import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	areebResourcePaths,
	MAX_RESOURCE_BYTES,
	parseFrontmatter,
	ResourceError,
	readResourceFile,
} from "../../src/coding/resources.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "areeb-resources-"));
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

describe("Areeb resource paths", () => {
	test("uses explicit absolute user and project roots", async () => {
		const directory = await createTempDirectory();
		const paths = areebResourcePaths({
			cwd: join(directory, "project"),
			userRoot: join(directory, "user-resources"),
		});

		expect(paths).toEqual({
			userRoot: join(directory, "user-resources"),
			userSkills: join(directory, "user-resources", "skills"),
			userPrompts: join(directory, "user-resources", "prompts"),
			projectRoot: join(directory, "project", ".areeb"),
			projectSkills: join(directory, "project", ".areeb", "skills"),
			projectPrompts: join(directory, "project", ".areeb", "prompts"),
		});
	});
});

describe("resource frontmatter", () => {
	test("normalizes BOM and line endings while preserving the body", () => {
		expect(
			parseFrontmatter(
				"\uFEFF---\r\n# comment\r\ndescription: value: with colon\r\n\r\n---\r\n\r\n# Body\r\n",
			),
		).toEqual({
			attributes: { description: "value: with colon" },
			body: "\n# Body\n",
		});
	});

	test("rejects malformed, duplicate, and unterminated frontmatter", () => {
		expect(() => parseFrontmatter("---\ninvalid\n---\nbody")).toThrow(
			"Malformed frontmatter entry",
		);
		expect(() =>
			parseFrontmatter("---\nname: first\nname: second\n---\nbody"),
		).toThrow('Duplicate frontmatter key "name"');
		expect(() => parseFrontmatter("---\nname: missing")).toThrow(
			"missing a closing",
		);
	});

	test("rejects oversized files with their absolute path", async () => {
		const directory = await createTempDirectory();
		const filePath = join(directory, "large.md");
		await writeFile(filePath, "x".repeat(MAX_RESOURCE_BYTES + 1));

		try {
			await readResourceFile(filePath);
			throw new Error("Expected readResourceFile to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(ResourceError);
			expect(error).toMatchObject({ filePath });
		}
	});
});
