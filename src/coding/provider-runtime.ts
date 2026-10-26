import type { AuthInteraction, AuthType, OAuthCredential } from "../ai/auth.ts";
import { createAssistantMessageEventStream } from "../ai/event-stream.ts";
import type {
	DiscoveredModel,
	ModelProvider,
	StreamOptions,
} from "../ai/provider_protocol.ts";
import type { ModelContext } from "../ai/types.ts";
import type { CredentialStore, StoredCredentialSummary } from "./auth-store.ts";
import { FALLBACK_CONTEXT_WINDOW_TOKENS } from "./context-window.ts";
import type {
	OAuthProviderRegistration,
	ProviderAuthMetadata,
	ProviderAuthRegistration,
	ProviderAuthRegistry,
} from "./provider-auth.ts";
import {
	createProviderRuntime as createConfiguredProviderRuntime,
	getProviderAuthStatus,
	type ProviderEnvironment,
	type ProviderFactory,
	type ProviderRuntime,
	type ProviderSelection,
	type ProviderSelectionOptions,
	type ProviderSettings,
	saveDefaultProviderModel,
} from "./provider-config.ts";

const OAUTH_REFRESH_WINDOW_MS = 5 * 60_000;
const OAUTH_REFRESH_TIMEOUT_MS = 15_000;

export type ProviderConnectionStatus =
	| "connected"
	| "expired"
	| "not connected";

export interface ProviderAuthView extends ProviderAuthMetadata {
	readonly status: ProviderConnectionStatus;
	readonly source?: "environment" | "stored";
	readonly stored: boolean;
}

export interface RuntimeModelCatalogEntry {
	readonly provider: string;
	readonly model: string;
	readonly usable: boolean;
	readonly isDefaultProvider: boolean;
	readonly isDefaultModel: boolean;
}

export interface ProviderRuntimeServiceOptions {
	readonly settings: ProviderSettings;
	readonly store: CredentialStore;
	readonly registry: ProviderAuthRegistry;
	readonly env?: ProviderEnvironment;
	/** Adapter factory for custom providers; built-ins use their registration. */
	readonly createProvider?: ProviderFactory;
	readonly now?: () => number;
}

export interface CreateCredentialRuntimeOptions {
	readonly allowUnavailable?: boolean;
}

export class ProviderRuntimeService {
	private readonly env: ProviderEnvironment;
	private readonly now: () => number;
	private readonly catalogByProvider = new Map<
		string,
		Promise<ModelCatalogDiscovery>
	>();

	constructor(private readonly options: ProviderRuntimeServiceOptions) {
		this.env = options.env ?? process.env;
		this.now = options.now ?? Date.now;
	}

	get authMetadata(): readonly ProviderAuthMetadata[] {
		return this.options.registry.metadata();
	}

	resolveSelection(options: ProviderSelectionOptions = {}): ProviderSelection {
		assertSelectionMatchesStored(options);
		const providerId =
			options.stored?.provider ??
			options.provider ??
			this.options.settings.defaultProvider;
		const configured = this.options.settings.providers[providerId];
		const registration = this.options.registry.get(providerId);
		const savedDefaultModel =
			providerId === this.options.settings.defaultProvider
				? this.options.settings.defaultModel
				: undefined;
		if (configured !== undefined) {
			const model =
				options.stored?.model ??
				options.model ??
				savedDefaultModel ??
				configured.defaultModel;
			return Object.freeze({ provider: providerId, model });
		}
		if (registration !== undefined) {
			const model =
				options.stored?.model ??
				options.model ??
				savedDefaultModel ??
				registration.defaultModel;
			return Object.freeze({ provider: providerId, model });
		}
		throw new Error(`Unknown provider: ${providerId}`);
	}

	async resolveInitialSelection(
		options: ProviderSelectionOptions = {},
	): Promise<ProviderSelection> {
		const explicit =
			options.stored !== undefined ||
			options.provider !== undefined ||
			options.model !== undefined;
		let configured: ProviderSelection;
		try {
			configured = this.resolveSelection(options);
		} catch (error) {
			if (explicit) {
				throw error;
			}
			configured = this.resolveProviderDefault(
				this.options.settings.defaultProvider,
			);
		}
		if (explicit) {
			return configured;
		}

		const fallbackModels = await this.fallbackModels();
		if (
			fallbackModels.some(
				(entry) =>
					entry.usable &&
					entry.provider === configured.provider &&
					entry.model === configured.model,
			)
		) {
			return configured;
		}

		const configuredIsKnown = fallbackModels.some(
			(entry) =>
				entry.provider === configured.provider &&
				entry.model === configured.model,
		);
		if (!configuredIsKnown) {
			const liveModels = await this.configuredModels();
			if (
				liveModels.some(
					(entry) =>
						entry.usable &&
						entry.provider === configured.provider &&
						entry.model === configured.model,
				)
			) {
				return configured;
			}
		}

		for (const provider of await this.listProviders()) {
			if (provider.status === "not connected") {
				continue;
			}
			const models = fallbackModels.filter(
				(entry) => entry.usable && entry.provider === provider.id,
			);
			const model = models.find((entry) => entry.isDefaultModel) ?? models[0];
			if (model !== undefined) {
				return Object.freeze({
					provider: model.provider,
					model: model.model,
				});
			}
		}

		const usableFallbacks = fallbackModels.filter((entry) => entry.usable);
		const fallback =
			usableFallbacks.find((entry) => entry.isDefaultModel) ??
			usableFallbacks[0];
		return fallback === undefined
			? configured
			: Object.freeze({
					provider: fallback.provider,
					model: fallback.model,
				});
	}

	async listProviders(savedOnly = false): Promise<readonly ProviderAuthView[]> {
		const stored = new Map(
			(await this.options.store.list()).map((credential) => [
				credential.provider,
				credential,
			]),
		);
		const views: ProviderAuthView[] = [];
		for (const metadata of this.authMetadata) {
			const saved = stored.get(metadata.id);
			if (savedOnly && saved === undefined) {
				continue;
			}
			if (this.environmentApiKey(metadata.id) !== undefined) {
				views.push(
					Object.freeze<ProviderAuthView>({
						...metadata,
						status: "connected",
						source: "environment",
						stored: saved !== undefined,
					}),
				);
				continue;
			}
			const status: ProviderConnectionStatus =
				saved === undefined
					? "not connected"
					: saved.type === "oauth" &&
							saved.expires !== undefined &&
							saved.expires <= this.now()
						? "expired"
						: "connected";
			views.push(
				Object.freeze<ProviderAuthView>({
					...metadata,
					status,
					...(saved === undefined ? {} : { source: "stored" }),
					stored: saved !== undefined,
				}),
			);
		}
		return Object.freeze(views);
	}

	async configuredModels(): Promise<readonly RuntimeModelCatalogEntry[]> {
		const fallback = await this.fallbackModels();
		const entries = [...fallback];
		const known = new Set(
			entries.map((entry) => `${entry.provider}\u0000${entry.model}`),
		);
		const providerIds = [
			...new Set(
				fallback.filter((entry) => entry.usable).map((entry) => entry.provider),
			),
		];
		const discoveries = await Promise.all(
			providerIds.map(async (providerId) => ({
				providerId,
				outcome: await this.discoverProviderCatalog(providerId),
			})),
		);

		for (const { providerId, outcome } of discoveries) {
			const defaultModel = this.defaultModelFor(providerId);
			for (const discovered of outcome.models) {
				const key = `${providerId}\u0000${discovered.model}`;
				if (known.has(key)) {
					continue;
				}
				known.add(key);
				entries.push(
					Object.freeze({
						provider: providerId,
						model: discovered.model,
						usable: true,
						isDefaultProvider:
							providerId === this.options.settings.defaultProvider,
						isDefaultModel: discovered.model === defaultModel,
					}),
				);
			}
		}

		entries.sort(
			(left, right) =>
				left.provider.localeCompare(right.provider) ||
				left.model.localeCompare(right.model),
		);
		return Object.freeze(entries);
	}

	async usableModels(): Promise<readonly RuntimeModelCatalogEntry[]> {
		return Object.freeze(
			(await this.configuredModels()).filter((entry) => entry.usable),
		);
	}

	async saveDefaultSelection(selection: ProviderSelection): Promise<void> {
		const canonical = this.resolveSelection({ stored: selection });
		await saveDefaultProviderModel(canonical, {
			path: this.options.settings.path,
			env: this.env,
		});
	}

	async login(
		provider: string,
		authType: AuthType,
		interaction: AuthInteraction,
	): Promise<void> {
		const registration = this.options.registry.get(provider);
		if (registration === undefined || registration.authType !== authType) {
			throw new Error(`Unknown provider login: ${provider}`);
		}
		const credential = await registration.login(interaction);
		if (credential.type !== registration.authType) {
			throw new Error(
				`Provider ${provider} returned ${credential.type} credentials for ${registration.authType} login`,
			);
		}
		await this.options.store.modify(
			provider,
			() => credential,
			interaction.signal,
		);
		this.catalogByProvider.delete(provider);
	}

	async logout(provider: string, signal?: AbortSignal): Promise<boolean> {
		if (this.options.registry.get(provider) === undefined) {
			throw new Error(`Unknown provider: ${provider}`);
		}
		const deleted = await this.options.store.delete(provider, signal);
		this.catalogByProvider.delete(provider);
		return deleted;
	}

	async createRuntime(
		selection: ProviderSelection,
		options: CreateCredentialRuntimeOptions = {},
	): Promise<ProviderRuntime & { readonly unavailableReason?: string }> {
		const canonical = this.resolveSelection({ stored: selection });
		const registration = this.options.registry.get(canonical.provider);
		if (registration === undefined) {
			return this.resolveRuntimeWindow(
				createConfiguredProviderRuntime(this.options.settings, canonical, {
					env: this.env,
					...(this.options.createProvider === undefined
						? {}
						: { createProvider: this.options.createProvider }),
				}),
			);
		}

		const provider = await this.createRegisteredProvider(registration);
		if (provider === undefined) {
			return this.unavailableRuntime(
				canonical,
				`No credentials for ${canonical.provider}. Run /login or /model`,
				options,
			);
		}
		const timeoutSeconds =
			this.options.settings.providers[canonical.provider]?.timeoutSeconds;
		return this.resolveRuntimeWindow(
			Object.freeze({
				provider,
				selection: canonical,
				...(timeoutSeconds === undefined
					? {}
					: { timeoutMs: timeoutSeconds * 1_000 }),
				...this.configuredContextWindow(canonical),
			}),
		);
	}

	private unavailableRuntime(
		selection: ProviderSelection,
		reason: string,
		options: CreateCredentialRuntimeOptions,
	): ProviderRuntime & { readonly unavailableReason?: string } {
		if (options.allowUnavailable !== true) {
			throw new Error(reason);
		}
		return Object.freeze({
			provider: new UnavailableModelProvider(selection.provider, reason),
			selection,
			unavailableReason: reason,
			...this.configuredContextWindow(selection),
		});
	}

	private configuredContextWindow(
		selection: ProviderSelection,
	): Pick<ProviderRuntime, "contextWindowTokens" | "contextWindowSource"> {
		const configured =
			this.options.settings.providers[selection.provider]?.contextWindows[
				selection.model
			];
		return configured === undefined
			? {
					contextWindowTokens: FALLBACK_CONTEXT_WINDOW_TOKENS,
					contextWindowSource: "fallback",
				}
			: { contextWindowTokens: configured, contextWindowSource: "configured" };
	}

	/** Build a built-in adapter, or return undefined when it has no credentials. */
	private async createRegisteredProvider(
		registration: ProviderAuthRegistration,
	): Promise<ModelProvider | undefined> {
		if (registration.authType === "oauth") {
			const credential = await this.options.store.read(registration.id);
			if (credential?.type !== "oauth") {
				return undefined;
			}
			return registration.createProvider({
				getCredential: (signal) =>
					this.resolveOAuthCredential(registration, signal),
			});
		}

		const config = this.options.settings.providers[registration.id];
		if (config === undefined) {
			throw new Error(
				`Built-in ${registration.displayName} settings are unavailable`,
			);
		}
		const stored = await this.options.store.read(registration.id);
		const apiKey =
			this.environmentApiKey(registration.id) ??
			(stored?.type === "api_key" ? stored.key : undefined);
		return apiKey === undefined
			? undefined
			: registration.createProvider({ config, apiKey });
	}

	private async resolveRuntimeWindow<T extends ProviderRuntime>(
		runtime: T,
	): Promise<T> {
		if (runtime.provider.discoverModels === undefined) {
			return runtime;
		}
		const outcome = await this.discoverProviderCatalog(
			runtime.selection.provider,
			runtime.provider,
		);
		const live = outcome.models.find(
			(model) => model.model === runtime.selection.model,
		);
		if (live !== undefined && isPositiveFinite(live.contextWindowTokens)) {
			return Object.freeze({
				...runtime,
				contextWindowTokens: live.contextWindowTokens,
				contextWindowSource: "live",
				...(isPositiveFinite(live.effectiveContextWindowPercent)
					? {
							effectiveContextWindowPercent: live.effectiveContextWindowPercent,
						}
					: {}),
			}) as T;
		}
		if (outcome.error === undefined) {
			return runtime;
		}
		return Object.freeze({
			...runtime,
			contextWindowDiscoveryError: outcome.error,
		}) as T;
	}

	private async fallbackModels(): Promise<readonly RuntimeModelCatalogEntry[]> {
		const credentials = new Map(
			(await this.options.store.list()).map((credential) => [
				credential.provider,
				credential,
			]),
		);
		const entries: RuntimeModelCatalogEntry[] = [];
		for (const providerId of Object.keys(
			this.options.settings.providers,
		).sort()) {
			const provider = this.options.settings.providers[providerId];
			if (provider === undefined) {
				continue;
			}
			const registration = this.options.registry.get(providerId);
			const usable =
				registration === undefined
					? !getProviderAuthStatus(provider, this.env).startsWith("missing:")
					: this.isConnected(registration, credentials.get(providerId));
			const models = [
				...new Set([...provider.models, ...(registration?.models ?? [])]),
			].sort();
			const defaultModel = this.defaultModelFor(providerId);
			for (const model of models) {
				entries.push(
					Object.freeze({
						provider: providerId,
						model,
						usable,
						isDefaultProvider:
							providerId === this.options.settings.defaultProvider,
						isDefaultModel: model === defaultModel,
					}),
				);
			}
		}
		for (const registration of this.options.registry.list()) {
			if (
				registration.models.length === 0 ||
				this.options.settings.providers[registration.id] !== undefined
			) {
				continue;
			}
			const usable = this.isConnected(
				registration,
				credentials.get(registration.id),
			);
			const defaultModel = this.defaultModelFor(registration.id);
			for (const model of registration.models) {
				entries.push(
					Object.freeze({
						provider: registration.id,
						model,
						usable,
						isDefaultProvider:
							registration.id === this.options.settings.defaultProvider,
						isDefaultModel: model === defaultModel,
					}),
				);
			}
		}
		return Object.freeze(entries);
	}

	private defaultModelFor(providerId: string): string | undefined {
		const configured = this.options.settings.providers[providerId];
		const registration = this.options.registry.get(providerId);
		return providerId === this.options.settings.defaultProvider
			? (this.options.settings.defaultModel ??
					configured?.defaultModel ??
					registration?.defaultModel)
			: (configured?.defaultModel ?? registration?.defaultModel);
	}

	private discoverProviderCatalog(
		providerId: string,
		provider?: ModelProvider,
	): Promise<ModelCatalogDiscovery> {
		let discovery = this.catalogByProvider.get(providerId);
		if (discovery === undefined) {
			discovery = this.readProviderCatalog(providerId, provider);
			this.catalogByProvider.set(providerId, discovery);
		}
		return discovery;
	}

	private async readProviderCatalog(
		providerId: string,
		provider?: ModelProvider,
	): Promise<ModelCatalogDiscovery> {
		try {
			const connected =
				provider ?? (await this.createDiscoveryProvider(providerId));
			const models = await connected?.discoverModels?.();
			return Object.freeze({
				models: Object.freeze([...(models ?? [])]),
			});
		} catch (error) {
			return Object.freeze({
				models: Object.freeze([]),
				error: errorMessage(error),
			});
		}
	}

	private async createDiscoveryProvider(
		providerId: string,
	): Promise<ModelProvider | undefined> {
		const registration = this.options.registry.get(providerId);
		if (registration !== undefined) {
			return this.createRegisteredProvider(registration);
		}

		const configured = this.options.settings.providers[providerId];
		if (
			configured === undefined ||
			getProviderAuthStatus(configured, this.env).startsWith("missing:")
		) {
			return undefined;
		}
		return createConfiguredProviderRuntime(
			this.options.settings,
			{ provider: providerId, model: configured.defaultModel },
			{
				env: this.env,
				...(this.options.createProvider === undefined
					? {}
					: { createProvider: this.options.createProvider }),
			},
		).provider;
	}

	private resolveProviderDefault(providerId: string): ProviderSelection {
		const configured = this.options.settings.providers[providerId];
		if (configured !== undefined) {
			return Object.freeze({
				provider: providerId,
				model: configured.defaultModel,
			});
		}
		const registration = this.options.registry.get(providerId);
		if (registration?.models.includes(registration.defaultModel)) {
			return Object.freeze({
				provider: providerId,
				model: registration.defaultModel,
			});
		}
		throw new Error(`Unknown provider: ${providerId}`);
	}

	private isConnected(
		registration: ProviderAuthRegistration,
		stored: StoredCredentialSummary | undefined,
	): boolean {
		return (
			stored?.type === registration.authType ||
			this.environmentApiKey(registration.id) !== undefined
		);
	}

	/** Read the API key named by the provider's `api_key_env` setting. */
	private environmentApiKey(providerId: string): string | undefined {
		const name = this.options.settings.providers[providerId]?.apiKeyEnv;
		const value =
			name !== undefined && Object.hasOwn(this.env, name)
				? this.env[name]?.trim()
				: undefined;
		return value || undefined;
	}

	/** Return a fresh OAuth credential, refreshing at most once under contention. */
	private async resolveOAuthCredential(
		registration: OAuthProviderRegistration,
		signal?: AbortSignal,
	): Promise<OAuthCredential> {
		const credential = await this.options.store.modify(
			registration.id,
			async (current) => {
				if (current?.type !== "oauth") {
					throw new Error(`${registration.displayName} is not logged in`);
				}
				if (current.expires > this.now() + OAUTH_REFRESH_WINDOW_MS) {
					return undefined;
				}
				return refreshWithTimeout(registration.refresh, current, signal);
			},
			signal,
		);
		if (credential?.type !== "oauth") {
			throw new Error(`${registration.displayName} is not logged in`);
		}
		return credential;
	}
}

interface ModelCatalogDiscovery {
	readonly models: readonly DiscoveredModel[];
	readonly error?: string;
}

function isPositiveFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function assertSelectionMatchesStored(options: ProviderSelectionOptions): void {
	if (
		options.stored !== undefined &&
		options.provider !== undefined &&
		options.provider !== options.stored.provider
	) {
		throw new Error(
			`Requested provider "${options.provider}" does not match stored provider "${options.stored.provider}"`,
		);
	}
	if (
		options.stored !== undefined &&
		options.model !== undefined &&
		options.model !== options.stored.model
	) {
		throw new Error(
			`Requested model "${options.model}" does not match stored model "${options.stored.model}"`,
		);
	}
}

export class UnavailableModelProvider implements ModelProvider {
	constructor(
		readonly providerId: string,
		readonly reason: string,
	) {}

	streamResponse(
		model: string,
		_context: ModelContext,
		_options?: StreamOptions,
	) {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "error",
				message: {
					role: "assistant",
					content: [],
					provider: this.providerId,
					model,
					usage: {
						inputTokens: 0,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						totalTokens: 0,
					},
					stopReason: "error",
					errorMessage: this.reason,
					timestamp: Date.now(),
				},
			});
		});
		return stream;
	}
}

async function refreshWithTimeout(
	refresh: (
		credential: OAuthCredential,
		signal?: AbortSignal,
	) => Promise<OAuthCredential>,
	credential: OAuthCredential,
	signal?: AbortSignal,
): Promise<OAuthCredential> {
	const timeout = AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS);
	const combined =
		signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
	return refresh(credential, combined);
}
