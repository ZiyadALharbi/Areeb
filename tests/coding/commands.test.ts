import { describe, expect, test } from "bun:test";
import {
	type CommandContext,
	CommandRegistry,
	createDefaultCommandRegistry,
	type SlashCommand,
} from "../../src/coding/commands.ts";

function context(
	capabilities: readonly Parameters<CommandContext["hasCapability"]>[0][] = [],
): CommandContext {
	let name: string | undefined;
	return {
		hasCapability: (capability) => capabilities.includes(capability),
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
			"hotkeys",
			"resume",
			"model",
			"login",
			"reload",
			"name",
			"theme",
		]);
		expect(commands.find((entry) => entry.name === "quit")?.aliases).toEqual([
			"exit",
		]);
		expect(commands.find((entry) => entry.name === "new")?.searchTerms).toEqual(
			["clear"],
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
});
