import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "../agent/types.ts";
import type { ToolDefinition } from "../ai/types.ts";

/** Common configuration shared by local coding tools. */
export interface CodingToolOptions {
	/** Working directory used to resolve relative paths. Defaults to process.cwd(). */
	cwd?: string;
}

export type CodingToolConfig = string | CodingToolOptions | undefined;

/**
 * Rich, Pi-like coding-tool metadata.
 *
 * Providers only receive the portable ToolDefinition fields. Applications can
 * use the prompt metadata to assemble their own system prompt, while executor
 * is adapted to AgentTool.execute by createAgentTool().
 */
export interface CodingToolDefinition<TInput = unknown, TDetails = unknown>
	extends ToolDefinition<TInput> {
	readonly promptSnippet: string;
	readonly promptGuidelines: readonly string[];
	executor(
		input: TInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	): Promise<AgentToolResult<TDetails>>;
}

/** Convert rich coding metadata into the provider-neutral agent tool contract. */
export function createAgentTool<TInput, TDetails>(
	definition: CodingToolDefinition<TInput, TDetails>,
): AgentTool<TInput, TDetails> {
	return {
		name: definition.name,
		description: definition.description,
		inputSchema: definition.inputSchema,
		execute: definition.executor,
	};
}
