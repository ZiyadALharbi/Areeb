import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Terminal,
	TuiInputListener,
	TuiInputListenerResult,
} from "@earendil-works/pi-tui";
import type {
	AgentEvent,
	AgentMessage,
	AgentRunStream,
	QueuedMessages,
} from "../../../src/agent/types.ts";
import { EventStream } from "../../../src/ai/event-stream.ts";
import type { ReasoningLevel, UserMessage } from "../../../src/ai/types.ts";
import { createDefaultCommandRegistry } from "../../../src/coding/commands.ts";
import type { ResourceDiagnostic } from "../../../src/coding/resources.ts";
import type { CodingSessionTuiService } from "../../../src/coding/session.ts";
import { TuiEventAdapter } from "../../../src/coding/tui/adapter.ts";
import type {
	CommandNoticeLevel,
	CreateTuiAppOptions,
	TuiApp,
} from "../../../src/coding/tui/app.ts";
import type {
	TuiCommandResult,
	TuiTransitionOutcome,
} from "../../../src/coding/tui/controller.ts";
import {
	copyTuiText,
	type InteractiveController,
	runInteractiveMode,
} from "../../../src/coding/tui/run.ts";
import {
	createTuiState,
	type TuiState,
} from "../../../src/coding/tui/state.ts";
import { AREEB_DARK_THEME } from "../../../src/coding/tui/theme.ts";

const restoredUser: UserMessage = {
	role: "user",
	content: [{ type: "text", text: "restored" }],
	timestamp: 1,
};

class CopyTerminal implements Terminal {
	readonly columns = 120;
	readonly rows = 32;
	readonly kittyProtocolActive = false;
	readonly writes: string[] = [];
	failWrites = false;

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		if (this.failWrites) {
			throw new Error("terminal unavailable");
		}
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

class ManualSession implements InteractiveController {
	readonly metadata = {
		id: "00000000-0000-4000-8000-000000000001",
		cwd: "/project",
	};
	readonly model = "fake-model";
	readonly provider = "fake";
	readonly resourceDiagnostics: ResourceDiagnostic[] = [];
	readonly completionCatalog = {
		commands: createDefaultCommandRegistry().list(),
		skillNames: ["review"],
		templateNames: ["explain"],
		availableCapabilities: [
			"session-controller",
			"model-selection",
			"tui",
		] as const,
		cwd: this.metadata.cwd,
		listSessions: async () => [],
		models: [
			{ provider: "fake", model: "fake-model" },
			{ provider: "other", model: "model-b" },
		],
	};
	state = createTuiState({
		sessionId: this.metadata.id,
		model: this.model,
		cwd: this.metadata.cwd,
		reasoning: "off",
	});
	adapter = new TuiEventAdapter(this.state);
	readonly promptCalls: string[] = [];
	readonly commandCalls: string[] = [];
	readonly followUpCalls: string[] = [];
	abortCount = 0;
	isRunning = false;
	commandHandler: (input: string) => Promise<TuiCommandResult> = async () => ({
		handled: false,
	});
	lastTuiService: CodingSessionTuiService | undefined;
	private stream: AgentRunStream | undefined;
	private idle = Promise.resolve();
	private resolveIdle: (() => void) | undefined;
	private followUps: AgentMessage[] = [];

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

	get queuedMessages(): QueuedMessages {
		return {
			steering: [],
			followUp: [...this.followUps],
			count: this.followUps.length,
		};
	}

	followUp(input: string): QueuedMessages {
		if (!this.isRunning) {
			throw new Error("idle");
		}
		this.followUpCalls.push(input);
		this.followUps.push({
			role: "user",
			content: [{ type: "text", text: input }],
			timestamp: 2,
		});
		return this.queuedMessages;
	}

	clearQueues(): QueuedMessages {
		this.followUps = [];
		return this.queuedMessages;
	}

	drainFollowUps(): void {
		this.followUps = [];
	}

	async listSessions() {
		return [];
	}

	async resumeSession(): Promise<TuiTransitionOutcome> {
		return { kind: "none" };
	}

	async setModel(): Promise<TuiTransitionOutcome> {
		return { kind: "none" };
	}

	async setReasoning(reasoning: ReasoningLevel): Promise<TuiTransitionOutcome> {
		this.state.reasoning = reasoning;
		return { kind: "none" };
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
		text: string;
		setText(text: string): void;
	};
	readonly started: () => number;
	readonly stopped: () => number;
	readonly listenerCount: () => number;
	readonly dismissedOverlays: () => number;
	readonly toolToggles: () => number;
	readonly paletteOpens: () => number;
	readonly completionAccepts: () => number;
	readonly sessionPickerOpens: () => number;
	readonly modelPickerOpens: () => number;
	readonly effortPickerOpens: () => number;
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
	let sessionPickerOpenCount = 0;
	let modelPickerOpenCount = 0;
	let effortPickerOpenCount = 0;
	const editor: {
		disableSubmit: boolean;
		onSubmit?: (text: string) => void;
		text: string;
		setText(text: string): void;
	} = {
		disableSubmit: false,
		text: "",
		setText(text) {
			this.text = text;
		},
	};
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
						editor.disableSubmit = state.inputMode === "locked";
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
				async openSessionPicker() {
					sessionPickerOpenCount += 1;
					return true;
				},
				openModelPicker() {
					modelPickerOpenCount += 1;
					return true;
				},
				openEffortPicker() {
					effortPickerOpenCount += 1;
					return true;
				},
				openThemePicker() {
					return true;
				},
				async setTheme() {
					return true;
				},
				dismissPicker() {
					return false;
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
		sessionPickerOpens: () => sessionPickerOpenCount,
		modelPickerOpens: () => modelPickerOpenCount,
		effortPickerOpens: () => effortPickerOpenCount,
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
		await Bun.sleep(1);
	}
	throw new Error("Condition did not settle");
}

describe("runInteractiveMode", () => {
	test("opens the inline effort picker for an idle effort command", async () => {
		const session = new ManualSession();
		session.commandHandler = async (input) => {
			if (input === "/effort") {
				return { handled: true, outcome: { kind: "effort-picker" } };
			}
			return { handled: true, outcome: { kind: "quit" } };
		};
		const app = createAppController();
		const running = runInteractiveMode(session, {
			createApp: app.createApp,
			theme: AREEB_DARK_THEME,
		});

		app.submit("/effort");
		await waitUntil(
			() => app.effortPickerOpens() === 1 && session.state.inputMode === "idle",
		);
		expect(session.promptCalls).toEqual([]);
		expect(session.followUpCalls).toEqual([]);

		app.submit("/quit");
		expect(await running).toBe(0);
	});

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
			theme: AREEB_DARK_THEME,
		});

		expect(controller.initialStates[0]?.items).toEqual([
			{ role: "user", text: "restored" },
		]);
		expect(controller.editor.disableSubmit).toBe(false);
		controller.submit("/help");
		controller.submit("ignored while command is pending");
		await waitUntil(() => controller.states.at(-1)?.inputMode === "idle");
		expect(session.commandCalls).toEqual(["/help"]);
		expect(session.lastTuiService?.getThemeName()).toBe("areeb-dark");
		expect(session.lastTuiService?.getThemeNames()).toEqual([
			"areeb-dark",
			"areeb-light",
		]);
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
		const running = runInteractiveMode(session, {
			createApp: app.createApp,
			theme: AREEB_DARK_THEME,
		});

		app.submit("/session");
		await waitUntil(
			() =>
				app.presentations.length === 1 && session.state.inputMode === "idle",
		);
		expect(session.state.items).toEqual([]);
		app.input("\u001b");
		expect(app.dismissedOverlays()).toBe(1);
		expect(session.abortCount).toBe(0);
		app.input("\u000f");
		expect(app.toolToggles()).toBe(1);

		app.submit("/quit");
		expect(await running).toBe(0);
	});

	test("shows one initial resource warning without adding a transcript item", async () => {
		const session = new ManualSession();
		session.resourceDiagnostics.push({
			kind: "skill",
			code: "validation-failed",
			severity: "warning",
			message: "Invalid skill",
		});
		session.commandHandler = async () => ({
			handled: true,
			outcome: { kind: "quit" },
		});
		const app = createAppController();
		const running = runInteractiveMode(session, {
			createApp: app.createApp,
			theme: AREEB_DARK_THEME,
		});

		expect(app.presentations).toEqual([
			{
				text: "1 resource warning; run /resources for details",
				level: "warning",
			},
		]);
		expect(session.state.items).toEqual([]);
		app.submit("/quit");
		expect(await running).toBe(0);
	});

	test("copies only assistant answers when thinking rows are present", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-thinking-copy-"));
		try {
			const session = new ManualSession();
			session.state.items.push(
				{ role: "thinking", text: "private reasoning" },
				{ role: "assistant", text: "public answer" },
			);
			session.commandHandler = async (input) =>
				input === "/copy"
					? { handled: true, outcome: { kind: "copy-last-assistant" } }
					: { handled: true, outcome: { kind: "quit" } };
			const terminal = new CopyTerminal();
			const app = createAppController();
			const userRoot = join(directory, "user");
			const running = runInteractiveMode(session, {
				createApp: app.createApp,
				theme: AREEB_DARK_THEME,
				terminal,
				userRoot,
			});

			app.submit("/copy");
			await waitUntil(() => session.state.inputMode === "idle");
			expect(await readFile(join(userRoot, "last-copy.txt"), "utf8")).toBe(
				"public answer",
			);
			expect(terminal.writes.join("\n")).toContain(
				Buffer.from("public answer").toString("base64"),
			);
			expect(terminal.writes.join("\n")).not.toContain(
				Buffer.from("private reasoning").toString("base64"),
			);
			expect(app.presentations).toContainEqual({
				text: "Copied",
				level: "info",
			});

			app.submit("/quit");
			expect(await running).toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("opens the shared palette and consumes Enter only when completion changes", async () => {
		const session = new ManualSession();
		session.commandHandler = async () => ({
			handled: true,
			outcome: { kind: "quit" },
		});
		const app = createAppController();
		const running = runInteractiveMode(session, {
			createApp: app.createApp,
			theme: AREEB_DARK_THEME,
		});

		expect(app.input("\u0010")).toEqual({ consume: true });
		expect(app.paletteOpens()).toBe(1);
		expect(app.input("\u001b")).toEqual({ consume: true });
		expect(session.abortCount).toBe(0);
		expect(app.input("\u0013")).toEqual({ consume: true });
		expect(app.sessionPickerOpens()).toBe(1);
		expect(app.input("\u001b[109;5u")).toEqual({ consume: true });
		expect(app.modelPickerOpens()).toBe(1);

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

	test("queues live submissions without dispatching commands or starting another prompt", async () => {
		const session = new ManualSession();
		session.commandHandler = async (input) =>
			input === "/quit"
				? { handled: true, outcome: { kind: "quit" } }
				: { handled: false };
		const app = createAppController();
		const running = runInteractiveMode(session, {
			createApp: app.createApp,
			theme: AREEB_DARK_THEME,
		});

		app.submit("first");
		await waitUntil(() => session.promptCalls.length === 1);
		expect(app.editor.disableSubmit).toBe(false);
		app.submit("/new");
		app.submit("   ");
		expect(session.promptCalls).toEqual(["first"]);
		expect(session.commandCalls).toEqual(["first"]);
		expect(session.followUpCalls).toEqual(["/new"]);
		expect(session.state.queuedCount).toBe(1);

		session.drainFollowUps();
		session.emit({ type: "turn_start" });
		await waitUntil(() => session.state.queuedCount === 0);
		session.emit({ type: "agent_end", messages: [], reason: "completed" });
		session.complete();
		await waitUntil(() => session.state.inputMode === "idle");

		app.submit("/quit");
		expect(await running).toBe(0);
	});

	test("shows blocked effort commands during a response without queuing model input", async () => {
		const session = new ManualSession();
		session.commandHandler = async (input) => {
			if (input.startsWith("/effort")) {
				return {
					handled: true,
					outcome: {
						kind: "message",
						level: "warning",
						text: "Cannot change thinking effort while the current session is running",
					},
				};
			}
			if (input === "/quit") {
				return { handled: true, outcome: { kind: "quit" } };
			}
			return { handled: false };
		};
		const app = createAppController();
		const running = runInteractiveMode(session, {
			createApp: app.createApp,
			theme: AREEB_DARK_THEME,
		});

		app.submit("first");
		await waitUntil(() => session.promptCalls.length === 1);
		app.submit("/effort max");
		await waitUntil(
			() =>
				session.commandCalls.includes("/effort max") &&
				app.presentations.at(-1)?.text ===
					"Cannot change thinking effort while the current session is running",
		);
		expect(session.followUpCalls).toEqual([]);
		expect(session.promptCalls).toEqual(["first"]);
		expect(app.presentations.at(-1)).toEqual({
			text: "Cannot change thinking effort while the current session is running",
			level: "warning",
		});

		app.input("\u0003");
		session.emit({ type: "agent_end", messages: [], reason: "aborted" });
		session.complete();
		expect(await running).toBe(0);
	});

	test("restores a live draft after enqueue failure", async () => {
		const session = new ManualSession();
		const app = createAppController();
		const running = runInteractiveMode(session, {
			createApp: app.createApp,
			theme: AREEB_DARK_THEME,
		});

		app.submit("first");
		await waitUntil(() => session.promptCalls.length === 1);
		session.followUp = () => {
			throw new Error("queue unavailable");
		};
		app.submit("keep this draft");
		expect(app.editor.text).toBe("keep this draft");
		expect(app.presentations.at(-1)).toEqual({
			text: "Failed to queue follow-up: queue unavailable",
			level: "error",
		});

		app.input("\u0003");
		session.emit({ type: "agent_end", messages: [], reason: "aborted" });
		session.complete();
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
					reasoning: "off",
				});
				session.adapter = new TuiEventAdapter(session.state);
				session.adapter.restore([restoredUser]);
				return { handled: true, outcome: { kind: "none" } };
			}
			return { handled: true, outcome: { kind: "quit" } };
		};
		const app = createAppController();
		const running = runInteractiveMode(session, {
			createApp: app.createApp,
			theme: AREEB_DARK_THEME,
		});

		app.submit("/switch");
		await waitUntil(
			() =>
				app.states.at(-1)?.sessionId ===
					"00000000-0000-4000-8000-000000000002" &&
				app.states.at(-1)?.inputMode === "idle",
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
			theme: AREEB_DARK_THEME,
		});

		controller.submit("hello");
		await waitUntil(() => session.promptCalls.length === 1);
		controller.submit("queued follow-up");
		expect(session.state.queuedCount).toBe(1);
		controller.editor.setText("unfinished draft");
		controller.input("\u001b");
		controller.input("\u001b");
		controller.input("\u0003");
		expect(session.abortCount).toBe(1);
		expect(controller.editor.text).toBe("unfinished draft");
		expect(controller.stopped()).toBe(0);

		session.emit({ type: "agent_start" });
		session.emit({ type: "agent_end", messages: [], reason: "aborted" });
		session.complete();
		expect(await running).toBe(0);
		expect(controller.states.at(-1)?.items.at(-1)).toEqual({
			role: "status",
			text: "Interrupted",
		});
		expect(session.state.queuedCount).toBe(0);
		expect(controller.stopped()).toBe(1);
		expect(controller.listenerCount()).toBe(0);
	});

	test("stops and rejects when the stream has no terminal event", async () => {
		const session = new ManualSession();
		const controller = createAppController();
		const running = runInteractiveMode(session, {
			createApp: controller.createApp,
			theme: AREEB_DARK_THEME,
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

describe("copyTuiText", () => {
	test("always overwrites a private backup even when OSC 52 fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-copy-"));
		try {
			const backupPath = join(directory, "user", "last-copy.txt");
			const terminal = new CopyTerminal();
			const first = await copyTuiText(terminal, backupPath, "first π");

			expect(first).toEqual({
				osc52Sent: true,
				backupSaved: true,
				backupPath,
			});
			expect(terminal.writes[0]).toBe(
				`\u001b]52;c;${Buffer.from("first π").toString("base64")}\u0007`,
			);
			expect(await readFile(backupPath, "utf8")).toBe("first π");
			expect((await stat(join(directory, "user"))).mode & 0o777).toBe(0o700);
			expect((await stat(backupPath)).mode & 0o777).toBe(0o600);

			terminal.failWrites = true;
			expect(
				await copyTuiText(terminal, backupPath, "replacement"),
			).toMatchObject({
				osc52Sent: false,
				backupSaved: true,
				error: "terminal unavailable",
			});
			expect(await readFile(backupPath, "utf8")).toBe("replacement");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
