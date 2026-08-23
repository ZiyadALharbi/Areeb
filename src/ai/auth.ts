export interface ApiKeyCredential {
	readonly type: "api_key";
	readonly key: string;
}

export interface OAuthCredential {
	readonly type: "oauth";
	readonly access: string;
	readonly refresh: string;
	readonly expires: number;
	readonly metadata?: Readonly<Record<string, string>>;
}

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthType = AuthCredential["type"];

export type AuthNotification = {
	readonly type: "auth_url";
	readonly url: string;
};

export type AuthPrompt =
	| {
			readonly type: "manual_code";
			readonly label: string;
			readonly placeholder?: string;
			readonly signal?: AbortSignal;
	  }
	| {
			readonly type: "text";
			readonly label: string;
			readonly placeholder?: string;
			readonly secret?: boolean;
			readonly signal?: AbortSignal;
	  };

export interface AuthInteraction {
	readonly signal?: AbortSignal;
	notify(notification: AuthNotification): void | Promise<void>;
	prompt(request: AuthPrompt): Promise<string>;
}

export interface ProviderAuth<TCredential extends AuthCredential> {
	login(interaction: AuthInteraction): Promise<TCredential>;
	refresh(credential: TCredential, signal?: AbortSignal): Promise<TCredential>;
}

export class AuthCancelledError extends Error {
	constructor(message = "Login cancelled") {
		super(message);
		this.name = "AuthCancelledError";
	}
}

export function createAuthAbortError(message = "Login cancelled"): Error {
	const error = new AuthCancelledError(message);
	error.name = "AbortError";
	return error;
}

export function throwIfAuthAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw createAuthAbortError();
	}
}
