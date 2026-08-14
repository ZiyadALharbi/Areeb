import { SessionError } from "./errors.ts";
import type {
  EntryOrder,
  EntryQuery,
  SessionEntry,
  SessionMutation,
  StorageBranchEntryQuery,
} from "./types.ts";

// Deep Clone: changing the cloned object does not change the orignal.
function clone<T>(value: T): T {
	return structuredClone(value);
}

/**
 * Rebuilds session state by applying append-only mutations in sequence.
 *
 * This class performs no I/O. Durable backends validate a mutation here,
 * persist it, and apply it only after persistence succeeds.
 */
export class SessionState {
	private sequence = 0;
	private readonly entries: SessionEntry[] = [];
	private readonly entriesById = new Map<string, SessionEntry>();
	private readonly childrenByParent = new Map<
		string | null,
		SessionEntry[]
	>();

	private leafId: string | null = null;
	private name: string | undefined;
  private readonly labels = new Map<string, string>();
  constructor(mutations: readonly SessionMutation[] = []) {
    for (const mutation of mutations) {
        this.applyMutation(mutation);
    }
  }

  get nextSequence(): number {
		return this.sequence + 1;
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getName(): string | undefined {
		return this.name;
  }

  getlable(targetId: string): string | undefined {
    return this.labels.get(targetId);
  }

  getEntry(id: string): SessionEntry | undefined {
    const entry = this.entriesById.get(id);
    return entry === undefined ? undefined : clone(entry);
  }

  getChildren(parentId: string | null): SessionEntry[] {
    return clone(this.childrenByParent.get(parentId) ?? []);
  }

  findEntries(query: EntryQuery = {}): SessionEntry[] {
	this.validateQuery(query);
	return this.queryEntries(this.entries, query, "oldest_first");
  }
  
  findEntriesOnBranch(
	query: StorageBranchEntryQuery,
  ): SessionEntry[] {
	this.validateQuery(query);
  
	const branch = this.walkToRoot(
		query.startId,
		query.stopAtId,
		query.stopAtType,
	);
  
	return this.queryEntries(branch, query, "newest_first");
  }

  validateMutation(mutation: SessionMutation): void {
    const sequence = mutation.kind === "entry" ? mutation.entry.seq : mutation.seq;

    if (
      !Number.isSafeInteger(sequence) ||
      sequence !== this.nextSequence
    ) {
      this.invalid(
				`expected seq ${this.nextSequence}, received ${sequence}`,
			);
    }

    switch (mutation.kind) {
      case "entry":
        this.validateEntry(mutation.entry);
        return;
      case "pointer":
        if (mutation.pointer !== "main") {
  					this.invalid(`unknown pointer ${String(mutation.pointer)}`);
  				}

  				if (
  					mutation.leafId !== null &&
  					!this.entriesById.has(mutation.leafId)
  				) {
  					this.invalid(
  						`pointer references missing entry ${mutation.leafId}`,
  					);
  				}
        return;
        case "fact":
				if (
					mutation.fact === "label" &&
					!this.entriesById.has(mutation.targetId)
				) {
					this.invalid(
						`label references missing entry ${mutation.targetId}`,
					);
				}
				return;

    }
  }

  applyMutation(mutation: SessionMutation): void {
    this.validateMutation(mutation);

    switch (mutation.kind) {
      case "entry": {
        // Add the entry to every state index maintained by this replay state:
        //
        // 1. Clone it so outside code cannot mutate the stored state.
        // 2. Add it to the list of entries sharing its parent.
        // 3. Add it to the complete entries list.
        // 4. Index it by ID for fast lookup.
        // 5. Make it the current leaf and update the latest sequence number.
        const storedEntry = clone(mutation.entry);
        const siblings =
          this.childrenByParent.get(storedEntry.parentId) ?? [];
        siblings.push(storedEntry);
        this.childrenByParent.set(storedEntry.parentId, siblings);
        this.entries.push(storedEntry);
        this.entriesById.set(storedEntry.id, storedEntry);
        this.leafId = storedEntry.id;
        this.sequence = storedEntry.seq;
        return;
      }
      case "pointer":
				this.leafId = mutation.leafId;
				this.sequence = mutation.seq;
				return;

			case "fact":
				// Apply either a session-name fact or an entry-label fact:
				// - name + value     → set the session name.
				// - name + null      → clear the session name.
				// - label + value    → set/update the label for an entry.
				// - label + null     → remove the entry's label.
				if (mutation.fact === "name") {
					this.name =
						mutation.value === null ? undefined : mutation.value;
				} else if (mutation.value === null) {
					this.labels.delete(mutation.targetId);
				} else {
					this.labels.set(mutation.targetId, mutation.value);
				}

				// Record the mutation as processed and stop handling this case.
				this.sequence = mutation.seq;
				return;
    }
  }

  /**
   * Walks one parent chain from a selected entry toward the root.
   *
   * A branch is one path through the session history. For example:
   *
   *   A (root) → B → C
   *
   * Starting at C returns [C, B, A]. The stop bounds are inclusive, so the
   * entry that matches stopAtId or stopAtType is included in the result.
   * A visited set detects cycles such as A → B → A, preventing an infinite
   * loop while traversing invalid parent links.
   */
  private walkToRoot(
	startId: string,
	stopAtId?: string,
  stopAtType?: SessionEntry["type"],
  ): SessionEntry[] {
	// Find the entry where the traversal should begin.
	let current = this.entriesById.get(startId);
	if (current === undefined) {
		throw new SessionError("not_found", `Entry not found: ${startId}`);
	}
  
	// Collect the path from the starting entry toward the root.
	const branch: SessionEntry[] = [];
	// Track visited IDs so a cyclic parent chain cannot loop forever.
	const visited = new Set<string>();
  
	while (true) {
		// Seeing the same ID twice means the branch contains a cycle.
		if (visited.has(current.id)) {
			this.invalid(`branch contains a cycle at ${current.id}`);
		}
  
		// Include the current entry before checking stop conditions; bounds are inclusive.
		visited.add(current.id);
		branch.push(current);
  
		// Stop at the requested ID, requested type, or the root entry.
		if (
			current.id === stopAtId ||
			current.type === stopAtType ||
			current.parentId === null
		) {
			break;
		}
  
		// Move one step upward through the parent chain.
		const parent = this.entriesById.get(current.parentId);
		if (parent === undefined) {
			// A non-root entry must reference an existing parent.
			this.invalid(`entry references missing parent ${current.parentId}`);
		}
  
		current = parent;
	}
  
	// Return the collected branch, ordered from the starting entry to the root.
	return branch;
  }

  /**
   * Applies ordering, filters, cursor pagination, and limit without exposing
   * stored entry references.
   */
  private queryEntries(
	entries: readonly SessionEntry[],
	query: EntryQuery,
	naturalOrder: EntryOrder,
  ): SessionEntry[] {
	const order = query.order ?? "newest_first";
	const ordered =
		order === naturalOrder ? entries : [...entries].reverse();
	const results: SessionEntry[] = [];
  
	for (const entry of ordered) {
		if (query.type !== undefined && entry.type !== query.type) {
			continue;
		}
  
		if (
			query.customType !== undefined &&
			(entry.type !== "custom" ||
				entry.customType !== query.customType)
		) {
			continue;
		}
  
		const afterSeq = query.cursor?.afterSeq;
		if (
			afterSeq !== undefined &&
			(order === "oldest_first"
				? entry.seq <= afterSeq
				: entry.seq >= afterSeq)
		) {
			continue;
		}
  
		results.push(clone(entry));
  
		if (
			query.limit !== undefined &&
			results.length === query.limit
		) {
			break;
		}
	}
  
	return results;
  }

  private validateQuery(query: EntryQuery): void {
	if (
		query.order !== undefined &&
		query.order !== "newest_first" &&
		query.order !== "oldest_first"
	) {
		this.invalidQuery(`unknown order ${String(query.order)}`);
	}
  
	if (
		query.limit !== undefined &&
		(!Number.isSafeInteger(query.limit) || query.limit <= 0)
	) {
		this.invalidQuery("limit must be a positive safe integer");
	}
  
	if (
		query.cursor !== undefined &&
		(!Number.isSafeInteger(query.cursor.afterSeq) ||
			query.cursor.afterSeq < 0)
	) {
		this.invalidQuery(
			"cursor afterSeq must be a non-negative safe integer",
		);
	}
  
	if (
		query.customType !== undefined &&
		query.type !== undefined &&
		query.type !== "custom"
	) {
		this.invalidQuery(
			"customType cannot be combined with a non-custom entry type",
		);
	}
  }
  
  private invalidQuery(message: string): never {
	throw new SessionError("invalid_query", `Invalid entry query: ${message}`);
  }

  
  private validateEntry(entry: SessionEntry): void {
		if (this.entriesById.has(entry.id)) {
			this.invalid(`duplicate entry id ${entry.id}`);
		}

		if (
			entry.parentId !== null &&
			!this.entriesById.has(entry.parentId)
		) {
			this.invalid(`entry references missing parent ${entry.parentId}`);
		}

		/*
		 * Entry mutations always extend main. Creating a branch requires an
		 * explicit pointer mutation before the new entry.
		 */
		if (entry.parentId !== this.leafId) {
			this.invalid(
				`entry parent ${String(entry.parentId)} does not match main leaf ${String(this.leafId)}`,
			);
		}

		if (
			entry.type === "branch_summary" &&
			!this.entriesById.has(entry.sourceLeafId)
		) {
			this.invalid(
				`branch summary references missing source ${entry.sourceLeafId}`,
			);
		}
	}

  private invalid(message: string): never {
		throw new SessionError(
			"invalid_mutation",
			`Invalid session mutation: ${message}`,
		);
	}
}
