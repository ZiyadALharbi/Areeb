import { z } from "zod";
import type { AgentMessage } from "../agent/types.ts";
import type {
	ProviderContextProjection,
	ProviderProjectedMessage,
} from "../ai/provider_protocol.ts";
import type {
	AssistantMessage,
	Message,
	ModelContext,
	ToolDefinition,
} from "../ai/types.ts";

export const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;
export const FALLBACK_IMAGE_TOKENS = 1_024;

export type ContextWindowSource = "live" | "configured" | "fallback";

export interface FullEstimateBreakdown {
	readonly mode: "full-estimate";
	readonly systemTokens: number;
	readonly messageTokens: number;
	readonly toolTokens: number;
	readonly imageTokens: number;
	readonly messageCount: number;
	readonly toolCount: number;
}

export interface ProviderAnchorBreakdown {
	readonly mode: "provider-anchor";
	readonly providerTokens: number;
	readonly trailingTokens: number;
	readonly imageTokens: number;
	readonly trailingMessageCount: number;
}

export type ContextUsageBreakdown =
	| FullEstimateBreakdown
	| ProviderAnchorBreakdown;

export interface ContextUsageEstimate {
	/** Changes whenever the immutable snapshot is replaced. */
	readonly revision: number;
	readonly requestShapeRevision: number;
	readonly usedTokens: number;
	readonly windowTokens: number;
	readonly percent: number;
	readonly mode: ContextUsageBreakdown["mode"];
	readonly usesProviderUsage: boolean;
	readonly breakdown: ContextUsageBreakdown;
	readonly contextWindowSource: ContextWindowSource;
	readonly discoveryError?: string;
	/** Catalog metadata only; it does not reduce windowTokens. */
	readonly effectiveContextWindowPercent?: number;
}

export interface ContextUsageInput {
	readonly context: ModelContext;
	readonly projection: ProviderContextProjection;
	readonly providerId: string;
	readonly model: string;
	readonly requestShapeRevision: number;
	readonly revision: number;
	readonly windowTokens: number;
	readonly contextWindowSource: ContextWindowSource;
	readonly discoveryError?: string;
	readonly effectiveContextWindowPercent?: number;
	readonly allowProviderAnchor?: boolean;
	readonly getMessageRevision?: (
		message: Message,
		index: number,
	) => number | undefined;
}

export function estimateTextTokens(text: string): number {
	return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/** Estimate the provider-visible input context for the next request. */
export function estimateContextUsage(
	input: ContextUsageInput,
): ContextUsageEstimate {
	assertPositiveFinite(input.windowTokens, "context window");
	const anchor =
		input.allowProviderAnchor === false ? undefined : findProviderAnchor(input);
	const breakdown = anchor
		? estimateFromProviderAnchor(input, anchor)
		: estimateFullContext(input.projection);
	const usedTokens =
		breakdown.mode === "provider-anchor"
			? breakdown.providerTokens + breakdown.trailingTokens
			: breakdown.systemTokens + breakdown.messageTokens + breakdown.toolTokens;

	return Object.freeze({
		revision: input.revision,
		requestShapeRevision: input.requestShapeRevision,
		usedTokens,
		windowTokens: input.windowTokens,
		percent: Math.round((usedTokens / input.windowTokens) * 100),
		mode: breakdown.mode,
		usesProviderUsage: breakdown.mode === "provider-anchor",
		breakdown: Object.freeze(breakdown),
		contextWindowSource: input.contextWindowSource,
		...(input.discoveryError === undefined
			? {}
			: { discoveryError: input.discoveryError }),
		...(input.effectiveContextWindowPercent === undefined
			? {}
			: {
					effectiveContextWindowPercent: input.effectiveContextWindowPercent,
				}),
	});
}

/** Generic projection for providers without adapter-specific replay policy. */
export function projectModelContext(
	context: ModelContext,
): ProviderContextProjection {
	return Object.freeze({
		systemPrompt: context.systemPrompt ?? "",
		messages: Object.freeze(
			context.messages.map((message, sourceIndex) =>
				projectGenericMessage(message, sourceIndex),
			),
		),
		tools: Object.freeze((context.tools ?? []).map(projectGenericTool)),
	});
}

export function formatContextUsageCompact(
	usage: Pick<ContextUsageEstimate, "usedTokens" | "windowTokens" | "percent">,
): string {
	return `~${formatCompactTokenCount(usage.usedTokens)} / ${formatCompactTokenCount(usage.windowTokens)} (${usage.percent}%)`;
}

function estimateFullContext(
	projection: ProviderContextProjection,
): FullEstimateBreakdown {
	const messageEstimate = estimateProjectedMessages(projection.messages);
	const toolTokens = projection.tools.reduce<number>(
		(total, tool) => total + estimateSerializedTokens(tool) + 16,
		0,
	);
	return {
		mode: "full-estimate",
		systemTokens: estimateTextTokens(projection.systemPrompt),
		messageTokens: messageEstimate.tokens,
		toolTokens,
		imageTokens: messageEstimate.imageTokens,
		messageCount: projection.messages.length,
		toolCount: projection.tools.length,
	};
}

function estimateFromProviderAnchor(
	input: ContextUsageInput,
	anchor: { readonly index: number; readonly message: AssistantMessage },
): ProviderAnchorBreakdown {
	const trailing = input.projection.messages.filter(
		(message) => message.sourceIndex > anchor.index,
	);
	const estimate = estimateProjectedMessages(trailing);
	return {
		mode: "provider-anchor",
		providerTokens: Math.ceil(anchor.message.usage.totalTokens),
		trailingTokens: estimate.tokens,
		imageTokens: estimate.imageTokens,
		trailingMessageCount: trailing.length,
	};
}

function estimateProjectedMessages(
	messages: readonly ProviderProjectedMessage[],
): { readonly tokens: number; readonly imageTokens: number } {
	let tokens = 0;
	let imageTokens = 0;
	for (const message of messages) {
		const estimatedImages =
			Math.max(0, Math.floor(message.imageCount ?? 0)) * FALLBACK_IMAGE_TOKENS;
		imageTokens += estimatedImages;
		tokens += estimateSerializedTokens(message.value) + 4 + estimatedImages;
	}
	return { tokens, imageTokens };
}

function findProviderAnchor(
	input: ContextUsageInput,
): { readonly index: number; readonly message: AssistantMessage } | undefined {
	for (let index = input.context.messages.length - 1; index >= 0; index -= 1) {
		const message = input.context.messages[index];
		if (
			message?.role !== "assistant" ||
			message.provider !== input.providerId ||
			message.model !== input.model ||
			(message.stopReason !== "stop" &&
				message.stopReason !== "length" &&
				message.stopReason !== "tool_call") ||
			!Number.isFinite(message.usage.totalTokens) ||
			message.usage.totalTokens <= 0 ||
			input.getMessageRevision?.(message, index) !==
				input.requestShapeRevision ||
			hasNewerPrecedingMessage(input.context.messages, index, message.timestamp)
		) {
			continue;
		}
		return { index, message };
	}
	return undefined;
}

function hasNewerPrecedingMessage(
	messages: readonly Message[],
	anchorIndex: number,
	anchorTimestamp: number,
): boolean {
	for (let index = 0; index < anchorIndex; index += 1) {
		const timestamp = messages[index]?.timestamp;
		if (typeof timestamp === "number" && timestamp > anchorTimestamp) {
			return true;
		}
	}
	return false;
}

function projectGenericMessage(
	message: Message,
	sourceIndex: number,
): ProviderProjectedMessage {
	let imageCount = 0;
	const content = message.content.map((part) => {
		if (part.type !== "image") {
			return part;
		}
		imageCount += 1;
		return { type: "image", mimeType: part.mimeType, data: "[image]" };
	});
	const value =
		message.role === "assistant"
			? { role: message.role, content }
			: message.role === "tool_result"
				? {
						role: message.role,
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						content,
					}
				: { role: message.role, content };
	return {
		sourceIndex,
		value,
		...(imageCount === 0 ? {} : { imageCount }),
	};
}

function projectGenericTool(tool: ToolDefinition): unknown {
	let parameters: unknown;
	try {
		parameters = z.toJSONSchema(tool.inputSchema, {
			target: "draft-07",
			io: "input",
		});
	} catch (error) {
		parameters = { error: safeErrorMessage(error) };
	}
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: parameters,
	};
}

function estimateSerializedTokens(value: unknown): number {
	return estimateTextTokens(safeSerialize(value));
}

function safeSerialize(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(value, (_key, candidate: unknown) => {
				if (typeof candidate === "bigint") {
					return candidate.toString();
				}
				if (typeof candidate === "number" && !Number.isFinite(candidate)) {
					return String(candidate);
				}
				if (typeof candidate === "object" && candidate !== null) {
					if (seen.has(candidate)) {
						return "[Circular]";
					}
					seen.add(candidate);
				}
				return candidate;
			}) ?? String(value)
		);
	} catch {
		return String(value);
	}
}

function formatCompactTokenCount(value: number): string {
	if (value < 1_000) {
		return String(value);
	}
	const thousands = value / 1_000;
	const precision = thousands >= 100 ? 0 : 1;
	return `${thousands.toFixed(precision).replace(/\.0$/, "")}k`;
}

function assertPositiveFinite(value: number, label: string): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be finite and greater than zero`);
	}
}

function safeErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isModelMessage(message: AgentMessage): message is Message {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		(message.role === "user" ||
			message.role === "assistant" ||
			message.role === "tool_result")
	);
}
