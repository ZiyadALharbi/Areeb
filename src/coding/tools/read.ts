import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentTool } from "../../agent/types.ts";
import {
	type CodingToolConfig,
	type CodingToolDefinition,
	type CodingToolOptions,
	createAgentTool,
} from "../types.ts";
import { resolveCodingCwd, resolveToCwd } from "./path-utils.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
	utf8ByteLength,
} from "./truncate.ts";

export const readInputSchema = z.object({
	path: z.string().min(1, "path must not be empty"),
	offset: z.number().int().nonnegative().optional(),
	limit: z.number().int().positive().optional(),
});

export type ReadToolInput = z.infer<typeof readInputSchema>;

export interface ReadToolDetails {
	path: string;
	bytes: number;
	truncation?: TruncationResult;
	image?: { mimeType: string; bytes: number };
}

export interface ReadOperations {
	readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface ReadToolOptions extends CodingToolOptions {
	maxLines?: number;
	maxBytes?: number;
	operations?: ReadOperations;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path, signal) => readFile(path, signal ? { signal } : undefined),
};

function normalizeOptions(
	config: string | ReadToolOptions | undefined,
): ReadToolOptions {
	return typeof config === "string" ? { cwd: config } : (config ?? {});
}

function detectImageMimeType(bytes: Uint8Array): string | undefined {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return "image/jpeg";
	}
	const prefix = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
	if (prefix === "GIF87a" || prefix === "GIF89a") {
		return "image/gif";
	}
	if (
		bytes.length >= 12 &&
		Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
		Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return undefined;
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new Error(`Could not read ${path}: file is not valid UTF-8 text.`, {
			cause: error,
		});
	}
}

function splitPhysicalLines(content: string): {
	lines: string[];
	hasFinalNewline: boolean;
} {
	if (content.length === 0) {
		return { lines: [], hasFinalNewline: false };
	}
	const lines = content.split("\n");
	const hasFinalNewline = content.endsWith("\n");
	if (hasFinalNewline) {
		lines.pop();
	}
	return { lines, hasFinalNewline };
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

export function createReadToolDefinition(
	config?: string | ReadToolOptions,
): CodingToolDefinition<ReadToolInput, ReadToolDetails> {
	const options = normalizeOptions(config);
	const cwd = resolveCodingCwd(options);
	const operations = options.operations ?? defaultReadOperations;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	return {
		name: "read",
		description: `Read a UTF-8 text file or supported image. Text output is limited to ${maxLines} lines or ${formatSize(maxBytes)}; use offset and limit to continue large reads.`,
		promptSnippet: "Read file contents",
		promptGuidelines: [
			"Use read to inspect files before editing them.",
			"For truncated files, continue from the offset shown in the result.",
		],
		inputSchema: readInputSchema,
		async executor({ path, offset, limit }, signal) {
			throwIfAborted(signal);
			const absolutePath = resolveToCwd(path, cwd);
			const bytes = await operations.readFile(absolutePath, signal);
			throwIfAborted(signal);
			const mimeType = detectImageMimeType(bytes);
			if (mimeType) {
				if (offset !== undefined || limit !== undefined) {
					throw new Error(
						"offset and limit cannot be used when reading an image file",
					);
				}
				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{
							type: "image",
							data: Buffer.from(bytes).toString("base64"),
							mimeType,
						},
					],
					details: {
						path: absolutePath,
						bytes: bytes.byteLength,
						image: { mimeType, bytes: bytes.byteLength },
					},
				};
			}

			const text = decodeUtf8(bytes, path);
			const { lines, hasFinalNewline } = splitPhysicalLines(text);
			const requestedOffset = offset ?? 1;
			const start = requestedOffset === 0 ? 0 : requestedOffset - 1;
			if (lines.length === 0) {
				if (start > 0) {
					throw new Error(
						`Offset ${requestedOffset} is beyond end of file (0 lines total)`,
					);
				}
				return {
					content: [{ type: "text", text: "" }],
					details: { path: absolutePath, bytes: bytes.byteLength },
				};
			}
			if (start >= lines.length) {
				throw new Error(
					`Offset ${requestedOffset} is beyond end of file (${lines.length} lines total)`,
				);
			}

			const end = Math.min(lines.length, start + (limit ?? lines.length));
			let selected = lines.slice(start, end).join("\n");
			if (end === lines.length && hasFinalNewline) {
				selected += "\n";
			}
			const truncation = truncateHead(selected, { maxLines, maxBytes });
			const startDisplay = start + 1;
			let output = truncation.content;
			let details: ReadToolDetails = {
				path: absolutePath,
				bytes: bytes.byteLength,
			};
			if (truncation.firstLineExceedsLimit) {
				const firstLineBytes = utf8ByteLength(lines[start] ?? "");
				output = `[Line ${startDisplay} is ${formatSize(firstLineBytes)}, exceeds ${formatSize(maxBytes)} limit. Use bash to read a bounded byte range.]`;
				details = { ...details, truncation };
			} else if (truncation.truncated) {
				const endDisplay = startDisplay + truncation.outputLines - 1;
				const nextOffset = endDisplay + 1;
				const byteNote =
					truncation.truncatedBy === "bytes"
						? ` (${formatSize(maxBytes)} limit)`
						: "";
				output += `\n\n[Showing lines ${startDisplay}-${endDisplay} of ${lines.length}${byteNote}. Use offset=${nextOffset} to continue.]`;
				details = { ...details, truncation };
			} else if (limit !== undefined && end < lines.length) {
				output += `\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`;
			}
			return { content: [{ type: "text", text: output }], details };
		},
	};
}

export function createReadTool(
	config?: CodingToolConfig | ReadToolOptions,
): AgentTool<ReadToolInput, ReadToolDetails> {
	return createAgentTool(createReadToolDefinition(config));
}
