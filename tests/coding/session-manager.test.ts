import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "../../src/agent/types.ts";
import { areebPaths } from "../../src/coding/paths.ts";
import {
	CodingSessionManager,
	findCodingSession,
	listCodingSessions,
} from "../../src/coding/session-manager.ts";

const SESSION_A_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_B_ID = "00000000-0000-4000-8000-000000000002";
const SESSION_C_ID = "00000000-0000-4000-8000-000000000003";

function sequence<T>(values: readonly T[]): () => T {
	let index = 0;
	return () => {
		const value = values[index];
		if (value === undefined) {
			throw new Error("Sequence exhausted");
		}
		index += 1;
		return value;
	};
}

function entryIds(count: number): string[] {
	return Array.from(
		{ length: count },
		(_, index) =>
			`10000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
	);
}

function user(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 1,
	};
}

function assistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "openai",
		model: "model-b",
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

async function withSessionHome(
	run: (userRoot: string) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "areeb-session-manager-"));
	try {
		await run(join(directory, "user"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe("CodingSessionManager", () => {
	test("treats absent project and global session directories as empty", async () => {
		await withSessionHome(async (userRoot) => {
			const manager = new CodingSessionManager({
				cwd: "/workspace/project",
				userRoot,
			});

			expect(await manager.list()).toEqual([]);
			expect(await listCodingSessions({ userRoot })).toEqual([]);
			expect(await manager.find(SESSION_A_ID)).toBeUndefined();
			expect(
				await findCodingSession(SESSION_A_ID, { userRoot }),
			).toBeUndefined();
		});
	});

	test("creates, derives, and deterministically sorts project records", async () => {
		await withSessionHome(async (userRoot) => {
			let timestamp = 100;
			const manager = new CodingSessionManager({
				cwd: "/workspace/project",
				userRoot,
				repositoryOptions: {
					clock: () => timestamp++,
					sessionIdGenerator: sequence([
						SESSION_A_ID,
						SESSION_B_ID,
						SESSION_C_ID,
					]),
					entryIdGenerator: sequence(entryIds(16)),
				},
			});
			const first = await manager.create();
			await first.appendEntry({
				type: "model_change",
				provider: "openai",
				model: "model-a",
			});
			await first.appendMessage(user("ignored because the name wins"));
			await first.appendMessage({
				role: "tool_result",
				toolCallId: "call-1",
				toolName: "read",
				content: [],
				isError: false,
				timestamp: 3,
			});
			await first.setName("  Explicit title  ");

			const second = await manager.create();
			await second.appendEntry({
				type: "model_change",
				provider: "openai",
				model: "model-b",
			});
			await second.appendMessage(user("  First user title  "));
			await second.appendMessage(assistant("answer"));

			await manager.create();

			const records = await manager.list();
			expect(records.map((record) => record.id)).toEqual([
				SESSION_C_ID,
				SESSION_B_ID,
				SESSION_A_ID,
			]);
			expect(records[0]).toMatchObject({
				title: "(no messages)",
				model: null,
				createdAt: 109,
				updatedAt: 109,
			});
			expect(records[1]).toMatchObject({
				title: "First user title",
				model: { provider: "openai", model: "model-b" },
				createdAt: 105,
				updatedAt: 108,
			});
			expect(records[2]).toMatchObject({
				title: "Explicit title",
				model: { provider: "openai", model: "model-a" },
				createdAt: 100,
				updatedAt: 102,
			});
			expect(records[2]?.path).toBe(
				join(
					areebPaths({ cwd: "/workspace/project", userRoot }).projectSessions,
					`${SESSION_A_ID}.jsonl`,
				),
			);
			expect(await manager.find(SESSION_A_ID)).toEqual(records[2]);
			expect(
				(await manager.open(SESSION_A_ID)).getMetadata(),
			).resolves.toMatchObject({ id: SESSION_A_ID });
			await expect(
				manager.open(SESSION_C_ID.replace(/3$/, "4")),
			).rejects.toMatchObject({ code: "not_found" });
			await expect(manager.find("short-id")).rejects.toMatchObject({
				code: "invalid_payload",
			});
		});
	});

	test("discovers exact UUIDs across project-scoped directories", async () => {
		await withSessionHome(async (userRoot) => {
			const firstManager = new CodingSessionManager({
				cwd: "/workspace/first",
				userRoot,
				repositoryOptions: {
					clock: () => 100,
					sessionIdGenerator: () => SESSION_A_ID,
				},
			});
			const secondManager = new CodingSessionManager({
				cwd: "/workspace/second",
				userRoot,
				repositoryOptions: {
					clock: () => 200,
					sessionIdGenerator: () => SESSION_B_ID,
				},
			});
			await firstManager.create();
			await secondManager.create();

			expect((await firstManager.list()).map((record) => record.id)).toEqual([
				SESSION_A_ID,
			]);
			expect(
				(await listCodingSessions({ userRoot })).map((record) => record.id),
			).toEqual([SESSION_B_ID, SESSION_A_ID]);
			expect(await findCodingSession(SESSION_B_ID, { userRoot })).toMatchObject(
				{
					id: SESSION_B_ID,
					cwd: "/workspace/second",
				},
			);
		});
	});
});
