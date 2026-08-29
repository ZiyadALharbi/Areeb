import { describe, expect, test } from "bun:test";
import {
	createBranchSummaryMessage,
	createCompactionMessage,
} from "../../../src/agent/session/messages.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
} from "../../../src/agent/session/types.ts";

describe("session synthetic messages", () => {
	test("creates a compaction message from context-visible fields", () => {
		const entry: CompactionEntry = {
			type: "compaction",
			id: "00000000-0000-4000-8000-000000000001",
			seq: 4,
			parentId: "00000000-0000-4000-8000-000000000000",
			timestamp: 400,
			summary: "Earlier conversation",
			retainedTail: [],
			tokensBefore: 1_000,
			details: { source: "test" },
			usage: {
				inputTokens: 800,
				outputTokens: 200,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 1_000,
			},
		};

		expect(createCompactionMessage(entry)).toEqual({
			role: "session_compaction",
			summary: "Earlier conversation",
			tokensBefore: 1_000,
			timestamp: 400,
		});
	});

	test("creates a branch-summary message from context-visible fields", () => {
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: "00000000-0000-4000-8000-000000000002",
			seq: 5,
			parentId: "00000000-0000-4000-8000-000000000001",
			timestamp: 500,
			sourceLeafId: "00000000-0000-4000-8000-000000000099",
			summary: "Abandoned branch",
			details: { source: "test" },
			usage: {
				inputTokens: 400,
				outputTokens: 100,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 500,
			},
		};

		expect(createBranchSummaryMessage(entry)).toEqual({
			role: "session_branch_summary",
			summary: "Abandoned branch",
			sourceLeafId: "00000000-0000-4000-8000-000000000099",
			timestamp: 500,
		});
	});
});
