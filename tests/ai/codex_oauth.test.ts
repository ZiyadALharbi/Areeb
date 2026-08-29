import { describe, expect, test } from "bun:test";
import type { AuthInteraction } from "../../src/ai/auth.ts";
import {
	CodexOAuth,
	extractCodexAccountId,
	parseManualCode,
} from "../../src/ai/codex_oauth.ts";

function jwt(accountId: string): string {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

describe("CodexOAuth", () => {
	test("runs browser PKCE with manual fallback and returns generic OAuth credentials", async () => {
		const requests: Request[] = [];
		const access = jwt("account-1");
		const fetcher = (async (
			input: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) => {
			requests.push(new Request(String(input), init));
			return Response.json({
				access_token: access,
				refresh_token: "refresh-1",
				expires_in: 3600,
			});
		}) as unknown as typeof fetch;
		const oauth = new CodexOAuth({
			fetch: fetcher,
			now: () => 1_000,
			randomBytes: (size) => new Uint8Array(size).fill(7),
			callbackPort: 0,
		});
		let authorizeUrl = "";
		const interaction: AuthInteraction = {
			notify(notification) {
				authorizeUrl = notification.url;
			},
			prompt: async () => "manual-code",
		};

		expect(await oauth.login(interaction)).toEqual({
			type: "oauth",
			access,
			refresh: "refresh-1",
			expires: 3_601_000,
			metadata: { accountId: "account-1" },
		});
		const url = new URL(authorizeUrl);
		expect(url.origin).toBe("https://auth.openai.com");
		expect(url.searchParams.get("originator")).toBe("areeb");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(await requests[0]?.text()).toContain("code=manual-code");
	});

	test("rotates refresh tokens and rejects malformed account claims", async () => {
		const access = jwt("account-2");
		const oauth = new CodexOAuth({
			fetch: (async () =>
				Response.json({
					access_token: access,
					refresh_token: "rotated",
					expires_in: 60,
				})) as unknown as typeof fetch,
			now: () => 5_000,
		});
		expect(
			await oauth.refresh({
				type: "oauth",
				access: jwt("old"),
				refresh: "old-refresh",
				expires: 0,
			}),
		).toMatchObject({ refresh: "rotated", expires: 65_000 });
		expect(() => extractCodexAccountId("a.b.c")).toThrow("invalid JWT");
	});
});

describe("parseManualCode", () => {
	test("accepts redirect URLs, code-state pairs, query strings, and raw codes", () => {
		expect(
			parseManualCode(
				"http://localhost:1455/auth/callback?code=url-code&state=expected",
				"expected",
			),
		).toBe("url-code");
		expect(parseManualCode("pair-code#expected", "expected")).toBe("pair-code");
		expect(parseManualCode("code=query-code&state=expected", "expected")).toBe(
			"query-code",
		);
		expect(parseManualCode("raw-code", "expected")).toBe("raw-code");
		expect(() => parseManualCode("code#wrong", "expected")).toThrow(
			"state does not match",
		);
	});
});
