import { z } from "zod";
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "./event-stream.ts";
import type {
	DiscoveredModelLimit,
	ModelProvider,
	ProviderContextProjection,
	ProviderRetryConfig,
	StreamOptions,
} from "./provider_protocol.ts";
import type {
	AssistantContent,
	AssistantMessage,
	Message,
	ModelContext,
	StopReason,
	ToolCall,
	ToolDefinition,
	Usage,
} from "./types.ts";

export const CODEX_RESPONSES_BASE_URL =
	"https://chatgpt.com/backend-api/codex/responses";

// The catalog endpoint rejects requests that do not report a supported Codex version.
const CODEX_CLIENT_VERSION = "0.150.1";
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

type Fetch = typeof globalThis.fetch;

export interface CodexRequestAuth {
	readonly access: string;
	readonly accountId: string;
}

export interface CodexProviderConfig {
	readonly providerId?: string;
	readonly baseUrl?: string;
	readonly getAuth: (signal?: AbortSignal) => Promise<CodexRequestAuth>;
	readonly fetch?: Fetch;
	readonly headers?: Readonly<Record<string, string>>;
	readonly retry?: ProviderRetryConfig;
}

interface StreamingItem {
	readonly contentIndex: number;
	readonly outputIndex: number;
	readonly kind: "text" | "thinking" | "tool";
	argumentsText?: string;
	ended: boolean;
}

interface ResponsesEvent {
	readonly type?: unknown;
	readonly [key: string]: unknown;
}

interface TerminalResponse {
	readonly id?: unknown;
	readonly status?: unknown;
	readonly usage?: unknown;
	readonly incomplete_details?: unknown;
	readonly error?: unknown;
}

const EMPTY_USAGE: Usage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

/** SSE-only adapter for the ChatGPT Codex Responses endpoint. */
export class CodexProvider implements ModelProvider {
	readonly providerId: string;

	private readonly baseUrl: string;
	private readonly getAuth: CodexProviderConfig["getAuth"];
	private readonly fetch: Fetch;
	private readonly headers: Readonly<Record<string, string>>;
	private readonly retry: ProviderRetryConfig;

	constructor(config: CodexProviderConfig) {
		this.providerId = config.providerId ?? "openai-codex";
		this.baseUrl = normalizeCodexUrl(
			config.baseUrl ?? CODEX_RESPONSES_BASE_URL,
		);
		this.getAuth = config.getAuth;
		this.fetch = config.fetch ?? globalThis.fetch;
		this.headers = { ...config.headers };
		this.retry = { ...config.retry };
	}

	streamResponse(
		model: string,
		context: ModelContext,
		options?: StreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		void this.consume(stream, model, context, options);
		return stream;
	}

	projectContext(
		_model: string,
		context: ModelContext,
	): ProviderContextProjection {
		return {
			systemPrompt: context.systemPrompt ?? "You are a helpful assistant.",
			messages: convertProjectedMessages(context.messages).map((message) => {
				const elided = elideImagePayloads(message.value);
				return {
					sourceIndex: message.sourceIndex,
					value: elided.value,
					...(elided.imageCount === 0 ? {} : { imageCount: elided.imageCount }),
				};
			}),
			tools: convertTools(context.tools ?? []),
		};
	}

	async discoverModelLimits(
		signal?: AbortSignal,
	): Promise<readonly DiscoveredModelLimit[]> {
		const auth = await this.getAuth(signal);
		const response = await this.fetch(codexModelsUrl(this.baseUrl), {
			method: "GET",
			headers: {
				...this.headers,
				authorization: `Bearer ${auth.access}`,
				"chatgpt-account-id": auth.accountId,
				originator: "areeb",
				"user-agent": codexUserAgent(),
				accept: "application/json",
			},
			signal,
		});
		if (!response.ok) {
			throw new Error(`Model catalog request failed: HTTP ${response.status}`);
		}
		return readDiscoveredModelLimits(await response.json());
	}

	private async consume(
		stream: AssistantMessageEventStream,
		model: string,
		context: ModelContext,
		options?: StreamOptions,
	): Promise<void> {
		const content: AssistantContent[] = [];
		const output: AssistantMessage = {
			role: "assistant",
			content,
			provider: this.providerId,
			model,
			usage: { ...EMPTY_USAGE },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const items = new Map<number, StreamingItem>();
		let terminal = false;

		try {
			const auth = await this.getAuth(options?.signal);
			const requestBody = JSON.stringify(buildRequest(model, context, options));
			const response = await fetchWithRetry(
				this.fetch,
				this.baseUrl,
				{
					method: "POST",
					headers: {
						...this.headers,
						authorization: `Bearer ${auth.access}`,
						"chatgpt-account-id": auth.accountId,
						originator: "areeb",
						"user-agent": codexUserAgent(),
						"openai-beta": "responses=experimental",
						accept: "text/event-stream",
						"content-type": "application/json",
					},
					body: requestBody,
				},
				this.retry,
				options,
			);
			if (!response.body) {
				throw new Error("Codex response did not include an SSE body");
			}

			stream.push({ type: "start", partial: cloneMessage(output) });
			for await (const event of parseSse(response.body, options?.signal)) {
				const eventType =
					typeof event.type === "string" ? event.type : undefined;
				if (eventType === undefined) {
					continue;
				}
				if (eventType === "error") {
					throw new Error(readEventError(event));
				}
				if (
					eventType === "response.completed" ||
					eventType === "response.done" ||
					eventType === "response.incomplete" ||
					eventType === "response.failed"
				) {
					finishOpenItems(stream, output, items);
					const responseValue = readObject(
						event,
						"response",
					) as TerminalResponse;
					captureTerminalMetadata(output, responseValue);
					const finish = normalizeTerminal(responseValue, eventType, content);
					terminal = true;
					if (finish.stopReason === "error") {
						stream.push({
							type: "error",
							message: {
								...output,
								stopReason: "error",
								errorMessage: finish.errorMessage,
							},
						});
					} else {
						output.stopReason = finish.stopReason;
						stream.push({
							type: "done",
							message: output as AssistantMessage & {
								stopReason: "stop" | "length" | "tool_call";
								errorMessage?: never;
							},
						});
					}
					return;
				}

				applyEvent(stream, output, items, eventType, event);
			}
			throw new Error("Codex stream ended without a terminal response event");
		} catch (error) {
			if (terminal) {
				return;
			}
			const aborted =
				options?.signal?.aborted === true ||
				(error instanceof Error && error.name === "AbortError");
			stream.push({
				type: "error",
				message: {
					...output,
					stopReason: aborted ? "aborted" : "error",
					errorMessage: aborted
						? "The model request was aborted"
						: errorMessage(error),
				},
			});
		}
	}
}

function buildRequest(
	model: string,
	context: ModelContext,
	options?: StreamOptions,
): Record<string, unknown> {
	return {
		model,
		store: false,
		stream: true,
		instructions: context.systemPrompt ?? "You are a helpful assistant.",
		input: convertMessages(context.messages),
		text: { verbosity: "low" },
		include: ["reasoning.encrypted_content"],
		...(context.tools && context.tools.length > 0
			? {
					tools: convertTools(context.tools),
					tool_choice: "auto",
					parallel_tool_calls: true,
				}
			: {}),
		...(options?.reasoning === undefined || options.reasoning === "off"
			? {}
			: { reasoning: { effort: options.reasoning, summary: "auto" } }),
	};
}

function convertMessages(messages: readonly Message[]): unknown[] {
	return convertProjectedMessages(messages).map((message) => message.value);
}

interface CodexProjectedMessage {
	readonly sourceIndex: number;
	readonly value: unknown;
}

function convertProjectedMessages(
	messages: readonly Message[],
): CodexProjectedMessage[] {
	const input: CodexProjectedMessage[] = [];
	for (const [sourceIndex, message] of messages.entries()) {
		switch (message.role) {
			case "user":
				if (message.content.length > 0) {
					input.push({
						sourceIndex,
						value: {
							type: "message",
							role: "user",
							content: message.content.map((part) =>
								part.type === "text"
									? { type: "input_text", text: part.text }
									: {
											type: "input_image",
											image_url: `data:${part.mimeType};base64,${part.data}`,
										},
							),
						},
					});
				}
				break;
			case "assistant": {
				for (const part of message.content) {
					if (part.type === "thinking" && part.signature) {
						const replay = parseReplayItem(part.signature);
						if (replay !== undefined) {
							input.push({ sourceIndex, value: replay });
						}
					}
				}
				const text = message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
				if (text) {
					input.push({
						sourceIndex,
						value: {
							type: "message",
							role: "assistant",
							status: "completed",
							content: [
								{
									type: "output_text",
									text,
									annotations: [],
								},
							],
						},
					});
				}
				for (const toolCall of message.content.filter(
					(part) => part.type === "tool_call",
				)) {
					const [callId, itemId] = splitToolId(toolCall.id);
					input.push({
						sourceIndex,
						value: {
							type: "function_call",
							...(itemId === undefined ? {} : { id: itemId }),
							call_id: callId,
							name: toolCall.name,
							arguments: JSON.stringify(toolCall.arguments),
						},
					});
				}
				break;
			}
			case "tool_result": {
				const [callId] = splitToolId(message.toolCallId);
				const text = message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				input.push({
					sourceIndex,
					value: {
						type: "function_call_output",
						call_id: callId,
						output: text || "(tool returned non-text content)",
					},
				});
				break;
			}
		}
	}
	return input;
}

function elideImagePayloads(value: unknown): {
	readonly value: unknown;
	readonly imageCount: number;
} {
	let imageCount = 0;
	const visit = (candidate: unknown): unknown => {
		if (Array.isArray(candidate)) {
			return candidate.map(visit);
		}
		if (typeof candidate !== "object" || candidate === null) {
			return candidate;
		}
		const copy: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(candidate)) {
			if (
				key === "image_url" &&
				typeof nested === "string" &&
				nested.startsWith("data:")
			) {
				imageCount += 1;
				copy[key] = "[image]";
			} else {
				copy[key] = visit(nested);
			}
		}
		return copy;
	};
	return { value: visit(value), imageCount };
}

function convertTools(tools: readonly ToolDefinition[]): unknown[] {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: z.toJSONSchema(tool.inputSchema, {
			target: "draft-07",
			io: "input",
		}),
		strict: false,
	}));
}

function applyEvent(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	items: Map<number, StreamingItem>,
	type: string,
	event: ResponsesEvent,
): void {
	if (type === "response.created") {
		const response = readOptionalObject(event, "response");
		const id = response && readOptionalString(response, "id");
		if (id) {
			output.responseId = id;
		}
		return;
	}
	if (type === "response.output_item.added") {
		const outputIndex = readNumber(event, "output_index");
		const item = readObject(event, "item");
		const itemType = readString(item, "type");
		if (items.has(outputIndex)) {
			return;
		}
		if (itemType === "reasoning") {
			const contentIndex = output.content.length;
			output.content.push({ type: "thinking", thinking: "" });
			items.set(outputIndex, {
				contentIndex,
				outputIndex,
				kind: "thinking",
				ended: false,
			});
			stream.push({
				type: "thinking_start",
				contentIndex,
				partial: cloneMessage(output),
			});
		} else if (itemType === "message") {
			const contentIndex = output.content.length;
			output.content.push({ type: "text", text: "" });
			items.set(outputIndex, {
				contentIndex,
				outputIndex,
				kind: "text",
				ended: false,
			});
			stream.push({
				type: "text_start",
				contentIndex,
				partial: cloneMessage(output),
			});
		} else if (itemType === "function_call") {
			const callId = readOptionalString(item, "call_id") ?? "";
			const itemId = readOptionalString(item, "id");
			const toolCall: ToolCall = {
				type: "tool_call",
				id: joinToolId(callId, itemId),
				name: readOptionalString(item, "name") ?? "",
				arguments: {},
			};
			const contentIndex = output.content.length;
			output.content.push(toolCall);
			items.set(outputIndex, {
				contentIndex,
				outputIndex,
				kind: "tool",
				argumentsText: "",
				ended: false,
			});
			stream.push({
				type: "toolcall_start",
				contentIndex,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				partial: cloneMessage(output),
			});
		}
		return;
	}

	const outputIndex = readOptionalNumber(event, "output_index");
	const streaming =
		outputIndex === undefined ? undefined : items.get(outputIndex);
	if (
		type === "response.reasoning_summary_text.delta" ||
		type === "response.reasoning_text.delta"
	) {
		appendThinking(stream, output, streaming, readString(event, "delta"));
		return;
	}
	if (type === "response.reasoning_summary_part.done") {
		appendThinking(stream, output, streaming, "\n\n");
		return;
	}
	if (
		type === "response.output_text.delta" ||
		type === "response.refusal.delta"
	) {
		appendText(stream, output, streaming, readString(event, "delta"));
		return;
	}
	if (type === "response.function_call_arguments.delta") {
		appendToolArguments(stream, output, streaming, readString(event, "delta"));
		return;
	}
	if (type === "response.function_call_arguments.done") {
		const complete = readOptionalString(event, "arguments");
		if (streaming?.kind === "tool" && complete !== undefined) {
			const current = streaming.argumentsText ?? "";
			if (complete.startsWith(current)) {
				appendToolArguments(
					stream,
					output,
					streaming,
					complete.slice(current.length),
				);
			} else {
				streaming.argumentsText = complete;
			}
		}
		return;
	}
	if (type === "response.output_item.done" && streaming !== undefined) {
		const item = readObject(event, "item");
		if (streaming.kind === "thinking") {
			const block = output.content[streaming.contentIndex];
			if (block?.type === "thinking") {
				block.signature = JSON.stringify(item);
			}
		} else if (streaming.kind === "tool") {
			const complete = readOptionalString(item, "arguments");
			if (complete !== undefined) {
				streaming.argumentsText = complete;
			}
		}
		finishItem(stream, output, streaming);
	}
}

function appendThinking(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	item: StreamingItem | undefined,
	delta: string,
): void {
	if (item?.kind !== "thinking" || !delta) {
		return;
	}
	const block = output.content[item.contentIndex];
	if (block?.type !== "thinking") {
		throw new Error("Invalid Codex reasoning streaming state");
	}
	block.thinking += delta;
	stream.push({
		type: "thinking_delta",
		contentIndex: item.contentIndex,
		delta,
		partial: cloneMessage(output),
	});
}

function appendText(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	item: StreamingItem | undefined,
	delta: string,
): void {
	if (item?.kind !== "text" || !delta) {
		return;
	}
	const block = output.content[item.contentIndex];
	if (block?.type !== "text") {
		throw new Error("Invalid Codex text streaming state");
	}
	block.text += delta;
	stream.push({
		type: "text_delta",
		contentIndex: item.contentIndex,
		delta,
		partial: cloneMessage(output),
	});
}

function appendToolArguments(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	item: StreamingItem | undefined,
	delta: string,
): void {
	if (item?.kind !== "tool" || !delta) {
		return;
	}
	item.argumentsText = (item.argumentsText ?? "") + delta;
	const block = output.content[item.contentIndex];
	if (block?.type !== "tool_call") {
		throw new Error("Invalid Codex tool-call streaming state");
	}
	stream.push({
		type: "toolcall_delta",
		contentIndex: item.contentIndex,
		toolCallId: block.id,
		argumentsDelta: delta,
		partial: cloneMessage(output),
	});
}

function finishOpenItems(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	items: ReadonlyMap<number, StreamingItem>,
): void {
	for (const item of items.values()) {
		finishItem(stream, output, item);
	}
}

function finishItem(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	item: StreamingItem,
): void {
	if (item.ended) {
		return;
	}
	item.ended = true;
	const block = output.content[item.contentIndex];
	if (item.kind === "text") {
		if (block?.type !== "text") {
			throw new Error("Invalid Codex text streaming state");
		}
		stream.push({
			type: "text_end",
			contentIndex: item.contentIndex,
			content: { ...block },
			partial: cloneMessage(output),
		});
		return;
	}
	if (item.kind === "thinking") {
		if (block?.type !== "thinking") {
			throw new Error("Invalid Codex reasoning streaming state");
		}
		stream.push({
			type: "thinking_end",
			contentIndex: item.contentIndex,
			content: { ...block },
			partial: cloneMessage(output),
		});
		return;
	}
	if (block?.type !== "tool_call") {
		throw new Error("Invalid Codex tool-call streaming state");
	}
	block.arguments = parseArguments(item.argumentsText ?? "", block);
	stream.push({
		type: "toolcall_end",
		contentIndex: item.contentIndex,
		toolCall: { ...block, arguments: structuredClone(block.arguments) },
		partial: cloneMessage(output),
	});
}

function captureTerminalMetadata(
	output: AssistantMessage,
	response: TerminalResponse,
): void {
	if (typeof response.id === "string" && response.id) {
		output.responseId = response.id;
	}
	if (typeof response.usage === "object" && response.usage !== null) {
		const input = numberField(response.usage, "input_tokens") ?? 0;
		const outputTokens = numberField(response.usage, "output_tokens") ?? 0;
		const details = Reflect.get(response.usage, "input_tokens_details");
		const cached =
			typeof details === "object" && details !== null
				? (numberField(details, "cached_tokens") ?? 0)
				: 0;
		output.usage = {
			inputTokens: Math.max(0, input - cached),
			outputTokens,
			cacheReadTokens: cached,
			cacheWriteTokens: 0,
			totalTokens: input + outputTokens,
		};
	}
}

function normalizeTerminal(
	response: TerminalResponse,
	eventType: string,
	content: readonly AssistantContent[],
): {
	readonly stopReason: Exclude<StopReason, "aborted">;
	readonly errorMessage: string;
} {
	const status =
		typeof response.status === "string"
			? response.status
			: eventType === "response.failed"
				? "failed"
				: eventType === "response.incomplete"
					? "incomplete"
					: "completed";
	if (status === "failed" || status === "cancelled" || status === "canceled") {
		return { stopReason: "error", errorMessage: readResponseError(response) };
	}
	if (status === "incomplete") {
		const details = response.incomplete_details;
		const reason =
			typeof details === "object" && details !== null
				? Reflect.get(details, "reason")
				: undefined;
		return reason === "max_output_tokens"
			? { stopReason: "length", errorMessage: "" }
			: {
					stopReason: "error",
					errorMessage: `Codex response was incomplete${typeof reason === "string" ? `: ${reason}` : ""}`,
				};
	}
	return content.some((part) => part.type === "tool_call")
		? { stopReason: "tool_call", errorMessage: "" }
		: { stopReason: "stop", errorMessage: "" };
}

async function* parseSse(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ResponsesEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) {
				throw createAbortError();
			}
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			let boundary = findRecordBoundary(buffer);
			while (boundary !== undefined) {
				const record = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary.length);
				const event = parseSseRecord(record);
				if (event !== undefined) {
					yield event;
				}
				boundary = findRecordBoundary(buffer);
			}
			if (done) {
				const event = parseSseRecord(buffer);
				if (event !== undefined) {
					yield event;
				}
				return;
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

function parseSseRecord(record: string): ResponsesEvent | undefined {
	const data = record
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^ /, ""))
		.join("\n")
		.trim();
	if (!data || data === "[DONE]") {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(data);
		if (typeof parsed !== "object" || parsed === null) {
			throw new Error("event is not an object");
		}
		return parsed as ResponsesEvent;
	} catch (error) {
		throw new Error(`Invalid Codex SSE event: ${data}`, { cause: error });
	}
}

async function fetchWithRetry(
	fetcher: Fetch,
	url: string,
	init: RequestInit,
	retry: ProviderRetryConfig,
	options?: StreamOptions,
): Promise<Response> {
	const maxRetries = normalizeMaxRetries(retry.maxRetries);
	let attempt = 0;
	while (true) {
		try {
			const signal = requestSignal(options);
			const response = await fetcher(url, { ...init, signal });
			if (response.ok) {
				return response;
			}
			const body = await response.text().catch(() => "");
			const error = new CodexHttpError(response.status, response.headers, body);
			if (attempt >= maxRetries || !isRetryableHttp(error)) {
				throw error;
			}
			await waitForRetry(retryDelay(error, attempt, retry), options?.signal);
			attempt += 1;
		} catch (error) {
			if (
				options?.signal?.aborted ||
				(error instanceof Error && error.name === "AbortError")
			) {
				throw createAbortError();
			}
			if (
				error instanceof CodexHttpError ||
				attempt >= maxRetries ||
				!(retry.isRetryable?.(error) ?? true)
			) {
				throw error;
			}
			await waitForRetry(retryDelay(error, attempt, retry), options?.signal);
			attempt += 1;
		}
	}
}

class CodexHttpError extends Error {
	constructor(
		readonly status: number,
		readonly headers: Headers,
		readonly body: string,
	) {
		super(`Codex request failed: HTTP ${status}${body ? `: ${body}` : ""}`);
		this.name = "CodexHttpError";
	}
}

function isRetryableHttp(error: CodexHttpError): boolean {
	if (![429, 500, 502, 503, 504].includes(error.status)) {
		return false;
	}
	return !/usage.?limit|insufficient_quota|billing|out.?of.?budget|balance/i.test(
		error.body,
	);
}

function retryDelay(
	error: unknown,
	attempt: number,
	config: ProviderRetryConfig,
): number {
	const custom = config.backoffMs?.(error, attempt);
	let delay = custom ?? readRetryAfter(error) ?? 1_000 * 2 ** attempt;
	if (!Number.isFinite(delay)) {
		throw new Error("Retry backoff must return a finite delay");
	}
	delay = Math.max(0, delay);
	const maximum = config.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maximum > 0 && delay > maximum) {
		throw new Error(
			`Server requested ${Math.ceil(delay / 1_000)}s retry delay (max: ${Math.ceil(maximum / 1_000)}s)`,
		);
	}
	return delay;
}

function readRetryAfter(error: unknown): number | undefined {
	if (!(error instanceof CodexHttpError)) {
		return undefined;
	}
	const milliseconds = error.headers.get("retry-after-ms");
	if (milliseconds !== null) {
		const value = Number.parseFloat(milliseconds);
		if (Number.isFinite(value)) {
			return value;
		}
	}
	const retryAfter = error.headers.get("retry-after");
	if (retryAfter === null) {
		return undefined;
	}
	const seconds = Number.parseFloat(retryAfter);
	if (Number.isFinite(seconds)) {
		return seconds * 1_000;
	}
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? date - Date.now() : undefined;
}

function normalizeMaxRetries(value: number | undefined): number {
	if (value === undefined) {
		return DEFAULT_MAX_RETRIES;
	}
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function requestSignal(options?: StreamOptions): AbortSignal | undefined {
	if (options?.timeout === undefined) {
		return options?.signal;
	}
	const timeout = AbortSignal.timeout(options.timeout);
	return options.signal === undefined
		? timeout
		: AbortSignal.any([options.signal, timeout]);
}

function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(createAbortError());
	}
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delay);
		const onAbort = (): void => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(createAbortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function normalizeCodexUrl(value: string): string {
	const base = value.replace(/\/+$/, "");
	if (base.endsWith("/codex/responses")) {
		return base;
	}
	return base.endsWith("/codex")
		? `${base}/responses`
		: `${base}/codex/responses`;
}

function codexModelsUrl(responsesUrl: string): string {
	const url = new URL(responsesUrl);
	url.pathname = url.pathname.replace(/\/responses\/?$/, "/models");
	url.search = "";
	url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
	url.hash = "";
	return url.toString();
}

function readDiscoveredModelLimits(value: unknown): DiscoveredModelLimit[] {
	const items = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null
			? ["models", "data"].flatMap((field) => {
					const candidate = Reflect.get(value, field);
					return Array.isArray(candidate) ? candidate : [];
				})
			: [];
	return items.flatMap((item) => {
		if (typeof item !== "object" || item === null) {
			return [];
		}
		const model = ["slug", "id", "model", "name"].flatMap((field) => {
			const candidate = Reflect.get(item, field);
			return typeof candidate === "string" && candidate.length > 0
				? [candidate]
				: [];
		})[0];
		const contextWindowTokens = [
			"context_window",
			"max_context_window",
		].flatMap((field) => {
			const candidate = Reflect.get(item, field);
			return isPositiveFinite(candidate) ? [candidate] : [];
		})[0];
		if (model === undefined || contextWindowTokens === undefined) {
			return [];
		}
		const effective = Reflect.get(item, "effective_context_window_percent");
		return [
			{
				model,
				contextWindowTokens,
				...(isPositiveFinite(effective)
					? { effectiveContextWindowPercent: effective }
					: {}),
			},
		];
	});
}

function isPositiveFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseReplayItem(signature: string): object | undefined {
	try {
		const value: unknown = JSON.parse(signature);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

function parseArguments(
	text: string,
	toolCall: ToolCall,
): Record<string, unknown> {
	if (!text) {
		return {};
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid JSON arguments for tool call ${toolCall.name}`, {
			cause: error,
		});
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Tool call ${toolCall.name} arguments must be an object`);
	}
	return value as Record<string, unknown>;
}

function splitToolId(id: string): readonly [string, string?] {
	const separator = id.indexOf("|");
	return separator === -1
		? [id]
		: [id.slice(0, separator), id.slice(separator + 1) || undefined];
}

function joinToolId(callId: string, itemId: string | undefined): string {
	return itemId ? `${callId}|${itemId}` : callId;
}

function readEventError(event: object): string {
	const nested = readOptionalObject(event, "error");
	return (
		(nested && readOptionalString(nested, "message")) ??
		readOptionalString(event, "message") ??
		"Codex returned an error event"
	);
}

function readResponseError(response: TerminalResponse): string {
	const error = response.error;
	return typeof error === "object" && error !== null
		? (readOptionalString(error, "message") ?? "Codex response failed")
		: "Codex response failed";
}

function readObject(value: object, key: string): Record<string, unknown> {
	const result = Reflect.get(value, key);
	if (typeof result !== "object" || result === null || Array.isArray(result)) {
		throw new Error(`Codex event is missing object field ${key}`);
	}
	return result as Record<string, unknown>;
}

function readOptionalObject(
	value: object,
	key: string,
): Record<string, unknown> | undefined {
	const result = Reflect.get(value, key);
	return typeof result === "object" && result !== null && !Array.isArray(result)
		? (result as Record<string, unknown>)
		: undefined;
}

function readString(value: object, key: string): string {
	const result = Reflect.get(value, key);
	if (typeof result !== "string") {
		throw new Error(`Codex event is missing string field ${key}`);
	}
	return result;
}

function readOptionalString(value: object, key: string): string | undefined {
	const result = Reflect.get(value, key);
	return typeof result === "string" ? result : undefined;
}

function readNumber(value: object, key: string): number {
	const result = Reflect.get(value, key);
	if (typeof result !== "number" || !Number.isFinite(result)) {
		throw new Error(`Codex event is missing number field ${key}`);
	}
	return result;
}

function readOptionalNumber(value: object, key: string): number | undefined {
	const result = Reflect.get(value, key);
	return typeof result === "number" && Number.isFinite(result)
		? result
		: undefined;
}

function numberField(value: object, key: string): number | undefined {
	return readOptionalNumber(value, key);
}

function findRecordBoundary(
	value: string,
): { readonly index: number; readonly length: number } | undefined {
	const unix = value.indexOf("\n\n");
	const windows = value.indexOf("\r\n\r\n");
	if (unix === -1 && windows === -1) {
		return undefined;
	}
	if (windows !== -1 && (unix === -1 || windows < unix)) {
		return { index: windows, length: 4 };
	}
	return { index: unix, length: 2 };
}

function cloneMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map((part) =>
			part.type === "tool_call"
				? { ...part, arguments: structuredClone(part.arguments) }
				: { ...part },
		),
		usage: { ...message.usage },
	};
}

function codexUserAgent(): string {
	return `areeb (${process.platform} ${process.release.name}; ${process.arch})`;
}

function createAbortError(): Error {
	const error = new Error("The model request was aborted");
	error.name = "AbortError";
	return error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
