import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type {
	AssistantContent,
	ImageContent,
	Message,
	ToolDefinition,
	ToolResultContent,
	UserContent,
} from "./types.ts";

function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

function userContentValue(content: UserContent): string {
	switch (content.type) {
		case "text":
			return content.text;
		case "image":
			return content.mimeType;
		default:
			return assertNever(content);
	}
}

function assistantContentValue(content: AssistantContent): string {
	switch (content.type) {
		case "text":
			return content.text;
		case "thinking":
			return content.thinking;
		case "tool_call":
			return content.name;
		default:
			return assertNever(content);
	}
}

function toolResultContentValue(content: ToolResultContent): string {
	switch (content.type) {
		case "text":
			return content.text;
		case "image":
			return content.mimeType;
		default:
			return assertNever(content);
	}
}

function messageRole(message: Message): string {
	switch (message.role) {
		case "user":
			return "user";
		case "assistant":
			return "assistant";
		case "tool_result":
			return "tool_result";
		default:
			return assertNever(message);
	}
}

describe("AI content and message contracts", () => {
	test("role-specific content narrows exhaustively", () => {
		const userContent: UserContent[] = [
			{ type: "text", text: "answer" },
			{ type: "image", data: "base64-data", mimeType: "image/png" },
		];
		const assistantContent: AssistantContent[] = [
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
			{
				type: "tool_call",
				id: "call-1",
				name: "search",
				arguments: { query: "Areeb" },
			},
		];
		const toolResultContent: ToolResultContent[] = [
			{ type: "text", text: "result" },
			{ type: "image", data: "base64-result", mimeType: "image/jpeg" },
		];

		expect(userContent.map(userContentValue)).toEqual(["answer", "image/png"]);
		expect(assistantContent.map(assistantContentValue)).toEqual([
			"answer",
			"reasoning",
			"search",
		]);
		expect(toolResultContent.map(toolResultContentValue)).toEqual([
			"result",
			"image/jpeg",
		]);
	});

	test("assistant content excludes images", () => {
		type AssistantSupportsImages = ImageContent extends AssistantContent
			? true
			: false;

		const assistantSupportsImages: AssistantSupportsImages = false;

		expect(assistantSupportsImages).toBe(false);
	});

	test("messages narrow exhaustively", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Hello" }],
				timestamp: 1_753_632_000_000,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Hi" }],
				provider: "anthropic",
				model: "claude-sonnet",
				responseId: "response-1",
				usage: {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 2,
					cacheWriteTokens: 1,
					totalTokens: 18,
				},
				stopReason: "stop",
				timestamp: 1_753_632_001_000,
			},
			{
				role: "tool_result",
				toolCallId: "call-1",
				toolName: "search",
				content: [{ type: "text", text: "Result" }],
				details: { resultCount: 1 },
				isError: false,
				timestamp: 1_753_632_002_000,
			},
		];

		expect(messages.map(messageRole)).toEqual([
			"user",
			"assistant",
			"tool_result",
		]);
	});

	test("assistant messages retain response metadata", () => {
		const message: Extract<Message, { role: "assistant" }> = {
			role: "assistant",
			content: [{ type: "text", text: "Done" }],
			provider: "openai",
			model: "gpt-5",
			responseId: "response-2",
			usage: {
				inputTokens: 20,
				outputTokens: 8,
				cacheReadTokens: 4,
				cacheWriteTokens: 0,
				totalTokens: 32,
			},
			stopReason: "stop",
			timestamp: 1_753_632_003_000,
		};

		expect(message.provider).toBe("openai");
		expect(message.model).toBe("gpt-5");
		expect(message.responseId).toBe("response-2");
		expect(message.usage.totalTokens).toBe(32);
	});
});

describe("tool input schemas", () => {
	const searchInputSchema = z.object({
		query: z.string().min(1),
		limit: z.number().int().positive().optional(),
	});

	type SearchInput = z.infer<typeof searchInputSchema>;

	const searchTool: ToolDefinition<SearchInput> = {
		name: "search",
		description: "Search for matching items",
		inputSchema: searchInputSchema,
	};

	test("parse valid tool arguments", () => {
		const result = searchTool.inputSchema.safeParse({
			query: "Areeb",
			limit: 5,
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.query).toBe("Areeb");
			expect(result.data.limit).toBe(5);
		}
	});

	test("reject invalid tool arguments", () => {
		const result = searchTool.inputSchema.safeParse({
			query: "",
			limit: -1,
		});

		expect(result.success).toBe(false);
	});
});
