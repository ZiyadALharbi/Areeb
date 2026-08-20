import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepository } from "../../../src/agent/session/jsonl/repository.ts";

const SESSION_A_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_B_ID = "00000000-0000-4000-8000-000000000002";
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

async function withRepositoryDirectory(
	run: (directory: string) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "areeb-jsonl-repository-"));

	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("JSONL repository lists an absent directory as empty", async () => {
	await withRepositoryDirectory(async (directory) => {
		const missing = join(directory, "missing");
		const repository = new JsonlSessionRepository(missing);

		expect(await repository.list()).toEqual([]);
	});
});

test("JSONL repository creates, filters, sorts, and lists defensively", async () => {
	await withRepositoryDirectory(async (directory) => {
		const sourceMetadata = { nested: { value: 1 } };
		const repository = new JsonlSessionRepository(directory, {
			clock: sequence([100, 200]),
		});

		await repository.create({
			id: SESSION_A_ID,
			cwd: "/first",
			metadata: sourceMetadata,
		});
		await repository.create({
			id: SESSION_B_ID,
			cwd: "/second",
		});
		sourceMetadata.nested.value = 2;

		await writeFile(join(directory, "notes.txt"), "ignored");

		const listed = await repository.list();
		expect(listed.map((metadata) => metadata.id)).toEqual([
			SESSION_B_ID,
			SESSION_A_ID,
		]);
		expect(listed[1]?.metadata).toEqual({ nested: { value: 1 } });
		expect(listed[1]?.path).toBe(join(directory, `${SESSION_A_ID}.jsonl`));
		expect(await repository.list({ cwd: "/first" })).toHaveLength(1);

		if (listed[1]?.metadata === undefined) {
			throw new Error("Expected metadata");
		}
		listed[1].metadata.nested = { value: 99 };
		expect((await repository.list())[1]?.metadata).toEqual({
			nested: { value: 1 },
		});
	});
});

test("JSONL repository discovers and opens sessions in a new instance", async () => {
	await withRepositoryDirectory(async (directory) => {
		const firstRepository = new JsonlSessionRepository(directory, {
			clock: () => 100,
			entryIdGenerator: () => ENTRY_A_ID,
		});
		const created = await firstRepository.create({
			id: SESSION_A_ID,
			cwd: "/workspace",
		});
		await created.appendCustomEntry("note", { persisted: true });
		await created.setName("Research");

		const secondRepository = new JsonlSessionRepository(directory);
		const [metadata] = await secondRepository.list();
		if (metadata === undefined) {
			throw new Error("Expected listed session");
		}
		const opened = await secondRepository.open(metadata);

		expect(await opened.getLeafId()).toBe(ENTRY_A_ID);
		expect(await opened.getName()).toBe("Research");
		expect((await opened.findEntries())[0]?.id).toBe(ENTRY_A_ID);
	});
});

test("JSONL repository finds sessions by exact UUID", async () => {
	await withRepositoryDirectory(async (directory) => {
		const repository = new JsonlSessionRepository(directory, {
			clock: () => 100,
		});
		await repository.create({ id: SESSION_A_ID, cwd: "/workspace" });

		expect(await repository.find(SESSION_A_ID)).toMatchObject({
			id: SESSION_A_ID,
			path: join(directory, `${SESSION_A_ID}.jsonl`),
		});
		expect(await repository.find(SESSION_B_ID)).toBeUndefined();
		await expect(repository.find("not-a-uuid")).rejects.toMatchObject({
			code: "invalid_payload",
		});
	});
});

test("JSONL repository rejects a header and filename ID mismatch on find", async () => {
	await withRepositoryDirectory(async (directory) => {
		const repository = new JsonlSessionRepository(directory, {
			clock: () => 100,
		});
		await repository.create({ id: SESSION_A_ID, cwd: "/workspace" });
		const source = await readFile(
			join(directory, `${SESSION_A_ID}.jsonl`),
			"utf8",
		);
		const mismatchedPath = join(directory, `${SESSION_B_ID}.jsonl`);
		await writeFile(mismatchedPath, source);

		await expect(repository.find(SESSION_B_ID)).rejects.toMatchObject({
			code: "invalid_format",
			path: mismatchedPath,
			line: 1,
		});
	});
});

test("repeated JSONL opens share one serialized writer", async () => {
	await withRepositoryDirectory(async (directory) => {
		let timestamp = 100;
		const repository = new JsonlSessionRepository(directory, {
			clock: () => timestamp++,
			entryIdGenerator: sequence([ENTRY_A_ID, ENTRY_B_ID, ENTRY_C_ID]),
		});
		const created = await repository.create({
			id: SESSION_A_ID,
			cwd: "/workspace",
		});
		await created.appendCustomEntry("note", { index: 1 });
		const metadata = await created.getMetadata();
		expect(await repository.find(SESSION_A_ID)).toEqual(metadata);

		const [first, second] = await Promise.all([
			repository.open(metadata),
			repository.open(metadata),
		]);
		await Promise.all([
			first.appendCustomEntry("note", { index: 2 }),
			second.appendCustomEntry("note", { index: 3 }),
		]);

		const entries = await created.findEntries({ order: "oldest_first" });
		expect(entries.map((entry) => entry.id)).toEqual([
			ENTRY_A_ID,
			ENTRY_B_ID,
			ENTRY_C_ID,
		]);
		expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
		expect(entries.map((entry) => entry.parentId)).toEqual([
			null,
			ENTRY_A_ID,
			ENTRY_B_ID,
		]);
	});
});

test("JSONL repository rejects duplicates, missing sessions, and foreign paths", async () => {
	await withRepositoryDirectory(async (directory) => {
		const repository = new JsonlSessionRepository(directory, {
			clock: () => 100,
		});
		const created = await repository.create({
			id: SESSION_A_ID,
			cwd: "/workspace",
		});
		const metadata = await created.getMetadata();

		await expect(
			repository.create({ id: SESSION_A_ID, cwd: "/workspace" }),
		).rejects.toMatchObject({ code: "already_exists" });

		await expect(
			repository.open({
				...metadata,
				id: SESSION_B_ID,
				path: join(directory, `${SESSION_B_ID}.jsonl`),
			}),
		).rejects.toMatchObject({ code: "not_found" });

		await expect(
			repository.open({
				...metadata,
				path: join(directory, "..", `${SESSION_A_ID}.jsonl`),
			}),
		).rejects.toMatchObject({ code: "invalid_payload" });
	});
});

test("JSONL repository rejects malformed session filenames", async () => {
	await withRepositoryDirectory(async (directory) => {
		await writeFile(join(directory, "not-a-uuid.jsonl"), "{}\n");
		const repository = new JsonlSessionRepository(directory);

		await expect(repository.list()).rejects.toMatchObject({
			code: "invalid_format",
			path: join(directory, "not-a-uuid.jsonl"),
		});
	});
});
