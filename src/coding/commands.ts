import type { ReasoningLevel } from "../ai/types.ts";

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

export interface CommandContext {
	readonly hasCapability: (capability: CommandCapability) => boolean;
	readonly getSessionInfo: () => Promise<CommandSessionInfo>;
	readonly getSessionName: () => Promise<string | undefined>;
	readonly setSessionName: (name: string) => Promise<void>;
}

export type CommandOutcome =
	| {
			readonly kind: "message";
			readonly level: "info" | "warning" | "error";
			readonly text: string;
	  }
	| { readonly kind: "quit" }
	| { readonly kind: "none" }
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
		// Session replacement belongs to an application controller that can reject
		// busy transitions and keep the current session intact if rebuilding fails.
		requirements: ["session-controller"],
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
				].join("\n"),
			};
		},
	});
	registry.register({
		name: "hotkeys",
		description: "Show common keyboard shortcuts",
		usage: "/hotkeys",
		// Areeb has no TUI or keybinding layer yet, so reporting shortcuts now would
		// publish behavior that the application cannot guarantee.
		requirements: ["tui"],
	});
	registry.register({
		name: "resume",
		description: "Resume a previous session",
		usage: "/resume [session-id]",
		// Resuming must atomically swap CodingSession through the same controller as
		// /new; exact UUID lookup already exists but does not own runtime replacement.
		requirements: ["session-controller"],
	});
	registry.register({
		name: "model",
		description: "Show or switch the current model",
		usage: "/model [model]",
		// Model switching needs a catalog plus safe provider/runtime reconstruction,
		// rather than mutating the persisted selection beneath the active harness.
		requirements: ["model-selection"],
	});
	registry.register({
		name: "login",
		description: "Add or refresh a provider login",
		usage: "/login [provider]",
		// Authentication is deferred to a provider credential service so commands do
		// not perform provider-specific or partially persisted login flows.
		requirements: ["provider-auth"],
	});
	registry.register({
		name: "reload",
		description: "Reload local resources and project context",
		usage: "/reload",
		// Resources are immutable snapshots on CodingSession; rebuilding them safely
		// requires the application-level session controller used by /new and /resume.
		requirements: ["session-controller"],
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
		name: "theme",
		description: "Show or set the interface theme",
		usage: "/theme [theme]",
		// Theme state belongs to the future TUI layer and must not leak into the
		// transport-neutral coding session.
		requirements: ["tui"],
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
