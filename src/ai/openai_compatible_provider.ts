import type { ReasoningLevel } from "./provider_protocol.ts";

export type OpenAIThinkingFormat =
  | "openai"
  | "openrouter"
  | "deepseek"
  | "zai";

export type ThinkingLevelMap = Partial<Readonly<Record<ReasoningLevel, string | null>>>;

export interface OpenAICompatibleCompat {
	readonly thinkingFormat?: OpenAIThinkingFormat;
	readonly supportsReasoningEffort?: boolean;
	readonly thinkingLevelMap?: ThinkingLevelMap;
  }

export interface OpenAICompatibleConfig {
	readonly providerId: string;
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly compat?: OpenAICompatibleCompat;
  }

