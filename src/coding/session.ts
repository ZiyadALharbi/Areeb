import { AgentHarness } from "../agent/harness.ts";
import type {
	SessionContext,
	SessionHandle,
	SessionMetadata,
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
	expandPromptTemplateInvocation,
	loadPromptTemplates,
	type PromptTemplate,
} from "./prompt-templates.ts";
import { type AreebResourcePaths, areebResourcePaths } from "./resources.ts";
import {
	expandSkillInvocation,
	isSkillDirective,
	loadSkills,
	type Skill,
} from "./skills.ts";
import { createCodingTools } from "./tools/index.ts";

export interface CodingSessionConfig<
	TMetadata extends SessionMetadata = SessionMetadata,
> {
	readonly session: SessionHandle<TMetadata>;
	readonly provider: ModelProvider;
	/** Default model for a branch that has no stored model selection. */
	readonly model: string;
	/** Default reasoning level for a branch that has no stored selection. */
	readonly reasoning: ReasoningLevel;
	readonly systemPrompt: string;
	/** Complete available tool set. Omit for the built-in cwd-bound coding tools. */
	readonly tools?: readonly AgentTool[];
	readonly timeout?: number;
	readonly maxTurns?: number;
	readonly messageConverter?: AgentMessageConverter;
	readonly steeringMode?: QueueMode;
	readonly followUpMode?: QueueMode;
	/** Override the default ~/.areeb and <cwd>/.areeb resource paths. */
	readonly resourcePaths?: AreebResourcePaths;
	/** Project resources are ignored unless the caller explicitly trusts them. */
	readonly trustProjectResources?: boolean;
}

export interface CommandResult {
	readonly handled: boolean;
	readonly message?: string;
	readonly exitRequested?: boolean;
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

	private constructor(
		private readonly session: SessionHandle<TMetadata>,
		private readonly harness: AgentHarness,
		private readonly sessionMetadata: TMetadata,
		private readonly sessionModel: string,
		private readonly sessionReasoning: ReasoningLevel,
		private readonly activeTools: readonly AgentTool[],
		private readonly loadedSkills: readonly Skill[],
		private readonly loadedPromptTemplates: readonly PromptTemplate[],
	) {}

	static async load<TMetadata extends SessionMetadata = SessionMetadata>(
		config: CodingSessionConfig<TMetadata>,
	): Promise<CodingSession<TMetadata>> {
		validateConfig(config);

		const metadata = await config.session.getMetadata();
		const resourcePaths =
			config.resourcePaths ?? areebResourcePaths({ cwd: metadata.cwd });
		const skillDirectories = [resourcePaths.userSkills];
		const promptDirectories = [resourcePaths.userPrompts];
		if (config.trustProjectResources === true) {
			skillDirectories.push(resourcePaths.projectSkills);
			promptDirectories.push(resourcePaths.projectPrompts);
		}
		const [skills, promptTemplates] = await Promise.all([
			loadSkills(skillDirectories),
			loadPromptTemplates(promptDirectories),
		]);
		let context = await config.session.buildContext();
		const availableTools =
			config.tools === undefined
				? createCodingTools(metadata.cwd)
				: [...config.tools];
		validateAvailableTools(availableTools);

		const hasReasoningEntry =
			(
				await config.session.findEntriesOnBranch({
					type: "reasoning_change",
					limit: 1,
				})
			).length > 0;
		let initialized = false;

		if (context.model === null) {
			await config.session.appendEntry({
				type: "model_change",
				provider: config.provider.providerId,
				model: config.model,
			});
			initialized = true;
		}

		if (!hasReasoningEntry) {
			await config.session.appendEntry({
				type: "reasoning_change",
				reasoning: config.reasoning,
			});
			initialized = true;
		}

		if (context.activeToolNames === null) {
			await config.session.appendEntry({
				type: "active_tools_change",
				activeToolNames: availableTools.map((tool) => tool.name),
			});
			initialized = true;
		}

		if (initialized) {
			context = await config.session.buildContext();
		}

		const model = requireStoredModel(context);
		if (model.provider !== config.provider.providerId) {
			throw new Error(
				`Stored provider "${model.provider}" does not match configured provider "${config.provider.providerId}"`,
			);
		}

		const tools = selectActiveTools(availableTools, context.activeToolNames);
		const harness = new AgentHarness(
			{
				provider: config.provider,
				model: model.model,
				systemPrompt: config.systemPrompt,
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
		for (const repair of repairs) {
			await config.session.appendMessage(repair);
		}

		const codingSession = new CodingSession(
			config.session,
			harness,
			metadata,
			model.model,
			context.reasoning,
			tools,
			skills,
			promptTemplates,
		);
		codingSession.attachPersistence();
		return codingSession;
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

	get reasoning(): ReasoningLevel {
		return this.sessionReasoning;
	}

	get tools(): readonly AgentTool[] {
		return [...this.activeTools];
	}

	get skills(): readonly Skill[] {
		return this.loadedSkills.map((skill) => ({ ...skill }));
	}

	get promptTemplates(): readonly PromptTemplate[] {
		return this.loadedPromptTemplates.map((template) => ({ ...template }));
	}

	get isRunning(): boolean {
		return this.harness.isRunning;
	}

	prompt(
		input: string | AgentMessage | readonly AgentMessage[],
	): AgentRunStream {
		this.assertPersistenceHealthy();
		return this.harness.prompt(
			typeof input === "string" ? this.expandPrompt(input) : input,
		);
	}

	continue(): AgentRunStream {
		this.assertPersistenceHealthy();
		return this.harness.continue();
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

	handleCommand(input: string): CommandResult {
		const command = input.trim();
		if (!command.startsWith("/")) {
			return { handled: false };
		}

		switch (command) {
			case "/help":
				return {
					handled: true,
					message: "Available commands:\n/help\n/exit",
				};
			case "/exit":
				return { handled: true, exitRequested: true };
		}

		if (
			isSkillDirective(input) ||
			this.loadedPromptTemplates.some((template) =>
				isTemplateDirective(input, template.name),
			)
		) {
			return { handled: false };
		}

		return {
			handled: true,
			message: `Unknown command: ${command}`,
		};
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

	private expandPrompt(input: string): string {
		const skillExpansion = expandSkillInvocation(input, this.loadedSkills);
		return skillExpansion === input
			? expandPromptTemplateInvocation(input, this.loadedPromptTemplates)
			: skillExpansion;
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
}

function validateAvailableTools(tools: readonly AgentTool[]): void {
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
	availableTools: readonly AgentTool[],
	activeToolNames: readonly string[] | null,
): AgentTool[] {
	if (activeToolNames === null) {
		throw new Error(
			"Session has no active-tool selection after initialization",
		);
	}

	const availableByName = new Map(
		availableTools.map((tool) => [tool.name, tool]),
	);
	const selected: AgentTool[] = [];
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

function isTemplateDirective(input: string, name: string): boolean {
	if (!input.startsWith(`/${name}`)) {
		return false;
	}
	const nextCharacter = input[name.length + 1];
	return nextCharacter === undefined || /\s/.test(nextCharacter);
}
