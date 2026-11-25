import { describe, expect, test } from "bun:test";
import { executeControllerFixture, cutAt, source } from "./fixtures/execute-workflow.ts";
import { executeStore } from "../skills/execute/ledger.mjs";
import { pitakoAgentFamily } from "../skills/agent-names.mjs";

const { fixture } = executeControllerFixture();
const tip = (host: ReturnType<typeof fixture>) => {
  const { invocation, epoch } = host.current();
  const { store, scope } = executeStore(host.root, invocation, false, epoch);
  return [...store.readRecords(scope).records];
};
const archives = (host: ReturnType<typeof fixture>): ReturnType<typeof import("../skills/execute/ledger.mjs").verifyLedger> => host.records();
const drainKey = "invoke-human-1.l1.finishDrain";

describe("fused loop ledger publication", () => {
  test("seal and loop records share the control-field projection without altering live state", async () => {
    const host = fixture(); host.setLimit(2);
    const script = source.replace("if (value?.checkpointReceipt) prepareSeal(projected);", `if (value?.checkpointReceipt) {
      projected.halt = taskState.completed.halt = { reason: "historical Stop" };
      loop.attempt.interruption = { currentBarrier: { cause: "stopped" } };
      prepareSeal(projected);
      if (taskState.completed?.halt?.reason !== "historical Stop" || loop.attempt.interruption?.currentBarrier?.cause !== "stopped")
        throw Error("Ledger projection mutated live control evidence");
    }`);
    expect(script).not.toBe(source);
    expect((await host.execute({}, script)).status).toBe("complete");
    const records = host.records().filter((record: any) => record.kind !== "spec");
    expect(records.map((record: any) => record.kind)).toEqual(["unit", "loop", "loop"]);
    for (const record of records)
      expect(JSON.stringify(record.body)).not.toMatch(/"(halt|interruption|interruptions|currentBarrier|hostHalt|failedHostObservation)"\s*:/);
    expect([...host.storage.keys()]).toEqual(["pitako-execute"]);
  });



  test("checkout drift after a published crash cannot confirm the changed candidate or publish another close", async () => {
    const host = fixture(undefined, { realCheckout: true, taskCount: 0 }); host.setLimit(1);
    const observed = host.observedCandidate();
    let published: ReturnType<typeof tip> | undefined;
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.checkout-observer" && !published) {
        published = tip(host);
        host.changeCheckout();
        throw Error("Crash after publication");
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status, output.reason).toBe("blocked");
    expect(output.reason).toContain("publication conflict: replay-differs");
    expect(output.reason).not.toMatch(/human reconciliation|new mission/i);
    expect(host.observedCandidate()).not.toEqual(observed);
    expect(published).toBeDefined();
    expect(tip(host)).toEqual(published!);
    expect(archives(host)).toEqual([]);
    expect(host.current().loop.outcome).toBeNull();
    const calls = host.calls.filter(call => call.agent === "pitako.checkout-observer");
    expect(calls.map(call => call.key)).toEqual(["invoke-human-1.l1.checkout", "invoke-human-1.l1.checkout.r1"]);
    expect(calls[1].task).toBe(calls[0].task);
  });

  test.each(["spawn", "unpublished", "unpublished-relaunch", "published-crash", "stdout", "state-save"])(
    "transient observer %s reconciles automatically", async failure => {
      const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
      const checkoutKey = "invoke-human-1.l1.checkout";
      let injected = false;
      host.setRespond((request, normal) => {
        if (request.agent !== "pitako.checkout-observer" || injected || failure === "state-save") return normal();
        injected = true;
        if (failure === "spawn") throw Error("Temporary observer spawn failure");
        if (failure.startsWith("unpublished")) return { ...host.result(request, null), ok: false, output: "Observer exited before publication" };
        const result = normal();
        if (failure === "published-crash") throw Error("Observer died after publication");
        return { ...result, output: "{" };
      });
      if (failure === "state-save") host.setFailSave(value => {
        if (injected || value.loop?.phase !== "closing" ||
            !tip(host).some(row => row.kind === "ledger" && row.seq <= value.head.seq)) return false;
        injected = true; return true;
      });
      if (failure === "unpublished-relaunch") {
        host.setFailSave(() => host.native.has(checkoutKey));
        await host.execute();
        expect(host.launches.filter(call => call.agent === "pitako.checkout-observer").map(call => call.key)).toEqual([checkoutKey]);
        expect(tip(host).some(row => row.kind === "ledger")).toBe(false);
        host.setFailSave();
        const { runId } = host.native.get(checkoutKey)!;
        host.setStatus(ref => ref === runId
          ? { ok: true, runId, output: `Run: ${runId}\nState: failed`, results: [] }
          : host.native.get(ref) ?? { ok: true, results: [] });
      }
      const output = failure === "unpublished-relaunch" ? await host.executeNative() : await host.execute();
      expect(injected).toBe(true);
      expect(output.status, output.reason).toBe("complete");
      expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "loop"]);
      const record = host.records()[1];
      expect(record.body.observation.checkout).toEqual(host.observedCandidate());
      expect(record.body).not.toHaveProperty("outcome");
      expect(record.body).not.toHaveProperty("endedAt");
      expect(record.body).not.toHaveProperty("observation.ledger");
      expect(host.current()).toMatchObject({ version: 10, action: { kind: "terminal" } });
      expect(host.emits.some(item => ["blocked", "cancelled"].includes(item.status))).toBe(false);
      const calls = host.launches.filter(call => call.agent === "pitako.checkout-observer");
      expect(calls.map(call => call.key)).toEqual(failure === "state-save" ? [checkoutKey] : [checkoutKey, `${checkoutKey}.r1`]);
      if (failure === "unpublished-relaunch") {
        expect(calls[1].task).toBe(calls[0].task);
        expect(host.launches.some(call => call.key.endsWith(".closing-replay.r1"))).toBe(false);
        expect(tip(host).filter(row => row.kind === "ledger")).toHaveLength(1);
      }
    });

  test.each(["rejected-plan", "invalid-worker", "stalled-continuation", "before-selection-no-preview", "after-selection-no-preview"])(
    "task-loop gaps archive %s with only admitted seals before exhausting the last slot", async path => {
      const host = fixture(); host.setLimit(1);
      const noPreview = path.endsWith("-no-preview");
      if (noPreview) {
        if (path === "before-selection-no-preview") host.setSaveObserver(value => {
          if (value.action?.role === "execution-director" && value.action.runId)
            throw Error("Cut before the selection writer");
        });
        else cutAt(host, value => value.loop?.attempt?.stage === "intention");
        expect((await host.execute()).status).not.toBe("complete");
        host.setSaveObserver(undefined);
        host.setFailSave();
        for (const result of host.native.values()) if (result.agent === "pitako.execution-director") delete result.structuredOutput;
      }
      const directorCount = host.launches.filter(call => call.agent === "pitako.execution-director").length;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.execution-director" && path === "rejected-plan") result.structuredOutput.select = "missing";
        if (request.agent === "pitako.worker" && path === "invalid-worker")
          result.structuredOutput = { status: "invalid" };
        if (request.agent === "pitako.worker" && path === "stalled-continuation")
          result.structuredOutput = { ...result.structuredOutput, status: "continue", remaining: ["Pending defect"] };
        return result;
      });
      const output = await host.execute();
      expect(output.status, output.reason).toBe("partial");
      expect(host.current().loop.outcome, output.reason).toBe("gaps");
      const pauses = path === "stalled-continuation" ? 4 : noPreview ? 1 : 0;
      if (noPreview) expect(host.launches.filter(call => call.agent === "pitako.execution-director")).toHaveLength(directorCount);
      expect(host.records().map((record: any) => record.kind)).toEqual(["spec", ...Array(pauses).fill("unit"), "loop"]);
      if (path === "stalled-continuation") expect(host.records().filter((record: any) => record.kind === "unit").every((record: any) => record.body.result.status === "continue")).toBe(true);
      expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(0);
      expect(host.calls.filter(call => call.key === "invoke-human-1.l1.gaps")).toHaveLength(1);
      const calls = host.calls.length;
      await host.execute();
      expect(host.calls).toHaveLength(calls);
    });

  test.each(["spawn", "published-crash", "stdout", "state-save"])("gaps archiver retries transient %s without a halt", async failure => {
    const host = fixture(); host.setLimit(1);
    let injected = false;
    host.setLaunchRespond(async (request, normal) => {
      if (request.key !== drainKey || injected || failure === "state-save") return normal();
      injected = true;
      if (failure === "spawn") throw Error("Temporary archiver spawn failure");
      const result = await normal();
      if (failure === "published-crash") throw Error("Archiver died after COMMIT");
      return { ...result, output: "{" };
    });
    if (failure === "state-save") host.setFailSave(value => {
      if (injected || value.action.kind !== "terminal") return false;
      injected = true; return true;
    });
    const output = await host.execute();
    expect(injected).toBe(true);
    expect(output.status, output.reason).toBe("partial");
    expect(host.current()).toMatchObject({ budget: { consumedLoops: 1, maxCycles: 1 }, action: { kind: "terminal" }, halt: null });
    expect(archives(host).map(record => record.kind)).toEqual(["spec", "unit", "loop"]);
    expect(host.calls.filter(call => call.agent === "pitako.execution-ledger").map(call => call.key))
      .toEqual(["invoke-human-1.l1.seal1", "invoke-human-1.l1.gaps"]);
    const drains = host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).operation === "drain");
    expect(drains.map(call => call.key)).toEqual(failure === "state-save" ? [drainKey] : [drainKey, `${drainKey}.r1`]);
    expect(new Set(drains.map(call => call.task)).size).toBe(1);
  });

  test("exhausted gaps admission saves retain the committed drain and do not republish", async () => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") result.structuredOutput.select = "missing";
      return result;
    });
    host.setFailSave(value => value.action.kind === "terminal");
    expect((await host.execute()).reason).toContain("Essential persistence failed");
    const retained = structuredClone(host.current()), committed = tip(host);
    expect(retained.action).toMatchObject({ kind: "pending", op: "drain", opKey: drainKey });
    expect(host.records()).toHaveLength(0);
    const firstDrain = host.launches.find(call => call.key === drainKey)!;
    const publications = () => host.calls.filter(call => call.agent === "pitako.execution-ledger").map(call => call.key);
    expect(publications()).toEqual(["invoke-human-1.l1.gaps"]);
    host.setFailSave();
    const admissions = host.launches.length;
    expect((await host.execute()).status).toBe("partial");
    expect(host.current().action).toEqual({ kind: "terminal" });
    expect(host.current().budget).toEqual(retained.budget);
    expect(tip(host)).toEqual(committed);
    expect(publications()).toEqual(["invoke-human-1.l1.gaps"]);
    expect(host.launches.slice(admissions)).toEqual([firstDrain]);
    expect(archives(host).map(record => record.kind)).toEqual(["spec", "loop"]);
  });

  test.each([false, true])("a committed gaps intent binds the archive across a before-dispatch cut; reference mutation=%s", async mutate => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") result.structuredOutput.select = "missing";
      return result;
    });
    host.setSaveObserver(value => {
      if (value.action.opKey === drainKey) throw Error("Cut before drain dispatch");
    });
    expect((await host.execute()).status).toBe("partial");
    const retained = host.current();
    expect(retained.action).toMatchObject({ kind: "pending", op: "drain", opKey: drainKey });
    const row = tip(host).find(row => row.opKey === `final-drain:${drainKey}`)!;
    expect(retained.action.input).toEqual({ seq: row.seq, digest: row.digest });
    expect(host.launches.some(call => call.key === drainKey)).toBe(false);
    host.setSaveObserver(undefined);
    if (mutate) retained.action.input.digest = "0".repeat(64);
    const output = await host.execute();
    if (mutate) {
      expect(output.status, output.reason).toBe("blocked");
      expect(host.records()).toEqual([]);
      expect(host.calls.some(call => call.agent === "pitako.execution-ledger")).toBe(false);
    } else {
      expect(output.status, output.reason).toBe("partial");
      expect(host.launches.filter(call => call.key === drainKey)).toHaveLength(1);
      const archive = archives(host).find(record => record.kind === "loop");
      expect(archive?.body.plan?.rejection?.diagnostic).toBe("Selected task must be pending");
      expect(host.current().action).toEqual({ kind: "terminal" });
    }
  });

  test.each(["director-permission", "worker-block", "exception", "stop"])("%s halts without archiving a loop", async halt => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director" && halt === "director-permission")
        return { ...result, ok: false, error: "Blocked by pi-subagents permission rule: director denied" };
      if (request.agent === "pitako.worker") {
        if (halt === "exception") throw Error("Unresolved writer observation");
        if (halt === "stop") return { ...result, stopped: true };
        if (halt === "worker-block") result.structuredOutput = { ...result.structuredOutput, status: "blocked", remaining: ["Human decision required"] };
      }
      return result;
    });
    expect((await host.execute()).status).not.toBe("complete");
    expect(host.records().map((record: any) => record.kind)).toEqual(halt === "worker-block" ? ["spec", "unit"] : []);
    if (halt === "worker-block") expect(host.records()[1].body.result.status).toBe("blocked");
    expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(0);
    expect(host.current().halt).toMatchObject({ stage: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  const isPrepare = (request: any) => pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "prepare";
  const overflow = (request: any, normal: () => any): any => isPrepare(request) ? { ...normal(), ok: false,
    output: JSON.stringify({ error: "loop-io", reason: "HUMAN + DECISION overflow: ask the human to consolidate", viewOverflow: true }) } : normal();
  test.each([false, true])("pre-director view overflow is terminal even if the Board view changes (overflow persists: %s)", async persists => {
    const host = fixture(); host.setLimit(1);
    host.setRespond(overflow);
    const blocked = await host.execute();
    expect(blocked.status, blocked.reason).toBe("blocked");
    expect(blocked.reason).toContain("consolidate");
    expect(blocked.loopReport.halt.code).toBe("view-overflow");
    const launches = [...host.launches], cursor = host.current();
    if (!persists) host.setRespond();
    const held = await host.execute();
    expect(held.status, held.reason).toBe("blocked");
    expect(held.loopReport.halt).toEqual(blocked.loopReport.halt);
    expect(host.current()).toEqual(cursor);
    expect(host.launches).toEqual(launches);
    expect(host.calls.filter(isPrepare)).toHaveLength(1);
    expect(host.calls.some(call => ["pitako.execution-director", "pitako.worker"].includes(call.agent!))).toBe(false);
  });

  test.each(["close", "gaps"])("a native Stop during %s cannot be retried without new human input", async phase => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
    host.setRespond((request, normal) => {
      if (request.agent === (phase === "close" ? "pitako.checkout-observer" : "pitako.execution-ledger"))
        return { ...host.result(request, null), stopped: true, ok: false };
      const result = normal();
      if (phase === "gaps" && request.agent === "pitako.execution-director") result.structuredOutput.select = "missing";
      return result;
    });
    const stopped = await host.execute();
    expect(stopped.status).toBe("cancelled");
    const calls = host.calls.length, launches = host.launches.length, cursor = structuredClone(host.current());
    const held = await host.execute();
    expect(held.status, held.reason).toBe("cancelled");
    const cause = (reason: string) => reason.replace(/^Execution cancelled: /, "");
    expect(cause(held.reason)).toBe(cause(stopped.reason));
    expect(host.calls).toHaveLength(calls);
    expect(host.launches).toHaveLength(launches);
    expect(host.current()).toEqual(cursor);
    expect(host.records()).toEqual([]);
    expect(host.current().halt).not.toBeNull();
  });
});

// pi-subagents rejects these launch fields for runner.type='external-cli'
// (acceptance:false included) before any process starts.
test("external-cli ledger and observer launches carry no field that runner rejects", async () => {
  const host = fixture(undefined, { findings: true }); host.setLimit(2);
  expect((await host.execute()).status).toBe("complete");
  const external = host.calls.filter(call => ["pitako.execution-ledger", "pitako.checkout-observer"].includes(call.agent!));
  expect(new Set(external.map(call => call.agent))).toEqual(new Set(["pitako.execution-ledger", "pitako.checkout-observer"]));
  for (const call of external as any[]) {
    for (const field of ["acceptance", "agentContract", "toolBudget", "model", "fast"]) expect(call, call.key).not.toHaveProperty(field);
    expect(call.outputSchema === undefined || call.outputSchema === false, call.key).toBe(true);
  }
});
