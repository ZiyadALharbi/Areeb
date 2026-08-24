import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentMessage } from "../../../src/agent/types.ts";
import type {
	AssistantMessage,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../../../src/ai/types.ts";
import { TuiEventAdapter } from "../../../src/coding/tui/adapter.ts";
import { createTuiState } from "../../../src/coding/tui/state.ts";
import { assistant, EMPTY_USAGE, failedAssistant } from "../modes/helpers.ts";

const user: UserMessage = {
	role: "user",
	content: [{ type: "text", text: "hello" }],
	timestamp: 1,
};
const toolCall: ToolCall = {
	type: "tool_call",
	id: "call-1",
	name: "read",
	arguments: {},
};
const toolResult: ToolResultMessage = {
	role: "tool_result",
	toolCallId: toolCall.id,
	toolName: toolCall.name,
	content: [{ type: "text", text: "hidden result" }],
	isError: false,
	timestamp: 3,
};

describe("TuiEventAdapter", () => {
	test("restores visible transcript content including separate thinking rows", () => {
		const state = createTuiState();
		const adapter = new TuiEventAdapter(state);
		const imageOnly: UserMessage = {
			role: "user",
			content: [{ type: "image", data: "ignored", mimeType: "image/png" }],
			timestamp: 0,
		};
		const response = assistant([
			{ type: "thinking", thinking: "private" },
			{ type: "text", text: "answer" },
			toolCall,
		]);
		const custom = {
			role: "custom",
			content: "ignored",
		} as unknown as AgentMessage;

		expect(
			adapter.restore([imageOnly, user, response, toolResult, custom]),
		).toBe(true);
		expect(state).toEqual({
			items: [
				{ role: "user", text: "[image]" },
				{ role: "user", text: "hello" },
				{ role: "thinking", text: "private" },
				{ role: "assistant", text: "answer" },
				{
					role: "tool",
					text: "read",
					toolName: "read",
					toolCallId: "call-1",
					preview: "hidden result",
					isError: false,
				},
			],
			lastUsage: { ...EMPTY_USAGE },
			sessionId: "unknown",
			model: "unknown model",
			cwd: ".",
			reasoning: "off",
			running: false,
			inputMode: "idle",
			queuedCount: 0,
		});
	});

	test("live events match restored messages without duplicate rows", () => {
		const response = assistant([
			{ type: "thinking", thinking: "private" },
			{ type: "text", text: "answer" },
			toolCall,
		]);
		const thinkingPartial: AssistantMessage = {
			...response,
			content: [{ type: "thinking", thinking: "pri" }],
			usage: { ...EMPTY_USAGE },
		};
		const textPartial: AssistantMessage = {
			...response,
			content: [
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: "ans" },
			],
			usage: { ...EMPTY_USAGE },
		};
		const state = createTuiState();
		const adapter = new TuiEventAdapter(state);

		expect(adapter.apply({ type: "message_start", message: user })).toBe(false);
		expect(adapter.apply({ type: "message_end", message: user })).toBe(true);
		expect(adapter.apply({ type: "message_end", message: user })).toBe(false);
		expect(
			adapter.apply({
				type: "message_update",
				message: thinkingPartial,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "pri",
					partial: thinkingPartial,
				},
			}),
		).toBe(true);
		expect(state.assistantBlocks).toEqual([{ role: "thinking", text: "pri" }]);
		expect(
			adapter.apply({
				type: "message_update",
				message: textPartial,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 1,
					delta: "ans",
					partial: textPartial,
				},
			}),
		).toBe(true);
		expect(state.assistantBlocks).toEqual([
			{ role: "thinking", text: "private" },
			{ role: "assistant", text: "ans" },
		]);
		expect(state.assistantBuffer).toBe("ans");
		expect(adapter.apply({ type: "message_end", message: response })).toBe(
			true,
		);
		expect(state.assistantBlocks).toBeUndefined();
		expect(state.assistantBuffer).toBeUndefined();
		expect(adapter.apply({ type: "tool_execution_start", toolCall })).toBe(
			false,
		);
		expect(
			adapter.apply({
				type: "tool_execution_end",
				toolCall,
				result: toolResult,
			}),
		).toBe(true);
		expect(adapter.apply({ type: "message_end", message: toolResult })).toBe(
			false,
		);

		const restored = createTuiState();
		new TuiEventAdapter(restored).restore([user, response, toolResult]);
		expect(state.items).toEqual(restored.items);
	});

	test("preserves content order, coalesces adjacent blocks, and skips empty thinking", () => {
		const orderedCall = { ...toolCall, id: "ordered-call" };
		const response = assistant([
			{ type: "thinking", thinking: "first " },
			{ type: "thinking", thinking: "thought" },
			{ type: "text", text: "answer " },
			{ type: "text", text: "one" },
			{ type: "thinking", thinking: " \n " },
			{ type: "thinking", thinking: "second thought" },
			orderedCall,
			{ type: "thinking", thinking: "after tool" },
			{ type: "text", text: "answer two" },
		]);
		const state = createTuiState();

		expect(new TuiEventAdapter(state).restore([response])).toBe(true);
		expect(state.items).toEqual([
			{ role: "thinking", text: "first thought" },
			{ role: "assistant", text: "answer one" },
			{ role: "thinking", text: "second thought" },
			{
				role: "tool",
				text: "read",
				toolName: "read",
				toolCallId: "ordered-call",
			},
			{ role: "thinking", text: "after tool" },
			{ role: "assistant", text: "answer two" },
		]);
	});

	test("avoids blank assistant rows and preserves multiple tool calls", () => {
		const state = createTuiState();
		const adapter = new TuiEventAdapter(state);
		const empty = assistant([{ type: "thinking", thinking: " \n " }]);
		const second = { ...toolCall, id: "call-2", name: "bash" };

		expect(adapter.apply({ type: "message_end", message: empty })).toBe(true);
		adapter.apply({ type: "tool_execution_start", toolCall });
		adapter.apply({ type: "tool_execution_start", toolCall: second });
		expect(state.items.map((item) => item.role)).toEqual(["tool", "tool"]);
	});

	test("tracks the latest completed assistant usage across live and restored state", () => {
		const first = {
			...assistant([{ type: "text", text: "first" }]),
			usage: { ...EMPTY_USAGE, inputTokens: 12_400, outputTokens: 860 },
		};
		const second = {
			...assistant([{ type: "thinking", thinking: "hidden" }]),
			usage: { ...EMPTY_USAGE, inputTokens: 25, outputTokens: 7 },
		};
		const state = createTuiState();
		const adapter = new TuiEventAdapter(state);

		expect(adapter.restore([first, second])).toBe(true);
		expect(state.lastUsage).toEqual(second.usage);
		expect(state.items).toEqual([
			{ role: "assistant", text: "first" },
			{ role: "thinking", text: "hidden" },
		]);
		expect(adapter.apply({ type: "message_end", message: second })).toBe(false);
		expect(adapter.restore([])).toBe(true);
		expect(state.lastUsage).toBeUndefined();
	});

	test("restores tool calls without results and enriches matching results", () => {
		const state = createTuiState();
		const response = assistant([toolCall]);
		const adapter = new TuiEventAdapter(state);

		expect(adapter.restore([response])).toBe(true);
		expect(state.items).toEqual([
			{
				role: "tool",
				text: "read",
				toolName: "read",
				toolCallId: "call-1",
			},
		]);
		expect(adapter.restore([response, toolResult])).toBe(true);
		expect(state.items[0]).toMatchObject({
			preview: "hidden result",
			isError: false,
		});
	});

	test("stores bounded previews and validated edit patches", () => {
		const state = createTuiState();
		const adapter = new TuiEventAdapter(state);
		const editCall: ToolCall = { ...toolCall, id: "edit-1", name: "edit" };
		const patch = "@@ -1 +1 @@\n-old\n+new";
		const result: ToolResultMessage = {
			role: "tool_result",
			toolCallId: editCall.id,
			toolName: editCall.name,
			content: [
				{
					type: "text",
					text: Array.from(
						{ length: 30 },
						(_, index) => `line ${index + 1} ${"x".repeat(300)}`,
					).join("\n"),
				},
			],
			details: { patch },
			isError: false,
			timestamp: 4,
		};

		adapter.apply({ type: "tool_execution_end", toolCall: editCall, result });
		const item = state.items[0];
		expect(item?.role).toBe("tool");
		if (item?.role !== "tool") {
			throw new Error("Expected a tool item");
		}
		expect(item.patch).toBe(patch);
		expect(item.preview?.split("\n").length).toBeLessThanOrEqual(16);
		expect(item.preview).toContain("omitted");
		expect(
			new TextEncoder().encode(item.preview).byteLength,
		).toBeLessThanOrEqual(4 * 1024);
	});

	test("bounds and sanitizes restored edit patches", () => {
		const state = createTuiState();
		const adapter = new TuiEventAdapter(state);
		const editCall: ToolCall = { ...toolCall, id: "edit-large", name: "edit" };
		const patch = Array.from(
			{ length: 40 },
			(_, index) => `+line ${index} ${"x".repeat(300)}`,
		).join("\n");
		const result: ToolResultMessage = {
			role: "tool_result",
			toolCallId: editCall.id,
			toolName: editCall.name,
			content: [],
			details: { patch: `\u001b[31m${patch}\u001b[0m` },
			isError: false,
			timestamp: 5,
		};

		adapter.restore([assistant([editCall]), result]);
		const item = state.items[0];
		if (item?.role !== "tool") {
			throw new Error("Expected a restored tool item");
		}
		expect(item.patch).not.toContain("\u001b[");
		expect(item.patch).toContain("omitted");
		expect(item.patch?.split("\n").length).toBeLessThanOrEqual(16);
		expect(new TextEncoder().encode(item.patch).byteLength).toBeLessThanOrEqual(
			4 * 1024,
		);
	});

	test("ignores images and malformed patches while retaining tool failures", () => {
		const state = createTuiState();
		const adapter = new TuiEventAdapter(state);
		const editCall: ToolCall = { ...toolCall, id: "edit-2", name: "edit" };
		const result: ToolResultMessage = {
			role: "tool_result",
			toolCallId: editCall.id,
			toolName: editCall.name,
			content: [{ type: "image", data: "ignored", mimeType: "image/png" }],
			details: { patch: 42 },
			isError: true,
			timestamp: 5,
		};

		adapter.apply({ type: "tool_execution_end", toolCall: editCall, result });
		expect(state.items[0]).toEqual({
			role: "tool",
			text: "edit",
			toolName: "edit",
			toolCallId: "edit-2",
			isError: true,
		});
	});

	test("records terminal outcomes without unlocking the controller", () => {
		for (const [reason, expected] of [
			["aborted", { role: "status", text: "Interrupted" }],
			["provider_error", { role: "error", text: "provider unavailable" }],
			[
				"max_turns",
				{
					role: "error",
					text: "Agent stopped after reaching its turn limit",
				},
			],
		] as const) {
			const state = createTuiState();
			const adapter = new TuiEventAdapter(state);
			const failure = failedAssistant("provider unavailable");
			adapter.apply({ type: "agent_start" });
			const event: AgentEvent = {
				type: "agent_end",
				reason,
				messages: reason === "provider_error" ? [failure] : [],
			};
			expect(adapter.apply(event)).toBe(true);
			expect(state.items.at(-1)).toEqual(expected);
			expect(state.running).toBe(true);
			expect(state.terminalReason).toBe(reason);
			expect(adapter.apply(event)).toBe(false);
		}
	});
});
