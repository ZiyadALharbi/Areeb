import { Key, matchesKey, ProcessTerminal } from "@earendil-works/pi-tui";
import { createTuiApp } from "./app.ts";
import { CollapsedToolBlock, MessageBlock } from "./blocks.ts";
import { AREEB_DARK_THEME } from "./theme.ts";

export function runTuiSmoke(): void {
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		throw new Error("The TUI smoke entry requires a TTY");
	}

	const theme = AREEB_DARK_THEME;
	const terminal = new ProcessTerminal();
	const { tui } = createTuiApp({
		terminal,
		theme,
		transcript: [
			new MessageBlock(
				"user",
				"Show me the files that define the command-line interface.",
				theme,
			),
			new CollapsedToolBlock("bash", theme),
			new MessageBlock(
				"assistant",
				"The CLI entry point is src/coding/cli.ts, with print rendering under src/coding/modes/.",
				theme,
			),
		],
		shortcuts: "Esc:quit  │  Ctrl+C:quit",
	});

	let stopped = false;
	let removeInputListener: (() => void) | undefined;
	const stop = (): void => {
		if (stopped) {
			return;
		}
		stopped = true;
		removeInputListener?.();
		tui.stop({ preserveScreen: true });
	};

	removeInputListener = tui.addInputListener((data) => {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			stop();
			return { consume: true };
		}
		return undefined;
	});

	tui.start();
}

if (import.meta.main) {
	try {
		runTuiSmoke();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`areeb tui smoke: ${message}\n`);
		process.exitCode = 1;
	}
}
