import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { discoverProjectDirectories } from "./project-context.ts";
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

export type SkillLayout = "areeb" | "agents";

export interface SkillSource {
	readonly directory: string;
	readonly layout: SkillLayout;
}

export async function loadSkills(
	sources: string | SkillSource | readonly (string | SkillSource)[],
): Promise<Skill[]> {
	const byName = new Map<string, Skill>();
	const canonicalFiles = new Set<string>();
	const sourceList = (
		Array.isArray(sources) ? sources : [sources]
	) as readonly (string | SkillSource)[];

	for (const sourceInput of sourceList) {
		const source =
			typeof sourceInput === "string"
				? { directory: sourceInput, layout: "areeb" as const }
				: sourceInput;
		const sourceByName = new Map<string, Skill>();
		for (const candidate of await discoverSkillFiles(source)) {
			const canonicalPath = await canonicalSkillPath(candidate.filePath);
			if (canonicalFiles.has(canonicalPath)) {
				continue;
			}
			canonicalFiles.add(canonicalPath);
			const skill = await loadSkill(candidate.filePath, candidate.derivedName);
			const duplicate = sourceByName.get(skill.name);
			if (duplicate) {
				throw new ResourceError(
					`Duplicate skill "${skill.name}"; first loaded from ${duplicate.filePath}`,
					skill.filePath,
				);
			}
			sourceByName.set(skill.name, skill);
		}
		for (const skill of sourceByName.values()) {
			byName.set(skill.name, skill);
		}
	}

	return [...byName.values()].sort(
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

	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of [...skills].sort(
		(left, right) =>
			left.name.localeCompare(right.name) ||
			left.filePath.localeCompare(right.filePath),
	)) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(
			`    <description>${escapeXml(skill.description)}</description>`,
		);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
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

export async function discoverProjectAgentSkillDirectories(
	cwd: string,
	userAgentSkills: string,
): Promise<string[]> {
	const excludedDirectory = resolve(userAgentSkills);
	return (await discoverProjectDirectories(cwd))
		.map((directory) => join(directory, ".agents", "skills"))
		.filter((directory) => resolve(directory) !== excludedDirectory);
}

async function discoverSkillFiles(
	source: SkillSource,
): Promise<SkillCandidate[]> {
	return source.layout === "agents"
		? discoverAgentSkillFiles(source.directory)
		: discoverAreebSkillFiles(source.directory);
}

async function discoverAreebSkillFiles(
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
		const entryPath = join(absoluteDirectory, entry.name);
		if (extname(entry.name) === ".md") {
			const metadata = await inspectSkillPath(
				entryPath,
				entry.isSymbolicLink(),
			);
			if (!metadata?.isFile()) {
				continue;
			}
			candidates.push({
				filePath: entryPath,
				derivedName: basename(entry.name, ".md"),
			});
			continue;
		}

		const entryMetadata = await inspectSkillPath(
			entryPath,
			entry.isSymbolicLink(),
		);
		if (!(entry.isDirectory() || entryMetadata?.isDirectory())) {
			continue;
		}

		const filePath = join(entryPath, "SKILL.md");
		const metadata = await inspectSkillPath(filePath, true);
		if (metadata === undefined) {
			continue;
		}
		if (!metadata.isFile()) {
			throw new ResourceError("Skill resource is not a file", filePath);
		}
		candidates.push({ filePath, derivedName: entry.name });
	}
	return candidates;
}

async function discoverAgentSkillFiles(
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
			{ cause: error },
		);
	}

	const candidates: SkillCandidate[] = [];
	const visitedDirectories = new Set<string>();
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		const entryPath = join(absoluteDirectory, entry.name);
		const metadata = await inspectSkillPath(entryPath, entry.isSymbolicLink());
		if (entry.isDirectory() || metadata?.isDirectory()) {
			await walkAgentSkillDirectory(entryPath, visitedDirectories, candidates);
		}
	}
	return candidates;
}

async function walkAgentSkillDirectory(
	directory: string,
	visitedDirectories: Set<string>,
	candidates: SkillCandidate[],
): Promise<void> {
	const canonicalDirectory = await canonicalSkillPath(directory);
	if (visitedDirectories.has(canonicalDirectory)) {
		return;
	}
	visitedDirectories.add(canonicalDirectory);

	let entries: Dirent<string>[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		throw new ResourceError("Unable to list skills directory", directory, {
			cause: error,
		});
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));

	if (entries.some((entry) => entry.name === "SKILL.md")) {
		const filePath = join(directory, "SKILL.md");
		const metadata = await inspectSkillPath(filePath, false);
		if (!metadata?.isFile()) {
			throw new ResourceError("Skill resource is not a file", filePath);
		}
		candidates.push({ filePath, derivedName: basename(directory) });
		return;
	}

	for (const entry of entries) {
		const entryPath = join(directory, entry.name);
		const metadata = await inspectSkillPath(entryPath, entry.isSymbolicLink());
		if (entry.isDirectory() || metadata?.isDirectory()) {
			await walkAgentSkillDirectory(entryPath, visitedDirectories, candidates);
		}
	}
}

async function inspectSkillPath(
	filePath: string,
	allowMissing: boolean,
): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
	try {
		return await stat(filePath);
	} catch (error) {
		if (allowMissing && isMissing(error)) {
			return undefined;
		}
		throw new ResourceError("Unable to inspect skill", filePath, {
			cause: error,
		});
	}
}

async function canonicalSkillPath(filePath: string): Promise<string> {
	try {
		return await realpath(filePath);
	} catch (error) {
		throw new ResourceError("Unable to resolve skill path", filePath, {
			cause: error,
		});
	}
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
		.replaceAll(">", "&gt;")
		.replaceAll("'", "&apos;");
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
