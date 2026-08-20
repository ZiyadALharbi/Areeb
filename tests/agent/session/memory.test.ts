import { describe, expect, test } from "bun:test";
import { SessionError } from "../../../src/agent/session/errors.ts";
import { MemorySessionRepository } from "../../../src/agent/session/memory.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_SESSION_ID = "00000000-0000-4000-8000-000000000002";
const ENTRY_A_ID = "00000000-0000-4000-8000-000000000011";
const ENTRY_B_ID = "00000000-0000-4000-8000-000000000012";
const ENTRY_C_ID = "00000000-0000-4000-8000-000000000013";

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

describe("MemorySessionRepository", () => {
	test("creates, lists, filters, and opens sessions defensively", async () => {
		const sourceMetadata = { nested: { value: 1 } };
		const repository = new MemorySessionRepository({
			clock: sequence([100, 200]),
		});

		await repository.create({
			id: SESSION_ID,
			cwd: "/first",
			metadata: sourceMetadata,
		});
		await repository.create({
			id: SECOND_SESSION_ID,
			cwd: "/second",
		});
		sourceMetadata.nested.value = 2;

		const listed = await repository.list();
		expect(listed.map((metadata) => metadata.id)).toEqual([
			SECOND_SESSION_ID,
			SESSION_ID,
		]);
		expect(listed[1]?.metadata).toEqual({ nested: { value: 1 } });
		expect(await repository.list({ cwd: "/first" })).toHaveLength(1);

		if (listed[1]?.metadata === undefined) {
			throw new Error("Expected metadata");
		}
		listed[1].metadata.nested = { value: 99 };
		expect((await repository.list())[1]?.metadata).toEqual({
			nested: { value: 1 },
		});

		const opened = await repository.open(listed[1]);
		expect((await opened.getMetadata()).id).toBe(SESSION_ID);
	});

	test("rejects duplicate creates and missing opens", async () => {
		const repository = new MemorySessionRepository({ clock: () => 100 });
		const session = await repository.create({
			id: SESSION_ID,
			cwd: "/workspace",
		});
		const metadata = await session.getMetadata();

		await expect(
			repository.create({ id: SESSION_ID, cwd: "/workspace" }),
		).rejects.toMatchObject({ code: "already_exists" });
		await expect(
			repository.open({ ...metadata, id: SECOND_SESSION_ID }),
		).rejects.toMatchObject({ code: "not_found" });
	});

	test("finds sessions by exact UUID", async () => {
		const repository = new MemorySessionRepository({ clock: () => 100 });
		await repository.create({ id: SESSION_ID, cwd: "/workspace" });

		expect(await repository.find(SESSION_ID)).toMatchObject({
			id: SESSION_ID,
			cwd: "/workspace",
		});
		expect(await repository.find(SECOND_SESSION_ID)).toBeUndefined();
		await expect(repository.find("not-a-uuid")).rejects.toMatchObject({
			code: "invalid_payload",
		});
	});

	test("serializes concurrent appends with increasing sequences", async () => {
		let timestamp = 100;
		const repository = new MemorySessionRepository({
			clock: () => timestamp++,
			entryIdGenerator: sequence([ENTRY_A_ID, ENTRY_B_ID, ENTRY_C_ID]),
		});
		const session = await repository.create({
			id: SESSION_ID,
			cwd: "/workspace",
		});

		const ids = await Promise.all([
			session.appendCustomEntry("note", { index: 1 }),
			session.appendCustomEntry("note", { index: 2 }),
			session.appendCustomEntry("note", { index: 3 }),
		]);

		expect(ids).toEqual([ENTRY_A_ID, ENTRY_B_ID, ENTRY_C_ID]);
		const entries = await session.findEntries({ order: "oldest_first" });
		expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
		expect(entries.map((entry) => entry.parentId)).toEqual([
			null,
			ENTRY_A_ID,
			ENTRY_B_ID,
		]);
		expect(entries.map((entry) => entry.timestamp)).toEqual([101, 102, 103]);
	});

	test("shares pointer state and the writer across repeated opens", async () => {
		const repository = new MemorySessionRepository({
			clock: () => 100,
			entryIdGenerator: sequence([ENTRY_A_ID, ENTRY_B_ID, ENTRY_C_ID]),
		});
		const firstHandle = await repository.create({
			id: SESSION_ID,
			cwd: "/workspace",
		});
		await firstHandle.appendCustomEntry("note", { branch: "root" });
		await firstHandle.appendCustomEntry("note", { branch: "first" });

		const secondHandle = await repository.open(await firstHandle.getMetadata());
		await secondHandle.moveLeaf(ENTRY_A_ID);
		await firstHandle.appendCustomEntry("note", { branch: "second" });

		expect(await secondHandle.getLeafId()).toBe(ENTRY_C_ID);
		expect(
			(await firstHandle.getChildren(ENTRY_A_ID)).map((entry) => entry.id),
		).toEqual([ENTRY_B_ID, ENTRY_C_ID]);
		expect(
			(await secondHandle.findEntriesOnBranch({ order: "oldest_first" })).map(
				(entry) => entry.id,
			),
		).toEqual([ENTRY_A_ID, ENTRY_C_ID]);
	});

	test("keeps state unchanged after a rejected write and continues the queue", async () => {
		const repository = new MemorySessionRepository({
			clock: () => 100,
			entryIdGenerator: sequence([ENTRY_A_ID, ENTRY_A_ID, ENTRY_B_ID]),
		});
		const session = await repository.create({
			id: SESSION_ID,
			cwd: "/workspace",
		});

		await session.appendCustomEntry("note", { index: 1 });

		let thrown: unknown;
		try {
			await session.appendCustomEntry("note", { index: 2 });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(SessionError);
		expect((thrown as SessionError).code).toBe("invalid_mutation");

		await session.appendCustomEntry("note", { index: 3 });
		const entries = await session.findEntries({ order: "oldest_first" });
		expect(entries.map((entry) => entry.id)).toEqual([ENTRY_A_ID, ENTRY_B_ID]);
		expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
		expect(entries[1]?.parentId).toBe(ENTRY_A_ID);
	});
});
