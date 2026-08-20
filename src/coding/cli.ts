#!/usr/bin/env bun

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { assertUuid } from "../agent/session/session.ts";
import { openAICompatibleConfigFromEnv } from "../ai/environment.ts";
import {
	type OpenAICompatibleConfig,
	OpenAICompatibleProvider,
} from "../ai/openai_compatible_provider.ts";
import type { ModelProvider } from "../ai/provider_protocol.ts";
import { runPrintMode } from "./modes/print-mode.ts";
import { isPrintOutputMode, type PrintOutputMode } from "./modes/types.ts";
import { areebPaths } from "./paths.ts";
import { CodingSession } from "./session.ts";
import {
	CodingSessionManager,
	type CodingSessionRecord,
	findCodingSession,
	listCodingSessions,
} from "./session-manager.ts";

export const USAGE = `Usage:
  areeb -p <prompt> [--model <model>] [--output <mode>] [--resume <session-id>] [--trust-project]
  areeb sessions

Options:
  -p, --prompt <prompt>       Run one prompt in print mode
      --resume <session-id>  Resume an indexed session by exact UUID
      --model <model>        Override OPENAI_MODEL for a new session
      --output <mode>        Output mode: text, json, or transcript (default: text)
      --trust-project        Load project-controlled resources and instructions
  -h, --help                 Show this help

Environment: OPENAI_API_KEY, OPENAI_MODEL, and optional OPENAI_BASE_URL
Interactive mode is not available yet.`;

type CliEnvironment = Readonly<Record<string, string | undefined>>;

export interface HelpCliCommand {
	readonly kind: "help";
}

export interface SessionsCliCommand {
	readonly kind: "sessions";
}

export interface PromptCliCommand {
	readonly kind: "prompt";
	readonly prompt: string;
	readonly model?: string;
	readonly requestedModel?: string;
	readonly resumeId?: string;
	readonly output: PrintOutputMode;
	readonly trustProjectResources: boolean;
}

export type CliCommand = HelpCliCommand | SessionsCliCommand | PromptCliCommand;

/** Parse help, session-listing, and one-shot prompt command variants. */
export function parseCli(
	args: string[],
	env: CliEnvironment = process.env,
): CliCommand {
	const { values, positionals } = parseArgs({
		args,
		options: {
			prompt: { type: "string", short: "p" },
			resume: { type: "string" },
			model: { type: "string" },
			output: { type: "string" },
			"trust-project": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
		strict: true,
	});

	if (values.help) {
		return { kind: "help" };
	}

	if (positionals[0] === "sessions") {
		if (positionals.length > 1) {
			throw new Error(`Unexpected argument: ${positionals[1]}`);
		}
		assertSessionsHasNoOptions(values);
		return { kind: "sessions" };
	}

	if (positionals.length > 0) {
		throw new Error(`Unexpected argument: ${positionals[0]}`);
	}
	if (values.prompt === undefined) {
		throw new Error(
			'Interactive mode is not available yet. Use -p "your prompt".',
		);
	}
	if (!values.prompt.trim()) {
		throw new Error("Prompt cannot be empty");
	}
	if (values.resume !== undefined) {
		assertUuid(values.resume, "resume session id");
	}

	const output = values.output ?? "text";
	if (!isPrintOutputMode(output)) {
		throw new Error(
			`Invalid output mode: ${output}. Expected text, json, or transcript.`,
		);
	}

	const requestedModel = values.model?.trim();
	if (values.model !== undefined && !requestedModel) {
		throw new Error("Model cannot be empty");
	}
	const model = requestedModel ?? (env.OPENAI_MODEL?.trim() || undefined);
	if (values.resume === undefined && model === undefined) {
		throw new Error("Missing model. Use --model or set OPENAI_MODEL.");
	}

	return {
		kind: "prompt",
		prompt: values.prompt,
		...(model === undefined ? {} : { model }),
		...(requestedModel === undefined ? {} : { requestedModel }),
		...(values.resume === undefined ? {} : { resumeId: values.resume }),
		output,
		trustProjectResources: values["trust-project"] ?? false,
	};
}

interface ParsedCliValues {
	readonly prompt?: string;
	readonly resume?: string;
	readonly model?: string;
	readonly output?: string;
	readonly "trust-project"?: boolean;
	readonly help?: boolean;
}

interface CliOutput {
	write(content: string): unknown;
}

interface CliRuntime {
	readonly cwd?: string;
	readonly userRoot?: string;
	readonly agentsRoot?: string;
	readonly env?: CliEnvironment;
	readonly stdout?: CliOutput;
	readonly stderr?: CliOutput;
	readonly createProvider?: (config: OpenAICompatibleConfig) => ModelProvider;
	readonly runPrint?: typeof runPrintMode;
}

/** Execute a parsed CLI command with persistent JSONL sessions. */
export async function runCli(
	args = Bun.argv.slice(2),
	runtime: CliRuntime = {},
): Promise<number> {
	const stdout = runtime.stdout ?? process.stdout;
	const stderr = runtime.stderr ?? process.stderr;

	try {
		const env = runtime.env ?? process.env;
		const command = parseCli(args, env);
		if (command.kind === "help") {
			stdout.write(`${USAGE}\n`);
			return 0;
		}
		if (command.kind === "sessions") {
			const records = await listCodingSessions({
				...(runtime.userRoot === undefined
					? {}
					: { userRoot: runtime.userRoot }),
			});
			if (records.length > 0) {
				stdout.write(`${records.map(formatSessionRecord).join("\n")}\n`);
			}
			return 0;
		}

		return await runPromptCommand(command, runtime, env);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		stderr.write(`areeb: ${message}\n`);
		return 1;
	}
}

async function runPromptCommand(
	command: PromptCliCommand,
	runtime: CliRuntime,
	env: CliEnvironment,
): Promise<number> {
	let cwd = resolve(runtime.cwd ?? process.cwd());
	let storedRecord: CodingSessionRecord | undefined;

	if (command.resumeId !== undefined) {
		storedRecord = await findCodingSession(command.resumeId, {
			...(runtime.userRoot === undefined ? {} : { userRoot: runtime.userRoot }),
		});
		if (storedRecord === undefined) {
			throw new Error(`Unknown session: ${command.resumeId}`);
		}
		if (
			command.requestedModel !== undefined &&
			storedRecord.model !== null &&
			command.requestedModel !== storedRecord.model.model
		) {
			throw new Error(
				`Requested model "${command.requestedModel}" does not match stored model "${storedRecord.model.model}"`,
			);
		}
		cwd = storedRecord.cwd;
	}

	const model = storedRecord?.model?.model ?? command.model;
	if (model === undefined) {
		throw new Error(
			"Resumed session has no stored model. Use --model or set OPENAI_MODEL.",
		);
	}
	const providerId = storedRecord?.model?.provider ?? "openai";
	const providerConfig = openAICompatibleConfigFromEnv({ env, providerId });
	const provider =
		runtime.createProvider?.(providerConfig) ??
		new OpenAICompatibleProvider({
			...providerConfig,
			compat: {
				thinkingLevelMap: { off: "none" },
			},
		});
	const manager = new CodingSessionManager({
		cwd,
		...(runtime.userRoot === undefined ? {} : { userRoot: runtime.userRoot }),
	});
	const session =
		command.resumeId === undefined
			? await manager.create()
			: await manager.open(command.resumeId);
	const coding = await CodingSession.load({
		session,
		provider,
		model,
		reasoning: "off",
		resourcePaths: areebPaths({
			cwd,
			...(runtime.userRoot === undefined ? {} : { userRoot: runtime.userRoot }),
			...(runtime.agentsRoot === undefined
				? {}
				: { agentsRoot: runtime.agentsRoot }),
		}),
		trustProjectResources: command.trustProjectResources,
	});

	return (runtime.runPrint ?? runPrintMode)(coding, command.prompt, {
		output: command.output,
	});
}

function assertSessionsHasNoOptions(values: ParsedCliValues): void {
	for (const option of [
		"prompt",
		"resume",
		"model",
		"output",
		"trust-project",
	] as const) {
		if (values[option] !== undefined) {
			throw new Error(`Option --${option} is not valid with sessions`);
		}
	}
}

function formatSessionRecord(record: CodingSessionRecord): string {
	const model =
		record.model === null
			? "-"
			: `${cleanDisplayField(record.model.provider)}/${cleanDisplayField(record.model.model)}`;
	return [
		cleanDisplayField(record.id),
		cleanDisplayField(record.title),
		model,
		cleanDisplayField(record.cwd),
	].join("\t");
}

function cleanDisplayField(value: string): string {
	return value.replace(/[\t\r\n]+/g, " ");
}

if (import.meta.main) {
	process.exitCode = await runCli();
}
