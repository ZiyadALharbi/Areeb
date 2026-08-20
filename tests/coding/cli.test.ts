import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "../../src/agent/types.ts";
import { FakeProvider } from "../../src/ai/fake_provider.ts";
import { parseCli, runCli } from "../../src/coding/cli.ts";
import type { PrintModeSession } from "../../src/coding/modes/types.ts";
import { CodingSessionManager } from "../../src/coding/session-manager.ts";
import { textScript } from "./modes/helpers.ts";

const RESUME_ID = "00000000-0000-4000-8000-000000000001";

class BufferOutput {
	value = "";

	write(content: string): void {
		this.value += content;
	}
}

function messageText(message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "assistant") {
		return undefined;
	}
	return message.content.find((content) => content.type === "text")?.text;
}

describe("CLI parsing", () => {
	test("parses prompt commands and every exact output mode", () => {
		expect(parseCli(["-p", "hello", "--model", "fake"])).toEqual({
			kind: "prompt",
			prompt: "hello",
			model: "fake",
			requestedModel: "fake",
			output: "text",
			trustProjectResources: false,
		});

		for (const output of ["text", "json", "transcript"] as const) {
			expect(
				parseCli(["--prompt", "hello", "--model", "fake", "--output", output]),
			).toMatchObject({ kind: "prompt", output });
		}
	});

	test("parses session listing, resume, project trust, and help", () => {
		expect(parseCli(["sessions"], {})).toEqual({ kind: "sessions" });
		expect(parseCli(["--help", "--output", "invalid"], {})).toEqual({
			kind: "help",
		});
		expect(
			parseCli(
				["-p", "continue", "--resume", RESUME_ID, "--trust-project"],
				{},
			),
		).toEqual({
			kind: "prompt",
			prompt: "continue",
			resumeId: RESUME_ID,
			output: "text",
			trustProjectResources: true,
		});
	});

	test("rejects malformed commands and values", () => {
		expect(() =>
			parseCli(["-p", "hello", "--model", "fake", "--output", "JSON"]),
		).toThrow("Invalid output mode: JSON");
		expect(() => parseCli(["-p", "hello", "--output"], {})).toThrow();
		expect(() => parseCli(["-p", " \n\t ", "--model", "fake"])).toThrow(
			"Prompt cannot be empty",
		);
		expect(() => parseCli(["-p", "hello", "--resume", "short"], {})).toThrow(
			"resume session id must be a full UUID",
		);
		expect(() => parseCli(["-p", "hello", "--resume"], {})).toThrow();
		expect(() => parseCli(["--resume", RESUME_ID], {})).toThrow(
			"Interactive mode is not available yet",
		);
		expect(() => parseCli(["sessions", "extra"], {})).toThrow(
			"Unexpected argument: extra",
		);
		expect(() => parseCli(["sessions", "--model", "fake"], {})).toThrow(
			"Option --model is not valid with sessions",
		);
	});
});

describe("CLI session persistence", () => {
	test("creates, resumes, and lists sessions without using launch cwd on resume", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-cli-session-"));
		try {
			const userRoot = join(directory, "user");
			const originalCwd = join(directory, "first-project");
			const otherCwd = join(directory, "second-project");
			const providers = [
				new FakeProvider([textScript("first answer")]),
				new FakeProvider([textScript("second answer")]),
			];
			const stdout = new BufferOutput();
			const stderr = new BufferOutput();
			const runtime = {
				cwd: originalCwd,
				userRoot,
				agentsRoot: join(directory, "agents"),
				env: {
					OPENAI_API_KEY: "test-key",
					OPENAI_MODEL: "environment-model",
				},
				stdout,
				stderr,
				createProvider() {
					const provider = providers.shift();
					if (provider === undefined) {
						throw new Error("Provider sequence exhausted");
					}
					return provider;
				},
				async runPrint(session: PrintModeSession, prompt: string) {
					await session.prompt(prompt).result();
					return 0;
				},
			};

			expect(
				await runCli(
					["-p", "first\tline\ncontinued", "--model", "stored-model"],
					runtime,
				),
			).toBe(0);
			const manager = new CodingSessionManager({ cwd: originalCwd, userRoot });
			const [created] = await manager.list();
			if (created === undefined) {
				throw new Error("Expected a persisted session");
			}
			expect(created).toMatchObject({
				title: "first\tline\ncontinued",
				model: { provider: "fake", model: "stored-model" },
			});

			expect(
				await runCli(["-p", "continue", "--resume", created.id], {
					...runtime,
					cwd: otherCwd,
					env: { OPENAI_API_KEY: "test-key" },
				}),
			).toBe(0);
			const resumed = await new CodingSessionManager({
				cwd: originalCwd,
				userRoot,
			}).open(created.id);
			expect((await resumed.buildContext()).messages.map(messageText)).toEqual([
				"first\tline\ncontinued",
				"first answer",
				"continue",
				"second answer",
			]);

			const listingOutput = new BufferOutput();
			expect(
				await runCli(["sessions"], {
					userRoot,
					env: {},
					stdout: listingOutput,
					stderr,
				}),
			).toBe(0);
			expect(listingOutput.value).toBe(
				`${created.id}\tfirst line continued\tfake/stored-model\t${originalCwd}\n`,
			);
			expect(stderr.value).toBe("");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("reports unknown sessions and explicit stored-model conflicts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-cli-errors-"));
		try {
			const userRoot = join(directory, "user");
			const cwd = join(directory, "project");
			const manager = new CodingSessionManager({
				cwd,
				userRoot,
				repositoryOptions: {
					sessionIdGenerator: () => RESUME_ID,
				},
			});
			const session = await manager.create();
			await session.appendEntry({
				type: "model_change",
				provider: "fake",
				model: "stored-model",
			});
			const stderr = new BufferOutput();

			expect(
				await runCli(
					["-p", "continue", "--resume", RESUME_ID, "--model", "other-model"],
					{
						cwd,
						userRoot,
						env: { OPENAI_API_KEY: "test-key" },
						stderr,
					},
				),
			).toBe(1);
			expect(stderr.value).toContain(
				'Requested model "other-model" does not match stored model "stored-model"',
			);

			const unknownId = RESUME_ID.replace(/1$/, "2");
			const unknownError = new BufferOutput();
			expect(
				await runCli(["-p", "continue", "--resume", unknownId], {
					cwd,
					userRoot,
					env: { OPENAI_API_KEY: "test-key" },
					stderr: unknownError,
				}),
			).toBe(1);
			expect(unknownError.value).toBe(`areeb: Unknown session: ${unknownId}\n`);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
