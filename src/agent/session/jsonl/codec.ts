import { z } from "zod";
import { REASONING_LEVELS } from "../../../ai/types.ts";
import { SessionError } from "../errors.ts";
import { assertJsonValue } from "../session.ts";
import type { JsonValue, SessionMetadata, SessionMutation } from "../types.ts";
import {
	SESSION_JSONL_VERSION,
	type SessionJsonlHeader,
	type SessionJsonlLocation,
	type SessionJsonlRecord,
} from "./types.ts";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const uuidSchema = z.string().regex(UUID_PATTERN);
const sequenceSchema = z.number().safe().positive();
const timestampSchema = z.number().safe().nonnegative();
const tokenCountSchema = z.number().safe().nonnegative();

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema),
	]),
);

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const textContentSchema = z
	.object({
		type: z.literal("text"),
		text: z.string(),
	})
	.strict();

const thinkingContentSchema = z
	.object({
		type: z.literal("thinking"),
		thinking: z.string(),
		signature: z.string().optional(),
	})
	.strict();

const imageContentSchema = z
	.object({
		type: z.literal("image"),
		data: z.string(),
		mimeType: z.string(),
	})
	.strict();

const toolCallSchema = z
	.object({
		type: z.literal("tool_call"),
		id: z.string(),
		name: z.string(),
		arguments: jsonObjectSchema,
	})
	.strict();

const usageSchema = z
	.object({
		inputTokens: tokenCountSchema,
		outputTokens: tokenCountSchema,
		cacheReadTokens: tokenCountSchema,
		cacheWriteTokens: tokenCountSchema,
		totalTokens: tokenCountSchema,
	})
	.strict();

const userMessageSchema = z
	.object({
		role: z.literal("user"),
		content: z.array(z.union([textContentSchema, imageContentSchema])),
		timestamp: timestampSchema,
	})
	.strict();

const assistantMessageSchema = z
	.object({
		role: z.literal("assistant"),
		content: z.array(
			z.union([textContentSchema, thinkingContentSchema, toolCallSchema]),
		),
		provider: z.string(),
		model: z.string(),
		responseId: z.string().optional(),
		usage: usageSchema,
		stopReason: z.enum(["stop", "length", "tool_call", "error", "aborted"]),
		errorMessage: z.string().optional(),
		timestamp: timestampSchema,
	})
	.strict();

const toolResultMessageSchema = z
	.object({
		role: z.literal("tool_result"),
		toolCallId: z.string(),
		toolName: z.string(),
		content: z.array(z.union([textContentSchema, imageContentSchema])),
		details: jsonValueSchema.optional(),
		isError: z.boolean(),
		timestamp: timestampSchema,
	})
	.strict();

const compactionMessageSchema = z
	.object({
		role: z.literal("session_compaction"),
		summary: z.string(),
		tokensBefore: tokenCountSchema,
		timestamp: timestampSchema,
	})
	.strict();

const branchSummaryMessageSchema = z
	.object({
		role: z.literal("session_branch_summary"),
		summary: z.string(),
		sourceLeafId: uuidSchema,
		timestamp: timestampSchema,
	})
	.strict();

const reservedRoles = new Set([
	"user",
	"assistant",
	"tool_result",
	"session_compaction",
	"session_branch_summary",
]);

const customAgentMessageSchema = z
	.object({
		role: z
			.string()
			.refine(
				(role) => !reservedRoles.has(role),
				"Reserved message roles must use their defined schema",
			),
	})
	.catchall(jsonValueSchema);

const agentMessageSchema = z.union([
	userMessageSchema,
	assistantMessageSchema,
	toolResultMessageSchema,
	compactionMessageSchema,
	branchSummaryMessageSchema,
	customAgentMessageSchema,
]);

const entryBaseSchema = z.object({
	id: uuidSchema,
	seq: sequenceSchema,
	parentId: uuidSchema.nullable(),
	timestamp: timestampSchema,
});

const sessionEntrySchema = z.discriminatedUnion("type", [
	entryBaseSchema
		.extend({
			type: z.literal("message"),
			message: agentMessageSchema,
		})
		.strict(),
	entryBaseSchema
		.extend({
			type: z.literal("model_change"),
			provider: z.string(),
			model: z.string(),
		})
		.strict(),
	entryBaseSchema
		.extend({
			type: z.literal("reasoning_change"),
			reasoning: z.enum(REASONING_LEVELS),
		})
		.strict(),
	entryBaseSchema
		.extend({
			type: z.literal("active_tools_change"),
			activeToolNames: z.array(z.string()),
		})
		.strict(),
	entryBaseSchema
		.extend({
			type: z.literal("compaction"),
			summary: z.string(),
			retainedTail: z.array(agentMessageSchema),
			tokensBefore: tokenCountSchema,
			details: jsonValueSchema.optional(),
			usage: usageSchema.optional(),
		})
		.strict(),
	entryBaseSchema
		.extend({
			type: z.literal("branch_summary"),
			sourceLeafId: uuidSchema,
			summary: z.string(),
			details: jsonValueSchema.optional(),
			usage: usageSchema.optional(),
		})
		.strict(),
	entryBaseSchema
		.extend({
			type: z.literal("custom"),
			customType: z.string(),
			data: jsonValueSchema.optional(),
		})
		.strict(),
]);

const entryMutationSchema = z
	.object({
		kind: z.literal("entry"),
		entry: sessionEntrySchema,
	})
	.strict();

const pointerMutationSchema = z
	.object({
		kind: z.literal("pointer"),
		seq: sequenceSchema,
		timestamp: timestampSchema,
		pointer: z.literal("main"),
		leafId: uuidSchema.nullable(),
	})
	.strict();

const nameFactMutationSchema = z
	.object({
		kind: z.literal("fact"),
		seq: sequenceSchema,
		timestamp: timestampSchema,
		fact: z.literal("name"),
		value: z.string().nullable(),
	})
	.strict();

const labelFactMutationSchema = z
	.object({
		kind: z.literal("fact"),
		seq: sequenceSchema,
		timestamp: timestampSchema,
		fact: z.literal("label"),
		targetId: uuidSchema,
		value: z.string().nullable(),
	})
	.strict();

const mutationSchema = z.union([
	entryMutationSchema,
	pointerMutationSchema,
	nameFactMutationSchema,
	labelFactMutationSchema,
]);

const headerSchema = z
	.object({
		kind: z.literal("header"),
		version: z.literal(SESSION_JSONL_VERSION),
		sessionId: uuidSchema,
		createdAt: timestampSchema,
		cwd: z.string(),
		parentSessionId: uuidSchema.optional(),
		metadata: jsonObjectSchema.optional(),
	})
	.strict();

const recordSchema = z.union([headerSchema, mutationSchema]);

function parseRecordValue(
	value: unknown,
	location: SessionJsonlLocation,
): SessionJsonlRecord {
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Reflect.get(value, "kind") === "header"
	) {
		const version = Reflect.get(value, "version");
		if (
			typeof version === "number" &&
			Number.isSafeInteger(version) &&
			version !== SESSION_JSONL_VERSION
		) {
			throw new SessionError(
				"unsupported_version",
				`Unsupported session JSONL version: ${version}`,
				location,
			);
		}
	}

	const result = recordSchema.safeParse(value);
	if (!result.success) {
		const issue = result.error.issues[0];
		const issuePath =
			issue === undefined || issue.path.length === 0
				? ""
				: ` at ${issue.path.map(String).join(".")}`;

		throw new SessionError(
			"invalid_format",
			`Invalid session JSONL record${issuePath}: ${
				issue?.message ?? "unknown validation error"
			}`,
			{ ...location, cause: result.error },
		);
	}

	return result.data as SessionJsonlRecord;
}

export function createSessionJsonlHeader(
	metadata: SessionMetadata,
): SessionJsonlHeader {
	return {
		kind: "header",
		version: SESSION_JSONL_VERSION,
		sessionId: metadata.id,
		createdAt: metadata.createdAt,
		cwd: metadata.cwd,
		...(metadata.parentSessionId === undefined
			? {}
			: { parentSessionId: metadata.parentSessionId }),
		...(metadata.metadata === undefined
			? {}
			: { metadata: structuredClone(metadata.metadata) }),
	};
}

export function metadataFromSessionJsonlHeader(
	header: SessionJsonlHeader,
): SessionMetadata {
	return {
		id: header.sessionId,
		createdAt: header.createdAt,
		cwd: header.cwd,
		...(header.parentSessionId === undefined
			? {}
			: { parentSessionId: header.parentSessionId }),
		...(header.metadata === undefined
			? {}
			: { metadata: structuredClone(header.metadata) }),
	};
}

export function encodeSessionJsonlRecord(record: SessionJsonlRecord): string {
	assertJsonValue(record, "JSONL record");
	const validated = parseRecordValue(record, {});
	return `${JSON.stringify(validated)}\n`;
}

export function decodeSessionJsonlRecord(
	line: string,
	location: SessionJsonlLocation = {},
): SessionJsonlRecord {
	let value: unknown;

	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new SessionError("invalid_format", "Invalid session JSONL syntax", {
			...location,
			cause: error,
		});
	}

	return parseRecordValue(value, location);
}

export function decodeSessionJsonlHeader(
	line: string,
	location: SessionJsonlLocation = {},
): SessionJsonlHeader {
	const record = decodeSessionJsonlRecord(line, location);

	if (record.kind !== "header") {
		throw new SessionError(
			"invalid_format",
			"Expected a session JSONL header",
			location,
		);
	}

	return record;
}

export function decodeSessionJsonlMutation(
	line: string,
	location: SessionJsonlLocation = {},
): SessionMutation {
	const record = decodeSessionJsonlRecord(line, location);

	if (record.kind === "header") {
		throw new SessionError(
			"invalid_format",
			"Unexpected session JSONL header",
			location,
		);
	}

	return record;
}
