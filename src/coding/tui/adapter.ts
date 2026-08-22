import type {
	AgentEndReason,
	AgentEvent,
	AgentMessage,
} from "../../agent/types.ts";
import type {
	AssistantMessage,
	ToolResultMessage,
	UserMessage,
} from "../../ai/types.ts";
import type { ChatItem, TuiState } from "./state.ts";

/** Projects transport-neutral agent events into display-only TUI state. */
export class TuiEventAdapter {
	private readonly projectedMessages = new Set<object>();

	constructor(readonly state: TuiState) {}

	restore(messages: readonly AgentMessage[]): boolean {
		let changed =
			this.state.items.length > 0 ||
			this.state.assistantBuffer !== undefined ||
			this.state.terminalReason !== undefined ||
			this.state.running;
		this.state.items.length = 0;
		delete this.state.assistantBuffer;
		delete this.state.terminalReason;
		this.state.running = false;
		this.projectedMessages.clear();

		for (const message of messages) {
			changed = this.projectMessage(message) || changed;
		}
		return changed;
	}

	apply(event: AgentEvent): boolean {
		switch (event.type) {
			case "agent_start": {
				const changed =
					!this.state.running || this.state.terminalReason !== undefined;
				this.state.running = true;
				delete this.state.terminalReason;
				return changed;
			}
			case "message_start":
			case "turn_start":
			case "turn_end":
			case "tool_execution_update":
				return false;
			case "message_update": {
				if (
					event.assistantMessageEvent.type !== "text_delta" ||
					!isAssistantMessage(event.message)
				) {
					return false;
				}
				const text = visibleAssistantText(event.message);
				if (this.state.assistantBuffer === text) {
					return false;
				}
				this.state.assistantBuffer = text;
				return true;
			}
			case "message_end":
				return this.projectMessage(event.message);
			case "tool_execution_start": {
				const flushed = this.flushAssistantBuffer();
				return (
					this.upsertTool(event.toolCall.id, event.toolCall.name) || flushed
				);
			}
			case "tool_execution_end":
				return this.upsertTool(event.toolCall.id, event.toolCall.name);
			case "agent_end":
				return this.applyTerminalEvent(event.reason, event.messages);
		}
	}

	private projectMessage(message: AgentMessage): boolean {
		if (typeof message !== "object" || message === null) {
			return false;
		}
		if (this.projectedMessages.has(message)) {
			return false;
		}

		let changed = false;
		if (isUserMessage(message)) {
			const text = visibleUserText(message);
			if (text.trim().length > 0) {
				this.state.items.push({ role: "user", text });
				changed = true;
			}
		} else if (isAssistantMessage(message)) {
			const text = visibleAssistantText(message);
			changed = this.finalizeAssistantMessage(text);
		} else if (isToolResultMessage(message)) {
			changed = this.upsertTool(message.toolCallId, message.toolName);
		} else {
			return false;
		}

		this.projectedMessages.add(message);
		return changed;
	}

	private finalizeAssistantMessage(text: string): boolean {
		const clearedBuffer = this.state.assistantBuffer !== undefined;
		delete this.state.assistantBuffer;
		if (text.trim().length === 0) {
			return clearedBuffer;
		}
		this.state.items.push({ role: "assistant", text });
		return true;
	}

	private flushAssistantBuffer(): boolean {
		const text = this.state.assistantBuffer;
		delete this.state.assistantBuffer;
		if (text === undefined || text.trim().length === 0) {
			return text !== undefined;
		}
		this.state.items.push({ role: "assistant", text });
		return true;
	}

	private upsertTool(toolCallId: string, toolName: string): boolean {
		const index = this.state.items.findIndex(
			(item) => item.role === "tool" && item.toolCallId === toolCallId,
		);
		const item: ChatItem = {
			role: "tool",
			text: toolName,
			toolName,
			toolCallId,
		};
		if (index === -1) {
			this.state.items.push(item);
			return true;
		}

		const existing = this.state.items[index];
		if (
			existing?.role === "tool" &&
			existing.toolName === toolName &&
			existing.text === toolName
		) {
			return false;
		}
		this.state.items[index] = item;
		return true;
	}

	private applyTerminalEvent(
		reason: AgentEndReason,
		messages: readonly AgentMessage[],
	): boolean {
		if (this.state.terminalReason === reason) {
			return false;
		}
		this.state.terminalReason = reason;
		switch (reason) {
			case "completed":
				return true;
			case "aborted":
				this.state.items.push({ role: "status", text: "Interrupted" });
				return true;
			case "provider_error":
				this.state.items.push({
					role: "error",
					text:
						findFinalAssistantMessage(messages)?.errorMessage ??
						"Provider request failed",
				});
				return true;
			case "max_turns":
				this.state.items.push({
					role: "error",
					text: "Agent stopped after reaching its turn limit",
				});
				return true;
		}
	}
}

function visibleUserText(message: UserMessage): string {
	return message.content
		.map((content) => (content.type === "text" ? content.text : "[image]"))
		.join("");
}

function visibleAssistantText(message: AssistantMessage): string {
	return message.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("");
}

function findFinalAssistantMessage(
	messages: readonly AgentMessage[],
): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message !== undefined && isAssistantMessage(message)) {
			return message;
		}
	}
	return undefined;
}

function isUserMessage(message: AgentMessage): message is UserMessage {
	return messageRole(message) === "user";
}

function isAssistantMessage(
	message: AgentMessage,
): message is AssistantMessage {
	return messageRole(message) === "assistant";
}

function isToolResultMessage(
	message: AgentMessage,
): message is ToolResultMessage {
	return messageRole(message) === "tool_result";
}

function messageRole(message: AgentMessage): string | undefined {
	if (typeof message !== "object" || message === null || !("role" in message)) {
		return undefined;
	}
	return typeof message.role === "string" ? message.role : undefined;
}
