import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgentLoop } from "../../src/agent/agent_loop.ts";
import type { AgentContext, AgentEvent } from "../../src/agent/types.ts";
import type { AssistantMessageEvent } from "../../src/ai/events.ts";
import { OpenAICompatibleProvider } from "../../src/ai/openai_compatible_provider.ts";
import type { ModelContext, UserMessage } from "../../src/ai/types.ts";

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
		const startEvent = events.find((event) => event.type === "start");
		const firstTextDelta = events.find((event) => event.type === "text_delta");
		expect(startEvent?.partial.content).toEqual([]);
		expect(firstTextDelta?.partial.content).toEqual([
			{ type: "text", text: "Hello" },
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
			.streamResponse("model", { messages: [], tools: [] })
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
			compat: {
				thinkingFormat: "zai",
				supportsReasoningEffort: true,
			},
		})
			.streamResponse("model", { messages: [] }, { reasoning: "off" })
			.result();
		await new OpenAICompatibleProvider({
			...baseConfig,
			compat: {
				thinkingFormat: "zai",
				supportsReasoningEffort: true,
			},
		})
			.streamResponse("model", { messages: [] }, { reasoning: "high" })
			.result();
		await new OpenAICompatibleProvider({
			...baseConfig,
			compat: {
				thinkingFormat: "zai",
				supportsReasoningEffort: true,
				thinkingLevelMap: { xhigh: "max" },
			},
		})
			.streamResponse("model", { messages: [] }, { reasoning: "xhigh" })
			.result();
		await new OpenAICompatibleProvider({
			...baseConfig,
			compat: {
				thinkingFormat: "zai",
				supportsReasoningEffort: true,
				thinkingLevelMap: { medium: null },
			},
		})
			.streamResponse("model", { messages: [] }, { reasoning: "medium" })
			.result();
		await new OpenAICompatibleProvider({
			...baseConfig,
			compat: {
				thinkingFormat: "zai",
				supportsReasoningEffort: false,
				thinkingLevelMap: { max: "provider-max" },
			},
		})
			.streamResponse("model", { messages: [] }, { reasoning: "max" })
			.result();

		expect(requestBodies).toHaveLength(7);
		expect(requestBodies[0]).toMatchObject({
			reasoning: { effort: "none" },
		});
		expect(requestBodies[1]).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "custom-medium",
		});
		expect(requestBodies[2]).toMatchObject({
			thinking: { type: "disabled" },
		});
		expect(requestBodies[2]).not.toHaveProperty("reasoning_effort");
		expect(requestBodies[3]).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "high",
		});
		expect(requestBodies[4]).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "max",
		});
		expect(requestBodies[5]).toMatchObject({
			thinking: { type: "enabled" },
		});
		expect(requestBodies[5]).not.toHaveProperty("reasoning_effort");
		expect(requestBodies[6]).toMatchObject({
			thinking: { type: "enabled" },
		});
		expect(requestBodies[6]).not.toHaveProperty("reasoning_effort");
		for (const body of requestBodies.slice(2)) {
			expect(body).not.toHaveProperty("enable_thinking");
			expect(body).not.toHaveProperty("clear_thinking");
		}
	});

	test("retries transient request failures before exposing the stream", async () => {
		let requestCount = 0;
		const { baseUrl } = startServer(() => {
			requestCount += 1;
			if (requestCount === 1) {
				return new Response(
					JSON.stringify({ error: { message: "temporary failure" } }),
					{
						status: 500,
						headers: {
							"Content-Type": "application/json",
							"retry-after-ms": "0",
						},
					},
				);
			}
			return sseResponse([
				chunk([
					{
						index: 0,
						delta: { content: "Recovered" },
						finish_reason: "stop",
					},
				]),
			]);
		});
		const provider = new OpenAICompatibleProvider({
			providerId: "compatible",
			baseUrl,
			retry: { maxRetries: 1 },
		});

		const events = await collect(
			provider.streamResponse("model", { messages: [] }),
		);

		expect(requestCount).toBe(2);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
	});

	test("uses retry classification and backoff from provider configuration", async () => {
		let requestCount = 0;
		const retryIndexes: number[] = [];
		const { baseUrl } = startServer(() => {
			requestCount += 1;
			if (requestCount === 1) {
				return new Response(
					JSON.stringify({ error: { message: "custom retry" } }),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return sseResponse([
				chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
			]);
		});
		const provider = new OpenAICompatibleProvider({
			providerId: "compatible",
			baseUrl,
			retry: {
				maxRetries: 1,
				isRetryable: () => true,
				backoffMs: (_error, retryIndex) => {
					retryIndexes.push(retryIndex);
					return 0;
				},
			},
		});

		const message = await provider
			.streamResponse("model", { messages: [] })
			.result();

		expect(requestCount).toBe(2);
		expect(retryIndexes).toEqual([0]);
		expect(message.stopReason).toBe("stop");
	});

	test("keeps a recovered retry inside one agent turn", async () => {
		let requestCount = 0;
		const { baseUrl } = startServer(() => {
			requestCount += 1;
			if (requestCount === 1) {
				return new Response(
					JSON.stringify({ error: { message: "temporary failure" } }),
					{
						status: 500,
						headers: {
							"Content-Type": "application/json",
							"retry-after-ms": "0",
						},
					},
				);
			}
			return sseResponse([
				chunk([
					{
						index: 0,
						delta: { content: "Recovered" },
						finish_reason: "stop",
					},
				]),
			]);
		});
		const provider = new OpenAICompatibleProvider({
			providerId: "compatible",
			baseUrl,
			retry: { maxRetries: 1 },
		});
		const prompt: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "Hello" }],
			timestamp: 1,
		};
		const context: AgentContext = {
			systemPrompt: "You are Areeb.",
			messages: [],
			tools: [],
		};
		const agentEvents: AgentEvent[] = [];

		const result = await runAgentLoop(
			[prompt],
			context,
			{ provider, model: "model" },
			(event) => {
				agentEvents.push(event);
			},
		);

		expect(requestCount).toBe(2);
		expect(
			agentEvents.filter((event) => event.type === "agent_start"),
		).toHaveLength(1);
		expect(
			agentEvents.filter((event) => event.type === "turn_start"),
		).toHaveLength(1);
		expect(
			agentEvents.filter((event) => event.type === "message_end"),
		).toHaveLength(2);
		expect(
			agentEvents.filter((event) => event.type === "turn_end"),
		).toHaveLength(1);
		expect(
			agentEvents.filter((event) => event.type === "agent_end"),
		).toHaveLength(1);
		expect(result.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Recovered" }],
			stopReason: "stop",
		});
	});

	test("does not retry after a provider stream has been exposed", async () => {
		let requestCount = 0;
		const { baseUrl } = startServer(() => {
			requestCount += 1;
			return sseResponse([
				chunk([
					{
						index: 0,
						delta: { content: "Partial" },
						finish_reason: null,
					},
				]),
			]);
		});
		const provider = new OpenAICompatibleProvider({
			providerId: "compatible",
			baseUrl,
			retry: { maxRetries: 2 },
		});
		const stream = provider.streamResponse("model", { messages: [] });

		const events = await collect(stream);
		const result = await stream.result();

		expect(requestCount).toBe(1);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"error",
		]);
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Partial" }],
			stopReason: "error",
			errorMessage: "The provider stream ended without a finish reason",
		});
	});

	test("returns one final error after exhausting transient retries", async () => {
		let requestCount = 0;
		const { baseUrl } = startServer(() => {
			requestCount += 1;
			return new Response(JSON.stringify({ error: { message: "try later" } }), {
				status: 503,
				headers: {
					"Content-Type": "application/json",
					"retry-after-ms": "0",
				},
			});
		});
		const provider = new OpenAICompatibleProvider({
			providerId: "compatible",
			baseUrl,
			retry: { maxRetries: 2 },
		});
		const stream = provider.streamResponse("model", { messages: [] });

		const events = await collect(stream);

		expect(requestCount).toBe(3);
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(await stream.result()).toMatchObject({
			content: [],
			stopReason: "error",
			errorMessage: "503 try later",
		});
	});

	test("can abort while waiting for a provider retry", async () => {
		let requestCount = 0;
		const controller = new AbortController();
		const { baseUrl } = startServer(() => {
			requestCount += 1;
			setTimeout(() => controller.abort(), 10);
			return new Response(JSON.stringify({ error: { message: "try later" } }), {
				status: 503,
				headers: {
					"Content-Type": "application/json",
					"retry-after-ms": "10000",
				},
			});
		});
		const provider = new OpenAICompatibleProvider({
			providerId: "compatible",
			baseUrl,
			retry: { maxRetries: 2 },
		});
		const stream = provider.streamResponse(
			"model",
			{ messages: [] },
			{ signal: controller.signal },
		);
		const events = await collect(stream);

		expect(requestCount).toBe(1);
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(await stream.result()).toMatchObject({
			stopReason: "aborted",
			errorMessage: "The model request was aborted",
		});
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
			{ signal: controller.signal },
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
