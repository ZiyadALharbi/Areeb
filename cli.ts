#!/usr/bin/env bun

import { parseArgs } from "node:util";
import type { AgentEndReason } from "./index.ts";
import {
	AgentHarness,
	createCodingTools,
	OpenAICompatibleProvider,
	openAICompatibleConfigFromEnv,
} from "./index.ts";

const USAGE = `Usage: areeb -p <prompt> [--model <model>]

Options:
  -p, --prompt <prompt>  Run one prompt in print mode
      --model <model>    Override OPENAI_MODEL
  -h, --help             Show this help

Environment: OPENAI_API_KEY, OPENAI_MODEL, and optional OPENAI_BASE_URL
Interactive mode is not available yet.`;

function parseCli(
	args: string[],
): { prompt: string; model: string } | undefined {
	const { values, positionals } = parseArgs({
		args,
		options: {
			prompt: { type: "string", short: "p" },
			model: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
		strict: true,
	});

	if (values.help) {
		console.log(USAGE);
		return;
	}
	if (values.prompt === undefined) {
		throw new Error(
			'Interactive mode is not available yet. Use -p "your prompt".',
		);
	}
	if (!values.prompt.trim()) {
		throw new Error("Prompt cannot be empty");
	}
	if (positionals.length > 0) {
		throw new Error(`Unexpected argument: ${positionals[0]}`);
	}

	const model = values.model?.trim() || process.env.OPENAI_MODEL?.trim();
	if (!model) {
		throw new Error("Missing model. Use --model or set OPENAI_MODEL.");
	}

	return { prompt: values.prompt, model };
}

function systemPrompt(cwd: string): string {
	return `You are Areeb, a coding agent working in ${cwd}. Use the available tools to inspect, modify, and validate the project. Be concise and summarize completed work.`;
}

async function runPrintMode(prompt: string, model: string): Promise<void> {
	const cwd = process.cwd();
	const harness = new AgentHarness({
		provider: new OpenAICompatibleProvider(openAICompatibleConfigFromEnv()),
		model,
		systemPrompt: systemPrompt(cwd),
		tools: createCodingTools(cwd),
	});
	const stream = harness.prompt(prompt);
	let endReason: AgentEndReason | undefined;
	let providerError: string | undefined;
	let messageHasText = false;
	let outputEndsWithNewline = true;
	const interrupt = () => harness.abort();
	process.once("SIGINT", interrupt);

	try {
		for await (const event of stream) {
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			) {
				const { delta } = event.assistantMessageEvent;
				process.stdout.write(delta);
				messageHasText = true;
				outputEndsWithNewline = delta.endsWith("\n");
			} else if (
				event.type === "message_end" &&
				event.message.role === "assistant"
			) {
				if (messageHasText && !outputEndsWithNewline) {
					process.stdout.write("\n");
				}
				messageHasText = false;
				outputEndsWithNewline = true;
				providerError = event.message.errorMessage;
			} else if (event.type === "tool_execution_end") {
				const status = event.result.isError ? "failed" : "done";
				process.stderr.write(`[tool] ${event.toolCall.name}: ${status}\n`);
			} else if (event.type === "agent_end") {
				endReason = event.reason;
			}
		}
	} finally {
		process.off("SIGINT", interrupt);
	}

	if (endReason === "aborted") {
		process.stderr.write("areeb: interrupted\n");
		process.exitCode = 130;
	} else if (endReason === "provider_error") {
		throw new Error(providerError || "Provider request failed");
	} else if (endReason === "max_turns") {
		throw new Error("Agent stopped after reaching its turn limit");
	} else if (endReason !== "completed") {
		throw new Error("Agent stopped unexpectedly");
	}
}

try {
	const options = parseCli(Bun.argv.slice(2));
	if (options) {
		await runPrintMode(options.prompt, options.model);
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`areeb: ${message}\n`);
	process.exitCode = 1;
}
