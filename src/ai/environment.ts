import type { OpenAICompatibleConfig } from "./openai_compatible_provider.ts";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

type Environment = Readonly<Record<string, string | undefined>>;

export interface OpenAICompatibleEnvOptions {
	readonly env?: Environment;
	readonly providerId?: string;
	readonly apiKeyVar?: string;
	readonly baseUrlVar?: string;
	readonly defaultBaseUrl?: string;
}

/**
 * Builds an OpenAI-compatible provider configuration from environment variables.
 * Variable names and defaults can be overridden for compatible providers.
 */
export function openAICompatibleConfigFromEnv({
	env = process.env,
	providerId = "openai",
	apiKeyVar = "OPENAI_API_KEY",
	baseUrlVar = "OPENAI_BASE_URL",
	defaultBaseUrl = DEFAULT_OPENAI_BASE_URL,
}: OpenAICompatibleEnvOptions = {}): OpenAICompatibleConfig {
	const apiKey = env[apiKeyVar]?.trim();
	if (!apiKey) {
		throw new Error(`Missing required environment variable: ${apiKeyVar}`);
	}

	return {
		providerId,
		apiKey,
		baseUrl: (env[baseUrlVar]?.trim() || defaultBaseUrl).replace(/\/+$/, ""),
	};
}
