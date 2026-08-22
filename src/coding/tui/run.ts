import {
	Key,
	matchesKey,
	ProcessTerminal,
	type Terminal,
} from "@earendil-works/pi-tui";
import type { AgentMessage, AgentRunStream } from "../../agent/types.ts";
import type { CommandResult } from "../commands.ts";
import { TuiEventAdapter } from "./adapter.ts";
import { type CreateTuiAppOptions, createTuiApp, type TuiApp } from "./app.ts";
import { createTuiState, type TuiState } from "./state.ts";
import { AREEB_DARK_THEME, type TuiTheme } from "./theme.ts";

export interface InteractiveSession {
	readonly messages: readonly AgentMessage[];
	readonly metadata: { readonly cwd: string };
	readonly model: string;
	readonly isRunning: boolean;
	prompt(input: string): AgentRunStream;
	handleCommand(input: string): Promise<CommandResult>;
	abort(): void;
	waitForIdle(): Promise<void>;
}

export interface InteractiveRunOptions {
	readonly terminal?: Terminal;
	readonly theme?: TuiTheme;
	readonly createApp?: (options: CreateTuiAppOptions) => TuiApp;
}

/** Run one CodingSession until the user quits the fullscreen TUI. */
export async function runInteractiveMode(
	session: InteractiveSession,
	options: InteractiveRunOptions = {},
): Promise<number> {
	const state = createTuiState();
	const adapter = new TuiEventAdapter(state);
	adapter.restore(session.messages);

	const app = (options.createApp ?? createTuiApp)({
		terminal: options.terminal ?? new ProcessTerminal(),
		theme: options.theme ?? AREEB_DARK_THEME,
		transcript: [],
		shortcuts: "Esc:interrupt  │  Ctrl+C:quit",
		state,
		model: session.model,
		cwd: session.metadata.cwd,
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
		if (abortRequested || !session.isRunning) {
			return;
		}
		abortRequested = true;
		session.abort();
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
			const command = await session.handleCommand(input);
			if (command.handled) {
				applyCommandResult(command, input, state, requestExit);
				app.refresh(state);
			} else if (!exitRequested) {
				await consumePrompt(session, input, adapter, app, state);
			}
		} catch (error) {
			failure = error;
		}

		try {
			await session.waitForIdle();
		} catch (error) {
			failure ??= error;
		}

		state.running = false;
		submissionActive = false;
		try {
			app.refresh(state);
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
			session.isRunning
		) {
			return;
		}
		// Lock synchronously because command dispatch may yield before prompt starts.
		submissionActive = true;
		abortRequested = false;
		state.running = true;
		delete state.terminalReason;
		try {
			app.refresh(state);
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
			requestAbort();
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
	session: InteractiveSession,
	input: string,
	adapter: TuiEventAdapter,
	app: TuiApp,
	state: TuiState,
): Promise<void> {
	const stream = session.prompt(input);
	let terminalEvents = 0;
	for await (const event of stream) {
		if (event.type === "agent_end") {
			terminalEvents += 1;
			if (terminalEvents > 1) {
				throw new Error("Agent emitted more than one terminal event");
			}
		}
		if (adapter.apply(event)) {
			app.refresh(state);
		}
	}
	await stream.result();
	if (terminalEvents === 0) {
		throw new Error("Agent stream ended without a terminal event");
	}
}

function applyCommandResult(
	result: Extract<CommandResult, { readonly handled: true }>,
	input: string,
	state: TuiState,
	requestExit: () => void,
): void {
	switch (result.outcome.kind) {
		case "message":
			state.items.push({
				role: result.outcome.level === "error" ? "error" : "status",
				text: result.outcome.text,
			});
			return;
		case "unavailable": {
			const command = input.trim().split(/\s/, 1)[0] ?? "Command";
			state.items.push({
				role: "status",
				text: `${command} is planned (${result.outcome.missingCapability})`,
			});
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
