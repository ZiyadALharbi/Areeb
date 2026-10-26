import type {
	ApiKeyCredential,
	AuthInteraction,
	AuthType,
	OAuthCredential,
} from "../ai/auth.ts";
import { CodexOAuth, extractCodexAccountId } from "../ai/codex_oauth.ts";
import {
	CodexProvider,
	type CodexProviderConfig,
} from "../ai/codex_provider.ts";
import {
	type OpenAICompatibleConfig,
	OpenAICompatibleProvider,
} from "../ai/openai_compatible_provider.ts";
import {
	type OpenAIResponsesConfig,
	OpenAIResponsesProvider,
} from "../ai/openai_responses_provider.ts";
import type {
	ModelProvider,
	ProviderRetryConfig,
} from "../ai/provider_protocol.ts";
import {
	DEFAULT_OPENAI_MODEL,
	DEFAULT_OPENROUTER_MODEL,
	type OpenAICompatibleProviderConfig,
	type ProviderFactory,
} from "./provider-config.ts";

export const DEFAULT_OPENAI_CODEX_MODEL = "gpt-6.1-sol";

export const OPENAI_CODEX_MODELS = Object.freeze([
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6-sol",
	"gpt-6.1-sol",
]);

export const OPENAI_API_MODELS = Object.freeze([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.6-luna",
	"gpt-5.6-luna-pro",
	"gpt-5.6-sol",
	"gpt-5.6-sol-pro",
	"gpt-5.6-terra",
	"gpt-5.6-terra-pro",
	"gpt-6-astra",
	"gpt-6-astra-pro",
	"gpt-6-luna",
	"gpt-6-luna-pro",
	"gpt-6-sol",
	"gpt-6-sol-pro",
	"gpt-6.1-sol",
	"gpt-6.1-sol-pro",
]);

/** Offline fallback; the live OpenRouter catalog is discovered after login. */
export const OPENROUTER_MODELS = Object.freeze([
	"anthropic/claude-haiku-5.5",
	"anthropic/claude-opus-5.5",
	"anthropic/claude-sonnet-5.5",
	"google/gemini-4-argon",
	"moonshotai/kimi-k3.1-pro",
	"openai/gpt-6-astra",
	"openai/gpt-6.1-sol",
	"qwen/qwen3.8-max-prime",
	"x-ai/grok-4.7",
	"z-ai/glm-5.3-prime",
]);

/** Inputs for building an API-key adapter from its built-in endpoint settings. */
export interface ApiKeyProviderContext {
	readonly config: OpenAICompatibleProviderConfig;
	readonly apiKey: string;
}

/** Inputs for building an OAuth adapter; credentials refresh on demand. */
export interface OAuthProviderContext {
	getCredential(signal?: AbortSignal): Promise<OAuthCredential>;
}

interface ProviderRegistrationBase {
	readonly id: string;
	readonly displayName: string;
	readonly authLabel: "api key" | "subscription";
	readonly models: readonly string[];
	readonly defaultModel: string;
}

export interface ApiKeyProviderRegistration extends ProviderRegistrationBase {
	readonly authType: "api_key";
	login(interaction: AuthInteraction): Promise<ApiKeyCredential>;
	createProvider(context: ApiKeyProviderContext): ModelProvider;
}

export interface OAuthProviderRegistration extends ProviderRegistrationBase {
	readonly authType: "oauth";
	login(interaction: AuthInteraction): Promise<OAuthCredential>;
	refresh(
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<OAuthCredential>;
	createProvider(context: OAuthProviderContext): ModelProvider;
}

export type ProviderAuthRegistration =
	| ApiKeyProviderRegistration
	| OAuthProviderRegistration;

export interface ProviderAuthMetadata {
	readonly id: string;
	readonly displayName: string;
	readonly authType: AuthType;
	readonly authLabel: string;
}

export class ProviderAuthRegistry {
	private readonly registrations = new Map<string, ProviderAuthRegistration>();

	constructor(registrations: readonly ProviderAuthRegistration[] = []) {
		for (const registration of registrations) {
			this.register(registration);
		}
	}

	register(registration: ProviderAuthRegistration): this {
		validateRegistration(registration);
		if (this.registrations.has(registration.id)) {
			throw new Error(
				`Duplicate provider auth registration: ${registration.id}`,
			);
		}
		this.registrations.set(
			registration.id,
			Object.freeze({
				...registration,
				models: Object.freeze([...registration.models]),
			}),
		);
		return this;
	}

	get(id: string): ProviderAuthRegistration | undefined {
		return this.registrations.get(id);
	}

	list(): readonly ProviderAuthRegistration[] {
		return Object.freeze([...this.registrations.values()]);
	}

	metadata(): readonly ProviderAuthMetadata[] {
		return Object.freeze(
			this.list().map((registration) =>
				Object.freeze({
					id: registration.id,
					displayName: registration.displayName,
					authType: registration.authType,
					authLabel: registration.authLabel,
				}),
			),
		);
	}
}

export interface DefaultProviderAuthRegistryOptions {
	readonly codexOAuth?: CodexOAuth;
	readonly createCodexProvider?: (config: CodexProviderConfig) => ModelProvider;
	readonly createOpenAIResponsesProvider?: (
		config: OpenAIResponsesConfig,
	) => ModelProvider;
	readonly createOpenAICompatibleProvider?: ProviderFactory;
}

export function createDefaultProviderAuthRegistry(
	options: DefaultProviderAuthRegistryOptions = {},
): ProviderAuthRegistry {
	const codexOAuth = options.codexOAuth ?? new CodexOAuth();
	return new ProviderAuthRegistry([
		{
			id: "openai-codex",
			displayName: "ChatGPT Plus/Pro",
			authType: "oauth",
			authLabel: "subscription",
			models: OPENAI_CODEX_MODELS,
			defaultModel: DEFAULT_OPENAI_CODEX_MODEL,
			login: (interaction) => codexOAuth.login(interaction),
			refresh: (credential, signal) => codexOAuth.refresh(credential, signal),
			createProvider({ getCredential }) {
				const config: CodexProviderConfig = {
					providerId: "openai-codex",
					async getAuth(signal) {
						const { access } = await getCredential(signal);
						return { access, accountId: extractCodexAccountId(access) };
					},
					retry: { maxRetries: 2, maxRetryDelayMs: 60_000 },
				};
				return (
					options.createCodexProvider?.(config) ?? new CodexProvider(config)
				);
			},
		},
		{
			id: "openai",
			displayName: "OpenAI",
			authType: "api_key",
			authLabel: "api key",
			models: OPENAI_API_MODELS,
			defaultModel: DEFAULT_OPENAI_MODEL,
			login: (interaction) =>
				promptApiKey(interaction, "OpenAI API key", "sk-..."),
			createProvider({ config, apiKey }) {
				const adapterConfig: OpenAIResponsesConfig = {
					providerId: config.id,
					baseUrl: config.baseUrl,
					apiKey,
					retry: retryConfig(config),
				};
				return (
					options.createOpenAIResponsesProvider?.(adapterConfig) ??
					new OpenAIResponsesProvider(adapterConfig)
				);
			},
		},
		{
			id: "openrouter",
			displayName: "OpenRouter",
			authType: "api_key",
			authLabel: "api key",
			models: OPENROUTER_MODELS,
			defaultModel: DEFAULT_OPENROUTER_MODEL,
			login: (interaction) =>
				promptApiKey(interaction, "OpenRouter API key", "sk-or-..."),
			createProvider({ config, apiKey }) {
				const adapterConfig: OpenAICompatibleConfig = {
					providerId: config.id,
					baseUrl: config.baseUrl,
					apiKey,
					retry: retryConfig(config),
					compat: config.compat,
				};
				return (
					options.createOpenAICompatibleProvider?.(adapterConfig) ??
					new OpenAICompatibleProvider(adapterConfig)
				);
			},
		},
	]);
}

async function promptApiKey(
	interaction: AuthInteraction,
	label: string,
	placeholder: string,
): Promise<ApiKeyCredential> {
	const key = (
		await interaction.prompt({
			type: "text",
			label,
			placeholder,
			secret: true,
			signal: interaction.signal,
		})
	).trim();
	if (!key) {
		throw new Error("API key cannot be empty");
	}
	return Object.freeze({ type: "api_key", key });
}

function retryConfig(
	config: OpenAICompatibleProviderConfig,
): ProviderRetryConfig {
	return {
		maxRetries: config.maxRetries,
		maxRetryDelayMs: config.maxRetryDelaySeconds * 1_000,
	};
}

function validateRegistration(registration: ProviderAuthRegistration): void {
	if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(registration.id)) {
		throw new Error(
			`Invalid provider auth registration ID: ${registration.id}`,
		);
	}
	if (!registration.displayName.trim()) {
		throw new Error(`Provider ${registration.id} requires a display name`);
	}
	if (!registration.authLabel.trim()) {
		throw new Error(`Provider ${registration.id} requires an auth label`);
	}
	if (
		registration.models.length > 0 &&
		!registration.models.includes(registration.defaultModel)
	) {
		throw new Error(
			`Provider ${registration.id} default model is not registered`,
		);
	}
	if (new Set(registration.models).size !== registration.models.length) {
		throw new Error(`Provider ${registration.id} has duplicate models`);
	}
}
