import {
	type Component,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TuiTheme } from "./theme.ts";

const MESSAGE_GLYPH = "│";
const TOOL_GLYPH = "◆";
const NORMAL_INSET = 2;

export type MessageBlockKind = "user" | "assistant" | "error";

export class MessageBlock implements Component {
	constructor(
		private readonly kind: MessageBlockKind,
		private readonly text: string,
		private readonly theme: TuiTheme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = normalizeWidth(width);
		if (availableWidth === 0) {
			return [];
		}

		const rail = this.theme[this.kind](MESSAGE_GLYPH);
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

		return wrapLiteralText(cleanText, contentWidth).map((line) =>
			line ? `${prefix}${this.theme.primary(line)}` : rail,
		);
	}
}

export class CollapsedToolBlock implements Component {
	constructor(
		private readonly toolName: string,
		private readonly theme: TuiTheme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = normalizeWidth(width);
		if (availableWidth === 0) {
			return [];
		}

		const glyph = this.theme.tool(TOOL_GLYPH);
		const cleanName =
			stripTerminalSequences(this.toolName).split(/\r\n|\r|\n/, 1)[0] ?? "";
		if (!cleanName) {
			return [glyph];
		}

		const inset = Math.min(
			NORMAL_INSET,
			Math.max(0, availableWidth - visibleWidth(TOOL_GLYPH) - 1),
		);
		const contentWidth = availableWidth - visibleWidth(TOOL_GLYPH) - inset;
		if (contentWidth <= 0) {
			return [glyph];
		}

		const name = truncateToWidth(cleanName, contentWidth, "");
		return [
			name ? `${glyph}${" ".repeat(inset)}${this.theme.primary(name)}` : glyph,
		];
	}
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
