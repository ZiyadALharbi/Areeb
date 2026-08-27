import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ResourceError, readResourceFile } from "./resources.ts";

const INSTRUCTION_FILE_NAMES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"CLAUDE.md",
] as const;

export interface ProjectContextFile {
	readonly path: string;
	readonly content: string;
}

export interface LoadProjectContextOptions {
	readonly cwd: string;
	readonly userRoot: string;
	readonly agentsRoot: string;
	readonly projectRoot: string;
	readonly projectAgentsRoot: string;
	readonly contextFiles?: readonly ProjectContextFile[];
}

/**
 * Load trusted instructions in increasing specificity. Caller-provided content
 * is already trusted and therefore remains last without filesystem access.
 */
export async function loadProjectContext(
	options: LoadProjectContextOptions,
): Promise<readonly ProjectContextFile[]> {
	const selectedPaths: string[] = [];
	for (const directory of [options.agentsRoot, options.userRoot]) {
		const instructions = await selectInstructionFile(directory);
		if (instructions !== undefined) {
			selectedPaths.push(instructions);
		}
	}

	for (const directory of await discoverProjectDirectories(options.cwd)) {
		const instructions = await selectInstructionFile(directory);
		if (instructions !== undefined) {
			selectedPaths.push(instructions);
		}
	}
	for (const directory of [options.projectAgentsRoot, options.projectRoot]) {
		const instructions = await selectInstructionFile(directory);
		if (instructions !== undefined) {
			selectedPaths.push(instructions);
		}
	}

	const context: ProjectContextFile[] = [];
	const canonicalPaths = new Set<string>();
	for (const filePath of selectedPaths) {
		const canonicalPath = await canonicalResourcePath(filePath);
		if (canonicalPaths.has(canonicalPath)) {
			continue;
		}
		canonicalPaths.add(canonicalPath);
		context.push(
			Object.freeze({
				path: filePath,
				content: await readResourceFile(filePath),
			}),
		);
	}

	for (const file of options.contextFiles ?? []) {
		context.push(Object.freeze({ ...file }));
	}
	return Object.freeze(context);
}

/** Return the nearest Git root through cwd, or cwd alone outside Git. */
export async function discoverProjectDirectories(
	cwd: string,
): Promise<string[]> {
	const absoluteCwd = resolve(cwd);
	let current = absoluteCwd;
	let gitRoot: string | undefined;

	while (true) {
		if (await hasGitBoundary(current)) {
			gitRoot = current;
			break;
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}

	if (gitRoot === undefined) {
		return [absoluteCwd];
	}

	const directories: string[] = [];
	current = absoluteCwd;
	while (true) {
		directories.push(current);
		if (current === gitRoot) {
			break;
		}
		current = dirname(current);
	}
	return directories.reverse();
}

async function selectInstructionFile(
	directory: string,
): Promise<string | undefined> {
	for (const name of INSTRUCTION_FILE_NAMES) {
		const filePath = join(resolve(directory), name);
		try {
			await stat(filePath);
			return filePath;
		} catch (error) {
			if (isMissing(error)) {
				continue;
			}
			throw new ResourceError(
				"Unable to inspect project instructions",
				filePath,
				{ cause: error },
			);
		}
	}
	return undefined;
}

async function hasGitBoundary(directory: string): Promise<boolean> {
	const gitPath = join(directory, ".git");
	try {
		const metadata = await stat(gitPath);
		return metadata.isFile() || metadata.isDirectory();
	} catch (error) {
		if (isMissing(error)) {
			return false;
		}
		throw new ResourceError("Unable to inspect Git boundary", gitPath, {
			cause: error,
		});
	}
}

async function canonicalResourcePath(filePath: string): Promise<string> {
	try {
		return await realpath(filePath);
	} catch (error) {
		throw new ResourceError("Unable to resolve resource path", filePath, {
			cause: error,
		});
	}
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
