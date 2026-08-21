import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AgentHarness } from "../../src/agent/harness.ts";
import type {
	AgentEvent,
	AgentHarnessConfig,
	AgentHarnessStreamOptions,
	AgentMessage,
	AgentRunStream,
	AgentTool,
} from "../../src/agent/types.ts";
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "../../src/ai/event-stream.ts";
import type { AssistantMessageEvent } from "../../src/ai/events.ts";
import { FakeProvider } from "../../src/ai/fake_provider.ts";
import type {
	ModelProvider,
	StreamOptions,
} from "../../src/ai/provider_protocol.ts";
import type {
	AssistantContent,
	AssistantMessage,
	Message,
	ModelContext,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../../src/ai/types.ts";

type DoneMessage = Extract<AssistantMessageEvent, { type: "done" }>["message"];
type ErrorMessage = Extract<
	AssistantMessageEvent,
	{ type: "error" }
>["message"];

const EMPTY_USAGE = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

function user(text: string, timestamp = 1): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	};
}

function assistant(
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

function failedAssistant(
	stopReason: ErrorMessage["stopReason"],
	errorMessage: string,
	timestamp = 2,
): ErrorMessage {
	return {
		role: "assistant",
		content: [],
		provider: "controlled",
		model: "fake-model",
		usage: { ...EMPTY_USAGE },
		stopReason,
		errorMessage,
		timestamp,
	};
}

function partial(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map((content) => ({ ...content })),
		usage: { ...message.usage },
		stopReason: "stop",
	};
}

function simpleScript(message: DoneMessage): AssistantMessageEvent[] {
	return [
		{ type: "start", partial: partial(message) },
		{ type: "done", message },
	];
}

function errorScript(message: ErrorMessage): AssistantMessageEvent[] {
	return [
		{ type: "start", partial: partial(message) },
		{ type: "error", message },
	];
}

function textScript(text: string, timestamp = 2): AssistantMessageEvent[] {
	return simpleScript(assistant([{ type: "text", text }], "stop", timestamp));
}

function toolCall(
	id: string,
	name = "work",
	arguments_: Record<string, unknown> = {},
): ToolCall {
	return { type: "tool_call", id, name, arguments: arguments_ };
}

function toolResult(
	call: ToolCall,
	text = "ok",
	timestamp = 3,
): ToolResultMessage {
	return {
		role: "tool_result",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function harness(
	provider: ModelProvider,
	overrides: Partial<Omit<AgentHarnessConfig, "provider" | "model">> = {},
	messages: readonly AgentMessage[] = [],
): AgentHarness {
	return new AgentHarness(
		{
			provider,
			model: "fake-model",
			systemPrompt: "You are Areeb.",
			...overrides,
		},
		messages,
	);
}

function messageText(message: AgentMessage): string | undefined {
	if (
		typeof message !== "object" ||
		message === null ||
		!("content" in message) ||
		!Array.isArray(message.content)
	) {
		return undefined;
	}
	const content = message.content[0];
	return content?.type === "text" ? content.text : undefined;
}

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function waitUntil(
	predicate: () => boolean,
	description: string,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) {
			return;
		}
		await Promise.resolve();
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function consume(stream: AgentRunStream): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

interface RecordedProviderCall {
	readonly model: string;
	readonly context: ModelContext;
	readonly options?: StreamOptions;
}

class AbortAwareProvider implements ModelProvider {
	readonly providerId = "controlled";
	readonly calls: RecordedProviderCall[] = [];

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

		const stream = createAssistantMessageEventStream();
		let settled = false;
		const finishAborted = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			stream.push({
				type: "error",
				message: failedAssistant("aborted", "The model request was aborted"),
			});
		};

		stream.push({
			type: "start",
			partial: partial(assistant([])),
		});
		if (options?.signal?.aborted) {
			finishAborted();
		} else {
			options?.signal?.addEventListener("abort", finishAborted, { once: true });
		}
		return stream;
	}
}

class ControlledPromptProvider implements ModelProvider {
	readonly providerId = "controlled";
	readonly calls: RecordedProviderCall[] = [];
	private readonly streams: AssistantMessageEventStream[] = [];

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
		const stream = createAssistantMessageEventStream();
		this.streams.push(stream);
		stream.push({ type: "start", partial: partial(assistant([])) });
		return stream;
	}

	finish(callIndex: number, text: string): void {
		const stream = this.streams[callIndex];
		if (stream === undefined) {
			throw new Error(`Provider call ${callIndex} is not waiting`);
		}
		stream.push({
			type: "done",
			message: assistant([{ type: "text", text }], "stop", callIndex + 2),
		});
	}
}

describe("AgentHarness construction and ownership", () => {
	test("excludes externally owned signals from stable stream options", () => {
		const externalSignal = new AbortController().signal;
		const invalidOptions: AgentHarnessStreamOptions = {
			// @ts-expect-error A harness creates a new AbortController for each run.
			signal: externalSignal,
		};

		expect((invalidOptions as unknown as { signal: AbortSignal }).signal).toBe(
			externalSignal,
		);
	});

	test("validates provider, model, maxTurns, queue modes, and duplicate tools", () => {
		const provider = new FakeProvider([]);
		const duplicate: AgentTool = {
			name: "duplicate",
			description: "Duplicate",
			inputSchema: z.object({}),
			async execute() {
				return { content: [] };
			},
		};

		expect(
			() =>
				new AgentHarness({
					provider: undefined,
					model: "fake-model",
					systemPrompt: "system",
				} as unknown as AgentHarnessConfig),
		).toThrow("requires a model provider");
		expect(
			() =>
				new AgentHarness({
					provider,
					model: "   ",
					systemPrompt: "system",
				}),
		).toThrow("requires a model name");
		for (const maxTurns of [0, -1, 1.5]) {
			expect(() => harness(provider, { maxTurns })).toThrow(
				"maxTurns must be a positive integer",
			);
		}
		expect(() =>
			harness(provider, {
				steeringMode: "invalid" as AgentHarnessConfig["steeringMode"],
			}),
		).toThrow("Invalid steeringMode");
		expect(() =>
			harness(provider, {
				followUpMode: "invalid" as AgentHarnessConfig["followUpMode"],
			}),
		).toThrow("Invalid followUpMode");
		expect(() => harness(provider, { tools: [duplicate, duplicate] })).toThrow(
			"Duplicate agent tool name: duplicate",
		);
	});

	test("copies initial messages, tools, and stream options", async () => {
		const provider = new FakeProvider([textScript("Done")]);
		const initial = user("Historical");
		const initialMessages: AgentMessage[] = [initial];
		const originalTool: AgentTool = {
			name: "original",
			description: "Original",
			inputSchema: z.object({}),
			async execute() {
				return { content: [] };
			},
		};
		const tools: AgentTool[] = [originalTool];
		const streamOptions = { timeout: 25, reasoning: "low" as const };
		const agent = harness(provider, { tools, streamOptions }, initialMessages);

		initialMessages.push(user("Added too late"));
		tools.length = 0;
		streamOptions.timeout = 999;

		await agent.prompt("New").result();

		expect(agent.messages[0]).toBe(initial);
		expect(agent.messages.map(messageText)).not.toContain("Added too late");
		expect(provider.calls[0]?.context.tools).toEqual([originalTool]);
		expect(provider.calls[0]?.options).toMatchObject({
			timeout: 25,
			reasoning: "low",
		});
		expect(provider.calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
	});

	test("replaces the system prompt only while idle without changing runtime state", async () => {
		const provider = new ControlledPromptProvider();
		const historical = user("Historical", 0);
		const tool: AgentTool = {
			name: "work",
			description: "Work",
			inputSchema: z.object({}),
			async execute() {
				return { content: [] };
			},
		};
		const agent = harness(
			provider,
			{ tools: [tool], streamOptions: { reasoning: "high", timeout: 25 } },
			[historical],
		);

		expect(agent.systemPrompt).toBe("You are Areeb.");
		const first = agent.prompt("First");
		await waitUntil(
			() => provider.calls.length === 1,
			"the first provider call",
		);
		expect(provider.calls[0]?.context.systemPrompt).toBe("You are Areeb.");
		expect(() => agent.replaceSystemPrompt("Replacement")).toThrow(
			"already running",
		);
		provider.finish(0, "First response");
		await first.result();

		agent.steer("Queued");
		const messagesBeforeReplacement = agent.messages;
		const queuesBeforeReplacement = agent.queuedMessages;
		agent.replaceSystemPrompt("Replacement");
		expect(agent.systemPrompt).toBe("Replacement");
		expect(agent.messages).toEqual(messagesBeforeReplacement);
		expect(agent.queuedMessages).toEqual(queuesBeforeReplacement);

		const second = agent.prompt("Second");
		await waitUntil(
			() => provider.calls.length === 2,
			"the second provider call",
		);
		expect(provider.calls[1]).toMatchObject({
			model: "fake-model",
			context: { systemPrompt: "Replacement", tools: [tool] },
			options: { reasoning: "high", timeout: 25 },
		});
		provider.finish(1, "Second response");
		await second.result();
	});
});

describe("AgentHarness prompt lifecycle", () => {
	test("reduces finalized messages once and returns invocation-local messages", async () => {
		const historical = user("Historical", 0);
		const prompt = user("Prompt", 1);
		const response = assistant([{ type: "text", text: "Response" }], "stop", 2);
		const provider = new FakeProvider([simpleScript(response)]);
		const agent = harness(provider, {}, [historical]);
		const stream = agent.prompt(prompt);
		const eventsPromise = consume(stream);

		const result = await stream.result();
		const events = await eventsPromise;

		expect(result).toEqual([prompt, response]);
		expect(agent.messages).toEqual([historical, prompt, response]);
		expect(agent.messages.filter((message) => message === prompt)).toHaveLength(
			1,
		);
		expect(
			agent.messages.filter((message) => message === response),
		).toHaveLength(1);
		expect(
			events
				.filter((event) => event.type === "message_end")
				.map((event) => event.message),
		).toEqual([prompt, response]);
		expect(agent.isRunning).toBe(false);
	});

	test("starts in the background without creating or consuming an iterator", async () => {
		const provider = new FakeProvider([textScript("Background")]);
		const agent = harness(provider);
		const stream = agent.prompt("Start");

		await waitUntil(() => provider.calls.length === 1, "the provider request");
		expect(provider.calls).toHaveLength(1);
		expect(agent.messages.map(messageText)).toContain("Start");

		const result = await stream.result();
		expect(result.map(messageText)).toEqual(["Start", "Background"]);
	});

	test("rejects overlap synchronously and settles idle after provider failure", async () => {
		const failure = failedAssistant("error", "provider failed");
		const provider = new FakeProvider([errorScript(failure)]);
		const agent = harness(provider);
		const stream = agent.prompt("First");
		const idle = agent.waitForIdle();

		expect(() => agent.prompt("Overlap")).toThrow("already running");
		expect(() => agent.continue()).toThrow("already running");
		expect(agent.isRunning).toBe(true);

		const result = await stream.result();
		await idle;

		expect(result.at(-1)).toBe(failure);
		expect(agent.isRunning).toBe(false);
		expect(() => agent.appendMessage(user("Idle again"))).not.toThrow();
	});

	test("awaits listeners after transcript reduction, preserves order, and unsubscribes", async () => {
		const firstResponse = assistant(
			[{ type: "text", text: "First" }],
			"stop",
			2,
		);
		const secondResponse = assistant(
			[{ type: "text", text: "Second" }],
			"stop",
			3,
		);
		const provider = new FakeProvider([
			simpleScript(firstResponse),
			simpleScript(secondResponse),
		]);
		const agent = harness(provider);
		const listenerEntered = deferred();
		const releaseListener = deferred();
		const timeline: string[] = [];
		let listenerEvent: AgentEvent | undefined;

		const unsubscribeFirst = agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message === firstResponse) {
				listenerEvent = event;
				timeline.push("first listener entered");
				expect(agent.messages.at(-1)).toBe(firstResponse);
				listenerEntered.resolve();
				await releaseListener.promise;
				timeline.push("first listener settled");
			}
		});
		const unsubscribeSecond = agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				timeline.push(`second listener: ${messageText(event.message)}`);
			}
		});

		const firstStream = agent.prompt("One");
		const observedEvents: AgentEvent[] = [];
		const consumption = (async () => {
			for await (const event of firstStream) {
				observedEvents.push(event);
			}
		})();
		await listenerEntered.promise;

		expect(timeline).toEqual(["first listener entered"]);
		expect(
			observedEvents.some(
				(event) =>
					event.type === "message_end" && event.message === firstResponse,
			),
		).toBe(false);

		releaseListener.resolve();
		await firstStream.result();
		await consumption;
		expect(timeline).toEqual([
			"first listener entered",
			"first listener settled",
			"second listener: First",
		]);
		expect(
			observedEvents.find(
				(event) =>
					event.type === "message_end" && event.message === firstResponse,
			),
		).toBe(listenerEvent);

		unsubscribeSecond();
		await agent.prompt("Two").result();
		expect(timeline).not.toContain("second listener: Second");
		unsubscribeFirst();
	});

	test("rejects the stream on listener failure and always clears active state", async () => {
		const provider = new FakeProvider([textScript("Completed")]);
		const agent = harness(provider);
		agent.subscribe((event) => {
			if (event.type === "agent_end") {
				throw new Error("listener exploded");
			}
		});

		const stream = agent.prompt("Run");
		const idle = agent.waitForIdle();
		await expect(stream.result()).rejects.toThrow("listener exploded");
		await idle;

		expect(agent.isRunning).toBe(false);
		expect(agent.messages.map(messageText)).toEqual(["Run", "Completed"]);
		expect(() => agent.replaceMessages([user("Recovered")])).not.toThrow();
	});
});

describe("AgentHarness queues", () => {
	test("polls pre-existing steering before the first prompt provider request", async () => {
		const provider = new FakeProvider([textScript("Done")]);
		const agent = harness(provider);
		agent.steer("Steer first");

		const result = await agent.prompt("Prompt").result();

		expect(result.map(messageText)).toEqual(["Prompt", "Steer first", "Done"]);
		expect(provider.calls[0]?.context.messages.map(messageText)).toEqual([
			"Prompt",
			"Steer first",
		]);
	});

	test("uses independent default FIFO queues with steering precedence", async () => {
		const provider = new FakeProvider([
			textScript("A1", 2),
			textScript("A2", 3),
			textScript("A3", 4),
		]);
		const agent = harness(provider, {}, [
			assistant([{ type: "text", text: "Old" }]),
		]);
		agent.steer("S1");
		agent.steer("S2");
		agent.followUp("F1");

		const result = await agent.continue().result();

		expect(result.map(messageText)).toEqual([
			"S1",
			"A1",
			"S2",
			"A2",
			"F1",
			"A3",
		]);
		expect(provider.calls).toHaveLength(3);
		expect(agent.pendingMessageCount).toBe(0);
	});

	test("configures steering and follow-up drain modes separately", async () => {
		const provider = new FakeProvider([
			textScript("A1", 2),
			textScript("A2", 3),
			textScript("A3", 4),
		]);
		const agent = harness(
			provider,
			{ steeringMode: "all", followUpMode: "one_at_a_time" },
			[assistant([{ type: "text", text: "Old" }])],
		);
		agent.steer("S1");
		agent.steer("S2");
		agent.followUp("F1");
		agent.followUp("F2");

		const result = await agent.continue().result();

		expect(result.map(messageText)).toEqual([
			"S1",
			"S2",
			"A1",
			"F1",
			"A2",
			"F2",
			"A3",
		]);
	});

	test("populates idle queues and returns isolated enqueue and clear snapshots", () => {
		const agent = harness(new FakeProvider([]));
		const steering = user("steering");
		const followUp = user("follow-up");
		const firstSnapshot = agent.steer(steering);
		agent.followUp(followUp);

		expect(firstSnapshot).toEqual({
			steering: [steering],
			followUp: [],
			count: 1,
		});
		expect(agent.queuedMessages).toEqual({
			steering: [steering],
			followUp: [followUp],
			count: 2,
		});
		expect(agent.pendingMessageCount).toBe(2);

		(firstSnapshot.steering as AgentMessage[]).length = 0;
		expect(agent.queuedMessages.steering).toEqual([steering]);

		expect(agent.clearSteeringQueue()).toEqual({
			steering: [steering],
			followUp: [],
			count: 1,
		});
		expect(agent.queuedMessages.followUp).toEqual([followUp]);
		expect(agent.clearFollowUpQueue()).toEqual({
			steering: [],
			followUp: [followUp],
			count: 1,
		});

		agent.steer("S2");
		agent.followUp("F2");
		expect(agent.clearQueues()).toMatchObject({ count: 2 });
		expect(agent.queuedMessages).toEqual({
			steering: [],
			followUp: [],
			count: 0,
		});
	});
});

describe("AgentHarness cancellation", () => {
	test("cancels a cooperative provider stream and preserves queued input", async () => {
		const provider = new AbortAwareProvider();
		const agent = harness(provider);
		const steering = user("Preserve steering");
		const followUp = user("Preserve follow-up");
		const endReasons: string[] = [];
		agent.subscribe((event) => {
			if (event.type === "agent_end") {
				endReasons.push(event.reason);
			}
		});

		const stream = agent.prompt("Start");
		await waitUntil(() => provider.calls.length === 1, "provider streaming");
		agent.steer(steering);
		agent.followUp(followUp);
		agent.abort();
		agent.abort();
		const result = await stream.result();

		expect(result.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
		expect(endReasons).toEqual(["aborted"]);
		expect(agent.queuedMessages).toEqual({
			steering: [steering],
			followUp: [followUp],
			count: 2,
		});
		expect(agent.isRunning).toBe(false);
	});

	test("finalizes every call when cancelled at each position in a sequential tool batch", async () => {
		for (const abortAt of [0, 1, 2]) {
			const calls = [
				toolCall("call-0", "work", { position: 0 }),
				toolCall("call-1", "work", { position: 1 }),
				toolCall("call-2", "work", { position: 2 }),
			];
			const provider = new FakeProvider([
				simpleScript(assistant(calls, "tool_call")),
			]);
			const executed: number[] = [];
			let agent: AgentHarness;
			const tool: AgentTool<{ position: number }> = {
				name: "work",
				description: "Work",
				inputSchema: z.object({ position: z.number() }),
				async execute(input) {
					executed.push(input.position);
					if (input.position === abortAt) {
						agent.abort();
					}
					return {
						content: [{ type: "text", text: `done-${input.position}` }],
					};
				},
			};
			agent = harness(provider, { tools: [tool] });

			const result = await agent.prompt("Run tools").result();
			const results = result.filter(
				(message): message is ToolResultMessage =>
					message.role === "tool_result",
			);

			expect(executed).toEqual([0, 1, 2].slice(0, abortAt + 1));
			expect(results.map((message) => message.toolCallId)).toEqual([
				"call-0",
				"call-1",
				"call-2",
			]);
			for (const [index, resultMessage] of results.entries()) {
				if (index <= abortAt) {
					expect(resultMessage.isError).toBe(false);
				} else {
					expect(resultMessage).toMatchObject({
						isError: true,
						content: [{ type: "text", text: "Tool call interrupted by user" }],
					});
				}
			}
			expect(agent.messages.at(-1)).toBe(results[2]);
		}
	});

	test("synthesizes the current and remaining results when aborted before each tool position", async () => {
		for (const abortBefore of [0, 1, 2]) {
			const calls = [
				toolCall("call-0", "work", { position: 0 }),
				toolCall("call-1", "work", { position: 1 }),
				toolCall("call-2", "work", { position: 2 }),
			];
			const provider = new FakeProvider([
				simpleScript(assistant(calls, "tool_call")),
			]);
			const executed: number[] = [];
			const tool: AgentTool<{ position: number }> = {
				name: "work",
				description: "Work",
				inputSchema: z.object({ position: z.number() }),
				async execute(input) {
					executed.push(input.position);
					return { content: [{ type: "text", text: "done" }] };
				},
			};
			const agent = harness(provider, { tools: [tool] });
			agent.subscribe((event) => {
				if (
					event.type === "tool_execution_start" &&
					event.toolCall.arguments.position === abortBefore
				) {
					agent.abort();
				}
			});

			const result = await agent.prompt("Run tools").result();
			const results = result.filter(
				(message): message is ToolResultMessage =>
					message.role === "tool_result",
			);

			expect(executed).toEqual([0, 1, 2].slice(0, abortBefore));
			expect(results).toHaveLength(3);
			for (const [index, resultMessage] of results.entries()) {
				expect(resultMessage.isError).toBe(index >= abortBefore);
			}
		}
	});
});

describe("AgentHarness continuation", () => {
	test("rejects empty and unqueued assistant-tail continuations", () => {
		const provider = new FakeProvider([]);
		expect(() => harness(provider).continue()).toThrow(
			"Cannot continue: no messages in transcript",
		);
		expect(() =>
			harness(provider, {}, [
				assistant([{ type: "text", text: "Already answered" }]),
			]).continue(),
		).toThrow("without queued messages");
		expect(provider.calls).toHaveLength(0);
	});

	test("uses loop continuation for valid user and tool-result tails", async () => {
		const tailCases: Message[][] = [
			[user("Continue this")],
			(() => {
				const call = toolCall("finished");
				return [assistant([call], "tool_call"), toolResult(call)];
			})(),
		];

		for (const [index, history] of tailCases.entries()) {
			const provider = new FakeProvider([textScript(`Continued ${index}`)]);
			const agent = harness(provider, {}, history);
			const historicalTail = history.at(-1);
			const stream = agent.continue();
			const eventsPromise = consume(stream);

			const result = await stream.result();
			const events = await eventsPromise;

			expect(result.map(messageText)).toEqual([`Continued ${index}`]);
			expect(provider.calls[0]?.context.messages).toEqual(history);
			expect(
				events.some(
					(event) =>
						(event.type === "message_start" || event.type === "message_end") &&
						event.message === historicalTail,
				),
			).toBe(false);
		}
	});

	test("drains steering before follow-up from an assistant tail", async () => {
		const provider = new FakeProvider([
			textScript("After steering", 3),
			textScript("After follow-up", 4),
		]);
		const agent = harness(provider, {}, [
			assistant([{ type: "text", text: "Assistant tail" }]),
		]);
		agent.followUp("Follow-up");
		agent.steer("Steering");

		const result = await agent.continue().result();

		expect(result.map(messageText)).toEqual([
			"Steering",
			"After steering",
			"Follow-up",
			"After follow-up",
		]);
		expect(provider.calls[0]?.context.messages.map(messageText)).toEqual([
			"Assistant tail",
			"Steering",
		]);
	});

	test("starts a prompt run from follow-up when an assistant tail has no steering", async () => {
		const provider = new FakeProvider([textScript("After follow-up", 3)]);
		const assistantTail = assistant([{ type: "text", text: "Assistant tail" }]);
		const agent = harness(provider, {}, [assistantTail]);
		agent.followUp("Only follow-up");

		const result = await agent.continue().result();

		expect(result.map(messageText)).toEqual([
			"Only follow-up",
			"After follow-up",
		]);
		expect(provider.calls[0]?.context.messages.map(messageText)).toEqual([
			"Assistant tail",
			"Only follow-up",
		]);
	});
});

describe("AgentHarness transcript mutation and repair", () => {
	test("returns shallow snapshots and copies replacement arrays", () => {
		const first = user("First");
		const second = user("Second");
		const source: AgentMessage[] = [first];
		const agent = harness(new FakeProvider([]), {}, source);
		const snapshot = agent.messages;

		expect(snapshot).not.toBe(agent.messages);
		expect(snapshot[0]).toBe(first);
		(snapshot as AgentMessage[]).push(second);
		expect(agent.messages).toEqual([first]);

		agent.appendMessage(second);
		expect(agent.messages).toEqual([first, second]);
		agent.replaceMessages(source);
		source.push(second);
		expect(agent.messages).toEqual([first]);
	});

	test("guards append, replace, and repair while active", async () => {
		const provider = new AbortAwareProvider();
		const agent = harness(provider);
		const stream = agent.prompt("Running");

		expect(() => agent.appendMessage(user("No"))).toThrow("already running");
		expect(() => agent.replaceMessages([])).toThrow("already running");
		expect(() => agent.repairInterruptedToolCalls()).toThrow("already running");

		agent.abort();
		await stream.result();
		expect(() => agent.replaceMessages([user("Idle")])).not.toThrow();
	});

	test("repairs only missing tail results in order and is idempotent", () => {
		const firstCall = toolCall("first");
		const secondCall = toolCall("second");
		const existingResult = toolResult(firstCall);
		const agent = harness(new FakeProvider([]), {}, [
			assistant([firstCall, secondCall], "tool_call"),
			existingResult,
		]);

		const repairs = agent.repairInterruptedToolCalls();

		expect(repairs).toHaveLength(1);
		expect(repairs[0]).toMatchObject({
			role: "tool_result",
			toolCallId: "second",
			toolName: "work",
			isError: true,
			content: [{ type: "text", text: "Tool call interrupted by user" }],
		});
		expect(agent.messages).toEqual([
			expect.any(Object),
			existingResult,
			repairs[0],
		]);
		expect(agent.repairInterruptedToolCalls()).toEqual([]);
		expect(agent.messages).toHaveLength(3);
	});

	test("does not duplicate a complete batch or an existing result", () => {
		const firstCall = toolCall("first");
		const secondCall = toolCall("second");
		const firstResult = toolResult(firstCall);
		const secondResult = toolResult(secondCall);
		const agent = harness(new FakeProvider([]), {}, [
			assistant([firstCall, secondCall], "tool_call"),
			firstResult,
			secondResult,
		]);

		expect(agent.repairInterruptedToolCalls()).toEqual([]);
		expect(agent.messages).toEqual([
			expect.any(Object),
			firstResult,
			secondResult,
		]);
	});

	test("repairs before prompting and rejects malformed non-tail gaps before a provider request", async () => {
		const missing = toolCall("missing");
		const repairProvider = new FakeProvider([textScript("Recovered")]);
		const repairAgent = harness(repairProvider, {}, [
			assistant([missing], "tool_call"),
		]);

		const result = await repairAgent.prompt("Proceed").result();
		expect(result.map(messageText)).toEqual(["Proceed", "Recovered"]);
		expect(repairProvider.calls[0]?.context.messages).toMatchObject([
			{ role: "assistant" },
			{
				role: "tool_result",
				toolCallId: "missing",
				isError: true,
			},
			{ role: "user" },
		]);

		const first = toolCall("first");
		const second = toolCall("second");
		const malformedProvider = new FakeProvider([textScript("Never")]);
		const malformedAgent = harness(malformedProvider, {}, [
			assistant([first, second], "tool_call"),
			toolResult(first),
			user("Unrelated later history"),
		]);

		expect(() => malformedAgent.prompt("Do not send")).toThrow(
			"Cannot repair malformed transcript",
		);
		expect(malformedProvider.calls).toHaveLength(0);
	});

	test("rejects orphaned, out-of-order, mismatched, and duplicate tool history", () => {
		const first = toolCall("first", "work");
		const second = toolCall("second", "other");
		const invalidHistories: AgentMessage[][] = [
			[toolResult(first)],
			[assistant([first, second], "tool_call"), toolResult(second)],
			[
				assistant([first], "tool_call"),
				{ ...toolResult(first), toolName: "wrong" },
			],
			[assistant([first, { ...first }], "tool_call")],
		];

		for (const history of invalidHistories) {
			const agent = harness(new FakeProvider([]), {}, history);
			expect(() => agent.repairInterruptedToolCalls()).toThrow(
				"Cannot repair malformed transcript",
			);
		}
	});
});

describe("AgentHarness max-turn continuation", () => {
	test("continues a max-turn tool tail and keeps results invocation-local", async () => {
		const call = toolCall("one", "noop");
		const provider = new FakeProvider([
			simpleScript(assistant([call], "tool_call", 2)),
			textScript("Finished", 4),
		]);
		const noop: AgentTool = {
			name: "noop",
			description: "No operation",
			inputSchema: z.object({}),
			async execute() {
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const historical = user("Historical", 0);
		const agent = harness(provider, { tools: [noop], maxTurns: 1 }, [
			historical,
		]);
		const endReasons: string[] = [];
		agent.subscribe((event) => {
			if (event.type === "agent_end") {
				endReasons.push(event.reason);
			}
		});

		const firstResult = await agent.prompt("Start").result();
		expect(firstResult.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool_result",
		]);
		expect(firstResult).not.toContain(historical);
		expect(provider.calls).toHaveLength(1);
		expect(endReasons).toEqual(["max_turns"]);

		const continuationResult = await agent.continue().result();
		expect(continuationResult.map(messageText)).toEqual(["Finished"]);
		expect(continuationResult).not.toContain(historical);
		expect(agent.messages).toEqual([
			historical,
			...firstResult,
			...continuationResult,
		]);
		expect(provider.calls).toHaveLength(2);
		expect(endReasons).toEqual(["max_turns", "completed"]);
	});
});
