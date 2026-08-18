import type { AssistantMessageEvent } from "../../../src/ai/events.ts";
import type {
	AssistantContent,
	AssistantMessage,
} from "../../../src/ai/types.ts";
import type {
	AsyncWriter,
	PrintModeSignalTarget,
} from "../../../src/coding/modes/types.ts";

type DoneMessage = Extract<AssistantMessageEvent, { type: "done" }>["message"];
type ErrorMessage = Extract<
	AssistantMessageEvent,
	{ type: "error" }
>["message"];

export const EMPTY_USAGE = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

export class MemoryWriter implements AsyncWriter {
	readonly chunks: string[] = [];
	flushCount = 0;
	writeCount = 0;

	constructor(
		private readonly writeFailureAt?: number,
		private readonly flushFailure?: Error,
	) {}

	get value(): string {
		return this.chunks.join("");
	}

	async write(content: string): Promise<void> {
		this.writeCount += 1;
		if (this.writeCount === this.writeFailureAt) {
			throw new Error("writer failed");
		}
		this.chunks.push(content);
	}

	async flush(): Promise<void> {
		this.flushCount += 1;
		if (this.flushFailure) {
			throw this.flushFailure;
		}
	}
}

export class TestSignalTarget implements PrintModeSignalTarget {
	private listener: (() => void) | undefined;

	get listenerCount(): number {
		return this.listener ? 1 : 0;
	}

	once(_event: "SIGINT", listener: () => void): void {
		this.listener = listener;
	}

	off(_event: "SIGINT", listener: () => void): void {
		if (this.listener === listener) {
			this.listener = undefined;
		}
	}

	interrupt(): void {
		const listener = this.listener;
		this.listener = undefined;
		listener?.();
	}
}

export function assistant(
	content: AssistantContent[],
	stopReason: DoneMessage["stopReason"] = "stop",
	timestamp = 2,
): DoneMessage {
	return {
		role: "assistant",
		content,
		provider: "fake",
		model: "fake-model",
		usage: { ...EMPTY_USAGE },
		stopReason,
		timestamp,
	};
}

export function failedAssistant(
	errorMessage: string,
	content: AssistantContent[] = [],
	timestamp = 2,
): ErrorMessage {
	return {
		role: "assistant",
		content,
		provider: "fake",
		model: "fake-model",
		usage: { ...EMPTY_USAGE },
		stopReason: "error",
		errorMessage,
		timestamp,
	};
}

export function textScript(
	text: string,
	stopReason: DoneMessage["stopReason"] = "stop",
): AssistantMessageEvent[] {
	const message = assistant([{ type: "text", text }], stopReason);
	const empty: AssistantMessage = { ...message, content: [] };
	return [
		{ type: "start", partial: empty },
		{ type: "text_start", contentIndex: 0, partial: empty },
		{
			type: "text_delta",
			contentIndex: 0,
			delta: text,
			partial: message,
		},
		{
			type: "text_end",
			contentIndex: 0,
			content: { type: "text", text },
			partial: message,
		},
		{ type: "done", message },
	];
}

export function terminalScript(message: DoneMessage): AssistantMessageEvent[] {
	return [
		{ type: "start", partial: message },
		{ type: "done", message },
	];
}

export function errorScript(
	errorMessage: string,
	partialText = "",
): AssistantMessageEvent[] {
	const failure = failedAssistant(
		errorMessage,
		partialText ? [{ type: "text", text: partialText }] : [],
	);
	const partial: AssistantMessage = {
		...failure,
		stopReason: "stop",
		errorMessage: undefined,
	};
	return [
		{ type: "start", partial: { ...partial, content: [] } },
		...(partialText
			? ([
					{
						type: "text_delta",
						contentIndex: 0,
						delta: partialText,
						partial,
					},
				] satisfies AssistantMessageEvent[])
			: []),
		{ type: "error", message: failure },
	];
}
