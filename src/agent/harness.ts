import { EventStream } from "../ai/event-stream.ts";
import type {
	AssistantMessage,
	ReasoningLevel,
	ToolResultMessage,
	UserMessage,
} from "../ai/types.ts";
import { isReasoningLevel } from "../ai/types.ts";
import {
	prepareModelContext,
	runAgentLoop,
	runAgentLoopContinue,
} from "./agent_loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentEventListener,
	AgentHarnessConfig,
	AgentHarnessStreamOptions,
	AgentLoopConfig,
	AgentMessage,
	AgentRunStream,
	AgentTool,
	AgentToolCall,
	QueuedMessages,
	QueueMode,
} from "./types.ts";

interface ActiveRun {
	readonly controller: AbortController;
	readonly stream: AgentRunStream;
}

type RunInvocation =
	| {
			readonly kind: "prompt";
			readonly prompts: readonly AgentMessage[];
			readonly skipInitialSteeringPoll: boolean;
	  }
	| { readonly kind: "continue" };

/**
 * Stateful, reusable agent runtime independent of coding-app and UI policy.
 */
export class AgentHarness {
	private readonly provider: AgentHarnessConfig["provider"];
	private readonly model: string;
	private currentSystemPrompt: string;
	private readonly tools: AgentTool[];
	private readonly messageConverter: AgentHarnessConfig["messageConverter"];
	private streamOptions: AgentHarnessStreamOptions;
	private readonly maxTurns: number | undefined;
	private readonly steeringMode: QueueMode;
	private readonly followUpMode: QueueMode;
	private transcript: AgentMessage[];
	private readonly steeringQueue: AgentMessage[] = [];
	private readonly followUpQueue: AgentMessage[] = [];
	private readonly listeners = new Set<AgentEventListener>();
	private activeRun: ActiveRun | undefined;
	private idleBarrier: Promise<void> = Promise.resolve();
	private resolveIdle: (() => void) | undefined;

	constructor(
		config: AgentHarnessConfig,
		messages: readonly AgentMessage[] = [],
	) {
		validateHarnessConfig(config);
		this.provider = config.provider;
		this.model = config.model;
		this.currentSystemPrompt = config.systemPrompt;
		this.tools = [...(config.tools ?? [])];
		this.messageConverter = config.messageConverter;
		this.streamOptions = { ...(config.streamOptions ?? {}) };
		this.maxTurns = config.maxTurns;
		this.steeringMode = config.steeringMode ?? "one_at_a_time";
		this.followUpMode = config.followUpMode ?? "one_at_a_time";
		this.transcript = [...messages];
	}

	/** A shallow transcript snapshot. Message objects retain their identity. */
	get messages(): readonly AgentMessage[] {
		return [...this.transcript];
	}

	get isRunning(): boolean {
		return this.activeRun !== undefined;
	}

	get systemPrompt(): string {
		return this.currentSystemPrompt;
	}

	get queuedMessages(): QueuedMessages {
		return queueSnapshot(this.steeringQueue, this.followUpQueue);
	}

	get pendingMessageCount(): number {
		return this.steeringQueue.length + this.followUpQueue.length;
	}

	/** Prepares the same converted context used by the next provider request. */
	prepareContext(): Promise<import("../ai/types.ts").ModelContext> {
		return prepareModelContext({
			systemPrompt: this.currentSystemPrompt,
			messages: [...this.transcript],
			tools: [...this.tools],
			...(this.messageConverter
				? { messageConverter: this.messageConverter }
				: {}),
		});
	}

	prompt(
		input: string | AgentMessage | readonly AgentMessage[],
	): AgentRunStream {
		this.ensureIdle();
		this.repairInterruptedToolCalls();
		const prompts = normalizePrompts(input);
		if (prompts.length === 0) {
			throw new Error("AgentHarness.prompt requires at least one message");
		}

		return this.startRun({
			kind: "prompt",
			prompts,
			skipInitialSteeringPoll: false,
		});
	}

	continue(): AgentRunStream {
		this.ensureIdle();
		this.repairInterruptedToolCalls();

		const tail = this.transcript.at(-1);
		if (!tail) {
			throw new Error("Cannot continue: no messages in transcript");
		}

		if (isUserMessage(tail) || isToolResultMessage(tail)) {
			return this.startRun({ kind: "continue" });
		}

		if (isAssistantMessage(tail)) {
			const steering = this.drainQueue(this.steeringQueue, this.steeringMode);
			if (steering.length > 0) {
				return this.startRun({
					kind: "prompt",
					prompts: steering,
					skipInitialSteeringPoll: true,
				});
			}

			const followUps = this.drainQueue(this.followUpQueue, this.followUpMode);
			if (followUps.length > 0) {
				return this.startRun({
					kind: "prompt",
					prompts: followUps,
					skipInitialSteeringPoll: false,
				});
			}

			throw new Error(
				"Cannot continue from an assistant message without queued messages",
			);
		}

		throw new Error(`Cannot continue from message role: ${messageRole(tail)}`);
	}

	subscribe(listener: AgentEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Best-effort, idempotent cancellation of the active run. */
	abort(): void {
		this.activeRun?.controller.abort();
	}

	/** Resolves whenever the run active at call time has fully settled. */
	waitForIdle(): Promise<void> {
		return this.idleBarrier;
	}

	steer(text: string): QueuedMessages;
	steer(message: AgentMessage): QueuedMessages;
	steer(input: string | AgentMessage): QueuedMessages {
		this.steeringQueue.push(normalizeQueuedMessage(input));
		return this.queuedMessages;
	}

	followUp(text: string): QueuedMessages;
	followUp(message: AgentMessage): QueuedMessages;
	followUp(input: string | AgentMessage): QueuedMessages {
		this.followUpQueue.push(normalizeQueuedMessage(input));
		return this.queuedMessages;
	}

	clearSteeringQueue(): QueuedMessages {
		const removed = queueSnapshot(this.steeringQueue, []);
		this.steeringQueue.length = 0;
		return removed;
	}

	clearFollowUpQueue(): QueuedMessages {
		const removed = queueSnapshot([], this.followUpQueue);
		this.followUpQueue.length = 0;
		return removed;
	}

	clearQueues(): QueuedMessages {
		const removed = this.queuedMessages;
		this.steeringQueue.length = 0;
		this.followUpQueue.length = 0;
		return removed;
	}

	appendMessage(message: AgentMessage): void {
		this.ensureIdle("append messages");
		this.transcript.push(message);
	}

	replaceMessages(messages: readonly AgentMessage[]): void {
		this.ensureIdle("replace messages");
		this.transcript = [...messages];
	}

	replaceSystemPrompt(systemPrompt: string): void {
		this.ensureIdle("replace the system prompt");
		this.currentSystemPrompt = systemPrompt;
	}

	setReasoning(reasoning: ReasoningLevel): void {
		this.ensureIdle("change reasoning effort");
		if (!isReasoningLevel(reasoning)) {
			throw new Error(`Invalid reasoning level: ${String(reasoning)}`);
		}
		this.streamOptions = { ...this.streamOptions, reasoning };
	}

	/**
	 * Repairs only an incomplete assistant tool-call batch at the transcript
	 * tail. Any gap followed by unrelated history is rejected as malformed.
	 */
	repairInterruptedToolCalls(): readonly ToolResultMessage[] {
		this.ensureIdle("repair interrupted tool calls");
		let pending:
			| {
					readonly calls: readonly AgentToolCall[];
					nextResultIndex: number;
			  }
			| undefined;

		for (let index = 0; index < this.transcript.length; index += 1) {
			const message = this.transcript[index] as AgentMessage;

			if (pending) {
				if (!isToolResultMessage(message)) {
					throw malformedTranscript(
						`incomplete tool-call batch is followed by message ${index + 1}`,
					);
				}

				const expected = pending.calls[pending.nextResultIndex];
				if (
					!expected ||
					message.toolCallId !== expected.id ||
					message.toolName !== expected.name
				) {
					throw malformedTranscript(
						`unexpected tool result ${message.toolCallId} at message ${index + 1}`,
					);
				}

				pending.nextResultIndex += 1;
				if (pending.nextResultIndex === pending.calls.length) {
					pending = undefined;
				}
				continue;
			}

			if (isToolResultMessage(message)) {
				throw malformedTranscript(
					`orphaned tool result ${message.toolCallId} at message ${index + 1}`,
				);
			}

			if (!isAssistantMessage(message)) {
				continue;
			}

			const calls = message.content.filter(
				(content): content is AgentToolCall => content.type === "tool_call",
			);
			if (calls.length === 0) {
				continue;
			}

			const callIds = new Set<string>();
			for (const call of calls) {
				if (callIds.has(call.id)) {
					throw malformedTranscript(`duplicate tool call id ${call.id}`);
				}
				callIds.add(call.id);
			}
			pending = { calls, nextResultIndex: 0 };
		}

		if (!pending) {
			return [];
		}

		const repairs = pending.calls
			.slice(pending.nextResultIndex)
			.map(createInterruptedToolResult);
		this.transcript.push(...repairs);
		return repairs;
	}

	private startRun(invocation: RunInvocation): AgentRunStream {
		const controller = new AbortController();
		const stream: AgentRunStream = new EventStream<AgentEvent, AgentMessage[]>(
			() => false,
			terminalEventResultUnavailable,
		);
		this.idleBarrier = new Promise<void>((resolve) => {
			this.resolveIdle = resolve;
		});
		this.activeRun = { controller, stream };

		const context: AgentContext = {
			systemPrompt: this.currentSystemPrompt,
			messages: [...this.transcript],
			tools: [...this.tools],
			...(this.messageConverter
				? { messageConverter: this.messageConverter }
				: {}),
		};
		void this.runInBackground(invocation, context, controller, stream);
		return stream;
	}

	private async runInBackground(
		invocation: RunInvocation,
		context: AgentContext,
		controller: AbortController,
		stream: AgentRunStream,
	): Promise<void> {
		let result: AgentMessage[] | undefined;
		let failure: unknown;
		let didFail = false;

		try {
			const config = this.createLoopConfig(
				invocation.kind === "prompt" && invocation.skipInitialSteeringPoll,
			);
			const emit = (event: AgentEvent) => this.reduceAndForward(event, stream);
			result =
				invocation.kind === "prompt"
					? await runAgentLoop(
							invocation.prompts,
							context,
							config,
							emit,
							controller.signal,
						)
					: await runAgentLoopContinue(
							context,
							config,
							emit,
							controller.signal,
						);
		} catch (error) {
			didFail = true;
			failure = error;
		} finally {
			if (this.activeRun?.controller === controller) {
				this.activeRun = undefined;
			}
			const resolveIdle = this.resolveIdle;
			this.resolveIdle = undefined;
			resolveIdle?.();
		}

		if (didFail) {
			stream.fail(failure);
		} else {
			stream.end([...(result ?? [])]);
		}
	}

	private createLoopConfig(skipInitialSteeringPoll: boolean): AgentLoopConfig {
		let skipNextSteeringDrain = skipInitialSteeringPoll;
		return {
			provider: this.provider,
			model: this.model,
			streamOptions: { ...this.streamOptions },
			...(this.maxTurns === undefined ? {} : { maxTurns: this.maxTurns }),
			getSteeringMessages: () => {
				if (skipNextSteeringDrain) {
					skipNextSteeringDrain = false;
					return [];
				}
				return this.drainQueue(this.steeringQueue, this.steeringMode);
			},
			getFollowUpMessages: () =>
				this.drainQueue(this.followUpQueue, this.followUpMode),
		};
	}

	private async reduceAndForward(
		event: AgentEvent,
		stream: AgentRunStream,
	): Promise<void> {
		if (event.type === "message_end") {
			this.transcript.push(event.message);
		}

		for (const listener of [...this.listeners]) {
			await listener(event);
		}
		stream.push(event);
	}

	private drainQueue(queue: AgentMessage[], mode: QueueMode): AgentMessage[] {
		if (mode === "all") {
			return queue.splice(0);
		}
		const message = queue.shift();
		return message ? [message] : [];
	}

	private ensureIdle(action = "start another run"): void {
		if (this.activeRun) {
			throw new Error(
				`AgentHarness is already running; cannot ${action}. Use steer() or followUp() to queue messages.`,
			);
		}
	}
}

function validateHarnessConfig(config: AgentHarnessConfig): void {
	if (!config.provider) {
		throw new Error("AgentHarness requires a model provider");
	}
	if (config.model.trim().length === 0) {
		throw new Error("AgentHarness requires a model name");
	}
	if (
		config.maxTurns !== undefined &&
		(!Number.isInteger(config.maxTurns) || config.maxTurns < 1)
	) {
		throw new Error("maxTurns must be a positive integer");
	}

	if (
		config.steeringMode !== undefined &&
		config.steeringMode !== "one_at_a_time" &&
		config.steeringMode !== "all"
	) {
		throw new Error(`Invalid steeringMode: ${String(config.steeringMode)}`);
	}
	if (
		config.followUpMode !== undefined &&
		config.followUpMode !== "one_at_a_time" &&
		config.followUpMode !== "all"
	) {
		throw new Error(`Invalid followUpMode: ${String(config.followUpMode)}`);
	}

	const names = new Set<string>();
	for (const tool of config.tools ?? []) {
		if (names.has(tool.name)) {
			throw new Error(`Duplicate agent tool name: ${tool.name}`);
		}
		names.add(tool.name);
	}
}

function normalizePrompts(
	input: string | AgentMessage | readonly AgentMessage[],
): AgentMessage[] {
	if (typeof input === "string") {
		return [createUserMessage(input)];
	}
	if (Array.isArray(input)) {
		return [...input];
	}
	return [input as AgentMessage];
}

function normalizeQueuedMessage(input: string | AgentMessage): AgentMessage {
	return typeof input === "string" ? createUserMessage(input) : input;
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function createInterruptedToolResult(call: AgentToolCall): ToolResultMessage {
	return {
		role: "tool_result",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: "Tool call interrupted by user" }],
		isError: true,
		timestamp: Date.now(),
	};
}

function queueSnapshot(
	steering: readonly AgentMessage[],
	followUp: readonly AgentMessage[],
): QueuedMessages {
	const steeringSnapshot = [...steering];
	const followUpSnapshot = [...followUp];
	return {
		steering: steeringSnapshot,
		followUp: followUpSnapshot,
		count: steeringSnapshot.length + followUpSnapshot.length,
	};
}

function isAssistantMessage(
	message: AgentMessage,
): message is AssistantMessage {
	return messageRole(message) === "assistant";
}

function isUserMessage(message: AgentMessage): message is UserMessage {
	return messageRole(message) === "user";
}

function isToolResultMessage(
	message: AgentMessage,
): message is ToolResultMessage {
	return messageRole(message) === "tool_result";
}

function messageRole(message: AgentMessage): string {
	if (typeof message === "object" && message !== null && "role" in message) {
		return String(message.role);
	}
	return "unknown";
}

function malformedTranscript(detail: string): Error {
	return new Error(`Cannot repair malformed transcript: ${detail}`);
}

function terminalEventResultUnavailable(): AgentMessage[] {
	throw new Error("Agent run streams settle only after the run becomes idle");
}
