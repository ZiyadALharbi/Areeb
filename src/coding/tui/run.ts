import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
	Key,
	matchesKey,
	ProcessTerminal,
	parseKey,
	type Terminal,
} from "@earendil-works/pi-tui";
import type {
	AgentMessage,
	AgentRunStream,
	QueuedMessages,
} from "../../agent/types.ts";
import type { CommandHotkey, CommandSessionListItem } from "../commands.ts";
import { areebPaths } from "../paths.ts";
import type { ResourceDiagnostic } from "../resources.ts";
import type { CodingSessionTuiService } from "../session.ts";
import type { TuiEventAdapter } from "./adapter.ts";
import {
	type CreateTuiAppOptions,
	createTuiApp,
	type TuiApp,
	type TuiShortcutSet,
} from "./app.ts";
import type { CompletionCatalog } from "./autocomplete.ts";
import {
	type LoadedTuiConfig,
	loadTuiConfig,
	saveTuiConfig,
} from "./config.ts";
import type { TuiCommandResult, TuiTransitionOutcome } from "./controller.ts";
import type { TuiState } from "./state.ts";
import {
	AREEB_DARK_THEME,
	getTuiTheme,
	listTuiThemes,
	type TuiTheme,
} from "./theme.ts";

export interface InteractiveController {
	readonly messages: readonly AgentMessage[];
	readonly metadata: { readonly id: string; readonly cwd: string };
	readonly provider: string;
	readonly model: string;
	readonly state: TuiState;
	readonly adapter: TuiEventAdapter;
	readonly isRunning: boolean;
	readonly queuedMessages: QueuedMessages;
	readonly resourceDiagnostics: readonly ResourceDiagnostic[];
	readonly completionCatalog: CompletionCatalog;
	prompt(input: string): AgentRunStream;
	handleCommand(
		input: string,
		tuiService?: CodingSessionTuiService,
	): Promise<TuiCommandResult>;
	abort(): void;
	followUp(input: string): QueuedMessages;
	clearQueues(): QueuedMessages;
	listSessions(): Promise<readonly CommandSessionListItem[]>;
	resumeSession(id: string): Promise<TuiTransitionOutcome>;
	setModel(provider: string, model: string): Promise<TuiTransitionOutcome>;
	waitForIdle(): Promise<void>;
}

interface InteractiveHotkey extends CommandHotkey {
	readonly footerLabel?: string;
}

export const INTERACTIVE_HOTKEYS: readonly InteractiveHotkey[] = Object.freeze([
	{ keys: "Enter", description: "Submit input" },
	{ keys: "Alt+Enter", description: "Insert a newline" },
	{ keys: "Tab / Enter", description: "Apply the selected completion" },
	{ keys: "Up / Down", description: "Move through completions" },
	{
		keys: "Esc",
		description: "Close the active menu or interrupt the run",
		footerLabel: "interrupt",
	},
	{ keys: "Ctrl+C", description: "Quit", footerLabel: "quit" },
	{
		keys: "Ctrl+P",
		description: "Open the command palette",
		footerLabel: "commands",
	},
	{
		keys: "Ctrl+S",
		description: "Open the session picker",
		footerLabel: "sessions",
	},
	{
		keys: "Ctrl+M",
		description: "Open the model picker when terminal modifiers are explicit",
		footerLabel: "model",
	},
	{ keys: "/", description: "Open slash command completion" },
	{
		keys: "Ctrl+O",
		description: "Toggle tool previews",
		footerLabel: "tools",
	},
	{ keys: "/theme", description: "Preview or switch the interface theme" },
	{ keys: "/copy", description: "Copy the latest assistant response" },
]);

export const INTERACTIVE_SHORTCUTS: TuiShortcutSet = Object.freeze({
	idle: "Ctrl+S:sessions  │  Ctrl+M:model  │  Ctrl+P:commands  │  Ctrl+O:tools  │  Ctrl+C:quit",
	menu: "Type:filter  │  Up/Down:move  │  Enter:select  │  Esc:close",
	running: "Enter:queue  │  Esc:interrupt  │  Ctrl+C:quit",
});

export interface InteractiveRunOptions {
	readonly terminal?: Terminal;
	readonly theme?: TuiTheme;
	readonly userRoot?: string;
	readonly createApp?: (options: CreateTuiAppOptions) => TuiApp;
}

export interface CopyDeliveryResult {
	readonly osc52Sent: boolean;
	readonly backupSaved: boolean;
	readonly backupPath: string;
	readonly error?: string;
}

/** Run the controller's active session until the user quits the fullscreen TUI. */
export async function runInteractiveMode(
	controller: InteractiveController,
	options: InteractiveRunOptions = {},
): Promise<number> {
	const paths = areebPaths({
		...(options.userRoot === undefined ? {} : { userRoot: options.userRoot }),
	});
	const loadedConfig: LoadedTuiConfig =
		options.theme === undefined
			? await loadTuiConfig(paths.userTuiConfig)
			: { config: { theme: options.theme.name } };
	const initialTheme =
		options.theme ?? getTuiTheme(loadedConfig.config.theme) ?? AREEB_DARK_THEME;
	let activeThemeName = initialTheme.name;
	const terminal = options.terminal ?? new ProcessTerminal();
	const tuiService: CodingSessionTuiService = {
		getThemeName: () => activeThemeName,
		getThemeNames: () => listTuiThemes().map((theme) => theme.name),
		getHotkeys: () => INTERACTIVE_HOTKEYS,
	};
	let app!: TuiApp;
	app = (options.createApp ?? createTuiApp)({
		terminal,
		theme: initialTheme,
		themes: listTuiThemes(),
		onSetTheme: async (theme) => {
			await saveTuiConfig(paths.userTuiConfig, { theme });
			activeThemeName = theme;
		},
		onCopySelection: async (text) => {
			const result = await copyTuiText(terminal, paths.userLastCopy, text);
			presentCopyResult(app, result);
			return result.backupSaved;
		},
		transcript: [],
		shortcuts: INTERACTIVE_SHORTCUTS,
		getCompletionCatalog: () => controller.completionCatalog,
		listSessions: () => controller.listSessions(),
		getModels: () => controller.completionCatalog.models,
		getCurrentModel: () => ({
			provider: controller.provider,
			model: controller.model,
		}),
		onResume: async (sessionId) =>
			applyPickerOutcome(
				await controller.resumeSession(sessionId),
				app,
				controller.state,
			),
		onSetModel: async (provider, model) =>
			applyPickerOutcome(
				await controller.setModel(provider, model),
				app,
				controller.state,
			),
		state: controller.state,
	});
	const startupWarning = formatStartupWarning(
		loadedConfig.warning,
		controller.resourceDiagnostics,
	);
	if (startupWarning !== undefined) {
		app.presentCommand(startupWarning, "warning");
	}

	let submissionActive = false;
	let abortRequested = false;
	let exitRequested = false;
	let settled = false;
	let removeInputListener: (() => void) | undefined;
	let resolveCompletion!: (code: number) => void;
	let rejectCompletion!: (error: unknown) => void;
	const completion = new Promise<number>((resolve, reject) => {
		resolveCompletion = resolve;
		rejectCompletion = reject;
	});

	const cleanup = (): void => {
		app.editor.onSubmit = undefined;
		removeInputListener?.();
		removeInputListener = undefined;
		app.dismissCommandPalette();
		app.dismissPicker();
		app.dismissInlineCompletion();
		app.clearCommandPresentation();
	};

	const settle = (error?: unknown): void => {
		if (settled) {
			return;
		}
		settled = true;
		cleanup();
		let failure = error;
		try {
			app.tui.stop();
		} catch (stopError) {
			failure ??= stopError;
		}
		if (failure === undefined) {
			resolveCompletion(0);
		} else {
			rejectCompletion(failure);
		}
	};

	const fail = (error: unknown): void => {
		if (settled) {
			return;
		}
		const state = controller.state;
		state.running = false;
		state.inputMode = "idle";
		state.items.push({ role: "error", text: errorMessage(error) });
		let failure = error;
		try {
			app.refresh(state);
		} catch (refreshError) {
			failure ??= refreshError;
		}
		settle(failure);
	};

	const requestAbort = (): void => {
		if (abortRequested || !controller.isRunning) {
			return;
		}
		abortRequested = true;
		controller.abort();
	};

	const requestExit = (): void => {
		if (settled || exitRequested) {
			return;
		}
		exitRequested = true;
		app.editor.disableSubmit = true;
		requestAbort();
		if (!submissionActive) {
			settle();
		}
	};

	const runSubmission = async (input: string): Promise<void> => {
		let failure: unknown;
		try {
			const command = await controller.handleCommand(input, tuiService);
			if (command.handled) {
				await applyCommandResult(command, input, app, requestExit, async () => {
					const text = findLastAssistantText(controller.state);
					if (text === undefined) {
						app.presentCommand("No assistant response to copy", "error");
						return;
					}
					presentCopyResult(
						app,
						await copyTuiText(terminal, paths.userLastCopy, text),
					);
				});
				app.refresh(controller.state);
			} else if (!exitRequested) {
				await consumePrompt(controller, input, controller.adapter, app);
			}
		} catch (error) {
			failure = error;
		}

		try {
			await controller.waitForIdle();
		} catch (error) {
			failure ??= error;
		}

		controller.state.running = false;
		controller.state.inputMode = "idle";
		controller.state.queuedCount = controller.queuedMessages.count;
		submissionActive = false;
		try {
			app.refresh(controller.state);
		} catch (error) {
			failure ??= error;
		}
		if (failure !== undefined) {
			fail(failure);
			return;
		}
		if (exitRequested) {
			settle();
		}
	};

	app.editor.onSubmit = (input) => {
		if (exitRequested || input.trim().length === 0) {
			return;
		}
		if (controller.isRunning || controller.state.inputMode === "running") {
			try {
				const queued = controller.followUp(input);
				controller.state.queuedCount = queued.count;
				app.clearCommandPresentation();
				app.refresh(controller.state);
			} catch (error) {
				app.editor.setText(input);
				app.presentCommand(
					`Failed to queue follow-up: ${errorMessage(error)}`,
					"error",
				);
				app.refresh(controller.state);
			}
			return;
		}
		if (submissionActive) {
			return;
		}
		// Lock synchronously because command dispatch may yield before prompt starts.
		submissionActive = true;
		abortRequested = false;
		controller.state.inputMode = "locked";
		delete controller.state.terminalReason;
		try {
			app.clearCommandPresentation();
			app.refresh(controller.state);
		} catch (error) {
			submissionActive = false;
			fail(error);
			return;
		}
		void runSubmission(input);
	};

	removeInputListener = app.tui.addInputListener((data) => {
		if (matchesKey(data, Key.ctrl("c"))) {
			requestExit();
			return { consume: true };
		}
		if (matchesKey(data, Key.escape)) {
			if (app.dismissPicker()) {
				return { consume: true };
			}
			if (app.dismissCommandPalette()) {
				return { consume: true };
			}
			if (app.dismissInlineCompletion()) {
				return { consume: true };
			}
			if (app.dismissCommandOverlay()) {
				return { consume: true };
			}
			requestAbort();
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("o"))) {
			app.toggleToolPreviews();
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("p"))) {
			if (!submissionActive && !controller.isRunning) {
				app.openCommandPalette();
			}
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			if (!submissionActive && !controller.isRunning) {
				void app.openSessionPicker();
			}
			return { consume: true };
		}
		if (isExplicitCtrlM(data)) {
			if (!submissionActive && !controller.isRunning) {
				app.openModelPicker();
			}
			return { consume: true };
		}
		if (matchesKey(data, Key.enter) && app.acceptInlineCompletion()) {
			return { consume: true };
		}
		return undefined;
	});

	try {
		app.tui.start();
	} catch (error) {
		fail(error);
	}

	return completion;
}

async function consumePrompt(
	controller: InteractiveController,
	input: string,
	adapter: TuiEventAdapter,
	app: TuiApp,
): Promise<void> {
	const stream = controller.prompt(input);
	controller.state.running = true;
	controller.state.inputMode = "running";
	controller.state.queuedCount = controller.queuedMessages.count;
	app.refresh(controller.state);
	let terminalEvents = 0;
	for await (const event of stream) {
		if (event.type === "agent_end") {
			terminalEvents += 1;
			if (terminalEvents > 1) {
				throw new Error("Agent emitted more than one terminal event");
			}
		}
		if (
			event.type === "agent_end" &&
			(event.reason === "aborted" || event.reason === "provider_error")
		) {
			controller.clearQueues();
		}
		const queueCount = controller.queuedMessages.count;
		const queueChanged = controller.state.queuedCount !== queueCount;
		controller.state.queuedCount = queueCount;
		if (adapter.apply(event) || queueChanged) {
			app.refresh(controller.state);
		}
	}
	await stream.result();
	if (terminalEvents === 0) {
		throw new Error("Agent stream ended without a terminal event");
	}
}

async function applyCommandResult(
	result: Extract<TuiCommandResult, { readonly handled: true }>,
	input: string,
	app: TuiApp,
	requestExit: () => void,
	copyLastAssistant: () => Promise<void>,
): Promise<void> {
	switch (result.outcome.kind) {
		case "message":
			app.presentCommand(result.outcome.text, result.outcome.level);
			return;
		case "unavailable": {
			const command = input.trim().split(/\s/, 1)[0] ?? "Command";
			app.presentCommand(
				`${command} is planned (${result.outcome.missingCapability})`,
				"info",
			);
			return;
		}
		case "quit":
			requestExit();
			return;
		case "resume-picker":
			await app.openSessionPicker();
			return;
		case "model-picker":
			app.openModelPicker();
			return;
		case "theme-picker":
			app.openThemePicker();
			return;
		case "set-theme":
			if (await app.setTheme(result.outcome.theme)) {
				app.presentCommand(`Theme set to ${result.outcome.theme}`, "info");
			}
			return;
		case "copy-last-assistant":
			await copyLastAssistant();
			return;
		case "none":
			return;
	}
}

function applyPickerOutcome(
	outcome: TuiTransitionOutcome,
	app: TuiApp,
	state: TuiState,
): boolean {
	switch (outcome.kind) {
		case "none":
			app.refresh(state);
			return true;
		case "message":
			app.presentCommand(outcome.text, outcome.level);
			app.refresh(state);
			return false;
		case "unavailable":
			app.presentCommand(
				`Selection is unavailable (${outcome.missingCapability})`,
				"info",
			);
			return false;
		case "quit":
		case "resume-picker":
		case "model-picker":
		case "theme-picker":
		case "set-theme":
		case "copy-last-assistant":
			return false;
	}
}

export async function copyTuiText(
	terminal: Terminal,
	backupPath: string,
	text: string,
): Promise<CopyDeliveryResult> {
	let osc52Sent = false;
	let oscError: unknown;
	try {
		terminal.write(
			`\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`,
		);
		osc52Sent = true;
	} catch (error) {
		oscError = error;
	}

	try {
		await writePrivateTextFile(backupPath, text);
		return {
			osc52Sent,
			backupSaved: true,
			backupPath,
			...(oscError === undefined ? {} : { error: errorMessage(oscError) }),
		};
	} catch (error) {
		return {
			osc52Sent,
			backupSaved: false,
			backupPath,
			error: errorMessage(error),
		};
	}
}

function presentCopyResult(app: TuiApp, result: CopyDeliveryResult): void {
	if (result.backupSaved && result.osc52Sent) {
		app.presentCommand(
			`Copy sent via OSC 52 and saved to ${result.backupPath}`,
			"info",
		);
		return;
	}
	if (result.backupSaved) {
		app.presentCommand(
			`Clipboard send failed; copy saved to ${result.backupPath}`,
			"warning",
		);
		return;
	}
	app.presentCommand(
		`${result.osc52Sent ? "OSC 52 sent, but copy recovery failed" : "Copy failed"}: could not save ${result.backupPath}${result.error === undefined ? "" : ` (${result.error})`}`,
		"error",
	);
}

async function writePrivateTextFile(path: string, text: string): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let temporaryCreated = false;
	try {
		const file = await open(temporaryPath, "wx", 0o600);
		temporaryCreated = true;
		try {
			await file.writeFile(text, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporaryPath, path);
		temporaryCreated = false;
		await chmod(path, 0o600);
	} finally {
		if (temporaryCreated) {
			await unlink(temporaryPath).catch(() => undefined);
		}
	}
}

function findLastAssistantText(state: TuiState): string | undefined {
	for (let index = state.items.length - 1; index >= 0; index -= 1) {
		const item = state.items[index];
		if (item?.role === "assistant" && item.text.trim().length > 0) {
			return item.text;
		}
	}
	return undefined;
}

function formatStartupWarning(
	configWarning: string | undefined,
	diagnostics: readonly ResourceDiagnostic[],
): string | undefined {
	const warningCount = diagnostics.filter(
		(diagnostic) => diagnostic.severity === "warning",
	).length;
	const resourceWarning =
		warningCount === 0
			? undefined
			: `${warningCount} resource warning${warningCount === 1 ? "" : "s"}; run /resources for details`;
	const parts = [configWarning, resourceWarning].filter(
		(value): value is string => value !== undefined,
	);
	return parts.length === 0 ? undefined : parts.join(" · ");
}

function isExplicitCtrlM(data: string): boolean {
	return (
		data !== "\r" &&
		data !== "\n" &&
		parseKey(data) === Key.ctrl("m") &&
		matchesKey(data, Key.ctrl("m"))
	);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}
