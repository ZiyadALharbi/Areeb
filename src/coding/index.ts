export * from "./modes/index.ts";
export type { AreebPathOptions, AreebPaths } from "./paths.ts";
export { areebPaths } from "./paths.ts";
export type {
	LoadProjectContextOptions,
	ProjectContextFile,
} from "./project-context.ts";
export {
	discoverProjectDirectories,
	loadProjectContext,
} from "./project-context.ts";
export type { BuildSystemPromptOptions } from "./prompt-builder.ts";
export { buildSystemPrompt } from "./prompt-builder.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export {
	expandPromptTemplateInvocation,
	loadPromptTemplates,
	renderPromptTemplate,
} from "./prompt-templates.ts";
export type { ParsedFrontmatter } from "./resources.ts";
export {
	MAX_RESOURCE_BYTES,
	parseFrontmatter,
	parseMarkdownFrontmatter,
	ResourceError,
	readResourceFile,
} from "./resources.ts";
export type { CodingSessionConfig, CommandResult } from "./session.ts";
export { CodingSession } from "./session.ts";
export type {
	CodingSessionDiscoveryOptions,
	CodingSessionManagerOptions,
	CodingSessionRecord,
} from "./session-manager.ts";
export {
	CodingSessionManager,
	findCodingSession,
	listCodingSessions,
} from "./session-manager.ts";
export type { Skill, SkillLayout, SkillSource } from "./skills.ts";
export {
	buildSkillIndex,
	discoverProjectAgentSkillDirectories,
	expandSkillInvocation,
	isSkillDirective,
	loadSkills,
} from "./skills.ts";
export * from "./tools/index.ts";
export type {
	CodingToolConfig,
	CodingToolDefinition,
	CodingToolOptions,
} from "./types.ts";
export { createAgentTool } from "./types.ts";
