import Anthropic, {
	APIConnectionError,
	APIError,
	APIUserAbortError,
} from "@anthropic-ai/sdk";
import type {
	BetaBase64ImageSource,
	BetaContentBlockParam,
	BetaMessageDeltaUsage,
	BetaMessageParam,
	BetaRawContentBlockDeltaEvent,
	BetaRawContentBlockStartEvent,
	BetaRefusalStopDetails,
	BetaStopReason,
	BetaTool,
	BetaToolResultBlockParam,
	BetaUsage,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages";
import { z } from "zod";
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "./event-stream.ts";
import type {
	DiscoveredModel,
	ModelProvider,
	ProviderContextProjection,
	ProviderRetryConfig,
	StreamOptions,
} from "./provider_protocol.ts";
import type {
	AssistantContent,
	AssistantMessage,
	ImageContent,
	Message,
	ModelContext,
	StopReason,
	ThinkingContent,
	ToolCall,
	ToolDefinition,
	Usage,
} from "./types.ts";

export interface AnthropicMessagesConfig {
	readonly providerId: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly retry?: ProviderRetryConfig;
	readonly fetch?: typeof globalThis.fetch;
}

interface StreamingBlock {
	readonly contentIndex: number;
	readonly kind: "text" | "thinking" | "tool";
	argumentsText?: string;
	ended: boolean;
}

interface AnthropicProjectedMessage {
	readonly sourceIndex: number;
	readonly value: {
		readonly role: "user" | "assistant";
		readonly content: BetaContentBlockParam[];
	};
}

/** Room for long tool inputs and thinking; streaming avoids HTTP timeouts. */
const DEFAULT_MAX_TOKENS = 64_000;

/** Models whose policy declines the API can re-run on a recommended model. */
const REFUSAL_FALLBACK_MODELS = new Set([
	"claude-fable-5-1",
	"claude-opus-5",
	"claude-opus-5-5",
	"claude-sonnet-5-5",
]);

const EMPTY_USAGE: Usage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

/** Messages API adapter for the Anthropic API-key provider. */
export class AnthropicMessagesProvider implements ModelProvider {
	readonly providerId: string;

	private readonly client: Anthropic;
	private readonly retry: ProviderRetryConfig;

	constructor(config: AnthropicMessagesConfig) {
		this.providerId = config.providerId;
		this.retry = { ...config.retry };
		this.client = new Anthropic({
			apiKey: config.apiKey,
			baseURL: config.baseUrl.replace(/\/+$/, ""),
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
			messages: convertProjectedMessages(context.messages, this.providerId).map(
				(message) => {
					const elided = elideImagePayloads(message.value);
					return {
						sourceIndex: message.sourceIndex,
						value: elided.value,
						...(elided.imageCount === 0
							? {}
							: { imageCount: elided.imageCount }),
					};
				},
			),
			tools: convertTools(context.tools ?? []),
		};
	}

	async discoverModels(
		signal?: AbortSignal,
	): Promise<readonly DiscoveredModel[]> {
		const models: DiscoveredModel[] = [];
		for await (const model of this.client.models.list({}, { signal })) {
			models.push({
				model: model.id,
				...(isPositiveFinite(model.max_input_tokens)
					? { contextWindowTokens: model.max_input_tokens }
					: {}),
			});
		}
		return models;
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
		const blocks = new Map<number, StreamingBlock>();
		let stopReason: BetaStopReason | null = null;
		let stopDetails: BetaRefusalStopDetails | null = null;
		let fallbackBoundary: number | undefined;
		let terminal = false;

		try {
			const request = buildRequest(model, context, this.providerId, options);
			// The beta endpoint is the stable Messages API plus opt-in betas; it is
			// required for server-side refusal fallback.
			const events = await retryProviderRequest(
				async () =>
					await this.client.beta.messages.create(request, {
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
				switch (event.type) {
					case "message_start":
						output.responseId = event.message.id;
						// Names the fallback model when a refusal was rerouted before
						// output or a sticky fallback serves this conversation.
						output.model = event.message.model;
						output.usage = convertUsage(event.message.usage);
						break;
					case "content_block_start":
						if (event.content_block.type === "fallback") {
							closeDeclinedBlocks(stream, output, blocks);
							fallbackBoundary = output.content.length;
							output.model = event.content_block.to.model;
						} else {
							startBlock(stream, output, blocks, event);
						}
						break;
					case "content_block_delta":
						applyDelta(stream, output, blocks.get(event.index), event.delta);
						break;
					case "content_block_stop": {
						const block = blocks.get(event.index);
						if (block !== undefined) {
							finishBlock(stream, output, block);
						}
						break;
					}
					case "message_delta":
						stopReason = event.delta.stop_reason;
						stopDetails = event.delta.stop_details;
						output.usage = mergeUsage(output.usage, event.usage);
						break;
					case "message_stop": {
						for (const block of blocks.values()) {
							finishBlock(stream, output, block);
						}
						if (fallbackBoundary !== undefined) {
							// Only text from a declined attempt carries over; its thinking
							// and tool calls must not be replayed or executed.
							output.content = [
								...output.content
									.slice(0, fallbackBoundary)
									.filter((part) => part.type === "text"),
								...output.content.slice(fallbackBoundary),
							];
						}
						const finish = normalizeStop(
							stopReason,
							stopDetails,
							output.content,
						);
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
				}
			}
			throw new Error("Anthropic stream ended without a message_stop event");
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
	providerId: string,
	options?: StreamOptions,
): MessageCreateParamsStreaming {
	const reasoning = options?.reasoning;
	return {
		model,
		max_tokens: DEFAULT_MAX_TOKENS,
		stream: true,
		// Caches the longest stable prefix: tools, system prompt, and history.
		cache_control: { type: "ephemeral" },
		...(context.systemPrompt ? { system: context.systemPrompt } : {}),
		messages: convertMessages(context.messages, providerId),
		...(context.tools && context.tools.length > 0
			? { tools: convertTools(context.tools) }
			: {}),
		...(REFUSAL_FALLBACK_MODELS.has(model)
			? {
					betas: ["server-side-fallback-2026-07-01"],
					fallbacks: "default" as const,
				}
			: {}),
		// Current Claude models reject disabled thinking, so "off" lowers effort
		// and leaves thinking at the model default.
		...(reasoning === "off"
			? { output_config: { effort: "low" as const } }
			: {
					thinking: {
						type: "adaptive" as const,
						display: "summarized" as const,
					},
					...(reasoning === undefined
						? {}
						: { output_config: { effort: reasoning } }),
				}),
	};
}

/** Merge per-source messages so parallel tool results share one user turn. */
function convertMessages(
	messages: readonly Message[],
	providerId: string,
): BetaMessageParam[] {
	const params: BetaMessageParam[] = [];
	for (const { value } of convertProjectedMessages(messages, providerId)) {
		const previous = params.at(-1);
		if (previous?.role === value.role && Array.isArray(previous.content)) {
			previous.content.push(...value.content);
		} else {
			params.push({ role: value.role, content: [...value.content] });
		}
	}
	return params;
}

function convertProjectedMessages(
	messages: readonly Message[],
	providerId: string,
): AnthropicProjectedMessage[] {
	const projected: AnthropicProjectedMessage[] = [];
	for (const [sourceIndex, message] of messages.entries()) {
		switch (message.role) {
			case "user": {
				const content = message.content.flatMap(
					(part): BetaContentBlockParam[] =>
						part.type === "text"
							? part.text
								? [{ type: "text", text: part.text }]
								: []
							: [convertImage(part)],
				);
				if (content.length > 0) {
					projected.push({ sourceIndex, value: { role: "user", content } });
				}
				break;
			}
			case "assistant": {
				// Failed turns never received tool results, and thinking signatures
				// only verify on the provider that produced them.
				const failed =
					message.stopReason === "error" || message.stopReason === "aborted";
				const replayThinking = !failed && message.provider === providerId;
				const content = message.content.flatMap(
					(part): BetaContentBlockParam[] => {
						if (part.type === "text") {
							return part.text ? [{ type: "text", text: part.text }] : [];
						}
						if (part.type === "thinking") {
							const replay = replayThinking
								? parseThinkingReplay(part)
								: undefined;
							return replay === undefined ? [] : [replay];
						}
						return failed
							? []
							: [
									{
										type: "tool_use",
										id: toToolUseId(part.id),
										name: part.name,
										input: part.arguments,
									},
								];
					},
				);
				if (content.length > 0) {
					projected.push({
						sourceIndex,
						value: { role: "assistant", content },
					});
				}
				break;
			}
			case "tool_result": {
				const resultContent = message.content.flatMap(
					(
						part,
					): NonNullable<
						Exclude<BetaToolResultBlockParam["content"], string>
					> =>
						part.type === "text"
							? part.text
								? [{ type: "text", text: part.text }]
								: []
							: [convertImage(part)],
				);
				projected.push({
					sourceIndex,
					value: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: toToolUseId(message.toolCallId),
								...(resultContent.length === 0
									? {}
									: { content: resultContent }),
								...(message.isError ? { is_error: true } : {}),
							},
						],
					},
				});
				break;
			}
		}
	}
	return projected;
}

function convertImage(image: ImageContent): BetaContentBlockParam & {
	type: "image";
} {
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: image.mimeType as BetaBase64ImageSource["media_type"],
			data: image.data,
		},
	};
}

function convertTools(tools: readonly ToolDefinition[]): BetaTool[] {
	return tools.map((tool) => {
		const schema: Record<string, unknown> = z.toJSONSchema(tool.inputSchema, {
			target: "draft-2020-12",
			io: "input",
		});
		delete schema.$schema;
		return {
			name: tool.name,
			description: tool.description,
			input_schema: schema as BetaTool.InputSchema,
			// Stream large tool inputs as generated; the agent loop validates
			// arguments against the tool schema before running the tool.
			eager_input_streaming: true,
		};
	});
}

/** Tool IDs from other providers may contain characters Anthropic rejects. */
function toToolUseId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function startBlock(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	blocks: Map<number, StreamingBlock>,
	event: BetaRawContentBlockStartEvent,
): void {
	const block = event.content_block;
	const contentIndex = output.content.length;
	switch (block.type) {
		case "text":
			output.content.push({ type: "text", text: "" });
			blocks.set(event.index, { contentIndex, kind: "text", ended: false });
			stream.push({
				type: "text_start",
				contentIndex,
				partial: cloneMessage(output),
			});
			return;
		case "thinking":
		case "redacted_thinking":
			output.content.push({
				type: "thinking",
				thinking: "",
				...(block.type === "redacted_thinking"
					? {
							signature: JSON.stringify({
								type: "redacted_thinking",
								data: block.data,
							}),
						}
					: {}),
			});
			blocks.set(event.index, { contentIndex, kind: "thinking", ended: false });
			stream.push({
				type: "thinking_start",
				contentIndex,
				partial: cloneMessage(output),
			});
			return;
		case "tool_use": {
			const toolCall: ToolCall = {
				type: "tool_call",
				id: block.id,
				name: block.name,
				arguments: {},
			};
			output.content.push(toolCall);
			blocks.set(event.index, {
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
			return;
		}
		default:
			return;
	}
}

function applyDelta(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	block: StreamingBlock | undefined,
	delta: BetaRawContentBlockDeltaEvent["delta"],
): void {
	if (block === undefined) {
		return;
	}
	const part = output.content[block.contentIndex];
	switch (delta.type) {
		case "text_delta":
			if (block.kind !== "text" || part?.type !== "text" || !delta.text) {
				return;
			}
			part.text += delta.text;
			stream.push({
				type: "text_delta",
				contentIndex: block.contentIndex,
				delta: delta.text,
				partial: cloneMessage(output),
			});
			return;
		case "thinking_delta":
			if (
				block.kind !== "thinking" ||
				part?.type !== "thinking" ||
				!delta.thinking
			) {
				return;
			}
			part.thinking += delta.thinking;
			stream.push({
				type: "thinking_delta",
				contentIndex: block.contentIndex,
				delta: delta.thinking,
				partial: cloneMessage(output),
			});
			return;
		case "signature_delta":
			if (part?.type === "thinking") {
				part.signature = JSON.stringify({
					type: "thinking",
					signature: delta.signature,
				});
			}
			return;
		case "input_json_delta":
			if (
				block.kind !== "tool" ||
				part?.type !== "tool_call" ||
				!delta.partial_json
			) {
				return;
			}
			block.argumentsText = (block.argumentsText ?? "") + delta.partial_json;
			stream.push({
				type: "toolcall_delta",
				contentIndex: block.contentIndex,
				toolCallId: part.id,
				argumentsDelta: delta.partial_json,
				partial: cloneMessage(output),
			});
			return;
		default:
			return;
	}
}

function finishBlock(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	block: StreamingBlock,
): void {
	if (block.ended) {
		return;
	}
	block.ended = true;
	const part = output.content[block.contentIndex];
	if (block.kind === "text") {
		if (part?.type !== "text") {
			throw new Error("Invalid Anthropic text streaming state");
		}
		stream.push({
			type: "text_end",
			contentIndex: block.contentIndex,
			content: { ...part },
			partial: cloneMessage(output),
		});
		return;
	}
	if (block.kind === "thinking") {
		if (part?.type !== "thinking") {
			throw new Error("Invalid Anthropic thinking streaming state");
		}
		stream.push({
			type: "thinking_end",
			contentIndex: block.contentIndex,
			content: { ...part },
			partial: cloneMessage(output),
		});
		return;
	}
	if (part?.type !== "tool_call") {
		throw new Error("Invalid Anthropic tool-call streaming state");
	}
	part.arguments = parseArguments(block.argumentsText ?? "", part);
	stream.push({
		type: "toolcall_end",
		contentIndex: block.contentIndex,
		toolCall: { ...part, arguments: structuredClone(part.arguments) },
		partial: cloneMessage(output),
	});
}

/** End blocks a declined attempt left open; partial tool input is not parsed. */
function closeDeclinedBlocks(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	blocks: ReadonlyMap<number, StreamingBlock>,
): void {
	for (const block of blocks.values()) {
		if (block.kind === "tool") {
			block.ended = true;
		} else {
			finishBlock(stream, output, block);
		}
	}
}

function convertUsage(usage: BetaUsage): Usage {
	return buildUsage(
		usage.input_tokens,
		usage.output_tokens,
		usage.cache_read_input_tokens ?? 0,
		usage.cache_creation_input_tokens ?? 0,
	);
}

/** Apply cumulative `message_delta` counts over the `message_start` counts. */
function mergeUsage(current: Usage, delta: BetaMessageDeltaUsage): Usage {
	return buildUsage(
		delta.input_tokens ?? current.inputTokens,
		delta.output_tokens,
		delta.cache_read_input_tokens ?? current.cacheReadTokens,
		delta.cache_creation_input_tokens ?? current.cacheWriteTokens,
	);
}

function buildUsage(
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens: number,
	cacheWriteTokens: number,
): Usage {
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens:
			inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
	};
}

function normalizeStop(
	stopReason: BetaStopReason | null,
	stopDetails: BetaRefusalStopDetails | null,
	content: readonly AssistantContent[],
): {
	readonly stopReason: Exclude<StopReason, "aborted">;
	readonly errorMessage: string;
} {
	switch (stopReason) {
		case "max_tokens":
		case "model_context_window_exceeded":
			return { stopReason: "length", errorMessage: "" };
		case "refusal": {
			const category = stopDetails?.category;
			const explanation = stopDetails?.explanation;
			const recommended = stopDetails?.recommended_model;
			return {
				stopReason: "error",
				errorMessage: `Claude declined the request${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : ""}${recommended ? `. Try ${recommended}` : ""}`,
			};
		}
		default:
			return content.some((part) => part.type === "tool_call")
				? { stopReason: "tool_call", errorMessage: "" }
				: { stopReason: "stop", errorMessage: "" };
	}
}

function parseThinkingReplay(
	part: ThinkingContent,
): BetaContentBlockParam | undefined {
	if (!part.signature) {
		return undefined;
	}
	try {
		const value: unknown = JSON.parse(part.signature);
		if (typeof value !== "object" || value === null) {
			return undefined;
		}
		const type = Reflect.get(value, "type");
		const signature = Reflect.get(value, "signature");
		const data = Reflect.get(value, "data");
		if (type === "thinking" && typeof signature === "string") {
			return { type: "thinking", thinking: part.thinking, signature };
		}
		if (type === "redacted_thinking" && typeof data === "string") {
			return { type: "redacted_thinking", data };
		}
		return undefined;
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
		const isBase64Source = Reflect.get(candidate, "type") === "base64";
		const copy: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(candidate)) {
			if (isBase64Source && key === "data" && typeof nested === "string") {
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
	// The Anthropic SDK models aborts and connection failures as APIError
	// subclasses without a status, so classify them before status checks.
	if (error instanceof APIUserAbortError) {
		return false;
	}
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
