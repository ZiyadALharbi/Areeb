import type { AgentEvent, AgentRunStream } from "../../agent/types.ts";

export type PrintOutputMode = "text" | "json" | "transcript";

export interface AsyncWriter {
	write(content: string): Promise<void>;
	flush(): Promise<void>;
}

export interface EventRenderer {
	render(event: AgentEvent): Promise<void>;
	flush(): Promise<void>;
}

export interface PrintModeSession {
	prompt(input: string): AgentRunStream;
	abort(): void;
}

export interface PrintModeSignalTarget {
	once(event: "SIGINT", listener: () => void): unknown;
	off(event: "SIGINT", listener: () => void): unknown;
}

export interface PrintModeRunOptions {
	readonly output?: PrintOutputMode;
	readonly stdout?: AsyncWriter;
	readonly stderr?: AsyncWriter;
	readonly signalTarget?: PrintModeSignalTarget;
}

export interface EventRendererOptions {
	readonly stdout?: AsyncWriter;
	readonly stderr?: AsyncWriter;
}

export function isPrintOutputMode(value: string): value is PrintOutputMode {
	return value === "text" || value === "json" || value === "transcript";
}
