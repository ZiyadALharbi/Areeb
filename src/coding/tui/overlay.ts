import {
	type Component,
	Container,
	type Focusable,
	isFocusable,
	Key,
	matchesKey,
	type OverlayOptions,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { CommandNoticeLevel } from "./app.ts";
import { boldText, type TuiTheme } from "./theme.ts";

export const STANDARD_OVERLAY_OPTIONS: OverlayOptions = Object.freeze({
	width: 84,
	maxHeight: "86%",
	anchor: "center",
	margin: 1,
});

export interface OverlayFrameOptions {
	readonly title: string;
	readonly subtitle?: string;
	readonly maxHeight: () => number;
	readonly scrollable?: boolean;
	readonly stickToEnd?: boolean;
	readonly scrollWithArrows?: boolean;
}

/** Shared visual and focus boundary for every centered TUI overlay. */
export class OverlayFrame extends Container implements Focusable {
	private _focused = false;
	private scrollOffset = 0;
	private userScrolled = false;
	private bodyCapacity = 1;
	private bodyLineCount = 0;

	constructor(
		private readonly content: Component,
		private readonly options: OverlayFrameOptions,
		private readonly theme: TuiTheme,
	) {
		super();
		this.addChild(content);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (isFocusable(this.content)) {
			this.content.focused = value;
		}
	}

	override render(width: number): string[] {
		const availableWidth = normalizeDimension(width);
		const maxHeight = normalizeDimension(this.options.maxHeight());
		if (availableWidth < 4 || maxHeight < 3) {
			return this.content
				.render(availableWidth)
				.slice(0, Math.max(1, maxHeight));
		}

		const horizontalPadding = availableWidth >= 10 ? 2 : 1;
		const contentWidth = Math.max(
			1,
			availableWidth - 2 - horizontalPadding * 2,
		);
		const body = this.content.render(contentWidth);
		this.bodyLineCount = body.length;
		const insideBudget = Math.max(1, maxHeight - 2);
		const prefix = this.renderPrefix(contentWidth, insideBudget);
		let suffix: string[] = insideBudget - prefix.length >= 3 ? [""] : [];
		let capacity = Math.max(1, insideBudget - prefix.length - suffix.length);
		const overflow = body.length > capacity;

		if (overflow && this.options.scrollable === true) {
			const scrollHint = this.theme.muted(
				this.options.scrollWithArrows === false
					? "PgUp/PgDn scroll"
					: "Up/Down scroll",
			);
			suffix =
				insideBudget - prefix.length >= 3 ? ["", scrollHint] : [scrollHint];
			capacity = Math.max(1, insideBudget - prefix.length - suffix.length);
		} else if (overflow) {
			suffix = [];
			capacity = Math.max(1, insideBudget - prefix.length);
		}
		this.bodyCapacity = capacity;

		const maxOffset = Math.max(0, body.length - capacity);
		if (this.options.stickToEnd === true && !this.userScrolled) {
			this.scrollOffset = maxOffset;
		} else {
			this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		}
		const visibleBody = body.slice(
			this.options.scrollable === true ? this.scrollOffset : 0,
			(this.options.scrollable === true ? this.scrollOffset : 0) + capacity,
		);
		if (visibleBody.length === 0) {
			visibleBody.push("");
		}

		const framed = [...prefix, ...visibleBody, ...suffix].slice(
			0,
			insideBudget,
		);
		return [
			this.renderTopBorder(availableWidth),
			...framed.map((line) =>
				this.renderContentLine(line, horizontalPadding, contentWidth),
			),
			this.theme.composerBorder(`╰${"─".repeat(availableWidth - 2)}╯`),
		];
	}

	handleInput(data: string): void {
		if (this.options.scrollable === true && this.handleScrollInput(data)) {
			return;
		}
		this.content.handleInput?.(data);
	}

	private handleScrollInput(data: string): boolean {
		const arrowKeys = this.options.scrollWithArrows !== false;
		const maxOffset = Math.max(0, this.bodyLineCount - this.bodyCapacity);
		let nextOffset = this.scrollOffset;
		if (arrowKeys && matchesKey(data, Key.up)) {
			nextOffset -= 1;
		} else if (arrowKeys && matchesKey(data, Key.down)) {
			nextOffset += 1;
		} else if (matchesKey(data, Key.pageUp)) {
			nextOffset -= this.bodyCapacity;
		} else if (matchesKey(data, Key.pageDown)) {
			nextOffset += this.bodyCapacity;
		} else if (matchesKey(data, Key.home)) {
			nextOffset = 0;
		} else if (matchesKey(data, Key.end)) {
			nextOffset = maxOffset;
		} else {
			return false;
		}
		this.userScrolled = true;
		this.scrollOffset = Math.max(0, Math.min(nextOffset, maxOffset));
		return true;
	}

	private renderPrefix(contentWidth: number, insideBudget: number): string[] {
		if (this.options.subtitle === undefined || insideBudget < 3) {
			return insideBudget >= 2 ? [""] : [];
		}
		const subtitle = stripTerminalSequences(this.options.subtitle).replace(
			/[\t\r\n]+/g,
			" ",
		);
		const wrapped = wrapTextWithAnsi(
			this.theme.muted(subtitle),
			contentWidth,
		).slice(0, Math.max(1, Math.min(2, insideBudget - 2)));
		return insideBudget >= 6 ? [...wrapped, ""] : wrapped;
	}

	private renderTopBorder(width: number): string {
		if (width < 7) {
			return this.theme.composerBorder(`╭${"─".repeat(width - 2)}╮`);
		}
		const title = truncateToWidth(
			stripTerminalSequences(this.options.title).replace(/[\t\r\n]+/g, " "),
			width - 6,
			"",
		);
		const fill = "─".repeat(width - 5 - visibleWidth(title));
		return `${this.theme.composerBorder("╭─ ")}${boldText(
			this.theme.assistant(title),
		)}${this.theme.composerBorder(` ${fill}╮`)}`;
	}

	private renderContentLine(
		line: string,
		horizontalPadding: number,
		contentWidth: number,
	): string {
		const fitted = truncateToWidth(line, contentWidth, "");
		const trailing = " ".repeat(
			Math.max(0, contentWidth - visibleWidth(fitted)),
		);
		return `${this.theme.composerBorder("│")}${" ".repeat(horizontalPadding)}${fitted}${trailing}${" ".repeat(horizontalPadding)}${this.theme.composerBorder("│")}`;
	}
}

/** Styled, width-aware command output used inside the shared overlay frame. */
export class CommandOverlayContent implements Component {
	private readonly lines: readonly string[];

	constructor(
		text: string,
		private readonly level: CommandNoticeLevel,
		private readonly theme: TuiTheme,
		title: string,
	) {
		const lines = stripTerminalSequences(text).split(/\r\n|\r|\n/);
		this.lines = headingMatches(lines[0], title) ? lines.slice(1) : lines;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = normalizeDimension(width);
		if (availableWidth === 0) {
			return [];
		}
		const labelWidth = Math.min(
			24,
			this.lines.reduce((widest, line) => {
				const match = fieldLine(line);
				return match?.value
					? Math.max(widest, visibleWidth(match.label))
					: widest;
			}, 0),
		);
		const rowWidth = Math.min(
			32,
			this.lines.reduce((widest, line) => {
				const match = choiceLine(line);
				return match === undefined
					? widest
					: Math.max(widest, visibleWidth(match.leading));
			}, 0),
		);
		let warningSection = false;
		const output: string[] = [];
		for (const line of this.lines) {
			if (line.length === 0) {
				output.push("");
				continue;
			}
			const field = fieldLine(line);
			if (field !== undefined && field.value.length === 0) {
				warningSection = field.label.toLocaleLowerCase() === "warnings";
				output.push(boldText(this.theme.assistant(`${field.label}:`)));
				continue;
			}
			if (field !== undefined && labelWidth > 0) {
				output.push(
					...this.renderField(
						field.label,
						field.value,
						labelWidth,
						availableWidth,
					),
				);
				continue;
			}
			const choice = choiceLine(line);
			if (choice !== undefined) {
				output.push(
					...this.renderChoice(
						choice.leading,
						choice.description,
						rowWidth,
						availableWidth,
					),
				);
				continue;
			}
			if (line.startsWith("- ")) {
				const body = line.slice(2);
				const fragments = wrapTextWithAnsi(
					body,
					Math.max(1, availableWidth - 2),
				);
				output.push(
					...fragments.map(
						(fragment, index) =>
							`${index === 0 ? this.theme.warning("• ") : "  "}${warningSection ? this.theme.warning(fragment) : this.theme.primary(fragment)}`,
					),
				);
				continue;
			}
			const style =
				this.level === "error"
					? this.theme.error
					: warningSection
						? this.theme.warning
						: this.theme.primary;
			output.push(...wrapTextWithAnsi(style(line), availableWidth));
		}
		return output;
	}

	private renderField(
		label: string,
		value: string,
		labelWidth: number,
		width: number,
	): string[] {
		if (width <= labelWidth + 6) {
			return wrapTextWithAnsi(
				`${this.theme.muted(`${label}:`)} ${this.theme.primary(value)}`,
				width,
			);
		}
		const valueWidth = width - labelWidth - 2;
		const fragments = wrapTextWithAnsi(value, valueWidth);
		const prefix = `${this.theme.muted(label.padEnd(labelWidth))}  `;
		const indent = " ".repeat(labelWidth + 2);
		return fragments.map(
			(fragment, index) =>
				`${index === 0 ? prefix : indent}${this.theme.primary(fragment)}`,
		);
	}

	private renderChoice(
		leading: string,
		description: string,
		rowWidth: number,
		width: number,
	): string[] {
		if (width <= 32 || rowWidth + 4 >= width) {
			return wrapTextWithAnsi(
				`${boldText(this.theme.assistant(leading))}${this.theme.muted(" — ")}${this.theme.primary(description)}`,
				width,
			);
		}
		const descriptionWidth = width - rowWidth - 2;
		const fragments = wrapTextWithAnsi(description, descriptionWidth);
		const prefix = `${boldText(
			this.theme.assistant(leading.padEnd(rowWidth)),
		)}  `;
		const indent = " ".repeat(rowWidth + 2);
		return fragments.map(
			(fragment, index) =>
				`${index === 0 ? prefix : indent}${this.theme.primary(fragment)}`,
		);
	}
}

export function overlayMaxHeight(terminalRows: number): number {
	const rows = normalizeDimension(terminalRows);
	return Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.86)));
}

export function overlayListRows(terminalRows: number, maximum: number): number {
	return Math.max(1, Math.min(maximum, overlayMaxHeight(terminalRows) - 7));
}

function normalizeDimension(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function headingMatches(line: string | undefined, title: string): boolean {
	if (line === undefined) {
		return false;
	}
	const normalize = (value: string): string =>
		value.trim().replace(/[:.]$/, "").toLocaleLowerCase();
	return normalize(line) === normalize(title);
}

function fieldLine(
	line: string,
): { readonly label: string; readonly value: string } | undefined {
	const match = /^([^:]{1,28}):(?:\s+(.*)|\s*)$/.exec(line);
	if (match?.[1] === undefined) {
		return undefined;
	}
	return { label: match[1], value: match[2] ?? "" };
}

function choiceLine(
	line: string,
): { readonly leading: string; readonly description: string } | undefined {
	const match = /^(.+?)\s+—\s+(.+)$/.exec(line);
	return match?.[1] === undefined || match[2] === undefined
		? undefined
		: { leading: match[1], description: match[2] };
}
