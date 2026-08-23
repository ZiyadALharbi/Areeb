import type { AuthInteraction, AuthType, OAuthCredential } from "../ai/auth.ts";
import { extractCodexAccountId } from "../ai/codex_oauth.ts";
import {
	CodexProvider,
	type CodexProviderConfig,
} from "../ai/codex_provider.ts";
import { createAssistantMessageEventStream } from "../ai/event-stream.ts";
import type { OpenAICompatibleConfig } from "../ai/openai_compatible_provider.ts";
import { OpenAICompatibleProvider } from "../ai/openai_compatible_provider.ts";
import type { ModelProvider, StreamOptions } from "../ai/provider_protocol.ts";
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
	resolveProviderSelection as resolveConfiguredSelection,
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

	constructor(private readonly options: ProviderRuntimeServiceOptions) {
		this.env = options.env ?? process.env;
		this.now = options.now ?? Date.now;
	}

	get authMetadata(): readonly ProviderAuthMetadata[] {
		return this.options.registry.metadata();
	}

	resolveSelection(options: ProviderSelectionOptions = {}): ProviderSelection {
		const providerId =
			options.stored?.provider ??
			options.provider ??
			this.options.settings.defaultProvider;
		const registration = this.options.registry.get(providerId);
		if (registration?.models.length) {
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
			const model =
				options.stored?.model ?? options.model ?? registration.defaultModel;
			if (!registration.models.includes(model)) {
				throw new Error(
					`Unknown model "${model}" for provider "${providerId}"`,
				);
			}
			return Object.freeze({ provider: providerId, model });
		}
		return resolveConfiguredSelection(this.options.settings, options);
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
			for (const model of [...provider.models].sort()) {
				entries.push(
					Object.freeze({
						provider: providerId,
						model,
						usable,
						isDefaultProvider:
							providerId === this.options.settings.defaultProvider,
						isDefaultModel: model === provider.defaultModel,
					}),
				);
			}
		}
		for (const registration of this.options.registry.list()) {
			if (registration.models.length === 0) {
				continue;
			}
			const credential = credentials.get(registration.id);
			const usable = credential?.type === registration.authType;
			for (const model of registration.models) {
				entries.push(
					Object.freeze({
						provider: registration.id,
						model,
						usable,
						isDefaultProvider: false,
						isDefaultModel: model === registration.defaultModel,
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
			return Object.freeze({ provider, selection: canonical });
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
				compat: { thinkingLevelMap: { off: "none" } },
			};
			const provider =
				this.options.createProvider?.(adapterConfig) ??
				new OpenAICompatibleProvider(adapterConfig);
			return Object.freeze({
				provider,
				selection: canonical,
				...(configured.timeoutSeconds === undefined
					? {}
					: { timeoutMs: configured.timeoutSeconds * 1_000 }),
			});
		}

		return createConfiguredProviderRuntime(this.options.settings, canonical, {
			env: this.env,
			...(this.options.createProvider === undefined
				? {}
				: { createProvider: this.options.createProvider }),
		});
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
		});
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
	refresh: NonNullable<ProviderAuthRegistry["get"]> extends never
		? never
		: (
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
