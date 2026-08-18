import { describe, expect, test } from "bun:test";
import { parseCli } from "../../src/coding/cli.ts";

describe("print-mode CLI parsing", () => {
	test("defaults to text and accepts every exact output mode", () => {
		expect(parseCli(["-p", "hello", "--model", "fake"])).toEqual({
			prompt: "hello",
			model: "fake",
			output: "text",
			trustProjectResources: false,
		});

		for (const output of ["text", "json", "transcript"] as const) {
			expect(
				parseCli(["--prompt", "hello", "--model", "fake", "--output", output]),
			).toEqual({
				prompt: "hello",
				model: "fake",
				output,
				trustProjectResources: false,
			});
		}
	});

	test("parses explicit project trust", () => {
		expect(
			parseCli(["-p", "hello", "--model", "fake", "--trust-project"]),
		).toEqual({
			prompt: "hello",
			model: "fake",
			output: "text",
			trustProjectResources: true,
		});
	});

	test("rejects invalid and missing output values", () => {
		expect(() =>
			parseCli(["-p", "hello", "--model", "fake", "--output", "JSON"]),
		).toThrow("Invalid output mode: JSON");
		expect(() =>
			parseCli(["-p", "hello", "--model", "fake", "--output"]),
		).toThrow();
	});

	test("rejects empty prompts and short-circuits help before model setup", () => {
		expect(() => parseCli(["-p", " \n\t ", "--model", "fake"])).toThrow(
			"Prompt cannot be empty",
		);
		expect(parseCli(["--help", "--output", "invalid"])).toBeUndefined();
	});
});
