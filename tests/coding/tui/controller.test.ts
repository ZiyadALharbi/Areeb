import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySessionRepository } from "../../../src/agent/session/memory.ts";
import type {
	SessionHandle,
	SessionModel,
} from "../../../src/agent/session/types.ts";
import type {
	AgentEvent,
	AgentMessage,
	AgentRunStream,
} from "../../../src/agent/types.ts";
import { EventStream } from "../../../src/ai/event-stream.ts";
import type { ReasoningLevel, UserMessage } from "../../../src/ai/types.ts";
import type { CommandResult } from "../../../src/coding/commands.ts";
import type { CodingSessionHostServices } from "../../../src/coding/session.ts";
import {
	CodingSessionManager,
	type CodingSessionRecord,
} from "../../../src/coding/session-manager.ts";
import {
	TuiController,
	type TuiControllerSession,
	type TuiSessionManager,
} from "../../../src/coding/tui/controller.ts";

const FIRST_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_ID = "00000000-0000-4000-8000-000000000002";
const THIRD_ID = "00000000-0000-4000-8000-000000000003";

function user(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 1,
	};
}

class StubSession implements TuiControllerSession {
	readonly promptCalls: string[] = [];
	abortCount = 0;
	isRunning = false;

	constructor(
		readonly metadata: { readonly id: string; readonly cwd: string },
		readonly messages: readonly AgentMessage[] = [],
		readonly provider = "fake",
		readonly model = "model-a",
		readonly reasoning: ReasoningLevel = "low",
	) {}

	prompt(input: string): AgentRunStream {
		this.promptCalls.push(input);
		const stream = new EventStream<AgentEvent, AgentMessage[]>(
			() => false,
			() => [],
		);
		stream.end([]);
		return stream;
	}

	async handleCommand(
		input: string,
		services: CodingSessionHostServices = {},
	): Promise<CommandResult> {
		const trimmed = input.trim();
		if (trimmed === "/help") {
			return {
				handled: true,
				outcome: { kind: "message", level: "info", text: "help" },
			};
		}
		if (trimmed === "/new") {
			return services.sessionController === undefined
				? {
						handled: true,
						outcome: {
							kind: "unavailable",
							missingCapability: "session-controller",
						},
					}
				: { handled: true, outcome: { kind: "new-session" } };
		}
		if (trimmed === "/resume") {
			const sessions = await services.sessionController?.listSessions();
			return {
				handled: true,
				outcome: {
					kind: "message",
					level: "info",
					text:
						sessions?.map((session) => session.id).join("\n") ?? "unavailable",
				},
			};
		}
		const resumed = /^\/resume\s+(\S+)$/.exec(trimmed);
		if (resumed?.[1] !== undefined) {
			return {
				handled: true,
				outcome: { kind: "resume", sessionId: resumed[1] },
			};
		}
		return { handled: false };
	}

	abort(): void {
		this.abortCount += 1;
	}

	async waitForIdle(): Promise<void> {}
}

class MemoryManager implements TuiSessionManager {
	readonly cwd = "/project";
	private readonly repository = new MemorySessionRepository();
	private readonly records = new Map<string, CodingSessionRecord>();
	private nextId = SECOND_ID;

	async add(
		id: string,
		model: SessionModel | null = { provider: "fake", model: "model-a" },
		title = `Session ${id}`,
	): Promise<SessionHandle> {
		const handle = await this.repository.create({ id, cwd: this.cwd });
		this.records.set(id, {
			id,
			path: `/sessions/${id}.jsonl`,
			cwd: this.cwd,
			createdAt: this.records.size + 1,
			updatedAt: this.records.size + 1,
			title,
			model,
		});
		return handle;
	}

	async create(): Promise<SessionHandle> {
		const id = this.nextId;
		this.nextId = id === SECOND_ID ? THIRD_ID : crypto.randomUUID();
		return this.add(id);
	}

	async find(id: string): Promise<CodingSessionRecord | undefined> {
		return this.records.get(id);
	}

	async open(id: string): Promise<SessionHandle> {
		const metadata = await this.repository.find(id);
		if (metadata === undefined) {
			throw new Error(`Session not found: ${id}`);
		}
		return this.repository.open(metadata);
	}

	async list(): Promise<CodingSessionRecord[]> {
		return [...this.records.values()].sort(
			(left, right) => right.updatedAt - left.updatedAt,
		);
	}
}

async function createFixture(): Promise<{
	readonly manager: MemoryManager;
	readonly initial: StubSession;
	readonly candidates: Map<string, TuiControllerSession>;
	readonly controller: TuiController;
}> {
	const manager = new MemoryManager();
	await manager.add(FIRST_ID);
	const initial = new StubSession({ id: FIRST_ID, cwd: manager.cwd }, [
		user("old transcript"),
	]);
	const candidates = new Map<string, TuiControllerSession>();
	const controller = new TuiController({
		session: initial,
		manager,
		async loadSession({ handle, selection, reasoning }) {
			const metadata = await handle.getMetadata();
			const candidate =
				candidates.get(metadata.id) ??
				new StubSession(
					metadata,
					[],
					selection.provider,
					selection.model,
					reasoning,
				);
			return candidate;
		},
	});
	return { manager, initial, candidates, controller };
}

describe("TuiController", () => {
	test("requires consecutive /new confirmation and clears it on another submission", async () => {
		const { controller, initial } = await createFixture();

		expect(await controller.handleCommand("/new")).toMatchObject({
			outcome: {
				kind: "message",
				level: "warning",
				text: "Run /new again to confirm starting a new session",
			},
		});
		expect(await controller.handleCommand("/help")).toMatchObject({
			outcome: { text: "help" },
		});
		expect(await controller.handleCommand("/new")).toMatchObject({
			outcome: { kind: "message" },
		});
		expect(controller.session).toBe(initial);

		expect(await controller.handleCommand("/new")).toEqual({
			handled: true,
			outcome: { kind: "none" },
		});
		expect(controller.session).not.toBe(initial);
		expect(controller.metadata.id).toBe(SECOND_ID);
		expect(controller.state.items).toEqual([]);
	});

	test("rejects busy swaps without aborting and treats the active ID as a no-op", async () => {
		const { controller, initial } = await createFixture();
		initial.isRunning = true;

		expect(await controller.newSession()).toMatchObject({
			kind: "message",
			text: "Cannot start a new session while the current session is running",
		});
		expect(await controller.resumeSession(SECOND_ID)).toMatchObject({
			kind: "message",
			text: "Cannot resume a session while the current session is running",
		});
		expect(initial.abortCount).toBe(0);
		initial.isRunning = false;
		expect(await controller.resumeSession(FIRST_ID)).toEqual({
			kind: "message",
			level: "info",
			text: `Session ${FIRST_ID} is already active`,
		});
	});

	test("keeps the exact active bundle when loading or transcript projection fails", async () => {
		const fixture = await createFixture();
		await fixture.manager.add(THIRD_ID);
		const original = {
			session: fixture.controller.session,
			state: fixture.controller.state,
			adapter: fixture.controller.adapter,
		};
		const failing = new TuiController({
			session: fixture.initial,
			manager: fixture.manager,
			async loadSession() {
				throw new Error("provider unavailable");
			},
		});
		const failedState = failing.state;
		const failedSession = failing.session;
		expect(await failing.resumeSession(THIRD_ID)).toMatchObject({
			kind: "message",
			level: "error",
			text: `Failed to resume session ${THIRD_ID}: provider unavailable`,
		});
		expect(failing.state).toBe(failedState);
		expect(failing.session).toBe(failedSession);

		const brokenMessages = new Proxy([], {
			get(target, property, receiver) {
				if (property === Symbol.iterator) {
					throw new Error("projection failed");
				}
				return Reflect.get(target, property, receiver);
			},
		}) as AgentMessage[];
		fixture.candidates.set(
			THIRD_ID,
			new StubSession(
				{ id: THIRD_ID, cwd: fixture.manager.cwd },
				brokenMessages,
			),
		);
		expect(await fixture.controller.resumeSession(THIRD_ID)).toMatchObject({
			kind: "message",
			text: `Failed to resume session ${THIRD_ID}: projection failed`,
		});
		expect(fixture.controller.session).toBe(original.session);
		expect(fixture.controller.state).toBe(original.state);
		expect(fixture.controller.adapter).toBe(original.adapter);
	});

	test("restores the replacement transcript and delegates the next prompt to it", async () => {
		const { manager, candidates, controller, initial } = await createFixture();
		await manager.add(
			SECOND_ID,
			{ provider: "other", model: "model-b" },
			"Newer",
		);
		const replacement = new StubSession(
			{ id: SECOND_ID, cwd: manager.cwd },
			[user("restored transcript")],
			"other",
			"model-b",
			"high",
		);
		candidates.set(SECOND_ID, replacement);

		expect(await controller.resumeSession(SECOND_ID)).toEqual({ kind: "none" });
		expect(controller.session).toBe(replacement);
		expect(controller.state).toMatchObject({
			sessionId: SECOND_ID,
			model: "model-b",
			cwd: manager.cwd,
			items: [{ role: "user", text: "restored transcript" }],
		});
		controller.prompt("next prompt");
		expect(replacement.promptCalls).toEqual(["next prompt"]);
		expect(initial.promptCalls).toEqual([]);
	});

	test("lists only manager sessions and rejects unknown or model-less targets", async () => {
		const { manager, controller } = await createFixture();
		await manager.add(SECOND_ID, null, "Uninitialized");

		expect(await controller.handleCommand("/resume")).toMatchObject({
			outcome: { text: `${SECOND_ID}\n${FIRST_ID}` },
		});
		expect(await controller.resumeSession(SECOND_ID)).toEqual({
			kind: "message",
			level: "error",
			text: `Session ${SECOND_ID} has no stored provider/model selection`,
		});
		expect(await controller.resumeSession(THIRD_ID)).toEqual({
			kind: "message",
			level: "error",
			text: `Unknown session: ${THIRD_ID}`,
		});
		expect(controller.metadata.id).toBe(FIRST_ID);
	});

	test("rejects overlapping transitions until candidate loading settles", async () => {
		const { manager, controller } = await createFixture();
		await manager.add(THIRD_ID);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let loadStarted = false;
		const guarded = new TuiController({
			session: controller.session,
			manager,
			async loadSession({ handle }) {
				loadStarted = true;
				await gate;
				return new StubSession(await handle.getMetadata());
			},
		});

		await guarded.newSession();
		const loading = guarded.newSession();
		while (!loadStarted) {
			await Promise.resolve();
		}
		expect(await guarded.resumeSession(THIRD_ID)).toMatchObject({
			kind: "message",
			text: "Cannot switch sessions while another session change is in progress",
		});
		release();
		expect(await loading).toEqual({ kind: "none" });
	});

	test("keeps the previous JSONL file after starting a new session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-controller-jsonl-"));
		try {
			const ids = [FIRST_ID, SECOND_ID];
			const manager = new CodingSessionManager({
				cwd: join(directory, "project"),
				userRoot: join(directory, "user"),
				repositoryOptions: {
					sessionIdGenerator: () => ids.shift() ?? crypto.randomUUID(),
				},
			});
			const firstHandle = await manager.create();
			const firstMetadata = await firstHandle.getMetadata();
			const firstRecord = await manager.find(firstMetadata.id);
			if (firstRecord === undefined) {
				throw new Error("Expected initial session record");
			}
			const controller = new TuiController({
				session: new StubSession(firstMetadata),
				manager,
				async loadSession({ handle, selection, reasoning }) {
					return new StubSession(
						await handle.getMetadata(),
						[],
						selection.provider,
						selection.model,
						reasoning,
					);
				},
			});

			await controller.newSession();
			expect(await controller.newSession()).toEqual({ kind: "none" });
			expect(controller.metadata.id).toBe(SECOND_ID);
			await expect(access(firstRecord.path)).resolves.toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
