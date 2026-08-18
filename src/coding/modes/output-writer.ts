import type { Writable } from "node:stream";
import type { AsyncWriter } from "./types.ts";

const WRITE_RETRY_DELAY_MS = 10;

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
			await new Promise<void>((resolve) =>
				setTimeout(resolve, WRITE_RETRY_DELAY_MS),
			);
		}
	}
}

function writeChunk(stream: Writable, content: string): Promise<void> {
	return new Promise((resolve, reject) => {
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
