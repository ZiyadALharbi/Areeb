import { describe, expect, test } from "bun:test";
import { CodexProvider } from "../../src/ai/codex_provider.ts";

function sse(events: readonly object[]): Response {
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

describe("CodexProvider", () => {
	test("discovers model limits with Codex authentication and metadata", async () => {
		let request: Request | undefined;
		const provider = new CodexProvider({
			getAuth: async () => ({ access: "access-token", accountId: "account" }),
			fetch: (async (
				input: Parameters<typeof fetch>[0],
				init?: RequestInit,
			) => {
				request = new Request(String(input), init);
				return Response.json({
					models: [
						{
							slug: "gpt-5.6-sol",
							context_window: 200_000,
							max_context_window: 100_000,
							effective_context_window_percent: 90,
						},
						{ id: "gpt-5.6-terra", max_context_window: 128_000 },
						{ model: "invalid", context_window: -1 },
					],
				});
			}) as unknown as typeof fetch,
		});

		expect(await provider.discoverModelLimits()).toEqual([
			{
				model: "gpt-5.6-sol",
				contextWindowTokens: 200_000,
				effectiveContextWindowPercent: 90,
			},
			{ model: "gpt-5.6-terra", contextWindowTokens: 128_000 },
		]);
		expect(request?.method).toBe("GET");
		expect(new URL(request?.url ?? "https://invalid").pathname).toBe(
			"/backend-api/codex/models",
		);
		expect(
			new URL(request?.url ?? "https://invalid").searchParams.get(
				"client_version",
			),
		).toBe("0.150.1");
		expect(request?.headers.get("authorization")).toBe("Bearer access-token");
		expect(request?.headers.get("chatgpt-account-id")).toBe("account");
	});

	test("projects signed reasoning and tool results in Responses replay order", () => {
		const provider = new CodexProvider({
			getAuth: async () => ({ access: "access-token", accountId: "account" }),
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
							signature: '{"type":"reasoning","encrypted_content":"opaque"}',
						},
						{ type: "text", text: "I will look." },
						{
							type: "tool_call",
							id: "call-1",
							name: "lookup",
							arguments: { query: "Areeb" },
						},
					],
					provider: "openai-codex",
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
					toolCallId: "call-1",
					toolName: "lookup",
					content: [{ type: "text", text: "Result" }],
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
					value: { type: "reasoning", encrypted_content: "opaque" },
				},
				{
					sourceIndex: 0,
					value: {
						type: "message",
						role: "assistant",
						status: "completed",
						content: [
							{ type: "output_text", text: "I will look.", annotations: [] },
						],
					},
				},
				{
					sourceIndex: 0,
					value: {
						type: "function_call",
						call_id: "call-1",
						name: "lookup",
						arguments: '{"query":"Areeb"}',
					},
				},
				{
					sourceIndex: 1,
					value: {
						type: "function_call_output",
						call_id: "call-1",
						output: "Result",
					},
				},
			],
			tools: [],
		});
		expect(JSON.stringify(projection)).not.toContain("Private reasoning");
	});

	test("maps Responses SSE text and usage onto Areeb events", async () => {
		let request: Request | undefined;
		const provider = new CodexProvider({
			getAuth: async () => ({ access: "access-token", accountId: "account" }),
			fetch: (async (
				input: Parameters<typeof fetch>[0],
				init?: RequestInit,
			) => {
				request = new Request(String(input), init);
				return sse([
					{ type: "response.created", response: { id: "response-1" } },
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
						response: {
							id: "response-1",
							status: "completed",
							usage: {
								input_tokens: 12,
								output_tokens: 3,
								input_tokens_details: { cached_tokens: 2 },
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
						content: [{ type: "text", text: "Hi" }],
						timestamp: 1,
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
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(result).toMatchObject({
			content: [{ type: "text", text: "hello" }],
			responseId: "response-1",
			stopReason: "stop",
			usage: {
				inputTokens: 10,
				outputTokens: 3,
				cacheReadTokens: 2,
				totalTokens: 15,
			},
		});
		expect(request?.headers.get("authorization")).toBe("Bearer access-token");
		expect(request?.headers.get("chatgpt-account-id")).toBe("account");
		expect(request?.headers.get("originator")).toBe("areeb");
		const body = (await request?.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			model: "gpt-5.6-sol",
			store: false,
			stream: true,
			instructions: "System",
			reasoning: { effort: "max", summary: "auto" },
		});
	});
});
