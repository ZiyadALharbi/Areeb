import type {
	BranchSummaryEntry,
	CompactionEntry,
	SessionBranchSummaryMessage,
	SessionCompactionMessage,
} from "./types.ts";

export function createCompactionMessage(
	entry: CompactionEntry,
): SessionCompactionMessage {
	return {
		role: "session_compaction",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: entry.timestamp,
	};
}

export function createBranchSummaryMessage(
	entry: BranchSummaryEntry,
): SessionBranchSummaryMessage {
	return {
		role: "session_branch_summary",
		summary: entry.summary,
		sourceLeafId: entry.sourceLeafId,
		timestamp: entry.timestamp,
	};
}
