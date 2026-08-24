import { describe, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	AREEB_DARK_THEME,
	AREEB_LIGHT_THEME,
	createTuiThemeBinding,
	getTuiTheme,
	listTuiThemes,
	TUI_THEME_NAMES,
} from "../../../src/coding/tui/theme.ts";

describe("TUI themes", () => {
	test("exposes exactly the two typed Areeb palettes", () => {
		expect(TUI_THEME_NAMES).toEqual(["areeb-dark", "areeb-light"]);
		expect(listTuiThemes().map((theme) => theme.name)).toEqual([
			...TUI_THEME_NAMES,
		]);
		expect(getTuiTheme("areeb-dark")).toBe(AREEB_DARK_THEME);
		expect(getTuiTheme("areeb-light")).toBe(AREEB_LIGHT_THEME);
		expect(getTuiTheme("unknown")).toBeUndefined();
	});

	test("keeps captured callbacks live when the palette changes", () => {
		const binding = createTuiThemeBinding(AREEB_DARK_THEME);
		const primary = binding.primary;
		const userBorder = binding.userBorder;
		const markdownHeading = binding.markdown.heading;
		const dark = primary("text");
		const darkUserBorder = userBorder("border");
		const darkHeading = markdownHeading("heading");

		binding.setTheme(AREEB_LIGHT_THEME);
		expect(binding.name).toBe("areeb-light");
		expect(primary("text")).not.toBe(dark);
		expect(userBorder("border")).not.toBe(darkUserBorder);
		expect(markdownHeading("heading")).not.toBe(darkHeading);
		expect(stripTerminalSequences(primary("text"))).toBe("text");
	});
});
