import type { AssistantMessageEvent } from "../ai/events.ts";
import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "../ai/types.ts";
import type {
	AgentContext,
	AgentEndReason,
	AgentEventSink,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
} from "./types.ts";

export type { AgentEventSink } from "./types.ts";

/**
 * Starts a pure agent run with new prompt messages.
 *
 * The caller's context is never mutated. The returned array contains only
 * messages produced by this invocation, including the supplied prompts.
 */
export async function runAgentLoop(
	prompts: readonly AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<AgentMessage[]> {
	validateInvocation(context, config);

	const newMessages: AgentMessage[] = [...prompts];
	const workingContext = createWorkingContext(context, prompts);
	const runSignal = signal ?? config.streamOptions?.signal;

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	await emitMessages(prompts, emit);

	return runLoop(workingContext, newMessages, config, emit, runSignal);
}

/**
 * Continues from an existing context without re-emitting historical messages.
 */
export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<AgentMessage[]> {
	validateInvocation(context, config);
	validateContinuation(context.messages);

	const newMessages: AgentMessage[] = [];
	const workingContext = createWorkingContext(context, []);
	const runSignal = signal ?? config.streamOptions?.signal;

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	return runLoop(workingContext, newMessages, config, emit, runSignal);
}

async function runLoop(
	context: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<AgentMessage[]> {
	let providerTurns = 0;
	let firstTurnStarted = true;
	let pendingMessages = await drainMessages(config.getSteeringMessages);

	while (true) {
		if (hasReachedMaxTurns(providerTurns, config.maxTurns)) {
			// Queue-drain callbacks have already removed these messages. Preserve
			// them in the working result even though no provider turn can start.
			await injectMessages(pendingMessages, context, newMessages, emit);
			return endRun("max_turns", newMessages, emit);
		}

		if (!firstTurnStarted) {
			await emit({ type: "turn_start" });
		} else {
			firstTurnStarted = false;
		}
		await injectMessages(pendingMessages, context, newMessages, emit);
		pendingMessages = [];

		providerTurns += 1;
		const assistantMessage = await streamAssistantResponse(
			context,
			config,
			emit,
			signal,
		);
		context.messages.push(assistantMessage);
		newMessages.push(assistantMessage);

		if (
			assistantMessage.stopReason === "error" ||
			assistantMessage.stopReason === "aborted"
		) {
			await emit({
				type: "turn_end",
				message: assistantMessage,
				toolResults: [],
			});
			return endRun(
				assistantMessage.stopReason === "aborted"
					? "aborted"
					: "provider_error",
				newMessages,
				emit,
			);
		}

		const toolCalls = assistantMessage.content.filter(
			(content): content is AgentToolCall => content.type === "tool_call",
		);
		const toolResults =
			assistantMessage.stopReason === "length"
				? await failTruncatedToolCalls(toolCalls, emit)
				: await executeToolCalls(toolCalls, context.tools, signal, emit);
		for (const toolResult of toolResults) {
			context.messages.push(toolResult);
			newMessages.push(toolResult);
		}

		await emit({
			type: "turn_end",
			message: assistantMessage,
			toolResults,
		});

		if (signal?.aborted) {
			return endRun("aborted", newMessages, emit);
		}

		const steeringMessages = await drainMessages(config.getSteeringMessages);
		if (steeringMessages.length > 0) {
			pendingMessages = steeringMessages;
			continue;
		}

		if (toolCalls.length > 0) {
			continue;
		}

		const followUpMessages = await drainMessages(config.getFollowUpMessages);
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}

		return endRun("completed", newMessages, emit);
	}
}

async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
	let response: ReturnType<AgentLoopConfig["provider"]["streamResponse"]>;
	let partial: AssistantMessage | undefined;
	let emittedMessageStart = false;

	try {
		const messages = context.messageConverter
			? await context.messageConverter([...context.messages])
			: context.messages.filter(isModelMessage);
		response = config.provider.streamResponse(
			config.model,
			{
				systemPrompt: context.systemPrompt,
				messages: [...messages],
				tools: [...context.tools],
			},
			{
				...config.streamOptions,
				...(signal ? { signal } : {}),
			},
		);
	} catch (error) {
		return emitProviderFailure(
			config,
			error,
			partial,
			emittedMessageStart,
			emit,
			signal,
		);
	}

	const iterator = response[Symbol.asyncIterator]();
	while (true) {
		let nextEvent: IteratorResult<AssistantMessageEvent>;
		try {
			nextEvent = await iterator.next();
		} catch (error) {
			return emitProviderFailure(
				config,
				error,
				partial,
				emittedMessageStart,
				emit,
				signal,
			);
		}

		if (nextEvent.done) {
			return emitProviderFailure(
				config,
				new Error("The provider stream ended without a terminal event"),
				partial,
				emittedMessageStart,
				emit,
				signal,
			);
		}

		const event = nextEvent.value;
		switch (event.type) {
			case "start":
				partial = event.partial;
				if (!emittedMessageStart) {
					await emit({ type: "message_start", message: event.partial });
					emittedMessageStart = true;
				}
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				partial = event.partial;
				if (!emittedMessageStart) {
					await emit({ type: "message_start", message: event.partial });
					emittedMessageStart = true;
				}
				await emit({
					type: "message_update",
					message: event.partial,
					assistantMessageEvent: event,
				});
				break;

			case "done":
			case "error":
				if (!emittedMessageStart) {
					await emit({ type: "message_start", message: event.message });
				}
				await emit({ type: "message_end", message: event.message });
				return event.message;
		}
	}
}

async function emitProviderFailure(
	config: AgentLoopConfig,
	error: unknown,
	partial: AssistantMessage | undefined,
	emittedMessageStart: boolean,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
	const aborted = isAbortError(error, signal);
	const message: AssistantMessage = partial
		? {
				...partial,
				content: cloneAssistantContent(partial.content),
				usage: { ...partial.usage },
				stopReason: aborted ? "aborted" : "error",
				errorMessage: aborted
					? "The model request was aborted"
					: errorToMessage(error),
			}
		: {
				role: "assistant",
				content: [],
				provider: config.provider.providerId,
				model: config.model,
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 0,
				},
				stopReason: aborted ? "aborted" : "error",
				errorMessage: aborted
					? "The model request was aborted"
					: errorToMessage(error),
				timestamp: Date.now(),
			};

	if (!emittedMessageStart) {
		await emit({ type: "message_start", message });
	}
	await emit({ type: "message_end", message });
	return message;
}

async function executeToolCalls(
	toolCalls: readonly AgentToolCall[],
	tools: readonly AgentTool[],
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({ type: "tool_execution_start", toolCall });
		const result = signal?.aborted
			? failedToolResult("Tool call interrupted by user")
			: await executeToolCall(
					toolCall,
					toolsByName.get(toolCall.name),
					signal,
					emit,
				);
		const message = await emitToolResult(toolCall, result, emit);
		messages.push(message);
	}

	return messages;
}

async function failTruncatedToolCalls(
	toolCalls: readonly AgentToolCall[],
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({ type: "tool_execution_start", toolCall });
		const message = await emitToolResult(
			toolCall,
			failedToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			emit,
		);
		messages.push(message);
	}
	return messages;
}

async function emitToolResult(
	toolCall: AgentToolCall,
	result: AgentToolResult,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	const message: ToolResultMessage = {
		role: "tool_result",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		...(result.details !== undefined ? { details: result.details } : {}),
		isError: result.isError ?? false,
		timestamp: Date.now(),
	};

	await emit({ type: "tool_execution_end", toolCall, result: message });
	await emit({ type: "message_start", message });
	await emit({ type: "message_end", message });
	return message;
}

async function executeToolCall(
	toolCall: AgentToolCall,
	tool: AgentTool | undefined,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<AgentToolResult> {
	if (!tool) {
		return failedToolResult(`Unknown tool: ${toolCall.name}`);
	}

	let parsedArguments: unknown;
	try {
		const parsed = await tool.inputSchema.safeParseAsync(toolCall.arguments);
		if (!parsed.success) {
			return failedToolResult(
				`Invalid arguments for tool ${toolCall.name}: ${parsed.error.message}`,
			);
		}
		parsedArguments = parsed.data;
	} catch (error) {
		return failedToolResult(
			`Invalid arguments for tool ${toolCall.name}: ${errorToMessage(error)}`,
		);
	}

	const updateEmissions: Promise<void>[] = [];
	let acceptingUpdates = true;
	let result: AgentToolResult;
	try {
		result = await tool.execute(parsedArguments, signal, (update) => {
			if (!acceptingUpdates) {
				return;
			}
			const emission = Promise.resolve().then(() =>
				emit({
					type: "tool_execution_update",
					toolCall,
					update,
				}),
			);
			updateEmissions.push(emission);
			return emission;
		});
	} catch (error) {
		result = failedToolResult(errorToMessage(error));
	} finally {
		acceptingUpdates = false;
	}

	await Promise.all(updateEmissions);
	return result;
}

function failedToolResult(message: string): AgentToolResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}

async function drainMessages(
	drain: AgentLoopConfig["getSteeringMessages"],
): Promise<AgentMessage[]> {
	return drain ? [...(await drain())] : [];
}

async function injectMessages(
	messages: readonly AgentMessage[],
	context: AgentContext,
	newMessages: AgentMessage[],
	emit: AgentEventSink,
): Promise<void> {
	await emitMessages(messages, emit);
	context.messages.push(...messages);
	newMessages.push(...messages);
}

async function emitMessages(
	messages: readonly AgentMessage[],
	emit: AgentEventSink,
): Promise<void> {
	for (const message of messages) {
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}
}

async function endRun(
	reason: AgentEndReason,
	newMessages: AgentMessage[],
	emit: AgentEventSink,
): Promise<AgentMessage[]> {
	const result = [...newMessages];
	await emit({ type: "agent_end", messages: result, reason });
	return result;
}

function createWorkingContext(
	context: AgentContext,
	prompts: readonly AgentMessage[],
): AgentContext {
	return {
		...context,
		messages: [...context.messages, ...prompts],
		tools: [...context.tools],
	};
}

function validateInvocation(
	context: AgentContext,
	config: AgentLoopConfig,
): void {
	if (!config.provider) {
		throw new Error("Agent loop requires a model provider");
	}
	if (config.model.trim().length === 0) {
		throw new Error("Agent loop requires a model name");
	}
	if (
		config.maxTurns !== undefined &&
		(!Number.isInteger(config.maxTurns) || config.maxTurns < 1)
	) {
		throw new Error("maxTurns must be a positive integer");
	}

	const names = new Set<string>();
	for (const tool of context.tools) {
		if (names.has(tool.name)) {
			throw new Error(`Duplicate agent tool name: ${tool.name}`);
		}
		names.add(tool.name);
	}
}

function validateContinuation(messages: readonly AgentMessage[]): void {
	const lastMessage = messages.at(-1);
	if (!lastMessage) {
		throw new Error("Cannot continue: no messages in context");
	}
	if (isModelMessage(lastMessage) && lastMessage.role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}
}

function hasReachedMaxTurns(
	providerTurns: number,
	maxTurns: number | undefined,
): boolean {
	return maxTurns !== undefined && providerTurns >= maxTurns;
}

function isModelMessage(message: AgentMessage): message is Message {
	if (typeof message !== "object" || message === null || !("role" in message)) {
		return false;
	}
	return (
		message.role === "user" ||
		message.role === "assistant" ||
		message.role === "tool_result"
	);
}

function cloneAssistantContent(
	content: AssistantMessage["content"],
): AssistantMessage["content"] {
	return content.map((part) =>
		part.type === "tool_call"
			? { ...part, arguments: structuredClone(part.arguments) }
			: { ...part },
	);
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	return (
		signal?.aborted === true ||
		(error instanceof Error && error.name === "AbortError")
	);
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
