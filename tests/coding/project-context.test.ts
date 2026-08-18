import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverProjectDirectories,
	loadProjectContext,
} from "../../src/coding/project-context.ts";
import {
	MAX_RESOURCE_BYTES,
	ResourceError,
} from "../../src/coding/resources.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "areeb-context-"));
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

describe("project context discovery", () => {
	test("selects one candidate per directory and orders root through caller context", async () => {
		const directory = await createTempDirectory();
		const userRoot = join(directory, "user");
		const repository = join(directory, "repository");
		const workspace = join(repository, "packages");
		const cwd = join(workspace, "app");
		await mkdir(join(repository, ".git"), { recursive: true });
		await mkdir(join(repository, ".agents"), { recursive: true });
		await mkdir(cwd, { recursive: true });
		await mkdir(userRoot, { recursive: true });
		await writeFile(join(userRoot, "CLAUDE.md"), "user");
		await writeFile(join(repository, "AGENTS.md"), "root agents");
		await writeFile(join(repository, "CLAUDE.md"), "root claude");
		await writeFile(
			join(workspace, "AGENTS.override.md"),
			"workspace override",
		);
		await writeFile(join(workspace, "AGENTS.md"), "workspace agents");
		await writeFile(join(cwd, "CLAUDE.md"), "cwd");
		await writeFile(join(repository, ".agents", "AGENTS.md"), "ignored");

		const context = await loadProjectContext({
			cwd,
			userRoot,
			trustProjectResources: true,
			contextFiles: [{ path: "caller://instructions", content: "caller" }],
		});

		expect(context).toEqual([
			{ path: join(userRoot, "CLAUDE.md"), content: "user" },
			{ path: join(repository, "AGENTS.md"), content: "root agents" },
			{
				path: join(workspace, "AGENTS.override.md"),
				content: "workspace override",
			},
			{ path: join(cwd, "CLAUDE.md"), content: "cwd" },
			{ path: "caller://instructions", content: "caller" },
		]);
	});

	test("does not inspect project instructions until trust is granted", async () => {
		const directory = await createTempDirectory();
		const userRoot = join(directory, "user");
		const cwd = join(directory, "project");
		await mkdir(userRoot);
		await mkdir(join(cwd, "AGENTS.override.md"), { recursive: true });
		await writeFile(join(userRoot, "AGENTS.md"), "user");

		await expect(
			loadProjectContext({
				cwd,
				userRoot,
				contextFiles: [{ path: "explicit", content: "trusted" }],
			}),
		).resolves.toEqual([
			{ path: join(userRoot, "AGENTS.md"), content: "user" },
			{ path: "explicit", content: "trusted" },
		]);
		await expect(
			loadProjectContext({
				cwd,
				userRoot,
				trustProjectResources: true,
			}),
		).rejects.toThrow("Resource is not a regular file");
	});

	test("inspects only cwd outside Git and accepts .git files as boundaries", async () => {
		const directory = await createTempDirectory();
		const outsideCwd = join(directory, "outside", "nested");
		await mkdir(outsideCwd, { recursive: true });
		expect(await discoverProjectDirectories(outsideCwd)).toEqual([outsideCwd]);

		const repository = join(directory, "repository");
		const cwd = join(repository, "nested", "app");
		await mkdir(cwd, { recursive: true });
		await writeFile(join(repository, ".git"), "gitdir: elsewhere");
		expect(await discoverProjectDirectories(cwd)).toEqual([
			repository,
			join(repository, "nested"),
			cwd,
		]);
	});

	test("deduplicates symlinked instructions by canonical path", async () => {
		const directory = await createTempDirectory();
		const userRoot = join(directory, "user");
		const repository = join(directory, "repository");
		const cwd = join(repository, "app");
		await mkdir(userRoot);
		await mkdir(join(repository, ".git"), { recursive: true });
		await mkdir(cwd);
		await writeFile(join(repository, "AGENTS.md"), "shared");
		await symlink(
			join(repository, "AGENTS.md"),
			join(cwd, "AGENTS.override.md"),
		);

		await expect(
			loadProjectContext({ cwd, userRoot, trustProjectResources: true }),
		).resolves.toEqual([
			{ path: join(repository, "AGENTS.md"), content: "shared" },
		]);
	});

	test("retains strict size failures for selected instructions", async () => {
		const directory = await createTempDirectory();
		const userRoot = join(directory, "user");
		await mkdir(userRoot);
		await writeFile(
			join(userRoot, "AGENTS.override.md"),
			"x".repeat(MAX_RESOURCE_BYTES + 1),
		);

		try {
			await loadProjectContext({ cwd: join(directory, "project"), userRoot });
			throw new Error("Expected project context loading to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(ResourceError);
			expect(error).toMatchObject({
				filePath: join(userRoot, "AGENTS.override.md"),
			});
		}
	});
});
