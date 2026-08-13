import OpenAI, {
	APIConnectionError,
	APIError,
	APIUserAbortError,
} from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam,
	ChatCompletionReasoningEffort,
	ChatCompletionTool,
} from "openai/resources/chat/completions/completions.js";
import { z } from "zod";
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "./event-stream.ts";
import type {
	ModelProvider,
	ProviderRetryConfig,
	StreamOptions,
} from "./provider_protocol.ts";
import type {
	AssistantContent,
	AssistantMessage,
	Message,
  ModelContext,
	ReasoningLevel,
	StopReason,
	ToolCall,
	ToolDefinition,
	Usage,
} from "./types.ts";

export type OpenAIThinkingFormat = "openai" | "openrouter" | "deepseek" | "zai";

export type ThinkingLevelMap = Partial<
	Readonly<Record<ReasoningLevel, string | null>>
>;

export interface OpenAICompatibleCompat {
	readonly thinkingFormat?: OpenAIThinkingFormat;
	readonly supportsReasoningEffort?: boolean;
	readonly thinkingLevelMap?: ThinkingLevelMap;
}

export interface OpenAICompatibleConfig {
	readonly providerId: string;
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly compat?: OpenAICompatibleCompat;
	readonly retry?: ProviderRetryConfig;
}

type SuccessfulStopReason = Extract<
	StopReason,
	"stop" | "length" | "tool_call"
>;

type CompatibleDelta = ChatCompletionChunk.Choice.Delta & {
	reasoning_content?: unknown;
	reasoning?: unknown;
	reasoning_text?: unknown;
};

interface NormalizedFinishReason {
	stopReason: StopReason;
	errorMessage?: string;
}

interface StreamingToolCall {
	contentIndex: number;
	toolCall: ToolCall;
	argumentFragments: string;
}

const EMPTY_USAGE: Usage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

/**
 * A Chat Completions adapter for OpenAI and OpenAI-compatible endpoints.
 */
export class OpenAICompatibleProvider implements ModelProvider {
	readonly providerId: string;

	private readonly client: OpenAI;
	private readonly compat: OpenAICompatibleCompat;
	private readonly retry: ProviderRetryConfig;

	constructor(config: OpenAICompatibleConfig) {
		this.providerId = config.providerId;
		this.compat = config.compat ?? {};
		this.retry = { ...config.retry };
		this.client = new OpenAI({
			apiKey: config.apiKey ?? "not-needed",
			baseURL: config.baseUrl,
			defaultHeaders: config.headers,
		});
	}

	streamResponse(
		model: string,
		context: ModelContext,
		options?: StreamOptions,
	): AssistantMessageEventStream {
		const eventStream = createAssistantMessageEventStream();
		void this.consumeResponse(eventStream, model, context, options);
		return eventStream;
	}

	private async consumeResponse(
		eventStream: AssistantMessageEventStream,
		model: string,
		context: ModelContext,
		options?: StreamOptions,
	): Promise<void> {
		const content: AssistantContent[] = [];
		const output = this.createMessage(model, content);
		let textContentIndex: number | undefined;
		let thinkingContentIndex: number | undefined;
		let finishReason: NormalizedFinishReason | undefined;
		const toolCallsByStreamIndex = new Map<number, StreamingToolCall>();

		try {
			const request = this.buildRequest(model, context, options);
			const chunks = await retryProviderRequest(
				() =>
					this.client.chat.completions.create(request, {
						...(options?.signal ? { signal: options.signal } : {}),
						...(options?.timeout !== undefined
							? { timeout: options.timeout }
							: {}),
						maxRetries: 0,
					}),
				this.retry,
				options?.signal,
			);

			// Failed attempts remain private to the provider. Consumers see a normal
			// assistant stream only after a request has been established.
			eventStream.push({
				type: "start",
				partial: cloneAssistantMessage(output),
			});

			for await (const chunk of chunks) {
				this.captureMetadata(output, chunk);

				const choice = chunk.choices.find((candidate) => candidate.index === 0);
				if (!choice) {
					continue;
				}

				if (choice.finish_reason !== null) {
					finishReason = normalizeFinishReason(choice.finish_reason);
				}

				const textDelta = choice.delta.content;
				if (typeof textDelta === "string" && textDelta.length > 0) {
					if (textContentIndex === undefined) {
						textContentIndex = content.length;
						content.push({ type: "text", text: "" });
						eventStream.push({
							type: "text_start",
							contentIndex: textContentIndex,
							partial: cloneAssistantMessage(output),
						});
					}

					const textContent = content[textContentIndex];
					if (textContent?.type !== "text") {
						throw new Error("Invalid text streaming state");
					}
					textContent.text += textDelta;
					eventStream.push({
						type: "text_delta",
						contentIndex: textContentIndex,
						delta: textDelta,
						partial: cloneAssistantMessage(output),
					});
				}

				const reasoningDelta = getReasoningDelta(choice.delta);
				if (reasoningDelta) {
					if (thinkingContentIndex === undefined) {
						thinkingContentIndex = content.length;
						content.push({ type: "thinking", thinking: "" });
						eventStream.push({
							type: "thinking_start",
							contentIndex: thinkingContentIndex,
							partial: cloneAssistantMessage(output),
						});
					}

					const thinkingContent = content[thinkingContentIndex];
					if (thinkingContent?.type !== "thinking") {
						throw new Error("Invalid reasoning streaming state");
					}
					thinkingContent.thinking += reasoningDelta;
					eventStream.push({
						type: "thinking_delta",
						contentIndex: thinkingContentIndex,
						delta: reasoningDelta,
						partial: cloneAssistantMessage(output),
					});
				}

				for (const toolCallDelta of choice.delta.tool_calls ?? []) {
					let streamingToolCall = toolCallsByStreamIndex.get(
						toolCallDelta.index,
					);
					if (!streamingToolCall) {
						const toolCall: ToolCall = {
							type: "tool_call",
							id: toolCallDelta.id ?? "",
							name: toolCallDelta.function?.name ?? "",
							arguments: {},
						};
						streamingToolCall = {
							contentIndex: content.length,
							toolCall,
							argumentFragments: "",
						};
						toolCallsByStreamIndex.set(toolCallDelta.index, streamingToolCall);
						content.push(toolCall);
						eventStream.push({
							type: "toolcall_start",
							contentIndex: streamingToolCall.contentIndex,
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							partial: cloneAssistantMessage(output),
						});
					}

					if (toolCallDelta.id) {
						streamingToolCall.toolCall.id = toolCallDelta.id;
					}
					if (toolCallDelta.function?.name) {
						streamingToolCall.toolCall.name = toolCallDelta.function.name;
					}

					const argumentsDelta = toolCallDelta.function?.arguments;
					if (argumentsDelta) {
						streamingToolCall.argumentFragments += argumentsDelta;
						eventStream.push({
							type: "toolcall_delta",
							contentIndex: streamingToolCall.contentIndex,
							toolCallId: streamingToolCall.toolCall.id,
							argumentsDelta,
							partial: cloneAssistantMessage(output),
						});
					}
				}
			}

			if (options?.signal?.aborted) {
				throw new APIUserAbortError();
			}

			if (!finishReason) {
				throw new Error("The provider stream ended without a finish reason");
			}

			this.finishContent(
				eventStream,
				output,
				textContentIndex,
				thinkingContentIndex,
				toolCallsByStreamIndex,
			);

			if (
				finishReason.stopReason === "error" ||
				finishReason.stopReason === "aborted"
			) {
				eventStream.push({
					type: "error",
					message: {
						...output,
						stopReason: finishReason.stopReason,
						errorMessage:
							finishReason.errorMessage ?? "The provider returned an error",
					},
				});
				return;
			}

			output.stopReason = finishReason.stopReason;
			eventStream.push({
				type: "done",
				message: output as AssistantMessage & {
					stopReason: SuccessfulStopReason;
					errorMessage?: never;
				},
			});
		} catch (error) {
			const aborted = isAbortError(error, options?.signal);
			const errorMessage = aborted
				? "The model request was aborted"
				: errorToMessage(error);
			eventStream.push({
				type: "error",
				message: {
					...output,
					stopReason: aborted ? "aborted" : "error",
					errorMessage,
				},
			});
		}
	}

	private createMessage(
		model: string,
		content: AssistantContent[],
	): AssistantMessage {
		return {
			role: "assistant",
			content,
			provider: this.providerId,
			model,
			usage: { ...EMPTY_USAGE },
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	private buildRequest(
		model: string,
		context: ModelContext,
		options?: StreamOptions,
	): ChatCompletionCreateParamsStreaming {
		const request: ChatCompletionCreateParamsStreaming = {
			model,
			stream: true,
			stream_options: { include_usage: true },
			messages: convertMessages(context),
			...(context.tools && context.tools.length > 0
				? { tools: convertTools(context.tools) }
				: {}),
		};

		this.applyReasoningOptions(request, options?.reasoning);
		return request;
	}

	private applyReasoningOptions(
		request: ChatCompletionCreateParamsStreaming,
		reasoning: ReasoningLevel | undefined,
	): void {
		if (reasoning === undefined) {
			return;
		}

		const format = this.compat.thinkingFormat ?? "openai";
		const mappedReasoning = mapReasoningLevel(
			reasoning,
			this.compat.thinkingLevelMap,
		);

		switch (format) {
			case "openrouter": {
				const openRouterEffort =
					reasoning === "off" &&
					!Object.hasOwn(this.compat.thinkingLevelMap ?? {}, "off")
						? "none"
						: mappedReasoning;
				if (openRouterEffort !== null) {
					Object.assign(request, {
						reasoning: { effort: openRouterEffort },
					});
				}
				break;
			}
			case "deepseek":
				Object.assign(request, {
					thinking: { type: reasoning === "off" ? "disabled" : "enabled" },
				});
				if (
					reasoning !== "off" &&
					this.compat.supportsReasoningEffort !== false &&
					mappedReasoning !== null
				) {
					request.reasoning_effort =
						mappedReasoning as ChatCompletionReasoningEffort;
				}
				break;
			case "zai":
				Object.assign(request, { enable_thinking: reasoning !== "off" });
				break;
			case "openai":
				if (
					this.compat.supportsReasoningEffort !== false &&
					mappedReasoning !== null
				) {
					request.reasoning_effort =
						mappedReasoning as ChatCompletionReasoningEffort;
				}
				break;
		}
	}

	private captureMetadata(
		output: AssistantMessage,
		chunk: ChatCompletionChunk,
	): void {
		if (!output.responseId && chunk.id) {
			output.responseId = chunk.id;
		}
		if (chunk.usage) {
			output.usage = convertUsage(chunk.usage);
		}
	}

	private finishContent(
		eventStream: AssistantMessageEventStream,
		output: AssistantMessage,
		textContentIndex: number | undefined,
		thinkingContentIndex: number | undefined,
		toolCallsByStreamIndex: ReadonlyMap<number, StreamingToolCall>,
	): void {
		const { content } = output;
		const toolCallsByContentIndex = new Map(
			[...toolCallsByStreamIndex.values()].map((toolCall) => [
				toolCall.contentIndex,
				toolCall,
			]),
		);

		for (
			let contentIndex = 0;
			contentIndex < content.length;
			contentIndex += 1
		) {
			const block = content[contentIndex];
			if (contentIndex === textContentIndex) {
				if (block?.type !== "text") {
					throw new Error("Invalid text streaming state");
				}
				eventStream.push({
					type: "text_end",
					contentIndex,
					content: block,
					partial: cloneAssistantMessage(output),
				});
				continue;
			}

			if (contentIndex === thinkingContentIndex) {
				if (block?.type !== "thinking") {
					throw new Error("Invalid reasoning streaming state");
				}
				eventStream.push({
					type: "thinking_end",
					contentIndex,
					content: block,
					partial: cloneAssistantMessage(output),
				});
				continue;
			}

			const streamingToolCall = toolCallsByContentIndex.get(contentIndex);
			if (streamingToolCall) {
				streamingToolCall.toolCall.arguments = parseToolArguments(
					streamingToolCall.argumentFragments,
					streamingToolCall.toolCall,
				);
				eventStream.push({
					type: "toolcall_end",
					contentIndex,
					toolCall: streamingToolCall.toolCall,
					partial: cloneAssistantMessage(output),
				});
			}
		}
	}
}

function convertMessages(context: ModelContext): ChatCompletionMessageParam[] {
	const messages: ChatCompletionMessageParam[] = [];
	if (context.systemPrompt !== undefined) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	for (let index = 0; index < context.messages.length; index += 1) {
		const message = context.messages[index];
		if (!message) {
			continue;
		}

		switch (message.role) {
			case "user": {
				const content: ChatCompletionContentPart[] = message.content.map(
					(part): ChatCompletionContentPart => {
						if (part.type === "text") {
							return { type: "text", text: part.text };
						}
						return {
							type: "image_url",
							image_url: {
								url: `data:${part.mimeType};base64,${part.data}`,
							},
						};
					},
				);
				if (content.length > 0) {
					messages.push({ role: "user", content });
				}
				break;
			}
			case "assistant": {
				const text = message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
				const toolCalls = message.content
					.filter((part) => part.type === "tool_call")
					.map((toolCall) => ({
						id: toolCall.id,
						type: "function" as const,
						function: {
							name: toolCall.name,
							arguments: JSON.stringify(toolCall.arguments),
						},
					}));
				if (text.length === 0 && toolCalls.length === 0) {
					break;
				}
				const assistantMessage: ChatCompletionAssistantMessageParam = {
					role: "assistant",
					content: text.length > 0 ? text : null,
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				};
				messages.push(assistantMessage);
				break;
			}
			case "tool_result": {
				const toolResultMessages: Message[] = [];
				let nextIndex = index;
				while (
					nextIndex < context.messages.length &&
					context.messages[nextIndex]?.role === "tool_result"
				) {
					const toolResult = context.messages[nextIndex];
					if (toolResult) {
						toolResultMessages.push(toolResult);
					}
					nextIndex += 1;
				}

				const images: ChatCompletionContentPart[] = [];
				for (const toolResult of toolResultMessages) {
					if (toolResult.role !== "tool_result") {
						continue;
					}
					const text = toolResult.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
					const resultImages = toolResult.content.filter(
						(part) => part.type === "image",
					);
					messages.push({
						role: "tool",
						tool_call_id: toolResult.toolCallId,
						content:
							text.length > 0
								? text
								: resultImages.length > 0
									? "(see attached image)"
									: "",
					});
					images.push(
						...resultImages.map(
							(image): ChatCompletionContentPart => ({
								type: "image_url",
								image_url: {
									url: `data:${image.mimeType};base64,${image.data}`,
								},
							}),
						),
					);
				}

				if (images.length > 0) {
					messages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: "Attached image(s) from tool result:",
							},
							...images,
						],
					});
				}
				index = nextIndex - 1;
				break;
			}
		}
	}

	return messages;
}

function convertTools(tools: readonly ToolDefinition[]): ChatCompletionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: z.toJSONSchema(tool.inputSchema, {
				target: "draft-07",
				io: "input",
			}),
		},
	}));
}

function getReasoningDelta(delta: CompatibleDelta): string | undefined {
	for (const field of [
		"reasoning_content",
		"reasoning",
		"reasoning_text",
	] as const) {
		const value = delta[field];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

function mapReasoningLevel(
	reasoning: ReasoningLevel,
	levelMap: ThinkingLevelMap | undefined,
): string | null {
	if (levelMap && Object.hasOwn(levelMap, reasoning)) {
		return levelMap[reasoning] ?? null;
	}
	return reasoning === "off" ? null : reasoning;
}

function convertUsage(
	rawUsage: NonNullable<ChatCompletionChunk["usage"]>,
): Usage {
	const cacheReadTokens =
		rawUsage.prompt_tokens_details?.cached_tokens ??
		getNumber(rawUsage, "prompt_cache_hit_tokens") ??
		0;
	const cacheWriteTokens =
		rawUsage.prompt_tokens_details?.cache_write_tokens ??
		getNumber(rawUsage, "cache_write_tokens") ??
		0;
	const inputTokens = Math.max(
		0,
		rawUsage.prompt_tokens - cacheReadTokens - cacheWriteTokens,
	);
	const outputTokens = rawUsage.completion_tokens;

	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens:
			typeof rawUsage.total_tokens === "number"
				? rawUsage.total_tokens
				: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
	};
}

function getNumber(value: object, key: string): number | undefined {
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "number" ? candidate : undefined;
}

function normalizeFinishReason(reason: string): NormalizedFinishReason {
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
		case "max_tokens":
		case "max_completion_tokens":
			return { stopReason: "length" };
		case "function_call":
		case "tool_call":
		case "tool_calls":
		case "tool_use":
			return { stopReason: "tool_call" };
		case "cancelled":
		case "canceled":
		case "aborted":
			return {
				stopReason: "aborted",
				errorMessage: `Provider finish reason: ${reason}`,
			};
		case "content_filter":
		case "error":
		case "network_error":
			return {
				stopReason: "error",
				errorMessage: `Provider finish reason: ${reason}`,
			};
		default:
			return {
				stopReason: "error",
				errorMessage: `Unknown provider finish reason: ${reason}`,
			};
	}
}

function parseToolArguments(
	argumentFragments: string,
	toolCall: Pick<ToolCall, "id" | "name">,
): Record<string, unknown> {
	if (argumentFragments.length === 0) {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(argumentFragments);
	} catch (error) {
		throw new Error(
			`Invalid JSON arguments for tool call ${toolCall.name || toolCall.id}: ${errorToMessage(error)}`,
			{ cause: error },
		);
	}

	if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
		throw new Error(
			`Tool call ${toolCall.name || toolCall.id} arguments must be a JSON object`,
		);
	}
	return parsed as Record<string, unknown>;
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

function createAbortError(): Error {
	const error = new Error("The model request was aborted");
	error.name = "AbortError";
	return error;
}

function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map((part) => {
			if (part.type === "tool_call") {
				return {
					...part,
					arguments: structuredClone(part.arguments),
				};
			}
			return { ...part };
		}),
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
