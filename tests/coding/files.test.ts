import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "diff";
import {
	createEditTool,
	createReadTool,
	createWriteTool,
} from "../../src/coding/index.ts";

async function tempDirectory(): Promise<string> {
	return mkdtemp(join(tmpdir(), "areeb-files-"));
}

function text(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	return result.content.find((part) => part.type === "text")?.text ?? "";
}

describe("read tool", () => {
	test("reads slices, accepts offset zero, and supplies continuation hints", async () => {
		const cwd = await tempDirectory();
		await writeFile(join(cwd, "lines.txt"), "one\ntwo\nthree\n");
		const tool = createReadTool(cwd);
		const first = await tool.execute({
			path: "lines.txt",
			offset: 0,
			limit: 2,
		});
		expect(text(first)).toBe(
			"one\ntwo\n\n[1 more lines in file. Use offset=3 to continue.]",
		);
		const last = await tool.execute({ path: "lines.txt", offset: 3 });
		expect(text(last)).toBe("three\n");
	});

	test("handles empty files, CRLF, truncation, and out-of-range offsets", async () => {
		const cwd = await tempDirectory();
		await writeFile(join(cwd, "empty.txt"), "");
		await writeFile(join(cwd, "crlf.txt"), "one\r\ntwo\r\n");
		const regular = createReadTool(cwd);
		expect(text(await regular.execute({ path: "empty.txt" }))).toBe("");
		expect(text(await regular.execute({ path: "crlf.txt" }))).toBe(
			"one\r\ntwo\r\n",
		);
		await expect(
			regular.execute({ path: "crlf.txt", offset: 3 }),
		).rejects.toThrow("beyond end of file");

		const bounded = createReadTool({ cwd, maxLines: 1, maxBytes: 100 });
		const result = await bounded.execute({ path: "crlf.txt" });
		expect(text(result)).toContain("Use offset=2 to continue");
		expect(result.details?.truncation).toMatchObject({
			truncated: true,
			truncatedBy: "lines",
		});
	});

	test("rejects invalid UTF-8 and directories", async () => {
		const cwd = await tempDirectory();
		await writeFile(join(cwd, "binary.txt"), Buffer.from([0xc3, 0x28]));
		await mkdir(join(cwd, "directory"));
		const tool = createReadTool(cwd);
		await expect(tool.execute({ path: "binary.txt" })).rejects.toThrow(
			"not valid UTF-8",
		);
		await expect(tool.execute({ path: "directory" })).rejects.toThrow();
		await expect(tool.execute({ path: "missing.txt" })).rejects.toThrow();
	});

	test("detects supported images from bytes and rejects image line arguments", async () => {
		const cwd = await tempDirectory();
		const png = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
		]);
		await writeFile(join(cwd, "not-an-extension.txt"), png);
		const tool = createReadTool(cwd);
		const result = await tool.execute({ path: "not-an-extension.txt" });
		expect(result.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
		]);
		expect(result.details?.image).toEqual({
			mimeType: "image/png",
			bytes: png.length,
		});
		await expect(
			tool.execute({ path: "not-an-extension.txt", offset: 0 }),
		).rejects.toThrow("cannot be used when reading an image");
	});
});

describe("write tool", () => {
	test("creates parents, overwrites content, handles empty text, and counts bytes", async () => {
		const cwd = await tempDirectory();
		const tool = createWriteTool(cwd);
		const unicode = await tool.execute({
			path: "nested/file.txt",
			content: "🙂",
		});
		expect(unicode.details?.bytes).toBe(4);
		expect(await readFile(join(cwd, "nested/file.txt"), "utf8")).toBe("🙂");
		await tool.execute({ path: "nested/file.txt", content: "" });
		expect(await readFile(join(cwd, "nested/file.txt"), "utf8")).toBe("");
	});

	test("writes through a file symlink without replacing it", async () => {
		const cwd = await tempDirectory();
		const target = join(cwd, "target.txt");
		const alias = join(cwd, "alias.txt");
		await writeFile(target, "old");
		await symlink(target, alias);
		await createWriteTool(cwd).execute({ path: "alias.txt", content: "new" });
		expect(await readFile(target, "utf8")).toBe("new");
		expect(await readlink(alias)).toBe(target);
	});

	test("does not commit when cancelled after parent preparation", async () => {
		const cwd = await tempDirectory();
		const controller = new AbortController();
		let writes = 0;
		const tool = createWriteTool({
			cwd,
			operations: {
				async mkdir() {
					controller.abort();
				},
				async writeFile() {
					writes += 1;
				},
			},
		});
		await expect(
			tool.execute({ path: "file.txt", content: "new" }, controller.signal),
		).rejects.toThrow("Operation aborted");
		expect(writes).toBe(0);
	});

	test("serializes write/edit interaction and cancels a queued write safely", async () => {
		const cwd = await tempDirectory();
		const path = join(cwd, "file.txt");
		await writeFile(path, "old");
		let releaseFirst = (): void => {};
		let firstStarted = (): void => {};
		const firstStartedPromise = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		const releaseFirstPromise = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = createWriteTool({
			cwd,
			operations: {
				async mkdir() {},
				async writeFile(filePath, content) {
					firstStarted();
					await releaseFirstPromise;
					await writeFile(filePath, content);
				},
			},
		});
		const firstExecution = first.execute({ path: "file.txt", content: "new" });
		await firstStartedPromise;

		let editReadStarted = false;
		const edit = createEditTool({
			cwd,
			operations: {
				async readFile(filePath) {
					editReadStarted = true;
					return readFile(filePath);
				},
				async writeFile(filePath, content) {
					await writeFile(filePath, content);
				},
			},
		});
		const editExecution = edit.execute({
			path: "file.txt",
			edits: [{ oldText: "new", newText: "edited" }],
		});
		const controller = new AbortController();
		const cancelled = createWriteTool(cwd).execute(
			{ path: "file.txt", content: "must-not-land" },
			controller.signal,
		);
		controller.abort();
		await Bun.sleep(10);
		expect(editReadStarted).toBe(false);
		releaseFirst();
		await firstExecution;
		await editExecution;
		await expect(cancelled).rejects.toThrow("Operation aborted");
		expect(await readFile(path, "utf8")).toBe("edited");
	});
});

describe("edit tool", () => {
	test("applies multiple original-file edits and returns a valid patch", async () => {
		const cwd = await tempDirectory();
		const original = "alpha\nbeta\ngamma\n";
		await writeFile(join(cwd, "file.txt"), original);
		const result = await createEditTool(cwd).execute({
			path: "file.txt",
			edits: [
				{ oldText: "alpha", newText: "one" },
				{ oldText: "gamma", newText: "three" },
			],
		});
		const expected = "one\nbeta\nthree\n";
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(expected);
		expect(result.details?.firstChangedLine).toBe(1);
		expect(result.details?.diff).toContain("+1 one");
		expect(applyPatch(original, result.details?.patch ?? "")).toBe(expected);
	});

	test("validates missing, duplicate, overlapping, and no-op edits before writing", async () => {
		const cwd = await tempDirectory();
		const path = join(cwd, "file.txt");
		const original = "repeat repeat\nabcdef\n";
		await writeFile(path, original);
		const tool = createEditTool(cwd);
		for (const edits of [
			[{ oldText: "missing", newText: "x" }],
			[{ oldText: "repeat", newText: "x" }],
			[
				{ oldText: "abcd", newText: "x" },
				{ oldText: "cdef", newText: "y" },
			],
			[{ oldText: "abcdef", newText: "abcdef" }],
		]) {
			await expect(tool.execute({ path: "file.txt", edits })).rejects.toThrow();
			expect(await readFile(path, "utf8")).toBe(original);
		}
	});

	test("normalizes legacy arguments and JSON edits", async () => {
		const cwd = await tempDirectory();
		await writeFile(join(cwd, "file.txt"), "one\ntwo\n");
		const tool = createEditTool(cwd);
		const legacy = await tool.inputSchema.parseAsync({
			path: "file.txt",
			oldText: "one",
			newText: "first",
		});
		await tool.execute(legacy);
		const json = await tool.inputSchema.parseAsync({
			path: "file.txt",
			edits: JSON.stringify([{ oldText: "two", newText: "second" }]),
		});
		await tool.execute(json);
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"first\nsecond\n",
		);
	});

	test("preserves BOM, CRLF, final newline, and symlinks", async () => {
		const cwd = await tempDirectory();
		const target = join(cwd, "target.txt");
		const alias = join(cwd, "alias.txt");
		await writeFile(target, "\uFEFFone\r\ntwo\r\n");
		await symlink(target, alias);
		await createEditTool(cwd).execute({
			path: "alias.txt",
			edits: [{ oldText: "one\ntwo", newText: "first\nsecond" }],
		});
		expect(await readFile(target, "utf8")).toBe("\uFEFFfirst\r\nsecond\r\n");
		expect(await readlink(alias)).toBe(target);
	});
});
