import type { EditorTheme } from "@earendil-works/pi-tui";

export type TextStyle = (text: string) => string;

export interface TuiTheme {
	readonly background: string;
	readonly primary: TextStyle;
	readonly muted: TextStyle;
	readonly user: TextStyle;
	readonly assistant: TextStyle;
	readonly tool: TextStyle;
	readonly error: TextStyle;
	readonly composerBorder: TextStyle;
	readonly shortcut: TextStyle;
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

const primary = foreground("#e1e1e1");
const muted = foreground("#6c6c6c");
const user = foreground("#c8c8c8");
const assistant = foreground("#bb9af7");
const tool = foreground("#787878");
const error = foreground("#f7768e");
const composerBorder = foreground("#505058");
const shortcut = foreground("#6c6c6c");

export const AREEB_DARK_THEME: TuiTheme = {
	background: "#141414",
	primary,
	muted,
	user,
	assistant,
	tool,
	error,
	composerBorder,
	shortcut,
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
