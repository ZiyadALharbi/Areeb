import type { AreebPaths } from "./paths.ts";
import {
	loadProjectContext,
	type ProjectContextFile,
} from "./project-context.ts";
import { buildSystemPrompt } from "./prompt-builder.ts";
import {
	loadPromptTemplatesWithDiagnostics,
	type PromptTemplate,
	type PromptTemplateSource,
} from "./prompt-templates.ts";
import type { ResourceDiagnostic } from "./resources.ts";
import {
	discoverProjectAgentSkillDirectories,
	loadSkillsWithDiagnostics,
	type Skill,
	type SkillSource,
} from "./skills.ts";
import type { CodingToolDefinition } from "./types.ts";

export interface SessionResourceInputs {
	readonly cwd: string;
	readonly paths: AreebPaths;
	readonly trustProjectResources: boolean;
	readonly callerContextFiles: readonly ProjectContextFile[];
	readonly activeToolDefinitions: readonly CodingToolDefinition[];
	readonly reservedPromptTemplateNames: readonly string[];
	readonly customPrompt?: string;
	readonly appendSystemPrompt?: string;
	readonly extraGuidelines: readonly string[];
}

export interface SessionResourceSnapshot {
	readonly skills: readonly Skill[];
	readonly promptTemplates: readonly PromptTemplate[];
	readonly contextFiles: readonly ProjectContextFile[];
	readonly diagnostics: readonly ResourceDiagnostic[];
}

/** Copy caller-owned values once so every reload uses the original contract. */
export function freezeSessionResourceInputs(
	inputs: SessionResourceInputs,
): SessionResourceInputs {
	return Object.freeze({
		cwd: inputs.cwd,
		paths: Object.freeze({ ...inputs.paths }),
		trustProjectResources: inputs.trustProjectResources,
		callerContextFiles: Object.freeze(
			inputs.callerContextFiles.map((file) => Object.freeze({ ...file })),
		),
		activeToolDefinitions: Object.freeze(
			inputs.activeToolDefinitions.map((definition) =>
				Object.freeze({
					...definition,
					...(definition.promptGuidelines === undefined
						? {}
						: {
								promptGuidelines: Object.freeze([
									...definition.promptGuidelines,
								]),
							}),
				}),
			),
		),
		reservedPromptTemplateNames: Object.freeze([
			...inputs.reservedPromptTemplateNames,
		]),
		...(inputs.customPrompt === undefined
			? {}
			: { customPrompt: inputs.customPrompt }),
		...(inputs.appendSystemPrompt === undefined
			? {}
			: { appendSystemPrompt: inputs.appendSystemPrompt }),
		extraGuidelines: Object.freeze([...inputs.extraGuidelines]),
	});
}

/** Discover all reloadable coding resources as one immutable candidate. */
export async function assembleSessionResources(
	inputs: SessionResourceInputs,
): Promise<SessionResourceSnapshot> {
	const skillSources: SkillSource[] = [
		{
			directory: inputs.paths.userAgentSkills,
			layout: "agents",
			precedence: 0,
		},
		{
			directory: inputs.paths.userSkills,
			layout: "areeb",
			precedence: 1,
		},
	];
	const promptSources: PromptTemplateSource[] = [
		{ directory: inputs.paths.userPrompts, precedence: 0 },
	];

	if (inputs.trustProjectResources) {
		let precedence = 2;
		for (const directory of await discoverProjectAgentSkillDirectories(
			inputs.cwd,
			inputs.paths.userAgentSkills,
		)) {
			skillSources.push({ directory, layout: "agents", precedence });
			precedence += 1;
		}
		skillSources.push({
			directory: inputs.paths.projectSkills,
			layout: "areeb",
			precedence,
		});
		promptSources.push({
			directory: inputs.paths.projectPrompts,
			precedence: 1,
		});
	}

	const [skillResult, promptTemplateResult, contextFiles] = await Promise.all([
		loadSkillsWithDiagnostics(skillSources),
		loadPromptTemplatesWithDiagnostics(promptSources, {
			reservedNames: inputs.reservedPromptTemplateNames,
		}),
		loadProjectContext({
			cwd: inputs.cwd,
			userRoot: inputs.paths.userRoot,
			agentsRoot: inputs.paths.agentsRoot,
			projectRoot: inputs.paths.projectRoot,
			projectAgentsRoot: inputs.paths.projectAgentsRoot,
			trustProjectResources: inputs.trustProjectResources,
			contextFiles: inputs.callerContextFiles,
		}),
	]);

	return Object.freeze({
		skills: skillResult.skills,
		promptTemplates: promptTemplateResult.promptTemplates,
		contextFiles,
		diagnostics: Object.freeze([
			...skillResult.diagnostics,
			...promptTemplateResult.diagnostics,
		]),
	});
}

export function buildSessionSystemPrompt(
	inputs: SessionResourceInputs,
	resources: SessionResourceSnapshot,
): string {
	return buildSystemPrompt({
		cwd: inputs.cwd,
		tools: inputs.activeToolDefinitions,
		skills: resources.skills,
		...(inputs.customPrompt === undefined
			? {}
			: { customPrompt: inputs.customPrompt }),
		...(inputs.appendSystemPrompt === undefined
			? {}
			: { appendSystemPrompt: inputs.appendSystemPrompt }),
		extraGuidelines: inputs.extraGuidelines,
		contextFiles: resources.contextFiles,
	});
}
