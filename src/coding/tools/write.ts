import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { AgentTool } from "../../agent/types.ts";
import {
	type CodingToolConfig,
	type CodingToolDefinition,
	type CodingToolOptions,
	createAgentTool,
} from "../types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveCodingCwd, resolveToCwd } from "./path-utils.ts";
import { utf8ByteLength } from "./truncate.ts";

export const writeInputSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe("Path to the file, relative to cwd or absolute"),
	content: z.string().describe("Complete UTF-8 content to write"),
});

export type WriteToolInput = z.infer<typeof writeInputSchema>;

export interface WriteToolDetails {
	path: string;
	bytes: number;
}

export interface WriteOperations {
	mkdir(path: string): Promise<void>;
	writeFile(path: string, content: string): Promise<void>;
}

export interface WriteToolOptions extends CodingToolOptions {
	operations?: WriteOperations;
}

const defaultWriteOperations: WriteOperations = {
	mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
	writeFile: (path, content) => writeFile(path, content, "utf8"),
};

function normalizeOptions(
	config: string | WriteToolOptions | undefined,
): WriteToolOptions {
	return typeof config === "string" ? { cwd: config } : (config ?? {});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

export function createWriteToolDefinition(
	config?: string | WriteToolOptions,
): CodingToolDefinition<WriteToolInput, WriteToolDetails> {
	const options = normalizeOptions(config);
	const cwd = resolveCodingCwd(options);
	const operations = options.operations ?? defaultWriteOperations;
	return {
		name: "write",
		description:
			"Write a complete UTF-8 file. Creates parent directories and overwrites an existing file.",
		promptSnippet: "Create or overwrite files",
		promptGuidelines: [
			"Use write for new files or intentional complete rewrites.",
		],
		inputSchema: writeInputSchema,
		async executor({ path, content }, signal) {
			const absolutePath = resolveToCwd(path, cwd);
			return withFileMutationQueue(absolutePath, async () => {
				throwIfAborted(signal);
				await operations.mkdir(dirname(absolutePath));
				throwIfAborted(signal);
				await operations.writeFile(absolutePath, content);
				throwIfAborted(signal);
				const bytes = utf8ByteLength(content);
				return {
					content: [
						{
							type: "text",
							text: `Successfully wrote ${bytes} bytes to ${path}`,
						},
					],
					details: { path: absolutePath, bytes },
				};
			});
		},
	};
}

export function createWriteTool(
	config?: CodingToolConfig | WriteToolOptions,
): AgentTool<WriteToolInput, WriteToolDetails> {
	return createAgentTool(createWriteToolDefinition(config));
}
