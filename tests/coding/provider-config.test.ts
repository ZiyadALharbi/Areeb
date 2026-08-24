import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../../src/ai/fake_provider.ts";
import type { OpenAICompatibleConfig } from "../../src/ai/openai_compatible_provider.ts";
import {
	configuredProviderModels,
	createProviderRuntime,
	DEFAULT_OPENAI_MODEL,
	loadProviderSettings,
	parseProviderSettings,
	resolveProviderSelection,
	saveDefaultProviderModel,
	setupOpenAICompatibleProvider,
	usableFavoriteModels,
} from "../../src/coding/provider-config.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "areeb-providers-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("provider settings parsing and resolution", () => {
	test("uses the implicit OpenAI provider with environment precedence", async () => {
		const userRoot = join(await createTempDirectory(), "missing-user-root");
		const env = {
			OPENAI_API_KEY: "secret",
			OPENAI_MODEL: "org/Exact:Model",
			OPENAI_BASE_URL: "https://gateway.example/v1/",
			OPENAI_TIMEOUT_SECONDS: "2.5",
			OPENAI_MAX_RETRIES: "0",
			OPENAI_MAX_RETRY_DELAY_SECONDS: "0",
		};
		const settings = await loadProviderSettings({ userRoot, env });

		expect(settings).toMatchObject({
			version: 1,
			defaultProvider: "openai",
		});
		expect(settings.providers.openai).toMatchObject({
			id: "openai",
			type: "openai-compatible",
			builtIn: true,
			baseUrl: "https://gateway.example/v1",
			apiKeyEnv: "OPENAI_API_KEY",
			models: ["org/Exact:Model"],
			defaultModel: "org/Exact:Model",
			timeoutSeconds: 2.5,
			maxRetries: 0,
			maxRetryDelaySeconds: 0,
			compat: { thinkingLevelMap: { off: "none" } },
		});
		expect(Object.isFrozen(settings)).toBe(true);
		expect(Object.isFrozen(settings.providers.openai?.models)).toBe(true);
		expect(
			resolveProviderSelection(settings, { model: "org/Exact:Model" }),
		).toEqual({ provider: "openai", model: "org/Exact:Model" });
		expect(() =>
			resolveProviderSelection(settings, { model: "org/exact:model" }),
		).toThrow('Unknown model "org/exact:model"');

		let adapterConfig: OpenAICompatibleConfig | undefined;
		const runtime = createProviderRuntime(
			settings,
			{ provider: "openai", model: "org/Exact:Model" },
			{
				env,
				createProvider(config) {
					adapterConfig = config;
					return new FakeProvider([], { providerId: "openai" });
				},
			},
		);
		expect(runtime.timeoutMs).toBe(2_500);
		expect(adapterConfig).toMatchObject({
			providerId: "openai",
			baseUrl: "https://gateway.example/v1",
			apiKey: "secret",
			retry: { maxRetries: 0, maxRetryDelayMs: 0 },
		});
	});

	test("normalizes snake-case thinking compatibility and forwards it to the adapter", () => {
		const settings = parseProviderSettings(
			{
				version: 1,
				default_provider: "local",
				providers: {
					local: {
						type: "openai-compatible",
						base_url: "https://api.example/v1",
						models: ["reasoning-model"],
						default_model: "reasoning-model",
						thinking_format: "zai",
						supports_reasoning_effort: true,
						thinking_level_map: {
							off: null,
							low: "high",
							max: "max",
						},
					},
				},
			},
			{ path: "/tmp/providers.json", env: {} },
		);
		expect(settings.providers.local?.compat).toEqual({
			thinkingFormat: "zai",
			supportsReasoningEffort: true,
			thinkingLevelMap: { off: null, low: "high", max: "max" },
		});

		let adapterConfig: OpenAICompatibleConfig | undefined;
		createProviderRuntime(
			settings,
			{ provider: "local", model: "reasoning-model" },
			{
				env: {},
				createProvider(config) {
					adapterConfig = config;
					return new FakeProvider([], { providerId: "local" });
				},
			},
		);
		expect(adapterConfig?.compat).toEqual({
			thinkingFormat: "zai",
			supportsReasoningEffort: true,
			thinkingLevelMap: { off: null, low: "high", max: "max" },
		});
	});

	test("uses the hardcoded model when no OpenAI model is configured", async () => {
		const settings = await loadProviderSettings({
			userRoot: join(await createTempDirectory(), "user"),
			env: {},
		});
		expect(settings.providers.openai?.defaultModel).toBe(DEFAULT_OPENAI_MODEL);
	});

	test("reports strict schema and semantic failures with file and field paths", () => {
		const path = "/tmp/example/providers.json";
		for (const [document, field] of [
			[{ version: 2 }, "$.version"],
			[{ version: 1, unexpected: true }, "$.unexpected"],
			[
				{
					version: 1,
					providers: {
						local: {
							type: "openai-compatible",
							base_url: "http://localhost/v1",
							models: ["qwen", "qwen"],
							default_model: "qwen",
						},
					},
				},
				"$.providers.local.models[1]",
			],
			[
				{
					version: 1,
					providers: {
						local: {
							type: "openai-compatible",
							base_url: "http://localhost/v1",
							models: ["qwen"],
							default_model: "llama",
						},
					},
				},
				"$.providers.local.default_model",
			],
			[
				{
					version: 1,
					default_provider: "missing",
				},
				"$.default_provider",
			],
			[
				{
					version: 1,
					providers: { openai: { api_key: "secret" } },
				},
				"$.providers.openai.api_key",
			],
			[
				{
					version: 1,
					providers: { local: { thinking_format: "qwen" } },
				},
				"$.providers.local.thinking_format",
			],
			[
				{
					version: 1,
					providers: { local: { supports_reasoning_effort: "true" } },
				},
				"$.providers.local.supports_reasoning_effort",
			],
			[
				{
					version: 1,
					providers: { local: { thinking_level_map: { minimal: "low" } } },
				},
				"$.providers.local.thinking_level_map.minimal",
			],
			[
				{
					version: 1,
					providers: { local: { thinking_level_map: { high: "" } } },
				},
				"$.providers.local.thinking_level_map.high",
			],
			[
				{
					version: 1,
					providers: { local: { thinkingFormat: "zai" } },
				},
				"$.providers.local.thinkingFormat",
			],
		] as const) {
			expect(() => parseProviderSettings(document, { path, env: {} })).toThrow(
				`${path}: ${field}`,
			);
		}
	});

	test("keeps stale favorites but exposes only currently usable exact models", () => {
		const settings = parseProviderSettings(
			{
				version: 1,
				default_provider: "local",
				providers: {
					local: {
						type: "openai-compatible",
						base_url: "http://localhost:11434/v1",
						models: ["Qwen/Exact", "llama:latest"],
						default_model: "Qwen/Exact",
					},
					remote: {
						type: "openai-compatible",
						base_url: "https://remote.example/v1",
						api_key_env: "REMOTE_KEY",
						models: ["remote-model"],
						default_model: "remote-model",
					},
				},
				favorite_models: [
					{ provider: "local", model: "Qwen/Exact" },
					{ provider: "local", model: "removed" },
					{ provider: "remote", model: "remote-model" },
					{ provider: "removed", model: "old" },
				],
			},
			{ path: "/tmp/providers.json", env: {} },
		);

		expect(settings.favoriteModels).toHaveLength(4);
		expect(usableFavoriteModels(settings, {})).toEqual([
			{ provider: "local", model: "Qwen/Exact" },
		]);
		expect(
			configuredProviderModels(settings, {}).find(
				(entry) => entry.provider === "remote",
			),
		).toMatchObject({
			authStatus: "missing:REMOTE_KEY",
			usable: false,
		});
		expect(() =>
			createProviderRuntime(
				settings,
				{ provider: "remote", model: "remote-model" },
				{ env: {} },
			),
		).toThrow("requires environment variable REMOTE_KEY");
	});
});

describe("provider settings persistence", () => {
	test("writes private files and preserves concurrent provider updates", async () => {
		const userRoot = join(await createTempDirectory(), "user");
		await Promise.all([
			setupOpenAICompatibleProvider({
				userRoot,
				env: {},
				provider: "alpha",
				baseUrl: "http://alpha.example/v1",
				models: ["a"],
				defaultModel: "a",
			}),
			setupOpenAICompatibleProvider({
				userRoot,
				env: {},
				provider: "beta",
				baseUrl: "http://beta.example/v1",
				models: ["b"],
				defaultModel: "b",
			}),
		]);

		const settings = await loadProviderSettings({ userRoot, env: {} });
		expect(Object.keys(settings.providers).sort()).toEqual([
			"alpha",
			"beta",
			"openai",
		]);
		const filePath = join(userRoot, "providers.json");
		expect((await stat(userRoot)).mode & 0o777).toBe(0o700);
		expect((await stat(filePath)).mode & 0o777).toBe(0o600);
		expect(await readFile(filePath, "utf8")).not.toContain("api_key");
	});

	test("preserves omitted fields and never overwrites a valid file with an invalid update", async () => {
		const userRoot = join(await createTempDirectory(), "user");
		await setupOpenAICompatibleProvider({
			userRoot,
			env: {},
			provider: "local",
			baseUrl: "http://localhost:11434/v1",
			models: ["qwen", "llama"],
			defaultModel: "qwen",
			timeoutSeconds: 120,
		});
		const filePath = join(userRoot, "providers.json");
		const configured = JSON.parse(await readFile(filePath, "utf8")) as {
			providers: Record<string, Record<string, unknown>>;
		};
		Object.assign(configured.providers.local ?? {}, {
			thinking_format: "zai",
			supports_reasoning_effort: true,
			thinking_level_map: { off: null, high: "max" },
		});
		await writeFile(filePath, `${JSON.stringify(configured)}\n`, "utf8");
		const before = await readFile(filePath, "utf8");

		await expect(
			setupOpenAICompatibleProvider({
				userRoot,
				env: {},
				provider: "local",
				models: ["llama"],
			}),
		).rejects.toThrow("must include existing default model");
		expect(await readFile(filePath, "utf8")).toBe(before);

		const updated = await setupOpenAICompatibleProvider({
			userRoot,
			env: {},
			provider: "local",
			models: ["llama"],
			defaultModel: "llama",
			setDefault: true,
		});
		expect(updated.providers.local).toMatchObject({
			baseUrl: "http://localhost:11434/v1",
			models: ["llama"],
			defaultModel: "llama",
			timeoutSeconds: 120,
			compat: {
				thinkingFormat: "zai",
				supportsReasoningEffort: true,
				thinkingLevelMap: { off: null, high: "max" },
			},
		});
		expect(updated.defaultProvider).toBe("local");
		expect(updated.defaultModel).toBe("llama");
		expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
			providers: {
				local: {
					thinking_format: "zai",
					supports_reasoning_effort: true,
					thinking_level_map: { off: null, high: "max" },
				},
			},
		});
	});

	test("persists a credential-backed default without changing provider setup", async () => {
		const userRoot = join(await createTempDirectory(), "user");
		await setupOpenAICompatibleProvider({
			userRoot,
			env: {},
			provider: "local",
			baseUrl: "http://localhost:11434/v1",
			models: ["qwen"],
			defaultModel: "qwen",
		});
		const path = join(userRoot, "providers.json");
		const document = JSON.parse(await readFile(path, "utf8")) as Record<
			string,
			unknown
		>;
		document.favorite_models = [{ provider: "local", model: "qwen" }];
		await writeFile(path, `${JSON.stringify(document)}\n`, "utf8");

		const settings = await saveDefaultProviderModel(
			{ provider: "openai-codex", model: "gpt-5.6-terra" },
			{ userRoot, env: {} },
		);

		expect(settings).toMatchObject({
			defaultProvider: "openai-codex",
			defaultModel: "gpt-5.6-terra",
			favoriteModels: [{ provider: "local", model: "qwen" }],
		});
		expect(settings.providers.local?.models).toEqual(["qwen"]);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			default_provider: "openai-codex",
			default_model: "gpt-5.6-terra",
			providers: {
				local: { default_model: "qwen" },
			},
			favorite_models: [{ provider: "local", model: "qwen" }],
		});
	});
});
