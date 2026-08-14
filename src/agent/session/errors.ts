export type SessionErrorCode =
	| "not_found"
	| "already_exists"
	| "invalid_payload"
	| "invalid_query"
	| "invalid_mutation"
	| "invalid_format"
	| "unsupported_version"
	| "storage";

export interface SessionErrorOptions {
	readonly cause?: unknown;
	/** Present when an error originated from a session file. */
	readonly path?: string;
	/** One-based JSONL line number, when known. */
	readonly line?: number;
}

/**
 * Stable error returned by every session backend.
 *
 * Callers should branch on code rather than parsing the message.
 */
export class SessionError extends Error {
	readonly code: SessionErrorCode;
	readonly path: string | undefined;
	readonly line: number | undefined;

	constructor(
		code: SessionErrorCode,
		message: string,
		options: SessionErrorOptions = {},
	) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);

		this.name = "SessionError";
		this.code = code;
		this.path = options.path;
		this.line = options.line;
	}
}
