import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/** Maximum UTF-8 size of one skill or prompt-template file. */
export const MAX_RESOURCE_BYTES = 1024 * 1024;

export type ResourceKind = "skill" | "prompt-template";

export type ResourceDiagnosticCode =
	| "source-unreadable"
	| "read-failed"
	| "parse-failed"
	| "validation-failed"
	| "duplicate"
	| "overridden"
	| "untrusted";

export interface ResourceDiagnostic {
	readonly kind: ResourceKind;
	readonly code: ResourceDiagnosticCode;
	readonly severity: "info" | "warning";
	readonly name?: string;
	readonly path?: string;
	readonly relatedPath?: string;
	readonly message: string;
}

export type ResourceLoadPolicy = "strict" | "diagnostic";

export interface ResourceSource {
	readonly directory: string;
	/** Higher values override lower values. Array order breaks ties. */
	readonly precedence?: number;
}

export type ResourceLoadResult<TKey extends string, TResource> = Readonly<
	Record<TKey, readonly TResource[]> & {
		readonly diagnostics: readonly ResourceDiagnostic[];
	}
>;

export interface ParsedFrontmatter {
	readonly attributes: Readonly<Record<string, string>>;
	readonly body: string;
}

export class ResourceError extends Error {
	readonly filePath: string | undefined;

	constructor(message: string, filePath?: string, options?: ErrorOptions) {
		super(
			filePath === undefined ? message : `${filePath}: ${message}`,
			options,
		);
		this.name = "ResourceError";
		this.filePath = filePath;
	}
}

/** Parse Areeb's documented frontmatter subset, not general YAML. */
export function parseFrontmatter(
	source: string,
	filePath?: string,
): ParsedFrontmatter {
	const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	if (lines[0] !== "---") {
		return { attributes: Object.freeze({}), body: normalized };
	}

	const attributes: Record<string, string> = {};
	let closingIndex = -1;

	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index] as string;
		if (line === "---") {
			closingIndex = index;
			break;
		}

		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) {
			continue;
		}
		if (/^\s/.test(line)) {
			throw new ResourceError(
				`Malformed frontmatter entry on line ${index + 1}`,
				filePath,
			);
		}

		const colonIndex = line.indexOf(":");
		if (colonIndex < 0) {
			throw new ResourceError(
				`Malformed frontmatter entry on line ${index + 1}`,
				filePath,
			);
		}

		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();
		if (key.length === 0 || !/^[A-Za-z0-9_-]+$/.test(key)) {
			throw new ResourceError(
				`Invalid frontmatter key on line ${index + 1}`,
				filePath,
			);
		}
		if (Object.hasOwn(attributes, key)) {
			throw new ResourceError(
				`Duplicate frontmatter key "${key}" on line ${index + 1}`,
				filePath,
			);
		}
		const blockStyle = /^([|>])([+-])?$/.exec(value);
		if (blockStyle !== null) {
			const block = readFrontmatterBlock(
				lines,
				index + 1,
				blockStyle[1] === ">",
			);
			attributes[key] = block.value;
			index = block.endIndex - 1;
			continue;
		}
		attributes[key] = value;
		if (value.length === 0) {
			index = skipNestedFrontmatterValue(lines, index + 1) - 1;
		}
	}

	if (closingIndex < 0) {
		throw new ResourceError(
			"Frontmatter is missing a closing --- line",
			filePath,
		);
	}

	return {
		attributes: Object.freeze(attributes),
		body: lines.slice(closingIndex + 1).join("\n"),
	};
}

function readFrontmatterBlock(
	lines: readonly string[],
	startIndex: number,
	fold: boolean,
): { readonly value: string; readonly endIndex: number } {
	let endIndex = startIndex;
	while (endIndex < lines.length) {
		const line = lines[endIndex] as string;
		if (line === "---" || (line.trim().length > 0 && !/^\s/.test(line))) {
			break;
		}
		endIndex += 1;
	}

	const blockLines = lines.slice(startIndex, endIndex);
	const indentation = blockLines
		.filter((line) => line.trim().length > 0)
		.reduce(
			(minimum, line) => Math.min(minimum, line.match(/^\s*/)?.[0].length ?? 0),
			Number.POSITIVE_INFINITY,
		);
	const dedented = blockLines.map((line) =>
		line.trim().length === 0
			? ""
			: line.slice(Number.isFinite(indentation) ? indentation : 0),
	);
	return {
		value: fold ? foldFrontmatterLines(dedented) : dedented.join("\n"),
		endIndex,
	};
}

function foldFrontmatterLines(lines: readonly string[]): string {
	const paragraphs: string[] = [];
	let paragraph: string[] = [];
	for (const line of lines) {
		if (line.length === 0) {
			if (paragraph.length > 0) {
				paragraphs.push(paragraph.join(" "));
				paragraph = [];
			}
			continue;
		}
		paragraph.push(line);
	}
	if (paragraph.length > 0) {
		paragraphs.push(paragraph.join(" "));
	}
	return paragraphs.join("\n\n");
}

function skipNestedFrontmatterValue(
	lines: readonly string[],
	startIndex: number,
): number {
	let index = startIndex;
	while (index < lines.length) {
		const line = lines[index] as string;
		if (line === "---" || (line.trim().length > 0 && !/^\s/.test(line))) {
			break;
		}
		index += 1;
	}
	return index;
}

export const parseMarkdownFrontmatter = parseFrontmatter;

export async function readResourceFile(filePath: string): Promise<string> {
	const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath);
	let metadata: Awaited<ReturnType<typeof stat>>;
	try {
		metadata = await stat(absolutePath);
	} catch (error) {
		throw new ResourceError("Unable to inspect resource", absolutePath, {
			cause: error,
		});
	}

	if (!metadata.isFile()) {
		throw new ResourceError("Resource is not a regular file", absolutePath);
	}
	if (metadata.size > MAX_RESOURCE_BYTES) {
		throw new ResourceError(
			`Resource exceeds the ${MAX_RESOURCE_BYTES}-byte limit`,
			absolutePath,
		);
	}

	let contents: string;
	try {
		contents = await readFile(absolutePath, "utf8");
	} catch (error) {
		throw new ResourceError("Unable to read resource", absolutePath, {
			cause: error,
		});
	}

	if (Buffer.byteLength(contents, "utf8") > MAX_RESOURCE_BYTES) {
		throw new ResourceError(
			`Resource exceeds the ${MAX_RESOURCE_BYTES}-byte limit`,
			absolutePath,
		);
	}
	return contents;
}
