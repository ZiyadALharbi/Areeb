import type {
	Message,
	ToolCall,
	ToolDefinition,
	ToolResultContent,
} from "../ai/types.ts";
import type { AssistantMessageEvent } from "../ai/events.ts";
import type { ToolResultMessage } from "../ai/types.ts";


/**
 * Applications can augment this interface with their own message types.
 *
 * @example
 * declare module "./agent/types.ts" {
 * 	interface CustomAgentMessages {
 * 		approval_request: ApprovalRequestMessage;
 * 	}
 * }
 */
export interface CustomAgentMessages {}

export type AgentMessage =
	| Message
  | CustomAgentMessages[keyof CustomAgentMessages];

  /**
   * Converts agent messages into model-compatible messages.
   * Custom messages may be converted, expanded, or filtered out.
   */
  export type AgentMessageConverter = (
	messages: AgentMessage[],
  ) => Message[] | Promise<Message[]>;

  /**
   * Persistent conversation state. Runtime dependencies do not belong here.
   */
  export interface AgentState {
	systemPrompt?: string;
	messages: AgentMessage[];
  }


export type AgentToolCall = ToolCall;

/**
 * Output returned by a tool.
 *
 * The agent loop turns this into a ToolResultMessage by adding the tool-call
 * ID, tool name, error status, and timestamp.
 */
export interface AgentToolResult<TDetails = unknown> {
	content: ToolResultContent[];
	details?: TDetails;
}

/**
 * An intermediate snapshot emitted while a tool is executing.
 */
export interface AgentToolUpdate<TDetails = unknown> {
	content: ToolResultContent[];
	details?: TDetails;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (
	update: AgentToolUpdate<TDetails>,
) => void | Promise<void>;

export interface AgentTool<TInput = unknown, TDetails = unknown>
	extends ToolDefinition<TInput> {
	execute(
		input: TInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	): Promise<AgentToolResult<TDetails>>;
}

/**
 * Persistent state combined with dependencies needed by the running loop.
 */
export interface AgentContext extends AgentState {
	tools: AgentTool[];
	messageConverter?: AgentMessageConverter;
}


export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }

	// Turn lifecycle
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[]; }

	// Message lifecycle
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent; }
	| { type: "message_end"; message: AgentMessage }

	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCall: AgentToolCall; }
	| { type: "tool_execution_update"; toolCall: AgentToolCall; update: AgentToolUpdate; }
	| { type: "tool_execution_end"; toolCall: AgentToolCall; result: ToolResultMessage; };
