import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	MessageBlock,
	ThinkingBlock,
	ToolBlock,
	ToolGroupBlock,
} from "../../../src/coding/tui/blocks.ts";
import { AREEB_DARK_THEME } from "../../../src/coding/tui/theme.ts";

const theme = AREEB_DARK_THEME;

describe("TUI transcript blocks", () => {
	test("renders bordered user rows and inset, label-free assistant rows", () => {
		const user = new MessageBlock("user", "hello", theme);
		const assistant = new MessageBlock("assistant", "welcome", theme);
		const status = new MessageBlock("status", "waiting", theme);
		const tool = new ToolBlock("bash", theme, { isError: false });

		const userLines = user.render(40).map(stripTerminalSequences);
		expect(userLines).toHaveLength(3);
		expect(userLines[0]).toBe(`╭${"─".repeat(38)}╮`);
		expect(userLines[1]).toStartWith("│  › hello");
		expect(userLines[2]).toBe(`╰${"─".repeat(38)}╯`);
		expect(userLines.every((line) => visibleWidth(line) === 40)).toBe(true);
		expect(user.render(40).join("\n")).toContain("38;2;57;118;94");
		expect(assistant.render(40).map(stripTerminalSequences)).toEqual([
			" welcome",
		]);
		expect(status.render(40).map(stripTerminalSequences)).toEqual([
			"│  waiting",
		]);
		expect(tool.render(40).map(stripTerminalSequences)).toEqual([
			"■ Ran 1 command (Ctrl+O to Expand)",
		]);
	});

	test("wraps assistant text naturally within the requested width", () => {
		const block = new MessageBlock(
			"assistant",
			"A long response wraps at words and keeps its semantic rail visible.",
			theme,
		);
		const lines = block.render(20);

		expect(lines.length).toBeGreaterThan(1);
		expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
		expect(lines.map(stripTerminalSequences).join(" ")).not.toContain("│");
	});

	test("renders compact thinking with a shortcut and sanitized expanded content", () => {
		const rendered = new ThinkingBlock(
			"\u001b[31m**first thought** that wraps\u001b[0m\nsecond",
			theme,
			{ expanded: true },
		).render(18);
		const plain = rendered.map(stripTerminalSequences);

		expect(plain[0]).toStartWith("Thinking...");
		expect(plain[0]).not.toContain("●");
		expect(plain.join("\n")).toContain("first");
		expect(plain.join("\n")).toContain("thought");
		expect(plain.join("\n")).toContain("wraps");
		expect(plain.join("\n")).toContain("second");
		expect(rendered.every((line) => visibleWidth(line) <= 18)).toBe(true);
		expect(rendered[0]).toContain("38;2;138;190;183");
		expect(rendered.join("\n")).toContain("38;2;112;112;112");
		expect(rendered.join("\n")).toContain("\u001b[3m");
		expect(rendered.join("\n")).not.toContain("\u001b[31m");
		expect(plain.join("\n")).not.toContain("**");
	});

	test("summarizes collapsed thinking without a completed-state circle", () => {
		const rendered = new ThinkingBlock(
			"**Examining** header utilities and provider integrations",
			theme,
		).render(100);
		const plain = rendered.map(stripTerminalSequences);

		expect(plain).toEqual([
			"Thinking... · Examining header utilities and provider integrations (Ctrl+T to Expand)",
		]);
		expect(plain[0]).not.toContain("●");
		expect(rendered[0]).toContain("38;2;138;190;183");
	});

	test("shows only the latest complete thinking summary when collapsed", () => {
		const rendered = new ThinkingBlock(
			"Outlining key files\n\nExplaining startup flow\n\nChecking lifecycle cleanup",
			theme,
		).render(100);

		expect(rendered.map(stripTerminalSequences)).toEqual([
			"Thinking... · Checking lifecycle cleanup (Ctrl+T to Expand)",
		]);
	});

	test("renders assistant Markdown while leaving user Markdown literal", () => {
		const assistant = new MessageBlock(
			"assistant",
			"###### Heading\n\n- **bold** and `code`\n\n```typescript\nconst answer: number = 42;\n```",
			theme,
		)
			.render(30)
			.map(stripTerminalSequences);
		const user = new MessageBlock("user", "**bold** and `code`", theme)
			.render(30)
			.map(stripTerminalSequences);

		expect(assistant.join("\n")).toContain("Heading");
		expect(assistant.join("\n")).not.toContain("######");
		expect(assistant.join("\n")).not.toContain("```");
		expect(assistant.join("\n")).toContain("- bold and code");
		expect(assistant.join("\n")).toContain("const answer: number = 42;");
		expect(
			new MessageBlock(
				"assistant",
				"```typescript\nconst answer: number = 42;\n```",
				theme,
			)
				.render(40)
				.join("\n"),
		).toContain("38;2;79;193;255");
		expect(user).toHaveLength(3);
		expect(user[1]).toContain("› **bold** and `code`");
		expect(assistant.every((line) => visibleWidth(line) <= 30)).toBe(true);
	});

	test("renders incomplete fenced code without throwing", () => {
		const block = new MessageBlock(
			"assistant",
			"```unknown\nconst answer = 42;",
			theme,
		);

		expect(() => block.render(20)).not.toThrow();
		expect(
			block.render(20).map(stripTerminalSequences).join("\n"),
		).not.toContain("```");
		expect(block.render(20).every((line) => visibleWidth(line) <= 20)).toBe(
			true,
		);
	});

	test("folds long unbroken strings instead of clipping them to one line", () => {
		const token = "abcdefghijklmnopqrstuvwxyz0123456789";
		const lines = new MessageBlock("user", token, theme)
			.render(10)
			.map(stripTerminalSequences);

		expect(lines.length).toBeGreaterThan(3);
		const content = lines
			.slice(1, -1)
			.map((line, index) =>
				line
					.slice(3, -3)
					.replace(index === 0 ? /^› / : /^ {2}/, "")
					.trimEnd(),
			)
			.join("");
		expect(content).toBe(token);
	});

	test("preserves explicit blank lines and renders empty user text as a prompt", () => {
		expect(
			new MessageBlock("assistant", "first\n\nlast", theme)
				.render(40)
				.map(stripTerminalSequences),
		).toEqual([" first", "", " last"]);
		const emptyUser = new MessageBlock("user", "", theme)
			.render(40)
			.map(stripTerminalSequences);
		expect(emptyUser).toHaveLength(3);
		expect(emptyUser[1]).toMatch(/^│ {2}› +│$/);
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
				new ThinkingBlock("reasoning🙂", theme),
				new ToolBlock("bash", theme),
			]) {
				const lines = block.render(width);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			}
		}
		expect(new MessageBlock("user", "content", theme).render(0)).toEqual([]);
	});

	test("keeps tool headers to one truncated line", () => {
		const lines = new ToolBlock("a-very-long-tool-name\nignored", theme, {
			isError: false,
		}).render(12);

		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(12);
		expect(stripTerminalSequences(lines[0] ?? "")).toBe("■ Ran 1 com…");
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
		expect(expanded.length).toBeLessThanOrEqual(18);
		expect(expanded.join("\n")).toContain("lines omitted");
		expect(expanded.join("\n")).toContain("**literal**");
		expect(expanded.every((line) => visibleWidth(line) <= 24)).toBe(true);
	});

	test("updates a mounted tool block in place", () => {
		const tool = new ToolBlock("read", theme, {
			expanded: true,
			preview: "old preview",
		});

		expect(tool.render(40).map(stripTerminalSequences)).toContain(
			"    old preview",
		);
		tool.update({ preview: "new preview", isError: true });
		const rendered = tool.render(40);
		expect(rendered.map(stripTerminalSequences)).toContain("    new preview");
		expect(rendered[0]).toContain("38;2;252;66;75");
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
			"● Ran 1 command (Ctrl+O to Co…",
			"  └ edit",
			"    @@ -1 +1 @@",
			"    - old",
			"    + new",
		]);
		expect(rendered[0]).toContain("38;2;252;66;75");
	});

	test("styles every unified-diff category before wrapping", () => {
		const tool = new ToolBlock("edit", theme, {
			expanded: true,
			patch: [
				"diff --git a/file b/file",
				"index 111..222 100644",
				"--- a/file",
				"+++ b/file",
				"@@ -1 +1 @@",
				" context",
				"-removed",
				"+added and wrapped across the available width",
				"\\ No newline at end of file",
			].join("\n"),
		});
		const rendered = tool.render(24);
		const plain = rendered.map(stripTerminalSequences);
		const styledLine = (text: string): string => {
			const index = plain.findIndex((line) => line.includes(text));
			return rendered[index] ?? "";
		};

		expect(plain).toContain("    file");
		expect(plain.join("\n")).not.toContain("diff --git");
		expect(plain.join("\n")).not.toContain("--- a/file");
		expect(styledLine("@@ -1")).toContain("38;2;138;190;183");
		expect(styledLine("context")).toContain("38;2;192;192;192");
		expect(styledLine("removed")).toContain("38;2;252;66;75");
		const addedIndex = plain.findIndex((line) => line.includes("+ added"));
		expect(addedIndex).toBeGreaterThan(0);
		expect(rendered[addedIndex]).toContain("38;2;0;189;125");
		expect(rendered[addedIndex + 1]).toContain("38;2;0;189;125");
	});

	test("groups consecutive tool activity under one command summary", () => {
		const group = new ToolGroupBlock(theme, [
			{ toolName: "read", isError: false },
			{ toolName: "edit", active: true },
		]);
		const active = group.render(60).map(stripTerminalSequences);
		expect(active).toHaveLength(1);
		expect(active[0]).toContain("Ran 2 commands (Ctrl+O to Expand)");
		expect(active[0]).not.toStartWith("●");

		group.update([
			{ toolName: "read", isError: false },
			{ toolName: "edit", isError: false },
		]);
		expect(group.render(60).map(stripTerminalSequences)).toEqual([
			"■ Ran 2 commands (Ctrl+O to Expand)",
		]);
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
		const thinking = new ThinkingBlock("reasoning", theme);
		const tool = new ToolBlock("bash", theme);

		expect(() => message.invalidate()).not.toThrow();
		expect(() => thinking.invalidate()).not.toThrow();
		expect(() => tool.invalidate()).not.toThrow();
	});
});
