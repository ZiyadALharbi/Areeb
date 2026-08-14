import { SessionError } from "./errors.ts";
import type { SessionEntry, SessionMutation } from "./types.ts";

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
