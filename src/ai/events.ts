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
			partial: AssistantMessage;
	  }
	| {
			type: "text_start";
			contentIndex: number;
			partial: AssistantMessage;
	  }
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "text_end";
			contentIndex: number;
			content: TextContent;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_start";
			contentIndex: number;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: ThinkingContent;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_start";
			contentIndex: number;
			toolCallId: string;
			toolName: string;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_delta";
			contentIndex: number;
			toolCallId: string;
			argumentsDelta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: ToolCall;
			partial: AssistantMessage;
	  }
	| {
			type: "done";
			message: SuccessfulAssistantMessage;
	  }
	| {
			type: "error";
			message: FailedAssistantMessage;
	  };
