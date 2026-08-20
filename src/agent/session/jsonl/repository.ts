import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionError } from "../errors.ts";
import { assertJsonValue, assertUuid, Session } from "../session.ts";
import type {
	SessionClock,
	SessionCreateOptions,
	SessionHandle,
	SessionIdGenerator,
	SessionListOptions,
	SessionMetadata,
	SessionRepository,
} from "../types.ts";
import { JsonlSessionStorage, type SessionJsonlAppend } from "./storage.ts";
import type { JsonlSessionMetadata } from "./types.ts";

const SESSION_FILE_EXTENSION = ".jsonl";

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

export interface JsonlSessionRepositoryOptions {
	readonly clock?: SessionClock;
	readonly sessionIdGenerator?: SessionIdGenerator;
	readonly entryIdGenerator?: SessionIdGenerator;
	readonly appendLine?: SessionJsonlAppend;
}

export class JsonlSessionRepository
	implements
		SessionRepository<
			JsonlSessionMetadata,
			SessionCreateOptions,
			SessionListOptions
		>
{
	private readonly directory: string;
	private readonly clock: SessionClock;
	private readonly sessionIdGenerator: SessionIdGenerator;
	private readonly entryIdGenerator: SessionIdGenerator;
	private readonly appendLine: SessionJsonlAppend | undefined;
	private readonly storages = new Map<string, Promise<JsonlSessionStorage>>();

	constructor(directory: string, options: JsonlSessionRepositoryOptions = {}) {
		this.directory = resolve(directory);
		this.clock = options.clock ?? Date.now;
		this.sessionIdGenerator =
			options.sessionIdGenerator ?? (() => crypto.randomUUID());
		this.entryIdGenerator =
			options.entryIdGenerator ?? (() => crypto.randomUUID());
		this.appendLine = options.appendLine;
	}

	async create(
		options: SessionCreateOptions,
	): Promise<SessionHandle<JsonlSessionMetadata>> {
		assertJsonValue(options, "session create options");

		const id = options.id ?? this.sessionIdGenerator();
		assertUuid(id, "session id");

		if (options.parentSessionId !== undefined) {
			assertUuid(options.parentSessionId, "parent session id");
		}

		if (this.storages.has(id)) {
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
		const path = this.pathForId(id);
		const storagePromise = JsonlSessionStorage.create(path, metadata, {
			clock: this.clock,
			...(this.appendLine === undefined ? {} : { appendLine: this.appendLine }),
		});

		this.storages.set(id, storagePromise);

		try {
			const storage = await storagePromise;
			return new Session(storage, this.entryIdGenerator);
		} catch (error) {
			if (this.storages.get(id) === storagePromise) {
				this.storages.delete(id);
			}
			throw error;
		}
	}

	async find(id: string): Promise<JsonlSessionMetadata | undefined> {
		assertUuid(id, "session id");

		try {
			const storage = await this.getStorage(id);
			return storage.getMetadata();
		} catch (error) {
			if (errorCode(error) === "not_found") {
				return undefined;
			}

			throw error;
		}
	}

	async open(
		metadata: JsonlSessionMetadata,
	): Promise<SessionHandle<JsonlSessionMetadata>> {
		assertJsonValue(metadata, "session metadata");
		assertUuid(metadata.id, "session id");

		const expectedPath = this.pathForId(metadata.id);
		if (resolve(metadata.path) !== expectedPath) {
			throw new SessionError(
				"invalid_payload",
				`Session path does not belong to this repository: ${metadata.path}`,
			);
		}

		const storage = await this.getStorage(metadata.id);
		return new Session(storage, this.entryIdGenerator);
	}

	async list(
		options: SessionListOptions = {},
	): Promise<JsonlSessionMetadata[]> {
		assertJsonValue(options, "session list options");

		let filenames: string[];
		try {
			const entries = await readdir(this.directory, {
				withFileTypes: true,
			});
			filenames = entries
				.filter(
					(entry) =>
						entry.isFile() && entry.name.endsWith(SESSION_FILE_EXTENSION),
				)
				.map((entry) => entry.name);
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				return [];
			}

			throw new SessionError(
				"storage",
				`Failed to list session directory: ${this.directory}`,
				{ cause: error, path: this.directory },
			);
		}

		const metadata = await Promise.all(
			filenames.map(async (filename) => {
				const id = filename.slice(0, -SESSION_FILE_EXTENSION.length);
				try {
					assertUuid(id, "session filename");
				} catch (error) {
					throw new SessionError(
						"invalid_format",
						`Invalid session filename: ${filename}`,
						{
							cause: error,
							path: join(this.directory, filename),
						},
					);
				}

				const storage = await this.getStorage(id);
				return storage.getMetadata();
			}),
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

	private pathForId(id: string): string {
		return join(this.directory, `${id}${SESSION_FILE_EXTENSION}`);
	}

	private async getStorage(id: string): Promise<JsonlSessionStorage> {
		const existing = this.storages.get(id);
		if (existing !== undefined) {
			return existing;
		}

		const path = this.pathForId(id);
		const storagePromise = (async () => {
			const storage = await JsonlSessionStorage.open(path, {
				clock: this.clock,
				...(this.appendLine === undefined
					? {}
					: { appendLine: this.appendLine }),
			});
			const metadata = await storage.getMetadata();

			if (metadata.id !== id) {
				throw new SessionError(
					"invalid_format",
					`Session header ID does not match filename: ${path}`,
					{ path, line: 1 },
				);
			}

			return storage;
		})();

		this.storages.set(id, storagePromise);

		try {
			return await storagePromise;
		} catch (error) {
			if (this.storages.get(id) === storagePromise) {
				this.storages.delete(id);
			}
			throw error;
		}
	}
}
