import { expect, test } from "bun:test";
import { copy, executeControllerFixture } from "./fixtures/execute-workflow.ts";

const { fixture: createFixture } = executeControllerFixture();
function fixture(options: Parameters<typeof createFixture>[1] = {}) {
  const host = createFixture(undefined, options);
  // These tests exercise grouped close, which is retained for tasks without journaled writes.
  host.setRespond((request, normal) => request.agent === "pitako.worker"
    ? host.result(request, { status: "complete", work: "Read-only task", remaining: [] }) : normal());
  return host;
}
const continuation = { unblock: true, resolution: { loop: 1, text: "Continue this interrupted operation under current native policy." } };

test.each(["close", "drain"])("interrupted grouped %s resumes the retained intention after fresh human input", async operation => {
  const host = fixture(); host.setLimit(1);
  let interrupted = false;
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (!interrupted && request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === operation) {
      interrupted = true;
      return { ...result, ok: false, stopped: true };
    }
    return result;
  });
  expect((await host.execute()).status).toBe("cancelled");
  const retained = copy(host.current()), count = host.launches.length;
  expect(retained.loop.halt.ref.agent).toBe("pitako.loop-io");
  expect((await host.execute()).status).toBe("cancelled");
  expect(host.launches).toHaveLength(count);
  host.setStatus(ref => {
    const retained = host.native.get(ref);
    return retained?.agent === "pitako.loop-io" ? { ...retained, ok: true, stopped: false }
      : retained ?? { ok: true, state: "unknown" };
  });
  host.setLaunchRespond();
  const result = await host.execute(continuation);
  expect(result.status, result.reason).toBe("partial");
  expect(host.launches.slice(count).some(call => call.key === `${retained.loop.halt.ref.key}.r1`)).toBe(true);
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "loop"]);
  expect(host.current().tasks.change1.completed).toEqual({ taskId: "change1", attempt: 1 });
  expect(result.loopReport.work).toContainEqual(expect.objectContaining({ taskId: "change1", attempt: 1, status: "complete" }));
  expect(host.current().intentions).toEqual([]);
});

test.each(["running", "permission", "capacity", "wrong-run", "wrong-agent"])(
  "grouped close recovery preserves current %s barrier without redispatch", async mode => {
    const host = fixture(); host.setLimit(1);
    host.setLaunchRespond(async (request, normal) => {
      const result = await normal();
      return request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "close"
        ? { ...result, ok: false, stopped: true } : result;
    });
    expect((await host.execute()).status).toBe("cancelled");
    const count = host.launches.length;
    host.setStatus(ref => {
      if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      if (mode === "capacity") throw Error("Active async run capacity exhausted: 1/1 used.");
      return { ok: true, runId: mode === "wrong-run" ? "other-run" : ref,
        agent: mode === "wrong-agent" ? "pitako.worker" : "pitako.loop-io",
        state: mode === "running" ? "running" : "complete" };
    });
    const result = await host.execute(continuation);
    expect(result.status).not.toBe("complete");
    expect(host.launches).toHaveLength(count);
    expect(host.current().lastConfirmed).toBeNull();
  });

test("a historical grouped permission denial cannot be erased by human continuation", async () => {
  const host = fixture(); host.setLimit(1);
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    return request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "close"
      ? { ...result, ok: false, error: "Blocked by pi-subagents permission rule: 'run' is denied." } : result;
  });
  expect((await host.execute()).status).toBe("blocked");
  const count = host.launches.length;
  host.setStatus(ref => ({ ok: true, runId: ref, state: "complete" }));
  expect((await host.execute(continuation)).status).toBe("blocked");
  expect(host.launches).toHaveLength(count);
});

test.each(["running", "permission", "capacity"])("a lost grouped dispatch receipt observes %s before any retry", async mode => {
  const host = fixture(); host.setLimit(1);
  let closeKey = "";
  host.setLaunchRespond((request, normal) => {
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "close") {
      closeKey = request.key;
      throw Error("Native transport disappeared");
    }
    return normal();
  });
  host.setStatus(ref => {
    if (ref !== closeKey) return host.native.get(ref) ?? { ok: true, state: "unknown" };
    if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
    if (mode === "capacity") throw Error("Active async run capacity exhausted: 1/1 used.");
    return { ok: true, runId: ref, state: "running" };
  });
  expect((await host.execute()).status).not.toBe("complete");
  expect(host.statusCalls).toContain(closeKey);
  expect(host.launches.filter(call => call.key.startsWith(closeKey))).toHaveLength(1);
});

test.each(["structured", "management"])("pending grouped seal observes its exact close run with %s status", async mode => {
  const host = fixture(); host.setLimit(1);
  host.setFailSave(value => !!value.loop?.attempt?.seal?.retry && value.loop.attempt.stage !== "result");
  expect((await host.execute()).status).toBe("partial");
  const close = copy(host.current().loop.attempt.close.ref), count = host.launches.length;
  host.setFailSave();
  host.setStatus(ref => ref === close.runId ? mode === "structured"
    ? { ok: true, runId: ref, agent: "pitako.loop-io", state: "running" }
    : { ok: true, output: `Run: ${ref}\nState: running`, results: [] }
    : host.native.get(ref) ?? { ok: true, state: "unknown" });
  expect((await host.execute()).status).toBe("blocked");
  expect(host.statusCalls).toContain(close.runId);
  expect(host.launches).toHaveLength(count);
});

test("an interrupted close retry observes the in-flight retry rather than its failed predecessor", async () => {
  const host = fixture(); host.setLimit(1);
  let closeKey = "";
  let retryRunning = false;
  host.setLaunchRespond((request, normal) => {
    if (request.agent !== "pitako.loop-io" || JSON.parse(request.task).operation !== "close") return normal();
    closeKey ||= request.key;
    if (request.key === closeKey) return {
      ...host.result(request, {}), ok: false, key: request.key,
      output: JSON.stringify({ error: "loop-io", reason: "Transient close failure" }),
    };
    retryRunning = true;
    throw Error("Native transport disappeared while retry is running");
  });
  host.setStatus(ref => retryRunning && ref === `${closeKey}.r1`
    ? { ok: true, runId: ref, agent: "pitako.loop-io", state: "running" }
    : host.native.get(ref) ?? { ok: true, state: "unknown" });
  expect((await host.execute()).status).toBe("blocked");
  const count = host.launches.length;
  expect(host.launches.filter(call => call.key.startsWith(closeKey)).map(call => call.key))
    .toEqual([closeKey, `${closeKey}.r1`]);
  const observed = host.statusCalls.length;
  expect((await host.execute()).status).toBe("blocked");
  expect(host.statusCalls.slice(observed)).toContain(`${closeKey}.r1`);
  expect(host.launches).toHaveLength(count);
  expect(host.current().lastConfirmed).toBeNull();
});

test("a saved close transport cannot admit a candidate changed before replay", async () => {
  const host = fixture({ realCheckout: true }); host.setLimit(1);
  host.setFailSave(value => !!value.loop?.attempt?.close?.admitted && !value.loop.attempt.seal);
  expect((await host.execute()).status).toBe("partial");
  expect(host.current().loop.attempt.close.stage).toBe("receipt");
  expect(host.current().loop.attempt.gate.stage).toBe("receipt");
  const count = host.launches.length;
  host.setFailSave();
  host.changeCheckout();
  const result = await host.execute();
  expect(result.status, result.reason).toBe("blocked");
  expect(host.current().loop.halt.code).toBe("recovery");
  expect(host.launches).toHaveLength(count);
  expect(host.current().lastConfirmed).toBeNull();
  expect(host.current().loop.attempt.stage).not.toBe("result");
  expect(host.current().intentions ?? []).toEqual([]);
  expect(host.records()).toEqual([]);
});

test("a legacy re-seal dispatched after a grouped close is observed before any further seal", async () => {
  const host = fixture(); host.setLimit(1);
  host.setFailSave(value => !!value.loop?.attempt?.seal?.retry && value.loop.attempt.stage !== "result");
  expect((await host.execute()).status).toBe("partial");
  host.setFailSave();
  const attempt = host.current().loop.attempt, legacy = `${attempt.key}.seal.r1`;
  // The grouped close consumed seal index 0; a cleared halt then dispatched the legacy `.seal.r1`.
  expect(attempt.close.dispatched).toBe(true);
  attempt.seal = { retry: 2, kind: "unit" };
  host.setStatus(ref => ref === legacy ? { ok: true, runId: ref, agent: "pitako.checkpoint-sealer", state: "running" }
    : host.native.get(ref) ?? { ok: true, state: "unknown" });
  const count = host.launches.length;
  expect((await host.execute()).status).toBe("blocked");
  expect(host.statusCalls).toContain(legacy);
  expect(host.launches).toHaveLength(count);
});

test("a cut after grouped sealing reuses the receipt without another close or worker", async () => {
  const host = fixture(); host.setLimit(1);
  host.setFailSave(value => !!value.loop?.attempt?.seal?.retry && value.loop.attempt.stage !== "result");
  expect((await host.execute()).status).toBe("partial");
  const count = host.launches.length;
  host.setFailSave();
  const result = await host.execute();
  expect(result.status, result.reason).toBe("partial");
  expect(host.launches.slice(count).every(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "drain")).toBe(true);
  expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "loop"]);
  expect(host.current().tasks.change1.completed).toEqual({ taskId: "change1", attempt: 1 });
  expect(result.loopReport.work).toContainEqual(expect.objectContaining({ taskId: "change1", attempt: 1, status: "complete" }));
});

test.each(["pitako.checkpoint-sealer", "pitako.execution-ledger"])("retained legacy %s references still reconcile", async agent => {
  const host = createFixture(); host.setLimit(1);
  host.setFailSave(value => agent === "pitako.checkpoint-sealer"
    ? !!value.loop?.attempt?.seal?.retry && value.loop.attempt.stage !== "result"
    : value.intentions?.some((entry: any) => entry.operation === "ledger" && entry.input.record.kind === "unit"));
  expect((await host.execute()).status).toBe("partial");
  host.setFailSave();
  const state = host.current(), attempt = state.loop.attempt;
  const key = agent === "pitako.checkpoint-sealer" ? `${attempt.key}.seal` : "invoke-human-1.l1.seal1";
  // Model retained pre-grouping metadata using the real checkpoint/gate evidence.
  if (agent === "pitako.checkpoint-sealer") {
    delete attempt.close;
    attempt.seal = { retry: 1, kind: "unit" };
  } else {
    expect(state.sealPending).toBeDefined();
    state.sealPending.retry = 1;
  }
  state.loop.halt = { status: "cancelled", code: "native-barrier", cause: "stopped", reason: "Retained legacy Stop",
    ref: { key, agent, runId: `legacy-${key}` } };
  host.setStatus(ref => ref === `legacy-${key}` ? { ok: true, runId: ref, agent, state: "complete" }
    : host.native.get(ref) ?? { ok: true, state: "unknown" });
  const count = host.launches.length;
  const result = await host.execute(continuation);
  expect(result.status, result.reason).toBe("partial");
  expect(host.statusCalls).toContain(`legacy-${key}`);
  expect(host.launches.slice(count).some(call => call.agent === agent && call.key === `${key}.r1`)).toBe(true);
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  // Only loop-io carries the fixed idle control; the standalone sealer and ledger never do.
  const standalone = host.launches.filter(call => call.agent === agent);
  expect(standalone.length).toBeGreaterThan(0);
  for (const call of standalone) expect(call).not.toHaveProperty("control");
});
