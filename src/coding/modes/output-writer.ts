import type { Writable } from "node:stream";
import type { AsyncWriter } from "./types.ts";

const WRITE_RETRY_DELAY_MS = 10;

/** Adapt a Node writable without closing process-owned stdout or stderr. */
export function createOutputWriter(stream: Writable): AsyncWriter {
	return {
		write: (content) => writeToStream(stream, content),
		flush: () => waitForDrain(stream),
	};
}

async function writeToStream(stream: Writable, content: string): Promise<void> {
	while (true) {
		try {
			await writeChunk(stream, content);
			return;
		} catch (error) {
			const writeError = toError(error);
			if (!isRetryableWriteError(writeError)) {
				throw writeError;
			}
			// These codes represent temporary buffer pressure rather than a broken
			// destination, so retry the same complete record after a short delay.
			await new Promise<void>((resolve) =>
				setTimeout(resolve, WRITE_RETRY_DELAY_MS),
			);
		}
	}
}

function writeChunk(stream: Writable, content: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// The callback settles only after Node has accepted the complete chunk.
		// Renderers await it, preventing records from interleaving.
		const finish = (error?: Error | null): void => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};

		try {
			stream.write(content, finish);
		} catch (error) {
			finish(toError(error));
		}
	});
}

function isRetryableWriteError(error: Error): boolean {
	const code = (error as Error & { code?: unknown }).code;
	return code === "ENOBUFS" || code === "EAGAIN" || code === "EWOULDBLOCK";
}

function waitForDrain(stream: Writable): Promise<void> {
	if (!stream.writableNeedDrain) {
		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		// Do not end process-owned streams; draining is the final-flush boundary.
		const cleanup = (): void => {
			stream.off("drain", onDrain);
			stream.off("error", onError);
		};
		const onDrain = (): void => {
			cleanup();
			resolve();
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};

		stream.once("drain", onDrain);
		stream.once("error", onError);
	});
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
