import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Component,
	decodeKittyPrintable,
	Editor,
	Key,
	matchesKey,
	type OverlayHandle,
	type AutocompleteItem as PiAutocompleteItem,
	ScrollView,
	SelectList,
	stripTerminalSequences,
	type Terminal,
	Text,
	TruncatedText,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import type { AuthPrompt, AuthType } from "../../ai/auth.ts";
import type {
	CommandModelListItem,
	CommandSessionListItem,
} from "../commands.ts";
import type { ProviderAuthView } from "../provider-runtime.ts";
import {
	buildCompletionState,
	type CompletionCatalog,
	type CompletionItem,
} from "./autocomplete.ts";
import { MessageBlock, ToolBlock } from "./blocks.ts";
import {
	AuthDialog,
	ProviderPicker,
	type ProviderPickerMode,
} from "./provider-auth.ts";
import type { ChatItem, TuiState } from "./state.ts";
import {
	createTuiThemeBinding,
	type TuiTheme,
	type TuiThemeName,
} from "./theme.ts";

const NOTICE_DURATION_MS = 4_000;
const COMMAND_OVERLAY_MAX_LINES = 24;
const COMMAND_OVERLAY_MAX_CHARACTERS = 8 * 1024;

export type CommandNoticeLevel = "info" | "warning" | "error";

export interface TuiShortcutSet {
	readonly idle: string;
	readonly menu: string;
	readonly running: string;
}

export interface CreateTuiAppOptions {
	readonly terminal: Terminal;
	readonly theme: TuiTheme;
	readonly transcript: readonly Component[];
	readonly shortcuts: TuiShortcutSet;
	readonly getCompletionCatalog: () => CompletionCatalog;
	readonly listSessions: () => Promise<readonly CommandSessionListItem[]>;
	readonly getModels: () => readonly CommandModelListItem[];
	readonly getCurrentModel: () => CommandModelListItem;
	readonly onResume: (sessionId: string) => Promise<boolean>;
	readonly onSetModel: (provider: string, model: string) => Promise<boolean>;
	readonly themes?: readonly TuiTheme[];
	readonly onSetTheme?: (theme: TuiThemeName) => Promise<void>;
	readonly onCopySelection?: (text: string) => Promise<boolean>;
	readonly state?: TuiState;
}

export interface TuiApp {
	readonly tui: TuiAltScreen;
	readonly editor: Editor;
	refresh(state?: TuiState): void;
	presentCommand(text: string, level: CommandNoticeLevel): void;
	clearCommandPresentation(): void;
	dismissCommandOverlay(): boolean;
	openCommandPalette(): boolean;
	dismissCommandPalette(): boolean;
	openSessionPicker(): Promise<boolean>;
	openModelPicker(): boolean;
	openThemePicker(): boolean;
	setTheme(name: string): Promise<boolean>;
	dismissPicker(): boolean;
	dismissInlineCompletion(): boolean;
	acceptInlineCompletion(): boolean;
	toggleToolPreviews(): void;
	openProviderPicker?(
		mode: ProviderPickerMode,
		providers: readonly ProviderAuthView[],
		onSelect: (provider: ProviderAuthView) => Promise<boolean>,
	): boolean;
	beginAuthDialog?(options: {
		readonly title: string;
		readonly subtitle: string;
		readonly authType: AuthType;
		readonly onCancel: () => void;
		readonly onCopyUrl?: (url: string) => void;
	}): void;
	setAuthUrl?(url: string): void;
	setAuthStatus?(status: string | undefined): void;
	requestAuthInput?(prompt: AuthPrompt): Promise<string>;
	cancelAuthDialog?(): boolean;
	closeAuthDialog?(): void;
}

export function createTuiApp(options: CreateTuiAppOptions): TuiApp {
	const theme = createTuiThemeBinding(options.theme);
	let activeTheme = options.theme;
	const themes = options.themes ?? [options.theme];
	const copySelection = options.onCopySelection;
	const tui = new TuiAltScreen(options.terminal, true, undefined, {
		mouse: true,
		...(copySelection === undefined
			? {}
			: {
					copySelection: async (text: string) => {
						try {
							return await copySelection(text);
						} catch {
							return false;
						}
					},
				}),
	});
	const initialTranscript = [...options.transcript];
	const transcript = new VStack(initialTranscript, { gap: 1 });
	const mountedTranscript = [...initialTranscript];
	const scrollView = new ScrollView(transcript, {
		follow: "end",
		primary: true,
		scrollbar: "hidden",
	});
	const editor = new Editor(tui, theme.editor, { paddingX: 1 });
	editor.setAutocompleteProvider(
		createAutocompleteProvider(options.getCompletionCatalog),
	);
	editor.disableSubmit = options.state?.inputMode === "locked";
	const status = new VStack();
	const shortcutLine = new VStack();
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
				component: shortcutLine,
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
	let selectorOverlay: OverlayHandle | undefined;
	let selectorKind:
		| "palette"
		| "session"
		| "model"
		| "theme"
		| "provider"
		| undefined;
	let authOverlay: OverlayHandle | undefined;
	let authDialog: AuthDialog | undefined;
	let selectorGeneration = 0;
	let selectionActive = false;
	let themePickerOrigin: TuiTheme | undefined;
	let notice:
		| { readonly text: string; readonly level: CommandNoticeLevel }
		| undefined;
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	const expandedToolCallIds = new Set<string>();
	let blocksByItem = new WeakMap<object, Component>();
	const toolBlocksById = new Map<string, ToolBlock>();

	const renderShortcuts = (): void => {
		const text =
			authOverlay !== undefined || selectorOverlay !== undefined
				? options.shortcuts.menu
				: currentState?.running === true ||
						currentState?.inputMode === "running"
					? options.shortcuts.running
					: options.shortcuts.idle;
		shortcutLine.clear();
		shortcutLine.addChild(new TruncatedText(theme.shortcut(text)));
	};

	const renderStatus = (): void => {
		status.clear();
		if (notice !== undefined) {
			const style =
				notice.level === "error"
					? theme.error
					: notice.level === "warning"
						? theme.warning
						: theme.muted;
			status.addChild(new TruncatedText(style(notice.text)));
		}
		if (currentState !== undefined) {
			const queue = currentState.running
				? ` · queued ${currentState.queuedCount}`
				: "";
			status.addChild(
				new TruncatedText(
					theme.muted(
						`${currentState.model} · ${currentState.cwd} · ${currentState.sessionId} · ${currentState.running ? "running" : currentState.inputMode}${queue}${formatLastUsage(currentState)}`,
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

	const dismissSelector = (kind: "palette" | "picker"): boolean => {
		if (
			selectorKind === undefined ||
			(kind === "palette"
				? selectorKind !== "palette"
				: selectorKind === "palette")
		) {
			return false;
		}
		if (selectorKind === "theme" && themePickerOrigin !== undefined) {
			applyVisualTheme(themePickerOrigin);
			themePickerOrigin = undefined;
		}
		selectorGeneration += 1;
		selectorOverlay?.hide();
		selectorOverlay = undefined;
		selectorKind = undefined;
		selectionActive = false;
		tui.setFocus(editor);
		renderShortcuts();
		tui.requestRender();
		return true;
	};

	const dismissCommandPalette = (): boolean => dismissSelector("palette");
	const dismissPicker = (): boolean => dismissSelector("picker");

	const beginSelector = (
		kind: "palette" | "session" | "model" | "theme" | "provider",
	): number => {
		if (selectorKind === "theme" && themePickerOrigin !== undefined) {
			applyVisualTheme(themePickerOrigin);
			themePickerOrigin = undefined;
		}
		selectorGeneration += 1;
		selectorOverlay?.hide();
		selectorOverlay = undefined;
		selectorKind = kind;
		selectionActive = false;
		tui.setFocus(editor);
		renderShortcuts();
		return selectorGeneration;
	};

	const closeAuthDialog = (): void => {
		authDialog?.close();
		authDialog = undefined;
		authOverlay?.hide();
		authOverlay = undefined;
		tui.setFocus(editor);
		renderShortcuts();
		tui.requestRender();
	};

	const cancelAuthDialog = (): boolean => {
		if (authDialog === undefined) {
			return false;
		}
		const dialog = authDialog;
		dialog.cancel();
		closeAuthDialog();
		return true;
	};

	const beginAuthDialog = (dialogOptions: {
		readonly title: string;
		readonly subtitle: string;
		readonly authType: AuthType;
		readonly onCancel: () => void;
		readonly onCopyUrl?: (url: string) => void;
	}): void => {
		dismissCommandPalette();
		dismissPicker();
		dismissCommandOverlay();
		closeAuthDialog();
		authDialog = new AuthDialog(dialogOptions, theme);
		authOverlay = tui.showOverlay(authDialog, {
			width: "80%",
			maxHeight: "85%",
			margin: 2,
		});
		authOverlay.focus();
		renderShortcuts();
		tui.requestRender();
	};

	const setAuthUrl = (url: string): void => {
		if (authDialog === undefined) {
			throw new Error("Auth dialog is not open");
		}
		authDialog.setUrl(url);
		tui.requestRender();
	};

	const setAuthStatus = (statusText: string | undefined): void => {
		if (authDialog === undefined) {
			return;
		}
		authDialog.setStatus(statusText);
		tui.requestRender();
	};

	const requestAuthInput = (prompt: AuthPrompt): Promise<string> => {
		if (authDialog === undefined) {
			return Promise.reject(new Error("Auth dialog is not open"));
		}
		const result = authDialog.requestInput(prompt);
		authOverlay?.focus();
		tui.requestRender();
		return result;
	};

	const dismissInlineCompletion = (): boolean => {
		if (!editor.isShowingAutocomplete()) {
			return false;
		}
		editor.handleInput("\u001b");
		tui.requestRender();
		return true;
	};

	const acceptInlineCompletion = (): boolean => {
		if (!editor.isShowingAutocomplete()) {
			return false;
		}
		const before = editor.getText();
		editor.handleInput("\t");
		const changed = editor.getText() !== before;
		if (changed) {
			tui.requestRender();
		}
		return changed;
	};

	const openCommandPalette = (): boolean => {
		if (currentState?.running === true) {
			return false;
		}
		if (selectorKind === "palette" && selectorOverlay !== undefined) {
			selectorOverlay.focus();
			return true;
		}
		dismissInlineCompletion();
		dismissCommandOverlay();
		beginSelector("palette");

		const catalog = options.getCompletionCatalog();
		const completion = buildCompletionState({
			...catalog,
			lines: ["/"],
			cursorLine: 0,
			cursorCol: 1,
		});
		if (completion === null || completion.items.length === 0) {
			selectorKind = undefined;
			renderShortcuts();
			return false;
		}

		const list = new FilterableSelectList(
			completion.items.map(toSelectItem),
			12,
			theme,
		);
		list.onCancel = () => {
			dismissCommandPalette();
		};
		list.onSelect = (item) => {
			dismissCommandPalette();
			applyPaletteSelection(editor, item.value);
			tui.requestRender();
		};
		selectorOverlay = tui.showOverlay(list, {
			width: "80%",
			maxHeight: "70%",
			margin: 2,
		});
		selectorOverlay.focus();
		renderShortcuts();
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
				? theme.error
				: level === "warning"
					? theme.warning
					: theme.primary;
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

	const showPicker = (
		kind: "session" | "model" | "theme",
		generation: number,
		items: PiAutocompleteItem[],
		onSelect: (value: string) => Promise<boolean>,
		selectedIndex = 0,
		onCancel?: () => void,
		onSelectionChange?: (value: string) => void,
	): boolean => {
		if (
			generation !== selectorGeneration ||
			selectorKind !== kind ||
			currentState?.running === true
		) {
			return false;
		}
		if (items.length === 0) {
			selectorKind = undefined;
			renderShortcuts();
			return false;
		}

		const list = new FilterableSelectList(items, 12, theme);
		list.setSelectedIndex(selectedIndex);
		list.onCancel = () => {
			onCancel?.();
			dismissPicker();
		};
		list.onSelectionChange = (item) => onSelectionChange?.(item.value);
		list.onSelect = (item) => {
			if (selectionActive) {
				return;
			}
			selectionActive = true;
			void onSelect(item.value).then(
				(close) => {
					if (generation !== selectorGeneration) {
						return;
					}
					selectionActive = false;
					if (close) {
						dismissPicker();
					} else {
						selectorOverlay?.focus();
						tui.requestRender();
					}
				},
				(error) => {
					if (generation !== selectorGeneration) {
						return;
					}
					selectionActive = false;
					presentCommand(`Selection failed: ${errorMessage(error)}`, "error");
					selectorOverlay?.focus();
				},
			);
		};
		selectorOverlay = tui.showOverlay(list, {
			width: "80%",
			maxHeight: "70%",
			margin: 2,
		});
		selectorOverlay.focus();
		renderShortcuts();
		tui.requestRender();
		return true;
	};

	const openSessionPicker = async (): Promise<boolean> => {
		if (currentState?.running === true) {
			return false;
		}
		dismissInlineCompletion();
		dismissCommandOverlay();
		const generation = beginSelector("session");
		try {
			const sessions = await options.listSessions();
			if (generation !== selectorGeneration) {
				return false;
			}
			if (sessions.length === 0) {
				selectorKind = undefined;
				renderShortcuts();
				presentCommand("No sessions found", "info");
				return false;
			}
			return showPicker(
				"session",
				generation,
				sessions.map(toSessionSelectItem),
				options.onResume,
			);
		} catch (error) {
			if (generation !== selectorGeneration) {
				return false;
			}
			selectorKind = undefined;
			renderShortcuts();
			presentCommand(
				`Failed to list sessions: ${errorMessage(error)}`,
				"error",
			);
			return false;
		}
	};

	const openModelPicker = (): boolean => {
		if (currentState?.running === true) {
			return false;
		}
		dismissInlineCompletion();
		dismissCommandOverlay();
		const generation = beginSelector("model");
		const models = options.getModels();
		const current = options.getCurrentModel();
		const selectedIndex = Math.max(
			0,
			models.findIndex(
				(entry) =>
					entry.provider === current.provider && entry.model === current.model,
			),
		);
		return showPicker(
			"model",
			generation,
			models.map(toModelSelectItem),
			async (value) => {
				const separator = value.indexOf("/");
				return options.onSetModel(
					value.slice(0, separator),
					value.slice(separator + 1),
				);
			},
			selectedIndex,
		);
	};

	const openProviderPicker = (
		mode: ProviderPickerMode,
		providers: readonly ProviderAuthView[],
		onSelect: (provider: ProviderAuthView) => Promise<boolean>,
	): boolean => {
		if (currentState?.running === true || providers.length === 0) {
			return false;
		}
		dismissInlineCompletion();
		dismissCommandOverlay();
		const generation = beginSelector("provider");
		const picker = new ProviderPicker(providers, mode, theme);
		picker.onCancel = () => dismissPicker();
		picker.onSelect = (provider) => {
			if (selectionActive) {
				return;
			}
			selectionActive = true;
			void onSelect(provider).then(
				(close) => {
					if (generation !== selectorGeneration) {
						return;
					}
					selectionActive = false;
					if (close) {
						dismissPicker();
					} else {
						selectorOverlay?.focus();
						tui.requestRender();
					}
				},
				(error) => {
					if (generation !== selectorGeneration) {
						return;
					}
					selectionActive = false;
					presentCommand(`Selection failed: ${errorMessage(error)}`, "error");
					selectorOverlay?.focus();
				},
			);
		};
		selectorOverlay = tui.showOverlay(picker, {
			width: "80%",
			maxHeight: "80%",
			margin: 2,
		});
		selectorOverlay.focus();
		renderShortcuts();
		tui.requestRender();
		return true;
	};

	const applyVisualTheme = (nextTheme: TuiTheme): void => {
		theme.setTheme(nextTheme);
		for (const component of mountedTranscript) {
			component.invalidate?.();
		}
		renderStatus();
		renderShortcuts();
		tui.invalidate();
		tui.requestRender();
	};

	const persistTheme = async (nextTheme: TuiTheme): Promise<boolean> => {
		try {
			await options.onSetTheme?.(nextTheme.name);
			activeTheme = nextTheme;
			applyVisualTheme(nextTheme);
			return true;
		} catch (error) {
			presentCommand(`Failed to save theme: ${errorMessage(error)}`, "error");
			return false;
		}
	};

	const setTheme = async (name: string): Promise<boolean> => {
		const nextTheme = themes.find((candidate) => candidate.name === name);
		if (nextTheme === undefined) {
			return false;
		}
		return persistTheme(nextTheme);
	};

	const openThemePicker = (): boolean => {
		if (currentState?.running === true || themes.length === 0) {
			return false;
		}
		dismissInlineCompletion();
		dismissCommandOverlay();
		const generation = beginSelector("theme");
		const originalTheme = activeTheme;
		themePickerOrigin = originalTheme;
		const selectedIndex = Math.max(
			0,
			themes.findIndex((candidate) => candidate.name === originalTheme.name),
		);
		return showPicker(
			"theme",
			generation,
			themes.map((candidate) => ({
				value: candidate.name,
				label: `${candidate.name}${candidate.name === originalTheme.name ? " (active)" : ""}`,
				description: "Interface theme",
			})),
			async (value) => {
				const nextTheme = themes.find((candidate) => candidate.name === value);
				if (nextTheme === undefined) {
					return false;
				}
				const committed = await persistTheme(nextTheme);
				if (!committed) {
					applyVisualTheme(originalTheme);
				} else {
					themePickerOrigin = undefined;
				}
				return committed;
			},
			selectedIndex,
			undefined,
			(value) => {
				const preview = themes.find((candidate) => candidate.name === value);
				if (preview !== undefined) {
					applyVisualTheme(preview);
				}
			},
		);
	};

	const refresh = (state = currentState): void => {
		if (state === undefined) {
			tui.requestRender();
			return;
		}
		const sessionReplaced =
			currentSessionId !== undefined && currentSessionId !== state.sessionId;
		if (sessionReplaced) {
			clearCommandPresentation();
			expandedToolCallIds.clear();
			transcript.clear();
			mountedTranscript.length = 0;
			blocksByItem = new WeakMap<object, Component>();
			toolBlocksById.clear();
			streamingBlock = undefined;
		}
		currentState = state;
		currentSessionId = state.sessionId;
		if (state.running) {
			dismissCommandPalette();
			dismissPicker();
			dismissInlineCompletion();
		}
		const desired = [...initialTranscript];
		for (const item of state.items) {
			let block: Component;
			if (item.role === "tool") {
				block =
					toolBlocksById.get(item.toolCallId) ??
					createChatItemBlock(item, theme);
				if (!(block instanceof ToolBlock)) {
					throw new Error(`Invalid tool block for ${item.toolCallId}`);
				}
				toolBlocksById.set(item.toolCallId, block);
				block.update({
					preview: item.preview,
					patch: item.patch,
					isError: item.isError,
				});
				block.setExpanded(expandedToolCallIds.has(item.toolCallId));
			} else {
				block = blocksByItem.get(item) ?? createChatItemBlock(item, theme);
				blocksByItem.set(item, block);
			}
			desired.push(block);
		}
		if (
			state.assistantBuffer !== undefined &&
			state.assistantBuffer.trim().length > 0
		) {
			streamingBlock ??= new MessageBlock(
				"assistant",
				state.assistantBuffer,
				theme,
			);
			streamingBlock.setText(state.assistantBuffer);
			desired.push(streamingBlock);
		}

		let stablePrefix = 0;
		while (
			stablePrefix < mountedTranscript.length &&
			stablePrefix < desired.length &&
			mountedTranscript[stablePrefix] === desired[stablePrefix]
		) {
			stablePrefix += 1;
		}
		for (
			let index = mountedTranscript.length - 1;
			index >= stablePrefix;
			index -= 1
		) {
			const component = mountedTranscript[index];
			if (component !== undefined) {
				transcript.removeChild(component);
			}
		}
		mountedTranscript.splice(stablePrefix);
		for (const component of desired.slice(stablePrefix)) {
			transcript.addChild(component);
			mountedTranscript.push(component);
		}

		renderStatus();
		renderShortcuts();
		editor.disableSubmit = state.inputMode === "locked";
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
	} else {
		renderShortcuts();
	}

	return {
		tui,
		editor,
		refresh,
		presentCommand,
		clearCommandPresentation,
		dismissCommandOverlay,
		openCommandPalette,
		dismissCommandPalette,
		openSessionPicker,
		openModelPicker,
		openThemePicker,
		setTheme,
		dismissPicker,
		dismissInlineCompletion,
		acceptInlineCompletion,
		toggleToolPreviews,
		openProviderPicker,
		beginAuthDialog,
		setAuthUrl,
		setAuthStatus,
		requestAuthInput,
		cancelAuthDialog,
		closeAuthDialog,
	};
}

class FilterableSelectList implements Component {
	private readonly list: SelectList;
	private filter = "";
	onSelect?: (item: PiAutocompleteItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: PiAutocompleteItem) => void;

	constructor(
		items: PiAutocompleteItem[],
		maxVisible: number,
		private readonly theme: TuiTheme,
	) {
		this.list = new SelectList(items, maxVisible, theme.editor.selectList);
		this.list.onSelect = (item) => this.onSelect?.(item);
		this.list.onCancel = () => this.onCancel?.();
		this.list.onSelectionChange = (item) => this.onSelectionChange?.(item);
	}

	setSelectedIndex(index: number): void {
		this.list.setSelectedIndex(index);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		return [
			this.theme.muted(
				this.filter.length === 0
					? "Filter: type to narrow"
					: `Filter: ${this.filter}`,
			),
			...this.list.render(width),
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.backspace)) {
			if (this.filter.length > 0) {
				this.filter = Array.from(this.filter).slice(0, -1).join("");
				this.list.setFilter(this.filter);
			}
			return;
		}

		const printable =
			decodeKittyPrintable(data) ??
			(Array.from(data).length === 1 && data >= " " && data !== "\u007f"
				? data
				: undefined);
		if (printable !== undefined && printable.trim().length > 0) {
			this.filter += printable;
			this.list.setFilter(this.filter);
			return;
		}
		this.list.handleInput(data);
	}
}

function formatLastUsage(state: TuiState): string {
	if (state.lastUsage === undefined) {
		return "";
	}
	return ` · last response in ${formatTokenCount(state.lastUsage.inputTokens)} · out ${formatTokenCount(state.lastUsage.outputTokens)}`;
}

function formatTokenCount(value: number): string {
	if (value < 1_000) {
		return String(value);
	}
	const formatted = (value / 1_000).toFixed(1);
	return `${formatted.replace(/\.0$/, "")}k`;
}

function createAutocompleteProvider(
	getCatalog: () => CompletionCatalog,
): AutocompleteProvider {
	let fileProvider: CombinedAutocompleteProvider | undefined;
	let fileProviderCwd: string | undefined;
	let latestSessionIds: readonly string[] = [];
	const getFileProvider = (cwd: string): CombinedAutocompleteProvider => {
		if (fileProvider === undefined || fileProviderCwd !== cwd) {
			fileProvider = new CombinedAutocompleteProvider([], cwd, Bun.which("fd"));
			fileProviderCwd = cwd;
		}
		return fileProvider;
	};

	return {
		triggerCharacters: ["@"],
		async getSuggestions(lines, cursorLine, cursorCol, requestOptions) {
			const catalog = getCatalog();
			latestSessionIds = isResumeArgument(lines, cursorLine, cursorCol)
				? (await catalog.listSessions()).map((session) => session.id)
				: [];
			const completion = buildCompletionState({
				...catalog,
				lines,
				cursorLine,
				cursorCol,
				sessionIds: latestSessionIds,
				modelValues: catalog.models.map(canonicalModel),
				providerIds: catalog.providerIds,
			});
			if (completion !== null) {
				return completion.items.length === 0
					? null
					: {
							items: completion.items.map(toSelectItem),
							prefix: completion.query,
						};
			}
			return getFileProvider(catalog.cwd).getSuggestions(
				[...lines],
				cursorLine,
				cursorCol,
				requestOptions,
			);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const catalog = getCatalog();
			const completion = buildCompletionState({
				...catalog,
				lines,
				cursorLine,
				cursorCol,
				sessionIds: latestSessionIds,
				modelValues: catalog.models.map(canonicalModel),
				providerIds: catalog.providerIds,
			});
			const selected = completion?.items.find(
				(candidate) =>
					candidate.value === item.value && candidate.label === item.label,
			);
			if (completion !== null && completion !== undefined && selected) {
				const nextLines = [...lines];
				const range = completion.replacement;
				const line = nextLines[range.line] ?? "";
				nextLines[range.line] =
					line.slice(0, range.start) + selected.value + line.slice(range.end);
				return {
					lines: nextLines,
					cursorLine: range.line,
					cursorCol: range.start + selected.value.length,
				};
			}
			return getFileProvider(catalog.cwd).applyCompletion(
				[...lines],
				cursorLine,
				cursorCol,
				item,
				prefix,
			);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const catalog = getCatalog();
			return getFileProvider(catalog.cwd).shouldTriggerFileCompletion(
				[...lines],
				cursorLine,
				cursorCol,
			);
		},
	};
}

function toSelectItem(item: CompletionItem): PiAutocompleteItem {
	const aliases =
		item.aliases.length === 0
			? undefined
			: `aliases ${item.aliases.map((alias) => `/${alias}`).join(", ")}`;
	const planned = item.planned
		? `planned: ${item.missingCapabilities.join(", ")}`
		: undefined;
	return {
		value: item.value,
		label: item.label,
		description: [
			item.usage === item.value ? undefined : item.usage,
			item.description,
			item.source,
			aliases,
			planned,
		]
			.filter((value) => value !== undefined)
			.join(" · "),
	};
}

function toSessionSelectItem(
	session: CommandSessionListItem,
): PiAutocompleteItem {
	return {
		value: session.id,
		label: cleanPickerText(session.title),
		description: [
			session.id,
			session.model === null ? "no model" : canonicalModel(session.model),
		].join(" · "),
	};
}

function toModelSelectItem(model: CommandModelListItem): PiAutocompleteItem {
	return {
		value: canonicalModel(model),
		label: cleanPickerText(model.model),
		description: cleanPickerText(model.provider),
	};
}

function canonicalModel(model: CommandModelListItem): string {
	return `${model.provider}/${model.model}`;
}

function cleanPickerText(value: string): string {
	return value.replace(/[\t\r\n]+/g, " ");
}

function isResumeArgument(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
): boolean {
	if (cursorLine !== 0) {
		return false;
	}
	const line = lines[0] ?? "";
	return /^\/resume\s/.test(line) && cursorCol > "/resume".length;
}

function applyPaletteSelection(editor: Editor, value: string): void {
	const cursor = editor.getCursor();
	const lines = editor.getLines();
	const line = lines[0] ?? "";
	const whitespaceIndex = line.search(/\s/);
	const tokenEnd = whitespaceIndex === -1 ? line.length : whitespaceIndex;
	if (
		cursor.line === 0 &&
		line.startsWith("/") &&
		cursor.col >= 1 &&
		cursor.col <= tokenEnd
	) {
		lines[0] = `${value}${line.slice(tokenEnd)}`;
		editor.setText(lines.join("\n"));
		return;
	}
	editor.insertTextAtCursor(value);
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
