import type { AssistantMessageEventStream } from "./event-stream.ts";
import type { ModelContext } from "./types.ts";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export type ReasoningLevel = "off" | ThinkingLevel;

export interface StreamOptions {
	readonly signal?: AbortSignal;
	readonly timeout?: number;
	readonly maxRetries?: number;
	readonly reasoning?: ReasoningLevel;
}

export interface ModelProvider {
	readonly providerId: string;

	streamResponse(
		model: string,
		context: ModelContext,
		options?: StreamOptions,
	): AssistantMessageEventStream;
}
