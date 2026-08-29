import { assertUuid } from "../agent/session/session.ts";
import type { SessionModel } from "../agent/session/types.ts";
import type { AuthType } from "../ai/auth.ts";
import { isReasoningLevel, type ReasoningLevel } from "../ai/types.ts";
import type { ContextUsageEstimate } from "./context-window.ts";
import type { ResourceDiagnostic } from "./resources.ts";

const COMMAND_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type CommandCapability =
	| "session-controller"
	| "compaction"
	| "session-export"
	| "model-selection"
	| "provider-auth"
	| "tui";

export interface CommandSessionInfo {
	readonly id: string;
	readonly name?: string;
	readonly cwd: string;
	readonly provider: string;
	readonly model: string;
	readonly reasoning: ReasoningLevel;
	readonly messageCount: number;
	readonly isRunning: boolean;
}

export interface CommandResourceSummary {
	readonly skillCount: number;
	readonly promptTemplateCount: number;
	readonly contextFileCount: number;
	readonly diagnostics: readonly ResourceDiagnostic[];
}

export interface CommandResourceReloadResult extends CommandResourceSummary {
	readonly systemPromptChanged: boolean;
}

export interface CommandSessionListItem {
	readonly id: string;
	readonly title: string;
	readonly model: SessionModel | null;
}

export interface CommandModelListItem {
	readonly provider: string;
	readonly model: string;
}

export interface CommandProviderAuthItem {
	readonly id: string;
	readonly displayName: string;
	readonly authType: AuthType;
	readonly authLabel: string;
}

export interface CommandHotkey {
	readonly keys: string;
	readonly description: string;
}

export interface CommandTuiInfo {
	readonly themeName: string;
	readonly themeNames: readonly string[];
	readonly hotkeys: readonly CommandHotkey[];
}

export interface CommandContext {
	readonly hasCapability: (capability: CommandCapability) => boolean;
	readonly listSessions: () => Promise<readonly CommandSessionListItem[]>;
	readonly listModels: () => readonly CommandModelListItem[];
	readonly listAuthProviders?: () => readonly CommandProviderAuthItem[];
	readonly getSessionInfo: () => Promise<CommandSessionInfo>;
	readonly getContextUsage: () => ContextUsageEstimate;
	readonly getResourceSummary: () => CommandResourceSummary;
	readonly reloadResources: () => Promise<CommandResourceReloadResult>;
	readonly getSessionName: () => Promise<string | undefined>;
	readonly setSessionName: (name: string) => Promise<void>;
	readonly getTuiInfo: () => CommandTuiInfo;
}

export type CommandOutcome =
	| {
			readonly kind: "message";
			readonly level: "info" | "warning" | "error";
			readonly text: string;
	  }
	| { readonly kind: "quit" }
	| { readonly kind: "none" }
	| { readonly kind: "new-session" }
	| { readonly kind: "resume-picker" }
	| { readonly kind: "resume"; readonly sessionId: string }
	| { readonly kind: "model-picker" }
	| { readonly kind: "login-picker" }
	| {
			readonly kind: "login";
			readonly provider: string;
			readonly authType: AuthType;
	  }
	| { readonly kind: "logout-picker" }
	| { readonly kind: "logout"; readonly provider: string }
	| { readonly kind: "theme-picker" }
	| { readonly kind: "skill-picker"; readonly argumentsText: string }
	| { readonly kind: "set-theme"; readonly theme: string }
	| { readonly kind: "effort-picker" }
	| { readonly kind: "set-effort"; readonly effort: ReasoningLevel }
	| { readonly kind: "copy-last-assistant" }
	| {
			readonly kind: "set-model";
			readonly provider: string;
			readonly model: string;
	  }
	| {
			readonly kind: "unavailable";
			readonly missingCapability: CommandCapability;
	  };

export type CommandResult =
	| { readonly handled: false }
	| { readonly handled: true; readonly outcome: CommandOutcome };

export type CommandHandler = (
	context: CommandContext,
	argumentsText: string,
) => Promise<CommandOutcome>;

export interface SlashCommand {
	readonly name: string;
	readonly aliases?: readonly string[];
	readonly description: string;
	readonly usage: string;
	readonly searchTerms?: readonly string[];
	readonly requirements?: readonly CommandCapability[];
	readonly handler?: CommandHandler;
}

export class CommandRegistry {
	private readonly commands: SlashCommand[] = [];
	private readonly commandsByName = new Map<string, SlashCommand>();

	constructor(commands: readonly SlashCommand[] = []) {
		for (const command of commands) {
			this.register(command);
		}
	}

	register(command: SlashCommand): this {
		const normalized = normalizeCommand(command);
		for (const name of [normalized.name, ...(normalized.aliases ?? [])]) {
			const existing = this.commandsByName.get(name);
			if (existing) {
				throw new Error(
					`Slash command name "${name}" conflicts with /${existing.name}`,
				);
			}
		}

		this.commands.push(normalized);
		this.commandsByName.set(normalized.name, normalized);
		for (const alias of normalized.aliases ?? []) {
			this.commandsByName.set(alias, normalized);
		}
		return this;
	}

	list(): readonly SlashCommand[] {
		return Object.freeze([...this.commands]);
	}

	executableNames(): readonly string[] {
		return Object.freeze([...this.commandsByName.keys()]);
	}

	async dispatch(
		input: string,
		context: CommandContext,
	): Promise<CommandResult> {
		const parsed = parseCommand(input);
		if (!parsed) {
			return { handled: false };
		}

		const command = this.commandsByName.get(parsed.name);
		if (!command) {
			return { handled: false };
		}

		const missingCapability = command.requirements?.find(
			(requirement) => !context.hasCapability(requirement),
		);
		if (missingCapability) {
			return {
				handled: true,
				outcome: { kind: "unavailable", missingCapability },
			};
		}
		// Deferred descriptors intentionally have no fake handler. A later phase must
		// add the real handler before its capability is exposed to the registry.
		if (!command.handler) {
			throw new Error(
				`Slash command /${command.name} has no handler for its available capabilities`,
			);
		}

		return {
			handled: true,
			outcome: await command.handler(context, parsed.argumentsText),
		};
	}
}

export function createDefaultCommandRegistry(): CommandRegistry {
	const registry = new CommandRegistry();
	registry.register({
		name: "help",
		description: "Show available slash commands",
		usage: "/help",
		async handler(context, argumentsText) {
			if (argumentsText.length > 0) {
				return usageError("/help");
			}
			return {
				kind: "message",
				level: "info",
				text: formatHelp(registry.list(), context),
			};
		},
	});
	registry.register({
		name: "quit",
		aliases: ["exit"],
		description: "Exit the current session",
		usage: "/quit",
		async handler(_context, argumentsText) {
			return argumentsText.length > 0 ? usageError("/quit") : { kind: "quit" };
		},
	});
	registry.register({
		name: "new",
		description: "Start a new session",
		usage: "/new",
		searchTerms: ["clear"],
		requirements: ["session-controller"],
		async handler(_context, argumentsText) {
			return argumentsText.length > 0
				? usageError("/new")
				: { kind: "new-session" };
		},
	});
	registry.register({
		name: "compact",
		description: "Compact the active context",
		usage: "/compact [instructions]",
		// Compaction needs an atomic summarization service with retained-tail and
		// token-accounting policies; partial transcript mutation is not acceptable.
		requirements: ["compaction"],
	});
	registry.register({
		name: "export",
		description: "Export the current session",
		usage: "/export [destination]",
		// Export remains deferred until scope, formats, overwrite behavior, and
		// sensitive tool-output handling have explicit contracts.
		requirements: ["session-export"],
	});
	registry.register({
		name: "session",
		description: "Show current session information",
		usage: "/session",
		async handler(context, argumentsText) {
			if (argumentsText.length > 0) {
				return usageError("/session");
			}
			const info = await context.getSessionInfo();
			const resourceSummary = context.getResourceSummary();
			return {
				kind: "message",
				level: "info",
				text: [
					`Session ID: ${info.id}`,
					`Name: ${info.name ?? "(unnamed)"}`,
					`Working directory: ${info.cwd}`,
					`Provider: ${info.provider}`,
					`Model: ${info.model}`,
					`Reasoning: ${info.reasoning}`,
					`Messages: ${info.messageCount}`,
					`Running: ${info.isRunning ? "yes" : "no"}`,
					`Context files: ${resourceSummary.contextFileCount}`,
					`Resource diagnostics: ${formatDiagnosticTotals(resourceSummary.diagnostics)}`,
				].join("\n"),
			};
		},
	});
	registry.register({
		name: "context",
		description: "Show active context usage",
		usage: "/context",
		async handler(context, argumentsText) {
			if (argumentsText.length > 0) {
				return usageError("/context");
			}
			return {
				kind: "message",
				level: "info",
				text: formatContextStatus(context.getContextUsage()),
			};
		},
	});
	registry.register({
		name: "resources",
		description: "Show loaded resources and discovery diagnostics",
		usage: "/resources",
		async handler(context, argumentsText) {
			if (argumentsText.length > 0) {
				return usageError("/resources");
			}
			const summary = context.getResourceSummary();
			return {
				kind: "message",
				level: summary.diagnostics.some(
					(diagnostic) => diagnostic.severity === "warning",
				)
					? "warning"
					: "info",
				text: formatResourceSummary(summary),
			};
		},
	});
	registry.register({
		name: "hotkeys",
		description: "Show common keyboard shortcuts",
		usage: "/hotkeys",
		requirements: ["tui"],
		async handler(context, argumentsText) {
			if (argumentsText.length > 0) {
				return usageError("/hotkeys");
			}
			return {
				kind: "message",
				level: "info",
				text: [
					"Keyboard shortcuts:",
					...context
						.getTuiInfo()
						.hotkeys.map((hotkey) => `${hotkey.keys} — ${hotkey.description}`),
				].join("\n"),
			};
		},
	});
	registry.register({
		name: "resume",
		description: "Resume a previous session",
		usage: "/resume [session-id]",
		requirements: ["session-controller"],
		async handler(_context, argumentsText) {
			if (argumentsText.length === 0) {
				return { kind: "resume-picker" };
			}

			if (/\s/.test(argumentsText)) {
				return usageError("/resume [session-id]");
			}
			try {
				assertUuid(argumentsText, "session id");
			} catch {
				return usageError("/resume [session-id]");
			}
			return { kind: "resume", sessionId: argumentsText };
		},
	});
	registry.register({
		name: "model",
		description: "Show or switch the current model",
		usage: "/model [provider/model]",
		requirements: ["model-selection"],
		async handler(context, argumentsText) {
			if (argumentsText.length === 0) {
				return { kind: "model-picker" };
			}

			const selection = parseModelSelection(argumentsText);
			if (selection === undefined) {
				return usageError("/model [provider/model]");
			}
			if (
				!context
					.listModels()
					.some(
						(entry) =>
							entry.provider === selection.provider &&
							entry.model === selection.model,
					)
			) {
				return {
					kind: "message",
					level: "error",
					text: `Unknown or unavailable model: ${argumentsText}`,
				};
			}
			return { kind: "set-model", ...selection };
		},
	});
	registry.register({
		name: "effort",
		description: "Show or change thinking effort",
		usage: "/effort [level]",
		requirements: ["tui"],
		async handler(_context, argumentsText) {
			if (argumentsText.length === 0) {
				return { kind: "effort-picker" };
			}
			if (/\s/.test(argumentsText) || !isReasoningLevel(argumentsText)) {
				return usageError("/effort [level]");
			}
			return { kind: "set-effort", effort: argumentsText };
		},
	});
	registry.register({
		name: "login",
		description: "Add or refresh a provider login",
		usage: "/login [provider]",
		requirements: ["provider-auth"],
		async handler(context, argumentsText) {
			if (argumentsText.length === 0) {
				return { kind: "login-picker" };
			}
			if (/\s/.test(argumentsText)) {
				return usageError("/login [provider]");
			}
			const provider = context
				.listAuthProviders?.()
				.find((entry) => entry.id === argumentsText);
			if (provider === undefined) {
				return {
					kind: "message",
					level: "error",
					text: `Unknown provider: ${argumentsText}`,
				};
			}
			return {
				kind: "login",
				provider: provider.id,
				authType: provider.authType,
			};
		},
	});
	registry.register({
		name: "logout",
		description: "Remove a saved provider login",
		usage: "/logout [provider]",
		requirements: ["provider-auth"],
		async handler(context, argumentsText) {
			if (argumentsText.length === 0) {
				return { kind: "logout-picker" };
			}
			if (/\s/.test(argumentsText)) {
				return usageError("/logout [provider]");
			}
			const provider = context
				.listAuthProviders?.()
				.find((entry) => entry.id === argumentsText);
			if (provider === undefined) {
				return {
					kind: "message",
					level: "error",
					text: `Unknown provider: ${argumentsText}`,
				};
			}
			return { kind: "logout", provider: provider.id };
		},
	});
	registry.register({
		name: "reload",
		description: "Reload local resources and project context",
		usage: "/reload",
		async handler(context, argumentsText) {
			if (argumentsText.length > 0) {
				return usageError("/reload");
			}
			const result = await context.reloadResources();
			return {
				kind: "message",
				level: result.diagnostics.some(
					(diagnostic) => diagnostic.severity === "warning",
				)
					? "warning"
					: "info",
				text: formatReloadSummary(result),
			};
		},
	});
	registry.register({
		name: "name",
		description: "Show or rename the current session",
		usage: "/name [text]",
		async handler(context, argumentsText) {
			if (argumentsText.length === 0) {
				return {
					kind: "message",
					level: "info",
					text: `Session name: ${(await context.getSessionName()) ?? "(unnamed)"}`,
				};
			}
			if (/[\r\n\u2028\u2029]/.test(argumentsText)) {
				return usageError("/name [text]", "name must be a single line");
			}
			await context.setSessionName(argumentsText);
			return {
				kind: "message",
				level: "info",
				text: `Session name set to: ${argumentsText}`,
			};
		},
	});
	registry.register({
		name: "copy",
		description: "Copy the most recent assistant response",
		usage: "/copy",
		requirements: ["tui"],
		async handler(_context, argumentsText) {
			return argumentsText.length > 0
				? usageError("/copy")
				: { kind: "copy-last-assistant" };
		},
	});
	registry.register({
		name: "skills",
		description: "Choose and invoke a loaded skill",
		usage: "/skills [instructions]",
		requirements: ["tui"],
		async handler(_context, argumentsText) {
			return { kind: "skill-picker", argumentsText };
		},
	});
	registry.register({
		name: "theme",
		description: "Preview or switch the interface theme",
		usage: "/theme [name]",
		requirements: ["tui"],
		async handler(context, argumentsText) {
			if (argumentsText.length === 0) {
				return { kind: "theme-picker" };
			}
			if (/\s/.test(argumentsText)) {
				return usageError("/theme [name]");
			}
			if (!context.getTuiInfo().themeNames.includes(argumentsText)) {
				return {
					kind: "message",
					level: "error",
					text: `Unknown theme: ${argumentsText}`,
				};
			}
			return { kind: "set-theme", theme: argumentsText };
		},
	});
	return registry;
}

function normalizeCommand(command: SlashCommand): SlashCommand {
	validateName(command.name, "name");
	if (command.description.trim().length === 0) {
		throw new Error(`Slash command /${command.name} requires a description`);
	}
	if (command.usage.trim().length === 0) {
		throw new Error(`Slash command /${command.name} requires usage text`);
	}

	const aliases = normalizeValues(command.aliases, (alias) =>
		validateName(alias, "alias"),
	);
	if (aliases.includes(command.name)) {
		throw new Error(`Slash command /${command.name} cannot alias itself`);
	}
	const searchTerms = normalizeValues(command.searchTerms, (term) => {
		if (term.trim().length === 0 || term !== term.trim()) {
			throw new Error(
				`Slash command /${command.name} has an invalid search term`,
			);
		}
	});
	const requirements = normalizeValues(command.requirements);
	if (!command.handler && requirements.length === 0) {
		throw new Error(
			`Slash command /${command.name} requires a handler or capability requirement`,
		);
	}

	return Object.freeze({
		name: command.name,
		aliases: Object.freeze(aliases),
		description: command.description.trim(),
		usage: command.usage.trim(),
		searchTerms: Object.freeze(searchTerms),
		requirements: Object.freeze(requirements),
		...(command.handler ? { handler: command.handler } : {}),
	});
}

function normalizeValues<T>(
	values: readonly T[] | undefined,
	validate?: (value: T) => void,
): T[] {
	const normalized: T[] = [];
	const seen = new Set<T>();
	for (const value of values ?? []) {
		validate?.(value);
		if (seen.has(value)) {
			throw new Error(
				`Duplicate slash command metadata value: ${String(value)}`,
			);
		}
		seen.add(value);
		normalized.push(value);
	}
	return normalized;
}

function validateName(name: string, kind: "name" | "alias"): void {
	if (!COMMAND_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid slash command ${kind} "${name}"; expected lowercase kebab-case without a leading slash`,
		);
	}
}

function parseCommand(
	input: string,
): { readonly name: string; readonly argumentsText: string } | undefined {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/") || trimmed.length === 1) {
		return undefined;
	}

	const whitespaceIndex = trimmed.search(/\s/);
	const token =
		whitespaceIndex === -1 ? trimmed : trimmed.slice(0, whitespaceIndex);
	return {
		name: token.slice(1),
		argumentsText:
			whitespaceIndex === -1 ? "" : trimmed.slice(whitespaceIndex).trim(),
	};
}

function usageError(usage: string, detail?: string): CommandOutcome {
	return {
		kind: "message",
		level: "error",
		text: `Usage: ${usage}${detail ? ` (${detail})` : ""}`,
	};
}

function formatHelp(
	commands: readonly SlashCommand[],
	context: CommandContext,
): string {
	return [
		"Available commands:",
		...commands.map((command) => {
			const aliases = command.aliases?.length
				? ` (aliases: ${command.aliases.map((alias) => `/${alias}`).join(", ")})`
				: "";
			const missing = command.requirements?.filter(
				(requirement) => !context.hasCapability(requirement),
			);
			const availability = missing?.length
				? ` [planned: ${missing.join(", ")}]`
				: "";
			return `${command.usage}${aliases} — ${command.description}${availability}`;
		}),
	].join("\n");
}

function formatResourceSummary(summary: CommandResourceSummary): string {
	const warnings = summary.diagnostics.filter(
		(diagnostic) => diagnostic.severity === "warning",
	);
	const info = summary.diagnostics.filter(
		(diagnostic) => diagnostic.severity === "info",
	);
	const lines = [
		`Skills loaded: ${summary.skillCount}`,
		`Prompt templates loaded: ${summary.promptTemplateCount}`,
		`Project context files loaded: ${summary.contextFileCount}`,
		`Resource diagnostics: ${formatDiagnosticTotals(summary.diagnostics)}`,
	];
	if (warnings.length > 0) {
		lines.push("", "Warnings:");
		for (const diagnostic of warnings) {
			lines.push(formatResourceDiagnostic(diagnostic));
		}
	}
	if (info.length > 0) {
		lines.push("", "Info:");
		for (const diagnostic of info) {
			lines.push(formatResourceDiagnostic(diagnostic));
		}
	}
	return lines.join("\n");
}

function formatReloadSummary(summary: CommandResourceReloadResult): string {
	return [
		"Resources reloaded.",
		formatResourceSummary(summary),
		`System prompt changed: ${summary.systemPromptChanged ? "yes" : "no"}`,
	].join("\n");
}

export function formatContextStatus(usage: ContextUsageEstimate): string {
	const lines = [
		"Context",
		`Estimated: ${formatInteger(usage.usedTokens)} / ${formatInteger(usage.windowTokens)} tokens (${usage.percent}%)`,
	];
	if (usage.breakdown.mode === "provider-anchor") {
		lines.push(
			"Mode: provider anchor",
			`Provider prefix: ${formatInteger(usage.breakdown.providerTokens)} tokens`,
			`Estimated trailing: ${formatInteger(usage.breakdown.trailingTokens)} tokens · ${formatCount(usage.breakdown.trailingMessageCount, "message")}`,
		);
	} else {
		lines.push(
			"Mode: full estimate",
			`System: ${formatInteger(usage.breakdown.systemTokens)} tokens`,
			`Messages: ${formatInteger(usage.breakdown.messageTokens)} tokens · ${formatCount(usage.breakdown.messageCount, "message")}`,
			`Tools: ${formatInteger(usage.breakdown.toolTokens)} tokens · ${formatCount(usage.breakdown.toolCount, "tool")}`,
		);
	}
	lines.push(`Window source: ${formatWindowSource(usage.contextWindowSource)}`);
	if (usage.effectiveContextWindowPercent !== undefined) {
		lines.push(
			`Provider effective window metadata: ${usage.effectiveContextWindowPercent}%`,
		);
	}
	if (usage.discoveryError !== undefined) {
		lines.push(`Catalog discovery: ${usage.discoveryError}`);
	}
	return lines.join("\n");
}

function formatWindowSource(
	source: ContextUsageEstimate["contextWindowSource"],
): string {
	switch (source) {
		case "live":
			return "provider live catalog";
		case "configured":
			return "configured catalog";
		case "fallback":
			return "fallback";
	}
}

function formatInteger(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function formatCount(value: number, singular: string): string {
	return `${formatInteger(value)} ${singular}${value === 1 ? "" : "s"}`;
}

function formatDiagnosticTotals(
	diagnostics: readonly ResourceDiagnostic[],
): string {
	let warnings = 0;
	let info = 0;
	for (const diagnostic of diagnostics) {
		if (diagnostic.severity === "warning") {
			warnings += 1;
		} else {
			info += 1;
		}
	}
	return `${warnings} warning${warnings === 1 ? "" : "s"}, ${info} info`;
}

function formatResourceDiagnostic(diagnostic: ResourceDiagnostic): string {
	const identity = [`[${diagnostic.kind}/${diagnostic.code}]`, diagnostic.name]
		.filter((value) => value !== undefined)
		.join(" ");
	const locations = [
		diagnostic.path === undefined ? undefined : `path: ${diagnostic.path}`,
		diagnostic.relatedPath === undefined
			? undefined
			: `winner: ${diagnostic.relatedPath}`,
	].filter((value) => value !== undefined);
	return `- ${identity}: ${diagnostic.message}${locations.length === 0 ? "" : ` (${locations.join("; ")})`}`;
}

function parseModelSelection(
	value: string,
): { readonly provider: string; readonly model: string } | undefined {
	if (/\s/.test(value)) {
		return undefined;
	}
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) {
		return undefined;
	}
	return {
		provider: value.slice(0, separator),
		model: value.slice(separator + 1),
	};
}
