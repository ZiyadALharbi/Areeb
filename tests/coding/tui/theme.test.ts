import { describe, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	AREEB_DARK_THEME,
	createTuiThemeBinding,
	getTuiTheme,
	listTuiThemes,
	TUI_THEME_NAMES,
} from "../../../src/coding/tui/theme.ts";

describe("TUI themes", () => {
	test("exposes only the dark Areeb palette", () => {
		expect(TUI_THEME_NAMES).toEqual(["areeb-dark"]);
		expect(listTuiThemes().map((theme) => theme.name)).toEqual([
			...TUI_THEME_NAMES,
		]);
		expect(getTuiTheme("areeb-dark")).toBe(AREEB_DARK_THEME);
		expect(getTuiTheme("areeb-light")).toBeUndefined();
		expect(getTuiTheme("unknown")).toBeUndefined();
	});

	test("keeps captured callbacks bound to the active palette", () => {
		const binding = createTuiThemeBinding(AREEB_DARK_THEME);
		const primary = binding.primary;
		const userBorder = binding.userBorder;
		const markdownHeading = binding.markdown.heading;
		const markdownBold = binding.markdown.bold;
		binding.setTheme(AREEB_DARK_THEME);
		expect(binding.name).toBe("areeb-dark");
		expect(stripTerminalSequences(primary("text"))).toBe("text");
		expect(stripTerminalSequences(userBorder("border"))).toBe("border");
		expect(stripTerminalSequences(markdownHeading("heading"))).toBe("heading");
		expect(markdownBold("bold")).toContain("38;2;236;234;228");
	});

	test("uses a varied code-only palette with grey reserved for comments", () => {
		const highlighted = AREEB_DARK_THEME.markdown
			.highlightCode?.(
				'function format(value: string) { return "value" + 42; } // explanation',
				"typescript",
			)
			?.join("\n");
		const fallback = AREEB_DARK_THEME.markdown
			.highlightCode?.("unclassified code", "unknown-language")
			?.join("\n");
		const plainOutput = ["", "text", "plaintext", "txt", "output"].map(
			(language) =>
				AREEB_DARK_THEME.markdown
					.highlightCode?.("The dog chased the cat.", language)
					?.join("\n"),
		);

		expect(highlighted).toContain("38;2;232;166;107");
		expect(highlighted).toContain("38;2;156;196;228");
		expect(highlighted).toContain("38;2;169;214;160");
		expect(highlighted).toContain("38;2;230;192;123");
		expect(highlighted).toContain("38;2;243;217;164");
		expect(highlighted).toContain("38;2;85;85;79");
		expect(highlighted).not.toContain("38;2;236;234;228");
		expect(highlighted).not.toContain("38;2;217;201;168");
		expect(highlighted).not.toContain("38;2;240;180;76");
		expect(fallback).toContain("38;2;217;214;207");
		expect(
			plainOutput.every((output) => output?.includes("38;2;236;234;228")),
		).toBe(true);
	});
});
