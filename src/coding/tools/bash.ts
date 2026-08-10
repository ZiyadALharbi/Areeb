import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { AgentTool, AgentToolUpdateCallback } from "../../agent/types.ts";
import {
	type CodingToolConfig,
	type CodingToolDefinition,
	type CodingToolOptions,
	createAgentTool,
} from "../types.ts";
import {
	OutputAccumulator,
	type OutputSnapshot,
} from "./output-accumulator.ts";
import { resolveCodingCwd } from "./path-utils.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
} from "./truncate.ts";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1_000;
const DEFAULT_UPDATE_THROTTLE_MS = 100;
const KILL_GRACE_MS = 500;
const EXIT_STDIO_GRACE_MS = 100;

export const bashInputSchema = z.object({
	command: z.string().min(1, "command must not be empty"),
	timeout: z.number().optional(),
});

export type BashToolInput = z.infer<typeof bashInputSchema>;

export interface BashToolDetails {
	command: string;
	cwd: string;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	timedOut: boolean;
	aborted: boolean;
	durationMs: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export interface BashToolOptions extends CodingToolOptions {
	commandPrefix?: string;
	shell?: string;
	env?: Record<string, string | undefined>;
	inheritEnv?: boolean;
	maxLines?: number;
	maxBytes?: number;
	updateThrottleMs?: number;
}

interface ProcessResult {
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	spawnError?: Error;
}

function normalizeOptions(
	config: string | BashToolOptions | undefined,
): BashToolOptions {
	return typeof config === "string" ? { cwd: config } : (config ?? {});
}

function validateTimeout(timeout: number | undefined): void {
	if (timeout === undefined) {
		return;
	}
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	if (timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(
			`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`,
		);
	}
}

function safeUpdate<TDetails>(
	onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
	update: Parameters<AgentToolUpdateCallback<TDetails>>[0],
): void {
	try {
		const pending = onUpdate?.(update);
		if (pending) {
			void pending.catch(() => {});
		}
	} catch {
		// Progress reporting is best effort and must not orphan a child process.
	}
}

function resolveDefaultShell(): string {
	if (process.platform === "win32") {
		return "bash.exe";
	}
	return existsSync("/bin/bash") ? "/bin/bash" : "bash";
}

function forceKillWindowsProcessTree(pid: number): void {
	try {
		const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		taskkill.once("error", () => {});
		taskkill.unref();
	} catch {
		// taskkill may be unavailable during process shutdown.
	}
}

function terminateProcessTree(child: Pick<ChildProcess, "pid" | "kill">): void {
	if (child.pid === undefined) {
		return;
	}
	try {
		if (process.platform === "win32") {
			forceKillWindowsProcessTree(child.pid);
			return;
		}
		process.kill(-child.pid, "SIGTERM");
	} catch {
		try {
			child.kill("SIGTERM");
		} catch {
			// The process may already have exited.
		}
	}
}

function forceKillProcessTree(child: Pick<ChildProcess, "pid" | "kill">): void {
	if (child.pid === undefined) {
		return;
	}
	try {
		if (process.platform === "win32") {
			forceKillWindowsProcessTree(child.pid);
			return;
		}
		process.kill(-child.pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// The process has exited.
		}
	}
}

function isProcessTreeAlive(child: Pick<ChildProcess, "pid">): boolean {
	if (child.pid === undefined || process.platform === "win32") {
		return false;
	}
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * Wait for the shell without hanging on a quiet detached descendant that keeps
 * stdout or stderr open. Active post-exit output extends the grace period so
 * its tail is not cut off.
 */
function waitForChildProcess(child: ChildProcess): Promise<ProcessResult> {
	return new Promise((resolve) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let signalCode: NodeJS.Signals | null = null;
		let spawnError: Error | undefined;
		let postExitTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = (): void => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve({
				exitCode,
				signalCode,
				...(spawnError ? { spawnError } : {}),
			});
		};

		const maybeFinalizeAfterExit = (): void => {
			if (exited && stdoutEnded && stderrEnded) {
				finalize();
			}
		};

		const armPostExitTimer = (): void => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
			}
			postExitTimer = setTimeout(finalize, EXIT_STDIO_GRACE_MS);
		};

		const onData = (): void => {
			if (exited && !settled) {
				armPostExitTimer();
			}
		};
		const onStdoutEnd = (): void => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};
		const onStderrEnd = (): void => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};
		const onError = (error: Error): void => {
			spawnError = error;
		};
		const onExit = (
			code: number | null,
			signal: NodeJS.Signals | null,
		): void => {
			exited = true;
			exitCode = code;
			signalCode = signal;
			maybeFinalizeAfterExit();
			if (!settled) {
				armPostExitTimer();
			}
		};
		const onClose = (
			code: number | null,
			signal: NodeJS.Signals | null,
		): void => {
			exitCode = code;
			signalCode = signal;
			finalize();
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

function truncationNotice(snapshot: OutputSnapshot): string | undefined {
	const { truncation, fullOutputPath } = snapshot;
	if (!truncation.truncated || !fullOutputPath) {
		return undefined;
	}
	const endLine = truncation.totalLines;
	const startLine = Math.max(1, endLine - truncation.outputLines + 1);
	if (truncation.lastLinePartial) {
		return `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(snapshot.lastLineBytes)}). Full output: ${fullOutputPath}]`;
	}
	if (truncation.truncatedBy === "lines") {
		return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
	}
	return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes)} limit). Full output: ${fullOutputPath}]`;
}

function formatResultText(snapshot: OutputSnapshot, status?: string): string {
	const sections: string[] = [];
	if (snapshot.content) {
		sections.push(snapshot.content);
	}
	const notice = truncationNotice(snapshot);
	if (notice) {
		sections.push(notice);
	}
	if (status) {
		sections.push(status);
	}
	return sections.join("\n\n") || "(no output)";
}

function createDetails(
	command: string,
	cwd: string,
	result: ProcessResult,
	timedOut: boolean,
	aborted: boolean,
	durationMs: number,
	snapshot: OutputSnapshot,
): BashToolDetails {
	return {
		command,
		cwd,
		exitCode: result.exitCode,
		signalCode: result.signalCode,
		timedOut,
		aborted,
		durationMs,
		...(snapshot.truncation.truncated
			? { truncation: snapshot.truncation }
			: {}),
		...(snapshot.fullOutputPath
			? { fullOutputPath: snapshot.fullOutputPath }
			: {}),
	};
}

export function createBashToolDefinition(
	config?: string | BashToolOptions,
): CodingToolDefinition<BashToolInput, BashToolDetails> {
	const options = normalizeOptions(config);
	const cwd = resolveCodingCwd(options);
	const shell = options.shell ?? resolveDefaultShell();
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const updateThrottleMs =
		options.updateThrottleMs ?? DEFAULT_UPDATE_THROTTLE_MS;
	if (!Number.isFinite(updateThrottleMs) || updateThrottleMs < 0) {
		throw new Error("updateThrottleMs must be a non-negative finite number");
	}

	return {
		name: "bash",
		description: `Execute a bash command in the configured working directory. Combined stdout/stderr is limited to the last ${maxLines} lines or ${formatSize(maxBytes)}, with full truncated output saved to a temp file.`,
		promptSnippet: "Run shell commands",
		promptGuidelines: [
			"Use bash for commands, tests, and filesystem operations not covered by a more specific tool.",
			"Set timeout only when a command needs an explicit upper bound.",
		],
		inputSchema: bashInputSchema,
		async executor({ command: rawCommand, timeout }, signal, onUpdate) {
			validateTimeout(timeout);
			const command = options.commandPrefix
				? `${options.commandPrefix}\n${rawCommand}`
				: rawCommand;
			const startTime = Date.now();
			const accumulator = new OutputAccumulator({ maxLines, maxBytes });
			let timedOut = false;
			let aborted = signal?.aborted ?? false;
			let acceptingUpdates = true;
			let updateDirty = false;
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			let lastUpdateAt = 0;

			const emitProgress = (): void => {
				if (!acceptingUpdates || !updateDirty) {
					return;
				}
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = accumulator.snapshot();
				safeUpdate(onUpdate, {
					content: [{ type: "text", text: snapshot.content }],
					details: createDetails(
						command,
						cwd,
						{ exitCode: null, signalCode: null },
						timedOut,
						aborted,
						Date.now() - startTime,
						snapshot,
					),
				});
			};
			const scheduleProgress = (): void => {
				if (!onUpdate || !acceptingUpdates) {
					return;
				}
				updateDirty = true;
				const remaining = updateThrottleMs - (Date.now() - lastUpdateAt);
				if (remaining <= 0) {
					if (updateTimer) {
						clearTimeout(updateTimer);
						updateTimer = undefined;
					}
					emitProgress();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitProgress();
				}, remaining);
			};

			safeUpdate(onUpdate, {
				content: [],
				details: {
					command,
					cwd,
					exitCode: null,
					signalCode: null,
					timedOut: false,
					aborted,
					durationMs: 0,
				},
			});

			if (aborted) {
				return {
					content: [{ type: "text", text: "Command aborted" }],
					details: {
						command,
						cwd,
						exitCode: null,
						signalCode: null,
						timedOut: false,
						aborted: true,
						durationMs: Date.now() - startTime,
					},
					isError: true,
				};
			}

			const childEnv = options.inheritEnv === false ? {} : { ...process.env };
			for (const [name, value] of Object.entries(options.env ?? {})) {
				if (value === undefined) {
					delete childEnv[name];
				} else {
					childEnv[name] = value;
				}
			}
			const child = spawn(shell, ["-c", command], {
				cwd,
				env: childEnv,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			let terminationRequested = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let forceKillSettled: (() => void) | undefined;
			let forceKillPromise: Promise<void> | undefined;
			const requestTermination = (): void => {
				if (terminationRequested) {
					return;
				}
				terminationRequested = true;
				terminateProcessTree(child);
				forceKillPromise = new Promise((resolve) => {
					forceKillSettled = resolve;
					killTimer = setTimeout(() => {
						forceKillProcessTree(child);
						resolve();
					}, KILL_GRACE_MS);
				});
			};
			const onAbort = (): void => {
				aborted = true;
				requestTermination();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const timeoutTimer =
				timeout === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							requestTermination();
						}, timeout * 1_000);
			timeoutTimer?.unref?.();

			child.stdout.on("data", (chunk: Buffer) => {
				accumulator.append("stdout", chunk);
				scheduleProgress();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				accumulator.append("stderr", chunk);
				scheduleProgress();
			});

			const processResult = await waitForChildProcess(child);
			if (
				terminationRequested &&
				forceKillPromise &&
				isProcessTreeAlive(child)
			) {
				await forceKillPromise;
			}
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
			}
			if (killTimer) {
				clearTimeout(killTimer);
				forceKillSettled?.();
			}
			signal?.removeEventListener("abort", onAbort);
			accumulator.finish();
			await accumulator.close();
			if (updateTimer) {
				clearTimeout(updateTimer);
				updateTimer = undefined;
			}
			updateDirty = true;
			emitProgress();
			acceptingUpdates = false;

			const durationMs = Date.now() - startTime;
			const snapshot = accumulator.snapshot();
			const details = createDetails(
				command,
				cwd,
				processResult,
				timedOut,
				aborted,
				durationMs,
				snapshot,
			);
			let status: string | undefined;
			if (aborted) {
				status = "Command aborted";
			} else if (timedOut) {
				status = `Command timed out after ${timeout} seconds`;
			} else if (processResult.spawnError) {
				status = `Could not start command: ${processResult.spawnError.message}`;
			} else if (processResult.signalCode) {
				status = `Command terminated by signal ${processResult.signalCode}`;
			} else if (processResult.exitCode !== 0) {
				status = `Command exited with code ${processResult.exitCode}`;
			}
			return {
				content: [{ type: "text", text: formatResultText(snapshot, status) }],
				details,
				isError: status !== undefined,
			};
		},
	};
}

export function createBashTool(
	config?: CodingToolConfig | BashToolOptions,
): AgentTool<BashToolInput, BashToolDetails> {
	return createAgentTool(createBashToolDefinition(config));
}
