import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { executeControllerFixture, copy, type ControllerHost, type Result } from "./fixtures/execute-workflow.ts";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";

const { fixture } = executeControllerFixture();
const receipt = (key: string) => {
  const message = new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: `workflow[${key}]`,
    used: 64, limit: 64, requested: 1, remaining: 0 }).message;
  return { key, ok: false, error: message, output: message, artifactPaths: [] };
};
const worker = "invoke-human-1.l1.t1.a1";
const checkpoint = (host: ControllerHost, key: string, file: string) =>
  existsSync(path.join(host.root, ".pi/subagents/checkpoints", key, file));
const frozen = (host: ControllerHost, key: string) => {
  const request = host.calls.find(call => call.key === key)!;
  return JSON.parse(request.task.split("FROZEN ATTEMPT:\n")[1]!.split("\n")[0]!);
};

// A relaunch is a new top-level run: it has no native receipt of the old run's
// children, and pi-subagents' status of a settled async child is a text receipt
// with results: [] and no structuredOutput (run-status.js, workflowChildResult).
function relaunchStatus(host: ControllerHost) {
  host.setStatus(ref => {
    if (host.current().budgetRejectedKeys?.includes(ref)) throw new Error("Rejected admission has no native child to observe.");
    const child = host.native.get(ref);
    return child ? { ok: child.ok, runId: child.runId, output: `Run: ${ref}\nState: complete`, results: [] } as Result
      : { ok: true, output: "", results: [] };
  });
}
// Exhaust the run fan-out budget on the first matching spawn after the worker
// settles: the request observer (the live case) or the checkpoint sealer.
function exhaustAfterWorker(host: ControllerHost, agent: string, shape?: (result: Result) => Result) {
  let settled = false, denied: string | undefined;
  host.setRespond((request, normal) => {
    if (settled && !denied && request.agent === agent) { denied = request.key; return receipt(request.key); }
    if (request.key !== worker) return normal();
    settled = true;
    return shape ? shape(normal()) : normal();
  });
  return () => denied;
}

test.each(["pitako.request-observer", "pitako.checkpoint-sealer"])(
  "a complete worker result received before %s budget exhaustion is sealed and admitted on relaunch, not restored", async agent => {
  const host = fixture(undefined, { taskCount: 1 });
  const denied = exhaustAfterWorker(host, agent);
  const first = await host.execute();
  expect(first.status, first.reason).toBe("budget-exhausted");
  expect(denied()).toBe(agent === "pitako.checkpoint-sealer" ? `${worker}.seal` : "invoke-human-1.l1.requests-2");
  expect(host.current().loop.attempt).toMatchObject({ key: worker, stage: "launched" });
  expect(checkpoint(host, worker, "manifest.json")).toBe(true);
  expect(checkpoint(host, worker, "unit.json")).toBe(false);

  host.setRespond();
  relaunchStatus(host);
  const resumed = await host.execute();
  expect(resumed.status, resumed.reason).toBe("complete");
  expect(host.calls.some(call => call.key === "invoke-human-1.l1.t1.a2")).toBe(false);
  expect(host.calls.filter(call => call.key === worker)).toHaveLength(1);
  expect(host.calls.filter(call => call.key === `${worker}.seal`)).toHaveLength(agent === "pitako.checkpoint-sealer" ? 2 : 1);
  expect(checkpoint(host, worker, "unit.json")).toBe(true);
  expect(checkpoint(host, worker, "restore.json")).toBe(false);
  expect(host.current().tasks.change1.completed).toMatchObject({ attempt: 1, status: "complete" });
  // The retained copy is admission input only; admission consumes it.
  expect(JSON.stringify(host.current())).not.toContain('"received"');
});

test("a pause result received before budget exhaustion continues from its seal on relaunch, not a rollback", async () => {
  const host = fixture(undefined, { taskCount: 1 });
  exhaustAfterWorker(host, "pitako.request-observer", result => {
    const value = copy(result);
    Object.assign(value.structuredOutput, { status: "continue", remaining: ["Finish src/change1.ts"],
      diagnosis: "First half written; second half pending", continuation: "Finish src/change1.ts" });
    return value;
  });
  expect((await host.execute()).status).toBe("budget-exhausted");

  host.setRespond();
  relaunchStatus(host);
  const resumed = await host.execute();
  expect(resumed.status, resumed.reason).toBe("complete");
  expect(checkpoint(host, worker, "pause.json")).toBe(true);
  expect(checkpoint(host, worker, "restore.json")).toBe(false);
  const next = frozen(host, "invoke-human-1.l1.t1.a2");
  expect(next).not.toHaveProperty("restore");
  expect(next.continuationRef).toMatchObject({ key: worker });
  expect(host.current().tasks.change1.admitted).toEqual(["continue", "complete"]);
});

test("without a retained worker result, relaunch keeps the checkpoint-first fallback", async () => {
  const host = fixture(undefined, { taskCount: 1 });
  exhaustAfterWorker(host, "pitako.request-observer");
  expect((await host.execute()).status).toBe("budget-exhausted");
  // State written before retention existed has only the launch reference.
  const retained = host.current();
  delete retained.loop.attempt.received;
  host.storage.set("invoke-human-1", retained);

  // The controlled worker does not perform restoration; observe the dispatch only.
  host.setRespond((request, normal) => request.agent === "pitako.worker" ? receipt(request.key) : normal());
  relaunchStatus(host);
  await host.execute();
  expect(frozen(host, "invoke-human-1.l1.t1.a2").restore).toMatchObject({ producer: { key: worker } });
  expect(checkpoint(host, worker, "unit.json")).toBe(false);
});
