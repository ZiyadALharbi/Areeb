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
		const rendered = stripTerminalSequences(picker.render(80).join("\n"));
		expect(rendered).toContain("Providers");
		expect(rendered).toContain("Connect with a subscription or API key.");
		expect(rendered).toContain("subscription");
		expect(rendered).toContain("connected (environment)");
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
