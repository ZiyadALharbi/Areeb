import { expect, test } from "bun:test";
import {
	appendFile,
	mkdtemp,
	readFile,
	rm,
	stat,
	truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStorage } from "../../../src/agent/session/jsonl/storage.ts";
import { Session } from "../../../src/agent/session/session.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const ENTRY_A_ID = "00000000-0000-4000-8000-000000000011";
const ENTRY_B_ID = "00000000-0000-4000-8000-000000000012";
const ENTRY_C_ID = "00000000-0000-4000-8000-000000000013";

const metadata = {
	id: SESSION_ID,
	createdAt: 100,
	cwd: "/workspace",
	metadata: { project: "Areeb" },
};

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

async function withSessionPath(
	run: (path: string) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "areeb-jsonl-storage-"));
	const path = join(directory, "session.jsonl");

	try {
		await run(path);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("JSONL storage persists and replays entries, pointers, and facts", async () => {
	await withSessionPath(async (path) => {
		let timestamp = 200;
		const storage = await JsonlSessionStorage.create(path, metadata, {
			clock: () => timestamp++,
		});
		const session = new Session(storage, sequence([ENTRY_A_ID, ENTRY_B_ID]));

		await session.appendCustomEntry("note", { text: "root" });
		await session.setName("Research");
		await session.setLabel(ENTRY_A_ID, "checkpoint");
		await session.appendCustomEntry("note", { text: "child" });
		await session.moveLeaf(ENTRY_A_ID);

		const reopenedStorage = await JsonlSessionStorage.open(path);
		const reopened = new Session(reopenedStorage);

		expect(await reopened.getLeafId()).toBe(ENTRY_A_ID);
		expect(await reopened.getName()).toBe("Research");
		expect(await reopened.getLabel(ENTRY_A_ID)).toBe("checkpoint");
		expect(
			(await reopened.findEntries({ order: "oldest_first" })).map(
				(entry) => entry.id,
			),
		).toEqual([ENTRY_A_ID, ENTRY_B_ID]);
		expect((await reopened.getMetadata()).path).toBe(path);

		const contents = await readFile(path, "utf8");
		expect(contents.endsWith("\n")).toBeTrue();
		expect(contents.trimEnd().split("\n")).toHaveLength(6);
	});
});

test("JSONL storage serializes concurrent writes", async () => {
	await withSessionPath(async (path) => {
		let timestamp = 200;
		const storage = await JsonlSessionStorage.create(path, metadata, {
			clock: () => timestamp++,
		});
		const session = new Session(
			storage,
			sequence([ENTRY_A_ID, ENTRY_B_ID, ENTRY_C_ID]),
		);

		await Promise.all([
			session.appendCustomEntry("note", { index: 1 }),
			session.appendCustomEntry("note", { index: 2 }),
			session.appendCustomEntry("note", { index: 3 }),
		]);

		const reopened = new Session(await JsonlSessionStorage.open(path));
		const entries = await reopened.findEntries({ order: "oldest_first" });

		expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
		expect(entries.map((entry) => entry.parentId)).toEqual([
			null,
			ENTRY_A_ID,
			ENTRY_B_ID,
		]);
	});
});

test("JSONL storage repairs a valid final line missing its newline", async () => {
	await withSessionPath(async (path) => {
		const storage = await JsonlSessionStorage.create(path, metadata, {
			clock: () => 200,
		});
		const session = new Session(storage, () => ENTRY_A_ID);
		await session.appendCustomEntry("note", { text: "persisted" });

		const size = (await stat(path)).size;
		await truncate(path, size - 1);

		const reopened = new Session(await JsonlSessionStorage.open(path));
		expect(await reopened.getLeafId()).toBe(ENTRY_A_ID);
		expect((await readFile(path, "utf8")).endsWith("\n")).toBeTrue();
	});
});

test("JSONL storage truncates a syntactically torn final line", async () => {
	await withSessionPath(async (path) => {
		const storage = await JsonlSessionStorage.create(path, metadata, {
			clock: () => 200,
		});
		const session = new Session(storage, () => ENTRY_A_ID);
		await session.appendCustomEntry("note", { text: "persisted" });
		const validPrefix = await readFile(path);

		await appendFile(path, '{"kind":"entry"');

		const reopened = new Session(await JsonlSessionStorage.open(path));
		expect(await reopened.getLeafId()).toBe(ENTRY_A_ID);
		expect(await readFile(path)).toEqual(validPrefix);
	});
});

test("JSONL storage rejects malformed complete lines", async () => {
	await withSessionPath(async (path) => {
		await JsonlSessionStorage.create(path, metadata);
		await appendFile(path, "{}\n");

		await expect(JsonlSessionStorage.open(path)).rejects.toMatchObject({
			code: "invalid_format",
			path,
			line: 2,
		});
	});

	await withSessionPath(async (path) => {
		await JsonlSessionStorage.create(path, metadata);
		await appendFile(path, "{}");
		const malformed = await readFile(path);

		await expect(JsonlSessionStorage.open(path)).rejects.toMatchObject({
			code: "invalid_format",
			path,
			line: 2,
		});
		expect(await readFile(path)).toEqual(malformed);
	});
});

test("failed persistence leaves replay state unchanged and poisons the writer", async () => {
	await withSessionPath(async (path) => {
		let appendAttempts = 0;
		const storage = await JsonlSessionStorage.create(path, metadata, {
			clock: () => 200,
			appendLine: async (targetPath, line) => {
				appendAttempts += 1;
				await appendFile(targetPath, line.slice(0, 12));
				throw new Error("simulated write failure");
			},
		});
		const session = new Session(storage, sequence([ENTRY_A_ID, ENTRY_B_ID]));

		await expect(
			session.appendCustomEntry("note", { index: 1 }),
		).rejects.toMatchObject({ code: "storage", path });
		expect(await session.getLeafId()).toBeNull();
		expect(await session.findEntries()).toEqual([]);

		await expect(
			session.appendCustomEntry("note", { index: 2 }),
		).rejects.toMatchObject({ code: "storage", path });
		expect(appendAttempts).toBe(1);

		const reopened = new Session(await JsonlSessionStorage.open(path));
		expect(await reopened.getLeafId()).toBeNull();
		expect((await readFile(path, "utf8")).trimEnd().split("\n")).toHaveLength(
			1,
		);
	});
});
