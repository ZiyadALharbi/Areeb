import { describe, expect, test } from "bun:test";
import type {
	SessionClock,
	SessionCreateOptions,
	SessionIdGenerator,
	SessionListOptions,
	SessionMetadata,
	SessionRepository,
} from "../../../src/agent/session/types.ts";
import type { AgentMessage } from "../../../src/agent/types.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000900";
const CWD = "/workspace/project";

export interface BackendConformanceOptions {
	readonly clock: SessionClock;
	readonly sessionIdGenerator: SessionIdGenerator;
	readonly entryIdGenerator: SessionIdGenerator;
}

export interface BackendConformanceInstance<TMetadata extends SessionMetadata> {
	repository: SessionRepository<
		TMetadata,
		SessionCreateOptions,
		SessionListOptions
	>;
	cleanup(): Promise<void>;
}

export type BackendConformanceFactory<TMetadata extends SessionMetadata> = (
	options: BackendConformanceOptions,
) => Promise<BackendConformanceInstance<TMetadata>>;

function uuid(index: number): string {
	return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function sequence<T>(values: readonly T[]): () => T {
	let index = 0;
	return () => {
		const value = values[index];
		if (value === undefined) {
			throw new Error("Conformance sequence exhausted");
		}
		index += 1;
		return value;
	};
}

function userMessage(text: string, timestamp: number): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	};
}

function userTexts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") {
			return [];
		}

		return message.content.flatMap((content) =>
			content.type === "text" ? [content.text] : [],
		);
	});
}

async function withBackend<TMetadata extends SessionMetadata>(
	factory: BackendConformanceFactory<TMetadata>,
	run: (
		repository: SessionRepository<
			TMetadata,
			SessionCreateOptions,
			SessionListOptions
		>,
	) => Promise<void>,
): Promise<void> {
	let timestamp = 1_000;
	const backend = await factory({
		clock: () => timestamp++,
		sessionIdGenerator: () => SESSION_ID,
		entryIdGenerator: sequence(
			Array.from({ length: 64 }, (_, index) => uuid(index + 1)),
		),
	});

	try {
		await run(backend.repository);
	} finally {
		await backend.cleanup();
	}
}

export function runBackendConformance<TMetadata extends SessionMetadata>(
	name: string,
	factory: BackendConformanceFactory<TMetadata>,
): void {
	describe(`${name} session backend conformance`, () => {
		test("round-trips rich messages and facts", async () => {
			await withBackend(factory, async (repository) => {
				const session = await repository.create({
					id: SESSION_ID,
					cwd: CWD,
					metadata: { nested: { value: 1 } },
				});
				const messages: AgentMessage[] = [
					{
						role: "user",
						content: [
							{ type: "text", text: "inspect this" },
							{
								type: "image",
								data: "aW1hZ2U=",
								mimeType: "image/png",
							},
						],
						timestamp: 10,
					},
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "reasoning" },
							{
								type: "tool_call",
								id: "call-1",
								name: "read",
								arguments: { path: "/tmp/file", nested: { limit: 10 } },
							},
						],
						provider: "openai",
						model: "model-a",
						usage: {
							inputTokens: 10,
							outputTokens: 5,
							cacheReadTokens: 2,
							cacheWriteTokens: 1,
							totalTokens: 18,
						},
						stopReason: "aborted",
						timestamp: 20,
					},
					{
						role: "tool_result",
						toolCallId: "call-1",
						toolName: "read",
						content: [
							{ type: "text", text: "result" },
							{
								type: "image",
								data: "cmVzdWx0",
								mimeType: "image/jpeg",
							},
						],
						details: { durationMs: 25, truncated: false },
						isError: false,
						timestamp: 30,
					},
					{
						role: "assistant",
						content: [],
						provider: "openai",
						model: "model-a",
						usage: {
							inputTokens: 4,
							outputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							totalTokens: 4,
						},
						stopReason: "error",
						errorMessage: "provider unavailable",
						timestamp: 40,
					},
				];

				const ids: string[] = [];
				for (const message of messages) {
					ids.push(await session.appendMessage(message));
				}
				await session.setName("Research");
				await session.setLabel(ids[0] as string, "checkpoint");

				const listed = await repository.list({ cwd: CWD });
				const listedMetadata = listed[0];
				if (listedMetadata === undefined) {
					throw new Error("Expected listed session");
				}
				const reopened = await repository.open(listedMetadata);
				const entries = await reopened.findEntries({
					type: "message",
					order: "oldest_first",
				});

				expect(
					entries.map((entry) =>
						entry.type === "message" ? entry.message : undefined,
					),
				).toEqual(messages);
				expect(await reopened.getName()).toBe("Research");
				expect(await reopened.getLabel(ids[0] as string)).toBe("checkpoint");
			});
		});

		test("creates branches, isolates siblings, and supports new roots", async () => {
			await withBackend(factory, async (repository) => {
				const session = await repository.create({ id: SESSION_ID, cwd: CWD });
				const rootId = await session.appendMessage(userMessage("root", 10));
				const siblingAId = await session.appendMessage(
					userMessage("sibling-a", 20),
				);
				await session.moveLeaf(rootId);
				const siblingBId = await session.appendMessage(
					userMessage("sibling-b", 30),
				);

				expect(
					(await session.getChildren(rootId)).map((entry) => entry.id),
				).toEqual([siblingAId, siblingBId]);
				expect(userTexts((await session.buildContext()).messages)).toEqual([
					"root",
					"sibling-b",
				]);

				const listedMetadata = (await repository.list())[0];
				if (listedMetadata === undefined) {
					throw new Error("Expected listed session");
				}
				const reopened = await repository.open(listedMetadata);
				expect(await reopened.getLeafId()).toBe(siblingBId);

				await reopened.moveLeaf(null);
				expect((await reopened.buildContext()).messages).toEqual([]);
				const newRootId = await reopened.appendMessage(
					userMessage("new-root", 40),
				);
				expect((await reopened.getEntry(newRootId))?.parentId).toBeNull();
				expect(userTexts((await reopened.buildContext()).messages)).toEqual([
					"new-root",
				]);
			});
		});

		test("uses the newest compaction and resolves full-path configuration", async () => {
			await withBackend(factory, async (repository) => {
				const session = await repository.create({ id: SESSION_ID, cwd: CWD });
				await session.appendEntry({
					type: "model_change",
					provider: "openai",
					model: "model-a",
				});
				await session.appendEntry({
					type: "reasoning_change",
					reasoning: "high",
				});
				await session.appendEntry({
					type: "active_tools_change",
					activeToolNames: [],
				});
				const sourceLeafId = await session.appendMessage(
					userMessage("discarded root", 10),
				);
				await session.appendEntry({
					type: "compaction",
					summary: "Old checkpoint",
					retainedTail: [userMessage("old tail", 15)],
					tokensBefore: 500,
				});
				await session.appendMessage(userMessage("discarded middle", 20));
				await session.appendEntry({
					type: "compaction",
					summary: "Current checkpoint",
					retainedTail: [
						userMessage("retained one", 25),
						userMessage("retained two", 30),
					],
					tokensBefore: 1_000,
				});
				await session.appendEntry({
					type: "model_change",
					provider: "openai",
					model: "model-b",
				});
				await session.appendMessage(userMessage("after checkpoint", 35));
				await session.appendEntry({
					type: "branch_summary",
					sourceLeafId,
					summary: "Abandoned path",
				});
				await session.appendCustomEntry("ignored", { text: "hidden" });
				await session.appendCustomEntry("projected", { text: "visible" });

				const context = await session.buildContext({
					customEntryProjectors: {
						projected: (entry) => [
							userMessage("custom projection", entry.timestamp),
						],
					},
				});

				expect(context.model).toEqual({
					provider: "openai",
					model: "model-b",
				});
				expect(context.reasoning).toBe("high");
				expect(context.activeToolNames).toEqual([]);
				expect(context.messages).toEqual([
					{
						role: "session_compaction",
						summary: "Current checkpoint",
						tokensBefore: 1_000,
						timestamp: 1_007,
					},
					userMessage("retained one", 25),
					userMessage("retained two", 30),
					userMessage("after checkpoint", 35),
					{
						role: "session_branch_summary",
						summary: "Abandoned path",
						sourceLeafId,
						timestamp: 1_010,
					},
					userMessage("custom projection", 1_012),
				]);
			});
		});

		test("serializes concurrent writes with unique sequences", async () => {
			await withBackend(factory, async (repository) => {
				const session = await repository.create({ id: SESSION_ID, cwd: CWD });
				await Promise.all(
					Array.from({ length: 16 }, (_, index) =>
						session.appendCustomEntry("concurrent", { index }),
					),
				);

				const entries = await session.findEntries({ order: "oldest_first" });
				expect(entries.map((entry) => entry.seq)).toEqual(
					Array.from({ length: 16 }, (_, index) => index + 1),
				);
				expect(new Set(entries.map((entry) => entry.id)).size).toBe(16);
				for (let index = 1; index < entries.length; index += 1) {
					expect(entries[index]?.parentId).toBe(entries[index - 1]?.id);
				}
			});
		});

		test("returns defensive metadata and entry snapshots", async () => {
			await withBackend(factory, async (repository) => {
				const session = await repository.create({
					id: SESSION_ID,
					cwd: CWD,
					metadata: { nested: { value: 1 } },
				});
				const entryId = await session.appendCustomEntry("note", {
					nested: { value: 1 },
				});

				const entry = await session.getEntry(entryId);
				if (entry?.type !== "custom") {
					throw new Error("Expected custom entry");
				}
				(entry.data as { nested: { value: number } }).nested.value = 99;

				const metadata = await session.getMetadata();
				if (metadata.metadata === undefined) {
					throw new Error("Expected session metadata");
				}
				(metadata.metadata.nested as { value: number }).value = 99;

				const reread = await session.getEntry(entryId);
				expect(reread?.type).toBe("custom");
				if (reread?.type !== "custom") {
					throw new Error("Expected custom entry");
				}
				expect(reread.data).toEqual({ nested: { value: 1 } });
				expect((await session.getMetadata()).metadata).toEqual({
					nested: { value: 1 },
				});
			});
		});
	});
}
