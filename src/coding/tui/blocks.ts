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

		const style =
			this.kind === "status" ? this.theme.muted : this.theme[this.kind];
		const rail = style(MESSAGE_GLYPH);
		const cleanText = stripTerminalSequences(this.text);
		if (!cleanText) {
			return [rail];
		}

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
		if (this.kind === "assistant") {
			try {
				this.markdown.setText(cleanText);
				const markdownLines = this.markdown.render(contentWidth);
				if (markdownLines.length === 0) {
					return [rail];
				}
				return markdownLines.flatMap((line) =>
					wrapTextWithAnsi(line, contentWidth).map((wrapped) => {
						const trimmed = trimTerminalLineEnd(wrapped);
						return visibleWidth(trimmed) > 0 ? `${prefix}${trimmed}` : rail;
					}),
				);
			} catch {
				// Streaming can temporarily expose malformed Markdown. Literal text is
				// always safe and keeps the transcript usable until the next update.
			}
		}
		return wrapLiteralText(cleanText, contentWidth).map((line) =>
			line ? `${prefix}${contentStyle(line)}` : rail,
		);
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

	constructor(
		private readonly toolName: string,
		private readonly theme: TuiTheme,
		private readonly options: ToolBlockOptions = {},
	) {
		this.expanded = options.expanded ?? false;
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

		const accent = this.options.isError ? this.theme.error : this.theme.tool;
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
		const detail = this.options.patch ?? this.options.preview;
		if (!this.expanded || !detail || contentWidth <= 0) {
			return [header];
		}

		const cleanDetail = stripTerminalSequences(detail);
		const detailLines = limitPhysicalLines(
			wrapLiteralText(cleanDetail, contentWidth),
			contentWidth,
		);
		const prefix = " ".repeat(visibleWidth(TOOL_GLYPH) + inset);
		return [
			header,
			...detailLines.map((line) =>
				line ? `${prefix}${this.theme.primary(line)}` : "",
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

function limitPhysicalLines(lines: string[], width: number): string[] {
	if (lines.length <= TOOL_PREVIEW_MAX_LINES) {
		return lines;
	}
	const headCount = Math.ceil((TOOL_PREVIEW_MAX_LINES - 1) / 2);
	const tailCount = TOOL_PREVIEW_MAX_LINES - headCount - 1;
	return [
		...lines.slice(0, headCount),
		truncateToWidth(
			`… ${lines.length - headCount - tailCount} lines omitted …`,
			width,
			"",
		),
		...lines.slice(-tailCount),
	];
}
