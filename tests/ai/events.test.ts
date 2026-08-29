import { describe, expect, test } from "bun:test";
import type { AssistantMessageEvent } from "../../src/ai/events.ts";
import type { AssistantMessage } from "../../src/ai/types.ts";

function partialMessage(
	content: AssistantMessage["content"] = [],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		provider: "openai",
		model: "gpt-5",
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
		},
		stopReason: "stop",
		timestamp: 1_753_632_000_000,
	};
}

function assertNever(value: never): never {
	throw new Error(`Unexpected event: ${JSON.stringify(value)}`);
}

function eventType(event: AssistantMessageEvent): string {
	switch (event.type) {
		case "start":
			return event.type;
		case "text_start":
			return event.type;
		case "text_delta":
			return event.type;
		case "text_end":
			return event.type;
		case "thinking_start":
			return event.type;
		case "thinking_delta":
			return event.type;
		case "thinking_end":
			return event.type;
		case "toolcall_start":
			return event.type;
		case "toolcall_delta":
			return event.type;
		case "toolcall_end":
			return event.type;
		case "done":
			return event.type;
		case "error":
			return event.type;
		default:
			return assertNever(event);
	}
}

describe("AssistantMessageEvent", () => {
	test("narrows every event variant exhaustively", () => {
		const partial = partialMessage();
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial },
			{ type: "text_start", contentIndex: 0, partial },
			{ type: "text_delta", contentIndex: 0, delta: "Hello", partial },
			{
				type: "text_end",
				contentIndex: 0,
				content: { type: "text", text: "Hello" },
				partial,
			},
			{ type: "thinking_start", contentIndex: 1, partial },
			{
				type: "thinking_delta",
				contentIndex: 1,
				delta: "Reasoning",
				partial,
			},
			{
				type: "thinking_end",
				contentIndex: 1,
				content: { type: "thinking", thinking: "Reasoning" },
				partial,
			},
			{
				type: "toolcall_start",
				contentIndex: 2,
				toolCallId: "call-1",
				toolName: "search",
				partial,
			},
			{
				type: "toolcall_delta",
				contentIndex: 2,
				toolCallId: "call-1",
				argumentsDelta: '{"query":"Areeb"}',
				partial,
			},
			{
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: {
					type: "tool_call",
					id: "call-1",
					name: "search",
					arguments: { query: "Areeb" },
				},
				partial,
			},
			{
				type: "done",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello" }],
					provider: "openai",
					model: "gpt-5",
					responseId: "response-1",
					usage: {
						inputTokens: 10,
						outputTokens: 5,
						cacheReadTokens: 2,
						cacheWriteTokens: 1,
						totalTokens: 18,
					},
					stopReason: "stop",
					timestamp: 1_753_632_000_000,
				},
			},
			{
				type: "error",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Partial answer" }],
					provider: "openai",
					model: "gpt-5",
					usage: {
						inputTokens: 10,
						outputTokens: 3,
						cacheReadTokens: 2,
						cacheWriteTokens: 1,
						totalTokens: 16,
					},
					stopReason: "error",
					errorMessage: "The provider request failed",
					timestamp: 1_753_632_001_000,
				},
			},
		];

		expect(events.map(eventType)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
			"error",
		]);
	});

	test("correlates streamed content by index and tool-call ID", () => {
		const partial = partialMessage();
		type StreamedContentEvent = Extract<
			AssistantMessageEvent,
			{ contentIndex: number }
		>;

		const events: StreamedContentEvent[] = [
			{ type: "text_delta", contentIndex: 0, delta: "Hello", partial },
			{
				type: "thinking_delta",
				contentIndex: 1,
				delta: "Reasoning",
				partial,
			},
			{
				type: "toolcall_delta",
				contentIndex: 2,
				toolCallId: "call-1",
				argumentsDelta: '{"query":',
				partial,
			},
			{
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: {
					type: "tool_call",
					id: "call-1",
					name: "search",
					arguments: { query: "Areeb" },
				},
				partial,
			},
		];

		expect(events.map((event) => event.contentIndex)).toEqual([0, 1, 2, 2]);

		const deltaEvent = events.find((event) => event.type === "toolcall_delta");
		const endEvent = events.find((event) => event.type === "toolcall_end");

		expect(deltaEvent?.toolCallId).toBe("call-1");
		expect(endEvent?.toolCall.id).toBe("call-1");
	});

	test("keeps raw argument deltas separate from normalized tool calls", () => {
		const partial = partialMessage();
		const deltaEvent: Extract<
			AssistantMessageEvent,
			{ type: "toolcall_delta" }
		> = {
			type: "toolcall_delta",
			contentIndex: 0,
			toolCallId: "call-1",
			argumentsDelta: '{"query":"Areeb"}',
			partial,
		};
		const endEvent: Extract<AssistantMessageEvent, { type: "toolcall_end" }> = {
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: {
				type: "tool_call",
				id: "call-1",
				name: "search",
				arguments: { query: "Areeb" },
			},
			partial,
		};

		expect(typeof deltaEvent.argumentsDelta).toBe("string");
		expect(endEvent.toolCall.arguments).toEqual({ query: "Areeb" });
	});

	test("uses the terminal message as the single source of the stop reason", () => {
		type DoneEvent = Extract<AssistantMessageEvent, { type: "done" }>;
		type ErrorEvent = Extract<AssistantMessageEvent, { type: "error" }>;
		type DoneStopReason = DoneEvent["message"]["stopReason"];
		type ErrorStopReason = ErrorEvent["message"]["stopReason"];
		type DoneHasReason = "reason" extends keyof DoneEvent ? true : false;
		type ErrorHasReason = "reason" extends keyof ErrorEvent ? true : false;
		type FailedErrorMessageIsRequired =
			ErrorEvent["message"] extends Required<
				Pick<ErrorEvent["message"], "errorMessage">
			>
				? true
				: false;
		type SuccessfulErrorMessageIsForbidden =
			Exclude<DoneEvent["message"]["errorMessage"], undefined> extends never
				? true
				: false;

		const successReasons: DoneStopReason[] = ["stop", "length", "tool_call"];
		const failureReasons: ErrorStopReason[] = ["error", "aborted"];
		const doneHasReason: DoneHasReason = false;
		const errorHasReason: ErrorHasReason = false;
		const failedErrorMessageIsRequired: FailedErrorMessageIsRequired = true;
		const successfulErrorMessageIsForbidden: SuccessfulErrorMessageIsForbidden = true;

		const doneEvent: AssistantMessageEvent = {
			type: "done",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Truncated answer" }],
				provider: "anthropic",
				model: "claude-sonnet",
				usage: {
					inputTokens: 20,
					outputTokens: 10,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 30,
				},
				stopReason: "length",
				timestamp: 1_753_632_002_000,
			},
		};
		const errorEvent: AssistantMessageEvent = {
			type: "error",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Partial answer" }],
				provider: "anthropic",
				model: "claude-sonnet",
				usage: {
					inputTokens: 20,
					outputTokens: 4,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 24,
				},
				stopReason: "aborted",
				errorMessage: "The request was aborted",
				timestamp: 1_753_632_003_000,
			},
		};

		expect(successReasons).toEqual(["stop", "length", "tool_call"]);
		expect(failureReasons).toEqual(["error", "aborted"]);
		expect(doneEvent.message.stopReason).toBe("length");
		expect(errorEvent.message.stopReason).toBe("aborted");
		expect(doneHasReason).toBe(false);
		expect(errorHasReason).toBe(false);
		expect(failedErrorMessageIsRequired).toBe(true);
		expect(successfulErrorMessageIsForbidden).toBe(true);
	});

	test("preserves partial content and metadata on failure", () => {
		const event: Extract<AssistantMessageEvent, { type: "error" }> = {
			type: "error",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Partial answer" }],
				provider: "openai",
				model: "gpt-5",
				responseId: "response-2",
				usage: {
					inputTokens: 10,
					outputTokens: 3,
					cacheReadTokens: 2,
					cacheWriteTokens: 1,
					totalTokens: 16,
				},
				stopReason: "error",
				errorMessage: "The provider request failed",
				timestamp: 1_753_632_004_000,
			},
		};
		type ErrorEventHasStack = "stack" extends keyof typeof event ? true : false;
		const errorEventHasStack: ErrorEventHasStack = false;

		expect(event.message.content).toEqual([
			{ type: "text", text: "Partial answer" },
		]);
		expect(event.message.usage.outputTokens).toBe(3);
		expect(event.message.provider).toBe("openai");
		expect(event.message.errorMessage).toBe("The provider request failed");
		expect(errorEventHasStack).toBe(false);
		expect(() => JSON.stringify(event)).not.toThrow();
	});
});
