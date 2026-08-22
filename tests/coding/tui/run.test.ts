import { describe, expect, test } from "bun:test";
import type {
	TuiInputListener,
	TuiInputListenerResult,
} from "@earendil-works/pi-tui";
import type {
	AgentEvent,
	AgentMessage,
	AgentRunStream,
} from "../../../src/agent/types.ts";
import { EventStream } from "../../../src/ai/event-stream.ts";
import type { UserMessage } from "../../../src/ai/types.ts";
import { createDefaultCommandRegistry } from "../../../src/coding/commands.ts";
import type { CodingSessionTuiService } from "../../../src/coding/session.ts";
import { TuiEventAdapter } from "../../../src/coding/tui/adapter.ts";
import type {
	CommandNoticeLevel,
	CreateTuiAppOptions,
	TuiApp,
} from "../../../src/coding/tui/app.ts";
import type { TuiCommandResult } from "../../../src/coding/tui/controller.ts";
import {
	type InteractiveController,
	runInteractiveMode,
} from "../../../src/coding/tui/run.ts";
import {
	createTuiState,
	type TuiState,
} from "../../../src/coding/tui/state.ts";

const restoredUser: UserMessage = {
	role: "user",
	content: [{ type: "text", text: "restored" }],
	timestamp: 1,
};

class ManualSession implements InteractiveController {
	readonly metadata = {
		id: "00000000-0000-4000-8000-000000000001",
		cwd: "/project",
	};
	readonly model = "fake-model";
	readonly completionCatalog = {
		commands: createDefaultCommandRegistry().list(),
		skillNames: ["review"],
		templateNames: ["explain"],
		availableCapabilities: ["session-controller", "tui"] as const,
		cwd: this.metadata.cwd,
	};
	state = createTuiState({
		sessionId: this.metadata.id,
		model: this.model,
		cwd: this.metadata.cwd,
	});
	adapter = new TuiEventAdapter(this.state);
	readonly promptCalls: string[] = [];
	readonly commandCalls: string[] = [];
	abortCount = 0;
	isRunning = false;
	commandHandler: (input: string) => Promise<TuiCommandResult> = async () => ({
		handled: false,
	});
	lastTuiService: CodingSessionTuiService | undefined;
	private stream: AgentRunStream | undefined;
	private idle = Promise.resolve();
	private resolveIdle: (() => void) | undefined;

	constructor(readonly messages: readonly AgentMessage[] = []) {
		this.adapter.restore(messages);
	}

	async handleCommand(
		input: string,
		tuiService?: CodingSessionTuiService,
	): Promise<TuiCommandResult> {
		this.commandCalls.push(input);
		this.lastTuiService = tuiService;
		return this.commandHandler(input);
	}

	prompt(input: string): AgentRunStream {
		this.promptCalls.push(input);
		this.isRunning = true;
		this.idle = new Promise<void>((resolve) => {
			this.resolveIdle = resolve;
		});
		this.stream = new EventStream<AgentEvent, AgentMessage[]>(
			() => false,
			() => [],
		);
		return this.stream;
	}

	emit(event: AgentEvent): void {
		this.requireStream().push(event);
	}

	complete(): void {
		const stream = this.requireStream();
		this.isRunning = false;
		this.resolveIdle?.();
		this.resolveIdle = undefined;
		stream.end([]);
	}

	abort(): void {
		this.abortCount += 1;
	}

	waitForIdle(): Promise<void> {
		return this.idle;
	}

	private requireStream(): AgentRunStream {
		if (this.stream === undefined) {
			throw new Error("Prompt has not started");
		}
		return this.stream;
	}
}

function createAppController(): {
	readonly createApp: (options: CreateTuiAppOptions) => TuiApp;
	readonly states: TuiState[];
	readonly initialStates: TuiState[];
	readonly presentations: Array<{
		readonly text: string;
		readonly level: CommandNoticeLevel;
	}>;
	readonly editor: {
		disableSubmit: boolean;
		onSubmit?: (text: string) => void;
	};
	readonly started: () => number;
	readonly stopped: () => number;
	readonly listenerCount: () => number;
	readonly dismissedOverlays: () => number;
	readonly toolToggles: () => number;
	readonly paletteOpens: () => number;
	readonly completionAccepts: () => number;
	setInlineCompletion(open: boolean, changes?: boolean): void;
	submit(text: string): void;
	input(data: string): TuiInputListenerResult | undefined;
} {
	let inputListener: TuiInputListener | undefined;
	let startCount = 0;
	let stopCount = 0;
	const states: TuiState[] = [];
	const initialStates: TuiState[] = [];
	const presentations: Array<{
		readonly text: string;
		readonly level: CommandNoticeLevel;
	}> = [];
	let overlayOpen = false;
	let dismissedOverlayCount = 0;
	let toolToggleCount = 0;
	let paletteOpen = false;
	let paletteOpenCount = 0;
	let inlineCompletionOpen = false;
	let inlineCompletionChanges = false;
	let completionAcceptCount = 0;
	const editor: {
		disableSubmit: boolean;
		onSubmit?: (text: string) => void;
	} = { disableSubmit: false };
	const tui = {
		start() {
			startCount += 1;
		},
		stop() {
			stopCount += 1;
		},
		addInputListener(listener: TuiInputListener) {
			inputListener = listener;
			return () => {
				if (inputListener === listener) {
					inputListener = undefined;
				}
			};
		},
	};

	return {
		createApp(options) {
			if (options.state !== undefined) {
				initialStates.push(structuredClone(options.state));
			}
			return {
				tui,
				editor,
				refresh(state?: TuiState) {
					if (state !== undefined) {
						states.push(structuredClone(state));
						editor.disableSubmit = state.running;
					}
				},
				presentCommand(text: string, level: CommandNoticeLevel) {
					presentations.push({ text, level });
					overlayOpen = text.includes("\n");
				},
				clearCommandPresentation() {
					overlayOpen = false;
				},
				dismissCommandOverlay() {
					if (!overlayOpen) {
						return false;
					}
					overlayOpen = false;
					dismissedOverlayCount += 1;
					return true;
				},
				openCommandPalette() {
					paletteOpen = true;
					paletteOpenCount += 1;
					return true;
				},
				dismissCommandPalette() {
					if (!paletteOpen) {
						return false;
					}
					paletteOpen = false;
					return true;
				},
				dismissInlineCompletion() {
					if (!inlineCompletionOpen) {
						return false;
					}
					inlineCompletionOpen = false;
					return true;
				},
				acceptInlineCompletion() {
					completionAcceptCount += 1;
					if (!inlineCompletionOpen) {
						return false;
					}
					inlineCompletionOpen = false;
					return inlineCompletionChanges;
				},
				toggleToolPreviews() {
					toolToggleCount += 1;
				},
			} as unknown as TuiApp;
		},
		states,
		initialStates,
		presentations,
		editor,
		started: () => startCount,
		stopped: () => stopCount,
		listenerCount: () => (inputListener === undefined ? 0 : 1),
		dismissedOverlays: () => dismissedOverlayCount,
		toolToggles: () => toolToggleCount,
		paletteOpens: () => paletteOpenCount,
		completionAccepts: () => completionAcceptCount,
		setInlineCompletion(open, changes = false) {
			inlineCompletionOpen = open;
			inlineCompletionChanges = changes;
		},
		submit(text) {
			editor.onSubmit?.(text);
		},
		input(data) {
			return inputListener?.(data);
		},
	};
}

async function waitUntil(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (condition()) {
			return;
		}
		await Promise.resolve();
	}
	throw new Error("Condition did not settle");
}

describe("runInteractiveMode", () => {
	test("restores before input and keeps command output local", async () => {
		const session = new ManualSession([restoredUser]);
		session.commandHandler = async (input) =>
			input === "/quit"
				? { handled: true, outcome: { kind: "quit" } }
				: {
						handled: true,
						outcome: { kind: "message", level: "info", text: "local help" },
					};
		const controller = createAppController();
		const running = runInteractiveMode(session, {
			createApp: controller.createApp,
		});

		expect(controller.initialStates[0]?.items).toEqual([
			{ role: "user", text: "restored" },
		]);
		expect(controller.editor.disableSubmit).toBe(false);
		controller.submit("/help");
		controller.submit("ignored while command is pending");
		await waitUntil(() => controller.states.at(-1)?.running === false);
		expect(session.commandCalls).toEqual(["/help"]);
		expect(session.lastTuiService?.getThemeName()).toBe("areeb-dark");
		expect(
			session.lastTuiService
				?.getHotkeys()
				.some((hotkey) => hotkey.keys === "Ctrl+P"),
		).toBe(true);
		expect(session.promptCalls).toEqual([]);
		expect(controller.states.at(-1)?.items).toEqual([
			{ role: "user", text: "restored" },
		]);
		expect(controller.presentations).toEqual([
			{ text: "local help", level: "info" },
		]);

		controller.submit("/quit");
		expect(await running).toBe(0);
		expect(controller.started()).toBe(1);
		expect(controller.stopped()).toBe(1);
		expect(controller.listenerCount()).toBe(0);
	});

	test("dismisses command overlays before aborting and toggles tool previews", async () => {
		const session = new ManualSession();
		session.commandHandler = async (input) =>
			input === "/quit"
				? { handled: true, outcome: { kind: "quit" } }
				: {
						handled: true,
						outcome: {
							kind: "message",
							level: "info",
							text: "Session ID: one\nModel: fake-model",
						},
					};
		const app = createAppController();
		const running = runInteractiveMode(session, { createApp: app.createApp });

		app.submit("/session");
		await waitUntil(() => app.presentations.length === 1);
		expect(session.state.items).toEqual([]);
		app.input("\u001b");
		expect(app.dismissedOverlays()).toBe(1);
		expect(session.abortCount).toBe(0);
		app.input("\u000f");
		expect(app.toolToggles()).toBe(1);

		app.submit("/quit");
		expect(await running).toBe(0);
	});

	test("opens the shared palette and consumes Enter only when completion changes", async () => {
		const session = new ManualSession();
		session.commandHandler = async () => ({
			handled: true,
			outcome: { kind: "quit" },
		});
		const app = createAppController();
		const running = runInteractiveMode(session, { createApp: app.createApp });

		expect(app.input("\u0010")).toEqual({ consume: true });
		expect(app.paletteOpens()).toBe(1);
		expect(app.input("\u001b")).toEqual({ consume: true });
		expect(session.abortCount).toBe(0);

		app.setInlineCompletion(true, true);
		expect(app.input("\r")).toEqual({ consume: true });
		expect(app.completionAccepts()).toBe(1);
		expect(session.commandCalls).toEqual([]);
		app.setInlineCompletion(true, false);
		expect(app.input("\r")).toBeUndefined();
		expect(app.completionAccepts()).toBe(2);

		app.submit("/quit");
		expect(await running).toBe(0);
	});

	test("refreshes from a replacement controller bundle after a command", async () => {
		const session = new ManualSession();
		session.commandHandler = async (input) => {
			if (input === "/switch") {
				session.state = createTuiState({
					sessionId: "00000000-0000-4000-8000-000000000002",
					model: "replacement-model",
					cwd: "/project",
				});
				session.adapter = new TuiEventAdapter(session.state);
				session.adapter.restore([restoredUser]);
				return { handled: true, outcome: { kind: "none" } };
			}
			return { handled: true, outcome: { kind: "quit" } };
		};
		const app = createAppController();
		const running = runInteractiveMode(session, { createApp: app.createApp });

		app.submit("/switch");
		await waitUntil(
			() =>
				app.states.at(-1)?.sessionId ===
					"00000000-0000-4000-8000-000000000002" &&
				app.states.at(-1)?.running === false,
		);
		expect(app.states.at(-1)).toMatchObject({
			model: "replacement-model",
			items: [{ role: "user", text: "restored" }],
		});

		app.submit("/quit");
		expect(await running).toBe(0);
	});

	test("aborts once and waits for stream settlement before Ctrl+C exits", async () => {
		const session = new ManualSession();
		const controller = createAppController();
		const running = runInteractiveMode(session, {
			createApp: controller.createApp,
		});

		controller.submit("hello");
		await waitUntil(() => session.promptCalls.length === 1);
		controller.input("\u001b");
		controller.input("\u001b");
		controller.input("\u0003");
		expect(session.abortCount).toBe(1);
		expect(controller.stopped()).toBe(0);

		session.emit({ type: "agent_start" });
		session.emit({ type: "agent_end", messages: [], reason: "aborted" });
		session.complete();
		expect(await running).toBe(0);
		expect(controller.states.at(-1)?.items.at(-1)).toEqual({
			role: "status",
			text: "Interrupted",
		});
		expect(controller.stopped()).toBe(1);
		expect(controller.listenerCount()).toBe(0);
	});

	test("stops and rejects when the stream has no terminal event", async () => {
		const session = new ManualSession();
		const controller = createAppController();
		const running = runInteractiveMode(session, {
			createApp: controller.createApp,
		});

		controller.submit("hello");
		await waitUntil(() => session.promptCalls.length === 1);
		session.complete();
		await expect(running).rejects.toThrow(
			"Agent stream ended without a terminal event",
		);
		expect(controller.states.at(-1)?.items.at(-1)).toEqual({
			role: "error",
			text: "Agent stream ended without a terminal event",
		});
		expect(controller.stopped()).toBe(1);
		expect(controller.listenerCount()).toBe(0);
	});
});
