import { describe, expect, test } from "bun:test";
import { SessionError } from "../../../src/agent/session/errors.ts";
import {
	createSessionJsonlHeader,
	decodeSessionJsonlHeader,
	decodeSessionJsonlMutation,
	decodeSessionJsonlRecord,
	encodeSessionJsonlRecord,
	metadataFromSessionJsonlHeader,
} from "../../../src/agent/session/jsonl/codec.ts";
import type { SessionJsonlRecord } from "../../../src/agent/session/jsonl/types.ts";
import type { SessionMetadata } from "../../../src/agent/session/types.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const ENTRY_ID = "00000000-0000-4000-8000-000000000002";
const PARENT_ID = "00000000-0000-4000-8000-000000000003";
const SOURCE_ID = "00000000-0000-4000-8000-000000000004";

const usage = {
	inputTokens: 10,
	outputTokens: 5,
	cacheReadTokens: 2,
	cacheWriteTokens: 1,
	totalTokens: 18,
};

const userMessage = {
	role: "user" as const,
	content: [{ type: "text" as const, text: "hello" }],
	timestamp: 100,
};

function expectSessionError(
	action: () => unknown,
	code: SessionError["code"],
): SessionError {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(SessionError);
	expect((thrown as SessionError).code).toBe(code);
	return thrown as SessionError;
}

describe("session JSONL codec", () => {
	test("round-trips the header and every mutation shape", () => {
		const records: SessionJsonlRecord[] = [
			{
				kind: "header",
				version: 1,
				sessionId: SESSION_ID,
				createdAt: 100,
				cwd: "/workspace",
				parentSessionId: SOURCE_ID,
				metadata: { nested: { value: true } },
			},
			{
				kind: "entry",
				entry: {
					type: "message",
					id: ENTRY_ID,
					seq: 1,
					parentId: null,
					timestamp: 100,
					message: userMessage,
				},
			},
			{
				kind: "entry",
				entry: {
					type: "model_change",
					id: ENTRY_ID,
					seq: 1,
					parentId: PARENT_ID,
					timestamp: 100,
					provider: "openai",
					model: "model-a",
				},
			},
			{
				kind: "entry",
				entry: {
					type: "reasoning_change",
					id: ENTRY_ID,
					seq: 1,
					parentId: PARENT_ID,
					timestamp: 100,
					reasoning: "xhigh",
				},
			},
			{
				kind: "entry",
				entry: {
					type: "active_tools_change",
					id: ENTRY_ID,
					seq: 1,
					parentId: PARENT_ID,
					timestamp: 100,
					activeToolNames: ["read", "write"],
				},
			},
			{
				kind: "entry",
				entry: {
					type: "compaction",
					id: ENTRY_ID,
					seq: 1,
					parentId: PARENT_ID,
					timestamp: 100,
					summary: "Earlier conversation",
					retainedTail: [userMessage],
					tokensBefore: 1_000,
					details: { reason: "limit" },
					usage,
				},
			},
			{
				kind: "entry",
				entry: {
					type: "branch_summary",
					id: ENTRY_ID,
					seq: 1,
					parentId: PARENT_ID,
					timestamp: 100,
					sourceLeafId: SOURCE_ID,
					summary: "Abandoned branch",
					details: { reason: "navigation" },
					usage,
				},
			},
			{
				kind: "entry",
				entry: {
					type: "custom",
					id: ENTRY_ID,
					seq: 1,
					parentId: PARENT_ID,
					timestamp: 100,
					customType: "note",
					data: { text: "remember" },
				},
			},
			{
				kind: "pointer",
				seq: 1,
				timestamp: 100,
				pointer: "main",
				leafId: ENTRY_ID,
			},
			{
				kind: "fact",
				seq: 1,
				timestamp: 100,
				fact: "name",
				value: "Research",
			},
			{
				kind: "fact",
				seq: 1,
				timestamp: 100,
				fact: "label",
				targetId: ENTRY_ID,
				value: "checkpoint",
			},
		];

		for (const record of records) {
			const encoded = encodeSessionJsonlRecord(record);
			expect(encoded.endsWith("\n")).toBeTrue();
			expect(encoded.split("\n")).toHaveLength(2);
			expect(decodeSessionJsonlRecord(encoded)).toEqual(record);
		}
	});

	test("converts metadata to and from a defensive header", () => {
		const metadata: SessionMetadata = {
			id: SESSION_ID,
			createdAt: 100,
			cwd: "/workspace",
			parentSessionId: SOURCE_ID,
			metadata: { nested: { value: 1 } },
		};

		const header = createSessionJsonlHeader(metadata);
		(metadata.metadata?.nested as { value: number }).value = 2;
		expect(header.metadata).toEqual({ nested: { value: 1 } });

		const decoded = metadataFromSessionJsonlHeader(header);
		(header.metadata?.nested as { value: number }).value = 3;
		expect(decoded.metadata).toEqual({ nested: { value: 1 } });
	});

	test("enforces header and mutation positions", () => {
		const header = encodeSessionJsonlRecord({
			kind: "header",
			version: 1,
			sessionId: SESSION_ID,
			createdAt: 100,
			cwd: "/workspace",
		});
		const mutation = encodeSessionJsonlRecord({
			kind: "fact",
			seq: 1,
			timestamp: 100,
			fact: "name",
			value: null,
		});

		expect(decodeSessionJsonlHeader(header).sessionId).toBe(SESSION_ID);
		expect(decodeSessionJsonlMutation(mutation).kind).toBe("fact");
		expectSessionError(
			() => decodeSessionJsonlHeader(mutation),
			"invalid_format",
		);
		expectSessionError(
			() => decodeSessionJsonlMutation(header),
			"invalid_format",
		);
	});

	test("rejects malformed syntax, fields, messages, and non-finite numbers", () => {
		const malformed = [
			"{",
			JSON.stringify({
				kind: "header",
				version: 1,
				sessionId: SESSION_ID,
				createdAt: 100,
				cwd: "/workspace",
				unknown: true,
			}),
			JSON.stringify({
				kind: "entry",
				entry: {
					type: "message",
					id: ENTRY_ID,
					seq: 1,
					parentId: null,
					timestamp: 100,
					message: { role: "user", timestamp: 100 },
				},
			}),
			`{"kind":"entry","entry":{"type":"custom","id":"${ENTRY_ID}","seq":1,"parentId":null,"timestamp":100,"customType":"note","data":1e400}}`,
		];

		for (const line of malformed) {
			expectSessionError(
				() => decodeSessionJsonlRecord(line),
				"invalid_format",
			);
		}
	});

	test("reports unsupported versions and source locations", () => {
		const error = expectSessionError(
			() =>
				decodeSessionJsonlRecord(
					JSON.stringify({
						kind: "header",
						version: 2,
						sessionId: SESSION_ID,
						createdAt: 100,
						cwd: "/workspace",
					}),
					{ path: "/sessions/example.jsonl", line: 1 },
				),
			"unsupported_version",
		);

		expect(error.path).toBe("/sessions/example.jsonl");
		expect(error.line).toBe(1);
	});

	test("rejects non-JSON values before encoding", () => {
		const record = {
			kind: "header",
			version: 1,
			sessionId: SESSION_ID,
			createdAt: 100,
			cwd: "/workspace",
			metadata: { invalid: undefined },
		} as never;

		expectSessionError(
			() => encodeSessionJsonlRecord(record),
			"invalid_payload",
		);
	});
});
