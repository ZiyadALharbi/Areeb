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
  data?: unknown;
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
	readonly startId: string;
	readonly stopAtId?: string;
	readonly stopAtType?: SessionEntryType;
}

export interface SessionMetadata {
	readonly id: string;
	readonly createdAt: number;
	readonly cwd: string;
	readonly parentSessionId?: string;
	readonly metadata?: JsonObject;
}

export interface SessionCreateOptions {
	readonly id?: string;
	readonly cwd: string;
	readonly parentSessionId?: string;
	readonly metadata?: JsonObject;
}

export interface SessionListOptions {
	readonly cwd?: string;
}

export interface SessionModel {
	readonly provider: string;
	readonly model: string;
}

export interface SessionContext {
	readonly messages: AgentMessage[];
	readonly model: SessionModel | null;
	readonly reasoning: ReasoningLevel;
	readonly activeToolNames: string[] | null;
}

export interface SessionCompactionMessage {
	readonly role: "session_compaction";
	readonly summary: string;
	readonly tokensBefore: number;
	readonly timestamp: number;
}

export interface SessionBranchSummaryMessage {
	readonly role: "session_branch_summary";
	readonly summary: string;
	readonly sourceLeafId: string;
	readonly timestamp: number;
}
