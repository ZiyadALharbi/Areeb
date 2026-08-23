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

		const stream = provider.streamResponse("gpt-5.6-sol", {
			systemPrompt: "System",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hi" }],
					timestamp: 1,
				},
			],
		});
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
		});
	});
});
