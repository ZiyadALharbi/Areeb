import type {
	AuthCredential,
	AuthInteraction,
	AuthType,
	OAuthCredential,
} from "../ai/auth.ts";
import { CodexOAuth } from "../ai/codex_oauth.ts";

export const OPENAI_CODEX_MODELS = Object.freeze([
	"gpt-5.3-codex-spark",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);

export const OPENAI_API_MODELS = Object.freeze([
	"gpt-4",
	"gpt-4-turbo",
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-4.1-nano",
	"gpt-4o",
	"gpt-4o-2024-05-13",
	"gpt-4o-2024-08-06",
	"gpt-4o-2024-11-20",
	"gpt-4o-mini",
	"gpt-5",
	"gpt-5-chat-latest",
	"gpt-5-mini",
	"gpt-5-nano",
	"gpt-5-pro",
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.2-chat-latest",
	"gpt-5.2-pro",
	"gpt-5.3-chat-latest",
	"gpt-5.3-codex",
	"gpt-5.3-codex-spark",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-realtime-2.1",
	"o1",
	"o1-pro",
	"o3",
	"o3-mini",
	"o3-pro",
	"o4-mini",
]);

export interface ProviderAuthRegistration {
	readonly id: string;
	readonly displayName: string;
	readonly authType: AuthType;
	readonly authLabel: "api key" | "subscription";
	readonly models: readonly string[];
	readonly defaultModel: string;
	login(interaction: AuthInteraction): Promise<AuthCredential>;
	refresh?(
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<OAuthCredential>;
}

export interface ProviderAuthMetadata {
	readonly id: string;
	readonly displayName: string;
	readonly authType: AuthType;
	readonly authLabel: string;
}

export class ProviderAuthRegistry {
	private readonly registrations = new Map<string, ProviderAuthRegistration>();

	constructor(registrations: readonly ProviderAuthRegistration[] = []) {
		for (const registration of registrations) {
			this.register(registration);
		}
	}

	register(registration: ProviderAuthRegistration): this {
		validateRegistration(registration);
		if (this.registrations.has(registration.id)) {
			throw new Error(
				`Duplicate provider auth registration: ${registration.id}`,
			);
		}
		this.registrations.set(
			registration.id,
			Object.freeze({
				...registration,
				models: Object.freeze([...registration.models]),
			}),
		);
		return this;
	}

	get(id: string): ProviderAuthRegistration | undefined {
		return this.registrations.get(id);
	}

	list(): readonly ProviderAuthRegistration[] {
		return Object.freeze([...this.registrations.values()]);
	}

	metadata(): readonly ProviderAuthMetadata[] {
		return Object.freeze(
			this.list().map((registration) =>
				Object.freeze({
					id: registration.id,
					displayName: registration.displayName,
					authType: registration.authType,
					authLabel: registration.authLabel,
				}),
			),
		);
	}
}

export interface DefaultProviderAuthRegistryOptions {
	readonly codexOAuth?: CodexOAuth;
}

export function createDefaultProviderAuthRegistry(
	options: DefaultProviderAuthRegistryOptions = {},
): ProviderAuthRegistry {
	const codexOAuth = options.codexOAuth ?? new CodexOAuth();
	return new ProviderAuthRegistry([
		{
			id: "openai-codex",
			displayName: "ChatGPT Plus/Pro (Codex Subscription)",
			authType: "oauth",
			authLabel: "subscription",
			models: OPENAI_CODEX_MODELS,
			defaultModel: "gpt-5.6-sol",
			login: (interaction) => codexOAuth.login(interaction),
			refresh: (credential, signal) => codexOAuth.refresh(credential, signal),
		},
		{
			id: "openai",
			displayName: "OpenAI",
			authType: "api_key",
			authLabel: "api key",
			models: OPENAI_API_MODELS,
			defaultModel: "gpt-5.6-sol",
			async login(interaction) {
				const key = (
					await interaction.prompt({
						type: "text",
						label: "OpenAI API key",
						placeholder: "sk-...",
						secret: true,
						signal: interaction.signal,
					})
				).trim();
				if (!key) {
					throw new Error("API key cannot be empty");
				}
				return Object.freeze({ type: "api_key", key });
			},
		},
	]);
}

function validateRegistration(registration: ProviderAuthRegistration): void {
	if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(registration.id)) {
		throw new Error(
			`Invalid provider auth registration ID: ${registration.id}`,
		);
	}
	if (!registration.displayName.trim()) {
		throw new Error(`Provider ${registration.id} requires a display name`);
	}
	if (!registration.authLabel.trim()) {
		throw new Error(`Provider ${registration.id} requires an auth label`);
	}
	if (
		registration.models.length > 0 &&
		!registration.models.includes(registration.defaultModel)
	) {
		throw new Error(
			`Provider ${registration.id} default model is not registered`,
		);
	}
	if (new Set(registration.models).size !== registration.models.length) {
		throw new Error(`Provider ${registration.id} has duplicate models`);
	}
}
