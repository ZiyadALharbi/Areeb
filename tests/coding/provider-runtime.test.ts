import { describe, expect, test } from "bun:test";
import type { CodexProviderConfig } from "../../src/ai/codex_provider.ts";
import { FakeProvider } from "../../src/ai/fake_provider.ts";
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
		const service = new ProviderRuntimeService({
			settings,
			store,
			registry: createDefaultProviderAuthRegistry(),
			env: { OPENAI_API_KEY: "environment-key" },
			createProvider(config) {
				configuredKey = config.apiKey;
				return new FakeProvider([], { providerId: config.providerId });
			},
		});

		await service.createRuntime({ provider: "openai", model: "gpt-5.6-sol" });
		expect(configuredKey).toBe("environment-key");
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
});
