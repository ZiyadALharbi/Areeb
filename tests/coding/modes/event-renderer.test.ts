import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../../../src/agent/types.ts";
import type { AssistantMessage } from "../../../src/ai/types.ts";
import { createEventRenderer } from "../../../src/coding/modes/event-renderer.ts";
import { assistant, EMPTY_USAGE, MemoryWriter } from "./helpers.ts";

describe("event renderers", () => {
	test("text writes only the final assistant text with one trailing newline", async () => {
		const stdout = new MemoryWriter();
		const stderr = new MemoryWriter();
		const renderer = createEventRenderer("text", { stdout, stderr });
		const intermediate = assistant(
			[{ type: "text", text: "hidden" }],
			"stop",
			1,
		);
		const final = assistant(
			[
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: "Hello" },
				{
					type: "tool_call",
					id: "call",
					name: "read",
					arguments: {},
				},
				{ type: "text", text: " world" },
			],
			"stop",
			2,
		);

		await renderer.render({ type: "message_end", message: intermediate });
		expect(stdout.value).toBe("");
		await renderer.render({
			type: "agent_end",
			messages: [intermediate, final],
			reason: "completed",
		});
		await renderer.flush();

		expect(stdout.value).toBe("Hello world\n");
		expect(stdout.writeCount).toBe(1);
		expect(stderr.value).toBe("");
	});

	test("text preserves a final newline and accepts empty assistant text", async () => {
		const withNewline = new MemoryWriter();
		const renderer = createEventRenderer("text", {
			stdout: withNewline,
			stderr: new MemoryWriter(),
		});
		await renderer.render({
			type: "agent_end",
			messages: [assistant([{ type: "text", text: "done\n" }])],
			reason: "completed",
		});
		expect(withNewline.value).toBe("done\n");

		const empty = new MemoryWriter();
		await createEventRenderer("text", {
			stdout: empty,
			stderr: new MemoryWriter(),
		}).render({
			type: "agent_end",
			messages: [assistant([{ type: "thinking", thinking: "only" }])],
			reason: "completed",
		});
		expect(empty.value).toBe("");
	});

	test("json emits LF-delimited events and strips cumulative update snapshots", async () => {
		const stdout = new MemoryWriter();
		const renderer = createEventRenderer("json", {
			stdout,
			stderr: new MemoryWriter(),
		});
		const partial = assistant([{ type: "text", text: "Hello" }]);
		const update: AgentEvent = {
			type: "message_update",
			message: partial,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Hello\u2028\u2029\nworld",
				partial,
			},
		};

		await renderer.render({ type: "agent_start" });
		await renderer.render(update);
		await renderer.flush();

		const records = stdout.value
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toEqual([
			{ type: "agent_start" },
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "Hello\u2028\u2029\nworld",
				},
			},
		]);
		expect(stdout.value.endsWith("\n")).toBe(true);
	});

	test("json update output grows linearly when cumulative partials grow", async () => {
		const renderUpdates = async (count: number): Promise<number> => {
			const stdout = new MemoryWriter();
			const renderer = createEventRenderer("json", {
				stdout,
				stderr: new MemoryWriter(),
			});
			for (let index = 1; index <= count; index += 1) {
				const partial: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "x".repeat(index) }],
					provider: "fake",
					model: "fake-model",
					usage: { ...EMPTY_USAGE },
					stopReason: "stop",
					timestamp: 1,
				};
				await renderer.render({
					type: "message_update",
					message: partial,
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "x",
						partial,
					},
				});
			}
			return stdout.value.length;
		};

		const small = await renderUpdates(100);
		const large = await renderUpdates(200);
		expect(large).toBeLessThan(small * 2.1);
	});

	test("transcript streams assistant deltas and only tool completion statuses", async () => {
		const stdout = new MemoryWriter();
		const stderr = new MemoryWriter();
		const renderer = createEventRenderer("transcript", { stdout, stderr });
		const partial = assistant([{ type: "text", text: "answer" }]);
		const toolCall = {
			type: "tool_call" as const,
			id: "call",
			name: "bash",
			arguments: {},
		};

		await renderer.render({
			type: "message_update",
			message: partial,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "answer",
				partial,
			},
		});
		await renderer.render({ type: "message_end", message: partial });
		await renderer.render({
			type: "tool_execution_update",
			toolCall,
			update: { content: [{ type: "text", text: "hidden progress" }] },
		});
		for (const isError of [false, true]) {
			await renderer.render({
				type: "tool_execution_end",
				toolCall,
				result: {
					role: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: "hidden result" }],
					isError,
					timestamp: 2,
				},
			});
		}
		await renderer.flush();

		expect(stdout.value).toBe("answer\n");
		expect(stderr.value).toBe("[tool] bash: done\n[tool] bash: failed\n");
	});
});
