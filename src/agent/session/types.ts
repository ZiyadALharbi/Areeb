import type { AgentMessage } from "../types.ts";
import type { ReasoningLevel, Usage } from "../../ai/types.ts";

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

	export interface JsonObject {
		[key: string]: JsonValue;
	}

export interface SessionEntryBase {
	id: string;
	seq: number;
	parentId: string | null;
	timestamp: number;
}


export interface MessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	model: string;
}

export interface ReasoningChangeEntry extends SessionEntryBase {
	type: "reasoning_change";
	reasoning: ReasoningLevel;
}

export interface ActiveToolsChangeEntry extends SessionEntryBase {
	type: "active_tools_change";
	activeToolNames: string[];
}

export interface CompactionEntry extends SessionEntryBase {
	type: "compaction";
	summary: string;
	retainedTail: AgentMessage[];
  tokensBefore: number;
  details?: unknown;
  usage?: Usage;
}

export interface BranchSummaryEntry extends SessionEntryBase {
	type: "branch_summary";
	sourceLeafId: string;
  summary: string;
  details?: unknown;
	usage?: Usage;
}

export interface CustomEntry extends SessionEntryBase {
	type: "custom";
	customType: string;
  data?: JsonValue;
}

export type SessionEntry =
	| MessageEntry
	| ModelChangeEntry
	| ReasoningChangeEntry
	| ActiveToolsChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
  | CustomEntry;

  export type SessionEntryType = SessionEntry["type"];

  export type SessionEntryOfType<TType extends SessionEntryType> = Extract<
	SessionEntry,
	{ type: TType }
  >;

  /**
   * Entry input accepted by the public Session facade.
   *
   * The facade generates id. Storage assigns parentId, seq, and timestamp.
   */
  export type NewSessionEntry<
	TEntry extends SessionEntry = SessionEntry,
  > = TEntry extends SessionEntry
	? Omit<TEntry, keyof SessionEntryBase>
	: never;


	/**
 * Entry accepted by a storage backend.
 *
 * The facade has provisioned id, while storage still owns parentId, seq,
 * and timestamp.
 *
 * NewSessionEntry          → before the facade creates id
 * ProvisionedSessionEntry  → after id exists, before storage metadata exists
 */

	export type ProvisionedSessionEntry<
		TEntry extends SessionEntry = SessionEntry,
	> = TEntry extends SessionEntry
		? Omit<TEntry, "parentId" | "seq" | "timestamp">
		: never;

	export interface EntryMutation {
		kind: "entry";
		entry: SessionEntry;
	}

	export interface PointerMutation {
		kind: "pointer";
		seq: number;
		timestamp: number;
		pointer: "main";
		leafId: string | null;
	}

	export interface NameFactMutation {
		kind: "fact";
		seq: number;
		timestamp: number;
		fact: "name";
		value: string | null;
	}

	export interface LabelFactMutation {
		kind: "fact";
		seq: number;
		timestamp: number;
		fact: "label";
		targetId: string;
		value: string | null;
  }
export type FactMutation = NameFactMutation | LabelFactMutation;

export type SessionMutation =
  | EntryMutation
  | PointerMutation
  | FactMutation;

export type EntryOrder = "newest_first" | "oldest_first";

export interface EntryCursor {
	/**
	 * Exclusive pagination cursor.
	 *
	 * oldest_first returns entries with greater sequences.
	 * newest_first returns entries with smaller sequences.
	 *
	 * oldest = created earliest
	 * newest = created latest
	 * seq determines their order
	 *
	 * With afterSeq: 5:
	 * oldest_first → 6, 7, 8, ...
	 * newest_first → 4, 3, 2, ...
	 */
	readonly afterSeq: number;
}

export interface EntryQuery {
	readonly type?: SessionEntryType;
	readonly customType?: string;
	readonly order?: EntryOrder;
	readonly limit?: number;
	readonly cursor?: EntryCursor;
}
export interface BranchEntryQuery extends EntryQuery {
	/**
	 * Defaults to the active main leaf when omitted.
	 * Explicit null represents an empty branch.
	 * EntryQuery       → general entry filters
	 * BranchEntryQuery → general filters + branch start/stop rules
	 */
	startId?: string | null;

	/** Inclusive stopping bound. */
	stopAtId?: string;

	/** Inclusive stopping bound. */
	stopAtType?: SessionEntryType;
}

/**
 * Storage receives an explicit non-null branch start so it never resolves
 * the active pointer separately from the query operation.
 */
export interface StorageBranchEntryQuery extends EntryQuery {
	startId: string;
	stopAtId?: string;
	stopAtType?: SessionEntryType;
}

export interface SessionMetadata {
	id: string;
	createdAt: number;
	cwd: string;
	parentSessionId?: string;
	metadata?: JsonObject;
}

export interface SessionCreateOptions {
	id?: string;
	cwd: string;
	parentSessionId?: string;
	metadata?: JsonObject;
}

export interface SessionListOptions {
	cwd?: string;
}

export interface SessionModel {
	provider: string;
	model: string;
}

export interface SessionContext {
	messages: AgentMessage[];
	model: SessionModel | null;
	reasoning: ReasoningLevel;
	activeToolNames: string[] | null;
}

export interface SessionCompactionMessage {
	role: "session_compaction";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

export interface SessionBranchSummaryMessage {
	role: "session_branch_summary";
	summary: string;
	sourceLeafId: string;
	timestamp: number;
}

/* This is useful for adding features to an existing shared type without editing the original file. */
declare module "../types.ts" {
	interface CustomAgentMessages {
		session_compaction: SessionCompactionMessage;
		session_branch_summary: SessionBranchSummaryMessage;
	}
}

export type CustomEntryContextProjector = (
	entry: CustomEntry,
	index: number,
	entries: readonly SessionEntry[],
) => readonly AgentMessage[] | undefined;

export interface SessionContextBuildOptions {
	readonly customEntryProjectors?: Readonly<
		Record<string, CustomEntryContextProjector>
	>;
}

/**
 * Public storage-neutral session contract.
 *
 * Concrete repositories return a Session facade implementing this contract.
 * It is the public API for working with a session.
 *
 * The facade separates application code from the storage implementation:
 *
 * it seperates
 * application code → SessionHandle → storage implementation
 * 
 *
 * How to apply it:
 *
 * A concrete session class must implement all of these methods:
 *
 * ```
 * class Session implements SessionHandle {
 *   // Implement getEntry, appendMessage, buildContext, etc.
 * }
 * ```
 *
 * Callers use the interface:
 *
 * ```
 * async function processSession(session: SessionHandle) {
 *   await session.appendMessage(message);
 *   const context = await session.buildContext();
 * }
 * ```
 */
export interface SessionHandle<
	TMetadata extends SessionMetadata = SessionMetadata,
> {
	getMetadata(): Promise<TMetadata>;
	getLeafId(): Promise<string | null>;
	moveLeaf(id: string | null): Promise<void>;

	getEntry(id: string): Promise<SessionEntry | undefined>;
	getChildren(parentId: string | null): Promise<SessionEntry[]>;
	findEntries(query?: EntryQuery): Promise<SessionEntry[]>;
	findEntriesOnBranch(query?: BranchEntryQuery): Promise<SessionEntry[]>;

	appendMessage(message: AgentMessage): Promise<string>;
	appendCustomEntry(customType: string, data?: JsonValue): Promise<string>;
	appendEntry<TEntry extends NewSessionEntry>(
		entry: TEntry,
	): Promise<string>;

	getName(): Promise<string | undefined>;
	setName(name: string | null): Promise<void>;
	getLabel(targetId: string): Promise<string | undefined>;
	setLabel(targetId: string, label: string | null): Promise<void>;

	buildContext(options?: SessionContextBuildOptions): Promise<SessionContext>;
}

/**
 * Backend contract used by the Session facade.
 *
 * Implementations must serialize mutations. JSONL storage must persist first
 * and update replay state only after the append succeeds.
 * 
 * 
 * `SessionHandle` and `SessionStorage` are two layers:
 *
 * Application code
 *       ↓
 * SessionHandle   (public facade)
 *       ↓
 * SessionStorage  (internal persistence backend)
 *       ↓
 * JSONL / database / files
 * 
 * SessionHandle:
 * Used by the rest of the application
 * It provides convenient session operations
 * 
 * SessionStorage:
 * Used internally by the session implementation
 * It provides low-level persistence operations
 * 
 * SessionHandle  = what users can do with a session
 * SessionStorage = how the session is stored
 * 
 * session.appendMessage(message);
 * 
 * The handle may internally call:
 * 
 * ```ts
 * storage.appendEntry(provisionedEntry);
 * ```
 The application uses the handle; the handle uses storage.
 */
export interface SessionStorage<
	TMetadata extends SessionMetadata = SessionMetadata,
> {
	getMetadata(): Promise<TMetadata>;
	getLeafId(): Promise<string | null>;
	moveLeaf(id: string | null): Promise<void>;

	appendEntry<TEntry extends SessionEntry>(
		entry: ProvisionedSessionEntry<TEntry>,
	): Promise<TEntry>;

	getEntry(id: string): Promise<SessionEntry | undefined>;
	getChildren(parentId: string | null): Promise<SessionEntry[]>;
	findEntries(query?: EntryQuery): Promise<SessionEntry[]>;
	findEntriesOnBranch(
		query: StorageBranchEntryQuery,
	): Promise<SessionEntry[]>;

	getName(): Promise<string | undefined>;
	setName(name: string | null): Promise<void>;
	getLabel(targetId: string): Promise<string | undefined>;
	setLabel(targetId: string, label: string | null): Promise<void>;
}


/**
 * `SessionRepository` describes an object that manages multiple sessions.
 * 
 * It has three configurable type parameters:
 * 
 * - `TMetadata`: the metadata shape for a session
 * - `TCreateOptions`: options needed to create a session
 * - `TListOptions`: options used to list sessions
 * 
 * 
 * create:
 *  Creates a new session.
 *  - receives creation options
 *  - asynchronously returns a `SessionHandle`
 *  - `Promise` means the operation may involve disk/database work
 * 
 * open:
 *  Opens an existing session using its metadata.
 *  The comment means repeated calls to `open` through the same repository reuse the same storage writer.
 * 
 * list:
 *  Lists session metadata.
 *  - `options?` means options are optional
 *  - returns an array of metadata asynchronously
 * 
 * Example usage:
 * const metadata = await repository.list();
 * const session = await repository.open(metadata[0]);
 */

export interface SessionRepository<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions extends SessionListOptions = SessionListOptions,
> {
	create(options: TCreateOptions): Promise<SessionHandle<TMetadata>>;

	/**
	 * Opens metadata returned by list().
	 *
	 * Repeated opens through one repository share the same storage writer.
	 */
	open(metadata: TMetadata): Promise<SessionHandle<TMetadata>>;

	list(options?: TListOptions): Promise<TMetadata[]>;
}

export type SessionIdGenerator = () => string;
export type SessionClock = () => number;