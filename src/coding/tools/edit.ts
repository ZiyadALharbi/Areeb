import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentTool } from "../../agent/types.ts";
import {
	type CodingToolConfig,
	type CodingToolDefinition,
	type CodingToolOptions,
	createAgentTool,
} from "../types.ts";
import {
	applyExactEdits,
	detectLineEnding,
	generateDisplayDiff,
	generateUnifiedPatch,
	normalizeLineEndings,
	restoreLineEndings,
	stripUtf8Bom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveCodingCwd, resolveToCwd } from "./path-utils.ts";

const textEditSchema = z.object({
	oldText: z
		.string()
		.min(1, "oldText must not be empty")
		.describe(
			"Exact text for one targeted replacement. It must be unique in the original file and must not overlap another edit.",
		),
	newText: z
		.string()
		.describe("Replacement text. Use an empty string to delete oldText."),
});

function normalizeEditArguments(input: unknown): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return input;
	}
	const normalized = { ...(input as Record<string, unknown>) };
	if (typeof normalized.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(normalized.edits);
			if (Array.isArray(parsed)) {
				normalized.edits = parsed;
			}
		} catch {
			// Leave malformed JSON in place so the schema returns a useful error.
		}
	}
	if (normalized.edits !== undefined && !Array.isArray(normalized.edits)) {
		// Preserve invalid explicit edits so the schema reports the error.
		return normalized;
	}

	if (
		typeof normalized.oldText === "string" &&
		typeof normalized.newText === "string"
	) {
		const edits = Array.isArray(normalized.edits) ? [...normalized.edits] : [];
		edits.push({
			oldText: normalized.oldText,
			newText: normalized.newText,
		});
		normalized.edits = edits;
		delete normalized.oldText;
		delete normalized.newText;
	}
	return normalized;
}

export const editInputSchema = z.preprocess(
	normalizeEditArguments,
	z.object({
		path: z
			.string()
			.min(1, "path must not be empty")
			.describe("Path to the file, relative to the coding cwd or absolute."),
		edits: z
			.array(textEditSchema)
			.min(1)
			.describe(
				"Targeted replacements matched against the original file, not incrementally. Edits must be unique and non-overlapping.",
			),
	}),
);

export type EditToolInput = z.output<typeof editInputSchema>;

export interface EditToolDetails {
	path: string;
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

export interface EditOperations {
	readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
	writeFile(path: string, content: string): Promise<void>;
}

export interface EditToolOptions extends CodingToolOptions {
	operations?: EditOperations;
}

const defaultEditOperations: EditOperations = {
	readFile: (path, signal) => readFile(path, signal ? { signal } : undefined),
	writeFile: (path, content) => writeFile(path, content, "utf8"),
};

function normalizeOptions(
	config: string | EditToolOptions | undefined,
): EditToolOptions {
	return typeof config === "string" ? { cwd: config } : (config ?? {});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch (error) {
		throw new Error(`Could not edit ${path}: file is not valid UTF-8 text.`, {
			cause: error,
		});
	}
}

export function createEditToolDefinition(
	config?: string | EditToolOptions,
): CodingToolDefinition<EditToolInput, EditToolDetails> {
	const options = normalizeOptions(config);
	const cwd = resolveCodingCwd(options);
	const operations = options.operations ?? defaultEditOperations;
	return {
		name: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet:
			"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		inputSchema: editInputSchema,
		async executor({ path, edits }, signal) {
			const absolutePath = resolveToCwd(path, cwd);
			return withFileMutationQueue(absolutePath, async () => {
				throwIfAborted(signal);
				let bytes: Uint8Array;
				try {
					bytes = await operations.readFile(absolutePath, signal);
				} catch (error) {
					throwIfAborted(signal);
					const message =
						error instanceof Error ? error.message : String(error);
					throw new Error(
						`Could not edit ${path}: failed to read file: ${message}`,
						{
							cause: error,
						},
					);
				}
				throwIfAborted(signal);
				const original = decodeUtf8(bytes, path);
				const { bom, text } = stripUtf8Bom(original);
				const lineEnding = detectLineEnding(text);
				const normalized = normalizeLineEndings(text);
				const applied = applyExactEdits(normalized, edits, path);
				throwIfAborted(signal);
				const finalContent =
					bom + restoreLineEndings(applied.newContent, lineEnding);
				try {
					await operations.writeFile(absolutePath, finalContent);
				} catch (error) {
					throwIfAborted(signal);
					const message =
						error instanceof Error ? error.message : String(error);
					throw new Error(
						`Could not edit ${path}: failed to write file: ${message}`,
						{
							cause: error,
						},
					);
				}

				throwIfAborted(signal);
				const display = generateDisplayDiff(
					applied.oldContent,
					applied.newContent,
				);
				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
						},
					],
					details: {
						path: absolutePath,
						diff: display.diff,
						patch: generateUnifiedPatch(
							path,
							applied.oldContent,
							applied.newContent,
						),
						...(display.firstChangedLine !== undefined
							? { firstChangedLine: display.firstChangedLine }
							: {}),
					},
				};
			});
		},
	};
}

export function createEditTool(
	config?: CodingToolConfig | EditToolOptions,
): AgentTool<EditToolInput, EditToolDetails> {
	return createAgentTool(createEditToolDefinition(config));
}
