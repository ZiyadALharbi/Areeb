import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	open,
	readFile,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { AuthCredential } from "../ai/auth.ts";
import { createAuthAbortError, throwIfAuthAborted } from "../ai/auth.ts";
import { areebPaths } from "./paths.ts";

export const AUTH_STORE_VERSION = 1;

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

const providerIdSchema = z
	.string()
	.regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/);
const apiKeyCredentialSchema = z
	.object({
		type: z.literal("api_key"),
		key: z.string().min(1),
	})
	.strict();
const oauthCredentialSchema = z
	.object({
		type: z.literal("oauth"),
		access: z.string().min(1),
		refresh: z.string().min(1),
		expires: z.number().finite().nonnegative(),
		metadata: z.record(z.string(), z.string()).optional(),
	})
	.strict();
const credentialSchema = z.discriminatedUnion("type", [
	apiKeyCredentialSchema,
	oauthCredentialSchema,
]);
const authDocumentSchema = z
	.object({
		version: z.literal(AUTH_STORE_VERSION),
		credentials: z.record(providerIdSchema, credentialSchema),
	})
	.strict();

interface AuthDocument {
	readonly version: typeof AUTH_STORE_VERSION;
	readonly credentials: Readonly<Record<string, AuthCredential>>;
}

export interface StoredCredentialSummary {
	readonly provider: string;
	readonly type: AuthCredential["type"];
	readonly expires?: number;
}

export type CredentialMutation = AuthCredential | null | undefined;

export interface CredentialStore {
	read(provider: string): Promise<AuthCredential | undefined>;
	list(): Promise<readonly StoredCredentialSummary[]>;
	modify(
		provider: string,
		update: (
			current: AuthCredential | undefined,
		) => CredentialMutation | Promise<CredentialMutation>,
		signal?: AbortSignal,
	): Promise<AuthCredential | undefined>;
	delete(provider: string, signal?: AbortSignal): Promise<boolean>;
}

export interface FileCredentialStoreOptions {
	readonly userRoot?: string;
	readonly path?: string;
}

export class AuthStoreError extends Error {
	constructor(
		message: string,
		readonly filePath: string,
		options?: ErrorOptions,
	) {
		super(`${filePath}: ${message}`, options);
		this.name = "AuthStoreError";
	}
}

export class FileCredentialStore implements CredentialStore {
	readonly path: string;

	constructor(options: FileCredentialStoreOptions = {}) {
		this.path =
			options.path ??
			areebPaths({
				...(options.userRoot === undefined
					? {}
					: { userRoot: options.userRoot }),
			}).userAuth;
	}

	async read(provider: string): Promise<AuthCredential | undefined> {
		assertProviderId(provider);
		return cloneCredential(
			(await readDocument(this.path)).credentials[provider],
		);
	}

	async list(): Promise<readonly StoredCredentialSummary[]> {
		const document = await readDocument(this.path);
		return Object.freeze(
			Object.keys(document.credentials)
				.sort()
				.map((provider) => {
					const credential = document.credentials[provider];
					if (credential === undefined) {
						throw new AuthStoreError(
							`credential disappeared while listing provider "${provider}"`,
							this.path,
						);
					}
					return Object.freeze({
						provider,
						type: credential.type,
						...(credential.type === "oauth"
							? { expires: credential.expires }
							: {}),
					});
				}),
		);
	}

	async modify(
		provider: string,
		update: (
			current: AuthCredential | undefined,
		) => CredentialMutation | Promise<CredentialMutation>,
		signal?: AbortSignal,
	): Promise<AuthCredential | undefined> {
		assertProviderId(provider);
		throwIfAuthAborted(signal);

		return withAuthLock(this.path, signal, async () => {
			const currentDocument = await readDocument(this.path);
			const current = cloneCredential(currentDocument.credentials[provider]);
			throwIfAuthAborted(signal);
			const mutation = await update(current);
			throwIfAuthAborted(signal);
			if (mutation === undefined) {
				return current;
			}

			const credentials: Record<string, AuthCredential> = Object.create(null);
			for (const [id, credential] of Object.entries(
				currentDocument.credentials,
			)) {
				credentials[id] = cloneCredential(credential) as AuthCredential;
			}
			if (mutation === null) {
				delete credentials[provider];
			} else {
				credentials[provider] = validateCredential(mutation, this.path);
			}

			await writeDocument(this.path, {
				version: AUTH_STORE_VERSION,
				credentials,
			});
			return mutation === null ? undefined : cloneCredential(mutation);
		});
	}

	async delete(provider: string, signal?: AbortSignal): Promise<boolean> {
		let deleted = false;
		await this.modify(
			provider,
			(current) => {
				deleted = current !== undefined;
				return current === undefined ? undefined : null;
			},
			signal,
		);
		return deleted;
	}
}

export class MemoryCredentialStore implements CredentialStore {
	private credentials: Record<string, AuthCredential> = Object.create(null);
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(initial: Readonly<Record<string, AuthCredential>> = {}) {
		for (const [provider, credential] of Object.entries(initial)) {
			assertProviderId(provider);
			this.credentials[provider] = validateCredential(
				credential,
				"<memory-auth-store>",
			);
		}
	}

	read(provider: string): Promise<AuthCredential | undefined> {
		assertProviderId(provider);
		return Promise.resolve(cloneCredential(this.credentials[provider]));
	}

	list(): Promise<readonly StoredCredentialSummary[]> {
		return Promise.resolve(
			Object.freeze(
				Object.keys(this.credentials)
					.sort()
					.map((provider) => {
						const credential = this.credentials[provider] as AuthCredential;
						return Object.freeze({
							provider,
							type: credential.type,
							...(credential.type === "oauth"
								? { expires: credential.expires }
								: {}),
						});
					}),
			),
		);
	}

	modify(
		provider: string,
		update: (
			current: AuthCredential | undefined,
		) => CredentialMutation | Promise<CredentialMutation>,
		signal?: AbortSignal,
	): Promise<AuthCredential | undefined> {
		assertProviderId(provider);
		const previous = this.mutationQueue;
		let release!: () => void;
		this.mutationQueue = new Promise<void>((resolve) => {
			release = resolve;
		});

		return previous.then(async () => {
			try {
				throwIfAuthAborted(signal);
				const current = cloneCredential(this.credentials[provider]);
				const mutation = await update(current);
				throwIfAuthAborted(signal);
				if (mutation === undefined) {
					return current;
				}
				if (mutation === null) {
					delete this.credentials[provider];
					return undefined;
				}
				const credential = validateCredential(mutation, "<memory-auth-store>");
				this.credentials[provider] = credential;
				return cloneCredential(credential);
			} finally {
				release();
			}
		});
	}

	async delete(provider: string, signal?: AbortSignal): Promise<boolean> {
		let deleted = false;
		await this.modify(
			provider,
			(current) => {
				deleted = current !== undefined;
				return current === undefined ? undefined : null;
			},
			signal,
		);
		return deleted;
	}
}

async function readDocument(path: string): Promise<AuthDocument> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return { version: AUTH_STORE_VERSION, credentials: Object.freeze({}) };
		}
		throw new AuthStoreError("failed to read auth file", path, {
			cause: error,
		});
	}

	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new AuthStoreError("invalid JSON", path, { cause: error });
	}
	const result = authDocumentSchema.safeParse(value);
	if (!result.success) {
		const issue = result.error.issues[0];
		throw new AuthStoreError(
			`invalid credential document${issue === undefined ? "" : ` at ${formatPath(issue.path)}: ${issue.message}`}`,
			path,
		);
	}
	const credentials: Record<string, AuthCredential> = Object.create(null);
	for (const [provider, credential] of Object.entries(
		result.data.credentials,
	)) {
		if (credential !== undefined) {
			credentials[provider] = cloneCredential(credential) as AuthCredential;
		}
	}
	return {
		version: AUTH_STORE_VERSION,
		credentials: Object.freeze(credentials),
	};
}

function validateCredential(
	credential: AuthCredential,
	path: string,
): AuthCredential {
	const result = credentialSchema.safeParse(credential);
	if (!result.success) {
		const issue = result.error.issues[0];
		throw new AuthStoreError(
			`invalid credential${issue === undefined ? "" : ` at ${formatPath(issue.path)}: ${issue.message}`}`,
			path,
		);
	}
	return cloneCredential(result.data) as AuthCredential;
}

function cloneCredential(
	credential: AuthCredential | undefined,
): AuthCredential | undefined {
	if (credential === undefined) {
		return undefined;
	}
	return credential.type === "api_key"
		? Object.freeze({ type: "api_key", key: credential.key })
		: Object.freeze({
				type: "oauth",
				access: credential.access,
				refresh: credential.refresh,
				expires: credential.expires,
				...(credential.metadata === undefined
					? {}
					: { metadata: Object.freeze({ ...credential.metadata }) }),
			});
}

async function writeDocument(
	path: string,
	document: AuthDocument,
): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let temporaryCreated = false;
	try {
		const file = await open(temporaryPath, "wx", 0o600);
		temporaryCreated = true;
		try {
			await file.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporaryPath, path);
		temporaryCreated = false;
		await chmod(path, 0o600);
	} finally {
		if (temporaryCreated) {
			await unlink(temporaryPath).catch(() => undefined);
		}
	}
}

async function withAuthLock<T>(
	path: string,
	signal: AbortSignal | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const lockPath = `${path}.lock`;
	const startedAt = Date.now();
	let lock: Awaited<ReturnType<typeof open>> | undefined;

	while (lock === undefined) {
		throwIfAuthAborted(signal);
		try {
			lock = await open(lockPath, "wx", 0o600);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				throw error;
			}
			try {
				const metadata = await stat(lockPath);
				if (Date.now() - metadata.mtimeMs > STALE_LOCK_MS) {
					await unlink(lockPath);
					continue;
				}
			} catch (metadataError) {
				if (errorCode(metadataError) === "ENOENT") {
					continue;
				}
				throw metadataError;
			}
			if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
				throw new AuthStoreError("timed out waiting for auth lock", path);
			}
			await abortableDelay(LOCK_RETRY_DELAY_MS, signal);
		}
	}

	try {
		return await operation();
	} finally {
		await lock.close();
		await unlink(lockPath).catch((error) => {
			if (errorCode(error) !== "ENOENT") {
				throw error;
			}
		});
	}
}

function abortableDelay(
	milliseconds: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(createAuthAbortError());
	}
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		const onAbort = (): void => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(createAuthAbortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function assertProviderId(provider: string): void {
	if (!providerIdSchema.safeParse(provider).success) {
		throw new Error(`Invalid provider ID: ${provider}`);
	}
}

function formatPath(path: readonly PropertyKey[]): string {
	let formatted = "$";
	for (const part of path) {
		formatted += typeof part === "number" ? `[${part}]` : `.${String(part)}`;
	}
	return formatted;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}
	const code = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}
