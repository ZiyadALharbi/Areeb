import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import {
	parseFrontmatter,
	type ResourceDiagnostic,
	ResourceError,
	type ResourceLoadPolicy,
	type ResourceLoadResult,
	type ResourceSource,
	readResourceFile,
} from "./resources.ts";

const PROMPT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PROMPT_NAME_LENGTH = 64;
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g;

export interface PromptTemplate {
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly content: string;
	readonly filePath: string;
}

export interface LoadPromptTemplatesOptions {
	readonly reservedNames?: readonly string[];
}

export type PromptTemplateSource = ResourceSource;

export type LoadPromptTemplatesResult = ResourceLoadResult<
	"promptTemplates",
	PromptTemplate
>;

type PromptTemplateSourceInput = string | PromptTemplateSource;

interface OrderedPromptTemplateSource extends PromptTemplateSource {
	readonly order: number;
	readonly precedence: number;
}

interface PromptDiscoveryContext {
	readonly diagnostics: ResourceDiagnostic[];
	readonly policy: ResourceLoadPolicy;
	readonly reservedNames: ReadonlySet<string>;
}

export async function loadPromptTemplates(
	sources: PromptTemplateSourceInput | readonly PromptTemplateSourceInput[],
	options: LoadPromptTemplatesOptions = {},
): Promise<PromptTemplate[]> {
	return [
		...(await loadPromptTemplatesInternal(sources, options, "strict"))
			.promptTemplates,
	];
}

export async function loadPromptTemplatesWithDiagnostics(
	sources: PromptTemplateSourceInput | readonly PromptTemplateSourceInput[],
	options: LoadPromptTemplatesOptions = {},
): Promise<LoadPromptTemplatesResult> {
	return loadPromptTemplatesInternal(sources, options, "diagnostic");
}

async function loadPromptTemplatesInternal(
	sources: PromptTemplateSourceInput | readonly PromptTemplateSourceInput[],
	options: LoadPromptTemplatesOptions,
	policy: ResourceLoadPolicy,
): Promise<LoadPromptTemplatesResult> {
	const byName = new Map<string, PromptTemplate>();
	const canonicalFiles = new Set<string>();
	const context: PromptDiscoveryContext = {
		diagnostics: [],
		policy,
		reservedNames: new Set(options.reservedNames ?? []),
	};

	for (const source of orderPromptSources(sources)) {
		const sourceByName = new Map<string, PromptTemplate>();
		for (const candidate of await discoverPromptFiles(source, context)) {
			const canonicalPath = await resolveCanonicalPrompt(
				candidate.filePath,
				context,
			);
			if (canonicalPath === undefined) {
				continue;
			}
			if (canonicalFiles.has(canonicalPath)) {
				continue;
			}
			canonicalFiles.add(canonicalPath);
			const template = await loadPromptTemplateCandidate(candidate, context);
			if (template === undefined) {
				continue;
			}
			const duplicate = sourceByName.get(template.name);
			if (duplicate) {
				const error = new ResourceError(
					`Duplicate prompt template "${template.name}"; first loaded from ${duplicate.filePath}`,
					template.filePath,
				);
				if (policy === "strict") {
					throw error;
				}
				context.diagnostics.push(
					createDiagnostic({
						kind: "prompt-template",
						code: "duplicate",
						severity: "warning",
						name: template.name,
						path: template.filePath,
						relatedPath: duplicate.filePath,
						message: `Duplicate prompt template "${template.name}" was skipped`,
					}),
				);
				continue;
			}
			sourceByName.set(template.name, template);
		}
		for (const template of sourceByName.values()) {
			const overridden = byName.get(template.name);
			if (overridden && policy === "diagnostic") {
				context.diagnostics.push(
					createDiagnostic({
						kind: "prompt-template",
						code: "overridden",
						severity: "info",
						name: template.name,
						path: overridden.filePath,
						relatedPath: template.filePath,
						message: `Prompt template "${template.name}" was overridden by a higher-precedence source`,
					}),
				);
			}
			byName.set(template.name, template);
		}
	}

	const promptTemplates = [...byName.values()].sort(
		(left, right) =>
			left.name.localeCompare(right.name) ||
			left.filePath.localeCompare(right.filePath),
	);
	return Object.freeze({
		promptTemplates: Object.freeze(promptTemplates),
		diagnostics: Object.freeze(context.diagnostics),
	});
}

export function renderPromptTemplate(
	template: PromptTemplate,
	variables: Readonly<Record<string, string>>,
): string {
	return template.content.replace(
		PLACEHOLDER_PATTERN,
		(_placeholder, name: string) => {
			if (!Object.hasOwn(variables, name)) {
				throw new ResourceError(
					`Missing prompt template variable "${name}"`,
					template.filePath,
				);
			}
			return variables[name] as string;
		},
	);
}

export function expandPromptTemplateInvocation(
	input: string,
	templates: readonly PromptTemplate[],
): string {
	const match = /^\/([^\s]+)([\s\S]*)$/.exec(input);
	if (!match) {
		return input;
	}

	const template = templates.find((candidate) => candidate.name === match[1]);
	if (!template) {
		return input;
	}

	const argumentsText = (match[2] as string).trim();
	const hasArgumentPlaceholder = hasPlaceholder(
		template.content,
		new Set(["arguments", "args"]),
	);
	const rendered = renderPromptTemplate(template, {
		arguments: argumentsText,
		args: argumentsText,
	});
	return !hasArgumentPlaceholder && argumentsText.length > 0
		? `${rendered}\n\n${argumentsText}`
		: rendered;
}

interface PromptTemplateCandidate {
	readonly filePath: string;
	readonly name: string;
	readonly relativePath: string;
}

async function discoverPromptFiles(
	source: OrderedPromptTemplateSource,
	context: PromptDiscoveryContext,
): Promise<PromptTemplateCandidate[]> {
	const absoluteDirectory = resolve(source.directory);
	let entries: Dirent<string>[];
	try {
		entries = await readdir(absoluteDirectory, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) {
			return [];
		}
		reportPromptFailure(
			context,
			new ResourceError(
				"Unable to list prompt templates directory",
				absoluteDirectory,
				{ cause: error },
			),
			"source-unreadable",
			absoluteDirectory,
		);
		return [];
	}

	const candidates: PromptTemplateCandidate[] = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		if (extname(entry.name) !== ".md") {
			continue;
		}
		const filePath = join(absoluteDirectory, entry.name);
		let metadata: Awaited<ReturnType<typeof stat>>;
		try {
			metadata = await stat(filePath);
		} catch (error) {
			if (entry.isSymbolicLink() && isMissing(error)) {
				if (context.policy === "diagnostic") {
					reportPromptFailure(
						context,
						new ResourceError("Unable to inspect prompt template", filePath, {
							cause: error,
						}),
						"read-failed",
						filePath,
						basename(filePath, ".md"),
					);
				}
				continue;
			}
			reportPromptFailure(
				context,
				new ResourceError("Unable to inspect prompt template", filePath, {
					cause: error,
				}),
				"read-failed",
				filePath,
				basename(filePath, ".md"),
			);
			continue;
		}
		if (metadata.isFile()) {
			candidates.push({
				filePath,
				name: basename(filePath, ".md"),
				relativePath: normalizeRelativePath(
					relative(absoluteDirectory, filePath),
				),
			});
		}
	}
	return candidates.sort(
		(left, right) =>
			left.relativePath.localeCompare(right.relativePath) ||
			left.filePath.localeCompare(right.filePath),
	);
}

async function loadPromptTemplateCandidate(
	candidate: PromptTemplateCandidate,
	context: PromptDiscoveryContext,
): Promise<PromptTemplate | undefined> {
	try {
		validatePromptName(candidate.name, candidate.filePath);
		if (context.reservedNames.has(candidate.name)) {
			throw new ResourceError(
				`Prompt template name "${candidate.name}" conflicts with a registered slash command`,
				candidate.filePath,
			);
		}
	} catch (error) {
		reportPromptFailure(
			context,
			error,
			"validation-failed",
			candidate.filePath,
			candidate.name,
		);
		return undefined;
	}

	let contents: string;
	try {
		contents = await readResourceFile(candidate.filePath);
	} catch (error) {
		reportPromptFailure(
			context,
			error,
			"read-failed",
			candidate.filePath,
			candidate.name,
		);
		return undefined;
	}

	let parsed: ReturnType<typeof parseFrontmatter>;
	try {
		parsed = parseFrontmatter(contents, candidate.filePath);
	} catch (error) {
		reportPromptFailure(
			context,
			error,
			"parse-failed",
			candidate.filePath,
			candidate.name,
		);
		return undefined;
	}

	try {
		return validateLoadedPromptTemplate(candidate, parsed);
	} catch (error) {
		reportPromptFailure(
			context,
			error,
			"validation-failed",
			candidate.filePath,
			candidate.name,
		);
		return undefined;
	}
}

function validateLoadedPromptTemplate(
	candidate: PromptTemplateCandidate,
	parsed: ReturnType<typeof parseFrontmatter>,
): PromptTemplate {
	const { attributes, body } = parsed;
	if (body.trim().length === 0) {
		throw new ResourceError(
			"Prompt template body cannot be empty",
			candidate.filePath,
		);
	}
	const description =
		attributes.description?.trim() ||
		body
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim();
	if (!description) {
		throw new ResourceError(
			"Prompt template requires content or a description",
			candidate.filePath,
		);
	}

	const argumentHint = attributes["argument-hint"]?.trim();
	return Object.freeze({
		name: candidate.name,
		description,
		...(argumentHint ? { argumentHint } : {}),
		content: body,
		filePath: resolve(candidate.filePath),
	});
}

async function resolveCanonicalPrompt(
	filePath: string,
	context: PromptDiscoveryContext,
): Promise<string | undefined> {
	try {
		return await realpath(filePath);
	} catch (error) {
		reportPromptFailure(
			context,
			new ResourceError("Unable to resolve prompt template path", filePath, {
				cause: error,
			}),
			"read-failed",
			filePath,
			basename(filePath, ".md"),
		);
		return undefined;
	}
}

function orderPromptSources(
	sources: PromptTemplateSourceInput | readonly PromptTemplateSourceInput[],
): OrderedPromptTemplateSource[] {
	const sourceList = (
		Array.isArray(sources) ? sources : [sources]
	) as readonly PromptTemplateSourceInput[];
	return sourceList
		.map((input, order) => {
			const source = typeof input === "string" ? { directory: input } : input;
			return {
				...source,
				order,
				precedence: source.precedence ?? order,
			};
		})
		.sort(
			(left, right) =>
				left.precedence - right.precedence || left.order - right.order,
		);
}

function reportPromptFailure(
	context: PromptDiscoveryContext,
	error: unknown,
	code: ResourceDiagnostic["code"],
	path: string,
	name?: string,
): void {
	if (context.policy === "strict") {
		throw error;
	}
	context.diagnostics.push(
		createDiagnostic({
			kind: "prompt-template",
			code,
			severity: "warning",
			...(name === undefined ? {} : { name }),
			path,
			message: diagnosticMessage(error),
		}),
	);
}

function createDiagnostic(diagnostic: ResourceDiagnostic): ResourceDiagnostic {
	return Object.freeze({ ...diagnostic });
}

function diagnosticMessage(error: unknown): string {
	if (!(error instanceof Error)) {
		return "Resource discovery failed";
	}
	if (error instanceof ResourceError && error.filePath !== undefined) {
		const prefix = `${error.filePath}: `;
		if (error.message.startsWith(prefix)) {
			return error.message.slice(prefix.length);
		}
	}
	return error.message;
}

function normalizeRelativePath(filePath: string): string {
	return filePath.replaceAll("\\", "/");
}

function validatePromptName(name: string, filePath: string): void {
	if (
		name.length === 0 ||
		name.length > MAX_PROMPT_NAME_LENGTH ||
		!PROMPT_NAME_PATTERN.test(name)
	) {
		throw new ResourceError(
			`Invalid prompt template name "${name}"; expected lowercase kebab-case with at most ${MAX_PROMPT_NAME_LENGTH} characters`,
			filePath,
		);
	}
}

function hasPlaceholder(content: string, names: ReadonlySet<string>): boolean {
	for (const match of content.matchAll(PLACEHOLDER_PATTERN)) {
		if (names.has(match[1] as string)) {
			return true;
		}
	}
	return false;
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
