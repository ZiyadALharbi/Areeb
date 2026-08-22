import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { MessageBlock, ToolBlock } from "../../../src/coding/tui/blocks.ts";
import { AREEB_DARK_THEME } from "../../../src/coding/tui/theme.ts";

const theme = AREEB_DARK_THEME;

describe("TUI transcript blocks", () => {
	test("renders transparent, label-free rows at normal widths", () => {
		const user = new MessageBlock("user", "hello", theme);
		const assistant = new MessageBlock("assistant", "welcome", theme);
		const status = new MessageBlock("status", "waiting", theme);
		const tool = new ToolBlock("bash", theme);

		expect(user.render(40).map(stripTerminalSequences)).toEqual(["│  hello"]);
		expect(assistant.render(40).map(stripTerminalSequences)).toEqual([
			"│  welcome",
		]);
		expect(status.render(40).map(stripTerminalSequences)).toEqual([
			"│  waiting",
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

	test("renders assistant Markdown while leaving user Markdown literal", () => {
		const assistant = new MessageBlock(
			"assistant",
			"## Heading\n\n- **bold** and `code`",
			theme,
		)
			.render(30)
			.map(stripTerminalSequences);
		const user = new MessageBlock("user", "**bold** and `code`", theme)
			.render(30)
			.map(stripTerminalSequences);

		expect(assistant.join("\n")).toContain("Heading");
		expect(assistant.join("\n")).toContain("- bold and code");
		expect(user).toEqual(["│  **bold** and `code`"]);
		expect(assistant.every((line) => visibleWidth(line) <= 30)).toBe(true);
	});

	test("renders incomplete fenced code without throwing", () => {
		const block = new MessageBlock(
			"assistant",
			"```unknown\nconst answer = 42;",
			theme,
		);

		expect(() => block.render(20)).not.toThrow();
		expect(block.render(20).every((line) => visibleWidth(line) <= 20)).toBe(
			true,
		);
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
				new ToolBlock("bash", theme),
			]) {
				const lines = block.render(width);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			}
		}
		expect(new MessageBlock("user", "content", theme).render(0)).toEqual([]);
	});

	test("keeps tool headers to one truncated line", () => {
		const lines = new ToolBlock("a-very-long-tool-name\nignored", theme).render(
			12,
		);

		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(12);
		expect(stripTerminalSequences(lines[0] ?? "")).toBe("◆  a-very-lo");
	});

	test("keeps tool output collapsed until expanded and bounds its lines", () => {
		const preview = Array.from(
			{ length: 30 },
			(_, index) => `line ${index + 1} **literal**`,
		).join("\n");
		const tool = new ToolBlock("bash", theme, { preview });

		expect(tool.render(24)).toHaveLength(1);
		tool.setExpanded(true);
		const expanded = tool.render(24).map(stripTerminalSequences);
		expect(expanded.length).toBeLessThanOrEqual(17);
		expect(expanded.join("\n")).toContain("lines omitted");
		expect(expanded.join("\n")).toContain("**literal**");
		expect(expanded.every((line) => visibleWidth(line) <= 24)).toBe(true);
	});

	test("prefers a literal edit patch and uses the error accent", () => {
		const tool = new ToolBlock("edit", theme, {
			expanded: true,
			preview: "success",
			patch: "@@ -1 +1 @@\n-old\n+new",
			isError: true,
		});
		const rendered = tool.render(30);

		expect(rendered.map(stripTerminalSequences)).toEqual([
			"◆  edit",
			"   @@ -1 +1 @@",
			"   -old",
			"   +new",
		]);
		expect(rendered[0]).toContain("38;2;247;118;142");
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
		const tool = new ToolBlock("bash", theme);

		expect(() => message.invalidate()).not.toThrow();
		expect(() => tool.invalidate()).not.toThrow();
	});
});
