import type { AgentTool } from "../../agent/types.ts";
import type { CodingToolOptions } from "../types.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export {
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashInputSchema,
	createBashTool,
	createBashToolDefinition,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editInputSchema,
} from "./edit.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readInputSchema,
} from "./read.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolDetails,
	type WriteToolInput,
	type WriteToolOptions,
	writeInputSchema,
} from "./write.ts";

export interface CreateCodingToolsOptions extends CodingToolOptions {}

/** The stable default coding-tool set: read, write, edit, then bash. */
export function createCodingTools(
	options: CreateCodingToolsOptions | string = {},
): AgentTool[] {
	const config = typeof options === "string" ? { cwd: options } : options;
	return [
		createReadTool(config),
		createWriteTool(config),
		createEditTool(config),
		createBashTool(config),
	];
}
