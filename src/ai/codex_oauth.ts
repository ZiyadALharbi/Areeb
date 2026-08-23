import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AuthInteraction, OAuthCredential, ProviderAuth } from "./auth.ts";
import { createAuthAbortError, throwIfAuthAborted } from "./auth.ts";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_BASE_URL = "https://auth.openai.com";
export const CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_OAUTH_SCOPE = "openid profile email offline_access";
export const CODEX_OAUTH_CALLBACK_PORT = 1455;

const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const TOKEN_TIMEOUT_MS = 15_000;
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

type Fetch = typeof globalThis.fetch;

export interface CodexOAuthOptions {
	readonly fetch?: Fetch;
	readonly now?: () => number;
	readonly randomBytes?: (size: number) => Uint8Array;
	readonly callbackHost?: string;
	readonly callbackPort?: number;
}

interface TokenResponse {
	readonly access_token: string;
	readonly refresh_token: string;
	readonly expires_in: number;
}

interface CallbackWaiter {
	readonly waitForCode: Promise<string>;
	close(): Promise<void>;
}

export class CodexOAuth implements ProviderAuth<OAuthCredential> {
	private readonly fetch: Fetch;
	private readonly now: () => number;
	private readonly random: (size: number) => Uint8Array;
	private readonly callbackHost: string;
	private readonly callbackPort: number;

	constructor(options: CodexOAuthOptions = {}) {
		this.fetch = options.fetch ?? globalThis.fetch;
		this.now = options.now ?? Date.now;
		this.random = options.randomBytes ?? randomBytes;
		this.callbackHost = options.callbackHost ?? "127.0.0.1";
		this.callbackPort = options.callbackPort ?? CODEX_OAUTH_CALLBACK_PORT;
	}

	async login(interaction: AuthInteraction): Promise<OAuthCredential> {
		throwIfAuthAborted(interaction.signal);
		const verifier = base64Url(this.random(32));
		const challenge = base64Url(createHash("sha256").update(verifier).digest());
		const state = Buffer.from(this.random(16)).toString("hex");
		const authorizeUrl = createAuthorizeUrl(challenge, state);
		const callback = await this.startCallback(state, interaction.signal).catch(
			(error) => {
				if (isAbortError(error, interaction.signal)) {
					throw error;
				}
				return undefined;
			},
		);
		const manualController = new AbortController();
		const manualSignal = combineSignals(
			interaction.signal,
			manualController.signal,
		);

		try {
			await interaction.notify({ type: "auth_url", url: authorizeUrl });
			const manualCode = interaction
				.prompt({
					type: "manual_code",
					label: "Paste redirect URL below, or complete login in browser:",
					placeholder: "http://localhost:1455/auth/callback?code=...",
					signal: manualSignal,
				})
				.then((value) => parseManualCode(value, state));
			void manualCode.catch(() => undefined);

			let code: string;
			if (callback === undefined) {
				code = await manualCode;
			} else {
				code = await Promise.race([callback.waitForCode, manualCode]);
			}
			manualController.abort();
			throwIfAuthAborted(interaction.signal);
			const token = await this.exchangeToken(
				code,
				verifier,
				interaction.signal,
			);
			return toCredential(token, this.now());
		} finally {
			manualController.abort();
			await callback?.close();
		}
	}

	async refresh(
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<OAuthCredential> {
		throwIfAuthAborted(signal);
		const response = await fetchWithTimeout(
			this.fetch,
			`${CODEX_OAUTH_BASE_URL}/oauth/token`,
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: credential.refresh,
					client_id: CODEX_OAUTH_CLIENT_ID,
				}),
			},
			signal,
		);
		const token = await parseTokenResponse(response, "refresh OAuth token");
		return toCredential(token, this.now());
	}

	private async exchangeToken(
		code: string,
		verifier: string,
		signal?: AbortSignal,
	): Promise<TokenResponse> {
		const response = await fetchWithTimeout(
			this.fetch,
			`${CODEX_OAUTH_BASE_URL}/oauth/token`,
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					client_id: CODEX_OAUTH_CLIENT_ID,
					code,
					code_verifier: verifier,
					redirect_uri: CODEX_OAUTH_REDIRECT_URI,
				}),
			},
			signal,
		);
		return parseTokenResponse(response, "exchange OAuth code");
	}

	private async startCallback(
		state: string,
		signal?: AbortSignal,
	): Promise<CallbackWaiter> {
		throwIfAuthAborted(signal);
		let settled = false;
		let resolveCode!: (code: string) => void;
		let rejectCode!: (error: unknown) => void;
		const waitForCode = new Promise<string>((resolve, reject) => {
			resolveCode = resolve;
			rejectCode = reject;
		});
		void waitForCode.catch(() => undefined);

		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", CODEX_OAUTH_REDIRECT_URI);
			if (url.pathname !== "/auth/callback") {
				response.writeHead(404).end("Not found");
				return;
			}
			if (url.searchParams.get("state") !== state) {
				response.writeHead(400).end("Invalid OAuth state");
				return;
			}
			const code = url.searchParams.get("code")?.trim();
			if (!code) {
				response.writeHead(400).end("Missing OAuth code");
				return;
			}
			response
				.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
				.end("Login complete. You can close this window and return to Areeb.");
			if (!settled) {
				settled = true;
				resolveCode(code);
			}
		});

		await listen(server, this.callbackPort, this.callbackHost, signal);
		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				rejectCode(new Error("OAuth callback timed out"));
			}
		}, CALLBACK_TIMEOUT_MS);
		const onAbort = (): void => {
			if (!settled) {
				settled = true;
				rejectCode(createAuthAbortError());
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		return {
			waitForCode,
			async close() {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				if (!settled) {
					settled = true;
					rejectCode(createAuthAbortError());
				}
				await closeServer(server);
			},
		};
	}
}

export function extractCodexAccountId(accessToken: string): string {
	const parts = accessToken.split(".");
	if (parts.length !== 3 || !parts[1]) {
		throw new Error("OAuth access token is not a valid JWT");
	}
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch (error) {
		throw new Error("OAuth access token has an invalid JWT payload", {
			cause: error,
		});
	}
	if (typeof payload !== "object" || payload === null) {
		throw new Error("OAuth access token has an invalid JWT payload");
	}
	const auth = Reflect.get(payload, CODEX_ACCOUNT_CLAIM);
	const accountId =
		typeof auth === "object" && auth !== null
			? Reflect.get(auth, "chatgpt_account_id")
			: undefined;
	if (typeof accountId !== "string" || accountId.trim().length === 0) {
		throw new Error("OAuth access token is missing chatgpt_account_id");
	}
	return accountId;
}

export function parseManualCode(value: string, expectedState: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error("OAuth code cannot be empty");
	}

	let code = normalized;
	let suppliedState: string | undefined;
	try {
		const url = new URL(normalized);
		code = url.searchParams.get("code")?.trim() ?? "";
		suppliedState = url.searchParams.get("state")?.trim() || undefined;
	} catch {
		const fragmentSeparator = normalized.indexOf("#");
		if (fragmentSeparator > 0) {
			code = normalized.slice(0, fragmentSeparator).trim();
			suppliedState =
				normalized.slice(fragmentSeparator + 1).trim() || undefined;
		} else if (normalized.includes("code=")) {
			const params = new URLSearchParams(normalized.replace(/^\?/, ""));
			code = params.get("code")?.trim() ?? "";
			suppliedState = params.get("state")?.trim() || undefined;
		}
	}
	if (suppliedState !== undefined && suppliedState !== expectedState) {
		throw new Error("OAuth state does not match this login attempt");
	}
	if (!code) {
		throw new Error("OAuth redirect does not contain a code");
	}
	return code;
}

function createAuthorizeUrl(challenge: string, state: string): string {
	const url = new URL("/oauth/authorize", CODEX_OAUTH_BASE_URL);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: CODEX_OAUTH_CLIENT_ID,
		redirect_uri: CODEX_OAUTH_REDIRECT_URI,
		scope: CODEX_OAUTH_SCOPE,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		originator: "areeb",
	}).toString();
	return url.toString();
}

async function parseTokenResponse(
	response: Response,
	action: string,
): Promise<TokenResponse> {
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`Failed to ${action}: HTTP ${response.status}${body ? `: ${body}` : ""}`,
		);
	}
	let value: unknown;
	try {
		value = await response.json();
	} catch (error) {
		throw new Error(`Failed to ${action}: invalid JSON response`, {
			cause: error,
		});
	}
	if (typeof value !== "object" || value === null) {
		throw new Error(`Failed to ${action}: invalid token response`);
	}
	const accessToken = Reflect.get(value, "access_token");
	const refreshToken = Reflect.get(value, "refresh_token");
	const expiresIn = Reflect.get(value, "expires_in");
	if (
		typeof accessToken !== "string" ||
		!accessToken ||
		typeof refreshToken !== "string" ||
		!refreshToken ||
		typeof expiresIn !== "number" ||
		!Number.isFinite(expiresIn) ||
		expiresIn <= 0
	) {
		throw new Error(`Failed to ${action}: incomplete token response`);
	}
	return {
		access_token: accessToken,
		refresh_token: refreshToken,
		expires_in: expiresIn,
	};
}

function toCredential(token: TokenResponse, now: number): OAuthCredential {
	const accountId = extractCodexAccountId(token.access_token);
	return Object.freeze({
		type: "oauth",
		access: token.access_token,
		refresh: token.refresh_token,
		expires: now + token.expires_in * 1_000,
		metadata: Object.freeze({ accountId }),
	});
}

async function fetchWithTimeout(
	fetcher: Fetch,
	url: string,
	init: RequestInit,
	signal?: AbortSignal,
): Promise<Response> {
	const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
	const combined = combineSignals(signal, timeout);
	try {
		return await fetcher(url, { ...init, signal: combined });
	} catch (error) {
		if (isAbortError(error, signal)) {
			throw createAuthAbortError();
		}
		throw error;
	}
}

function combineSignals(
	left: AbortSignal | undefined,
	right: AbortSignal,
): AbortSignal {
	return left === undefined ? right : AbortSignal.any([left, right]);
}

function base64Url(value: Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

function listen(
	server: Server,
	port: number,
	host: string,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (error: unknown): void => {
			cleanup();
			reject(error);
		};
		const onListening = (): void => {
			cleanup();
			resolve();
		};
		const onAbort = (): void => {
			cleanup();
			server.close();
			reject(createAuthAbortError());
		};
		const cleanup = (): void => {
			server.off("error", onError);
			server.off("listening", onListening);
			signal?.removeEventListener("abort", onAbort);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		signal?.addEventListener("abort", onAbort, { once: true });
		server.listen(port, host);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error && errorCode(error) !== "ERR_SERVER_NOT_RUNNING") {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	return (
		signal?.aborted === true ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}
	const code = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}
