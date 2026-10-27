// Adapted from packages/dev-tools/test/core/lock.test.ts, nredd/pi-harness (MIT, Redd).
import { expect, test } from "bun:test";
import { LockAbortedError, withLock } from "../../extensions/dev-tools/core/lock.ts";
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(accept => { resolve = accept; });
	return { resolve, promise };
}

test("cancelling the last waiter does not release its still-running owner", async () => {
	const key = "cancelled-tail";
	const gate = deferred();
	const order: string[] = [];
	const owner = withLock(key, async () => { order.push("owner"); await gate.promise; order.push("settled"); });
	const controller = new AbortController();
	const cancelled = withLock(key, async () => { order.push("must not run"); }, { signal: controller.signal });
	const pending = [owner, cancelled];
	try {
		controller.abort();
		await expect(cancelled).rejects.toBeInstanceOf(LockAbortedError);
		let waited = 0;
		const next = withLock(key, async () => { order.push("next"); }, { onWait: () => { waited++; } });
		pending.push(next);
		const independent = withLock("independent", async () => { order.push("independent"); });
		pending.push(independent);
		await independent;
		expect(order).toEqual(["owner", "independent"]);
		expect(waited).toBe(1);
		gate.resolve();
		await Promise.all([owner, next]);
		expect(order).toEqual(["owner", "independent", "settled", "next"]);
	} finally {
		gate.resolve();
		await Promise.allSettled(pending);
	}
});

test("failed callbacks and work release the queue without releasing an earlier owner", async () => {
	const gate = deferred();
	const owner = withLock("callbacks", () => gate.promise);
	const pending: Promise<unknown>[] = [owner];
	try {
		const callback = withLock("callbacks", async () => {}, { onWait: () => { throw Error("wait callback"); } });
		pending.push(callback);
		await expect(callback).rejects.toThrow("wait callback");
		let ran = false;
		const next = withLock("callbacks", async () => { ran = true; throw Error("work failed"); });
		// Observe immediately without a matcher that waits before returning control.
		const outcome = next.then(() => undefined, (error: unknown) => error);
		pending.push(outcome);
		await Promise.resolve();
		expect(ran).toBe(false);
		gate.resolve();
		await owner;
		const error = await outcome;
		expect(ran).toBe(true);
		expect(error).toBeInstanceOf(Error);
		expect(error).toHaveProperty("message", "work failed");
		expect(await withLock("callbacks", async () => "released")).toBe("released");
	} finally {
		gate.resolve();
		await Promise.allSettled(pending);
	}
});
