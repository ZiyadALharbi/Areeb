import { describe, expect, test } from "bun:test";
import {
	CommandRegistry,
	type SlashCommand,
} from "../../../src/coding/commands.ts";
import {
	buildCompletionState,
	type CompletionItem,
} from "../../../src/coding/tui/autocomplete.ts";

function command(
	name: string,
	overrides: Partial<SlashCommand> = {},
): SlashCommand {
	return {
		name,
		description: `${name} command`,
		usage: `/${name}`,
		async handler() {
			return { kind: "none" };
		},
		...overrides,
	};
}

function complete(
	text: string,
	options: {
		readonly commands?: readonly SlashCommand[];
		readonly skillNames?: readonly string[];
		readonly templateNames?: readonly string[];
		readonly cursorLine?: number;
		readonly cursorCol?: number;
		readonly lines?: readonly string[];
	} = {},
) {
	return buildCompletionState({
		commands: options.commands ?? [],
		skillNames: options.skillNames ?? [],
		templateNames: options.templateNames ?? [],
		lines: options.lines ?? [text],
		cursorLine: options.cursorLine ?? 0,
		cursorCol: options.cursorCol ?? text.length,
		availableCapabilities: ["session-controller", "tui"],
	});
}

function values(items: readonly CompletionItem[]): string[] {
	return items.map((item) => item.value);
}

describe("buildCompletionState", () => {
	test("keeps registry order for an empty query and annotates planned commands", () => {
		const state = complete("/", {
			commands: [
				command("first"),
				command("planned", { requirements: ["model-selection"] }),
				command("last"),
			],
			skillNames: ["review"],
			templateNames: ["zeta", "alpha"],
		});

		expect(values(state?.items ?? [])).toEqual([
			"/first",
			"/planned",
			"/last",
			"/skill:",
			"/alpha",
			"/zeta",
		]);
		expect(state?.items[1]).toMatchObject({
			planned: true,
			missingCapabilities: ["model-selection"],
		});
	});

	test("ranks exact names, aliases, fuzzy matches, and search terms", () => {
		const commands = [
			command("session", { aliases: ["status"] }),
			command("new", { searchTerms: ["clear"] }),
			command("resources"),
		];

		expect(values(complete("/se", { commands })?.items ?? [])).toEqual([
			"/session",
			"/resources",
		]);
		expect(values(complete("/status", { commands })?.items ?? [])[0]).toBe(
			"/session",
		);
		expect(values(complete("/clear", { commands })?.items ?? [])).toEqual([
			"/new",
		]);
	});

	test("lets an exact template outrank a command search term", () => {
		const state = complete("/clear", {
			commands: [command("new", { searchTerms: ["clear"] })],
			templateNames: ["clear"],
		});

		expect(values(state?.items ?? [])).toEqual(["/clear", "/new"]);
		expect(state?.items[0]?.source).toBe("template");
	});

	test("offers the synthetic skill namespace and replaces only a skill name", () => {
		const namespace = complete("/ski", { skillNames: ["test", "review"] });
		expect(values(namespace?.items ?? [])).toEqual(["/skill:"]);

		const state = complete("/skill:r fix the bug", {
			skillNames: ["test", "review"],
			cursorCol: "/skill:r".length,
		});
		expect(values(state?.items ?? [])).toEqual(["review"]);
		expect(state?.replacement).toEqual({
			line: 0,
			start: "/skill:".length,
			end: "/skill:r".length,
		});
		const line = "/skill:r fix the bug";
		const range = state?.replacement;
		if (range === undefined) {
			throw new Error("Expected a skill completion range");
		}
		expect(`${line.slice(0, range.start)}review${line.slice(range.end)}`).toBe(
			"/skill:review fix the bug",
		);
	});

	test("does not trigger after arguments, on later lines, or away from column zero", () => {
		const commands = [command("session")];
		expect(complete("/session details", { commands })).toBeNull();
		expect(complete(" /session", { commands })).toBeNull();
		expect(
			complete("/session", {
				commands,
				lines: ["draft", "/session"],
				cursorLine: 1,
				cursorCol: "/session".length,
			}),
		).toBeNull();
	});

	test("prevents templates from shadowing names, aliases, or skill expansion", () => {
		const registry = new CommandRegistry([
			command("quit", { aliases: ["exit"] }),
		]);
		const state = complete("/", {
			commands: registry.list(),
			templateNames: ["quit", "exit", "skill", "review"],
		});

		expect(values(state?.items ?? [])).toEqual(["/quit", "/review"]);
	});
});
