import { AgentHarness } from "../agent/harness.ts";
import type {
	SessionContext,
	SessionHandle,
	SessionMetadata,
	SessionModel,
} from "../agent/session/types.ts";
import type {
	AgentMessage,
	AgentMessageConverter,
	AgentRunStream,
	AgentTool,
	QueuedMessages,
	QueueMode,
} from "../agent/types.ts";
import type { ModelProvider } from "../ai/provider_protocol.ts";
import type { ReasoningLevel } from "../ai/types.ts";
import {
	type CommandContext,
	type CommandHotkey,
	type CommandModelListItem,
	type CommandProviderAuthItem,
	type CommandRegistry,
	type CommandResourceReloadResult,
	type CommandResult,
	type CommandSessionListItem,
	createDefaultCommandRegistry,
	type SlashCommand,
} from "./commands.ts";
import { type AreebPaths, areebPaths } from "./paths.ts";
import type { ProjectContextFile } from "./project-context.ts";
import {
	expandPromptTemplateInvocation,
	type PromptTemplate,
} from "./prompt-templates.ts";
import {
	assembleSessionResources,
	buildSessionSystemPrompt,
	freezeSessionResourceInputs,
	type SessionResourceInputs,
	type SessionResourceSnapshot,
} from "./session-resources.ts";
import { expandSkillInvocation, type Skill } from "./skills.ts";
import { createCodingToolDefinitions } from "./tools/index.ts";
import { type CodingToolDefinition, createAgentTool } from "./types.ts";

export interface CodingSessionConfig<
	TMetadata extends SessionMetadata = SessionMetadata,
> {
	readonly session: SessionHandle<TMetadata>;
	readonly provider: ModelProvider;
	/** Default model for a branch that has no stored model selection. */
	readonly model: string;
	/** Default reasoning level for a branch that has no stored selection. */
	readonly reasoning: ReasoningLevel;
	/** Custom base prompt. Omit to use Areeb's default coding prompt. */
	readonly systemPrompt?: string;
	readonly appendSystemPrompt?: string;
	readonly extraGuidelines?: readonly string[];
	readonly contextFiles?: readonly ProjectContextFile[];
	/** Complete available tool set. Omit for the built-in cwd-bound coding tools. */
	readonly tools?: readonly CodingToolDefinition[];
	/** Provider HTTP request timeout in milliseconds. */
	readonly timeout?: number;
	/** Interactive-only reason that prompt submission is unavailable. */
	readonly unavailableReason?: string;
	readonly maxTurns?: number;
	readonly messageConverter?: AgentMessageConverter;
	readonly steeringMode?: QueueMode;
	readonly followUpMode?: QueueMode;
	/** Override the canonical user and project resource paths. */
	readonly resourcePaths?: AreebPaths;
	/** Project resources are ignored unless the caller explicitly trusts them. */
	readonly trustProjectResources?: boolean;
}

export interface CodingSessionControllerService {
	listSessions(): Promise<readonly CommandSessionListItem[]>;
}

export interface CodingSessionModelService {
	listModels(): readonly CommandModelListItem[];
}

export interface CodingSessionProviderAuthService {
	listProviders(): readonly CommandProviderAuthItem[];
}

export interface CodingSessionTuiService {
	getThemeName(): string;
	getThemeNames(): readonly string[];
	getHotkeys(): readonly CommandHotkey[];
}

export interface CodingSessionHostServices {
	readonly sessionController?: CodingSessionControllerService;
	readonly modelController?: CodingSessionModelService;
	readonly providerAuth?: CodingSessionProviderAuthService;
	readonly tui?: CodingSessionTuiService;
}

export interface PreparedCodingSession<
	TMetadata extends SessionMetadata = SessionMetadata,
> {
	readonly session: CodingSession<TMetadata>;
	commit(): Promise<void>;
}

/**
 * Coding-agent runtime backed by an append-only session.
 *
 * Construction is asynchronous so stored runtime state and transcript repairs
 * are durable before callers can start a provider run.
 */
export class CodingSession<
	TMetadata extends SessionMetadata = SessionMetadata,
> {
	private persistenceFailure: unknown;
	private resourceReload: Promise<CommandResourceReloadResult> | undefined;

	private constructor(
		private readonly session: SessionHandle<TMetadata>,
		private readonly harness: AgentHarness,
		private readonly sessionMetadata: TMetadata,
		private readonly sessionProvider: string,
		private readonly sessionModel: string,
		private readonly sessionReasoning: ReasoningLevel,
		private readonly sessionUnavailableReason: string | undefined,
		private assembledSystemPrompt: string,
		private readonly activeTools: readonly AgentTool[],
		private readonly resourceInputs: SessionResourceInputs,
		private resourceSnapshot: SessionResourceSnapshot,
		private readonly commandRegistry: CommandRegistry,
	) {}

	static async load<TMetadata extends SessionMetadata = SessionMetadata>(
		config: CodingSessionConfig<TMetadata>,
	): Promise<CodingSession<TMetadata>> {
		const { session } = await CodingSession.construct(config, {
			initialize: true,
		});
		session.attachPersistence();
		return session;
	}

	/** Build a replacement runtime before durably changing the active model. */
	static async prepareModelChange<
		TMetadata extends SessionMetadata = SessionMetadata,
	>(
		config: CodingSessionConfig<TMetadata>,
	): Promise<PreparedCodingSession<TMetadata>> {
		const prepared = await CodingSession.construct(config, {
			initialize: false,
			selection: {
				provider: config.provider.providerId,
				model: config.model,
			},
		});
		let committed = false;

		return Object.freeze({
			session: prepared.session,
			async commit() {
				if (committed) {
					throw new Error("Prepared model change has already been committed");
				}
				const latest = requireStoredModel(await config.session.buildContext());
				if (!sameModel(latest, prepared.storedModel)) {
					throw new Error(
						"Session model changed while the replacement runtime was being prepared",
					);
				}
				await config.session.appendEntry({
					type: "model_change",
					provider: config.provider.providerId,
					model: config.model,
				});
				prepared.session.attachPersistence();
				committed = true;
			},
		});
	}

	private static async construct<
		TMetadata extends SessionMetadata = SessionMetadata,
	>(
		config: CodingSessionConfig<TMetadata>,
		options: {
			readonly initialize: boolean;
			readonly selection?: SessionModel;
		},
	): Promise<{
		readonly session: CodingSession<TMetadata>;
		readonly storedModel: SessionModel;
	}> {
		validateConfig(config);

		const metadata = await config.session.getMetadata();
		const resourcePaths =
			config.resourcePaths ?? areebPaths({ cwd: metadata.cwd });
		const commandRegistry = createDefaultCommandRegistry();
		let context = await config.session.buildContext();
		const availableToolDefinitions =
			config.tools === undefined
				? createCodingToolDefinitions(metadata.cwd)
				: [...config.tools];
		validateAvailableTools(availableToolDefinitions);
		const initialActiveToolDefinitions = selectActiveTools(
			availableToolDefinitions,
			context.activeToolNames ??
				availableToolDefinitions.map((tool) => tool.name),
		);
		const resourceInputs = freezeSessionResourceInputs({
			cwd: metadata.cwd,
			paths: resourcePaths,
			trustProjectResources: config.trustProjectResources === true,
			callerContextFiles: config.contextFiles ?? [],
			activeToolDefinitions: initialActiveToolDefinitions,
			reservedPromptTemplateNames: [
				...commandRegistry.executableNames(),
				"skill",
			],
			...(config.systemPrompt === undefined
				? {}
				: { customPrompt: config.systemPrompt }),
			...(config.appendSystemPrompt === undefined
				? {}
				: { appendSystemPrompt: config.appendSystemPrompt }),
			extraGuidelines: config.extraGuidelines ?? [],
		});
		const resourceSnapshot = await assembleSessionResources(resourceInputs);
		const systemPrompt = buildSessionSystemPrompt(
			resourceInputs,
			resourceSnapshot,
		);

		const hasReasoningEntry =
			(
				await config.session.findEntriesOnBranch({
					type: "reasoning_change",
					limit: 1,
				})
			).length > 0;
		let initialized = false;

		if (options.initialize && context.model === null) {
			await config.session.appendEntry({
				type: "model_change",
				provider: config.provider.providerId,
				model: config.model,
			});
			initialized = true;
		}

		if (options.initialize && !hasReasoningEntry) {
			await config.session.appendEntry({
				type: "reasoning_change",
				reasoning: config.reasoning,
			});
			initialized = true;
		}

		if (options.initialize && context.activeToolNames === null) {
			await config.session.appendEntry({
				type: "active_tools_change",
				activeToolNames: availableToolDefinitions.map((tool) => tool.name),
			});
			initialized = true;
		}

		if (initialized) {
			context = await config.session.buildContext();
		}

		if (
			!options.initialize &&
			(!hasReasoningEntry || context.activeToolNames === null)
		) {
			throw new Error(
				"Cannot stage a model change for an uninitialized session",
			);
		}

		const storedModel = requireStoredModel(context);
		const runtimeModel = options.selection ?? storedModel;
		if (runtimeModel.provider !== config.provider.providerId) {
			throw new Error(
				`Stored provider "${runtimeModel.provider}" does not match configured provider "${config.provider.providerId}"`,
			);
		}

		const activeToolDefinitions = selectActiveTools(
			availableToolDefinitions,
			context.activeToolNames,
		);
		if (
			!sameToolSelection(initialActiveToolDefinitions, activeToolDefinitions)
		) {
			throw new Error("Active tool selection changed during session loading");
		}
		const tools = activeToolDefinitions.map((definition) =>
			createAgentTool(definition),
		);
		const harness = new AgentHarness(
			{
				provider: config.provider,
				model: runtimeModel.model,
				systemPrompt,
				tools,
				streamOptions: {
					reasoning: context.reasoning,
					...(config.timeout === undefined ? {} : { timeout: config.timeout }),
				},
				...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
				...(config.messageConverter === undefined
					? {}
					: { messageConverter: config.messageConverter }),
				...(config.steeringMode === undefined
					? {}
					: { steeringMode: config.steeringMode }),
				...(config.followUpMode === undefined
					? {}
					: { followUpMode: config.followUpMode }),
			},
			context.messages,
		);

		const repairs = harness.repairInterruptedToolCalls();
		if (!options.initialize && repairs.length > 0) {
			throw new Error(
				"Cannot stage a model change while the transcript needs repair",
			);
		}
		for (const repair of repairs) {
			await config.session.appendMessage(repair);
		}

		const codingSession = new CodingSession(
			config.session,
			harness,
			metadata,
			runtimeModel.provider,
			runtimeModel.model,
			context.reasoning,
			config.unavailableReason,
			systemPrompt,
			tools,
			resourceInputs,
			resourceSnapshot,
			commandRegistry,
		);
		return { session: codingSession, storedModel: { ...storedModel } };
	}

	get messages(): readonly AgentMessage[] {
		return this.harness.messages;
	}

	get metadata(): TMetadata {
		return structuredClone(this.sessionMetadata);
	}

	get model(): string {
		return this.sessionModel;
	}

	get provider(): string {
		return this.sessionProvider;
	}

	get reasoning(): ReasoningLevel {
		return this.sessionReasoning;
	}

	get unavailableReason(): string | undefined {
		return this.sessionUnavailableReason;
	}

	get systemPrompt(): string {
		return this.assembledSystemPrompt;
	}

	get tools(): readonly AgentTool[] {
		return [...this.activeTools];
	}

	get skills(): readonly Skill[] {
		return this.resourceSnapshot.skills.map((skill) => ({ ...skill }));
	}

	get promptTemplates(): readonly PromptTemplate[] {
		return this.resourceSnapshot.promptTemplates.map((template) => ({
			...template,
		}));
	}

	get contextFiles(): readonly ProjectContextFile[] {
		return Object.freeze(
			this.resourceSnapshot.contextFiles.map((file) =>
				Object.freeze({ ...file }),
			),
		);
	}

	get resourceDiagnostics(): SessionResourceSnapshot["diagnostics"] {
		return Object.freeze(
			this.resourceSnapshot.diagnostics.map((diagnostic) =>
				Object.freeze({ ...diagnostic }),
			),
		);
	}

	get commands(): readonly SlashCommand[] {
		return this.commandRegistry.list();
	}

	get isRunning(): boolean {
		return this.harness.isRunning;
	}

	get queuedMessages(): QueuedMessages {
		return this.harness.queuedMessages;
	}

	prompt(
		input: string | AgentMessage | readonly AgentMessage[],
	): AgentRunStream {
		this.assertPersistenceHealthy();
		this.assertResourceReloadIdle();
		return this.harness.prompt(
			typeof input === "string" ? this.expandPrompt(input) : input,
		);
	}

	continue(): AgentRunStream {
		this.assertPersistenceHealthy();
		this.assertResourceReloadIdle();
		return this.harness.continue();
	}

	reloadResources(): Promise<CommandResourceReloadResult> {
		this.assertPersistenceHealthy();
		if (this.harness.isRunning) {
			return Promise.reject(
				new Error("Cannot reload resources while the agent is running"),
			);
		}
		if (this.resourceReload !== undefined) {
			return this.resourceReload;
		}

		const reload = this.performResourceReload();
		this.resourceReload = reload;
		void reload.then(
			() => {
				if (this.resourceReload === reload) {
					this.resourceReload = undefined;
				}
			},
			() => {
				if (this.resourceReload === reload) {
					this.resourceReload = undefined;
				}
			},
		);
		return reload;
	}

	abort(): void {
		this.harness.abort();
	}

	waitForIdle(): Promise<void> {
		return this.harness.waitForIdle();
	}

	steer(text: string): QueuedMessages;
	steer(message: AgentMessage): QueuedMessages;
	steer(input: string | AgentMessage): QueuedMessages {
		this.assertPersistenceHealthy();
		return typeof input === "string"
			? this.harness.steer(this.expandPrompt(input))
			: this.harness.steer(input);
	}

	followUp(text: string): QueuedMessages;
	followUp(message: AgentMessage): QueuedMessages;
	followUp(input: string | AgentMessage): QueuedMessages {
		this.assertPersistenceHealthy();
		return typeof input === "string"
			? this.harness.followUp(this.expandPrompt(input))
			: this.harness.followUp(input);
	}

	clearQueues(): QueuedMessages {
		this.assertPersistenceHealthy();
		this.harness.clearQueues();
		return this.harness.queuedMessages;
	}

	async handleCommand(
		input: string,
		services: CodingSessionHostServices = {},
	): Promise<CommandResult> {
		this.assertPersistenceHealthy();
		return this.commandRegistry.dispatch(
			input,
			this.createCommandContext(services),
		);
	}

	private attachPersistence(): void {
		this.harness.subscribe(async (event) => {
			if (event.type !== "message_end") {
				return;
			}

			try {
				await this.session.appendMessage(event.message);
			} catch (error) {
				this.persistenceFailure = error;
				throw error;
			}
		});
	}

	private assertPersistenceHealthy(): void {
		if (this.persistenceFailure !== undefined) {
			throw new Error(
				"CodingSession must be reopened after a persistence failure",
				{ cause: this.persistenceFailure },
			);
		}
	}

	private assertResourceReloadIdle(): void {
		if (this.resourceReload !== undefined) {
			throw new Error(
				"Cannot start an agent run while resources are reloading",
			);
		}
	}

	private async performResourceReload(): Promise<CommandResourceReloadResult> {
		const candidate = await assembleSessionResources(this.resourceInputs);
		const candidateSystemPrompt = buildSessionSystemPrompt(
			this.resourceInputs,
			candidate,
		);
		if (this.harness.isRunning) {
			throw new Error("Cannot reload resources while the agent is running");
		}

		const systemPromptChanged =
			candidateSystemPrompt !== this.assembledSystemPrompt;
		if (systemPromptChanged) {
			this.harness.replaceSystemPrompt(candidateSystemPrompt);
		}
		this.resourceSnapshot = candidate;
		this.assembledSystemPrompt = candidateSystemPrompt;

		return Object.freeze({
			skillCount: candidate.skills.length,
			promptTemplateCount: candidate.promptTemplates.length,
			contextFileCount: candidate.contextFiles.length,
			diagnostics: candidate.diagnostics,
			systemPromptChanged,
		});
	}

	private expandPrompt(input: string): string {
		const skillExpansion = expandSkillInvocation(
			input,
			this.resourceSnapshot.skills,
		);
		return skillExpansion === input
			? expandPromptTemplateInvocation(
					input,
					this.resourceSnapshot.promptTemplates,
				)
			: skillExpansion;
	}

	private createCommandContext(
		services: CodingSessionHostServices,
	): CommandContext {
		const sessionController = services.sessionController;
		const modelController = services.modelController;
		const providerAuth = services.providerAuth;
		const tui = services.tui;
		return {
			hasCapability: (capability) => {
				switch (capability) {
					case "session-controller":
						return sessionController !== undefined;
					case "tui":
						return tui !== undefined;
					case "model-selection":
						return modelController !== undefined;
					case "provider-auth":
						return providerAuth !== undefined;
					case "compaction":
					case "session-export":
						return false;
				}
			},
			listSessions: () => {
				if (sessionController === undefined) {
					throw new Error("Session controller is unavailable");
				}
				return sessionController.listSessions();
			},
			listModels: () => {
				if (modelController === undefined) {
					throw new Error("Model controller is unavailable");
				}
				return modelController.listModels();
			},
			listAuthProviders: () => {
				if (providerAuth === undefined) {
					throw new Error("Provider auth service is unavailable");
				}
				return providerAuth
					.listProviders()
					.map((provider) => ({ ...provider }));
			},
			getResourceSummary: () => ({
				skillCount: this.resourceSnapshot.skills.length,
				promptTemplateCount: this.resourceSnapshot.promptTemplates.length,
				contextFileCount: this.resourceSnapshot.contextFiles.length,
				diagnostics: this.resourceDiagnostics,
			}),
			getContextFiles: () =>
				this.resourceSnapshot.contextFiles.map((file) => file.path),
			reloadResources: () => this.reloadResources(),
			getSessionInfo: async () => {
				const name = await this.session.getName();
				return {
					id: this.sessionMetadata.id,
					...(name === undefined ? {} : { name }),
					cwd: this.sessionMetadata.cwd,
					provider: this.sessionProvider,
					model: this.sessionModel,
					reasoning: this.sessionReasoning,
					messageCount: this.harness.messages.length,
					isRunning: this.harness.isRunning,
				};
			},
			getSessionName: () => this.session.getName(),
			setSessionName: (name) => this.session.setName(name),
			getTuiInfo: () => {
				if (tui === undefined) {
					throw new Error("TUI service is unavailable");
				}
				return {
					themeName: tui.getThemeName(),
					themeNames: [...tui.getThemeNames()],
					hotkeys: tui.getHotkeys().map((hotkey) => ({ ...hotkey })),
				};
			},
		};
	}
}

function validateConfig(config: CodingSessionConfig): void {
	if (!config.session) {
		throw new Error("CodingSession requires a session handle");
	}
	if (!config.provider) {
		throw new Error("CodingSession requires a model provider");
	}
	if (config.provider.providerId.trim().length === 0) {
		throw new Error("CodingSession requires a provider ID");
	}
	if (config.model.trim().length === 0) {
		throw new Error("CodingSession requires a default model name");
	}
	if (!isReasoningLevel(config.reasoning)) {
		throw new Error(`Invalid reasoning level: ${String(config.reasoning)}`);
	}
	if (
		config.timeout !== undefined &&
		(!Number.isFinite(config.timeout) || config.timeout <= 0)
	) {
		throw new Error(
			"CodingSession timeout must be finite and greater than zero",
		);
	}
	if (
		config.systemPrompt !== undefined &&
		config.systemPrompt.trim().length === 0
	) {
		throw new Error("Custom system prompt cannot be empty");
	}
}

function validateAvailableTools(tools: readonly CodingToolDefinition[]): void {
	const names = new Set<string>();
	for (const tool of tools) {
		if (names.has(tool.name)) {
			throw new Error(`Duplicate coding tool name: ${tool.name}`);
		}
		names.add(tool.name);
	}
}

function requireStoredModel(
	context: SessionContext,
): NonNullable<SessionContext["model"]> {
	if (context.model === null) {
		throw new Error("Session has no model after runtime initialization");
	}
	return context.model;
}

function selectActiveTools(
	availableTools: readonly CodingToolDefinition[],
	activeToolNames: readonly string[] | null,
): CodingToolDefinition[] {
	if (activeToolNames === null) {
		throw new Error(
			"Session has no active-tool selection after initialization",
		);
	}

	const availableByName = new Map(
		availableTools.map((tool) => [tool.name, tool]),
	);
	const selected: CodingToolDefinition[] = [];
	const selectedNames = new Set<string>();

	for (const name of activeToolNames) {
		const tool = availableByName.get(name);
		if (!tool) {
			throw new Error(`Stored active tool is unavailable: ${name}`);
		}
		if (selectedNames.has(name)) {
			throw new Error(`Stored active tool is duplicated: ${name}`);
		}
		selectedNames.add(name);
		selected.push(tool);
	}

	return selected;
}

function sameToolSelection(
	left: readonly CodingToolDefinition[],
	right: readonly CodingToolDefinition[],
): boolean {
	return (
		left.length === right.length &&
		left.every((tool, index) => tool.name === right[index]?.name)
	);
}

function sameModel(left: SessionModel, right: SessionModel): boolean {
	return left.provider === right.provider && left.model === right.model;
}

function isReasoningLevel(value: unknown): value is ReasoningLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}
