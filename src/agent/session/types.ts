import type { AgentMessage } from "../types.ts";
import type { ReasoningLevel, Usage } from "../../ai/types.ts";

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };


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
	 */
	afterSeq: number;
}