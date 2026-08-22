import {
	type Component,
	Editor,
	ScrollView,
	type Terminal,
	TruncatedText,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { CollapsedToolBlock, MessageBlock } from "./blocks.ts";
import type { ChatItem, TuiState } from "./state.ts";
import type { TuiTheme } from "./theme.ts";

export interface CreateTuiAppOptions {
	readonly terminal: Terminal;
	readonly theme: TuiTheme;
	readonly transcript: readonly Component[];
	readonly shortcuts: string;
	readonly state?: TuiState;
}

export interface TuiApp {
	readonly tui: TuiAltScreen;
	readonly editor: Editor;
	refresh(state?: TuiState): void;
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
	editor.disableSubmit = options.state?.running ?? true;
	const status = new VStack();
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
			{ component: status, basis: "auto" },
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
	let currentState = options.state;

	const refresh = (state = currentState): void => {
		if (state === undefined) {
			tui.requestRender();
			return;
		}
		currentState = state;
		transcript.clear();
		for (const item of state.items) {
			transcript.addChild(createChatItemBlock(item, options.theme));
		}
		if (
			state.assistantBuffer !== undefined &&
			state.assistantBuffer.trim().length > 0
		) {
			transcript.addChild(
				new MessageBlock("assistant", state.assistantBuffer, options.theme),
			);
		}

		status.clear();
		status.addChild(
			new TruncatedText(
				options.theme.muted(
					`${state.model} · ${state.cwd} · ${state.sessionId} · ${state.running ? "running" : "idle"}`,
				),
			),
		);
		editor.disableSubmit = state.running;
		tui.requestRender();
	};

	if (currentState !== undefined) {
		refresh(currentState);
	}

	return { tui, editor, refresh };
}

function createChatItemBlock(item: ChatItem, theme: TuiTheme): Component {
	switch (item.role) {
		case "user":
		case "assistant":
		case "status":
		case "error":
			return new MessageBlock(item.role, item.text, theme);
		case "tool":
			return new CollapsedToolBlock(item.toolName, theme);
	}
}
