import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FileCredentialStore,
	MemoryCredentialStore,
} from "../../src/coding/auth-store.ts";

const tempDirectories: string[] = [];

async function tempStore(): Promise<{
	readonly directory: string;
	readonly path: string;
	readonly store: FileCredentialStore;
}> {
	const directory = await mkdtemp(join(tmpdir(), "areeb-auth-store-"));
	tempDirectories.push(directory);
	const path = join(directory, "user", "auth.json");
	return { directory, path, store: new FileCredentialStore({ path }) };
}

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("FileCredentialStore", () => {
	test("writes atomically with private permissions and lists no secrets", async () => {
		const { path, store } = await tempStore();
		await store.modify("openai", () => ({
			type: "api_key",
			key: "top-secret",
		}));

		expect(await store.read("openai")).toEqual({
			type: "api_key",
			key: "top-secret",
		});
		expect(await store.list()).toEqual([
			{ provider: "openai", type: "api_key" },
		]);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			version: 1,
			credentials: {
				openai: { type: "api_key", key: "top-secret" },
			},
		});
	});

	test("preserves a malformed file instead of overwriting it", async () => {
		const { path, store } = await tempStore();
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, "not-json\n", { mode: 0o600 });

		await expect(
			store.modify("openai", () => ({ type: "api_key", key: "new" })),
		).rejects.toThrow("invalid JSON");
		expect(await readFile(path, "utf8")).toBe("not-json\n");
	});

	test("serializes mutations and preserves unrelated credentials", async () => {
		const { store } = await tempStore();
		await Promise.all([
			store.modify("openai", async () => ({
				type: "api_key",
				key: "one",
			})),
			store.modify("openai-codex", async () => ({
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: 123,
				metadata: { accountId: "account" },
			})),
		]);

		expect((await store.list()).map((entry) => entry.provider)).toEqual([
			"openai",
			"openai-codex",
		]);
		expect(await store.delete("openai")).toBe(true);
		expect(await store.delete("openai")).toBe(false);
		expect(await store.read("openai-codex")).toMatchObject({ type: "oauth" });
	});
});

describe("MemoryCredentialStore", () => {
	test("supports provider-neutral serialized mutation for tests", async () => {
		const store = new MemoryCredentialStore();
		await store.modify("openai", () => ({ type: "api_key", key: "first" }));
		await store.modify("openai", (current) => {
			expect(current).toEqual({ type: "api_key", key: "first" });
			return { type: "api_key", key: "second" };
		});
		expect(await store.read("openai")).toEqual({
			type: "api_key",
			key: "second",
		});
	});
});
