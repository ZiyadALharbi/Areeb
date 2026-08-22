import {
	type Component,
	Editor,
	ScrollView,
	type Terminal,
	TruncatedText,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import type { TuiTheme } from "./theme.ts";

export interface CreateTuiAppOptions {
	readonly terminal: Terminal;
	readonly theme: TuiTheme;
	readonly transcript: readonly Component[];
	readonly shortcuts: string;
}

export interface TuiApp {
	readonly tui: TuiAltScreen;
	readonly editor: Editor;
}

export function createTuiApp(options: CreateTuiAppOptions): TuiApp {
	const tui = new TuiAltScreen(options.terminal, true, undefined, {
		mouse: false,
	});
	const transcript = new VStack([...options.transcript], { gap: 1 });
	const scrollView = new ScrollView(transcript, {
		follow: "end",
		primary: true,
		scrollbar: "hidden",
	});
	const editor = new Editor(tui, options.theme.editor, { paddingX: 1 });
	editor.disableSubmit = true;
	const shortcuts = new TruncatedText(
		options.theme.shortcut(options.shortcuts),
	);
	const root = new VStack(
		[
			{
				component: scrollView,
				basis: 0,
				grow: 1,
				minSize: 1,
			},
			{ component: editor, basis: "auto" },
			{
				component: shortcuts,
				basis: 1,
				minSize: 1,
				maxSize: 1,
			},
		],
		{ gap: 0 },
	);

	tui.setLayoutRoot(root);
	tui.setFocus(editor);

	return { tui, editor };
}
