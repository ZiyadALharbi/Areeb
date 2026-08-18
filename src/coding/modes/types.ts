import type { AgentEvent, AgentRunStream } from "../../agent/types.ts";

/** Human-readable final text, machine-readable events, or a live transcript. */
export type PrintOutputMode = "text" | "json" | "transcript";

/** Awaited output boundary used to preserve ordering and honor backpressure. */
export interface AsyncWriter {
	write(content: string): Promise<void>;
	flush(): Promise<void>;
}

/** Consumes agent events without adding terminal outcome policy to the agent core. */
export interface EventRenderer {
	render(event: AgentEvent): Promise<void>;
	flush(): Promise<void>;
}

/** Minimal session surface needed by one-shot print mode. */
export interface PrintModeSession {
	prompt(input: string): AgentRunStream;
	abort(): void;
}

/** Injectable process-signal surface that keeps SIGINT behavior testable. */
export interface PrintModeSignalTarget {
	once(event: "SIGINT", listener: () => void): unknown;
	off(event: "SIGINT", listener: () => void): unknown;
}

/** Optional print-mode dependencies; process streams and signals are the defaults. */
export interface PrintModeRunOptions {
	readonly output?: PrintOutputMode;
	readonly stdout?: AsyncWriter;
	readonly stderr?: AsyncWriter;
	readonly signalTarget?: PrintModeSignalTarget;
}

/** Writer overrides for standalone renderer use and focused tests. */
export interface EventRendererOptions {
	readonly stdout?: AsyncWriter;
	readonly stderr?: AsyncWriter;
}

/** Runtime guard for the exact CLI output values. */
export function isPrintOutputMode(value: string): value is PrintOutputMode {
	return value === "text" || value === "json" || value === "transcript";
}
