import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveTruncationLimits,
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
type AccumulatorState = "active" | "finished" | "closed";

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
	private pendingText: string[] = [];
	private tail = "";
	private tailBytes = 0;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private hasOpenLine = false;
	private currentLineBytes = 0;
	private state: AccumulatorState = "active";
	private tempPath: string | undefined;
	private tempStream: WriteStream | undefined;
	private tempError: Error | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		const { maxLines, maxBytes } = resolveTruncationLimits(options);
		this.maxLines = maxLines;
		this.maxBytes = maxBytes;
		this.rollingBytes = maxBytes * 2;
		this.tempFilePrefix = options.tempFilePrefix ?? "areeb-bash";
	}

	append(channel: OutputChannel, data: Uint8Array): void {
		if (this.state !== "active") {
			throw new Error(`Cannot append to a ${this.state} output accumulator`);
		}
		if (data.byteLength === 0) {
			return;
		}
		this.totalRawBytes += data.byteLength;
		this.appendText(this.decoders[channel].decode(data, { stream: true }));
		if (this.shouldPersist()) {
			this.ensureTempFile();
		}
	}

	finish(): void {
		if (this.state === "finished") {
			return;
		}
		if (this.state === "closed") {
			throw new Error("Cannot finish a closed output accumulator");
		}
		this.appendText(this.decoders.stdout.decode());
		this.appendText(this.decoders.stderr.decode());
		this.state = "finished";
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
			totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy: truncated
				? (tailTruncation.truncatedBy ??
					(this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
				: null,
			totalLines,
			totalBytes: this.totalDecodedBytes,
		};
		return {
			content: truncated ? truncation.content : this.tail,
			truncation,
			...(this.tempPath ? { fullOutputPath: this.tempPath } : {}),
			lastLineBytes: this.currentLineBytes,
		};
	}

	async close(): Promise<void> {
		if (this.state === "closed") {
			return;
		}
		if (this.state === "active") {
			this.finish();
		}
		this.state = "closed";
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
		if (this.tempStream) {
			this.tempStream.write(text, "utf8");
		} else {
			this.pendingText.push(text);
		}
		const bytes = utf8ByteLength(text);
		this.totalDecodedBytes += bytes;
		this.tail += text;
		this.tailBytes += bytes;

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
		if (this.tailBytes > this.rollingBytes * 2) {
			this.trimTail();
		}
	}

	private trimTail(): void {
		const bytes = Buffer.from(this.tail, "utf8");
		if (bytes.length <= this.rollingBytes) {
			this.tailBytes = bytes.length;
			return;
		}
		let start = bytes.length - this.rollingBytes;
		while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
			start += 1;
		}
		this.tail = bytes.subarray(start).toString("utf8");
		this.tailBytes = bytes.length - start;
	}

	private shouldPersist(): boolean {
		return (
			this.totalRawBytes > this.maxBytes ||
			this.totalDecodedBytes > this.maxBytes ||
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
		for (const text of this.pendingText) {
			stream.write(text, "utf8");
		}
		this.pendingText = [];
	}
}
