import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
	parseFrontmatter,
	ResourceError,
	readResourceFile,
} from "./resources.ts";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

export interface Skill {
	readonly name: string;
	readonly description: string;
	readonly content: string;
	readonly filePath: string;
	readonly baseDir: string;
}

export async function loadSkills(
	directories: string | readonly string[],
): Promise<Skill[]> {
	const skills: Skill[] = [];
	const byName = new Map<string, Skill>();

	for (const directory of typeof directories === "string"
		? [directories]
		: directories) {
		for (const candidate of await discoverSkillFiles(directory)) {
			const skill = await loadSkill(candidate.filePath, candidate.derivedName);
			const duplicate = byName.get(skill.name);
			if (duplicate) {
				throw new ResourceError(
					`Duplicate skill "${skill.name}"; first loaded from ${duplicate.filePath}`,
					skill.filePath,
				);
			}
			byName.set(skill.name, skill);
			skills.push(skill);
		}
	}

	return skills.sort(
		(left, right) =>
			left.name.localeCompare(right.name) ||
			left.filePath.localeCompare(right.filePath),
	);
}

export function expandSkillInvocation(
	input: string,
	skills: readonly Skill[],
): string {
	if (!isSkillDirective(input)) {
		return input;
	}

	const match = /^\/skill:([^\s]+)([\s\S]*)$/.exec(input);
	if (!match) {
		throw new ResourceError("Malformed skill invocation");
	}

	const name = match[1] as string;
	validateSkillName(name);
	const skill = skills.find((candidate) => candidate.name === name);
	if (!skill) {
		throw new ResourceError(`Unknown skill: ${name}`);
	}

	const argumentsText = (match[2] as string).trim();
	const content = skill.content.endsWith("\n")
		? skill.content
		: `${skill.content}\n`;
	const block = `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">\nReferences are relative to ${escapeXml(skill.baseDir)}.\n\n${content}</skill>`;
	return argumentsText.length === 0 ? block : `${block}\n\n${argumentsText}`;
}

export function buildSkillIndex(skills: readonly Skill[]): string {
	if (skills.length === 0) {
		return "";
	}

	const entries = [...skills]
		.sort(
			(left, right) =>
				left.name.localeCompare(right.name) ||
				left.filePath.localeCompare(right.filePath),
		)
		.map(
			(skill) =>
				`- <skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">${escapeXml(skill.description)}</skill>`,
		);
	return `Available skills:\n${entries.join("\n")}`;
}

export function isSkillDirective(input: string): boolean {
	return (
		input === "/skill" ||
		input.startsWith("/skill:") ||
		input.startsWith("/skill ") ||
		input.startsWith("/skill\n") ||
		input.startsWith("/skill\t")
	);
}

interface SkillCandidate {
	readonly filePath: string;
	readonly derivedName: string;
}

async function discoverSkillFiles(
	directory: string,
): Promise<SkillCandidate[]> {
	const absoluteDirectory = resolve(directory);
	let entries: Dirent<string>[];
	try {
		entries = await readdir(absoluteDirectory, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) {
			return [];
		}
		throw new ResourceError(
			"Unable to list skills directory",
			absoluteDirectory,
			{
				cause: error,
			},
		);
	}

	const candidates: SkillCandidate[] = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		if (entry.isFile() && extname(entry.name) === ".md") {
			candidates.push({
				filePath: join(absoluteDirectory, entry.name),
				derivedName: basename(entry.name, ".md"),
			});
			continue;
		}
		if (!entry.isDirectory()) {
			continue;
		}

		const filePath = join(absoluteDirectory, entry.name, "SKILL.md");
		let isFile: boolean;
		try {
			isFile = (await stat(filePath)).isFile();
		} catch (error) {
			if (isMissing(error)) {
				continue;
			}
			throw new ResourceError("Unable to inspect skill", filePath, {
				cause: error,
			});
		}
		if (!isFile) {
			throw new ResourceError("Skill resource is not a file", filePath);
		}
		candidates.push({ filePath, derivedName: entry.name });
	}
	return candidates;
}

async function loadSkill(
	filePath: string,
	derivedName: string,
): Promise<Skill> {
	validateSkillName(derivedName, filePath);
	const { attributes, body } = parseFrontmatter(
		await readResourceFile(filePath),
		filePath,
	);
	const declaredName = attributes.name;
	if (declaredName !== undefined && declaredName !== derivedName) {
		throw new ResourceError(
			`Frontmatter name "${declaredName}" must match derived name "${derivedName}"`,
			filePath,
		);
	}

	const description = attributes.description?.trim();
	if (!description) {
		throw new ResourceError("Skill requires a description", filePath);
	}
	if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
		throw new ResourceError(
			`Skill description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters`,
			filePath,
		);
	}
	if (body.trim().length === 0) {
		throw new ResourceError("Skill body cannot be empty", filePath);
	}

	const absolutePath = resolve(filePath);
	return Object.freeze({
		name: derivedName,
		description,
		content: body,
		filePath: absolutePath,
		baseDir: dirname(absolutePath),
	});
}

function validateSkillName(name: string, filePath?: string): void {
	if (
		name.length === 0 ||
		name.length > MAX_SKILL_NAME_LENGTH ||
		!SKILL_NAME_PATTERN.test(name)
	) {
		throw new ResourceError(
			`Invalid skill name "${name}"; expected lowercase kebab-case with at most ${MAX_SKILL_NAME_LENGTH} characters`,
			filePath,
		);
	}
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
