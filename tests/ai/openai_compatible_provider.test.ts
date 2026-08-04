import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AssistantMessageEvent } from "../../src/ai/events.ts";
import { OpenAICompatibleProvider } from "../../src/ai/openai_compatible_provider.ts";
import type { ModelContext } from "../../src/ai/types.ts";

const servers: Bun.Server<unknown>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function startServer(
	fetch: (request: Request) => Response | Promise<Response>,
): { baseUrl: string } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch,
	});
	servers.push(server);
	return { baseUrl: `http://${server.hostname}:${server.port}/v1` };
}

function sseResponse(chunks: readonly object[]): Response {
	return new Response(
		`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
		{
			headers: { "Content-Type": "text/event-stream" },
		},
	);
}

function chunk(
	choices: readonly object[],
	extra: Readonly<Record<string, unknown>> = {},
): object {
	return {
		id: "chatcmpl-response-1",
		object: "chat.completion.chunk",
		created: 1_753_632_000,
		model: "provider-model-alias",
		choices,
		...extra,
	};
}

async function collect(
	stream: ReturnType<OpenAICompatibleProvider["streamResponse"]>,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("OpenAICompatibleProvider", () => {
	test("builds a multimodal Chat Completions request and streams Areeb events", async () => {
		let requestBody: Record<string, unknown> | undefined;
		let requestHeaders: Headers | undefined;
		const { baseUrl } = startServer(async (request) => {
			requestBody = (await request.json()) as Record<string, unknown>;
			requestHeaders = request.headers;
			return sseResponse([
				chunk([
					{
						index: 0,
						delta: {
							role: "assistant",
							content: "Hello",
							reasoning_content: "Consider this",
						},
						finish_reason: null,
					},
				]),
				chunk([
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call-weather",
									type: "function",
									function: {
										name: "weather",
										arguments: '{"city":',
									},
								},
								{
									index: 1,
									id: "call-time",
									type: "function",
									function: {
										name: "time",
										arguments: '{"zone":',
									},
								},
							],
						},
						finish_reason: null,
					},
				]),
				chunk([
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, function: { arguments: '"Riyadh"}' } },
								{ index: 1, function: { arguments: '"UTC+3"}' } },
							],
						},
						finish_reason: "tool_calls",
					},
				]),
				chunk([], {
					usage: {
						prompt_tokens: 100,
						completion_tokens: 5,
						total_tokens: 105,
						prompt_tokens_details: {
							cached_tokens: 20,
							cache_write_tokens: 10,
						},
					},
				}),
			]);
		});

		const provider = new OpenAICompatibleProvider({
			providerId: "compatible",
			baseUrl,
			apiKey: "test-key",
			headers: { "X-Areeb-Test": "present" },
			compat: {
				thinkingLevelMap: { high: "xhigh" },
			},
		});
		const context: ModelContext = {
			systemPrompt: "You are Areeb.",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "What is here?" },
						{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
					],
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Private reasoning" },
						{ type: "text", text: "I will check." },
						{
							type: "tool_call",
							id: "old-call",
							name: "weather",
							arguments: { city: "Riyadh" },
						},
					],
					provider: "compatible",
					model: "old-model",
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						totalTokens: 2,
					},
					stopReason: "tool_call",
					timestamp: 2,
				},
				{
					role: "tool_result",
					toolCallId: "old-call",
					toolName: "weather",
					content: [{ type: "text", text: "Sunny" }],
					isError: false,
					timestamp: 3,
				},
			],
			tools: [
				{
					name: "weather",
					description: "Get the weather",
					inputSchema: z.object({ city: z.string() }),
				},
			],
		};

		const stream = provider.streamResponse("requested-model", context, {
			reasoning: "high",
			maxRetries: 0,
		});
		const events = await collect(stream);
		const result = await stream.result();

		expect(requestHeaders?.get("x-areeb-test")).toBe("present");
		expect(requestBody).toMatchObject({
			model: "requested-model",
			stream: true,
			stream_options: { include_usage: true },
			reasoning_effort: "xhigh",
			messages: [
				{ role: "system", content: "You are Areeb." },
				{
					role: "user",
					content: [
						{ type: "text", text: "What is here?" },
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,aW1hZ2U=" },
						},
					],
				},
				{
					role: "assistant",
					content: "I will check.",
					tool_calls: [
						{
							id: "old-call",
							type: "function",
							function: {
								name: "weather",
								arguments: '{"city":"Riyadh"}',
							},
						},
					],
				},
				{ role: "tool", tool_call_id: "old-call", content: "Sunny" },
			],
			tools: [
				{
					type: "function",
					function: {
						name: "weather",
						description: "Get the weather",
						parameters: {
							$schema: "http://json-schema.org/draft-07/schema#",
							type: "object",
							properties: { city: { type: "string" } },
							required: ["city"],
						},
					},
				},
			],
		});
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"thinking_start",
			"thinking_delta",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_delta",
			"text_end",
			"thinking_end",
			"toolcall_end",
			"toolcall_end",
			"done",
		]);
		expect(result).toMatchObject({
			role: "assistant",
			provider: "compatible",
			model: "requested-model",
			responseId: "chatcmpl-response-1",
			stopReason: "tool_call",
			usage: {
				inputTokens: 70,
				outputTokens: 5,
				cacheReadTokens: 20,
				cacheWriteTokens: 10,
				totalTokens: 105,
			},
			content: [
				{ type: "text", text: "Hello" },
				{ type: "thinking", thinking: "Consider this" },
				{
					type: "tool_call",
					id: "call-weather",
					name: "weather",
					arguments: { city: "Riyadh" },
				},
				{
					type: "tool_call",
					id: "call-time",
					name: "time",
					arguments: { zone: "UTC+3" },
				},
			],
		});
	});

	test("omits tools when empty and normalizes compatible stop reasons", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const { baseUrl } = startServer(async (request) => {
			requestBody = (await request.json()) as Record<string, unknown>;
			return sseResponse([
				chunk([
					{
						index: 0,
						delta: { content: "Done" },
						finish_reason: "end",
					},
				]),
			]);
		});
		const provider = new OpenAICompatibleProvider({
			providerId: "compatible",
			baseUrl,
		});

		const message = await provider
			.streamResponse("model", { messages: [], tools: [] }, { maxRetries: 0 })
			.result();

		expect(requestBody).toBeDefined();
		expect(requestBody).not.toHaveProperty("tools");
		expect(message.stopReason).toBe("stop");
	});

	test("builds provider-specific reasoning options", async () => {
		const requestBodies: Record<string, unknown>[] = [];
		const { baseUrl } = startServer(async (request) => {
			requestBodies.push((await request.json()) as Record<string, unknown>);
			return sseResponse([
				chunk([
					{
						index: 0,
						delta: {},
						finish_reason: "stop",
					},
				]),
			]);
		});
		const baseConfig = { providerId: "compatible", baseUrl } as const;

		await new OpenAICompatibleProvider({
			...baseConfig,
			compat: { thinkingFormat: "openrouter" },
		})
			.streamResponse("model", { messages: [] }, { reasoning: "off" })
			.result();
		await new OpenAICompatibleProvider({
			...baseConfig,
			compat: {
				thinkingFormat: "deepseek",
				thinkingLevelMap: { medium: "custom-medium" },
			},
		})
			.streamResponse("model", { messages: [] }, { reasoning: "medium" })
			.result();
		await new OpenAICompatibleProvider({
			...baseConfig,
			compat: { thinkingFormat: "zai" },
		})
			.streamResponse("model", { messages: [] }, { reasoning: "off" })
			.result();

		expect(requestBodies).toHaveLength(3);
		expect(requestBodies[0]).toMatchObject({
			reasoning: { effort: "none" },
		});
		expect(requestBodies[1]).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "custom-medium",
		});
		expect(requestBodies[2]).toMatchObject({ enable_thinking: false });
	});

	test("forwards AbortSignal and returns partial content in an aborted terminal error", async () => {
		const encoder = new TextEncoder();
		const { baseUrl } = startServer((request) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify(
								chunk([
									{
										index: 0,
										delta: { content: "Partial" },
										finish_reason: null,
									},
								]),
							)}\n\n`,
						),
					);
					request.signal.addEventListener("abort", () => controller.close(), {
						once: true,
					});
				},
			});
			return new Response(body, {
				headers: { "Content-Type": "text/event-stream" },
			});
		});
		const provider = new OpenAICompatibleProvider({
			providerId: "compatible",
			baseUrl,
		});
		const controller = new AbortController();
		const stream = provider.streamResponse(
			"model",
			{ messages: [] },
			{ signal: controller.signal, maxRetries: 0 },
		);
		const events: AssistantMessageEvent[] = [];

		for await (const event of stream) {
			events.push(event);
			if (event.type === "text_delta") {
				controller.abort();
			}
		}

		const result = await stream.result();
		expect(events.at(-1)?.type).toBe("error");
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Partial" }],
			stopReason: "aborted",
			errorMessage: "The model request was aborted",
		});
	});
});
