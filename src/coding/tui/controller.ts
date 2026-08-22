import type { SessionHandle, SessionModel } from "../../agent/session/types.ts";
import type { AgentMessage, AgentRunStream } from "../../agent/types.ts";
import type { ReasoningLevel } from "../../ai/types.ts";
import type {
	CommandOutcome,
	CommandResult,
	CommandSessionListItem,
} from "../commands.ts";
import type {
	CodingSessionControllerService,
	CodingSessionHostServices,
} from "../session.ts";
import type { CodingSessionRecord } from "../session-manager.ts";
import { TuiEventAdapter } from "./adapter.ts";
import { createTuiState, type TuiState } from "./state.ts";

type AppliedCommandOutcome = Exclude<
	CommandOutcome,
	{ readonly kind: "new-session" } | { readonly kind: "resume" }
>;

export type TuiCommandResult =
	| { readonly handled: false }
	| { readonly handled: true; readonly outcome: AppliedCommandOutcome };

export interface TuiControllerSession {
	readonly messages: readonly AgentMessage[];
	readonly metadata: { readonly id: string; readonly cwd: string };
	readonly provider: string;
	readonly model: string;
	readonly reasoning: ReasoningLevel;
	readonly isRunning: boolean;
	prompt(input: string): AgentRunStream;
	handleCommand(
		input: string,
		services?: CodingSessionHostServices,
	): Promise<CommandResult>;
	abort(): void;
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

export interface TuiControllerOptions {
	readonly session: TuiControllerSession;
	readonly manager: TuiSessionManager;
	readonly loadSession: TuiSessionLoader;
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

	constructor(private readonly options: TuiControllerOptions) {
		this.active = buildBundle(options.session);
		this.sessionControllerService = {
			listSessions: () => this.listSessions(),
		};
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

	prompt(input: string): AgentRunStream {
		this.newSessionPending = false;
		return this.active.session.prompt(input);
	}

	abort(): void {
		this.active.session.abort();
	}

	waitForIdle(): Promise<void> {
		return this.active.session.waitForIdle();
	}

	async handleCommand(input: string): Promise<TuiCommandResult> {
		const services: CodingSessionHostServices = {
			sessionController: this.sessionControllerService,
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
			case "message":
			case "quit":
			case "none":
			case "unavailable":
				this.newSessionPending = false;
				return { handled: true, outcome: result.outcome };
		}
	}

	async newSession(): Promise<AppliedCommandOutcome> {
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

	async resumeSession(id: string): Promise<AppliedCommandOutcome> {
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

	private async listSessions(): Promise<readonly CommandSessionListItem[]> {
		return (await this.options.manager.list()).map((session) => ({
			id: session.id,
			title: session.title,
			model: session.model === null ? null : { ...session.model },
		}));
	}

	private transitionBlock(action: string): AppliedCommandOutcome | undefined {
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
	): Promise<AppliedCommandOutcome> {
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
	const adapter = new TuiEventAdapter(state);
	adapter.restore(session.messages);
	return { session, state, adapter };
}

function transitionFailure(
	prefix: string,
	error: unknown,
): AppliedCommandOutcome {
	return message("error", `${prefix}: ${errorMessage(error)}`);
}

function message(
	level: "info" | "warning" | "error",
	text: string,
): AppliedCommandOutcome {
	return { kind: "message", level, text };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
