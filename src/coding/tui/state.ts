import type { AgentEndReason } from "../../agent/types.ts";

export type ChatItem =
	| { readonly role: "user"; readonly text: string }
	| { readonly role: "assistant"; readonly text: string }
	| {
			readonly role: "tool";
			readonly text: string;
			readonly toolName: string;
			readonly toolCallId: string;
	  }
	| { readonly role: "status"; readonly text: string }
	| { readonly role: "error"; readonly text: string };

/** Display-only state shared by the event adapter and TUI renderer. */
export interface TuiState {
	readonly items: ChatItem[];
	assistantBuffer?: string;
	running: boolean;
	terminalReason?: AgentEndReason;
}

export function createTuiState(): TuiState {
	return { items: [], running: false };
}
