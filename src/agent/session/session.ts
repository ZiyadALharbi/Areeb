import type { AgentMessage } from "../types.ts";
import { buildSessionContext } from "./context.ts";
import { SessionError } from "./errors.ts";
import type {
	BranchEntryQuery,
	EntryQuery,
	JsonValue,
	NewSessionEntry,
	ProvisionedSessionEntry,
	SessionContext,
	SessionContextBuildOptions,
	SessionEntry,
	SessionHandle,
	SessionIdGenerator,
	SessionMetadata,
	SessionStorage,
} from "./types.ts";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(
	value: unknown,
	field = "id",
): asserts value is string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		throw new SessionError("invalid_payload", `${field} must be a full UUID`);
	}
}

export function assertJsonValue(
	value: unknown,
	field = "value",
): asserts value is JsonValue {
	const ancestors = new WeakSet<object>();

	const invalid = (path: string, reason: string): never => {
		throw new SessionError(
			"invalid_payload",
			`Invalid JSON value at ${path}: ${reason}`,
		);
	};

	const visit = (current: unknown, path: string): void => {
		if (
			current === null ||
			typeof current === "boolean" ||
			typeof current === "string"
		) {
			return;
		}

		if (typeof current === "number") {
			if (!Number.isFinite(current)) {
				invalid(path, "numbers must be finite");
				return;
			}
			return;
		}

		if (typeof current !== "object" || current === null) {
			invalid(path, `${typeof current} is not valid JSON`);
			return;
		}

		if (ancestors.has(current)) {
			invalid(path, "cycles are not valid JSON");
			return;
		}

		ancestors.add(current);

		try {
			if (Array.isArray(current)) {
				for (const key of Reflect.ownKeys(current)) {
					if (typeof key === "symbol") {
						invalid(path, "symbol properties are not valid JSON");
						return;
					}

					if (key === "length") {
						continue;
					}

					const index = Number(key);
					if (
						!Number.isSafeInteger(index) ||
						index < 0 ||
						String(index) !== key ||
						index >= current.length
					) {
						invalid(path, `unexpected array property ${String(key)}`);
						return;
					}
				}

				for (let index = 0; index < current.length; index += 1) {
					const propertyPath = `${path}[${index}]`;

					if (!Object.hasOwn(current, index)) {
						invalid(propertyPath, "sparse arrays are not valid JSON");
						return;
					}

					const descriptor = Object.getOwnPropertyDescriptor(
						current,
						String(index),
					);

					if (descriptor === undefined || !("value" in descriptor)) {
						invalid(propertyPath, "accessors are not valid JSON");
						return;
					}

					if (!descriptor.enumerable) {
						invalid(propertyPath, "non-enumerable values are not valid JSON");
						return;
					}

					visit(descriptor.value, propertyPath);
				}

				return;
			}

			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) {
				invalid(path, "objects must be plain objects");
				return;
			}

			for (const key of Reflect.ownKeys(current)) {
				if (typeof key === "symbol") {
					invalid(path, "symbol properties are not valid JSON");
					return;
				}

				const propertyPath = `${path}[${JSON.stringify(key)}]`;
				const descriptor = Object.getOwnPropertyDescriptor(current, key);

				if (descriptor === undefined || !("value" in descriptor)) {
					invalid(propertyPath, "accessors are not valid JSON");
					return;
				}

				if (!descriptor.enumerable) {
					invalid(propertyPath, "non-enumerable values are not valid JSON");
					return;
				}

				visit(descriptor.value, propertyPath);
			}
		} finally {
			ancestors.delete(current);
		}
	};

	visit(value, field);
}

export class Session<TMetadata extends SessionMetadata = SessionMetadata>
	implements SessionHandle<TMetadata>
{
	constructor(
		private readonly storage: SessionStorage<TMetadata>,
		private readonly generateId: SessionIdGenerator = () => crypto.randomUUID(),
	) {}

	getMetadata(): Promise<TMetadata> {
		return this.storage.getMetadata();
	}

	getLeafId(): Promise<string | null> {
		return this.storage.getLeafId();
	}

	async moveLeaf(id: string | null): Promise<void> {
		assertJsonValue(id, "leafId");
		await this.storage.moveLeaf(id);
	}

	getEntry(id: string): Promise<SessionEntry | undefined> {
		return this.storage.getEntry(id);
	}

	getChildren(parentId: string | null): Promise<SessionEntry[]> {
		return this.storage.getChildren(parentId);
	}

	findEntries(query: EntryQuery = {}): Promise<SessionEntry[]> {
		return this.storage.findEntries(query);
	}

	async findEntriesOnBranch(
		query: BranchEntryQuery = {},
	): Promise<SessionEntry[]> {
		const { startId, ...storageQuery } = query;
		const resolvedStartId =
			startId === undefined ? await this.storage.getLeafId() : startId;

		if (resolvedStartId === null) {
			return [];
		}

		return this.storage.findEntriesOnBranch({
			...storageQuery,
			startId: resolvedStartId,
		});
	}

	appendMessage(message: AgentMessage): Promise<string> {
		return this.appendEntry({
			type: "message",
			message,
		});
	}

	appendCustomEntry(customType: string, data?: JsonValue): Promise<string> {
		return this.appendEntry({
			type: "custom",
			customType,
			...(data === undefined ? {} : { data }),
		});
	}

	async appendEntry<TEntry extends NewSessionEntry>(
		entry: TEntry,
	): Promise<string> {
		assertJsonValue(entry, "entry");
		for (const field of ["id", "seq", "parentId", "timestamp"]) {
			if (Object.hasOwn(entry as object, field)) {
				throw new SessionError(
					"invalid_payload",
					`Entry callers cannot provide ${field}`,
				);
			}
		}

		const id = this.generateId();
		assertUuid(id, "generated entry id");

		const provisionedEntry = Object.assign({}, structuredClone(entry), {
			id,
		}) as ProvisionedSessionEntry;

		const storedEntry = await this.storage.appendEntry(provisionedEntry);
		return storedEntry.id;
	}

	getName(): Promise<string | undefined> {
		return this.storage.getName();
	}

	async setName(name: string | null): Promise<void> {
		assertJsonValue(name, "name");
		await this.storage.setName(name);
	}

	getLabel(targetId: string): Promise<string | undefined> {
		return this.storage.getLabel(targetId);
	}

	async setLabel(targetId: string, label: string | null): Promise<void> {
		assertJsonValue(targetId, "targetId");
		assertJsonValue(label, "label");
		await this.storage.setLabel(targetId, label);
	}

	buildContext(
		options: SessionContextBuildOptions = {},
	): Promise<SessionContext> {
		return buildSessionContext(this.storage, options);
	}
}
