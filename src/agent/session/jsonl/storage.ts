import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { SessionError } from "../errors.ts";
import { assertJsonValue, assertUuid } from "../session.ts";
import { SessionState } from "../state.ts";
import type {
	EntryQuery,
	ProvisionedSessionEntry,
	SessionClock,
	SessionEntry,
	SessionMetadata,
	SessionMutation,
	SessionStorage,
	StorageBranchEntryQuery,
} from "../types.ts";
import {
	createSessionJsonlHeader,
	decodeSessionJsonlHeader,
	decodeSessionJsonlMutation,
	encodeSessionJsonlRecord,
	metadataFromSessionJsonlHeader,
} from "./codec.ts";
import type { JsonlSessionMetadata } from "./types.ts";

export type SessionJsonlAppend = (path: string, line: string) => Promise<void>;

export interface JsonlSessionStorageOptions {
	readonly clock?: SessionClock;
	readonly appendLine?: SessionJsonlAppend;
}

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

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}

	const code = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}

async function appendLineDurably(path: string, line: string): Promise<void> {
	const handle = await open(path, "a");
	let failure: unknown;

	try {
		await handle.writeFile(line, "utf8");
		await handle.sync();
	} catch (error) {
		failure = error;
	}

	try {
		await handle.close();
	} catch (error) {
		failure ??= error;
	}

	if (failure !== undefined) {
		throw failure;
	}
}

async function truncateDurably(path: string, length: number): Promise<void> {
	const handle = await open(path, "r+");
	let failure: unknown;

	try {
		await handle.truncate(length);
		await handle.sync();
	} catch (error) {
		failure = error;
	}

	try {
		await handle.close();
	} catch (error) {
		failure ??= error;
	}

	if (failure !== undefined) {
		throw failure;
	}
}

async function createSessionFile(
	path: string,
	metadata: SessionMetadata,
): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
	} catch (error) {
		throw new SessionError(
			"storage",
			`Failed to create session directory: ${dirname(path)}`,
			{ cause: error, path },
		);
	}

	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "wx");
	} catch (error) {
		if (errorCode(error) === "EEXIST") {
			throw new SessionError(
				"already_exists",
				`Session file already exists: ${path}`,
				{ cause: error, path },
			);
		}

		throw new SessionError(
			"storage",
			`Failed to create session file: ${path}`,
			{
				cause: error,
				path,
			},
		);
	}

	let failure: unknown;
	try {
		await handle.writeFile(
			encodeSessionJsonlRecord(createSessionJsonlHeader(metadata)),
			"utf8",
		);
		await handle.sync();
	} catch (error) {
		failure = error;
	}

	try {
		await handle.close();
	} catch (error) {
		failure ??= error;
	}

	if (failure !== undefined) {
		try {
			await unlink(path);
		} catch {
			// The original create failure is more useful to the caller.
		}

		throw new SessionError(
			"storage",
			`Failed to create session file: ${path}`,
			{
				cause: failure,
				path,
			},
		);
	}
}

async function repairTornTail(
	path: string,
	offset: number,
	line: number,
): Promise<void> {
	try {
		await truncateDurably(path, offset);
	} catch (error) {
		throw new SessionError(
			"storage",
			`Failed to repair torn session tail: ${path}`,
			{ path, line, cause: error },
		);
	}
}

async function replaySessionFile(path: string): Promise<{
	metadata: JsonlSessionMetadata;
	state: SessionState;
}> {
	let contents: Buffer;

	try {
		contents = await readFile(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			throw new SessionError("not_found", `Session file not found: ${path}`, {
				cause: error,
				path,
			});
		}

		throw new SessionError("storage", `Failed to read session file: ${path}`, {
			cause: error,
			path,
		});
	}

	if (contents.length === 0) {
		throw new SessionError("invalid_format", "Session file is empty", {
			path,
			line: 1,
		});
	}

	const state = new SessionState();
	let metadata: SessionMetadata | undefined;
	let offset = 0;
	let lineNumber = 1;

	while (offset < contents.length) {
		const newlineOffset = contents.indexOf(0x0a, offset);
		const hasNewline = newlineOffset !== -1;
		const lineEnd = hasNewline ? newlineOffset : contents.length;
		const location = { path, line: lineNumber };
		let line: string;

		try {
			line = new TextDecoder("utf-8", { fatal: true }).decode(
				contents.subarray(offset, lineEnd),
			);
		} catch (error) {
			if (!hasNewline && metadata !== undefined) {
				await repairTornTail(path, offset, lineNumber);
				break;
			}

			throw new SessionError(
				"invalid_format",
				"Session JSONL line is not valid UTF-8",
				{ ...location, cause: error },
			);
		}

		if (!hasNewline) {
			try {
				JSON.parse(line);
			} catch {
				if (metadata === undefined) {
					throw new SessionError(
						"invalid_format",
						"Session header is torn or malformed",
						location,
					);
				}

				await repairTornTail(path, offset, lineNumber);
				break;
			}
		}

		if (metadata === undefined) {
			const header = decodeSessionJsonlHeader(line, location);
			metadata = metadataFromSessionJsonlHeader(header);
		} else {
			const mutation = decodeSessionJsonlMutation(line, location);

			try {
				state.applyMutation(mutation);
			} catch (error) {
				throw new SessionError(
					"invalid_format",
					`Invalid session replay mutation at line ${lineNumber}`,
					{ ...location, cause: error },
				);
			}
		}

		if (!hasNewline) {
			try {
				await appendLineDurably(path, "\n");
			} catch (error) {
				throw new SessionError(
					"storage",
					`Failed to repair session newline: ${path}`,
					{ ...location, cause: error },
				);
			}
			break;
		}

		offset = lineEnd + 1;
		lineNumber += 1;
	}

	if (metadata === undefined) {
		throw new SessionError("invalid_format", "Session header is missing", {
			path,
			line: 1,
		});
	}

	return {
		metadata: { ...metadata, path },
		state,
	};
}

export class JsonlSessionStorage
	implements SessionStorage<JsonlSessionMetadata>
{
	private writeQueue: Promise<void> = Promise.resolve();
	private poisoned = false;

	private constructor(
		private readonly metadata: JsonlSessionMetadata,
		private readonly state: SessionState,
		private readonly clock: SessionClock,
		private readonly appendLine: SessionJsonlAppend,
	) {}

	static async create(
		path: string,
		metadata: SessionMetadata,
		options: JsonlSessionStorageOptions = {},
	): Promise<JsonlSessionStorage> {
		assertJsonValue(metadata, "session metadata");
		assertUuid(metadata.id, "session id");
		await createSessionFile(path, metadata);

		return new JsonlSessionStorage(
			{ ...(structuredClone(metadata) as SessionMetadata), path },
			new SessionState(),
			options.clock ?? Date.now,
			options.appendLine ?? appendLineDurably,
		);
	}

	static async open(
		path: string,
		options: JsonlSessionStorageOptions = {},
	): Promise<JsonlSessionStorage> {
		const { metadata, state } = await replaySessionFile(path);

		return new JsonlSessionStorage(
			metadata,
			state,
			options.clock ?? Date.now,
			options.appendLine ?? appendLineDurably,
		);
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLeafId(): Promise<string | null> {
		return this.state.getLeafId();
	}

	async moveLeaf(id: string | null): Promise<void> {
		assertJsonValue(id, "leafId");

		await this.persistMutation(() => ({
			kind: "pointer",
			seq: this.state.nextSequence,
			timestamp: readTimestamp(this.clock),
			pointer: "main",
			leafId: id,
		}));
	}

	async appendEntry<TEntry extends SessionEntry>(
		entry: ProvisionedSessionEntry<TEntry>,
	): Promise<TEntry> {
		assertJsonValue(entry, "entry");
		assertUuid(entry.id, "entry id");

		return this.persistMutation(() => {
			const storedEntry = Object.assign({}, structuredClone(entry), {
				parentId: this.state.getLeafId(),
				seq: this.state.nextSequence,
				timestamp: readTimestamp(this.clock),
			}) as unknown as TEntry;
			const mutation: SessionMutation = {
				kind: "entry",
				entry: storedEntry,
			};

			return {
				mutation,
				result: structuredClone(storedEntry),
			};
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

		await this.persistMutation(() => ({
			kind: "fact",
			seq: this.state.nextSequence,
			timestamp: readTimestamp(this.clock),
			fact: "name",
			value: name,
		}));
	}

	async getLabel(targetId: string): Promise<string | undefined> {
		return this.state.getLabel(targetId);
	}

	async setLabel(targetId: string, label: string | null): Promise<void> {
		assertJsonValue(targetId, "targetId");
		assertJsonValue(label, "label");

		await this.persistMutation(() => ({
			kind: "fact",
			seq: this.state.nextSequence,
			timestamp: readTimestamp(this.clock),
			fact: "label",
			targetId,
			value: label,
		}));
	}

	private persistMutation(createMutation: () => SessionMutation): Promise<void>;
	private persistMutation<T>(
		createMutation: () => {
			mutation: SessionMutation;
			result: T;
		},
	): Promise<T>;
	private persistMutation<T>(
		createMutation: () =>
			| SessionMutation
			| { mutation: SessionMutation; result: T },
	): Promise<T | undefined> {
		return this.enqueueWrite(async () => {
			if (this.poisoned) {
				throw new SessionError(
					"storage",
					"Session storage must be reopened after a failed write",
					{ path: this.metadata.path },
				);
			}

			const created = createMutation();
			const mutation = "mutation" in created ? created.mutation : created;
			this.state.validateMutation(mutation);
			const line = encodeSessionJsonlRecord(mutation);

			try {
				await this.appendLine(this.metadata.path, line);
			} catch (error) {
				this.poisoned = true;
				throw new SessionError(
					"storage",
					`Failed to append session mutation: ${this.metadata.path}`,
					{ cause: error, path: this.metadata.path },
				);
			}

			try {
				this.state.applyMutation(mutation);
			} catch (error) {
				this.poisoned = true;
				throw new SessionError(
					"storage",
					"Persisted session mutation could not be applied",
					{ cause: error, path: this.metadata.path },
				);
			}

			return "mutation" in created ? created.result : undefined;
		});
	}

	private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.writeQueue.then(operation);
		this.writeQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
