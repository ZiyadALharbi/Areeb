import { SessionError } from "./errors.ts";
import { assertJsonValue, assertUuid, Session } from "./session.ts";
import { SessionState } from "./state.ts";
import type {
	EntryQuery,
	ProvisionedSessionEntry,
	SessionClock,
	SessionCreateOptions,
	SessionEntry,
	SessionHandle,
	SessionIdGenerator,
	SessionListOptions,
	SessionMetadata,
	SessionRepository,
	SessionStorage,
	StorageBranchEntryQuery,
} from "./types.ts";

function readTimestamp(clock: SessionClock): number {
	const timestamp = clock();

	if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
		throw new SessionError(
			"storage",
			"Session clock must return a non-negative safe integer",
		);
	}

	return timestamp;
}

export class MemorySessionStorage implements SessionStorage {
	private readonly metadata: SessionMetadata;
	private readonly state = new SessionState();
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		metadata: SessionMetadata,
		private readonly clock: SessionClock = Date.now,
	) {
		assertJsonValue(metadata, "session metadata");
		assertUuid(metadata.id, "session id");

		if (!Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 0) {
			throw new SessionError(
				"invalid_payload",
				"Session createdAt must be a non-negative safe integer",
			);
		}

		this.metadata = structuredClone(metadata);
	}

	async getMetadata(): Promise<SessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLeafId(): Promise<string | null> {
		return this.state.getLeafId();
	}

	async moveLeaf(id: string | null): Promise<void> {
		assertJsonValue(id, "leafId");

		await this.enqueueWrite(() => {
			this.state.applyMutation({
				kind: "pointer",
				seq: this.state.nextSequence,
				timestamp: readTimestamp(this.clock),
				pointer: "main",
				leafId: id,
			});
		});
	}

	async appendEntry<TEntry extends SessionEntry>(
		entry: ProvisionedSessionEntry<TEntry>,
	): Promise<TEntry> {
		assertJsonValue(entry, "entry");
		assertUuid(entry.id, "entry id");

		return this.enqueueWrite(() => {
			const storedEntry = Object.assign({}, structuredClone(entry), {
				parentId: this.state.getLeafId(),
				seq: this.state.nextSequence,
				timestamp: readTimestamp(this.clock),
			}) as unknown as TEntry;

			this.state.applyMutation({
				kind: "entry",
				entry: storedEntry,
			});

			return structuredClone(storedEntry);
		});
	}

	async getEntry(id: string): Promise<SessionEntry | undefined> {
		return this.state.getEntry(id);
	}

	async getChildren(parentId: string | null): Promise<SessionEntry[]> {
		return this.state.getChildren(parentId);
	}

	async findEntries(query: EntryQuery = {}): Promise<SessionEntry[]> {
		return this.state.findEntries(query);
	}

	async findEntriesOnBranch(
		query: StorageBranchEntryQuery,
	): Promise<SessionEntry[]> {
		return this.state.findEntriesOnBranch(query);
	}

	async getName(): Promise<string | undefined> {
		return this.state.getName();
	}

	async setName(name: string | null): Promise<void> {
		assertJsonValue(name, "name");

		await this.enqueueWrite(() => {
			this.state.applyMutation({
				kind: "fact",
				seq: this.state.nextSequence,
				timestamp: readTimestamp(this.clock),
				fact: "name",
				value: name,
			});
		});
	}

	async getLabel(targetId: string): Promise<string | undefined> {
		return this.state.getLabel(targetId);
	}

	async setLabel(targetId: string, label: string | null): Promise<void> {
		assertJsonValue(targetId, "targetId");
		assertJsonValue(label, "label");

		await this.enqueueWrite(() => {
			this.state.applyMutation({
				kind: "fact",
				seq: this.state.nextSequence,
				timestamp: readTimestamp(this.clock),
				fact: "label",
				targetId,
				value: label,
			});
		});
	}

	private enqueueWrite<T>(operation: () => T | Promise<T>): Promise<T> {
		const result = this.writeQueue.then(operation);

		this.writeQueue = result.then(
			() => undefined,
			() => undefined,
		);

		return result;
	}
}

export interface MemorySessionRepositoryOptions {
	readonly clock?: SessionClock;
	readonly sessionIdGenerator?: SessionIdGenerator;
	readonly entryIdGenerator?: SessionIdGenerator;
}

export class MemorySessionRepository implements SessionRepository {
	private readonly sessions = new Map<string, MemorySessionStorage>();
	private readonly clock: SessionClock;
	private readonly sessionIdGenerator: SessionIdGenerator;
	private readonly entryIdGenerator: SessionIdGenerator;

	constructor(options: MemorySessionRepositoryOptions = {}) {
		this.clock = options.clock ?? Date.now;
		this.sessionIdGenerator =
			options.sessionIdGenerator ?? (() => crypto.randomUUID());
		this.entryIdGenerator =
			options.entryIdGenerator ?? (() => crypto.randomUUID());
	}

	async create(options: SessionCreateOptions): Promise<SessionHandle> {
		assertJsonValue(options, "session create options");

		const id = options.id ?? this.sessionIdGenerator();
		assertUuid(id, "session id");

		if (options.parentSessionId !== undefined) {
			assertUuid(options.parentSessionId, "parent session id");
		}

		if (this.sessions.has(id)) {
			throw new SessionError("already_exists", `Session already exists: ${id}`);
		}

		const metadata: SessionMetadata = {
			id,
			createdAt: readTimestamp(this.clock),
			cwd: options.cwd,
			...(options.parentSessionId === undefined
				? {}
				: { parentSessionId: options.parentSessionId }),
			...(options.metadata === undefined
				? {}
				: { metadata: structuredClone(options.metadata) }),
		};

		const storage = new MemorySessionStorage(metadata, this.clock);
		this.sessions.set(id, storage);

		return new Session(storage, this.entryIdGenerator);
	}

	async open(metadata: SessionMetadata): Promise<SessionHandle> {
		assertJsonValue(metadata, "session metadata");
		assertUuid(metadata.id, "session id");

		const storage = this.sessions.get(metadata.id);
		if (storage === undefined) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}

		return new Session(storage, this.entryIdGenerator);
	}

	async list(options: SessionListOptions = {}): Promise<SessionMetadata[]> {
		assertJsonValue(options, "session list options");

		const metadata = await Promise.all(
			[...this.sessions.values()].map((storage) => storage.getMetadata()),
		);

		return metadata
			.filter(
				(session) => options.cwd === undefined || session.cwd === options.cwd,
			)
			.sort(
				(left, right) =>
					right.createdAt - left.createdAt || left.id.localeCompare(right.id),
			);
	}
}
