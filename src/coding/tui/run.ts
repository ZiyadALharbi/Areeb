import {
	Key,
	matchesKey,
	ProcessTerminal,
	type Terminal,
} from "@earendil-works/pi-tui";
import type { AgentMessage, AgentRunStream } from "../../agent/types.ts";
import type { TuiEventAdapter } from "./adapter.ts";
import { type CreateTuiAppOptions, createTuiApp, type TuiApp } from "./app.ts";
import type { TuiCommandResult } from "./controller.ts";
import type { TuiState } from "./state.ts";
import { AREEB_DARK_THEME, type TuiTheme } from "./theme.ts";

export interface InteractiveController {
	readonly messages: readonly AgentMessage[];
	readonly metadata: { readonly id: string; readonly cwd: string };
	readonly model: string;
	readonly state: TuiState;
	readonly adapter: TuiEventAdapter;
	readonly isRunning: boolean;
	prompt(input: string): AgentRunStream;
	handleCommand(input: string): Promise<TuiCommandResult>;
	abort(): void;
	waitForIdle(): Promise<void>;
}

export interface InteractiveRunOptions {
	readonly terminal?: Terminal;
	readonly theme?: TuiTheme;
	readonly createApp?: (options: CreateTuiAppOptions) => TuiApp;
}

/** Run the controller's active session until the user quits the fullscreen TUI. */
export async function runInteractiveMode(
	controller: InteractiveController,
	options: InteractiveRunOptions = {},
): Promise<number> {
	const app = (options.createApp ?? createTuiApp)({
		terminal: options.terminal ?? new ProcessTerminal(),
		theme: options.theme ?? AREEB_DARK_THEME,
		transcript: [],
		shortcuts: "Ctrl+O:tools  │  Esc:interrupt  │  Ctrl+C:quit",
		state: controller.state,
	});

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
			const command = await controller.handleCommand(input);
			if (command.handled) {
				applyCommandResult(command, input, app, requestExit);
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
		if (
			input.trim().length === 0 ||
			submissionActive ||
			exitRequested ||
			controller.isRunning
		) {
			return;
		}
		// Lock synchronously because command dispatch may yield before prompt starts.
		submissionActive = true;
		abortRequested = false;
		controller.state.running = true;
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
	let terminalEvents = 0;
	for await (const event of stream) {
		if (event.type === "agent_end") {
			terminalEvents += 1;
			if (terminalEvents > 1) {
				throw new Error("Agent emitted more than one terminal event");
			}
		}
		if (adapter.apply(event)) {
			app.refresh(controller.state);
		}
	}
	await stream.result();
	if (terminalEvents === 0) {
		throw new Error("Agent stream ended without a terminal event");
	}
}

function applyCommandResult(
	result: Extract<TuiCommandResult, { readonly handled: true }>,
	input: string,
	app: TuiApp,
	requestExit: () => void,
): void {
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
		case "none":
			return;
	}
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
