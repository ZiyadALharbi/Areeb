import { describe, expect, test } from "bun:test";
import {
	createAssistantMessageEventStream,
	EventStream,
} from "../../src/ai/event-stream.ts";
import type { AssistantMessageEvent } from "../../src/ai/events.ts";

type TestEvent =
	| { type: "value"; value: number }
	| { type: "done"; result: string };

function createTestStream(): EventStream<TestEvent, string> {
	return new EventStream(
		(event) => event.type === "done",
		(event) => {
			if (event.type === "done") {
				return event.result;
			}
			throw new Error("A value event has no result");
		},
	);
}

describe("EventStream", () => {
	test("preserves FIFO order while a consumer is waiting", async () => {
		const stream = createTestStream();
		const received: TestEvent[] = [];
		const consuming = (async () => {
			for await (const event of stream) {
				received.push(event);
			}
		})();

		stream.push({ type: "value", value: 1 });
		stream.push({ type: "value", value: 2 });
		stream.push({ type: "done", result: "complete" });

		await consuming;
		expect(received).toEqual([
			{ type: "value", value: 1 },
			{ type: "value", value: 2 },
			{ type: "done", result: "complete" },
		]);
		expect(await stream.result()).toBe("complete");
	});

	test("buffers events emitted before iteration", async () => {
		const stream = createTestStream();

		stream.push({ type: "value", value: 1 });
		stream.push({ type: "value", value: 2 });
		stream.push({ type: "done", result: "buffered" });

		const received: TestEvent[] = [];
		for await (const event of stream) {
			received.push(event);
		}

		expect(received).toEqual([
			{ type: "value", value: 1 },
			{ type: "value", value: 2 },
			{ type: "done", result: "buffered" },
		]);
		expect(await stream.result()).toBe("buffered");
	});

	test("a terminal event wakes pending iteration and completes it", async () => {
		const stream = createTestStream();
		const iterator = stream[Symbol.asyncIterator]();
		const terminalEvent = iterator.next();
		const afterTerminal = iterator.next();

		stream.push({ type: "done", result: "finished" });

		await expect(terminalEvent).resolves.toEqual({
			value: { type: "done", result: "finished" },
			done: false,
		});
		await expect(afterTerminal).resolves.toEqual({
			value: undefined,
			done: true,
		});
		await expect(stream.result()).resolves.toBe("finished");
	});

	test("an unexpected failure rejects iteration and the result", async () => {
		const stream = createTestStream();
		const failure = new Error("producer failed");
		const iterator = stream[Symbol.asyncIterator]();
		const nextEvent = iterator.next();
		const result = stream.result();

		stream.fail(failure);

		await expect(nextEvent).rejects.toBe(failure);
		await expect(result).rejects.toBe(failure);
	});

	test("throws on double completion", () => {
		const stream = createTestStream();

		stream.end("first");

		expect(() => stream.end("second")).toThrow(
			"after the event stream has completed",
		);
	});

	test("throws when emitting after completion", () => {
		const stream = createTestStream();

		stream.push({ type: "done", result: "finished" });

		expect(() => stream.push({ type: "value", value: 1 })).toThrow(
			"after the event stream has completed",
		);
	});

	test("rejects additional iterators", () => {
		const stream = createTestStream();

		stream[Symbol.asyncIterator]();

		expect(() => stream[Symbol.asyncIterator]()).toThrow(
			"supports only one iterator",
		);
	});
});

describe("AssistantMessageEventStream", () => {
	test("done completes with the successful AssistantMessage", async () => {
		const event: Extract<AssistantMessageEvent, { type: "done" }> = {
			type: "done",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
				provider: "openai",
				model: "gpt-5",
				usage: {
					inputTokens: 2,
					outputTokens: 1,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 3,
				},
				stopReason: "stop",
				timestamp: 1_753_632_000_000,
			},
		};
		const stream = createAssistantMessageEventStream();
		const startEvent: AssistantMessageEvent = {
			type: "start",
			partial: event.message,
		};
		const received: AssistantMessageEvent[] = [];
		const consuming = (async () => {
			for await (const receivedEvent of stream) {
				received.push(receivedEvent);
			}
		})();

		stream.push(startEvent);
		stream.push(event);

		await consuming;
		expect(received).toEqual([startEvent, event]);
		await expect(stream.result()).resolves.toBe(event.message);
	});

	test("error completes with the failed AssistantMessage", async () => {
		const event: Extract<AssistantMessageEvent, { type: "error" }> = {
			type: "error",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Partial answer" }],
				provider: "openai",
				model: "gpt-5",
				usage: {
					inputTokens: 2,
					outputTokens: 1,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 3,
				},
				stopReason: "error",
				errorMessage: "The provider request failed",
				timestamp: 1_753_632_000_000,
			},
		};
		const stream = createAssistantMessageEventStream();
		const startEvent: AssistantMessageEvent = {
			type: "start",
			partial: event.message,
		};
		const received: AssistantMessageEvent[] = [];
		const consuming = (async () => {
			for await (const receivedEvent of stream) {
				received.push(receivedEvent);
			}
		})();

		stream.push(startEvent);
		stream.push(event);

		await consuming;
		expect(received).toEqual([startEvent, event]);
		await expect(stream.result()).resolves.toBe(event.message);
	});
});
