import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHarness } from "../../src/agent/harness.ts";
import type { AgentEvent } from "../../src/agent/types.ts";
import type { AssistantMessageEvent } from "../../src/ai/events.ts";
import { FakeProvider } from "../../src/ai/fake_provider.ts";
import type { AssistantContent } from "../../src/ai/types.ts";
import {
	createBashTool,
	createCodingTools,
	createReadTool,
} from "../../src/coding/index.ts";

type DoneMessage = Extract<AssistantMessageEvent, { type: "done" }>["message"];

const EMPTY_USAGE = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

function assistant(
	content: AssistantContent[],
	stopReason: DoneMessage["stopReason"],
	timestamp: number,
): DoneMessage {
	return {
		role: "assistant",
		content,
		provider: "fake",
		model: "fake-model",
		usage: { ...EMPTY_USAGE },
		stopReason,
		timestamp,
	};
}

function script(message: DoneMessage): AssistantMessageEvent[] {
	return [
		{ type: "start", partial: { ...message, stopReason: "stop" } },
		{ type: "done", message },
	];
}

describe("coding tools with AgentHarness", () => {
	test("keeps stable unique default order and exposes schemas to providers", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "areeb-harness-"));
		const tools = createCodingTools({ cwd });
		expect(tools.map((tool) => tool.name)).toEqual([
			"read",
			"write",
			"edit",
			"bash",
		]);
		expect(new Set(tools.map((tool) => tool.name)).size).toBe(4);

		const provider = new FakeProvider([
			script(assistant([{ type: "text", text: "done" }], "stop", 2)),
		]);
		const harness = new AgentHarness({
			provider,
			model: "fake-model",
			systemPrompt: "system",
			tools,
		});
		await harness.prompt("inspect tools").result();
		expect(provider.calls[0]?.context.tools?.map((tool) => tool.name)).toEqual([
			"read",
			"write",
			"edit",
			"bash",
		]);
	});

	test("validates schema, executes a read, preserves details, and continues", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "areeb-harness-"));
		await writeFile(join(cwd, "file.txt"), "hello");
		const provider = new FakeProvider([
			script(
				assistant(
					[
						{
							type: "tool_call",
							id: "bad",
							name: "read",
							arguments: { path: "file.txt", limit: 0 },
						},
						{
							type: "tool_call",
							id: "good",
							name: "read",
							arguments: { path: "file.txt" },
						},
					],
					"tool_call",
					2,
				),
			),
			script(assistant([{ type: "text", text: "done" }], "stop", 3)),
		]);
		const events: AgentEvent[] = [];
		const harness = new AgentHarness({
			provider,
			model: "fake-model",
			systemPrompt: "system",
			tools: [createReadTool(cwd)],
		});
		harness.subscribe((event) => {
			events.push(event);
		});
		const result = await harness.prompt("read").result();
		const toolResults = result.filter(
			(message) => message.role === "tool_result",
		);
		expect(toolResults.map((message) => message.isError)).toEqual([
			true,
			false,
		]);
		expect(toolResults[1]?.content).toEqual([{ type: "text", text: "hello" }]);
		expect(toolResults[1]?.details).toMatchObject({ bytes: 5 });
		expect(provider.calls).toHaveLength(2);
		expect(
			events.filter((event) => event.type === "tool_execution_end"),
		).toHaveLength(2);
	});

	test("emits bash progress and marks nonzero execution as isError", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "areeb-harness-"));
		const provider = new FakeProvider([
			script(
				assistant(
					[
						{
							type: "tool_call",
							id: "bash-call",
							name: "bash",
							arguments: { command: "printf progress; exit 2" },
						},
					],
					"tool_call",
					2,
				),
			),
			script(assistant([{ type: "text", text: "handled" }], "stop", 3)),
		]);
		const events: AgentEvent[] = [];
		const harness = new AgentHarness({
			provider,
			model: "fake-model",
			systemPrompt: "system",
			tools: [createBashTool(cwd)],
		});
		harness.subscribe((event) => {
			events.push(event);
		});
		const result = await harness.prompt("run").result();
		const toolResult = result.find((message) => message.role === "tool_result");
		expect(toolResult).toMatchObject({
			role: "tool_result",
			isError: true,
			details: { exitCode: 2 },
		});
		expect(events.some((event) => event.type === "tool_execution_update")).toBe(
			true,
		);
		expect(provider.calls).toHaveLength(2);
	});

	test("passes image tool results into the next provider turn", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "areeb-harness-"));
		await writeFile(
			join(cwd, "image.bin"),
			Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00]),
		);
		const provider = new FakeProvider([
			script(
				assistant(
					[
						{
							type: "tool_call",
							id: "image-read",
							name: "read",
							arguments: { path: "image.bin" },
						},
					],
					"tool_call",
					2,
				),
			),
			script(assistant([{ type: "text", text: "saw image" }], "stop", 3)),
		]);
		const harness = new AgentHarness({
			provider,
			model: "fake-model",
			systemPrompt: "system",
			tools: [createReadTool(cwd)],
		});
		const result = await harness.prompt("read image").result();
		const toolResult = result.find((message) => message.role === "tool_result");
		expect(toolResult?.content.some((part) => part.type === "image")).toBe(
			true,
		);
		expect(provider.calls[1]?.context.messages).toContain(toolResult);
	});
});
