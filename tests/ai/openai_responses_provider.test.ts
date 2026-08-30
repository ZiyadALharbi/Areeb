import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { OpenAIResponsesProvider } from "../../src/ai/openai_responses_provider.ts";

function sse(events: readonly object[]): Response {
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

function requestFrom(
	input: Parameters<typeof fetch>[0],
	init?: RequestInit,
): Request {
	return input instanceof Request ? input : new Request(String(input), init);
}

describe("OpenAIResponsesProvider", () => {
	test("projects reasoning, tool calls, and tool-result images for stateless replay", () => {
		const provider = new OpenAIResponsesProvider({
			providerId: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "test-key",
		});
		const projection = provider.projectContext("gpt-5.6-sol", {
			systemPrompt: "System",
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "Private reasoning",
							signature:
								'{"type":"reasoning","id":"reasoning-1","summary":[],"encrypted_content":"opaque"}',
						},
						{ type: "text", text: "I will look." },
						{
							type: "tool_call",
							id: "call-1|item-1",
							name: "lookup",
							arguments: { query: "Areeb" },
						},
					],
					provider: "openai",
					model: "gpt-5.6-sol",
					usage: {
						inputTokens: 10,
						outputTokens: 5,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						totalTokens: 15,
					},
					stopReason: "tool_call",
					timestamp: 1,
				},
				{
					role: "tool_result",
					toolCallId: "call-1|item-1",
					toolName: "lookup",
					content: [
						{ type: "text", text: "Result" },
						{ type: "image", mimeType: "image/png", data: "pixels" },
					],
					isError: false,
					timestamp: 2,
				},
			],
		});

		expect(projection).toEqual({
			systemPrompt: "System",
			messages: [
				{
					sourceIndex: 0,
					value: {
						type: "reasoning",
						id: "reasoning-1",
						summary: [],
						encrypted_content: "opaque",
					},
				},
				{
					sourceIndex: 0,
					value: {
						type: "message",
						role: "assistant",
						content: "I will look.",
					},
				},
				{
					sourceIndex: 0,
					value: {
						type: "function_call",
						id: "item-1",
						call_id: "call-1",
						name: "lookup",
						arguments: '{"query":"Areeb"}',
					},
				},
				{
					sourceIndex: 1,
					imageCount: 1,
					value: {
						type: "function_call_output",
						call_id: "call-1",
						output: [
							{ type: "input_text", text: "Result" },
							{
								type: "input_image",
								detail: "auto",
								image_url: "[image]",
							},
						],
					},
				},
			],
			tools: [],
		});
		expect(JSON.stringify(projection)).not.toContain("Private reasoning");
		expect(JSON.stringify(projection)).not.toContain("pixels");
	});

	test("streams reasoning and function calls with usage metadata", async () => {
		let request: Request | undefined;
		const provider = new OpenAIResponsesProvider({
			providerId: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "test-key",
			fetch: (async (
				input: Parameters<typeof fetch>[0],
				init?: RequestInit,
			) => {
				request = requestFrom(input, init);
				return sse([
					{
						type: "response.created",
						response: { id: "response-1" },
					},
					{
						type: "response.output_item.added",
						output_index: 0,
						item: {
							type: "reasoning",
							id: "reasoning-1",
							summary: [],
							status: "in_progress",
						},
					},
					{
						type: "response.reasoning_summary_text.delta",
						output_index: 0,
						delta: "Checking",
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "reasoning",
							id: "reasoning-1",
							summary: [{ type: "summary_text", text: "Checking" }],
							encrypted_content: "opaque",
							status: "completed",
						},
					},
					{
						type: "response.output_item.added",
						output_index: 1,
						item: {
							type: "function_call",
							id: "item-1",
							call_id: "call-1",
							name: "lookup",
							arguments: "",
							status: "in_progress",
						},
					},
					{
						type: "response.function_call_arguments.delta",
						output_index: 1,
						delta: '{"query":',
					},
					{
						type: "response.function_call_arguments.done",
						output_index: 1,
						item_id: "item-1",
						name: "lookup",
						arguments: '{"query":"Areeb"}',
					},
					{
						type: "response.output_item.done",
						output_index: 1,
						item: {
							type: "function_call",
							id: "item-1",
							call_id: "call-1",
							name: "lookup",
							arguments: '{"query":"Areeb"}',
							status: "completed",
						},
					},
					{
						type: "response.completed",
						response: {
							id: "response-1",
							status: "completed",
							usage: {
								input_tokens: 20,
								output_tokens: 7,
								total_tokens: 27,
								input_tokens_details: {
									cached_tokens: 3,
									cache_write_tokens: 2,
								},
								output_tokens_details: { reasoning_tokens: 4 },
							},
						},
					},
				]);
			}) as unknown as typeof fetch,
		});

		const stream = provider.streamResponse(
			"gpt-5.6-sol",
			{
				systemPrompt: "System",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Find Areeb" }],
						timestamp: 1,
					},
				],
				tools: [
					{
						name: "lookup",
						description: "Look up a value",
						inputSchema: z.object({ query: z.string() }),
					},
				],
			},
			{ reasoning: "max" },
		);
		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		const result = await stream.result();

		expect(eventTypes).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(result).toMatchObject({
			content: [
				{
					type: "thinking",
					thinking: "Checking",
					signature: expect.stringContaining('"encrypted_content":"opaque"'),
				},
				{
					type: "tool_call",
					id: "call-1|item-1",
					name: "lookup",
					arguments: { query: "Areeb" },
				},
			],
			responseId: "response-1",
			stopReason: "tool_call",
			usage: {
				inputTokens: 15,
				outputTokens: 7,
				cacheReadTokens: 3,
				cacheWriteTokens: 2,
				totalTokens: 27,
			},
		});
		expect(new URL(request?.url ?? "https://invalid").pathname).toBe(
			"/v1/responses",
		);
		expect(request?.headers.get("authorization")).toBe("Bearer test-key");
		const body = (await request?.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			model: "gpt-5.6-sol",
			store: false,
			stream: true,
			instructions: "System",
			reasoning: { effort: "max", summary: "auto" },
			tool_choice: "auto",
			parallel_tool_calls: true,
			tools: [
				{
					type: "function",
					name: "lookup",
					description: "Look up a value",
					strict: false,
				},
			],
		});
	});

	test("maps off to explicit none reasoning and streams text", async () => {
		let request: Request | undefined;
		const provider = new OpenAIResponsesProvider({
			providerId: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "test-key",
			fetch: (async (
				input: Parameters<typeof fetch>[0],
				init?: RequestInit,
			) => {
				request = requestFrom(input, init);
				return sse([
					{ type: "response.created", response: { id: "response-2" } },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "message", id: "message-1" },
					},
					{
						type: "response.output_text.delta",
						output_index: 0,
						delta: "hello",
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: { type: "message", id: "message-1" },
					},
					{
						type: "response.completed",
						response: { id: "response-2", status: "completed" },
					},
				]);
			}) as unknown as typeof fetch,
		});

		const stream = provider.streamResponse(
			"gpt-5.6-sol",
			{ messages: [] },
			{ reasoning: "off" },
		);
		for await (const _event of stream) {
			// Consume the event stream before reading its final result.
		}

		expect(await stream.result()).toMatchObject({
			content: [{ type: "text", text: "hello" }],
			stopReason: "stop",
		});
		const body = (await request?.json()) as Record<string, unknown>;
		expect(body.reasoning).toEqual({ effort: "none" });
	});

	test("surfaces HTTP request failures as terminal provider errors", async () => {
		const provider = new OpenAIResponsesProvider({
			providerId: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "test-key",
			retry: { maxRetries: 0 },
			fetch: (async () =>
				Response.json(
					{
						error: {
							message: "invalid request",
							type: "invalid_request_error",
						},
					},
					{ status: 400 },
				)) as unknown as typeof fetch,
		});

		const stream = provider.streamResponse("gpt-5.6-sol", { messages: [] });
		for await (const _event of stream) {
			// Consume the event stream before reading its final result.
		}

		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("invalid request"),
		});
	});
});
