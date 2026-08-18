import type { ProjectContextFile } from "./project-context.ts";
import type { Skill } from "./skills.ts";
import { buildSkillIndex } from "./skills.ts";
import type { CodingToolDefinition } from "./types.ts";

const DEFAULT_IDENTITY =
	"You are an expert coding assistant operating inside Areeb, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
const BASELINE_GUIDELINES = [
	"Review applicable project instructions and relevant files before making changes",
	"Keep changes focused and consistent with the existing architecture and conventions",
	"Preserve unrelated work already present in the project",
	"Follow the project's documented workflows, commands, and package manager",
	"After changing code, run the applicable formatting, linting, type-checking, and test commands",
	"Report verification accurately and only claim results from commands you actually ran",
	"Request confirmation before destructive actions or decisions with materially unclear requirements",
	"Be concise in your responses",
	"Show file paths clearly when working with files",
] as const;

export interface BuildSystemPromptOptions {
	readonly cwd: string;
	readonly tools: readonly CodingToolDefinition[];
	readonly skills?: readonly Skill[];
	readonly customPrompt?: string;
	readonly appendSystemPrompt?: string;
	readonly extraGuidelines?: readonly string[];
	readonly contextFiles?: readonly ProjectContextFile[];
}

/** Build a deterministic coding system prompt from caller-provided resources. */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	if (
		options.customPrompt !== undefined &&
		options.customPrompt.trim().length === 0
	) {
		throw new Error("Custom system prompt cannot be empty");
	}

	const sections = [
		options.customPrompt ?? buildDefaultPrompt(options),
		...(options.appendSystemPrompt === undefined ||
		options.appendSystemPrompt.length === 0
			? []
			: [options.appendSystemPrompt]),
	];
	const context = buildProjectContext(options.contextFiles ?? []);
	if (context.length > 0) {
		sections.push(context);
	}
	if (options.tools.some((tool) => tool.name === "read")) {
		const skillIndex = buildSkillIndex(options.skills ?? []);
		if (skillIndex.length > 0) {
			sections.push(skillIndex);
		}
	}
	sections.push(
		`Current working directory: ${options.cwd.replaceAll("\\", "/")}`,
	);
	return sections.join("\n\n");
}

function buildDefaultPrompt(options: BuildSystemPromptOptions): string {
	const toolLines: string[] = [];
	for (const tool of options.tools) {
		const snippet = tool.promptSnippet?.trim().replace(/\s+/g, " ");
		if (snippet) {
			toolLines.push(`- ${tool.name}: ${snippet}`);
		}
	}

	const guidelines: string[] = [];
	const seenGuidelines = new Set<string>();
	const addGuideline = (value: string): void => {
		const normalized = value.trim();
		if (normalized.length === 0 || seenGuidelines.has(normalized)) {
			return;
		}
		seenGuidelines.add(normalized);
		guidelines.push(normalized);
	};
	for (const tool of options.tools) {
		for (const guideline of tool.promptGuidelines ?? []) {
			addGuideline(guideline);
		}
	}
	for (const guideline of options.extraGuidelines ?? []) {
		addGuideline(guideline);
	}
	for (const guideline of BASELINE_GUIDELINES) {
		addGuideline(guideline);
	}

	return `${DEFAULT_IDENTITY}

Available tools:
${toolLines.length === 0 ? "(none)" : toolLines.join("\n")}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines.map((guideline) => `- ${guideline}`).join("\n")}`;
}

function buildProjectContext(files: readonly ProjectContextFile[]): string {
	if (files.length === 0) {
		return "";
	}

	const instructions = files.map(
		(file) =>
			`<project_instructions path="${escapeXml(file.path)}">\n${file.content}\n</project_instructions>`,
	);
	return `<project_context>

Project-specific instructions and guidelines. Later files have higher specificity:

${instructions.join("\n\n")}

</project_context>`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("'", "&apos;");
}
