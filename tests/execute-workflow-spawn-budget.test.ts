import { expect, test } from "bun:test";
import { executeControllerFixture, copy, gaps } from "./fixtures/execute-workflow.ts";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";

const { fixture } = executeControllerFixture();
const rejection = (key: string) => new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT",
  path: `workflow[${key}]`, used: 64, limit: 64, requested: 1, remaining: 0 });
const receipt = (key: string) => ({ key, ok: false, error: rejection(key).message,
  output: rejection(key).message, artifactPaths: [] });

test.each(["reconstruction", "human", "human-permission"])("budget relaunch does not revive a host failure resolved by %s", async route => {
  const host = fixture(undefined, { readOnly: true });
  host.setHostResponse(() => { throw Error(route === "human-permission"
    ? "Blocked by pi-subagents permission rule: 'host' is denied." : "EIO: transport loss"); });
  expect((await host.execute()).status).toBe("blocked");
  host.setHostResponse();
  let denied = false;
  host.setRespond((request, normal) => {
    if (!denied && request.key.endsWith(".compliance")) { denied = true; return receipt(request.key); }
    return normal();
  });
  expect((await host.execute(route.startsWith("human")
    ? { unblock: true, resolution: { loop: 0, text: "Continue after repaired host transport." } } : {})).status).toBe("budget-exhausted");
  expect(host.current().hostHalt).toBeDefined();
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
});

test("budget relaunch retains an unresolved host barrier without dispatch", async () => {
  const host = fixture(undefined, { readOnly: true });
  host.setAdmission(calls => { throw rejection(calls[0]!.key); });
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
  expect(host.current().ledger).toEqual({ count: 0, head: null });
  expect(host.current().loop).not.toHaveProperty("archived");
  expect(host.current().loop).not.toHaveProperty("halt");
  expect(host.current().budgetRejectedKeys).toEqual(["invoke-human-1.l1.director"]);
  host.setAdmission();
  expect((await host.executeNative()).status).toBe("complete");
  expect(host.current().consumedLoops).toBe(1);
  expect(new Set(host.calls.map(call => call.key)).size).toBe(host.calls.length);
});

test.each(["worker", "implementation", "seal", "review", "compliance", "checkout", "recovery", "gaps"])(
  "%s rejection retains pending work and reentry never repeats admitted launches", async phase => {
    const host = fixture(undefined, { readOnly: !["seal", "implementation"].includes(phase) });
    if (phase === "gaps") host.setLimit(1);
    let denied = false;
    let original: any;
    host.setRespond((request, normal) => {
      if (phase === "recovery" && request.agent === "pitako.execution-director") {
        const value = normal(); original = copy(value.structuredOutput); delete value.structuredOutput; return value;
      }
      const selected = ["worker", "implementation"].includes(phase) ? request.agent === "pitako.worker"
        : phase === "seal" ? request.agent === "pitako.execution-ledger"
        : phase === "review" ? request.key.includes(".review.independent-")
        : phase === "recovery" ? request.agent === "pitako.execution-inspector"
        : phase === "gaps" ? request.agent === "pitako.execution-ledger"
        : request.key.endsWith(`.${phase}`);
      if (!denied && selected) { denied = true; return receipt(request.key); }
      if (phase === "recovery" && request.agent === "pitako.execution-inspector")
        return host.result(request, { status: "recovered", reason: "Exact original plan", original,
          workerResult: null, originalAvailable: true, binding: "absent", comparison: "only-original", provenance: ["/native/plan"] });
      const result = normal();
      if (phase === "gaps" && request.agent === "pitako.execution-director") result.structuredOutput.tasks = [];
      return result;
    });
    const first = await host.execute();
    expect(denied).toBe(true);
    expect(first.status, first.reason).toBe("budget-exhausted");
    const before = copy(host.current()), rejected = before.budgetRejectedKeys;
    const admittedKeys = host.calls.filter(call => !rejected.includes(call.key)).map(call => call.key);
    expect(before.loop).not.toHaveProperty("archived");
    expect(before.loop).not.toHaveProperty("halt");
    host.setStatus(ref => {
      if (rejected.includes(ref)) throw new Error("Rejected admission has no native child to observe.");
      return copy(host.native.get(ref) ?? { ok: true, output: "", results: [] });
    });
    if (phase === "seal") {
      expect(before.sealPending).not.toBeNull();
      expect(before.ledger.count).toBe(0);
      expect(before.loop.cursor).toBe(0);
      expect(before.sealPending.retry).toBe(0);
    }
    const resumed = await host.execute();
    expect(resumed.status, resumed.reason).toBe(phase === "gaps" ? "partial" : "complete");
    expect(resumed.loopsConsumed).toBe(1);
    expect(host.current().budgetRejectedKeys).toEqual([]);
    for (const key of admittedKeys) expect(host.calls.filter(call => call.key === key)).toHaveLength(1);
    for (const key of rejected) expect(host.calls.filter(call => call.key === key)).toHaveLength(2);
  });

test("a closed loop permits another exhaustion even without any checkpoint seals", async () => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(2);
  const rejected = new Set<string>();
  host.setRespond((request, normal) => {
    if (request.key.endsWith(".director") && !rejected.has(request.key)) {
      rejected.add(request.key); return receipt(request.key);
    }
    const result = normal();
    return request.key === "invoke-human-1.l1.compliance" ? gaps(result) : result;
  });
  expect((await host.execute()).status).toBe("budget-exhausted");
  const second = await host.execute();
  expect(second.status, second.reason).toBe("budget-exhausted");
  expect(host.current().lastBudgetProgress).toMatchObject({ checkpoint: null, closedLoop: 1 });
  expect((await host.execute()).status).toBe("complete");
});

test("repeated exhaustion without progress halts for a human and names the native setting", async () => {
  const host = fixture(undefined, { readOnly: true });
  host.setRespond(request => receipt(request.key));
  expect((await host.execute()).status).toBe("budget-exhausted");
  const second = await host.execute();
  expect(second.status).toBe("blocked");
  expect(second.reason).toContain("one step needs more spawns");
  expect(second.reason).toContain("config.maxSubagentSpawnsPerRun");
  expect(second.action.actor).toBe("human");
  expect(second.loopsConsumed).toBe(1);
  const calls = host.calls.length, barrier = copy(host.current().loop.halt);
  expect((await host.execute()).status).toBe("blocked");
  expect(host.calls).toHaveLength(calls);
  expect(host.current().loop.halt).toEqual(barrier);
});

test("an admitted seal permits another budget-exhausted end and relaunch", async () => {
  const host = fixture();
  let remaining = 2;
  host.setRespond((request, normal) => request.agent === "pitako.execution-ledger" && remaining-- > 0
    ? receipt(request.key) : normal());
  expect((await host.execute()).status).toBe("budget-exhausted");
  // First rejected seal must publish before another seal can make progress.
  remaining = 0;
  let denied = false;
  host.setRespond((request, normal) => {
    if (!denied && request.key.endsWith(".compliance")) { denied = true; return receipt(request.key); }
    return normal();
  });
  const second = await host.execute();
  expect(second.status, second.reason).toBe("budget-exhausted");
  expect(host.current().lastBudgetProgress.ledger.count).toBeGreaterThan(0);
  expect((await host.execute()).status).toBe("complete");
});

test.each(["stopped", "native permission denial", "semantic-block"])(
  "budget relaunch preserves a recorded %s barrier without any dispatch", async cause => {
    const host = fixture();
    host.setRespond((request, normal) => request.agent === "pitako.execution-ledger" ? receipt(request.key) : normal());
    expect((await host.execute()).status).toBe("budget-exhausted");
    host.current().loop.halt = { status: cause === "stopped" ? "cancelled" : "blocked",
      code: cause === "semantic-block" ? cause : "native-barrier", cause, reason: `Retained ${cause}` };
    const before = copy(host.current()), calls = host.calls.length, observations = host.hostCalls.length;
    const output = await host.execute();
    expect(output.status).toBe(before.loop.halt.status);
    expect(output.reason).toBe(before.loop.halt.reason);
    expect(host.current()).toEqual(before);
    expect(host.calls).toHaveLength(calls);
    expect(host.hostCalls).toHaveLength(observations);
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
  expect(host.current()).not.toHaveProperty("lastBudgetProgress");
});
