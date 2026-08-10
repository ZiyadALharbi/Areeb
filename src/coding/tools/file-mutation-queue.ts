import { canonicalMutationPath } from "./path-utils.ts";

const queues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

/** Serialize mutations to the same canonical path while allowing other paths in parallel. */
export async function withFileMutationQueue<T>(
	filePath: string,
	operation: () => Promise<T>,
): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await canonicalMutationPath(filePath);
		const current = queues.get(key) ?? Promise.resolve();
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const chained = current.then(() => gate);
		queues.set(key, chained);
		return { key, current, chained, release };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, current, chained, release } = await registration;
	await current;
	try {
		return await operation();
	} finally {
		release();
		if (queues.get(key) === chained) {
			queues.delete(key);
		}
	}
}
