import type { ZodType } from "zod";

export const REASONING_LEVELS = Object.freeze([
	"off",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const);

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
export type ThinkingLevel = Exclude<ReasoningLevel, "off">;

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
	return (
		typeof value === "string" &&
		(REASONING_LEVELS as readonly string[]).includes(value)
	);
}

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	/** Provider-owned replay data for stateless reasoning APIs. */
	signature?: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCall {
	type: "tool_call";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type UserContent = TextContent | ImageContent;
export type AssistantContent = TextContent | ThinkingContent | ToolCall;
export type ToolResultContent = TextContent | ImageContent;

export interface ToolDefinition<TInput = unknown> {
	name: string;
	description: string;
	inputSchema: ZodType<TInput>;
}

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
}

export type StopReason = "stop" | "length" | "tool_call" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: UserContent[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	provider: string;
	model: string;
	responseId?: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
	role: "tool_result";
	toolCallId: string;
	toolName: string;
	content: ToolResultContent[];
	details?: TDetails;
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface ModelContext {
	systemPrompt?: string;
	messages: Message[];
	tools?: ToolDefinition[];
}
