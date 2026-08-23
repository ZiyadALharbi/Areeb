import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";

export type TextStyle = (text: string) => string;

export const TUI_THEME_NAMES = Object.freeze([
	"areeb-dark",
	"areeb-light",
] as const);
export type TuiThemeName = (typeof TUI_THEME_NAMES)[number];

export interface TuiTheme {
	readonly name: TuiThemeName;
	readonly background: string;
	readonly primary: TextStyle;
	readonly muted: TextStyle;
	readonly user: TextStyle;
	readonly assistant: TextStyle;
	readonly tool: TextStyle;
	readonly error: TextStyle;
	readonly warning: TextStyle;
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

interface ThemePalette {
	readonly primary: `#${string}`;
	readonly muted: `#${string}`;
	readonly user: `#${string}`;
	readonly assistant: `#${string}`;
	readonly tool: `#${string}`;
	readonly error: `#${string}`;
	readonly warning: `#${string}`;
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
		assistant: foreground(palette.assistant),
		tool: foreground(palette.tool),
		error: foreground(palette.error),
		warning: foreground(palette.warning),
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
	};

	return Object.freeze({
		name,
		background,
		primary: styles.primary,
		muted: styles.muted,
		user: styles.user,
		assistant: styles.assistant,
		tool: styles.tool,
		error: styles.error,
		warning: styles.warning,
		composerBorder: styles.composerBorder,
		shortcut: styles.shortcut,
		diffAdded: styles.diffAdded,
		diffRemoved: styles.diffRemoved,
		diffContext: styles.diffContext,
		diffHunk: styles.diffHunk,
		diffMeta: styles.diffMeta,
		markdown: Object.freeze({
			heading: styles.heading,
			link: styles.link,
			linkUrl: styles.muted,
			code: styles.code,
			codeBlock: styles.primary,
			codeBlockBorder: styles.muted,
			quote: styles.quote,
			quoteBorder: styles.muted,
			hr: styles.muted,
			listBullet: styles.assistant,
			bold,
			italic,
			strikethrough,
			underline,
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

export const AREEB_DARK_THEME = createTheme("areeb-dark", "#141414", {
	primary: "#e1e1e1",
	muted: "#6c6c6c",
	user: "#c8c8c8",
	assistant: "#bb9af7",
	tool: "#787878",
	error: "#f7768e",
	warning: "#e0af68",
	composerBorder: "#505058",
	shortcut: "#6c6c6c",
	heading: "#bb9af7",
	link: "#7aa2f7",
	code: "#e0af68",
	quote: "#9aa5ce",
	diffAdded: "#9ece6a",
	diffRemoved: "#f7768e",
	diffContext: "#a9b1d6",
	diffHunk: "#7aa2f7",
	diffMeta: "#787878",
});

export const AREEB_LIGHT_THEME = createTheme("areeb-light", "#f7f7f5", {
	primary: "#242424",
	muted: "#767676",
	user: "#444444",
	assistant: "#6f42c1",
	tool: "#666666",
	error: "#c62828",
	warning: "#9a6700",
	composerBorder: "#b8b8b8",
	shortcut: "#6f6f6f",
	heading: "#6f42c1",
	link: "#0969da",
	code: "#9a6700",
	quote: "#57606a",
	diffAdded: "#16794a",
	diffRemoved: "#c43543",
	diffContext: "#5f6368",
	diffHunk: "#6f42c1",
	diffMeta: "#6b7280",
});

const THEMES: Readonly<Record<TuiThemeName, TuiTheme>> = Object.freeze({
	"areeb-dark": AREEB_DARK_THEME,
	"areeb-light": AREEB_LIGHT_THEME,
});

export function isTuiThemeName(value: unknown): value is TuiThemeName {
	return value === "areeb-dark" || value === "areeb-light";
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
		assistant: bind((theme) => theme.assistant),
		tool: bind((theme) => theme.tool),
		error: bind((theme) => theme.error),
		warning: bind((theme) => theme.warning),
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
			bold,
			italic,
			strikethrough,
			underline,
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
