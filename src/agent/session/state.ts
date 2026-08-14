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

  
}