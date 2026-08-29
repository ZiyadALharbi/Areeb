import type { AuthInteraction, AuthType, OAuthCredential } from "../ai/auth.ts";
import { extractCodexAccountId } from "../ai/codex_oauth.ts";
import {
	CodexProvider,
	type CodexProviderConfig,
} from "../ai/codex_provider.ts";
import { createAssistantMessageEventStream } from "../ai/event-stream.ts";
import type { OpenAICompatibleConfig } from "../ai/openai_compatible_provider.ts";
import { OpenAICompatibleProvider } from "../ai/openai_compatible_provider.ts";
import type {
	DiscoveredModelLimit,
	ModelProvider,
	StreamOptions,
} from "../ai/provider_protocol.ts";
import type { ModelContext } from "../ai/types.ts";
import type { CredentialStore } from "./auth-store.ts";
import type {
	ProviderAuthMetadata,
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
	readonly createProvider?: ProviderFactory;
	readonly createCodexProvider?: (config: CodexProviderConfig) => ModelProvider;
	readonly now?: () => number;
}

export interface CreateCredentialRuntimeOptions {
	readonly allowUnavailable?: boolean;
}

export class ProviderRuntimeService {
	private readonly env: ProviderEnvironment;
	private readonly now: () => number;
	private readonly discoveryByProvider = new WeakMap<
		ModelProvider,
		Promise<ModelLimitDiscovery>
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
			const models = new Set([
				...configured.models,
				...(registration?.models ?? []),
			]);
			if (!models.has(model)) {
				throw new Error(
					`Unknown model "${model}" for provider "${providerId}"`,
				);
			}
			return Object.freeze({ provider: providerId, model });
		}
		if (registration?.models.length) {
			const model =
				options.stored?.model ??
				options.model ??
				savedDefaultModel ??
				registration.defaultModel;
			if (!registration.models.includes(model)) {
				throw new Error(
					`Unknown model "${model}" for provider "${providerId}"`,
				);
			}
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

		const usableModels = await this.usableModels();
		if (
			usableModels.some(
				(entry) =>
					entry.provider === configured.provider &&
					entry.model === configured.model,
			)
		) {
			return configured;
		}

		for (const provider of await this.listProviders()) {
			if (provider.status === "not connected") {
				continue;
			}
			const models = usableModels.filter(
				(entry) => entry.provider === provider.id,
			);
			const model = models.find((entry) => entry.isDefaultModel) ?? models[0];
			if (model !== undefined) {
				return Object.freeze({
					provider: model.provider,
					model: model.model,
				});
			}
		}

		const fallback =
			usableModels.find((entry) => entry.isDefaultModel) ?? usableModels[0];
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
			if (metadata.id === "openai" && environmentApiKey(this.env)) {
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
			const usable =
				providerId === "openai"
					? environmentApiKey(this.env) !== undefined ||
						credentials.get(providerId)?.type === "api_key"
					: !getProviderAuthStatus(provider, this.env).startsWith("missing:");
			const registration = this.options.registry.get(providerId);
			const models = [
				...new Set([...provider.models, ...(registration?.models ?? [])]),
			].sort();
			const defaultModel =
				providerId === this.options.settings.defaultProvider
					? (this.options.settings.defaultModel ?? provider.defaultModel)
					: provider.defaultModel;
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
			const credential = credentials.get(registration.id);
			const usable = credential?.type === registration.authType;
			const defaultModel =
				registration.id === this.options.settings.defaultProvider
					? (this.options.settings.defaultModel ?? registration.defaultModel)
					: registration.defaultModel;
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
	}

	logout(provider: string, signal?: AbortSignal): Promise<boolean> {
		if (this.options.registry.get(provider) === undefined) {
			return Promise.reject(new Error(`Unknown provider: ${provider}`));
		}
		return this.options.store.delete(provider, signal);
	}

	async createRuntime(
		selection: ProviderSelection,
		options: CreateCredentialRuntimeOptions = {},
	): Promise<ProviderRuntime & { readonly unavailableReason?: string }> {
		const canonical = this.resolveSelection({ stored: selection });
		if (canonical.provider === "openai-codex") {
			const credential = await this.options.store.read(canonical.provider);
			if (credential?.type !== "oauth") {
				return this.unavailableRuntime(
					canonical,
					`No credentials for ${canonical.provider}. Run /login or /model`,
					options,
				);
			}
			const config: CodexProviderConfig = {
				providerId: canonical.provider,
				getAuth: (signal) => this.resolveCodexAuth(signal),
				retry: { maxRetries: 2, maxRetryDelayMs: 60_000 },
			};
			const provider =
				this.options.createCodexProvider?.(config) ?? new CodexProvider(config);
			return this.resolveRuntimeWindow(
				Object.freeze({
					provider,
					selection: canonical,
					contextWindowTokens: 128_000,
					contextWindowSource: "fallback" as const,
				}),
			);
		}

		if (canonical.provider === "openai") {
			const configured = this.options.settings.providers.openai;
			if (configured === undefined) {
				throw new Error("Built-in OpenAI settings are unavailable");
			}
			const stored = await this.options.store.read("openai");
			const apiKey =
				environmentApiKey(this.env) ??
				(stored?.type === "api_key" ? stored.key : undefined);
			if (!apiKey) {
				return this.unavailableRuntime(
					canonical,
					"No credentials for openai. Run /login or /model",
					options,
				);
			}
			const adapterConfig: OpenAICompatibleConfig = {
				providerId: "openai",
				baseUrl: configured.baseUrl,
				apiKey,
				retry: {
					maxRetries: configured.maxRetries,
					maxRetryDelayMs: configured.maxRetryDelaySeconds * 1_000,
				},
				compat: configured.compat,
			};
			const provider =
				this.options.createProvider?.(adapterConfig) ??
				new OpenAICompatibleProvider(adapterConfig);
			return this.resolveRuntimeWindow(
				Object.freeze({
					provider,
					selection: canonical,
					...(configured.timeoutSeconds === undefined
						? {}
						: { timeoutMs: configured.timeoutSeconds * 1_000 }),
					contextWindowTokens:
						configured.contextWindows[canonical.model] ?? 128_000,
					contextWindowSource:
						configured.contextWindows[canonical.model] === undefined
							? ("fallback" as const)
							: ("configured" as const),
				}),
			);
		}

		return this.resolveRuntimeWindow(
			createConfiguredProviderRuntime(this.options.settings, canonical, {
				env: this.env,
				...(this.options.createProvider === undefined
					? {}
					: { createProvider: this.options.createProvider }),
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
			contextWindowTokens:
				this.options.settings.providers[selection.provider]?.contextWindows[
					selection.model
				] ?? 128_000,
			contextWindowSource:
				this.options.settings.providers[selection.provider]?.contextWindows[
					selection.model
				] === undefined
					? "fallback"
					: "configured",
		});
	}

	private async resolveRuntimeWindow<T extends ProviderRuntime>(
		runtime: T,
	): Promise<T> {
		if (runtime.provider.discoverModelLimits === undefined) {
			return runtime;
		}
		let discovery = this.discoveryByProvider.get(runtime.provider);
		if (discovery === undefined) {
			discovery = discoverModelLimits(runtime.provider);
			this.discoveryByProvider.set(runtime.provider, discovery);
		}
		const outcome = await discovery;
		const live = outcome.limits.find(
			(limit) => limit.model === runtime.selection.model,
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

	private async resolveCodexAuth(
		signal?: AbortSignal,
	): Promise<{ readonly access: string; readonly accountId: string }> {
		const refresh = this.options.registry.get("openai-codex")?.refresh;
		if (refresh === undefined) {
			throw new Error("Codex OAuth refresh is unavailable");
		}
		const credential = await this.options.store.modify(
			"openai-codex",
			async (current) => {
				if (current?.type !== "oauth") {
					throw new Error("OpenAI Codex is not logged in");
				}
				if (current.expires > this.now() + OAUTH_REFRESH_WINDOW_MS) {
					return undefined;
				}
				return refreshWithTimeout(refresh, current, signal);
			},
			signal,
		);
		if (credential?.type !== "oauth") {
			throw new Error("OpenAI Codex is not logged in");
		}
		return Object.freeze({
			access: credential.access,
			accountId: extractCodexAccountId(credential.access),
		});
	}
}

interface ModelLimitDiscovery {
	readonly limits: readonly DiscoveredModelLimit[];
	readonly error?: string;
}

async function discoverModelLimits(
	provider: ModelProvider,
): Promise<ModelLimitDiscovery> {
	try {
		const limits = await provider.discoverModelLimits?.();
		return Object.freeze({ limits: Object.freeze([...(limits ?? [])]) });
	} catch (error) {
		return Object.freeze({
			limits: Object.freeze([]),
			error: errorMessage(error),
		});
	}
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

function environmentApiKey(env: ProviderEnvironment): string | undefined {
	const value = Object.hasOwn(env, "OPENAI_API_KEY")
		? env.OPENAI_API_KEY?.trim()
		: undefined;
	return value || undefined;
}
