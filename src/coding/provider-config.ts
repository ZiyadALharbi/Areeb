import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	open,
	readFile,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { DEFAULT_OPENAI_BASE_URL } from "../ai/environment.ts";
import {
	type OpenAICompatibleCompat,
	type OpenAICompatibleConfig,
	OpenAICompatibleProvider,
} from "../ai/openai_compatible_provider.ts";
import type { ModelProvider } from "../ai/provider_protocol.ts";
import { REASONING_LEVELS } from "../ai/types.ts";
import {
	type ContextWindowSource,
	FALLBACK_CONTEXT_WINDOW_TOKENS,
} from "./context-window.ts";
import { areebPaths } from "./paths.ts";

export const PROVIDER_SETTINGS_VERSION = 1;
export const DEFAULT_OPENAI_MODEL = "gpt-5.6-sol";
export const DEFAULT_PROVIDER_MAX_RETRIES = 2;
export const DEFAULT_PROVIDER_MAX_RETRY_DELAY_SECONDS = 60;

const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const RESERVED_PROVIDER_IDS = new Set(["openai-codex"]);

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export interface ProviderModelReference {
	readonly provider: string;
	readonly model: string;
}

export interface OpenAICompatibleProviderConfig {
	readonly id: string;
	readonly type: "openai-compatible";
	readonly builtIn: boolean;
	readonly baseUrl: string;
	readonly apiKeyEnv?: string;
	readonly models: readonly string[];
	readonly defaultModel: string;
	readonly timeoutSeconds?: number;
	readonly maxRetries: number;
	readonly maxRetryDelaySeconds: number;
	readonly compat: OpenAICompatibleCompat;
	readonly contextWindows: Readonly<Record<string, number>>;
}

export interface ProviderSettings {
	readonly version: typeof PROVIDER_SETTINGS_VERSION;
	readonly path: string;
	readonly defaultProvider: string;
	readonly defaultModel?: string;
	readonly providers: Readonly<Record<string, OpenAICompatibleProviderConfig>>;
	readonly favoriteModels: readonly ProviderModelReference[];
}

export interface ProviderSelection extends ProviderModelReference {}

export type ProviderAuthStatus = "not-required" | "ready" | `missing:${string}`;

export interface ProviderModelCatalogEntry extends ProviderModelReference {
	readonly baseUrl: string;
	readonly isDefaultProvider: boolean;
	readonly isDefaultModel: boolean;
	readonly authStatus: ProviderAuthStatus;
	readonly usable: boolean;
}

export interface ProviderSelectionOptions {
	readonly provider?: string;
	readonly model?: string;
	readonly stored?: ProviderModelReference;
}

export type ProviderFactory = (config: OpenAICompatibleConfig) => ModelProvider;

export interface ProviderRuntimeOptions {
	readonly env?: ProviderEnvironment;
	readonly createProvider?: ProviderFactory;
}

export interface ProviderRuntime {
	readonly provider: ModelProvider;
	readonly selection: ProviderSelection;
	/** HTTP request timeout in milliseconds. */
	readonly timeoutMs?: number;
	readonly contextWindowTokens: number;
	readonly contextWindowSource: ContextWindowSource;
	readonly contextWindowDiscoveryError?: string;
	readonly effectiveContextWindowPercent?: number;
}

export interface LoadProviderSettingsOptions {
	readonly userRoot?: string;
	readonly path?: string;
	readonly env?: ProviderEnvironment;
}

export interface SetupOpenAICompatibleProviderOptions
	extends LoadProviderSettingsOptions {
	readonly provider: string;
	readonly baseUrl?: string;
	readonly apiKeyEnv?: string | null;
	readonly models?: readonly string[];
	readonly defaultModel?: string;
	readonly timeoutSeconds?: number;
	readonly maxRetries?: number;
	readonly maxRetryDelaySeconds?: number;
	readonly contextWindows?: Readonly<Record<string, number>>;
	readonly setDefault?: boolean;
}

export class ProviderConfigError extends Error {
	constructor(
		message: string,
		readonly filePath: string,
		readonly fieldPath: string,
		options?: ErrorOptions,
	) {
		super(`${filePath}: ${fieldPath}: ${message}`, options);
		this.name = "ProviderConfigError";
	}
}

const providerIdSchema = z
	.string()
	.regex(
		PROVIDER_ID_PATTERN,
		"must use lowercase letters, digits, dots, underscores, or hyphens",
	);
const modelIdSchema = z
	.string()
	.min(1, "must not be empty")
	.refine(
		(value) => value.trim() === value,
		"must not have surrounding spaces",
	);
const environmentNameSchema = z
	.string()
	.regex(ENVIRONMENT_NAME_PATTERN, "must be an environment variable name");
const finitePositiveSchema = z.number().finite().positive();
const finiteNonnegativeSchema = z.number().finite().nonnegative();
const nonnegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
const thinkingLevelMapSchema = z.partialRecord(
	z.enum(REASONING_LEVELS),
	z.string().min(1, "must not be empty").nullable(),
);

const rawProviderSchema = z
	.object({
		type: z.literal("openai-compatible").optional(),
		base_url: z.string().min(1).optional(),
		api_key_env: environmentNameSchema.optional(),
		models: z.array(modelIdSchema).min(1).optional(),
		default_model: modelIdSchema.optional(),
		timeout_seconds: finitePositiveSchema.optional(),
		max_retries: nonnegativeSafeIntegerSchema.optional(),
		max_retry_delay_seconds: finiteNonnegativeSchema.optional(),
		thinking_format: z
			.enum(["openai", "openrouter", "deepseek", "zai"])
			.optional(),
		supports_reasoning_effort: z.boolean().optional(),
		thinking_level_map: thinkingLevelMapSchema.optional(),
		context_windows: z
			.record(modelIdSchema, z.number().int().safe().positive())
			.optional(),
	})
	.strict();

const rawFavoriteSchema = z
	.object({
		provider: providerIdSchema,
		model: modelIdSchema,
	})
	.strict();

const rawSettingsSchema = z
	.object({
		version: z.literal(PROVIDER_SETTINGS_VERSION),
		default_provider: providerIdSchema.optional(),
		default_model: modelIdSchema.optional(),
		providers: z.record(providerIdSchema, rawProviderSchema).optional(),
		favorite_models: z.array(rawFavoriteSchema).optional(),
	})
	.strict();

type RawProvider = z.infer<typeof rawProviderSchema>;
type RawProviderSettings = z.infer<typeof rawSettingsSchema>;

/** Load one immutable provider configuration snapshot. */
export async function loadProviderSettings(
	options: LoadProviderSettingsOptions = {},
): Promise<ProviderSettings> {
	const path = resolveSettingsPath(options);
	const raw = await readRawSettings(path);
	return composeProviderSettings(raw, path, options.env ?? process.env);
}

/** Parse a settings document supplied by an embedding without filesystem I/O. */
export function parseProviderSettings(
	value: unknown,
	options: LoadProviderSettingsOptions = {},
): ProviderSettings {
	const path = resolveSettingsPath(options);
	const raw = parseRawSettings(value, path);
	return composeProviderSettings(raw, path, options.env ?? process.env);
}

/** Return every configured provider/model pair, including unavailable entries. */
export function configuredProviderModels(
	settings: ProviderSettings,
	env: ProviderEnvironment = process.env,
): readonly ProviderModelCatalogEntry[] {
	const entries: ProviderModelCatalogEntry[] = [];
	for (const providerId of Object.keys(settings.providers).sort()) {
		const provider = settings.providers[providerId];
		if (provider === undefined) {
			continue;
		}
		const authStatus = getProviderAuthStatus(provider, env);
		const defaultModel =
			providerId === settings.defaultProvider
				? (settings.defaultModel ?? provider.defaultModel)
				: provider.defaultModel;
		for (const model of [...provider.models].sort()) {
			entries.push(
				Object.freeze({
					provider: providerId,
					model,
					baseUrl: provider.baseUrl,
					isDefaultProvider: providerId === settings.defaultProvider,
					isDefaultModel: model === defaultModel,
					authStatus,
					usable: !authStatus.startsWith("missing:"),
				}),
			);
		}
	}
	return Object.freeze(entries);
}

/** Return only provider/model pairs that can be opened in the current process. */
export function usableProviderModels(
	settings: ProviderSettings,
	env: ProviderEnvironment = process.env,
): readonly ProviderModelCatalogEntry[] {
	return Object.freeze(
		configuredProviderModels(settings, env).filter((entry) => entry.usable),
	);
}

/** Filter durable favorites without mutating or rejecting stale references. */
export function usableFavoriteModels(
	settings: ProviderSettings,
	env: ProviderEnvironment = process.env,
): readonly ProviderSelection[] {
	const usable = new Set(
		usableProviderModels(settings, env).map(
			(entry) => `${entry.provider}\u0000${entry.model}`,
		),
	);
	return Object.freeze(
		settings.favoriteModels.flatMap((favorite) =>
			usable.has(`${favorite.provider}\u0000${favorite.model}`)
				? [Object.freeze({ ...favorite })]
				: [],
		),
	);
}

/** Resolve one exact canonical provider/model selection. */
export function resolveProviderSelection(
	settings: ProviderSettings,
	options: ProviderSelectionOptions = {},
): ProviderSelection {
	if (options.stored !== undefined) {
		if (
			options.provider !== undefined &&
			options.provider !== options.stored.provider
		) {
			throw new Error(
				`Requested provider "${options.provider}" does not match stored provider "${options.stored.provider}"`,
			);
		}
		if (options.model !== undefined && options.model !== options.stored.model) {
			throw new Error(
				`Requested model "${options.model}" does not match stored model "${options.stored.model}"`,
			);
		}
	}

	const providerId =
		options.stored?.provider ?? options.provider ?? settings.defaultProvider;
	const provider = settings.providers[providerId];
	if (provider === undefined) {
		throw new Error(`Unknown provider: ${providerId}`);
	}

	const model =
		options.stored?.model ??
		options.model ??
		(providerId === settings.defaultProvider
			? settings.defaultModel
			: undefined) ??
		provider.defaultModel;
	if (!provider.models.includes(model)) {
		throw new Error(`Unknown model "${model}" for provider "${providerId}"`);
	}

	return Object.freeze({ provider: providerId, model });
}

/** Construct an adapter only after exact selection and authentication checks. */
export function createProviderRuntime(
	settings: ProviderSettings,
	selection: ProviderSelection,
	options: ProviderRuntimeOptions = {},
): ProviderRuntime {
	const env = options.env ?? process.env;
	const canonical = resolveProviderSelection(settings, { stored: selection });
	const providerConfig = settings.providers[canonical.provider];
	if (providerConfig === undefined) {
		throw new Error(`Unknown provider: ${canonical.provider}`);
	}

	const apiKey =
		providerConfig.apiKeyEnv === undefined
			? undefined
			: environmentValue(env, providerConfig.apiKeyEnv)?.trim();
	if (providerConfig.apiKeyEnv !== undefined && !apiKey) {
		throw new Error(
			`Provider "${providerConfig.id}" requires environment variable ${providerConfig.apiKeyEnv}`,
		);
	}

	const timeoutMs = secondsToMilliseconds(
		providerConfig.timeoutSeconds,
		"timeout_seconds",
	);
	const maxRetryDelayMs = secondsToMilliseconds(
		providerConfig.maxRetryDelaySeconds,
		"max_retry_delay_seconds",
	);
	const adapterConfig: OpenAICompatibleConfig = {
		providerId: providerConfig.id,
		baseUrl: providerConfig.baseUrl,
		...(apiKey === undefined ? {} : { apiKey }),
		retry: {
			maxRetries: providerConfig.maxRetries,
			maxRetryDelayMs,
		},
		compat: providerConfig.compat,
	};
	const provider =
		options.createProvider?.(adapterConfig) ??
		new OpenAICompatibleProvider(adapterConfig);
	if (provider.providerId !== canonical.provider) {
		throw new Error(
			`Provider factory returned "${provider.providerId}" for configured provider "${canonical.provider}"`,
		);
	}

	return Object.freeze({
		provider,
		selection: canonical,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		contextWindowTokens:
			providerConfig.contextWindows[canonical.model] ??
			FALLBACK_CONTEXT_WINDOW_TOKENS,
		contextWindowSource:
			providerConfig.contextWindows[canonical.model] === undefined
				? "fallback"
				: "configured",
	});
}

/** Create or update one provider while preserving the rest of the document. */
export async function setupOpenAICompatibleProvider(
	options: SetupOpenAICompatibleProviderOptions,
): Promise<ProviderSettings> {
	const path = resolveSettingsPath(options);
	const env = options.env ?? process.env;
	assertProviderId(options.provider, path, "$.providers");

	return withSettingsLock(path, async () => {
		const currentRaw = await readRawSettings(path);
		const currentSettings = composeProviderSettings(currentRaw, path, env);
		const existingRaw =
			currentRaw?.providers !== undefined &&
			Object.hasOwn(currentRaw.providers, options.provider)
				? currentRaw.providers[options.provider]
				: undefined;
		const isNewCustom =
			options.provider !== "openai" && existingRaw === undefined;

		if (isNewCustom) {
			for (const [field, value] of [
				["base_url", options.baseUrl],
				["models", options.models],
				["default_model", options.defaultModel],
			] as const) {
				if (value === undefined) {
					throwConfig(
						path,
						`$.providers.${options.provider}.${field}`,
						"is required when creating a provider",
					);
				}
			}
		}

		if (options.models !== undefined && options.defaultModel === undefined) {
			const existingDefault =
				currentSettings.providers[options.provider]?.defaultModel;
			if (
				existingDefault !== undefined &&
				!options.models.includes(existingDefault)
			) {
				throwConfig(
					path,
					`$.providers.${options.provider}.models`,
					`must include existing default model "${existingDefault}" or set a new default_model`,
				);
			}
		}
		const contextWindows =
			options.contextWindows === undefined && options.models !== undefined
				? Object.fromEntries(
						Object.entries(existingRaw?.context_windows ?? {}).filter(
							([model]) => options.models?.includes(model) === true,
						),
					)
				: options.contextWindows;

		const nextProvider: RawProvider = {
			...(existingRaw ?? {}),
			type: "openai-compatible",
			...(options.baseUrl === undefined ? {} : { base_url: options.baseUrl }),
			...(options.models === undefined ? {} : { models: [...options.models] }),
			...(options.defaultModel === undefined
				? {}
				: { default_model: options.defaultModel }),
			...(options.timeoutSeconds === undefined
				? {}
				: { timeout_seconds: options.timeoutSeconds }),
			...(options.maxRetries === undefined
				? {}
				: { max_retries: options.maxRetries }),
			...(options.maxRetryDelaySeconds === undefined
				? {}
				: {
						max_retry_delay_seconds: options.maxRetryDelaySeconds,
					}),
			...(contextWindows === undefined
				? {}
				: { context_windows: { ...contextWindows } }),
		};
		if (options.apiKeyEnv === null) {
			delete nextProvider.api_key_env;
		} else if (options.apiKeyEnv !== undefined) {
			nextProvider.api_key_env = options.apiKeyEnv;
		}

		const nextRaw: RawProviderSettings = {
			version: PROVIDER_SETTINGS_VERSION,
			default_provider: options.setDefault
				? options.provider
				: (currentRaw?.default_provider ?? "openai"),
			...(options.setDefault || currentRaw?.default_model === undefined
				? {}
				: { default_model: currentRaw.default_model }),
			providers: {
				...(currentRaw?.providers ?? {}),
				[options.provider]: nextProvider,
			},
			...(currentRaw?.favorite_models === undefined
				? {}
				: { favorite_models: currentRaw.favorite_models }),
		};
		let nextSettings = composeProviderSettings(nextRaw, path, env);
		if (options.setDefault) {
			const selectedProvider = nextSettings.providers[options.provider];
			if (selectedProvider === undefined) {
				throwConfig(
					path,
					"$.default_provider",
					`references unknown provider "${options.provider}"`,
				);
			}
			nextRaw.default_model = selectedProvider.defaultModel;
			nextSettings = composeProviderSettings(nextRaw, path, env);
		}
		await writeRawSettings(path, nextRaw);
		return nextSettings;
	});
}

/** Persist the global provider/model preference without changing provider setup. */
export async function saveDefaultProviderModel(
	selection: ProviderModelReference,
	options: LoadProviderSettingsOptions = {},
): Promise<ProviderSettings> {
	const path = resolveSettingsPath(options);
	const env = options.env ?? process.env;
	assertProviderId(selection.provider, path, "$.default_provider");
	const model = modelIdSchema.safeParse(selection.model);
	if (!model.success) {
		throwConfig(
			path,
			"$.default_model",
			model.error.issues[0]?.message ?? "invalid model",
		);
	}

	return withSettingsLock(path, async () => {
		const currentRaw = await readRawSettings(path);
		const nextRaw: RawProviderSettings = {
			version: PROVIDER_SETTINGS_VERSION,
			default_provider: selection.provider,
			default_model: model.data,
			...(currentRaw?.providers === undefined
				? {}
				: { providers: currentRaw.providers }),
			...(currentRaw?.favorite_models === undefined
				? {}
				: { favorite_models: currentRaw.favorite_models }),
		};
		const nextSettings = composeProviderSettings(nextRaw, path, env);
		await writeRawSettings(path, nextRaw);
		return nextSettings;
	});
}

export function getProviderAuthStatus(
	provider: OpenAICompatibleProviderConfig,
	env: ProviderEnvironment = process.env,
): ProviderAuthStatus {
	if (provider.apiKeyEnv === undefined) {
		return "not-required";
	}
	return environmentValue(env, provider.apiKeyEnv)?.trim()
		? "ready"
		: `missing:${provider.apiKeyEnv}`;
}

function composeProviderSettings(
	raw: RawProviderSettings | undefined,
	path: string,
	env: ProviderEnvironment,
): ProviderSettings {
	const explicitProviders = raw?.providers ?? {};
	const providers = Object.create(null) as Record<
		string,
		OpenAICompatibleProviderConfig
	>;
	providers.openai = normalizeBuiltInOpenAI(
		explicitProviders.openai,
		path,
		env,
	);

	for (const providerId of Object.keys(explicitProviders).sort()) {
		if (providerId === "openai") {
			continue;
		}
		if (RESERVED_PROVIDER_IDS.has(providerId)) {
			throwConfig(
				path,
				`$.providers.${providerId}`,
				"is reserved for a built-in credential-backed provider",
			);
		}
		const provider = explicitProviders[providerId];
		if (provider === undefined) {
			continue;
		}
		providers[providerId] = normalizeCustomProvider(providerId, provider, path);
	}

	const defaultProvider = raw?.default_provider ?? "openai";
	if (
		!Object.hasOwn(providers, defaultProvider) &&
		!RESERVED_PROVIDER_IDS.has(defaultProvider)
	) {
		throwConfig(
			path,
			"$.default_provider",
			`references unknown provider "${defaultProvider}"`,
		);
	}

	const favorites = raw?.favorite_models ?? [];
	const favoriteKeys = new Set<string>();
	for (let index = 0; index < favorites.length; index += 1) {
		const favorite = favorites[index];
		if (favorite === undefined) {
			continue;
		}
		const key = `${favorite.provider}\u0000${favorite.model}`;
		if (favoriteKeys.has(key)) {
			throwConfig(
				path,
				`$.favorite_models[${index}]`,
				`duplicates ${favorite.provider}/${favorite.model}`,
			);
		}
		favoriteKeys.add(key);
	}

	return Object.freeze({
		version: PROVIDER_SETTINGS_VERSION,
		path,
		defaultProvider,
		...(raw?.default_model === undefined
			? {}
			: { defaultModel: raw.default_model }),
		providers: Object.freeze(providers),
		favoriteModels: Object.freeze(
			favorites.map((favorite) => Object.freeze({ ...favorite })),
		),
	});
}

function normalizeBuiltInOpenAI(
	overlay: RawProvider | undefined,
	path: string,
	env: ProviderEnvironment,
): OpenAICompatibleProviderConfig {
	const environmentModel =
		environmentValue(env, "OPENAI_MODEL")?.trim() || undefined;
	const defaultModel =
		overlay?.default_model ?? environmentModel ?? DEFAULT_OPENAI_MODEL;
	const models = overlay?.models ?? [defaultModel];
	return normalizeProvider(
		"openai",
		{
			type: "openai-compatible",
			base_url:
				overlay?.base_url ??
				(environmentValue(env, "OPENAI_BASE_URL")?.trim() || undefined) ??
				DEFAULT_OPENAI_BASE_URL,
			api_key_env: overlay?.api_key_env ?? "OPENAI_API_KEY",
			models,
			default_model: defaultModel,
			timeout_seconds:
				overlay?.timeout_seconds ??
				readEnvironmentNumber(env, "OPENAI_TIMEOUT_SECONDS", path, "positive"),
			max_retries:
				overlay?.max_retries ??
				readEnvironmentNumber(env, "OPENAI_MAX_RETRIES", path, "safeInteger") ??
				DEFAULT_PROVIDER_MAX_RETRIES,
			max_retry_delay_seconds:
				overlay?.max_retry_delay_seconds ??
				readEnvironmentNumber(
					env,
					"OPENAI_MAX_RETRY_DELAY_SECONDS",
					path,
					"nonnegative",
				) ??
				DEFAULT_PROVIDER_MAX_RETRY_DELAY_SECONDS,
			...(overlay?.thinking_format === undefined
				? {}
				: { thinking_format: overlay.thinking_format }),
			...(overlay?.supports_reasoning_effort === undefined
				? {}
				: {
						supports_reasoning_effort: overlay.supports_reasoning_effort,
					}),
			...(overlay?.thinking_level_map === undefined
				? {}
				: { thinking_level_map: overlay.thinking_level_map }),
			...(overlay?.context_windows === undefined
				? {}
				: { context_windows: overlay.context_windows }),
		},
		path,
		true,
	);
}

function normalizeCustomProvider(
	providerId: string,
	raw: RawProvider,
	path: string,
): OpenAICompatibleProviderConfig {
	assertContextWindowModels(raw, path, `$.providers.${providerId}`);
	for (const [field, value] of [
		["type", raw.type],
		["base_url", raw.base_url],
		["models", raw.models],
		["default_model", raw.default_model],
	] as const) {
		if (value === undefined) {
			throwConfig(
				path,
				`$.providers.${providerId}.${field}`,
				"is required for a custom provider",
			);
		}
	}

	return normalizeProvider(providerId, raw, path, false);
}

function normalizeProvider(
	providerId: string,
	raw: RawProvider,
	path: string,
	builtIn: boolean,
): OpenAICompatibleProviderConfig {
	const basePath = `$.providers.${providerId}`;
	if (raw.base_url === undefined) {
		throwConfig(path, `${basePath}.base_url`, "is required");
	}
	if (raw.models === undefined) {
		throwConfig(path, `${basePath}.models`, "is required");
	}
	if (raw.default_model === undefined) {
		throwConfig(path, `${basePath}.default_model`, "is required");
	}
	assertBaseUrl(raw.base_url, path, `${basePath}.base_url`);
	assertNoDuplicateModels(raw.models, path, `${basePath}.models`);
	if (!raw.models.includes(raw.default_model)) {
		throwConfig(
			path,
			`${basePath}.default_model`,
			`must appear in ${basePath}.models`,
		);
	}
	assertContextWindowModels(raw, path, basePath);
	const thinkingLevelMap = Object.freeze({
		off: "none",
		...(raw.thinking_level_map ?? {}),
	});
	const compat: OpenAICompatibleCompat = Object.freeze({
		...(raw.thinking_format === undefined
			? {}
			: { thinkingFormat: raw.thinking_format }),
		...(raw.supports_reasoning_effort === undefined
			? {}
			: { supportsReasoningEffort: raw.supports_reasoning_effort }),
		thinkingLevelMap,
	});

	return Object.freeze({
		id: providerId,
		type: "openai-compatible",
		builtIn,
		baseUrl: raw.base_url.replace(/\/+$/, ""),
		...(raw.api_key_env === undefined ? {} : { apiKeyEnv: raw.api_key_env }),
		models: Object.freeze([...raw.models]),
		defaultModel: raw.default_model,
		...(raw.timeout_seconds === undefined
			? {}
			: { timeoutSeconds: raw.timeout_seconds }),
		maxRetries: raw.max_retries ?? DEFAULT_PROVIDER_MAX_RETRIES,
		maxRetryDelaySeconds:
			raw.max_retry_delay_seconds ?? DEFAULT_PROVIDER_MAX_RETRY_DELAY_SECONDS,
		compat,
		contextWindows: Object.freeze({ ...(raw.context_windows ?? {}) }),
	});
}

async function readRawSettings(
	path: string,
): Promise<RawProviderSettings | undefined> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return undefined;
		}
		throw new ProviderConfigError("failed to read file", path, "$", {
			cause: error,
		});
	}

	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new ProviderConfigError("invalid JSON", path, "$", {
			cause: error,
		});
	}
	return parseRawSettings(value, path);
}

function parseRawSettings(value: unknown, path: string): RawProviderSettings {
	assertNoSecretFields(value, path);
	const result = rawSettingsSchema.safeParse(value);
	if (!result.success) {
		const issue = result.error.issues[0];
		if (issue === undefined) {
			throwConfig(path, "$", "invalid provider settings");
		}
		const issuePath = [...issue.path];
		if (issue.code === "unrecognized_keys" && issue.keys[0] !== undefined) {
			issuePath.push(issue.keys[0]);
		}
		throwConfig(path, formatFieldPath(issuePath), issue.message);
	}
	return result.data;
}

function assertNoSecretFields(value: unknown, path: string): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return;
	}
	const providers = Reflect.get(value, "providers");
	if (
		typeof providers !== "object" ||
		providers === null ||
		Array.isArray(providers)
	) {
		return;
	}
	for (const [providerId, provider] of Object.entries(providers)) {
		if (
			typeof provider !== "object" ||
			provider === null ||
			Array.isArray(provider)
		) {
			continue;
		}
		for (const secretField of ["api_key", "headers"] as const) {
			if (Object.hasOwn(provider, secretField)) {
				throwConfig(
					path,
					`$.providers.${providerId}.${secretField}`,
					"secrets and secret-bearing headers are not allowed in providers.json",
				);
			}
		}
	}
}

function assertProviderId(
	providerId: string,
	path: string,
	fieldPath: string,
): void {
	if (!PROVIDER_ID_PATTERN.test(providerId)) {
		throwConfig(path, fieldPath, `invalid provider ID "${providerId}"`);
	}
}

function assertBaseUrl(value: string, path: string, fieldPath: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new ProviderConfigError("must be an absolute URL", path, fieldPath, {
			cause: error,
		});
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throwConfig(path, fieldPath, "must use http or https");
	}
	if (url.username || url.password) {
		throwConfig(path, fieldPath, "must not contain embedded credentials");
	}
	for (const name of url.searchParams.keys()) {
		if (/api[_-]?key|token|secret|password/i.test(name)) {
			throwConfig(path, fieldPath, "must not contain secret query parameters");
		}
	}
}

function assertNoDuplicateModels(
	models: readonly string[],
	path: string,
	fieldPath: string,
): void {
	const seen = new Set<string>();
	for (let index = 0; index < models.length; index += 1) {
		const model = models[index];
		if (model !== undefined && seen.has(model)) {
			throwConfig(
				path,
				`${fieldPath}[${index}]`,
				`duplicates model "${model}"`,
			);
		}
		if (model !== undefined) {
			seen.add(model);
		}
	}
}

function assertContextWindowModels(
	raw: RawProvider,
	path: string,
	basePath: string,
): void {
	if (raw.models === undefined) {
		return;
	}
	for (const model of Object.keys(raw.context_windows ?? {})) {
		if (!raw.models.includes(model)) {
			throwConfig(
				path,
				`${basePath}.context_windows.${model}`,
				`references model not present in ${basePath}.models`,
			);
		}
	}
}

function readEnvironmentNumber(
	env: ProviderEnvironment,
	name: string,
	path: string,
	kind: "positive" | "nonnegative" | "safeInteger",
): number | undefined {
	const raw = environmentValue(env, name)?.trim();
	if (!raw) {
		return undefined;
	}
	const value = Number(raw);
	const valid =
		kind === "positive"
			? Number.isFinite(value) && value > 0
			: kind === "nonnegative"
				? Number.isFinite(value) && value >= 0
				: Number.isSafeInteger(value) && value >= 0;
	if (!valid) {
		throwConfig(
			path,
			`$env.${name}`,
			kind === "positive"
				? "must be a finite number greater than zero"
				: kind === "nonnegative"
					? "must be a finite nonnegative number"
					: "must be a nonnegative safe integer",
		);
	}
	return value;
}

function secondsToMilliseconds(
	seconds: number | undefined,
	field: string,
): number | undefined {
	if (seconds === undefined) {
		return undefined;
	}
	const milliseconds = seconds * 1_000;
	if (!Number.isFinite(milliseconds)) {
		throw new Error(`${field} is too large to convert to milliseconds`);
	}
	return milliseconds;
}

function resolveSettingsPath(options: LoadProviderSettingsOptions): string {
	return (
		options.path ??
		areebPaths({
			...(options.userRoot === undefined ? {} : { userRoot: options.userRoot }),
		}).userProviders
	);
}

async function writeRawSettings(
	path: string,
	settings: RawProviderSettings,
): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let temporaryCreated = false;

	try {
		const file = await open(temporaryPath, "wx", 0o600);
		temporaryCreated = true;
		try {
			await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporaryPath, path);
		temporaryCreated = false;
		await chmod(path, 0o600);
	} finally {
		if (temporaryCreated) {
			await unlink(temporaryPath).catch(() => undefined);
		}
	}
}

async function withSettingsLock<T>(
	path: string,
	operation: () => Promise<T>,
): Promise<T> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const lockPath = `${path}.lock`;
	const startedAt = Date.now();
	let lock: Awaited<ReturnType<typeof open>> | undefined;

	while (lock === undefined) {
		try {
			lock = await open(lockPath, "wx", 0o600);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				throw error;
			}
			try {
				const metadata = await stat(lockPath);
				if (Date.now() - metadata.mtimeMs > STALE_LOCK_MS) {
					await unlink(lockPath);
					continue;
				}
			} catch (metadataError) {
				if (errorCode(metadataError) === "ENOENT") {
					continue;
				}
				throw metadataError;
			}
			if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
				throw new ProviderConfigError(
					"timed out waiting for configuration lock",
					path,
					"$",
				);
			}
			await delay(LOCK_RETRY_DELAY_MS);
		}
	}

	try {
		return await operation();
	} finally {
		await lock.close();
		await unlink(lockPath).catch((error) => {
			if (errorCode(error) !== "ENOENT") {
				throw error;
			}
		});
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatFieldPath(path: readonly PropertyKey[]): string {
	let formatted = "$";
	for (const part of path) {
		formatted += typeof part === "number" ? `[${part}]` : `.${String(part)}`;
	}
	return formatted;
}

function throwConfig(path: string, fieldPath: string, message: string): never {
	throw new ProviderConfigError(message, path, fieldPath);
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}
	const code = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}

function environmentValue(
	env: ProviderEnvironment,
	name: string,
): string | undefined {
	return Object.hasOwn(env, name) ? env[name] : undefined;
}
