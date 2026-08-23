import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isTuiThemeName, type TuiThemeName } from "./theme.ts";

export interface TuiConfig {
	readonly theme: TuiThemeName;
}

export interface LoadedTuiConfig {
	readonly config: TuiConfig;
	readonly warning?: string;
}

export const DEFAULT_TUI_CONFIG: TuiConfig = Object.freeze({
	theme: "areeb-dark",
});

export async function loadTuiConfig(path: string): Promise<LoadedTuiConfig> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return { config: DEFAULT_TUI_CONFIG };
		}
		return fallback(path, "could not be read");
	}

	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch {
		return fallback(path, "contains malformed JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return fallback(path, "must contain a JSON object");
	}
	if (!("theme" in value)) {
		return { config: DEFAULT_TUI_CONFIG };
	}
	if (!isTuiThemeName(value.theme)) {
		return fallback(path, "contains an unknown theme");
	}
	return { config: Object.freeze({ theme: value.theme }) };
}

export async function saveTuiConfig(
	path: string,
	config: TuiConfig,
): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let temporaryCreated = false;

	try {
		const file = await open(temporaryPath, "wx", 0o600);
		temporaryCreated = true;
		try {
			await file.writeFile(
				`${JSON.stringify({ theme: config.theme }, null, 2)}\n`,
			);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporaryPath, path);
		temporaryCreated = false;
		await chmod(path, 0o600);
	} finally {
		if (temporaryCreated) {
			await unlink(temporaryPath).catch(() => undefined);
		}
	}
}

function fallback(path: string, reason: string): LoadedTuiConfig {
	return {
		config: DEFAULT_TUI_CONFIG,
		warning: `TUI config ${path} ${reason}; using areeb-dark`,
	};
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
