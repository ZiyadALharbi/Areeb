import { describe, expect, test } from "bun:test";
import {
	type CommandContext,
	type CommandModelListItem,
	type CommandProviderAuthItem,
	CommandRegistry,
	type CommandResourceSummary,
	type CommandSessionListItem,
	createDefaultCommandRegistry,
	type SlashCommand,
} from "../../src/coding/commands.ts";
import type { ContextUsageEstimate } from "../../src/coding/context-window.ts";

const DEFAULT_CONTEXT_USAGE: ContextUsageEstimate = {
	revision: 1,
	requestShapeRevision: 1,
	usedTokens: 0,
	windowTokens: 128_000,
	percent: 0,
	mode: "full-estimate",
	usesProviderUsage: false,
	breakdown: {
		mode: "full-estimate",
		systemTokens: 0,
		messageTokens: 0,
		toolTokens: 0,
		imageTokens: 0,
		messageCount: 0,
		toolCount: 0,
	},
	contextWindowSource: "fallback",
};

function context(
	capabilities: readonly Parameters<CommandContext["hasCapability"]>[0][] = [],
	resourceSummary: CommandResourceSummary = {
		skillCount: 0,
		promptTemplateCount: 0,
		contextFileCount: 0,
		diagnostics: [],
	},
	contextFiles: readonly string[] = [],
	systemPromptChanged = false,
	sessions: readonly CommandSessionListItem[] | Error = [],
	models: readonly CommandModelListItem[] = [],
	providers: readonly CommandProviderAuthItem[] = [],
	contextUsage: ContextUsageEstimate = DEFAULT_CONTEXT_USAGE,
): CommandContext {
	let name: string | undefined;
	return {
		hasCapability: (capability) => capabilities.includes(capability),
		async listSessions() {
			if (sessions instanceof Error) {
				throw sessions;
			}
			return sessions;
		},
		listModels: () => models,
		listAuthProviders: () => providers,
		getResourceSummary: () => resourceSummary,
		getContextFiles: () => [...contextFiles],
		getContextUsage: () => contextUsage,
		async reloadResources() {
			return { ...resourceSummary, systemPromptChanged };
		},
		async getSessionInfo() {
			return {
				id: "00000000-0000-4000-8000-000000000001",
				...(name === undefined ? {} : { name }),
				cwd: "/workspace",
				provider: "fake",
				model: "model-a",
				reasoning: "high",
				messageCount: 3,
				isRunning: false,
			};
		},
		async getSessionName() {
			return name;
		},
		async setSessionName(value) {
			name = value;
		},
		getTuiInfo() {
			return {
				themeName: "areeb-dark",
				themeNames: ["areeb-dark", "areeb-light"],
				hotkeys: [{ keys: "Ctrl+P", description: "Open the command palette" }],
			};
		},
	};
}

function command(
	name: string,
	overrides: Partial<SlashCommand> = {},
): SlashCommand {
	return {
		name,
		description: `${name} command`,
		usage: `/${name}`,
		async handler(_context, argumentsText) {
			return { kind: "message", level: "info", text: argumentsText };
		},
		...overrides,
	};
}

describe("CommandRegistry registration", () => {
	test("preserves registration order and returns immutable metadata snapshots", () => {
		const aliases = ["first-alias"];
		const registry = new CommandRegistry([
			command("first", { aliases }),
			command("second"),
		]);
		aliases.push("late");

		const listed = registry.list();
		expect(listed.map((entry) => entry.name)).toEqual(["first", "second"]);
		expect(listed[0]?.aliases).toEqual(["first-alias"]);
		expect(Object.isFrozen(listed)).toBe(true);
		expect(Object.isFrozen(listed[0])).toBe(true);
		expect(Object.isFrozen(listed[0]?.aliases)).toBe(true);
		expect(registry.executableNames()).toEqual([
			"first",
			"first-alias",
			"second",
		]);
	});

	test("validates descriptors and all executable-name collisions", () => {
		expect(() => new CommandRegistry([command("Bad")])).toThrow(
			"expected lowercase kebab-case",
		);
		expect(
			() => new CommandRegistry([command("missing", { description: " " })]),
		).toThrow("requires a description");
		expect(
			() =>
				new CommandRegistry([
					command("first", { aliases: ["shared"] }),
					command("shared"),
				]),
		).toThrow("conflicts with /first");
		expect(
			() =>
				new CommandRegistry([
					command("first"),
					command("second", { aliases: ["first"] }),
				]),
		).toThrow("conflicts with /first");
		expect(
			() =>
				new CommandRegistry([
					command("first", { aliases: ["shared"] }),
					command("second", { aliases: ["shared"] }),
				]),
		).toThrow("conflicts with /first");
	});
});

describe("CommandRegistry dispatch", () => {
	test("parses exact case-sensitive tokens and preserves trimmed argument content", async () => {
		const registry = new CommandRegistry([
			command("run", { aliases: ["r"], searchTerms: ["execute"] }),
		]);
		const commandContext = context();

		expect(
			await registry.dispatch(
				" \t/run \t first  value\nsecond \t",
				commandContext,
			),
		).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "info",
				text: "first  value\nsecond",
			},
		});
		expect(await registry.dispatch("/r alias", commandContext)).toMatchObject({
			handled: true,
			outcome: { text: "alias" },
		});
		for (const input of [
			"run",
			"/Run",
			"/runx",
			"/execute",
			"/missing",
			"/tmp",
			"/Users/me/file.png",
			"/",
			"//host",
		]) {
			expect(await registry.dispatch(input, commandContext)).toEqual({
				handled: false,
			});
		}
	});

	test("returns unavailable before invoking capability-gated handlers", async () => {
		let calls = 0;
		const registry = new CommandRegistry([
			command("reload", {
				requirements: ["session-controller"],
				async handler() {
					calls += 1;
					return { kind: "none" };
				},
			}),
		]);

		expect(await registry.dispatch("/reload", context())).toEqual({
			handled: true,
			outcome: {
				kind: "unavailable",
				missingCapability: "session-controller",
			},
		});
		expect(calls).toBe(0);
		expect(
			await registry.dispatch("/reload", context(["session-controller"])),
		).toEqual({ handled: true, outcome: { kind: "none" } });
		expect(calls).toBe(1);
	});

	test("propagates recognized handler failures", async () => {
		const registry = new CommandRegistry([
			command("fail", {
				async handler() {
					throw new Error("handler failed");
				},
			}),
		]);

		await expect(registry.dispatch("/fail", context())).rejects.toThrow(
			"handler failed",
		);
	});
});

describe("default slash commands", () => {
	test("registers operational and planned command metadata", () => {
		const commands = createDefaultCommandRegistry().list();
		expect(commands.map((entry) => entry.name)).toEqual([
			"help",
			"quit",
			"new",
			"compact",
			"export",
			"session",
			"status",
			"context",
			"resources",
			"hotkeys",
			"resume",
			"model",
			"effort",
			"login",
			"logout",
			"reload",
			"name",
			"copy",
			"skills",
			"theme",
		]);
		expect(commands.find((entry) => entry.name === "quit")?.aliases).toEqual([
			"exit",
		]);
		expect(commands.find((entry) => entry.name === "new")?.searchTerms).toEqual(
			["clear"],
		);
	});

	test("opens the effort picker and validates exact canonical levels", async () => {
		const registry = createDefaultCommandRegistry();
		const commandContext = context(["tui"]);

		expect(await registry.dispatch("/effort", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "effort-picker" },
		});
		for (const effort of [
			"off",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		] as const) {
			expect(
				await registry.dispatch(`/effort ${effort}`, commandContext),
			).toEqual({
				handled: true,
				outcome: { kind: "set-effort", effort },
			});
		}

		for (const input of [
			"/effort minimal",
			"/effort High",
			"/effort high extra",
		]) {
			expect(await registry.dispatch(input, commandContext)).toMatchObject({
				handled: true,
				outcome: { kind: "message", level: "error" },
			});
		}
	});

	test("returns provider-auth outcomes without performing auth side effects", async () => {
		const registry = createDefaultCommandRegistry();
		const providers: readonly CommandProviderAuthItem[] = [
			{
				id: "openai-codex",
				displayName: "ChatGPT Plus/Pro (Codex Subscription)",
				authType: "oauth",
				authLabel: "subscription",
			},
			{
				id: "openai",
				displayName: "OpenAI",
				authType: "api_key",
				authLabel: "api key",
			},
		];
		const commandContext = context(
			["provider-auth"],
			undefined,
			[],
			false,
			[],
			[],
			providers,
		);

		expect(await registry.dispatch("/login", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "login-picker" },
		});
		expect(
			await registry.dispatch("/login openai-codex", commandContext),
		).toEqual({
			handled: true,
			outcome: {
				kind: "login",
				provider: "openai-codex",
				authType: "oauth",
			},
		});
		expect(await registry.dispatch("/logout", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "logout-picker" },
		});
		expect(await registry.dispatch("/logout openai", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "logout", provider: "openai" },
		});
		expect(await registry.dispatch("/login anthropic", commandContext)).toEqual(
			{
				handled: true,
				outcome: {
					kind: "message",
					level: "error",
					text: "Unknown provider: anthropic",
				},
			},
		);
	});

	test("generates help, validates operational arguments, and reports planned commands", async () => {
		const registry = createDefaultCommandRegistry();
		const commandContext = context();

		const help = await registry.dispatch("/help", commandContext);
		expect(help).toMatchObject({
			handled: true,
			outcome: { kind: "message", level: "info" },
		});
		if (!help.handled || help.outcome.kind !== "message") {
			throw new Error("Expected help message");
		}
		expect(help.outcome.text).toContain("/quit (aliases: /exit)");
		expect(help.outcome.text).toContain(
			"/resources — Show loaded resources and discovery diagnostics",
		);
		expect(help.outcome.text).toContain(
			"/context — Show active project context files",
		);
		expect(help.outcome.text).toContain(
			"/reload — Reload local resources and project context",
		);
		expect(help.outcome.text).not.toContain(
			"/reload — Reload local resources and project context [planned:",
		);
		expect(help.outcome.text).toContain(
			"/new — Start a new session [planned: session-controller]",
		);
		expect(await registry.dispatch("/quit now", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "message", level: "error", text: "Usage: /quit" },
		});
		expect(await registry.dispatch("/exit", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "quit" },
		});
		expect(await registry.dispatch("/compact", commandContext)).toEqual({
			handled: true,
			outcome: {
				kind: "unavailable",
				missingCapability: "compaction",
			},
		});
	});

	test("returns session-controller outcomes and validates resume identifiers", async () => {
		const registry = createDefaultCommandRegistry();
		const id = "00000000-0000-4000-8000-000000000001";
		const commandContext = context(["session-controller"]);

		expect(await registry.dispatch("/new", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "new-session" },
		});
		expect(await registry.dispatch("/new now", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "message", level: "error", text: "Usage: /new" },
		});
		expect(await registry.dispatch(`/resume ${id}`, commandContext)).toEqual({
			handled: true,
			outcome: { kind: "resume", sessionId: id },
		});
		expect(await registry.dispatch("/resume", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "resume-picker" },
		});
		for (const input of ["/resume partial", `/resume ${id} extra`]) {
			expect(await registry.dispatch(input, commandContext)).toEqual({
				handled: true,
				outcome: {
					kind: "message",
					level: "error",
					text: "Usage: /resume [session-id]",
				},
			});
		}
	});

	test("reports TUI hotkeys and dispatches theme and copy actions", async () => {
		const registry = createDefaultCommandRegistry();
		const commandContext = context(["tui"]);

		expect(await registry.dispatch("/hotkeys", commandContext)).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "info",
				text: "Keyboard shortcuts:\nCtrl+P — Open the command palette",
			},
		});
		expect(await registry.dispatch("/theme", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "theme-picker" },
		});
		expect(
			await registry.dispatch("/skills inspect this", commandContext),
		).toEqual({
			handled: true,
			outcome: {
				kind: "skill-picker",
				argumentsText: "inspect this",
			},
		});
		expect(await registry.dispatch("/skill", commandContext)).toEqual({
			handled: false,
		});
		expect(
			await registry.dispatch("/theme areeb-light", commandContext),
		).toEqual({
			handled: true,
			outcome: { kind: "set-theme", theme: "areeb-light" },
		});
		expect(await registry.dispatch("/theme light", commandContext)).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "error",
				text: "Unknown theme: light",
			},
		});
		expect(await registry.dispatch("/copy", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "copy-last-assistant" },
		});
		expect(await registry.dispatch("/copy path", commandContext)).toMatchObject(
			{
				outcome: { text: "Usage: /copy" },
			},
		);
	});

	test("opens semantic pickers and validates canonical model selections", async () => {
		const registry = createDefaultCommandRegistry();
		const models: readonly CommandModelListItem[] = [
			{ provider: "openai", model: "gpt-5.6-sol" },
			{ provider: "local", model: "org/model/version" },
		];
		const commandContext = context(
			["session-controller", "model-selection"],
			undefined,
			[],
			false,
			[],
			models,
		);

		expect(await registry.dispatch("/resume", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "resume-picker" },
		});
		expect(await registry.dispatch("/model", commandContext)).toEqual({
			handled: true,
			outcome: { kind: "model-picker" },
		});
		expect(
			await registry.dispatch("/model local/org/model/version", commandContext),
		).toEqual({
			handled: true,
			outcome: {
				kind: "set-model",
				provider: "local",
				model: "org/model/version",
			},
		});
		expect(
			await registry.dispatch("/model local/missing", commandContext),
		).toMatchObject({
			outcome: {
				kind: "message",
				level: "error",
				text: "Unknown or unavailable model: local/missing",
			},
		});
		expect(
			await registry.dispatch("/model missing-provider", commandContext),
		).toMatchObject({ outcome: { text: "Usage: /model [provider/model]" } });
		expect(await registry.dispatch("/login", commandContext)).toMatchObject({
			outcome: { missingCapability: "provider-auth" },
		});
	});

	test("reports resource totals and grouped deterministic diagnostics", async () => {
		const registry = createDefaultCommandRegistry();
		const commandContext = context([], {
			skillCount: 2,
			promptTemplateCount: 1,
			contextFileCount: 3,
			diagnostics: [
				{
					kind: "skill",
					code: "validation-failed",
					severity: "warning",
					name: "broken",
					path: "/skills/broken.md",
					message: "Skill requires a description",
				},
				{
					kind: "prompt-template",
					code: "overridden",
					severity: "info",
					name: "review",
					path: "/user/review.md",
					relatedPath: "/project/review.md",
					message: "Prompt template was overridden",
				},
			],
		});

		expect(await registry.dispatch("/resources now", commandContext)).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "error",
				text: "Usage: /resources",
			},
		});
		const result = await registry.dispatch("/resources", commandContext);
		if (!result.handled || result.outcome.kind !== "message") {
			throw new Error("Expected resource message");
		}
		expect(result.outcome.level).toBe("warning");
		expect(result.outcome.text).toBe(`Skills loaded: 2
Prompt templates loaded: 1
Project context files loaded: 3
Resource diagnostics: 1 warning, 1 info

Warnings:
- [skill/validation-failed] broken: Skill requires a description (path: /skills/broken.md)

Info:
- [prompt-template/overridden] review: Prompt template was overridden (path: /user/review.md; winner: /project/review.md)`);
	});

	test("reports exact context usage with source-aware provenance", async () => {
		const registry = createDefaultCommandRegistry();
		const fullEstimate: ContextUsageEstimate = {
			revision: 2,
			requestShapeRevision: 1,
			usedTokens: 20_000,
			windowTokens: 128_000,
			percent: 16,
			mode: "full-estimate",
			usesProviderUsage: false,
			breakdown: {
				mode: "full-estimate",
				systemTokens: 1_000,
				messageTokens: 15_000,
				toolTokens: 4_000,
				imageTokens: 0,
				messageCount: 4,
				toolCount: 2,
			},
			contextWindowSource: "configured",
		};
		const fullContext = context(
			[],
			undefined,
			[],
			false,
			[],
			[],
			[],
			fullEstimate,
		);

		expect(await registry.dispatch("/status extra", fullContext)).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "error",
				text: "Usage: /status",
			},
		});
		expect(await registry.dispatch("/status", fullContext)).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "info",
				text: `Context
Estimated: 20,000 / 128,000 tokens (16%)
Mode: full estimate
System: 1,000 tokens
Messages: 15,000 tokens · 4 messages
Tools: 4,000 tokens · 2 tools
Window source: configured catalog`,
			},
		});

		const anchored: ContextUsageEstimate = {
			...fullEstimate,
			revision: 3,
			mode: "provider-anchor",
			usesProviderUsage: true,
			breakdown: {
				mode: "provider-anchor",
				providerTokens: 18_000,
				trailingTokens: 2_000,
				imageTokens: 0,
				trailingMessageCount: 1,
			},
			contextWindowSource: "live",
			effectiveContextWindowPercent: 90,
			discoveryError: "catalog unavailable",
		};
		const anchorContext = context(
			[],
			undefined,
			[],
			false,
			[],
			[],
			[],
			anchored,
		);
		expect(await registry.dispatch("/status", anchorContext)).toMatchObject({
			outcome: {
				text: `Context
Estimated: 20,000 / 128,000 tokens (16%)
Mode: provider anchor
Provider prefix: 18,000 tokens
Estimated trailing: 2,000 tokens · 1 message
Window source: provider live catalog
Provider effective window metadata: 90%
Catalog discovery: catalog unavailable`,
			},
		});
	});

	test("lists context paths and reloads resources with argument validation", async () => {
		const registry = createDefaultCommandRegistry();
		const summary: CommandResourceSummary = {
			skillCount: 2,
			promptTemplateCount: 1,
			contextFileCount: 2,
			diagnostics: [],
		};
		const commandContext = context(
			[],
			summary,
			["/workspace/AGENTS.md", "/workspace/.areeb/AGENTS.md"],
			true,
		);

		expect(await registry.dispatch("/context extra", commandContext)).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "error",
				text: "Usage: /context",
			},
		});
		expect(await registry.dispatch("/context", commandContext)).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "info",
				text: "/workspace/AGENTS.md\n/workspace/.areeb/AGENTS.md",
			},
		});
		expect(await registry.dispatch("/context", context())).toMatchObject({
			outcome: { text: "No project context files loaded" },
		});
		expect(await registry.dispatch("/reload extra", commandContext)).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "error",
				text: "Usage: /reload",
			},
		});
		expect(await registry.dispatch("/reload", commandContext)).toEqual({
			handled: true,
			outcome: {
				kind: "message",
				level: "info",
				text: `Resources reloaded.
Skills loaded: 2
Prompt templates loaded: 1
Project context files loaded: 2
Resource diagnostics: 0 warnings, 0 info
System prompt changed: yes`,
			},
		});
	});
});
