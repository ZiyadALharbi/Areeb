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
		const thinking = new ThinkingBlock("Planning the change", theme);
		const tool = new ToolBlock("bash", theme, { isError: false });

		const userLines = user.render(40).map(stripTerminalSequences);
		expect(userLines).toHaveLength(3);
		expect(userLines[0]).toBe(`╭${"─".repeat(38)}╮`);
		expect(userLines[1]).toStartWith("│  › hello");
		expect(userLines[2]).toBe(`╰${"─".repeat(38)}╯`);
		expect(userLines.every((line) => visibleWidth(line) === 40)).toBe(true);
		expect(user.render(40).join("\n")).toContain("38;2;57;118;94");
		expect(assistant.render(40).map(stripTerminalSequences)).toEqual([
			"",
			" welcome",
		]);
		expect(status.render(40).map(stripTerminalSequences)).toEqual([
			"│  waiting",
		]);
		expect(thinking.render(40).map(stripTerminalSequences)).toEqual([
			" Thought · Planning the change",
		]);
		expect(tool.render(40).map(stripTerminalSequences)).toEqual([
			" Ran 1 command · success",
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

	test("renders compact thinking with sanitized expanded content", () => {
		const rendered = new ThinkingBlock(
			"\u001b[31m**first thought** that wraps\u001b[0m\nsecond",
			theme,
			{ expanded: true },
		).render(18);
		const plain = rendered.map(stripTerminalSequences);

		expect(plain[0]).toStartWith(" Thought");
		expect(plain[0]).not.toContain("Thinking...");
		expect(plain[0]).not.toContain("●");
		expect(plain[0]).not.toContain("Ctrl+T");
		expect(plain[0]).not.toContain("Ctrl+O");
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
			" Thought · Examining header utilities and provider integrations",
		]);
		expect(plain[0]).not.toContain("●");
		expect(rendered[0]).toContain("38;2;138;190;183");
	});

	test("spins while thinking and keeps the assistant color", () => {
		const rendered = new ThinkingBlock("Inspecting files", theme, {
			active: true,
		}).render(60);
		const plain = rendered.map(stripTerminalSequences);

		expect(plain).toHaveLength(1);
		expect(plain[0]).toMatch(/ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking... · Inspecting files/);
		expect(plain[0]).not.toContain("Thought");
		expect(rendered[0]).toContain("38;2;138;190;183");
	});

	test("shows only the latest complete thinking summary when collapsed", () => {
		const rendered = new ThinkingBlock(
			"Outlining key files\n\nExplaining startup flow\n\nChecking lifecycle cleanup",
			theme,
		).render(100);

		expect(rendered.map(stripTerminalSequences)).toEqual([
			" Thought · Checking lifecycle cleanup",
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
		const emphasized = new MessageBlock(
			"assistant",
			"### Gold heading\n\nA **Transformer** uses **attention**.",
			theme,
		).render(80);
		const headingLine = emphasized.find((line) =>
			line.includes("Gold heading"),
		);
		const proseLine = emphasized.find((line) => line.includes("Transformer"));
		expect(headingLine).toContain("38;2;241;198;116");
		expect(headingLine).not.toContain("38;2;182;189;104");
		expect(proseLine).toContain("\u001b[38;2;182;189;104m\u001b[1mTransformer");
		expect(proseLine).toContain("\u001b[38;2;182;189;104m\u001b[1mattention");
		expect(
			new MessageBlock("assistant", "`technical term`", theme)
				.render(40)
				.join("\n"),
		).toContain("38;2;182;189;104");
		expect(
			new MessageBlock(
				"assistant",
				"```typescript\nconst answer: number = 42;\n```",
				theme,
			)
				.render(40)
				.join("\n"),
		).toContain("38;2;77;158;255");
		expect(user).toHaveLength(3);
		expect(user[1]).toContain("› **bold** and `code`");
		expect(assistant.every((line) => visibleWidth(line) <= 30)).toBe(true);
	});

	test("renders unlabelled and plain-text output blocks as normal text", () => {
		const rendered = new MessageBlock(
			"assistant",
			"```text\nHead 1: attends nearby words\nHead 2: tracks subjects\n```",
			theme,
		).render(60);

		expect(rendered).toHaveLength(3);
		expect(
			rendered.slice(1).every((line) => line.includes("38;2;245;245;245")),
		).toBe(true);
	});

	test("renders Markdown diff blocks with standard syntax highlighting", () => {
		const rendered = new MessageBlock(
			"assistant",
			[
				"```diff",
				"diff --git a/src/first.ts b/src/first.ts",
				"--- a/src/first.ts",
				"+++ b/src/first.ts",
				"@@ -9,2 +9,2 @@",
				" context",
				"-old",
				"+new",
				"diff --git a/src/second.ts b/src/second.ts",
				"--- a/src/second.ts",
				"+++ b/src/second.ts",
				"@@ -20 +20 @@",
				"-before",
				"+after",
				"```",
			].join("\n"),
			theme,
		).render(80);
		const plain = rendered.map(stripTerminalSequences);

		expect(plain.join("\n")).toContain(
			"diff --git a/src/first.ts b/src/first.ts",
		);
		expect(plain.join("\n")).toContain("--- a/src/first.ts");
		expect(plain.join("\n")).toContain("+++ b/src/second.ts");
		expect(plain.join("\n")).not.toContain("◆ Edit");
		expect(
			rendered.find((line) => stripTerminalSequences(line).includes("-old")),
		).toContain("38;2;252;66;75");
		expect(
			rendered.find((line) => stripTerminalSequences(line).includes("+new")),
		).toContain("38;2;139;184;232");
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
		).toEqual(["", " first", "", " last"]);
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
		expect(stripTerminalSequences(lines[0] ?? "")).toBe(" Ran 1 comm…");
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

	test("prefers structured edit display data and uses the error accent", () => {
		const tool = new ToolBlock("edit", theme, {
			expanded: true,
			preview: "success",
			edit: {
				path: "src/file.ts",
				diff: "-1 old\n+1 new",
				patch: "@@ -99 +99 @@\n-patch old\n+patch new",
				firstChangedLine: 1,
			},
			isError: true,
		});
		const rendered = tool.render(30);

		expect(rendered.map(stripTerminalSequences)).toEqual([
			" Ran 1 command · failed",
			" ◆ Edit src/file.ts",
			"",
			"    1  - old",
			"    1  + new",
		]);
		expect(rendered[0]).toContain("38;2;252;66;75");
		expect(rendered.join("\n")).not.toContain("patch old");
	});

	test("renders an edit title and aligned diff line numbers", () => {
		const tool = new ToolBlock("edit", theme, {
			expanded: true,
			edit: {
				path: "tests/coding/tui/blocks.test.ts",
				diff: ["  99 context", "-100 old", "+100 new", " 101 trailing"].join(
					"\n",
				),
				patch: [
					"--- a/wrong.ts",
					"+++ b/wrong.ts",
					"@@ -99,4 +99,4 @@",
					" context",
					"-old",
					"+new",
					" trailing",
				].join("\n"),
				firstChangedLine: 100,
			},
		});
		const rendered = tool.render(80);
		const plain = rendered.map(stripTerminalSequences);

		expect(plain).toEqual([
			" Ran 1 command",
			" ◆ Edit tests/coding/tui/blocks.test.ts",
			"",
			"     99    context",
			"    100  - old",
			"    100  + new",
			"    101    trailing",
		]);
		expect(rendered[1]).toContain(theme.primary("Edit"));
		expect(rendered[1]).toContain(theme.tool("◆"));
		expect(rendered[1]).toContain(
			theme.warning("tests/coding/tui/blocks.test.ts"),
		);
		expect(rendered[3]).toContain(theme.diffContext("  context"));
		expect(rendered[4]).toContain(theme.diffRemoved("100  "));
		expect(rendered[5]).toContain(theme.diffAdded("100  "));
		expect(plain.join("\n")).not.toContain("wrong.ts");
	});

	test("uses the unified patch only as a styled display fallback", () => {
		const tool = new ToolBlock("edit", theme, {
			expanded: true,
			edit: {
				path: "src/canonical.ts",
				diff: "",
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
				firstChangedLine: 1,
			},
		});
		const rendered = tool.render(24);
		const plain = rendered.map(stripTerminalSequences);
		const styledLine = (text: string): string => {
			const index = plain.findIndex((line) => line.includes(text));
			return rendered[index] ?? "";
		};

		expect(plain).toContain(" ◆ Edit src/canonical.ts");
		expect(plain.join("\n")).not.toContain("diff --git");
		expect(plain.join("\n")).not.toContain("--- a/file");
		expect(plain.join("\n")).not.toContain("◆ Edit file");
		expect(styledLine("@@ -1")).toContain("38;2;138;190;183");
		expect(styledLine("context")).toContain("38;2;192;192;192");
		expect(styledLine("removed")).toContain("38;2;252;66;75");
		expect(styledLine("No newline")).toContain("38;2;112;112;112");
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
		expect(active[0]).toMatch(/ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] running 2 commands/);
		expect(active[0]).not.toContain("Ran");
		expect(active[0]).not.toContain("Ctrl+O");
		expect(active[0]).not.toContain("Ctrl+T");

		group.update([
			{ toolName: "read", isError: false },
			{ toolName: "edit", isError: false },
		]);
		expect(group.render(60).map(stripTerminalSequences)).toEqual([
			" Ran 2 commands · success",
		]);
		expect(group.render(60)[0]).toContain("38;2;0;189;125");

		group.update([
			{ toolName: "read", preview: "content", isError: false },
			{
				toolName: "edit",
				edit: {
					path: "src/group.ts",
					diff: "+1 content",
					patch: "@@ -0,0 +1 @@\n+content",
					firstChangedLine: 1,
				},
				isError: false,
			},
		]);
		group.setExpanded(true);
		const expanded = group.render(60).map(stripTerminalSequences);
		expect(expanded).toContain("  ├ read");
		expect(expanded).toContain(" ◆ Edit src/group.ts");
		expect(expanded).toContain("    1  + content");
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
