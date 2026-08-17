import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildSkillIndex,
	expandSkillInvocation,
	loadSkills,
} from "../../src/coding/skills.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "areeb-skills-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("skill loading", () => {
	test("loads only direct markdown and one-level SKILL.md layouts", async () => {
		const directory = await createTempDirectory();
		await mkdir(join(directory, "typescript-testing"), { recursive: true });
		await mkdir(join(directory, "ignored", "nested"), { recursive: true });
		await writeFile(
			join(directory, "git-review.md"),
			"---\ndescription: Review git changes safely.\n---\nReview the diff.",
		);
		await writeFile(
			join(directory, "typescript-testing", "SKILL.md"),
			"---\nname: typescript-testing\ndescription: Write TypeScript tests.\n---\nRun focused tests.\n",
		);
		await writeFile(
			join(directory, "ignored", "nested", "SKILL.md"),
			"---\ndescription: Ignore me.\n---\nIgnored.",
		);

		const skills = await loadSkills(directory);
		expect(skills.map((skill) => skill.name)).toEqual([
			"git-review",
			"typescript-testing",
		]);
		expect(skills[1]).toMatchObject({
			description: "Write TypeScript tests.",
			content: "Run focused tests.\n",
			baseDir: join(directory, "typescript-testing"),
		});
	});

	test("rejects invalid metadata and duplicates across roots", async () => {
		const directory = await createTempDirectory();
		const first = join(directory, "first");
		const second = join(directory, "second");
		await mkdir(first);
		await mkdir(second);
		await writeFile(
			join(first, "review.md"),
			"---\ndescription: First.\n---\nFirst body.",
		);
		await writeFile(
			join(second, "review.md"),
			"---\ndescription: Second.\n---\nSecond body.",
		);
		await expect(loadSkills([first, second])).rejects.toThrow(
			'Duplicate skill "review"',
		);

		await writeFile(join(first, "Bad_Name.md"), "No frontmatter.");
		await expect(loadSkills(first)).rejects.toThrow("Invalid skill name");
	});
});

describe("skill prompt formatting", () => {
	test("expands arguments and builds an escaped index with locations", async () => {
		const directory = await createTempDirectory();
		await writeFile(
			join(directory, "review.md"),
			"---\ndescription: Review <changes> & report.\n---\nInspect references/file.md.\n",
		);
		const skills = await loadSkills(directory);

		expect(
			expandSkillInvocation("/skill:review   src/app.ts\ncarefully ", skills),
		).toBe(`<skill name="review" location="${join(directory, "review.md")}">
References are relative to ${directory}.

Inspect references/file.md.
</skill>

src/app.ts
carefully`);
		const index = buildSkillIndex(skills);
		expect(
			index,
		).toBe(`The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>review</name>
    <description>Review &lt;changes&gt; &amp; report.</description>
    <location>${join(directory, "review.md")}</location>
  </skill>
</available_skills>`);
		expect(index).not.toContain("Inspect references/file.md");
	});

	test("rejects unknown and malformed directives without matching later text", () => {
		expect(() => expandSkillInvocation("/skill:missing", [])).toThrow(
			"Unknown skill",
		);
		expect(() => expandSkillInvocation("/skill:", [])).toThrow(
			"Malformed skill invocation",
		);
		expect(expandSkillInvocation("Use /skill:missing", [])).toBe(
			"Use /skill:missing",
		);
	});
});
