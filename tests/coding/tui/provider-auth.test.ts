import { describe, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	AuthDialog,
	ProviderPicker,
} from "../../../src/coding/tui/provider-auth.ts";
import { AREEB_DARK_THEME } from "../../../src/coding/tui/theme.ts";

describe("provider auth TUI", () => {
	test("renders searchable two-line provider rows with connection status", () => {
		const picker = new ProviderPicker(
			[
				{
					id: "openai-codex",
					displayName: "ChatGPT Plus/Pro (Codex Subscription)",
					authType: "oauth",
					authLabel: "subscription",
					status: "not connected",
					stored: false,
				},
				{
					id: "openai",
					displayName: "OpenAI",
					authType: "api_key",
					authLabel: "api key",
					status: "connected",
					source: "environment",
					stored: false,
				},
			],
			"login",
			AREEB_DARK_THEME,
		);
		const lines = picker.render(80);
		const rendered = stripTerminalSequences(lines.join("\n"));
		expect(rendered).toContain("ChatGPT Plus/Pro (Codex Subscription)");
		expect(rendered).toContain("OAuth · subscription");
		expect(rendered).toContain("API key · api key");
		expect(rendered).toContain("connected (environment)");
		expect(lines.join("\n")).toContain("\u001b[1m");
	});

	test("masks API keys and never renders the secret", async () => {
		const dialog = new AuthDialog(
			{
				title: "Login to OpenAI",
				subtitle: "Enter an API key to connect this provider.",
				authType: "api_key",
				onCancel() {},
			},
			AREEB_DARK_THEME,
		);
		const result = dialog.requestInput({
			type: "text",
			label: "OpenAI API key",
			secret: true,
		});
		for (const character of "sk-secret") {
			dialog.handleInput(character);
		}
		const rendered = stripTerminalSequences(dialog.render(80).join("\n"));
		expect(rendered).not.toContain("sk-secret");
		expect(rendered).toContain("•••••••••");
		dialog.handleInput("\r");
		expect(await result).toBe("sk-secret");
	});
});
