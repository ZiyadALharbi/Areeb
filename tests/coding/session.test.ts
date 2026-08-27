import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { JsonlSessionRepository } from "../../src/agent/session/jsonl/repository.ts";
import { MemorySessionRepository } from "../../src/agent/session/memory.ts";
import type {
	SessionHandle,
	SessionMetadata,
} from "../../src/agent/session/types.ts";
import type { AgentMessage } from "../../src/agent/types.ts";
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "../../src/ai/event-stream.ts";
import type { AssistantMessageEvent } from "../../src/ai/events.ts";
import { FakeProvider } from "../../src/ai/fake_provider.ts";
import type {
	ModelProvider,
	StreamOptions,
} from "../../src/ai/provider_protocol.ts";
import type {
	AssistantContent,
	ModelContext,
	ToolCall,
	UserMessage,
} from "../../src/ai/types.ts";
import { areebPaths } from "../../src/coding/paths.ts";
import {
	CodingSession,
	type CodingSessionConfig,
} from "../../src/coding/session.ts";
import type { CodingToolDefinition } from "../../src/coding/types.ts";

type DoneMessage = Extract<AssistantMessageEvent, { type: "done" }>["message"];
type ErrorMessage = Extract<
	AssistantMessageEvent,
	{ type: "error" }
>["message"];

const EMPTY_USAGE = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};
const EMPTY_RESOURCE_PATHS = areebPaths({
	cwd: "/workspace",
	userRoot: join(tmpdir(), `areeb-tests-${process.pid}-missing-user`),
	agentsRoot: join(tmpdir(), `areeb-tests-${process.pid}-missing-agents`),
});

function user(text: string, timestamp = 1): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	};
}

function assistant(
	content: AssistantContent[],
	stopReason: DoneMessage["stopReason"] = "stop",
	timestamp = 2,
): DoneMessage {
	return {
		role: "assistant",
		content,
		provider: "fake",
		model: "stored-model",
		usage: { ...EMPTY_USAGE },
		stopReason,
		timestamp,
	};
}

function failedAssistant(
	stopReason: ErrorMessage["stopReason"],
	errorMessage: string,
	timestamp = 2,
): ErrorMessage {
	return {
		role: "assistant",
		content: [],
		provider: "fake",
		model: "stored-model",
		usage: { ...EMPTY_USAGE },
		stopReason,
		errorMessage,
		timestamp,
	};
}

function doneScript(message: DoneMessage): AssistantMessageEvent[] {
	return [
		{ type: "start", partial: { ...message, stopReason: "stop" } },
		{ type: "done", message },
	];
}

function errorScript(message: ErrorMessage): AssistantMessageEvent[] {
	return [
		{ type: "start", partial: { ...message, stopReason: "stop" } },
		{ type: "error", message },
	];
}

function textScript(text: string, timestamp = 2): AssistantMessageEvent[] {
	return doneScript(assistant([{ type: "text", text }], "stop", timestamp));
}

function toolCall(id: string, name = "work"): ToolCall {
	return { type: "tool_call", id, name, arguments: {} };
}

function messageText(message: AgentMessage | undefined): string | undefined {
	if (
		typeof message !== "object" ||
		message === null ||
		!("content" in message) ||
		!Array.isArray(message.content)
	) {
		return undefined;
	}
	const content = message.content[0];
	return content?.type === "text" ? content.text : undefined;
}

async function createMemorySession(cwd = "/workspace"): Promise<SessionHandle> {
	return new MemorySessionRepository().create({ cwd });
}

function config<TMetadata extends SessionMetadata>(
	session: SessionHandle<TMetadata>,
	provider: ModelProvider,
	overrides: Partial<
		Omit<CodingSessionConfig<TMetadata>, "session" | "provider">
	> = {},
): CodingSessionConfig<TMetadata> {
	return {
		session,
		provider,
		model: "default-model",
		reasoning: "low",
		systemPrompt: "You are Areeb.",
		resourcePaths: EMPTY_RESOURCE_PATHS,
		...overrides,
	};
}

function deferred<T = void>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function seedRuntime(
	session: SessionHandle,
	options: {
		provider?: string;
		model?: string;
		reasoning?: CodingSessionConfig["reasoning"];
		activeToolNames?: string[];
	} = {},
): Promise<void> {
	await session.appendEntry({
		type: "model_change",
		provider: options.provider ?? "fake",
		model: options.model ?? "stored-model",
	});
	await session.appendEntry({
		type: "reasoning_change",
		reasoning: options.reasoning ?? "high",
	});
	await session.appendEntry({
		type: "active_tools_change",
		activeToolNames: options.activeToolNames ?? [],
	});
}

async function waitUntil(
	predicate: () => boolean,
	description: string,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) {
			return;
		}
		await Promise.resolve();
	}
	throw new Error(`Timed out waiting for ${description}`);
}

class ControlledProvider implements ModelProvider {
	readonly providerId = "fake";
	readonly calls: {
		model: string;
		context: ModelContext;
		options?: StreamOptions;
	}[] = [];
	private stream: AssistantMessageEventStream | undefined;
	private settled = false;

	streamResponse(
		model: string,
		context: ModelContext,
		options?: StreamOptions,
	): AssistantMessageEventStream {
		this.calls.push({ model, context, ...(options ? { options } : {}) });
		const stream = createAssistantMessageEventStream();
		this.stream = stream;
		stream.push({
			type: "start",
			partial: { ...assistant([]), model },
		});
		options?.signal?.addEventListener(
			"abort",
			() => {
				if (this.settled) {
					return;
				}
				this.settled = true;
				stream.push({
					type: "error",
					message: { ...failedAssistant("aborted", "aborted"), model },
				});
			},
			{ once: true },
		);
		return stream;
	}

	finish(text = "done"): void {
		if (!this.stream || this.settled) {
			throw new Error("Controlled provider is not waiting");
		}
		this.settled = true;
		this.stream.push({
			type: "done",
			message: assistant([{ type: "text", text }]),
		});
	}
}

describe("CodingSession loading", () => {
	test("initializes an empty session in model, reasoning, and tool order", async () => {
		const session = await createMemorySession();
		const coding = await CodingSession.load(
			config(session, new FakeProvider([])),
		);
		const entries = await session.findEntries({ order: "oldest_first" });

		expect(entries.map((entry) => entry.type)).toEqual([
			"model_change",
			"reasoning_change",
			"active_tools_change",
		]);
		expect(entries[0]).toMatchObject({
			provider: "fake",
			model: "default-model",
		});
		expect(entries[1]).toMatchObject({ reasoning: "low" });
		expect(entries[2]).toMatchObject({
			activeToolNames: ["read", "write", "edit", "bash"],
		});
		expect(coding.model).toBe("default-model");
		expect(coding.reasoning).toBe("low");
		expect(coding.tools.map((tool) => tool.name)).toEqual([
			"read",
			"write",
			"edit",
			"bash",
		]);
		expect(coding.metadata.cwd).toBe("/workspace");
		expect(coding.messages).toEqual([]);
		expect(coding.isRunning).toBe(false);
	});

	test("binds built-ins to metadata cwd and respects exact tool overrides", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "areeb-coding-session-"));
		try {
			await writeFile(join(cwd, "project.txt"), "from session cwd");
			const builtInSession = await createMemorySession(cwd);
			const builtIn = await CodingSession.load(
				config(builtInSession, new FakeProvider([])),
			);
			const readResult = await builtIn.tools[0]?.execute({
				path: "project.txt",
			});
			expect(readResult?.content).toEqual([
				{ type: "text", text: "from session cwd" },
			]);

			const noToolSession = await createMemorySession(cwd);
			const noTools = await CodingSession.load(
				config(noToolSession, new FakeProvider([]), { tools: [] }),
			);
			expect(noTools.tools).toEqual([]);
			expect((await noToolSession.buildContext()).activeToolNames).toEqual([]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("restores branch runtime state, transcript, and active tool order", async () => {
		const session = await createMemorySession();
		await seedRuntime(session, { activeToolNames: ["beta"] });
		await session.appendMessage(user("historical", 10));
		const alpha: CodingToolDefinition = {
			name: "alpha",
			description: "Alpha",
			promptSnippet: "Run alpha",
			promptGuidelines: ["Use alpha carefully"],
			inputSchema: z.object({}),
			async executor() {
				return { content: [] };
			},
		};
		const beta = {
			...alpha,
			name: "beta",
			promptSnippet: "Run beta",
		};
		const provider = new FakeProvider([textScript("resumed")]);
		const coding = await CodingSession.load(
			config(session, provider, {
				model: "ignored-default",
				reasoning: "max",
				systemPrompt: undefined,
				tools: [alpha, beta],
				timeout: 50,
			}),
		);

		expect(coding.model).toBe("stored-model");
		expect(coding.reasoning).toBe("high");
		expect(coding.tools.map((tool) => tool.name)).toEqual(["beta"]);
		expect(coding.systemPrompt).toContain("- beta: Run beta");
		expect(coding.systemPrompt).not.toContain("- alpha: Run alpha");
		expect(coding.messages.map(messageText)).toEqual(["historical"]);

		await coding.continue().result();
		expect(provider.calls[0]).toMatchObject({
			model: "stored-model",
			options: { reasoning: "high", timeout: 50 },
		});
		expect(provider.calls[0]?.context.systemPrompt).toBe(coding.systemPrompt);
		expect(provider.calls[0]?.context.messages.map(messageText)).toEqual([
			"historical",
		]);
	});

	test("rejects provider mismatches and unavailable restored tools", async () => {
		const mismatched = await createMemorySession();
		await seedRuntime(mismatched, { provider: "other" });
		await expect(
			CodingSession.load(config(mismatched, new FakeProvider([]))),
		).rejects.toThrow('Stored provider "other"');

		const unavailable = await createMemorySession();
		await seedRuntime(unavailable, { activeToolNames: ["missing"] });
		await expect(
			CodingSession.load(
				config(unavailable, new FakeProvider([]), { tools: [] }),
			),
		).rejects.toThrow("Stored active tool is unavailable: missing");
	});

	test("stages model reconstruction before durably committing the new runtime", async () => {
		const session = await createMemorySession();
		await seedRuntime(session);
		const provider = new FakeProvider([textScript("switched")], {
			providerId: "other",
		});
		const prepared = await CodingSession.prepareModelChange(
			config(session, provider, {
				model: "org/model/version",
				tools: [],
				timeout: 321,
			}),
		);

		expect(prepared.session).toMatchObject({
			provider: "other",
			model: "org/model/version",
			reasoning: "high",
		});
		expect((await session.buildContext()).model).toEqual({
			provider: "fake",
			model: "stored-model",
		});

		await prepared.commit();
		expect((await session.buildContext()).model).toEqual({
			provider: "other",
			model: "org/model/version",
		});
		await prepared.session.prompt("after switch").result();
		expect(provider.calls[0]).toMatchObject({
			model: "org/model/version",
			options: { reasoning: "high", timeout: 321 },
		});
		await expect(prepared.commit()).rejects.toThrow("already been committed");
	});

	test("leaves the stored model unchanged when a staged commit fails", async () => {
		const session = await createMemorySession();
		await seedRuntime(session);
		const failingSession = new Proxy(session, {
			get(target, property) {
				if (property === "appendEntry") {
					return async (entry: { type: string }) => {
						if (entry.type === "model_change") {
							throw new Error("model storage failed");
						}
						return target.appendEntry(entry as never);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const prepared = await CodingSession.prepareModelChange(
			config(failingSession, new FakeProvider([], { providerId: "other" }), {
				model: "model-b",
				tools: [],
			}),
		);

		await expect(prepared.commit()).rejects.toThrow("model storage failed");
		expect((await session.buildContext()).model).toEqual({
			provider: "fake",
			model: "stored-model",
		});
	});
});

describe("CodingSession reasoning changes", () => {
	test("persists one actual change, updates the next request, and restores it", async () => {
		const handle = await createMemorySession();
		const provider = new FakeProvider([textScript("updated")]);
		const coding = await CodingSession.load(
			config(handle, provider, { tools: [] }),
		);

		await coding.setReasoning("max");
		await coding.setReasoning("max");
		expect(coding.reasoning).toBe("max");
		expect(
			(await handle.findEntries({ type: "reasoning_change" })).filter(
				(entry) => entry.type === "reasoning_change",
			),
		).toHaveLength(2);

		await coding.prompt("use max").result();
		expect(provider.calls[0]?.options?.reasoning).toBe("max");

		const reopened = await CodingSession.load(
			config(handle, new FakeProvider([]), {
				reasoning: "off",
				tools: [],
			}),
		);
		expect(reopened.reasoning).toBe("max");
	});

	test("restores the latest reasoning change from only the reopened branch", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-reasoning-branch-"));
		try {
			const firstRepository = new JsonlSessionRepository(directory);
			const firstHandle = await firstRepository.create({ cwd: "/workspace" });
			await seedRuntime(firstHandle, { reasoning: "low" });
			const branchPoint = await firstHandle.getLeafId();
			if (branchPoint === null) {
				throw new Error("Expected a branch point");
			}

			await firstHandle.appendEntry({
				type: "reasoning_change",
				reasoning: "high",
			});
			const highLeaf = await firstHandle.getLeafId();
			if (highLeaf === null) {
				throw new Error("Expected a high-effort branch leaf");
			}
			await firstHandle.moveLeaf(branchPoint);
			await firstHandle.appendEntry({
				type: "reasoning_change",
				reasoning: "max",
			});

			const secondRepository = new JsonlSessionRepository(directory);
			const metadata = (await secondRepository.list())[0];
			if (metadata === undefined) {
				throw new Error("Expected stored session metadata");
			}
			const reopenedHandle = await secondRepository.open(metadata);
			const maxBranch = await CodingSession.load(
				config(reopenedHandle, new FakeProvider([]), { tools: [] }),
			);
			expect(maxBranch.reasoning).toBe("max");

			await reopenedHandle.moveLeaf(highLeaf);
			const highBranch = await CodingSession.load(
				config(reopenedHandle, new FakeProvider([]), { tools: [] }),
			);
			expect(highBranch.reasoning).toBe("high");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("keeps runtime unchanged when persistence fails", async () => {
		const handle = await createMemorySession();
		await seedRuntime(handle, { reasoning: "low" });
		const failingHandle = new Proxy(handle, {
			get(target, property) {
				if (property === "appendEntry") {
					return async (entry: { type: string }) => {
						if (entry.type === "reasoning_change") {
							throw new Error("reasoning storage failed");
						}
						return target.appendEntry(entry as never);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const provider = new FakeProvider([textScript("unchanged")]);
		const coding = await CodingSession.load(
			config(failingHandle, provider, { tools: [] }),
		);

		await expect(coding.setReasoning("high")).rejects.toThrow(
			"reasoning storage failed",
		);
		expect(coding.reasoning).toBe("low");
		await coding.prompt("still low").result();
		expect(provider.calls[0]?.options?.reasoning).toBe("low");
	});

	test("blocks prompts, continuation, and overlapping changes while append is pending", async () => {
		const handle = await createMemorySession();
		await seedRuntime(handle, { reasoning: "low" });
		const appendStarted = deferred();
		const releaseAppend = deferred();
		const delayedHandle = new Proxy(handle, {
			get(target, property) {
				if (property === "appendEntry") {
					return async (entry: { type: string }) => {
						if (entry.type === "reasoning_change") {
							appendStarted.resolve();
							await releaseAppend.promise;
						}
						return target.appendEntry(entry as never);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const coding = await CodingSession.load(
			config(delayedHandle, new FakeProvider([]), { tools: [] }),
		);

		const changing = coding.setReasoning("high");
		await appendStarted.promise;
		expect(coding.reasoning).toBe("low");
		expect(() => coding.prompt("blocked")).toThrow();
		expect(() => coding.continue()).toThrow();
		await expect(coding.setReasoning("max")).rejects.toThrow();

		releaseAppend.resolve();
		await changing;
		expect(coding.reasoning).toBe("high");
	});

	test("rejects reasoning changes while a response is active", async () => {
		const handle = await createMemorySession();
		const provider = new ControlledProvider();
		const coding = await CodingSession.load(
			config(handle, provider, { tools: [] }),
		);
		const stream = coding.prompt("running");
		await waitUntil(() => provider.calls.length === 1, "provider request");

		await expect(coding.setReasoning("max")).rejects.toThrow(
			"agent is running",
		);
		expect(coding.reasoning).toBe("low");
		provider.finish();
		await stream.result();
	});
});

describe("CodingSession persistence", () => {
	test("persists a user prompt before a waiting provider completes", async () => {
		const session = await createMemorySession();
		const provider = new ControlledProvider();
		const coding = await CodingSession.load(
			config(session, provider, { tools: [] }),
		);
		const stream = coding.prompt("durable first");

		await waitUntil(() => provider.calls.length === 1, "provider request");
		const waitingEntries = await session.findEntries({
			type: "message",
			order: "oldest_first",
		});
		expect(waitingEntries).toHaveLength(1);
		expect(waitingEntries[0]).toMatchObject({
			message: { role: "user", content: [{ text: "durable first" }] },
		});

		provider.finish();
		await stream.result();
		expect(
			(await session.findEntries({ type: "message" })).map((entry) =>
				entry.type === "message" ? entry.message.role : undefined,
			),
		).toEqual(["assistant", "user"]);
	});

	test("persists assistant and tool-result messages exactly once in event order", async () => {
		const call = toolCall("call-1");
		const provider = new FakeProvider([
			doneScript(assistant([call], "tool_call", 2)),
			textScript("finished", 4),
		]);
		const tool: CodingToolDefinition = {
			name: "work",
			description: "Work",
			inputSchema: z.object({}),
			async executor() {
				return { content: [{ type: "text", text: "tool output" }] };
			},
		};
		const session = await createMemorySession();
		const coding = await CodingSession.load(
			config(session, provider, { tools: [tool] }),
		);

		await coding.prompt("run tool").result();
		const entries = await session.findEntries({
			type: "message",
			order: "oldest_first",
		});
		expect(
			entries.map((entry) =>
				entry.type === "message" ? entry.message.role : undefined,
			),
		).toEqual(["user", "assistant", "tool_result", "assistant"]);
		expect(entries).toHaveLength(4);
	});

	test("retains provider errors and aborted assistant messages", async () => {
		const errorSession = await createMemorySession();
		const errorProvider = new FakeProvider([
			errorScript(failedAssistant("error", "provider failed")),
		]);
		const withError = await CodingSession.load(
			config(errorSession, errorProvider, { tools: [] }),
		);
		await withError.prompt("fail").result();
		expect((await errorSession.buildContext()).messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "provider failed",
		});

		const abortSession = await createMemorySession();
		const abortProvider = new ControlledProvider();
		const withAbort = await CodingSession.load(
			config(abortSession, abortProvider, { tools: [] }),
		);
		const stream = withAbort.prompt("abort");
		await waitUntil(() => abortProvider.calls.length === 1, "provider request");
		withAbort.abort();
		await withAbort.waitForIdle();
		await stream.result();
		expect((await abortSession.buildContext()).messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
	});

	test("persists independently when a stream consumer stops early", async () => {
		const session = await createMemorySession();
		const coding = await CodingSession.load(
			config(session, new FakeProvider([textScript("background")]), {
				tools: [],
			}),
		);
		const stream = coding.prompt("start");

		for await (const _event of stream) {
			break;
		}
		await stream.result();
		expect((await session.buildContext()).messages.map(messageText)).toEqual([
			"start",
			"background",
		]);
	});

	test("continues restored history without persisting it twice", async () => {
		const session = await createMemorySession();
		await seedRuntime(session);
		await session.appendMessage(user("historical", 10));
		const provider = new FakeProvider([textScript("continued", 20)]);
		const coding = await CodingSession.load(
			config(session, provider, { tools: [] }),
		);

		await coding.continue().result();
		const messages = (await session.buildContext()).messages;
		expect(messages.map(messageText)).toEqual(["historical", "continued"]);
		expect(provider.calls[0]?.context.messages.map(messageText)).toEqual([
			"historical",
		]);
	});

	test("repairs interrupted tail calls and rejects malformed non-tail gaps", async () => {
		const repairSession = await createMemorySession();
		await seedRuntime(repairSession);
		await repairSession.appendMessage(
			assistant([toolCall("missing")], "tool_call"),
		);
		const repaired = await CodingSession.load(
			config(repairSession, new FakeProvider([]), { tools: [] }),
		);
		expect(repaired.messages.at(-1)).toMatchObject({
			role: "tool_result",
			toolCallId: "missing",
			isError: true,
		});
		expect((await repairSession.buildContext()).messages.at(-1)).toMatchObject({
			role: "tool_result",
			toolCallId: "missing",
		});

		const malformedSession = await createMemorySession();
		await seedRuntime(malformedSession);
		const first = toolCall("first");
		await malformedSession.appendMessage(
			assistant([first, toolCall("second")], "tool_call"),
		);
		await malformedSession.appendMessage({
			role: "tool_result",
			toolCallId: first.id,
			toolName: first.name,
			content: [],
			isError: false,
			timestamp: 3,
		});
		await malformedSession.appendMessage(user("later", 4));
		await expect(
			CodingSession.load(
				config(malformedSession, new FakeProvider([]), { tools: [] }),
			),
		).rejects.toThrow("Cannot repair malformed transcript");
	});

	test("round-trips persisted messages through a new JSONL repository", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-coding-jsonl-"));
		try {
			const firstRepository = new JsonlSessionRepository(directory);
			const firstHandle = await firstRepository.create({ cwd: "/workspace" });
			const first = await CodingSession.load(
				config(firstHandle, new FakeProvider([textScript("stored")]), {
					tools: [],
				}),
			);
			await first.prompt("persist").result();

			const secondRepository = new JsonlSessionRepository(directory);
			const metadata = (await secondRepository.list())[0];
			if (!metadata) {
				throw new Error("Expected stored session metadata");
			}
			const reopenedHandle = await secondRepository.open(metadata);
			const reopened = await CodingSession.load(
				config(reopenedHandle, new FakeProvider([]), { tools: [] }),
			);
			expect(reopened.messages.map(messageText)).toEqual(["persist", "stored"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("persists interrupted tool-call repair exactly once across JSONL reopens", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-coding-repair-"));
		try {
			const firstRepository = new JsonlSessionRepository(directory);
			const firstHandle = await firstRepository.create({ cwd: "/workspace" });
			await seedRuntime(firstHandle);
			await firstHandle.appendMessage(
				assistant([toolCall("interrupted")], "tool_call"),
			);

			const secondRepository = new JsonlSessionRepository(directory);
			const metadata = (await secondRepository.list())[0];
			if (metadata === undefined) {
				throw new Error("Expected stored session metadata");
			}
			await CodingSession.load(
				config(await secondRepository.open(metadata), new FakeProvider([]), {
					tools: [],
				}),
			);

			const thirdRepository = new JsonlSessionRepository(directory);
			const reopenedMetadata = (await thirdRepository.list())[0];
			if (reopenedMetadata === undefined) {
				throw new Error("Expected repaired session metadata");
			}
			const thirdHandle = await thirdRepository.open(reopenedMetadata);
			await CodingSession.load(
				config(thirdHandle, new FakeProvider([]), { tools: [] }),
			);
			const repairs = (
				await thirdHandle.findEntries({ type: "message" })
			).filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "tool_result" &&
					entry.message.toolCallId === "interrupted",
			);

			expect(repairs).toHaveLength(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("propagates persistence failures and requires a reload", async () => {
		const session = await createMemorySession();
		const failingSession = new Proxy(session, {
			get(target, property) {
				if (property === "appendMessage") {
					return async () => {
						throw new Error("storage failed");
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const provider = new FakeProvider([textScript("never requested")]);
		const coding = await CodingSession.load(
			config(failingSession, provider, { tools: [] }),
		);

		await expect(coding.prompt("fail to persist").result()).rejects.toThrow(
			"storage failed",
		);
		expect(provider.calls).toHaveLength(0);
		expect(() => coding.prompt("try again")).toThrow(
			"must be reopened after a persistence failure",
		);
	});
});

describe("CodingSession commands and queues", () => {
	test("delegates exact commands and leaves unknown slash input for prompting", async () => {
		const session = await createMemorySession();
		const coding = await CodingSession.load(
			config(session, new FakeProvider([]), { tools: [] }),
		);

		expect(await coding.handleCommand(" normal text ")).toEqual({
			handled: false,
		});
		const help = await coding.handleCommand("  /help  ");
		expect(help).toMatchObject({
			handled: true,
			outcome: { kind: "message", level: "info" },
		});
		if (!help.handled || help.outcome.kind !== "message") {
			throw new Error("Expected help message");
		}
		expect(help.outcome.text).toContain("/help");
		expect(help.outcome.text).toContain("/theme");
		expect(await coding.handleCommand("/quit")).toEqual({
			handled: true,
			outcome: { kind: "quit" },
		});
		expect(await coding.handleCommand("/exit")).toEqual({
			handled: true,
			outcome: { kind: "quit" },
		});
		expect(await coding.handleCommand("/new")).toEqual({
			handled: true,
			outcome: {
				kind: "unavailable",
				missingCapability: "session-controller",
			},
		});
		for (const input of [
			"/Help",
			"/skill:missing",
			"/unknown",
			"/tmp",
			"/Users/me/file.png",
		]) {
			expect(await coding.handleCommand(input)).toEqual({ handled: false });
		}
		expect(coding.steer("steer").count).toBe(1);
		expect(coding.followUp("follow up").count).toBe(2);
		expect(coding.queuedMessages.count).toBe(2);
		expect(coding.clearQueues().count).toBe(0);
	});

	test("enables only session-controller commands when that host service is supplied", async () => {
		const session = await createMemorySession();
		const coding = await CodingSession.load(
			config(session, new FakeProvider([]), { tools: [] }),
		);
		const services = {
			sessionController: {
				async listSessions() {
					return [
						{
							id: "00000000-0000-4000-8000-000000000001",
							title: "Stored session",
							model: { provider: "fake", model: "stored-model" },
						},
					];
				},
			},
		};

		expect(await coding.handleCommand("/new", services)).toEqual({
			handled: true,
			outcome: { kind: "new-session" },
		});
		expect(await coding.handleCommand("/resume", services)).toMatchObject({
			handled: true,
			outcome: { kind: "resume-picker" },
		});
		expect(await coding.handleCommand("/theme", services)).toEqual({
			handled: true,
			outcome: { kind: "unavailable", missingCapability: "tui" },
		});
		expect(await coding.handleCommand("/new")).toEqual({
			handled: true,
			outcome: {
				kind: "unavailable",
				missingCapability: "session-controller",
			},
		});
	});

	test("enables model commands only with a concrete reconstruction service", async () => {
		const session = await createMemorySession();
		const coding = await CodingSession.load(
			config(session, new FakeProvider([]), { tools: [] }),
		);
		const services = {
			modelController: {
				listModels: () => [
					{ provider: "fake", model: "default-model" },
					{ provider: "other", model: "org/model-b" },
				],
			},
		};

		expect(await coding.handleCommand("/model", services)).toEqual({
			handled: true,
			outcome: { kind: "model-picker" },
		});
		expect(
			await coding.handleCommand("/model other/org/model-b", services),
		).toEqual({
			handled: true,
			outcome: {
				kind: "set-model",
				provider: "other",
				model: "org/model-b",
			},
		});
		expect(await coding.handleCommand("/model")).toEqual({
			handled: true,
			outcome: {
				kind: "unavailable",
				missingCapability: "model-selection",
			},
		});
	});

	test("enables TUI commands only with a concrete TUI host service", async () => {
		const session = await createMemorySession();
		const coding = await CodingSession.load(
			config(session, new FakeProvider([]), { tools: [] }),
		);
		const services = {
			tui: {
				getThemeName: () => "areeb-dark",
				getThemeNames: () => ["areeb-dark", "areeb-light"],
				getHotkeys: () => [
					{ keys: "Ctrl+P", description: "Open the command palette" },
				],
			},
		};

		expect(await coding.handleCommand("/hotkeys", services)).toMatchObject({
			outcome: {
				kind: "message",
				text: "Keyboard shortcuts:\nCtrl+P — Open the command palette",
			},
		});
		expect(await coding.handleCommand("/theme", services)).toMatchObject({
			outcome: { kind: "theme-picker" },
		});
		expect(
			await coding.handleCommand("/theme areeb-light", services),
		).toMatchObject({
			outcome: { kind: "set-theme", theme: "areeb-light" },
		});
		expect(await coding.handleCommand("/hotkeys")).toEqual({
			handled: true,
			outcome: { kind: "unavailable", missingCapability: "tui" },
		});
	});

	test("shows session information and persists valid session names", async () => {
		const session = await createMemorySession("/workspace/project");
		const coding = await CodingSession.load(
			config(session, new FakeProvider([]), { tools: [] }),
		);
		const metadata = await session.getMetadata();

		expect(await coding.handleCommand("/name")).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "info",
				text: "Session name: (unnamed)",
			},
		});
		expect(await coding.handleCommand("/name   Registry work  ")).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "info",
				text: "Session name set to: Registry work",
			},
		});
		expect(await session.getName()).toBe("Registry work");
		expect(await coding.handleCommand("/name invalid\nname")).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "error",
				text: "Usage: /name [text] (name must be a single line)",
			},
		});

		const result = await coding.handleCommand("/session");
		if (!result.handled || result.outcome.kind !== "message") {
			throw new Error("Expected session information");
		}
		expect(result.outcome.text).toBe(`Session ID: ${metadata.id}
Name: Registry work
Working directory: /workspace/project
Provider: fake
Model: default-model
Reasoning: low
Messages: 0
Running: no
Context files: 0
Resource diagnostics: 0 warnings, 0 info`);
	});

	test("persists command names across reopen and propagates command failures", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-command-name-"));
		try {
			const firstRepository = new JsonlSessionRepository(directory);
			const firstHandle = await firstRepository.create({ cwd: "/workspace" });
			const first = await CodingSession.load(
				config(firstHandle, new FakeProvider([]), { tools: [] }),
			);
			await first.handleCommand("/name Persistent name");

			const secondRepository = new JsonlSessionRepository(directory);
			const metadata = (await secondRepository.list())[0];
			if (!metadata) {
				throw new Error("Expected stored session metadata");
			}
			expect(await (await secondRepository.open(metadata)).getName()).toBe(
				"Persistent name",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}

		const session = await createMemorySession();
		const failingSession = new Proxy(session, {
			get(target, property) {
				if (property === "setName") {
					return async () => {
						throw new Error("name storage failed");
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const provider = new FakeProvider([]);
		const coding = await CodingSession.load(
			config(failingSession, provider, { tools: [] }),
		);
		await expect(coding.handleCommand("/name Failed")).rejects.toThrow(
			"name storage failed",
		);
		expect(provider.calls).toHaveLength(0);
	});

	test("loads immutable resource snapshots with project trust disabled by default", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-session-resources-"));
		try {
			const cwd = join(directory, "project");
			const paths = areebPaths({
				cwd,
				userRoot: join(directory, "user"),
				agentsRoot: join(directory, "agents"),
			});
			await mkdir(join(paths.userAgentSkills, "shared"), { recursive: true });
			await mkdir(join(paths.projectAgentSkills, "shared"), {
				recursive: true,
			});
			await mkdir(paths.userSkills, { recursive: true });
			await mkdir(paths.userPrompts, { recursive: true });
			await mkdir(paths.projectSkills, { recursive: true });
			await mkdir(paths.projectPrompts, { recursive: true });
			await writeFile(join(paths.userRoot, "AGENTS.md"), "User context.");
			await writeFile(join(cwd, "AGENTS.md"), "Project context.");
			await writeFile(
				join(paths.userAgentSkills, "shared", "SKILL.md"),
				"---\ndescription: User shared skill.\n---\nUser agents body.",
			);
			await writeFile(
				join(paths.userSkills, "review.md"),
				"---\ndescription: Review code.\n---\nReview carefully.",
			);
			await writeFile(
				join(paths.userSkills, "shared.md"),
				"---\ndescription: User Areeb override.\n---\nUser Areeb body.",
			);
			await writeFile(join(paths.userPrompts, "shared.md"), "User prompt.");
			await writeFile(
				join(paths.projectAgentSkills, "shared", "SKILL.md"),
				"---\ndescription: Project shared skill.\n---\nProject agents body.",
			);
			await writeFile(join(paths.projectPrompts, "private.md"), "Private.");
			await writeFile(
				join(paths.projectPrompts, "shared.md"),
				"Project prompt.",
			);
			await writeFile(
				join(paths.projectSkills, "private.md"),
				"---\ndescription: Project-only instructions.\n---\nPrivate skill.",
			);
			await writeFile(
				join(paths.projectSkills, "shared.md"),
				"---\ndescription: Project Areeb override.\n---\nProject Areeb body.",
			);

			const session = await createMemorySession(cwd);
			const coding = await CodingSession.load(
				config(session, new FakeProvider([]), {
					systemPrompt: undefined,
					resourcePaths: paths,
					contextFiles: [{ path: "explicit", content: "Explicit context." }],
				}),
			);
			expect(coding.skills.map((skill) => skill.name)).toEqual([
				"review",
				"shared",
			]);
			expect(
				coding.skills.find((skill) => skill.name === "shared")?.content,
			).toBe("User Areeb body.");
			expect(coding.promptTemplates.map((template) => template.name)).toEqual([
				"shared",
			]);
			expect(coding.resourceDiagnostics).toMatchObject([
				{
					kind: "skill",
					code: "overridden",
					severity: "info",
					name: "shared",
				},
			]);
			const resources = await coding.handleCommand("/resources");
			if (!resources.handled || resources.outcome.kind !== "message") {
				throw new Error("Expected resource summary");
			}
			expect(resources.outcome.text).toContain("Skills loaded: 2");
			expect(resources.outcome.text).toContain("Prompt templates loaded: 1");
			expect(resources.outcome.text).toContain(
				"Project context files loaded: 3",
			);
			expect(coding.systemPrompt).toContain("User context.");
			expect(coding.systemPrompt).toContain("Project context.");
			expect(coding.systemPrompt.indexOf("User context.")).toBeLessThan(
				coding.systemPrompt.indexOf("Project context."),
			);

			await writeFile(
				join(paths.userSkills, "later.md"),
				"---\ndescription: Loaded after reopen.\n---\nLater body.",
			);
			expect(coding.skills.map((skill) => skill.name)).toEqual([
				"review",
				"shared",
			]);
			const exposed = coding.skills;
			(exposed[0] as { name: string }).name = "changed";
			expect(coding.skills[0]?.name).toBe("review");
			const exposedDiagnostics = coding.resourceDiagnostics;
			expect(() => {
				(exposedDiagnostics[0] as { message: string }).message = "changed";
			}).toThrow();
			expect(coding.resourceDiagnostics[0]?.message).not.toBe("changed");

			const trustedSession = await createMemorySession(cwd);
			const trusted = await CodingSession.load(
				config(trustedSession, new FakeProvider([]), {
					systemPrompt: undefined,
					resourcePaths: paths,
					trustProjectResources: true,
					contextFiles: [{ path: "explicit", content: "Explicit context." }],
				}),
			);
			expect(trusted.skills.map((skill) => skill.name)).toEqual([
				"later",
				"private",
				"review",
				"shared",
			]);
			expect(
				trusted.skills.find((skill) => skill.name === "shared")?.content,
			).toBe("Project Areeb body.");
			expect(trusted.systemPrompt).toContain("<name>private</name>");
			expect(trusted.systemPrompt).toContain("Project context.");
			expect(trusted.systemPrompt.indexOf("Project context.")).toBeLessThan(
				trusted.systemPrompt.indexOf("Explicit context."),
			);
			expect(trusted.promptTemplates.map((template) => template.name)).toEqual([
				"private",
				"shared",
			]);
			expect(
				trusted.promptTemplates.find((template) => template.name === "shared")
					?.content,
			).toBe("Project prompt.");
			expect(
				trusted.resourceDiagnostics.filter(
					(diagnostic) => diagnostic.code === "overridden",
				),
			).toHaveLength(4);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("gates project discovery, recovers resource failures, and keeps context strict", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-session-trust-"));
		try {
			const cwd = join(directory, "project");
			const paths = areebPaths({
				cwd,
				userRoot: join(directory, "user"),
				agentsRoot: join(directory, "agents"),
			});
			await mkdir(join(paths.projectAgentSkills, "invalid"), {
				recursive: true,
			});
			await mkdir(paths.projectSkills, { recursive: true });
			await mkdir(paths.projectPrompts, { recursive: true });
			await writeFile(
				join(paths.projectAgentSkills, "invalid", "SKILL.md"),
				"Missing required metadata.",
			);
			await writeFile(
				join(paths.projectSkills, "invalid.md"),
				"Missing required metadata.",
			);
			await writeFile(join(paths.projectPrompts, "help.md"), "Reserved.");
			await writeFile(join(paths.projectPrompts, "skill.md"), "Reserved.");

			const untrustedSession = await createMemorySession(cwd);
			const untrusted = await CodingSession.load(
				config(untrustedSession, new FakeProvider([]), {
					resourcePaths: paths,
				}),
			);
			expect(untrusted.resourceDiagnostics).toEqual([]);

			const trustedSession = await createMemorySession(cwd);
			const trusted = await CodingSession.load(
				config(trustedSession, new FakeProvider([]), {
					resourcePaths: paths,
					trustProjectResources: true,
				}),
			);
			expect(trusted.skills).toEqual([]);
			expect(trusted.promptTemplates).toEqual([]);
			expect(
				trusted.resourceDiagnostics.map((diagnostic) => diagnostic.code),
			).toEqual([
				"validation-failed",
				"validation-failed",
				"validation-failed",
				"validation-failed",
			]);

			await mkdir(join(cwd, "AGENTS.override.md"));
			const invalidContextSession = await createMemorySession(cwd);
			await expect(
				CodingSession.load(
					config(invalidContextSession, new FakeProvider([]), {
						resourcePaths: paths,
						trustProjectResources: true,
					}),
				),
			).rejects.toThrow();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("reloads create, edit, delete, and no-op changes without replacing session state", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-session-reload-"));
		try {
			const cwd = join(directory, "project");
			const paths = areebPaths({
				cwd,
				userRoot: join(directory, "user"),
				agentsRoot: join(directory, "agents"),
			});
			await mkdir(paths.userRoot, { recursive: true });
			await mkdir(paths.agentsRoot, { recursive: true });
			await mkdir(paths.userSkills, { recursive: true });
			await mkdir(paths.userPrompts, { recursive: true });
			const contextPath = join(paths.userRoot, "AGENTS.md");
			await writeFile(contextPath, "Initial global context.");
			const callerContext = {
				path: "caller://fixed",
				content: "Original caller context.",
			};
			const provider = new FakeProvider([
				textScript("before reload", 2),
				textScript("after reload", 4),
			]);
			const session = await createMemorySession(cwd);
			const coding = await CodingSession.load(
				config(session, provider, {
					systemPrompt: undefined,
					resourcePaths: paths,
					contextFiles: [callerContext],
				}),
			);
			const metadata = coding.metadata;
			const toolNames = coding.tools.map((tool) => tool.name);

			await coding.prompt("Before").result();
			const messagesBeforeReload = coding.messages;
			const persistedBeforeReload = (await session.buildContext()).messages;
			await expect(coding.reloadResources()).resolves.toMatchObject({
				systemPromptChanged: false,
				contextFileCount: 2,
			});

			(callerContext as { content: string }).content = "Mutated by caller.";
			await writeFile(contextPath, "Updated global context.");
			await writeFile(
				join(paths.userSkills, "review.md"),
				"---\ndescription: Review changes.\n---\nReview carefully.",
			);
			await writeFile(
				join(paths.userPrompts, "explain.md"),
				"Explain {{ arguments }} after reload.",
			);

			const firstReload = coding.reloadResources();
			const coalescedReload = coding.reloadResources();
			expect(firstReload).toBe(coalescedReload);
			expect(() => coding.prompt("Blocked during reload")).toThrow(
				"resources are reloading",
			);
			await expect(firstReload).resolves.toMatchObject({
				skillCount: 1,
				promptTemplateCount: 1,
				contextFileCount: 2,
				systemPromptChanged: true,
			});

			expect(coding.metadata).toEqual(metadata);
			expect(coding.model).toBe("default-model");
			expect(coding.reasoning).toBe("low");
			expect(coding.tools.map((tool) => tool.name)).toEqual(toolNames);
			expect(coding.messages).toEqual(messagesBeforeReload);
			expect((await session.buildContext()).messages).toEqual(
				persistedBeforeReload,
			);
			expect(coding.contextFiles).toEqual([
				{ path: contextPath, content: "Updated global context." },
				{ path: "caller://fixed", content: "Original caller context." },
			]);
			expect(await coding.handleCommand("/context")).toMatchObject({
				outcome: { text: `${contextPath}\ncaller://fixed` },
			});
			expect(coding.systemPrompt).toContain("Updated global context.");
			expect(coding.systemPrompt).toContain("Original caller context.");
			expect(coding.systemPrompt).not.toContain("Mutated by caller.");

			await coding.prompt("/explain reload.ts").result();
			expect(provider.calls[1]?.context.systemPrompt).toBe(coding.systemPrompt);
			expect(provider.calls[1]?.context.messages.map(messageText).at(-1)).toBe(
				"Explain reload.ts after reload.",
			);
			await expect(coding.reloadResources()).resolves.toMatchObject({
				systemPromptChanged: false,
			});

			await rm(contextPath);
			await expect(coding.reloadResources()).resolves.toMatchObject({
				contextFileCount: 1,
				systemPromptChanged: true,
			});
			expect(coding.contextFiles.map((file) => file.path)).toEqual([
				"caller://fixed",
			]);

			await writeFile(join(paths.agentsRoot, "AGENTS.md"), "Shared context.");
			await expect(coding.reloadResources()).resolves.toMatchObject({
				contextFileCount: 2,
				systemPromptChanged: true,
			});
			expect(coding.contextFiles.map((file) => file.path)).toEqual([
				join(paths.agentsRoot, "AGENTS.md"),
				"caller://fixed",
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("refreshes diagnostics without a prompt change and rolls back strict failures", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-reload-rollback-"));
		try {
			const cwd = join(directory, "project");
			const paths = areebPaths({
				cwd,
				userRoot: join(directory, "user"),
				agentsRoot: join(directory, "agents"),
			});
			await mkdir(paths.userSkills, { recursive: true });
			await mkdir(paths.userPrompts, { recursive: true });
			await mkdir(paths.agentsRoot, { recursive: true });
			const skillPath = join(paths.userSkills, "review.md");
			await writeFile(skillPath, "Missing description.");
			const session = await createMemorySession(cwd);
			const coding = await CodingSession.load(
				config(session, new FakeProvider([]), {
					tools: [],
					resourcePaths: paths,
				}),
			);
			const originalPrompt = coding.systemPrompt;
			expect(coding.resourceDiagnostics).toHaveLength(1);

			await writeFile(
				skillPath,
				"---\ndescription: Review changes.\n---\nFirst version.",
			);
			await writeFile(join(paths.userPrompts, "explain.md"), "Explain this.");
			await expect(coding.reloadResources()).resolves.toMatchObject({
				skillCount: 1,
				promptTemplateCount: 1,
				diagnostics: [],
				systemPromptChanged: false,
			});
			expect(coding.systemPrompt).toBe(originalPrompt);
			expect(coding.skills[0]?.content).toBe("First version.");

			await writeFile(
				skillPath,
				"---\ndescription: Review changes.\n---\nSecond version.",
			);
			await mkdir(join(paths.userRoot, "AGENTS.override.md"), {
				recursive: true,
			});
			const snapshotBeforeFailure = {
				skills: coding.skills,
				promptTemplates: coding.promptTemplates,
				contextFiles: coding.contextFiles,
				diagnostics: coding.resourceDiagnostics,
				systemPrompt: coding.systemPrompt,
			};

			await expect(coding.reloadResources()).rejects.toThrow(
				"Resource is not a regular file",
			);
			expect({
				skills: coding.skills,
				promptTemplates: coding.promptTemplates,
				contextFiles: coding.contextFiles,
				diagnostics: coding.resourceDiagnostics,
				systemPrompt: coding.systemPrompt,
			}).toEqual(snapshotBeforeFailure);

			await rm(join(paths.userRoot, "AGENTS.override.md"), {
				recursive: true,
			});
			await coding.reloadResources();
			expect(coding.skills[0]?.content).toBe("Second version.");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects reload while the harness is running", async () => {
		const provider = new ControlledProvider();
		const session = await createMemorySession();
		const coding = await CodingSession.load(
			config(session, provider, { tools: [] }),
		);
		const stream = coding.prompt("Run");
		await waitUntil(() => provider.calls.length === 1, "provider request");

		await expect(coding.reloadResources()).rejects.toThrow("agent is running");
		await expect(coding.handleCommand("/reload")).rejects.toThrow(
			"agent is running",
		);
		provider.finish();
		await stream.result();
	});

	test("expands string prompts and queues before provider execution and persistence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-session-expansion-"));
		try {
			const cwd = join(directory, "project");
			const paths = areebPaths({
				cwd,
				userRoot: join(directory, "user"),
				agentsRoot: join(directory, "agents"),
			});
			await mkdir(paths.userSkills, { recursive: true });
			await mkdir(paths.userPrompts, { recursive: true });
			await writeFile(
				join(paths.userSkills, "review.md"),
				"---\ndescription: Review code.\n---\nUse the checklist.\n",
			);
			await writeFile(
				join(paths.userPrompts, "explain.md"),
				"Explain {{ arguments }} clearly.",
			);

			const provider = new FakeProvider([
				textScript("template done", 2),
				textScript("skill done", 4),
				textScript("raw done", 6),
				textScript("unknown done", 8),
				textScript("path done", 10),
			]);
			const session = await createMemorySession(cwd);
			const coding = await CodingSession.load(
				config(session, provider, { tools: [], resourcePaths: paths }),
			);
			expect(await coding.handleCommand("/explain src/app.ts")).toEqual({
				handled: false,
			});

			await coding.prompt("/explain src/app.ts").result();
			expect(provider.calls[0]?.context.messages.map(messageText)).toEqual([
				"Explain src/app.ts clearly.",
			]);

			await coding.prompt("/skill:review src/app.ts").result();
			const expandedSkill = provider.calls[1]?.context.messages
				.map(messageText)
				.at(-1);
			expect(expandedSkill).toContain('<skill name="review"');
			expect(expandedSkill).toEndWith("</skill>\n\nsrc/app.ts");
			expect((await session.buildContext()).messages.map(messageText)).toEqual([
				"Explain src/app.ts clearly.",
				"template done",
				expandedSkill,
				"skill done",
			]);
			await coding.prompt(user("/explain raw.ts", 5)).result();
			expect(provider.calls[2]?.context.messages.map(messageText).at(-1)).toBe(
				"/explain raw.ts",
			);
			expect(await coding.handleCommand("/unknown value")).toEqual({
				handled: false,
			});
			await coding.prompt("/unknown value").result();
			expect(provider.calls[3]?.context.messages.map(messageText).at(-1)).toBe(
				"/unknown value",
			);
			expect(await coding.handleCommand("/tmp/example.ts")).toEqual({
				handled: false,
			});
			await coding.prompt("/tmp/example.ts").result();
			expect(provider.calls[4]?.context.messages.map(messageText).at(-1)).toBe(
				"/tmp/example.ts",
			);

			expect(messageText(coding.steer("/explain queued.ts").steering[0])).toBe(
				"Explain queued.ts clearly.",
			);
			expect(
				messageText(coding.followUp("/skill:review later.ts").followUp[0]),
			).toEndWith("</skill>\n\nlater.ts");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("composes custom prompt additions in provider-visible order", async () => {
		const provider = new FakeProvider([textScript("done")]);
		const session = await createMemorySession("C:\\workspace\\project");
		const coding = await CodingSession.load(
			config(session, provider, {
				systemPrompt: "Custom base",
				appendSystemPrompt: "Appended instructions",
				extraGuidelines: ["Must not replace custom base"],
				contextFiles: [{ path: '/repo/a&".md', content: "Trusted context" }],
				tools: [],
			}),
		);

		expect(coding.systemPrompt).toBe(`Custom base

Appended instructions

<project_context>

Project-specific instructions and guidelines. Later files have higher specificity:

<project_instructions path="/repo/a&amp;&quot;.md">
Trusted context
</project_instructions>

</project_context>

Current working directory: C:/workspace/project`);
		expect(coding.systemPrompt).not.toContain("Must not replace custom base");

		await coding.prompt("inspect").result();
		expect(provider.calls[0]?.context.systemPrompt).toBe(coding.systemPrompt);
	});

	test("rejects whitespace-only custom system prompts", async () => {
		const session = await createMemorySession();
		await expect(
			CodingSession.load(
				config(session, new FakeProvider([]), { systemPrompt: " \n\t " }),
			),
		).rejects.toThrow("Custom system prompt cannot be empty");
	});
});
