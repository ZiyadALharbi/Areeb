import type {
	CommandCapability,
	CommandModelListItem,
	CommandSessionListItem,
	SlashCommand,
} from "../commands.ts";

export type CompletionSource =
	| "builtin"
	| "skill"
	| "template"
	| "session"
	| "model";

export interface CompletionItem {
	readonly value: string;
	readonly label: string;
	readonly description: string;
	readonly source: CompletionSource;
	readonly usage?: string;
	readonly aliases: readonly string[];
	readonly missingCapabilities: readonly CommandCapability[];
	readonly planned: boolean;
}

export interface CompletionRange {
	readonly line: number;
	readonly start: number;
	readonly end: number;
}

export interface CompletionState {
	readonly items: readonly CompletionItem[];
	readonly query: string;
	readonly replacement: CompletionRange;
}

export interface BuildCompletionStateOptions {
	readonly commands: readonly SlashCommand[];
	readonly skillNames: readonly string[];
	readonly templateNames: readonly string[];
	readonly lines: readonly string[];
	readonly cursorLine: number;
	readonly cursorCol: number;
	readonly availableCapabilities: readonly CommandCapability[];
	readonly sessionIds?: readonly string[];
	readonly modelValues?: readonly string[];
}

export interface CompletionCatalog {
	readonly commands: readonly SlashCommand[];
	readonly skillNames: readonly string[];
	readonly templateNames: readonly string[];
	readonly availableCapabilities: readonly CommandCapability[];
	readonly cwd: string;
	readonly listSessions: () => Promise<readonly CommandSessionListItem[]>;
	readonly models: readonly CommandModelListItem[];
}

interface RankedItem {
	readonly item: CompletionItem;
	readonly matchGroup: number;
	readonly matchScore: number;
	readonly catalogOrder: number;
}

const SKILL_PREFIX = "/skill:";

/** Build slash completions without depending on terminal or filesystem state. */
export function buildCompletionState(
	options: BuildCompletionStateOptions,
): CompletionState | null {
	if (options.cursorLine !== 0) {
		return null;
	}
	const line = options.lines[0] ?? "";
	if (
		!line.startsWith("/") ||
		options.cursorCol < 1 ||
		options.cursorCol > line.length
	) {
		return null;
	}

	const whitespaceIndex = line.search(/\s/);
	const tokenEnd = whitespaceIndex === -1 ? line.length : whitespaceIndex;
	if (options.cursorCol > tokenEnd) {
		return buildArgumentCompletion(options, line, tokenEnd);
	}

	const tokenBeforeCursor = line.slice(0, options.cursorCol);
	if (tokenBeforeCursor.startsWith(SKILL_PREFIX)) {
		const query = tokenBeforeCursor.slice(SKILL_PREFIX.length);
		const replacement = Object.freeze({
			line: 0,
			start: SKILL_PREFIX.length,
			end: tokenEnd,
		});
		const items = [...new Set(options.skillNames)]
			.sort((left, right) => left.localeCompare(right))
			.map((name, index) =>
				rankItem(
					{
						value: name,
						label: `${SKILL_PREFIX}${name}`,
						description: "Loaded skill",
						source: "skill",
						aliases: [],
						missingCapabilities: [],
						planned: false,
					},
					query,
					[],
					[],
					index,
				),
			)
			.filter((candidate): candidate is RankedItem => candidate !== undefined)
			.sort(compareRankedItems)
			.map((candidate) => candidate.item);
		return freezeState(items, query, replacement);
	}

	const query = tokenBeforeCursor.slice(1);
	const availableCapabilities = new Set(options.availableCapabilities);
	const executableNames = new Set(
		options.commands.flatMap((command) => [
			command.name,
			...(command.aliases ?? []),
		]),
	);
	const ranked: RankedItem[] = [];
	let catalogOrder = 0;

	for (const command of options.commands) {
		const missingCapabilities = (command.requirements ?? []).filter(
			(requirement) => !availableCapabilities.has(requirement),
		);
		const candidate = rankItem(
			{
				value: `/${command.name}`,
				label: `/${command.name}`,
				description: command.description,
				source: "builtin",
				usage: command.usage,
				aliases: command.aliases ?? [],
				missingCapabilities,
				planned: missingCapabilities.length > 0,
			},
			query,
			command.aliases ?? [],
			command.searchTerms ?? [],
			catalogOrder,
		);
		catalogOrder += 1;
		if (candidate !== undefined) {
			ranked.push(candidate);
		}
	}

	if (options.skillNames.length > 0) {
		const candidate = rankItem(
			{
				value: SKILL_PREFIX,
				label: SKILL_PREFIX,
				description: "Use a loaded skill",
				source: "skill",
				aliases: [],
				missingCapabilities: [],
				planned: false,
			},
			query,
			[],
			[],
			catalogOrder,
		);
		catalogOrder += 1;
		if (candidate !== undefined) {
			ranked.push(candidate);
		}
	}

	for (const name of [...new Set(options.templateNames)]
		.filter((name) => name !== "skill" && !executableNames.has(name))
		.sort((left, right) => left.localeCompare(right))) {
		const candidate = rankItem(
			{
				value: `/${name}`,
				label: `/${name}`,
				description: "Prompt template",
				source: "template",
				aliases: [],
				missingCapabilities: [],
				planned: false,
			},
			query,
			[],
			[],
			catalogOrder,
		);
		catalogOrder += 1;
		if (candidate !== undefined) {
			ranked.push(candidate);
		}
	}

	const replacement = Object.freeze({ line: 0, start: 0, end: tokenEnd });
	return freezeState(
		ranked.sort(compareRankedItems).map((candidate) => candidate.item),
		`/${query}`,
		replacement,
	);
}

function buildArgumentCompletion(
	options: BuildCompletionStateOptions,
	line: string,
	tokenEnd: number,
): CompletionState | null {
	const command = line.slice(0, tokenEnd);
	const values =
		command === "/resume"
			? options.sessionIds
			: command === "/model"
				? options.modelValues
				: undefined;
	if (values === undefined) {
		return null;
	}

	let argumentStart = tokenEnd;
	while (argumentStart < line.length && /\s/.test(line[argumentStart] ?? "")) {
		argumentStart += 1;
	}
	if (options.cursorCol < argumentStart) {
		argumentStart = options.cursorCol;
	}
	const argumentBeforeCursor = line.slice(argumentStart, options.cursorCol);
	if (/\s/.test(argumentBeforeCursor)) {
		return null;
	}
	let argumentEnd = options.cursorCol;
	while (argumentEnd < line.length && !/\s/.test(line[argumentEnd] ?? "")) {
		argumentEnd += 1;
	}

	const source = command === "/resume" ? "session" : "model";
	const description =
		source === "session" ? "Stored session" : "Usable provider model";
	const items = [...new Set(values)]
		.map((value, index) =>
			rankItem(
				{
					value,
					label: value,
					description,
					source,
					aliases: [],
					missingCapabilities: [],
					planned: false,
				},
				argumentBeforeCursor,
				[],
				[],
				index,
			),
		)
		.filter((candidate): candidate is RankedItem => candidate !== undefined)
		.sort(compareRankedItems)
		.map((candidate) => candidate.item);

	return freezeState(items, argumentBeforeCursor, {
		line: 0,
		start: argumentStart,
		end: argumentEnd,
	});
}

function rankItem(
	item: CompletionItem,
	query: string,
	aliases: readonly string[],
	searchTerms: readonly string[],
	catalogOrder: number,
): RankedItem | undefined {
	if (query.length === 0) {
		return {
			item: freezeItem(item),
			matchGroup: 0,
			matchScore: 0,
			catalogOrder,
		};
	}

	const primary = scoreText(query, item.value.replace(/^\//, ""));
	let best: { readonly group: number; readonly score: number } | undefined =
		primary === undefined
			? undefined
			: { group: primary.kind, score: primary.score };
	for (const alias of aliases) {
		const score = scoreText(query, alias);
		if (score === undefined) {
			continue;
		}
		const match = { group: score.kind + 1, score: score.score };
		if (best === undefined || compareMatch(match, best) < 0) {
			best = match;
		}
	}
	for (const term of searchTerms) {
		const score = scoreText(query, term);
		if (score === undefined) {
			continue;
		}
		const match = { group: 6, score: score.kind * 1_000 + score.score };
		if (best === undefined || compareMatch(match, best) < 0) {
			best = match;
		}
	}
	if (best === undefined) {
		return undefined;
	}
	return {
		item: freezeItem(item),
		matchGroup: best.group,
		matchScore: best.score,
		catalogOrder,
	};
}

function scoreText(
	query: string,
	text: string,
): { readonly kind: 0 | 2 | 4; readonly score: number } | undefined {
	const normalizedQuery = query.toLocaleLowerCase();
	const normalizedText = text.toLocaleLowerCase();
	if (normalizedText === normalizedQuery) {
		return { kind: 0, score: 0 };
	}
	if (normalizedText.startsWith(normalizedQuery)) {
		return { kind: 2, score: normalizedText.length - normalizedQuery.length };
	}

	let textIndex = 0;
	let gapScore = 0;
	for (const character of normalizedQuery) {
		const matchIndex = normalizedText.indexOf(character, textIndex);
		if (matchIndex === -1) {
			return undefined;
		}
		gapScore += matchIndex - textIndex;
		textIndex = matchIndex + character.length;
	}
	return {
		kind: 4,
		score: gapScore * 10 + normalizedText.length - normalizedQuery.length,
	};
}

function compareMatch(
	left: { readonly group: number; readonly score: number },
	right: { readonly group: number; readonly score: number },
): number {
	return left.group - right.group || left.score - right.score;
}

function compareRankedItems(left: RankedItem, right: RankedItem): number {
	return (
		left.matchGroup - right.matchGroup ||
		left.matchScore - right.matchScore ||
		left.catalogOrder - right.catalogOrder ||
		left.item.value.localeCompare(right.item.value)
	);
}

function freezeItem(item: CompletionItem): CompletionItem {
	return Object.freeze({
		...item,
		aliases: Object.freeze([...item.aliases]),
		missingCapabilities: Object.freeze([...item.missingCapabilities]),
	});
}

function freezeState(
	items: readonly CompletionItem[],
	query: string,
	replacement: CompletionRange,
): CompletionState {
	return Object.freeze({
		items: Object.freeze([...items]),
		query,
		replacement,
	});
}
