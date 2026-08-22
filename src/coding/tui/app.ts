import {
	type Component,
	Editor,
	type OverlayHandle,
	ScrollView,
	stripTerminalSequences,
	type Terminal,
	Text,
	TruncatedText,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { MessageBlock, ToolBlock } from "./blocks.ts";
import type { ChatItem, TuiState } from "./state.ts";
import type { TuiTheme } from "./theme.ts";

const NOTICE_DURATION_MS = 4_000;
const COMMAND_OVERLAY_MAX_LINES = 24;
const COMMAND_OVERLAY_MAX_CHARACTERS = 8 * 1024;

export type CommandNoticeLevel = "info" | "warning" | "error";

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
	presentCommand(text: string, level: CommandNoticeLevel): void;
	clearCommandPresentation(): void;
	dismissCommandOverlay(): boolean;
	toggleToolPreviews(): void;
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
	let currentSessionId = currentState?.sessionId;
	let streamingBlock: MessageBlock | undefined;
	let commandOverlay: OverlayHandle | undefined;
	let notice:
		| { readonly text: string; readonly level: CommandNoticeLevel }
		| undefined;
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	const expandedToolCallIds = new Set<string>();
	const blocksByItem = new WeakMap<object, Component>();

	const renderStatus = (): void => {
		status.clear();
		if (notice !== undefined) {
			const style =
				notice.level === "error"
					? options.theme.error
					: notice.level === "warning"
						? options.theme.warning
						: options.theme.muted;
			status.addChild(new TruncatedText(style(notice.text)));
		}
		if (currentState !== undefined) {
			status.addChild(
				new TruncatedText(
					options.theme.muted(
						`${currentState.model} · ${currentState.cwd} · ${currentState.sessionId} · ${currentState.running ? "running" : "idle"}`,
					),
				),
			);
		}
	};

	const dismissCommandOverlay = (): boolean => {
		if (commandOverlay === undefined) {
			return false;
		}
		commandOverlay.hide();
		commandOverlay = undefined;
		tui.setFocus(editor);
		tui.requestRender();
		return true;
	};

	const clearCommandPresentation = (): void => {
		if (noticeTimer !== undefined) {
			clearTimeout(noticeTimer);
			noticeTimer = undefined;
		}
		notice = undefined;
		dismissCommandOverlay();
		renderStatus();
		tui.requestRender();
	};

	const presentCommand = (text: string, level: CommandNoticeLevel): void => {
		clearCommandPresentation();
		const cleanText = stripTerminalSequences(text).replace(/\r\n|\r/g, "\n");
		if (!cleanText.includes("\n")) {
			notice = { text: cleanText, level };
			renderStatus();
			const currentNotice = notice;
			noticeTimer = setTimeout(() => {
				if (notice !== currentNotice) {
					return;
				}
				notice = undefined;
				noticeTimer = undefined;
				renderStatus();
				tui.requestRender();
			}, NOTICE_DURATION_MS);
			tui.requestRender();
			return;
		}

		const style =
			level === "error"
				? options.theme.error
				: level === "warning"
					? options.theme.warning
					: options.theme.primary;
		commandOverlay = tui.showOverlay(
			new Text(style(boundCommandText(cleanText)), 1, 1),
			{
				width: "80%",
				maxHeight: "70%",
				margin: 2,
			},
		);
		tui.requestRender();
	};

	const refresh = (state = currentState): void => {
		if (state === undefined) {
			tui.requestRender();
			return;
		}
		if (
			currentSessionId !== undefined &&
			currentSessionId !== state.sessionId
		) {
			clearCommandPresentation();
			expandedToolCallIds.clear();
		}
		currentState = state;
		currentSessionId = state.sessionId;
		transcript.clear();
		for (const item of state.items) {
			let block = blocksByItem.get(item);
			if (block === undefined) {
				block = createChatItemBlock(item, options.theme);
				blocksByItem.set(item, block);
			}
			if (item.role === "tool" && block instanceof ToolBlock) {
				block.setExpanded(expandedToolCallIds.has(item.toolCallId));
			}
			transcript.addChild(block);
		}
		if (
			state.assistantBuffer !== undefined &&
			state.assistantBuffer.trim().length > 0
		) {
			streamingBlock ??= new MessageBlock(
				"assistant",
				state.assistantBuffer,
				options.theme,
			);
			streamingBlock.setText(state.assistantBuffer);
			transcript.addChild(streamingBlock);
		}

		renderStatus();
		editor.disableSubmit = state.running;
		tui.requestRender();
	};

	const toggleToolPreviews = (): void => {
		if (currentState === undefined) {
			return;
		}
		const toolCallIds = currentState.items.flatMap((item) =>
			item.role === "tool" ? [item.toolCallId] : [],
		);
		if (toolCallIds.length === 0) {
			return;
		}
		const expand = toolCallIds.some(
			(toolCallId) => !expandedToolCallIds.has(toolCallId),
		);
		expandedToolCallIds.clear();
		if (expand) {
			for (const toolCallId of toolCallIds) {
				expandedToolCallIds.add(toolCallId);
			}
		}
		refresh(currentState);
	};

	if (currentState !== undefined) {
		refresh(currentState);
	}

	return {
		tui,
		editor,
		refresh,
		presentCommand,
		clearCommandPresentation,
		dismissCommandOverlay,
		toggleToolPreviews,
	};
}

function createChatItemBlock(item: ChatItem, theme: TuiTheme): Component {
	switch (item.role) {
		case "user":
		case "assistant":
		case "status":
		case "error":
			return new MessageBlock(item.role, item.text, theme);
		case "tool":
			return new ToolBlock(item.toolName, theme, {
				preview: item.preview,
				patch: item.patch,
				isError: item.isError,
			});
	}
}

function boundCommandText(text: string): string {
	const characters = Array.from(text);
	const characterBounded =
		characters.length <= COMMAND_OVERLAY_MAX_CHARACTERS
			? text
			: `${characters
					.slice(0, COMMAND_OVERLAY_MAX_CHARACTERS / 2)
					.join("")}\n… output omitted …\n${characters
					.slice(-COMMAND_OVERLAY_MAX_CHARACTERS / 2)
					.join("")}`;
	const lines = characterBounded.split("\n");
	if (lines.length <= COMMAND_OVERLAY_MAX_LINES) {
		return characterBounded;
	}
	const headCount = Math.ceil((COMMAND_OVERLAY_MAX_LINES - 1) / 2);
	const tailCount = COMMAND_OVERLAY_MAX_LINES - headCount - 1;
	return [
		...lines.slice(0, headCount),
		`… ${lines.length - headCount - tailCount} lines omitted …`,
		...lines.slice(-tailCount),
	].join("\n");
}
