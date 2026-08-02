import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "./event-stream.ts";
import type { AssistantMessageEvent } from "./events.ts";
import type { ModelProvider, StreamOptions } from "./provider_protocol.ts";
import type { ModelContext } from "./types.ts";

export interface FakeProviderCall {
	readonly model: string;
	readonly context: ModelContext;
	readonly options?: StreamOptions;
}

export interface FakeProviderOptions {
	readonly providerId?: string;
}

/**
 * A deterministic model provider that replays one scripted event stream per call.
 */
export class FakeProvider implements ModelProvider {
	readonly providerId: string;
	readonly calls: FakeProviderCall[] = [];

	private readonly scripts: AssistantMessageEvent[][];
	private nextScriptIndex = 0;

	constructor(
		scripts: Iterable<Iterable<AssistantMessageEvent>>,
		options: FakeProviderOptions = {},
	) {
		this.providerId = options.providerId ?? "fake";
		this.scripts = Array.from(scripts, (script) => Array.from(script));
	}

	streamResponse(
		model: string,
		context: ModelContext,
		options?: StreamOptions,
	): AssistantMessageEventStream {
		this.calls.push({
			model,
			context: {
				...context,
				messages: [...context.messages],
				tools: context.tools ? [...context.tools] : undefined,
			},
			options: options ? { ...options } : undefined,
		});

		const scriptIndex = this.nextScriptIndex;
		const script = this.scripts[scriptIndex];
		if (!script) {
			throw new Error(
				`FakeProvider has no scripted response for call ${scriptIndex + 1}`,
			);
		}

		this.assertValidScript(script, scriptIndex);
		this.nextScriptIndex += 1;

		const stream = createAssistantMessageEventStream();
		this.replay(script, stream, model, options?.signal);
		return stream;
	}

	private assertValidScript(
		script: AssistantMessageEvent[],
		scriptIndex: number,
	): void {
		const terminalIndexes = script.flatMap((event, index) =>
			event.type === "done" || event.type === "error" ? [index] : [],
		);

		if (terminalIndexes.length === 0) {
			throw new Error(
				`FakeProvider script ${scriptIndex + 1} must end with a done or error event`,
			);
		}

		if (
			terminalIndexes.length !== 1 ||
			terminalIndexes[0] !== script.length - 1
		) {
			throw new Error(
				`FakeProvider script ${scriptIndex + 1} must contain exactly one terminal event, as its final event`,
			);
		}
	}

	private replay(
		script: AssistantMessageEvent[],
		stream: AssistantMessageEventStream,
		model: string,
		signal?: AbortSignal,
	): void {
		let eventIndex = 0;

		const pushNext = (): void => {
			if (signal?.aborted) {
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
						stopReason: "aborted",
						errorMessage: "The model request was aborted",
						timestamp: Date.now(),
					},
				});
				return;
			}

			const event = script[eventIndex];
			if (!event) {
				return;
			}

			stream.push(event);
			eventIndex += 1;

			if (eventIndex < script.length) {
				queueMicrotask(pushNext);
			}
		};

		queueMicrotask(pushNext);
	}
}
