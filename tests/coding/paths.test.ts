import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { areebPaths } from "../../src/coding/paths.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "areeb-paths-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("areebPaths", () => {
	test("normalizes overrides and exposes the complete filesystem contract", async () => {
		const directory = await createTempDirectory();
		const cwd = resolve(directory, "nested", "..", "project");
		const userRoot = join(directory, "user-resources");
		const agentsRoot = join(directory, "shared-agents");
		const digest = createHash("sha256").update(cwd).digest("hex");

		expect(
			areebPaths({
				cwd: join(directory, "nested", "..", "project"),
				userRoot,
				agentsRoot,
			}),
		).toEqual({
			userRoot,
			userAuth: join(userRoot, "auth.json"),
			userProviders: join(userRoot, "providers.json"),
			userTuiConfig: join(userRoot, "tui.json"),
			userLastCopy: join(userRoot, "last-copy.txt"),
			userSessions: join(userRoot, "sessions"),
			userSkills: join(userRoot, "skills"),
			userPrompts: join(userRoot, "prompts"),
			agentsRoot,
			userAgentSkills: join(agentsRoot, "skills"),
			projectRoot: join(cwd, ".areeb"),
			projectAgentsRoot: join(cwd, ".agents"),
			projectSkills: join(cwd, ".areeb", "skills"),
			projectPrompts: join(cwd, ".areeb", "prompts"),
			projectAgentSkills: join(cwd, ".agents", "skills"),
			projectSessions: join(userRoot, "sessions", digest),
		});
	});

	test("uses a stable full digest without creating directories", async () => {
		const directory = await createTempDirectory();
		const userRoot = join(directory, "missing-user");
		const agentsRoot = join(directory, "missing-agents");
		const first = areebPaths({
			cwd: join(directory, "project"),
			userRoot,
			agentsRoot,
		});
		const equivalent = areebPaths({
			cwd: join(directory, "other", "..", "project"),
			userRoot,
			agentsRoot,
		});
		const other = areebPaths({
			cwd: join(directory, "other-project"),
			userRoot,
			agentsRoot,
		});

		expect(first.projectSessions).toBe(equivalent.projectSessions);
		expect(first.projectSessions).not.toBe(other.projectSessions);
		expect(basename(first.projectSessions)).toMatch(/^[a-f0-9]{64}$/);
		await expect(stat(userRoot)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(agentsRoot)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(first.projectRoot)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
