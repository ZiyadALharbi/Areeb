import type { AgentEndReason } from "../../agent/types.ts";
import type { ReasoningLevel, Usage } from "../../ai/types.ts";
import type { ContextUsageEstimate } from "../context-window.ts";

export interface StreamingAssistantBlock {
	readonly role: "assistant" | "thinking";
	readonly text: string;
}

export type ChatItem =
	| { readonly role: "user"; readonly text: string }
	| { readonly role: "assistant"; readonly text: string }
	| { readonly role: "thinking"; readonly text: string }
	| {
			readonly role: "tool";
			readonly text: string;
			readonly toolName: string;
			readonly toolCallId: string;
			readonly preview?: string;
			readonly patch?: string;
			readonly isError?: boolean;
	  }
	| { readonly role: "status"; readonly text: string }
	| { readonly role: "error"; readonly text: string };

/** Display-only state shared by the event adapter and TUI renderer. */
export interface TuiState {
	readonly items: ChatItem[];
	readonly sessionId: string;
	readonly model: string;
	readonly cwd: string;
	assistantBuffer?: string;
	assistantBlocks?: readonly StreamingAssistantBlock[];
	reasoning: ReasoningLevel;
	running: boolean;
	inputMode: "idle" | "locked" | "running";
	queuedCount: number;
	lastUsage?: Usage;
	contextUsage?: ContextUsageEstimate;
	terminalReason?: AgentEndReason;
}

export interface TuiSessionDisplay {
	readonly sessionId: string;
	readonly model: string;
	readonly cwd: string;
	readonly reasoning: ReasoningLevel;
}

export function createTuiState(
	display: TuiSessionDisplay = {
		sessionId: "unknown",
		model: "unknown model",
		cwd: ".",
		reasoning: "high",
	},
): TuiState {
	return {
		items: [],
		...display,
		running: false,
		inputMode: "idle",
		queuedCount: 0,
	};
}
