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
		binding.setTheme(AREEB_DARK_THEME);
		expect(binding.name).toBe("areeb-dark");
		expect(stripTerminalSequences(primary("text"))).toBe("text");
		expect(stripTerminalSequences(userBorder("border"))).toBe("border");
		expect(stripTerminalSequences(markdownHeading("heading"))).toBe("heading");
	});
});
