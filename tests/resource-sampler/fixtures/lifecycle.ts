// Isolated module doubles: never alter module registrations in another test file.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import * as collector from "../../../extensions/resource-sampler/collect.ts";
import * as os from "node:os";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(accept => { resolve = accept; });
	return { promise, resolve };
}
let cpu = 0;
const pending: { gate: ReturnType<typeof deferred>; signal: AbortSignal }[] = [];
mock.module("node:os", () => ({
	...os, platform: () => "win32",
	cpus: () => [{ model: "fixture", speed: 1, times: { user: ++cpu, idle: cpu, sys: 0, nice: 0, irq: 0 } }],
	loadavg: () => [], totalmem: () => 1000, freemem: () => 500,
}));
mock.module("../../../extensions/resource-sampler/collect.ts", () => ({
	...collector,
	pressure: async (budget: collector.Budget) => {
		const gate = deferred();
		pending.push({ gate, signal: budget.signal });
		await gate.promise;
		return { source: "unsupported", reason: "controlled fixture" };
	},
}));
const { createResourceSampler } = await import("../../../extensions/resource-sampler/index.ts");
assert.throws(() => createResourceSampler({ maxPids: 0 }), RangeError);
assert.equal(pending.length, 0); // Failed initialization must not start work.
const a = createResourceSampler(), b = createResourceSampler();
const aborted = new AbortController();
const first = a.sample(aborted.signal);
const firstOutcome = first.then(() => { throw Error("expected cancellation"); }, error => error);
const second = b.sample();
await assert.rejects(a.sample(), /active sample/);
assert.equal(pending.length, 2); // Instances own separate starts.
aborted.abort(new Error("owner A cancelled"));
assert.equal(pending[0]!.signal.aborted, true);
assert.equal(pending[1]!.signal.aborted, false);
let disposed = false;
const closing = a.dispose().then(() => { disposed = true; });
await Promise.resolve();
assert.equal(disposed, false); // Abort/status is not collection settlement.
pending[1]!.gate.resolve();
assert.equal((await second).cpu.state, "warming");
pending[0]!.gate.resolve();
assert.match(String(await firstOutcome), /owner A cancelled/);
await closing;
await a.dispose();
await assert.rejects(a.sample(), /disposed/);
const third = b.sample();
pending[2]!.gate.resolve();
assert.equal((await third).cpu.state, "available");
await b.dispose();
console.log("independent sampler owners and disposal settled");
