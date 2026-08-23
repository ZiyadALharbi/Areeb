import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import type { CommandSessionListItem } from "../../../src/coding/commands.ts";
import {
	type CreateTuiAppOptions,
	createTuiApp,
} from "../../../src/coding/tui/app.ts";
import { createTuiState } from "../../../src/coding/tui/state.ts";
import { AREEB_DARK_THEME } from "../../../src/coding/tui/theme.ts";

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
		state,
		...overrides,
	};
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("createTuiApp pickers", () => {
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

	test("renders flat filterable rows and contextual running status", () => {
		const state = createTuiState({
			sessionId: SESSION_ID,
			model: "model-a",
			cwd: "/project",
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
		expect(pickerOutput).toContain("Filter: type to narrow");
		expect(pickerOutput).toContain("model-a");
		expect(pickerOutput).toContain("fake");
		expect(pickerOutput).not.toMatch(/[┌┐└┘]/);
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
		expect(output).toContain("queued 2");
		expect(app.editor.disableSubmit).toBe(false);
	});
});
