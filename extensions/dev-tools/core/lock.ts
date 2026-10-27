/**
 * In-process mutex keyed by string. Cargo and uv serialize on their build dir; running two
 * concurrently (parallel subagents) blocks on the file lock with no feedback. This queues them
 * instead, tells the caller when it is waiting, and lets a waiter give up on abort.
 */

const queues = new Map<string, Promise<void>>();

export interface LockOptions {
	/** Called once if the lock is held by someone else when we arrive. */
	onWait?: () => void;
	/** Abort while queued rejects with `LockAbortedError` and never runs `fn`. */
	signal?: AbortSignal;
}

export class LockAbortedError extends Error {
	constructor(key: string) {
		super(`aborted while waiting for lock ${key}`);
		this.name = "LockAbortedError";
	}
}

function abortable(prior: Promise<void>, key: string, signal?: AbortSignal): Promise<void> {
	if (!signal) return prior;
	if (signal.aborted) return Promise.reject(new LockAbortedError(key));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new LockAbortedError(key));
		signal.addEventListener("abort", onAbort, { once: true });
		prior.then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}

export async function withLock<T>(key: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
	const prior = queues.get(key);
	let release: () => void = () => {};
	const mine = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chained = prior ? prior.then(() => mine) : mine;
	queues.set(key, chained);
	try {
		if (prior) opts.onWait?.();
		if (prior) await abortable(prior, key, opts.signal);
		return await fn();
	} finally {
		release();
		// A cancelled waiter is not settlement of the owner ahead of it.
		void chained.then(() => {
			if (queues.get(key) === chained) queues.delete(key);
		});
	}
}
