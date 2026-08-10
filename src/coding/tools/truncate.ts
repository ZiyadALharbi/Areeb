/** Shared line- and byte-bounded output truncation. */

export const DEFAULT_MAX_LINES = 2_000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}

export interface ResolvedTruncationLimits {
	maxLines: number;
	maxBytes: number;
}

export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	lastLinePartial: boolean;
	firstLineExceedsLimit: boolean;
	maxLines: number;
	maxBytes: number;
}

export function utf8ByteLength(content: string): number {
	return Buffer.byteLength(content, "utf8");
}

/** Count physical lines without treating a terminal newline as an empty line. */
export function countPhysicalLines(content: string): number {
	if (content.length === 0) {
		return 0;
	}
	let lines = 1;
	for (let index = 0; index < content.length; index += 1) {
		if (content.charCodeAt(index) === 10) {
			lines += 1;
		}
	}
	return content.endsWith("\n") ? lines - 1 : lines;
}

function splitPhysicalLines(content: string): string[] {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	if (content.endsWith("\n")) {
		lines.pop();
	}
	return lines;
}

export function resolveTruncationLimits(
	options: TruncationOptions = {},
): ResolvedTruncationLimits {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	if (!Number.isSafeInteger(maxLines) || maxLines < 1) {
		throw new Error("maxLines must be a positive safe integer");
	}
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error("maxBytes must be a positive safe integer");
	}
	return { maxLines, maxBytes };
}

function untruncated(
	content: string,
	totalLines: number,
	totalBytes: number,
	maxLines: number,
	maxBytes: number,
): TruncationResult {
	return {
		content,
		truncated: false,
		truncatedBy: null,
		totalLines,
		totalBytes,
		outputLines: totalLines,
		outputBytes: totalBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

export function truncateHead(
	content: string,
	options: TruncationOptions = {},
): TruncationResult {
	const { maxLines, maxBytes } = resolveTruncationLimits(options);
	const totalLines = countPhysicalLines(content);
	const totalBytes = utf8ByteLength(content);
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return untruncated(content, totalLines, totalBytes, maxLines, maxBytes);
	}

	const lines = splitPhysicalLines(content);
	const firstLineBytes = utf8ByteLength(lines[0] ?? "");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	const output: string[] = [];
	let outputBytes = 0;
	let truncatedBy: "lines" | "bytes" | null = null;
	for (let index = 0; index < lines.length && index < maxLines; index += 1) {
		const line = lines[index] ?? "";
		const candidateBytes = utf8ByteLength(line) + (output.length > 0 ? 1 : 0);
		if (outputBytes + candidateBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		output.push(line);
		outputBytes += candidateBytes;
	}
	if (
		truncatedBy === null &&
		output.length === maxLines &&
		output.length < lines.length
	) {
		truncatedBy = "lines";
	}
	truncatedBy ??= totalBytes > maxBytes ? "bytes" : "lines";

	const truncatedContent = output.join("\n");
	return {
		content: truncatedContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: output.length,
		outputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

function takeUtf8Tail(content: string, maxBytes: number): string {
	const bytes = Buffer.from(content, "utf8");
	if (bytes.length <= maxBytes) {
		return content;
	}
	let start = bytes.length - maxBytes;
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
		start += 1;
	}
	return bytes.subarray(start).toString("utf8");
}

export function truncateTail(
	content: string,
	options: TruncationOptions = {},
): TruncationResult {
	const { maxLines, maxBytes } = resolveTruncationLimits(options);
	const totalLines = countPhysicalLines(content);
	const totalBytes = utf8ByteLength(content);
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return untruncated(content, totalLines, totalBytes, maxLines, maxBytes);
	}

	const lines = splitPhysicalLines(content);
	const output: string[] = [];
	let outputBytes = 0;
	let truncatedBy: "lines" | "bytes" | null = null;
	let lastLinePartial = false;

	for (
		let index = lines.length - 1;
		index >= 0 && output.length < maxLines;
		index -= 1
	) {
		const line = lines[index] ?? "";
		const candidateBytes = utf8ByteLength(line) + (output.length > 0 ? 1 : 0);
		if (outputBytes + candidateBytes > maxBytes) {
			truncatedBy = "bytes";
			if (output.length === 0) {
				const partial = takeUtf8Tail(line, maxBytes);
				output.unshift(partial);
				outputBytes = utf8ByteLength(partial);
				lastLinePartial = true;
			}
			break;
		}
		output.unshift(line);
		outputBytes += candidateBytes;
	}
	if (
		truncatedBy === null &&
		output.length === maxLines &&
		output.length < lines.length
	) {
		truncatedBy = "lines";
	}
	truncatedBy ??= totalBytes > maxBytes ? "bytes" : "lines";

	const truncatedContent = output.join("\n");
	return {
		content: truncatedContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: output.length,
		outputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
