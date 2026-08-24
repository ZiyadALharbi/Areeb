import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { discoverProjectDirectories } from "./project-context.ts";
import {
	parseFrontmatter,
	type ResourceDiagnostic,
	ResourceError,
	type ResourceLoadPolicy,
	type ResourceLoadResult,
	type ResourceSource,
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

export interface SkillSource extends ResourceSource {
	readonly layout: SkillLayout;
}

export type LoadSkillsResult = ResourceLoadResult<"skills", Skill>;

type SkillSourceInput = string | SkillSource;

interface OrderedSkillSource extends SkillSource {
	readonly order: number;
	readonly precedence: number;
}

interface SkillDiscoveryContext {
	readonly diagnostics: ResourceDiagnostic[];
	readonly policy: ResourceLoadPolicy;
}

export async function loadSkills(
	sources: SkillSourceInput | readonly SkillSourceInput[],
): Promise<Skill[]> {
	return [...(await loadSkillsInternal(sources, "strict")).skills];
}

export async function loadSkillsWithDiagnostics(
	sources: SkillSourceInput | readonly SkillSourceInput[],
): Promise<LoadSkillsResult> {
	return loadSkillsInternal(sources, "diagnostic");
}

async function loadSkillsInternal(
	sources: SkillSourceInput | readonly SkillSourceInput[],
	policy: ResourceLoadPolicy,
): Promise<LoadSkillsResult> {
	const byName = new Map<string, Skill>();
	const canonicalFiles = new Set<string>();
	const context: SkillDiscoveryContext = { diagnostics: [], policy };

	for (const source of orderSkillSources(sources)) {
		const sourceByName = new Map<string, Skill>();
		for (const candidate of await discoverSkillFiles(source, context)) {
			const canonicalPath = await resolveCanonicalSkill(
				candidate.filePath,
				context,
			);
			if (canonicalPath === undefined) {
				continue;
			}
			if (canonicalFiles.has(canonicalPath)) {
				continue;
			}
			canonicalFiles.add(canonicalPath);
			const skill = await loadSkillCandidate(candidate, context);
			if (skill === undefined) {
				continue;
			}
			const duplicate = sourceByName.get(skill.name);
			if (duplicate) {
				const error = new ResourceError(
					`Duplicate skill "${skill.name}"; first loaded from ${duplicate.filePath}`,
					skill.filePath,
				);
				if (policy === "strict") {
					throw error;
				}
				context.diagnostics.push(
					createDiagnostic({
						kind: "skill",
						code: "duplicate",
						severity: "warning",
						name: skill.name,
						path: skill.filePath,
						relatedPath: duplicate.filePath,
						message: `Duplicate skill "${skill.name}" was skipped`,
					}),
				);
				continue;
			}
			sourceByName.set(skill.name, skill);
		}
		for (const skill of sourceByName.values()) {
			const overridden = byName.get(skill.name);
			if (overridden && policy === "diagnostic") {
				context.diagnostics.push(
					createDiagnostic({
						kind: "skill",
						code: "overridden",
						severity: "info",
						name: skill.name,
						path: overridden.filePath,
						relatedPath: skill.filePath,
						message: `Skill "${skill.name}" was overridden by a higher-precedence source`,
					}),
				);
			}
			byName.set(skill.name, skill);
		}
	}

	const skills = [...byName.values()].sort(
		(left, right) =>
			left.name.localeCompare(right.name) ||
			left.filePath.localeCompare(right.filePath),
	);
	return Object.freeze({
		skills: Object.freeze(skills),
		diagnostics: Object.freeze(context.diagnostics),
	});
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
	return input.startsWith("/skill:");
}

interface SkillCandidate {
	readonly filePath: string;
	readonly derivedName: string;
	readonly relativePath: string;
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
	source: OrderedSkillSource,
	context: SkillDiscoveryContext,
): Promise<SkillCandidate[]> {
	const candidates =
		source.layout === "agents"
			? await discoverAgentSkillFiles(source.directory, context)
			: await discoverAreebSkillFiles(source.directory, context);
	return candidates.sort(
		(left, right) =>
			left.relativePath.localeCompare(right.relativePath) ||
			left.filePath.localeCompare(right.filePath),
	);
}

async function discoverAreebSkillFiles(
	directory: string,
	context: SkillDiscoveryContext,
): Promise<SkillCandidate[]> {
	const absoluteDirectory = resolve(directory);
	let entries: Dirent<string>[];
	try {
		entries = await readdir(absoluteDirectory, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) {
			return [];
		}
		reportSkillFailure(
			context,
			new ResourceError("Unable to list skills directory", absoluteDirectory, {
				cause: error,
			}),
			"source-unreadable",
			absoluteDirectory,
		);
		return [];
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
				context,
				entry.isSymbolicLink(),
			);
			if (!metadata?.isFile()) {
				continue;
			}
			candidates.push({
				filePath: entryPath,
				derivedName: basename(entry.name, ".md"),
				relativePath: normalizeRelativePath(
					relative(absoluteDirectory, entryPath),
				),
			});
			continue;
		}

		const entryMetadata = await inspectSkillPath(
			entryPath,
			entry.isSymbolicLink(),
			context,
			entry.isSymbolicLink(),
		);
		if (!(entry.isDirectory() || entryMetadata?.isDirectory())) {
			continue;
		}

		const filePath = join(entryPath, "SKILL.md");
		const metadata = await inspectSkillPath(filePath, true, context, false);
		if (metadata === undefined) {
			continue;
		}
		if (!metadata.isFile()) {
			reportSkillFailure(
				context,
				new ResourceError("Skill resource is not a file", filePath),
				"validation-failed",
				filePath,
				entry.name,
			);
			continue;
		}
		candidates.push({
			filePath,
			derivedName: entry.name,
			relativePath: normalizeRelativePath(
				relative(absoluteDirectory, filePath),
			),
		});
	}
	return candidates;
}

async function discoverAgentSkillFiles(
	directory: string,
	context: SkillDiscoveryContext,
): Promise<SkillCandidate[]> {
	const absoluteDirectory = resolve(directory);
	let entries: Dirent<string>[];
	try {
		entries = await readdir(absoluteDirectory, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) {
			return [];
		}
		reportSkillFailure(
			context,
			new ResourceError("Unable to list skills directory", absoluteDirectory, {
				cause: error,
			}),
			"source-unreadable",
			absoluteDirectory,
		);
		return [];
	}

	const candidates: SkillCandidate[] = [];
	const visitedDirectories = new Set<string>();
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		const entryPath = join(absoluteDirectory, entry.name);
		const metadata = await inspectSkillPath(
			entryPath,
			entry.isSymbolicLink(),
			context,
			entry.isSymbolicLink(),
		);
		if (entry.isDirectory() || metadata?.isDirectory()) {
			await walkAgentSkillDirectory(
				entryPath,
				absoluteDirectory,
				visitedDirectories,
				candidates,
				context,
			);
		}
	}
	return candidates;
}

async function walkAgentSkillDirectory(
	directory: string,
	sourceDirectory: string,
	visitedDirectories: Set<string>,
	candidates: SkillCandidate[],
	context: SkillDiscoveryContext,
): Promise<void> {
	const canonicalDirectory = await resolveCanonicalSkill(directory, context);
	if (canonicalDirectory === undefined) {
		return;
	}
	if (visitedDirectories.has(canonicalDirectory)) {
		return;
	}
	visitedDirectories.add(canonicalDirectory);

	let entries: Dirent<string>[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		reportSkillFailure(
			context,
			new ResourceError("Unable to list skills directory", directory, {
				cause: error,
			}),
			"read-failed",
			directory,
		);
		return;
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));

	if (entries.some((entry) => entry.name === "SKILL.md")) {
		const filePath = join(directory, "SKILL.md");
		const metadata = await inspectSkillPath(filePath, false, context, false);
		if (metadata === undefined) {
			return;
		}
		if (!metadata?.isFile()) {
			reportSkillFailure(
				context,
				new ResourceError("Skill resource is not a file", filePath),
				"validation-failed",
				filePath,
				basename(directory),
			);
			return;
		}
		candidates.push({
			filePath,
			derivedName: basename(directory),
			relativePath: normalizeRelativePath(relative(sourceDirectory, filePath)),
		});
		return;
	}

	for (const entry of entries) {
		const entryPath = join(directory, entry.name);
		const metadata = await inspectSkillPath(
			entryPath,
			entry.isSymbolicLink(),
			context,
			entry.isSymbolicLink(),
		);
		if (entry.isDirectory() || metadata?.isDirectory()) {
			await walkAgentSkillDirectory(
				entryPath,
				sourceDirectory,
				visitedDirectories,
				candidates,
				context,
			);
		}
	}
}

async function inspectSkillPath(
	filePath: string,
	allowMissing: boolean,
	context: SkillDiscoveryContext,
	reportMissing: boolean,
): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
	try {
		return await stat(filePath);
	} catch (error) {
		if (allowMissing && isMissing(error)) {
			if (
				context.policy === "diagnostic" &&
				(reportMissing || (await isSymbolicLink(filePath)))
			) {
				reportSkillFailure(
					context,
					new ResourceError("Unable to inspect skill", filePath, {
						cause: error,
					}),
					"read-failed",
					filePath,
				);
			}
			return undefined;
		}
		reportSkillFailure(
			context,
			new ResourceError("Unable to inspect skill", filePath, {
				cause: error,
			}),
			"read-failed",
			filePath,
		);
		return undefined;
	}
}

async function isSymbolicLink(filePath: string): Promise<boolean> {
	try {
		return (await lstat(filePath)).isSymbolicLink();
	} catch {
		return false;
	}
}

async function resolveCanonicalSkill(
	filePath: string,
	context: SkillDiscoveryContext,
): Promise<string | undefined> {
	try {
		return await realpath(filePath);
	} catch (error) {
		reportSkillFailure(
			context,
			new ResourceError("Unable to resolve skill path", filePath, {
				cause: error,
			}),
			"read-failed",
			filePath,
		);
		return undefined;
	}
}

async function loadSkillCandidate(
	candidate: SkillCandidate,
	context: SkillDiscoveryContext,
): Promise<Skill | undefined> {
	try {
		validateSkillName(candidate.derivedName, candidate.filePath);
	} catch (error) {
		reportSkillFailure(
			context,
			error,
			"validation-failed",
			candidate.filePath,
			candidate.derivedName,
		);
		return undefined;
	}

	let contents: string;
	try {
		contents = await readResourceFile(candidate.filePath);
	} catch (error) {
		reportSkillFailure(
			context,
			error,
			"read-failed",
			candidate.filePath,
			candidate.derivedName,
		);
		return undefined;
	}

	let parsed: ReturnType<typeof parseFrontmatter>;
	try {
		parsed = parseFrontmatter(contents, candidate.filePath);
	} catch (error) {
		reportSkillFailure(
			context,
			error,
			"parse-failed",
			candidate.filePath,
			candidate.derivedName,
		);
		return undefined;
	}

	try {
		return validateLoadedSkill(candidate, parsed);
	} catch (error) {
		reportSkillFailure(
			context,
			error,
			"validation-failed",
			candidate.filePath,
			candidate.derivedName,
		);
		return undefined;
	}
}

function validateLoadedSkill(
	candidate: SkillCandidate,
	parsed: ReturnType<typeof parseFrontmatter>,
): Skill {
	const { attributes, body } = parsed;
	const { derivedName, filePath } = candidate;
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

function orderSkillSources(
	sources: SkillSourceInput | readonly SkillSourceInput[],
): OrderedSkillSource[] {
	const sourceList = (
		Array.isArray(sources) ? sources : [sources]
	) as readonly SkillSourceInput[];
	return sourceList
		.map((input, order) => {
			const source =
				typeof input === "string"
					? { directory: input, layout: "areeb" as const }
					: input;
			return {
				...source,
				order,
				precedence: source.precedence ?? order,
			};
		})
		.sort(
			(left, right) =>
				left.precedence - right.precedence || left.order - right.order,
		);
}

function reportSkillFailure(
	context: SkillDiscoveryContext,
	error: unknown,
	code: ResourceDiagnostic["code"],
	path: string,
	name?: string,
): void {
	if (context.policy === "strict") {
		throw error;
	}
	context.diagnostics.push(
		createDiagnostic({
			kind: "skill",
			code,
			severity: "warning",
			...(name === undefined ? {} : { name }),
			path,
			message: diagnosticMessage(error),
		}),
	);
}

function createDiagnostic(diagnostic: ResourceDiagnostic): ResourceDiagnostic {
	return Object.freeze({ ...diagnostic });
}

function diagnosticMessage(error: unknown): string {
	if (!(error instanceof Error)) {
		return "Resource discovery failed";
	}
	if (error instanceof ResourceError && error.filePath !== undefined) {
		const prefix = `${error.filePath}: `;
		if (error.message.startsWith(prefix)) {
			return error.message.slice(prefix.length);
		}
	}
	return error.message;
}

function normalizeRelativePath(filePath: string): string {
	return filePath.replaceAll("\\", "/");
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
