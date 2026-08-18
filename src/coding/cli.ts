#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { MemorySessionRepository } from "../agent/session/memory.ts";
import { openAICompatibleConfigFromEnv } from "../ai/environment.ts";
import { OpenAICompatibleProvider } from "../ai/openai_compatible_provider.ts";
import { runPrintMode } from "./modes/print-mode.ts";
import { isPrintOutputMode, type PrintOutputMode } from "./modes/types.ts";
import { CodingSession } from "./session.ts";

export const USAGE = `Usage: areeb -p <prompt> [--model <model>] [--output <mode>]

Options:
  -p, --prompt <prompt>  Run one prompt in print mode
      --model <model>    Override OPENAI_MODEL
      --output <mode>    Output mode: text, json, or transcript (default: text)
  -h, --help             Show this help

Environment: OPENAI_API_KEY, OPENAI_MODEL, and optional OPENAI_BASE_URL
Interactive mode is not available yet.`;

export interface CliOptions {
	readonly prompt: string;
	readonly model: string;
	readonly output: PrintOutputMode;
}

export function parseCli(args: string[]): CliOptions | undefined {
	const { values, positionals } = parseArgs({
		args,
		options: {
			prompt: { type: "string", short: "p" },
			model: { type: "string" },
			output: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
		strict: true,
	});

	if (values.help) {
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
	const output = values.output ?? "text";
	if (!isPrintOutputMode(output)) {
		throw new Error(
			`Invalid output mode: ${output}. Expected text, json, or transcript.`,
		);
	}

	const model = values.model?.trim() || process.env.OPENAI_MODEL?.trim();
	if (!model) {
		throw new Error("Missing model. Use --model or set OPENAI_MODEL.");
	}

	return { prompt: values.prompt, model, output };
}

export async function runCli(args = Bun.argv.slice(2)): Promise<number> {
	try {
		const options = parseCli(args);
		if (!options) {
			process.stdout.write(`${USAGE}\n`);
			return 0;
		}

		const cwd = process.cwd();
		const providerConfig = openAICompatibleConfigFromEnv();
		const session = await new MemorySessionRepository().create({ cwd });
		const coding = await CodingSession.load({
			session,
			provider: new OpenAICompatibleProvider({
				...providerConfig,
				compat: {
					thinkingLevelMap: { off: "none" },
				},
			}),
			model: options.model,
			reasoning: "off",
		});
		return runPrintMode(coding, options.prompt, { output: options.output });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`areeb: ${message}\n`);
		return 1;
	}
}

if (import.meta.main) {
	process.exitCode = await runCli();
}
