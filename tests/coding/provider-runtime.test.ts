import { describe, expect, test } from "bun:test";
import type { CodexProviderConfig } from "../../src/ai/codex_provider.ts";
import { FakeProvider } from "../../src/ai/fake_provider.ts";
import type { OpenAICompatibleConfig } from "../../src/ai/openai_compatible_provider.ts";
import type { OpenAIResponsesConfig } from "../../src/ai/openai_responses_provider.ts";
import { MemoryCredentialStore } from "../../src/coding/auth-store.ts";
import {
	createDefaultProviderAuthRegistry,
	ProviderAuthRegistry,
} from "../../src/coding/provider-auth.ts";
import { parseProviderSettings } from "../../src/coding/provider-config.ts";
import { ProviderRuntimeService } from "../../src/coding/provider-runtime.ts";

function jwt(accountId: string): string {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

describe("ProviderRuntimeService", () => {
	test("prefers exact live model limits and coalesces discovery per provider instance", async () => {
		const settings = parseProviderSettings(
			{
				version: 1,
				default_provider: "local",
				providers: {
					local: {
						type: "openai-compatible",
						base_url: "https://api.example/v1",
						models: ["model-a", "model-b"],
						default_model: "model-a",
						context_windows: { "model-a": 64_000, "model-b": 32_000 },
					},
				},
			},
			{ path: "/tmp/providers.json", env: {} },
		);
		let discoveryCalls = 0;
		let releaseDiscovery!: () => void;
		const discoveryStarted = new Promise<void>((resolve) => {
			releaseDiscovery = resolve;
		});
		const provider = Object.assign(
			new FakeProvider([], { providerId: "local" }),
			{
				async discoverModelLimits() {
					discoveryCalls += 1;
					await discoveryStarted;
					return [
						{
							model: "model-a",
							contextWindowTokens: 200_000,
							effectiveContextWindowPercent: 90,
						},
					];
				},
			},
		);
		const service = new ProviderRuntimeService({
			settings,
			store: new MemoryCredentialStore(),
			registry: createDefaultProviderAuthRegistry(),
			env: {},
			createProvider: () => provider,
		});

		const first = service.createRuntime({
			provider: "local",
			model: "model-a",
		});
		const second = service.createRuntime({
			provider: "local",
			model: "model-a",
		});
		await Promise.resolve();
		expect(discoveryCalls).toBe(1);
		releaseDiscovery();
		expect(await Promise.all([first, second])).toEqual([
			expect.objectContaining({
				provider,
				contextWindowTokens: 200_000,
				contextWindowSource: "live",
				effectiveContextWindowPercent: 90,
			}),
			expect.objectContaining({
				provider,
				contextWindowTokens: 200_000,
				contextWindowSource: "live",
			}),
		]);

		expect(
			await service.createRuntime({ provider: "local", model: "model-b" }),
		).toMatchObject({
			contextWindowTokens: 32_000,
			contextWindowSource: "configured",
		});
		expect(discoveryCalls).toBe(1);
	});

	test("keeps discovery failures nonfatal and isolated by provider instance", async () => {
		const settings = parseProviderSettings(
			{
				version: 1,
				default_provider: "alpha",
				providers: {
					alpha: {
						type: "openai-compatible",
						base_url: "https://alpha.example/v1",
						models: ["shared"],
						default_model: "shared",
					},
					beta: {
						type: "openai-compatible",
						base_url: "https://beta.example/v1",
						models: ["shared"],
						default_model: "shared",
					},
				},
			},
			{ path: "/tmp/providers.json", env: {} },
		);
		const calls = new Map<string, number>();
		const providers = new Map(
			["alpha", "beta"].map((providerId) => [
				providerId,
				Object.assign(new FakeProvider([], { providerId }), {
					async discoverModelLimits() {
						calls.set(providerId, (calls.get(providerId) ?? 0) + 1);
						if (providerId === "alpha") {
							throw new Error("alpha catalog unavailable");
						}
						return [{ model: "shared", contextWindowTokens: 96_000 }];
					},
				}),
			]),
		);
		const service = new ProviderRuntimeService({
			settings,
			store: new MemoryCredentialStore(),
			registry: createDefaultProviderAuthRegistry(),
			env: {},
			createProvider(config) {
				const provider = providers.get(config.providerId);
				if (provider === undefined) {
					throw new Error(`Unexpected provider ${config.providerId}`);
				}
				return provider;
			},
		});

		const [alpha, beta] = await Promise.all([
			service.createRuntime({ provider: "alpha", model: "shared" }),
			service.createRuntime({ provider: "beta", model: "shared" }),
		]);
		expect(alpha).toMatchObject({
			contextWindowTokens: 128_000,
			contextWindowSource: "fallback",
			contextWindowDiscoveryError: "alpha catalog unavailable",
		});
		expect(beta).toMatchObject({
			contextWindowTokens: 96_000,
			contextWindowSource: "live",
		});
		expect(beta).not.toHaveProperty("contextWindowDiscoveryError");
		expect(calls).toEqual(
			new Map([
				["alpha", 1],
				["beta", 1],
			]),
		);

		await service.createRuntime({ provider: "alpha", model: "shared" });
		expect(calls.get("alpha")).toBe(1);
	});

	test("forwards provider thinking compatibility through authenticated runtimes", async () => {
		const settings = parseProviderSettings(
			{
				version: 1,
				default_provider: "local",
				providers: {
					local: {
						type: "openai-compatible",
						base_url: "https://api.example/v1",
						models: ["model-a"],
						default_model: "model-a",
						thinking_format: "zai",
						supports_reasoning_effort: true,
						thinking_level_map: { off: null, max: "maximum" },
					},
				},
			},
			{ path: "/tmp/providers.json", env: {} },
		);
		let providerConfig: OpenAICompatibleConfig | undefined;
		const service = new ProviderRuntimeService({
			settings,
			store: new MemoryCredentialStore(),
			registry: createDefaultProviderAuthRegistry(),
			env: {},
			createProvider(config) {
				providerConfig = config;
				return new FakeProvider([], { providerId: config.providerId });
			},
		});

		await service.createRuntime({ provider: "local", model: "model-a" });
		expect(providerConfig?.compat).toEqual({
			thinkingFormat: "zai",
			supportsReasoningEffort: true,
			thinkingLevelMap: { off: null, max: "maximum" },
		});
	});

	test("uses environment before stored OpenAI keys and gates the model catalog", async () => {
		const settings = parseProviderSettings(
			{ version: 1 },
			{
				path: "/tmp/providers.json",
				env: {},
			},
		);
		const store = new MemoryCredentialStore({
			openai: { type: "api_key", key: "stored-key" },
		});
		let configuredKey: string | undefined;
		let responsesConfig: OpenAIResponsesConfig | undefined;
		const service = new ProviderRuntimeService({
			settings,
			store,
			registry: createDefaultProviderAuthRegistry(),
			env: { OPENAI_API_KEY: "environment-key" },
			createOpenAIResponsesProvider(config) {
				responsesConfig = config;
				configuredKey = config.apiKey;
				return new FakeProvider([], { providerId: config.providerId });
			},
		});

		await service.createRuntime({ provider: "openai", model: "gpt-5.6-sol" });
		expect(configuredKey).toBe("environment-key");
		expect(responsesConfig).toMatchObject({
			providerId: "openai",
			baseUrl: "https://api.openai.com/v1",
			retry: { maxRetries: 2, maxRetryDelayMs: 60_000 },
		});
		expect(await service.usableModels()).toContainEqual(
			expect.objectContaining({
				provider: "openai",
				model: "gpt-5.6-sol",
				usable: true,
			}),
		);
		expect(
			(await service.usableModels()).filter(
				(entry) => entry.provider === "openai",
			),
		).toHaveLength(38);
		expect(await service.listProviders()).toMatchObject([
			{ id: "openai-codex", status: "not connected" },
			{ id: "openai", status: "connected", source: "environment" },
		]);
	});

	test("refreshes an expired Codex token once under contention", async () => {
		let refreshCalls = 0;
		const registry = new ProviderAuthRegistry([
			{
				id: "openai-codex",
				displayName: "ChatGPT Plus/Pro (Codex Subscription)",
				authType: "oauth",
				authLabel: "subscription",
				models: ["gpt-5.6-sol"],
				defaultModel: "gpt-5.6-sol",
				async login() {
					throw new Error("not used");
				},
				async refresh() {
					refreshCalls += 1;
					return {
						type: "oauth",
						access: jwt("account"),
						refresh: "rotated",
						expires: 1_000_000,
					};
				},
			},
		]);
		const store = new MemoryCredentialStore({
			"openai-codex": {
				type: "oauth",
				access: jwt("account"),
				refresh: "old",
				expires: 0,
			},
		});
		let codexConfig: CodexProviderConfig | undefined;
		const service = new ProviderRuntimeService({
			settings: parseProviderSettings(
				{ version: 1 },
				{
					path: "/tmp/providers.json",
					env: {},
				},
			),
			store,
			registry,
			env: {},
			now: () => 10,
			createCodexProvider(config) {
				codexConfig = config;
				return new FakeProvider([], { providerId: "openai-codex" });
			},
		});
		await service.createRuntime({
			provider: "openai-codex",
			model: "gpt-5.6-sol",
		});
		if (codexConfig === undefined) {
			throw new Error("Expected Codex provider config");
		}

		await Promise.all([
			codexConfig.getAuth(),
			codexConfig.getAuth(),
			codexConfig.getAuth(),
		]);
		expect(refreshCalls).toBe(1);
		expect(await store.read("openai-codex")).toMatchObject({
			refresh: "rotated",
		});
	});

	test("selects a globally connected provider for a new implicit session", async () => {
		const service = new ProviderRuntimeService({
			settings: parseProviderSettings(
				{ version: 1 },
				{ path: "/tmp/providers.json", env: {} },
			),
			store: new MemoryCredentialStore({
				"openai-codex": {
					type: "oauth",
					access: jwt("account"),
					refresh: "refresh",
					expires: Date.now() + 60_000,
				},
			}),
			registry: createDefaultProviderAuthRegistry(),
			env: {},
		});

		expect(await service.resolveInitialSelection()).toEqual({
			provider: "openai-codex",
			model: "gpt-5.6-sol",
		});
		expect(
			await service.resolveInitialSelection({ provider: "openai" }),
		).toEqual({ provider: "openai", model: "gpt-5.6-sol" });
	});

	test("prefers the saved global selection and repairs a stale saved model", async () => {
		const store = new MemoryCredentialStore({
			"openai-codex": {
				type: "oauth",
				access: jwt("account"),
				refresh: "refresh",
				expires: Date.now() + 60_000,
			},
		});
		const options = {
			store,
			registry: createDefaultProviderAuthRegistry(),
			env: { OPENAI_API_KEY: "environment-key" },
		};
		const saved = new ProviderRuntimeService({
			...options,
			settings: parseProviderSettings(
				{
					version: 1,
					default_provider: "openai-codex",
					default_model: "gpt-5.6-terra",
				},
				{ path: "/tmp/providers.json", env: options.env },
			),
		});

		expect(await saved.resolveInitialSelection()).toEqual({
			provider: "openai-codex",
			model: "gpt-5.6-terra",
		});

		const stale = new ProviderRuntimeService({
			...options,
			settings: parseProviderSettings(
				{
					version: 1,
					default_provider: "openai-codex",
					default_model: "removed-model",
				},
				{ path: "/tmp/providers.json", env: options.env },
			),
		});
		expect(await stale.resolveInitialSelection()).toEqual({
			provider: "openai-codex",
			model: "gpt-5.6-sol",
		});
	});
});
