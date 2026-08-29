import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildSkillIndex,
	discoverProjectAgentSkillDirectories,
	expandSkillInvocation,
	loadSkills,
	loadSkillsWithDiagnostics,
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
	test("loads direct markdown and one-level SKILL.md from Areeb sources", async () => {
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

	test("uses later-source precedence and still rejects invalid metadata", async () => {
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
		const [review] = await loadSkills([first, second]);
		expect(review?.content).toBe("Second body.");
		expect(review?.filePath).toBe(join(second, "review.md"));

		await writeFile(join(first, "Bad_Name.md"), "No frontmatter.");
		await expect(loadSkills(first)).rejects.toThrow("Invalid skill name");
	});

	test("keeps valid siblings and lower-precedence winners when candidates fail", async () => {
		const directory = await createTempDirectory();
		const lower = join(directory, "lower");
		const higher = join(directory, "higher");
		await mkdir(lower);
		await mkdir(higher);
		await writeFile(
			join(lower, "review.md"),
			"---\ndescription: Lower review.\n---\nLower body.",
		);
		await writeFile(join(higher, "review.md"), "Missing description.");
		await writeFile(
			join(higher, "deploy.md"),
			"---\ndescription: Deploy safely.\n---\nDeploy body.",
		);

		const result = await loadSkillsWithDiagnostics([
			{ directory: higher, layout: "areeb", precedence: 20 },
			{ directory: lower, layout: "areeb", precedence: 10 },
		]);
		expect(result.skills.map((skill) => skill.name)).toEqual([
			"deploy",
			"review",
		]);
		expect(
			result.skills.find((skill) => skill.name === "review")?.content,
		).toBe("Lower body.");
		expect(result.diagnostics).toMatchObject([
			{
				kind: "skill",
				code: "validation-failed",
				severity: "warning",
				name: "review",
				path: join(higher, "review.md"),
			},
		]);
	});

	test("reports deterministic duplicates and higher-precedence overrides", async () => {
		const directory = await createTempDirectory();
		const agents = join(directory, "agents");
		const higher = join(directory, "higher");
		for (const parent of ["a", "z"]) {
			await mkdir(join(agents, parent, "review"), { recursive: true });
			await writeFile(
				join(agents, parent, "review", "SKILL.md"),
				`---\ndescription: ${parent}.\n---\n${parent} body.`,
			);
		}
		await mkdir(higher);
		await writeFile(
			join(higher, "review.md"),
			"---\ndescription: Higher.\n---\nHigher body.",
		);

		const result = await loadSkillsWithDiagnostics([
			{ directory: agents, layout: "agents", precedence: 0 },
			{ directory: higher, layout: "areeb", precedence: 1 },
		]);
		expect(result.skills).toMatchObject([
			{ name: "review", content: "Higher body." },
		]);
		expect(result.diagnostics).toEqual([
			{
				kind: "skill",
				code: "duplicate",
				severity: "warning",
				name: "review",
				path: join(agents, "z", "review", "SKILL.md"),
				relatedPath: join(agents, "a", "review", "SKILL.md"),
				message: 'Duplicate skill "review" was skipped',
			},
			{
				kind: "skill",
				code: "overridden",
				severity: "info",
				name: "review",
				path: join(agents, "a", "review", "SKILL.md"),
				relatedPath: join(higher, "review.md"),
				message: 'Skill "review" was overridden by a higher-precedence source',
			},
		]);
	});

	test("continues after an unreadable source and preserves strict failures", async () => {
		const directory = await createTempDirectory();
		const invalidSource = join(directory, "not-a-directory");
		const validSource = join(directory, "valid");
		await writeFile(invalidSource, "file");
		await mkdir(validSource);
		await writeFile(
			join(validSource, "review.md"),
			"---\ndescription: Review.\n---\nReview body.",
		);

		const result = await loadSkillsWithDiagnostics([
			invalidSource,
			validSource,
		]);
		expect(result.skills).toMatchObject([{ name: "review" }]);
		expect(result.diagnostics).toMatchObject([
			{
				kind: "skill",
				code: "source-unreadable",
				severity: "warning",
				path: invalidSource,
			},
		]);
		await expect(loadSkills(invalidSource)).rejects.toThrow(
			"Unable to list skills directory",
		);
	});

	test("recursively loads only .agents SKILL.md layouts and stops at skills", async () => {
		const directory = await createTempDirectory();
		const agents = join(directory, "agents");
		await mkdir(join(agents, "group", "deep-review", "ignored"), {
			recursive: true,
		});
		await writeFile(join(agents, "AGENTS.md"), "Not a skill.");
		await writeFile(
			join(agents, "root.md"),
			"---\ndescription: Root markdown.\n---\nIgnore.",
		);
		await writeFile(
			join(agents, "group", "deep-review", "SKILL.md"),
			"---\ndescription: Deep skill.\n---\nDeep body.",
		);
		await writeFile(
			join(agents, "group", "deep-review", "ignored", "SKILL.md"),
			"---\ndescription: Nested skill.\n---\nNested body.",
		);

		const skills = await loadSkills({ directory: agents, layout: "agents" });
		expect(skills.map((skill) => skill.name)).toEqual(["deep-review"]);
		expect(skills[0]?.content).toBe("Deep body.");
	});

	test("follows symlinks, deduplicates canonical files, and rejects same-source names", async () => {
		const directory = await createTempDirectory();
		const agents = join(directory, "agents");
		const external = join(directory, "external");
		await mkdir(join(agents, "linked-file"), { recursive: true });
		await mkdir(join(external, "shared"), { recursive: true });
		await writeFile(
			join(external, "shared", "SKILL.md"),
			"---\ndescription: Shared skill.\n---\nShared body.",
		);
		await writeFile(
			join(external, "file-skill.md"),
			"---\ndescription: Linked file.\n---\nLinked body.",
		);
		await symlink(join(external, "shared"), join(agents, "shared"));
		await symlink(join(external, "shared"), join(agents, "shared-copy"));
		await symlink(
			join(external, "file-skill.md"),
			join(agents, "linked-file", "SKILL.md"),
		);

		const skills = await loadSkills([
			{ directory: agents, layout: "agents" },
			{ directory: agents, layout: "agents" },
		]);
		expect(skills.map((skill) => skill.name)).toEqual([
			"linked-file",
			"shared",
		]);
		const diagnosticResult = await loadSkillsWithDiagnostics([
			{ directory: agents, layout: "agents" },
			{ directory: agents, layout: "agents" },
		]);
		expect(diagnosticResult.skills.map((skill) => skill.name)).toEqual([
			"linked-file",
			"shared",
		]);
		expect(diagnosticResult.diagnostics).toEqual([]);

		const duplicates = join(directory, "duplicates");
		await mkdir(join(duplicates, "a", "review"), { recursive: true });
		await mkdir(join(duplicates, "b", "review"), { recursive: true });
		for (const parent of ["a", "b"]) {
			await writeFile(
				join(duplicates, parent, "review", "SKILL.md"),
				`---\ndescription: ${parent}.\n---\n${parent}.`,
			);
		}
		await expect(
			loadSkills({ directory: duplicates, layout: "agents" }),
		).rejects.toThrow('Duplicate skill "review"');
	});

	test("reports broken symlinks without following directory cycles", async () => {
		const directory = await createTempDirectory();
		const agents = join(directory, "agents");
		await mkdir(join(agents, "cycle"), { recursive: true });
		await mkdir(join(agents, "valid"), { recursive: true });
		await symlink(join(directory, "missing"), join(agents, "broken"));
		await symlink(join(agents, "cycle"), join(agents, "cycle", "self"));
		await writeFile(
			join(agents, "valid", "SKILL.md"),
			"---\ndescription: Valid.\n---\nValid body.",
		);

		const result = await loadSkillsWithDiagnostics({
			directory: agents,
			layout: "agents",
		});
		expect(result.skills).toMatchObject([{ name: "valid" }]);
		expect(result.diagnostics).toMatchObject([
			{
				kind: "skill",
				code: "read-failed",
				severity: "warning",
				path: join(agents, "broken"),
			},
		]);
	});

	test("discovers project .agents directories from the nearest Git root", async () => {
		const directory = await createTempDirectory();
		const repository = join(directory, "repository");
		const cwd = join(repository, "packages", "app");
		await mkdir(cwd, { recursive: true });
		await writeFile(join(repository, ".git"), "gitdir: elsewhere");

		expect(
			await discoverProjectAgentSkillDirectories(
				cwd,
				join(directory, "user-agents", "skills"),
			),
		).toEqual([
			join(repository, ".agents", "skills"),
			join(repository, "packages", ".agents", "skills"),
			join(cwd, ".agents", "skills"),
		]);

		const outsideGit = join(directory, "outside", "nested");
		expect(
			await discoverProjectAgentSkillDirectories(
				outsideGit,
				join(directory, "user-agents", "skills"),
			),
		).toEqual([join(outsideGit, ".agents", "skills")]);
		expect(
			await discoverProjectAgentSkillDirectories(
				repository,
				join(repository, ".agents", "skills"),
			),
		).toEqual([]);
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
		expect(expandSkillInvocation("/skill", [])).toBe("/skill");
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
