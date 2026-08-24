import { describe, expect, test } from "bun:test";
import {
	stripTerminalSequences,
	type Terminal,
	VStack,
} from "@earendil-works/pi-tui";
import type { CommandSessionListItem } from "../../../src/coding/commands.ts";
import {
	type CreateTuiAppOptions,
	createTuiApp,
} from "../../../src/coding/tui/app.ts";
import { createTuiState } from "../../../src/coding/tui/state.ts";
import {
	AREEB_DARK_THEME,
	AREEB_LIGHT_THEME,
} from "../../../src/coding/tui/theme.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

class TestTerminal implements Terminal {
	readonly columns = 120;
	readonly rows = 32;
	readonly kittyProtocolActive = false;

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

function appOptions(
	overrides: Partial<CreateTuiAppOptions> = {},
): CreateTuiAppOptions {
	const state = createTuiState({
		sessionId: SESSION_ID,
		model: "model-a",
		cwd: "/project",
		reasoning: "off",
	});
	return {
		terminal: new TestTerminal(),
		theme: AREEB_DARK_THEME,
		transcript: [],
		shortcuts: {
			idle: "idle shortcuts",
			menu: "menu shortcuts",
			running: "running shortcuts",
		},
		getCompletionCatalog: () => ({
			commands: [],
			skillNames: [],
			templateNames: [],
			availableCapabilities: [],
			cwd: "/project",
			listSessions: async () => [],
			models: [],
		}),
		listSessions: async () => [],
		getModels: () => [{ provider: "fake", model: "model-a" }],
		getCurrentModel: () => ({ provider: "fake", model: "model-a" }),
		onResume: async () => true,
		onSetModel: async () => true,
		onSetEffort: async () => true,
		state,
		...overrides,
	};
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("createTuiApp pickers", () => {
	test("renders the effort selector inline and restores the exact draft and focus", async () => {
		const selected: string[] = [];
		const state = createTuiState({
			sessionId: SESSION_ID,
			model: "model-a",
			cwd: "/project",
			reasoning: "high",
		});
		const app = createTuiApp(
			appOptions({
				state,
				async onSetEffort(effort) {
					selected.push(effort);
					return true;
				},
			}),
		);
		app.editor.setText("  exact draft\nsecond line  ");

		expect(app.openEffortPicker()).toBe(true);
		expect(app.tui.hasOverlay()).toBe(false);
		const picker = app.tui.getFocusedComponent();
		expect(picker).not.toBe(app.editor);
		const rendered = stripTerminalSequences(
			picker?.render(80).join("\n") ?? "",
		);
		for (const label of ["off", "low", "medium", "high", "xhigh", "max"]) {
			expect(
				rendered.split("\n").some((line) => line.trim().endsWith(label)),
			).toBe(true);
		}
		expect(rendered.split("\n")).toHaveLength(6);
		expect(rendered).not.toContain("Filter:");
		expect(rendered).not.toContain("Thinking effort");
		expect(rendered).not.toMatch(/[┌┐└┘╭╮╰╯]/);

		picker?.handleInput?.("\u001b");
		expect(app.tui.getFocusedComponent()).toBe(app.editor);
		expect(app.editor.getText()).toBe("  exact draft\nsecond line  ");

		expect(app.openEffortPicker()).toBe(true);
		app.tui.getFocusedComponent()?.handleInput?.("\r");
		await flush();
		expect(selected).toEqual(["high"]);
		expect(app.tui.hasOverlay()).toBe(false);
		expect(app.tui.getFocusedComponent()).toBe(app.editor);
		expect(app.editor.getText()).toBe("  exact draft\nsecond line  ");
	});

	test("keeps a failed effort selector open and safely replaces it with other pickers", async () => {
		const failing = createTuiApp(
			appOptions({
				async onSetEffort() {
					throw new Error("effort storage failed");
				},
			}),
		);
		failing.editor.setText("preserved");
		expect(failing.openEffortPicker()).toBe(true);
		const picker = failing.tui.getFocusedComponent();
		picker?.handleInput?.("\r");
		await flush();
		expect(failing.tui.hasOverlay()).toBe(false);
		expect(failing.tui.getFocusedComponent()).toBe(picker);
		expect(failing.editor.getText()).toBe("preserved");
		expect(
			stripTerminalSequences(failing.tui.render(100).join("\n")),
		).toContain("effort storage failed");

		expect(failing.openModelPicker()).toBe(true);
		expect(failing.tui.hasOverlay()).toBe(true);
		expect(failing.dismissPicker()).toBe(true);
		expect(failing.tui.getFocusedComponent()).toBe(failing.editor);
		expect(failing.editor.getText()).toBe("preserved");

		expect(failing.openEffortPicker()).toBe(true);
		failing.refresh(
			createTuiState({
				sessionId: "00000000-0000-4000-8000-000000000002",
				model: "model-b",
				cwd: "/project",
				reasoning: "max",
			}),
		);
		expect(failing.tui.getFocusedComponent()).toBe(failing.editor);
		expect(failing.editor.getText()).toBe("preserved");
	});

	test("ignores stale async session results after a newer picker opens", async () => {
		let resolveSessions!: (sessions: readonly CommandSessionListItem[]) => void;
		const sessions = new Promise<readonly CommandSessionListItem[]>(
			(resolve) => {
				resolveSessions = resolve;
			},
		);
		const app = createTuiApp(
			appOptions({
				listSessions: () => sessions,
				getModels: () => [
					{ provider: "fake", model: "model-a" },
					{ provider: "other", model: "model-b" },
				],
			}),
		);

		const openingSessions = app.openSessionPicker();
		expect(app.openModelPicker()).toBe(true);
		resolveSessions([
			{
				id: SESSION_ID,
				title: "Stored",
				model: { provider: "fake", model: "model-a" },
			},
		]);
		expect(await openingSessions).toBe(false);
		expect(app.tui.hasOverlay()).toBe(true);
		expect(app.dismissPicker()).toBe(true);
		expect(app.tui.getFocusedComponent()).toBe(app.editor);
	});

	test("keeps one selection active, restores focus, and preserves the draft", async () => {
		let resolveSelection!: (close: boolean) => void;
		const selection = new Promise<boolean>((resolve) => {
			resolveSelection = resolve;
		});
		const selected: string[] = [];
		const app = createTuiApp(
			appOptions({
				listSessions: async () => [
					{
						id: SESSION_ID,
						title: "Stored session",
						model: { provider: "fake", model: "model-a" },
					},
				],
				onResume: async (id) => {
					selected.push(id);
					return selection;
				},
			}),
		);
		app.editor.setText("preserved draft");
		expect(await app.openSessionPicker()).toBe(true);
		const picker = app.tui.getFocusedComponent();
		expect(picker).not.toBe(app.editor);
		picker?.handleInput?.("\r");
		picker?.handleInput?.("\r");
		expect(selected).toEqual([SESSION_ID]);

		resolveSelection(true);
		await flush();
		expect(app.tui.hasOverlay()).toBe(false);
		expect(app.tui.getFocusedComponent()).toBe(app.editor);
		expect(app.editor.getText()).toBe("preserved draft");
	});

	test("renders framed filterable rows and contextual running status", () => {
		const state = createTuiState({
			sessionId: SESSION_ID,
			model: "model-a",
			cwd: "/project",
			reasoning: "off",
		});
		const app = createTuiApp(
			appOptions({
				state,
				getModels: () => [
					{ provider: "fake", model: "model-a" },
					{ provider: "other", model: "model-b" },
				],
			}),
		);

		expect(app.openModelPicker()).toBe(true);
		const picker = app.tui.getFocusedComponent();
		expect(picker).not.toBe(app.editor);
		const pickerOutput = stripTerminalSequences(
			picker?.render(100).join("\n") ?? "",
		);
		expect(pickerOutput).toContain("Models");
		expect(pickerOutput).toContain("Search  Type to filter");
		expect(pickerOutput).toContain("model-a");
		expect(pickerOutput).toContain("fake");
		expect(pickerOutput).toMatch(/[╭╮╰╯]/);
		expect(stripTerminalSequences(app.tui.render(100).join("\n"))).toContain(
			"menu shortcuts",
		);

		app.dismissPicker();
		state.running = true;
		state.inputMode = "running";
		state.queuedCount = 2;
		app.refresh(state);
		const output = stripTerminalSequences(app.tui.render(100).join("\n"));
		expect(output).toContain("running shortcuts");
		expect(output).toContain("2 queued");
		expect(app.editor.disableSubmit).toBe(false);
	});

	test("previews, reverts, commits, and recovers failed theme selections", async () => {
		const saved: string[] = [];
		const app = createTuiApp(
			appOptions({
				themes: [AREEB_DARK_THEME, AREEB_LIGHT_THEME],
				async onSetTheme(theme) {
					saved.push(theme);
				},
			}),
		);
		app.editor.setText("preserved draft");
		const darkBorder = app.editor.borderColor("border");

		expect(app.openThemePicker()).toBe(true);
		app.tui.getFocusedComponent()?.handleInput?.("\u001b[B");
		expect(app.editor.borderColor("border")).not.toBe(darkBorder);
		expect(app.dismissPicker()).toBe(true);
		expect(app.editor.borderColor("border")).toBe(darkBorder);

		expect(app.openThemePicker()).toBe(true);
		app.tui.getFocusedComponent()?.handleInput?.("\u001b[B");
		app.tui.getFocusedComponent()?.handleInput?.("\r");
		await flush();
		expect(saved).toEqual(["areeb-light"]);
		expect(app.tui.hasOverlay()).toBe(false);
		expect(app.editor.borderColor("border")).not.toBe(darkBorder);
		expect(app.editor.getText()).toBe("preserved draft");

		const failing = createTuiApp(
			appOptions({
				themes: [AREEB_DARK_THEME, AREEB_LIGHT_THEME],
				async onSetTheme() {
					throw new Error("storage failed");
				},
			}),
		);
		const originalBorder = failing.editor.borderColor("border");
		failing.openThemePicker();
		failing.tui.getFocusedComponent()?.handleInput?.("\u001b[B");
		failing.tui.getFocusedComponent()?.handleInput?.("\r");
		await flush();
		expect(failing.tui.hasOverlay()).toBe(true);
		expect(failing.editor.borderColor("border")).toBe(originalBorder);
	});

	test("shows honest last-response usage in the footer", () => {
		const state = createTuiState({
			sessionId: SESSION_ID,
			model: "model-a",
			cwd: "/project",
			reasoning: "off",
		});
		state.lastUsage = {
			inputTokens: 12_400,
			outputTokens: 860,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 13_260,
		};
		const app = createTuiApp(appOptions({ state }));
		const output = stripTerminalSequences(app.tui.render(120).join("\n"));

		expect(output).toContain("Last · 12.4k in · 860 out");
		expect(output).not.toContain("%");
	});

	test("shows the exact thinking level in wide and narrow footers", () => {
		const state = createTuiState({
			sessionId: SESSION_ID,
			model: "model-a",
			cwd: "/project",
			reasoning: "off",
		});
		const app = createTuiApp(appOptions({ state }));

		expect(stripTerminalSequences(app.tui.render(120).join("\n"))).toContain(
			"model-a · effort off",
		);
		state.reasoning = "high";
		app.refresh(state);
		expect(stripTerminalSequences(app.tui.render(32).join("\n"))).toContain(
			"model-a · effort high",
		);
		state.reasoning = "max";
		app.refresh(state);
		expect(stripTerminalSequences(app.tui.render(24).join("\n"))).toContain(
			"model-a · effort max",
		);
	});

	test("reconciles a same-session refresh without clearing the transcript", () => {
		const state = createTuiState({
			sessionId: SESSION_ID,
			model: "model-a",
			cwd: "/project",
			reasoning: "off",
		});
		state.items.push({ role: "user", text: "stable" });
		const app = createTuiApp(appOptions({ state }));
		const originalClear = VStack.prototype.clear;
		let clearCount = 0;
		VStack.prototype.clear = function clear(): void {
			clearCount += 1;
			originalClear.call(this);
		};

		try {
			state.assistantBuffer = "streaming";
			app.refresh(state);
			state.assistantBuffer = "streaming delta";
			app.refresh(state);
			// Status and shortcut stacks are redrawn once per refresh; the transcript is not.
			expect(clearCount).toBe(4);
		} finally {
			VStack.prototype.clear = originalClear;
		}
	});
});
