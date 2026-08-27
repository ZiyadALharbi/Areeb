import {
	type Component,
	Markdown,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TuiEditDetails } from "./state.ts";
import type { TuiTheme } from "./theme.ts";

const MESSAGE_GLYPH = "│";
const NORMAL_INSET = 2;
const ASSISTANT_MARGIN = 1;
const USER_PADDING = 2;
const TOOL_PREVIEW_MAX_LINES = 16;
const DETAIL_INSET = 2;
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

		const style = this.kind === "status" ? this.theme.muted : this.theme.error;
		const rail = style(MESSAGE_GLYPH);
		const inset = Math.min(
			NORMAL_INSET,
			Math.max(0, availableWidth - visibleWidth(MESSAGE_GLYPH) - 1),
		);
		const prefix = `${rail}${" ".repeat(inset)}`;
		const contentWidth = availableWidth - visibleWidth(MESSAGE_GLYPH) - inset;
		if (contentWidth <= 0) {
			return [rail];
		}

		const contentStyle =
			this.kind === "status" ? this.theme.muted : this.theme.primary;
		return wrapLiteralText(cleanText, contentWidth).map((line) =>
			line ? `${prefix}${contentStyle(line)}` : rail,
		);
	}

	private renderAssistant(text: string, width: number): string[] {
		if (!text) {
			return [""];
		}
		const margin = contentMargin(width);
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
		const glyph = this.theme.user("›");
		if (width < 4) {
			if (width === 1 || !text) {
				return [glyph];
			}
			const separator = width === 3 ? " " : "";
			return [
				`${glyph}${separator}${this.theme.primary(truncateToWidth(text, 1, ""))}`,
			];
		}

		const innerWidth = width - 2;
		const padding = Math.min(
			USER_PADDING,
			Math.max(0, Math.floor((innerWidth - 1) / 2)),
		);
		const contentWidth = Math.max(1, innerWidth - padding * 2);
		const body = this.renderUserBody(text, contentWidth, glyph);

		return [
			this.theme.userBorder(`╭${"─".repeat(innerWidth)}╮`),
			...body.map(
				(line) =>
					`${this.theme.userBorder("│")}${" ".repeat(padding)}${fitLine(line, contentWidth)}${" ".repeat(padding)}${this.theme.userBorder("│")}`,
			),
			this.theme.userBorder(`╰${"─".repeat(innerWidth)}╯`),
		];
	}

	private renderUserBody(text: string, width: number, glyph: string): string[] {
		if (width === 1 || !text) {
			return [glyph];
		}
		const prefix = `${glyph} `;
		const indent = " ".repeat(visibleWidth(prefix));
		const lines = wrapLiteralText(
			text,
			Math.max(1, width - visibleWidth(prefix)),
		);
		return lines.map((line, index) => {
			if (line.length === 0) {
				return index === 0 ? prefix.trimEnd() : "";
			}
			return `${index === 0 ? prefix : indent}${this.theme.primary(line)}`;
		});
	}
}

export interface ToolBlockOptions {
	readonly expanded?: boolean;
	readonly active?: boolean;
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

		const header = renderToolHeader(this.tools, availableWidth, this.theme);
		const rendered = [header];
		if (!this.expanded) {
			return rendered;
		}

		const detailPrefixWidth = Math.min(
			DETAIL_INSET * 2,
			Math.max(0, availableWidth - 1),
		);
		const detailWidth = Math.max(1, availableWidth - detailPrefixWidth);
		for (const [index, tool] of this.tools.entries()) {
			const branch = index === this.tools.length - 1 ? "└" : "├";
			const cleanName =
				stripTerminalSequences(tool.toolName).split(/\r\n|\r|\n/, 1)[0] ?? "";
			if (tool.edit === undefined) {
				rendered.push(
					truncateToWidth(
						`${" ".repeat(DETAIL_INSET)}${this.theme.tool(branch)} ${this.theme.primary(cleanName)}`,
						availableWidth,
						"…",
					),
				);
			} else {
				const path = sanitizePath(tool.edit.path);
				rendered.push(
					truncateToWidth(
						`${" ".repeat(contentMargin(availableWidth))}${this.theme.tool("◆")} ${this.theme.primary("Edit")} ${this.theme.warning(path)}`,
						availableWidth,
						"…",
					),
					"",
				);
			}
			const cleanPreview =
				tool.preview === undefined
					? undefined
					: stripTerminalSequences(tool.preview);
			if (tool.edit === undefined && !cleanPreview) {
				continue;
			}
			const detailLines = limitPhysicalLines(
				tool.edit === undefined
					? wrapLiteralText(cleanPreview ?? "", detailWidth).map((text) => ({
							text,
						}))
					: wrapDiffLines(formatEditDiff(tool.edit), detailWidth, this.theme),
				detailWidth,
			);
			const prefix = " ".repeat(detailPrefixWidth);
			for (const line of detailLines) {
				rendered.push(
					line.text
						? `${prefix}${line.style?.(line.text) ?? this.theme.primary(line.text)}`
						: "",
				);
			}
		}
		return rendered;
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

		const header = renderThinkingHeader(
			cleanText,
			this.active,
			this.expanded,
			availableWidth,
			this.theme,
		);
		const rendered = [header];
		if (!this.expanded) {
			return rendered;
		}

		const contentInset = Math.min(
			DETAIL_INSET,
			Math.max(0, availableWidth - 1),
		);
		const contentWidth = Math.max(1, availableWidth - contentInset);
		return [
			...rendered,
			...wrapLiteralText(cleanText, contentWidth).map((line) =>
				line
					? `${" ".repeat(contentInset)}${this.theme.markdown.italic(this.theme.muted(line))}`
					: "",
			),
		];
	}
}

// The smoke entry remains intentionally unchanged for this phase.
export { ToolBlock as CollapsedToolBlock };

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

function fitLine(line: string, width: number): string {
	const fitted = truncateToWidth(line, width, "");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
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
		const numberStyle =
			logicalLine.kind === "added"
				? theme.diffAdded
				: logicalLine.kind === "removed"
					? theme.diffRemoved
					: theme.diffMeta;
		const wrapped = wrapLiteralText(logicalLine.text, contentWidth);
		for (const [index, fragment] of wrapped.entries()) {
			const number =
				index === 0 && logicalLine.lineNumber !== undefined
					? logicalLine.lineNumber.toString().padStart(numberWidth, " ")
					: " ".repeat(numberWidth);
			const prefix = showNumbers ? `${number}  ` : "";
			lines.push({
				text: `${prefix}${fragment}`,
				style: () => `${numberStyle(prefix)}${contentStyle(fragment)}`,
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

function limitPhysicalLines(lines: StyledLine[], width: number): StyledLine[] {
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

function contentMargin(width: number): number {
	return width > ASSISTANT_MARGIN * 2 ? ASSISTANT_MARGIN : 0;
}

function spinnerFrame(): string {
	const index =
		Math.floor(Date.now() / SPINNER_INTERVAL) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0] ?? "⠋";
}

function renderToolHeader(
	tools: readonly ToolActivity[],
	width: number,
	theme: TuiTheme,
): string {
	const active = tools.some((tool) => tool.active === true);
	const failed = tools.some((tool) => tool.isError === true);
	const incomplete = tools.some((tool) => tool.isError === undefined);
	const count = tools.length;
	const noun = `command${count === 1 ? "" : "s"}`;
	const prefix = " ".repeat(contentMargin(width));
	if (active) {
		return truncateToWidth(
			`${prefix}${theme.assistant(spinnerFrame())} ${theme.assistant(`running ${count} ${noun}`)}`,
			width,
			"…",
		);
	}

	const summary = theme.primary(`Ran ${count} ${noun}`);
	const status = failed
		? `${theme.muted(STATUS_SEPARATOR)}${theme.error("failed")}`
		: incomplete
			? ""
			: `${theme.muted(STATUS_SEPARATOR)}${theme.success("success")}`;
	return truncateToWidth(`${prefix}${summary}${status}`, width, "…");
}

function renderThinkingHeader(
	text: string,
	active: boolean,
	expanded: boolean,
	width: number,
	theme: TuiTheme,
): string {
	const prefix = " ".repeat(contentMargin(width));
	const marker = active ? `${theme.assistant(spinnerFrame())} ` : "";
	const label = active ? "Thinking..." : "Thought";
	const leading = `${prefix}${marker}${theme.assistant(label)}`;
	if (expanded || visibleWidth(leading) >= width) {
		return truncateToWidth(leading, width, "…");
	}

	const previewWidth =
		width - visibleWidth(leading) - visibleWidth(STATUS_SEPARATOR);
	if (previewWidth <= 0) {
		return leading;
	}
	const summaries = text.split(/\n\s*\n/);
	const previewText = (summaries.at(-1) ?? text).replace(/\s+/g, " ").trim();
	const preview = truncateToWidth(previewText, previewWidth, "…");
	return `${leading}${theme.muted(`${STATUS_SEPARATOR}${preview}`)}`;
}
