import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "../../src/agent/types.ts";
import { FakeProvider } from "../../src/ai/fake_provider.ts";
import type { OpenAICompatibleConfig } from "../../src/ai/openai_compatible_provider.ts";
import { FileCredentialStore } from "../../src/coding/auth-store.ts";
import { parseCli, runCli } from "../../src/coding/cli.ts";
import type { PrintModeSession } from "../../src/coding/modes/types.ts";
import { setupOpenAICompatibleProvider } from "../../src/coding/provider-config.ts";
import { CodingSessionManager } from "../../src/coding/session-manager.ts";
import { textScript } from "./modes/helpers.ts";

const RESUME_ID = "00000000-0000-4000-8000-000000000001";

function jwt(accountId: string): string {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

class BufferOutput {
	value = "";
	constructor(readonly isTTY?: boolean) {}

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
		expect(parseCli(["sessions"])).toEqual({ kind: "sessions" });
		expect(parseCli(["providers"])).toEqual({ kind: "providers" });
		expect(parseCli(["--help", "--output", "invalid"])).toEqual({
			kind: "help",
		});
		expect(
			parseCli(["-p", "continue", "--resume", RESUME_ID, "--trust-project"]),
		).toEqual({
			kind: "prompt",
			prompt: "continue",
			resumeId: RESUME_ID,
			output: "text",
			trustProjectResources: true,
		});
		expect(parseCli([])).toEqual({
			kind: "interactive",
			trustProjectResources: false,
		});
		expect(parseCli(["--resume", RESUME_ID, "--provider", "fake"])).toEqual({
			kind: "interactive",
			resumeId: RESUME_ID,
			provider: "fake",
			trustProjectResources: false,
		});
	});

	test("parses subcommand-first provider setup", () => {
		expect(
			parseCli([
				"setup",
				"--provider",
				"local",
				"--base-url",
				"http://localhost:11434/v1",
				"--api-key-env",
				"LOCAL_API_KEY",
				"--models",
				"qwen,llama:latest",
				"--default-model",
				"qwen",
				"--timeout-seconds",
				"120",
				"--max-retries",
				"2",
				"--max-retry-delay-seconds",
				"0.5",
				"--set-default",
			]),
		).toEqual({
			kind: "setup",
			provider: "local",
			baseUrl: "http://localhost:11434/v1",
			apiKeyEnv: "LOCAL_API_KEY",
			models: ["qwen", "llama:latest"],
			defaultModel: "qwen",
			timeoutSeconds: 120,
			maxRetries: 2,
			maxRetryDelaySeconds: 0.5,
			setDefault: true,
		});
	});

	test("rejects malformed commands and values", () => {
		expect(() =>
			parseCli(["-p", "hello", "--model", "fake", "--output", "JSON"]),
		).toThrow("Invalid output mode: JSON");
		expect(() => parseCli(["-p", "hello", "--output"])).toThrow();
		expect(() => parseCli(["-p", " \n\t ", "--model", "fake"])).toThrow(
			"Prompt cannot be empty",
		);
		expect(() => parseCli(["-p", "hello", "--resume", "short"])).toThrow(
			"resume session id must be a full UUID",
		);
		expect(() => parseCli(["-p", "hello", "--resume"])).toThrow();
		expect(() => parseCli(["--output", "json"])).toThrow(
			"Option --output requires -p",
		);
		expect(() => parseCli(["sessions", "extra"])).toThrow(
			"Unexpected argument: extra",
		);
		expect(() => parseCli(["sessions", "--model", "fake"])).toThrow(
			"Option --model is not valid with sessions",
		);
		expect(() => parseCli(["setup", "--provider", "local"])).not.toThrow();
		expect(() => parseCli(["setup", "--provider", "local", "-p", "x"])).toThrow(
			"Option --prompt is not valid with setup",
		);
		expect(() =>
			parseCli(["setup", "--provider", "local", "--max-retries", "1.5"]),
		).toThrow("--max-retries must be a nonnegative safe integer");
	});
});

describe("CLI session persistence", () => {
	test("creates, resumes, and lists sessions without using launch cwd on resume", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-cli-session-"));
		try {
			const userRoot = join(directory, "user");
			const originalCwd = join(directory, "first-project");
			const otherCwd = join(directory, "second-project");
			await setupOpenAICompatibleProvider({
				userRoot,
				env: { OPENAI_API_KEY: "test-key" },
				provider: "openai",
				models: ["stored-model"],
				defaultModel: "stored-model",
			});
			const providers = [
				new FakeProvider([textScript("first answer")], {
					providerId: "openai",
				}),
				new FakeProvider([textScript("second answer")], {
					providerId: "openai",
				}),
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
				model: { provider: "openai", model: "stored-model" },
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
				`${created.id}\tfirst line continued\topenai/stored-model\t${originalCwd}\n`,
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

describe("CLI interactive mode", () => {
	test("rejects non-TTY invocation before provider bootstrap", async () => {
		const stderr = new BufferOutput();
		let providerCreated = false;

		expect(
			await runCli([], {
				stdin: { isTTY: false },
				stdout: new BufferOutput(true),
				stderr,
				createProvider() {
					providerCreated = true;
					return new FakeProvider([]);
				},
			}),
		).toBe(1);
		expect(stderr.value).toContain(
			"Interactive mode requires a TTY. Use -p for print mode.",
		);
		expect(providerCreated).toBe(false);
	});

	test("starts interactive mode without credentials so login remains reachable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-cli-first-run-"));
		try {
			let providerCreated = false;
			expect(
				await runCli([], {
					cwd: join(directory, "project"),
					userRoot: join(directory, "user"),
					agentsRoot: join(directory, "agents"),
					env: {},
					stdin: { isTTY: true },
					stdout: new BufferOutput(true),
					stderr: new BufferOutput(),
					createProvider() {
						providerCreated = true;
						return new FakeProvider([]);
					},
					async runInteractive(controller) {
						expect(controller.unavailableReason).toContain(
							"No credentials for openai",
						);
						expect(
							controller.completionCatalog.availableCapabilities,
						).toContain("provider-auth");
						expect(await controller.handleCommand("/login")).toEqual({
							handled: true,
							outcome: { kind: "login-picker" },
						});
						return 0;
					},
				}),
			).toBe(0);
			expect(providerCreated).toBe(false);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("uses global Codex credentials when starting in another directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-cli-global-auth-"));
		try {
			const userRoot = join(directory, "user");
			await new FileCredentialStore({ userRoot }).modify(
				"openai-codex",
				() => ({
					type: "oauth",
					access: jwt("account"),
					refresh: "refresh",
					expires: Date.now() + 60_000,
				}),
			);

			let openAiCreated = false;
			expect(
				await runCli([], {
					cwd: join(directory, "unrelated-project"),
					userRoot,
					agentsRoot: join(directory, "agents"),
					env: {},
					stdin: { isTTY: true },
					stdout: new BufferOutput(true),
					stderr: new BufferOutput(),
					createProvider() {
						openAiCreated = true;
						return new FakeProvider([]);
					},
					createCodexProvider() {
						return new FakeProvider([], { providerId: "openai-codex" });
					},
					async runInteractive(controller) {
						expect(controller).toMatchObject({
							provider: "openai-codex",
							model: "gpt-5.6-sol",
						});
						expect(controller.unavailableReason).toBeUndefined();
						return 0;
					},
				}),
			).toBe(0);
			expect(openAiCreated).toBe(false);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("dispatches sibling runners and propagates interactive failures", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-cli-interactive-"));
		try {
			const userRoot = join(directory, "user");
			const storedCwd = join(directory, "stored-project");
			const launchCwd = join(directory, "launch-project");
			await setupOpenAICompatibleProvider({
				userRoot,
				env: { OPENAI_API_KEY: "test-key" },
				provider: "openai",
				models: ["stored-model"],
				defaultModel: "stored-model",
			});
			const stored = await new CodingSessionManager({
				cwd: storedCwd,
				userRoot,
				repositoryOptions: { sessionIdGenerator: () => RESUME_ID },
			}).create();
			await stored.appendEntry({
				type: "model_change",
				provider: "openai",
				model: "stored-model",
			});

			let interactiveRuns = 0;
			let printRuns = 0;
			let providerCreations = 0;
			const common = {
				cwd: launchCwd,
				userRoot,
				agentsRoot: join(directory, "agents"),
				env: { OPENAI_API_KEY: "test-key" },
				stdin: { isTTY: true },
				stdout: new BufferOutput(true),
				stderr: new BufferOutput(),
				createProvider: () => {
					providerCreations += 1;
					return new FakeProvider([], { providerId: "openai" });
				},
			};

			expect(
				await runCli(["--resume", RESUME_ID], {
					...common,
					async runInteractive(controller, options) {
						interactiveRuns += 1;
						expect(options?.userRoot).toBe(userRoot);
						expect(controller.metadata.cwd).toBe(storedCwd);
						expect(controller.model).toBe("stored-model");
						expect(controller.messages).toEqual([]);
						expect(controller.completionCatalog.models).toContainEqual({
							provider: "openai",
							model: "stored-model",
						});
						expect(await controller.handleCommand("/new")).toMatchObject({
							outcome: { kind: "message", level: "warning" },
						});
						expect(await controller.handleCommand("/new")).toEqual({
							handled: true,
							outcome: { kind: "none" },
						});
						expect(controller.metadata.cwd).toBe(storedCwd);
						expect(controller.model).toBe("stored-model");
						return 0;
					},
					async runPrint() {
						throw new Error("print runner should not run");
					},
				}),
			).toBe(0);

			expect(
				await runCli(["-p", "hello"], {
					...common,
					async runInteractive() {
						throw new Error("interactive runner should not run");
					},
					async runPrint(_session, prompt) {
						printRuns += 1;
						expect(prompt).toBe("hello");
						return 0;
					},
				}),
			).toBe(0);
			expect({ interactiveRuns, printRuns }).toEqual({
				interactiveRuns: 1,
				printRuns: 1,
			});
			expect(providerCreations).toBe(3);

			const failureOutput = new BufferOutput();
			expect(
				await runCli([], {
					...common,
					stderr: failureOutput,
					async runInteractive() {
						throw new Error("interactive runner failed");
					},
				}),
			).toBe(1);
			expect(failureOutput.value).toBe("areeb: interactive runner failed\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("reconstructs the active session across providers before persisting the switch", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-cli-model-switch-"));
		try {
			const userRoot = join(directory, "user");
			const cwd = join(directory, "project");
			await setupOpenAICompatibleProvider({
				userRoot,
				env: { OPENAI_API_KEY: "test-key" },
				provider: "openai",
				models: ["model-a"],
				defaultModel: "model-a",
			});
			await setupOpenAICompatibleProvider({
				userRoot,
				env: { OPENAI_API_KEY: "test-key" },
				provider: "local",
				baseUrl: "http://localhost:11434/v1",
				models: ["org/model-b"],
				defaultModel: "org/model-b",
				timeoutSeconds: 45,
			});
			const providerConfigs: OpenAICompatibleConfig[] = [];

			expect(
				await runCli([], {
					cwd,
					userRoot,
					agentsRoot: join(directory, "agents"),
					env: { OPENAI_API_KEY: "test-key" },
					stdin: { isTTY: true },
					stdout: new BufferOutput(true),
					stderr: new BufferOutput(),
					createProvider(config) {
						providerConfigs.push(config);
						return new FakeProvider([], { providerId: config.providerId });
					},
					async runInteractive(controller) {
						expect(controller.completionCatalog.models).toContainEqual({
							provider: "local",
							model: "org/model-b",
						});
						expect(controller.completionCatalog.models).toContainEqual({
							provider: "openai",
							model: "model-a",
						});
						expect(await controller.setModel("local", "org/model-b")).toEqual({
							kind: "none",
						});
						expect(controller).toMatchObject({
							provider: "local",
							model: "org/model-b",
						});
						return 0;
					},
				}),
			).toBe(0);
			expect(providerConfigs).toMatchObject([
				{ providerId: "openai" },
				{
					providerId: "local",
					baseUrl: "http://localhost:11434/v1",
				},
			]);
			const [record] = await new CodingSessionManager({ cwd, userRoot }).list();
			expect(record?.model).toEqual({
				provider: "local",
				model: "org/model-b",
			});
			expect(
				JSON.parse(await readFile(join(userRoot, "providers.json"), "utf8")),
			).toMatchObject({
				default_provider: "local",
				default_model: "org/model-b",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("CLI provider configuration", () => {
	test("sets up, lists, and runs a custom provider without exposing secrets", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-cli-provider-"));
		try {
			const userRoot = join(directory, "user");
			const stdout = new BufferOutput();
			const stderr = new BufferOutput();
			expect(
				await runCli(
					[
						"setup",
						"--provider",
						"local",
						"--base-url",
						"http://localhost:11434/v1/",
						"--api-key-env",
						"LOCAL_API_KEY",
						"--models",
						"qwen,llama",
						"--default-model",
						"qwen",
						"--timeout-seconds",
						"120",
						"--max-retries",
						"3",
						"--max-retry-delay-seconds",
						"0.5",
						"--set-default",
					],
					{ userRoot, env: {}, stdout, stderr },
				),
			).toBe(0);
			expect(stdout.value).toBe("Configured provider local.\n");
			expect(stderr.value).toContain(
				'warning: LOCAL_API_KEY is not set for provider "local"',
			);

			const listing = new BufferOutput();
			expect(
				await runCli(["providers"], {
					userRoot,
					env: { LOCAL_API_KEY: "top-secret" },
					stdout: listing,
					stderr: new BufferOutput(),
				}),
			).toBe(0);
			expect(listing.value).toContain(
				"local\tprovider,model\tqwen\thttp://localhost:11434/v1\tready",
			);
			expect(listing.value).toContain(
				"local\tprovider\tllama\thttp://localhost:11434/v1\tready",
			);
			expect(listing.value).not.toContain("top-secret");

			const fake = new FakeProvider([textScript("custom answer")], {
				providerId: "local",
			});
			let providerConfig: OpenAICompatibleConfig | undefined;
			expect(
				await runCli(["-p", "hello"], {
					cwd: join(directory, "project"),
					userRoot,
					agentsRoot: join(directory, "agents"),
					env: { LOCAL_API_KEY: "top-secret" },
					stdout: new BufferOutput(),
					stderr: new BufferOutput(),
					createProvider(config) {
						providerConfig = config;
						return fake;
					},
					async runPrint(session: PrintModeSession, prompt: string) {
						await session.prompt(prompt).result();
						return 0;
					},
				}),
			).toBe(0);
			expect(providerConfig).toMatchObject({
				providerId: "local",
				baseUrl: "http://localhost:11434/v1",
				apiKey: "top-secret",
				retry: { maxRetries: 3, maxRetryDelayMs: 500 },
			});
			expect(fake.calls[0]?.options?.timeout).toBe(120_000);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("refuses to move a resumed session to a missing provider", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-cli-safe-resume-"));
		try {
			const userRoot = join(directory, "user");
			const cwd = join(directory, "project");
			await setupOpenAICompatibleProvider({
				userRoot,
				env: {},
				provider: "local",
				baseUrl: "http://localhost:11434/v1",
				models: ["qwen"],
				defaultModel: "qwen",
				setDefault: true,
			});
			const manager = new CodingSessionManager({ cwd, userRoot });
			const session = await manager.create();
			const sessionMetadata = await session.getMetadata();
			await session.appendEntry({
				type: "model_change",
				provider: "local",
				model: "qwen",
			});
			const configPath = join(userRoot, "providers.json");
			const document = JSON.parse(await readFile(configPath, "utf8")) as {
				default_provider: string;
				providers: Record<string, unknown>;
			};
			delete document.providers.local;
			document.default_provider = "openai";
			await writeFile(configPath, `${JSON.stringify(document)}\n`, "utf8");

			const stderr = new BufferOutput();
			let providerCreated = false;
			expect(
				await runCli(["-p", "continue", "--resume", sessionMetadata.id], {
					cwd,
					userRoot,
					env: { OPENAI_API_KEY: "test-key" },
					stderr,
					createProvider() {
						providerCreated = true;
						return new FakeProvider([], { providerId: "openai" });
					},
				}),
			).toBe(1);
			expect(stderr.value).toContain("Unknown provider: local");
			expect(providerCreated).toBe(false);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("reports corrupt provider settings instead of using the implicit default", async () => {
		const directory = await mkdtemp(join(tmpdir(), "areeb-cli-corrupt-"));
		try {
			const userRoot = join(directory, "user");
			await setupOpenAICompatibleProvider({
				userRoot,
				env: {},
				provider: "openai",
			});
			await writeFile(
				join(userRoot, "providers.json"),
				'{"version":2}\n',
				"utf8",
			);
			const stderr = new BufferOutput();
			expect(await runCli(["providers"], { userRoot, env: {}, stderr })).toBe(
				1,
			);
			expect(stderr.value).toContain("providers.json: $.version");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
