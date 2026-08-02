import type { AssistantMessageEventStream } from "./event-stream.ts";
import type { ModelContext } from "./types.ts";

export interface StreamOptions {
	readonly signal?: AbortSignal;
}

export interface ModelProvider {
	readonly providerId: string;

	streamResponse(
		model: string,
		context: ModelContext,
		options?: StreamOptions,
	): AssistantMessageEventStream;
}
