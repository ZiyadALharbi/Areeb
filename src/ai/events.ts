import type {
	AssistantMessage,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "./types.ts";

type SuccessReason = Extract<StopReason, "stop" | "length" | "tool_call">;

type FailureReason = Extract<StopReason, "error" | "aborted">;

type SuccessfulAssistantMessage = Omit<
	AssistantMessage,
	"stopReason" | "errorMessage"
> & {
	stopReason: SuccessReason;
	errorMessage?: never;
};

type FailedAssistantMessage = Omit<
	AssistantMessage,
	"stopReason" | "errorMessage"
> & {
	stopReason: FailureReason;
	errorMessage: string;
};

export type AssistantMessageEvent =
	| {
			type: "start";
	  }
	| {
			type: "text_start";
			contentIndex: number;
	  }
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
	  }
	| {
			type: "text_end";
			contentIndex: number;
			content: TextContent;
	  }
	| {
			type: "thinking_start";
			contentIndex: number;
	  }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
	  }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: ThinkingContent;
	  }
	| {
			type: "toolcall_start";
			contentIndex: number;
			toolCallId: string;
			toolName: string;
	  }
	| {
			type: "toolcall_delta";
			contentIndex: number;
			toolCallId: string;
			argumentsDelta: string;
	  }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: ToolCall;
	  }
	| {
			type: "done";
			message: SuccessfulAssistantMessage;
	  }
	| {
			type: "error";
			message: FailedAssistantMessage;
	  };
