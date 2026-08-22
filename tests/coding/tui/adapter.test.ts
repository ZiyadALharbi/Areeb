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
	test("restores only visible transcript content", () => {
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
				{ role: "assistant", text: "answer" },
				{
					role: "tool",
					text: "read",
					toolName: "read",
					toolCallId: "call-1",
				},
			],
			running: false,
		});
	});

	test("live events match restored messages without duplicate rows", () => {
		const response = assistant([
			{ type: "thinking", thinking: "private" },
			{ type: "text", text: "answer" },
			toolCall,
		]);
		const partial: AssistantMessage = {
			...response,
			content: [{ type: "text", text: "wrong snapshot" }],
			usage: { ...EMPTY_USAGE },
		};
		const finalSnapshot: AssistantMessage = {
			...response,
			content: [{ type: "text", text: "answer" }],
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
				message: partial,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "private",
					partial,
				},
			}),
		).toBe(false);
		expect(
			adapter.apply({
				type: "message_update",
				message: finalSnapshot,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "answer",
					partial: finalSnapshot,
				},
			}),
		).toBe(true);
		expect(state.assistantBuffer).toBe("answer");
		expect(adapter.apply({ type: "message_end", message: response })).toBe(
			true,
		);
		expect(adapter.apply({ type: "tool_execution_start", toolCall })).toBe(
			true,
		);
		expect(
			adapter.apply({
				type: "tool_execution_end",
				toolCall,
				result: toolResult,
			}),
		).toBe(false);
		expect(adapter.apply({ type: "message_end", message: toolResult })).toBe(
			false,
		);

		const restored = createTuiState();
		new TuiEventAdapter(restored).restore([user, response, toolResult]);
		expect(state.items).toEqual(restored.items);
	});

	test("avoids blank assistant rows and preserves multiple tool calls", () => {
		const state = createTuiState();
		const adapter = new TuiEventAdapter(state);
		const empty = assistant([{ type: "thinking", thinking: "hidden" }]);
		const second = { ...toolCall, id: "call-2", name: "bash" };

		expect(adapter.apply({ type: "message_end", message: empty })).toBe(false);
		adapter.apply({ type: "tool_execution_start", toolCall });
		adapter.apply({ type: "tool_execution_start", toolCall: second });
		expect(state.items.map((item) => item.role)).toEqual(["tool", "tool"]);
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
