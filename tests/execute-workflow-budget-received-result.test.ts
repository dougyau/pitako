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
const checkpointIntent = (host: ControllerHost, key: string) => {
  const request = host.calls.find(call => call.key === key)!;
  return JSON.parse(request.task.split("PRE-WRITE CHECKPOINT INTENTION (not a backup until published):\n")[1]!.split("\n")[0]!);
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
// Complete results gate before review; incomplete results retain grouped close.
function exhaustAfterWorker(host: ControllerHost, shape?: (result: Result) => Result) {
  let denied: string | undefined;
  host.setRespond((request, normal) => request.key === worker && shape ? shape(normal()) : normal());
  host.setLaunchRespond((request, normal) => {
    if (!denied && request.key === `${worker}.${shape ? "close" : "gate"}`) { denied = request.key; return receipt(request.key); }
    return normal();
  });
  return () => denied;
}

test("a complete worker result received before gate budget exhaustion is reviewed, sealed and admitted on relaunch, not restored", async () => {
  const host = fixture(undefined, { taskCount: 1 });
  const denied = exhaustAfterWorker(host);
  const first = await host.execute();
  expect(first.status, first.reason).toBe("budget-exhausted");
  expect(denied()).toBe(`${worker}.gate`);
  expect(host.current().loop.attempt).toMatchObject({ key: worker, stage: "launched" });
  expect(checkpoint(host, worker, "manifest.json")).toBe(true);
  expect(checkpoint(host, worker, "unit.json")).toBe(false);

  host.setRespond();
  relaunchStatus(host);
  const resumed = await host.execute();
  expect(resumed.status, resumed.reason).toBe("complete");
  expect(host.calls.some(call => call.key === "invoke-human-1.l1.t1.a2")).toBe(false);
  expect(host.calls.filter(call => call.key === worker)).toHaveLength(1);
  expect(host.calls.filter(call => call.key === `${worker}.seal`)).toHaveLength(1);
  expect(host.launches.filter(call => call.key === `${worker}.gate`)).toHaveLength(2);
  expect(checkpoint(host, worker, "unit.json")).toBe(true);
  expect(checkpoint(host, worker, "restore.json")).toBe(false);
  expect(host.calls.filter(call => call.key === `${worker}.gate`)).toHaveLength(1);
  expect(host.records().find((record: any) => record.kind === "unit").body.result).toMatchObject({ attempt: 1, status: "complete" });
  // The retained copy is admission input only; admission consumes it.
  expect(JSON.stringify(host.current())).not.toContain('"received"');
});

test("a pause result received before budget exhaustion continues from its seal on relaunch, not a rollback", async () => {
  const host = fixture(undefined, { taskCount: 1 });
  exhaustAfterWorker(host, result => {
    const value = copy(result);
    Object.assign(value.structuredOutput, { status: "continue", remaining: ["Finish src/change1.ts"],
      knowledge: { findings: [], handoff: "src/change1.ts contains the first half." } });
    return value;
  });
  expect((await host.execute()).status).toBe("budget-exhausted");

  host.setRespond();
  relaunchStatus(host);
  const resumed = await host.execute();
  expect(resumed.status, resumed.reason).toBe("complete");
  expect(checkpoint(host, worker, "pause.json")).toBe(true);
  expect(checkpoint(host, worker, "restore.json")).toBe(false);
  const next = checkpointIntent(host, "invoke-human-1.l1.t1.a2");
  expect(next).not.toHaveProperty("restore");
  expect(host.calls.find(call => call.key === "invoke-human-1.l1.t1.a2")!.task).toContain(`/native/output/${worker}.json`);
  expect(host.records().filter((record: any) => record.kind === "unit").map((record: any) => record.body.result.status)).toEqual(["continue", "complete"]);
});

test("without a retained worker result, relaunch keeps the checkpoint-first fallback", async () => {
  const host = fixture(undefined, { taskCount: 1 });
  exhaustAfterWorker(host);
  expect((await host.execute()).status).toBe("budget-exhausted");
  // State written before retention existed has only the launch reference.
  const retained = host.current();
  delete retained.loop.attempt.received;
  host.storage.set("invoke-human-1", retained);

  // The controlled worker does not perform restoration; observe the dispatch only.
  host.setRespond((request, normal) => request.agent === "pitako.worker" ? receipt(request.key) : normal());
  relaunchStatus(host);
  await host.execute();
  const request = host.calls.find(call => call.key === "invoke-human-1.l1.t1.a2")!;
  const fallback = JSON.parse(request.task.split("CHECKPOINT FALLBACK (same pending task, not a metadata repair):\n")[1]!.split("\n")[0]!);
  expect(fallback).toMatchObject({ producer: { key: worker } });
  expect(checkpoint(host, worker, "unit.json")).toBe(false);
});
