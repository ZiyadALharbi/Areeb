import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "../../src/coding/index.ts";

async function tempDirectory(): Promise<string> {
	return mkdtemp(join(tmpdir(), "areeb-bash-test-"));
}

function output(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	return result.content.find((part) => part.type === "text")?.text ?? "";
}

async function waitForFile(path: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			await access(path);
			return;
		} catch {
			await Bun.sleep(5);
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function waitForProcessExit(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await Bun.sleep(5);
	}
	return false;
}

describe("bash tool", () => {
	test("captures combined stdout/stderr, exit metadata, cwd, and silent success", async () => {
		const cwd = await tempDirectory();
		const tool = createBashTool(cwd);
		const success = await tool.execute({
			command: "printf 'stdout\\n'; printf 'stderr\\n' >&2",
		});
		expect(output(success)).toContain("stdout");
		expect(output(success)).toContain("stderr");
		expect(success).toMatchObject({
			isError: false,
			details: {
				cwd,
				exitCode: 0,
				timedOut: false,
				aborted: false,
			},
		});
		expect(success.details?.durationMs).toBeGreaterThanOrEqual(0);

		const directory = await tool.execute({ command: "pwd" });
		expect(output(directory).trim()).toBe(await realpath(cwd));
		expect(output(await tool.execute({ command: ":" }))).toBe("(no output)");
	});

	test("returns nonzero exits as model-visible errors with their output", async () => {
		const tool = createBashTool(await tempDirectory());
		const result = await tool.execute({
			command: "printf 'before failure'; exit 7",
		});
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(7);
		expect(output(result)).toContain("before failure");
		expect(output(result)).toContain("Command exited with code 7");
	});

	test("validates timeouts and terminates timed-out commands", async () => {
		const tool = createBashTool(await tempDirectory());
		for (const timeout of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
			await expect(tool.execute({ command: ":", timeout })).rejects.toThrow(
				"Invalid timeout",
			);
		}
		const result = await tool.execute({ command: "sleep 5", timeout: 0.02 });
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ timedOut: true, aborted: false });
		expect(output(result)).toContain("timed out after 0.02 seconds");
	});

	test("honors AbortSignal and reports an aborted result", async () => {
		const controller = new AbortController();
		const tool = createBashTool(await tempDirectory());
		const execution = tool.execute(
			{ command: "printf started; sleep 5" },
			controller.signal,
		);
		await Bun.sleep(20);
		controller.abort();
		const result = await execution;
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ timedOut: false, aborted: true });
		expect(output(result)).toContain("started");
		expect(output(result)).toContain("Command aborted");
	});

	test("terminates child processes when aborted", async () => {
		if (process.platform === "win32") {
			return;
		}
		const cwd = await tempDirectory();
		const pidPath = join(cwd, "child.pid");
		const controller = new AbortController();
		const execution = createBashTool(cwd).execute(
			{ command: "sleep 5 & echo $! > child.pid; wait" },
			controller.signal,
		);
		await waitForFile(pidPath);
		const childPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
		controller.abort();
		await execution;
		expect(await waitForProcessExit(childPid)).toBe(true);
	});

	test("does not hang when a quiet descendant inherits stdio", async () => {
		if (process.platform === "win32") {
			return;
		}
		const cwd = await tempDirectory();
		const pidPath = join(cwd, "background.pid");
		const startedAt = Date.now();
		let childPid: number | undefined;
		try {
			const result = await createBashTool(cwd).execute({
				command: "sleep 5 & echo $! > background.pid",
			});
			childPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
			expect(result.isError).toBe(false);
			expect(Date.now() - startedAt).toBeLessThan(1_000);
		} finally {
			if (childPid !== undefined) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {
					// The child may already have exited.
				}
			}
		}
	});

	test("reports signal termination instead of an exit code of null", async () => {
		if (process.platform === "win32") {
			return;
		}
		const result = await createBashTool(await tempDirectory()).execute({
			command: "kill -TERM $$",
		});
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			exitCode: null,
			signalCode: "SIGTERM",
		});
		expect(output(result)).toContain("Command terminated by signal SIGTERM");
		expect(output(result)).not.toContain("code null");
	});

	test("tail-truncates high-volume output and preserves complete output", async () => {
		const tool = createBashTool({
			cwd: await tempDirectory(),
			maxLines: 20,
			maxBytes: 1_024,
		});
		const result = await tool.execute({
			command: "for i in {1..100}; do echo line-$i; done",
		});
		expect(result.isError).toBe(false);
		expect(result.details?.truncation).toMatchObject({
			truncated: true,
			truncatedBy: "lines",
			totalLines: 100,
			outputLines: 20,
		});
		expect(output(result)).toContain("line-100");
		expect(output(result)).not.toContain("line-1\n");
		const fullOutputPath = result.details?.fullOutputPath;
		expect(fullOutputPath).toBeDefined();
		if (fullOutputPath) {
			const full = await readFile(fullOutputPath, "utf8");
			expect(full.startsWith("line-1\n")).toBe(true);
			expect(full.endsWith("line-100\n")).toBe(true);
			await unlink(fullOutputPath);
		}
	});

	test("keeps a UTF-8-safe tail for one oversized line", async () => {
		const tool = createBashTool({
			cwd: await tempDirectory(),
			maxLines: 10,
			maxBytes: 101,
		});
		const result = await tool.execute({
			command: `bun -e 'process.stdout.write("🙂".repeat(1_000))'`,
		});
		const visible = output(result).split("\n\n", 1)[0] ?? "";
		expect(Buffer.byteLength(visible)).toBeLessThanOrEqual(101);
		expect(visible.includes("�")).toBe(false);
		expect(result.details?.truncation).toMatchObject({
			truncated: true,
			truncatedBy: "bytes",
			lastLinePartial: true,
			totalBytes: 4_000,
		});
		if (result.details?.fullOutputPath) {
			await unlink(result.details.fullOutputPath);
		}
	});

	test("throttles progress and stops updating after completion", async () => {
		const updates: string[] = [];
		const tool = createBashTool({
			cwd: await tempDirectory(),
			updateThrottleMs: 50,
		});
		await tool.execute(
			{
				command: "for i in {1..5}; do printf $i; sleep 0.02; done",
			},
			undefined,
			(update) => {
				updates.push(output(update));
			},
		);
		const settledCount = updates.length;
		await Bun.sleep(80);
		expect(updates).toHaveLength(settledCount);
		expect(updates.length).toBeGreaterThanOrEqual(2);
		expect(updates.length).toBeLessThan(8);
	});

	test("ignores rejected asynchronous progress callbacks", async () => {
		const result = await createBashTool(await tempDirectory()).execute(
			{ command: "printf update" },
			undefined,
			async () => {
				throw new Error("update sink failed");
			},
		);
		await Bun.sleep(0);
		expect(result.isError).toBe(false);
		expect(output(result)).toBe("update");
	});
});
