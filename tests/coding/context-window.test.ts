import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ProviderContextProjection } from "../../src/ai/provider_protocol.ts";
import type {
	AssistantMessage,
	Message,
	ModelContext,
} from "../../src/ai/types.ts";
import {
	estimateContextUsage,
	estimateTextTokens,
	formatContextUsageCompact,
	projectModelContext,
} from "../../src/coding/context-window.ts";

const EMPTY_USAGE = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

function assistant(
	totalTokens: number,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		provider: "fake",
		model: "model-a",
		usage: { ...EMPTY_USAGE, totalTokens },
		stopReason: "stop",
		timestamp: 2,
		...overrides,
	};
}

function estimate(
	context: ModelContext,
	projection: ProviderContextProjection,
	overrides: Partial<Parameters<typeof estimateContextUsage>[0]> = {},
) {
	return estimateContextUsage({
		context,
		projection,
		providerId: "fake",
		model: "model-a",
		requestShapeRevision: 7,
		revision: 11,
		windowTokens: 128_000,
		contextWindowSource: "fallback",
		...overrides,
	});
}

function serializedTokens(value: unknown, overhead: number): number {
	return Math.ceil(JSON.stringify(value).length / 4) + overhead;
}

describe("context-window projection", () => {
	test("projects complete tool schemas and elides binary image payloads", () => {
		const projection = projectModelContext({
			systemPrompt: "System",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Inspect this" },
						{
							type: "image",
							mimeType: "image/png",
							data: "large-base64-payload",
						},
					],
					timestamp: 1,
				},
			],
			tools: [
				{
					name: "lookup",
					description: "Look up a record",
					inputSchema: z.object({
						query: z.string(),
						options: z
							.object({ limit: z.number().int().min(1).max(10) })
							.optional(),
					}),
				},
			],
		});

		expect(projection.systemPrompt).toBe("System");
		expect(projection.messages).toHaveLength(1);
		expect(projection.messages[0]).toMatchObject({
			sourceIndex: 0,
			imageCount: 1,
		});
		expect(JSON.stringify(projection.messages[0]?.value)).toContain("[image]");
		expect(JSON.stringify(projection)).not.toContain("large-base64-payload");
		expect(projection.tools).toEqual([
			{
				name: "lookup",
				description: "Look up a record",
				inputSchema: expect.objectContaining({
					type: "object",
					required: ["query"],
					properties: expect.objectContaining({
						query: { type: "string" },
						options: expect.objectContaining({ type: "object" }),
					}),
				}),
			},
		]);
	});
});

describe("estimateContextUsage", () => {
	test("uses the documented full-estimate formulas for each request source", () => {
		const context: ModelContext = {
			systemPrompt: "12345",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: 1,
				},
			],
		};
		const messageValue = { role: "user", content: "hello" };
		const toolValue = {
			name: "lookup",
			description: "Look up a record",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
			},
		};
		const usage = estimate(
			context,
			{
				systemPrompt: "12345",
				messages: [{ sourceIndex: 0, value: messageValue }],
				tools: [toolValue],
			},
			{
				windowTokens: 100,
				contextWindowSource: "configured",
				discoveryError: "catalog unavailable",
				effectiveContextWindowPercent: 90,
			},
		);
		const systemTokens = 2;
		const messageTokens = serializedTokens(messageValue, 4);
		const toolTokens = serializedTokens(toolValue, 16);

		expect(estimateTextTokens("12345")).toBe(systemTokens);
		expect(usage).toEqual({
			revision: 11,
			requestShapeRevision: 7,
			usedTokens: systemTokens + messageTokens + toolTokens,
			windowTokens: 100,
			percent: Math.round(
				((systemTokens + messageTokens + toolTokens) / 100) * 100,
			),
			mode: "full-estimate",
			usesProviderUsage: false,
			breakdown: {
				mode: "full-estimate",
				systemTokens,
				messageTokens,
				toolTokens,
				imageTokens: 0,
				messageCount: 1,
				toolCount: 1,
			},
			contextWindowSource: "configured",
			discoveryError: "catalog unavailable",
			effectiveContextWindowPercent: 90,
		});
	});

	test("uses the latest valid matching provider anchor and estimates its tail", () => {
		const valid = assistant(1_000, { timestamp: 1 });
		const invalidLatest = assistant(9_999, {
			stopReason: "aborted",
			timestamp: 2,
		});
		const trailingUser: Message = {
			role: "user",
			content: [{ type: "text", text: "continue" }],
			timestamp: 3,
		};
		const context: ModelContext = {
			messages: [valid, invalidLatest, trailingUser],
		};
		const invalidValue = { role: "assistant", content: "partial" };
		const userValue = { role: "user", content: "continue" };
		const usage = estimate(
			context,
			{
				systemPrompt: "",
				messages: [
					{ sourceIndex: 0, value: { role: "assistant", content: "done" } },
					{ sourceIndex: 1, value: invalidValue },
					{ sourceIndex: 2, value: userValue, imageCount: 1 },
				],
				tools: [],
			},
			{
				allowProviderAnchor: true,
				getMessageRevision: (_message, index) => (index < 2 ? 7 : undefined),
				windowTokens: 500,
				contextWindowSource: "live",
			},
		);
		const trailingTokens =
			serializedTokens(invalidValue, 4) +
			serializedTokens(userValue, 4) +
			1_024;

		expect(usage).toMatchObject({
			usedTokens: 1_000 + trailingTokens,
			windowTokens: 500,
			percent: Math.round(((1_000 + trailingTokens) / 500) * 100),
			mode: "provider-anchor",
			usesProviderUsage: true,
			contextWindowSource: "live",
			breakdown: {
				mode: "provider-anchor",
				providerTokens: 1_000,
				trailingTokens,
				imageTokens: 1_024,
				trailingMessageCount: 2,
			},
		});
		expect(usage.percent).toBeGreaterThan(100);
	});

	test("falls back when anchors are stale, mismatched, failed, or disabled", () => {
		const candidates: readonly {
			message: AssistantMessage;
			messageRevision: number;
			allowProviderAnchor?: boolean;
		}[] = [
			{ message: assistant(0), messageRevision: 7 },
			{
				message: assistant(Number.NaN),
				messageRevision: 7,
			},
			{
				message: assistant(100, { stopReason: "error" }),
				messageRevision: 7,
			},
			{
				message: assistant(100, { provider: "other" }),
				messageRevision: 7,
			},
			{
				message: assistant(100, { model: "model-b" }),
				messageRevision: 7,
			},
			{ message: assistant(100), messageRevision: 6 },
			{
				message: assistant(100),
				messageRevision: 7,
				allowProviderAnchor: false,
			},
		];

		for (const candidate of candidates) {
			const usage = estimate(
				{ messages: [candidate.message] },
				{
					systemPrompt: "",
					messages: [
						{
							sourceIndex: 0,
							value: { role: "assistant", content: "answer" },
						},
					],
					tools: [],
				},
				{
					allowProviderAnchor: candidate.allowProviderAnchor ?? true,
					getMessageRevision: () => candidate.messageRevision,
				},
			);

			expect(usage.mode).toBe("full-estimate");
			expect(usage.usesProviderUsage).toBe(false);
		}
	});

	test("safely estimates malformed provider-visible values", () => {
		const cyclic: Record<string, unknown> = { value: "visible" };
		cyclic.self = cyclic;
		const usage = estimate(
			{ messages: [] },
			{
				systemPrompt: "",
				messages: [
					{ sourceIndex: 0, value: cyclic },
					{ sourceIndex: 1, value: { unsupported: 1n } },
				],
				tools: [],
			},
		);

		expect(usage.mode).toBe("full-estimate");
		expect(usage.usedTokens).toBeGreaterThan(0);
		expect(Number.isFinite(usage.usedTokens)).toBe(true);
	});
});

describe("formatContextUsageCompact", () => {
	test("formats the canonical idle footer without clamping utilization", () => {
		expect(
			formatContextUsageCompact({
				usedTokens: 20_000,
				windowTokens: 128_000,
				percent: 16,
			}),
		).toBe("~20k / 128k (16%)");
		expect(
			formatContextUsageCompact({
				usedTokens: 150_000,
				windowTokens: 128_000,
				percent: 117,
			}),
		).toBe("~150k / 128k (117%)");
	});
});
