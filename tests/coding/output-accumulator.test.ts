import { describe, expect, test } from "bun:test";
import { readFile, unlink } from "node:fs/promises";
import { OutputAccumulator } from "../../src/coding/tools/output-accumulator.ts";

async function readOutput(accumulator: OutputAccumulator): Promise<string> {
	const path = accumulator.snapshot().fullOutputPath;
	expect(path).toBeDefined();
	const output = await readFile(path as string, "utf8");
	await unlink(path as string);
	return output;
}

describe("output accumulator", () => {
	test("persists decoded stdout and stderr in display order", async () => {
		const accumulator = new OutputAccumulator({ maxBytes: 3 });
		accumulator.append("stdout", Uint8Array.of(0xe2));
		accumulator.append("stderr", Buffer.from("x"));
		accumulator.append("stdout", Uint8Array.of(0x82, 0xac));
		accumulator.finish();
		await accumulator.close();

		expect(await readOutput(accumulator)).toBe("x€");
	});

	test("spools when raw bytes exceed the limit before decoding", async () => {
		const accumulator = new OutputAccumulator({ maxBytes: 1 });
		accumulator.append("stdout", Uint8Array.of(0xe2, 0x82));
		expect(accumulator.snapshot().fullOutputPath).toBeDefined();
		await accumulator.close();

		expect(await readOutput(accumulator)).toBe("�");
	});

	test("closes by finishing and rejects later appends", async () => {
		const accumulator = new OutputAccumulator({ maxBytes: 1 });
		accumulator.append("stdout", Buffer.from("abc"));
		await accumulator.close();

		expect(() => accumulator.append("stdout", Buffer.alloc(0))).toThrow(
			"Cannot append to a closed output accumulator",
		);
		expect(() => accumulator.finish()).toThrow(
			"Cannot finish a closed output accumulator",
		);
		expect(await readOutput(accumulator)).toBe("abc");
	});

	test("validates limits during construction", () => {
		expect(() => new OutputAccumulator({ maxLines: 0 })).toThrow(
			"maxLines must be a positive safe integer",
		);
	});
});
