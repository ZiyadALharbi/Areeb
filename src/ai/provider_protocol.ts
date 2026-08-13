import type { AssistantMessageEventStream } from "./event-stream.ts";
import type { ModelContext, ReasoningLevel, ThinkingLevel } from "./types.ts";



export interface StreamOptions {
	readonly signal?: AbortSignal;
	readonly timeout?: number;
	readonly reasoning?: ReasoningLevel;
}

/** Provider-owned policy for transient request failures. */
export interface ProviderRetryConfig {
	/** Retry attempts after the initial request. */
	readonly maxRetries?: number;
	/** Maximum retry delay; zero disables the cap. */
	readonly maxRetryDelayMs?: number;
	/** Returns a delay for a zero-based retry index. */
	readonly backoffMs?: (error: unknown, retryIndex: number) => number;
	/** Classifies provider errors that are safe to retry. */
	readonly isRetryable?: (error: unknown) => boolean;
}

export interface ModelProvider {
	readonly providerId: string;

	streamResponse(
		model: string,
		context: ModelContext,
		options?: StreamOptions,
	): AssistantMessageEventStream;
}
