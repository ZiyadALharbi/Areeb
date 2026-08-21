import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AreebPaths {
	readonly userRoot: string;
	readonly userProviders: string;
	readonly userSessions: string;
	readonly userSkills: string;
	readonly userPrompts: string;
	readonly agentsRoot: string;
	readonly userAgentSkills: string;
	readonly projectRoot: string;
	readonly projectAgentsRoot: string;
	readonly projectSkills: string;
	readonly projectPrompts: string;
	readonly projectAgentSkills: string;
	readonly projectSessions: string;
}

export interface AreebPathOptions {
	readonly cwd?: string;
	/** The Areeb user directory itself. Defaults to ~/.areeb. */
	readonly userRoot?: string;
	/** The shared Agent Skills directory itself. Defaults to ~/.agents. */
	readonly agentsRoot?: string;
}

/** Resolve Areeb's filesystem contract without creating any directories. */
export function areebPaths(options: AreebPathOptions = {}): AreebPaths {
	const cwd = resolve(options.cwd ?? process.cwd());
	const userRoot = resolve(options.userRoot ?? join(homedir(), ".areeb"));
	const agentsRoot = resolve(options.agentsRoot ?? join(homedir(), ".agents"));
	const userSessions = join(userRoot, "sessions");
	const projectRoot = join(cwd, ".areeb");
	const projectAgentsRoot = join(cwd, ".agents");

	return Object.freeze({
		userRoot,
		userProviders: join(userRoot, "providers.json"),
		userSessions,
		userSkills: join(userRoot, "skills"),
		userPrompts: join(userRoot, "prompts"),
		agentsRoot,
		userAgentSkills: join(agentsRoot, "skills"),
		projectRoot,
		projectAgentsRoot,
		projectSkills: join(projectRoot, "skills"),
		projectPrompts: join(projectRoot, "prompts"),
		projectAgentSkills: join(projectAgentsRoot, "skills"),
		projectSessions: join(
			userSessions,
			createHash("sha256").update(cwd).digest("hex"),
		),
	});
}
