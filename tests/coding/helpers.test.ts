import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "../../src/coding/tools/file-mutation-queue.ts";
import {
	countPhysicalLines,
	truncateHead,
	truncateTail,
} from "../../src/coding/tools/truncate.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "areeb-queue-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		tempDirectories.splice(0).map((directory) =>
			rm(directory, {
				recursive: true,
				force: true,
			}),
		),
	);
});

describe("coding output truncation", () => {
	test("counts empty, terminated, and unterminated physical lines", () => {
		expect(countPhysicalLines("")).toBe(0);
		expect(countPhysicalLines("one")).toBe(1);
		expect(countPhysicalLines("one\n")).toBe(1);
		expect(countPhysicalLines("one\ntwo")).toBe(2);
		expect(countPhysicalLines("\n")).toBe(1);
	});

	test("keeps exact boundaries and truncates by complete head lines", () => {
		const exact = `${Array.from({ length: 2_000 }, (_, index) => index).join("\n")}\n`;
		expect(truncateHead(exact, { maxBytes: 100_000 }).truncated).toBe(false);

		const over = `${exact}last`;
		const result = truncateHead(over, { maxBytes: 100_000 });
		expect(result).toMatchObject({
			truncated: true,
			truncatedBy: "lines",
			totalLines: 2_001,
			outputLines: 2_000,
			firstLineExceedsLimit: false,
		});
		expect(result.content.endsWith("1999")).toBe(true);
	});

	test("uses UTF-8 bytes and never splits a multibyte character", () => {
		const head = truncateHead("🙂🙂\nnext", { maxLines: 10, maxBytes: 7 });
		expect(head).toMatchObject({
			truncated: true,
			truncatedBy: "bytes",
			firstLineExceedsLimit: true,
			totalBytes: 13,
		});

		const tail = truncateTail("🙂".repeat(20), { maxLines: 10, maxBytes: 17 });
		expect(tail.content).toBe("🙂".repeat(4));
		expect(Buffer.byteLength(tail.content)).toBe(16);
		expect(tail.lastLinePartial).toBe(true);
	});

	test("keeps the last complete lines when tail-truncated", () => {
		const result = truncateTail("one\ntwo\nthree\nfour", {
			maxLines: 2,
			maxBytes: 100,
		});
		expect(result.content).toBe("three\nfour");
		expect(result).toMatchObject({
			truncated: true,
			truncatedBy: "lines",
			totalLines: 4,
			outputLines: 2,
		});
	});

	test("reports the limit that actually removes a terminal newline", () => {
		const options = { maxLines: 1, maxBytes: 1 };
		expect(truncateHead("a\n", options).truncatedBy).toBe("bytes");
		expect(truncateTail("a\n", options).truncatedBy).toBe("bytes");
		expect(
			truncateTail("a\nlong", { maxLines: 1, maxBytes: 2 }).truncatedBy,
		).toBe("bytes");
	});

	test("rejects limits outside the positive safe-integer range", () => {
		for (const maxBytes of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => truncateTail("text", { maxBytes })).toThrow(
				"maxBytes must be a positive safe integer",
			);
		}
	});
});

describe("file mutation queue", () => {
	test("serializes symlink aliases", async () => {
		const directory = await createTempDirectory();
		const target = join(directory, "target.txt");
		const alias = join(directory, "alias.txt");
		await writeFile(target, "base");
		await symlink(target, alias);
		const gate = deferred();
		const order: string[] = [];
		const first = withFileMutationQueue(target, async () => {
			order.push("first-start");
			await gate.promise;
			order.push("first-end");
		});
		await Promise.resolve();
		const second = withFileMutationQueue(alias, async () => {
			order.push("second");
		});

		await Bun.sleep(10);
		expect(order).toEqual(["first-start"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["first-start", "first-end", "second"]);
	});

	test("serializes dangling symlinks with their missing targets", async () => {
		const directory = await createTempDirectory();
		const target = join(directory, "target.txt");
		const alias = join(directory, "alias.txt");
		await symlink(target, alias);
		const gate = deferred();
		const order: string[] = [];
		const first = withFileMutationQueue(target, async () => {
			order.push("first-start");
			await gate.promise;
			order.push("first-end");
		});
		await Promise.resolve();
		const second = withFileMutationQueue(alias, async () => {
			order.push("second");
		});

		await Bun.sleep(10);
		expect(order).toEqual(["first-start"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["first-start", "first-end", "second"]);
	});

	test("allows different files in parallel and releases after failures", async () => {
		const directory = await createTempDirectory();
		const gate = deferred();
		let otherStarted = false;
		const first = withFileMutationQueue(join(directory, "one"), async () => {
			await gate.promise;
			throw new Error("expected failure");
		});
		const other = withFileMutationQueue(join(directory, "two"), async () => {
			otherStarted = true;
		});
		await other;
		expect(otherStarted).toBe(true);
		gate.resolve();
		await expect(first).rejects.toThrow("expected failure");
		await expect(
			withFileMutationQueue(join(directory, "one"), async () => "released"),
		).resolves.toBe("released");
	});
});
