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
		expect(markdownBold("bold")).toContain("38;2;182;189;104");
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

		expect(highlighted).toContain("38;2;77;158;255");
		expect(highlighted).toContain("38;2;230;161;90");
		expect(highlighted).toContain("38;2;224;122;95");
		expect(highlighted).toContain("38;2;255;209;102");
		expect(highlighted).toContain("38;2;239;91;91");
		expect(highlighted).toContain("38;2;112;112;112");
		expect(highlighted).not.toContain("38;2;245;245;245");
		expect(highlighted).not.toContain("38;2;182;189;104");
		expect(highlighted).not.toContain("38;2;138;190;183");
		expect(fallback).toContain("38;2;230;213;184");
		expect(
			plainOutput.every((output) => output?.includes("38;2;245;245;245")),
		).toBe(true);
	});
});
