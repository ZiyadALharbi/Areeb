import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	runAgentLoop,
	runAgentLoopContinue,
} from "../../src/agent/agent_loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
} from "../../src/agent/types.ts";
import type { AssistantMessageEvent } from "../../src/ai/events.ts";
import { FakeProvider } from "../../src/ai/fake_provider.ts";
import type { ModelProvider } from "../../src/ai/provider_protocol.ts";
import type {
	AssistantContent,
	AssistantMessage,
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

function partial(
	message: AssistantMessage,
	content: AssistantContent[] = [],
): AssistantMessage {
	return {
		...message,
		content,
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

function textScript(text: string): AssistantMessageEvent[] {
	const message = assistant([{ type: "text", text }]);
	return [
		{ type: "start", partial: partial(message) },
		{
			type: "text_start",
			contentIndex: 0,
			partial: partial(message, [{ type: "text", text: "" }]),
		},
		{
			type: "text_delta",
			contentIndex: 0,
			delta: text,
			partial: partial(message, [{ type: "text", text }]),
		},
		{
			type: "text_end",
			contentIndex: 0,
			content: { type: "text", text },
			partial: partial(message, [{ type: "text", text }]),
		},
		{ type: "done", message },
	];
}

function context(
	messages: AgentMessage[] = [],
	tools: AgentTool[] = [],
): AgentContext {
	return {
		systemPrompt: "You are Areeb.",
		messages,
		tools,
	};
}

function config(
	provider: ModelProvider,
	overrides: Partial<Omit<AgentLoopConfig, "provider" | "model">> = {},
): AgentLoopConfig {
	return {
		provider,
		model: "fake-model",
		...overrides,
	};
}

function collector(): {
	events: AgentEvent[];
	emit: (event: AgentEvent) => void;
} {
	const events: AgentEvent[] = [];
	return {
		events,
		emit: (event) => {
			events.push(event);
		},
	};
}

describe("runAgentLoop", () => {
	test("streams a text response without mutating the caller context", async () => {
		const provider = new FakeProvider([textScript("Hello")]);
		const prompt = user("Hi");
		const originalContext = context();
		const { events, emit } = collector();

		const result = await runAgentLoop(
			[prompt],
			originalContext,
			config(provider),
			emit,
		);

		expect(originalContext.messages).toEqual([]);
		expect(result).toEqual([
			prompt,
			assistant([{ type: "text", text: "Hello" }]),
		]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_update",
			"message_update",
			"message_update",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(events.at(-1)).toMatchObject({
			type: "agent_end",
			reason: "completed",
		});
	});

	test("executes tools sequentially, settles updates, and converts every turn", async () => {
		const firstMessage = assistant(
			[
				{
					type: "tool_call",
					id: "call-one",
					name: "number",
					arguments: { value: 1 },
				},
				{
					type: "tool_call",
					id: "call-two",
					name: "number",
					arguments: { value: 2 },
				},
			],
			"tool_call",
		);
		const provider = new FakeProvider([
			simpleScript(firstMessage),
			simpleScript(assistant([{ type: "text", text: "Done" }], "stop", 3)),
		]);
		const executionOrder: number[] = [];
		const tool: AgentTool<{ value: number }> = {
			name: "number",
			description: "Returns a number",
			inputSchema: z.object({ value: z.number() }),
			async execute(input, _signal, onUpdate) {
				executionOrder.push(input.value);
				void onUpdate?.({
					content: [{ type: "text", text: `working-${input.value}` }],
				});
				return {
					content: [{ type: "text", text: String(input.value) }],
				};
			},
		};
		const conversionSizes: number[] = [];
		const originalContext = context([], [tool]);
		originalContext.messageConverter = (messages) => {
			conversionSizes.push(messages.length);
			return messages as ReturnType<
				NonNullable<AgentContext["messageConverter"]>
			>;
		};
		const events: AgentEvent[] = [];
		const emit = async (event: AgentEvent): Promise<void> => {
			if (event.type === "tool_execution_update") {
				await Promise.resolve();
			}
			events.push(event);
		};

		const result = await runAgentLoop(
			[user("Use tools")],
			originalContext,
			config(provider),
			emit,
		);

		expect(executionOrder).toEqual([1, 2]);
		expect(conversionSizes).toEqual([1, 4]);
		expect(
			provider.calls[1]?.context.messages.map((message) => message.role),
		).toEqual(["user", "assistant", "tool_result", "tool_result"]);
		expect(
			events
				.filter((event) => event.type.startsWith("tool_execution_"))
				.map((event) => event.type),
		).toEqual([
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		]);
		expect(
			result.filter((message) => message.role === "tool_result"),
		).toHaveLength(2);
	});

	test("ignores tool updates emitted after execution settles", async () => {
		const firstMessage = assistant(
			[
				{
					type: "tool_call",
					id: "late-update",
					name: "deferred-update",
					arguments: {},
				},
			],
			"tool_call",
		);
		const provider = new FakeProvider([
			simpleScript(firstMessage),
			simpleScript(assistant([{ type: "text", text: "Done" }], "stop", 3)),
		]);
		let emitLateUpdate: (() => void | Promise<void>) | undefined;
		const tool: AgentTool = {
			name: "deferred-update",
			description: "Attempts an update after returning",
			inputSchema: z.object({}),
			async execute(_input, _signal, onUpdate) {
				emitLateUpdate = () =>
					onUpdate?.({ content: [{ type: "text", text: "too late" }] });
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const { events, emit } = collector();

		await runAgentLoop(
			[user("Use the tool")],
			context([], [tool]),
			config(provider),
			emit,
		);
		await emitLateUpdate?.();

		expect(
			events.filter((event) => event.type === "tool_execution_update"),
		).toEqual([]);
	});

	test("isolates unknown tools, invalid arguments, and tool exceptions", async () => {
		const calls: AssistantContent[] = [
			{
				type: "tool_call",
				id: "unknown",
				name: "missing",
				arguments: {},
			},
			{
				type: "tool_call",
				id: "invalid",
				name: "strict",
				arguments: { value: "wrong" },
			},
			{
				type: "tool_call",
				id: "broken",
				name: "broken",
				arguments: {},
			},
			{
				type: "tool_call",
				id: "good",
				name: "strict",
				arguments: { value: 4 },
			},
		];
		const provider = new FakeProvider([
			simpleScript(assistant(calls, "tool_call")),
			simpleScript(assistant([{ type: "text", text: "Recovered" }], "stop", 3)),
		]);
		const strict: AgentTool<{ value: number }> = {
			name: "strict",
			description: "Requires a number",
			inputSchema: z.object({ value: z.number() }),
			async execute(input) {
				return { content: [{ type: "text", text: String(input.value) }] };
			},
		};
		const broken: AgentTool = {
			name: "broken",
			description: "Throws",
			inputSchema: z.object({}),
			async execute() {
				throw new Error("boom");
			},
		};

		const result = await runAgentLoop(
			[user("Try every tool")],
			context([], [strict, broken]),
			config(provider),
			() => undefined,
		);
		const toolResults = result.filter(
			(message) => message.role === "tool_result",
		);

		expect(toolResults.map((message) => message.isError)).toEqual([
			true,
			true,
			true,
			false,
		]);
		expect(toolResults[0]?.content[0]).toEqual({
			type: "text",
			text: "Unknown tool: missing",
		});
		expect(
			toolResults[1]?.content[0]?.type === "text" &&
				toolResults[1].content[0].text,
		).toContain("Invalid arguments for tool strict");
		expect(toolResults[2]?.content[0]).toEqual({ type: "text", text: "boom" });
	});

	test("preserves provider errors as finalized messages", async () => {
		const failed: ErrorMessage = {
			...assistant([{ type: "text", text: "Partial" }]),
			stopReason: "error",
			errorMessage: "provider failed",
		};
		const provider = new FakeProvider([
			[
				{ type: "start", partial: partial(failed, failed.content) },
				{ type: "error", message: failed },
			],
		]);
		const { events, emit } = collector();

		const result = await runAgentLoop(
			[user("Hi")],
			context(),
			config(provider),
			emit,
		);

		expect(result.at(-1)).toBe(failed);
		expect(events.map((event) => event.type).slice(-3)).toEqual([
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(events.at(-1)).toMatchObject({
			type: "agent_end",
			reason: "provider_error",
		});
	});

	test("stops at maxTurns after completing the current tool batch", async () => {
		const provider = new FakeProvider([
			simpleScript(
				assistant(
					[
						{
							type: "tool_call",
							id: "call-one",
							name: "noop",
							arguments: {},
						},
					],
					"tool_call",
				),
			),
		]);
		const noop: AgentTool = {
			name: "noop",
			description: "No operation",
			inputSchema: z.object({}),
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const { events, emit } = collector();

		const result = await runAgentLoop(
			[user("Loop")],
			context([], [noop]),
			config(provider, { maxTurns: 1 }),
			emit,
		);

		expect(provider.calls).toHaveLength(1);
		expect(result.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool_result",
		]);
		expect(events.at(-1)).toMatchObject({
			type: "agent_end",
			reason: "max_turns",
		});
	});

	test("cancellation finalizes every remaining sequential tool call", async () => {
		const controller = new AbortController();
		const provider = new FakeProvider([
			simpleScript(
				assistant(
					[
						{
							type: "tool_call",
							id: "first",
							name: "cancel",
							arguments: {},
						},
						{
							type: "tool_call",
							id: "second",
							name: "cancel",
							arguments: {},
						},
					],
					"tool_call",
				),
			),
		]);
		let executions = 0;
		const cancel: AgentTool = {
			name: "cancel",
			description: "Cancels the run",
			inputSchema: z.object({}),
			async execute() {
				executions += 1;
				controller.abort();
				throw new Error("cancelled by tool");
			},
		};
		const { events, emit } = collector();

		const result = await runAgentLoop(
			[user("Cancel")],
			context([], [cancel]),
			config(provider),
			emit,
			controller.signal,
		);

		expect(executions).toBe(1);
		const toolResults = result.filter(
			(message) => message.role === "tool_result",
		);
		expect(toolResults).toHaveLength(2);
		expect(toolResults.map((message) => message.toolCallId)).toEqual([
			"first",
			"second",
		]);
		expect(toolResults[1]?.content).toEqual([
			{ type: "text", text: "Tool call interrupted by user" },
		]);
		expect(toolResults[1]?.isError).toBe(true);
		expect(events.at(-1)).toMatchObject({
			type: "agent_end",
			reason: "aborted",
		});
	});

	test("polls queued steering before the first provider request", async () => {
		const provider = new FakeProvider([
			simpleScript(assistant([{ type: "text", text: "First" }], "stop", 2)),
			simpleScript(assistant([{ type: "text", text: "Second" }], "stop", 3)),
		]);
		const steering = user("Steer", 10);
		const followUp = user("Follow up", 11);
		let steeringDrains = 0;
		let followUpDrains = 0;

		const result = await runAgentLoop(
			[user("Start")],
			context(),
			config(provider, {
				getSteeringMessages: () => (steeringDrains++ === 0 ? [steering] : []),
				getFollowUpMessages: () => (followUpDrains++ === 0 ? [followUp] : []),
			}),
			() => undefined,
		);

		expect(provider.calls).toHaveLength(2);
		expect(provider.calls[0]?.context.messages).toContain(steering);
		expect(provider.calls[1]?.context.messages).toContain(followUp);
		expect(result).toContain(steering);
		expect(result).toContain(followUp);
	});

	test("fails tool calls from length-truncated assistant messages", async () => {
		const provider = new FakeProvider([
			simpleScript(
				assistant(
					[
						{
							type: "tool_call",
							id: "truncated",
							name: "echo",
							arguments: { value: "partial" },
						},
					],
					"length",
				),
			),
			simpleScript(assistant([{ type: "text", text: "Recovered" }], "stop", 3)),
		]);
		let executions = 0;
		const echo: AgentTool<{ value: string }> = {
			name: "echo",
			description: "Echoes text",
			inputSchema: z.object({ value: z.string() }),
			async execute(input) {
				executions += 1;
				return { content: [{ type: "text", text: input.value }] };
			},
		};

		const result = await runAgentLoop(
			[user("Echo")],
			context([], [echo]),
			config(provider),
			() => undefined,
		);
		const toolResult = result.find((message) => message.role === "tool_result");

		expect(executions).toBe(0);
		expect(provider.calls).toHaveLength(2);
		expect(toolResult?.isError).toBe(true);
		expect(
			toolResult?.content[0]?.type === "text" && toolResult.content[0].text,
		).toContain("output token limit");
	});

	test("turns synchronous provider failures into terminal agent messages", async () => {
		const provider: ModelProvider = {
			providerId: "broken",
			streamResponse() {
				throw new Error("synchronous failure");
			},
		};
		const { events, emit } = collector();

		const result = await runAgentLoop(
			[user("Hi")],
			context(),
			config(provider),
			emit,
		);
		const failure = result.at(-1);

		expect(failure?.role).toBe("assistant");
		if (failure?.role === "assistant") {
			expect(failure.stopReason).toBe("error");
			expect(failure.errorMessage).toBe("synchronous failure");
		}
		expect(events.at(-1)).toMatchObject({
			type: "agent_end",
			reason: "provider_error",
		});
	});
});

describe("runAgentLoopContinue", () => {
	test("does not re-emit historical user messages", async () => {
		const historical = user("Existing");
		const provider = new FakeProvider([textScript("Continued")]);
		const { events, emit } = collector();

		const result = await runAgentLoopContinue(
			context([historical]),
			config(provider),
			emit,
		);

		expect(result).toEqual([assistant([{ type: "text", text: "Continued" }])]);
		expect(
			events.filter(
				(event) =>
					(event.type === "message_start" || event.type === "message_end") &&
					event.message === historical,
			),
		).toEqual([]);
	});
});
