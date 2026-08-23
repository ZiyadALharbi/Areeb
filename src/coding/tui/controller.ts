import type { SessionHandle, SessionModel } from "../../agent/session/types.ts";
import type {
	AgentMessage,
	AgentRunStream,
	QueuedMessages,
} from "../../agent/types.ts";
import type { ReasoningLevel } from "../../ai/types.ts";
import type {
	CommandModelListItem,
	CommandOutcome,
	CommandResult,
	CommandSessionListItem,
	SlashCommand,
} from "../commands.ts";
import type {
	CodingSessionControllerService,
	CodingSessionHostServices,
	CodingSessionModelService,
	CodingSessionTuiService,
} from "../session.ts";
import type { CodingSessionRecord } from "../session-manager.ts";
import { TuiEventAdapter } from "./adapter.ts";
import type { CompletionCatalog } from "./autocomplete.ts";
import { createTuiState, type TuiState } from "./state.ts";

export type TuiTransitionOutcome = Exclude<
	CommandOutcome,
	| { readonly kind: "new-session" }
	| { readonly kind: "resume" }
	| { readonly kind: "set-model" }
>;

export type TuiCommandResult =
	| { readonly handled: false }
	| { readonly handled: true; readonly outcome: TuiTransitionOutcome };

export interface TuiControllerSession {
	readonly messages: readonly AgentMessage[];
	readonly metadata: { readonly id: string; readonly cwd: string };
	readonly provider: string;
	readonly model: string;
	readonly reasoning: ReasoningLevel;
	readonly isRunning: boolean;
	readonly queuedMessages: QueuedMessages;
	readonly commands: readonly SlashCommand[];
	readonly skills: readonly { readonly name: string }[];
	readonly promptTemplates: readonly { readonly name: string }[];
	prompt(input: string): AgentRunStream;
	handleCommand(
		input: string,
		services?: CodingSessionHostServices,
	): Promise<CommandResult>;
	abort(): void;
	followUp(input: string): QueuedMessages;
	clearQueues(): QueuedMessages;
	waitForIdle(): Promise<void>;
}

export interface TuiSessionManager {
	readonly cwd: string;
	create(): Promise<SessionHandle>;
	find(id: string): Promise<CodingSessionRecord | undefined>;
	open(id: string): Promise<SessionHandle>;
	list(): Promise<CodingSessionRecord[]>;
}

export interface TuiSessionLoadRequest {
	readonly handle: SessionHandle;
	readonly selection: SessionModel;
	readonly reasoning: ReasoningLevel;
}

export type TuiSessionLoader = (
	request: TuiSessionLoadRequest,
) => Promise<TuiControllerSession>;

export interface TuiPreparedSession {
	readonly session: TuiControllerSession;
	commit(): Promise<void>;
}

export type TuiModelSessionLoader = (
	request: TuiSessionLoadRequest,
) => Promise<TuiPreparedSession>;

export interface TuiControllerOptions {
	readonly session: TuiControllerSession;
	readonly manager: TuiSessionManager;
	readonly loadSession: TuiSessionLoader;
	readonly models?: readonly CommandModelListItem[];
	readonly prepareModelSession?: TuiModelSessionLoader;
}

interface ActiveBundle {
	readonly session: TuiControllerSession;
	readonly state: TuiState;
	readonly adapter: TuiEventAdapter;
}

/** Owns the one active session and commits replacements as complete bundles. */
export class TuiController {
	private active: ActiveBundle;
	private transitionActive = false;
	private newSessionPending = false;
	private readonly sessionControllerService: CodingSessionControllerService;
	private readonly modelControllerService:
		| CodingSessionModelService
		| undefined;
	private readonly modelCatalog: readonly CommandModelListItem[];

	constructor(private readonly options: TuiControllerOptions) {
		this.active = buildBundle(options.session);
		this.sessionControllerService = {
			listSessions: () => this.listSessions(),
		};
		this.modelCatalog = Object.freeze(
			(options.models ?? []).map((entry) =>
				Object.freeze({ provider: entry.provider, model: entry.model }),
			),
		);
		this.modelControllerService =
			options.prepareModelSession === undefined
				? undefined
				: { listModels: () => this.models };
	}

	get session(): TuiControllerSession {
		return this.active.session;
	}

	get state(): TuiState {
		return this.active.state;
	}

	get adapter(): TuiEventAdapter {
		return this.active.adapter;
	}

	get messages(): readonly AgentMessage[] {
		return this.active.session.messages;
	}

	get metadata(): TuiControllerSession["metadata"] {
		return this.active.session.metadata;
	}

	get provider(): string {
		return this.active.session.provider;
	}

	get model(): string {
		return this.active.session.model;
	}

	get reasoning(): ReasoningLevel {
		return this.active.session.reasoning;
	}

	get isRunning(): boolean {
		return this.active.session.isRunning;
	}

	get queuedMessages(): QueuedMessages {
		return this.active.session.queuedMessages;
	}

	get models(): readonly CommandModelListItem[] {
		return this.modelCatalog.map((entry) => ({ ...entry }));
	}

	get completionCatalog(): CompletionCatalog {
		return {
			commands: this.active.session.commands,
			skillNames: this.active.session.skills.map((skill) => skill.name),
			templateNames: this.active.session.promptTemplates.map(
				(template) => template.name,
			),
			availableCapabilities: [
				"session-controller",
				...(this.modelControllerService === undefined
					? []
					: (["model-selection"] as const)),
				"tui",
			],
			cwd: this.active.session.metadata.cwd,
			listSessions: () => this.listSessions(),
			models: this.models,
		};
	}

	prompt(input: string): AgentRunStream {
		if (this.transitionActive) {
			throw new Error(
				"Cannot start a prompt while a session change is in progress",
			);
		}
		this.newSessionPending = false;
		return this.active.session.prompt(input);
	}

	abort(): void {
		this.active.session.abort();
	}

	followUp(input: string): QueuedMessages {
		if (!this.active.session.isRunning) {
			throw new Error("Cannot queue a follow-up while the agent is idle");
		}
		return this.active.session.followUp(input);
	}

	clearQueues(): QueuedMessages {
		return this.active.session.clearQueues();
	}

	waitForIdle(): Promise<void> {
		return this.active.session.waitForIdle();
	}

	async handleCommand(
		input: string,
		tuiService?: CodingSessionTuiService,
	): Promise<TuiCommandResult> {
		const services: CodingSessionHostServices = {
			sessionController: this.sessionControllerService,
			...(this.modelControllerService === undefined
				? {}
				: { modelController: this.modelControllerService }),
			...(tuiService === undefined ? {} : { tui: tuiService }),
		};
		const result = await this.active.session.handleCommand(input, services);
		if (!result.handled) {
			this.newSessionPending = false;
			return result;
		}

		switch (result.outcome.kind) {
			case "new-session":
				return { handled: true, outcome: await this.newSession() };
			case "resume":
				this.newSessionPending = false;
				return {
					handled: true,
					outcome: await this.resumeSession(result.outcome.sessionId),
				};
			case "set-model":
				this.newSessionPending = false;
				return {
					handled: true,
					outcome: await this.setModel(
						result.outcome.provider,
						result.outcome.model,
					),
				};
			case "resume-picker":
				this.newSessionPending = false;
				return {
					handled: true,
					outcome: this.transitionBlock("resume a session") ?? result.outcome,
				};
			case "model-picker":
				this.newSessionPending = false;
				return {
					handled: true,
					outcome: this.transitionBlock("switch models") ?? result.outcome,
				};
			case "message":
			case "quit":
			case "none":
			case "unavailable":
				this.newSessionPending = false;
				return { handled: true, outcome: result.outcome };
		}
	}

	async newSession(): Promise<TuiTransitionOutcome> {
		const blocked = this.transitionBlock("start a new session");
		if (blocked !== undefined) {
			this.newSessionPending = false;
			return blocked;
		}
		if (!this.newSessionPending) {
			this.newSessionPending = true;
			return {
				kind: "message",
				level: "warning",
				text: "Run /new again to confirm starting a new session",
			};
		}

		this.newSessionPending = false;
		const current = this.active.session;
		return this.replaceSession(
			async () => this.options.manager.create(),
			{
				provider: current.provider,
				model: current.model,
			},
			current.reasoning,
			"Failed to start a new session",
		);
	}

	async resumeSession(id: string): Promise<TuiTransitionOutcome> {
		const blocked = this.transitionBlock("resume a session");
		if (blocked !== undefined) {
			return blocked;
		}
		if (id === this.active.session.metadata.id) {
			return {
				kind: "message",
				level: "info",
				text: `Session ${id} is already active`,
			};
		}

		this.transitionActive = true;
		try {
			const record = await this.options.manager.find(id);
			if (record === undefined) {
				return message("error", `Unknown session: ${id}`);
			}
			if (record.model === null) {
				return message(
					"error",
					`Session ${id} has no stored provider/model selection`,
				);
			}

			const handle = await this.options.manager.open(id);
			const candidate = await this.options.loadSession({
				handle,
				selection: record.model,
				reasoning: "off",
			});
			const bundle = buildBundle(candidate);
			this.active = bundle;
			return { kind: "none" };
		} catch (error) {
			return transitionFailure(`Failed to resume session ${id}`, error);
		} finally {
			this.transitionActive = false;
		}
	}

	async setModel(
		provider: string,
		model: string,
	): Promise<TuiTransitionOutcome> {
		const blocked = this.transitionBlock("switch models");
		if (blocked !== undefined) {
			return blocked;
		}
		if (this.options.prepareModelSession === undefined) {
			return message("error", "Model switching is unavailable");
		}
		if (
			!this.modelCatalog.some(
				(entry) => entry.provider === provider && entry.model === model,
			)
		) {
			return message(
				"error",
				`Unknown or unavailable model: ${provider}/${model}`,
			);
		}
		if (
			provider === this.active.session.provider &&
			model === this.active.session.model
		) {
			return message("info", `${provider}/${model} is already active`);
		}

		this.transitionActive = true;
		try {
			const handle = await this.options.manager.open(
				this.active.session.metadata.id,
			);
			const prepared = await this.options.prepareModelSession({
				handle,
				selection: { provider, model },
				reasoning: this.active.session.reasoning,
			});
			const bundle = buildBundle(prepared.session);
			await prepared.commit();
			this.active = bundle;
			return { kind: "none" };
		} catch (error) {
			return transitionFailure(
				`Failed to switch to ${provider}/${model}`,
				error,
			);
		} finally {
			this.transitionActive = false;
		}
	}

	async listSessions(): Promise<readonly CommandSessionListItem[]> {
		return (await this.options.manager.list()).map((session) => ({
			id: session.id,
			title: session.title,
			model: session.model === null ? null : { ...session.model },
		}));
	}

	private transitionBlock(action: string): TuiTransitionOutcome | undefined {
		if (this.active.session.isRunning) {
			return message(
				"warning",
				`Cannot ${action} while the current session is running`,
			);
		}
		if (this.transitionActive) {
			return message(
				"warning",
				"Cannot switch sessions while another session change is in progress",
			);
		}
		return undefined;
	}

	private async replaceSession(
		openHandle: () => Promise<SessionHandle>,
		selection: SessionModel,
		reasoning: ReasoningLevel,
		failurePrefix: string,
	): Promise<TuiTransitionOutcome> {
		this.transitionActive = true;
		try {
			const handle = await openHandle();
			const candidate = await this.options.loadSession({
				handle,
				selection,
				reasoning,
			});
			const bundle = buildBundle(candidate);
			this.active = bundle;
			return { kind: "none" };
		} catch (error) {
			return transitionFailure(failurePrefix, error);
		} finally {
			this.transitionActive = false;
		}
	}
}

function buildBundle(session: TuiControllerSession): ActiveBundle {
	const state = createTuiState({
		sessionId: session.metadata.id,
		model: session.model,
		cwd: session.metadata.cwd,
	});
	state.queuedCount = session.queuedMessages.count;
	const adapter = new TuiEventAdapter(state);
	adapter.restore(session.messages);
	return { session, state, adapter };
}

function transitionFailure(
	prefix: string,
	error: unknown,
): TuiTransitionOutcome {
	return message("error", `${prefix}: ${errorMessage(error)}`);
}

function message(
	level: "info" | "warning" | "error",
	text: string,
): TuiTransitionOutcome {
	return { kind: "message", level, text };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
