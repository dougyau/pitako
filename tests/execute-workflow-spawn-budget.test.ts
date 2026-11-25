import { expect, test } from "bun:test";
import { executeControllerFixture, copy } from "./fixtures/execute-workflow.ts";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { readExecuteAdmission } from "../extensions/execute-progress.ts";

const { fixture } = executeControllerFixture();
const rejection = (key: string) => new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT",
  path: `workflow[${key}]`, used: 64, limit: 64, requested: 1, remaining: 0 });
const receipt = (key: string) => ({ key, ok: false, error: rejection(key).message,
  output: rejection(key).message, artifactPaths: [] });

test("budget relaunch does not revive a reconstructed host failure", async () => {
  const host = fixture(undefined, { readOnly: true });
  host.setHostResponse(() => { throw Error("EIO: transport loss"); });
  expect((await host.execute()).status).toBe("blocked");
  host.setHostResponse();
  let denied = false;
  host.setRespond((request, normal) => {
    if (!denied && request.key.endsWith(".compliance")) { denied = true; return receipt(request.key); }
    return normal();
  });
  expect((await host.execute()).status).toBe("budget-exhausted");
  expect(host.current().hostHalt).toBeNull();
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
});

test("budget relaunch retains an unresolved host barrier without dispatch", async () => {
  const host = fixture(undefined, { readOnly: true });
  host.setLaunchRespond((request, normal) => request.agent === "pitako.execution-director" ? receipt(request.key) : normal());
  expect((await host.executeNative()).status).toBe("budget-exhausted");
  host.setHostResponse(() => { throw Error("Blocked by pi-subagents permission rule: 'host' is denied."); });
  expect((await host.executeNative()).status).toBe("blocked");
  host.setHostResponse();
  const before = copy(host.current()), calls = host.calls.length, observations = host.hostCalls.length;
  const output = await host.executeNative();
  expect(output.status).toBe("blocked");
  expect(output.reason).toBe(before.hostHalt.reason);
  expect(host.current()).toEqual(before);
  expect(host.calls).toHaveLength(calls);
  expect(host.hostCalls).toHaveLength(observations);
});

test("native admission rejection saves budget-exhausted before any child starts; same mission reentry continues", async () => {
  const host = fixture(undefined, { readOnly: true });
  host.setAdmission(calls => { throw rejection(calls[0]!.key); });
  const output = await host.executeNative();
  expect(output.status, output.reason).toBe("budget-exhausted");
  expect(output.action.actor).toBe("foreground");
  expect(output.actionRequired).toBe("none");
  expect(output.loopReport.next).toContain("automatically relaunch");
  expect(output.loopsConsumed).toBe(1);
  expect(host.calls).toHaveLength(0);
  expect(host.storage.size).toBe(0); // No cursor before the first COMMIT.
  host.setAdmission();
  expect((await host.executeNative()).status).toBe("complete");
  expect(host.current().budget.consumedLoops).toBe(2);
  expect(new Set(host.calls.map(call => call.key)).size).toBe(host.calls.length);
});

test.each(["worker", "implementation", "close", "drain", "review", "compliance", "checkout", "recovery", "recovery-retry-director", "recovery-status-denied", "gaps"])(
  "%s rejection retains pending work and reentry never repeats admitted launches", async phase => {
    const host = fixture(undefined, { readOnly: !["close", "drain", "implementation"].includes(phase) });
    const recovery = phase.startsWith("recovery");
    const retryDirector = phase === "recovery-retry-director";
    if (phase === "gaps") host.setLimit(1);
    let denied = false;
    let original: any;
    host.setRespond((request, normal) => {
      if (phase === "close" && request.agent === "pitako.worker")
        return host.result(request, { status: "complete", work: "Read-only task", remaining: [] });
      if (recovery && request.agent === "pitako.execution-director" && request.key.startsWith("invoke-human-1.l1.")) {
        const value = normal();
        if (retryDirector && request.key.endsWith(".director")) {
          value.structuredOutput.select = "missing";
        } else {
          original = copy(value.structuredOutput);
          delete value.structuredOutput;
        }
        return value;
      }

      if (recovery && request.agent === "pitako.execution-inspector")
        return host.result(request, { status: "recovered", reason: "Exact original plan", original,
          workerResult: null, originalAvailable: true, binding: "absent", comparison: "only-original", provenance: ["/native/plan"] });
      const result = normal();
      if (phase === "gaps" && request.agent === "pitako.execution-director") result.structuredOutput.select = "missing";
      return result;
    });
    host.setLaunchRespond((request, normal) => {
      const selected = ["worker", "implementation"].includes(phase) ? request.agent === "pitako.worker"
        : phase === "close" ? request.key.endsWith(".t1.a1.close")
        : phase === "drain" ? request.key.endsWith(".nextAdvance")
        : phase === "review" ? request.key.includes(".review.independent-")
        : recovery ? request.agent === "pitako.execution-inspector"
        : phase === "gaps" ? request.key.endsWith(".finishDrain")
        : request.key.endsWith(`.${phase}`);
      if (!denied && selected) { denied = true; return receipt(request.key); }
      return normal();
    });
    const first = await host.execute();
    expect(denied).toBe(true);
    expect(first.status, first.reason).toBe("budget-exhausted");
    const before = copy(host.current());
    expect(before.budget.rejectedKeys.length, first.reason).toBeGreaterThan(0);
    const rejected = [...new Set(host.launches.filter(call => before.budget.rejectedKeys.includes(canonicalDigest(call.key))).map(call => call.key))];
    const admittedKeys = host.launches.filter(call => !rejected.includes(call.key)).map(call => call.key);
    if (retryDirector) {
      expect(before.action).toMatchObject({ kind: "launched", key: rejected[0], role: "execution-inspector", runId: null });
      expect(before.inFlight.filter((ref: { role: string }) => ref.role === "execution-director"))
        .toEqual([{ key: "invoke-human-1.l1.director.d1", runId: host.native.get("invoke-human-1.l1.director.d1")!.runId, role: "execution-director" }]);
    }
    if (!["gaps", "drain"].includes(phase)) expect(before.loop.outcome).toBeNull();
    expect(before.halt).toBeNull();
    let statusDenied = phase === "recovery-status-denied";
    host.setStatus(ref => {
      if (rejected.includes(ref)) throw new Error("Rejected admission has no native child to observe.");
      const child = host.native.get(ref);
      if (statusDenied && child?.agent === "pitako.execution-director")
        throw new Error("Blocked by pi-subagents permission rule: 'status' is denied.");
      if (retryDirector && child?.agent === "pitako.execution-director")
        return { ok: true, output: `Run: ${child.runId}\nState: complete`, results: [] };
      return copy(child ? { ...child, output: `Run: ${child.runId}\nState: complete` } : { ok: true, output: "", results: [] });
    });
    if (phase === "close") {
      expect(rejected).toEqual(["invoke-human-1.l1.t1.a1.close"]);
      expect(before.action).toMatchObject({ kind: "pending", op: "close", opKey: rejected[0] });
      expect(before.loop.attempt.stage).not.toBe("result");
    }
    if (phase === "drain") {
      expect(before.action).toMatchObject({ kind: "launched", key: "invoke-human-1.l1.t1.a1.task-synthesis" });
      expect(host.records().filter((record: any) => record.kind === "unit")).toHaveLength(0);
    }
    // Reloaded settings cannot change the budget admitted by the first COMMIT.
    host.setLimit(1 + before.budget.maxCycles);
    const launchCount = host.launches.length;
    const resumed = await host.execute();
    if (statusDenied) {
      expect(resumed.status, resumed.reason).toBe("blocked");
      expect(resumed.reason).toContain("native permission denial");
      const held = copy(host.current());
      expect(held.hostHalt).not.toBeNull();
      expect({ ...held, hostHalt: null }).toEqual(before);
      statusDenied = false;
      const observed = host.statusCalls.length;
      const relaunched = await host.execute();
      expect(relaunched.loopReport.halt).toEqual(resumed.loopReport.halt);
      expect(relaunched.status).toBe(resumed.status);
      expect(relaunched.reason).toBe(resumed.reason);
      expect(host.current()).toEqual(held);
      expect(host.launches).toHaveLength(launchCount);
      expect(host.statusCalls).toHaveLength(observed);
      return;
    }
    expect(resumed.status, resumed.reason).toBe(phase === "gaps" ? "partial" : "complete");
    expect(resumed.loopsConsumed).toBe(phase === "gaps" ? 1 : 2);
    expect(host.current().budget.maxCycles).toBe(before.budget.maxCycles);
    expect(host.current().budget.rejectedKeys).toEqual([]);
    for (const key of admittedKeys) expect(host.launches.filter(call => call.key === key)).toHaveLength(1);
    for (const key of rejected) expect(host.launches.filter(call => call.key === key)).toHaveLength(2);
    if (recovery) {
      const [initial, replay] = host.launches.filter(call => call.key === rejected[0]);
      expect(replay).toEqual(initial);
    }
  });

test("a closed loop permits another exhaustion even without any checkpoint seals", async () => {
  const host = fixture(undefined, { taskCount: 0 }); host.setLimit(2);
  const rejected = new Set<string>();
  host.setRespond((request, normal) => {
    if (request.key.endsWith(".director") && !rejected.has(request.key)) {
      rejected.add(request.key); return receipt(request.key);
    }
    const result = normal();
    return /^invoke-human-1\.l1\.director(?:\.d1)?$/.test(request.key) ? { ...result, structuredOutput: { ...result.structuredOutput, select: "missing" } } : result;
  });
  expect((await host.execute()).status).toBe("budget-exhausted");
  const second = await host.execute();
  expect(second.status, second.reason).toBe("budget-exhausted");
  expect(host.history()).toHaveLength(1);
  expect(host.records().filter((record: any) => record.kind === "unit")).toHaveLength(0);
  expect((await host.execute()).status).toBe("complete");
});

test("repeated exhaustion without progress halts for a human and names the native setting", async () => {
  const host = fixture(undefined, { readOnly: true });
  host.setLaunchRespond((request, normal) => request.agent === "pitako.execution-director" ? receipt(request.key) : normal());
  expect((await host.execute()).status).toBe("budget-exhausted");
  const second = await host.execute();
  expect(second.status).toBe("blocked");
  expect(second.reason).toContain("one step needs more spawns");
  expect(second.reason).toContain("config.maxSubagentSpawnsPerRun");
  expect(second.action.actor).toBe("human");
  expect(second.loopsConsumed).toBe(1);
  const calls = host.launches.length, barrier = copy(host.current().halt);
  expect(barrier.stage).toBe("spawn-budget");
  expect((await host.execute()).status).toBe("blocked");
  expect(host.launches).toHaveLength(calls);
  expect(host.current().halt).toEqual(barrier);
});

test("an admitted seal permits another budget-exhausted end and relaunch", async () => {
  const host = fixture();
  host.setLaunchRespond((request, normal) => request.key.endsWith(".seal") ? receipt(request.key) : normal());
  expect((await host.execute()).status).toBe("budget-exhausted");
  // The close is admitted and its seal drained before the next exhaustion.
  host.setLaunchRespond();
  let denied = false;
  host.setRespond((request, normal) => {
    if (!denied && request.key.endsWith(".compliance")) { denied = true; return receipt(request.key); }
    return normal();
  });
  const second = await host.execute();
  expect(second.status, second.reason).toBe("budget-exhausted");
  expect(host.records().filter((record: any) => record.kind === "unit")).toHaveLength(1);
  expect((await host.execute()).status).toBe("complete");
});

test.each([
  ["changed amendments", { amendments: [{ path: ".pitako/amendments/late.md", sha256: "a".repeat(64), provenance: "human message 1" }] }, "Immutable admission amendments changed"],
  ["changed worktree", { root: "/other/worktree" }, "wrong cwd"],
] as const)("an early %s block after budget exhaustion leaves pending intentions undispatched", async (_name, override, reason) => {
  const host = fixture();
  // Loop 1's unit ledger, settlement and loop record stay queued when the next draining advance is rejected.
  host.setLimit(2);
  host.setLaunchRespond((request, normal) => request.key.endsWith(".l1.nextAdvance") ? receipt(request.key) : normal());
  expect((await host.execute()).status).toBe("budget-exhausted");
  const before = copy(host.current()), calls = host.launches.length;
  expect(before.budget.rejectedKeys).toContain(canonicalDigest("invoke-human-1.l1.nextAdvance"));
  if ("amendments" in override) {
    host.setHostResponse((_key, value) => {
      const { admission } = readExecuteAdmission(host.root, before);
      return canonicalDigest(admission.amendments ?? []) === canonicalDigest(override.amendments)
        ? value : { version: 1, error: "Immutable admission amendments changed" };
    });
  }
  const output = await host.execute(override);
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain(reason);
  expect(host.launches).toHaveLength(calls);
  expect(host.current()).toEqual(before);
});

test.each(["stopped", "native permission denial", "semantic-block"])(
  "budget relaunch preserves a recorded %s barrier without any dispatch", async cause => {
    const host = fixture();
    let denied = false;
    host.setLaunchRespond((request, normal) => {
      if (!denied && request.agent === "pitako.execution-director") { denied = true; return receipt(request.key); }
      return normal();
    });
    expect((await host.execute()).status).toBe("budget-exhausted");
    host.setRespond((request, normal) => {
      if (request.agent !== "pitako.worker") return normal();
      if (cause === "native permission denial") throw new Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      if (cause === "stopped") return { ...normal(), ok: false, stopped: true };
      return host.result(request, { status: "blocked", work: "Retained semantic block", remaining: ["Human ruling needed"] });
    });
    const first = await host.execute();
    expect(first.status, first.reason).toBe(cause === "stopped" ? "cancelled" : "blocked");
    const before = copy(host.current()), calls = host.launches.length;
    expect(before.halt).not.toBeNull();
    const output = await host.execute();
    expect(output.status, output.reason).toBe(first.status);
    expect(output.reason).toBe(first.reason);
    expect(host.current()).toEqual(before);
    expect(host.launches).toHaveLength(calls);
  });

test.each(["throw", "prose", "child"])("non-budget %s failure is not misclassified", async kind => {
  const host = fixture(undefined, { readOnly: true });
  host.setRespond(request => {
    if (kind === "throw") throw rejection(request.key);
    if (kind === "child") return { ...receipt(request.key), runId: "actual-child", agent: request.agent };
    return { ...receipt(request.key), error: "Unrelated error: Run fan-out limit reached", output: "Unrelated error" };
  });
  const output = await host.execute();
  expect(output.status).not.toBe("budget-exhausted");
  expect(host.current()?.budget.lastProgress ?? null).toBeNull();
});

// Task attempts include workflow-owned gates; final acceptance has no worker or sealer.
test("a task attempt groups requests, gate and exactly one seal after the writer", async () => {
  const host = fixture();
  host.setRespond((request, normal) => request.agent === "pitako.worker"
    ? host.result(request, { status: "complete", work: "Read-only task", remaining: [] }) : normal());
  expect((await host.execute()).status).toBe("complete");
  const effects = host.calls.slice(host.calls.findIndex(call => call.key === "invoke-human-1.l1.t1.a1") + 1, -1);
  expect(effects.findIndex(call => call.key.endsWith(".gate"))).toBeLessThan(effects.findIndex(call => call.agent === "pitako.checkpoint-sealer"));
  const baseline = host.calls.find(call => call.key === "invoke-human-1.l1.t1.a1.baseline")!;
  expect(JSON.parse(baseline.task).operation).toBe("baseline");
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.seal"]);
});
