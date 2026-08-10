import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
	utf8ByteLength,
} from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	lastLineBytes: number;
}

type OutputChannel = "stdout" | "stderr";

/** Incremental combined shell capture with bounded display memory. */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly rollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoders = {
		stdout: new TextDecoder("utf-8"),
		stderr: new TextDecoder("utf-8"),
	};
	private rawChunks: Buffer[] = [];
	private tail = "";
	private totalBytes = 0;
	private completedLines = 0;
	private hasOpenLine = false;
	private currentLineBytes = 0;
	private finished = false;
	private tempPath: string | undefined;
	private tempStream: WriteStream | undefined;
	private tempError: Error | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.rollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "areeb-bash";
	}

	append(channel: OutputChannel, data: Uint8Array): void {
		if (this.finished || data.byteLength === 0) {
			return;
		}
		const raw = Buffer.from(data);
		if (this.tempStream) {
			this.tempStream.write(raw);
		} else {
			this.rawChunks.push(raw);
		}
		this.appendText(this.decoders[channel].decode(raw, { stream: true }));
		if (this.shouldPersist()) {
			this.ensureTempFile();
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendText(this.decoders.stdout.decode());
		this.appendText(this.decoders.stderr.decode());
		if (this.shouldPersist()) {
			this.ensureTempFile();
		}
	}

	snapshot(): OutputSnapshot {
		const tailTruncation = truncateTail(this.tail, {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
		const truncated =
			totalLines > this.maxLines || this.totalBytes > this.maxBytes;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy: truncated
				? (tailTruncation.truncatedBy ??
					(this.totalBytes > this.maxBytes ? "bytes" : "lines"))
				: null,
			totalLines,
			totalBytes: this.totalBytes,
		};
		return {
			content: truncated ? truncation.content : this.tail,
			truncation,
			...(this.tempPath ? { fullOutputPath: this.tempPath } : {}),
			lastLineBytes: this.currentLineBytes,
		};
	}

	async close(): Promise<void> {
		const stream = this.tempStream;
		this.tempStream = undefined;
		if (this.tempError) {
			stream?.destroy();
			throw this.tempError;
		}
		if (stream) {
			await new Promise<void>((resolve, reject) => {
				const onFinish = (): void => {
					stream.off("error", onError);
					resolve();
				};
				const onError = (error: Error): void => {
					stream.off("finish", onFinish);
					reject(error);
				};
				stream.once("finish", onFinish);
				stream.once("error", onError);
				stream.end();
			});
		}
		if (this.tempError) {
			throw this.tempError;
		}
	}

	private appendText(text: string): void {
		if (text.length === 0) {
			return;
		}
		const bytes = utf8ByteLength(text);
		this.totalBytes += bytes;
		this.tail += text;

		let newlineCount = 0;
		let lastNewline = -1;
		for (
			let index = text.indexOf("\n");
			index !== -1;
			index = text.indexOf("\n", index + 1)
		) {
			newlineCount += 1;
			lastNewline = index;
		}
		if (newlineCount === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlineCount;
			const trailing = text.slice(lastNewline + 1);
			this.currentLineBytes = utf8ByteLength(trailing);
			this.hasOpenLine = trailing.length > 0;
		}
		this.trimTail();
	}

	private trimTail(): void {
		const bytes = Buffer.from(this.tail, "utf8");
		if (bytes.length <= this.rollingBytes * 2) {
			return;
		}
		let start = bytes.length - this.rollingBytes;
		while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
			start += 1;
		}
		this.tail = bytes.subarray(start).toString("utf8");
	}

	private shouldPersist(): boolean {
		return (
			this.totalBytes > this.maxBytes ||
			this.completedLines + (this.hasOpenLine ? 1 : 0) > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempPath) {
			return;
		}
		this.tempPath = join(
			tmpdir(),
			`${this.tempFilePrefix}-${randomBytes(8).toString("hex")}.log`,
		);
		const stream = createWriteStream(this.tempPath, { flags: "wx" });
		stream.on("error", (error) => {
			this.tempError = error;
		});
		this.tempStream = stream;
		for (const chunk of this.rawChunks) {
			stream.write(chunk);
		}
		this.rawChunks = [];
	}
}
