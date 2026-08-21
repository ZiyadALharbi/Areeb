import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
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

function contextRoots(directory: string, cwd: string) {
	return {
		userRoot: join(directory, "user"),
		agentsRoot: join(directory, "agents"),
		projectRoot: join(cwd, ".areeb"),
		projectAgentsRoot: join(cwd, ".agents"),
	};
}

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("project context discovery", () => {
	test("selects one candidate per source in exact specificity order", async () => {
		const directory = await createTempDirectory();
		const repository = join(directory, "repository");
		const workspace = join(repository, "packages");
		const cwd = join(workspace, "app");
		const roots = contextRoots(directory, cwd);
		await mkdir(join(repository, ".git"), { recursive: true });
		await mkdir(join(repository, ".agents"), { recursive: true });
		await mkdir(roots.projectAgentsRoot, { recursive: true });
		await mkdir(roots.projectRoot, { recursive: true });
		await mkdir(roots.userRoot, { recursive: true });
		await mkdir(roots.agentsRoot, { recursive: true });
		await writeFile(join(roots.agentsRoot, "AGENTS.md"), "global agents");
		await writeFile(join(roots.userRoot, "CLAUDE.md"), "global areeb");
		await writeFile(join(repository, "AGENTS.md"), "root agents");
		await writeFile(join(repository, "CLAUDE.md"), "root claude");
		await writeFile(
			join(workspace, "AGENTS.override.md"),
			"workspace override",
		);
		await writeFile(join(workspace, "AGENTS.md"), "workspace agents");
		await writeFile(join(cwd, "CLAUDE.md"), "cwd");
		await writeFile(join(repository, ".agents", "AGENTS.md"), "ignored");
		await writeFile(
			join(roots.projectAgentsRoot, "AGENTS.md"),
			"project agents",
		);
		await writeFile(
			join(roots.projectRoot, "AGENTS.override.md"),
			"project areeb",
		);

		const context = await loadProjectContext({
			cwd,
			...roots,
			trustProjectResources: true,
			contextFiles: [{ path: "caller://instructions", content: "caller" }],
		});

		expect(context).toEqual([
			{ path: join(roots.agentsRoot, "AGENTS.md"), content: "global agents" },
			{ path: join(roots.userRoot, "CLAUDE.md"), content: "global areeb" },
			{ path: join(repository, "AGENTS.md"), content: "root agents" },
			{
				path: join(workspace, "AGENTS.override.md"),
				content: "workspace override",
			},
			{ path: join(cwd, "CLAUDE.md"), content: "cwd" },
			{
				path: join(roots.projectAgentsRoot, "AGENTS.md"),
				content: "project agents",
			},
			{
				path: join(roots.projectRoot, "AGENTS.override.md"),
				content: "project areeb",
			},
			{ path: "caller://instructions", content: "caller" },
		]);
	});

	test("does not inspect project instructions until trust is granted", async () => {
		const directory = await createTempDirectory();
		const cwd = join(directory, "project");
		const roots = contextRoots(directory, cwd);
		await mkdir(roots.userRoot);
		await mkdir(roots.agentsRoot);
		await mkdir(join(cwd, "AGENTS.override.md"), { recursive: true });
		await mkdir(roots.projectAgentsRoot, { recursive: true });
		await writeFile(join(roots.userRoot, "AGENTS.md"), "user");
		await mkdir(join(roots.projectAgentsRoot, "AGENTS.md"));

		await expect(
			loadProjectContext({
				cwd,
				...roots,
				contextFiles: [{ path: "explicit", content: "trusted" }],
			}),
		).resolves.toEqual([
			{ path: join(roots.userRoot, "AGENTS.md"), content: "user" },
			{ path: "explicit", content: "trusted" },
		]);
		await expect(
			loadProjectContext({
				cwd,
				...roots,
				trustProjectResources: true,
			}),
		).rejects.toThrow("Resource is not a regular file");
	});

	test("uses the nearest Git file or directory boundary and cwd outside Git", async () => {
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

		const nestedRepository = join(repository, "nested", "vendor");
		const nestedCwd = join(nestedRepository, "src");
		await mkdir(join(nestedRepository, ".git"), { recursive: true });
		await mkdir(nestedCwd);
		expect(await discoverProjectDirectories(nestedCwd)).toEqual([
			nestedRepository,
			nestedCwd,
		]);
	});

	test("deduplicates symlinked instructions by canonical path", async () => {
		const directory = await createTempDirectory();
		const repository = join(directory, "repository");
		const cwd = join(repository, "app");
		const roots = contextRoots(directory, cwd);
		await mkdir(roots.userRoot);
		await mkdir(roots.agentsRoot);
		await mkdir(join(repository, ".git"), { recursive: true });
		await mkdir(cwd);
		await writeFile(join(repository, "AGENTS.md"), "shared");
		await symlink(
			join(repository, "AGENTS.md"),
			join(cwd, "AGENTS.override.md"),
		);

		await expect(
			loadProjectContext({ cwd, ...roots, trustProjectResources: true }),
		).resolves.toEqual([
			{ path: join(repository, "AGENTS.md"), content: "shared" },
		]);
	});

	test("retains strict size failures for selected instructions", async () => {
		const directory = await createTempDirectory();
		const cwd = join(directory, "project");
		const roots = contextRoots(directory, cwd);
		await mkdir(roots.userRoot);
		await mkdir(roots.agentsRoot);
		await writeFile(
			join(roots.userRoot, "AGENTS.override.md"),
			"x".repeat(MAX_RESOURCE_BYTES + 1),
		);

		try {
			await loadProjectContext({ cwd, ...roots });
			throw new Error("Expected project context loading to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(ResourceError);
			expect(error).toMatchObject({
				filePath: join(roots.userRoot, "AGENTS.override.md"),
			});
		}
	});

	test("fails for selected directories and unreadable files", async () => {
		const directory = await createTempDirectory();
		const cwd = join(directory, "project");
		const roots = contextRoots(directory, cwd);
		await mkdir(roots.userRoot);
		await mkdir(roots.agentsRoot);
		await mkdir(join(roots.userRoot, "AGENTS.override.md"));

		await expect(loadProjectContext({ cwd, ...roots })).rejects.toThrow(
			"Resource is not a regular file",
		);

		await rm(join(roots.userRoot, "AGENTS.override.md"), { recursive: true });
		const unreadable = join(roots.userRoot, "AGENTS.md");
		await writeFile(unreadable, "private");
		await chmod(unreadable, 0o000);
		try {
			await expect(loadProjectContext({ cwd, ...roots })).rejects.toThrow(
				"Unable to read resource",
			);
		} finally {
			await chmod(unreadable, 0o600);
		}
	});
});
