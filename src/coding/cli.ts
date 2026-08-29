#!/usr/bin/env bun

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { assertUuid } from "../agent/session/session.ts";
import type { SessionModel } from "../agent/session/types.ts";
import type { CodexProviderConfig } from "../ai/codex_provider.ts";
import type { OpenAICompatibleConfig } from "../ai/openai_compatible_provider.ts";
import type { ModelProvider } from "../ai/provider_protocol.ts";
import {
	isReasoningLevel,
	REASONING_LEVELS,
	type ReasoningLevel,
} from "../ai/types.ts";
import { FileCredentialStore } from "./auth-store.ts";
import { runPrintMode } from "./modes/print-mode.ts";
import { isPrintOutputMode, type PrintOutputMode } from "./modes/types.ts";
import { areebPaths } from "./paths.ts";
import { createDefaultProviderAuthRegistry } from "./provider-auth.ts";
import {
	configuredProviderModels,
	getProviderAuthStatus,
	loadProviderSettings,
	setupOpenAICompatibleProvider,
} from "./provider-config.ts";
import { ProviderRuntimeService } from "./provider-runtime.ts";
import { CodingSession } from "./session.ts";
import {
	CodingSessionManager,
	type CodingSessionRecord,
	findCodingSession,
	listCodingSessions,
} from "./session-manager.ts";
import {
	TuiController,
	type TuiModelSessionLoader,
	type TuiSessionLoader,
} from "./tui/controller.ts";
import { runInteractiveMode } from "./tui/run.ts";

export const USAGE = `Usage:
  areeb [--provider <provider>] [--model <model>] [--effort <level>] [--resume <session-id>] [--trust-project]
  areeb -p <prompt> [--provider <provider>] [--model <model>] [--effort <level>] [--output <mode>] [--resume <session-id>] [--trust-project]
  areeb sessions
  areeb providers
  areeb setup --provider <provider> [--base-url <url>] [--models <model,...>] [--default-model <model>] [--api-key-env <name>] [--timeout-seconds <seconds>] [--max-retries <count>] [--max-retry-delay-seconds <seconds>] [--set-default]

Options:
  -p, --prompt <prompt>       Run one prompt in print mode
      --resume <session-id>  Resume an indexed session by exact UUID
      --provider <provider>  Select an exact configured provider
      --model <model>        Select an exact configured model
      --effort <level>       Thinking effort: off, low, medium, high, xhigh, or max
      --output <mode>        Output mode: text, json, or transcript (default: text)
      --trust-project        Load project skills and prompt templates
  -h, --help                 Show this help

Provider settings: ~/.areeb/providers.json
OpenAI environment: OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL, OPENAI_TIMEOUT_SECONDS, OPENAI_MAX_RETRIES, OPENAI_MAX_RETRY_DELAY_SECONDS`;

type CliEnvironment = Readonly<Record<string, string | undefined>>;

export interface HelpCliCommand {
	readonly kind: "help";
}

export interface SessionsCliCommand {
	readonly kind: "sessions";
}

export interface ProvidersCliCommand {
	readonly kind: "providers";
}

export interface SetupCliCommand {
	readonly kind: "setup";
	readonly provider: string;
	readonly baseUrl?: string;
	readonly apiKeyEnv?: string;
	readonly models?: readonly string[];
	readonly defaultModel?: string;
	readonly timeoutSeconds?: number;
	readonly maxRetries?: number;
	readonly maxRetryDelaySeconds?: number;
	readonly setDefault: boolean;
}

export interface PromptCliCommand {
	readonly kind: "prompt";
	readonly prompt: string;
	readonly provider?: string;
	readonly model?: string;
	readonly effort?: ReasoningLevel;
	readonly resumeId?: string;
	readonly output: PrintOutputMode;
	readonly trustProjectResources: boolean;
}

export interface InteractiveCliCommand {
	readonly kind: "interactive";
	readonly provider?: string;
	readonly model?: string;
	readonly effort?: ReasoningLevel;
	readonly resumeId?: string;
	readonly trustProjectResources: boolean;
}

export type CliCommand =
	| HelpCliCommand
	| SessionsCliCommand
	| ProvidersCliCommand
	| SetupCliCommand
	| PromptCliCommand
	| InteractiveCliCommand;

interface ParsedCliValues {
	readonly prompt?: string;
	readonly resume?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly effort?: string;
	readonly output?: string;
	readonly "trust-project"?: boolean;
	readonly "base-url"?: string;
	readonly "api-key-env"?: string;
	readonly models?: string;
	readonly "default-model"?: string;
	readonly "timeout-seconds"?: string;
	readonly "max-retries"?: string;
	readonly "max-retry-delay-seconds"?: string;
	readonly "set-default"?: boolean;
	readonly help?: boolean;
}

/** Parse CLI syntax without consulting environment or durable settings. */
export function parseCli(args: string[]): CliCommand {
	const { values, positionals } = parseArgs({
		args,
		options: {
			prompt: { type: "string", short: "p" },
			resume: { type: "string" },
			provider: { type: "string" },
			model: { type: "string" },
			effort: { type: "string" },
			output: { type: "string" },
			"trust-project": { type: "boolean" },
			"base-url": { type: "string" },
			"api-key-env": { type: "string" },
			models: { type: "string" },
			"default-model": { type: "string" },
			"timeout-seconds": { type: "string" },
			"max-retries": { type: "string" },
			"max-retry-delay-seconds": { type: "string" },
			"set-default": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
		strict: true,
	});

	if (values.help) {
		return { kind: "help" };
	}

	const subcommand = positionals[0];
	if (
		subcommand === "sessions" ||
		subcommand === "providers" ||
		subcommand === "setup"
	) {
		if (positionals.length > 1) {
			throw new Error(`Unexpected argument: ${positionals[1]}`);
		}
		if (subcommand === "sessions" || subcommand === "providers") {
			assertOnlyOptions(values, [], subcommand);
			return { kind: subcommand };
		}
		return parseSetupCommand(values);
	}

	if (positionals.length > 0) {
		throw new Error(`Unexpected argument: ${positionals[0]}`);
	}
	assertOnlyOptions(
		values,
		[
			"prompt",
			"resume",
			"provider",
			"model",
			"effort",
			"output",
			"trust-project",
		],
		"session mode",
	);
	if (values.resume !== undefined) {
		assertUuid(values.resume, "resume session id");
	}
	const provider = optionalNonempty(values.provider, "Provider");
	const model = optionalNonempty(values.model, "Model");
	const effort = values.effort;
	if (effort !== undefined && !isReasoningLevel(effort)) {
		throw new Error(
			`Invalid effort: ${effort}. Expected ${REASONING_LEVELS.join(", ")}.`,
		);
	}
	const common = {
		...(provider === undefined ? {} : { provider }),
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort }),
		...(values.resume === undefined ? {} : { resumeId: values.resume }),
		trustProjectResources: values["trust-project"] ?? false,
	};

	if (values.prompt === undefined) {
		if (values.output !== undefined) {
			throw new Error("Option --output requires -p");
		}
		return { kind: "interactive", ...common };
	}
	if (!values.prompt.trim()) {
		throw new Error("Prompt cannot be empty");
	}

	const output = values.output ?? "text";
	if (!isPrintOutputMode(output)) {
		throw new Error(
			`Invalid output mode: ${output}. Expected text, json, or transcript.`,
		);
	}

	return {
		kind: "prompt",
		prompt: values.prompt,
		...common,
		output,
	};
}

interface CliOutput {
	readonly isTTY?: boolean;
	write(content: string): unknown;
}

interface CliInput {
	readonly isTTY?: boolean;
}

interface CliRuntime {
	readonly cwd?: string;
	readonly userRoot?: string;
	readonly agentsRoot?: string;
	readonly env?: CliEnvironment;
	readonly stdin?: CliInput;
	readonly stdout?: CliOutput;
	readonly stderr?: CliOutput;
	readonly createProvider?: (config: OpenAICompatibleConfig) => ModelProvider;
	readonly createCodexProvider?: (config: CodexProviderConfig) => ModelProvider;
	readonly runPrint?: typeof runPrintMode;
	readonly runInteractive?: typeof runInteractiveMode;
}

/** Execute a parsed CLI command with durable provider and session settings. */
export async function runCli(
	args = Bun.argv.slice(2),
	runtime: CliRuntime = {},
): Promise<number> {
	const stdout = runtime.stdout ?? process.stdout;
	const stderr = runtime.stderr ?? process.stderr;

	try {
		const env = runtime.env ?? process.env;
		const command = parseCli(args);
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
		if (command.kind === "providers") {
			const settings = await loadProviderSettings({
				...(runtime.userRoot === undefined
					? {}
					: { userRoot: runtime.userRoot }),
				env,
			});
			stdout.write(formatProviderCatalog(settings, env));
			return 0;
		}
		if (command.kind === "setup") {
			const settings = await setupOpenAICompatibleProvider({
				...(runtime.userRoot === undefined
					? {}
					: { userRoot: runtime.userRoot }),
				env,
				provider: command.provider,
				...(command.baseUrl === undefined ? {} : { baseUrl: command.baseUrl }),
				...(command.apiKeyEnv === undefined
					? {}
					: { apiKeyEnv: command.apiKeyEnv }),
				...(command.models === undefined ? {} : { models: command.models }),
				...(command.defaultModel === undefined
					? {}
					: { defaultModel: command.defaultModel }),
				...(command.timeoutSeconds === undefined
					? {}
					: { timeoutSeconds: command.timeoutSeconds }),
				...(command.maxRetries === undefined
					? {}
					: { maxRetries: command.maxRetries }),
				...(command.maxRetryDelaySeconds === undefined
					? {}
					: {
							maxRetryDelaySeconds: command.maxRetryDelaySeconds,
						}),
				setDefault: command.setDefault,
			});
			const provider = settings.providers[command.provider];
			if (
				provider !== undefined &&
				!provider.builtIn &&
				getProviderAuthStatus(provider, env).startsWith("missing:")
			) {
				stderr.write(
					`areeb: warning: ${provider.apiKeyEnv} is not set for provider "${provider.id}"\n`,
				);
			}
			stdout.write(`Configured provider ${command.provider}.\n`);
			return 0;
		}

		if (command.kind === "interactive") {
			const stdin = runtime.stdin ?? process.stdin;
			if (stdin.isTTY !== true || stdout.isTTY !== true) {
				throw new Error(
					"Interactive mode requires a TTY. Use -p for print mode.",
				);
			}
		}

		return await runSessionCommand(command, runtime, env);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		stderr.write(`areeb: ${message}\n`);
		return 1;
	}
}

async function runSessionCommand(
	command: PromptCliCommand | InteractiveCliCommand,
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
		if (storedRecord.model === null) {
			throw new Error(
				`Resumed session ${command.resumeId} has no stored provider/model selection`,
			);
		}
		cwd = storedRecord.cwd;
	}

	const settings = await loadProviderSettings({
		...(runtime.userRoot === undefined ? {} : { userRoot: runtime.userRoot }),
		env,
	});
	const credentialStore = new FileCredentialStore({
		...(runtime.userRoot === undefined ? {} : { userRoot: runtime.userRoot }),
	});
	const providerRegistry = createDefaultProviderAuthRegistry();
	const providerRuntime = new ProviderRuntimeService({
		settings,
		store: credentialStore,
		registry: providerRegistry,
		env,
		...(runtime.createProvider === undefined
			? {}
			: { createProvider: runtime.createProvider }),
		...(runtime.createCodexProvider === undefined
			? {}
			: { createCodexProvider: runtime.createCodexProvider }),
	});
	const initialSelection = await providerRuntime.resolveInitialSelection({
		...(command.provider === undefined ? {} : { provider: command.provider }),
		...(command.model === undefined ? {} : { model: command.model }),
		...(storedRecord?.model === null || storedRecord?.model === undefined
			? {}
			: { stored: storedRecord.model }),
	});
	const manager = new CodingSessionManager({
		cwd,
		...(runtime.userRoot === undefined ? {} : { userRoot: runtime.userRoot }),
	});
	const session =
		command.resumeId === undefined
			? await manager.create()
			: await manager.open(command.resumeId);
	const loadSession: TuiSessionLoader = async ({
		handle,
		selection,
		reasoning,
	}) =>
		loadCodingSession(handle, selection, reasoning, {
			providerRuntime,
			cwd,
			...(runtime.userRoot === undefined ? {} : { userRoot: runtime.userRoot }),
			...(runtime.agentsRoot === undefined
				? {}
				: { agentsRoot: runtime.agentsRoot }),
			trustProjectResources: command.trustProjectResources,
			allowUnavailable: command.kind === "interactive",
		});
	const prepareModelSession: TuiModelSessionLoader = async ({
		handle,
		selection,
		reasoning,
	}) =>
		prepareCodingSessionModelChange(handle, selection, reasoning, {
			providerRuntime,
			cwd,
			...(runtime.userRoot === undefined ? {} : { userRoot: runtime.userRoot }),
			...(runtime.agentsRoot === undefined
				? {}
				: { agentsRoot: runtime.agentsRoot }),
			trustProjectResources: command.trustProjectResources,
			allowUnavailable: false,
		});
	const coding = await loadSession({
		handle: session,
		selection: initialSelection,
		reasoning:
			command.resumeId === undefined ? (command.effort ?? "high") : "high",
	});
	if (command.resumeId !== undefined && command.effort !== undefined) {
		await coding.setReasoning(command.effort);
	}

	if (command.kind === "prompt") {
		return (runtime.runPrint ?? runPrintMode)(coding, command.prompt, {
			output: command.output,
		});
	}
	return (runtime.runInteractive ?? runInteractiveMode)(
		new TuiController({
			session: coding,
			manager,
			loadSession,
			models: (await providerRuntime.usableModels()).map((entry) => ({
				provider: entry.provider,
				model: entry.model,
			})),
			prepareModelSession,
			saveDefaultSelection: (selection) =>
				providerRuntime.saveDefaultSelection(selection),
			providerAuth: {
				listMetadata: () => providerRuntime.authMetadata,
				listProviders: (savedOnly) => providerRuntime.listProviders(savedOnly),
				login: (provider, authType, interaction) =>
					providerRuntime.login(provider, authType, interaction),
				logout: (provider, signal) => providerRuntime.logout(provider, signal),
				listModels: async () =>
					(await providerRuntime.usableModels()).map((entry) => ({
						provider: entry.provider,
						model: entry.model,
					})),
			},
		}),
		{
			...(runtime.userRoot === undefined ? {} : { userRoot: runtime.userRoot }),
		},
	);
}

interface CodingSessionLoaderOptions {
	readonly providerRuntime: ProviderRuntimeService;
	readonly cwd: string;
	readonly userRoot?: string;
	readonly agentsRoot?: string;
	readonly trustProjectResources: boolean;
	readonly allowUnavailable: boolean;
}

async function loadCodingSession(
	session: Parameters<TuiSessionLoader>[0]["handle"],
	selection: SessionModel,
	reasoning: Parameters<TuiSessionLoader>[0]["reasoning"],
	options: CodingSessionLoaderOptions,
): Promise<CodingSession> {
	const providerRuntime = await options.providerRuntime.createRuntime(
		selection,
		{
			allowUnavailable: options.allowUnavailable,
		},
	);
	return CodingSession.load({
		session,
		provider: providerRuntime.provider,
		model: providerRuntime.selection.model,
		reasoning,
		...(providerRuntime.timeoutMs === undefined
			? {}
			: { timeout: providerRuntime.timeoutMs }),
		...(providerRuntime.unavailableReason === undefined
			? {}
			: { unavailableReason: providerRuntime.unavailableReason }),
		contextWindowTokens: providerRuntime.contextWindowTokens,
		contextWindowSource: providerRuntime.contextWindowSource,
		...(providerRuntime.contextWindowDiscoveryError === undefined
			? {}
			: {
					contextWindowDiscoveryError:
						providerRuntime.contextWindowDiscoveryError,
				}),
		...(providerRuntime.effectiveContextWindowPercent === undefined
			? {}
			: {
					effectiveContextWindowPercent:
						providerRuntime.effectiveContextWindowPercent,
				}),
		resourcePaths: areebPaths({
			cwd: options.cwd,
			...(options.userRoot === undefined ? {} : { userRoot: options.userRoot }),
			...(options.agentsRoot === undefined
				? {}
				: { agentsRoot: options.agentsRoot }),
		}),
		trustProjectResources: options.trustProjectResources,
	});
}

async function prepareCodingSessionModelChange(
	session: Parameters<TuiSessionLoader>[0]["handle"],
	selection: SessionModel,
	reasoning: Parameters<TuiSessionLoader>[0]["reasoning"],
	options: CodingSessionLoaderOptions,
) {
	const providerRuntime = await options.providerRuntime.createRuntime(
		selection,
		{
			allowUnavailable: options.allowUnavailable,
		},
	);
	return CodingSession.prepareModelChange({
		session,
		provider: providerRuntime.provider,
		model: providerRuntime.selection.model,
		reasoning,
		...(providerRuntime.timeoutMs === undefined
			? {}
			: { timeout: providerRuntime.timeoutMs }),
		...(providerRuntime.unavailableReason === undefined
			? {}
			: { unavailableReason: providerRuntime.unavailableReason }),
		contextWindowTokens: providerRuntime.contextWindowTokens,
		contextWindowSource: providerRuntime.contextWindowSource,
		...(providerRuntime.contextWindowDiscoveryError === undefined
			? {}
			: {
					contextWindowDiscoveryError:
						providerRuntime.contextWindowDiscoveryError,
				}),
		...(providerRuntime.effectiveContextWindowPercent === undefined
			? {}
			: {
					effectiveContextWindowPercent:
						providerRuntime.effectiveContextWindowPercent,
				}),
		resourcePaths: areebPaths({
			cwd: options.cwd,
			...(options.userRoot === undefined ? {} : { userRoot: options.userRoot }),
			...(options.agentsRoot === undefined
				? {}
				: { agentsRoot: options.agentsRoot }),
		}),
		trustProjectResources: options.trustProjectResources,
	});
}

function parseSetupCommand(values: ParsedCliValues): SetupCliCommand {
	assertOnlyOptions(
		values,
		[
			"provider",
			"base-url",
			"api-key-env",
			"models",
			"default-model",
			"timeout-seconds",
			"max-retries",
			"max-retry-delay-seconds",
			"set-default",
		],
		"setup",
	);
	const provider = optionalNonempty(values.provider, "Provider");
	if (provider === undefined) {
		throw new Error("Option --provider is required with setup");
	}
	const baseUrl = optionalNonempty(values["base-url"], "Base URL");
	const apiKeyEnv = optionalNonempty(
		values["api-key-env"],
		"API key environment variable",
	);
	const models = parseModels(values.models);
	const defaultModel = optionalNonempty(
		values["default-model"],
		"Default model",
	);

	return {
		kind: "setup",
		provider,
		...(baseUrl === undefined ? {} : { baseUrl }),
		...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
		...(models === undefined ? {} : { models }),
		...(defaultModel === undefined ? {} : { defaultModel }),
		...(values["timeout-seconds"] === undefined
			? {}
			: {
					timeoutSeconds: parseNumberOption(
						values["timeout-seconds"],
						"--timeout-seconds",
						"positive",
					),
				}),
		...(values["max-retries"] === undefined
			? {}
			: {
					maxRetries: parseNumberOption(
						values["max-retries"],
						"--max-retries",
						"safeInteger",
					),
				}),
		...(values["max-retry-delay-seconds"] === undefined
			? {}
			: {
					maxRetryDelaySeconds: parseNumberOption(
						values["max-retry-delay-seconds"],
						"--max-retry-delay-seconds",
						"nonnegative",
					),
				}),
		setDefault: values["set-default"] ?? false,
	};
}

function assertOnlyOptions(
	values: ParsedCliValues,
	allowed: readonly (keyof ParsedCliValues)[],
	command: string,
): void {
	const allowedSet = new Set<keyof ParsedCliValues>([...allowed, "help"]);
	for (const [option, value] of Object.entries(values)) {
		if (
			value !== undefined &&
			!allowedSet.has(option as keyof ParsedCliValues)
		) {
			throw new Error(`Option --${option} is not valid with ${command}`);
		}
	}
}

function optionalNonempty(
	value: string | undefined,
	label: string,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const normalized = value.trim();
	if (!normalized) {
		throw new Error(`${label} cannot be empty`);
	}
	return normalized;
}

function parseModels(value: string | undefined): readonly string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	const models = value.split(",").map((model) => model.trim());
	if (models.length === 0 || models.some((model) => model.length === 0)) {
		throw new Error("Option --models must be a comma-separated list of models");
	}
	return models;
}

function parseNumberOption(
	value: string,
	option: string,
	kind: "positive" | "nonnegative" | "safeInteger",
): number {
	if (!value.trim()) {
		throw new Error(`${option} cannot be empty`);
	}
	const parsed = Number(value);
	const valid =
		kind === "positive"
			? Number.isFinite(parsed) && parsed > 0
			: kind === "nonnegative"
				? Number.isFinite(parsed) && parsed >= 0
				: Number.isSafeInteger(parsed) && parsed >= 0;
	if (!valid) {
		throw new Error(
			`${option} must be ${
				kind === "positive"
					? "a finite number greater than zero"
					: kind === "nonnegative"
						? "a finite nonnegative number"
						: "a nonnegative safe integer"
			}`,
		);
	}
	return parsed;
}

function formatProviderCatalog(
	settings: Awaited<ReturnType<typeof loadProviderSettings>>,
	env: CliEnvironment,
): string {
	const header = "PROVIDER\tDEFAULT\tMODEL\tENDPOINT\tAUTH";
	const rows = configuredProviderModels(settings, env).map((entry) => {
		const defaults = [
			...(entry.isDefaultProvider ? ["provider"] : []),
			...(entry.isDefaultModel ? ["model"] : []),
		].join(",");
		return [
			entry.provider,
			defaults || "-",
			entry.model,
			entry.baseUrl,
			entry.authStatus,
		]
			.map(cleanDisplayField)
			.join("\t");
	});
	return `${[header, ...rows].join("\n")}\n`;
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
