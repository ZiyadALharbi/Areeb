import { describe, expect, test } from "bun:test";
import {
	DEFAULT_OPENAI_BASE_URL,
	openAICompatibleConfigFromEnv,
} from "../../src/ai/environment.ts";

describe("openAICompatibleConfigFromEnv", () => {
	test("loads the OpenAI API key and default endpoint", () => {
		const config = openAICompatibleConfigFromEnv({
			env: { OPENAI_API_KEY: "  test-key  " },
		});

		expect(config).toEqual({
			providerId: "openai",
			apiKey: "test-key",
			baseUrl: DEFAULT_OPENAI_BASE_URL,
		});
	});

	test("loads a custom endpoint and removes trailing slashes", () => {
		const config = openAICompatibleConfigFromEnv({
			env: {
				OPENAI_API_KEY: "test-key",
				OPENAI_BASE_URL: " https://gateway.example.test/v1/// ",
			},
		});

		expect(config.baseUrl).toBe("https://gateway.example.test/v1");
	});

	test("supports provider-specific environment variable names", () => {
		const config = openAICompatibleConfigFromEnv({
			env: {
				COMPATIBLE_API_KEY: "compatible-key",
				COMPATIBLE_BASE_URL: "https://compatible.example.test/v1",
			},
			providerId: "compatible",
			apiKeyVar: "COMPATIBLE_API_KEY",
			baseUrlVar: "COMPATIBLE_BASE_URL",
			defaultBaseUrl: "https://unused.example.test/v1",
		});

		expect(config).toEqual({
			providerId: "compatible",
			apiKey: "compatible-key",
			baseUrl: "https://compatible.example.test/v1",
		});
	});

	test("rejects missing or blank API keys", () => {
		expect(() => openAICompatibleConfigFromEnv({ env: {} })).toThrow(
			"Missing required environment variable: OPENAI_API_KEY",
		);
		expect(() =>
			openAICompatibleConfigFromEnv({
				env: { OPENAI_API_KEY: "   " },
			}),
		).toThrow("Missing required environment variable: OPENAI_API_KEY");
	});
});
