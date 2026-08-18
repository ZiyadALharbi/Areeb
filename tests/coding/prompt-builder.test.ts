import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildSystemPrompt } from "../../src/coding/prompt-builder.ts";
import type { Skill } from "../../src/coding/skills.ts";
import type { CodingToolDefinition } from "../../src/coding/types.ts";

function tool(
	name: string,
	promptSnippet?: string,
	promptGuidelines?: readonly string[],
): CodingToolDefinition {
	return {
		name,
		description: `${name} tool`,
		inputSchema: z.object({}),
		...(promptSnippet === undefined ? {} : { promptSnippet }),
		...(promptGuidelines === undefined ? {} : { promptGuidelines }),
		async executor() {
			return { content: [] };
		},
	};
}

const reviewSkill: Skill = {
	name: "code-review",
	description: "Review <code> & report 'risks'.",
	content: "Full instructions must stay out of the index.",
	filePath: "/skills/a&b/SKILL.md",
	baseDir: "/skills/a&b",
};

describe("buildSystemPrompt", () => {
	test("builds the exact default prompt in active-tool and guideline order", () => {
		const prompt = buildSystemPrompt({
			cwd: "/workspace",
			tools: [
				tool("read", "  Read\n file contents  ", [
					" Inspect before editing ",
					"Shared rule",
				]),
				tool("custom", undefined, ["Shared rule", "", "Custom rule"]),
			],
			extraGuidelines: [
				" Custom rule ",
				"Extra rule",
				"Be concise in your responses",
			],
		});

		expect(
			prompt,
		).toBe(`You are an expert coding assistant operating inside Areeb, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Inspect before editing
- Shared rule
- Custom rule
- Extra rule
- Be concise in your responses
- Review applicable project instructions and relevant files before making changes
- Keep changes focused and consistent with the existing architecture and conventions
- Preserve unrelated work already present in the project
- Follow the project's documented workflows, commands, and package manager
- After changing code, run the applicable formatting, linting, type-checking, and test commands
- Report verification accurately and only claim results from commands you actually ran
- Request confirmation before destructive actions or decisions with materially unclear requirements
- Show file paths clearly when working with files

Current working directory: /workspace`);
	});

	test("renders no tools with only baseline guidelines", () => {
		expect(buildSystemPrompt({ cwd: "/repo", tools: [] })).toBe(
			`You are an expert coding assistant operating inside Areeb, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
(none)

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Review applicable project instructions and relevant files before making changes
- Keep changes focused and consistent with the existing architecture and conventions
- Preserve unrelated work already present in the project
- Follow the project's documented workflows, commands, and package manager
- After changing code, run the applicable formatting, linting, type-checking, and test commands
- Report verification accurately and only claim results from commands you actually ran
- Request confirmation before destructive actions or decisions with materially unclear requirements
- Be concise in your responses
- Show file paths clearly when working with files

Current working directory: /repo`,
		);
	});

	test("replaces the default base while preserving append and context order", () => {
		const prompt = buildSystemPrompt({
			cwd: "C:\\repo\\app",
			tools: [],
			customPrompt: "Custom base",
			appendSystemPrompt: "Append next",
			contextFiles: [
				{ path: '/repo/a&"<.md', content: "first\ncontent" },
				{ path: "/repo/second.md", content: "second" },
			],
		});

		expect(prompt).toBe(`Custom base

Append next

<project_context>

Project-specific instructions and guidelines. Later files have higher specificity:

<project_instructions path="/repo/a&amp;&quot;&lt;.md">
first
content
</project_instructions>

<project_instructions path="/repo/second.md">
second
</project_instructions>

</project_context>

Current working directory: C:/repo/app`);
		expect(prompt).not.toContain("Available tools:");
	});

	test("includes escaped skill metadata only when read is active", () => {
		const withoutRead = buildSystemPrompt({
			cwd: "/repo",
			tools: [tool("bash", "Run commands")],
			skills: [reviewSkill],
		});
		const withRead = buildSystemPrompt({
			cwd: "/repo",
			tools: [tool("read", "Read files")],
			skills: [reviewSkill],
		});

		expect(withoutRead).not.toContain("<available_skills>");
		expect(withRead).toContain("<available_skills>");
		expect(withRead).toContain(
			"<description>Review &lt;code&gt; &amp; report &apos;risks&apos;.</description>",
		);
		expect(withRead).toContain("<location>/skills/a&amp;b/SKILL.md</location>");
		expect(withRead).not.toContain(reviewSkill.content);
	});

	test("rejects whitespace custom prompts and is deterministic", () => {
		expect(() =>
			buildSystemPrompt({
				cwd: "/repo",
				tools: [],
				customPrompt: " \n\t ",
			}),
		).toThrow("Custom system prompt cannot be empty");

		const options = {
			cwd: "/repo",
			tools: [tool("read", "Read files", ["Use read first"])],
			skills: [reviewSkill],
		} as const;
		expect(buildSystemPrompt(options)).toBe(buildSystemPrompt(options));
	});
});
