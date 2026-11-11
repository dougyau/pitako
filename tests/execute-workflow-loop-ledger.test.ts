import { describe, expect, test } from "bun:test";
import { executeControllerFixture, cutAt, source, closedInterruptedProducer } from "./fixtures/execute-workflow.ts";

import { restoreCheckpoint } from "../extensions/execute-checkpoint.ts";

const { fixture } = executeControllerFixture();

describe("fused loop ledger publication", () => {
  test("seal and loop records share the control-field projection without altering live state", async () => {
    const host = fixture(); host.setLimit(2);
    let preservedLiveControl = false;
    host.setSaveObserver(value => {
      if (value.tasks?.change1?.completed?.halt?.reason === "historical Stop") preservedLiveControl = true;
    });
    const script = source.replace("if (value?.checkpointReceipt) prepareSeal(projected);", `if (value?.checkpointReceipt) {
      projected.halt = taskState.completed.halt = { reason: "historical Stop" };
      loop.attempt.interruption = { currentBarrier: { cause: "stopped" } };
      prepareSeal(projected);
    }`);
    expect(script).not.toBe(source);
    expect((await host.execute({}, script)).status).toBe("complete");
    const records = host.records().filter((record: any) => record.kind !== "spec");
    expect(records.map((record: any) => record.kind)).toEqual(["unit", "loop", "loop"]);
    for (const record of records)
      expect(JSON.stringify(record.body)).not.toMatch(/"(halt|interruption|interruptions|currentBarrier|hostHalt|failedHostObservation)"\s*:/);
    expect(preservedLiveControl).toBe(true);
  });

  test("a previously resolved Stop archives human history but not its live control evidence", async () => {
    const host = fixture(undefined, { realCheckout: true }); host.setLimit(2);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker" && request.key.includes(".l1.")) return closedInterruptedProducer(result, "stopped");
      return result;
    });
    expect((await host.execute()).status).toBe("cancelled");
    host.setStatus(ref => host.native.get(ref)!);
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.worker" && request.task.includes("CHECKPOINT FALLBACK")) {
        const fallback = JSON.parse(request.task.split("CHECKPOINT FALLBACK (same pending task, not a metadata repair):\n")[1]!.split("\n")[0]!);
        restoreCheckpoint(fallback.checkpoint, fallback.authority);
      }
      return normal();
    });
    const output = await host.execute({ unblock: true, resolution: { loop: 1, text: "Continue after the resolved Stop." } });
    expect(output.status, output.reason).toBe("complete");
    const body = host.records().find((record: any) => record.kind === "loop" && record.loop === 1).body;
    expect(body.resolutions[0]).toMatchObject({ loop: 1, stage: "applied", text: "Continue after the resolved Stop." });
    expect(body.resolutions[0].request).toBeDefined();
    expect(JSON.stringify(body)).not.toMatch(/"(halt|interruption|interruptions|currentBarrier|hostHalt|failedHostObservation)"\s*:/);
    expect(host.history()[0].resolutions[0].halt).toBeDefined();
  });

  test("a changed observation after a published crash is a human-needed conflict, not another close", async () => {
    const host = fixture(undefined, { realCheckout: true, taskCount: 0 }); host.setLimit(1);
    let crashed = false;
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.checkout-observer" && !crashed) {
        crashed = true; host.changeCheckout();
        throw Error("Crash after publication");
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    expect(output.reason).toContain("Ledger integrity requires human reconciliation");
    expect(output.reason).toContain("publication conflict");
    expect(host.current().ledger).toEqual({ count: 0, head: null });
    expect(host.current().loop.outcome).toBeUndefined();
    expect(host.calls.filter(call => call.agent === "pitako.checkout-observer").map(call => call.key))
      .toEqual(["invoke-human-1.l1.checkout", "invoke-human-1.l1.checkout.r1"]);
  });

  test.each(["spawn", "unpublished", "published-crash", "stdout", "state-save"])(
    "transient observer %s reconciles automatically", async failure => {
      const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
      let injected = false;
      host.setRespond((request, normal) => {
        if (request.agent !== "pitako.checkout-observer" || injected || failure === "state-save") return normal();
        injected = true;
        if (failure === "spawn") throw Error("Temporary observer spawn failure");
        if (failure === "unpublished") return { ...host.result(request, null), ok: false, output: "Observer exited before publication" };
        const result = normal();
        if (failure === "published-crash") throw Error("Observer died after publication");
        return { ...result, output: "{" };
      });
      if (failure === "state-save") host.setFailSave(value => {
        if (injected || !value.loop?.closing) return false;
        injected = true; return true;
      });
      const output = await host.execute();
      expect(injected).toBe(true);
      expect(output.status, output.reason).toBe("complete");
      expect(host.current().ledger.count).toBe(2);
      expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "loop"]);
      const record = host.records()[1];
      expect(record.body.observation.checkout).toEqual(host.observedCandidate());
      expect(record.body).not.toHaveProperty("outcome");
      expect(record.body).not.toHaveProperty("endedAt");
      expect(record.body).not.toHaveProperty("observation.ledger");
      expect(host.current().loop.analysisCalls).toBeUndefined();
      expect(host.current().loop.usage).toEqual([]);
      expect(host.emits.some(item => ["blocked", "cancelled"].includes(item.status))).toBe(false);
      expect(host.calls.filter(call => call.agent === "pitako.checkout-observer").map(call => call.key))
        .toEqual(failure === "state-save" ? ["invoke-human-1.l1.checkout"] : ["invoke-human-1.l1.checkout", "invoke-human-1.l1.checkout.r1"]);
    });

  test.each(["rejected-plan", "invalid-worker", "stalled-continuation", "lost-published-plan", "lost-admitted-plan"])(
    "task-loop gaps archive %s with only admitted seals before exhausting the last slot", async path => {
      const host = fixture(); host.setLimit(1);
      if (path.startsWith("lost-")) {
        cutAt(host, value => path === "lost-published-plan" ? value.loop?.plan?.stage === "admitted" : value.loop?.attempt?.stage === "intention");
        expect((await host.execute()).status).not.toBe("complete");
        host.setFailSave();
        host.current().activePlan = null;
        for (const result of host.native.values()) if (result.agent === "pitako.execution-director") delete result.structuredOutput;
      }
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.execution-director" && path === "rejected-plan") result.structuredOutput.select = "missing";
        if (request.agent === "pitako.worker" && path === "invalid-worker")
          result.structuredOutput = { status: "invalid" };
        if (request.agent === "pitako.worker" && path === "stalled-continuation")
          result.structuredOutput = { ...result.structuredOutput, status: "continue", remaining: ["Pending defect"] };
        if (request.agent === "pitako.execution-inspector" && path.startsWith("lost-"))
          result.structuredOutput = { status: "lost", reason: "Exact complete original unavailable", original: null,
            workerResult: null, originalAvailable: false, binding: "absent", comparison: "neither", provenance: ["/native/original"] };
        return result;
      });
      const output = await host.execute();
      expect(output.status, output.reason).toBe("partial");
      expect(host.current().loop.outcome, output.reason).toBe("gaps");
      const pauses = path === "stalled-continuation" ? 4 : path === "lost-admitted-plan" ? 1 : 0;
      expect(host.current().ledger.count).toBe(2 + pauses);
      expect(host.records().map((record: any) => record.kind)).toEqual(["spec", ...Array(pauses).fill("unit"), "loop"]);
      if (path === "stalled-continuation") expect(host.records().filter((record: any) => record.kind === "unit").every((record: any) => record.body.result.status === "continue")).toBe(true);
      expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(0);
      expect(host.calls.filter(call => call.key === "invoke-human-1.l1.gaps")).toHaveLength(1);
      const calls = host.calls.length;
      await host.execute();
      expect(host.calls).toHaveLength(calls);
    });

  test.each(["spawn", "published-crash", "stdout", "state-save"])("gaps archiver retries transient %s without a halt", async failure => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
    let injected = false;
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.execution-ledger" && !injected && failure !== "state-save") {
        injected = true;
        if (failure === "spawn") throw Error("Temporary archiver spawn failure");
        const result = normal();
        if (failure === "published-crash") throw Error("Archiver died after link");
        return { ...result, output: "{" };
      }
      const result = normal();
      if (request.agent === "pitako.execution-director") result.structuredOutput.select = "missing";
      return result;
    });
    if (failure === "state-save") host.setFailSave(value => {
      if (injected || !value.loop?.archived) return false;
      injected = true; return true;
    });
    const output = await host.execute();
    expect(injected).toBe(true);
    expect(output.status, output.reason).toBe("partial");
    expect(output.reason).toContain("authorized loops consumed");
    expect(host.current().loop).toMatchObject({ archived: true, outcome: "gaps" });
    expect(host.records()).toHaveLength(2);
    const publications = host.calls.filter(call => call.agent === "pitako.execution-ledger").map(call => call.key);
    expect(publications).toEqual(failure === "state-save" ? ["invoke-human-1.l1.gaps"]
      : ["invoke-human-1.l1.gaps", "invoke-human-1.l1.gaps"]);
    const drains = host.launches.filter(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "drain");
    expect(drains.map(call => call.key)).toEqual(failure === "state-save" ? ["invoke-human-1.l1.finishDrain"]
      : ["invoke-human-1.l1.finishDrain", "invoke-human-1.l1.finishDrain.r1"]);
  });

  test("exhausted gaps admission saves retain the frozen intention and reuse the successful drain", async () => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") result.structuredOutput.select = "missing";
      return result;
    });
    host.setFailSave(value => !!value.loop?.archived);
    expect((await host.execute()).status).toBe("partial");
    const retained = host.current();
    const body = JSON.stringify(retained.intentions[0].input.record);
    expect(retained.finishDrain.stage).toBe("receipt");
    expect(retained.loop.archived).toBeUndefined();
    host.setFailSave();
    expect((await host.execute()).status).toBe("partial"); // Authorized loop budget, not a persistence halt.
    expect(host.current().loop.archived).toBe(true);
    const calls = host.calls.filter(call => call.agent === "pitako.execution-ledger");
    expect(calls.map(call => call.key)).toEqual(["invoke-human-1.l1.gaps"]);
    expect(calls.every(call => JSON.stringify(JSON.parse(call.task).record) === body)).toBe(true);
    expect(host.records()).toHaveLength(2);
  });

  test.each(["director-permission", "worker-block", "exception", "stop"])("resumable %s leaves the loop open without archiving", async halt => {
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
    expect(host.current().loop.archived).toBeUndefined();
  });

  const isPrepare = (request: any) => request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "prepare";
  const overflow = (request: any, normal: () => any): any => isPrepare(request) ? { ...normal(), ok: false,
    output: JSON.stringify({ error: "loop-io", reason: "HUMAN + DECISION overflow: ask the human to consolidate", viewOverflow: true }) } : normal();
  test.each(["unblock", "relaunch"])("a %s after a pre-director view overflow clears the halt before the writer launches", async route => {
    const host = fixture(); host.setLimit(1);
    host.setRespond(overflow);
    const blocked = await host.execute();
    expect(blocked.status).toBe("blocked");
    expect(host.current().loop).toMatchObject({ phase: "director", halt: { code: "recovery" } });
    expect(host.calls.some(call => call.agent === "pitako.execution-director")).toBe(false);
    // The checkpoint hook refuses every write while the durable loop has a halt.
    const atLaunch: any[] = [];
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.worker") atLaunch.push(structuredClone(host.current().loop));
      return normal();
    });
    const output = await host.execute(route === "unblock"
      ? { unblock: true, resolution: { loop: 1, text: "Board consolidated into one HUMAN post." } } : {});
    expect(atLaunch).toHaveLength(1);
    expect(atLaunch[0]).toMatchObject({ phase: "implementation", attempt: { stage: "launched" } });
    expect(atLaunch[0].halt).toBeUndefined();
    expect(output.status, output.reason).not.toBe("blocked");
    if (route === "unblock") expect(host.history()[0].resolutions[0]).toMatchObject({ stage: "applied", halt: { code: "recovery" } });
  });

  test("a persisting pre-director view overflow halts again before any director", async () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond(overflow);
    expect((await host.execute()).status).toBe("blocked");
    const output = await host.execute({ unblock: true, resolution: { loop: 1, text: "Board consolidated." } });
    expect(output.status).toBe("blocked");
    expect(output.reason).toContain("consolidate");
    expect(host.current().loop.halt).toMatchObject({ code: "recovery" });
    expect(host.calls.filter(isPrepare)).toHaveLength(2);
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
    expect((await host.execute()).status).toBe("cancelled");
    const calls = host.calls.length;
    expect((await host.execute()).status).toBe("cancelled");
    expect(host.calls).toHaveLength(calls);
    expect(host.current().ledger.count).toBe(0);
    expect(host.current().loop.archived).toBeUndefined();
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
