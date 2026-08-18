import type { AgentEvent } from "../../agent/types.ts";
import type { AssistantMessage } from "../../ai/types.ts";
import { createEventRenderer } from "./event-renderer.ts";
import { createOutputWriter } from "./output-writer.ts";
import type {
	AsyncWriter,
	PrintModeRunOptions,
	PrintModeSession,
} from "./types.ts";

export async function runPrintMode(
	session: PrintModeSession,
	prompt: string,
	options: PrintModeRunOptions = {},
): Promise<number> {
	const stdout = options.stdout ?? createOutputWriter(process.stdout);
	const stderr = options.stderr ?? createOutputWriter(process.stderr);
	const renderer = createEventRenderer(options.output ?? "text", {
		stdout,
		stderr,
	});
	const signalTarget = options.signalTarget ?? process;
	let interrupted = false;
	let terminalEvent: Extract<AgentEvent, { type: "agent_end" }> | undefined;
	let exitCode = 1;
	let diagnostic: string | undefined;
	const interrupt = (): void => {
		interrupted = true;
		session.abort();
	};

	signalTarget.once("SIGINT", interrupt);
	try {
		const stream = session.prompt(prompt);
		if (interrupted) {
			session.abort();
		}

		for await (const event of stream) {
			if (event.type === "agent_end") {
				if (terminalEvent) {
					throw new Error("Agent emitted more than one terminal event");
				}
				terminalEvent = event;
			}
			await renderer.render(event);
		}

		if (!terminalEvent) {
			throw new Error("Agent stream ended without a terminal event");
		}
		({ exitCode, diagnostic } = outcomeFor(terminalEvent));
	} catch (error) {
		exitCode = 1;
		diagnostic = errorMessage(error);
	} finally {
		signalTarget.off("SIGINT", interrupt);
	}

	if (diagnostic) {
		await writeDiagnostic(stderr, diagnostic);
	}

	try {
		await renderer.flush();
	} catch (error) {
		exitCode = 1;
		await writeDiagnostic(stderr, errorMessage(error));
		await flushAfterFailure(stderr);
	}

	return exitCode;
}

function outcomeFor(event: Extract<AgentEvent, { type: "agent_end" }>): {
	exitCode: number;
	diagnostic?: string;
} {
	switch (event.reason) {
		case "completed":
			if (!findFinalAssistantMessage(event.messages)) {
				return {
					exitCode: 1,
					diagnostic: "Completed run has no final assistant message",
				};
			}
			return { exitCode: 0 };
		case "provider_error":
			return {
				exitCode: 1,
				diagnostic:
					findFinalAssistantMessage(event.messages)?.errorMessage ??
					"Provider request failed",
			};
		case "max_turns":
			return {
				exitCode: 1,
				diagnostic: "Agent stopped after reaching its turn limit",
			};
		case "aborted":
			return { exitCode: 130, diagnostic: "interrupted" };
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

async function writeDiagnostic(
	stderr: AsyncWriter,
	diagnostic: string,
): Promise<void> {
	try {
		await stderr.write(`areeb: ${diagnostic}\n`);
	} catch {
		// The process still returns failure when its diagnostic stream is unavailable.
	}
}

async function flushAfterFailure(stderr: AsyncWriter): Promise<void> {
	try {
		await stderr.flush();
	} catch {
		// The exit code already records the output failure.
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}
