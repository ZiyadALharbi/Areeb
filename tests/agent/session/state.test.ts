import { describe, expect, test } from "bun:test";
import { SessionError } from "../../../src/agent/session/errors.ts";
import type {
	NewSessionEntry,
	ProvisionedSessionEntry,
	SessionEntry,
	SessionMutation,
} from "../../../src/agent/session/types.ts";
import type { AgentMessage } from "../../../src/agent/types.ts";
import type { Message } from "../../../src/ai/types.ts";

const ENTRY_ID = "00000000-0000-4000-8000-000000000001";

const entryBase = {
	id: ENTRY_ID,
	seq: 1,
	parentId: null,
	timestamp: 100,
};

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
