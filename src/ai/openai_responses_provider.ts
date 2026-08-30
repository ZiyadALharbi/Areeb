import OpenAI, {
	APIConnectionError,
	APIError,
	APIUserAbortError,
} from "openai";
import type {
	FunctionTool,
	Response as OpenAIResponse,
	ResponseCreateParamsStreaming,
	ResponseInputItem,
	ResponseStreamEvent,
	ResponseUsage,
} from "openai/resources/responses/responses.js";
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

export interface OpenAIResponsesConfig {
	readonly providerId: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly retry?: ProviderRetryConfig;
	readonly fetch?: typeof globalThis.fetch;
}

interface StreamingItem {
	readonly contentIndex: number;
	readonly kind: "text" | "thinking" | "tool";
	argumentsText?: string;
	ended: boolean;
}

const EMPTY_USAGE: Usage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

/** Responses API adapter for the official OpenAI API-key provider. */
export class OpenAIResponsesProvider implements ModelProvider {
	readonly providerId: string;

	private readonly client: OpenAI;
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly headers: Readonly<Record<string, string>>;
	private readonly fetch: typeof globalThis.fetch;
	private readonly retry: ProviderRetryConfig;

	constructor(config: OpenAIResponsesConfig) {
		this.providerId = config.providerId;
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.apiKey = config.apiKey;
		this.headers = { ...config.headers };
		this.fetch = config.fetch ?? globalThis.fetch;
		this.retry = { ...config.retry };
		this.client = new OpenAI({
			apiKey: this.apiKey,
			baseURL: this.baseUrl,
			defaultHeaders: config.headers,
			fetch: config.fetch,
			maxRetries: 0,
		});
	}

	projectContext(
		_model: string,
		context: ModelContext,
	): ProviderContextProjection {
		return {
			systemPrompt: context.systemPrompt ?? "",
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
		const response = await this.fetch(openAIModelsUrl(this.baseUrl), {
			method: "GET",
			headers: {
				...this.headers,
				authorization: `Bearer ${this.apiKey}`,
				accept: "application/json",
			},
			signal,
		});
		if (!response.ok) {
			throw new Error(`Model catalog request failed: HTTP ${response.status}`);
		}
		return readDiscoveredModelLimits(await response.json());
	}

	streamResponse(
		model: string,
		context: ModelContext,
		options?: StreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		void this.consumeResponse(stream, model, context, options);
		return stream;
	}

	private async consumeResponse(
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
			const request = buildRequest(model, context, options);
			const events = await retryProviderRequest(
				async () =>
					await this.client.responses.create(request, {
						...(options?.signal ? { signal: options.signal } : {}),
						...(options?.timeout === undefined
							? {}
							: { timeout: options.timeout }),
						maxRetries: 0,
					}),
				this.retry,
				options?.signal,
			);

			stream.push({ type: "start", partial: cloneMessage(output) });
			for await (const event of events) {
				if (event.type === "error") {
					throw new Error(event.message);
				}
				if (
					event.type === "response.completed" ||
					event.type === "response.incomplete" ||
					event.type === "response.failed"
				) {
					finishOpenItems(stream, output, items);
					captureTerminalMetadata(output, event.response);
					const finish = normalizeTerminal(event.response, event.type, content);
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

				applyEvent(stream, output, items, event);
			}
			throw new Error(
				"OpenAI Responses stream ended without a terminal response event",
			);
		} catch (error) {
			if (terminal) {
				return;
			}
			const aborted = isAbortError(error, options?.signal);
			stream.push({
				type: "error",
				message: {
					...output,
					stopReason: aborted ? "aborted" : "error",
					errorMessage: aborted
						? "The model request was aborted"
						: errorToMessage(error),
				},
			});
		}
	}
}

function buildRequest(
	model: string,
	context: ModelContext,
	options?: StreamOptions,
): ResponseCreateParamsStreaming {
	const reasoning = options?.reasoning;
	return {
		model,
		store: false,
		stream: true,
		instructions: context.systemPrompt ?? "You are a helpful assistant.",
		input: convertMessages(context.messages),
		include: ["reasoning.encrypted_content"],
		...(context.tools && context.tools.length > 0
			? {
					tools: convertTools(context.tools),
					tool_choice: "auto" as const,
					parallel_tool_calls: true,
				}
			: {}),
		...(reasoning === undefined
			? {}
			: reasoning === "off"
				? { reasoning: { effort: "none" as const } }
				: { reasoning: { effort: reasoning, summary: "auto" as const } }),
	};
}

function convertMessages(messages: readonly Message[]): ResponseInputItem[] {
	return convertProjectedMessages(messages).map((message) => message.value);
}

interface OpenAIResponsesProjectedMessage {
	readonly sourceIndex: number;
	readonly value: ResponseInputItem;
}

function convertProjectedMessages(
	messages: readonly Message[],
): OpenAIResponsesProjectedMessage[] {
	const input: OpenAIResponsesProjectedMessage[] = [];
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
											detail: "auto",
											image_url: `data:${part.mimeType};base64,${part.data}`,
										},
							),
						},
					});
				}
				break;
			case "assistant": {
				for (const part of message.content) {
					if (part.type !== "thinking" || !part.signature) {
						continue;
					}
					const replay = parseReasoningReplayItem(part.signature);
					if (replay !== undefined) {
						input.push({ sourceIndex, value: replay });
					}
				}
				const text = message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
				if (text) {
					input.push({
						sourceIndex,
						value: { type: "message", role: "assistant", content: text },
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
				const images = message.content.filter((part) => part.type === "image");
				input.push({
					sourceIndex,
					value: {
						type: "function_call_output",
						call_id: callId,
						output:
							images.length === 0
								? text
								: [
										...(text ? [{ type: "input_text" as const, text }] : []),
										...images.map((image) => ({
											type: "input_image" as const,
											detail: "auto" as const,
											image_url: `data:${image.mimeType};base64,${image.data}`,
										})),
									],
					},
				});
				break;
			}
		}
	}
	return input;
}

function convertTools(tools: readonly ToolDefinition[]): FunctionTool[] {
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
	event: ResponseStreamEvent,
): void {
	switch (event.type) {
		case "response.created":
			output.responseId = event.response.id;
			return;
		case "response.output_item.added":
			startItem(stream, output, items, event.output_index, event.item);
			return;
		case "response.reasoning_summary_text.delta":
		case "response.reasoning_text.delta":
			appendThinking(
				stream,
				output,
				items.get(event.output_index),
				event.delta,
			);
			return;
		case "response.reasoning_summary_part.done":
			appendThinking(stream, output, items.get(event.output_index), "\n\n");
			return;
		case "response.output_text.delta":
		case "response.refusal.delta":
			appendText(stream, output, items.get(event.output_index), event.delta);
			return;
		case "response.function_call_arguments.delta":
			appendToolArguments(
				stream,
				output,
				items.get(event.output_index),
				event.delta,
			);
			return;
		case "response.function_call_arguments.done": {
			const item = items.get(event.output_index);
			if (item?.kind === "tool") {
				const current = item.argumentsText ?? "";
				if (event.arguments.startsWith(current)) {
					appendToolArguments(
						stream,
						output,
						item,
						event.arguments.slice(current.length),
					);
				} else {
					item.argumentsText = event.arguments;
				}
			}
			return;
		}
		case "response.output_item.done": {
			const item = items.get(event.output_index);
			if (item === undefined) {
				return;
			}
			if (item.kind === "thinking" && event.item.type === "reasoning") {
				const block = output.content[item.contentIndex];
				if (block?.type === "thinking") {
					block.signature = JSON.stringify(event.item);
				}
			} else if (item.kind === "tool" && event.item.type === "function_call") {
				item.argumentsText = event.item.arguments;
			}
			finishItem(stream, output, item);
			return;
		}
		default:
			return;
	}
}

function startItem(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	items: Map<number, StreamingItem>,
	outputIndex: number,
	item: Extract<
		ResponseStreamEvent,
		{ readonly type: "response.output_item.added" }
	>["item"],
): void {
	if (items.has(outputIndex)) {
		return;
	}
	if (item.type === "reasoning") {
		const contentIndex = output.content.length;
		output.content.push({ type: "thinking", thinking: "" });
		items.set(outputIndex, {
			contentIndex,
			kind: "thinking",
			ended: false,
		});
		stream.push({
			type: "thinking_start",
			contentIndex,
			partial: cloneMessage(output),
		});
		return;
	}
	if (item.type === "message") {
		const contentIndex = output.content.length;
		output.content.push({ type: "text", text: "" });
		items.set(outputIndex, {
			contentIndex,
			kind: "text",
			ended: false,
		});
		stream.push({
			type: "text_start",
			contentIndex,
			partial: cloneMessage(output),
		});
		return;
	}
	if (item.type === "function_call") {
		const toolCall: ToolCall = {
			type: "tool_call",
			id: joinToolId(item.call_id, item.id),
			name: item.name,
			arguments: {},
		};
		const contentIndex = output.content.length;
		output.content.push(toolCall);
		items.set(outputIndex, {
			contentIndex,
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
		throw new Error("Invalid OpenAI reasoning streaming state");
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
		throw new Error("Invalid OpenAI text streaming state");
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
		throw new Error("Invalid OpenAI tool-call streaming state");
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
			throw new Error("Invalid OpenAI text streaming state");
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
			throw new Error("Invalid OpenAI reasoning streaming state");
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
		throw new Error("Invalid OpenAI tool-call streaming state");
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
	response: OpenAIResponse,
): void {
	if (response.id) {
		output.responseId = response.id;
	}
	if (response.usage) {
		output.usage = convertUsage(response.usage);
	}
}

function convertUsage(usage: ResponseUsage): Usage {
	const cacheReadTokens = usage.input_tokens_details.cached_tokens ?? 0;
	const cacheWriteTokens = usage.input_tokens_details.cache_write_tokens ?? 0;
	return {
		inputTokens: Math.max(
			0,
			usage.input_tokens - cacheReadTokens - cacheWriteTokens,
		),
		outputTokens: usage.output_tokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens: usage.total_tokens,
	};
}

function normalizeTerminal(
	response: OpenAIResponse,
	eventType: "response.completed" | "response.incomplete" | "response.failed",
	content: readonly AssistantContent[],
): {
	readonly stopReason: Exclude<StopReason, "aborted">;
	readonly errorMessage: string;
} {
	if (
		eventType === "response.failed" ||
		response.status === "failed" ||
		response.status === "cancelled"
	) {
		return {
			stopReason: "error",
			errorMessage: response.error?.message ?? "OpenAI response failed",
		};
	}
	if (eventType === "response.incomplete" || response.status === "incomplete") {
		const reason = response.incomplete_details?.reason;
		return reason === "max_output_tokens"
			? { stopReason: "length", errorMessage: "" }
			: {
					stopReason: "error",
					errorMessage: `OpenAI response was incomplete${reason ? `: ${reason}` : ""}`,
				};
	}
	return content.some((part) => part.type === "tool_call")
		? { stopReason: "tool_call", errorMessage: "" }
		: { stopReason: "stop", errorMessage: "" };
}

function parseReasoningReplayItem(
	signature: string,
): ResponseInputItem | undefined {
	try {
		const value: unknown = JSON.parse(signature);
		return typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			Reflect.get(value, "type") === "reasoning"
			? (value as ResponseInputItem)
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

function openAIModelsUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
	return url.toString();
}

function readDiscoveredModelLimits(value: unknown): DiscoveredModelLimit[] {
	const items =
		typeof value === "object" &&
		value !== null &&
		Array.isArray(Reflect.get(value, "data"))
			? (Reflect.get(value, "data") as unknown[])
			: Array.isArray(value)
				? value
				: [];
	return items.flatMap((item) => {
		if (typeof item !== "object" || item === null) {
			return [];
		}
		const model = Reflect.get(item, "id");
		const contextWindowTokens = [
			"context_length",
			"max_model_len",
			"context_window",
		].flatMap((field) => {
			const candidate = Reflect.get(item, field);
			return isPositiveFinite(candidate) ? [candidate] : [];
		})[0];
		return typeof model === "string" && contextWindowTokens !== undefined
			? [{ model, contextWindowTokens }]
			: [];
	});
}

function isPositiveFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

function normalizeMaxRetries(maxRetries: number | undefined): number {
	if (maxRetries === undefined) {
		return DEFAULT_MAX_RETRIES;
	}
	if (!Number.isFinite(maxRetries) || maxRetries <= 0) {
		return 0;
	}
	return Math.floor(maxRetries);
}

async function retryProviderRequest<T>(
	request: () => Promise<T>,
	config: ProviderRetryConfig,
	signal?: AbortSignal,
): Promise<T> {
	const maxRetries = normalizeMaxRetries(config.maxRetries);
	let retriesRemaining = maxRetries;

	while (true) {
		try {
			return await request();
		} catch (error) {
			if (signal?.aborted) {
				throw createAbortError();
			}
			const isRetryable = config.isRetryable ?? isRetryableError;
			if (retriesRemaining <= 0 || !isRetryable(error)) {
				throw error;
			}

			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining -= 1;
			const backoffMs = config.backoffMs ?? retryDelayMs;
			await waitForRetry(
				validateRetryDelayMs(
					backoffMs(error, retryIndex),
					config.maxRetryDelayMs,
					error,
				),
				signal,
			);
		}
	}
}

function isRetryableError(error: unknown): boolean {
	if (error instanceof APIConnectionError) {
		return true;
	}
	if (!(error instanceof APIError)) {
		return false;
	}

	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") {
		return true;
	}
	if (shouldRetry === "false") {
		return false;
	}

	return (
		error.status === 408 ||
		error.status === 409 ||
		error.status === 429 ||
		(error.status !== undefined && error.status >= 500)
	);
}

function retryDelayMs(error: unknown, retryIndex: number): number {
	const headers = error instanceof APIError ? error.headers : undefined;
	const retryAfterMs = headers?.get("retry-after-ms");
	if (retryAfterMs !== null && retryAfterMs !== undefined) {
		const parsed = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	const retryAfter = headers?.get("retry-after");
	if (retryAfter !== null && retryAfter !== undefined) {
		const seconds = Number.parseFloat(retryAfter);
		if (Number.isFinite(seconds)) {
			return seconds * 1_000;
		}
		const dateDelay = Date.parse(retryAfter) - Date.now();
		if (Number.isFinite(dateDelay)) {
			return dateDelay;
		}
	}

	const exponentialDelay = Math.min(500 * 2 ** retryIndex, 8_000);
	return exponentialDelay * (1 - Math.random() * 0.25);
}

function validateRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	error: unknown,
): number {
	if (!Number.isFinite(delayMs)) {
		throw new Error("Retry backoff must return a finite delay");
	}
	const normalizedDelayMs = Math.max(0, delayMs);
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && normalizedDelayMs > maxDelayMs) {
		throw new Error(
			`Server requested ${Math.ceil(normalizedDelayMs / 1_000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1_000)}s). ${errorToMessage(error)}`,
		);
	}
	return normalizedDelayMs;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(createAbortError());
	}

	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = (): void => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(createAbortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isAbortError(
	error: unknown,
	signal: AbortSignal | undefined,
): boolean {
	return (
		signal?.aborted === true ||
		error instanceof APIUserAbortError ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function createAbortError(): Error {
	const error = new Error("The model request was aborted");
	error.name = "AbortError";
	return error;
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

function errorToMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}
