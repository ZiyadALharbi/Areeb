export type {
	CredentialMutation,
	CredentialStore,
	FileCredentialStoreOptions,
	StoredCredentialSummary,
} from "./auth-store.ts";
export {
	AUTH_STORE_VERSION,
	AuthStoreError,
	FileCredentialStore,
	MemoryCredentialStore,
} from "./auth-store.ts";
export type {
	CommandCapability,
	CommandContext,
	CommandHandler,
	CommandHotkey,
	CommandModelListItem,
	CommandOutcome,
	CommandProviderAuthItem,
	CommandResourceReloadResult,
	CommandResourceSummary,
	CommandResult,
	CommandSessionInfo,
	CommandSessionListItem,
	CommandTuiInfo,
	SlashCommand,
} from "./commands.ts";
export {
	CommandRegistry,
	createDefaultCommandRegistry,
} from "./commands.ts";
export * from "./modes/index.ts";
export type { AreebPathOptions, AreebPaths } from "./paths.ts";
export { areebPaths } from "./paths.ts";
export type {
	LoadProjectContextOptions,
	ProjectContextFile,
} from "./project-context.ts";
export {
	discoverProjectDirectories,
	loadProjectContext,
} from "./project-context.ts";
export type { BuildSystemPromptOptions } from "./prompt-builder.ts";
export { buildSystemPrompt } from "./prompt-builder.ts";
export type {
	LoadPromptTemplatesOptions,
	LoadPromptTemplatesResult,
	PromptTemplate,
	PromptTemplateSource,
} from "./prompt-templates.ts";
export {
	expandPromptTemplateInvocation,
	loadPromptTemplates,
	loadPromptTemplatesWithDiagnostics,
	renderPromptTemplate,
} from "./prompt-templates.ts";
export type {
	DefaultProviderAuthRegistryOptions,
	ProviderAuthMetadata,
	ProviderAuthRegistration,
} from "./provider-auth.ts";
export {
	createDefaultProviderAuthRegistry,
	OPENAI_API_MODELS,
	OPENAI_CODEX_MODELS,
	ProviderAuthRegistry,
} from "./provider-auth.ts";
export type {
	LoadProviderSettingsOptions,
	OpenAICompatibleProviderConfig,
	ProviderAuthStatus,
	ProviderEnvironment,
	ProviderFactory,
	ProviderModelCatalogEntry,
	ProviderModelReference,
	ProviderRuntime,
	ProviderRuntimeOptions,
	ProviderSelection,
	ProviderSelectionOptions,
	ProviderSettings,
	SetupOpenAICompatibleProviderOptions,
} from "./provider-config.ts";
export {
	configuredProviderModels,
	createProviderRuntime,
	DEFAULT_OPENAI_MODEL,
	DEFAULT_PROVIDER_MAX_RETRIES,
	DEFAULT_PROVIDER_MAX_RETRY_DELAY_SECONDS,
	getProviderAuthStatus,
	loadProviderSettings,
	PROVIDER_SETTINGS_VERSION,
	ProviderConfigError,
	parseProviderSettings,
	resolveProviderSelection,
	saveDefaultProviderModel,
	setupOpenAICompatibleProvider,
	usableFavoriteModels,
	usableProviderModels,
} from "./provider-config.ts";
export type {
	CreateCredentialRuntimeOptions,
	ProviderAuthView,
	ProviderConnectionStatus,
	ProviderRuntimeServiceOptions,
	RuntimeModelCatalogEntry,
} from "./provider-runtime.ts";
export {
	ProviderRuntimeService,
	UnavailableModelProvider,
} from "./provider-runtime.ts";
export type {
	ParsedFrontmatter,
	ResourceDiagnostic,
	ResourceDiagnosticCode,
	ResourceKind,
	ResourceLoadPolicy,
	ResourceLoadResult,
	ResourceSource,
} from "./resources.ts";
export {
	MAX_RESOURCE_BYTES,
	parseFrontmatter,
	parseMarkdownFrontmatter,
	ResourceError,
	readResourceFile,
} from "./resources.ts";
export type {
	CodingSessionConfig,
	CodingSessionControllerService,
	CodingSessionHostServices,
	CodingSessionModelService,
	CodingSessionProviderAuthService,
	CodingSessionTuiService,
} from "./session.ts";
export { CodingSession } from "./session.ts";
export type {
	CodingSessionDiscoveryOptions,
	CodingSessionManagerOptions,
	CodingSessionRecord,
} from "./session-manager.ts";
export {
	CodingSessionManager,
	findCodingSession,
	listCodingSessions,
} from "./session-manager.ts";
export type {
	LoadSkillsResult,
	Skill,
	SkillLayout,
	SkillSource,
} from "./skills.ts";
export {
	buildSkillIndex,
	discoverProjectAgentSkillDirectories,
	expandSkillInvocation,
	isSkillDirective,
	loadSkills,
	loadSkillsWithDiagnostics,
} from "./skills.ts";
export * from "./tools/index.ts";
export type {
	CodingToolConfig,
	CodingToolDefinition,
	CodingToolOptions,
} from "./types.ts";
export { createAgentTool } from "./types.ts";
