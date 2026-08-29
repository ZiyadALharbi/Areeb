import { describe, expect, test } from "bun:test";
import { AgentHarness } from "../../../src/agent/harness.ts";
import type {
	AgentEvent,
	AgentMessage,
	AgentRunStream,
} from "../../../src/agent/types.ts";
import { EventStream } from "../../../src/ai/event-stream.ts";
import { FakeProvider } from "../../../src/ai/fake_provider.ts";
import { runPrintMode } from "../../../src/coding/modes/print-mode.ts";
import type { PrintModeSession } from "../../../src/coding/modes/types.ts";
import {
	assistant,
	errorScript,
	MemoryWriter,
	TestSignalTarget,
	terminalScript,
	textScript,
} from "./helpers.ts";

describe("runPrintMode", () => {
	test("defaults to final-only text and treats length completion as success", async () => {
		const stdout = new MemoryWriter();
		const stderr = new MemoryWriter();
		const signals = new TestSignalTarget();
		const session = harness(new FakeProvider([textScript("final", "length")]));

		const exitCode = await runPrintMode(session, "prompt", {
			stdout,
			stderr,
			signalTarget: signals,
		});

		expect(exitCode).toBe(0);
		expect(stdout.value).toBe("final\n");
		expect(stderr.value).toBe("");
		expect(signals.listenerCount).toBe(0);
	});

	test("keeps a failed tool recoverable and returns the later answer", async () => {
		const toolCall = {
			type: "tool_call" as const,
			id: "missing-call",
			name: "missing",
			arguments: {},
		};
		const provider = new FakeProvider([
			terminalScript(assistant([toolCall], "tool_call", 2)),
			textScript("recovered"),
		]);
		const stdout = new MemoryWriter();
		const stderr = new MemoryWriter();

		const exitCode = await runPrintMode(harness(provider), "prompt", {
			output: "transcript",
			stdout,
			stderr,
			signalTarget: new TestSignalTarget(),
		});

		expect(exitCode).toBe(0);
		expect(stdout.value).toBe("recovered\n");
		expect(stderr.value).toBe("[tool] missing: failed\n");
	});

	test("suppresses partial text and reports the provider error", async () => {
		const stdout = new MemoryWriter();
		const stderr = new MemoryWriter();
		const exitCode = await runPrintMode(
			harness(
				new FakeProvider([errorScript("provider unavailable", "partial")]),
			),
			"prompt",
			{
				stdout,
				stderr,
				signalTarget: new TestSignalTarget(),
			},
		);

		expect(exitCode).toBe(1);
		expect(stdout.value).toBe("");
		expect(stderr.value).toBe("areeb: provider unavailable\n");
	});

	test("reports max turns without treating the tool failure as the cause", async () => {
		const toolCall = {
			type: "tool_call" as const,
			id: "call",
			name: "missing",
			arguments: {},
		};
		const session = harness(
			new FakeProvider([terminalScript(assistant([toolCall], "tool_call", 2))]),
			1,
		);
		const stderr = new MemoryWriter();

		const exitCode = await runPrintMode(session, "prompt", {
			stdout: new MemoryWriter(),
			stderr,
			signalTarget: new TestSignalTarget(),
		});

		expect(exitCode).toBe(1);
		expect(stderr.value).toBe(
			"areeb: Agent stopped after reaching its turn limit\n",
		);
	});

	test("turns stream failures into diagnostics", async () => {
		const stderr = new MemoryWriter();
		const exitCode = await runPrintMode(
			new FailingSession(new Error("persistence rejected")),
			"prompt",
			{
				stdout: new MemoryWriter(),
				stderr,
				signalTarget: new TestSignalTarget(),
			},
		);

		expect(exitCode).toBe(1);
		expect(stderr.value).toBe("areeb: persistence rejected\n");
	});

	test("returns 130 for SIGINT and removes its listener", async () => {
		const signals = new TestSignalTarget();
		const session = new InterruptibleSession(signals);
		const stderr = new MemoryWriter();

		const exitCode = await runPrintMode(session, "prompt", {
			stdout: new MemoryWriter(),
			stderr,
			signalTarget: signals,
		});

		expect(exitCode).toBe(130);
		expect(session.abortCount).toBe(1);
		expect(signals.listenerCount).toBe(0);
		expect(stderr.value).toBe("areeb: interrupted\n");
	});

	test("returns failure for writer and completed-run invariant failures", async () => {
		const failedOutput = new MemoryWriter(1);
		const writerDiagnostics = new MemoryWriter();
		const writerExitCode = await runPrintMode(
			harness(new FakeProvider([textScript("answer")])),
			"prompt",
			{
				stdout: failedOutput,
				stderr: writerDiagnostics,
				signalTarget: new TestSignalTarget(),
			},
		);
		expect(writerExitCode).toBe(1);
		expect(writerDiagnostics.value).toBe("areeb: writer failed\n");

		const invariantDiagnostics = new MemoryWriter();
		const invariantExitCode = await runPrintMode(
			new CompletedWithoutAssistantSession(),
			"prompt",
			{
				stdout: new MemoryWriter(),
				stderr: invariantDiagnostics,
				signalTarget: new TestSignalTarget(),
			},
		);
		expect(invariantExitCode).toBe(1);
		expect(invariantDiagnostics.value).toBe(
			"areeb: Completed run has no final assistant message\n",
		);
	});
});

function harness(provider: FakeProvider, maxTurns?: number): AgentHarness {
	return new AgentHarness({
		provider,
		model: "fake-model",
		systemPrompt: "system",
		...(maxTurns === undefined ? {} : { maxTurns }),
	});
}

class FailingSession implements PrintModeSession {
	constructor(private readonly failure: Error) {}

	prompt(): AgentRunStream {
		const stream = createRunStream();
		queueMicrotask(() => stream.fail(this.failure));
		return stream;
	}

	abort(): void {}
}

class InterruptibleSession implements PrintModeSession {
	readonly stream = createRunStream();
	abortCount = 0;

	constructor(private readonly signals: TestSignalTarget) {}

	prompt(): AgentRunStream {
		queueMicrotask(() => this.signals.interrupt());
		return this.stream;
	}

	abort(): void {
		this.abortCount += 1;
		this.stream.push({ type: "agent_end", messages: [], reason: "aborted" });
		this.stream.end([]);
	}
}

class CompletedWithoutAssistantSession implements PrintModeSession {
	prompt(): AgentRunStream {
		const stream = createRunStream();
		queueMicrotask(() => {
			const message: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: "prompt" }],
				timestamp: 1,
			};
			stream.push({
				type: "agent_end",
				messages: [message],
				reason: "completed",
			});
			stream.end([message]);
		});
		return stream;
	}

	abort(): void {}
}

function createRunStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		() => false,
		() => [],
	);
}
