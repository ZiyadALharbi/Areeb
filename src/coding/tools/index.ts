import type { AgentTool } from "../../agent/types.ts";
import {
	type CodingToolDefinition,
	type CodingToolOptions,
	createAgentTool,
} from "../types.ts";
import { createBashToolDefinition } from "./bash.ts";
import { createEditToolDefinition } from "./edit.ts";
import { createReadToolDefinition } from "./read.ts";
import { createWriteToolDefinition } from "./write.ts";

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
export function createCodingToolDefinitions(
	options: CreateCodingToolsOptions | string = {},
): CodingToolDefinition[] {
	const config = typeof options === "string" ? { cwd: options } : options;
	return [
		createReadToolDefinition(config),
		createWriteToolDefinition(config),
		createEditToolDefinition(config),
		createBashToolDefinition(config),
	];
}

/** Adapt the default rich definitions to the provider-neutral agent contract. */
export function createCodingTools(
	options: CreateCodingToolsOptions | string = {},
): AgentTool[] {
	return createCodingToolDefinitions(options).map((definition) =>
		createAgentTool(definition),
	);
}
