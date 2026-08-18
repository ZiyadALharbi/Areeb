import type { AssistantMessage } from "../../ai/types.ts";
import { toJsonAgentEvent } from "./json-event.ts";
import { createOutputWriter } from "./output-writer.ts";
import type {
	AsyncWriter,
	EventRenderer,
	EventRendererOptions,
	PrintOutputMode,
} from "./types.ts";

/** Select an output policy while keeping all terminal I/O outside the agent core. */
export function createEventRenderer(
	output: PrintOutputMode = "text",
	options: EventRendererOptions = {},
): EventRenderer {
	const stdout = options.stdout ?? createOutputWriter(process.stdout);
	const stderr = options.stderr ?? createOutputWriter(process.stderr);

	switch (output) {
		case "text":
			return createTextRenderer(stdout, stderr);
		case "json":
			return createJsonRenderer(stdout, stderr);
		case "transcript":
			return createTranscriptRenderer(stdout, stderr);
		default:
			throw new Error(`Invalid output mode: ${String(output)}`);
	}
}

function createTextRenderer(
	stdout: AsyncWriter,
	stderr: AsyncWriter,
): EventRenderer {
	return {
		async render(event) {
			// Text mode intentionally ignores every intermediate turn and tool event.
			if (event.type !== "agent_end" || event.reason !== "completed") {
				return;
			}

			const message = findFinalAssistantMessage(event.messages);
			if (!message) {
				throw new Error("Completed run has no final assistant message");
			}
			const text = message.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("");
			if (text.length > 0) {
				await stdout.write(text.endsWith("\n") ? text : `${text}\n`);
			}
		},
		flush: () => flushWriters(stdout, stderr),
	};
}

function createJsonRenderer(
	stdout: AsyncWriter,
	stderr: AsyncWriter,
): EventRenderer {
	return {
		async render(event) {
			const serialized = JSON.stringify(toJsonAgentEvent(event));
			if (serialized === undefined) {
				throw new Error(`Cannot serialize agent event: ${event.type}`);
			}
			// A complete record is one awaited write, preserving strict JSON Lines.
			await stdout.write(`${serialized}\n`);
		},
		flush: () => flushWriters(stdout, stderr),
	};
}

function createTranscriptRenderer(
	stdout: AsyncWriter,
	stderr: AsyncWriter,
): EventRenderer {
	// Transcript mode receives deltas, so it tracks only the newline state that
	// cannot be recovered from an individual event.
	let messageHasText = false;
	let outputEndsWithNewline = true;

	return {
		async render(event) {
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			) {
				const { delta } = event.assistantMessageEvent;
				await stdout.write(delta);
				messageHasText = true;
				outputEndsWithNewline = delta.endsWith("\n");
				return;
			}

			if (event.type === "message_end" && isAssistantMessage(event.message)) {
				await finishAssistantMessage();
				return;
			}

			if (event.type === "tool_execution_end") {
				const status = event.result.isError ? "failed" : "done";
				await stderr.write(`[tool] ${event.toolCall.name}: ${status}\n`);
			}
		},
		async flush() {
			// A stream or persistence failure can occur before message_end arrives.
			await finishAssistantMessage();
			await flushWriters(stdout, stderr);
		},
	};

	async function finishAssistantMessage(): Promise<void> {
		if (messageHasText && !outputEndsWithNewline) {
			await stdout.write("\n");
		}
		messageHasText = false;
		outputEndsWithNewline = true;
	}
}

function findFinalAssistantMessage(
	messages: readonly unknown[],
): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (isAssistantMessage(message)) {
			return message;
		}
	}
	return undefined;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		message.role === "assistant"
	);
}

async function flushWriters(
	stdout: AsyncWriter,
	stderr: AsyncWriter,
): Promise<void> {
	await stdout.flush();
	if (stderr !== stdout) {
		await stderr.flush();
	}
}
