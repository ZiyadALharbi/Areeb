import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { SessionError } from "../agent/session/errors.ts";
import {
	JsonlSessionRepository,
	type JsonlSessionRepositoryOptions,
} from "../agent/session/jsonl/repository.ts";
import type { JsonlSessionMetadata } from "../agent/session/jsonl/types.ts";
import { assertUuid } from "../agent/session/session.ts";
import type {
	SessionEntry,
	SessionHandle,
	SessionModel,
} from "../agent/session/types.ts";
import { areebPaths } from "./paths.ts";

const PROJECT_DIRECTORY_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_DISCOVERY_CONCURRENCY = 8;

export interface CodingSessionRecord {
	readonly id: string;
	readonly path: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly title: string;
	readonly model: SessionModel | null;
}

export interface CodingSessionManagerOptions {
	readonly cwd?: string;
	readonly userRoot?: string;
	readonly maxConcurrency?: number;
	readonly repositoryOptions?: JsonlSessionRepositoryOptions;
}

export interface CodingSessionDiscoveryOptions {
	readonly userRoot?: string;
	readonly maxConcurrency?: number;
	readonly repositoryOptions?: JsonlSessionRepositoryOptions;
}

export class CodingSessionManager {
	readonly cwd: string;
	private readonly maxConcurrency: number;
	private readonly repositoryOptions: JsonlSessionRepositoryOptions;
	private readonly repository: JsonlSessionRepository;

	constructor(options: CodingSessionManagerOptions = {}) {
		const paths = areebPaths({
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			...(options.userRoot === undefined ? {} : { userRoot: options.userRoot }),
		});

		this.cwd = resolve(options.cwd ?? process.cwd());
		this.maxConcurrency = validateConcurrency(options.maxConcurrency);
		this.repositoryOptions = options.repositoryOptions ?? {};
		this.repository = new JsonlSessionRepository(
			paths.projectSessions,
			this.repositoryOptions,
		);
	}

	create(): Promise<SessionHandle<JsonlSessionMetadata>> {
		return this.repository.create({ cwd: this.cwd });
	}

	async find(id: string): Promise<CodingSessionRecord | undefined> {
		const metadata = await this.repository.find(id);
		if (metadata === undefined) {
			return undefined;
		}

		this.assertProjectOwnership(metadata);
		return deriveRecord(this.repository, metadata);
	}

	async open(id: string): Promise<SessionHandle<JsonlSessionMetadata>> {
		const metadata = await this.repository.find(id);
		if (metadata === undefined) {
			throw new SessionError("not_found", `Session not found: ${id}`);
		}

		this.assertProjectOwnership(metadata);
		return this.repository.open(metadata);
	}

	async list(): Promise<CodingSessionRecord[]> {
		const metadata = await this.repository.list();
		for (const session of metadata) {
			this.assertProjectOwnership(session);
		}

		const records = await mapConcurrent(
			metadata,
			this.maxConcurrency,
			(session) => deriveRecord(this.repository, session),
		);
		return records.sort(compareRecords);
	}

	private assertProjectOwnership(metadata: JsonlSessionMetadata): void {
		if (resolve(metadata.cwd) === this.cwd) {
			return;
		}

		throw new SessionError(
			"invalid_format",
			`Session cwd does not match its project directory: ${metadata.path}`,
			{ path: metadata.path, line: 1 },
		);
	}
}

export async function listCodingSessions(
	options: CodingSessionDiscoveryOptions = {},
): Promise<CodingSessionRecord[]> {
	const discovery = createDiscovery(options);
	const directories = await listProjectDirectories(discovery.userSessions);
	const discovered = await mapConcurrent(
		directories,
		discovery.maxConcurrency,
		async (directory) => {
			const repository = new JsonlSessionRepository(
				directory,
				discovery.repositoryOptions,
			);
			const metadata = await repository.list();
			for (const session of metadata) {
				assertDiscoveredOwnership(session, directory, discovery.userRoot);
			}
			return metadata.map((session) => ({ repository, metadata: session }));
		},
	);
	const sessions = discovered.flat();
	const records = await mapConcurrent(
		sessions,
		discovery.maxConcurrency,
		({ repository, metadata }) => deriveRecord(repository, metadata),
	);

	return records.sort(compareRecords);
}

export async function findCodingSession(
	id: string,
	options: CodingSessionDiscoveryOptions = {},
): Promise<CodingSessionRecord | undefined> {
	assertUuid(id, "session id");
	const discovery = createDiscovery(options);
	const directories = await listProjectDirectories(discovery.userSessions);
	const matches = (
		await mapConcurrent(
			directories,
			discovery.maxConcurrency,
			async (directory) => {
				const repository = new JsonlSessionRepository(
					directory,
					discovery.repositoryOptions,
				);
				const metadata = await repository.find(id);
				if (metadata === undefined) {
					return undefined;
				}

				assertDiscoveredOwnership(metadata, directory, discovery.userRoot);
				return { repository, metadata };
			},
		)
	).filter(
		(
			match,
		): match is {
			readonly repository: JsonlSessionRepository;
			readonly metadata: JsonlSessionMetadata;
		} => match !== undefined,
	);

	if (matches.length === 0) {
		return undefined;
	}
	if (matches.length > 1) {
		throw new SessionError(
			"invalid_format",
			`Session ID exists in multiple project directories: ${id}`,
		);
	}

	const match = matches[0];
	if (match === undefined) {
		return undefined;
	}
	return deriveRecord(match.repository, match.metadata);
}

interface DiscoveryContext {
	readonly userRoot: string;
	readonly userSessions: string;
	readonly maxConcurrency: number;
	readonly repositoryOptions: JsonlSessionRepositoryOptions;
}

function createDiscovery(
	options: CodingSessionDiscoveryOptions,
): DiscoveryContext {
	const paths = areebPaths({
		...(options.userRoot === undefined ? {} : { userRoot: options.userRoot }),
	});
	return {
		userRoot: paths.userRoot,
		userSessions: paths.userSessions,
		maxConcurrency: validateConcurrency(options.maxConcurrency),
		repositoryOptions: options.repositoryOptions ?? {},
	};
}

async function listProjectDirectories(userSessions: string): Promise<string[]> {
	try {
		return (await readdir(userSessions, { withFileTypes: true }))
			.filter(
				(entry) =>
					entry.isDirectory() && PROJECT_DIRECTORY_PATTERN.test(entry.name),
			)
			.map((entry) => resolve(userSessions, entry.name))
			.sort();
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return [];
		}

		throw new SessionError(
			"storage",
			`Failed to list session directory: ${userSessions}`,
			{ cause: error, path: userSessions },
		);
	}
}

function assertDiscoveredOwnership(
	metadata: JsonlSessionMetadata,
	directory: string,
	userRoot: string,
): void {
	const expectedDirectory = areebPaths({
		cwd: metadata.cwd,
		userRoot,
	}).projectSessions;
	if (expectedDirectory === directory) {
		return;
	}

	throw new SessionError(
		"invalid_format",
		`Session cwd does not match its project directory: ${metadata.path}`,
		{ path: metadata.path, line: 1 },
	);
}

async function deriveRecord(
	repository: JsonlSessionRepository,
	metadata: JsonlSessionMetadata,
): Promise<CodingSessionRecord> {
	const session = await repository.open(metadata);
	const [name, entries, context] = await Promise.all([
		session.getName(),
		session.findEntries({ type: "message", order: "oldest_first" }),
		session.buildContext(),
	]);
	const explicitTitle = name?.trim();

	return {
		id: metadata.id,
		path: metadata.path,
		cwd: metadata.cwd,
		createdAt: metadata.createdAt,
		updatedAt: latestConversationTimestamp(entries) ?? metadata.createdAt,
		title: explicitTitle || firstUserText(entries) || "(no messages)",
		model: context.model === null ? null : { ...context.model },
	};
}

function latestConversationTimestamp(
	entries: readonly SessionEntry[],
): number | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (
			entry?.type === "message" &&
			(entry.message.role === "user" || entry.message.role === "assistant")
		) {
			return entry.timestamp;
		}
	}
	return undefined;
}

function firstUserText(entries: readonly SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") {
			continue;
		}

		const text = entry.message.content
			.flatMap((content) => (content.type === "text" ? [content.text] : []))
			.join(" ")
			.trim();
		if (text.length > 0) {
			return text;
		}
	}
	return undefined;
}

function compareRecords(
	left: CodingSessionRecord,
	right: CodingSessionRecord,
): number {
	return (
		right.updatedAt - left.updatedAt ||
		right.createdAt - left.createdAt ||
		left.id.localeCompare(right.id)
	);
}

function validateConcurrency(value: number | undefined): number {
	const concurrency = value ?? DEFAULT_DISCOVERY_CONCURRENCY;
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
		throw new SessionError(
			"invalid_payload",
			"Session discovery concurrency must be a positive safe integer",
		);
	}
	return concurrency;
}

async function mapConcurrent<T, TResult>(
	values: readonly T[],
	concurrency: number,
	map: (value: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
	const results = new Array<TResult>(values.length);
	let nextIndex = 0;
	const workers = Array.from(
		{ length: Math.min(concurrency, values.length) },
		async () => {
			while (nextIndex < values.length) {
				const index = nextIndex;
				nextIndex += 1;
				results[index] = await map(values[index] as T, index);
			}
		},
	);

	await Promise.all(workers);
	return results;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}

	const code = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}
