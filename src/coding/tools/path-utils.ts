import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodingToolConfig } from "../types.ts";

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths on Windows. */
function normalizeWindowsShellPath(filePath: string): string {
	if (
		process.platform !== "win32" ||
		!filePath.startsWith("/") ||
		filePath.startsWith("//") ||
		filePath.includes("\\")
	) {
		return filePath;
	}

	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	const drive = match?.[1];
	if (!drive) {
		return filePath;
	}

	const suffix = match[2]?.replaceAll("/", "\\");
	return `${drive.toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * Normalize conventional local path syntax without rewriting valid filename
 * characters such as leading @ signs or Unicode spaces.
 */
function normalizeCodingPath(filePath: string): string {
	let normalized = normalizeWindowsShellPath(filePath);

	if (normalized === "~") {
		return homedir();
	}

	if (
		normalized.startsWith("~/") ||
		(process.platform === "win32" && normalized.startsWith("~\\"))
	) {
		return join(homedir(), normalized.slice(2));
	}

	if (/^file:\/\//i.test(normalized)) {
		normalized = fileURLToPath(normalized);
	}

	return normalized;
}

export function resolveCodingCwd(config: CodingToolConfig): string {
	const configuredCwd = typeof config === "string" ? config : config?.cwd;
	return resolveToCwd(configuredCwd ?? process.cwd(), process.cwd());
}

/** Resolve an absolute or cwd-relative local path. */
export function resolveToCwd(filePath: string, cwd: string): string {
	const normalizedPath = normalizeCodingPath(filePath);
	const normalizedCwd = normalizeCodingPath(cwd);
	const absoluteCwd = resolve(normalizedCwd);

	return isAbsolute(normalizedPath)
		? resolve(normalizedPath)
		: resolve(absoluteCwd, normalizedPath);
}

/**
 * Return a stable mutation queue key.
 *
 * Missing suffixes are resolved through the nearest existing ancestor so
 * paths through symlinked directories share the same queue key.
 */
export async function canonicalMutationPath(
	filePath: string,
	cwd: string = process.cwd(),
): Promise<string> {
	const absolutePath = resolveToCwd(filePath, cwd);
	let candidate = absolutePath;
	const missingSegments: string[] = [];

	while (true) {
		try {
			const canonicalAncestor = await realpath(candidate);
			return resolve(canonicalAncestor, ...missingSegments);
		} catch (error) {
			if (!isMissingPathError(error)) {
				throw error;
			}
		}

		try {
			const stats = await lstat(candidate);
			if (stats.isSymbolicLink()) {
				const target = await readlink(candidate);
				candidate = resolve(dirname(candidate), target, ...missingSegments);
				missingSegments.length = 0;
				continue;
			}
		} catch (error) {
			if (!isMissingPathError(error)) {
				throw error;
			}
		}

		const parent = dirname(candidate);
		if (parent === candidate) {
			return absolutePath;
		}

		missingSegments.unshift(basename(candidate));
		candidate = parent;
	}
}
