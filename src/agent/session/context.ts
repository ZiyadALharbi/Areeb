import type { AgentMessage } from "../types.ts";
import {
	createBranchSummaryMessage,
	createCompactionMessage,
} from "./messages.ts";
import type {
	CompactionEntry,
	SessionContext,
	SessionContextBuildOptions,
	SessionStorage,
} from "./types.ts";

export async function buildSessionContext(
	storage: Pick<SessionStorage, "getLeafId" | "findEntriesOnBranch">,
	options: SessionContextBuildOptions = {},
): Promise<SessionContext> {
	const leafId = await storage.getLeafId();
	const entries =
		leafId === null
			? []
			: await storage.findEntriesOnBranch({
					startId: leafId,
					order: "oldest_first",
				});

	let model: SessionContext["model"] = null;
	let reasoning: SessionContext["reasoning"] = "high";
	let activeToolNames: SessionContext["activeToolNames"] = null;
	let newestCompaction: { entry: CompactionEntry; index: number } | undefined;

	for (const [index, entry] of entries.entries()) {
		switch (entry.type) {
			case "model_change":
				model = {
					provider: entry.provider,
					model: entry.model,
				};
				break;

			case "reasoning_change":
				reasoning = entry.reasoning;
				break;

			case "active_tools_change":
				activeToolNames = [...entry.activeToolNames];
				break;

			case "compaction":
				newestCompaction = { entry, index };
				break;

			case "message":
			case "branch_summary":
			case "custom":
				break;
		}
	}

	const messages: AgentMessage[] = [];
	let firstEntryIndex = 0;

	if (newestCompaction !== undefined) {
		messages.push(createCompactionMessage(newestCompaction.entry));
		messages.push(...structuredClone(newestCompaction.entry.retainedTail));
		firstEntryIndex = newestCompaction.index + 1;
	}

	for (let index = firstEntryIndex; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry === undefined) {
			continue;
		}

		switch (entry.type) {
			case "message":
				messages.push(structuredClone(entry.message));
				break;

			case "branch_summary":
				messages.push(createBranchSummaryMessage(entry));
				break;

			case "custom": {
				const projector = options.customEntryProjectors?.[entry.customType];
				const projected = projector?.(entry, index, entries);

				if (projected !== undefined) {
					messages.push(...structuredClone(projected));
				}
				break;
			}

			case "model_change":
			case "reasoning_change":
			case "active_tools_change":
			case "compaction":
				break;
		}
	}

	return {
		messages,
		model,
		reasoning,
		activeToolNames,
	};
}
