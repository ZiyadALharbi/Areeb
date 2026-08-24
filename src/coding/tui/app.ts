import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	decodeKittyPrintable,
	Editor,
	fuzzyFilter,
	Key,
	matchesKey,
	type OverlayHandle,
	type AutocompleteItem as PiAutocompleteItem,
	ScrollView,
	SelectList,
	sliceByColumn,
	stripTerminalSequences,
	type Terminal,
	TruncatedText,
	TuiAltScreen,
	truncateToWidth,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AuthPrompt, AuthType } from "../../ai/auth.ts";
import { REASONING_LEVELS, type ReasoningLevel } from "../../ai/types.ts";
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
import { MessageBlock, ThinkingBlock, ToolBlock } from "./blocks.ts";
import {
	CommandOverlayContent,
	OverlayFrame,
	overlayListRows,
	overlayMaxHeight,
	STANDARD_OVERLAY_OPTIONS,
} from "./overlay.ts";
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
	readonly onSetEffort: (effort: ReasoningLevel) => Promise<boolean>;
	readonly themes?: readonly TuiTheme[];
	readonly onSetTheme?: (theme: TuiThemeName) => Promise<void>;
	readonly onCopySelection?: (text: string) => Promise<boolean>;
	readonly state?: TuiState;
}

export interface TuiApp {
	readonly tui: TuiAltScreen;
	readonly editor: Editor;
	refresh(state?: TuiState): void;
	presentCommand(
		text: string,
		level: CommandNoticeLevel,
		overlayTitle?: string,
	): void;
	clearCommandPresentation(): void;
	dismissCommandOverlay(): boolean;
	openCommandPalette(): boolean;
	dismissCommandPalette(): boolean;
	openSessionPicker(): Promise<boolean>;
	openModelPicker(): boolean;
	openEffortPicker(): boolean;
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

interface FilterableSelectItem extends PiAutocompleteItem {
	readonly searchText?: string;
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
	const editor = new Editor(tui, theme.editor, { paddingX: 3 });
	editor.setAutocompleteProvider(
		createAutocompleteProvider(options.getCompletionCatalog),
	);
	editor.disableSubmit = options.state?.inputMode === "locked";
	const composerSurface = new ComposerSurface(editor, theme, options.state);
	const composer = new VStack([composerSurface]);
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
			{ component: composer, basis: "auto" },
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
	let commandOverlay: OverlayHandle | undefined;
	let selectorOverlay: OverlayHandle | undefined;
	let selectorKind:
		| "palette"
		| "session"
		| "model"
		| "effort"
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
			selectorKind === "effort"
				? "Up/Down:move  │  Enter:select  │  Esc:close"
				: commandOverlay !== undefined
					? "Up/Down:scroll  │  PgUp/PgDn:page  │  Esc:close"
					: authOverlay !== undefined || selectorKind !== undefined
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
		if (notice !== undefined || currentState !== undefined) {
			status.addChild(new ComposerStatusLine(currentState, notice, theme));
		}
	};

	const dismissCommandOverlay = (): boolean => {
		if (commandOverlay === undefined) {
			return false;
		}
		commandOverlay.hide();
		commandOverlay = undefined;
		tui.setFocus(editor);
		renderShortcuts();
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
		if (selectorKind === "effort") {
			composer.clear();
			composer.addChild(composerSurface);
		}
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
		kind: "palette" | "session" | "model" | "effort" | "theme" | "provider",
	): number => {
		if (selectorKind === "theme" && themePickerOrigin !== undefined) {
			applyVisualTheme(themePickerOrigin);
			themePickerOrigin = undefined;
		}
		selectorGeneration += 1;
		selectorOverlay?.hide();
		selectorOverlay = undefined;
		if (selectorKind === "effort") {
			composer.clear();
			composer.addChild(composerSurface);
		}
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
		authOverlay = tui.showOverlay(
			new OverlayFrame(
				authDialog,
				{
					title: dialogOptions.title,
					subtitle: dialogOptions.subtitle,
					maxHeight: () => overlayMaxHeight(options.terminal.rows),
					scrollable: true,
					stickToEnd: true,
					scrollWithArrows: false,
				},
				theme,
			),
			STANDARD_OVERLAY_OPTIONS,
		);
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
		const searchTermsByCommand = new Map(
			catalog.commands.map((command) => [
				`/${command.name}`,
				command.searchTerms ?? [],
			]),
		);
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
			completion.items.map((item) =>
				toSelectItem(item, searchTermsByCommand.get(item.value)),
			),
			overlayListRows(options.terminal.rows, 12),
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
		selectorOverlay = tui.showOverlay(
			new OverlayFrame(
				list,
				{
					title: "Commands",
					subtitle: "Type to filter available actions",
					maxHeight: () => overlayMaxHeight(options.terminal.rows),
				},
				theme,
			),
			STANDARD_OVERLAY_OPTIONS,
		);
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

	const presentCommand = (
		text: string,
		level: CommandNoticeLevel,
		overlayTitle = "Details",
	): void => {
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

		commandOverlay = tui.showOverlay(
			new OverlayFrame(
				new CommandOverlayContent(
					boundCommandText(cleanText),
					level,
					theme,
					overlayTitle,
				),
				{
					title: overlayTitle,
					maxHeight: () => overlayMaxHeight(options.terminal.rows),
					scrollable: true,
				},
				theme,
			),
			STANDARD_OVERLAY_OPTIONS,
		);
		commandOverlay.focus();
		renderShortcuts();
		tui.requestRender();
	};

	const showPicker = (
		kind: "session" | "model" | "theme",
		generation: number,
		items: FilterableSelectItem[],
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

		const list = new FilterableSelectList(
			items,
			overlayListRows(options.terminal.rows, 12),
			theme,
		);
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
		const presentation = pickerPresentation(kind);
		selectorOverlay = tui.showOverlay(
			new OverlayFrame(
				list,
				{
					...presentation,
					maxHeight: () => overlayMaxHeight(options.terminal.rows),
				},
				theme,
			),
			STANDARD_OVERLAY_OPTIONS,
		);
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

	const openEffortPicker = (): boolean => {
		if (currentState?.running === true) {
			return false;
		}
		dismissInlineCompletion();
		dismissCommandOverlay();
		const generation = beginSelector("effort");
		const list = new SelectList(
			REASONING_LEVELS.map((effort) => ({
				value: effort,
				label: effort,
			})),
			REASONING_LEVELS.length,
			theme.editor.selectList,
		);
		list.setSelectedIndex(
			Math.max(0, REASONING_LEVELS.indexOf(currentState?.reasoning ?? "off")),
		);
		list.onCancel = () => dismissPicker();
		list.onSelect = (item) => {
			if (selectionActive) {
				return;
			}
			selectionActive = true;
			void options.onSetEffort(item.value as ReasoningLevel).then(
				(close) => {
					if (generation !== selectorGeneration) {
						return;
					}
					selectionActive = false;
					if (close) {
						dismissPicker();
					} else {
						tui.setFocus(list);
						tui.requestRender();
					}
				},
				(error) => {
					if (generation !== selectorGeneration) {
						return;
					}
					selectionActive = false;
					presentCommand(`Selection failed: ${errorMessage(error)}`, "error");
					tui.setFocus(list);
				},
			);
		};
		composer.clear();
		composer.addChild(list);
		tui.setFocus(list);
		renderShortcuts();
		tui.requestRender();
		return true;
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
		const picker = new ProviderPicker(
			providers,
			mode,
			theme,
			overlayListRows(options.terminal.rows, 8),
		);
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
		selectorOverlay = tui.showOverlay(
			new OverlayFrame(
				picker,
				{
					title: mode === "login" ? "Connect provider" : "Log out",
					subtitle:
						mode === "login"
							? "Choose a subscription or API key"
							: "Choose a saved credential to remove",
					maxHeight: () => overlayMaxHeight(options.terminal.rows),
				},
				theme,
			),
			STANDARD_OVERLAY_OPTIONS,
		);
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
			dismissPicker();
			clearCommandPresentation();
			expandedToolCallIds.clear();
			transcript.clear();
			mountedTranscript.length = 0;
			blocksByItem = new WeakMap<object, Component>();
			toolBlocksById.clear();
		}
		currentState = state;
		currentSessionId = state.sessionId;
		composerSurface.setState(state);
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
		if (state.assistantBlocks !== undefined) {
			for (const block of state.assistantBlocks) {
				if (block.text.trim().length === 0) {
					continue;
				}
				const component =
					block.role === "thinking"
						? new ThinkingBlock(block.text, theme)
						: new MessageBlock("assistant", block.text, theme);
				desired.push(component);
			}
		} else if (
			state.assistantBuffer !== undefined &&
			state.assistantBuffer.trim().length > 0
		) {
			const component = new MessageBlock(
				"assistant",
				state.assistantBuffer,
				theme,
			);
			desired.push(component);
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
		openEffortPicker,
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

class ComposerSurface extends Container {
	constructor(
		private readonly editor: Editor,
		private readonly theme: TuiTheme,
		private state: TuiState | undefined,
	) {
		super();
		this.addChild(editor);
	}

	setState(state: TuiState): void {
		this.state = state;
	}

	override render(width: number): string[] {
		const availableWidth = normalizeWidth(width);
		if (availableWidth < 12) {
			return this.editor.render(availableWidth);
		}

		const innerWidth = availableWidth - 2;
		const editorLines = this.editor.render(innerWidth);
		const bottomBorderIndex = editorLines.findIndex(
			(line, index) => index > 0 && isEditorBorderLine(line, innerWidth),
		);
		const body =
			bottomBorderIndex === -1
				? editorLines.slice(1)
				: [
						editorLines.slice(1, bottomBorderIndex),
						editorLines.slice(bottomBorderIndex + 1),
					].flat();
		const content = body.length === 0 ? [""] : body;

		return [
			this.theme.composerBorder(`╭${"─".repeat(innerWidth)}╮`),
			...content.map((line, index) => {
				const prompted =
					index === 0
						? `${this.theme.assistant("❯ ")}${sliceByColumn(line, 2, innerWidth - 2, true)}`
						: line;
				return `${this.theme.composerBorder("│")}${fitLine(prompted, innerWidth)}${this.theme.composerBorder("│")}`;
			}),
			this.renderBottomBorder(innerWidth),
		];
	}

	private renderBottomBorder(innerWidth: number): string {
		const metadata = renderComposerMetadata(
			this.state,
			Math.max(0, innerWidth - 2),
			this.theme,
		);
		if (metadata === "") {
			return this.theme.composerBorder(`╰${"─".repeat(innerWidth)}╯`);
		}
		const fill = "─".repeat(
			Math.max(0, innerWidth - visibleWidth(metadata) - 2),
		);
		return `${this.theme.composerBorder(`╰${fill} `)}${metadata}${this.theme.composerBorder(" ╯")}`;
	}
}

class ComposerStatusLine implements Component {
	constructor(
		private readonly state: TuiState | undefined,
		private readonly notice:
			| { readonly text: string; readonly level: CommandNoticeLevel }
			| undefined,
		private readonly theme: TuiTheme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = normalizeWidth(width);
		if (availableWidth === 0) {
			return [];
		}
		const left = this.renderLeft();
		return left === undefined
			? []
			: [truncateToWidth(left, availableWidth, "…")];
	}

	private renderLeft(): string | undefined {
		if (this.notice !== undefined) {
			const style =
				this.notice.level === "error"
					? this.theme.error
					: this.notice.level === "warning"
						? this.theme.warning
						: this.theme.assistant;
			return style(this.notice.text);
		}
		if (this.state?.running === true) {
			return this.theme.muted(
				this.state.queuedCount > 0
					? `Running · ${this.state.queuedCount} queued`
					: "Running",
			);
		}
		if (this.state?.inputMode === "locked") {
			return this.theme.muted("Starting");
		}
		if (this.state?.lastUsage !== undefined) {
			return this.theme.muted(
				`Last · ${formatTokenCount(this.state.lastUsage.inputTokens)} in · ${formatTokenCount(this.state.lastUsage.outputTokens)} out`,
			);
		}
		return undefined;
	}
}

class FilterableSelectList implements Component {
	private list: SelectList;
	private filter = "";
	onSelect?: (item: PiAutocompleteItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: PiAutocompleteItem) => void;

	constructor(
		private readonly items: FilterableSelectItem[],
		private readonly maxVisible: number,
		private readonly theme: TuiTheme,
	) {
		this.list = this.createList(items);
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
					? "Search  Type to filter"
					: `Search  ${this.filter}`,
			),
			...this.list.render(width),
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.backspace)) {
			if (this.filter.length > 0) {
				this.filter = Array.from(this.filter).slice(0, -1).join("");
				this.applyFilter();
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
			this.applyFilter();
			return;
		}
		this.list.handleInput(data);
	}

	private applyFilter(): void {
		this.list = this.createList(
			fuzzyFilter(this.items, this.filter, (item) =>
				[
					item.value.replace(/^\//, ""),
					item.label,
					item.description ?? "",
					item.searchText ?? "",
				].join(" "),
			),
		);
	}

	private createList(items: FilterableSelectItem[]): SelectList {
		const list = new SelectList(
			items,
			this.maxVisible,
			this.theme.editor.selectList,
		);
		list.onSelect = (item) => this.onSelect?.(item);
		list.onCancel = () => this.onCancel?.();
		list.onSelectionChange = (item) => this.onSelectionChange?.(item);
		return list;
	}
}

function pickerPresentation(kind: "session" | "model" | "theme"): {
	readonly title: string;
	readonly subtitle: string;
} {
	switch (kind) {
		case "session":
			return {
				title: "Sessions",
				subtitle: "Resume a previous conversation",
			};
		case "model":
			return {
				title: "Models",
				subtitle: "Choose the model for this session",
			};
		case "theme":
			return {
				title: "Theme",
				subtitle: "Preview and apply an interface theme",
			};
	}
}

function normalizeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function isEditorBorderLine(line: string, width: number): boolean {
	const plain = stripTerminalSequences(line);
	return (
		visibleWidth(plain) === width &&
		(/^─+$/.test(plain) ||
			plain.startsWith("─── ↑ ") ||
			plain.startsWith("─── ↓ "))
	);
}

function fitLine(line: string, width: number): string {
	const fitted = truncateToWidth(line, width, "");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function formatTokenCount(value: number): string {
	if (value < 1_000) {
		return String(value);
	}
	const formatted = (value / 1_000).toFixed(1);
	return `${formatted.replace(/\.0$/, "")}k`;
}

function renderComposerMetadata(
	state: TuiState | undefined,
	width: number,
	theme: TuiTheme,
): string {
	if (state === undefined || width === 0) {
		return "";
	}
	const effort = `effort ${state.reasoning}`;
	if (visibleWidth(effort) >= width) {
		return theme.assistant(truncateToWidth(effort, width, "…"));
	}
	const separator = " · ";
	const modelWidth = width - visibleWidth(separator) - visibleWidth(effort);
	if (modelWidth < 4) {
		return theme.assistant(effort);
	}
	const model = truncateToWidth(state.model, modelWidth, "…");
	return `${theme.primary(model)}${theme.muted(separator)}${theme.assistant(effort)}`;
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
							items: completion.items.map((item) => toSelectItem(item)),
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

function toSelectItem(
	item: CompletionItem,
	searchTerms: readonly string[] = [],
): FilterableSelectItem {
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
		searchText: searchTerms.join(" "),
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
		case "thinking":
			return new ThinkingBlock(item.text, theme);
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
