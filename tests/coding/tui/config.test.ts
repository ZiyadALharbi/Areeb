import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadTuiConfig,
	saveTuiConfig,
} from "../../../src/coding/tui/config.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "areeb-tui-config-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("TUI config", () => {
	test("defaults missing files and ignores unknown keys", async () => {
		const directory = await createTempDirectory();
		const path = join(directory, "tui.json");

		expect(await loadTuiConfig(path)).toEqual({
			config: { theme: "areeb-dark" },
		});
		await Bun.write(path, '{"theme":"areeb-light","future":true}');
		expect(await loadTuiConfig(path)).toEqual({
			config: { theme: "areeb-light" },
		});
	});

	test("warns and falls back for malformed or unknown themes", async () => {
		const directory = await createTempDirectory();
		const path = join(directory, "tui.json");

		await writeFile(path, "not json");
		expect(await loadTuiConfig(path)).toMatchObject({
			config: { theme: "areeb-dark" },
			warning: expect.stringContaining("malformed JSON"),
		});
		await writeFile(path, '{"theme":"solarized"}');
		expect(await loadTuiConfig(path)).toMatchObject({
			config: { theme: "areeb-dark" },
			warning: expect.stringContaining("unknown theme"),
		});
	});

	test("saves only the theme with private permissions", async () => {
		const directory = await createTempDirectory();
		const path = join(directory, "user", "tui.json");

		await saveTuiConfig(path, { theme: "areeb-light" });
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			theme: "areeb-light",
		});
		expect((await stat(join(directory, "user"))).mode & 0o777).toBe(0o700);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
});
