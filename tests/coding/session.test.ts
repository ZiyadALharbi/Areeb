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
import { areebResourcePaths } from "../../src/coding/resources.ts";
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
		...overrides,
	};
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
				reasoning: "minimal",
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
	test("handles only exact, trimmed, case-sensitive slash commands", async () => {
		const session = await createMemorySession();
		const coding = await CodingSession.load(
			config(session, new FakeProvider([]), { tools: [] }),
		);

		expect(coding.handleCommand(" normal text ")).toEqual({ handled: false });
		expect(coding.handleCommand("  /help  ")).toEqual({
			handled: true,
			message: "Available commands:\n/help\n/exit",
		});
		expect(coding.handleCommand("/exit")).toEqual({
			handled: true,
			exitRequested: true,
		});
		expect(coding.handleCommand("/Help")).toEqual({
			handled: true,
			message: "Unknown command: /Help",
		});
		expect(coding.handleCommand("/skill:missing")).toEqual({ handled: false });
		expect(coding.steer("steer").count).toBe(1);
		expect(coding.followUp("follow up").count).toBe(2);
	});

	test("loads immutable resource snapshots with project trust disabled by default", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-session-resources-"));
		try {
			const cwd = join(directory, "project");
			const paths = areebResourcePaths({
				cwd,
				userRoot: join(directory, "user"),
			});
			await mkdir(paths.userSkills, { recursive: true });
			await mkdir(paths.projectSkills, { recursive: true });
			await mkdir(paths.projectPrompts, { recursive: true });
			await writeFile(
				join(paths.userSkills, "review.md"),
				"---\ndescription: Review code.\n---\nReview carefully.",
			);
			await writeFile(join(paths.projectPrompts, "private.md"), "Private.");
			await writeFile(
				join(paths.projectSkills, "private.md"),
				"---\ndescription: Project-only instructions.\n---\nPrivate skill.",
			);

			const session = await createMemorySession(cwd);
			const coding = await CodingSession.load(
				config(session, new FakeProvider([]), {
					systemPrompt: undefined,
					resourcePaths: paths,
				}),
			);
			expect(coding.skills.map((skill) => skill.name)).toEqual(["review"]);
			expect(coding.promptTemplates).toEqual([]);
			expect(coding.systemPrompt).toContain("<name>review</name>");
			expect(coding.systemPrompt).not.toContain("<name>private</name>");

			await writeFile(
				join(paths.userSkills, "later.md"),
				"---\ndescription: Loaded after reopen.\n---\nLater body.",
			);
			expect(coding.skills.map((skill) => skill.name)).toEqual(["review"]);
			const exposed = coding.skills;
			(exposed[0] as { name: string }).name = "changed";
			expect(coding.skills[0]?.name).toBe("review");

			const trustedSession = await createMemorySession(cwd);
			const trusted = await CodingSession.load(
				config(trustedSession, new FakeProvider([]), {
					systemPrompt: undefined,
					resourcePaths: paths,
					trustProjectResources: true,
				}),
			);
			expect(trusted.skills.map((skill) => skill.name)).toEqual([
				"later",
				"private",
				"review",
			]);
			expect(trusted.systemPrompt).toContain("<name>private</name>");
			expect(trusted.promptTemplates.map((template) => template.name)).toEqual([
				"private",
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("expands string prompts and queues before provider execution and persistence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-session-expansion-"));
		try {
			const cwd = join(directory, "project");
			const paths = areebResourcePaths({
				cwd,
				userRoot: join(directory, "user"),
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
			]);
			const session = await createMemorySession(cwd);
			const coding = await CodingSession.load(
				config(session, provider, { tools: [], resourcePaths: paths }),
			);
			expect(coding.handleCommand("/explain src/app.ts")).toEqual({
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

Project-specific instructions and guidelines:

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
