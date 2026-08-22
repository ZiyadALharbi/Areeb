import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";

export type TextStyle = (text: string) => string;

export interface TuiTheme {
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
	readonly markdown: MarkdownTheme;
	readonly editor: EditorTheme;
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

const primary = foreground("#e1e1e1");
const muted = foreground("#6c6c6c");
const user = foreground("#c8c8c8");
const assistant = foreground("#bb9af7");
const tool = foreground("#787878");
const error = foreground("#f7768e");
const warning = foreground("#e0af68");
const composerBorder = foreground("#505058");
const shortcut = foreground("#6c6c6c");
const heading = foreground("#bb9af7");
const link = foreground("#7aa2f7");
const code = foreground("#e0af68");
const quote = foreground("#9aa5ce");
const bold = decoration(1, 22);
const italic = decoration(3, 23);
const strikethrough = decoration(9, 29);
const underline = decoration(4, 24);

export const AREEB_DARK_THEME: TuiTheme = {
	background: "#141414",
	primary,
	muted,
	user,
	assistant,
	tool,
	error,
	warning,
	composerBorder,
	shortcut,
	markdown: {
		heading,
		link,
		linkUrl: muted,
		code,
		codeBlock: primary,
		codeBlockBorder: muted,
		quote,
		quoteBorder: muted,
		hr: muted,
		listBullet: assistant,
		bold,
		italic,
		strikethrough,
		underline,
		codeBlockIndent: "  ",
	},
	editor: {
		borderColor: composerBorder,
		selectList: {
			selectedPrefix: assistant,
			selectedText: primary,
			description: muted,
			scrollInfo: muted,
			noMatch: error,
		},
	},
};
