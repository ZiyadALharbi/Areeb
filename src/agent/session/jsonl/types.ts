import type { JsonObject, SessionMetadata, SessionMutation } from "../types.ts";

export const SESSION_JSONL_VERSION = 1 as const;

export interface SessionJsonlHeader {
	kind: "header";
	version: typeof SESSION_JSONL_VERSION;
	sessionId: string;
	createdAt: number;
	cwd: string;
	parentSessionId?: string;
	metadata?: JsonObject;
}

export type SessionJsonlRecord = SessionJsonlHeader | SessionMutation;

export interface SessionJsonlLocation {
	readonly path?: string;
	readonly line?: number;
}

export interface JsonlSessionMetadata extends SessionMetadata {
	path: string;
}
