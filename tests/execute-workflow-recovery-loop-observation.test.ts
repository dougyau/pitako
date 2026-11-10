import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { readReviewOriginal, readBacklog } from "../skills/execute/loop.ts";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { restoreCheckpoint } from "../extensions/execute-checkpoint.ts";
import { EXECUTE_STATE_VERSION } from "../extensions/execute-state.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { validateWorkflowScript } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { MISSION_STATE_MAX_BYTES } from "../node_modules/pi-subagents/src/missions/workflow-state.js";
import { digest, MAX_SPEC_BYTES } from "../extensions/spec-plans.ts";
import { executeControllerFixture, resolvedLoop, source, copy, gaps, closedInterruptedProducer, cutAt, config, candidate, expectImpediment, removeCache, publicationWitness, type Result } from "./fixtures/execute-workflow.ts";
import { realCheckoutCompositionFixture } from "./fixtures/plan-execute-composition.ts";
import { expectProcessBudget } from "./fixtures/process-budget.ts";

const { fixture } = executeControllerFixture();
const recoveryComposition = realCheckoutCompositionFixture();
const recoveryScripts = recoveryComposition.scripts;

// Association/access witnesses belong to the in-progress manifest, not compact references.
function observeInlineReviewOriginals(host: ReturnType<typeof fixture>) {
  const originals = new Map<string, any>();
  host.setSaveObserver(() => {
    const manifest = host.storage.get("review-invoke-human-1");
    for (const original of manifest?.originals ?? [])
      if (Object.hasOwn(original, "digest"))
        originals.set(original.key, copy({ ...manifest.originalDefaults, ...original }));
  });
  return originals;
}

describe("workflow-owned execute controller", () => {
  test.each([2, 3])("v6 never migrates or rewrites a retained v%s invocation", async version => {
    const host = fixture(); host.setLimit(1);
    await host.execute();
    host.current().version = version;
    const retained = copy(host.current()), calls = host.calls.length;
    expect((await host.execute()).status).toBe("blocked");
    expect(host.current()).toEqual(retained);
    expect(host.calls).toHaveLength(calls);
  });

  test("v6 rejects duplicate completion at admission, before another seal or dependent dispatch", async () => {
    const host = fixture(); host.setLimit(1);
    await host.execute();
    const retained = host.current();
    retained.loop.attempt = copy(host.snapshots.find(value =>
      value.loop?.attempt?.key.endsWith(".t1.a1") && value.loop.attempt.stage === "launched").loop.attempt);
    retained.loop.phase = "implementation"; retained.loop.cursor = 0;
    delete retained.loop.outcome;
    const count = host.calls.length;
    const outcome = await host.execute();
    expect(outcome.reason).toContain("Duplicate task completion rejected at admission");
    expect(outcome.status).toBe("blocked");
    expect(host.calls.slice(count).some(call => call.agent === "pitako.execution-ledger" || call.agent === "pitako.worker")).toBe(false);
    expect(host.records()).toHaveLength(3);
  });

  test("v6 repeated worker handoffs cannot bypass measured stall detection", async () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => request.agent === "pitako.worker" && request.key.includes(".l1.t1.") ?
      host.result(request, { ...host.worker(request, "pause"), status: "continue",
        remaining: ["Same pending defect"], diagnosis: "The same defect is still present",
        continuation: { mode: "fresh", reason: "Fix the same branch" }, usefulProgress: true }) : normal());
    expect((await host.execute()).status).toBe("partial");
    const workers = host.calls.filter(call => call.agent === "pitako.worker");
    expect(workers.map(call => call.key)).toEqual([1, 2, 3, 4].map(attempt => `invoke-human-1.l1.t1.a${attempt}`));
    const pauses = host.records().filter((record: any) => record.loop === 1 && record.kind === "unit");
    expect(pauses).toHaveLength(4);
    expect(pauses.every((record: any) => record.body.result.checkpoint.confirmation.kind === "pause")).toBe(true);
    expect(host.current().loop.metricSeries.nonImproving).toBe(3);
    expect(resolvedLoop(host.current()).results.at(-1).diagnosis).toContain("Three consecutive non-improving");
    expect(host.current().tasks.change1.completed).toBeNull();
  });

  test.each(["gaps", "continue"])("a closed loop's %s pause cannot block the next loop's checkpoint recovery", async status => {
    const host = fixture(undefined, { realCheckout: true }); host.setLimit(2);
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.checkpoint-sealer" ||
          request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "taskDelta")
        return recoveryScripts.runDeterministic(request.key, request,
          { ...recoveryScripts, root: host.root, inlineSealer: true }, undefined);
      if (request.agent === "pitako.worker" && request.key.includes(".l1.t1."))
        return host.result(request, { ...host.worker(request, "pause"), status,
          remaining: ["Same pending defect"], diagnosis: "Still pending",
          continuation: { mode: "fresh", reason: "Fix the same branch" }, usefulProgress: true });
      if (request.key === "invoke-human-1.l2.director") {
        const result = normal();
        result.structuredOutput.changes.push({ kind: "update", id: "change1",
          patch: { expectedResult: "Fix the pending branch with recoverable checkpoint evidence" },
          reason: "Narrow the stalled task to the pending branch before checkpoint recovery" });
        return result;
      }
      if (request.key === "invoke-human-1.l2.t1.a1") {
        host.worker(request); // Capture a real recoverable checkpoint before losing the writer.
        return { ok: false, output: "", error: "Writer disappeared" };
      }
      if (request.key === "invoke-human-1.l2.t1.a2") {
        const restore = host.current().loop.attempt.restore;
        const sources = restore.sourceKeys.map((key: string) => host.current().taskFrame.sources.find((source: any) => source.key === key));
        const restored = restoreCheckpoint(sources, restore.authority);
        const restoredRef = restored.partialRef.replace(/restore\.json$/, "restored.json");
        const value = host.worker(request);
        return host.result(request, { ...value, restoreReceipt: { ...restored, restoredRef } });
      }
      return normal();
    });
    const output = await host.execute();
    expect(output.status, output.reason).toBe("partial");
    expect(host.calls.filter(call => call.key === "invoke-human-1.l2.t1.a2")).toHaveLength(1);
    expect(host.current().lastConfirmed).toMatchObject({ kind: "unit", taskId: "change1", position: { loop: 2, cursor: 1 } });
    // Measured 244 including IPC Git and one shared runtime, plus twenty-five.
    expectProcessBudget([host.processes(), recoveryComposition.processes()], 269);
  });

  test.each(["spawn", "nonzero", "stdout", "published-crash", "state-save"])(
    "v6 seal automatically reconciles transient %s without a halt or discarded pending data", async failure => {
      const host = fixture(); host.setLimit(1);
      let injected = false;
      host.setLaunchRespond(async (request, normal) => {
        if (request.agent !== "pitako.loop-io" || JSON.parse(request.task).operation !== "drain" || injected) return normal();
        if (failure === "state-save") return normal();
        injected = true;
        expect(host.current().intentions.map((entry: any) => entry.operation)).toEqual(["ledger", "apply", "ledger"]);
        expect(host.current().ledger.count).toBe(0);
        expect(host.current().loop.cursor).toBe(1);
        if (failure === "published-crash") { await normal(); throw Error("Archiver disappeared after link"); }
        if (failure === "spawn") throw Error("Transient spawn failure");
        const result = await normal();
        return failure === "stdout" ? { ...result, output: "{" } :
          { ...result, ok: false, results: result.results?.map(entry => ({ ...entry, exitCode: 1 })), output: "" };
      });
      if (failure === "state-save") host.setFailSave(value => {
        if (injected || value.intentions?.length || value.ledger?.count !== 3) return false;
        injected = true;
        return true;
      });
      const outcome = await host.execute();
      expect(injected).toBe(true);
      expect(outcome.status, outcome.reason).toBe("partial");
      expect(host.current()).toMatchObject({ version: EXECUTE_STATE_VERSION, consumedLoops: 1, sealPending: null, taskFrame: null,
        ledger: { count: 3 }, loop: { cursor: 1 } });
      expect(host.calls.filter(call => call.agent === "pitako.execution-ledger").map(call => call.key))
        .toEqual(["invoke-human-1.l1.seal1", "invoke-human-1.l1.gaps"]);
      expect(host.launches.filter(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "drain").map(call => call.key))
        .toEqual(failure === "state-save" ? ["invoke-human-1.l1.finishDrain"] :
          ["invoke-human-1.l1.finishDrain", "invoke-human-1.l1.finishDrain.r1"]);
      expect(host.emits.some(item => item.type === "execution-progress" && ["blocked", "cancelled"].includes(item.status))).toBe(false);
      expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "unit", "loop"]);
      expect(host.current()).not.toHaveProperty("snapshot");
      expect(host.current().tasks.change1.completed.prerequisiteResults).toEqual([]);
    });

  test("v6 exhausted publication retries preserve all pending data and reentry publishes the same record", async () => {
    const host = fixture(); host.setLimit(1);
    host.setLaunchRespond((request, normal) => {
      if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "drain") throw Error("Filesystem temporarily unavailable");
      return normal();
    });
    const outcome = await host.execute();
    expect(outcome.status).toBe("partial");
    expect(outcome.reason).toContain("Filesystem temporarily unavailable");
    const pending = copy(host.current().intentions);
    expect(host.current()).toMatchObject({ ledger: { count: 0, head: null }, loop: { cursor: 1 } });
    expect(pending.map((entry: any) => entry.operation)).toEqual(["ledger", "apply", "ledger"]);
    expect(host.current().loop.results).toHaveLength(1);
    expect(host.launches.filter(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "drain")).toHaveLength(3);
    host.setLaunchRespond();
    expect((await host.execute()).status).toBe("partial");
    expect(host.records()[1].body).toEqual(pending[0].input.record.body);
    expect(host.calls.filter(call => call.agent === "pitako.execution-ledger" && call.key.includes(".seal")).at(-1)?.key)
      .toBe("invoke-human-1.l1.seal1");
    expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "unit", "loop"]);
  });

  test.each(["integrity", "stopped", "capacity"])("v6 seal preserves native or human-only %s barriers without retry", async cause => {
    const host = fixture(); host.setLimit(1);
    host.setLaunchRespond((request, normal) => request.agent !== "pitako.loop-io" || JSON.parse(request.task).operation !== "drain" ? normal() : ({
      key: request.key, agent: request.agent, runId: `native-${request.key}`, ok: false,
      // The exact loop-io CLI failure line for a real hash-ledger head mismatch.
      output: cause === "integrity" ? JSON.stringify({ error: "loop-io", reason: "Ledger head mismatch.", selectionRejected: false,
        replayRejected: false, viewOverflow: false, ledgerIntegrity: true }) : "",
      ...(cause === "stopped" ? { stopped: true } : {}),
      ...(cause === "capacity" ? { error: "Active async run capacity exhausted: 1/1 used." } : {}),
    }));
    const outcome = await host.execute();
    expect(outcome.status).not.toBe("complete");
    expect(outcome.reason).toContain(cause === "integrity" ? "Ledger integrity requires human reconciliation: Ledger head mismatch."
      : cause === "stopped" ? "stopped" : "capacity exhausted");
    expect(host.launches.filter(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "drain")).toHaveLength(1);
    expect(host.current()).toMatchObject({ ledger: { count: 0 }, loop: { cursor: 1 } });
    expect(host.current().intentions.map((entry: any) => entry.operation)).toEqual(["ledger", "apply", "ledger"]);
  });

  test.each(["unit", "pause"].flatMap(kind => ["none", "resolution-cut"].map(cut => [kind, cut])))(
    "v6 stale %s seal Stop requires fresh human input before any archiver dispatch (%s)", async (kind, cut) => {
    const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
    host.setLaunchRespond((request, normal) => request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "drain"
      ? { key: request.key, runId: `native-${request.key}`, agent: request.agent, ok: false, stopped: true, output: "" } : normal());
    host.setRespond((request, normal) => {
      if (kind === "pause" && request.key.endsWith(".t1.a1")) return host.result(request, {
        ...host.worker(request, "pause"), status: "blocked", remaining: ["Finish saved task"], diagnosis: "Saved partial work",
      });
      return normal();
    });
    expect((await host.execute()).status).toBe("cancelled");
    const retained = copy(host.current()), count = host.calls.length;
    expect(retained.loop.halt.ref).toMatchObject({ agent: "pitako.loop-io", key: "invoke-human-1.l1.finishDrain" });
    host.setLaunchRespond();
    host.setRespond((request, normal) => {
      if (kind !== "pause" || !request.key.endsWith(".t1.a2")) return normal();
      const restore = host.current().loop.attempt.restore;
      const sources = restore.sourceKeys.map((key: string) => host.current().taskFrame.sources.find((source: any) => source.key === key));
      restoreCheckpoint(sources, restore.authority);
      return normal();
    });
    expect((await host.execute()).status).toBe("cancelled");
    expect(host.calls).toHaveLength(count);
    expect(host.current()).toEqual(retained);
    const input = { unblock: true, resolution: { loop: 1, text: "Continue after the actual archiver Stop" } };
    if (cut === "resolution-cut") {
      const set = host.state.set;
      host.state.set = async (key, value: any) => {
        await set(key, value);
        if (value.loop?.resolutions?.at(-1)?.observations?.length && !value.loop.halt)
          throw Error("Cut after durable grouped drain resolution");
      };
      expect((await host.execute(input)).reason).toContain("Essential persistence failed");
      host.state.set = set;
    }
    const resumed = await host.execute(cut === "none" ? input : {});
    expect(resumed.status, resumed.reason).toBe("partial");
    expect(host.records().map((record: any) => record.kind), resumed.reason).toEqual(kind === "unit" ? ["spec", "unit", "loop"] : ["spec", "unit", "unit", "loop"]);
    expect(host.calls.slice(count).filter(call => call.agent === "pitako.execution-ledger").map(call => call.key))
      .toEqual(kind === "unit" ? ["invoke-human-1.l1.seal1", "invoke-human-1.l1.gaps"] :
        ["invoke-human-1.l1.seal1", "invoke-human-1.l1.seal2", "invoke-human-1.l1.gaps"]);
    expect(host.records()[1].body).toEqual(retained.intentions[0].input.record.body);
  });

  test("v6 a post-publication persistence cut resumes identical bytes before moving the cursor", async () => {
    const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
    host.setFailSave(value => value.ledger?.count === 3 && !value.intentions?.length);
    const outcome = await host.execute();
    expect(outcome.status).toBe("partial");
    const file = path.join(host.root, ".pi/subagents/execute/human-1/000001.json");
    const bytes = readFileSync(file);
    const pending = copy(host.current().intentions);
    expect(host.current().loop.cursor).toBe(1);
    host.setFailSave();
    expect((await host.execute()).status).toBe("partial");
    expect(readFileSync(file)).toEqual(bytes);
    expect(host.records()[1].body).toEqual(pending[0].input.record.body);
    expect(host.calls.filter(call => call.key.endsWith(".t1.a1"))).toHaveLength(1);
  });

  test("v6 admission-to-archive halt cannot enter frozen record bytes", async () => {
    const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
    let cut = false;
    const set = host.state.set;
    host.state.set = async (key, value: any) => {
      await set(key, value);
      if (!cut && value.sealPending) { cut = true; throw Error("Injected admission-to-archive halt"); }
    };
    expect((await host.execute()).status).toBe("partial");
    expect(host.calls.some(call => call.agent === "pitako.execution-ledger")).toBe(false);
    const pending = copy(host.current().sealPending);
    host.current().loop.halt = { status: "blocked", code: "semantic-block", reason: "Injected reentry diagnostic" };
    host.setFailSave();
    await host.execute();
    expect(host.records()[1].body).toEqual(pending.record.body);
    expect(readFileSync(path.join(host.root, ".pi/subagents/execute/human-1/000001.json"), "utf8"))
      .not.toContain("Injected reentry diagnostic");
  });
  test("a saved cooperative pause continues the same task without human input or another loop", async () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => request.key.endsWith(".t1.a1") ? host.result(request, {
      ...host.worker(request, "pause"), status: "continue",
      remaining: ["Finish original publication and access guarantees"],
      diagnosis: "Useful metadata changes are saved; the original evidence implementation remains pending.",
      continuation: { mode: "fresh", reason: "Complete the remaining evidence guarantees without repeating metadata work" },
    }) : normal());
    const outcome = await host.executeNative();
    expect(outcome).toMatchObject({ status: "partial", loopsConsumed: 1 });
    // The superseded pause is durable, while the loop retains the current task result.
    const units = host.records().filter((record: any) => record.kind === "unit").map((record: any) => record.body.result);
    expect(units.slice(0, 2).map((result: any) => [result.taskId, result.attempt, result.status]))
      .toEqual([["change1", 1, "continue"], ["change1", 2, "complete"]]);
    expect(units[0]).toMatchObject({
      usefulContinuation: true, checkpoint: { confirmation: { kind: "pause", position: { cursor: 0 } } },
    });
    const loop = resolvedLoop(host.current());
    expect(loop.results[0]).toMatchObject({ taskId: "change1", attempt: 2, status: "complete" });
    expect(loop.cursor).toBe(1);
    expect(loop.halt).toBeUndefined();
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    for (const suffix of [".t1.a1", ".t1.a2"])
      expect(host.calls.filter(call => call.key.endsWith(suffix))).toHaveLength(1);
    expect(host.calls.some(call => call.key.includes(".t2.") || call.key.includes(".review.") || call.key.endsWith(".compliance"))).toBe(false);
    expect(host.calls.find(call => call.key.endsWith(".t1.a2"))!.task).toContain("invoke-human-1.l1.t1.a1");
  });

  test("a pause with gaps exhausts the ordinary budget without inventing a human impediment", async () => {
    const host = fixture();
    host.setLimit(1);
    host.setRespond((request, normal) => request.agent === "pitako.worker" ? host.result(request, {
      ...host.worker(request, "pause"), status: "gaps", usefulProgress: false,
      remaining: ["Replan the remaining implementation"], continuation: { mode: "fresh", reason: "Replan the remaining implementation" },
    }) : normal());
    const outcome = await host.execute();
    expect(outcome).toMatchObject({ status: "partial", loopsConsumed: 1 });
    expect(resolvedLoop(host.current())).toMatchObject({ outcome: "gaps", cursor: 0 });
    expect(resolvedLoop(host.current()).halt).toBeUndefined();
    expect(host.current().lastConfirmed.kind).toBe("pause");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(4);
    expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
  });

  test.each(["stopped", "permission"] as const)("automatic pause continuation still honors native %s", async cause => {
    const host = fixture();
    host.setRespond((request, normal) => {
      if (request.key.endsWith(".t1.a1")) return host.result(request, {
        ...host.worker(request, "pause"), status: "continue", remaining: ["Finish pending work"],
        continuation: { mode: "fresh", reason: "Continue the same authorized task" },
      });
      return request.key.endsWith(".t1.a2") ? closedInterruptedProducer(normal(), cause) : normal();
    });
    const outcome = await host.execute();
    expect(outcome.status).toBe(cause === "stopped" ? "cancelled" : "blocked");
    expect(resolvedLoop(host.current()).halt).toMatchObject({
      code: "native-barrier", cause: cause === "stopped" ? "stopped" : "native permission denial",
    });
    expect(outcome.loopsConsumed).toBe(1);
    expect(resolvedLoop(host.current()).results).toHaveLength(1);
    expect(host.current().lastConfirmed.kind).toBe("pause");
    expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
  });

  test.each(["continue", "gaps"])("an exact retained synthetic pause halt is reconciled without renewed authorization: %s", async status => {
    const host = fixture();
    host.setLimit(1);
    host.setRespond((request, normal) => request.key.endsWith(".t1.a1") ? host.result(request, {
      ...host.worker(request, "pause"), status, remaining: ["Finish pending work"],
      diagnosis: "The saved implementation is partial, not an external impediment.",
      continuation: { mode: "fresh", reason: "Complete the remaining implementation" },
    }) : normal());
    let retained: any;
    cutAt(host, value => {
      if (value.loop?.attempt?.result?.status !== "continue") return false;
      retained = copy(value);
      return true;
    });
    expect((await host.execute()).status).toBe("partial");
    expect(retained).toBeDefined();
    // Model the previously published reader's exact false classification, not
    // a worker barrier, native Stop, new plan or invented checkpoint receipt.
    const loop = retained.loop, result = loop.attempt.result;
    loop.outcome = "blocked";
    loop.halt = { status: "blocked", code: "semantic-block", reason: result.diagnosis, ref: copy(result.ref) };
    host.storage.set("invoke-human-1", copy(retained));
    host.setFailSave();
    const outcome = await host.execute();
    expect(outcome).toMatchObject({ status: "partial", loopsConsumed: 1 });
    expect(host.current().association).toEqual(retained.association);
    expect(host.history()).toHaveLength(1);
    expect(host.records().find((record: any) => record.kind === "unit").body.result).toEqual(result);
    expect(host.history()[0].halt).toBeUndefined();
    expect(host.calls.filter(call => call.key.endsWith(".t1.a1"))).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".t1.a2"))).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
  });


  // Hold the observer input fixed to test durable dispatch policy; the registered
  // Node loss-reentry case covers real inspection, journaled bytes and tool loading.
  test.each([
    { status: "blocked", retained: "current" },
    { status: "blocked", retained: "missing-evidence" },
    { status: "blocked", retained: "missing-authority" },
    { status: "blocked", retained: "conflicting-authority" },
  ])("pause recovery does not renew a lost writer: $status / $retained", async ({ status, retained }) => {
    const host = fixture("FULL SPECS", { taskCount: 2 }); host.setLimit(2);
    host.setHostResponse((key, value) => {
      const loop = host.current()?.loop, attempt = loop?.attempt;
      return !key.startsWith("inspect-") || !attempt ? value : { ...value, checkpointObservation: {
        key: attempt.key, taskId: attempt.taskId, attempt: attempt.number, loop: loop.number, cursor: loop.cursor,
        evidence: digest("unchanged checkpoint observation"),
      } };
    });
    host.setRespond((request, normal) => {
      if (request.key === "invoke-human-1.l2.t1.a1") return host.result(request, {
        ...host.worker(request, "pause"), status, remaining: ["Finish pending second unit"],
        continuation: { mode: "fresh", reason: "Resume the admitted pause" },
      });
      if (request.key === "invoke-human-1.l2.t1.a2") return {
        ok: false, output: "", error: "Restoration transport disappeared before useful effects",
      };
      return normal();
    });
    expect((await host.execute()).status).toBe("blocked");
    const paused = copy(host.current()), point = paused.lastConfirmed;
    const completed = copy(host.history()[0].results);
    expect(completed).toMatchObject([{ taskId: "change1", status: "complete" }]);
    expect(point).toMatchObject({ kind: "pause", taskId: "change2", position: { cursor: 0 } });
    expect(resolvedLoop(paused).results.map((result: any) => result.status)).toEqual([status]);
    const yieldedCalls = copy(host.calls);
    expect((await host.execute()).status).toBe("blocked");
    expect(host.calls).toEqual(yieldedCalls);

    expect((await host.execute({ unblock: true, resolution: { loop: 2, text: "Resume the saved pending unit" } })).status).not.toBe("complete");
    const loop = host.history()[1];
    expect(host.calls.filter(call => call.key === "invoke-human-1.l2.t1.a2")).toHaveLength(1);
    expect(loop.attempt.restore.authority.confirmedPause).toEqual(resolvedLoop(paused).results[0].checkpoint.confirmation);
    expect(loop.attempt.restore.evidence).toBe(digest("unchanged checkpoint observation"));
    if (retained !== "current") {
      loop.attempt.restore.evidence = null;
      if (retained === "missing-authority") delete loop.attempt.restore.authority.confirmedPause;
      if (retained === "conflicting-authority") loop.attempt.restore.authority.confirmedPause.digest = "0".repeat(64);
    }
    const pending = copy(loop.attempt.restore), calls = copy(host.calls);
    for (let reentry = 0; reentry < 2; reentry++) {
      const outcome = await host.execute();
      expect(outcome.status).not.toBe("complete");
      expect(outcome.loopsConsumed).toBe(2);
      expect(outcome.reason).toContain(retained !== "current" ? "Confirmed pause conflicts" : "no new checkpoint evidence");
      expect(host.calls).toEqual(calls);
      expect(host.current().association).toEqual(paused.association);
      expect(host.history()).toHaveLength(2);
      expect(host.history()[1].cursor).toBe(0);
      expect(host.history()[1].results).toEqual(resolvedLoop(paused).results);
      expect(host.history()[0].results).toEqual(completed);
      expect(host.current().lastConfirmed).toEqual(point);
      expect(host.history()[1].attempt.restore).toEqual(pending);
    }
    expect(host.calls.filter(call => call.agent !== "pitako.request-observer").map(call => call.key)).toEqual([...yieldedCalls.filter((call: any) => call.agent !== "pitako.request-observer").map((call: any) => call.key), "invoke-human-1.l2.t1.a2.baseline", "invoke-human-1.l2.t1.a2"]);
  });

  // Human input cannot restore a confirmed pause while its producer currently
  // reports Stop, denial or activity; the restoration writer is never dispatched.
  test.each([
    { mode: "stopped", status: "cancelled", cause: "stopped" },
    { mode: "permission", status: "blocked", cause: "native permission denial" },
    { mode: "observer-permission", status: "blocked", cause: "native permission denial" },
    { mode: "active", status: "blocked", cause: "current pertinent writer activity or native refusal" },
  ])("pause restoration honors the paused producer's current $mode", async ({ mode, status, cause }) => {
    const host = fixture("FULL SPECS", { taskCount: 2 }); host.setLimit(2);
    host.setRespond((request, normal) => request.key === "invoke-human-1.l2.t1.a1" ? host.result(request, {
      ...host.worker(request, "pause"), status: "blocked", remaining: ["Finish pending second unit"],
      continuation: { mode: "fresh", reason: "Resume the admitted pause" },
    }) : normal());
    expect((await host.execute()).status).toBe("blocked");
    const paused = copy(host.current()), calls = copy(host.calls);
    expect(paused.lastConfirmed).toMatchObject({ kind: "pause", taskId: "change2" });
    host.setStatus(ref => {
      if (!ref.includes(".l2.t1.a1")) return copy(host.native.get(ref) ?? { ok: true, output: "", results: [] });
      if (mode === "observer-permission") throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
      return { ...copy(host.native.get(ref)!), ...(mode === "stopped" ? { stopped: true } : mode === "active" ? { state: "running" }
        : { error: "Blocked by pi-subagents permission rule: current denial" }) };
    });
    const outcome = await host.execute({ unblock: true, resolution: { loop: 2, text: "Resume the saved pending unit" } });
    expect(outcome).toMatchObject({ status, loopsConsumed: 2 });
    expect(host.calls).toEqual(calls);
    expect(host.history()[1]).toMatchObject({ cursor: 0, halt: { code: "native-barrier", cause } });
    expect(host.history()[1].attempt.restore).toBeUndefined();
    expect(host.current().lastConfirmed).toEqual(paused.lastConfirmed);
  });

  // Missing preimages cannot be repaired by replanning or accepting a report.
  test("changed implementation without a pre-capture manifest blocks without admitting the unit", async () => {
    const host = fixture("FULL SPECS", { realCheckout: true });
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.t1.a1") {
        host.changeCheckout();
        rmSync(path.join(host.root, ".pi/subagents/checkpoints", request.key, "manifest.json"));
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status, output.reason).toBe("blocked");
    expect(output.reason).toContain("Checkpoint journal integrity conflict");
    expect(output.reason).toContain("candidate-drift");
    const sealer = host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => [call.key, JSON.parse(call.task).kind]);
    expect(sealer).toContainEqual(["invoke-human-1.l1.t1.a1.seal", "unit"]);
    expect(host.current().tasks.change1.completed).toBeNull();
    expect(host.current().lastConfirmed).toBeNull();
    const calls = host.calls.length;
    expect((await host.execute()).status).toBe("blocked");
    expect(host.calls.slice(calls).some(call => ["pitako.worker", "pitako.execution-director"].includes(call.agent!))).toBe(false);
  });

  test.each(["unknown", "complete", "wrapped-complete", "native-complete"])(
    "retained file fallback requires actual settlement: %s", async mode => {
      const host = fixture();
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key.endsWith("director-prepare"))
          Object.assign(result.structuredOutput, { status: "blocked", reason: "Prior semantic impediment" });
        return result;
      });
      expect((await host.executeNative()).status).toBe("blocked");
      const prior = copy(host.current()), calls = host.calls.length;
      const ref = prior.loop.review.references[0];
      host.setHostResponse((key, value) => key === "inspect-initial" ? {
        ...value, retainedAnalyses: [{ key: ref.key, runId: ref.runId, ok: true,
          ...(mode === "native-complete" ? { state: "complete" } : {}),
          structuredOutput: copy(host.native.get(ref.runId)!.structuredOutput) }],
      } : value);
      host.setStatus(runId => ({ ok: true, runId, results: [], output: mode.includes("complete") && mode !== "native-complete" ?
        `${mode === "wrapped-complete" ? `Status target: run ${runId}\nSpawn budget: 1/10\nActive async capacity: 0/5\n` : ""}Run: ${runId}\nState: complete` :
        "Preview only; no settlement receipt" }));
      const result = await host.executeNative();
      expect(result.status).toBe("blocked");
      expect(result.reason).toContain(mode === "unknown" ? "Read-only producer settlement uncertain" : "Prior");
      expect(host.calls).toHaveLength(calls);
      expect(host.history().at(-1).results).toEqual(resolvedLoop(prior).results);
      expect(host.history().at(-1).review.references).toMatchObject(prior.loop.review.references.map((entry: any) =>
        mode === "unknown" ? entry : { ...entry, reused: true }));
    });

  test("compliance reentry preserves original references with metadata-only management delivery", async () => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".compliance")) result.structuredOutput.status = "blocked";
      return result;
    });
    expect((await host.executeNative()).status).toBe("blocked");
    const prior = copy(host.current()), calls = host.calls.length;
    const refs = [...prior.loop.review.references, prior.loop.compliance.ref];
    host.setHostResponse((key, value) => key === "inspect-initial" ? {
      ...value, retainedAnalyses: refs.map(ref => ({
        key: ref.key, runId: ref.runId, ok: true,
        structuredOutput: copy(host.native.get(ref.runId)!.structuredOutput),
      })),
    } : value);
    host.setStatus(ref => ({ ok: true, runId: ref, output: `Run: ${ref}\nState: complete`, results: [] }));
    expect((await host.executeNative()).status).toBe("blocked");
    expect(host.calls).toHaveLength(calls);
    expect(host.history().at(-1).compliance.ref).toEqual(prior.loop.compliance.ref);
    expect(host.history().at(-1).review.references).toEqual(prior.loop.review.references);
    expect(host.history().at(-1).results).toEqual(resolvedLoop(prior).results);
  });

  test.each(["conflict", "escape", "stopped", "pending"])(
    "a full management body does not hide retained %s evidence", async mode => {
      const host = fixture();
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key.endsWith("director-prepare")) result.structuredOutput.status = "blocked";
        return result;
      });
      expect((await host.executeNative()).status).toBe("blocked");
      const prior = copy(host.current()), calls = host.calls.length;
      const ref = prior.loop.review.references[0];
      host.setHostResponse((key, value) => key === "inspect-initial" ? {
        ...value, retainedAnalyses: [{ key: ref.key, runId: ref.runId, ok: false,
          ...(mode === "conflict" ? { error: "Conflicting complete retained analysis originals." } :
            mode === "escape" ? { error: "Structured original escapes its retained native producer." } :
              { state: mode === "stopped" ? "stopped" : "pending" }) }],
      } : value);
      const result = await host.executeNative();
      expect(result.status).toBe(mode === "stopped" ? "cancelled" : "blocked");
      expect(host.calls).toHaveLength(calls);
      expect(host.history().at(-1).review.references).toEqual(prior.loop.review.references);
      expect(host.history().at(-1).results).toEqual(resolvedLoop(prior).results);
      expect(result.reason).toContain(mode === "conflict" ? "Conflicting complete" :
        mode === "escape" ? "escapes its retained" : mode === "stopped" ? "Execution cancelled" : "Positive native barrier");
    });

  test.each(["stopped", "permission", "unavailable"])("current %s after a historical semantic block still prevents continuation", async mode => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith("director-prepare"))
        Object.assign(result.structuredOutput, { status: "blocked", reason: "Prior semantic impediment" });
      return result;
    });
    expect((await host.executeNative()).status).toBe("blocked");
    expect(host.history().at(-1).halt.code).toBe("semantic-block");
    const prior = copy(host.current()), calls = host.calls.length;
    host.setStatus(ref => {
      if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      if (mode === "unavailable") return { ok: true, output: "A preview is not the complete result", results: [] };
      return { ok: true, output: `Run: ${ref}\nState: stopped`, results: [] };
    });
    const result = await host.executeNative();
    expect(result).toMatchObject({ status: mode === "stopped" ? "cancelled" : "blocked", loopsConsumed: 2 });
    expect(host.current().association).toEqual(prior.association);
    // The current missing original is a recovery impediment, not the earlier
    // semantic verdict. It must not erase that verdict's producer references.
    expect(host.history().at(-1).halt).toMatchObject({ code: mode === "unavailable" ? "recovery" : "native-barrier" });
    if (mode === "unavailable") expect(result.reason).toContain("Complete retained analysis unavailable");
    expect(host.calls).toHaveLength(calls);
    expect(host.history().at(-1).results).toEqual(resolvedLoop(prior).results);
    expect(host.history().at(-1).review.references).toEqual(prior.loop.review.references);
    expect((await host.executeNative()).status).toBe(result.status);
    expect(host.calls).toHaveLength(calls);
  });


  // Reject a replacement inspector after its result returned but admission save
  // failed. Management previews alone must not hide its exact retained original.
  test.each(["complete", "pending", "unknown-settlement", "conflict", "wrong-run", "missing", "current-stop", "current-permission", "current-run-conflict"])(
    "pending recovery receipt reconciles its retained original: %s", async mode => {
      const host = fixture(); host.setLimit(1);
      const director = "invoke-human-1.l1.director";
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.execution-inspector") return host.result(request, {
          status: "recovered", reason: "Exact associated original retained", original: host.plan(), workerResult: null,
          originalAvailable: true, binding: "absent", comparison: "only-original", provenance: ["/native/original.json"],
        });
        return request.key === director ? { ...result, structuredOutput: undefined } : result;
      });
      cutAt(host, value => value.loop?.recoveries?.[0]?.stage === "observed");
      expect((await host.executeNative()).status).toBe("partial");
      host.setFailSave();
      const recovery = copy(host.history().at(-1).recoveries[0]), calls = host.calls.length;
      expect(recovery.stage).toBe("intention");
      expect(typeof recovery.ref.runId).toBe("string");
      const receipt = copy(host.native.get(recovery.ref.key)!);
      host.setStatus(ref => ({ key: ref, runId: ref === recovery.ref.runId && mode === "current-run-conflict" ? "other-producer" : ref, ok: true,
        ...(ref === recovery.ref.runId && mode === "current-stop" ? { stopped: true } : {}),
        ...(ref === recovery.ref.runId && mode === "current-permission" ? { error: "Blocked by pi-subagents permission rule: 'run' is denied." } : {}),
        output: mode === "unknown-settlement" && ref === recovery.ref.runId ? "No current settlement inventory" : `Run: ${ref}\nState: complete`,
        results: [] }));
      host.setHostResponse((key, value) => key === "inspect-initial" ? { ...value, retainedAnalyses: mode === "missing" ? [] : [{
        key: recovery.ref.key, runId: mode === "wrong-run" ? "other-producer" : recovery.ref.runId, ok: true,
        ...(mode === "complete" || mode === "conflict" ? { state: "complete" } : mode === "pending" ? { state: "running" } : {}),
        ...(mode === "conflict" ? { ok: false, error: "Conflicting complete retained analysis originals." } : {}),
        structuredOutput: receipt.structuredOutput,
      }] } : value);
      const result = await host.executeNative();
      expect(result.status, result.reason).toBe(mode === "complete" ? "partial" : mode === "current-stop" ? "cancelled" : "blocked");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
      expect(host.calls.slice(calls).filter(call => call.key.endsWith(".director"))).toHaveLength(0);
      expect(host.history()).toHaveLength(1);
      expect(host.current().association.maxCycles).toBe(1);
      if (mode !== "complete") expect(host.calls).toHaveLength(calls);
      else {
        expect(host.records().flatMap((record: any) => record.body.recoveries ?? [])[0]).toMatchObject({ stage: "observed", disposition: "recovered" });
        expect(host.calls.slice(calls).filter(call => call.agent === "pitako.worker")).toHaveLength(1);
        expect(host.current().tasks.change1.completed.status).toBe("complete");
      }
    });

  // Reject treating an unknown transport cause as Stop or requiring --unblock
  // for ordinary technical reconstruction. Closing replay must not repeat work.
  test.each(["inspect-initial"])(
    "technical host reentry reconstructs without redundant human input at %s", async target => {
      const host = fixture(); host.setLimit(1);
      host.setHostResponse((key, value) => {
        if (key === target) throw Error(`Host command '${target}' failed: Command stopped because the workflow was aborted.`);
        return value;
      });
      expect((await host.execute()).status).toBe("blocked");
      const original = copy(host.current().hostHalt), calls = host.calls.length;
      host.setHostResponse();
      expect(await host.execute()).toMatchObject({ status: "partial" });
      expect(host.current().hostHalt).toEqual(original);
      expect(host.current().hostReconstruction).toMatchObject({ source: original, stage: "admitted" });
      expect(host.current().resolutions).toBeUndefined();
      expect(host.history()).toHaveLength(1);
      expect(host.current().tasks.change1.completed.status).toBe("complete");
      const completed = host.calls.length;
      expect(await host.execute()).toMatchObject({ status: "partial" });
      expect(host.calls).toHaveLength(completed);
    });

  // A durable intention is not a receipt. Repeating only the fixed pure reads
  // must reconstruct state, not repeat an admitted worker or a pending query.
  test.each(["inspect-initial"])(
    "technical host committed reconstruction intention resumes pure projections at %s", async target => {
      const host = fixture(); host.setLimit(1);
      host.setHostResponse((key, value) => {
        if (key === target) throw Error("Controlled ambiguous transport failure");
        return value;
      });
      expect((await host.execute()).status).toBe("blocked");
      const original = copy(host.current().hostHalt), priorCalls = host.calls.length;
      host.current().hostReconstruction = { source: copy(original), stage: "intention" };
      host.setHostResponse();
      expect((await host.execute()).status).toBe("partial");
      expect(host.current().hostHalt).toEqual(original);
      expect(host.current().hostReconstruction).toMatchObject({ source: original, stage: "admitted",
        observation: { ref: { key: "inspect-initial", outputReference: "/native/host/inspect-initial.log" },
          candidate: host.observedCandidate(), source: host.current().association.source,
          digest: host.current().association.digest } });
      expect(host.history()).toHaveLength(1);
      expect(host.current().tasks.change1.completed.status).toBe("complete");
      expect(host.current().association.maxCycles).toBe(1);
      expect(host.current().resolutions).toBeUndefined();
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
      const completed = host.calls.length;
      expect((await host.execute()).status).toBe("partial");
      expect(host.calls).toHaveLength(completed);
    });

  test("technical host intention replay cannot replace a pending read-only model recovery", async () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") delete result.structuredOutput;
      if (request.agent === "pitako.execution-inspector") result.state = "running";
      return result;
    });
    expect((await host.execute()).status).toBe("blocked");
    const pending = copy(host.history().at(-1).recoveries[0]);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
    host.setHostResponse(() => { throw Error("Controlled host transport failure on reentry"); });
    expect((await host.execute()).status).toBe("blocked");
    host.current().hostReconstruction = { source: copy(host.current().hostHalt), stage: "intention" };
    const calls = host.calls.length;
    host.setHostResponse();
    expect((await host.execute()).status).toBe("blocked");
    expect(host.current().hostReconstruction.stage).toBe("admitted");
    expect(host.history().at(-1).recoveries[0]).toEqual(pending);
    expect(host.history()).toHaveLength(1);
    expect(host.calls).toHaveLength(calls);
  });

  test.each(["stopped", "pending", "permission"])(
    "technical host reentry preserves observed %s without current human input", async cause => {
      const host = fixture(); host.setLimit(1);
      host.setHostResponse(() => { throw Error("Controlled ambiguous host failure"); });
      await host.execute();
      const checkpoint = host.current();
      if (cause === "permission") checkpoint.hostHalt.observedBarrier = "native permission denial";
      else checkpoint.hostHalt.observedState = cause;
      host.storage.set("invoke-human-1", copy(checkpoint));
      const original = copy(host.current()), calls = host.hostCalls.length;
      host.setHostResponse();
      expect((await host.execute()).status).toBe("blocked");
      expect(host.hostCalls).toHaveLength(calls);
      expect(host.current()).toEqual(original);
      expect(host.calls).toHaveLength(0);
    });

  test.each(["intention", "failure"])("technical host reconstruction %s cannot dispatch blindly on replay", async cut => {
    const host = fixture(); host.setLimit(1);
    host.setHostResponse(() => { throw Error("Controlled read-only failure"); });
    await host.execute();
    if (cut === "intention") {
      host.setHostResponse();
      cutAt(host, value => value.hostReconstruction?.stage === "intention");
    }
    const second = await host.execute();
    expect(second.status).not.toBe("complete");
    expect(host.calls).toHaveLength(0);
    const calls = host.hostCalls.length;
    host.setFailSave(); host.setHostResponse();
    // A cut before saving the intention has launched nothing, so reentry may
    // safely persist it. A failed attempted inspection cannot renew its route.
    const replay = await host.execute();
    if (cut === "failure") {
      expect(replay.status).toBe("blocked");
      expect(host.hostCalls).toHaveLength(calls);
      expect(host.current().hostReconstruction.stage).toBe("failed");
    } else {
      expect(replay.status).toBe("partial");
      expect(host.current().tasks.change1.completed.status).toBe("complete");
    }
  });

  // Reject a permanent historical-host veto, fabricated Stop classification,
  // repeated completed producers, and renewal/double consumption of loop slots.
  test.each(["inspect-initial"])(
    "current human resolution reconstructs after historical host ambiguity at %s", async target => {
      const host = fixture(); host.setLimit(1);
      host.setHostResponse((key, value) => {
        if (key === target) throw Error(`Host command '${target}' failed: Command stopped because the workflow was aborted.`);
        return value;
      });
      expect((await host.execute()).status).toBe("blocked");
      const original = copy(host.current().hostHalt), count = host.calls.length;
      expect(original).not.toHaveProperty("observedState");
      expect(host.current().association).toBeUndefined();
      const loops = host.current()?.consumedLoops ?? 0;
      host.setHostResponse();
      const input = { unblock: true, resolution: { loop: loops, text: "Continue the same request; reconstruct state under current native policy." } };
      expect((await host.execute(input)).status).toBe("partial");
      expect(host.current().hostHalt).toEqual(original);
      const retained = loops ? host.history().at(-1).resolutions[0] : host.current().resolutions[0];
      expect(retained).toMatchObject({ text: input.resolution.text, hostHalt: original });
      expect(host.history()).toHaveLength(1);
      expect(host.current().tasks.change1.completed.status).toBe("complete");
      const complete = host.calls.length;
      expect((await host.execute(input)).status).toBe("partial");
      expect(host.calls).toHaveLength(complete);
    });

  test.each(["stopped", "pending"])("checkpointed host %s is retained, not fabricated from text", async observedState => {
    const host = fixture(); host.setLimit(1);
    host.setHostResponse(key => { throw Error(`Host command '${key}' failed: Command stopped because the workflow was aborted.`); });
    expect((await host.execute()).status).toBe("blocked");
    // Model an already-retained checkpoint that really has a structured state;
    // the ambiguous native exception in the adjacent test does NOT supply it.
    const checkpoint = host.current();
    checkpoint.hostHalt.observedState = observedState;
    checkpoint.hostHalt.status = observedState === "stopped" ? "cancelled" : "blocked";
    host.storage.set("invoke-human-1", copy(checkpoint));
    const original = copy(checkpoint.hostHalt), calls = host.hostCalls.length;
    host.setHostResponse();
    const output = await host.execute({ unblock: true, resolution: { loop: 0, text: "Continue state reconstruction under current native authority." } });
    expect(output.status).toBe(observedState === "stopped" ? "partial" : "blocked");
    expect(host.current().hostHalt).toEqual(original);
    expect(host.current().resolutions[0].hostHalt).toEqual(original);
    if (observedState === "stopped") expect(host.current().tasks.change1.completed.status).toBe("complete");
    if (observedState === "pending") {
      expect(host.hostCalls).toHaveLength(calls);
      expect(host.calls).toHaveLength(0);
      expect(host.current()).not.toHaveProperty("association");
    }
  });

  test.each(["accepted", "applied"])("host resolution %s cut replays without another human input", async cut => {
    const host = fixture(); host.setLimit(1);
    host.setHostResponse(key => { throw Error(`Host command '${key}' failed: Command stopped because the workflow was aborted.`); });
    expect((await host.execute()).status).toBe("blocked");
    const original = copy(host.current().hostHalt);
    host.setHostResponse();
    cutAt(host, value => value.resolutions?.[0]?.stage === cut);
    expect((await host.execute({ unblock: true, resolution: { loop: 0, text: "Continue bounded state reconstruction under current policy." } })).reason)
      .toContain("Essential persistence failed");
    host.setFailSave();
    expect((await host.execute()).status).toBe("partial");
    const calls = host.calls.length;
    expect((await host.execute()).status).toBe("partial");
    expect(host.calls).toHaveLength(calls);
    expect(host.hostCalls.filter(key => key === "execute-settings")).toHaveLength(0);
    expect(host.current().resolutions).toHaveLength(1);
    expect(host.current().resolutions[0]).toMatchObject({ stage: "applied", hostHalt: original });
    expect(host.current().tasks.change1.completed.status).toBe("complete");
    expect(host.current().hostHalt).toEqual(original);
  });

  // A prior answer does not settle a later failure. Equally, that answer must
  // not turn an otherwise recoverable technical read into a human-only veto.
  test.each(["none", "intention", "admitted"])(
    "technical failure after applied human input reconstructs without another answer at %s", async cut => {
      const host = fixture(); host.setLimit(1);
      const fail = (key: string) => { throw Error(`Host command '${key}' failed: Command stopped because the workflow was aborted.`); };
      host.setHostResponse(fail);
      expect((await host.execute()).status).toBe("blocked");
      const original = copy(host.current().hostHalt);
      host.setHostResponse();
      expect((await host.execute({ unblock: true, resolution: { loop: 0, text: "Continue the interrupted read under current policy." } })).status).toBe("partial");
      host.setHostResponse(fail);
      expect((await host.execute()).status).toBe("blocked"); // identical text, NEW operation
      const later = copy(host.current().hostHalt), writers = host.calls.length;
      expect(host.current().resolutions[0]).toMatchObject({ hostHalt: original, failedHostObservation: later });
      host.setHostResponse();
      if (cut !== "none") {
        cutAt(host, value => value.hostReconstruction?.stage === cut);
        expect((await host.execute()).reason).toContain("Essential persistence failed");
        host.setFailSave();
      }
      expect((await host.execute()).status).toBe("partial");
      expect(host.current().hostReconstruction).toMatchObject({ source: later, stage: "admitted" });
      expect(host.current().resolutions).toHaveLength(1);
      expect(host.current().resolutions[0]).toMatchObject({ hostHalt: original, failedHostObservation: later });
      expect(host.history()).toHaveLength(1);
      expect(host.current().tasks.change1.completed.status).toBe("complete");
      expect(host.calls).toHaveLength(writers);
      expect((await host.execute()).status).toBe("partial");
      expect(host.calls).toHaveLength(writers);
    });

  test.each(["stopped", "pending", "permission", "failed-reconstruction"])(
    "later host %s after applied input remains a real barrier", async cause => {
      const host = fixture(); host.setLimit(1);
      const fail = () => { throw Error("Controlled ambiguous host failure"); };
      host.setHostResponse(fail);
      await host.execute();
      host.setHostResponse();
      expect((await host.execute({ unblock: true, resolution: { loop: 0, text: "Continue the original read under current policy." } })).status).toBe("partial");
      host.setHostResponse(fail);
      expect((await host.execute()).status).toBe("blocked");
      const record = host.current();
      if (cause === "failed-reconstruction") {
        expect((await host.execute()).status).toBe("blocked");
        expect(host.current().hostReconstruction.stage).toBe("failed");
      } else {
        if (cause === "permission") record.hostHalt.observedBarrier = "native permission denial";
        else record.hostHalt.observedState = cause;
        record.resolutions[0].failedHostObservation = copy(record.hostHalt);
      }
      const retained = copy(host.current()), calls = host.hostCalls.length, writers = host.calls.length;
      host.setHostResponse();
      expect((await host.execute()).status).toBe("blocked");
      expect(host.hostCalls).toHaveLength(calls);
      expect(host.calls).toHaveLength(writers);
      expect(host.current()).toEqual(retained);
    });

  test("retained resolution without an exact request match cannot clear host history", async () => {
    const host = fixture(); host.setLimit(1);
    host.setHostResponse(key => { throw Error(`Host command '${key}' failed: Command stopped because the workflow was aborted.`); });
    expect((await host.execute()).status).toBe("blocked");
    host.setHostResponse();
    expect((await host.execute({ unblock: true, resolution: { loop: 0, text: "Continue under current policy." } })).status).toBe("partial");
    host.current().resolutions[0].request.invocation = "unrelated-invocation";
    const retained = copy(host.current()), calls = host.hostCalls.length;
    expect((await host.execute()).status).toBe("blocked");
    expect(host.current()).toEqual(retained);
    expect(host.hostCalls).toHaveLength(calls);
  });

  test.each(["intention", "accepted", "applied", "next-slot", "none"])(
    "loop-three director Stop resolution survives %s cut without replacing completed work", async cut => {
      const host = fixture(undefined, { taskCount: 4 }); host.setLimit(4);
      const target = "invoke-human-1.l3.director";
      host.setRespond((request, normal) => request.key === target ? closedInterruptedProducer(normal()) : normal());
      expect((await host.execute()).status).toBe("cancelled");
      const original = copy(host.history()[2]), completed = copy(host.current().tasks), prior = host.calls.length;
      host.setRespond((request, normal) => request.agent === "pitako.execution-inspector"
        ? host.result(request, { status: "recovered", reason: "Exact settled director original",
          original: copy(host.native.get(target)), workerResult: null, originalAvailable: true,
          binding: "absent", comparison: "only-original", provenance: ["/native/output/" + target + ".json"] }) : normal());
      const input = { unblock: true, resolution: { loop: 3, text: "Continue after the settled director Stop in the next ordinary slot." } };
      if (cut !== "none") cutAt(host, value => cut === "next-slot" ? value.consumedLoops === 4
        : value.loop?.number === 3 && value.loop.resolutions?.[0]?.stage === cut);
      const first = await host.execute(input);
      if (cut !== "none") {
        expect(first.reason).toContain("Essential persistence failed");
        host.setFailSave();
      }
      const output = await host.execute(cut === "intention" ? input : {});
      expect(output).toMatchObject({ status: "partial", loopsConsumed: 4, maxLoops: 4 });
      const record = host.history()[2];
      expect(record.plan).toEqual(original.plan);
      expect(record.resolutions).toHaveLength(1);
      expect(record.resolutions[0]).toMatchObject({ ...input.resolution, stage: "applied", halt: original.halt });
      for (const id of ["change1", "change2"]) expect(host.current().tasks[id]).toEqual(completed[id]);
      expect(host.current().tasks.change3.completed.status).toBe("complete");
      expect(readBacklog(host.root, "spec").backlog?.tasks.find(task => task.id === "change4")?.status).toBe("pending");
      expect(host.calls.slice(prior).every(call => call.agent === "pitako.execution-inspector" ||
        call.key.startsWith("invoke-human-1.l4.") || call.key === "invoke-human-1.l3.gaps" ||
        call.key.startsWith("invoke-human-1.l3.nextAdvance."))).toBe(true);
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(4);
      expect(host.calls.filter(call => call.key === target)).toHaveLength(1);
      expect(host.calls.find(call => call.key === "invoke-human-1.l4.director")?.task).toContain(input.resolution.text);
    });

  test("resolution cannot invent an invocation, clear a scope gap, or replace a pending writer", async () => {
    const fresh = fixture(), input = { unblock: true, resolution: { loop: 0, text: "Continue" } };
    expect((await fresh.execute(input)).status).toBe("blocked");
    expect(fresh.hostCalls).toHaveLength(0);
    const host = fixture();
    host.setRespond((request, normal) => request.agent === "pitako.worker" ? { ...normal(), ok: false, state: "running" } : normal());
    expect((await host.execute()).status).toBe("blocked");
    const count = host.calls.length;
    expect((await host.execute({ ...input, resolution: { ...input.resolution, loop: 1 } })).status).toBe("blocked");
    expect(host.calls).toHaveLength(count);
    expect(host.statusCalls.length).toBeGreaterThan(0);
    const scope = fixture();
    scope.setRespond((request, normal) => {
      const result = normal();
      // Every settled non-complete backlog attempt seals pause; a semantic block still requires authority.
      if (request.agent === "pitako.worker")
        Object.assign(result.structuredOutput, { status: "blocked", work: "Expansion needed: unauthorized external resource", remaining: [] });
      return result;
    });
    expect((await scope.execute()).status).toBe("blocked");
    expect(scope.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind)).toEqual(["pause"]);
    const before = scope.calls.length;
    expect((await scope.execute({ ...input, resolution: { ...input.resolution, loop: 1 } })).status).toBe("blocked");
    expect(scope.calls).toHaveLength(before);
  });

  test.each(["settled", "unknown", "permission", "current-stop"])(
    "historical worker %s uses checkpoint-first recovery without redispatch", async mode => {
      const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
      const target = "invoke-human-1.l1.t1.a1";
      host.setRespond((request, normal) => request.key !== target ? normal() : mode === "unknown"
        ? { ...normal(), ok: false, stopped: true }
        : closedInterruptedProducer(normal(), mode === "permission" ? "permission" : "stopped"));
      expect((await host.executeNative()).status).toBe(mode === "permission" ? "blocked" : "cancelled");
      const count = host.calls.length;
      host.setStatus(ref => {
        const response = copy(host.native.get(ref)!);
        if (response?.key === target && mode !== "permission")
          return { ok: false, output: "", error: "Historical writer unavailable" };
        return response;
      });
      host.setRespond((request, normal) => {
        if (request.key === "invoke-human-1.l1.t1.a2") {
          if (mode === "current-stop") return { ...normal(), ok: false, stopped: true };
          const restore = host.current().loop.attempt.restore;
          const sources = restore.sourceKeys.map((key: string) => host.current().taskFrame.sources.find((source: any) => source.key === key));
          const restored = restoreCheckpoint(sources, restore.authority);
          return host.result(request, { ...host.worker(request), restoreReceipt: {
            ...restored, restoredRef: restored.partialRef.replace(/restore\.json$/, "restored.json") } });
        }
        return normal();
      });
      const output = await host.executeNative({ unblock: true, resolution: { loop: 1,
        text: "Continue the task from its captured checkpoint after the historical interruption." } });
      expect(output.status, output.reason).toBe(mode === "permission" ? "blocked" : mode === "current-stop" ? "cancelled" : "partial");
      expect(host.calls.filter(call => call.key === target)).toHaveLength(1);
      expect(host.calls.some(call => call.key.endsWith(".l2.director"))).toBe(false);
      if (mode === "permission") expect(host.calls).toHaveLength(count);
      else {
        expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a2")).toHaveLength(1);
        if (mode !== "current-stop") expect(host.current().tasks.change1.completed.status).toBe("complete");
      }
      const after = host.calls.length;
      await host.executeNative();
      expect(host.calls).toHaveLength(after);
    });

  // Review and compliance require their exact settled read-only originals.
  test.each(["review", "compliance"].flatMap(phase =>
    ["stopped", "permission", "unknown", "current-stop"].map(mode => ({ phase, mode }))))(
    "historical $phase $mode requires exact settlement and current authority", async ({ phase, mode }) => {
      const host = fixture(undefined, { taskCount: 0 });
      const target = `invoke-human-1.l1.${phase === "worker" ? "t1.a1" : phase === "review" ? "review.director-prepare" : "compliance"}`;
      host.setRespond((request, normal) => request.key !== target ? normal() : mode === "unknown"
        ? { ...normal(), ok: false, stopped: true }
        : closedInterruptedProducer(normal(), mode === "permission" ? "permission" : "stopped"));
      expect((await host.executeNative()).status).toBe(mode === "permission" ? "blocked" : "cancelled");
      const original = copy(host.current()), count = host.calls.length;
      host.setStatus(ref => {
        const response = copy(host.native.get(ref)!);
        if (response?.key === target || ref === `native-${target}` || ref === target) {
          if (mode === "unknown") return { ...response, state: "completed" }; // label alone does not establish closure
          return response;
        }
        return response;
      });
      host.setRespond((request, normal) => request.agent === "pitako.execution-inspector"
        ? host.result(request, { status: mode === "unknown" ? "unresolved" : "recovered", reason: "Exact retained operation receipt; settlement checked",
          original: mode === "unknown" ? null : copy(host.native.get(target)), workerResult: null,
          originalAvailable: mode !== "unknown", binding: "absent", comparison: mode === "unknown" ? "neither" : "only-original",
          provenance: [`/native/output/${target}.json`] })
        : mode === "current-stop" && request.key.endsWith(".l2.director") ? { ...normal(), ok: false, stopped: true } : normal());
      const input = { unblock: true, resolution: { loop: 1, text: "Continue pending work after reconciling the historical interruption." } };
      const output = await host.executeNative(input);
      expect(output.status).toBe(mode === "permission" ? "blocked" : mode === "unknown" || mode === "current-stop" ? "cancelled" : "complete");
      if (mode === "permission") {
        expect(host.calls).toHaveLength(count);
        expect(host.history()).toHaveLength(1);
        expect(host.history()[0].halt).toMatchObject({ code: "native-barrier", cause: "native permission denial" });
        expect(host.history()[0].resolutions[0].stage).toBe("accepted");
        expect((await host.executeNative()).status).toBe("blocked");
        expect(host.calls).toHaveLength(count);
      } else if (mode === "unknown") {
        expect(host.calls).toHaveLength(count + 1); // one exact exceptional observation, not a writer
        expect(host.history()).toHaveLength(1);
      } else {
        expect(host.history()).toHaveLength(2);
        expect(host.history()[0].resolutions[0]).toMatchObject({ stage: "applied", halt: original.loop.halt });
        expect(host.calls.slice(count).every(call => call.agent === "pitako.execution-inspector" || call.key === "invoke-human-1.l1.gaps" ||
          call.key.startsWith("invoke-human-1.l1.nextAdvance.") || call.key.startsWith("invoke-human-1.l2."))).toBe(true);
        const after = host.calls.length;
        await host.executeNative();
        expect(host.calls).toHaveLength(after);
      }
    });

  test("later director Stop needs new current input without reviving an older barrier after application", async () => {
    const host = fixture(), firstDirector = "invoke-human-1.l1.director", director = "invoke-human-1.l2.director";
    host.setLimit(4);
    host.setRespond((request, normal) => request.key === firstDirector ? closedInterruptedProducer(normal()) : normal());
    expect((await host.executeNative()).status).toBe("cancelled");
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.execution-inspector") {
        const target = request.task.includes(`"key":"${director}"`) ? director : firstDirector;
        return host.result(request, { status: "recovered", reason: "Exact complete settled original operation receipt",
          original: copy(host.native.get(target)), workerResult: null, originalAvailable: true,
          binding: "absent", comparison: "only-original", provenance: [`/native/output/${target}.json`] });
      }
      return request.key === director ? closedInterruptedProducer(normal()) : normal();
    });
    expect((await host.executeNative({ unblock: true, resolution: { loop: 1, text: "Continue after the first settled interruption under current policy." } })).status).toBe("cancelled");
    const before = host.calls.length;
    expect((await host.executeNative()).status).toBe("cancelled");
    expect(host.calls).toHaveLength(before);
    expect((await host.executeNative({ unblock: true, resolution: { loop: 2, text: "New current request after the later director Stop: reconcile and continue within the original budget." } })).status).toBe("complete");
    const after = host.calls.length;
    expect((await host.executeNative()).status).toBe("complete");
    expect(host.calls).toHaveLength(after);
    expect(host.history()).toHaveLength(4);
    expect(readBacklog(host.root, "spec").backlog!.tasks.find(task => task.id === "change1")!.status).toBe("done");
    expect(host.current().association.maxCycles).toBe(4);
    expect(host.history()[0].resolutions[0].currentBarrier).toBeUndefined();
    expect(host.snapshots.some(value => value.loop?.number === 2 && value.loop.halt?.cause === "stopped")).toBe(true);
    expect(host.history()[1].resolutions[0]).toMatchObject({ stage: "applied", halt: { cause: "stopped" } });
    expect(host.calls.filter(call => call.key === director)).toHaveLength(1);
  });
});

describe("workflow-owned execute controller", () => {
  // Publication and apply rejection remain distinct durable cuts; replay must
  // not redispatch a director or admit an invalid selection.
  test.each(["none", "publication", "rejection", "next-slot"])("new rejected plan is accounted once across %s cut", async cut => {
    const host = fixture(); host.setLimit(2);
    let original: any;
    host.setRespond((request, normal) => {
      const result = normal();
      if (/^invoke-human-1\.l1\.director(?:\.d1)?$/.test(request.key)) {
        result.structuredOutput.select = "missing";
        original = copy(result.structuredOutput);
      }
      if (request.key === "invoke-human-1.l2.director") {
        expect(host.history()[0]).toMatchObject({ outcome: "gaps", plan: { stage: "rejected" } });
        expect(request.task).toContain("Selected task must be pending");
        expect(request.task).toContain("VERIFIED RETAINED LOOP SUMMARIES");
        expect(request.task).toContain("CLOSED HISTORY REFERENCE");
      }
      return result;
    });
    if (cut !== "none") {
      cutAt(host, value => {
        const first = value.loop;
        return cut === "publication" ? first?.plan?.stage === "published"
          : cut === "rejection" ? first?.plan?.stage === "rejected"
          : value.consumedLoops === 2;
      });
      expect((await host.execute()).status).toBe("partial");
      host.setFailSave();
    }
    expect((await host.execute()).status).toBe("partial");
    const first = host.history()[0];
    expect(first).toMatchObject({ number: 1, outcome: "gaps", cursor: 0, manifest: null, results: [],
      plan: { stage: "rejected", rejection: { diagnostic: expect.stringContaining("Selected task must be pending"), ref: { runId: "native-invoke-human-1.l1.director.d1" } } } });
    expect(host.history()).toHaveLength(2);
    expect(host.history()[1].task.id).toBe("change1");
    expect(host.history()[1].results).toMatchObject([{ taskId: "change1", status: "complete" }]);
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(3);
    expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key.includes(".l1."))).toHaveLength(0);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.native.get("invoke-human-1.l1.director")!.structuredOutput).toEqual(original);
    // The publication cut deliberately failed its write; the surviving intent
    // is reconciled by exact status rather than redispatching the director.
    if (cut !== "publication") {
      const published = host.snapshots.find(value => value.loop?.plan?.stage === "published");
      expect(published.loop.manifest).toBeNull();
      expect(published.loop.outcome).toBeUndefined();
    }
  });

  test("repeated invalid selection consumes frozen slots without dispatching a writer", async () => {
    const host = fixture(); host.setLimit(3);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") result.structuredOutput.select = "missing";
      return result;
    });
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 3 });
    expect(host.history().map(loop => loop.plan.stage)).toEqual(["rejected", "rejected", "rejected"]);
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(6);
    expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
  });

  test.each(["available", "lost", "unresolved"])("last-slot rejection survives optional-cache loss with %s original", async mode => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") result.structuredOutput.select = "missing";
      return result;
    });
    expect(await host.executeNative()).toMatchObject({ status: "partial", loopsConsumed: 1 });
    const retained = copy(host.history()[0]);
    removeCache(host);
    if (mode !== "available") {
      for (const result of host.native.values()) delete result.structuredOutput;
      host.setRespond((request, normal) => request.agent === "pitako.execution-inspector"
        ? host.result(request, { status: mode, reason: "Exact original unavailable", original: null, workerResult: null,
          originalAvailable: false, binding: "unavailable", comparison: "neither", provenance: ["/native/exact-original"] }) : normal());
    }
    const actions = host.calls.map(call => call.key), statuses = host.statusCalls.length;
    expect(await host.executeNative()).toMatchObject({ status: "partial", loopsConsumed: 1 });
    expect(host.history()[0]).toEqual(retained);
    expect(host.calls.map(call => call.key)).toEqual(actions);
    expect(host.statusCalls).toHaveLength(statuses);
  });

  test("essential rejection write failure stops dispatch until exact selection can be reconciled", async () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") result.structuredOutput.select = "missing";
      return result;
    });
    cutAt(host, value => value.loop?.plan?.stage === "rejected");
    expect((await host.executeNative()).reason).toContain("Essential persistence failed");
    expect(host.calls.some(call => call.key.endsWith(".gaps") || call.agent === "pitako.worker")).toBe(false);
    expect(host.history()[0].plan.stage).toBe("published");
    expect(host.history()[0].plan.ref.key).toBe("invoke-human-1.l1.director.d1");
    host.setFailSave();
    expect(await host.executeNative()).toMatchObject({ status: "partial", loopsConsumed: 1 });
    expect(host.history()[0].plan.stage).toBe("rejected");
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(2);
    expect(host.statusCalls).toContain("native-invoke-human-1.l1.director.d1");
  });

  test("last-slot rejection remains a durable accounted gap without another director", async () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") result.structuredOutput.select = "missing";
      return result;
    });
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 1 });
    expect(host.history()[0]).toMatchObject({ outcome: "gaps", plan: { stage: "rejected" } });
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 1 });
    expect(host.calls.filter(call => call.agent !== "pitako.loop-io").map(call => call.key)).toEqual(["invoke-human-1.l1.advance.requests", "invoke-human-1.l1.director", "invoke-human-1.l1.director.d1", "invoke-human-1.l1.gaps"]);
    expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "loop"]);
  });

  test("distinct diagnosed selection defects retain their diagnoses without renewing slots", async () => {
    const host = fixture(); host.setLimit(2);
    host.setRespond((request, normal) => {
      const result = normal();
      if (/^invoke-human-1\.l1\.director(?:\.d1)?$/.test(request.key)) result.structuredOutput.select = "missing";
      if (/^invoke-human-1\.l2\.director(?:\.d1)?$/.test(request.key)) result.structuredOutput.changes[0].task.gates = [];
      return result;
    });
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 2 });
    expect(host.history().map(loop => loop.plan.stage)).toEqual(["rejected", "rejected"]);
    expect(host.history()[0].plan.rejection.diagnostic).toContain("pending");
    expect(host.history()[1].plan.rejection.diagnostic).toContain("focused gates");
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(4);
    expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
  });

  test.each(["producer", "binding", "stopped", "permission", "pending", "schema-no-original"])(
    "structural defect cannot hide %s barrier or authority conflict", async mode => {
      const host = fixture(); host.setLimit(2);
      host.setRespond((request, normal) => {
        if (mode === "permission" && request.agent === "pitako.execution-director") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
        const result = normal();
        if (request.agent === "pitako.execution-inspector") {
          result.structuredOutput = { status: "lost", reason: "No usable exact original", original: null, workerResult: null,
            originalAvailable: false, binding: "absent", comparison: "neither", provenance: ["/native/original-unavailable"] };
          return result;
        }
        if (request.agent !== "pitako.execution-director") return result;
        result.structuredOutput.select = "missing";
        if (mode === "producer") result.agent = "unrelated-producer";
        if (mode === "binding") result.output = JSON.stringify({ ...result.structuredOutput, reason: "Different binding" });
        if (mode === "stopped") result.stopped = true;
        if (mode === "pending") result.state = "pending";
        if (mode === "schema-no-original") { result.ok = false; delete result.structuredOutput; result.error = "Native schema rejected"; }
        return result;
      });
      const output = await host.execute();
      expect(output.status).toBe(mode === "stopped" ? "cancelled" : "blocked");
      expect(host.history()).toHaveLength(1);
      expect(host.history()[0].plan.stage).not.toBe("rejected");
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
      expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
      if (["producer", "binding"].includes(mode)) {
        const calls = host.calls.length;
        host.setRespond(undefined);
        host.setStatus(() => ({ ok: true, output: "", structuredOutput: host.plan() }));
        expect((await host.execute()).status).toBe("blocked");
        expect(host.calls).toHaveLength(calls);
        expect(host.history()[0].plan.stage).not.toBe("rejected");
      }
    },
  );

  test.each(["capacity", "stopped", "permission", "pending"])("rejected plan does not bypass next-director %s barrier", async mode => {
    const host = fixture(); host.setLimit(2);
    host.setRespond((request, normal) => {
      const result = normal();
      if (/^invoke-human-1\.l1\.director(?:\.d1)?$/.test(request.key)) result.structuredOutput.select = "missing";
      if (request.key === "invoke-human-1.l2.director") {
        if (mode === "capacity") Object.assign(result, { ok: false, error: "Active async run capacity exhausted: 4/4 used." });
        if (mode === "stopped") result.stopped = true;
        if (mode === "permission") Object.assign(result, { ok: false, error: "Blocked by pi-subagents permission rule: 'run' is denied." });
        if (mode === "pending") result.state = "pending";
      }
      return result;
    });
    expect((await host.execute()).status).toBe(mode === "stopped" ? "cancelled" : mode === "capacity" ? "partial" : "blocked");
    expect(host.history()).toHaveLength(2);
    expect(host.history()[0]).toMatchObject({ outcome: "gaps", plan: { stage: "rejected" } });
    expect(host.history()[1].plan.stage).not.toBe("rejected");
    expect(host.calls.filter(call => call.agent !== "pitako.loop-io").map(call => call.key)).toEqual(["invoke-human-1.l1.advance.requests", "invoke-human-1.l1.director", "invoke-human-1.l1.director.d1", "invoke-human-1.l1.gaps", "invoke-human-1.l1.nextAdvance.requests", "invoke-human-1.l2.director"]);
    expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
  });

  test("exact recovered original can establish rejection eligibility after native schema failure", async () => {
    const host = fixture(); host.setLimit(2);
    let original: any;
    const recoverySubjects: any[] = [];
    host.setRespond((request, normal) => {
      const result = normal();
      if (/^invoke-human-1\.l1\.director(?:\.d1)?$/.test(request.key)) {
        original = copy(result.structuredOutput); original.select = "missing";
        delete result.structuredOutput; result.ok = false; result.error = "Native schema rejected";
      }
      if (request.agent === "pitako.execution-inspector") {
        recoverySubjects.push(copy(host.history()[0].recoveries.at(-1)));
        result.structuredOutput = { status: "recovered", reason: "Exact settled producer original", original: copy(original),
          workerResult: null, originalAvailable: true, binding: "identical", comparison: "equal-full-json",
          provenance: ["/native/witness/invoke-human-1.l1.director.json"] };
      }
      return result;
    });
    const outcome = await host.execute();
    expect(outcome.status, outcome.reason).toBe("partial");
    expect(host.history()[0].plan).toMatchObject({ stage: "rejected",
      rejection: { diagnostic: "Selected task must be pending" }, recoverySource: { comparison: "equal-full-json" } });
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(2);
    expect(recoverySubjects).toMatchObject([
      { subject: "loop-plan", source: { key: "invoke-human-1.l1.director" }, stage: "intention", disposition: "pending" },
      { subject: "loop-plan:d1", source: { key: "invoke-human-1.l1.director.d1" }, stage: "intention", disposition: "pending" },
    ]);
    expect(original.select).toBe("missing");
    expect(host.history()[1].results).toMatchObject([{ taskId: "change1", status: "complete" }]);
  });

  test("native schema failure with a complete settled original uses it before optional recovery", async () => {
    const host = fixture(); host.setLimit(2);
    host.setRespond((request, normal) => {
      const result = normal();
      if (/^invoke-human-1\.l1\.director(?:\.d1)?$/.test(request.key)) {
        result.structuredOutput.select = "missing";
        result.ok = false; result.error = "Native schema rejected";
      }
      return result;
    });
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 2 });
    expect(host.history()[1].results).toMatchObject([{ taskId: "change1", status: "complete" }]);
    expect(host.history()[0].plan.stage).toBe("rejected");
    expect(host.statusCalls).toEqual([]);
    expect(host.calls.some(call => call.agent === "pitako.execution-inspector")).toBe(false);
  });

  test("native director returns selections while the root attaches the actual association on each task loop", async () => {
    const host = fixture(undefined, { taskCount: 2 }); host.setLimit(2);
    const sourceRefs = [{ path: "/stable/inherited.md", digest: "f".repeat(64) }];
    const known: any[] = [];
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.worker") {
        const expected = JSON.parse(request.task.split("ASSOCIATION (data): ")[1]!.split("\n")[0]!);
        expect(host.current().loop.plan.association).toEqual(expected);
        known.push(copy(expected));
      }
      return normal();
    });
    expect((await host.executeNative({ sourceRefs })).status).toBe("partial");
    const directors = host.calls.filter(request => request.key.endsWith(".director"));
    expect(directors).toHaveLength(2);
    for (const request of directors) {
      const selection = host.native.get(request.key)!.structuredOutput;
      const original = copy(selection);
      const tool = { name: "selection", description: "Published backlog selection", parameters: request.outputSchema };
      const validate = (value: any) => validateToolArguments(tool, { type: "toolCall", id: "selection", name: tool.name, arguments: value });
      expect(selection).not.toHaveProperty("association");
      expect(request.outputSchema.properties).not.toHaveProperty("association");
      expect(validate(selection)).toEqual(selection);
      expect(() => validate({ ...selection, association: { digest: "mistyped" } })).toThrow();
      expect(selection).toEqual(original);
    }
    expect(known.map(value => value.loop)).toEqual([1, 2]);
    expect(known.every(value => JSON.stringify(value.sourceRefs) === JSON.stringify(sourceRefs))).toBe(true);
  });

  test.each([false, true])("backlog insertion order does not override the single selected definition (%s)", async reverse => {
    const host = fixture("FULL SPECS WITH INDEPENDENT OBLIGATIONS", { taskCount: 2 }); host.setLimit(2);
    const published: any[] = [];
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) {
        if (request.key.includes(".l1.")) {
          if (reverse) result.structuredOutput.changes.reverse();
          result.structuredOutput.select = "change2";
        }
        published.push(copy(result.structuredOutput));
        expect(request.outputSchema.properties).not.toHaveProperty("tasks");
      }
      return result;
    });
    expect((await host.executeNative()).status).toBe("partial");
    const workers = host.calls.filter(call => call.agent === "pitako.worker");
    expect(workers).toHaveLength(2);
    const definitions = published[0].changes.map((change: any) => change.task);
    for (const [index, call] of workers.entries()) {
      const selected = JSON.parse(call.task.split("COMPLETE SELECTED TASK:\n")[1]!.split("\nTASK CONTINUATION")[0]!);
      expect(selected.id).toBe(published[index].select);
      const definition = definitions.find((task: any) => task.id === selected.id);
      expect(selected).toMatchObject({ ...definition,
        history: [{ event: "add", reason: "From complete spec" }] });
      expect(call.task).toContain("DIRECT PREREQUISITE COMPLETED RESULTS (historical references, not current check evidence):\n[]");
      expect(call.task).not.toContain("FROZEN ATTEMPT");
    }
    expect(workers.map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l2.t1.a1"]);
    expect(host.current().activePlan).toBeNull();
    expect(host.current().loop.manifest).toEqual(["change1"]);
    expect(host.calls.some(call => call.key.includes(".review.") || call.key.endsWith(".compliance"))).toBe(false);
  });

  test.each([
    undefined, null, {}, [null], [{}], [{ taskId: "change1", reason: "old ordered contract" }], [""], ["  "],
  ].map(invalid => ({ invalid })))("apply rejects incompatible dependency metadata %j", async ({ invalid }) => {
    const host = fixture(undefined, { taskCount: 2 }); host.setLimit(2);
    host.setRespond((request, normal) => {
      const selectionApply = request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "apply";
      const file = readBacklog(host.root, "spec").path;
      const before = existsSync(file) ? readFileSync(file, "utf8") : null;
      const result = normal();
      if (selectionApply) expect(existsSync(file) ? readFileSync(file, "utf8") : null).toBe(before);
      if (request.agent === "pitako.execution-director") result.structuredOutput.changes[0].task.dependsOn = invalid;
      return result;
    });
    const output = await host.execute();
    expect(output.status).toBe("partial");
    const diagnostic = host.history()[0].plan.rejection.diagnostic;
    expect(diagnostic).toMatch(/references|dependency/);
    expect(host.history().every(loop => loop.plan.stage === "rejected" && loop.outcome === "gaps")).toBe(true);
    expect(host.calls.find(call => call.key.endsWith(".l2.director"))!.task).toContain(diagnostic);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
  });

  test.each(["unknown", "self", "unfinished", "cycle"])("%s backlog dependency cannot dispatch a writer", async mode => {
    const host = fixture(undefined, { taskCount: 2 }); host.setLimit(2);
    host.setRespond((request, normal) => {
      const selectionApply = request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "apply";
      const file = readBacklog(host.root, "spec").path;
      const before = existsSync(file) ? readFileSync(file, "utf8") : null;
      const result = normal();
      if (selectionApply) expect(existsSync(file) ? readFileSync(file, "utf8") : null).toBe(before);
      if (request.agent === "pitako.execution-director") {
        const tasks = result.structuredOutput.changes.map((change: any) => change.task);
        tasks[0].dependsOn = [mode === "unknown" ? "missing" : mode === "self" ? "change1" : "change2"];
        if (mode === "cycle") tasks[1].dependsOn = ["change1"];
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status).toBe("partial");
    const diagnostic = host.history()[0].plan.rejection.diagnostic;
    expect(host.history().every(loop => loop.plan.stage === "rejected" && loop.outcome === "gaps")).toBe(true);
    expect(host.calls.find(call => call.key.endsWith(".l2.director"))!.task).toContain(diagnostic);
    expect(diagnostic).toMatch(/dependency|dependencies/);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
  });

  test.each(["before-result", "before-cursor"])("done prerequisite handoff survives %s cut without rerunning the completed writer", async cut => {
    const host = fixture(undefined, { taskCount: 2 }); host.setLimit(2);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.director")
        result.structuredOutput.changes[1].task.dependsOn = ["change1"];
      if (request.key === "invoke-human-1.l1.t1.a1")
        Object.assign(result.structuredOutput, { status: "continue", remaining: ["Finish the assigned API"] });
      if (request.key === "invoke-human-1.l2.t1.a1") {
        const references = JSON.parse(request.task.split("DIRECT PREREQUISITE COMPLETED RESULTS (historical references, not current check evidence):\n")[1]!.split("\nRead relevant")[0]!);
        expect(references).toEqual([{ taskId: "change1", status: "done", source: host.current().backlogPath }]);
        expect(request.task).toContain("do not automatically repeat all prerequisite gates");
      }
      return result;
    });
    cutAt(host, value => value.loop?.number === 1 && (cut === "before-result"
      ? value.loop.attempt?.number === 2 && value.loop.attempt.stage === "result"
      : value.loop.cursor === 1));
    expect((await host.execute()).status).toBe("partial");
    expect(host.calls.some(call => call.key.includes(".l2."))).toBe(false);
    host.setFailSave();
    expect((await host.execute()).status).toBe("partial");
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a2")).toHaveLength(1);
    expect(host.calls.filter(call => call.key === "invoke-human-1.l2.t1.a1")).toHaveLength(1);
    expect(host.history().map((loop: any) => loop.manifest)).toEqual([["change1"], ["change2"]]);
  });

  test.each(["continue", "gaps"])("a %s worker result never satisfies a backlog prerequisite", async status => {
    const host = fixture(undefined, { taskCount: 2 }); host.setLimit(2);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.director")
        result.structuredOutput.changes[1].task.dependsOn = ["change1"];
      if (/^invoke-human-1\.l2\.director(?:\.d1)?$/.test(request.key)) result.structuredOutput.select = "change2";
      if (request.agent === "pitako.worker")
        Object.assign(result.structuredOutput, { status, remaining: ["Unfinished API"] });
      return result;
    });
    expect((await host.execute()).status).toBe("partial");
    expect(host.calls.some(call => call.key === "invoke-human-1.l2.t1.a1")).toBe(false);
    expect(host.history()[1].plan.rejection.diagnostic).toContain("unfinished dependencies");
    expect(host.current().lastConfirmed?.kind).not.toBe("unit");
  });

  test("an incompatible v5 admitted contract is retained without dispatch or migration", async () => {
    const host = fixture();
    cutAt(host, value => value.loop?.attempt?.stage === "intention");
    expect((await host.execute()).status).toBe("partial");
    host.setFailSave();
    const saved = copy(host.current()); saved.version = 5;
    host.storage.set("invoke-human-1", saved);
    const calls = host.calls.length;
    expect((await host.execute()).reason).toContain("incompatible Pitako contract v5");
    expect(host.calls).toHaveLength(calls);
    expect(host.current()).toEqual(saved);
  });

  test.each([1, 2, 4])("admitted limit %s controls every gap report and dispatch, independent of later settings", async limit => {
    const host = fixture(); host.setLimit(limit);
    host.setRespond((request, normal) => request.key.endsWith(".compliance") ? gaps(normal()) : normal());
    const output = await host.execute();
    expect(output).toMatchObject({ status: "partial", loopsConsumed: limit, maxLoops: limit });
    expect(host.current().association.maxCycles).toBe(limit);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(limit);
    for (const report of host.emits) {
      expect(report.maxLoops).toBe(limit);
      if (report.type !== "execution-loop") continue;
      expect(report.next).toBe(report.loop < limit ? `continue loop ${report.loop + 1}` : "new invocation requires human authorization");
      if (report.loop === limit) for (const reason of [report.reason, report.pending[0].reason, report.actionRequired])
        expect(reason).toContain("new invocation with human authorization");
    }
    const before = copy(host.current()), dispatches = host.calls.length;
    const settingsReads = host.hostCalls.filter(key => key === "execute-settings").length;
    host.setLimit(limit + 10);
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: limit, maxLoops: limit });
    expect(host.current()).toEqual(before); expect(host.calls).toHaveLength(dispatches);
    expect(host.hostCalls.filter(key => key === "execute-settings")).toHaveLength(settingsReads);
  });

  test.each([1, 2, 4])("limit %s permits early fulfillment without requesting another invocation", async limit => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(limit);
    expect(await host.execute()).toMatchObject({ status: "complete", maxLoops: limit, loopsConsumed: 1, actionRequired: "none" });
    for (const report of host.emits.filter(item => item.type === "execution-loop")) {
      expect(report).toMatchObject({ status: "complete", maxLoops: limit, next: "close", actionRequired: "none", pending: [] });
    }
  });

  test("coalesced admission cannot invent a default when its required receipt is absent or invalid", async () => {
    for (const admission of [undefined, {}, { maxCycles: false }, { maxCycles: 0 }]) {
      const host = fixture();
      host.setHostResponse((key, value) => key === "inspect-initial" ? { ...value, admission } : value);
      const output = await host.execute({ settings: undefined });
      expect(output).toMatchObject({ status: "blocked", loopsConsumed: 0, phase: "admission" });
      expect(output.reason).toContain("Invalid pitako.execute.maxCycles admission receipt");
      expect(host.calls).toEqual([]);
      expect(host.storage.size).toBe(0);
      expect(host.hostCalls).toEqual(["inspect-initial"]);
    }
  });

  test("ten authorized loops are not clamped by former closing grants", async () => {
    const host = fixture(undefined, { readOnly: true, taskCount: 0 }); host.setLimit(10);
    host.setRespond((request, normal) => {
      const result = normal();
      return request.key.endsWith(".compliance") && !request.key.includes(".l9.") ? gaps(result) : result;
    });
    const output = await host.execute();
    expect(output).toMatchObject({ status: "complete", loopsConsumed: 9, maxLoops: 10 });
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(9);
    expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(5);
    expect(host.hostCalls).toEqual(["inspect-initial"]);
    expect(host.current().association.maxCycles).toBe(10);
    const refs = host.history().filter((loop: any) => loop.closing).map((loop: any) => loop.closing.ref);
    for (const field of ["runId", "asyncDir"]) expect(new Set(refs.map((ref: any) => ref[field])).size).toBe(5);
    for (const field of ["stdoutPath", "stderrPath"]) expect(new Set(refs.map((ref: any) => ref.externalAdapter.outputArtifacts[field])).size).toBe(5);
  });

  test("new human invocation admits new settings without changing old native records", async () => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1); expect((await host.execute()).status).toBe("complete");
    const previous = copy(host.current()), oldStore = copy(Object.fromEntries(host.storage));
    // Another explicit mission/invocation owns its own marker; original store stays intact.
    const next = fixture(); next.storage.set("prior-invocation-history", oldStore); next.setLimit(4);
    expect(await next.execute({ invocation: "human-2", missionId: "another-mission", missionPath: "/native/another-mission.json" }))
      .toMatchObject({ status: "complete", maxLoops: 4 });
    expect(next.storage.get("invoke-human-2").association.maxCycles).toBe(4);
    expect(host.current()).toEqual(previous);
    expect(next.storage.get("prior-invocation-history")).toEqual(oldStore);
  });

  test.each([2, 3, 4, 5, 6])("prior retained state v%s fails before any resume or dispatch with the actionable message", async version => {
    const host = fixture();
    host.setRespond((request, normal) => request.key.endsWith(".compliance") ? gaps(normal()) : normal());
    await host.execute();
    for (const field of ["invoke-human-1", "pitako-execution"]) {
      const old = copy(host.storage.get(field)); old.version = version;
      host.storage.set(field, old);
      const before = copy([...host.storage.entries()]), reads = host.hostCalls.length, calls = host.calls.length;
      const output = await host.execute();
      expect(output.status).toBe("blocked");
      expect(output.reason).toContain(`created by an incompatible Pitako contract v${version}; start a new mission`);
      expect([...host.storage.entries()]).toEqual(before);
      expect(host.calls).toHaveLength(calls); expect(host.hostCalls).toHaveLength(reads);
      old.version = EXECUTE_STATE_VERSION; host.storage.set(field, old);
    }
  });

  test.each([0, -1, 1.5, "4", true, null, Number.MAX_SAFE_INTEGER + 1])("invalid admission receipt %s consumes no cycle or director", async invalid => {
    const host = fixture(); host.setHostResponse((key, value) => key === "inspect-initial" ? { ...value, admission: { maxCycles: invalid } } : value);
    expect(await host.execute()).toMatchObject({ status: "blocked", loopsConsumed: 0 });
    expect(host.calls).toHaveLength(0); expect(host.storage.size).toBe(0);
  });

  test.each(["stopped", "permission"])("halt-save failure preserves %s AND persistence across reports and replay without dispatch", async cause => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") return { ...result, ok: false,
        ...(cause === "stopped" ? { stopped: true } : { error: "Blocked by pi-subagents permission rule: fixture" }) };
      return result;
    });
    cutAt(host, value => !!value.loop?.halt);
    const output = await host.execute();
    expect(output.status).toBe(cause === "stopped" ? "cancelled" : "blocked");
    expect(output.reason).toContain("Essential persistence failed");
    for (const report of host.emits.filter(item => item.type === "execution-loop")) {
      expect(report).toEqual(output.loopReport);
      expect(report.next).toBe("restore essential persistence; resolve observed impediment before any continuation");
      for (const reason of [report.reason, report.pending[0].reason, report.actionRequired, output.reason, output.actionRequired]) {
        expect(reason).toContain("Essential persistence failed");
        expect(reason).toContain(cause === "stopped" ? "stopped" : "permission");
        expect(reason).not.toContain("new invocation");
      }
    }
    const calls = copy(host.calls); host.setFailSave();
    const replay = await host.execute();
    expect(replay.status).toBe(output.status); expect(replay.loopReport.next).toBe("resolve observed impediment");
    expect(host.calls).toEqual(calls); expect(replay.loopsConsumed).toBe(1);
  });

  test.each([
    ["worker", "stopped", "essential"], ["worker", "permission", "essential"],
    ["review", "stopped", "essential"], ["review", "permission", "essential"],
    ["worker", "detached", "essential"], ["review", "recovery", "essential"],
    ["worker", "stopped", "optional"], ["review", "permission", "optional"],
  ])("pre-attachment %s %s survives %s save failure in every report", async (phase, cause, saveKind) => {
    const host = fixture(undefined, { taskCount: phase === "worker" ? 1 : 0 }); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (phase === "worker" ? request.agent === "pitako.worker" : request.key.endsWith("director-prepare"))
        return { ...result, ok: false, ...(cause === "permission"
          ? { error: "Blocked by pi-subagents permission rule: fixture" } : { [cause!]: true }) };
      return result;
    });
    host.setFailSave(value => {
      const loop = value.loop;
      const observed = phase === "worker" ? !!loop?.attempt?.launch : !!loop?.review;
      return observed && (saveKind === "optional" ? !!value.activePlan : !value.activePlan);
    });
    const output = await host.execute();
    if (saveKind === "optional") expect(host.snapshots.every(value => !value.activePlan)).toBe(true);
    expectImpediment(host, output, cause === "stopped" ? "cancelled" : "blocked", cause!,
      saveKind === "essential" ? "Essential persistence failed" : undefined);
    expect(output.maxLoops).toBe(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(phase === "worker" ? 1 : 0);
    expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
    expect(host.hostCalls.filter(key => key === "inspect-initial")).toHaveLength(1);
  });

  test.each([["decision", "essential"], ["worker", "essential"], ["decision", "optional"], ["worker", "optional"]])(
    "%s block survives pre-finish %s save failure without replacing its reason", async (phase, saveKind) => {
      const host = fixture(undefined, { taskCount: phase === "worker" ? 1 : 0 }); host.setLimit(1);
      const reason = "Decision required: conflicting source obligations";
      host.setRespond((request, normal) => {
        const result = normal();
        if (phase === "decision" && request.key.endsWith(".compliance"))
          Object.assign(result.structuredOutput, { status: "blocked", reason });
        if (phase === "worker" && request.agent === "pitako.worker")
          Object.assign(result.structuredOutput, { status: "blocked", diagnosis: reason, remaining: [reason] });
        return result;
      });
      host.setFailSave(value => (value.loop?.outcome === "blocked" || value.loop?.halt?.status === "blocked") &&
        (saveKind === "optional" ? !!value.activePlan : !value.activePlan));
      const output = await host.execute();
      if (saveKind === "optional") expect(host.snapshots.every(value => !value.activePlan)).toBe(true);
      expectImpediment(host, output, "blocked", reason,
        saveKind === "essential" ? "Essential persistence failed" : undefined);
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(phase === "worker" ? 1 : 0);
      const dispatches = () => host.calls.filter(call => call.agent === "pitako.worker" || call.key.endsWith(".director"));
      const calls = copy(dispatches()), reads = host.hostCalls.filter(key => key === "execute-settings").length;
      host.setFailSave(); host.setLimit(4); host.emits.length = 0;
      const replay = await host.execute();
      expectImpediment(host, replay, "blocked", reason);
      expect(replay.maxLoops).toBe(1); expect(dispatches()).toEqual(calls);
      expect(host.hostCalls.filter(key => key === "execute-settings")).toHaveLength(reads);
    });

  test.each([1, 2])("blocked result is atomic and old committed cut replays as blocked at limit %s", async limit => {
    const host = fixture(); host.setLimit(limit);
    const reason = "Human decision required before editing the conflicting API";
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") Object.assign(result.structuredOutput,
        { status: "blocked", diagnosis: reason, remaining: [reason] });
      return result;
    });
    expect(await host.execute()).toMatchObject({ status: "blocked", loopsConsumed: 1 });
    const committed = host.snapshots.find(value => value.loop?.attempt?.stage === "result");
    const cut = copy(committed);
    delete cut.loop.outcome; delete cut.loop.halt; cut.activePlan = null;
    host.storage.set("invoke-human-1", cut);
    const before = copy(cut), calls = copy(host.calls), reads = host.hostCalls.filter(key => key === "execute-settings").length;
    host.setLimit(4); host.emits.length = 0;
    const replay = await host.execute();
    expectImpediment(host, replay, "blocked", reason);
    // The root pause seal of the blocked result may only finish its idempotent
    // archive under the already-dispatched ledger key; no worker/director repeats.
    expect(replay.maxLoops).toBe(limit); expect(host.calls.slice(0, calls.length)).toEqual(calls);
    const sealKeys = calls.filter((call: any) => call.agent === "pitako.execution-ledger").map((call: any) => call.key);
    expect(host.calls.slice(calls.length).every(call => call.agent === "pitako.execution-ledger" && sealKeys.includes(call.key))).toBe(true);
    expect(host.current().loop.attempt).toEqual(before.loop.attempt);
    expect(host.current().tasks).toEqual(before.tasks);
    expect(host.hostCalls.filter(key => key === "execute-settings")).toHaveLength(reads);
    expect(committed.loop).toMatchObject({ outcome: "blocked",
      halt: { status: "blocked", code: "semantic-block", reason } });
    expect(replay.loopReport.halt.ref).toEqual(committed.loop.attempt.result.ref);
    expect(replay.loopReport.work).toEqual(resolvedLoop(committed).results.map((result: any) => ({
      taskId: result.taskId, attempt: result.attempt, status: result.status, reference: result.ref,
      workDone: result.workDone, remaining: result.remaining, remainingCount: result.remainingCount, diagnosis: result.diagnosis,
    })));
  });

  test("complete additional spec sources are immutable context for all fresh phases", async () => {
    const host = fixture("SELECTED SNAPSHOT INTACT");
    const sourceRefs = [{ path: "/stable/.pitako/plans/inherited.md", digest: "f".repeat(64) }];
    expect((await host.execute({ sourceRefs })).status).toBe("complete");
    expect(host.current().association.sourceRefs).toEqual(sourceRefs);
    for (const request of host.calls.filter(call => !call.resume && call.agent !== "pitako.loop-io" && call.agent !== "pitako.checkout-observer" && call.agent !== "pitako.execution-ledger" && call.agent !== "pitako.request-observer" && call.agent !== "pitako.checkpoint-sealer" && call.agent !== "pitako.access-verifier")) {
      expect(request.task).toContain("SELECTED SNAPSHOT INTACT");
      expect(request.task).toContain(JSON.stringify(sourceRefs));
      expect(request.task).toContain("read EVERY referenced source IN FULL");
    }
    const count = host.calls.length;
    expect((await host.execute({ sourceRefs: [] })).status).toBe("blocked"); expect(host.calls).toHaveLength(count);
  });

  test("semantic block and halt-save failure both survive every report without exhaustion advice", async () => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".compliance")) Object.assign(result.structuredOutput,
        { status: "blocked", reason: "Decision required: conflicting source obligations" });
      return result;
    });
    cutAt(host, value => value.loop?.halt?.code === "semantic-block");
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    for (const report of host.emits.filter(value => value.type === "execution-loop")) {
      expect(report.status).toBe("blocked"); expect(report.next).toContain("resolve observed impediment");
      for (const reason of [report.reason, report.pending[0].reason, report.actionRequired, output.reason, output.actionRequired]) {
        expect(reason).toContain("Decision required"); expect(reason).toContain("Essential persistence failed");
        expect(reason).not.toContain("new invocation");
      }
    }
  });
  test("full shared review assembly validates and runs through the native sandbox with sequential fresh workers", async () => {
    expect(validateWorkflowScript(`const config = ${JSON.stringify(config)};\n${source}`).ok).toBe(true);
    const host = fixture("ALL COMPLETE SPEC SECTIONS");
    const output = await host.executeNative();
    expect(output.status).toBe("complete"); expect(output.loopsConsumed).toBe(2);
    const director = host.calls.find(call => call.agent === "pitako.execution-director")!;
    expect(director).toMatchObject({ key: "invoke-human-1.l1.director", label: "Plan execution work", phase: "planning" });
    expect(director.agent).toBe("pitako.execution-director"); expect(director.task).toContain("then END");
    expect(Object.keys(director.outputSchema.properties).sort()).toEqual(["acceptance", "changes", "reason", "select"]);
    expect(host.snapshots.some(value => value.loop?.plan?.stage === "intention")).toBe(true);
    const workers = host.calls.filter(call => call.agent === "pitako.worker"); expect(workers).toHaveLength(1);
    for (const worker of workers) {
      const selectedTask = JSON.parse(worker.task.split("COMPLETE SELECTED TASK:\n")[1]!.split("\nTASK CONTINUATION")[0]!);
      expect(worker).toMatchObject({ label: selectedTask.title ?? selectedTask.id, phase: "implementation" });
      expect(worker).toMatchObject({ context: "fresh", cwd: host.root, timeoutMs: 14400000, reads: false, progress: false, acceptance: { level: "none" } });
      expect(worker.acceptance.reason).toContain("root owns"); expect(worker.async).toBeUndefined();
      expect(worker.task).toContain("ALL COMPLETE SPEC SECTIONS"); expect(worker.task).toContain("COMPLETE SHARED CONTEXT");
      expect(worker.task).toContain("No delegation, next-task selection, private diary");
    }
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.calls.filter(call => call.key.endsWith(".compliance"))).toHaveLength(1);
    const compliance = host.calls.find(call => call.key.endsWith(".compliance"))!;
    expect(compliance).toMatchObject({ label: "Check whole-spec compliance", phase: "compliance" });
    for (const call of [director, ...workers, compliance]) {
      expect(call.task.startsWith(`${call.label}\n\n`)).toBe(true);
      expect(call.task).toContain("CURRENT HUMAN RESOLUTIONS (accepted input, not new permissions): ");
      expect(call.task).toContain("ASSOCIATION (data): ");
    }
    expect(host.calls.findIndex(call => call.key.endsWith(".compliance"))).toBeGreaterThan(host.calls.findIndex(call => call.key.endsWith("director-synthesis")));
    expect(host.hostCalls).toEqual(["inspect-initial"]);
    expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(1);
    expect(output.actionRequired).toBe("none"); expect(output.reason).toContain("No more loops");
    expect(host.current().loop.finalAttempt.gate.receipt).toMatchObject({ mutated: false, gates: [{ id: "full", status: "pass", exit: 0 }] });
    expect(host.history()[0].plan.ref).toMatchObject({ agent: "pitako.execution-director", runId: "native-invoke-human-1.l1.director",
      outputReference: "/native/output/invoke-human-1.l1.director.json", outputArtifactPath: "/native/binding/invoke-human-1.l1.director.json",
      outputPathMapping: { requestedPath: "invoke-human-1.l1.director.json", savedPath: "/native/remapped/invoke-human-1.l1.director.json" },
      results: [{ structuredOutputPath: "/native/witness/invoke-human-1.l1.director.json" }] });
    expect(host.current().association.digest).toBe(digest("ALL COMPLETE SPEC SECTIONS"));
  });

  test("Fleet labels use short titles without truncating the selected task", async () => {
    const host = fixture(); host.setLimit(1);
    const goal = "  Fix recovery\n after\t timeout " + "with complete evidence ".repeat(12);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) {
        result.structuredOutput.changes[0].task.goal = goal;
        result.structuredOutput.changes[0].task.title = "Fix recovery";
      }
      return result;
    });
    expect((await host.execute()).status).toBe("partial");
    expect(host.current().tasks.change1.completed.status).toBe("complete");
    const worker = host.calls.find(call => call.agent === "pitako.worker")!;
    expect(worker.label).toBe("Fix recovery");
    expect(worker.label).not.toContain("with complete evidence");
    expect(worker.label).toBe(worker.task.split("\n")[0]);
    expect(worker.key).toBe("invoke-human-1.l1.t1.a1");
    const selectedTask = JSON.parse(worker.task.split("COMPLETE SELECTED TASK:\n")[1]!.split("\nTASK CONTINUATION")[0]!);
    expect(selectedTask.goal).toBe(goal);
  });

  test.each([["stopped", "cancelled"], ["failed", "blocked"]] as const)("a %s access verifier in review is a native barrier, not a semantic block", async (mode, status) => {
    const host = fixture("FULL SPECS", { findings: true });
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent !== "pitako.access-verifier") return result;
      const child = { ...result.results![0]!, exitCode: 1, ...(mode === "stopped" ? { stopped: true } : {}) };
      return mode === "stopped" ? { ...result, ok: false, stopped: true, output: "", results: [child] }
        : { ...result, ok: false, error: "verifier exited 1", output: "", results: [child] };
    });
    const output = await host.execute();
    expect(output.status).toBe(status);
    expect(host.current().loop.halt?.code).not.toBe("semantic-block");
    expect(output.reason).not.toContain("task owner");
    expect(host.calls.some(call => call.key.endsWith(".review.defense-a") || call.key.includes(".review.defense"))).toBe(false);
  });

  test.each([2, 3, 4])("real %s-angle review includes critiques, one defense and synthesis, not include=material", async angles => {
    const host = fixture("FULL SPECS", { angles, findings: true });
    const inlineOriginals = observeInlineReviewOriginals(host);
    const goal = "Improve record selection\n " + "with complete caller evidence ".repeat(12);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.director") result.structuredOutput.changes[0].task.goal = goal;
      return result;
    });
    // A scoped-defect finding returned as ready reaches synthesis instead of stopping execute.
    expect((await host.execute()).status).toBe("complete");
    const verifiers = host.calls.filter(call => call.agent === "pitako.access-verifier");
    // One model-free verifier per consuming gate: critique, defense and synthesis.
    expect(verifiers.map(call => call.key)).toEqual(["critique", "defense", "synthesis"].map(gate => `invoke-human-1.l2.review.verify-${gate}`));
    expect(host.verifications.every(entry => entry.output.items.every((item: any) => item.state === "accessible"))).toBe(true);
    expect(host.calls.filter(call => call.key.includes(".review.") && call.agent !== "pitako.access-verifier")).toHaveLength(3 * angles + 2);
    for (const call of host.calls.filter(item => item.key.includes(".review.") && item.agent !== "pitako.access-verifier"))
      expect(call.task).toContain("Return status blocked only when missing material context prevents this review phase.");
    expect(host.calls.filter(call => call.key.includes(".review.") && call.resume)).toHaveLength(2 * angles + 1);
    const requests = host.calls.filter(call => call.key.includes(".review.") && call.agent !== "pitako.access-verifier");
    expect(new Set(requests.map(request => request.phase))).toEqual(new Set([
      "review-prepare", "review-independent", "review-critique", "review-defense", "review-synthesis",
    ]));
    const manifest = host.storage.get("review-invoke-human-1");
    expect(manifest.originals).toHaveLength(requests.length);
    for (const request of requests) {
      const label = request.label ?? "";
      expect(label).toBe(request.task.split("\n")[0]);
      expect(label).toContain("Loop 2 result");
      const angle = request.key.match(/(?:independent|critique|defense)-angle(\d+)$/)?.[1];
      if (angle) expect(label.indexOf(`Whole-result angle ${angle}`)).toBeLessThan(label.indexOf("Loop 2 result"));
      expect(request.task).toContain("FULL SPECS");
      expect(request.task).toContain("ADMITTED PLAN CONTEXT");
      expect(request.task).toContain("COMPLETE TARGET:");
      expect(request.outputMode).toBe("file-only");
      expect(request.output).toBe(`review/${request.key}.json`);
      expect(request).toMatchObject({ cwd: host.root, reads: false, progress: false });
      const ref = resolvedLoop(host.current()).review.references.find((entry: any) => entry.key === request.key);
      const retained = manifest.originals.find((entry: any) => entry.key === request.key);
      expect(Object.keys(retained).sort()).toEqual(["id", "key", "path", "runId", "sha256"]);
      const original = inlineOriginals.get(request.key);
      expect(canonicalDigest(readReviewOriginal(retained))).toBe(original.digest);
      expect(ref.runId).toBe(original.runId);
      expect(ref.outputReference).toBe(`/native/output/${request.key}.json`);
      expect(original.results).toBeUndefined(); // canonical witnesses belong to execute, not a second manifest copy
      expect(manifest.decision.reference).toMatchObject({ stateKey: "invoke-human-1", loop: 2 });
      const witness = publicationWitness(ref.results[0], host.native.get(ref.runId)!.results![0]);
      expect(witness.outputReference).toEqual({ path: witness.savedOutputPath,
        bytes: readFileSync(witness.savedOutputPath).byteLength, lines: 1, message: "Saved" });
      expect(witness.structuredOutputPath).toBe(`/native/witness/${request.key}.json`);
      const recovered = JSON.parse(readFileSync(witness.savedOutputPath, "utf8"));
      for (const field of ["association", "delivery", "access"])
        expect(request.outputSchema.properties).not.toHaveProperty(field);
      expect(original.association).toMatchObject({ key: request.key, namespace: manifest.namespace,
        query: manifest.query, revision: manifest.revision, attempt: 1 });
      expect(original.digest).toBe(canonicalDigest(recovered));
      expect(original).toMatchObject({ terminal: "succeeded", publication: "published", sufficient: true });
      expect(original.failedOriginal).toBeUndefined();
    }
  });

  test.each(["key", "agent", "runId", "workflowKey", "failed-state", "failed-outcome", "nested-running", "nested-timeout"])(
    "integrated review rejects and retains contradictory native witnesses: %s", async fault => {
      const host = fixture();
      let observed: Result | undefined;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key.endsWith("review.director-prepare")) {
          const receipt = result.results![0]! as any;
          if (["key", "agent", "runId", "workflowKey"].includes(fault)) receipt[fault] = "conflicting-native-producer";
          if (fault === "failed-state") result.state = "failed";
          if (fault === "failed-outcome") receipt.terminalOutcome = { state: "partial", reason: "budget_exhausted" };
          if (fault === "nested-running") receipt.state = "running";
          if (fault === "nested-timeout") receipt.timedOut = true;
          observed = copy(result);
        }
        return result;
      });
      const output = await host.executeNative();
      expect(output.status).toBe("blocked");
      expect(host.calls.filter(request => request.key.includes(".review."))).toHaveLength(1);
      expect(host.calls.some(request => request.key.endsWith(".compliance"))).toBe(false);
      const manifest = host.storage.get("review-invoke-human-1");
      const original = { ...manifest.originalDefaults, ...manifest.originals[0] };
      expect(original.sufficient).toBe(false);
      expect(original.failedOriginal).toBeUndefined();
      const reference = resolvedLoop(host.current()).review.references[0];
      const actual = observed!.results![0]!;
      const witness = publicationWitness(reference.results[0], actual);
      expect(witness.savedOutputPath).toBe(actual.savedOutputPath);
      expect(witness.outputReference).toEqual(actual.outputReference);
      for (const field of ["key", "agent", "runId", "workflowKey", "terminalOutcome", "state", "timedOut"])
        expect(witness[field]).toEqual((actual as any)[field]);
      if (fault === "failed-state") expect(reference.state).toBe("failed");
      const prior = copy(reference), count = host.calls.length;
      expect((await host.executeNative()).status).toBe("blocked");
      expect(host.calls).toHaveLength(count);
      expect(resolvedLoop(host.current()).review.references[0]).toEqual(prior);
    });

  test.each(["different-path", "no-reference"])("integrated review retains distinct or missing publication references: %s", async mode => {
    const host = fixture();
    const inlineOriginals = observeInlineReviewOriginals(host);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.phase?.startsWith("review-")) {
        const witness = result.results![0]!;
        if (mode === "no-reference") delete witness.outputReference;
        else witness.outputReference = { ...witness.outputReference!, path: "/native/distinct-returned-reference" };
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status).toBe("complete");
    for (const ref of resolvedLoop(host.current()).review.references) {
      const witness = ref.results[0], actual = host.native.get(ref.runId)!.results![0];
      expect(witness.savedOutputPath).toBe(actual.savedOutputPath);
      expect(witness.outputReference).toEqual(actual.outputReference);
      const original = host.storage.get("review-invoke-human-1").originals.find((entry: any) => entry.key === ref.key);
      expect(inlineOriginals.get(ref.key).association.key).toBe(ref.key);
      expect(canonicalDigest(readReviewOriginal(original))).toBe(inlineOriginals.get(ref.key).digest);
      expect(JSON.parse(readFileSync(witness.savedOutputPath, "utf8"))).toEqual(readReviewOriginal(original));
    }
  });

  test.each(["optional-artifact", "mandatory-publication", "partial-failed", "non-delivery", "unknown-completeness", "inaccessible-essential"])(
    "integrated review distinguishes publication/delivery/access: %s", async mode => {
      const host = fixture();
      let observed: Result | undefined;
      host.setRespond((request, normal) => {
        const result = normal();
        if (mode === "inaccessible-essential" ? request.phase === "review-independent" && !observed : request.key.endsWith("review.director-prepare")) {
          if (mode === "optional-artifact") result.metadataSaveError = "Optional debug artifact unavailable";
          if (["mandatory-publication", "partial-failed", "inaccessible-essential"].includes(mode)) {
            delete result.results![0]!.savedOutputPath;
            result.results![0]!.outputSaveError = "Required output save failed";
          }
          // Native failures can embed the delivered body after the diagnostic.
          if (mode === "mandatory-publication")
            result.error = `Required output save failed\n\nOutput:\n${JSON.stringify(result.structuredOutput, null, 2)}`;
          if (mode === "partial-failed") {
            result.ok = false; result.error = "Terminal partial analysis";
            result.structuredOutput.status = "blocked";
            result.structuredOutput.reason = "Contrary partial evidence, not sufficient";
          }
          if (mode === "non-delivery") delete result.structuredOutput;
          if (mode === "unknown-completeness") delete result.structuredOutput.angles;
          observed = copy(result);
        }
        return result;
      });
      // The failed original must exist once in every durable merged checkpoint.
      const bodyCopies: number[] = [];
      let optionalOriginal: any;
      host.setSaveObserver(() => {
        const manifest = host.storage.get("review-invoke-human-1");
        const original = manifest?.originals.find((entry: any) => entry.runId === observed?.runId);
        if (original?.digest) optionalOriginal = copy({ ...manifest.originalDefaults, ...original });
        if (!observed?.structuredOutput) return;
        const merged = JSON.stringify(Object.fromEntries(host.storage));
        bodyCopies.push(merged.split(JSON.stringify(observed.structuredOutput.reason).slice(1, -1)).length - 1);
      });
      const output = await host.executeNative();
      if (mode === "mandatory-publication") {
        expect(bodyCopies.length).toBeGreaterThan(0);
        expect(Math.max(...bodyCopies)).toBe(1);
      }
      if (mode === "optional-artifact") {
        expect(output.status).toBe("complete");
      } else {
        expect(output.status).toBe("blocked");
        expect(host.calls.some(request => request.key.endsWith(".compliance"))).toBe(false);
      }
      const manifest = host.storage.get("review-invoke-human-1");
      const retainedOriginal = manifest.originals.find((entry: any) => entry.runId === observed!.runId);
      expect(retainedOriginal).toBeDefined();
      const original = { ...manifest.originalDefaults, ...retainedOriginal };
      expect(manifest.originals.filter((entry: any) => entry.id === original.id)).toHaveLength(1);
      if (["mandatory-publication", "partial-failed", "inaccessible-essential"].includes(mode)) {
        expect(original).toMatchObject({ publication: "unpublished", delivery: "complete", sufficient: false });
        expect(original.failedOriginal).toEqual(observed!.structuredOutput);
      } else expect(original.failedOriginal).toBeUndefined();
      if (mode === "non-delivery") expect(original.delivery).toBe("not-delivered");
      if (mode === "unknown-completeness") expect(original.delivery).toBe("unproved");
      if (mode === "inaccessible-essential") {
        expect(original).toMatchObject({ publication: "unpublished", sufficient: false });
        expect(host.calls.some(request => ["review-critique", "review-defense", "review-synthesis"].includes(request.phase!))).toBe(false);
      }
      if (mode === "optional-artifact") {
        expect(optionalOriginal).toMatchObject({ publication: "published", observability: "failed", sufficient: true });
        expect(optionalOriginal).not.toHaveProperty("value");
        expect(optionalOriginal.digest).toBe(canonicalDigest(observed!.structuredOutput));
        expect(readReviewOriginal(retainedOriginal)).toEqual(observed!.structuredOutput);
      }
      if (mode === "partial-failed") {
        host.setStatus(ref => ({ ...copy(host.native.get(ref)!), ok: true,
          structuredOutput: { ...observed!.structuredOutput, angles: undefined } }));
        expect((await host.executeNative()).status).toBe("blocked");
        const retained = host.storage.get("review-invoke-human-1").originals;
        expect(retained).toHaveLength(1);
        expect(retained[0].failedOriginal).toEqual(observed!.structuredOutput);
        expect(retained[0]).toMatchObject({ sufficient: false, publication: "unpublished" });
      }
    });

  test("director has settled before first worker and no next worker starts before prior settlement", async () => {
    const host = fixture(); let active = false;
    host.setRespond(async (request, normal) => {
      expect(active).toBe(false);
      if (request.agent === "pitako.worker" || request.agent === "pitako.execution-director") {
        active = true;
        await Promise.resolve(); active = false;
      }
      return normal();
    });
    expect((await host.execute()).status).toBe("complete"); expect(active).toBe(false);
  });

  test.each(["continue", "gaps"])("worker %s retains the selected task through a pause continuation", async status => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.t1.a1") Object.assign(result.structuredOutput, {
        status, remaining: ["Fix concrete diagnosed parser branch"],
        knowledge: { findings: ["Parser branch is incomplete"], handoff: "src/change1.ts contains the parser branch." },
      });
      return result;
    });
    expect((await host.executeNative()).status).toBe("partial");
    const workers = host.calls.filter(call => call.agent === "pitako.worker");
    expect(workers.map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
    expect(workers[1]!.task).toContain("/native/output/invoke-human-1.l1.t1.a1.json");
    expect(workers[1]!.task).toContain("src/change1.ts contains the parser branch.");
    expect(workers[1]!.task).toContain("TASK CONTINUATION");
    expect(workers[1]!.task).not.toContain("FROZEN ATTEMPT");
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    expect(host.history()[0].manifest).toEqual(["change1"]);
    expect(host.current().tasks.change1.completed).toMatchObject({ taskId: "change1", attempt: 2, prerequisiteResults: [] });
    expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind)).toEqual(["pause", "unit"]);
    expect(host.calls.some(call => call.key.includes(".review.") || call.key.endsWith(".compliance"))).toBe(false);
  });

  test("selection association echoes cannot override the root binding", async () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) result.structuredOutput.association = { root: "/wrong", invocation: "different" };
      return result;
    });
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 1 });
    expect(host.current().tasks.change1.completed).toBeDefined();
    expect(host.current().association.root).toBe(host.root);
  });

  test.each(["duplicate-id", "preview-only"])("rejects selection %s before any edit", async mode => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") {
        if (mode === "duplicate-id") result.structuredOutput.changes.push(copy(result.structuredOutput.changes[0]));
        else { result.output = "{preview...}"; delete result.structuredOutput; }
      }
      return result;
    });
    expect((await host.execute()).status).not.toBe("complete");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
  });

  test("selection admission compares complete JSON binding, not equal IDs", async () => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) {
        const binding = copy(result.structuredOutput); binding.changes[0].task.goal = "Different goal";
        result.output = JSON.stringify(binding);
      }
      return result;
    });
    expect((await host.execute()).reason).toContain("conflicting");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
  });

  // Per-check attestations are no longer worker authority. Preserve the original
  // native body, but derive completion and check currency only from loop-io.
  test.each(["absent", "failed", "not-run", "stale", "malformed", "forged-pass"])(
    "workflow gates, not %s worker check echoes, determine completion", async mode => {
      const host = fixture(); host.setLimit(1);
      let original: any;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.worker") {
          expect(request.outputSchema.properties).not.toHaveProperty("checks");
          if (mode !== "absent") result.structuredOutput.checks = mode === "malformed" ? [null, { logPaths: [42] }] : [{
            id: "change1-check", result: mode === "forged-pass" ? "passed" : mode,
            command: "echo fabricated", cwd: "/other", before: null, after: candidate(2),
          }];
          original = copy(result.structuredOutput);
        }
        return result;
      });
      expect((await host.executeNative()).status).toBe("partial");
      expect(host.native.get("invoke-human-1.l1.t1.a1")!.structuredOutput).toEqual(original);
      expect(host.current().tasks.change1.completed).toBeDefined();
      expect(host.history()[0].results[0].checks).toMatchObject({ current: true, count: 1, passed: 1 });
      const gate = host.calls.find(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "gate")!;
      expect(JSON.parse(gate.task).task.gates[0].command).toBe("bun test change1");
    });

  test.each(["work", "status", "remaining", "remaining-entry"])("invalid worker %s is rejected before gate dispatch", async field => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") {
        if (field === "work") result.structuredOutput.work = "";
        if (field === "status") result.structuredOutput.status = "green";
        if (field === "remaining") result.structuredOutput.remaining = null;
        if (field === "remaining-entry") result.structuredOutput.remaining = [42];
      }
      return result;
    });
    expect((await host.execute()).status).toBe("partial");
    expect(host.history()[0].results).toEqual([expect.objectContaining({ status: "rejected",
      rejection: "Worker returned an invalid work/status/remaining contract." })]);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.some(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "gate")).toBe(false);
  });

  test.each(["wrong-producer", "wrong-nested-producer", "failed-exit", "wrong-key", "binding-conflict", "native-ok-only"])(
    "worker %s cannot cross the native producer boundary", async mode => {
      const host = fixture(); host.setLimit(1);
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.worker") {
          if (mode === "wrong-producer") result.agent = "pitako.reviewer";
          if (mode === "wrong-nested-producer") result.results![0]!.agent = "pitako.reviewer";
          if (mode === "failed-exit") result.results![0]!.exitCode = 1;
          if (mode === "wrong-key") result.key = "another-invocation.l2.t1.a1";
          if (mode === "binding-conflict") result.output = JSON.stringify({ ...result.structuredOutput, work: "Different body" });
          if (mode === "native-ok-only") delete result.structuredOutput;
        }
        return result;
      });
      expect((await host.execute()).status).not.toBe("complete");
      const workers = host.calls.filter(call => call.agent === "pitako.worker");
      expect(workers).toHaveLength(mode === "native-ok-only" ? 2 : 1);
      if (mode === "native-ok-only") {
        expect(workers[1]!.key).toBe("invoke-human-1.l1.t1.a2");
        expect(workers[1]!.task).toContain("CHECKPOINT FALLBACK");
        expect(host.current().tasks.change1.completed).toBeNull();
      }
      expect(host.calls.some(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "gate")).toBe(false);
      expect(host.calls.some(call => call.key.includes(".review.") || call.key.endsWith(".compliance"))).toBe(false);
    });

  test("a schema-rejected worker is handed to the next director without rerunning the old writer", async () => {
    const host = fixture(); host.setLimit(2);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.t1.a1") result.structuredOutput.remaining = null;
      return result;
    });
    expect((await host.execute()).status).toBe("partial");
    expect(host.history()).toHaveLength(2);
    expect(host.history()[0]).toMatchObject({ outcome: "gaps", results: [{ status: "rejected" }] });
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
    const director = host.calls.find(call => call.key === "invoke-human-1.l2.director")!;
    expect(director.task).toContain("Worker returned an invalid work/status/remaining contract.");
    expect(host.current().tasks.change1.completed).toBeDefined();
  });

  test("known worker identity echoes cannot override deterministic observation", async () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") {
        for (const field of ["taskId", "attempt", "candidate", "checkpointReceipt", "restoreReceipt", "git"])
          expect(request.outputSchema.properties).not.toHaveProperty(field);
        Object.assign(result.structuredOutput, { taskId: "wrong", attempt: 99, candidate: candidate(2),
          checkpointReceipt: { kind: "pause" }, restoreReceipt: { digest: "wrong" } });
      }
      return result;
    });
    expect((await host.execute()).status).toBe("partial");
    expect(host.history()[0].results[0]).toMatchObject({ taskId: "change1", attempt: 1, candidate: host.observedCandidate() });
  });

  test("material review gaps skip compliance and all repairs until next director", async () => {
    const host = fixture("FULL SPECS", { findings: true, taskCount: 0 }); host.setRespond((request, normal) => {
      const result = normal(); if (request.key.endsWith("director-synthesis") && request.key.includes(".l1.")) {
        result.structuredOutput.screening.verdict = "material-gaps";
        result.structuredOutput.screening.assessments[0].material = true;
      } return result;
    });
    expect((await host.execute()).status).toBe("complete");
    expect(host.calls.filter(call => call.key.endsWith(".compliance")).map(call => call.key)).toEqual(["invoke-human-1.l3.compliance"]);
    const synthesis = host.calls.findIndex(call => call.key === "invoke-human-1.l1.review.director-synthesis");
    expect(host.calls[synthesis + 1]!.agent).toBe("pitako.loop-io");
    expect(host.calls[synthesis + 1]!.key).toBe("invoke-human-1.l1.reviewOriginals");
    const nextDirector = host.calls.findIndex(call => call.key === "invoke-human-1.l2.director");
    const beforeDirector = host.calls.slice(synthesis + 1, nextDirector);
    expect(beforeDirector.map(call => call.key)).toEqual(["invoke-human-1.l1.reviewOriginals",
      "invoke-human-1.l1.final-gaps", "invoke-human-1.l1.checkout", "invoke-human-1.l2.advance.prepare", "invoke-human-1.l2.advance.requests",
      "invoke-human-1.l2.demandOriginals", "invoke-human-1.l2.demand-observation"]);
    expect(beforeDirector.find(call => call.key.endsWith(".final-gaps"))!.task).toContain("final-phase");
    expect(beforeDirector.some(call => call.agent === "pitako.worker")).toBe(false);
    const report = host.emits.find(value => value.type === "execution-loop" && value.loop === 1);
    expect(report.next).toBe("continue loop 2"); expect(report.verification.compliance.status).toBe("not-run");
  });

  test.each(["empty", "all-not-applicable", "duplicate", "missing-source", "reasonless", "green-only"])("%s compliance never completes", async mode => {
    const host = fixture(); host.setRespond((request, normal) => {
      const result = normal(); if (request.key.endsWith(".compliance")) {
        const value = result.structuredOutput;
        if (mode === "empty") value.requirements = [];
        if (mode === "all-not-applicable") value.requirements.forEach((item: any) => { item.status = "not-applicable"; });
        if (mode === "duplicate") value.requirements[1].id = value.requirements[0].id;
        if (mode === "missing-source") value.requirements[0].source = "";
        if (mode === "reasonless") value.requirements[0].reason = "";
        if (mode === "green-only") value.requirements[0].evidence = [];
      } return result;
    });
    expect((await host.execute()).status).toBe("blocked");
  });

  test("a stray compliance candidate echo is ignored; the workflow attaches the judged candidate", async () => {
    const host = fixture(); host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".compliance")) result.structuredOutput.candidate = candidate(3);
      return result;
    });
    // Completion requires the closing gate and the ledger loop record to match
    // compliance.candidate to the loop candidate, so the echo cannot leak in.
    expect((await host.execute()).status).toBe("complete");
  });

  test.each([{ ids: ["AC-output", "constraint-no-publication"] }, { ids: ["REQ-A"] }])("complete selected specs admit their own shorter inventory: %j", async ({ ids }) => {
    const content = `# Acceptance criteria\n${ids[0]}: required output.\n# Constraints\nNo publication.\n# Verification\nCheck the output.`;
    const host = fixture(content);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".compliance")) {
        expect(request.task).toContain(content);
        expect(request.task).toContain("obligations in expected");
        expect(request.task).not.toContain("criterion-17");
        expect(request.outputSchema.properties.requirements.minItems).toBe(1);
        result.structuredOutput.requirements = ids.map((id, index) => ({
          ...result.structuredOutput.requirements[index], id,
          source: index ? "spec:Constraints,Verification" : "spec:Acceptance criteria,Constraints,Verification",
        }));
      }
      return result;
    });
    expect((await host.execute()).status).toBe("complete");
  });

  test("an analyst's identified outside-acceptance obligation remains a gap until the next loop", async () => {
    const host = fixture("# Acceptance criteria\nAC-output: output exists.\n# Constraints\nDo not publish.", { taskCount: 0 });
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".compliance") && request.key.includes(".l1.")) {
        result.structuredOutput.status = "gaps";
        result.structuredOutput.requirements.push({ id: "no-publication", source: "spec:Constraints",
          reason: "Publication obligation not yet evidenced", status: "gap",
          evidence: ["/native/work-result.json: publication evidence absent"], checks: [] });
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status, output.reason).toBe("complete"); expect(output.loopsConsumed).toBe(3);
    expect(host.history()[0].compliance.status).toBe("gaps");
    expect(host.calls.filter(call => call.agent === "pitako.worker").every(call => call.key.includes(".l2."))).toBe(true);
    expect(host.calls.filter(call => call.key.endsWith(".compliance")).map(call => call.key))
      .toEqual(["invoke-human-1.l1.compliance", "invoke-human-1.l3.compliance"]);
  });

  test.each(["compliance", "adversarial", "candidate-drift"])("three %s gaps report exhaustion on every emission and replay without renewing slots", async mode => {
    const host = fixture("FULL SPECS", { realCheckout: mode === "candidate-drift", findings: true, taskCount: 0 });
    host.setRespond((request, normal) => {
      const result = normal();
      if (mode === "compliance" && request.key.endsWith(".compliance")) return gaps(result);
      if (mode === "adversarial" && request.key.endsWith("director-synthesis")) {
        result.structuredOutput.screening.verdict = "material-gaps";
        result.structuredOutput.screening.assessments[0].material = true;
      }
      return result;
    });
    if (mode === "candidate-drift") host.setObservationResponse((key, value) => {
      if (key.endsWith(".checkout")) {
        const version = Number(key.match(/\.l(\d+)\./)![1]);
        host.changeCheckout(version); return { ...value, checkout: { ...host.observedCandidate() } };
      }
      return value;
    });
    const output = await host.execute(); expect(output).toMatchObject({ status: "partial", loopsConsumed: 3 });
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(3);
    const reports = host.emits.filter(value => value.type === "execution-loop");
    expect(reports.slice(0, 2).map(value => value.next)).toEqual(["continue loop 2", "continue loop 3"]);
    expect(reports.slice(0, 2).every(value => value.status === "gaps" && value.actionRequired === "none")).toBe(true);
    expect(reports.filter(value => value.loop === 3)).toHaveLength(2);
    const count = host.calls.length; expect((await host.execute()).status).toBe("partial"); expect(host.calls).toHaveLength(count);
    expect(host.history()).toHaveLength(3);
    const exhausted = host.emits.filter(value => value.type === "execution-loop" && value.loop === 3);
    expect(exhausted).toHaveLength(3);
    for (const report of exhausted) {
      expect(report.status).toBe("partial");
      expect(report.next).toBe("new invocation requires human authorization");
      for (const message of [report.reason, report.pending[0].reason, report.actionRequired]) {
        expect(message).toContain("partial");
        expect(message).toContain("new invocation with human authorization");
        expect(message).not.toContain("next director");
        expect(message).not.toContain("continue loop");
      }
      if (mode === "candidate-drift") {
        expect(report.reason).toContain("stale");
        expect(report.verification.checks.every((check: any) => check.status === "stale" && !check.current)).toBe(true);
      }
    }
  });

  test.each(["compliance", "adversarial", "candidate-drift"])("third-loop %s closing persistence suspension reports recovery before exhaustion without repeating work", async mode => {
    const host = fixture("FULL SPECS", { realCheckout: mode === "candidate-drift", findings: true, taskCount: 0 });
    host.setRespond((request, normal) => {
      const result = normal();
      if (mode === "compliance" && request.key.endsWith(".compliance")) return gaps(result);
      if (mode === "adversarial" && request.key.endsWith("director-synthesis")) {
        result.structuredOutput.screening.verdict = "material-gaps";
        result.structuredOutput.screening.assessments[0].material = true;
      }
      return result;
    });
    if (mode === "candidate-drift") host.setObservationResponse((key, value) => {
      if (!key.endsWith(".checkout")) return value;
      const version = Number(key.match(/\.l(\d+)\./)![1]);
      host.changeCheckout(version); return { ...value, checkout: { ...host.observedCandidate() } };
    });
    let cutObserved = false;
    cutAt(host, value => {
      const third = ((value.loop?.number === 3 ? value.loop : undefined));
      if (third?.phase !== "finished" || third.outcome !== "gaps") return false;
      cutObserved = true; return true;
    });
    const output = await host.execute();
    expect(cutObserved).toBe(true);
    expect(output).toMatchObject({ status: "partial", phase: "closing", loopsConsumed: 3 });
    const reports = host.emits.filter(value => value.type === "execution-loop");
    expect(reports.map(value => value.loop)).toEqual([1, 2, 3]);
    expect(reports.slice(0, 2).map(value => value.next)).toEqual(["continue loop 2", "continue loop 3"]);
    expect(output.loopReport).toEqual(reports[2]);
    for (const report of reports.filter(value => value.loop === 3)) {
      expect(report).toMatchObject({ status: "partial", phase: "closing",
        next: "restore essential persistence; continuation requires supported native reconciliation" });
      for (const message of [report.reason, report.pending[0].reason, report.actionRequired, output.reason, output.actionRequired]) {
        expect(message).toContain("Essential persistence failed");
        expect(message).toContain("Controlled essential persistence cut");
        expect(message).not.toContain("new invocation");
        expect(message).not.toContain("next director");
      }
      expect(report.verification.compliance.status).toBe(mode === "adversarial" ? "not-run" : mode === "candidate-drift" ? "stale" : "gaps");
    }
    expect(host.history()[2]).toMatchObject({ phase: "closing" });
    expect(host.history()[2].outcome).toBeUndefined();
    const calls = copy(host.calls), usage = host.history().map((loop: any) => copy(loop.usage));
    const startedAt = host.current().startedAt, loopStartedAt = host.history()[2].startedAt;
    const closes = host.hostCalls.filter(key => key === "inspect-loop-3").length;
    host.setFailSave(); host.advance(10000);
    const recovered = await host.execute();
    expect(recovered).toMatchObject({ status: "partial", loopsConsumed: 3 });
    expect(host.calls).toEqual(calls);
    expect(host.history().map((loop: any) => loop.number)).toEqual([1, 2, 3]);
    expect(host.current().loop.usage).toEqual([]);
    expect(host.current().usageTotals.tokens).toBe((host.history().slice(0, 2).reduce((sum: number, loop: any) => sum + (loop.usageSummary?.tokens ?? 0), 0)) + usage[2].reduce((sum: number, item: any) => sum + (item.tokens ?? 0), 0));
    expect(host.current().startedAt).toBe(startedAt);
    expect(host.history()[2].startedAt).toBe(loopStartedAt);
    expect(recovered.tokens).toEqual(output.tokens);
    expect(recovered.elapsedMs).toBe(output.elapsedMs + 10000);
    expect(recovered.loopReport.elapsedMs).toBe(output.loopReport.elapsedMs + 10000);
    expect(host.hostCalls.filter(key => key === "inspect-loop-3")).toHaveLength(closes);
    expect(host.history()[2]).toMatchObject({ phase: "finished", outcome: "gaps" });
    const recoveredReports = host.emits.slice(host.emits.indexOf(reports[2]) + 1).filter(value => value.type === "execution-loop");
    expect(recoveredReports).toHaveLength(2);
    expect(recovered.loopReport).toEqual(recoveredReports[1]);
    for (const report of recoveredReports) {
      expect(report).toMatchObject({ status: "partial", next: "new invocation requires human authorization" });
      for (const message of [report.reason, report.pending[0].reason, report.actionRequired]) {
        expect(message).toContain("new invocation with human authorization");
        expect(message).not.toContain("persistence");
        expect(message).not.toContain("next director");
      }
    }
  });

  test("candidate drift at the single closing comparison invalidates checks/review/compliance and goes to next director", async () => {
    const host = fixture(undefined, { realCheckout: true, taskCount: 0 }); host.setObservationResponse((key, value) => {
      if (key === "invoke-human-1.l1.checkout") { host.changeCheckout(); return { ...value, checkout: { ...host.observedCandidate() } }; } return value;
    });
    expect((await host.execute()).status).toBe("complete");
    expect(host.hostCalls).toEqual(["inspect-initial"]);
    expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(2);
    const stale = host.emits.find(value => value.type === "execution-loop");
    expect(stale.reason).toContain("stale");
    expect(stale.verification.checks.every((check: any) => check.status === "stale" && !check.current)).toBe(true);
    expect(stale.verification.adversarial.status).toBe("stale");
    expect(stale.verification.compliance.status).toBe("stale");
  });
});

describe("workflow-owned execute controller", () => {
  test.each(["published", "admitted", "result-before-cursor"])("durable %s cut recovers original values without repeated completed edits or renewed slots", async phase => {
    const host = fixture();
    cutAt(host, value => {
      const loop = value.loop;
      return phase === "published" ? loop?.plan?.stage === "published" : phase === "admitted"
        ? loop?.phase === "implementation" : loop?.cursor === 1;
    });
    const first = await host.execute(); expect(first.status).toBe("partial");
    const firstWorkers = host.calls.filter(call => call.agent === "pitako.worker").length;
    expect(firstWorkers).toBe(phase === "result-before-cursor" ? 1 : 0);
    host.setFailSave(); host.advance(10000);
    expect((await host.execute()).status).toBe("complete");
    expect(host.history()).toHaveLength(2);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(2);
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.current().startedAt).toBe(1000);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
  });

  test.each(["direct-values", "direct-conflict", "absent-binding", "absent-witness", "cache-only", "lost-definition", "changed-binding", "changed-native", "changed-selection"])("recovery distinguishes %s using full originals and exact refs", async mode => {
    const host = fixture(undefined, { readOnly: true });
    cutAt(host, value => mode == "cache-only" ? value.loop?.attempt?.stage === "intention" : value.loop?.plan?.stage === "published");
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    // Recover the full selection before apply; after admission loop.task is authoritative.
    // Neither cut has launched a writer.
    if (mode !== "cache-only" && mode !== "changed-native") removeCache(host);
    if (mode === "lost-definition" || mode === "cache-only") {
      host.native.delete("native-invoke-human-1.l1.director"); host.native.delete("invoke-human-1.l1.director");
    }
    if (mode === "absent-witness") for (const value of host.native.values()) delete value.results;
    if (mode.startsWith("direct-")) for (const value of host.native.values()) {
      if (!value.structuredOutput?.changes) continue;
      const binding = copy(value.structuredOutput);
      if (mode === "direct-conflict") binding.reason = "conflicting-native-binding";
      value.output = JSON.stringify(binding);
    }
    // Only the unavailable-direct-value cases need the exceptional inspector.
    // A file-only preview alone is not a reason to query again.
    if (["absent-binding", "changed-binding", "changed-selection"].includes(mode))
      host.setStatus(() => ({ ok: true, results: [] }));
    if (mode === "changed-native") host.setStatus(ref => {
      // An admitted complete cache does not require an optional inspector.
      // Supply the actually conflicting native original at its exact producer.
      const result = copy(host.native.get(ref)!);
      if (result?.structuredOutput?.changes) {
        result.output = JSON.stringify(result.structuredOutput);
        result.structuredOutput.reason = "changed-but-same-selection";
      }
      return result;
    });
    host.setRespond((request, normal) => {
      const result = normal(); if (request.key.includes(".recover")) {
        const value = result.structuredOutput;
        if (mode === "absent-binding") Object.assign(value, { binding: "absent", comparison: "only-original" });
        if (mode === "changed-binding") Object.assign(value, { status: "conflict", binding: "changed", comparison: "different-full-json" });
        if (mode === "changed-selection" && value.original) {
          value.original.select = "unknown-task";
          Object.assign(value, { status: "conflict", binding: "changed", comparison: "different-full-json" });
        }
      } return result;
    });
    const output = await host.execute();
    if (["direct-conflict", "changed-binding", "changed-native", "changed-selection"].includes(mode)) {
      expect(output.status).toBe("blocked"); expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
    } else {
      expect(host.history().find((loop: any) => loop.kind === "task")?.results[0]?.status).toBe("complete");
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
      expect(host.calls.filter(call => call.key === "invoke-human-1.l1.director")).toHaveLength(1);
      expect(output.status).toBe("complete");
      if (mode === "absent-binding") expect(host.history()[0].plan.recoverySource.binding).toBe("absent");
    }
    if (mode.startsWith("direct-")) expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
  });

  test.each(["running", "queued", "pending", "detached", "recovery", "stopped", "permission", "management"])("unresolved writer %s cannot be blindly redispatched or replaced in another slot", async mode => {
    const host = fixture(undefined, { readOnly: true });
    cutAt(host, value => !!value.loop?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    const saved = host.history()[0].attempt;
    expect(saved.stage).toBe("launched"); // The no-writer baseline persisted dispatch readiness before launch attachment.
    expect(saved.launch).toBeUndefined();
    host.setStatus(ref => {
      if (!ref.includes(".t1.a1")) return copy(host.native.get(ref) ?? { ok: true, results: [] });
      if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
      if (mode === "management") return { ok: true, results: [], output: `Run: ${ref}\nState: running\nMode: single` };
      return { ok: true, state: ["running", "queued", "pending"].includes(mode) ? mode : undefined, [mode]: true };
    });
    const output = await host.execute(); expect(["blocked", "cancelled"]).toContain(output.status);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    expect(host.history()).toHaveLength(1);
  });

  test("missing writer inventory continues only through checkpoint-first restoration of the selected task", async () => {
    const host = fixture(undefined, { realCheckout: true, readOnly: true }); host.setLimit(1);
    cutAt(host, value => !!value.loop?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    host.setStatus(ref => ref.includes(".t1.a1") ? { ok: true, results: [] } : copy(host.native.get(ref)!));
    host.setRespond((request, normal) => {
      if (request.key === "invoke-human-1.l1.t1.a2") {
        const restore = host.current().loop.attempt.restore;
        expect(restore.producer.key).toBe("invoke-human-1.l1.t1.a1");
        const sources = restore.sourceKeys.map((key: string) => host.current().taskFrame.sources.find((source: any) => source.key === key));
        restoreCheckpoint(sources, restore.authority);
      }
      return normal();
    });
    const output = await host.execute();
    expect(output.status, output.reason).toBe("partial");
    expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
      .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.calls.some(call => call.resume)).toBe(false);
    expect(host.current().tasks.change1.completed.status).toBe("complete");
    expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
    expect(host.history()).toHaveLength(1);
  });

  test("dispatch-before-result can reconcile the exact settled original, without calling the writer key again", async () => {
    const host = fixture(); cutAt(host, value => !!value.loop?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    expect((await host.execute()).status).toBe("complete");
    expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1"]);
    expect(host.statusCalls).toContain("invoke-human-1.l1.t1.a1");
  });

  test("native status may echo its queried run ID without changing the frozen dispatch or original report", async () => {
    const host = fixture();
    cutAt(host, value => value.loop?.attempt?.stage === "result");
    expect((await host.executeNative()).status).toBe("partial");
    const original = copy(host.native.get("native-invoke-human-1.l1.t1.a1"));
    host.setFailSave();
    expect((await host.executeNative()).status).toBe("complete");
    expect(host.statusCalls).toContain("native-invoke-human-1.l1.t1.a1");
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.history()[0].results[0].ref.key).toBe("invoke-human-1.l1.t1.a1");
    expect(host.native.get("native-invoke-human-1.l1.t1.a1")).toEqual(original);
  });

  test.each(["native-original", "exact-fallback"])(
    "a new published receipt missing its value consumes the %s and really starts implementation", async mode => {
      const host = fixture();
      let original: any;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key === "invoke-human-1.l1.director") {
          original = copy(result);
          delete result.structuredOutput;
        }
        if (request.agent === "pitako.execution-inspector") {
          expect(request).toMatchObject({ label: "Recover complete execution plan", phase: "recovery" });
          expect(request.task.startsWith(`${request.label}\n\nEXCEPTIONAL READ-ONLY`)).toBe(true);
          expect(host.history()[0].recoveries[0]).toMatchObject({
            subject: "loop-plan", phase: "loop-plan", stage: "intention",
            source: { key: "invoke-human-1.l1.director" },
          });
          Object.assign(result.structuredOutput, { status: "recovered", original: copy(original.structuredOutput),
            originalAvailable: true, binding: "absent", comparison: "only-original" });
        }
        return result;
      });
      host.setStatus(ref => ref.endsWith("l1.director")
        ? mode === "native-original" ? copy(original) : { ok: true, results: [] } : copy(host.native.get(ref)!));
      const output = await host.executeNative();
      expect(output.status).toBe("complete");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector"))
        .toHaveLength(mode === "native-original" ? 0 : 1);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
      expect(host.history()[0].plan.stage).toBe("admitted");
      expect(host.history()[0].kind).toBe("task");
      expect(host.history()).toHaveLength(2);
      expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(true);
    },
  );

  test.each(["none", "before-intent", "before-launch", "before-result", "before-cursor", "after-cursor"])(
    "a missing worker report uses checkpoint-first continuation across %s without an inspector or repeated writer", async cut => {
      const host = fixture(undefined, { realCheckout: true, readOnly: true });
      host.setRespond((request, normal) => {
        if (request.key === "invoke-human-1.l1.t1.a1") {
          const result = normal(); // The original captured real preimages before losing its report.
          delete result.structuredOutput;
          return result;
        }
        if (request.key === "invoke-human-1.l1.t1.a2") {
          const restore = host.current().loop.attempt.restore;
          expect(restore.producer.key).toBe("invoke-human-1.l1.t1.a1");
          const sources = restore.sourceKeys.map((key: string) => host.current().taskFrame.sources.find((source: any) => source.key === key));
          restoreCheckpoint(sources, restore.authority);
        }
        return normal();
      });
      if (cut !== "none") cutAt(host, value => {
        const loop = value.loop;
        return cut === "before-intent" ? loop?.attempt?.restore?.undispatched === true
          : cut === "before-launch" ? loop?.attempt?.key.endsWith(".a2") && !!loop.attempt.launch
          : cut === "before-result" ? loop?.attempt?.key.endsWith(".a2") && loop.attempt.stage === "result"
          : cut === "before-cursor" ? loop?.cursor === 1
          : loop?.number === 2;
      });
      const first = await host.executeNative();
      let output = first;
      if (cut !== "none") {
        expect(first.status).toBe("partial");
        expect(first.reason).toContain("Essential persistence failed");
        host.setFailSave();
        output = await host.executeNative();
      }
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
      expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
        .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
      expect(host.history()[0].results.find((entry: any) => entry.taskId === "change1").status).toBe("complete");
      expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
      expect(host.calls.some(call => call.key.endsWith("review.director-prepare"))).toBe(true);
      expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(true);
      expect(host.current().association.maxCycles).toBe(3);
      expect(output.status).toBe("complete");
    },
  );

  test("intent committed before an uncertain launch cannot authorize a replacement observation", async () => {
    const host = fixture(undefined, { readOnly: true });
    cutAt(host, value => value.loop?.plan?.stage === "published");
    expect((await host.execute()).status).toBe("partial");
    host.setFailSave();
    host.setStatus(ref => ref.endsWith(".director") ? { ok: true, results: [] } : copy(host.native.get(ref)!));
    const setter = host.state.set;
    host.state.set = async (key, value: any) => {
      await setter(key, value);
      if (value.loop?.recoveries?.[0]?.stage === "intention")
        throw Error("Controlled interruption after committed intent");
    };
    expect((await host.execute()).status).toBe("partial");
    expect(host.history()[0].recoveries[0].stage).toBe("intention");
    host.state.set = setter;
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    expect(output.reason).toContain("settlement/result uncertain");
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
    expect(host.history()).toHaveLength(1);
  });

  // Rejects treating unresolved observation as ordinary loss, including the
  // admitted-definition caller and a replay with the retained inspector value.
  test.each(["published", "admitted"])("unresolved %s plan retains scope impediment without replacement dispatch", async stage => {
    const host = fixture();
    const reason = "Actor: artifact owner. Exact binding unreadable. Expansion needed: grant read access to that binding; do not change permissions here.";
    if (stage === "admitted") {
      cutAt(host, value => value.loop?.phase === "implementation");
      expect((await host.executeNative()).status).toBe("partial");
      host.setFailSave(); removeCache(host);
    }
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") delete result.structuredOutput;
      if (request.agent === "pitako.execution-inspector") Object.assign(result.structuredOutput, {
        status: "unresolved", reason, original: null, originalAvailable: false,
        binding: "unavailable", comparison: "neither",
      });
      return result;
    });
    host.setStatus(ref => ref.includes(".recover") ? copy(host.native.get(ref)!) : { ok: true, results: [] });
    for (let replay = 0; replay < 2; replay++) {
      const output = await host.executeNative();
      expect(output).toMatchObject({ status: "blocked", loopsConsumed: 1,
        reason: expect.stringContaining(reason), actionRequired: expect.stringContaining(reason),
        action: { actor: "evidence owner", started: false,
          operation: "resolve the concrete retained impediment; no replacement dispatch" } });
      expect(output.action.references).toContainEqual(expect.objectContaining({ agent: "pitako.execution-inspector" }));
      expect(host.history()[0].recoveries[0]).toMatchObject({ disposition: "unresolved", stage: "observed",
        provenance: ["/native/binding/invoke-human-1.l1.director.json"] });
      expect(host.history()).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
    }
  });

  test.each(["pending", "missing", "outside-scope", "conflicting-binding"])(
    "the finite %s observation route retains evidence and cannot renew itself by renaming refs", async mode => {
      const host = fixture(undefined, { readOnly: true });
      let original: any;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.execution-director") { original = copy(result.structuredOutput); delete result.structuredOutput; }
        if (request.agent === "pitako.execution-inspector") {
          if (mode === "pending") return { ...result, state: "pending", structuredOutput: undefined };
          if (mode === "missing") return { ...result, structuredOutput: undefined };
          if (mode === "outside-scope") Object.assign(result.structuredOutput, { status: "unresolved", original: null, originalAvailable: false,
            reason: "Actor: artifact owner. Exact retained binding is unreadable. Expansion needed: grant read access to that binding; do not change permissions here." });
          if (mode === "conflicting-binding") {
            Object.assign(result.structuredOutput, { status: "recovered", original, originalAvailable: true, binding: "absent", comparison: "only-original" });
            result.output = JSON.stringify({ ...result.structuredOutput, reason: "Different original" });
          }
        }
        return result;
      });
      const first = await host.executeNative();
      expect(first.status).toBe("blocked");
      expect(first.action.actor).not.toBe("human");
      expect(first.action.started).toBe(false);
      if (mode === "outside-scope") {
        expect(first.reason).toContain("Expansion needed: grant read access");
        expect(first.action.references).toContainEqual(expect.objectContaining({ agent: "pitako.execution-inspector" }));
        expect(first.actionRequired).not.toContain("consent");
      }
      const saved = host.current();
      saved.loop.recoveries[0].ref.key = "renamed-query";
      saved.loop.recoveries[0].source.key = "renamed-director";
      host.storage.set("invoke-human-1", saved);
      expect((await host.executeNative()).status).toBe("blocked");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
      expect(host.history()[0].recoveries).toHaveLength(1);
      expect(host.current().association.maxCycles).toBe(3);
    },
  );

  test.each([
    ["running", "State: running", true],
    ["live foreground", "State: live foreground", true],
    ["queued", "State: queued", true],
    ["pending", "State: pending", true],
    ["paused", "State: paused", true],
    ["recovery", "State: recovery", true],
    ["detached", "State: remembered foreground\n1. pitako.worker detached, detached: awaiting supervisor", true],
    ["remembered running", "State: remembered foreground\n1. pitako.worker running", true],
    ["named remembered child", "State: remembered foreground\n1. Writer task one running", true],
    ["remembered paused", "State: remembered foreground\n1. pitako.worker paused, exit 0", true],
    ["pending append", "State: complete\nPending appends: 1", true],
    ["nested running", "State: complete\n  ↳ worker [native-child] running | tool bash", true],
    ["nested exact queued", "Root: native-parent\nParent: native-parent\nState: queued", true],
    ["settled historical detach", "State: remembered foreground\n1. pitako.worker completed, exit 0, detached: awaiting supervisor", false],
    ["settled prose", "State: remembered foreground\n1. pitako.worker completed, exit 0, output: worker stopped, pending recovery", false],
    ["settled async", "State: complete\nPending appends: 0", false],
    ["unrelated run", "State: running", false],
    ["unrelated body run", "State: running", false],
    ["unrelated output", "State: complete\nOutput: /native/running-stopped-recovery.txt", false],
  ])("installed wrapped status distinguishes %s from actual writer activity", async (mode, body, active) => {
    const host = fixture(undefined, { realCheckout: true, readOnly: true });
    cutAt(host, value => !!value.loop?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
        host.setRespond((request, normal) => {
      if (request.key === "invoke-human-1.l1.t1.a2") {
        const saved = host.current(), restore = saved.loop.attempt.restore;
        restoreCheckpoint(restore.sourceKeys.map((key: string) => saved.taskFrame.sources.find((source: any) => source.key === key)), restore.authority);
      }
      return normal();
    });
    host.setStatus(ref => {
      if (!ref.includes(".t1.a1")) {
        const settled = copy(host.native.get(ref)!);
        return { ...settled, output: JSON.stringify(settled.structuredOutput) };
      }
      const id = mode === "unrelated run" ? "another-run" : ref;
      const header = mode === "nested exact queued" ? `Nested run: ${id}`
        : `Run: ${mode === "unrelated body run" ? "another-run" : id}`;
      return { ok: true, results: [], output: `Status target: run ${id}\nSpawn budget: unlimited\nActive async capacity: 0/unlimited used\n${header}\n${body}\nMode: single` };
    });
    const output = await host.execute();
    expect(output.status).toBe(active ? "blocked" : "complete");
    expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key.endsWith(".t1.a1"))).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(active ? 1 : 2);
    if (active) expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.filter(call => call.key.includes(".recover"))).toHaveLength(0);
  });

  test.each([["plan", "stopped"], ["writer", "stopped"], ["plan", "interrupted"], ["writer", "interrupted"]])("observed %s recovery %s preserves barriers without repeating work", async (phase, signal) => {
    const host = fixture(undefined, { realCheckout: true, readOnly: true });
    cutAt(host, value => phase === "plan" ? value.loop?.plan?.stage === "published" : !!value.loop?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    if (phase === "plan") removeCache(host);
    host.setStatus(ref => {
      if (phase === "writer" && !ref.includes(".t1.a1")) {
        const settled = copy(host.native.get(ref)!);
        return { ...settled, output: JSON.stringify(settled.structuredOutput) };
      }
      return { ok: true, results: [] };
    });
    const kind = phase === "plan" ? "loop-plan" : "attempt-result";
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.worker" && host.current().loop.attempt.restore) {
        const saved = host.current(), restore = saved.loop.attempt.restore;
        restoreCheckpoint(restore.sourceKeys.map((key: string) => saved.taskFrame.sources.find((source: any) => source.key === key)), restore.authority);
      }
      return (phase === "plan" ? request.phase === "recovery" && request.task.includes(`\n\nEXCEPTIONAL READ-ONLY ${kind}`) : request.key === "invoke-human-1.l1.t1.a2")
        ? { ...normal(), ok: false, [signal]: true } : normal();
    });
    const technicalInterruption = phase === "writer" && signal === "interrupted";
    const output = await host.execute();
    expect(output.status, output.reason).toBe(technicalInterruption ? "partial" : "cancelled");
    if (technicalInterruption) {
      expect(output.reason).toContain("Restoration remains pending with no new checkpoint evidence");
      const workers = host.calls.filter(call => call.agent === "pitako.worker");
      expect((await host.execute()).status).toBe("partial");
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toEqual(workers);
    }
    expect(host.calls.some(call => phase === "plan" ? call.phase === "recovery" && call.task.includes(`\n\nEXCEPTIONAL READ-ONLY ${kind}`) : call.key === "invoke-human-1.l1.t1.a2")).toBe(true);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(phase === "plan" ? 0 : 2);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
  });

  test.each(["plan", "writer"])("native rejected %s status preserves causal cancellation, not its error wording", async phase => {
    const host = fixture();
    cutAt(host, value => !!value.loop?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    if (phase === "plan") removeCache(host);
    host.setStatus(ref => {
      if (phase === "writer" && !ref.includes(".t1.a1")) {
        const settled = copy(host.native.get(ref)!);
        return { ...settled, output: JSON.stringify(settled.structuredOutput) };
      }
      return { ok: false, results: [], output:
        `Status target: run ${ref}\nSpawn budget: unlimited\nActive async capacity: 0/unlimited used\nRun: ${ref}\nState: stopped\nMode: single` };
    });
    const output = await host.executeNative();
    expect(output.status).toBe("cancelled");
    expect(output.reason).toContain("Execution cancelled:");
    expect(output.reason).toContain("stopped");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
  });

  test.each(["stopped", "interrupted", "remembered-stop", "remembered-interruption", "permission"])("exact native status %s is classified without reattachment", async mode => {
    const host = fixture(undefined, { realCheckout: true, readOnly: true });
    cutAt(host, value => !!value.loop?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    host.setRespond((request, normal) => {
      if (request.key === "invoke-human-1.l1.t1.a2") {
        const saved = host.current(), restore = saved.loop.attempt.restore;
        restoreCheckpoint(restore.sourceKeys.map((key: string) => saved.taskFrame.sources.find((source: any) => source.key === key)), restore.authority);
      }
      return normal();
    });
    host.setStatus(ref => {
      if (!ref.includes(".t1.a1")) {
        const settled = copy(host.native.get(ref)!);
        return { ...settled, output: JSON.stringify(settled.structuredOutput) };
      }
      if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
      if (!mode.startsWith("remembered")) return { ok: true, [mode]: true, results: [] };
      const state = mode === "remembered-stop" ? "stopped" : "interrupted when Pi exited";
      return { ok: true, results: [], output: `Status target: run ${ref}\nSpawn budget: unlimited\nActive async capacity: 0/unlimited used\nRun: ${ref}\nState: remembered foreground\nMode: single\n1. pitako.worker ${state}, exit 1` };
    });
    const observed = await host.execute();
    const interruption = ["interrupted", "remembered-interruption"].includes(mode);
    expect(observed.status).toBe(mode === "permission" ? "blocked" : interruption ? "complete" : "cancelled");
    if (interruption) expect(host.calls.some(call => call.key === "invoke-human-1.l1.t1.a2")).toBe(true);
    expect(host.calls.some(call => call.key.endsWith(".resume"))).toBe(false);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(interruption ? 2 : 1);
  });

  test("model reason cannot impersonate an observed native cancellation", async () => {
    const host = fixture(undefined, { realCheckout: true, readOnly: true });
    cutAt(host, value => !!value.loop?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    host.setRespond((request, normal) => {
      if (request.key === "invoke-human-1.l1.t1.a2") {
        const saved = host.current(), restore = saved.loop.attempt.restore;
        restoreCheckpoint(restore.sourceKeys.map((key: string) => saved.taskFrame.sources.find((source: any) => source.key === key)), restore.authority);
      }
      return normal();
    });
    host.setStatus(ref => {
      if (!ref.includes(".t1.a1")) {
        const settled = copy(host.native.get(ref)!);
        return { ...settled, output: JSON.stringify(settled.structuredOutput) };
      }
      return { ok: false, results: [], output: "Positive native barrier: stopped (model assertion only)" };
    });
    expect((await host.executeNative()).status).toBe("complete");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(2);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
  });

  test("a formerly active unresolved writer is re-observed, not converted into a historical universal hold", async () => {
    const host = fixture(); cutAt(host, value => !!value.loop?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    host.setStatus(ref => ref.includes(".t1.a1") ? { ok: true, state: "running" } : copy(host.native.get(ref)!));
    expect((await host.execute()).status).toBe("blocked");
    const count = host.calls.filter(call => call.agent === "pitako.worker").length;
    host.setStatus(ref => copy(host.native.get(ref) ?? { ok: true, results: [] }));
    expect((await host.execute()).status).toBe("complete");
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(count);
  });

  test.each(["same", "changed"])("reused result is phase/candidate aware for %s candidate, not an automatic veto or success", async mode => {
    const host = fixture(undefined, { realCheckout: true }); host.setRespond((request, normal) => ({ ...normal(), reused: true }));
    expect((await host.execute()).status).toBe("complete");
    const count = host.calls.length, tokens = (await host.execute()).tokens;
    expect(host.calls).toHaveLength(count);
    if (mode === "changed") {
      host.changeCheckout(); expect((await host.execute()).loopsConsumed).toBe(3);
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(3);
    } else expect((await host.execute()).tokens).toEqual(tokens);
  });

  test("replay of already completed review/compliance does not rerun gates or double tokens after a closing persistence cut", async () => {
    const host = fixture(undefined, { taskCount: 0 }); cutAt(host, value => value.loop?.phase === "finished");
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    const count = host.calls.length, tokens = (await host.execute()).tokens;
    expect((await host.execute()).status).toBe("complete"); expect(host.calls).toHaveLength(count);
    expect(host.current().loop.usage).toEqual([]); expect((await host.execute()).tokens).toEqual(tokens);
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.checkout")).toHaveLength(1);
  });

  test("candidate changed after closing persistence cut invalidates cached gates without a second close in that loop", async () => {
    const host = fixture(undefined, { realCheckout: true, taskCount: 0 }); cutAt(host, value => value.loop?.phase === "finished");
    expect((await host.execute()).status).toBe("partial"); host.setFailSave(); host.changeCheckout();
    expect((await host.execute()).status).toBe("complete");
    expect(host.history()).toHaveLength(2);
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.checkout")).toHaveLength(1);
    expect(host.history()[0].invalidated).toBe("candidate-changed-after-close");
  });

  test.each(["detached", "recovery"])("positive %s review observation survives the shared library boundary and blocks another writer", async field => {
    const host = fixture(undefined, { taskCount: 0 }); host.setRespond((request, normal) => request.key.endsWith("director-prepare")
      ? { ...normal(), [field]: true } : normal());
    const output = await host.execute();
    expect(output.status).toBe("blocked"); expect(output.reason).toContain(field);
    expect(host.calls.filter(call => call.key.endsWith(".compliance"))).toHaveLength(0);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
    expect(host.history()).toHaveLength(1);
  });

  test.each(["review", "compliance"])("native child capacity exhausted during %s preserves phase and refs without omitted phases, replacement mission or own budget", async phase => {
    const host = fixture("FULL SPEC", { angles: 4, findings: true, taskCount: 0 });
    host.setRespond((request, normal) => {
      if (phase === "review" ? request.key.includes("critique-") : request.key.endsWith(".compliance"))
        throw Error("Run fan-out limit reached at root (64/64 used; 1 requested, 0 remaining). No children from this admission group were started. Start a new top-level run or raise config.maxSubagentSpawnsPerRun.");
      return normal();
    });
    const output = await host.execute(); expect(output.status).toBe("partial"); expect(output.loopsConsumed).toBe(1);
    expect(output.phase).toBe(phase); expect(output.reason).toContain("Run fan-out limit reached");
    expect(host.history()[0].halt.code).toBe("capacity");
    expect(output.loopReport.next).not.toContain("continue loop");
    expect(host.current().loop.finalAttempt.gate.receipt.gates).toMatchObject([{ id: "full", status: "pass" }]);
    if (phase === "review") expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
    const count = host.calls.length, halt = copy(host.history()[0].halt);
    const replay = await host.execute();
    expect(replay.status).toBe("partial"); expect(replay.reason).toBe(output.reason);
    expect(replay.phase).toBe(phase); expect(replay.loopsConsumed).toBe(1);
    expect(replay.loopReport.halt).toEqual(halt);
    expect(replay.loopReport.pending[0].references).toContainEqual(halt.ref);
    expect(host.history()[0].halt).toEqual(halt); expect(host.calls).toHaveLength(count);
    expect(host.calls.every(call => !("maxSubagentSpawnsPerRun" in call))).toBe(true);
  });

  test.each(["director-prepare", "director-synthesis", "compliance"])("semantic %s blocking prose never becomes a native capacity halt", async phase => {
    const reason = "Cannot establish capacity, spawn, budget, timeout or deadline requirements from the spec.";
    const host = fixture(undefined, { taskCount: 0 });
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(phase)) {
        const value = result.structuredOutput;
        if (phase === "director-synthesis") value.screening = { verdict: "blocked", reason, assessments: [] };
        else Object.assign(value, { status: "blocked", reason });
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status).toBe("blocked"); expect(output.reason).toContain(reason);
    expect(output.loopsConsumed).toBe(1);
    const halt = copy(host.history()[0].halt);
    expect(halt.code).toBe("semantic-block");
    const phaseRecord = phase === "compliance" ? host.history()[0].compliance : host.history()[0].review;
    const retained = JSON.stringify(phaseRecord);
    expect(retained).toContain(`/native/output/invoke-human-1.l1.${phase === "compliance" ? "" : "review."}${phase}.json`);
    const calls = host.calls.length, replay = await host.execute();
    expect(replay.reason).toBe(output.reason); expect(replay.status).toBe("blocked");
    expect(replay.phase).toBe(output.phase); expect(replay.loopsConsumed).toBe(1);
    // Reference-only synthesis revalidates its required originals on disk.
    expect(host.calls.slice(calls).map(call => ({ agent: call.agent, key: call.key }))).toEqual(
      phase === "director-synthesis" ? [{ agent: "pitako.access-verifier", key: "invoke-human-1.l1.review.verify-synthesis.r1" }] : []);
    expect(host.history()[0].halt).toEqual(halt);
  });

  test.each(["director", "worker", "review", "compliance"])("returned native capacity receipt at %s retains its actual run reference", async phase => {
    const reason = "Active async run capacity exhausted: 4/4 used.";
    const host = fixture(undefined, { taskCount: phase === "director" || phase === "worker" ? 1 : 0 });
    const suffix = phase === "review" ? "review.director-prepare" : phase === "worker" ? "t1.a1" : phase;
    host.setRespond((request, normal) => request.key.endsWith(suffix)
      ? { ...normal(), ok: false, error: reason } : normal());
    const output = await host.execute();
    expect(output.status).toBe("partial"); expect(output.reason).toContain(reason);
    expect(host.history()[0].halt).toMatchObject({ code: "capacity", reason,
      ref: { runId: `native-invoke-human-1.l1.${suffix}` } });
    const count = host.calls.length, replay = await host.execute();
    expect(replay.loopReport.halt).toEqual(host.history()[0].halt);
    expect(replay.loopReport.pending[0].references).toContainEqual(host.history()[0].halt.ref);
    expect(replay.loopsConsumed).toBe(1); expect(host.calls).toHaveLength(count);
  });

  test("native sandbox dispatch retains a thrown capacity receipt without rerunning its halted loop", async () => {
    const host = fixture(undefined, { taskCount: 0 });
    const reason = "Active async run capacity exhausted: 4/4 used.";
    host.setRespond((request, normal) => {
      if (request.key.endsWith(".compliance")) throw Error(reason);
      return normal();
    });
    const output = await host.executeNative();
    expect(output.status).toBe("partial"); expect(output.reason).toBe(reason);
    expect(host.history()[0].halt.code).toBe("capacity");
    const count = host.calls.length;
    expect((await host.executeNative()).reason).toBe(reason); expect(host.calls).toHaveLength(count);
  });

  test.each(["compliance", "director-prepare"])("even an exact capacity receipt quoted by a successful %s is a semantic block", async phase => {
    const reason = "Active async run capacity exhausted: 4/4 used.";
    const host = fixture(undefined, { taskCount: 0 });
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(phase)) Object.assign(result.structuredOutput, { status: "blocked", reason });
      return result;
    });
    const output = await host.execute();
    expect(output.status).toBe("blocked"); expect(output.reason).toContain(reason);
    expect(host.history()[0].halt.code).toBe("semantic-block");
  });

  test.each(["director-prepare", "independent-angle1"])("thrown native permission receipt at %s crosses the shared review boundary as a barrier", async phase => {
    const host = fixture(undefined, { taskCount: 0 });
    host.setRespond((request, normal) => {
      if (request.key.endsWith(phase)) throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      return normal();
    });
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    expect(host.history()[0].halt).toMatchObject({ code: "native-barrier", cause: "native permission denial" });
    expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
  });

  test("arbitrary native exception words are incomplete dispatch evidence, not a capacity certificate", async () => {
    const host = fixture(undefined, { taskCount: 0 });
    host.setRespond((request, normal) => {
      if (request.key.endsWith(".compliance")) throw Error("Investigate timeout, capacity, spawn and budget diagnostics");
      return normal();
    });
    const output = await host.execute();
    expect(output.status).toBe("partial");
    expect(host.history()[0].halt.code).toBe("native-dispatch");
    const count = host.calls.length;
    expect((await host.execute()).reason).toBe(output.reason); expect(host.calls).toHaveLength(count);
  });

  test.each(["worker-stop", "review-stop", "permission", "timeout"])("native %s is not green or an inferred invocation timeout cancellation", async mode => {
    const host = fixture(undefined, { realCheckout: true, readOnly: true, taskCount: mode === "review-stop" ? 0 : 1 }); host.setRespond((request, normal) => {
      if (request.agent === "pitako.worker" && host.current().loop.attempt.restore) {
        const saved = host.current(), restore = saved.loop.attempt.restore;
        restoreCheckpoint(restore.sourceKeys.map((key: string) => saved.taskFrame.sources.find((source: any) => source.key === key)), restore.authority);
      }
      if (mode === "review-stop" && request.key.endsWith("director-prepare")) return { ...normal(), ok: false, stopped: true, error: "Observed Stop" };
      if (request.agent === "pitako.worker" && request.key.includes(".l1.")) {
        if (mode === "worker-stop") return { ...normal(), ok: false, stopped: true };
        if (mode === "permission") return { ...normal(), ok: false, error: "Blocked by pi-subagents permission rule: 'run' is denied." };
        if (mode === "timeout" && request.key.endsWith(".a1")) return { ...normal(), ok: false, terminalOutcome: { state: "partial", reason: "timeout" }, error: "Native deadline" };
      } return normal();
    });
    const output = await host.execute();
    expect(output.status).toBe(mode.endsWith("stop") ? "cancelled" : mode === "timeout" ? "complete" : "blocked");
    if (mode === "timeout") expect(output.loopsConsumed).toBe(2);
    else expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
  });

  test("full-file native 256 KiB envelope includes other keys, maximum multibyte/escaped spec, long metadata, huge allowed reports and three slots", async () => {
    const unit = '\\"é界';
    const content = unit.repeat(Math.floor(MAX_SPEC_BYTES / Buffer.byteLength(unit))) + "x".repeat(MAX_SPEC_BYTES % Buffer.byteLength(unit));
    expect(Buffer.byteLength(content)).toBe(39936);
    const host = fixture(content, { metadataPadding: 7000, angles: 4, findings: true, taskCount: 0 });
    const inlineOriginals = observeInlineReviewOriginals(host);
    host.storage.set("other-owned-history", { content: "h".repeat(90000) });
    const essentialBytes: number[] = [];
    const originalSet = host.state.set;
    host.state.set = async (key, value) => {
      if (!(value as any)?.activePlan)
        essentialBytes.push(Buffer.byteLength(JSON.stringify({ ...Object.fromEntries(host.storage), [key]: value }, null, 2)));
      await originalSet(key, value);
    };
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.phase?.startsWith("review-")) {
        // This capacity case publishes only the actual original. The default
        // double's extra /native optional paths are not real publications here;
        // dedicated adapter cases below/above retain every supplied witness.
        const saved = result.results![0]!.savedOutputPath!;
        result.outputReference = saved;
        delete result.outputArtifactPath; delete result.outputPathMapping; delete result.artifactPaths;
        delete result.results![0]!.structuredOutputPath;
      }
      // The selection contract has no conversational sharedContext cache.
      if (request.agent === "pitako.worker") {
        result.structuredOutput.work = "w".repeat(300000);
        result.structuredOutput.knowledge = { findings: ["d".repeat(300000)], handoff: "o".repeat(300000) };
      }
      return request.key.endsWith(".compliance") ? gaps(result) : result;
    });
    const output = await host.execute(); expect(output).toMatchObject({ status: "partial", loopsConsumed: 3 });
    expect(host.optionalCacheFailures()).toBe(0);
    expect(host.snapshots.every(value => !value.activePlan)).toBe(true);
    const serialized = JSON.stringify(Object.fromEntries(host.storage), null, 2);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(MISSION_STATE_MAX_BYTES);
    expect(serialized).not.toContain("w".repeat(1000)); expect(serialized).not.toContain("d".repeat(1000)); expect(serialized).not.toContain("o".repeat(1000));
    expect(host.current().association.digest).toBe(digest(content)); expect(host.storage.get("other-owned-history").content).toHaveLength(90000);
    expect(host.hostCalls).toEqual(["inspect-initial"]); expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(2);
    expect(host.history().map((loop: any) => loop.number)).toEqual([1, 2, 3]);
    expect(Math.max(...essentialBytes)).toBeLessThanOrEqual(MISSION_STATE_MAX_BYTES);
    // One review slot per execute invocation: archived loops never re-enter review.
    expect([...host.storage.keys()].filter(key => key.startsWith("review-"))).toEqual(["review-invoke-human-1"]);
    for (const loop of host.history().slice(-1)) {
      const manifest = host.storage.get("review-invoke-human-1");
      expect(manifest.decision).toEqual({ reference: { stateKey: "invoke-human-1", loop: loop.number } });
      expect(manifest.query).toBe(JSON.stringify(loop.candidate));
      expect(manifest.revision).toBe(1);
      expect(manifest.originals).toHaveLength(14);
      for (const retained of manifest.originals) {
        expect(Object.keys(retained).sort()).toEqual(["id", "key", "path", "runId", "sha256"]);
        const original = inlineOriginals.get(retained.key);
        expect(canonicalDigest(readReviewOriginal(retained))).toBe(original.digest);
        expect(original).toMatchObject({ attempt: 1, terminal: "succeeded", publication: "published",
          delivery: "complete", essentialAccess: "accessible", sufficient: true, diagnostic: "" });
        const ref = loop.review.references.find((entry: any) => entry.key === original.key);
        expect(ref.runId).toBe(original.runId);
        const witness = publicationWitness(ref.results[0], host.native.get(ref.runId)!.results![0]);
        const exact = JSON.parse(readFileSync(witness.savedOutputPath, "utf8"));
        expect(original.association).toEqual({ namespace: manifest.namespace, query: manifest.query, revision: manifest.revision,
          phase: host.calls.find(call => call.key === original.key)!.phase!.replace("review-", ""),
          producer: original.key.includes(".director-") ? "director" : original.key.split("-").at(-1),
          key: original.key, attempt: original.attempt });
        expect(original.digest).toBe(canonicalDigest(exact));
        expect(original.id).toBe(`${original.association.key}.v1.a1`);
        expect(ref.outputReference).toBe(witness.savedOutputPath);
        expect(witness.outputReference).toEqual({ path: witness.savedOutputPath,
          bytes: readFileSync(witness.savedOutputPath).byteLength, lines: 1, message: "Saved" });
      }
    }
  });

  test.each(["before-director", "before-worker", "after-result"])("essential state failure %s halts new dispatch and retains frozen snapshot/descriptor/history", async phase => {
    const host = fixture(); host.storage.set("history", { retained: true });
    cutAt(host, value => phase === "before-director" ? value.consumedLoops === 1 : phase === "before-worker"
      ? value.loop?.attempt?.stage === "intention" : value.loop?.attempt?.stage === "result");
    const output = await host.execute(); expect(output.status).toBe("partial"); expect(output.reason).toContain("Essential persistence failed");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(phase === "after-result" ? 1 : 0);
    expect(host.current().association.digest).toBe(digest("COMPLETE IMMUTABLE SPECS")); expect(host.storage.get("history")).toEqual({ retained: true });
    if (phase === "after-result") expect(host.history()[0].attempt).toMatchObject({
      taskId: "change1", index: 0, number: 1, stage: "launched",
      launch: { key: "invoke-human-1.l1.t1.a1", runId: "native-invoke-human-1.l1.t1.a1" },
    });
  });

  test("native envelope overflow in essential snapshot does not dispatch or prune unrelated state", async () => {
    const host = fixture("s".repeat(MAX_SPEC_BYTES)); host.storage.set("unrelated", { bytes: "h".repeat(MISSION_STATE_MAX_BYTES - 400) });
    const before = copy(host.storage.get("unrelated"));
    expect((await host.execute()).reason).toContain("Essential persistence failed"); expect(host.calls).toHaveLength(0);
    expect(host.storage.get("unrelated")).toEqual(before);
  });

  test("semantic progress preserves original elapsed waits and attributable token dedup, with missing metrics unavailable not zero", async () => {
    const host = fixture(); host.setRespond((request, normal) => {
      const result = normal(); if (request.key.endsWith(".director")) host.advance(5000);
      if (request.agent === "pitako.worker") delete result.results; return result;
    });
    const output = await host.execute(); expect(output.elapsedMs).toBeGreaterThanOrEqual(5000);
    expect(output.tokens.coverage).toBe("partial"); expect(output.tokens.value).toBeGreaterThan(0);
    const progress = host.emits.filter(value => value.type === "execution-progress");
    expect(progress[0]).toMatchObject({ invocation: "human-1", loop: 1, loopsConsumed: 1, phase: "director", tokens: { value: null, coverage: "unavailable" } });
    expect(progress.find(value => value.phase === "implementation")).toMatchObject({ taskId: "change1", attempt: 1 });
    const before = copy(output.tokens); host.advance(10000);
    const replay = await host.execute(); expect(replay.tokens).toEqual(before); expect(replay.elapsedMs).toBe(output.elapsedMs + 10000);
    expect(replay.loopReport.elapsedMs).toBe(output.loopReport.elapsedMs);
  });

  test("a worker decision block reports concrete question, unrun analyses and no continuation announcement", async () => {
    const host = fixture(); host.setRespond((request, normal) => {
      const result = normal(); if (request.agent === "pitako.worker") Object.assign(result.structuredOutput, { status: "blocked", work: "Cannot choose conflicting requirements", remaining: ["Which of the two conflicting public API requirements is authorized?"] });
      return result;
    });
    const output = await host.execute(); expect(output.status).toBe("blocked"); expect(output.actionRequired).toContain("Which");
    expect(output.loopReport.verification.adversarial.status).toBe("not-run"); expect(output.loopReport.next).not.toContain("continue");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.some(call => call.key.includes(".review.") || call.key.endsWith(".compliance"))).toBe(false);
  });

  test.each(["old-state", "unblock", "mission-path", "source-drift", "different-invocation"])("rejects %s without historical rewrites or slot renewal", async mode => {
    const host = fixture(); let before: any;
    if (mode === "old-state") host.storage.set("pitako-execution", { unsettled: { invocation: "old" }, root: config.root });
    if (["mission-path", "source-drift", "different-invocation"].includes(mode)) expect((await host.execute()).status).toBe("complete");
    before = copy(Object.fromEntries(host.storage)); const count = host.calls.length;
    if (mode === "source-drift") host.setHostResponse((_key, value) => ({ ...value, binding: "f".repeat(64) }));
    const output = await host.execute(mode === "unblock" ? { unblock: true } : mode === "mission-path" ? { missionPath: "/guessed/path" } : mode === "different-invocation" ? { invocation: "new-ID" } : {});
    expect(output.status).toBe("blocked"); expect(host.calls).toHaveLength(count); expect(Object.fromEntries(host.storage)).toEqual(before);
  });
});


describe("checkpoint-first interrupted selected-task continuation", () => {
  // All selected backlog tasks have a checkpoint, including no-op/read-only work.
  // Restoration uses real owned preimages; native resume is not a second writer route.
  const restoreSelectedTask = (host: ReturnType<typeof fixture>) => {
    const restore = host.current().loop.attempt.restore;
    const sources = restore.sourceKeys.map((key: string) => host.current().taskFrame.sources.find((source: any) => source.key === key));
    restoreCheckpoint(sources, restore.authority);
  };

  test("an interrupted task restores before a fresh same-task worker and reaches final verification", async () => {
    const fx = fixture(undefined, { realCheckout: true, readOnly: true });
    fx.setRespond((request, normal) => {
      if (request.key.endsWith(".t1.a1")) return {
        ...normal(), ok: false, structuredOutput: undefined, state: "interrupted", results: [],
      };
      if (request.key.endsWith(".t1.a2")) {
        expect(fx.current().loop.attempt.restore.producer.key).toBe("invoke-human-1.l1.t1.a1");
        restoreSelectedTask(fx);
      }
      return normal();
    });
    const result = await fx.executeNative();
    expect(fx.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
      .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
    expect(fx.calls.some(call => call.resume?.includes(".t1."))).toBe(false);
    expect(fx.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(fx.history()[0].results.find((entry: any) => entry.taskId === "change1").status).toBe("complete");
    expect(readBacklog(fx.root, "spec").backlog!.tasks[0]!.status).toBe("done");
    expect(fx.calls.some(call => call.key.endsWith(".compliance"))).toBe(true);
    expect(result.status).toBe("complete");
  });

  test.each(["before-restoration-launch", "before-result-save", "after-result-save"])("reconciles %s without repeating the interrupted or restored writer", async cut => {
    const fx = fixture(undefined, { realCheckout: true, readOnly: true }); fx.setLimit(1);
    cutAt(fx, value => cut === "after-result-save" ? value.loop?.cursor === 1
      : value.loop?.attempt?.key.endsWith(".a2") && (cut === "before-restoration-launch"
        ? value.loop.attempt.restore?.undispatched === true : value.loop.attempt.stage === "result"));
    fx.setRespond((request, normal) => {
      if (request.key.endsWith(".t1.a1")) return { ...normal(), ok: false, state: "interrupted", structuredOutput: undefined, results: [] };
      if (request.key.endsWith(".t1.a2")) restoreSelectedTask(fx);
      return normal();
    });
    const first = await fx.executeNative();
    expect(first.status).toBe("partial");
    expect(first.reason).toContain("Essential persistence failed");
    fx.setFailSave();
    const continued = await fx.executeNative();
    expect(continued.status, continued.reason).toBe("partial");
    expect(fx.current().tasks.change1.completed.status).toBe("complete");
    expect(fx.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
      .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
    expect(fx.calls.some(call => call.resume)).toBe(false);
    expect(fx.history()).toHaveLength(1);
  });

  test("a pending restoration successor is observed, never replaced by another key", async () => {
    const fx = fixture(undefined, { realCheckout: true, readOnly: true }); fx.setLimit(1);
    fx.setRespond((request, normal) => {
      if (request.key.endsWith(".t1.a1")) return { ...normal(), ok: false, state: "interrupted", structuredOutput: undefined, results: [] };
      if (request.key.endsWith(".t1.a2")) {
        restoreSelectedTask(fx);
        return { ...normal(), ok: false, state: "running", structuredOutput: undefined, results: [] };
      }
      return normal();
    });
    expect((await fx.executeNative()).status).toBe("blocked");
    fx.setStatus(ref => ref.endsWith(".t1.a2") ? { ok: true, state: "running" } : copy(fx.native.get(ref) ?? { ok: true, results: [] }));
    const callCount = fx.calls.length;
    const replay = await fx.executeNative();
    expect(replay.status, replay.reason).toBe("blocked");
    expect(fx.calls).toHaveLength(callCount);
    expect(fx.calls.filter(call => call.key.endsWith(".t1.a2"))).toHaveLength(1);
    expect(fx.calls.some(call => call.resume)).toBe(false);
  });

  test("a previously pending restoration successor is admitted when its exact result settles", async () => {
    const fx = fixture(undefined, { realCheckout: true, readOnly: true }); fx.setLimit(1);
    let successor: Result | undefined;
    fx.setRespond((request, normal) => {
      if (request.key.endsWith(".t1.a1")) return { ...normal(), ok: false, state: "interrupted", structuredOutput: undefined, results: [] };
      if (request.key.endsWith(".t1.a2")) {
        restoreSelectedTask(fx);
        successor = normal();
        return { ...successor, ok: false, state: "running", structuredOutput: undefined, results: [] };
      }
      return normal();
    });
    expect((await fx.executeNative()).status).toBe("blocked");
    fx.setStatus(ref => ref.endsWith(".t1.a2") ? copy(successor!) : copy(fx.native.get(ref) ?? { ok: true, results: [] }));
    const continued = await fx.executeNative();
    expect(continued.status, continued.reason).toBe("partial");
    expect(fx.current().tasks.change1.completed.status).toBe("complete");
    expect(fx.calls.filter(call => call.key.endsWith(".t1.a2"))).toHaveLength(1);
    expect(fx.calls.some(call => call.resume)).toBe(false);
    expect(fx.history()).toHaveLength(1);
  });

  test.each(["stopped", "running", "rejected"])("positive %s remains a barrier, not checkpoint recovery authority", async state => {
    const fx = fixture(undefined, { readOnly: true });
    fx.setRespond((request, normal) => request.key.endsWith(".t1.a1") ?
      { ...normal(), ok: false, state, structuredOutput: undefined, results: [] } : normal());
    const result = await fx.executeNative();
    expect(result.status).not.toBe("complete");
    expect(fx.calls.some(call => call.resume)).toBe(false);
    expect(fx.calls.some(call => call.key.endsWith(".t1.a2"))).toBe(false);
  });
});

describe("compact admission", () => {
  test.each(["bad-digest", "extra-field", "wrong-subject-type"])("bound admission recovery rejects invalid native checkpoint witness: %s", mode => {
    const host = fixture();
    host.setHostResponse((_key, value) => ({ ...value, checkpointObservation: {
      key: "invoke-human-1.l1.t1.a1", taskId: "change1", attempt: 1, loop: 1, cursor: 0,
      evidence: mode === "bad-digest" ? "truncated" : "f".repeat(64),
      ...(mode === "extra-field" ? { unvalidated: true } : {}),
      ...(mode === "wrong-subject-type" ? { attempt: "1" } : {}),
    } }));
    return host.execute().then(outcome => {
      expect(outcome.status).toBe("blocked");
      expect(outcome.reason).toContain("Invalid native checkpoint observation");
      expect(host.calls).toHaveLength(0);
      expect(host.current()?.association).toBeUndefined();
      expect(host.hostCalls).toEqual(["inspect-initial"]);
    });
  });
  test("compares before the snapshot save or first director, uses one host and no initial child", async () => {
    const host = fixture();
    host.setHostResponse((key, value) => key === "inspect-initial" ? { ...value, binding: "f".repeat(64) } : value);
    const result = await host.execute();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("binding mismatch");
    expect(result.reason).toContain("expected");
    expect(result.reason).toContain("observed");
    expect(result.reason).toContain("explicitly prepare admission");
    expect(host.calls).toHaveLength(0);
    expect(host.hostCalls).toEqual(["inspect-initial"]);
    expect(host.current()?.snapshot).toBeUndefined();
  });
  test("persists only the spec digest and frozen budget before director", async () => {
    const content = "Unicode 中😀 \n \"; globalThis.untrusted = true; //";
    const host = fixture(content); host.setLimit(10);
    host.setRespond((request, normal) => {
      if (request.agent !== "pitako.execution-director") return normal();
      expect(host.current().association.digest).toBe(digest(content));
      expect(host.current().association.maxCycles).toBe(10);
      expect(host.hostCalls).toEqual(["inspect-initial"]);
      expect(request.agent).toBe("pitako.execution-director");
      return { ok: false, error: "Controlled director rejection after admission" };
    });
    await host.execute();
    expect(host.current().snapshot).toBeUndefined(); expect(host.current().association.digest).toBe(digest(content));
    expect(JSON.stringify(Object.fromEntries(host.storage)).split(content).length).toBeLessThanOrEqual(2);
    expect(host.launches.map(call => call.agent)).toEqual(["pitako.loop-io", "pitako.execution-director"]);
  });
  test("later settings cannot replace the admitted budget and base changes preserve original bytes", async () => {
    const host = fixture("ORIGINAL FULL SNAPSHOT");
    host.setRespond(() => ({ ok: false, error: "Controlled rejection after admission" }));
    await host.execute();
    const original = copy(host.current().snapshot);
    host.setLimit(10);
    await host.execute();
    expect(host.current().association.maxCycles).toBe(3);
    expect(host.current().snapshot).toEqual(original);
    host.setHostResponse((key, value) => key === "inspect-initial" ? { ...value, binding: "b".repeat(64) } : value);
    const before = host.calls.length;
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    expect(output.reason).toContain("restore reliable exact bytes");
    expect(host.current().snapshot).toEqual(original);
    expect(host.calls).toHaveLength(before);
  });
  test("essential snapshot save failure prevents every child", async () => {
    const host = fixture();
    host.setFailSave(value => !!value.association);
    const output = await host.execute();
    expect(output.status).toBe("partial");
    expect(output.reason).toContain("Essential persistence failed");
    expect(host.calls).toHaveLength(0);
    expect(host.hostCalls).toEqual(["inspect-initial"]);
    expect(host.current()).toBeUndefined();
  });
});


describe("native closing observations", () => {
  test("four host-free final closes interleaved with repair tasks preserve singleton implicit waiting and distinct evidence", async () => {
    // Closing evidence is the subject; real checkpoint sealing is covered by the sealer and recovery suites.
    const host = fixture(undefined, { readOnly: true }); host.setLimit(10);
    host.setRespond((request, normal) => {
      const result = normal();
      // Each of the first two loops stalls a distinct task, not the same task twice.
      if (request.key === "invoke-human-1.l2.director") {
        const stalled = readBacklog(host.root, "spec").backlog!.tasks.find(task => task.id === "change1")!;
        result.structuredOutput.changes.push({ kind: "split", id: stalled.id,
          tasks: [{ ...copy(stalled), id: "change1-repair", goal: "Repair the pending implementation branch" }],
          reason: "Extract the pending implementation branch from the stalled task" });
        result.structuredOutput.select = "change1-repair";
      }
      if (request.key === "invoke-human-1.l3.director")
        result.structuredOutput.changes.push({ kind: "update", id: "change1-repair",
          patch: { expectedResult: "Complete the concrete pending implementation before final verification" },
          reason: "Refine the stalled repair to the concrete defect reported by the worker" });
      if (request.agent === "pitako.worker" && /\.l[12]\./.test(request.key)) {
        result.structuredOutput.status = "gaps";
        result.structuredOutput.remaining = ["Concrete pending implementation"];
      }
      if (request.key.endsWith(".compliance") && !request.key.includes(".l10.")) {
        result.structuredOutput.status = "gaps";
        result.structuredOutput.requirements[0].status = "gap";
      }
      if (request.agent === "pitako.checkout-observer") {
        const loop = host.history().at(-1);
        expect(loop.observation).toMatchObject({ invocation: "human-1", loop: Number(request.key.match(/\.l(\d+)\./)![1]),
          key: request.key, stage: "intention" });
        expect(loop.closing).toBeUndefined();
        expect(request).toMatchObject({ output: false, outputMode: "inline", cwd: host.root, context: "fresh" });
        expect(request.async).toBeUndefined(); expect(request.outputSchema).toBe(false);
        expect(request.task).not.toContain("IMMUTABLE");
      }
      return result;
    });
    expect(await host.executeNative()).toMatchObject({ status: "complete", maxLoops: 10, loopsConsumed: 10 });
    expect(host.calls.filter(call => call.agent === "pitako.checkout-observer").map(call => call.key)).toEqual([4, 6, 8, 10].map(loop => `invoke-human-1.l${loop}.checkout`));
    const refs = host.history().filter((loop: any) => loop.closing).map((loop: any) => loop.closing.ref);
    expect(new Set(refs.map((ref: any) => ref.asyncDir)).size).toBe(4);
    expect(new Set(refs.map((ref: any) => ref.externalAdapter.outputArtifacts.stdoutPath)).size).toBe(4);
    expect(new Set(refs.map((ref: any) => ref.externalAdapter.outputArtifacts.stderrPath)).size).toBe(4);
    expect(host.hostCalls).toEqual(["inspect-initial"]);
  });

  test.each(["intention", "receipt", "evidence"])("%s save cut retries publication without advancing an unconfirmed close", async cut => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
    cutAt(host, value => {
      const loop = value.loop;
      return cut === "evidence" ? !!loop?.closing : loop?.observation?.stage === cut;
    });
    const output = await host.execute();
    expect(output.status).toBe("partial"); expect(output.reason).toContain("Essential persistence failed");
    expect(host.current().loop.outcome).toBeUndefined();
    const dispatched = host.calls.filter(call => call.agent === "pitako.checkout-observer");
    expect(dispatched).toHaveLength(cut === "intention" ? 0 : cut === "receipt" ? 3 : 1);
    host.setFailSave();
    host.setStatus(ref => ({ ok: true, runId: ref, results: [], output: `Run: ${ref}\nState: complete` }));
    expect((await host.execute()).status).toBe("complete");
    const closing = host.current().loop.closing;
    const expectedKey = `invoke-human-1.l1.checkout${cut === "intention" ? ".r2" : cut === "receipt" ? ".r3" : ""}`;
    expect(closing.ref.runId).toBe(`native-${expectedKey}`);
    expect(closing.ref.asyncDir).toBe(`/native/async/${expectedKey}`);
    expect(closing.ref.externalAdapter.outputArtifacts).toEqual({ stdoutPath: `/native/async/${expectedKey}/stdout.log`, stderrPath: `/native/async/${expectedKey}/stderr.log` });
    expect(closing.observation.checkout).toEqual(host.current().loop.candidate);
    expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "loop"]);
    expect(host.current().ledger.count).toBe(2);
    expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(cut === "receipt" ? 4 : 1);
  });

  test.each(["validated", "recovered"])("%s closing evidence after a save cut cannot certify a changed checkout", async mode => {
    const host = fixture(undefined, { realCheckout: true, taskCount: 0 }); host.setLimit(1);
    cutAt(host, value => mode === "validated" ? !!value.loop?.closing :
      value.loop?.observation?.stage === "receipt");
    expect((await host.execute()).status).toBe("partial");
    const retained = host.history()[0];
    expect(retained.closing).toBeUndefined();
    expect(!!retained.observation.validated).toBe(mode === "validated");
    const originalCandidate = copy(retained.candidate);
    host.setFailSave(); host.changeCheckout();
    const resumed = await host.execute();
    expect(resumed.status).toBe("partial");
    expect(resumed.loopsConsumed).toBe(1);
    expect(resumed.maxLoops).toBe(1);
    expect(host.history()).toHaveLength(1);
    expect(host.history()[0]).toMatchObject({ outcome: "gaps",
      invalidated: "candidate-changed-after-close",
      closing: { candidate: originalCandidate, sameCandidate: false, resumeCandidate: host.observedCandidate() } });
    expect(resumed.loopReport.reason).toContain("Candidate changed");
    expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(mode === "validated" ? 1 : 3);
  });

  test.each(["missing", "wrong-workspace", "oversized", "producer-conflict", "active"])(
    "save-cut replay reconciles %s evidence and preserves current native barriers", async mode => {
      const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
      cutAt(host, value => !!value.loop?.closing);
      expect((await host.execute()).status).toBe("partial");
      host.setFailSave();
      const intention = host.history()[0].observation;
      expect(intention.validated.checkout).toEqual(host.history()[0].candidate);
      if (mode === "missing") delete intention.validated;
      if (mode === "wrong-workspace") intention.validated.root = "/other";
      if (mode === "oversized") intention.validated.extra = "x".repeat(61441);
      host.setStatus(ref => ({ ok: true, runId: mode === "producer-conflict" ? "another-run" : ref,
        results: [], output: `Run: ${ref}\nState: ${mode === "active" ? "running" : "complete"}` }));
      const resumed = await host.execute();
      if (mode === "missing") {
        expect(resumed.status).toBe("complete");
        expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(2);
        expect(host.records()).toHaveLength(2);
        return;
      }
      expect(resumed.status).not.toBe("complete");
      expect(resumed.reason).toContain(mode === "producer-conflict" ? "producer identity changed" :
        mode === "active" ? "native management activity" :
        "Invalid retained closing evidence");
      expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(1);
      expect(host.history()[0].outcome).toBeUndefined();
    });

  test("an unavailable completion is retried against the ledger rather than halted", async () => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
    cutAt(host, value => value.loop?.observation?.stage === "receipt");
    expect((await host.execute()).status).toBe("partial");
    host.setFailSave(); host.native.clear();
    expect((await host.execute()).status).toBe("complete");
    expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(4);
    expect(host.statusCalls).toContain("invoke-human-1.l1.checkout.r2");
    expect(host.current().loop.outcome).toBe("complete");
    expect(host.records()).toHaveLength(2);
  });

  test.each(["missing", "truncated", "invalid", "multiple", "wrong-root", "wrong-common", "wrong-version",
    "running", "rejected", "stopped", "cancelled", "wrong-agent", "no-run", "no-directory", "no-stdout", "no-stderr",
    "save-error", "metadata-error", "transcript-error", "partial", "failed-exit", "partial-terminal", "producer-failure", "no-result", "no-exit"])(
    "rejects %s without closing evidence or an outcome", async mode => {
      const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
      host.setRespond((request, normal) => {
        const result = normal(); if (request.agent !== "pitako.checkout-observer") return result;
        if (mode === "missing") delete result.output;
        if (mode === "truncated") result.output = result.output!.slice(0, -2);
        if (mode === "invalid") result.output = "not JSON";
        if (mode === "multiple") result.output += "\n{}";
        if (["wrong-root", "wrong-common", "wrong-version", "producer-failure"].includes(mode)) {
          const value = JSON.parse(result.output!);
          if (mode === "wrong-root") value.root = "/other";
          if (mode === "wrong-common") value.commonDir = "/other/.git";
          if (mode === "wrong-version") value.version = 2;
          if (mode === "producer-failure") { value.ok = false; value.reason = "observed failure"; value.nextStep = "Inspect actual cwd"; }
          result.output = JSON.stringify(value);
        }
        if (mode === "running" || mode === "rejected") result.state = mode;
        if (mode === "stopped") result.stopped = true;
        if (mode === "cancelled") result.results![0]!.processSignal = "SIGTERM";
        if (mode === "wrong-agent") result.agent = "pitako.worker";
        if (mode === "no-run") delete result.runId;
        if (mode === "no-directory") delete result.asyncDir;
        if (mode === "no-stdout" || mode === "no-stderr") {
          const artifacts = result.externalAdapter?.outputArtifacts;
          if (!artifacts) throw Error("Valid observer fixture must supply output artifacts");
          delete artifacts[mode === "no-stdout" ? "stdoutPath" : "stderrPath"];
        }
        if (mode === "save-error") result.results![0]!.outputSaveError = "disk full";
        if (mode === "metadata-error") result.metadataSaveError = "disk full";
        if (mode === "transcript-error") result.results![0]!.transcriptError = "disk full";
        if (mode === "partial") result.results![0]!.outputPartial = true;
        if (mode === "no-result") result.results = [];
        // Intentionally malformed native payload at the controlled boundary.
        if (mode === "no-exit") Reflect.deleteProperty(result.results![0]!, "exitCode");
        if (mode === "failed-exit") result.results![0]!.exitCode = 1;
        if (mode === "partial-terminal") result.terminalOutcome = { state: "partial", reason: "timeout" };
        return result;
      });
      expect((await host.execute()).status).not.toBe("complete");
      expect(host.history()[0].closing).toBeUndefined();
      expect(host.history()[0].outcome).toBeUndefined();
      const calls = host.calls.length;
      expect((await host.execute()).status).not.toBe("complete");
      const barriers = ["running", "rejected", "stopped"];
      expect(host.calls).toHaveLength(calls + (barriers.includes(mode) ? 0 : 2));
      expect(host.current().loop.outcome).toBeUndefined();
      expect(host.records()).toHaveLength(0);
    });

  test("pre-dispatch native rejection preserves only the actual key and cause", async () => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.checkout-observer") throw Error("Active async run capacity exhausted: 2/2 used.");
      return normal();
    });
    const output = await host.execute();
    expect(output.status).toBe("partial"); expect(output.reason).toContain("2/2 used");
    expect(host.history()[0].observation).toMatchObject({ stage: "intention", failure: { reason: "Active async run capacity exhausted: 2/2 used." } });
    expect(host.history()[0].observation.ref).toBeUndefined();
    expect(host.history()[0].closing).toBeUndefined();
  });
});
