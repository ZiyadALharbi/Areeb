import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import {
	parseFrontmatter,
	ResourceError,
	readResourceFile,
} from "./resources.ts";

const PROMPT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PROMPT_NAME_LENGTH = 64;
const RESERVED_PROMPT_NAMES = new Set(["help", "exit"]);
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g;

export interface PromptTemplate {
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly content: string;
	readonly filePath: string;
}

export async function loadPromptTemplates(
	directories: string | readonly string[],
): Promise<PromptTemplate[]> {
	const templates: PromptTemplate[] = [];
	const byName = new Map<string, PromptTemplate>();

	for (const directory of typeof directories === "string"
		? [directories]
		: directories) {
		for (const filePath of await discoverPromptFiles(directory)) {
			const template = await loadPromptTemplate(filePath);
			const duplicate = byName.get(template.name);
			if (duplicate) {
				throw new ResourceError(
					`Duplicate prompt template "${template.name}"; first loaded from ${duplicate.filePath}`,
					template.filePath,
				);
			}
			byName.set(template.name, template);
			templates.push(template);
		}
	}

	return templates.sort(
		(left, right) =>
			left.name.localeCompare(right.name) ||
			left.filePath.localeCompare(right.filePath),
	);
}

export function renderPromptTemplate(
	template: PromptTemplate,
	variables: Readonly<Record<string, string>>,
): string {
	return template.content.replace(
		PLACEHOLDER_PATTERN,
		(_placeholder, name: string) => {
			if (!Object.hasOwn(variables, name)) {
				throw new ResourceError(
					`Missing prompt template variable "${name}"`,
					template.filePath,
				);
			}
			return variables[name] as string;
		},
	);
}

export function expandPromptTemplateInvocation(
	input: string,
	templates: readonly PromptTemplate[],
): string {
	const match = /^\/([^\s]+)([\s\S]*)$/.exec(input);
	if (!match) {
		return input;
	}

	const template = templates.find((candidate) => candidate.name === match[1]);
	if (!template) {
		return input;
	}

	const argumentsText = (match[2] as string).trim();
	const hasArgumentPlaceholder = hasPlaceholder(
		template.content,
		new Set(["arguments", "args"]),
	);
	const rendered = renderPromptTemplate(template, {
		arguments: argumentsText,
		args: argumentsText,
	});
	return !hasArgumentPlaceholder && argumentsText.length > 0
		? `${rendered}\n\n${argumentsText}`
		: rendered;
}

async function discoverPromptFiles(directory: string): Promise<string[]> {
	const absoluteDirectory = resolve(directory);
	let entries: Dirent<string>[];
	try {
		entries = await readdir(absoluteDirectory, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) {
			return [];
		}
		throw new ResourceError(
			"Unable to list prompt templates directory",
			absoluteDirectory,
			{ cause: error },
		);
	}

	return entries
		.filter((entry) => entry.isFile() && extname(entry.name) === ".md")
		.map((entry) => join(absoluteDirectory, entry.name))
		.sort((left, right) => left.localeCompare(right));
}

async function loadPromptTemplate(filePath: string): Promise<PromptTemplate> {
	const name = basename(filePath, ".md");
	validatePromptName(name, filePath);
	if (RESERVED_PROMPT_NAMES.has(name)) {
		throw new ResourceError(
			`Prompt template name "${name}" is reserved`,
			filePath,
		);
	}

	const { attributes, body } = parseFrontmatter(
		await readResourceFile(filePath),
		filePath,
	);
	if (body.trim().length === 0) {
		throw new ResourceError("Prompt template body cannot be empty", filePath);
	}
	const description =
		attributes.description?.trim() ||
		body
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim();
	if (!description) {
		throw new ResourceError(
			"Prompt template requires content or a description",
			filePath,
		);
	}

	const argumentHint = attributes["argument-hint"]?.trim();
	return Object.freeze({
		name,
		description,
		...(argumentHint ? { argumentHint } : {}),
		content: body,
		filePath: resolve(filePath),
	});
}

function validatePromptName(name: string, filePath: string): void {
	if (
		name.length === 0 ||
		name.length > MAX_PROMPT_NAME_LENGTH ||
		!PROMPT_NAME_PATTERN.test(name)
	) {
		throw new ResourceError(
			`Invalid prompt template name "${name}"; expected lowercase kebab-case with at most ${MAX_PROMPT_NAME_LENGTH} characters`,
			filePath,
		);
	}
}

function hasPlaceholder(content: string, names: ReadonlySet<string>): boolean {
	for (const match of content.matchAll(PLACEHOLDER_PATTERN)) {
		if (names.has(match[1] as string)) {
			return true;
		}
	}
	return false;
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
