import { homedir } from "node:os";
import {
	type Component,
	Markdown,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { REASONING_LEVELS, type ReasoningLevel } from "../../ai/types.ts";
import type { TuiEditDetails, TuiState } from "./state.ts";
import { boldText, type TuiTheme } from "./theme.ts";

// Every transcript row shares one gutter: a two-column inset, then a short
// tag such as "read" or "think", then the content column.
const INSET = 2;
const TAG_WIDTH = 8;
const GUTTER_WIDTH = INSET + TAG_WIDTH;
const MIN_GUTTER_CONTENT = 20;
const MAX_COLLAPSED_TOOLS = 5;
const TOOL_PREVIEW_MAX_LINES = 16;
const HIDDEN_CODE_FENCE = "\u{e000}";
const STATUS_SEPARATOR = " · ";

const SPINNER_FRAMES = Object.freeze([
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
]);

export const SPINNER_INTERVAL = 80;

export type MessageBlockKind = "user" | "assistant" | "status" | "error";

export class MessageBlock implements Component {
	private text: string;
	private readonly markdown: Markdown;
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly kind: MessageBlockKind,
		text: string,
		private readonly theme: TuiTheme,
	) {
		this.text = text;
		this.markdown = new Markdown(
			"",
			0,
			0,
			{
				...theme.markdown,
				codeBlockBorder: () => HIDDEN_CODE_FENCE,
			},
			{
				color: theme.primary,
			},
			{
				transform: normalizeMarkdownHeadings,
			},
		);
	}

	setText(text: string): void {
		if (this.text === text) {
			return;
		}
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		const availableWidth = normalizeWidth(width);
		if (
			this.cachedLines !== undefined &&
			this.cachedWidth === availableWidth &&
			this.cachedText === this.text
		) {
			return this.cachedLines;
		}

		const lines = this.renderUncached(availableWidth);
		this.cachedText = this.text;
		this.cachedWidth = availableWidth;
		this.cachedLines = lines;
		return lines;
	}

	private renderUncached(availableWidth: number): string[] {
		if (availableWidth === 0) {
			return [];
		}

		const cleanText = stripTerminalSequences(this.text);
		if (this.kind === "assistant") {
			return this.renderAssistant(cleanText, availableWidth);
		}
		if (this.kind === "user") {
			return this.renderUser(cleanText, availableWidth);
		}

		const status = this.kind === "status";
		return renderTagged(
			status ? "note" : "error",
			status ? this.theme.subtle : this.theme.error,
			(contentWidth) =>
				wrapLiteralText(cleanText, contentWidth).map((line) =>
					status ? this.theme.muted(line) : this.theme.primary(line),
				),
			availableWidth,
		);
	}

	private renderAssistant(text: string, width: number): string[] {
		if (!text) {
			return [""];
		}
		const margin = width > INSET * 2 + 4 ? INSET : 0;
		const contentWidth = width - margin * 2;
		try {
			this.markdown.setText(text);
			const markdownLines = this.markdown
				.render(contentWidth)
				.filter(
					(line) => stripTerminalSequences(line).trim() !== HIDDEN_CODE_FENCE,
				);
			if (markdownLines.length === 0) {
				return [""];
			}
			return [
				"",
				...markdownLines.flatMap((line) =>
					wrapTextWithAnsi(line, contentWidth).map((fragment) => {
						const trimmed = trimTerminalLineEnd(fragment);
						return trimmed ? `${" ".repeat(margin)}${trimmed}` : "";
					}),
				),
			];
		} catch {
			// Streaming can temporarily expose malformed Markdown. Literal text is
			// always safe and keeps the transcript usable until the next update.
			return [
				"",
				...wrapLiteralText(text, contentWidth).map((line) =>
					line ? `${" ".repeat(margin)}${this.theme.primary(line)}` : "",
				),
			];
		}
	}

	private renderUser(text: string, width: number): string[] {
		const glyph = boldText(this.theme.accent("›"));
		if (width < 6) {
			return [
				truncateToWidth(
					`${glyph} ${this.theme.primary(text.split(/\r\n|\r|\n/, 1)[0] ?? "")}`,
					width,
					"",
				),
			];
		}

		// One column of padding on each side, then "› " before the text.
		const contentWidth = width - 4;
		const lines = text ? wrapLiteralText(text, contentWidth) : [""];
		return [
			"",
			...renderCard(
				lines.map(
					(line, index) =>
						` ${index === 0 ? glyph : " "} ${this.theme.primary(line)}`,
				),
				width,
				this.theme,
			),
		];
	}
}

export interface ToolBlockOptions {
	readonly expanded?: boolean;
	readonly active?: boolean;
	readonly target?: string;
	readonly preview?: string;
	readonly edit?: TuiEditDetails;
	readonly isError?: boolean;
}

export class ToolBlock implements Component {
	private readonly group: ToolGroupBlock;

	constructor(
		private readonly toolName: string,
		theme: TuiTheme,
		options: ToolBlockOptions = {},
	) {
		this.group = new ToolGroupBlock(theme, [{ toolName, ...options }]);
		this.group.setExpanded(options.expanded ?? false);
	}

	setExpanded(expanded: boolean): void {
		this.group.setExpanded(expanded);
	}

	update(options: ToolBlockOptions): void {
		this.group.update([{ toolName: this.toolName, ...options }]);
	}

	invalidate(): void {
		this.group.invalidate();
	}

	render(width: number): string[] {
		return this.group.render(width);
	}
}

export interface ToolActivity extends ToolBlockOptions {
	readonly toolName: string;
}

export class ToolGroupBlock implements Component {
	private expanded = false;
	private tools: readonly ToolActivity[];

	constructor(
		private readonly theme: TuiTheme,
		tools: readonly ToolActivity[],
	) {
		this.tools = [...tools];
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	update(tools: readonly ToolActivity[]): void {
		this.tools = [...tools];
	}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = normalizeWidth(width);
		if (availableWidth === 0 || this.tools.length === 0) {
			return [];
		}

		const hidden = this.expanded
			? 0
			: Math.max(0, this.tools.length - MAX_COLLAPSED_TOOLS);
		const shown = hidden === 0 ? this.tools : this.tools.slice(hidden + 1);
		const rendered =
			hidden === 0
				? []
				: renderTagged(
						"",
						this.theme.subtle,
						() => [this.theme.subtle(`${hidden + 1} earlier tool calls`)],
						availableWidth,
					);

		for (const tool of shown) {
			rendered.push(...this.renderTool(tool, availableWidth));
			if (this.expanded) {
				rendered.push(...this.renderDetails(tool, availableWidth));
			}
		}
		return rendered;
	}

	private renderTool(tool: ToolActivity, width: number): string[] {
		const name =
			stripTerminalSequences(tool.toolName).split(/\r\n|\r|\n/, 1)[0] ?? "";
		const tag = tool.active === true ? `${spinnerFrame()} ${name}` : name;
		const tagStyle =
			tool.active === true
				? this.theme.accent
				: tool.isError === true
					? this.theme.error
					: this.theme.subtle;
		const target = sanitizePath(tool.target ?? tool.edit?.path ?? "");
		const meta = this.renderMeta(tool);
		return renderTagged(
			tag,
			tagStyle,
			(contentWidth) => {
				const metaWidth = visibleWidth(meta);
				const targetWidth = Math.max(
					0,
					contentWidth - (metaWidth > 0 ? metaWidth + 2 : 0),
				);
				const shortTarget = truncateToWidth(target, targetWidth, "…");
				const line =
					meta === ""
						? this.theme.primary(shortTarget)
						: `${this.theme.primary(shortTarget)}${shortTarget ? "  " : ""}${meta}`;
				return [truncateToWidth(line, contentWidth, "…")];
			},
			width,
		);
	}

	private renderMeta(tool: ToolActivity): string {
		if (tool.isError === true) {
			return this.theme.error("failed");
		}
		if (tool.edit === undefined) {
			return "";
		}
		const lines = formatEditDiff(tool.edit);
		const added = lines.filter((line) => line.kind === "added").length;
		const removed = lines.filter((line) => line.kind === "removed").length;
		return `${this.theme.diffAdded(`+${added}`)} ${this.theme.diffRemoved(`−${removed}`)}`;
	}

	private renderDetails(tool: ToolActivity, width: number): string[] {
		const cleanPreview =
			tool.preview === undefined
				? undefined
				: stripTerminalSequences(tool.preview);
		if (tool.edit === undefined && !cleanPreview) {
			return [];
		}
		const indent = gutterWidth(width);
		const detailWidth = Math.max(1, width - indent);
		const detailLines = limitPhysicalLines(
			tool.edit === undefined
				? wrapLiteralText(cleanPreview ?? "", detailWidth).map((text) => ({
						text,
						style: this.theme.muted,
					}))
				: wrapDiffLines(formatEditDiff(tool.edit), detailWidth, this.theme),
			detailWidth,
			this.theme,
		);
		const prefix = " ".repeat(indent);
		return detailLines.map((line) =>
			line.text
				? `${prefix}${line.style?.(line.text) ?? this.theme.primary(line.text)}`
				: "",
		);
	}
}

export interface ThinkingBlockOptions {
	readonly active?: boolean;
	readonly expanded?: boolean;
}

export class ThinkingBlock implements Component {
	private text: string;
	private active: boolean;
	private expanded: boolean;

	constructor(
		text: string,
		private readonly theme: TuiTheme,
		options: ThinkingBlockOptions = {},
	) {
		this.text = text;
		this.active = options.active ?? false;
		this.expanded = options.expanded ?? false;
	}

	setText(text: string): void {
		this.text = text;
	}

	setActive(active: boolean): void {
		this.active = active;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = normalizeWidth(width);
		if (availableWidth === 0) {
			return [];
		}
		const cleanText = stripThinkingMarkdown(stripTerminalSequences(this.text));
		if (cleanText.trim().length === 0) {
			return [];
		}

		const tag = this.active ? `${spinnerFrame()} think` : "think";
		const tagStyle = this.active ? this.theme.accent : this.theme.subtle;
		const style = (line: string) =>
			this.theme.markdown.italic(this.theme.muted(line));
		return renderTagged(
			tag,
			tagStyle,
			(contentWidth) => {
				if (this.expanded) {
					return wrapLiteralText(cleanText, contentWidth).map(style);
				}
				// Collapsed, show the latest paragraph on one line.
				const summaries = cleanText.split(/\n\s*\n/);
				const preview = (summaries.at(-1) ?? cleanText)
					.replace(/\s+/g, " ")
					.trim();
				return [style(truncateToWidth(preview, contentWidth, "…"))];
			},
			availableWidth,
		);
	}
}

// The smoke entry remains intentionally unchanged for this phase.
export { ToolBlock as CollapsedToolBlock };

// Seven-row pixel glyphs for the empty-state wordmark, drawn as a dot matrix
// like the website hero.
const WORDMARK_GLYPHS: readonly (readonly string[])[] = [
	[".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
	[".....", ".....", "#.##.", "##..#", "#....", "#....", "#...."],
	[".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
	[".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
	["#....", "#....", "####.", "#...#", "#...#", "#...#", "####."],
];

/** Empty-session welcome: the dot-matrix wordmark and the first steps. */
export class WelcomeBlock implements Component {
	constructor(
		private readonly theme: TuiTheme,
		private readonly getState: () => TuiState | undefined,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = normalizeWidth(width);
		if (availableWidth === 0) {
			return [];
		}
		const state = this.getState();
		const center = (line: string) => centerLine(line, availableWidth);
		const wordmark = renderWordmark(this.theme);
		const header =
			visibleWidth(wordmark[0] ?? "") + 4 <= availableWidth
				? wordmark.map(center)
				: [center(boldText(this.theme.primary("Areeb")))];
		const details =
			state === undefined
				? []
				: [
						center(
							[
								this.theme.muted(displayPath(state.cwd)),
								this.theme.muted(state.model),
								effortLabel(state.reasoning, this.theme),
							].join(this.theme.subtle(STATUS_SEPARATOR)),
						),
					];
		const tips = [
			["/login", "connect a provider"],
			["/model", "pick a model"],
			["@", "attach a file"],
		]
			.map(
				([key, label]) =>
					`${this.theme.accent(key ?? "")} ${this.theme.subtle(label ?? "")}`,
			)
			.join("    ");
		return [
			"",
			"",
			...header,
			"",
			center(this.theme.primary("A sharp mind for your codebase.")),
			...details,
			"",
			center(tips),
		];
	}
}

/** The reasoning level followed by a rising meter, like a signal indicator. */
export function effortLabel(level: ReasoningLevel, theme: TuiTheme): string {
	const bars = "▁▂▃▅▆█";
	const filled = Math.max(0, REASONING_LEVELS.indexOf(level));
	return `${theme.accent(level)} ${theme.accent(bars.slice(0, filled))}${theme.subtle(bars.slice(filled))}`;
}

export function displayPath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`)
		? `~${path.slice(home.length)}`
		: path;
}

/** Wrap lines in a filled card with half-block edges above and below. */
export function renderCard(
	lines: readonly string[],
	width: number,
	theme: TuiTheme,
): string[] {
	return [
		theme.surfaceEdge("▄".repeat(width)),
		...lines.map((line) => theme.surface(fitLine(line, width))),
		theme.surfaceEdge("▀".repeat(width)),
	];
}

export function fitLine(line: string, width: number): string {
	const fitted = truncateToWidth(line, width, "");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function renderWordmark(theme: TuiTheme): string[] {
	const lit = theme.primary("●");
	const unlit = theme.subtle("·");
	const rows = WORDMARK_GLYPHS[0]?.length ?? 0;
	return Array.from({ length: rows }, (_, row) =>
		WORDMARK_GLYPHS.map((glyph) =>
			Array.from(glyph[row] ?? "", (pixel) =>
				pixel === "#" ? lit : unlit,
			).join(" "),
		).join(` ${unlit} `),
	);
}

function centerLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) {
		return truncateToWidth(line, width, "…");
	}
	return `${" ".repeat(Math.floor((width - lineWidth) / 2))}${line}`;
}

function gutterWidth(width: number): number {
	return width >= GUTTER_WIDTH + MIN_GUTTER_CONTENT ? GUTTER_WIDTH : 0;
}

/** Render content beside a gutter tag; narrow widths drop the gutter. */
function renderTagged(
	tag: string,
	tagStyle: TuiTheme["primary"],
	renderContent: (contentWidth: number) => string[],
	width: number,
): string[] {
	const gutter = gutterWidth(width);
	if (gutter === 0) {
		// Too narrow for a gutter: keep the tag inline before the first line.
		const inline = tag ? `${tag} ` : "";
		const content = renderContent(Math.max(1, width - visibleWidth(inline)));
		return content.map((line, index) =>
			truncateToWidth(
				index === 0 && tag ? `${tagStyle(tag)} ${line}` : line,
				width,
				"…",
			),
		);
	}
	const content = renderContent(Math.max(1, width - gutter));
	const label = truncateToWidth(tag, TAG_WIDTH - 1, "…");
	const first = `${" ".repeat(INSET)}${tagStyle(label)}${" ".repeat(TAG_WIDTH - visibleWidth(label))}`;
	const blank = " ".repeat(GUTTER_WIDTH);
	return content.map((line, index) =>
		line
			? `${index === 0 ? first : blank}${line}`
			: index === 0
				? first.trimEnd()
				: "",
	);
}

function normalizeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function wrapLiteralText(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const logicalLine of text.split(/\r\n|\r|\n/)) {
		if (!logicalLine) {
			lines.push("");
			continue;
		}

		const fittedLines = wrapTextWithAnsi(logicalLine, width)
			.map((line) => truncateToWidth(line, width, ""))
			.filter((line) => visibleWidth(line) > 0);
		lines.push(...(fittedLines.length > 0 ? fittedLines : [""]));
	}
	return lines;
}

function trimTerminalLineEnd(line: string): string {
	const width = visibleWidth(stripTerminalSequences(line).trimEnd());
	return truncateToWidth(line, width, "");
}

interface StyledLine {
	readonly text: string;
	readonly style?: TuiTheme["primary"];
}

function wrapDiffLines(
	logicalLines: readonly DiffLine[],
	width: number,
	theme: TuiTheme,
): StyledLine[] {
	const lines: StyledLine[] = [];
	const numberWidth = logicalLines.reduce(
		(maximum, line) =>
			Math.max(maximum, line.lineNumber?.toString().length ?? 0),
		0,
	);
	const showNumbers = numberWidth > 0 && width > numberWidth + 2;
	const contentWidth = showNumbers ? width - numberWidth - 2 : width;
	for (const logicalLine of logicalLines) {
		const contentStyle = diffStyle(logicalLine.kind, theme);
		const lineStyle =
			logicalLine.kind === "added"
				? theme.diffAddedLine
				: logicalLine.kind === "removed"
					? theme.diffRemovedLine
					: undefined;
		const wrapped = wrapLiteralText(logicalLine.text, contentWidth);
		for (const [index, fragment] of wrapped.entries()) {
			const number =
				index === 0 && logicalLine.lineNumber !== undefined
					? logicalLine.lineNumber.toString().padStart(numberWidth, " ")
					: " ".repeat(numberWidth);
			const prefix = showNumbers ? `${number}  ` : "";
			const padding = " ".repeat(
				Math.max(0, width - visibleWidth(prefix) - visibleWidth(fragment)),
			);
			lines.push({
				text: `${prefix}${fragment}`,
				style: () => {
					const styled = `${theme.diffMeta(prefix)}${contentStyle(fragment)}`;
					return lineStyle === undefined
						? styled
						: lineStyle(`${styled}${padding}`);
				},
			});
		}
	}
	return lines;
}

type DiffLineKind = "hunk" | "added" | "removed" | "context" | "meta";

interface DiffLine {
	readonly kind: DiffLineKind;
	readonly text: string;
	readonly lineNumber?: number;
}

function formatEditDiff(edit: TuiEditDetails): DiffLine[] {
	const displayLines = formatDisplayDiff(stripTerminalSequences(edit.diff));
	return displayLines.length > 0
		? displayLines
		: formatUnifiedDiff(stripTerminalSequences(edit.patch));
}

function formatDisplayDiff(text: string): DiffLine[] {
	if (text.length === 0) {
		return [];
	}
	const lines: DiffLine[] = [];
	for (const line of text.split(/\r\n|\r|\n/)) {
		const match = /^([ +-])(\s*\d+) (.*)$/.exec(line);
		if (match === null) {
			lines.push({ kind: "meta", text: line.trimStart() });
			continue;
		}
		const marker = match[1];
		const lineNumber = Number(match[2]);
		const content = match[3] ?? "";
		if (marker === "+") {
			lines.push({ kind: "added", text: `+ ${content}`, lineNumber });
		} else if (marker === "-") {
			lines.push({ kind: "removed", text: `- ${content}`, lineNumber });
		} else {
			lines.push({ kind: "context", text: `  ${content}`, lineNumber });
		}
	}
	return lines;
}

function formatUnifiedDiff(text: string): DiffLine[] {
	const lines: DiffLine[] = [];
	let oldLine: number | undefined;
	let newLine: number | undefined;
	for (const line of text.split(/\r\n|\r|\n/)) {
		if (
			line.startsWith("diff ") ||
			line.startsWith("index ") ||
			line.startsWith("--- ")
		) {
			continue;
		}
		if (line.startsWith("+++ ")) {
			continue;
		}
		if (line.startsWith("@@")) {
			const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			if (hunk !== null) {
				oldLine = Number(hunk[1]);
				newLine = Number(hunk[2]);
			}
			lines.push({ kind: "hunk", text: line });
		} else if (line.startsWith("+")) {
			lines.push({
				kind: "added",
				text: `+ ${line.slice(1)}`,
				...(newLine === undefined ? {} : { lineNumber: newLine }),
			});
			if (newLine !== undefined) {
				newLine += 1;
			}
		} else if (line.startsWith("-")) {
			lines.push({
				kind: "removed",
				text: `- ${line.slice(1)}`,
				...(oldLine === undefined ? {} : { lineNumber: oldLine }),
			});
			if (oldLine !== undefined) {
				oldLine += 1;
			}
		} else if (line.startsWith(" ")) {
			lines.push({
				kind: "context",
				text: `  ${line.slice(1)}`,
				...(newLine === undefined ? {} : { lineNumber: newLine }),
			});
			if (oldLine !== undefined) {
				oldLine += 1;
			}
			if (newLine !== undefined) {
				newLine += 1;
			}
		} else {
			lines.push({ kind: "meta", text: line });
		}
	}
	return lines;
}

function sanitizePath(path: string): string {
	return stripTerminalSequences(path).replace(/\p{Cc}/gu, "�");
}

function diffStyle(kind: DiffLineKind, theme: TuiTheme): TuiTheme["primary"] {
	switch (kind) {
		case "hunk":
			return theme.diffHunk;
		case "added":
			return theme.diffAdded;
		case "removed":
			return theme.diffRemoved;
		case "context":
			return theme.diffContext;
		case "meta":
			return theme.diffMeta;
	}
}

function limitPhysicalLines(
	lines: StyledLine[],
	width: number,
	theme: TuiTheme,
): StyledLine[] {
	if (lines.length <= TOOL_PREVIEW_MAX_LINES) {
		return lines;
	}
	const headCount = Math.ceil((TOOL_PREVIEW_MAX_LINES - 1) / 2);
	const tailCount = TOOL_PREVIEW_MAX_LINES - headCount - 1;
	return [
		...lines.slice(0, headCount),
		{
			text: truncateToWidth(
				`… ${lines.length - headCount - tailCount} lines omitted …`,
				width,
				"",
			),
			style: theme.subtle,
		},
		...lines.slice(-tailCount),
	];
}

function normalizeMarkdownHeadings(markdown: string): string {
	const lines = markdown.split("\n");
	let fence: string | undefined;
	return lines
		.map((line) => {
			const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
			if (fenceMatch !== undefined) {
				if (fence === undefined) {
					fence = fenceMatch;
				} else if (
					fenceMatch[0] === fence[0] &&
					fenceMatch.length >= fence.length
				) {
					fence = undefined;
				}
				return line;
			}
			return fence === undefined
				? line.replace(/^(\s{0,3})#{3,6}(\s+)/, "$1##$2")
				: line;
		})
		.join("\n");
}

function stripThinkingMarkdown(text: string): string {
	return text
		.replaceAll("**", "")
		.replaceAll("__", "")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.trim();
}

function spinnerFrame(): string {
	const index =
		Math.floor(Date.now() / SPINNER_INTERVAL) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0] ?? "⠋";
}
