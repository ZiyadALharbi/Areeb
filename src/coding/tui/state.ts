import type { AgentEndReason } from "../../agent/types.ts";

export type ChatItem =
	| { readonly role: "user"; readonly text: string }
	| { readonly role: "assistant"; readonly text: string }
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
	running: boolean;
	inputMode: "idle" | "locked" | "running";
	queuedCount: number;
	terminalReason?: AgentEndReason;
}

export interface TuiSessionDisplay {
	readonly sessionId: string;
	readonly model: string;
	readonly cwd: string;
}

export function createTuiState(
	display: TuiSessionDisplay = {
		sessionId: "unknown",
		model: "unknown model",
		cwd: ".",
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
