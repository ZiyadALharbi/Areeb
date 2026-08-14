import { describe, expect, test } from "bun:test";
import { SessionError } from "../../../src/agent/session/errors.ts";
import { SessionState } from "../../../src/agent/session/state.ts";
import type {
	EntryMutation,
	EntryQuery,
	JsonValue,
	NewSessionEntry,
	ProvisionedSessionEntry,
	SessionEntry,
	SessionMutation,
} from "../../../src/agent/session/types.ts";
import type { AgentMessage } from "../../../src/agent/types.ts";
import type { Message } from "../../../src/ai/types.ts";

const ENTRY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD_A_ID = "00000000-0000-4000-8000-000000000002";
const CHILD_B_ID = "00000000-0000-4000-8000-000000000003";
const SECOND_ROOT_ID = "00000000-0000-4000-8000-000000000004";

const entryBase = {
	id: ENTRY_ID,
	seq: 1,
	parentId: null,
	timestamp: 100,
};

function customMutation(
	id: string,
	seq: number,
	parentId: string | null,
	data?: JsonValue,
): EntryMutation {
	return {
		kind: "entry",
		entry: {
			type: "custom",
			id,
			seq,
			parentId,
			timestamp: 100 + seq,
			customType: "test",
			...(data === undefined ? {} : { data }),
		},
	};
}

function expectInvalidMutation(
	action: () => void,
	messageFragment: string,
): void {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(SessionError);
	const error = thrown as SessionError;
	expect(error.code).toBe("invalid_mutation");
	expect(error.message).toContain(messageFragment);
}

function expectInvalidQuery(action: () => void, messageFragment: string): void {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(SessionError);
	const error = thrown as SessionError;
	expect(error.code).toBe("invalid_query");
	expect(error.message).toContain(messageFragment);
}

function createQueryableState(): SessionState {
	const state = new SessionState();
	state.applyMutation(
		customMutation(ENTRY_ID, 1, null, { nested: { value: 1 } }),
	);
	state.applyMutation({
		kind: "entry",
		entry: {
			type: "model_change",
			id: CHILD_A_ID,
			seq: 2,
			parentId: ENTRY_ID,
			timestamp: 102,
			provider: "openai",
			model: "model-a",
		},
	});
	state.applyMutation({
		kind: "entry",
		entry: {
			type: "custom",
			id: SECOND_ROOT_ID,
			seq: 3,
			parentId: CHILD_A_ID,
			timestamp: 103,
			customType: "note",
			data: { text: "sibling branch" },
		},
	});
	state.applyMutation({
		kind: "pointer",
		seq: 4,
		timestamp: 104,
		pointer: "main",
		leafId: ENTRY_ID,
	});
	state.applyMutation({
		kind: "entry",
		entry: {
			type: "message",
			id: CHILD_B_ID,
			seq: 5,
			parentId: ENTRY_ID,
			timestamp: 105,
			message: {
				role: "user",
				content: [{ type: "text", text: "main branch" }],
				timestamp: 105,
			},
		},
	});
	return state;
}

function getEntryType(entry: SessionEntry): SessionEntry["type"] {
	switch (entry.type) {
		case "message":
		case "model_change":
		case "reasoning_change":
		case "active_tools_change":
		case "compaction":
		case "branch_summary":
		case "custom":
			return entry.type;
	}

	// Adding an entry type requires updating this exhaustive switch.
	const unhandled: never = entry;
	return unhandled;
}

function getMutationType(mutation: SessionMutation): string {
	switch (mutation.kind) {
		case "entry":
			return "entry";

		case "pointer":
			return "pointer";

		case "fact": {
			switch (mutation.fact) {
				case "name":
					return "name";
				case "label":
					return "label";
			}

			const unhandledFact: never = mutation;
			return unhandledFact;
		}
	}

	const unhandledMutation: never = mutation;
	return unhandledMutation;
}

describe("session type contracts", () => {
	test("covers every Phase 7 entry type", () => {
		const entries: SessionEntry[] = [
			{
				...entryBase,
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: 100,
				},
			},
			{
				...entryBase,
				type: "model_change",
				provider: "openai",
				model: "example-model",
			},
			{
				...entryBase,
				type: "reasoning_change",
				reasoning: "medium",
			},
			{
				...entryBase,
				type: "active_tools_change",
				activeToolNames: ["read", "write"],
			},
			{
				...entryBase,
				type: "compaction",
				summary: "Earlier conversation",
				retainedTail: [],
				tokensBefore: 1000,
			},
			{
				...entryBase,
				type: "branch_summary",
				sourceLeafId: ENTRY_ID,
				summary: "Abandoned branch",
			},
			{
				...entryBase,
				type: "custom",
				customType: "note",
				data: { important: true },
			},
		];

		expect(entries.map(getEntryType)).toEqual([
			"message",
			"model_change",
			"reasoning_change",
			"active_tools_change",
			"compaction",
			"branch_summary",
			"custom",
		]);
	});

	test("covers every mutation type", () => {
		const entry: SessionEntry = {
			...entryBase,
			type: "custom",
			customType: "note",
		};

		const mutations: SessionMutation[] = [
			{ kind: "entry", entry },
			{
				kind: "pointer",
				seq: 2,
				timestamp: 101,
				pointer: "main",
				leafId: null,
			},
			{
				kind: "fact",
				seq: 3,
				timestamp: 102,
				fact: "name",
				value: "Example",
			},
			{
				kind: "fact",
				seq: 4,
				timestamp: 103,
				fact: "label",
				targetId: ENTRY_ID,
				value: "checkpoint",
			},
		];

		expect(mutations.map(getMutationType)).toEqual([
			"entry",
			"pointer",
			"name",
			"label",
		]);
	});

	test("separates caller and storage-assigned entry fields", () => {
		const input: NewSessionEntry = {
			type: "custom",
			customType: "note",
		};

		const provisioned: ProvisionedSessionEntry = {
			...input,
			id: ENTRY_ID,
		};

		expect(provisioned.id).toBe(ENTRY_ID);

		const invalidInput: NewSessionEntry = {
			type: "custom",
			customType: "note",
			// @ts-expect-error The facade, not the caller, assigns entry IDs.
			id: ENTRY_ID,
		};

		// @ts-expect-error A provisioned entry must contain its facade-assigned ID.
		const missingId: ProvisionedSessionEntry = {
			type: "custom",
			customType: "note",
		};

		void invalidInput;
		void missingId;
	});

	test("keeps session messages outside the provider message union", () => {
		const sessionMessage: AgentMessage = {
			role: "session_compaction",
			summary: "Earlier conversation",
			tokensBefore: 1000,
			timestamp: 100,
		};

		// @ts-expect-error Session messages require conversion before provider use.
		const providerMessage: Message = sessionMessage;

		expect(sessionMessage.role).toBe("session_compaction");
		void providerMessage;
	});

	test("exposes stable error information", () => {
		const cause = new Error("invalid JSON");
		const error = new SessionError("invalid_format", "Invalid session line", {
			cause,
			path: "/sessions/example.jsonl",
			line: 3,
		});

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("SessionError");
		expect(error.code).toBe("invalid_format");
		expect(error.path).toBe("/sessions/example.jsonl");
		expect(error.line).toBe(3);
		expect(error.cause).toBe(cause);
	});
});

describe("SessionState", () => {
	test("starts with an empty main pointer and no facts", () => {
		const state = new SessionState();

		expect(state.nextSequence).toBe(1);
		expect(state.getLeafId()).toBeNull();
		expect(state.getName()).toBeUndefined();
		expect(state.getLabel(ENTRY_ID)).toBeUndefined();
		expect(state.getEntry(ENTRY_ID)).toBeUndefined();
		expect(state.getChildren(null)).toEqual([]);
	});

	test("replays entries, pointer movement, branches, and new roots", () => {
		const state = new SessionState();

		state.applyMutation(customMutation(ENTRY_ID, 1, null));
		state.applyMutation(customMutation(CHILD_A_ID, 2, ENTRY_ID));
		state.applyMutation({
			kind: "pointer",
			seq: 3,
			timestamp: 103,
			pointer: "main",
			leafId: ENTRY_ID,
		});
		state.applyMutation(customMutation(CHILD_B_ID, 4, ENTRY_ID));

		expect(state.getLeafId()).toBe(CHILD_B_ID);
		expect(state.getChildren(ENTRY_ID).map((entry) => entry.id)).toEqual([
			CHILD_A_ID,
			CHILD_B_ID,
		]);

		state.applyMutation({
			kind: "pointer",
			seq: 5,
			timestamp: 105,
			pointer: "main",
			leafId: null,
		});
		state.applyMutation(customMutation(SECOND_ROOT_ID, 6, null));

		expect(state.getLeafId()).toBe(SECOND_ROOT_ID);
		expect(state.getChildren(null).map((entry) => entry.id)).toEqual([
			ENTRY_ID,
			SECOND_ROOT_ID,
		]);
		expect(state.nextSequence).toBe(7);
	});

	test("replays name and label facts including explicit clears", () => {
		const state = new SessionState();
		state.applyMutation(customMutation(ENTRY_ID, 1, null));
		state.applyMutation({
			kind: "fact",
			seq: 2,
			timestamp: 102,
			fact: "name",
			value: "Research",
		});
		state.applyMutation({
			kind: "fact",
			seq: 3,
			timestamp: 103,
			fact: "label",
			targetId: ENTRY_ID,
			value: "checkpoint",
		});

		expect(state.getName()).toBe("Research");
		expect(state.getLabel(ENTRY_ID)).toBe("checkpoint");

		state.applyMutation({
			kind: "fact",
			seq: 4,
			timestamp: 104,
			fact: "name",
			value: null,
		});
		state.applyMutation({
			kind: "fact",
			seq: 5,
			timestamp: 105,
			fact: "label",
			targetId: ENTRY_ID,
			value: null,
		});

		expect(state.getName()).toBeUndefined();
		expect(state.getLabel(ENTRY_ID)).toBeUndefined();
	});

	test("constructs state by replaying an existing mutation history", () => {
		const state = new SessionState([
			customMutation(ENTRY_ID, 1, null),
			customMutation(CHILD_A_ID, 2, ENTRY_ID),
			{
				kind: "pointer",
				seq: 3,
				timestamp: 103,
				pointer: "main",
				leafId: ENTRY_ID,
			},
		]);

		expect(state.getLeafId()).toBe(ENTRY_ID);
		expect(state.nextSequence).toBe(4);
		expect(state.getEntry(CHILD_A_ID)?.parentId).toBe(ENTRY_ID);
	});

	test("validation does not mutate state", () => {
		const state = new SessionState();
		const candidate = customMutation(ENTRY_ID, 1, null);

		state.validateMutation(candidate);

		expect(state.nextSequence).toBe(1);
		expect(state.getLeafId()).toBeNull();
		expect(state.getEntry(ENTRY_ID)).toBeUndefined();
	});

	test("rejects non-consecutive and unsafe sequences without mutation", () => {
		const state = new SessionState();

		expectInvalidMutation(
			() => state.applyMutation(customMutation(ENTRY_ID, 2, null)),
			"expected seq 1, received 2",
		);
		expectInvalidMutation(
			() =>
				state.applyMutation(
					customMutation(ENTRY_ID, Number.POSITIVE_INFINITY, null),
				),
			"expected seq 1",
		);

		expect(state.nextSequence).toBe(1);
		expect(state.getLeafId()).toBeNull();
	});

	test("rejects duplicate IDs, missing parents, and stale parents", () => {
		const state = new SessionState();

		expectInvalidMutation(
			() => state.applyMutation(customMutation(CHILD_A_ID, 1, ENTRY_ID)),
			"missing parent",
		);

		state.applyMutation(customMutation(ENTRY_ID, 1, null));
		expectInvalidMutation(
			() => state.applyMutation(customMutation(ENTRY_ID, 2, ENTRY_ID)),
			"duplicate entry id",
		);

		state.applyMutation(customMutation(CHILD_A_ID, 2, ENTRY_ID));
		expectInvalidMutation(
			() => state.applyMutation(customMutation(CHILD_B_ID, 3, ENTRY_ID)),
			"does not match main leaf",
		);

		expect(state.nextSequence).toBe(3);
		expect(state.getLeafId()).toBe(CHILD_A_ID);
	});

	test("rejects invalid pointer, label, and branch-summary references", () => {
		const pointerState = new SessionState();
		expectInvalidMutation(
			() =>
				pointerState.applyMutation({
					kind: "pointer",
					seq: 1,
					timestamp: 101,
					pointer: "main",
					leafId: ENTRY_ID,
				}),
			"pointer references missing entry",
		);

		const labelState = new SessionState();
		expectInvalidMutation(
			() =>
				labelState.applyMutation({
					kind: "fact",
					seq: 1,
					timestamp: 101,
					fact: "label",
					targetId: ENTRY_ID,
					value: null,
				}),
			"label references missing entry",
		);

		const branchState = new SessionState();
		expectInvalidMutation(
			() =>
				branchState.applyMutation({
					kind: "entry",
					entry: {
						type: "branch_summary",
						id: ENTRY_ID,
						seq: 1,
						parentId: null,
						timestamp: 101,
						sourceLeafId: CHILD_A_ID,
						summary: "missing source",
					},
				}),
			"branch summary references missing source",
		);
	});

	test("rejects pointer names other than main at runtime", () => {
		const state = new SessionState();
		const mutation = {
			kind: "pointer",
			seq: 1,
			timestamp: 101,
			pointer: "worker",
			leafId: null,
		} as unknown as SessionMutation;

		expectInvalidMutation(
			() => state.applyMutation(mutation),
			"unknown pointer worker",
		);
	});

	test("stores and returns defensive entry copies", () => {
		const state = new SessionState();
		const data = { nested: { value: 1 } };
		const mutation = customMutation(ENTRY_ID, 1, null, data);

		state.applyMutation(mutation);
		data.nested.value = 2;

		const firstRead = state.getEntry(ENTRY_ID);
		expect(firstRead?.type).toBe("custom");
		if (firstRead?.type !== "custom") {
			throw new Error("Expected custom entry");
		}
		expect(firstRead.data).toEqual({ nested: { value: 1 } });

		const firstData = firstRead.data as { nested: { value: number } };
		firstData.nested.value = 3;
		const childRead = state.getChildren(null)[0];
		expect(childRead?.type).toBe("custom");
		if (childRead?.type !== "custom") {
			throw new Error("Expected custom child entry");
		}
		expect(childRead.data).toEqual({ nested: { value: 1 } });
	});
});

describe("SessionState queries", () => {
	test("returns global entries newest first by default", () => {
		const state = createQueryableState();

		expect(state.findEntries().map((entry) => entry.id)).toEqual([
			CHILD_B_ID,
			SECOND_ROOT_ID,
			CHILD_A_ID,
			ENTRY_ID,
		]);
		expect(
			state.findEntries({ order: "oldest_first" }).map((entry) => entry.id),
		).toEqual([ENTRY_ID, CHILD_A_ID, SECOND_ROOT_ID, CHILD_B_ID]);
	});

	test("filters by entry type and custom type", () => {
		const state = createQueryableState();

		expect(
			state.findEntries({ type: "message" }).map((entry) => entry.id),
		).toEqual([CHILD_B_ID]);
		expect(
			state
				.findEntries({ type: "custom", order: "oldest_first" })
				.map((entry) => entry.id),
		).toEqual([ENTRY_ID, SECOND_ROOT_ID]);
		expect(
			state.findEntries({ customType: "note" }).map((entry) => entry.id),
		).toEqual([SECOND_ROOT_ID]);
	});

	test("applies exclusive cursors and limits in the selected order", () => {
		const state = createQueryableState();

		expect(
			state
				.findEntries({
					order: "oldest_first",
					cursor: { afterSeq: 2 },
				})
				.map((entry) => entry.seq),
		).toEqual([3, 5]);
		expect(
			state
				.findEntries({ cursor: { afterSeq: 5 }, limit: 2 })
				.map((entry) => entry.seq),
		).toEqual([3, 2]);
	});

	test("walks only the selected branch and isolates siblings", () => {
		const state = createQueryableState();

		expect(
			state
				.findEntriesOnBranch({ startId: CHILD_B_ID })
				.map((entry) => entry.id),
		).toEqual([CHILD_B_ID, ENTRY_ID]);
		expect(
			state
				.findEntriesOnBranch({
					startId: SECOND_ROOT_ID,
					order: "oldest_first",
				})
				.map((entry) => entry.id),
		).toEqual([ENTRY_ID, CHILD_A_ID, SECOND_ROOT_ID]);
	});

	test("includes ID and type stopping bounds", () => {
		const state = createQueryableState();

		expect(
			state
				.findEntriesOnBranch({
					startId: SECOND_ROOT_ID,
					stopAtId: CHILD_A_ID,
				})
				.map((entry) => entry.id),
		).toEqual([SECOND_ROOT_ID, CHILD_A_ID]);
		expect(
			state
				.findEntriesOnBranch({
					startId: SECOND_ROOT_ID,
					stopAtType: "model_change",
				})
				.map((entry) => entry.id),
		).toEqual([SECOND_ROOT_ID, CHILD_A_ID]);
	});

	test("rejects missing branch starts", () => {
		const state = createQueryableState();

		expect(() =>
			state.findEntriesOnBranch({
				startId: "00000000-0000-4000-8000-000000000099",
			}),
		).toThrow("Entry not found");

		try {
			state.findEntriesOnBranch({
				startId: "00000000-0000-4000-8000-000000000099",
			});
		} catch (error) {
			expect(error).toBeInstanceOf(SessionError);
			expect((error as SessionError).code).toBe("not_found");
		}
	});

	test("rejects invalid limits, cursors, filters, and orders", () => {
		const state = createQueryableState();

		expectInvalidQuery(
			() => state.findEntries({ limit: 0 }),
			"limit must be a positive safe integer",
		);
		expectInvalidQuery(
			() => state.findEntries({ cursor: { afterSeq: -1 } }),
			"cursor afterSeq must be a non-negative safe integer",
		);
		expectInvalidQuery(
			() => state.findEntries({ type: "message", customType: "note" }),
			"customType cannot be combined",
		);
		expectInvalidQuery(
			() => state.findEntries({ order: "sideways" } as unknown as EntryQuery),
			"unknown order sideways",
		);
	});

	test("returns defensive copies from global and branch queries", () => {
		const state = createQueryableState();
		const globalEntry = state.findEntries({ order: "oldest_first" })[0];

		expect(globalEntry?.type).toBe("custom");
		if (globalEntry?.type !== "custom") {
			throw new Error("Expected custom entry");
		}
		const data = globalEntry.data as { nested: { value: number } };
		data.nested.value = 99;

		const branchEntry = state.findEntriesOnBranch({
			startId: CHILD_B_ID,
			order: "oldest_first",
		})[0];
		expect(branchEntry?.type).toBe("custom");
		if (branchEntry?.type !== "custom") {
			throw new Error("Expected custom branch entry");
		}
		expect(branchEntry.data).toEqual({ nested: { value: 1 } });
	});
});
