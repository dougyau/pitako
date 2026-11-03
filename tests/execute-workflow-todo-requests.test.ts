import { expect, test } from "bun:test";
import { executeControllerFixture, cutAt, copy, type ControllerHost } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
const request = (kind = "cancel", taskId = "change1") => ({ v: 1, requestId: `request-${taskId}`, invocation: "human-1",
  taskId, kind, origin: "model", at: "2026-11-03T00:00:00Z" });
function page(call: any, requests: any[], next: number | null = null) {
  return { ok: true, agent: call.agent, runId: `native-${call.key}`, results: [{ index: 0, agent: call.agent!, task: call.task, exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }],
    output: JSON.stringify({ version: 1, ok: true, invocation: "human-1", requests, next }) };
}
const rows = (host: ControllerHost) => host.emits.filter(value => value.schema === "pitako.execute-todo").flatMap(value => value.tasks);

test.each(["cancel", "delete"])("execute observes %s before dispatch, persists and cascades without replanning", async kind => {
  const host = fixture(undefined, { readOnly: true, taskCount: 3 }); host.setLimit(1);
  host.setRespond((call, normal) => {
    if (call.agent === "pitako.request-observer") return page(call, [request(kind)]);
    const result = normal();
    if (call.agent === "pitako.execution-director") {
      const tasks = result.structuredOutput.tasks;
      tasks[1].dependsOn = [{ taskId: "change1", reason: "Requires implementation" }];
      tasks[2].dependsOn = [{ taskId: "change2", reason: "Requires integration" }];
    }
    if (call.agent === "pitako.worker") {
      expect(host.current().tasks.change1.cancel.origin).toBe("model");
      expect(call.key).toContain(".t4."); // Only the independent verification survives.
    }
    if (call.key.endsWith(".compliance")) {
      expect(call.task).toContain("cancelled by main-session request");
      expect(call.task).toContain('"origin":"model"');
    }
    return result;
  });
  const result = await host.executeNative();
  expect(result.status, result.reason).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  expect(host.current().tasks.change2.cancel.cascadeFrom).toBe("change1");
  expect(host.current().tasks.change3.cancel.cascadeFrom).toBe("change2");
  expect(host.current().loop.compliance.status).toBe("gaps");
  expect(result.cancelledScope).toHaveLength(3);
  expect(result.cancelledScope[0].cancel).toMatchObject({ kind, origin: "model", requestId: "request-change1" });
  expect(rows(host).some(row => row.id === "change1" && row.status === "cancelled")).toBe(true);
  expect(host.records().some((record: any) => record.kind === "loop" && record.body.cancelledScope?.length === 3)).toBe(true);
});

test.each(["complete", "continue", "gaps"])("execute lets a running attempt settle %s but never dispatches another attempt", async status => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(1);
  let cancel = false, workerFinished = false, started!: () => void, settle!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { settle = resolve; });
  host.setRespond(async (call, normal) => {
    if (call.agent === "pitako.request-observer") {
      if (cancel) expect(workerFinished).toBe(true);
      return page(call, cancel ? [request()] : []);
    }
    if (call.agent === "pitako.worker" && call.key.includes(".t1.")) {
      started(); await release; workerFinished = true;
      const value = host.worker(call);
      return host.result(call, { ...value, status,
        ...(status !== "complete" ? { remaining: ["Required check pending"], continuation: "Finish the required check" } : {}) });
    }
    return normal();
  });
  const execution = host.executeNative();
  await running;
  const before = host.calls.length;
  cancel = true;
  expect(host.calls).toHaveLength(before); // No interruption or observer while the attempt is live.
  settle();
  const result = await execution;
  expect(result.status, result.reason).toBe(status === "complete" ? "complete" : "partial");
  expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key.includes(".t1."))).toHaveLength(1);
  expect(host.current().tasks.change1.cancel.origin).toBe("model");
  const final = rows(host).filter(row => row.id === "change1").at(-1);
  expect(final.status).toBe(status === "complete" ? "completed" : "cancelled");
  if (status === "complete") expect(rows(host).filter(row => row.id === "change1").some(row => row.status === "cancelled")).toBe(false);
});

test("execute drains observation pages and replayed records do not replace the original cancellation", async () => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(1);
  const original = request(); let observed = 0;
  host.setRespond((call, normal) => {
    if (call.agent === "pitako.request-observer") {
      observed++;
      const cursor = JSON.parse(call.task).cursor;
      return cursor === 0 ? page(call, [original], 1) : page(call, [{ ...original, requestId: "duplicate", kind: "delete" }]);
    }
    if (call.agent === "pitako.worker") expect(host.current().tasks.change1.cancel.requestId).toBe(original.requestId);
    return normal();
  });
  expect((await host.execute()).status).toBe("partial");
  expect(observed).toBeGreaterThan(2);
  expect(host.current().tasks.change1.cancel).toEqual({ requestId: original.requestId, origin: "model", kind: "cancel",
    reason: "cancelled by main-session request (origin: model; cancel)" });
  expect(Object.keys(host.current().excludedScope)).toEqual(["change1"]);
});

test("execute cancellation persistence failure prevents action and emission", async () => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(1);
  host.setRespond((call, normal) => call.agent === "pitako.request-observer" ? page(call, [request()]) : normal());
  host.setFailSave(value => !!value.tasks?.change1?.cancel);
  const result = await host.execute();
  expect(result.status).toBe("partial");
  expect(result.reason).toContain("Essential persistence failed");
  expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
  expect(host.current().tasks.change1.cancel).toBeUndefined();
  expect(rows(host).some(row => row.status === "cancelled")).toBe(false);
});

test("execute carries excluded cancelled scope to later directors and cannot claim fulfillment", async () => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(2);
  host.setRespond((call, normal) => {
    if (call.agent === "pitako.request-observer") return page(call, [request("delete")]);
    const result = normal();
    if (call.key === "invoke-human-1.l2.director") {
      expect(call.task).toContain("EXCLUDED SCOPE (not human intent");
      expect(call.task).toContain('"scope":["src/change1.ts"]');
      expect(call.task).toContain("cancelled by main-session request (origin: model; delete)");
      result.structuredOutput.tasks = result.structuredOutput.tasks.filter((task: any) => task.id !== "change1");
    }
    return result;
  });
  const result = await host.execute();
  expect(result.loopsConsumed).toBe(2);
  expect(result.status, result.reason).toBe("partial");
  expect(result.cancelledScope).toHaveLength(1);
  expect(host.calls.filter(call => call.agent === "pitako.worker").every(call => !call.key.includes(".l1.t1."))).toBe(true);
  expect(host.current().loop.compliance.reason).toContain("cancelled by main-session request (origin: model; delete)");
});

test("execute failed request observer cannot silently dispatch a worker", async () => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(1);
  host.setRespond((call, normal) => call.agent === "pitako.request-observer"
    ? { ...page(call, []), output: JSON.stringify({ version: 1, ok: false, reason: "malformed file" }) } : normal());
  const result = await host.execute();
  expect(result.status).toBe("blocked");
  expect(result.reason).toContain("malformed file");
  expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
});


test.each(["stopped", "permission", "interrupted"])("execute honors %s before request reads and suppresses cancelled continuation", async mode => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(1);
  let writerReturned = false, readsAfterWriter = 0;
  host.setRespond((call, normal) => {
    if (call.agent === "pitako.request-observer") {
      if (writerReturned) readsAfterWriter++;
      return page(call, writerReturned ? [request()] : []);
    }
    if (call.agent === "pitako.worker" && call.key.endsWith(".t1.a1")) {
      writerReturned = true;
      return { ...normal(), ok: false, structuredOutput: undefined, results: [],
        ...(mode === "permission" ? { error: "Blocked by pi-subagents permission rule: worker denied." }
          : mode === "stopped" ? { stopped: true } : { state: "interrupted" }) };
    }
    return normal();
  });
  const result = await host.executeNative();
  expect(result.status).not.toBe("complete");
  expect(host.calls.filter(call => call.key.endsWith(".resume"))).toHaveLength(0);
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  expect(readsAfterWriter).toBe(mode === "interrupted" ? 1 : 0);
  if (mode === "interrupted") expect(host.current().tasks.change1.cancel.origin).toBe("model");
});

test("execute observes a new request immediately before a useful retry", async () => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(1);
  host.setRespond((call, normal) => {
    if (call.agent === "pitako.request-observer")
      return page(call, host.current().loop.attempt?.number === 2 ? [request()] : []);
    if (call.agent === "pitako.worker" && call.key.endsWith(".t1.a1"))
      return host.result(call, { ...host.worker(call), status: "continue", remaining: ["Finish required check"],
        continuation: "Finish the required check" });
    return normal();
  });
  expect((await host.executeNative()).status).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key.includes(".t1."))).toHaveLength(1);
  expect(host.current().tasks.change1.cancel.origin).toBe("model");
  expect(rows(host).filter(row => row.id === "change1").at(-1).status).toBe("cancelled");
});


test.each(["cancel", "delete"])("execute observes %s before admitting a recovered successful attempt and cancels dependents", async kind => {
  for (const recovery of ["status", "inspector"]) {
    const host = fixture(undefined, { readOnly: true, taskCount: 2 }); host.setLimit(1);
    let pending = false;
    host.setRespond((call, normal) => {
      if (call.agent === "pitako.request-observer") return page(call, pending ? [request(kind)] : []);
      const result = normal();
      if (call.agent === "pitako.execution-director")
        result.structuredOutput.tasks[1].dependsOn = [{ taskId: "change1", reason: "Requires implementation" }];
      if (call.agent === "pitako.worker" && call.key.endsWith(".t1.a1")) pending = true;
      if (call.phase === "recovery" && call.task.includes("EXCEPTIONAL READ-ONLY attempt-result")) {
        const worker = host.native.get("invoke-human-1.l1.t1.a1")!;
        Object.assign(result.structuredOutput, { status: "recovered", workerResult: copy(worker.structuredOutput) });
      }
      if (call.key.endsWith(".compliance")) {
        expect(call.task).toContain("cancelled by main-session request");
        expect(call.task).toContain('"origin":"model"');
        expect(call.task).toContain('"cascadeFrom":"change1"');
      }
      return result;
    });
    // Lose the controller after the worker has settled but before its result is admitted.
    cutAt(host, value => !!value.loop?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    expect(pending).toBe(true);
    expect(host.current().tasks.change1.completed).toBeFalsy();
    expect(host.current().tasks.change1.cancel).toBeUndefined();
    host.setStatus(ref => recovery === "inspector" && ref.includes(".t1.a1")
      ? { ok: false, results: [], output: "Worker result needs recovery" }
      : copy(host.native.get(ref)!));
    const result = await host.executeNative();
    expect(host.current().tasks.change1.completed).toBeTruthy();
    expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key.includes(".t1."))).toHaveLength(1);
    expect(host.calls.some(call => call.agent === "pitako.worker" && call.key.includes(".t2."))).toBe(false);
    expect(result.status, result.reason).toBe("partial");
    expect(host.current().tasks.change2.cancel).toMatchObject({ cascadeFrom: "change1", origin: "model", kind,
      requestId: "request-change1", reason: "cancelled by main-session request (origin: model; dependency: change1)" });
    expect(host.current().excludedScope.change2.cancel).toEqual(host.current().tasks.change2.cancel);
    expect(host.current().loop.compliance.status).toBe("gaps");
    expect(host.current().loop.compliance.reason).toContain("cancelled by main-session request (origin: model; dependency: change1)");
    expect(result.cancelledScope.find((task: any) => task.id === "change2").cancel.cascadeFrom).toBe("change1");
    expect(rows(host).filter(row => row.id === "change1").at(-1).status).toBe("completed");
    expect(rows(host).filter(row => row.id === "change2").at(-1).status).toBe("cancelled");
  }
});
