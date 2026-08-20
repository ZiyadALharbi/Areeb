import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultCommandRegistry } from "../../src/coding/commands.ts";
import {
	expandPromptTemplateInvocation,
	loadPromptTemplates,
	renderPromptTemplate,
} from "../../src/coding/prompt-templates.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "areeb-prompts-"));
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

describe("prompt template loading", () => {
	test("loads direct markdown with metadata and a description fallback", async () => {
		const directory = await createTempDirectory();
		await mkdir(join(directory, "nested"));
		await writeFile(
			join(directory, "review.md"),
			"---\ndescription: Review code.\nargument-hint: <target>\n---\nReview {{ arguments }}.",
		);
		await writeFile(join(directory, "explain.md"), "Explain this code.\n");
		await writeFile(join(directory, "nested", "ignored.md"), "Ignored.");

		const templates = await loadPromptTemplates(directory);
		expect(templates.map((template) => template.name)).toEqual([
			"explain",
			"review",
		]);
		expect(templates[0]?.description).toBe("Explain this code.");
		expect(templates[1]).toMatchObject({
			description: "Review code.",
			argumentHint: "<target>",
		});
	});

	test("rejects executable command names and lets search terms remain available", async () => {
		const directory = await createTempDirectory();
		const registry = createDefaultCommandRegistry();
		const helpPath = join(directory, "help.md");
		await writeFile(helpPath, "Cannot replace help.");
		await expect(
			loadPromptTemplates(directory, {
				reservedNames: registry.executableNames(),
			}),
		).rejects.toThrow(`${helpPath}: Prompt template name "help" conflicts`);

		await rm(helpPath);
		await writeFile(
			join(directory, "clear.md"),
			"Search terms do not reserve.",
		);
		expect(
			await loadPromptTemplates(directory, {
				reservedNames: registry.executableNames(),
			}),
		).toMatchObject([{ name: "clear" }]);

		await rm(join(directory, "clear.md"));
		const other = await createTempDirectory();
		await writeFile(join(directory, "review.md"), "First.");
		await writeFile(join(other, "review.md"), "Second.");
		const templates = await loadPromptTemplates([directory, other]);
		expect(templates).toHaveLength(1);
		expect(templates[0]?.content).toBe("Second.");
		expect(templates[0]?.filePath).toBe(join(other, "review.md"));
	});
});

describe("prompt template rendering", () => {
	test("renders repeated variables once, rejects missing values, and ignores extras", () => {
		const template = {
			name: "review",
			description: "Review.",
			content: "{{ target }} then {{ target }} for {{ focus }}.",
			filePath: "/prompts/review.md",
		};

		expect(
			renderPromptTemplate(template, {
				target: "{{ focus }}",
				focus: "correctness",
				extra: "ignored",
			}),
		).toBe("{{ focus }} then {{ focus }} for correctness.");
		expect(() => renderPromptTemplate(template, { target: "src" })).toThrow(
			'Missing prompt template variable "focus"',
		);
	});

	test("expands raw arguments, appends fallback arguments, and rejects custom placeholders", () => {
		const withArguments = {
			name: "review",
			description: "Review.",
			content: "Review {{ arguments }} and {{ args }}.",
			filePath: "/prompts/review.md",
		};
		const withoutArguments = {
			name: "explain",
			description: "Explain.",
			content: "Explain clearly.",
			filePath: "/prompts/explain.md",
		};

		expect(
			expandPromptTemplateInvocation("/review  src/app.ts\nwith details ", [
				withArguments,
			]),
		).toBe("Review src/app.ts\nwith details and src/app.ts\nwith details.");
		expect(
			expandPromptTemplateInvocation("/explain src/app.ts", [withoutArguments]),
		).toBe("Explain clearly.\n\nsrc/app.ts");
		expect(() =>
			expandPromptTemplateInvocation("/review target", [
				{ ...withArguments, content: "Review {{ target }}." },
			]),
		).toThrow('Missing prompt template variable "target"');
	});
});
