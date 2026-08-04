import { describe, expect, test } from "bun:test";
import type { AssistantMessageEvent } from "../../src/ai/events.ts";
import { FakeProvider } from "../../src/ai/fake_provider.ts";
import type { ModelProvider } from "../../src/ai/provider_protocol.ts";
import type { ModelContext } from "../../src/ai/types.ts";

function successfulScript(text: string): AssistantMessageEvent[] {
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		provider: "fake",
		model: "fake-model",
		usage: {
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 2,
		},
		stopReason: "stop" as const,
		timestamp: 1_753_632_000_000,
	};

	return [
		{ type: "start" },
		{ type: "text_start", contentIndex: 0 },
		{ type: "text_delta", contentIndex: 0, delta: text },
		{
			type: "text_end",
			contentIndex: 0,
			content: { type: "text", text },
		},
		{ type: "done", message },
	];
}

async function collect(
	stream: ReturnType<ModelProvider["streamResponse"]>,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("FakeProvider", () => {
	test("replays a scripted response and records a call snapshot", async () => {
		const script = successfulScript("Hello");
		const provider: ModelProvider & FakeProvider = new FakeProvider([script]);
		const context: ModelContext = {
			systemPrompt: "You are Areeb.",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hi" }],
					timestamp: 1_753_631_999_000,
				},
			],
		};

		const stream = provider.streamResponse("fake-model", context);
		context.messages.length = 0;
		const terminalEvent = script.at(-1);
		if (terminalEvent?.type !== "done") {
			throw new Error("The test script must end with a done event");
		}

		expect(await collect(stream)).toEqual(script);
		await expect(stream.result()).resolves.toBe(terminalEvent.message);
		expect(provider.providerId).toBe("fake");
		expect(provider.calls).toHaveLength(1);
		expect(provider.calls[0]?.model).toBe("fake-model");
		expect(provider.calls[0]?.context.systemPrompt).toBe("You are Areeb.");
		expect(provider.calls[0]?.context.messages).toHaveLength(1);
	});

	test("consumes one script per call", async () => {
		const first = successfulScript("First");
		const second = successfulScript("Second");
		const provider = new FakeProvider([first, second]);
		const context: ModelContext = { messages: [] };

		const firstEvents = await collect(
			provider.streamResponse("fake-model", context),
		);
		const secondEvents = await collect(
			provider.streamResponse("fake-model", context),
		);

		expect(firstEvents).toEqual(first);
		expect(secondEvents).toEqual(second);
		expect(provider.calls).toHaveLength(2);
	});

	test("fails fast when no scripted response remains", () => {
		const provider = new FakeProvider([]);

		expect(() =>
			provider.streamResponse("fake-model", { messages: [] }),
		).toThrow("no scripted response for call 1");
		expect(provider.calls).toHaveLength(1);
	});

	test("rejects a script without a terminal event", () => {
		const provider = new FakeProvider([[{ type: "start" }]]);

		expect(() =>
			provider.streamResponse("fake-model", { messages: [] }),
		).toThrow("must end with a done or error event");
	});

	test("emits an aborted terminal message when the signal is aborted", async () => {
		const controller = new AbortController();
		const provider = new FakeProvider([successfulScript("Never emitted")]);
		const stream = provider.streamResponse(
			"fake-model",
			{ messages: [] },
			{ signal: controller.signal },
		);
		controller.abort();

		const events = await collect(stream);

		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("error");
		const message = await stream.result();
		expect(message.stopReason).toBe("aborted");
		expect(message.errorMessage).toBe("The model request was aborted");
	});
});
