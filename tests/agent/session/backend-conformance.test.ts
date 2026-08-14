import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepository } from "../../../src/agent/session/jsonl/repository.ts";
import type { JsonlSessionMetadata } from "../../../src/agent/session/jsonl/types.ts";
import { MemorySessionRepository } from "../../../src/agent/session/memory.ts";
import type { SessionMetadata } from "../../../src/agent/session/types.ts";
import {
	type BackendConformanceFactory,
	runBackendConformance,
} from "./backend-conformance.ts";

const memoryFactory: BackendConformanceFactory<SessionMetadata> = async (
	options,
) => ({
	repository: new MemorySessionRepository(options),
	async cleanup() {},
});

const jsonlFactory: BackendConformanceFactory<JsonlSessionMetadata> = async (
	options,
) => {
	const directory = await mkdtemp(join(tmpdir(), "areeb-conformance-"));

	return {
		repository: new JsonlSessionRepository(directory, options),
		async cleanup() {
			await rm(directory, { recursive: true, force: true });
		},
	};
};

runBackendConformance("memory", memoryFactory);
runBackendConformance("JSONL", jsonlFactory);
