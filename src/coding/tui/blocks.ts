import {
	type Component,
	Markdown,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TuiTheme } from "./theme.ts";

const MESSAGE_GLYPH = "│";
const TOOL_GLYPH = "◆";
const NORMAL_INSET = 2;
const TOOL_PREVIEW_MAX_LINES = 16;

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
		this.markdown = new Markdown("", 0, 0, theme.markdown, {
			color: theme.primary,
		});
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
		try {
			this.markdown.setText(text);
			const markdownLines = this.markdown.render(width);
			if (markdownLines.length === 0) {
				return [""];
			}
			return markdownLines.flatMap((line) =>
				wrapTextWithAnsi(line, width).map(trimTerminalLineEnd),
			);
		} catch {
			// Streaming can temporarily expose malformed Markdown. Literal text is
			// always safe and keeps the transcript usable until the next update.
			return wrapLiteralText(text, width).map((line) =>
				this.theme.primary(line),
			);
		}
	}

	private renderUser(text: string, width: number): string[] {
		const glyph = this.theme.user("›");
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
	readonly preview?: string;
	readonly patch?: string;
	readonly isError?: boolean;
}

export class ToolBlock implements Component {
	private expanded: boolean;
	private preview?: string;
	private patch?: string;
	private isError?: boolean;

	constructor(
		private readonly toolName: string,
		private readonly theme: TuiTheme,
		options: ToolBlockOptions = {},
	) {
		this.expanded = options.expanded ?? false;
		this.preview = options.preview;
		this.patch = options.patch;
		this.isError = options.isError;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	update(options: ToolBlockOptions): void {
		this.preview = options.preview;
		this.patch = options.patch;
		this.isError = options.isError;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = normalizeWidth(width);
		if (availableWidth === 0) {
			return [];
		}

		const accent = this.isError ? this.theme.error : this.theme.tool;
		const glyph = accent(TOOL_GLYPH);
		const cleanName =
			stripTerminalSequences(this.toolName).split(/\r\n|\r|\n/, 1)[0] ?? "";

		const inset = Math.min(
			NORMAL_INSET,
			Math.max(0, availableWidth - visibleWidth(TOOL_GLYPH) - 1),
		);
		const contentWidth = availableWidth - visibleWidth(TOOL_GLYPH) - inset;
		const name =
			contentWidth > 0 ? truncateToWidth(cleanName, contentWidth, "") : "";
		const header = name
			? `${glyph}${" ".repeat(inset)}${this.theme.primary(name)}`
			: glyph;
		const detail = this.patch ?? this.preview;
		if (!this.expanded || !detail || contentWidth <= 0) {
			return [header];
		}

		const cleanDetail = stripTerminalSequences(detail);
		const detailLines = limitPhysicalLines(
			this.patch === undefined
				? wrapLiteralText(cleanDetail, contentWidth).map((text) => ({ text }))
				: wrapDiffText(cleanDetail, contentWidth, this.theme),
			contentWidth,
		);
		const prefix = " ".repeat(visibleWidth(TOOL_GLYPH) + inset);
		return [
			header,
			...detailLines.map((line) =>
				line.text
					? `${prefix}${line.style?.(line.text) ?? this.theme.primary(line.text)}`
					: "",
			),
		];
	}
}

export class ThinkingBlock implements Component {
	private text: string;

	constructor(
		text: string,
		private readonly theme: TuiTheme,
	) {
		this.text = text;
	}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = normalizeWidth(width);
		if (availableWidth === 0) {
			return [];
		}
		const cleanText = stripTerminalSequences(this.text);
		if (cleanText.trim().length === 0) {
			return [];
		}

		const label = "Thinking";
		const separator = " · ";
		const prefixWidth = visibleWidth(label) + visibleWidth(separator);
		if (availableWidth <= prefixWidth) {
			return [truncateToWidth(this.theme.assistant(label), availableWidth, "")];
		}

		const contentWidth = availableWidth - prefixWidth;
		const lines = wrapLiteralText(cleanText, contentWidth);
		const prefix = `${this.theme.assistant(label)}${this.theme.muted(separator)}`;
		const indent = " ".repeat(prefixWidth);
		return lines.map((line, index) => {
			const body = this.theme.markdown.italic(this.theme.muted(line));
			return `${index === 0 ? prefix : indent}${body}`;
		});
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

interface StyledLine {
	readonly text: string;
	readonly style?: TuiTheme["primary"];
}

function wrapDiffText(
	text: string,
	width: number,
	theme: TuiTheme,
): StyledLine[] {
	const lines: StyledLine[] = [];
	for (const logicalLine of text.split(/\r\n|\r|\n/)) {
		const style = diffStyle(logicalLine, theme);
		const wrapped = wrapLiteralText(logicalLine, width);
		lines.push(...wrapped.map((fragment) => ({ text: fragment, style })));
	}
	return lines;
}

function diffStyle(line: string, theme: TuiTheme): TuiTheme["primary"] {
	if (line.startsWith("@@")) {
		return theme.diffHunk;
	}
	if (
		line.startsWith("---") ||
		line.startsWith("+++") ||
		line.startsWith("diff ") ||
		line.startsWith("index ") ||
		line.startsWith("\\ No newline") ||
		line.includes("output omitted") ||
		line.includes("lines omitted")
	) {
		return theme.diffMeta;
	}
	if (line.startsWith("+")) {
		return theme.diffAdded;
	}
	if (line.startsWith("-")) {
		return theme.diffRemoved;
	}
	return line.startsWith(" ") ? theme.diffContext : theme.primary;
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
