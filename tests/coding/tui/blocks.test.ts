import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	CollapsedToolBlock,
	MessageBlock,
} from "../../../src/coding/tui/blocks.ts";
import { AREEB_DARK_THEME } from "../../../src/coding/tui/theme.ts";

const theme = AREEB_DARK_THEME;

describe("TUI transcript blocks", () => {
	test("renders transparent, label-free rows at normal widths", () => {
		const user = new MessageBlock("user", "hello", theme);
		const assistant = new MessageBlock("assistant", "welcome", theme);
		const tool = new CollapsedToolBlock("bash", theme);

		expect(user.render(40).map(stripTerminalSequences)).toEqual(["│  hello"]);
		expect(assistant.render(40).map(stripTerminalSequences)).toEqual([
			"│  welcome",
		]);
		expect(tool.render(40).map(stripTerminalSequences)).toEqual(["◆  bash"]);
	});

	test("wraps every physical line within the requested width", () => {
		const block = new MessageBlock(
			"assistant",
			"A long response wraps at words and keeps its semantic rail visible.",
			theme,
		);
		const lines = block.render(20);

		expect(lines.length).toBeGreaterThan(1);
		expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
		expect(
			lines.map(stripTerminalSequences).every((line) => line.startsWith("│  ")),
		).toBe(true);
	});

	test("folds long unbroken strings instead of clipping them to one line", () => {
		const token = "abcdefghijklmnopqrstuvwxyz0123456789";
		const lines = new MessageBlock("user", token, theme)
			.render(10)
			.map(stripTerminalSequences);

		expect(lines.length).toBeGreaterThan(1);
		expect(lines.map((line) => line.slice(3)).join("")).toBe(token);
	});

	test("preserves explicit blank lines and renders empty text as one rail", () => {
		expect(
			new MessageBlock("assistant", "first\n\nlast", theme)
				.render(40)
				.map(stripTerminalSequences),
		).toEqual(["│  first", "│", "│  last"]);
		expect(
			new MessageBlock("user", "", theme)
				.render(40)
				.map(stripTerminalSequences),
		).toEqual(["│"]);
	});

	test("handles CJK, emoji, and combining characters by visible width", () => {
		for (const text of [
			"你好世界你好世界",
			"🙂🙂🙂🙂🙂",
			"e\u0301e\u0301e\u0301e\u0301",
		]) {
			const lines = new MessageBlock("assistant", text, theme).render(8);
			expect(lines.every((line) => visibleWidth(line) <= 8)).toBe(true);
		}
	});

	test("degrades safely at widths zero through two", () => {
		for (const width of [0, 1, 2]) {
			for (const block of [
				new MessageBlock("user", "content🙂", theme),
				new CollapsedToolBlock("bash", theme),
			]) {
				const lines = block.render(width);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			}
		}
		expect(new MessageBlock("user", "content", theme).render(0)).toEqual([]);
	});

	test("keeps tool headers to one truncated line", () => {
		const lines = new CollapsedToolBlock(
			"a-very-long-tool-name\nignored",
			theme,
		).render(12);

		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(12);
		expect(stripTerminalSequences(lines[0] ?? "")).toBe("◆  a-very-lo");
	});

	test("strips injected terminal styling and adds no labels, boxes, or backgrounds", () => {
		const lines = new MessageBlock(
			"assistant",
			"\u001b[41mplain text\u001b[0m",
			theme,
		).render(40);
		const plain = lines.map(stripTerminalSequences).join("\n");
		const rendered = lines.join("\n");

		expect(plain).not.toContain("you:");
		expect(plain).not.toContain("assistant:");
		expect(plain).not.toMatch(/[╭╮╰╯]/);
		expect(rendered).not.toContain("\u001b[4");
		expect(rendered).not.toContain("\u001b[10");
	});

	test("supports cache invalidation", () => {
		const message = new MessageBlock("error", "failed", theme);
		const tool = new CollapsedToolBlock("bash", theme);

		expect(() => message.invalidate()).not.toThrow();
		expect(() => tool.invalidate()).not.toThrow();
	});
});
