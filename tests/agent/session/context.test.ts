import { describe, expect, test } from "bun:test";
import { buildSessionContext } from "../../../src/agent/session/context.ts";
import type {
	SessionEntry,
	StorageBranchEntryQuery,
} from "../../../src/agent/session/types.ts";
import type { AgentMessage } from "../../../src/agent/types.ts";

const ROOT_ID = "00000000-0000-4000-8000-000000000001";
const LEAF_ID = "00000000-0000-4000-8000-000000000009";

class ContextStorage {
	lastQuery: StorageBranchEntryQuery | undefined;

	constructor(
		private readonly leafId: string | null,
		private readonly entries: SessionEntry[],
	) {}

	async getLeafId(): Promise<string | null> {
		return this.leafId;
	}

	async findEntriesOnBranch(
		query: StorageBranchEntryQuery,
	): Promise<SessionEntry[]> {
		this.lastQuery = query;
		return this.entries;
	}
}

function userMessage(text: string, timestamp: number): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	};
}

describe("buildSessionContext", () => {
	test("returns defaults without querying a branch for an empty session", async () => {
		const storage = new ContextStorage(null, []);

		expect(await buildSessionContext(storage)).toEqual({
			messages: [],
			model: null,
			reasoning: "high",
			activeToolNames: null,
		});
		expect(storage.lastQuery).toBeUndefined();
	});

	test("requests the active root-to-leaf path and resolves configuration", async () => {
		const storage = new ContextStorage(LEAF_ID, [
			{
				type: "message",
				id: ROOT_ID,
				seq: 1,
				parentId: null,
				timestamp: 100,
				message: userMessage("root", 100),
			},
			{
				type: "model_change",
				id: "00000000-0000-4000-8000-000000000002",
				seq: 2,
				parentId: ROOT_ID,
				timestamp: 200,
				provider: "openai",
				model: "model-a",
			},
			{
				type: "reasoning_change",
				id: "00000000-0000-4000-8000-000000000003",
				seq: 3,
				parentId: "00000000-0000-4000-8000-000000000002",
				timestamp: 300,
				reasoning: "high",
			},
			{
				type: "active_tools_change",
				id: "00000000-0000-4000-8000-000000000004",
				seq: 4,
				parentId: "00000000-0000-4000-8000-000000000003",
				timestamp: 400,
				activeToolNames: ["read", "write"],
			},
			{
				type: "message",
				id: LEAF_ID,
				seq: 5,
				parentId: "00000000-0000-4000-8000-000000000004",
				timestamp: 500,
				message: userMessage("leaf", 500),
			},
		]);

		const context = await buildSessionContext(storage);

		expect(storage.lastQuery).toEqual({
			startId: LEAF_ID,
			order: "oldest_first",
		});
		expect(context).toEqual({
			messages: [userMessage("root", 100), userMessage("leaf", 500)],
			model: { provider: "openai", model: "model-a" },
			reasoning: "high",
			activeToolNames: ["read", "write"],
		});
	});

	test("uses the latest max reasoning change on the selected branch", async () => {
		const firstChangeId = "00000000-0000-4000-8000-000000000002";
		const secondChangeId = "00000000-0000-4000-8000-000000000003";
		const branchEntries: SessionEntry[] = [
			{
				type: "reasoning_change",
				id: ROOT_ID,
				seq: 1,
				parentId: null,
				timestamp: 100,
				reasoning: "low",
			},
			{
				type: "reasoning_change",
				id: firstChangeId,
				seq: 2,
				parentId: ROOT_ID,
				timestamp: 200,
				reasoning: "high",
			},
			{
				type: "reasoning_change",
				id: secondChangeId,
				seq: 3,
				parentId: firstChangeId,
				timestamp: 300,
				reasoning: "max",
			},
		];

		const selected = new ContextStorage(secondChangeId, branchEntries);
		expect((await buildSessionContext(selected)).reasoning).toBe("max");

		const sibling = new ContextStorage(
			firstChangeId,
			branchEntries.slice(0, 2),
		);
		expect((await buildSessionContext(sibling)).reasoning).toBe("high");
	});

	test("uses only the newest compaction and preserves its complete tail", async () => {
		const storage = new ContextStorage(LEAF_ID, [
			{
				type: "message",
				id: ROOT_ID,
				seq: 1,
				parentId: null,
				timestamp: 100,
				message: userMessage("discarded root", 100),
			},
			{
				type: "compaction",
				id: "00000000-0000-4000-8000-000000000002",
				seq: 2,
				parentId: ROOT_ID,
				timestamp: 200,
				summary: "Discarded checkpoint",
				retainedTail: [userMessage("discarded tail", 150)],
				tokensBefore: 500,
			},
			{
				type: "message",
				id: "00000000-0000-4000-8000-000000000003",
				seq: 3,
				parentId: "00000000-0000-4000-8000-000000000002",
				timestamp: 300,
				message: userMessage("also discarded", 300),
			},
			{
				type: "compaction",
				id: "00000000-0000-4000-8000-000000000004",
				seq: 4,
				parentId: "00000000-0000-4000-8000-000000000003",
				timestamp: 400,
				summary: "Current checkpoint",
				retainedTail: [
					userMessage("retained one", 350),
					userMessage("retained two", 375),
				],
				tokensBefore: 1_000,
			},
			{
				type: "message",
				id: LEAF_ID,
				seq: 5,
				parentId: "00000000-0000-4000-8000-000000000004",
				timestamp: 500,
				message: userMessage("after checkpoint", 500),
			},
		]);

		const context = await buildSessionContext(storage);

		expect(context.messages).toEqual([
			{
				role: "session_compaction",
				summary: "Current checkpoint",
				tokensBefore: 1_000,
				timestamp: 400,
			},
			userMessage("retained one", 350),
			userMessage("retained two", 375),
			userMessage("after checkpoint", 500),
		]);
	});

	test("projects branch summaries and registered custom entries", async () => {
		const sourceLeafId = "00000000-0000-4000-8000-000000000099";
		const storage = new ContextStorage(LEAF_ID, [
			{
				type: "custom",
				id: ROOT_ID,
				seq: 1,
				parentId: null,
				timestamp: 100,
				customType: "ignored",
				data: { text: "not projected" },
			},
			{
				type: "branch_summary",
				id: "00000000-0000-4000-8000-000000000002",
				seq: 2,
				parentId: ROOT_ID,
				timestamp: 200,
				sourceLeafId,
				summary: "Abandoned branch",
			},
			{
				type: "custom",
				id: LEAF_ID,
				seq: 3,
				parentId: "00000000-0000-4000-8000-000000000002",
				timestamp: 300,
				customType: "note",
				data: { text: "project me" },
			},
		]);

		const context = await buildSessionContext(storage, {
			customEntryProjectors: {
				note: (entry, index, entries) => {
					expect(index).toBe(2);
					expect(entries).toHaveLength(3);
					return [userMessage(String(entry.data), entry.timestamp)];
				},
			},
		});

		expect(context.messages).toEqual([
			{
				role: "session_branch_summary",
				summary: "Abandoned branch",
				sourceLeafId,
				timestamp: 200,
			},
			userMessage("[object Object]", 300),
		]);
	});
});
