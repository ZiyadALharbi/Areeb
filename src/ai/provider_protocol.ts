import type { AssistantMessageEventStream } from "./event-stream.ts";
import type { ModelContext, ReasoningLevel } from "./types.ts";

export type { ReasoningLevel, ThinkingLevel } from "./types.ts";

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

export interface ProviderProjectedMessage {
	/** Index in ModelContext.messages that produced this provider-visible item. */
	readonly sourceIndex: number;
	/** Side-effect-free wire-shaped value with binary image payloads elided. */
	readonly value: unknown;
	/** Images represented by this item and estimated separately from text. */
	readonly imageCount?: number;
}

export interface ProviderContextProjection {
	readonly systemPrompt: string;
	readonly messages: readonly ProviderProjectedMessage[];
	readonly tools: readonly unknown[];
}

export interface DiscoveredModelLimit {
	readonly model: string;
	readonly contextWindowTokens: number;
	readonly effectiveContextWindowPercent?: number;
}

export interface ModelProvider {
	readonly providerId: string;

	/** Project a converted context through this adapter's replay serialization. */
	projectContext?(
		model: string,
		context: ModelContext,
	): ProviderContextProjection;

	/** Fetch the authenticated model catalog for this provider instance. */
	discoverModelLimits?(
		signal?: AbortSignal,
	): Promise<readonly DiscoveredModelLimit[]>;

	streamResponse(
		model: string,
		context: ModelContext,
		options?: StreamOptions,
	): AssistantMessageEventStream;
}
