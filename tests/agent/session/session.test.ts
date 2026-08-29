import { describe, expect, test } from "bun:test";
import { SessionError } from "../../../src/agent/session/errors.ts";
import {
	assertJsonValue,
	Session,
} from "../../../src/agent/session/session.ts";
import type {
	EntryQuery,
	ProvisionedSessionEntry,
	SessionEntry,
	SessionMetadata,
	SessionStorage,
	StorageBranchEntryQuery,
} from "../../../src/agent/session/types.ts";

const ENTRY_ID = "00000000-0000-4000-8000-000000000001";
const LEAF_ID = "00000000-0000-4000-8000-000000000002";

class RecordingStorage implements SessionStorage {
	readonly metadata: SessionMetadata = {
		id: "00000000-0000-4000-8000-000000000099",
		createdAt: 100,
		cwd: "/workspace",
	};
	readonly appended: ProvisionedSessionEntry[] = [];
	readonly branchQueries: StorageBranchEntryQuery[] = [];
	leafId: string | null = null;
	name: string | undefined;
	readonly labels = new Map<string, string>();

	async getMetadata(): Promise<SessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLeafId(): Promise<string | null> {
		return this.leafId;
	}

	async moveLeaf(id: string | null): Promise<void> {
		this.leafId = id;
	}

	async appendEntry<TEntry extends SessionEntry>(
		entry: ProvisionedSessionEntry<TEntry>,
	): Promise<TEntry> {
		this.appended.push(structuredClone(entry as ProvisionedSessionEntry));
		const storedEntry = {
			...structuredClone(entry),
			seq: this.appended.length,
			parentId: this.leafId,
			timestamp: 100 + this.appended.length,
		} as unknown as TEntry;
		this.leafId = storedEntry.id;
		return storedEntry;
	}

	async getEntry(_id: string): Promise<SessionEntry | undefined> {
		return undefined;
	}

	async getChildren(_parentId: string | null): Promise<SessionEntry[]> {
		return [];
	}

	async findEntries(_query?: EntryQuery): Promise<SessionEntry[]> {
		return [];
	}

	async findEntriesOnBranch(
		query: StorageBranchEntryQuery,
	): Promise<SessionEntry[]> {
		this.branchQueries.push(structuredClone(query));
		return [];
	}

	async getName(): Promise<string | undefined> {
		return this.name;
	}

	async setName(name: string | null): Promise<void> {
		this.name = name ?? undefined;
	}

	async getLabel(targetId: string): Promise<string | undefined> {
		return this.labels.get(targetId);
	}

	async setLabel(targetId: string, label: string | null): Promise<void> {
		if (label === null) {
			this.labels.delete(targetId);
		} else {
			this.labels.set(targetId, label);
		}
	}
}

function expectInvalidPayload(action: () => unknown): void {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(SessionError);
	expect((thrown as SessionError).code).toBe("invalid_payload");
}

describe("strict JSON validation", () => {
	test("accepts JSON values and repeated non-cyclic references", () => {
		const shared = { value: 1 };

		expect(() =>
			assertJsonValue({
				null: null,
				boolean: true,
				number: 1,
				string: "value",
				array: [1, "two", false],
				first: shared,
				second: shared,
			}),
		).not.toThrow();
	});

	test("rejects every unsupported payload category", () => {
		const sparse: unknown[] = [];
		sparse.length = 2;
		sparse[1] = "value";

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		const symbolProperty = { value: 1 };
		Object.defineProperty(symbolProperty, Symbol("hidden"), {
			value: 2,
			enumerable: true,
		});

		const unsupported: unknown[] = [
			undefined,
			1n,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			sparse,
			new Map([["value", 1]]),
			new Set([1]),
			Symbol("value"),
			symbolProperty,
			cyclic,
		];

		for (const value of unsupported) {
			expectInvalidPayload(() => assertJsonValue(value));
		}
	});

	test("rejects accessors without invoking them", () => {
		let invoked = false;
		const value = Object.defineProperty({}, "secret", {
			enumerable: true,
			get() {
				invoked = true;
				return "secret";
			},
		});

		expectInvalidPayload(() => assertJsonValue(value));
		expect(invoked).toBeFalse();
	});
});

describe("Session", () => {
	test("provisions a full UUID before appending", async () => {
		const storage = new RecordingStorage();
		const session = new Session(storage, () => ENTRY_ID);
		const message = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "hello" }],
			timestamp: 100,
		};

		expect(await session.appendMessage(message)).toBe(ENTRY_ID);
		expect(storage.appended).toEqual([
			{
				type: "message",
				message,
				id: ENTRY_ID,
			},
		]);
	});

	test("rejects invalid generated IDs before storage mutation", async () => {
		const storage = new RecordingStorage();
		const session = new Session(storage, () => "short-id");

		await expect(session.appendCustomEntry("note")).rejects.toMatchObject({
			code: "invalid_payload",
		});
		expect(storage.appended).toEqual([]);
	});

	test("rejects caller-provided storage fields", async () => {
		const storage = new RecordingStorage();
		const session = new Session(storage, () => ENTRY_ID);

		await expect(
			session.appendEntry({
				type: "custom",
				customType: "note",
				parentId: null,
			} as never),
		).rejects.toMatchObject({ code: "invalid_payload" });
		expect(storage.appended).toEqual([]);
	});

	test("rejects invalid entry payloads before storage mutation", async () => {
		const storage = new RecordingStorage();
		const session = new Session(storage, () => ENTRY_ID);

		await expect(
			session.appendCustomEntry("note", {
				value: undefined,
			} as never),
		).rejects.toMatchObject({ code: "invalid_payload" });
		expect(storage.appended).toEqual([]);
	});

	test("resolves omitted branch starts and preserves explicit empty branches", async () => {
		const storage = new RecordingStorage();
		storage.leafId = LEAF_ID;
		const session = new Session(storage);

		expect(
			await session.findEntriesOnBranch({ order: "oldest_first" }),
		).toEqual([]);
		expect(storage.branchQueries).toEqual([
			{ startId: LEAF_ID, order: "oldest_first" },
		]);

		expect(await session.findEntriesOnBranch({ startId: null })).toEqual([]);
		expect(storage.branchQueries).toHaveLength(1);
	});
});
