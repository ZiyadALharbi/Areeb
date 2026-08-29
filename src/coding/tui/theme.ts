import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";
import {
	type Theme as HighlightTheme,
	highlight,
	supportsLanguage,
} from "cli-highlight";

export type TextStyle = (text: string) => string;

export const TUI_THEME_NAMES = Object.freeze(["areeb-dark"] as const);
export type TuiThemeName = (typeof TUI_THEME_NAMES)[number];

export interface TuiTheme {
	readonly name: TuiThemeName;
	readonly background: string;
	readonly primary: TextStyle;
	readonly muted: TextStyle;
	readonly user: TextStyle;
	readonly userBorder: TextStyle;
	readonly assistant: TextStyle;
	readonly tool: TextStyle;
	readonly error: TextStyle;
	readonly warning: TextStyle;
	readonly success: TextStyle;
	readonly composerBorder: TextStyle;
	readonly shortcut: TextStyle;
	readonly diffAdded: TextStyle;
	readonly diffRemoved: TextStyle;
	readonly diffContext: TextStyle;
	readonly diffHunk: TextStyle;
	readonly diffMeta: TextStyle;
	readonly markdown: MarkdownTheme;
	readonly editor: EditorTheme;
}

export interface TuiThemeBinding extends TuiTheme {
	setTheme(theme: TuiTheme): void;
}

function foreground(hex: `#${string}`): TextStyle {
	const value = Number.parseInt(hex.slice(1), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	const open = `\u001b[38;2;${red};${green};${blue}m`;

	return (text) => (text ? `${open}${text}\u001b[39m` : "");
}

function decoration(open: number, close: number): TextStyle {
	return (text) => (text ? `\u001b[${open}m${text}\u001b[${close}m` : "");
}

const bold = decoration(1, 22);
const italic = decoration(3, 23);
const strikethrough = decoration(9, 29);
const underline = decoration(4, 24);
const PLAIN_TEXT_LANGUAGES = new Set(["text", "plaintext", "txt", "output"]);
// ANSI foreground escapes must be removed before applying a semantic Markdown color.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC starts every ANSI sequence.
const FOREGROUND_SEQUENCE = /\x1b\[(?:38;2;\d{1,3};\d{1,3};\d{1,3}|39)m/g;

function withoutForeground(text: string): string {
	return text.replace(FOREGROUND_SEQUENCE, "");
}

interface ThemePalette {
	readonly primary: `#${string}`;
	readonly muted: `#${string}`;
	readonly user: `#${string}`;
	readonly userBorder: `#${string}`;
	readonly assistant: `#${string}`;
	readonly tool: `#${string}`;
	readonly error: `#${string}`;
	readonly warning: `#${string}`;
	readonly success: `#${string}`;
	readonly composerBorder: `#${string}`;
	readonly shortcut: `#${string}`;
	readonly heading: `#${string}`;
	readonly link: `#${string}`;
	readonly code: `#${string}`;
	readonly quote: `#${string}`;
	readonly diffAdded: `#${string}`;
	readonly diffRemoved: `#${string}`;
	readonly diffContext: `#${string}`;
	readonly diffHunk: `#${string}`;
	readonly diffMeta: `#${string}`;
	readonly syntaxPlain: `#${string}`;
	readonly syntaxKeyword: `#${string}`;
	readonly syntaxType: `#${string}`;
	readonly syntaxNumber: `#${string}`;
	readonly syntaxString: `#${string}`;
	readonly syntaxComment: `#${string}`;
	readonly syntaxFunction: `#${string}`;
	readonly syntaxVariable: `#${string}`;
	readonly syntaxAddition: `#${string}`;
	readonly syntaxDeletion: `#${string}`;
}

function createTheme(
	name: TuiThemeName,
	background: `#${string}`,
	palette: ThemePalette,
): TuiTheme {
	const styles = {
		primary: foreground(palette.primary),
		muted: foreground(palette.muted),
		user: foreground(palette.user),
		userBorder: foreground(palette.userBorder),
		assistant: foreground(palette.assistant),
		tool: foreground(palette.tool),
		error: foreground(palette.error),
		warning: foreground(palette.warning),
		success: foreground(palette.success),
		composerBorder: foreground(palette.composerBorder),
		shortcut: foreground(palette.shortcut),
		heading: foreground(palette.heading),
		link: foreground(palette.link),
		code: foreground(palette.code),
		quote: foreground(palette.quote),
		diffAdded: foreground(palette.diffAdded),
		diffRemoved: foreground(palette.diffRemoved),
		diffContext: foreground(palette.diffContext),
		diffHunk: foreground(palette.diffHunk),
		diffMeta: foreground(palette.diffMeta),
		syntaxPlain: foreground(palette.syntaxPlain),
		syntaxKeyword: foreground(palette.syntaxKeyword),
		syntaxType: foreground(palette.syntaxType),
		syntaxNumber: foreground(palette.syntaxNumber),
		syntaxString: foreground(palette.syntaxString),
		syntaxComment: foreground(palette.syntaxComment),
		syntaxFunction: foreground(palette.syntaxFunction),
		syntaxVariable: foreground(palette.syntaxVariable),
		syntaxAddition: foreground(palette.syntaxAddition),
		syntaxDeletion: foreground(palette.syntaxDeletion),
	};
	const markdownHeading = (text: string) =>
		styles.heading(withoutForeground(text));
	const markdownBold = (text: string) =>
		styles.code(bold(withoutForeground(text)));
	const highlightTheme: HighlightTheme = {
		default: styles.syntaxPlain,
		keyword: styles.syntaxKeyword,
		built_in: styles.syntaxType,
		type: styles.syntaxType,
		class: styles.syntaxType,
		literal: styles.syntaxNumber,
		number: styles.syntaxNumber,
		string: styles.syntaxString,
		regexp: styles.syntaxString,
		subst: styles.syntaxVariable,
		symbol: styles.syntaxString,
		comment: styles.syntaxComment,
		doctag: styles.syntaxComment,
		function: styles.syntaxFunction,
		title: styles.syntaxFunction,
		name: styles.syntaxFunction,
		"builtin-name": styles.syntaxFunction,
		attr: styles.syntaxVariable,
		attribute: styles.syntaxVariable,
		variable: styles.syntaxVariable,
		params: styles.syntaxVariable,
		meta: styles.syntaxKeyword,
		"meta-keyword": styles.syntaxKeyword,
		"meta-string": styles.syntaxString,
		section: styles.heading,
		tag: styles.syntaxKeyword,
		bullet: styles.syntaxKeyword,
		code: styles.syntaxPlain,
		emphasis: styles.syntaxPlain,
		strong: styles.syntaxPlain,
		formula: styles.syntaxNumber,
		link: styles.syntaxVariable,
		quote: styles.syntaxPlain,
		"selector-tag": styles.syntaxKeyword,
		"selector-id": styles.syntaxFunction,
		"selector-class": styles.syntaxVariable,
		"selector-attr": styles.syntaxType,
		"selector-pseudo": styles.syntaxKeyword,
		"template-tag": styles.syntaxKeyword,
		"template-variable": styles.syntaxVariable,
		addition: styles.syntaxAddition,
		deletion: styles.syntaxDeletion,
	};

	return Object.freeze({
		name,
		background,
		primary: styles.primary,
		muted: styles.muted,
		user: styles.user,
		userBorder: styles.userBorder,
		assistant: styles.assistant,
		tool: styles.tool,
		error: styles.error,
		warning: styles.warning,
		success: styles.success,
		composerBorder: styles.composerBorder,
		shortcut: styles.shortcut,
		diffAdded: styles.diffAdded,
		diffRemoved: styles.diffRemoved,
		diffContext: styles.diffContext,
		diffHunk: styles.diffHunk,
		diffMeta: styles.diffMeta,
		markdown: Object.freeze({
			heading: markdownHeading,
			link: styles.link,
			linkUrl: styles.muted,
			code: styles.code,
			codeBlock: styles.primary,
			codeBlockBorder: styles.muted,
			quote: styles.quote,
			quoteBorder: styles.muted,
			hr: styles.muted,
			listBullet: styles.assistant,
			bold: markdownBold,
			italic,
			strikethrough,
			underline,
			highlightCode: (code: string, language?: string) => {
				if (!language || PLAIN_TEXT_LANGUAGES.has(language.toLowerCase())) {
					return code.split("\n").map(styles.primary);
				}
				if (!supportsLanguage(language)) {
					return code.split("\n").map(styles.syntaxPlain);
				}
				try {
					return highlight(code, {
						language,
						ignoreIllegals: true,
						theme: highlightTheme,
					}).split("\n");
				} catch {
					return code.split("\n").map(styles.syntaxPlain);
				}
			},
			codeBlockIndent: "  ",
		}),
		editor: Object.freeze({
			borderColor: styles.composerBorder,
			selectList: Object.freeze({
				selectedPrefix: styles.assistant,
				selectedText: styles.primary,
				description: styles.muted,
				scrollInfo: styles.muted,
				noMatch: styles.error,
			}),
		}),
	});
}

export const AREEB_DARK_THEME = createTheme("areeb-dark", "#0a0a0a", {
	primary: "#f5f5f5",
	muted: "#707070",
	user: "#f1c674",
	userBorder: "#39765e",
	assistant: "#8abeb7",
	tool: "#707070",
	error: "#fc424b",
	warning: "#f1c674",
	success: "#00bd7d",
	composerBorder: "#4b4b4b",
	shortcut: "#707070",
	heading: "#f1c674",
	link: "#8abeb7",
	code: "#b6bd68",
	quote: "#8abeb7",
	diffAdded: "#00bd7d",
	diffRemoved: "#fc424b",
	diffContext: "#c0c0c0",
	diffHunk: "#8abeb7",
	diffMeta: "#707070",
	syntaxPlain: "#e6d5b8",
	syntaxKeyword: "#4d9eff",
	syntaxType: "#e6a15a",
	syntaxNumber: "#ffd166",
	syntaxString: "#e07a5f",
	syntaxComment: "#707070",
	syntaxFunction: "#ef5b5b",
	syntaxVariable: "#8bb8e8",
	syntaxAddition: "#8bb8e8",
	syntaxDeletion: "#ef5b5b",
});

const THEMES: Readonly<Record<TuiThemeName, TuiTheme>> = Object.freeze({
	"areeb-dark": AREEB_DARK_THEME,
});

export function isTuiThemeName(value: unknown): value is TuiThemeName {
	return value === "areeb-dark";
}

export function getTuiTheme(name: string): TuiTheme | undefined {
	return isTuiThemeName(name) ? THEMES[name] : undefined;
}

export function listTuiThemes(): readonly TuiTheme[] {
	return TUI_THEME_NAMES.map((name) => THEMES[name]);
}

/** Keep callbacks captured by Pi components bound to the current palette. */
export function createTuiThemeBinding(initial: TuiTheme): TuiThemeBinding {
	let current = initial;
	const bind =
		(getStyle: (theme: TuiTheme) => TextStyle): TextStyle =>
		(text) =>
			getStyle(current)(text);

	return {
		get name() {
			return current.name;
		},
		get background() {
			return current.background;
		},
		primary: bind((theme) => theme.primary),
		muted: bind((theme) => theme.muted),
		user: bind((theme) => theme.user),
		userBorder: bind((theme) => theme.userBorder),
		assistant: bind((theme) => theme.assistant),
		tool: bind((theme) => theme.tool),
		error: bind((theme) => theme.error),
		warning: bind((theme) => theme.warning),
		success: bind((theme) => theme.success),
		composerBorder: bind((theme) => theme.composerBorder),
		shortcut: bind((theme) => theme.shortcut),
		diffAdded: bind((theme) => theme.diffAdded),
		diffRemoved: bind((theme) => theme.diffRemoved),
		diffContext: bind((theme) => theme.diffContext),
		diffHunk: bind((theme) => theme.diffHunk),
		diffMeta: bind((theme) => theme.diffMeta),
		markdown: {
			heading: bind((theme) => theme.markdown.heading),
			link: bind((theme) => theme.markdown.link),
			linkUrl: bind((theme) => theme.markdown.linkUrl),
			code: bind((theme) => theme.markdown.code),
			codeBlock: bind((theme) => theme.markdown.codeBlock),
			codeBlockBorder: bind((theme) => theme.markdown.codeBlockBorder),
			quote: bind((theme) => theme.markdown.quote),
			quoteBorder: bind((theme) => theme.markdown.quoteBorder),
			hr: bind((theme) => theme.markdown.hr),
			listBullet: bind((theme) => theme.markdown.listBullet),
			bold: bind((theme) => theme.markdown.bold),
			italic,
			strikethrough,
			underline,
			highlightCode: (code, language) =>
				current.markdown.highlightCode?.(code, language) ?? code.split("\n"),
			codeBlockIndent: "  ",
		},
		editor: {
			borderColor: bind((theme) => theme.editor.borderColor),
			selectList: {
				selectedPrefix: bind((theme) => theme.editor.selectList.selectedPrefix),
				selectedText: bind((theme) => theme.editor.selectList.selectedText),
				description: bind((theme) => theme.editor.selectList.description),
				scrollInfo: bind((theme) => theme.editor.selectList.scrollInfo),
				noMatch: bind((theme) => theme.editor.selectList.noMatch),
			},
		},
		setTheme(theme) {
			current = theme;
		},
	};
}
