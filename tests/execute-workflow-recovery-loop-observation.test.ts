import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readReviewOriginal, readBacklog } from "../skills/execute/loop.ts";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { executeStore } from "../skills/execute/ledger.mjs";
import { applyCheckpoint, restoreCheckpoint, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { readExecuteIntentContext } from "../extensions/execute-intent.ts";
import { EXECUTE_STATE_VERSION } from "../extensions/execute-state.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { validateWorkflowScript } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { MISSION_STATE_MAX_BYTES } from "../node_modules/pi-subagents/src/missions/workflow-state.js";
import { digest, MAX_SPEC_BYTES } from "../extensions/spec-plans.ts";
import { executeControllerFixture, executeField, source, copy, gaps, closedInterruptedProducer, cutAt, config, candidate, expectImpediment, publicationWitness, type Result } from "./fixtures/execute-workflow.ts";
import { childResponse, realCheckoutCompositionFixture } from "./fixtures/plan-execute-composition.ts";
import { expectProcessBudget } from "./fixtures/process-budget.ts";
import { pitakoAgentFamily } from "../skills/agent-names.mjs";

const recoveryComposition = realCheckoutCompositionFixture();
const { fixture } = executeControllerFixture(recoveryComposition.fake);
const recoveryScripts = recoveryComposition.scripts;

function atCursor(host: ReturnType<typeof fixture>, cursor = host.current()) {
  const { store, scope } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
  return store.read(scope, cursor.head);
}

function storedRows(host: ReturnType<typeof fixture>, cursor = host.current()) {
  const { store, scope } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
  return [...store.readRecords(scope, cursor.head).records];
}

function storeTipRows(host: ReturnType<typeof fixture>) {
  const { invocation, epoch } = host.current();
  const { store, scope } = executeStore(host.root, invocation, false, epoch);
  return [...store.readRecords(scope).records];
}

function cutAfterOriginal(host: ReturnType<typeof fixture>, childKey: string) {
  host.setFailSave(() => host.native.has(childKey));
}

async function cutBeforeSelection(host: ReturnType<typeof fixture>) {
  const key = "invoke-human-1.l1.director";
  host.setSaveObserver(value => {
    if (value.action.key === key && value.action.runId) throw Error("Cut before selection");
  });
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  host.setSaveObserver(undefined);
  const cursor = copy(host.current()), producer = copy(host.native.get(key)!);
  expect(cursor.action).toMatchObject({ kind: "launched", key, runId: producer.runId });
  expect(atCursor(host).P.control.operation).toMatchObject({ operation: "advance", loop: 1 });
  return { cursor, producer, rows: storedRows(host), launches: copy(host.launches) };
}

function lastConfirmed(host: ReturnType<typeof fixture>) {
  return [...host.records()].reverse().find((record: { kind: string }) => record.kind === "unit")?.body.checkpoint ?? null;
}

function restoreRecordedAttempt(host: ReturnType<typeof fixture>, key: string, producer?: string) {
  const rows = storedRows(host);
  const baseline = [...rows].reverse().find(row => row.kind === "operation" &&
    (row.body as { operation?: string; request?: { intent?: CheckpointIntent } }).operation === "baseline" &&
    (row.body as { request: { intent: CheckpointIntent } }).request.intent.key === key);
  const { restore } = (baseline!.body as { request: { continuation: { attempt: {
    restore: { sourceKeys: string[]; authority: Parameters<typeof restoreCheckpoint>[1]; producer: { key: string } };
  } } } }).request.continuation.attempt;
  if (producer) expect(restore.producer.key).toBe(producer);
  const sources = restore.sourceKeys.map(source => {
    const row = [...rows].reverse().find(row => row.kind === "intent" && (row.body as CheckpointIntent).key === source);
    if (!row) throw new Error(`Missing admitted restoration source: ${source}`);
    return row.body as CheckpointIntent;
  });
  return restoreCheckpoint(sources, restore.authority);
}

function expectOpenHalt(host: ReturnType<typeof fixture>, output: Awaited<ReturnType<typeof host.execute>>,
  stage = output.loopReport.halt.code) {
  const halt = output.loopReport.halt;
  expect(halt).not.toBeNull();
  expect(host.current().halt, output.reason).toEqual({ stage, digest: canonicalDigest(halt),
    ...(["capacity", "native-dispatch", "permission"].includes(stage) && !halt.ref.runId ? { reason: halt.reason } : {}) });
  expect(host.history().some((loop: { number: number }) => loop.number === host.current().loop.number)).toBe(false);
  expect(atCursor(host).head).toEqual(host.current().head);
  return halt;
}

function closingReview(host: ReturnType<typeof fixture>) {
  const closed = [...host.history()].reverse().find((loop: { kind: string }) => loop.kind === "final");
  const seed = storedRows(host).reverse().find(row => row.kind === "review-originals" &&
    (row.body as { archiveSeed?: unknown }).archiveSeed);
  const { originals } = seed!.body as {
    originals: { key: string; runId: string; path: string; sha256: string; body: unknown }[];
  };
  return { closed, originals };
}

describe("workflow-owned execute controller", () => {
  test("terminal reentry cannot admit a second completion, seal or dependent dispatch", async () => {
    const host = fixture(); host.setLimit(1);
    expect((await host.execute()).status).toBe("partial");
    const retained = copy(host.current()), rows = storedRows(host), count = host.launches.length;
    expect(retained.action.kind).toBe("terminal");
    const outcome = await host.execute();
    expect(outcome).toMatchObject({ status: "partial", loopsConsumed: 1, maxLoops: 1 });
    expect(host.launches).toHaveLength(count);
    expect(host.current()).toEqual(retained);
    expect(storeTipRows(host)).toEqual(rows);
    expect(host.records()).toHaveLength(3);
  });

  test("repeated worker handoffs cannot bypass measured stall detection", async () => {
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
    const task = readBacklog(host.root, "spec").backlog!.tasks.find(task => task.id === "change1")!;
    expect(task.progress.nonImproving).toBe(3);
    expect(host.history().at(-1).results.at(-1).diagnosis).toContain("Three consecutive non-improving");
    expect(task.status).not.toBe("done");
  });

  test.each(["gaps", "continue"])("a closed loop's %s pause cannot block the next loop's checkpoint recovery", async status => {
    const host = fixture(undefined, { realCheckout: true }); host.setLimit(2);
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.checkpoint-sealer" ||
          pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "taskDelta")
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
        const restored = restoreRecordedAttempt(host, request.key);
        const restoredRef = restored.partialRef.replace(/restore\.json$/, "restored.json");
        const value = host.worker(request);
        return host.result(request, { ...value, restoreReceipt: { ...restored, restoredRef } });
      }
      return normal();
    });
    const output = await host.execute();
    expect(output.status, output.reason).toBe("partial");
    expect(host.calls.filter(call => call.key === "invoke-human-1.l2.t1.a2")).toHaveLength(1);
    expect(lastConfirmed(host)).toMatchObject({ kind: "unit", taskId: "change1", position: { loop: 2, cursor: 1 } });
    // Measured 194 including IPC Git and one shared runtime, plus twenty.
    expectProcessBudget([host.processes(), recoveryComposition.processes()], 214);
  });

  test.each(["published", "unpublished"])("an unsealed continuation keeps an earlier loop's unit as recovery provenance for a %s lost writer", async capture => {
    const host = fixture(undefined, { realCheckout: true, taskCount: 2 }); host.setLimit(2);
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.checkpoint-sealer" ||
          pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "taskDelta")
        return recoveryScripts.runDeterministic(request.key, request,
          { ...recoveryScripts, root: host.root, inlineSealer: true }, undefined);
      // Write-free continuation: no capture, so its close observes and seals nothing.
      if (request.key === "invoke-human-1.l2.t1.a1")
        return host.result(request, { status: "continue", work: "Investigated the pending branch",
          remaining: ["Same pending defect"], knowledge: { findings: [], handoff: "Branch located" },
          diagnosis: "Still pending", continuation: { mode: "fresh", reason: "Fix the located branch" }, usefulProgress: true });
      if (request.key === "invoke-human-1.l2.t1.a2") {
        expect(lastConfirmed(host)).toMatchObject({ kind: "unit", taskId: "change1", position: { loop: 1, cursor: 1 } });
        const ref = host.current().loop.attempt.intent;
        const intent = storedRows(host).find(row => row.seq === ref.seq && row.digest === ref.digest);
        expect(intent).toMatchObject({ kind: "intent", body: { key: request.key, progress: {
          admitted: { change2: ["continue"] }, previous: { taskId: "change1", attempt: 1, digest: lastConfirmed(host).digest },
        } } });
        if (capture === "published") host.worker(request);
        return { ok: false, output: "", error: "Writer disappeared" };
      }
      if (request.key === "invoke-human-1.l2.t1.a3") {
        const restored = restoreRecordedAttempt(host, request.key);
        const restoredRef = restored.partialRef.replace(/restore\.json$/, "restored.json");
        return host.result(request, { ...host.worker(request), restoreReceipt: { ...restored, restoredRef } });
      }
      return normal();
    });
    const output = await host.execute();
    expect(host.current().halt).toBeNull();
    expect(output.status, output.reason).toBe("partial");
    expect(host.calls.filter(call => call.key === "invoke-human-1.l2.t1.a3")).toHaveLength(1);
    expect(host.history().at(-1).results).toContainEqual(expect.objectContaining({ taskId: "change2", attempt: 3, status: "complete" }));
    expect(lastConfirmed(host)).toMatchObject({ kind: "unit", taskId: "change2", position: { loop: 2, cursor: 1 } });
  });

  test.each(["spawn", "nonzero", "stdout", "published-crash", "state-save"])(
    "final drain reconciles transient %s without a duplicate admission", async failure => {
      const host = fixture(); host.setLimit(1);
      const drainKey = "invoke-human-1.l1.finishDrain";
      let injected = false;
      let committed: ReturnType<typeof storedRows> | undefined;
      let retained: ReturnType<typeof host.current>;
      host.setLaunchRespond(async (request, normal) => {
        if (pitakoAgentFamily(request.agent) !== "loop-io" || JSON.parse(request.task).operation !== "drain" || injected) return normal();
        if (failure === "state-save") return normal();
        injected = true;
        retained = copy(host.current());
        if (failure === "spawn") throw Error("Transient spawn failure");
        const result = await normal();
        committed = storeTipRows(host);
        if (failure === "published-crash") throw Error("Drain disappeared after COMMIT");
        return failure === "stdout" ? { ...result, output: "{" } :
          { ...result, ok: false, results: result.results?.map(entry => ({ ...entry, exitCode: 1 })), output: "" };
      });
      if (failure === "state-save") host.setFailSave(value => {
        if (injected || value.action.kind !== "terminal") return false;
        injected = true;
        return true;
      });
      const outcome = await host.execute();
      expect(injected).toBe(true);
      expect(outcome.status, outcome.reason).toBe("partial");
      if (failure !== "state-save") {
        expect(retained.action).toMatchObject({ kind: "launched", role: "reviewer", key: "invoke-human-1.l1.t1.a1.task-synthesis" });
        expect(storedRows(host, retained).some(row => row.kind === "ledger")).toBe(false);
      }
      if (!["state-save", "spawn"].includes(failure)) expect(committed).toBeDefined();
      expect(host.current()).toMatchObject({ version: EXECUTE_STATE_VERSION, budget: { consumedLoops: 1, maxCycles: 1 },
        action: { kind: "terminal" }, loop: { cursor: 1 } });
      expect(executeField(atCursor(host).P.control, "ledger", "count")).toBe(3);
      if (committed) expect(storedRows(host).slice(0, committed.length)).toEqual(committed);
      expect(host.calls.filter(call => call.agent === "pitako.execution-ledger").map(call => call.key))
        .toEqual(["invoke-human-1.l1.seal1", "invoke-human-1.l1.gaps"]);
      const drains = host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).operation === "drain");
      expect(drains.map(call => call.key)).toEqual(failure === "state-save" ? [drainKey] : [drainKey, `${drainKey}.r1`]);
      expect(new Set(drains.map(call => call.task)).size).toBe(1);
      expect(host.emits.some(item => item.type === "execution-progress" && ["blocked", "cancelled"].includes(item.status))).toBe(false);
      expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "unit", "loop"]);
      expect(host.current()).not.toHaveProperty("snapshot");
      expect(host.calls.find(call => call.agent === "pitako.worker")!.task).toContain("DIRECT PREREQUISITE COMPLETED RESULTS (historical references, not current check evidence):\n[]");
    });

  test("exhausted final drain attempts retain the input for identical reentry", async () => {
    const host = fixture(); host.setLimit(1);
    host.setLaunchRespond((request, normal) => {
      if (pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "drain") throw Error("Filesystem temporarily unavailable");
      return normal();
    });
    const outcome = await host.execute();
    expect(outcome.status).toBe("partial");
    expect(outcome.reason).toContain("Filesystem temporarily unavailable");
    const pending = copy(host.current());
    expect(pending).toMatchObject({ loop: { cursor: 0, taskId: "change1" },
      action: { kind: "launched", role: "reviewer", key: "invoke-human-1.l1.t1.a1.task-synthesis" } });
    expect(host.records()).toEqual([]);
    const drains = () => host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).operation === "drain");
    expect(drains()).toHaveLength(3);
    const models = host.calls.filter(call => ["pitako.worker", "pitako.execution-director"].includes(call.agent!));
    host.setLaunchRespond();
    expect((await host.execute()).status).toBe("partial");
    expect(drains()).toHaveLength(4);
    expect(drains().at(-1)?.task).toBe(drains()[0]?.task);
    expect(storedRows(host).find(row => row.opKey === `final-drain:${drains()[0]!.key}`)?.body)
      .toMatchObject({ request: { expectedHead: pending.head } });
    expect(host.calls.filter(call => ["pitako.worker", "pitako.execution-director"].includes(call.agent!))).toEqual(models);
    expect(host.calls.filter(call => call.agent === "pitako.execution-ledger" && call.key.includes(".seal")).at(-1)?.key)
      .toBe("invoke-human-1.l1.seal1");
    expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "unit", "loop"]);
  });

  test.each(["integrity", "stopped", "capacity"])("final drain does not retry %s evidence as a transport failure", async cause => {
    const host = fixture(); host.setLimit(1);
    host.setLaunchRespond((request, normal) => pitakoAgentFamily(request.agent) !== "loop-io" || JSON.parse(request.task).operation !== "drain" ? normal() : ({
      key: request.key, agent: request.agent, runId: `native-${request.key}`, ok: false,
      // The exact loop-io CLI failure line for a real hash-ledger head mismatch.
      output: cause === "integrity" ? JSON.stringify({ error: "loop-io", reason: "Ledger head mismatch.", selectionRejected: false,
        replayRejected: false, viewOverflow: false, ledgerIntegrity: true }) : "",
      ...(cause === "stopped" ? { stopped: true } : {}),
      ...(cause === "capacity" ? { error: "Active async run capacity exhausted: 1/1 used." } : {}),
    }));
    const outcome = await host.execute();
    expect(outcome.status).not.toBe("complete");
    expect(outcome.reason).toContain(cause === "integrity" ? "Execute ledger integrity failure: Ledger head mismatch."
      : cause === "stopped" ? "stopped" : "capacity exhausted");
    expect(host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).operation === "drain")).toHaveLength(1);
    if (cause === "stopped") {
      expectOpenHalt(host, outcome);
      expect(host.current()).toMatchObject({ loop: { cursor: 1, taskId: "change1" },
        action: { kind: "pending", op: "drain", opKey: "invoke-human-1.l1.finishDrain" } });
    } else {
      expect(host.current()).toMatchObject({ loop: { cursor: 0, taskId: "change1" },
        action: { kind: "launched", role: "reviewer", key: "invoke-human-1.l1.t1.a1.task-synthesis" } });
    }
    expect(host.records()).toEqual([]);
    expect(executeField(atCursor(host).P.control, "ledger")).toMatchObject({ count: 0, head: null });
  });

  test.each(["unit", "pause"])(
    "a stopped %s drain is terminal without another archiver dispatch", async kind => {
    const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
    const drainKey = "invoke-human-1.l1.finishDrain";
    host.setLaunchRespond((request, normal) => pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "drain"
      ? { key: request.key, runId: `native-${request.key}`, agent: request.agent, ok: false, stopped: true, output: "",
        results: [{ exitCode: -1, processSignal: "SIGTERM" }] } : normal());
    host.setRespond((request, normal) => {
      if (kind === "pause" && request.key.endsWith(".t1.a1")) return host.result(request, {
        ...host.worker(request, "pause"), status: "blocked", remaining: ["Finish saved task"], diagnosis: "Saved partial work",
      });
      return normal();
    });
    const stopped = await host.execute();
    expect(stopped.status).toBe("cancelled");
    const retained = copy(host.current()), count = host.launches.length, effects = host.calls.length;
    expect(stopped.reason).not.toContain("Essential persistence failed");
    const halt = stopped.loopReport.halt;
    expect(retained.halt).toEqual({ stage: "native-barrier", digest: canonicalDigest(halt) });
    expect(halt.ref).toMatchObject({ agent: "pitako.loop-io", key: drainKey });
    expect(retained.action).toMatchObject({ kind: "pending", op: "drain", opKey: drainKey });
    expect(retained.inFlight).toContainEqual({ key: drainKey, runId: halt.ref.runId, role: "loop-io" });
    const original = JSON.parse(host.launches.find(call => call.key === drainKey)!.task);
    expect(retained.action.drainDigest).toBe(canonicalDigest(original));
    expect(host.records()).toEqual([]);
    host.setLaunchRespond();
    host.setRespond((request, normal) => {
      if (kind !== "pause" || !request.key.endsWith(".t1.a2")) return normal();
      restoreRecordedAttempt(host, request.key, "invoke-human-1.l1.t1.a1");
      return normal();
    });
    expect((await host.execute()).status).toBe("cancelled");
    expect(host.launches).toHaveLength(count);
    expect(host.current()).toEqual(retained);
    host.setStatus(ref => {
      const observed = host.native.get(ref);
      return ref === halt.ref.runId && observed ? { ...observed, stopped: false, ok: true, state: "complete" }
        : observed ?? { ok: true, state: "unknown" };
    });
    expect((await host.execute()).reason).toContain("integrity");
    expect(host.launches).toHaveLength(count);
    expect(host.current()).toEqual(retained);
    expect(host.calls).toHaveLength(effects);
  });

  test.each(["named", "legacy"])("a post-publication persistence cut preserves %s task review archive bytes", async mode => {
    const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
    if (mode === "legacy") host.setLaunchRespond((request, normal) => {
      if (/\.task-(reviewer|synthesis)$/.test(request.key)) request.agent = "pitako.reviewer";
      return normal();
    });
    host.setFailSave(value => value.action.kind === "terminal");
    const outcome = await host.execute();
    expect(outcome.status).toBe("partial");
    expect(outcome.reason).toContain("Essential persistence failed");
    const committed = storeTipRows(host);
    const rows = storedRows(host);
    expect(committed.length).toBeGreaterThan(rows.length);
    expect(host.current()).toMatchObject({ action: { kind: "launched", role: "reviewer", key: "invoke-human-1.l1.t1.a1.task-synthesis" },
      loop: { cursor: 0, taskId: "change1", outcome: null } });
    const unit = committed.flatMap(row => row.kind === "ledger"
      ? (row.body as { entries: ReturnType<typeof host.records> }).entries : []).find(entry => entry.kind === "unit");
    expect(unit).toBeDefined();
    const archive = committed.flatMap(row => row.kind === "ledger"
      ? (row.body as { entries: ReturnType<typeof host.records> }).entries : []).find(entry => entry.kind === "loop");
    expect(archive?.body.analysisCalls).toEqual(["reviewer", "synthesis"].map(stage => {
      const key = `invoke-human-1.l1.t1.a1.task-${stage}`;
      const agent = mode === "legacy" ? "pitako.reviewer" : stage === "reviewer" ? "pitako.task-review" : "pitako.task-synthesis";
      return { key, stage: "receipt", ref: { key, agent, runId: host.native.get(key)!.runId } };
    }));
    host.setFailSave();
    expect((await host.execute()).status).toBe("partial");
    expect(storedRows(host).slice(0, committed.length)).toEqual(committed);
    expect(storedRows(host).filter(row => row.kind === "ledger")).toEqual(committed.filter(row => row.kind === "ledger"));
    expect(host.records()[1]).toEqual(unit);
    expect(host.records().at(-1)).toEqual(archive);
    expect(host.calls.filter(call => call.key.endsWith(".t1.a1"))).toHaveLength(1);
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
    const loop = host.history()[0];
    expect(loop.results.at(-1)).toMatchObject({ taskId: "change1", attempt: 2, status: "complete" });
    expect(loop.cursor).toBe(1);
    expect(host.current().halt).toBeNull();
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
    expect(host.history()[0]).toMatchObject({ outcome: "gaps", cursor: 0 });
    expect(host.current().halt).toBeNull();
    expect(lastConfirmed(host)).toMatchObject({ kind: "pause" });
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
    expect(outcome.loopReport.halt).toMatchObject({
      code: "native-barrier", cause: cause === "stopped" ? "stopped" : "native permission denial",
    });
    expectOpenHalt(host, outcome, "native-settlement");
    expect(outcome.loopsConsumed).toBe(1);
    expect(outcome.loopReport.work).toMatchObject([{ taskId: "change1", attempt: 1, status: "continue" }]);
    expect(JSON.parse(host.native.get("invoke-human-1.l1.t1.a1.seal")!.output!))
      .toMatchObject({ kind: "pause", outcome: "sealed", position: { loop: 1, cursor: 0 } });
    expect(host.records().filter((record: { kind: string; body: { result?: unknown } }) =>
      record.kind === "unit" && record.body.result != null)
      .map((record: { body: { result?: unknown } }) => record.body.result))
      .not.toContainEqual(expect.objectContaining({ status: "complete" }));
    expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
  });

  // Hold the observer input fixed to test durable dispatch policy; the registered
  // Node loss-reentry case covers real inspection, journaled bytes and tool loading.
  test("a committed worker block holds without renewing its writer", async () => {
    const status = "blocked";
    const host = fixture("FULL SPECS", { taskCount: 2 }); host.setLimit(2);
    host.setHostResponse((key, value) => {
      const loop = host.current()?.loop, attempt = loop?.attempt;
      return !key.startsWith("inspect-") || !attempt ? value : { ...value, checkpointObservation: {
        key: `invoke-human-1.l${loop.number}.t${loop.cursor + 1}.a${attempt.number}`,
        taskId: loop.taskId, attempt: attempt.number, loop: loop.number, cursor: loop.cursor,
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
    const paused = copy(host.current()), point = lastConfirmed(host);
    const completed = copy(host.history()[0].results);
    const pause = [...host.records()].reverse().find((record: { kind: string }) => record.kind === "unit")!.body.result;
    expect(completed).toMatchObject([{ taskId: "change1", status: "complete" }]);
    expect(point).toMatchObject({ kind: "pause", taskId: "change2", position: { cursor: 0 } });
    expect(pause).toMatchObject({ taskId: "change2", status, attempt: 1 });
    expect(paused.loop).toMatchObject({ number: 2, taskId: "change2", cursor: 0, attempt: { number: 1, stage: "result" } });
    const yieldedCalls = host.calls.length, pausedRows = storedRows(host);
    expect((await host.execute()).status).toBe("blocked");
    expect(host.calls).toHaveLength(yieldedCalls);
    expect(storedRows(host)).toEqual(pausedRows);

    expect(lastConfirmed(host)).toEqual(point);
    expect(host.history()[0].results).toEqual(completed);
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
    expect(readBacklog(host.root, "spec").backlog!.tasks.find(task => task.id === "change1")!.status).not.toBe("done");
    expect(lastConfirmed(host)).toBeNull();
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
      const ref = prior.action;
      expect(ref).toMatchObject({ kind: "launched", role: "reviewer",
        key: "invoke-human-1.l2.review.director-prepare" });
      const original = host.native.get(ref.runId)!.structuredOutput;
      expect(prior.review.slots).toContainEqual({ key: ref.key, runId: ref.runId,
        phase: "prepare", digest: canonicalDigest(original) });
      const rows = storedRows(host);
      host.setHostResponse((key, value) => key === "inspect-initial" ? {
        ...value, retainedAnalyses: [{ key: ref.key, runId: ref.runId, ok: true,
          ...(mode === "native-complete" ? { state: "complete" } : {}),
          structuredOutput: copy(original) }],
      } : value);
      host.setStatus(runId => ({ ok: true, runId, results: [], output: mode.includes("complete") && mode !== "native-complete" ?
        `${mode === "wrapped-complete" ? `Status target: run ${runId}\nSpawn budget: 1/10\nActive async capacity: 0/5\n` : ""}Run: ${runId}\nState: complete` :
        "Preview only; no settlement receipt" }));
      const result = await host.executeNative();
      expect(result.status).toBe("blocked");
      expect(result.reason).toContain(mode === "unknown" ? "Read-only producer settlement uncertain" : "Prior");
      expect(host.calls).toHaveLength(calls);
      expect(host.current()).toEqual(prior);
      expect(storeTipRows(host)).toEqual(rows);
      if (mode !== "unknown") expect(canonicalDigest(result.loopReport.halt)).toBe(prior.halt.digest);
    });

  test("compliance reentry preserves original references with metadata-only management delivery", async () => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".compliance")) result.structuredOutput.status = "blocked";
      return result;
    });
    const output = await host.executeNative();
    expect(output.status).toBe("blocked");
    const prior = copy(host.current()), calls = host.calls.length;
    const rows = storedRows(host);
    const ref = prior.action;
    expect(ref).toMatchObject({ kind: "launched", role: "reviewer", key: "invoke-human-1.l2.compliance" });
    const originals = [...rows].reverse().find(row => row.kind === "review-originals")!.body as {
      originals: { key: string; runId: string; path: string; sha256: string; body: unknown }[];
    };
    expect(originals.originals.map(({ key, runId }) => ({ key, runId }))).toEqual(
      prior.review.slots.map(({ key, runId }: { key: string; runId: string }) => ({ key, runId })));
    for (const original of originals.originals) {
      expect(original.body).toEqual(readReviewOriginal(original));
      expect(original.body).toEqual(host.native.get(original.runId)!.structuredOutput);
    }
    host.setHostResponse((key, value) => key === "inspect-initial" ? {
      ...value, retainedAnalyses: [{ key: ref.key, runId: ref.runId, ok: true,
        structuredOutput: copy(host.native.get(ref.runId)!.structuredOutput) }],
    } : value);
    host.setStatus(ref => ({ ok: true, runId: ref, output: `Run: ${ref}\nState: complete`, results: [] }));
    const replay = await host.executeNative();
    expect(replay.status).toBe("blocked");
    expect(replay.reason).toBe(output.reason);
    expect(replay.loopReport.halt).toEqual(output.loopReport.halt);
    expect(replay.loopReport.pending[0].references).toContainEqual({ key: ref.key, runId: ref.runId });
    expect(host.calls).toHaveLength(calls);
    expect(host.current()).toEqual(prior);
    expect(storeTipRows(host)).toEqual(rows);
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
      const ref = prior.action;
      const rows = storedRows(host);
      expect(ref).toMatchObject({ kind: "launched", role: "reviewer",
        key: "invoke-human-1.l2.review.director-prepare" });
      expect(host.native.get(ref.runId)!.structuredOutput.status).toBe("blocked");
      host.setHostResponse((key, value) => key === "inspect-initial" ? {
        ...value, retainedAnalyses: [{ key: ref.key, runId: ref.runId, ok: false,
          ...(mode === "conflict" ? { error: "Conflicting complete retained analysis originals." } :
            mode === "escape" ? { error: "Structured original escapes its retained native producer." } :
              { state: mode === "stopped" ? "stopped" : "pending" }) }],
      } : value);
      const result = await host.executeNative();
      expect(result.status).toBe(mode === "stopped" ? "cancelled" : "blocked");
      expect(host.calls).toHaveLength(calls);
      expect(host.current()).toEqual(prior);
      expect(storeTipRows(host)).toEqual(rows);
      expect(result.reason).toContain(mode === "conflict" ? "Conflicting complete" :
        mode === "escape" ? "escapes its retained" : `Positive native barrier: ${mode}`);
    });

  test.each(["stopped", "permission", "unavailable"])("current %s after a historical semantic block still prevents continuation", async mode => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith("director-prepare"))
        Object.assign(result.structuredOutput, { status: "blocked", reason: "Prior semantic impediment" });
      return result;
    });
    const output = await host.executeNative();
    expect(output.status).toBe("blocked");
    expect(expectOpenHalt(host, output).code).toBe("semantic-block");
    const prior = copy(host.current()), calls = host.calls.length;
    const rows = storedRows(host);
    const ref = prior.action;
    expect(ref).toMatchObject({ kind: "launched", role: "reviewer",
      key: "invoke-human-1.l2.review.director-prepare" });
    host.setStatus(ref => {
      if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      if (mode === "unavailable") return { ok: true, output: "A preview is not the complete result", results: [] };
      return { ok: true, output: `Run: ${ref}\nState: stopped`, results: [] };
    });
    const result = await host.executeNative();
    expect(result).toMatchObject({ status: mode === "stopped" ? "cancelled" : "blocked", loopsConsumed: 2 });
    // The current missing original is a recovery impediment, not the earlier
    // semantic verdict. It must not erase that verdict's producer references.
    expect(result.reason).toContain(mode === "unavailable" ? "Complete retained analysis unavailable" :
      `Positive native barrier: ${mode === "permission" ? "native permission denial" : "stopped"}`);
    expect(host.calls).toHaveLength(calls);
    expect(host.current()).toEqual(prior);
    expect(storeTipRows(host)).toEqual(rows);
    expect((await host.executeNative()).status).toBe(result.status);
    expect(host.calls).toHaveLength(calls);
  });


  // Reject a replacement inspector after its result returned but admission save
  // failed. Management previews alone must not hide its exact retained original.
  test.each(["complete", "pending", "unknown-settlement", "conflict", "wrong-run", "missing", "current-stop", "current-permission", "current-run-conflict", "source-binding-mismatch"] as const)(
    "pending recovery receipt reconciles its retained original: %s", async mode => {
      const host = fixture(); host.setLimit(1);
      const director = "invoke-human-1.l1.director";
      const responses = (subject: typeof host) => subject.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.execution-inspector") return subject.result(request, {
          status: "recovered", reason: "Exact associated original retained", original: subject.plan(), workerResult: null,
          originalAvailable: true, binding: "absent", comparison: "only-original", provenance: ["/native/original.json"],
        });
        if (request.key === director) {
          rmSync(result.results![0]!.savedOutputPath!);
          return { ...result, structuredOutput: undefined };
        }
        return result;
      });
      responses(host);
      const inspectorKey = "invoke-human-1.l1.recover1";
      let savedReceipt = false;
      cutAt(host, value => {
        if (value.action?.key !== inspectorKey || !value.action.runId) return false;
        if (savedReceipt) return true;
        savedReceipt = true;
        return false;
      });
      const cut = await host.executeNative();
      expect(cut.status, cut.reason).toBe("partial");
      expect(cut.reason).toContain("Essential persistence failed");
      host.setFailSave();
      const cursor = copy(host.current()), calls = host.calls.length, launchCount = host.launches.length, rows = storedRows(host);
      const receipt = copy(host.native.get(inspectorKey)!);
      const runId = receipt.runId!;
      expect(cursor.action).toMatchObject({ kind: "launched", role: "execution-inspector", key: inspectorKey, runId });
      expect(cursor.inFlight).toContainEqual({ key: director, runId: host.native.get(director)!.runId, role: "execution-director" });
      expect(cursor.loop).toMatchObject({ number: 1, phase: "director", attempt: null });
      expect(cursor.halt).toBeNull();
      expect(executeField(atCursor(host).P.control, "ledger")).toEqual({ count: 0, head: null });
      expect(cursor.budget).toMatchObject({ consumedLoops: 1, maxCycles: 1 });
      const originalPath = receipt.results![0]!.savedOutputPath!;
      expect(JSON.parse(readFileSync(originalPath, "utf8"))).toEqual(receipt.structuredOutput);
      let retainedOriginal;
      host.setStatus(ref => ({ key: ref, runId: ref === runId && mode === "current-run-conflict" ? "other-producer" : ref, ok: true,
        ...(ref === runId && mode === "current-stop" ? { stopped: true } : {}),
        ...(ref === runId && mode === "current-permission" ? { error: "Blocked by pi-subagents permission rule: 'run' is denied." } : {}),
        output: mode === "unknown-settlement" && ref === runId ? "No current settlement inventory" : `Run: ${ref}\nState: complete`,
        results: [] }));
      host.setHostResponse((key, value) => {
        if (key !== "inspect-initial") return value;
        const original = value.retainedAnalyses.find((item: { key: string }) => item.key === inspectorKey);
        retainedOriginal = original;
        if (mode === "complete" || mode === "source-binding-mismatch") return value;
        const changed = { ...original };
        if (mode === "wrong-run") changed.runId = "other-producer";
        if (mode === "pending") changed.state = "running";
        if (mode === "unknown-settlement") delete changed.state;
        if (mode === "conflict") Object.assign(changed, {
          ok: false, error: "Conflicting complete retained analysis originals.",
        });
        return { ...value, retainedAnalyses: mode === "missing" ? [] : [changed] };
      });
      if (mode === "source-binding-mismatch") {
        const statusDir = path.join(host.root, ".pi/native-review", runId);
        const { parentWorkflowRunId } = JSON.parse(readFileSync(path.join(statusDir, "status.json"), "utf8"));
        const journal = path.join(path.dirname(statusDir), parentWorkflowRunId, "workflow-children.jsonl");
        const original = readFileSync(journal, "utf8");
        const changed = original.split("\n").map(line => {
          if (!line) return line;
          const entry = JSON.parse(line);
          if (entry.key === inspectorKey) entry.result.results[0].task = entry.result.results[0].task.replace(
            /(Selection source \(data\): )([^\n]+)/, (_match: string, prefix: string, data: string) => {
              const binding = JSON.parse(data);
              binding.director.digest = "0".repeat(64);
              return prefix + JSON.stringify(binding);
            });
          return JSON.stringify(entry);
        }).join("\n");
        expect(changed).not.toBe(original);
        writeFileSync(journal, changed);
      }
      const result = await host.executeNative();
      expect(retainedOriginal).toMatchObject({ key: inspectorKey, runId, ok: true, structuredOutput: receipt.structuredOutput });
      expect(result.status, result.reason).toBe(mode === "complete" ? "partial" : mode === "current-stop" ? "cancelled" : "blocked");
      expect(host.statusCalls).toContain(runId);
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
      expect(host.calls.slice(calls).filter(call => call.key.endsWith(".director"))).toHaveLength(0);
      expect(host.current().budget).toMatchObject({ consumedLoops: 1, maxCycles: 1 });
      if (mode !== "complete") {
        expect(host.launches.slice(launchCount).map(call => call.key)).toEqual(
          mode === "source-binding-mismatch" ? ["invoke-human-1.l1.selectionIO.r1"] : []);
        if (mode !== "source-binding-mismatch") expect(host.calls).toHaveLength(calls);
        expect(host.current()).toEqual(cursor);
        expect(storeTipRows(host)).toEqual(rows);
        expect(host.history()).toHaveLength(0);
        const diagnostic = {
          pending: "Positive native barrier: running",
          "unknown-settlement": "Read-only producer settlement uncertain",
          conflict: "Conflicting complete retained analysis originals",
          "wrong-run": "Exact retained recovery original is unavailable",
          missing: "Exact retained recovery original is unavailable",
          "current-stop": "Positive native barrier: stopped",
          "current-permission": "Positive native barrier: native permission denial",
          "current-run-conflict": "Recovery producer/run identity conflict",
          "source-binding-mismatch": "inspector source binding or digest mismatch",
        }[mode];
        expect(result.reason).toContain(diagnostic);
      } else {
        expect(host.history()).toHaveLength(1);
        const selection = "invoke-human-1.l1.selectionIO";
        const selectionRecord = storedRows(host).find(row => row.opKey === `operation:${selection}`)!;
        const recoveries = (selectionRecord.body as { request: { recoveries: unknown[] } }).request.recoveries;
        expect(recoveries).toContainEqual(expect.objectContaining({
          stage: "observed", disposition: "recovered", ref: expect.objectContaining({ key: inspectorKey, runId }),
        }));
        expect(host.launches.filter(call => call.key.startsWith(selection)).map(call => call.key)).toEqual([`${selection}.r1`]);
        expect(Buffer.byteLength(JSON.stringify({ "pitako-execute": cursor }, null, 2))).toBeLessThanOrEqual(16384);
        expect(host.calls.slice(calls).filter(call => call.agent === "pitako.worker")).toHaveLength(1);
        expect(host.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", status: "complete" }));
        const direct = fixture(); direct.setLimit(1); responses(direct);
        expect((await direct.executeNative()).status).toBe("partial");
        expect(host.launches.map(call => call.key)).toEqual(direct.launches.map(call =>
          call.key === selection ? `${selection}.r1` : call.key));
        function evidence(subject: typeof host, launchKey: string) {
          const output = subject.native.get(launchKey)!.output!;
          expect(Buffer.byteLength(output)).toBeLessThanOrEqual(61440);
          const wire = JSON.parse(output);
          const prefix = atCursor(subject, { ...subject.current(), head: wire.head });
          expect(canonicalDigest(wire.P)).toBe(canonicalDigest(prefix.P));
          const opened = (wire.P.prompt.loopOpen as { number: number; startedAt: number }).startedAt;
          expect(wire.P.prompt.selectedTask.id).toBe("change1");
          const worker = subject.launches.find(call => call.key === "invoke-human-1.l1.t1.a1")!;
          const rows = storedRows(subject, { ...subject.current(), head: wire.head });
          const backlog = wire.projection.steps.find((step: { operation: string }) => step.operation === "apply").result.digest;
          expect(wire.P.preview.manifest.digest).toBe(backlog);
          expect(worker.task).toContain(`admitted backlog digest ${backlog}`);
          expect(wire.P.prompt.admission.admissionBinding).toBe(subject.current().admissionBinding);
          const normalize = (value: string) => rows.reduce((content, row) =>
            content.replaceAll(row.digest, `<record:${row.seq}>`), value.replaceAll(subject.root, "<root>")
              .replaceAll(backlog, "<backlog-digest>")
              .replaceAll(subject.current().admissionBinding, "<admission-binding>")
              .replaceAll(`"startedAt":${wire.P.prompt.admission.startedAt}`, '"startedAt":0')
              .replaceAll(`"startedAt":${opened}`, '"startedAt":0'));
          return { P: normalize(JSON.stringify(wire.P)), prompt: normalize(worker.task) };
        }
        expect(evidence(host, `${selection}.r1`)).toEqual(evidence(direct, selection));
      }
    });

  // An unknown transport cause does not fabricate Stop before admission.
  test.each(["inspect-initial"])(
    "technical failure before the first COMMIT at %s leaves admission available without human input", async target => {
      const host = fixture(); host.setLimit(1);
      host.setHostResponse((key, value) => {
        if (key === target) throw Error(`Host command '${target}' failed: Command stopped because the workflow was aborted.`);
        return value;
      });
      const blocked = await host.execute();
      expect(blocked).toMatchObject({ status: "blocked", phase: "admission", loopsConsumed: 0 });
      expect(blocked.reason).toContain("ambiguous");
      expect(blocked.references).toContainEqual({ key: target });
      expect(host.current()).toBeUndefined();
      expect(host.storage.size).toBe(0);
      expect(host.launches).toEqual([]);
      host.setHostResponse();
      expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 1, maxLoops: 1 });
      expect(host.current()).toMatchObject({ hostHalt: null, action: { kind: "terminal" } });
      expect(host.history()).toHaveLength(1);
      expect(host.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", status: "complete" }));
      expect(storedRows(host).filter(row => row.kind === "root-admission")).toHaveLength(1);
      expect(host.launches.filter(call => call.agent === "pitako.worker").map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1"]);
      const completed = host.launches.length;
      expect(await host.execute()).toMatchObject({ status: "partial" });
      expect(host.launches).toHaveLength(completed);
    });

  test.each(["inspect-initial"])(
    "a committed host failure at %s holds without a fresh inspection or child", async target => {
      const host = fixture(); host.setLimit(1);
      const director = "invoke-human-1.l1.director";
      host.setSaveObserver(value => {
        if (value.action.key === director && value.action.runId)
          throw Error("Cut after director receipt and before selection");
      });
      expect((await host.execute()).reason).toContain("Essential persistence failed");
      host.setSaveObserver(undefined);
      const cursor = copy(host.current()), rows = storedRows(host), count = host.launches.length;
      const producer = host.native.get(director)!;
      expect(cursor.action).toMatchObject({ kind: "launched", key: director, runId: producer.runId });
      expect(atCursor(host).P.control.operation).toMatchObject({ operation: "advance", loop: 1 });
      host.setStatus(ref => ref === producer.runId ? { ...producer, state: "complete" }
        : host.native.get(ref) ?? { ok: false, state: "unknown" });
      host.setHostResponse((key, value) => {
        if (key === target) throw Error("Controlled ambiguous transport failure");
        return value;
      });
      const blocked = await host.execute();
      expect(blocked).toMatchObject({ status: "blocked", phase: "director", loopsConsumed: 1,
        loopReport: { halt: { ref: { key: director, runId: producer.runId } } } });
      expect(blocked.reason).toContain("Controlled ambiguous transport failure");
      const held = copy(host.current());
      expect(held).toEqual({ ...cursor, hostHalt: expect.objectContaining({ digest: expect.any(String) }) });
      expect(storeTipRows(host)).toEqual(rows);
      expect(host.launches).toHaveLength(count);
      host.setHostResponse();
      const inspections = host.hostCalls.length;
      expect(await host.execute()).toEqual(blocked);
      expect(host.current()).toEqual(held);
      expect(storeTipRows(host)).toEqual(rows);
      expect(host.hostCalls).toHaveLength(inspections);
      expect(host.launches).toHaveLength(count);
      host.current().hostHalt.reason = "changed diagnostic";
      expect((await host.execute()).reason).toContain("host halt integrity failure");
      expect(host.hostCalls).toHaveLength(inspections);
      expect(host.launches).toHaveLength(count);
    });

  test("selection replay cannot inspect or replace a pending read-only model recovery", async () => {
    const host = fixture(); host.setLimit(1);
    const inspector = "invoke-human-1.l1.recover1";
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") delete result.structuredOutput;
      return result;
    });
    host.setSaveObserver(value => {
      if (value.action.key === inspector && value.action.runId)
        throw Error("Cut after inspector receipt");
    });
    expect((await host.execute()).reason).toContain("Essential persistence failed");
    host.setSaveObserver(undefined);
    const cursor = copy(host.current()), rows = storedRows(host), count = host.launches.length;
    const runId = host.native.get(inspector)!.runId!;
    expect(cursor.action).toMatchObject({ kind: "launched", role: "execution-inspector", key: inspector, runId });
    expect(atCursor(host).P.control.operation).toMatchObject({ operation: "advance", loop: 1 });
    const inspections = host.hostCalls.length;
    host.setStatus(ref => ref === runId ? { ok: true, runId, state: "pending" } : host.native.get(ref)!);
    expect(await host.execute()).toMatchObject({ status: "blocked", reason: "Positive native barrier: pending" });
    expect(host.statusCalls.at(-1)).toBe(runId);
    expect(host.hostCalls).toHaveLength(inspections);
    expect(host.current()).toEqual(cursor);
    expect(storeTipRows(host)).toEqual(rows);
    expect(host.launches).toHaveLength(count);
    expect(host.launches.filter(call => call.agent === "pitako.execution-inspector").map(call => call.key)).toEqual([inspector]);
  });

  test.each(["stopped", "pending", "permission"])(
    "committed host failure stays terminal at +0 even if its producer now reports %s", async cause => {
      const host = fixture(); host.setLimit(1);
      const { cursor, producer, rows, launches } = await cutBeforeSelection(host);
      host.setStatus(ref => ref === producer.runId ? { ...producer, state: "complete" } : host.native.get(ref)!);
      host.setHostResponse(() => { throw Error("Controlled ambiguous host failure"); });
      const blocked = await host.execute();
      expect(blocked).toMatchObject({ status: "blocked", reason: "Read-only host inspection failed: Controlled ambiguous host failure",
        loopReport: { halt: { ref: { key: cursor.action.key, runId: producer.runId } } } });
      const held = copy(host.current());
      expect(held).toEqual({ ...cursor, hostHalt: { stage: "host", reason: blocked.reason, digest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      expect(storeTipRows(host)).toEqual(rows);
      expect(host.launches).toEqual(launches);
      host.setStatus(ref => ref !== producer.runId ? host.native.get(ref)! : cause === "permission"
        ? { key: cursor.action.key, runId: producer.runId, ok: false, error: "Blocked by pi-subagents permission rule: 'run' is denied." }
        : { key: cursor.action.key, runId: producer.runId, ok: false, state: cause });
      const calls = host.hostCalls.length;
      const statuses = copy(host.statusCalls);
      host.setHostResponse();
      expect(await host.execute()).toEqual(blocked);
      expect(host.statusCalls).toEqual(statuses);
      expect(host.hostCalls).toHaveLength(calls);
      expect(host.current()).toEqual(held);
      expect(storeTipRows(host)).toEqual(rows);
      expect(host.launches).toEqual(launches);
    });

  test("selection replay observes a pending selection before admitting its one recovery child", async () => {
    const host = fixture(); host.setLimit(1);
    const { cursor, producer, rows, launches } = await cutBeforeSelection(host);
    const key = "invoke-human-1.l1.selectionIO";
    host.setStatus(ref => ref === key ? { key, ok: false, state: "pending" }
      : ref === producer.runId ? { ...producer, state: "complete" } : host.native.get(ref)!);
    expect(await host.execute()).toMatchObject({ status: "blocked", reason: "Positive native barrier: pending" });
    expect(host.current()).toEqual(cursor);
    expect(storeTipRows(host)).toEqual(rows);
    expect(host.launches).toEqual(launches);
    host.setStatus(ref => ref === producer.runId ? { ...producer, state: "complete" } : host.native.get(ref)!);
    const replay = await host.execute();
    expect(replay).toMatchObject({ status: "partial", loopsConsumed: 1, maxLoops: 1 });
    expect(host.launches.slice(launches.length)[0]).toMatchObject({ key: "invoke-human-1.l1.selectionIO.r1", agent: "pitako.loop-selection" });
    expect(host.launches.filter(call => call.agent === "pitako.execution-director").map(call => call.key)).toEqual([cursor.action.key]);
    expect(host.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", status: "complete" }));
    expect(storedRows(host).slice(0, rows.length)).toEqual(rows);
  });

  test("pre-admission inspect-initial ambiguity does not fabricate Stop or a resolution", async () => {
    const host = fixture(); host.setLimit(1);
    const error = "Host command 'inspect-initial' failed: Command stopped because the workflow was aborted.";
    host.setHostResponse(key => { expect(key).toBe("inspect-initial"); throw Error(error); });
    expect(await host.execute()).toMatchObject({ status: "blocked", loopsConsumed: 0, reason: expect.stringContaining(error) });
    expect(host.storage.size).toBe(0);
    expect(host.launches).toEqual([]);
    host.setHostResponse();
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 1, maxLoops: 1 });
    expect(host.history()).toHaveLength(1);
    expect(host.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", status: "complete" }));
    expect(storedRows(host).filter(row => row.kind === "resolution")).toEqual([]);
    const count = host.launches.length;
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 1 });
    expect(host.launches).toHaveLength(count);
  });

  test.each(["stopped", "pending"])("checkpointed drain %s is retained from native evidence, not fabricated from text", async observedState => {
    const host = fixture(); host.setLimit(1);
    const key = "invoke-human-1.l1.finishDrain";
    host.setLaunchRespond((request, normal) => request.key === key
      ? { key, runId: `native-${key}`, agent: request.agent, ok: false, stopped: true, output: "",
        results: [{ exitCode: -1, processSignal: "SIGTERM" }] } : normal());
    const stopped = await host.execute();
    expect(stopped.status).toBe("cancelled");
    const halt = expectOpenHalt(host, stopped), retained = copy(host.current()), rows = storeTipRows(host);
    const launches = copy(host.launches), producer = host.native.get(key)!;
    expect(halt.ref).toMatchObject({ key, runId: producer.runId });
    expect(retained.inFlight).toContainEqual({ key, runId: producer.runId, role: "loop-io" });
    expect(retained.action).toMatchObject({ kind: "pending", op: "drain", opKey: key });
    expect(retained.action.drainDigest).toBe(canonicalDigest(JSON.parse(launches.find(call => call.key === key)!.task)));
    host.setLaunchRespond();
    host.setStatus(ref => ref === producer.runId ? { ...producer, stopped: observedState === "stopped", state: observedState }
      : host.native.get(ref)!);
    expect((await host.execute()).status).toBe(observedState === "stopped" ? "cancelled" : "blocked");
    expect(host.current()).toEqual(retained);
    expect(storeTipRows(host)).toEqual(rows);
    expect(host.launches).toEqual(launches);
  });

  function writeFreeBlockedWorker() {
    const host = fixture(); host.setLimit(1);
    const first = "invoke-human-1.l1.t1.a1";
    const reason = "Current input required: choose the supported API";
    host.setRespond((request, normal) => request.key === first ? host.result(request, {
      status: "blocked", work: "Located the conflicting API", remaining: [reason],
      knowledge: { findings: [], handoff: "Awaiting the API decision" }, diagnosis: reason,
    }) : normal());
    return host;
  }



  // A prior answer does not settle a later failure. Equally, that answer must
  // not turn an otherwise recoverable technical read into a human-only veto.












  test.each(["settled", "missing-original", "wrong-family", "nested-agent", "permission"])(
    "historical worker %s never redispatches after a terminal native halt", async mode => {
      const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
      const target = "invoke-human-1.l1.t1.a1";
      host.setRespond((request, normal) => request.key !== target ? normal()
        : closedInterruptedProducer({ key: request.key, ...normal() }, mode === "permission" ? "permission" : "stopped"));
      const initial = await host.executeNative();
      expect(initial.status).toBe(mode === "permission" ? "blocked" : "cancelled");
      const cursor = copy(host.current()), count = host.calls.length, launchCount = host.launches.length;
      const intentRow = storedRows(host, cursor).find(row => row.seq === cursor.loop.attempt.intent.seq);
      expect(intentRow).toMatchObject({ kind: "intent", digest: cursor.loop.attempt.intent.digest,
        body: { key: target, taskId: "change1", attempt: 1 } });
      expect(cursor.action).toMatchObject({ kind: "launched", role: "worker", key: target,
        runId: host.native.get(target)!.runId });
      expect(cursor.halt.digest).toBe(canonicalDigest(initial.loopReport.halt));
      const rows = storeTipRows(host);
      const invalid = ["missing-original", "wrong-family", "nested-agent"].includes(mode);
      if (invalid) {
        const mission = JSON.parse(readFileSync(initial.missionPath, "utf8"));
        const child = mission.workflowChildren.find((item: { key: string }) => item.key === target);
        const dir = child.artifactPaths.find((file: string) => path.basename(file) === child.runId);
        const journal = path.join(path.dirname(dir), child.workflowRunId, "workflow-children.jsonl");
        if (mode === "missing-original") rmSync(journal);
        else {
          const entries = readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
          const settled = entries.find(entry => entry.type === "settle" && entry.key === target).result;
          if (mode === "wrong-family") {
            child.agent = "pitako.task-review";
            writeFileSync(initial.missionPath, JSON.stringify(mission));
            const statusFile = path.join(dir, "status.json");
            const status = JSON.parse(readFileSync(statusFile, "utf8"));
            status.steps[0].agent = child.agent;
            writeFileSync(statusFile, JSON.stringify(status));
            settled.agent = child.agent;
          }
          settled.results[0].agent = "pitako.task-review";
          writeFileSync(journal, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
        }
      }
      host.setStatus(ref => {
        const response = copy(host.native.get(ref)!);
        if (response?.key === target && mode !== "permission")
          return { ok: false, output: "", error: "Historical writer unavailable" };
        return response;
      });
      const replay = await host.executeNative();
      if (invalid) {
        expect(replay.status).toBe("blocked");
        expect(replay.reason).toContain("native original integrity failure");
      } else {
        expect(replay.status, replay.reason).toBe(initial.status);
        expect(replay.loopReport?.halt, replay.reason).toEqual(initial.loopReport.halt);
      }
      expect(host.launches).toHaveLength(launchCount);
      expect(host.calls).toHaveLength(count);
      expect(host.current()).toEqual(cursor);
      expect(storeTipRows(host)).toEqual(rows);
    });

  test.each(["review", "compliance"].flatMap(phase =>
    ["stopped", "permission", "unknown", "current-stop"].map(mode => ({ phase, mode }))))(
    "historical $phase $mode holds the verified halt without dispatch", async ({ phase, mode }) => {
      const host = fixture(undefined, { taskCount: 0 });
      const target = `invoke-human-1.l1.${phase === "review" ? "review.director-prepare" : "compliance"}`;
      const denied = mode === "permission";
      host.setRespond((request, normal) => request.key !== target ? normal() : mode === "unknown"
        ? { ...normal(), ok: false, stopped: true }
        : closedInterruptedProducer(normal(), denied ? "permission" : "stopped"));
      const initial = await host.executeNative();
      expect(initial.status).toBe(denied ? "blocked" : "cancelled");
      const original = copy(host.current()), calls = copy(host.calls);
      const rows = storeTipRows(host), launches = copy(host.launches);
      const producer = copy(host.native.get(target)!);
      const halt = denied ? initial.loopReport.halt : expectOpenHalt(host, initial);
      expect(halt).toMatchObject({ code: "native-barrier", cause: denied ? "native permission denial" : "stopped",
        ref: { key: target, runId: producer.runId } });
      expect(original).toMatchObject({ version: 10,
        halt: { stage: denied ? "native-permission" : "native-barrier", digest: canonicalDigest(halt) },
        loop: { number: 1, phase }, action: { kind: "launched", key: target, runId: producer.runId } });
      host.setStatus(ref => ref !== producer.runId ? copy(host.native.get(ref)!) :
        mode === "stopped" || denied ? producer :
          { ok: false, runId: producer.runId, state: mode === "unknown" ? "unknown" : "stopped" });
      const output = await host.executeNative();
      expect(output, output.reason).toMatchObject({ status: denied ? "blocked" : "cancelled",
        phase, loopsConsumed: 1, maxLoops: original.budget.maxCycles });
      expect(output.loopReport.halt).toEqual(halt);
      expect(output.reason).toBe(halt.reason);
      expect(host.current()).toEqual(original);
      expect(host.history()).toEqual([]);
      expect(storeTipRows(host)).toEqual(rows);
      expect(host.native.get(target)).toEqual(producer);
      expect(host.launches).toEqual(launches);
      expect(host.calls).toEqual(calls);

      // A positive current Stop is not a substitute for the retained original.
      if (mode === "current-stop") {
        const mission = JSON.parse(readFileSync(initial.missionPath, "utf8"));
        const child = mission.workflowChildren.find((item: { key: string }) => item.key === target);
        const dir = child.artifactPaths.find((file: string) => path.basename(file) === producer.runId);
        const journal = path.join(path.dirname(dir), child.workflowRunId, "workflow-children.jsonl");
        const bytes = readFileSync(journal);
        try {
          rmSync(journal);
          expect((await host.executeNative()).reason).toContain("native original integrity failure");
        } finally {
          writeFileSync(journal, bytes);
        }
        host.storage.set("pitako-execute", { ...original, halt: { ...original.halt, digest: "e".repeat(64) } });
        expect((await host.executeNative()).reason).toContain("halt digest or status integrity mismatch");
        host.storage.set("pitako-execute", original);
        host.setStatus(ref => ref === producer.runId ? { ok: true, runId: producer.runId, state: "complete" }
          : copy(host.native.get(ref)!));
        const contradictory = await host.executeNative();
        expect(contradictory.status).toBe("blocked");
        expect(contradictory.reason).toContain("halt digest or status integrity mismatch");
        expect(storeTipRows(host)).toEqual(rows);
        expect(host.launches).toEqual(launches);
        expect(host.calls).toEqual(calls);
      }
    });


});

describe("workflow-owned execute controller", () => {
  // Publication and apply rejection remain distinct durable cuts; replay must
  // not redispatch a director or admit an invalid selection.
  test.each(["none", "publication", "rejection", "next-slot"])("new rejected plan is accounted once across %s cut", async cut => {
    const host = fixture(); host.setLimit(2);
    const rejectedDirector = "invoke-human-1.l1.director.d1";
    const rejectedSelection = "invoke-human-1.l1.selectionIO.d1";
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
    if (cut === "publication") host.setSaveObserver(value => {
      if (value.action.key === rejectedDirector && value.action.runId) throw Error("Cut after native publication was recorded");
    });
    if (cut === "rejection") cutAfterOriginal(host, rejectedSelection);
    if (cut === "next-slot") cutAt(host, value => value.budget.consumedLoops === 2);
    if (cut !== "none") {
      expect((await host.execute()).reason).toContain("Essential persistence failed");
      host.setFailSave();
      host.setSaveObserver(undefined);
    }
    const resumed = await host.execute();
    expect(resumed.status, resumed.reason).toBe("partial");
    const first = host.history()[0];
    expect(first).toMatchObject({ number: 1, outcome: "gaps", cursor: 0, manifest: null, results: [],
      plan: { stage: "rejected", rejection: { diagnostic: expect.stringContaining("Selected task must be pending"),
        ref: { key: rejectedDirector, runId: host.native.get(rejectedDirector)!.runId } } } });
    expect(host.history()).toHaveLength(2);
    expect(host.history()[1].manifest).toEqual(["change1"]);
    expect(host.history()[1].results).toMatchObject([{ taskId: "change1", status: "complete" }]);
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(3);
    expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key.includes(".l1."))).toHaveLength(0);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.native.get("invoke-human-1.l1.director")!.structuredOutput).toEqual(original);
    // The publication cut deliberately failed its write; the surviving intent
    // is reconciled by exact status rather than redispatching the director.
    const published = host.snapshots.find(value => value.action.kind === "launched" &&
      value.action.key === rejectedDirector && value.action.runId === host.native.get(rejectedDirector)!.runId);
    expect(published?.loop).toMatchObject({ taskId: null, outcome: null });
  });

  test("repeated invalid selection consumes frozen slots without dispatching a writer", async () => {
    const host = fixture(); host.setLimit(3);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") result.structuredOutput.select = "missing";
      return result;
    });
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 3 });
    expect(host.history().map((loop: { plan: { stage: string } }) => loop.plan.stage)).toEqual(["rejected", "rejected", "rejected"]);
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(6);
    expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
  });

  test.each(["available", "lost", "unresolved"])("last-slot rejection remains settled with %s original", async mode => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") result.structuredOutput.select = "missing";
      return result;
    });
    expect(await host.executeNative()).toMatchObject({ status: "partial", loopsConsumed: 1 });
    const retained = copy(host.history()[0]);
    const cursor = copy(host.current());
    expect(cursor.action).toEqual({ kind: "terminal" });
    if (mode !== "available") {
      for (const result of host.native.values()) delete result.structuredOutput;
      host.setRespond((request, normal) => request.agent === "pitako.execution-inspector"
        ? host.result(request, { status: mode, reason: "Exact original unavailable", original: null, workerResult: null,
          originalAvailable: false, binding: "unavailable", comparison: "neither", provenance: ["/native/exact-original"] }) : normal());
    }
    const actions = host.calls.map(call => call.key), statuses = host.statusCalls.length;
    expect(await host.executeNative()).toMatchObject({ status: "partial", loopsConsumed: 1 });
    expect(host.history()[0]).toEqual(retained);
    expect(host.current()).toEqual(cursor);
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
    const director = "invoke-human-1.l1.director.d1", selection = "invoke-human-1.l1.selectionIO.d1";
    cutAfterOriginal(host, selection);
    expect((await host.executeNative()).reason).toContain("Essential persistence failed");
    expect(host.calls.some(call => call.key.endsWith(".gaps") || call.agent === "pitako.worker")).toBe(false);
    expect(host.current().action).toMatchObject({ kind: "launched", key: director, runId: host.native.get(director)!.runId });
    expect(host.history()).toEqual([]);
    const committed = storeTipRows(host).find(row => row.opKey === `operation:${selection}`);
    expect(committed).toBeDefined();
    expect(storedRows(host)).not.toContainEqual(committed);
    host.setFailSave();
    expect(await host.executeNative()).toMatchObject({ status: "partial", loopsConsumed: 1 });
    expect(host.history()[0].plan.stage).toBe("rejected");
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(2);
    expect(host.statusCalls).toContain(host.native.get(director)!.runId!);
    expect(storedRows(host).find(row => row.seq === committed!.seq)).toEqual(committed);
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
    expect(host.calls.filter(call => pitakoAgentFamily(call.agent) !== "loop-io").map(call => call.key)).toEqual(["invoke-human-1.l1.advance.requests", "invoke-human-1.l1.director", "invoke-human-1.l1.director.d1", "invoke-human-1.l1.gaps"]);
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
    expect(host.history().map((loop: { plan: { stage: string } }) => loop.plan.stage)).toEqual(["rejected", "rejected"]);
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
      expectOpenHalt(host, output, mode === "permission" ? "permission" : undefined);
      expect(host.history()).toEqual([]);
      expect(atCursor(host).P.preview.planRejections).toEqual([]);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
      expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
      if (["producer", "binding"].includes(mode)) {
        const calls = host.calls.length;
        host.setRespond(undefined);
        host.setStatus(() => ({ ok: true, output: "", structuredOutput: host.plan() }));
        expect((await host.execute()).status).toBe("blocked");
        expect(host.calls).toHaveLength(calls);
        expect(atCursor(host).P.preview.planRejections).toEqual([]);
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
    const output = await host.execute();
    expect(output.status).toBe(mode === "stopped" ? "cancelled" : mode === "capacity" ? "partial" : "blocked");
    expectOpenHalt(host, output, mode === "permission" ? "native-settlement" : undefined);
    expect(host.history()).toHaveLength(1);
    expect(host.history()[0]).toMatchObject({ outcome: "gaps", plan: { stage: "rejected" } });
    expect(atCursor(host).P.preview.planRejections.map(rejection => rejection.loop)).toEqual([1]);
    expect(host.calls.filter(call => pitakoAgentFamily(call.agent) !== "loop-io").map(call => call.key)).toEqual(["invoke-human-1.l1.advance.requests", "invoke-human-1.l1.director", "invoke-human-1.l1.director.d1", "invoke-human-1.l1.gaps", "invoke-human-1.l1.nextAdvance.requests", "invoke-human-1.l2.director"]);
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
        recoverySubjects.push(JSON.parse(request.task.split(
          "Use existing read tools and ONLY these exact native producer/run/output references, plus Git/WIP:\n",
        )[1]!.split("\n")[0]!));
        result.structuredOutput = { status: "recovered", reason: "Exact settled producer original", original: copy(original),
          workerResult: null, originalAvailable: true, binding: "identical", comparison: "equal-full-json",
          provenance: ["/native/witness/invoke-human-1.l1.director.json"] };
      }
      return result;
    });
    const outcome = await host.execute();
    expect(outcome.status, outcome.reason).toBe("partial");
    expect(host.records().find((record: any) => record.kind === "loop").body.plan).toMatchObject({ stage: "rejected",
      rejection: { diagnostic: "Selected task must be pending" }, recoverySource: { comparison: "equal-full-json" } });
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(2);
    expect(recoverySubjects).toHaveLength(2);
    expect(recoverySubjects.map(subject => subject.key)).toEqual(["invoke-human-1.l1.director", "invoke-human-1.l1.director.d1"]);
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
    const workerBindings: { key: string; cursor: any; association: any }[] = [];
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.worker") {
        const association = JSON.parse(request.task.split("ASSOCIATION (data): ")[1]!.split("\n")[0]!);
        workerBindings.push({ key: request.key, cursor: copy(host.current()), association });
      }
      return normal();
    });
    const outcome = await host.executeNative({ sourceRefs });
    expect(outcome).toMatchObject({ status: "partial", loopsConsumed: 2 });
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
    expect(workerBindings.map(({ association }) => association.loop)).toEqual([1, 2]);
    for (const { key, cursor, association } of workerBindings) {
      expect(association.sourceRefs).toEqual(sourceRefs);
      const ref = cursor.loop.attempt.intent;
      const intent = storedRows(host, cursor)
        .find(row => row.seq === ref.seq && row.digest === ref.digest && row.kind === "intent");
      const { loop, ...binding } = association;
      expect(intent?.body).toMatchObject({ key, loop, association: binding });
    }
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
    expect(host.current()).not.toHaveProperty("activePlan");
    expect(host.history().map((loop: { manifest: string[] }) => loop.manifest)).toEqual([["change2"], ["change1"]]);
    expect(host.calls.some(call => call.key.includes(".review.") || call.key.endsWith(".compliance"))).toBe(false);
  });

  test.each([
    undefined, null, {}, [null], [{}], [{ taskId: "change1", reason: "old ordered contract" }], [""], ["  "],
  ].map(invalid => ({ invalid })))("apply rejects incompatible dependency metadata %j", async ({ invalid }) => {
    const host = fixture(undefined, { taskCount: 2 }); host.setLimit(2);
    host.setRespond((request, normal) => {
      const selectionApply = pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "apply";
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
    expect(host.history().every((loop: { plan: { stage: string }; outcome: string }) =>
      loop.plan.stage === "rejected" && loop.outcome === "gaps")).toBe(true);
    expect(host.calls.find(call => call.key.endsWith(".l2.director"))!.task).toContain(diagnostic);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
  });

  test.each(["unknown", "self", "unfinished", "cycle"])("%s backlog dependency cannot dispatch a writer", async mode => {
    const host = fixture(undefined, { taskCount: 2 }); host.setLimit(2);
    host.setRespond((request, normal) => {
      const selectionApply = pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "apply";
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
    expect(host.history().every((loop: { plan: { stage: string }; outcome: string }) =>
      loop.plan.stage === "rejected" && loop.outcome === "gaps")).toBe(true);
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
        expect(references).toEqual([{ taskId: "change1", status: "done", source: readBacklog(host.root, "spec").path }]);
        expect(request.task).toContain("do not automatically repeat all prerequisite gates");
      }
      return result;
    });
    if (cut === "before-result") cutAfterOriginal(host, "invoke-human-1.l1.t1.a2");
    else cutAt(host, value => value.loop?.number === 1 && value.loop.cursor === 1);
    expect((await host.execute()).reason).toContain("Essential persistence failed");
    expect(host.calls.some(call => call.key.includes(".l2."))).toBe(false);
    if (cut === "before-cursor") expect(host.current()).toMatchObject({
      action: { kind: "pending", op: "gate", opKey: "invoke-human-1.l1.t1.a2.gate" },
      loop: { number: 1, cursor: 0, attempt: { number: 2, stage: "result" } },
    });
    const cutLaunches = host.launches.length;
    const committedPrefix = storedRows(host);
    host.setFailSave();
    const resumed = await host.execute();
    expect(resumed.status, resumed.reason).toBe("partial");
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a2")).toHaveLength(1);
    expect(host.calls.filter(call => call.key === "invoke-human-1.l2.t1.a1")).toHaveLength(1);
    expect(host.history().map((loop: any) => loop.manifest)).toEqual([["change1"], ["change2"]]);
    if (cut === "before-cursor") {
      expect(host.launches.slice(cutLaunches).filter(call => call.key.startsWith("invoke-human-1.l1.t1.a2."))
        .map(({ key, agent }) => ({ key, agent }))).toEqual([
        { key: "invoke-human-1.l1.t1.a2.task-synthesis.review-recovery.r1", agent: "pitako.loop-gate" },
      ]);
      expect(storedRows(host).slice(0, committedPrefix.length)).toEqual(committedPrefix);
    }
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
    expect(host.records().filter((record: { kind: string; loop: number }) => record.kind === "unit" && record.loop === 2)).toEqual([]);
  });

  test.each([1, 2, 4])("admitted limit %s controls every gap report and dispatch, independent of later settings", async limit => {
    const host = fixture(); host.setLimit(limit);
    host.setRespond((request, normal) => request.key.endsWith(".compliance") ? gaps(normal()) : normal());
    const output = await host.execute();
    expect(output).toMatchObject({ status: "partial", loopsConsumed: limit, maxLoops: limit });
    expect(host.current().budget).toMatchObject({ maxCycles: limit, consumedLoops: limit });
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
    expect(host.current().budget).toMatchObject({ maxCycles: 10, consumedLoops: 9 });
    const closes = host.launches.filter(call => call.agent === "pitako.checkout-observer");
    const refs = closes.map(call => host.native.get(call.key)!);
    expect(host.history().filter((loop: { kind: string }) => loop.kind === "final")
      .map((loop: { number: number }) => loop.number))
      .toEqual(closes.map(call => Number(call.key.match(/\.l(\d+)\./)![1])));
    for (const field of ["runId", "asyncDir"] as const) {
      expect(refs.every(ref => ref[field])).toBe(true);
      expect(new Set(refs.map(ref => ref[field])).size).toBe(5);
    }
    for (const field of ["stdoutPath", "stderrPath"] as const) {
      const paths = refs.map(ref => ref.externalAdapter?.outputArtifacts?.[field]);
      expect(paths.every(Boolean)).toBe(true);
      expect(new Set(paths).size).toBe(5);
    }
  });

  test("new human invocation replaces the fixed cursor without changing old store or native records", async () => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1); expect((await host.execute()).status).toBe("complete");
    const previous = copy(host.current());
    const prior = atCursor(host, previous);
    const originals = copy([...host.native.entries()]);
    host.setLimit(4);
    host.setInvocation("human-2");
    host.setRespond((request, normal) => request.agent === "pitako.execution-director"
      ? { ...normal(), ok: false, stopped: true } : normal());
    expect(await host.execute()).toMatchObject({ status: "cancelled", maxLoops: 4 });
    expect(host.calls.at(-1)?.key).toBe("invoke-human-2.l1.director");
    expect([...host.storage.keys()]).toEqual(["pitako-execute"]);
    expect(host.current()).toMatchObject({ version: 10, invocation: "human-2", storeId: previous.storeId,
      budget: { maxCycles: 4, consumedLoops: 1 } });
    expect(atCursor(host).P.prompt.admission?.association.invocation).toBe("human-2");
    expect(atCursor(host, previous)).toEqual(prior);
    for (const [key, original] of originals) expect(host.native.get(key)).toEqual(original);
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
    cutAt(host, value => value.halt !== null);
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
    expect(replay.status).toBe(output.status);
    expect(replay.reason).toContain(cause === "stopped" ? "stopped" : "permission");
    expect(replay.reason).not.toMatch(/Essential persistence failed|new invocation/);
    expect(host.calls).toEqual(calls); expect(replay.loopsConsumed).toBe(1);
  });

  test.each([
    ["worker", "stopped"], ["worker", "permission"],
    ["review", "stopped"], ["review", "permission"],
    ["worker", "detached"], ["review", "recovery"],
  ])("pre-attachment %s %s survives essential save failure in every report", async (phase, cause) => {
    const host = fixture(undefined, { taskCount: phase === "worker" ? 1 : 0 }); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (phase === "worker" ? request.agent === "pitako.worker" : request.key.endsWith("director-prepare"))
        return { ...result, ok: false, ...(cause === "permission"
          ? { error: "Blocked by pi-subagents permission rule: fixture" } : { [cause!]: true }) };
      return result;
    });
    cutAfterOriginal(host, phase === "worker"
      ? "invoke-human-1.l1.t1.a1" : "invoke-human-1.l1.review.director-prepare");
    const output = await host.execute();
    expectImpediment(host, output, cause === "stopped" ? "cancelled" : "blocked", cause!, "Essential persistence failed");
    expect(output.maxLoops).toBe(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(phase === "worker" ? 1 : 0);
    expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
    expect(host.hostCalls.filter(key => key === "inspect-initial")).toHaveLength(1);
  });

  test.each([["decision", "lost save"], ["worker", "lost save"], ["decision", "committed halt"], ["worker", "committed halt"]])(
    "%s block preserves its reason on replay after %s", async (phase, cutKind) => {
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
      if (cutKind === "lost save") cutAt(host, value => value.halt?.stage === "semantic-block" &&
        (phase !== "worker" || value.loop?.attempt?.stage === "result"));
      const output = await host.execute();
      expectImpediment(host, output, "blocked", reason,
        cutKind === "lost save" ? "Essential persistence failed" : undefined);
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(phase === "worker" ? 1 : 0);
      const cut = copy(host.current()), rows = storeTipRows(host), admissions = copy(host.launches);
      const dispatches = () => host.calls.filter(call => call.agent === "pitako.worker" || call.key.endsWith(".director"));
      const calls = copy(dispatches()), reads = host.hostCalls.filter(key => key === "execute-settings").length;
      host.setFailSave(); host.setLimit(4); host.emits.length = 0;
      const replay = await host.execute();
      expectImpediment(host, replay, "blocked", reason);
      expect(replay.maxLoops).toBe(1); expect(dispatches()).toEqual(calls);
      if (phase === "decision" || cutKind === "committed halt") {
        expectOpenHalt(host, replay);
        expect(replay.loopReport.pending[0].references).toContainEqual(replay.loopReport.halt.ref ??
          { key: "invoke-human-1.l1.compliance", runId: host.native.get("invoke-human-1.l1.compliance")!.runId });
        expect(host.launches).toEqual(admissions);
        expect(storeTipRows(host)).toEqual(rows);
      }
      if (phase === "decision") {
        const key = "invoke-human-1.l1.compliance";
        const native = host.native.get(key)!;
        expect(cut.action).toMatchObject({ kind: "launched", role: "reviewer", key, runId: native.runId });
        expect(host.current().head).toEqual(cut.head);
      }
      expect(host.hostCalls.filter(key => key === "execute-settings")).toHaveLength(reads);
    });

  test.each([1, 2])("blocked result is atomic and old committed cut replays as blocked at limit %s", async limit => {
    const host = fixture(); host.setLimit(limit);
    const key = "invoke-human-1.l1.t1.a1";
    const reason = "Human decision required before editing the conflicting API";
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") Object.assign(result.structuredOutput,
        { status: "blocked", diagnosis: reason, remaining: [reason] });
      return result;
    });
    const closeKey = `${key}.close`;
    cutAt(host, value => value.loop?.attempt?.stage === "result" && value.halt?.stage === "semantic-block");
    const first = await host.execute();
    expect(first.reason).toContain("Essential persistence failed");
    const cut = copy(host.current()), before = storeTipRows(host), admissions = copy(host.launches);
    expect(cut.loop).toMatchObject({ number: 1, cursor: 0, taskId: "change1", attempt: { number: 1, stage: "launched" } });
    expect(cut.action).toMatchObject({ kind: "pending", op: "close", opKey: closeKey });
    const folded = atCursor(host, cut).P.prompt.execution?.foldedContinuation;
    const worker = folded == null ? undefined : executeField(folded, "worker");
    expect(worker).toMatchObject({ reference: { key, runId: host.native.get(key)!.runId },
      value: { status: "blocked", remaining: [reason] } });
    expect(before.filter(row => row.kind === "receipt" && (row.body as { key: string }).key === closeKey)).toHaveLength(1);
    const reads = host.hostCalls.filter(key => key === "execute-settings").length;
    host.setFailSave();
    host.setLimit(4); host.emits.length = 0;
    const replay = await host.execute();
    expectImpediment(host, replay, "blocked", reason);
    expect(replay.maxLoops).toBe(limit);
    expect(host.launches.slice(0, admissions.length)).toEqual(admissions);
    expect(host.launches.slice(admissions.length).map(({ key, agent }) => ({ key, agent }))).toEqual([
      { key: `${closeKey}.r1`, agent: "pitako.loop-close" }, // the only extra admission
      { key: "invoke-human-1.l1.finishDrain", agent: "pitako.loop-drain" },
    ]);
    expect(storeTipRows(host).slice(0, before.length)).toEqual(before);
    expect(host.hostCalls.filter(key => key === "execute-settings")).toHaveLength(reads);
    expect(host.current().loop).toMatchObject({ outcome: "blocked", attempt: { number: 1, stage: "result", intent: cut.loop.attempt.intent } });
    const halt = expectOpenHalt(host, replay);
    expect(halt).toMatchObject({ status: "blocked", code: "semantic-block", reason,
      ref: { key, runId: host.native.get(key)!.runId } });
    expect(replay.loopReport.work).toEqual([expect.objectContaining({
      taskId: "change1", attempt: 1, status: "blocked", reference: halt.ref, remaining: [reason], diagnosis: reason,
    })]);
  });

  // A write-free worker block has no pause seal. Current input answering that exact
  // block continues the task in the same loop; anything else keeps the halt.


  // A blocked restorer can change historical paths while capturing none of its own.


  test("complete additional spec sources are immutable context for all fresh phases", async () => {
    const host = fixture("SELECTED SNAPSHOT INTACT");
    const sourceRefs = [{ path: "/stable/.pitako/plans/inherited.md", digest: "f".repeat(64) }];
    expect((await host.execute({ sourceRefs })).status).toBe("complete");
    expect(atCursor(host).P.prompt.admission?.association.sourceRefs).toEqual(sourceRefs);
    for (const request of host.calls.filter(call => !call.resume && pitakoAgentFamily(call.agent) !== "loop-io" && call.agent !== "pitako.checkout-observer" && call.agent !== "pitako.execution-ledger" && call.agent !== "pitako.request-observer" && call.agent !== "pitako.checkpoint-sealer" && call.agent !== "pitako.originals-verifier")) {
      expect(request.task).toContain("SELECTED SNAPSHOT INTACT");
      for (const ref of sourceRefs) {
        expect(request.task).toContain(JSON.stringify(ref.path));
        expect(request.task).toContain(JSON.stringify(ref.digest));
      }
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
    cutAt(host, value => value.halt?.stage === "semantic-block");
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
    expect(host.snapshots.some(value => value.action?.kind === "launched" &&
      value.action.key === director.key && value.action.runId === null)).toBe(true);
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
    expect(host.history().at(-1).finalAttempt.gate.receipt).toMatchObject({ mutated: false, gates: [{ id: "full", status: "pass", exit: 0 }] });
    expect(host.history()[0].plan.ref).toMatchObject({ agent: "pitako.execution-director", runId: host.native.get(director.key)!.runId,
      outputReference: "/native/output/invoke-human-1.l1.director.json", outputArtifactPath: "/native/binding/invoke-human-1.l1.director.json",
      outputPathMapping: { requestedPath: "invoke-human-1.l1.director.json", savedPath: "/native/remapped/invoke-human-1.l1.director.json" },
      results: [{ structuredOutputPath: "/native/witness/invoke-human-1.l1.director.json" }] });
    expect(atCursor(host).P.prompt.admission?.association.digest).toBe(digest("ALL COMPLETE SPEC SECTIONS"));
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
    expect(host.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", status: "complete" }));
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
      if (request.agent !== "pitako.originals-verifier") return result;
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

  test("real mirrored two-angle review runs directly to synthesis, not include=material", async () => {
    const host = fixture("FULL SPECS", { findings: true });
    const goal = "Improve record selection\n " + "with complete caller evidence ".repeat(12);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.director") result.structuredOutput.changes[0].task.goal = goal;
      return result;
    });
    // A scoped-defect finding returned as ready reaches synthesis instead of stopping execute.
    expect((await host.execute()).status).toBe("complete");
    const verifiers = host.calls.filter(call => call.agent === "pitako.originals-verifier");
    // Only synthesis consumes independent originals.
    expect(verifiers.map(call => call.key)).toEqual(["synthesis"].map(gate => `invoke-human-1.l2.review.verify-${gate}`));
    expect(host.verifications.every(entry => entry.output.items.every((item: any) => item.state === "accessible"))).toBe(true);
    expect(host.calls.filter(call => call.key.includes(".review.") && call.agent !== "pitako.originals-verifier")).toHaveLength(6);
    for (const call of host.calls.filter(item => item.key.includes(".review.") && item.agent !== "pitako.originals-verifier"))
      expect(call.task).toContain("Return status blocked only when missing material context prevents this review phase.");
    expect(host.calls.filter(call => call.key.includes(".review.") && call.resume)).toHaveLength(1);
    const requests = host.calls.filter(call => call.key.includes(".review.") && call.agent !== "pitako.originals-verifier");
    expect(new Set(requests.map(request => request.phase))).toEqual(new Set([
      "review-prepare", "review-independent", "review-synthesis",
    ]));
    const { closed, originals } = closingReview(host);
    const manifest = closed.integratedReview;
    expect(manifest.originals).toHaveLength(requests.length);
    expect(originals).toHaveLength(requests.length);
    expect(manifest.decision.reference).toMatchObject({ stateKey: "invoke-human-1", loop: 2 });
    for (const request of requests) {
      const label = request.label ?? "";
      expect(label).toBe(request.task.split("\n")[0]);
      expect(label).toContain("Loop 2 result");
      const angle = request.key.match(/independent-angle(\d+)-r[12]$/)?.[1];
      if (angle) expect(label.indexOf(`Whole-result angle ${angle}`)).toBeLessThan(label.indexOf("Loop 2 result"));
      expect(request.task).toContain("FULL SPECS");
      expect(request.task).toContain("ADMITTED PLAN CONTEXT");
      expect(request.task).toContain("COMPLETE TARGET:");
      expect(request.outputMode).toBe("file-only");
      expect(request.output).toBe(`review/${request.key}.json`);
      expect(request).toMatchObject({ cwd: host.root, reads: false, progress: false });
      const ref = closed.review.references.find((entry: any) => entry.key === request.key);
      const retained = manifest.originals.find((entry: any) => entry.key === request.key);
      expect(Object.keys(retained).sort()).toEqual(["id", "key", "path", "runId", "sha256"]);
      const original = originals.find(value => value.key === request.key)!;
      expect(original).toMatchObject({ key: request.key, runId: ref.runId, sha256: retained.sha256, path: retained.path });
      expect(readReviewOriginal(retained)).toEqual(original.body);
      expect(ref.model).toBe(request.model);
      expect(ref.outputReference).toBe(`/native/output/${request.key}.json`);
      expect(original).not.toHaveProperty("results"); // native witnesses belong to execute, not a second manifest copy
      const witness = publicationWitness(ref.results[0], host.native.get(ref.runId)!.results![0]);
      expect(witness.outputReference).toEqual({ path: witness.savedOutputPath,
        bytes: readFileSync(witness.savedOutputPath).byteLength, lines: 1, message: "Saved" });
      expect(witness.structuredOutputPath).toBe(`/native/witness/${request.key}.json`);
      const recovered = JSON.parse(readFileSync(witness.savedOutputPath, "utf8"));
      for (const field of ["association", "delivery", "access"])
        expect(request.outputSchema.properties).not.toHaveProperty(field);
      expect(original.body).toEqual(recovered);
      expect(closed.review.verdict).toBe("clear");
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
      expect(output.status).toBe(fault === "nested-timeout" ? "partial" : "blocked");
      expect(host.calls.filter(request => request.key.includes(".review."))).toHaveLength(1);
      expect(host.calls.some(request => request.key.endsWith(".compliance"))).toBe(false);
      const key = "invoke-human-1.l2.review.director-prepare";
      const runId = observed!.runId;
      expect(host.current().action).toMatchObject({ kind: "launched", role: "reviewer", key, runId });
      const halt = expectOpenHalt(host, output);
      const rows = storedRows(host);
      expect(rows.some(row => row.kind === "review-originals")).toBe(false);
      const rootRefusal = ["failed-outcome", "nested-running", "nested-timeout"].includes(fault);
      if (fault === "nested-timeout")
        expect(halt).toMatchObject({ code: "timeout", class: "final-review", key, launchedMs: 14400000 });
      else if (rootRefusal)
        expect(halt).toMatchObject({ code: "native-barrier",
          cause: fault === "nested-running" ? "running" : "native child barrier" });
      else {
        expect(halt.code).toBe("semantic-block");
        expect(host.current().review.slots).toEqual([expect.objectContaining({ key, runId,
          digest: fault === "failed-state" ? canonicalDigest(observed!.structuredOutput) : null })]);
        expect(output.reason).toContain(fault === "failed-state" ? "Native child control/terminal failure" : "producer/key/run identity");
      }
      const reference = output.loopReport.pending[0].references.flat().find((entry: any) => entry?.key === key && entry.results?.length);
      expect(reference).toMatchObject({ key, runId });
      const actual = observed!.results![0]!;
      const witness = publicationWitness(reference.results[0], actual);
      expect(witness.savedOutputPath).toBe(actual.savedOutputPath);
      expect(witness.outputReference).toEqual(actual.outputReference);
      for (const field of ["key", "agent", "runId", "workflowKey", "terminalOutcome", "state", "timedOut"])
        expect(witness[field]).toEqual((actual as any)[field]);
      if (fault === "failed-state") expect(reference.state).toBe("failed");
      const cursor = copy(host.current()), count = host.launches.length;
      const original = copy(host.native.get(runId!));
      expect(host.native.get(key)).toEqual(original);
      if (fault === "nested-timeout") {
        // Native management metadata proves settlement, not the nested timeout body.
        host.setStatus(ref => ({ ok: true, output: `Run: ${ref}\nState: complete`, results: [] }));
      }
      const replay = await host.executeNative();
      expect(replay.status, replay.reason).toBe(fault === "nested-timeout" ? "partial" : "blocked");
      if (fault === "nested-timeout") {
        expect(replay.loopReport.halt).toEqual(halt);
        expect(replay.loopReport.pending[0].references).toEqual([halt.ref]);
      }
      expect(host.launches).toHaveLength(count);
      expect(host.current()).toEqual(cursor);
      expect(storeTipRows(host)).toEqual(rows);
      expect(host.native.get(runId!)).toEqual(original);
    });

  test.each(["different-path", "no-reference"])("integrated review retains distinct or missing publication references: %s", async mode => {
    const host = fixture();
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
    const { closed, originals } = closingReview(host);
    expect(originals.length).toBeGreaterThan(0);
    for (const ref of closed.review.references) {
      const witness = ref.results[0], actual = host.native.get(ref.runId)!.results![0];
      expect(witness.savedOutputPath).toBe(actual.savedOutputPath);
      expect(witness.outputReference).toEqual(actual.outputReference);
      const original = closed.integratedReview.originals.find((entry: any) => entry.key === ref.key);
      expect(originals.find(value => value.key === ref.key)).toMatchObject({ runId: ref.runId, body: readReviewOriginal(original) });
      expect(JSON.parse(readFileSync(witness.savedOutputPath, "utf8"))).toEqual(readReviewOriginal(original));
    }
  });

  test.each(["optional-artifact", "mandatory-publication", "partial-failed", "non-delivery", "unknown-completeness", "inaccessible-essential"])(
    "integrated review distinguishes publication/delivery/access: %s", async mode => {
      const host = fixture();
      let observed: Result | undefined;
      let observedKey: string;
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
          observedKey = request.key;
        }
        return result;
      });
      // Failure bodies belong to store/native evidence, never to the cursor.
      const bodyCopies: number[] = [];
      host.setSaveObserver(() => {
        if (!observed?.structuredOutput) return;
        const merged = JSON.stringify(Object.fromEntries(host.storage));
        bodyCopies.push(merged.split(JSON.stringify(observed.structuredOutput.reason).slice(1, -1)).length - 1);
      });
      const output = await host.executeNative();
      if (observed!.structuredOutput) {
        expect(bodyCopies.length).toBeGreaterThan(0);
        expect(Math.max(...bodyCopies)).toBe(0);
      }
      if (mode === "optional-artifact") {
        expect(output.status).toBe("complete");
        const { closed, originals } = closingReview(host);
        expect(closed.review.verdict).toBe("clear");
        expect(closed.compliance.status).toBe("fulfilled");
        const key = host.calls.find(call => call.key.endsWith(".review.director-prepare"))!.key;
        const { runId, structuredOutput, metadataSaveError } = observed!;
        expect(metadataSaveError).toBe("Optional debug artifact unavailable");
        const retained = closed.integratedReview.originals.find((entry: { key: string }) => entry.key === key);
        expect(retained).toMatchObject({ key, runId });
        const matching = originals.filter(entry => entry.key === key);
        expect(matching).toEqual([{ ...retained, body: structuredOutput }]);
        expect(readReviewOriginal(retained)).toEqual(structuredOutput);
        expect(host.snapshots.some(cursor => cursor.review?.slots.some((slot: { key: string; runId: string; digest: string }) =>
          slot.key === key && slot.runId === runId && slot.digest === canonicalDigest(structuredOutput)))).toBe(true);
        const ref = closed.review.references.find((entry: { key: string }) => entry.key === key);
        expect(ref.runId).toBe(runId);
        publicationWitness(ref.results[0], observed!.results![0]);
        return;
      } else {
        expect(output.status).toBe("blocked");
        expect(host.calls.some(request => request.key.endsWith(".compliance"))).toBe(false);
      }
      expectOpenHalt(host, output);
      const { runId, structuredOutput } = observed!;
      const key = observedKey!;
      const slots = host.current().review.slots.filter((slot: { key: string }) => slot.key === key);
      const digest = ["mandatory-publication", "partial-failed", "inaccessible-essential"].includes(mode)
        ? canonicalDigest(structuredOutput) : null;
      expect(slots).toEqual([expect.objectContaining({ key, runId, digest })]);
      const admitted = storedRows(host);
      expect(admitted.some(row => row.kind === "review-originals")).toBe(false);
      const native = host.native.get(runId!)!;
      expect(host.native.get(key)).toEqual(native);
      expect(native.structuredOutput).toEqual(structuredOutput);
      const ref = output.loopReport.pending[0].references.flat().find((entry: any) => entry?.key === key);
      expect(ref).toMatchObject({ key, runId });
      publicationWitness(ref.results[0], observed!.results![0]);
      if (["mandatory-publication", "partial-failed", "inaccessible-essential"].includes(mode)) {
        expect(ref.results[0].savedOutputPath).toBeUndefined();
        expect(ref.results[0].outputSaveError).toBe("Required output save failed");
        expect(native.structuredOutput).toBeDefined();
      }
      if (mode === "non-delivery") {
        expect(native.structuredOutput).toBeUndefined();
        expect(output.reason).toContain("No usable structured result");
      }
      if (mode === "unknown-completeness") {
        expect(native.structuredOutput).toBeDefined();
        expect(output.reason).toContain("Original completeness/schema/association not demonstrated");
      }
      if (mode === "inaccessible-essential") {
        expect(host.calls.some(request => ["review-critique", "review-defense", "review-synthesis"].includes(request.phase!))).toBe(false);
      }
      if (mode === "partial-failed") {
        const cursor = copy(host.current()), calls = copy(host.calls);
        host.setStatus(ref => ({ ...copy(host.native.get(ref)!), ok: true,
          structuredOutput: { ...observed!.structuredOutput, angles: undefined } }));
        const replay = await host.executeNative();
        expect(replay.status).toBe("blocked");
        expect(replay.reason).toBe("Retained review original integrity mismatch.");
        expect(host.current()).toEqual(cursor);
        expect(storedRows(host)).toEqual(admitted);
        expect(host.native.get(runId!)).toEqual(native);
        expect(host.calls).toEqual(calls);
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
    const original = host.native.get(workers[0]!.key)!;
    const previous = JSON.parse(workers[1]!.task.split("TASK CONTINUATION (data):\n")[1]!.split("\nTASK REVIEW REPAIR")[0]!);
    expect(previous.previousResult).toEqual(expect.any(String));
    const result = host.history()[0].results.find((entry: any) => entry.attempt === 1);
    expect(result?.ref).toMatchObject({ key: workers[0]!.key, runId: original.runId });
    expect(previous.previousResult).toBe(result.ref.path ?? result.ref.outputReference ?? result.ref.outputArtifactPath);
    expect(workers[1]!.task).toContain("src/change1.ts contains the parser branch.");
    expect(workers[1]!.task).toContain("TASK CONTINUATION");
    expect(workers[1]!.task).not.toContain("FROZEN ATTEMPT");
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    expect(host.history()[0].manifest).toEqual(["change1"]);
    expect(host.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", attempt: 2, status: "complete" }));
    expect(workers[1]!.task).toContain("DIRECT PREREQUISITE COMPLETED RESULTS (historical references, not current check evidence):\n[]");
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
    expect(host.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", status: "complete" }));
    expect(atCursor(host).P.prompt.admission?.association).toMatchObject({ root: host.root, invocation: "human-1" });
    expect(host.current()).toMatchObject({ root: host.root, invocation: "human-1" });
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
      expect(host.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", status: "complete" }));
      expect(host.history()[0].results[0].checks).toMatchObject({ current: true, count: 1, passed: 1 });
      const rows = storeTipRows(host);
      const gate = rows.find(row => row.opKey === "worker-gate:invoke-human-1.l1.t1.a1.gate");
      expect(gate?.body).toMatchObject({ result: { gates: [{ id: "change1-check", status: "pass" }] } });
      const task = readBacklog(host.root, "spec").backlog!.tasks.find(task => task.id === "change1")!;
      expect(task.gates).toMatchObject([{ id: "change1-check", command: "bun test change1", cwd: host.root }]);
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
    expect(host.records().find((record: any) => record.kind === "loop").body.results).toEqual([expect.objectContaining({ status: "rejected",
      rejection: "Worker returned an invalid work/status/remaining contract." })]);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.some(call => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).operation === "gate")).toBe(false);
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
        expect(readBacklog(host.root, "spec").backlog!.tasks.find(task => task.id === "change1")!.status).not.toBe("done");
      }
      expect(host.calls.some(call => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).operation === "gate")).toBe(false);
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
    expect(host.history()[1].results).toContainEqual(expect.objectContaining({ taskId: "change1", status: "complete" }));
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
    expect(host.calls[synthesis + 1]!.agent).toBe("pitako.loop-review-originals");
    expect(host.calls[synthesis + 1]!.key).toBe("invoke-human-1.l1.reviewOriginals");
    const nextDirector = host.calls.findIndex(call => call.key === "invoke-human-1.l2.director");
    const beforeDirector = host.calls.slice(synthesis + 1, nextDirector);
    expect(beforeDirector.map(call => call.key)).toEqual(["invoke-human-1.l1.reviewOriginals",
      "invoke-human-1.l1.final-gaps", "invoke-human-1.l1.checkout", "invoke-human-1.l2.advance.prepare", "invoke-human-1.l2.advance.requests",
      "invoke-human-1.l2.demandOriginals", "invoke-human-1.l2.demand-observation"]);
    expect(beforeDirector.find(call => call.key.endsWith(".final-gaps"))!.task).toContain("final-phase");
    const gapInput = JSON.parse(beforeDirector.find(call => call.key.endsWith(".final-gaps"))!.task);
    expect(JSON.stringify(gapInput)).toContain("invoke-human-1.l1.review.director-synthesis");
    const synthesisCall = host.calls[synthesis]!;
    expect(synthesisCall.task).toContain("evidence-contract-r1-1");
    expect(synthesisCall.task).toContain("evidence-contract-r2-1");
    expect(synthesisCall.task).toContain("angle1-r1-1");
    expect(synthesisCall.task).toContain("angle1-r2-1");
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
    const count = host.launches.length, terminal = copy(host.current()), rows = storedRows(host);
    host.setLimit(4);
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 3, maxLoops: 3 });
    expect(host.launches).toHaveLength(count);
    expect(host.current()).toEqual(terminal);
    expect(storeTipRows(host)).toEqual(rows);
    expect(host.history()).toHaveLength(3);
    const exhausted = host.emits.filter(value => value.type === "execution-loop" && value.loop === 3);
    expect(exhausted).toHaveLength(2); // Terminal reentry does not read or emit another loop.
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
    const cursor = copy(host.current());
    expect(cursor.loop).toMatchObject({ number: 3, phase: "closing", outcome: null });
    expect(cursor.budget).toMatchObject({ consumedLoops: 3, maxCycles: 3 });
    expect(host.history().map((loop: { number: number }) => loop.number)).toEqual([1, 2, 3]);
    const rows = storedRows(host), calls = copy(host.launches);
    const closing = host.history()[2];
    expect(closing.outcome).toBe("gaps");
    expect(closing.observation.checkout).toEqual(host.observedCandidate());
    const action = cursor.action;
    if (mode === "adversarial") {
      const key = "invoke-human-1.l3.review.director-synthesis";
      const original = closing.integratedReview.originals.find((entry: { key: string }) => entry.key === key);
      expect(action).toMatchObject({ kind: "launched", role: "reviewer", key, runId: original.runId });
      expect(readReviewOriginal(original)).toEqual(host.native.get(key)!.structuredOutput);
      expect(calls.some(call => call.key === "invoke-human-1.l3.compliance")).toBe(false);
    }
    const usage = atCursor(host).P.preview.usage;
    host.setFailSave(); host.advance(10000);
    const recovered = await host.execute();
    const replayKey = mode === "adversarial" ? "invoke-human-1.l3.checkout.closing-replay.r1" : `${action.key}.closing-replay.r1`;
    expect(recovered, host.native.get(replayKey)?.output ?? recovered.reason).toMatchObject({ status: "partial", loopsConsumed: 3, maxLoops: 3 });
    expect(host.launches.slice(0, calls.length)).toEqual(calls);
    expect(host.launches.slice(calls.length).map(call => call.key)).toEqual([replayKey]);
    expect(host.history().map((loop: any) => loop.number)).toEqual([1, 2, 3]);
    expect(host.current().action.kind).toBe("terminal");
    expect(storedRows(host).slice(0, rows.length)).toEqual(rows);
    expect(atCursor(host).P.preview.usage).toEqual(usage);
    expect(recovered.tokens).toEqual(output.tokens);
    // The single replay admission advances the fixture clock by 10 ms.
    expect(recovered.elapsedMs).toBe(output.elapsedMs + 10010);
    expect(recovered.loopReport.elapsedMs).toBe(output.loopReport.elapsedMs + 10010);
    expect(host.launches.filter(call => call.agent === "pitako.checkout-observer")).toEqual(calls.filter(call => call.agent === "pitako.checkout-observer"));
    expect(host.history()[2]).toEqual(closing);
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
    if (phase === "published" || phase === "admitted") host.setSaveObserver(value => {
      const { action } = value;
      if (action.kind === "launched" && (phase === "published"
        ? action.role === "execution-director" && action.runId === host.native.get(action.key)?.runId
        : action.role === "worker" && action.runId === null))
        throw Error("Cut after recorded action save");
    });
    else cutAt(host, value => value.loop?.number === 1 && value.loop.cursor === 1);
    const first = await host.execute(); expect(first.reason).toContain("Essential persistence failed");
    const firstWorkers = host.calls.filter(call => call.agent === "pitako.worker").length;
    expect(firstWorkers).toBe(phase === "result-before-cursor" ? 1 : 0);
    host.setFailSave(); host.setSaveObserver(undefined); host.advance(10000);
    const resumed = await host.execute();
    expect(resumed.status, resumed.reason).toBe("complete");
    expect(host.history()).toHaveLength(2);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(2);
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(atCursor(host).P.prompt.admission!.startedAt).toBe(1000);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
  });

  test.each(["direct-values", "direct-conflict", "absent-binding", "absent-witness", "committed-selection", "lost-definition", "changed-binding", "changed-native", "changed-selection"])("recovery distinguishes %s using full originals and exact refs", async mode => {
    const host = fixture(undefined, { readOnly: true });
    const director = "invoke-human-1.l1.director", selection = "invoke-human-1.l1.selectionIO";
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === director && ["direct-values", "direct-conflict", "changed-binding"].includes(mode)) {
        const binding = copy(result.structuredOutput);
        if (mode === "direct-conflict") binding.reason = "conflicting-native-binding";
        if (mode === "changed-binding") binding.changes = [];
        result.output = JSON.stringify(binding);
      }
      return result;
    });
    const committed = mode === "committed-selection";
    if (committed) host.setFailSave(() => host.native.has(selection));
    else host.setSaveObserver(cursor => {
      if (cursor.action.key === director && cursor.action.runId)
        throw Error("Cut after retaining the settled director");
    });
    const cut = await host.execute();
    expect(cut.status).toBe("partial");
    expect(cut.reason).toContain("Essential persistence failed");
    host.setSaveObserver(undefined);
    host.setFailSave();
    const original = host.native.get(director)!;
    const retained = copy(host.current());
    expect(retained.action).toMatchObject({ kind: "launched", key: director, runId: original.runId });
    const artifact = original.results![0]!.savedOutputPath!;
    if (committed || mode === "lost-definition") rmSync(artifact);
    if (committed) {
      // A committed selection is authoritative even if its director's original file disappears.
      expect(storeTipRows(host).some(row => row.opKey === `operation:${selection}`)).toBe(true);
    }
    if (mode === "changed-native" || mode === "changed-selection")
      writeFileSync(artifact, JSON.stringify({ ...original.structuredOutput,
        ...(mode === "changed-native" ? { reason: "changed-but-same-selection" } : { select: "unknown-task" }) }));
    if (mode === "absent-witness") host.setStatus(ref => ref === original.runId
      ? { ok: true, runId: ref, output: `Run: ${ref}\nState: complete`, results: [] }
      : copy(host.native.get(ref) ?? { ok: false, state: "unknown", results: [] }));
    const count = host.launches.length;
    const output = await host.execute();
    expect(host.statusCalls).toContain(original.runId!);
    expect(host.launches[count]).toMatchObject({ agent: "pitako.loop-selection", key: `${selection}.r1` });
    expect(host.launches.filter(call => call.key === director)).toHaveLength(1);
    expect(host.launches.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    if (["direct-conflict", "changed-binding", "changed-native", "changed-selection", "lost-definition"].includes(mode)) {
      expect(output.status).toBe("blocked");
      expect(output.reason).toContain("Director selection integrity failure");
      expect(host.launches.slice(count).map(call => call.key)).toEqual([`${selection}.r1`]);
      expect(host.current()).toEqual(retained);
      expect(readBacklog(host.root, "spec").backlog).toBeNull();
    } else {
      expect(output.status, output.reason).toBe("complete");
      expect(host.launches.filter(call => call.agent === "pitako.worker").map(call => call.key))
        .toEqual(["invoke-human-1.l1.t1.a1"]);
      expect(host.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", status: "complete" }));
      expect(storedRows(host).filter(row => row.opKey === `operation:${selection}`)).toHaveLength(1);
    }
  });

  test.each(["running", "queued", "pending", "detached", "recovery", "stopped", "permission", "management"])("unresolved writer %s cannot be blindly redispatched or replaced in another slot", async mode => {
    const host = fixture(undefined, { readOnly: true });
    const key = "invoke-human-1.l1.t1.a1";
    cutAfterOriginal(host, key);
    expect((await host.execute()).reason).toContain("Essential persistence failed"); host.setFailSave();
    const saved = copy(host.current());
    expect(saved.loop.attempt.stage).toBe("launched");
    expect(saved.action).toMatchObject({ kind: "launched", role: "worker", key, runId: null });
    expect(storedRows(host).find(row => row.seq === saved.loop.attempt.intent.seq)).toMatchObject({
      kind: "intent", digest: saved.loop.attempt.intent.digest, body: { key },
    });
    host.setStatus(ref => {
      if (!ref.includes(".t1.a1")) return copy(host.native.get(ref) ?? { ok: true, results: [] });
      if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
      if (mode === "management") return { ok: true, results: [], output: `Run: ${ref}\nState: running\nMode: single` };
      return { ok: true, state: ["running", "queued", "pending"].includes(mode) ? mode : undefined, [mode]: true };
    });
    const output = await host.execute(); expect(["blocked", "cancelled"]).toContain(output.status);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    expect(host.statusCalls).toContain(key);
    expect(host.current()).toEqual(saved);
    expect(host.history()).toHaveLength(0);
  });

  test("missing writer inventory continues only through checkpoint-first restoration of the selected task", async () => {
    const host = fixture(undefined, { realCheckout: true, readOnly: true }); host.setLimit(1);
    const first = "invoke-human-1.l1.t1.a1", successor = "invoke-human-1.l1.t1.a2";
    cutAfterOriginal(host, first);
    expect((await host.execute()).reason).toContain("Essential persistence failed"); host.setFailSave();
    const cut = copy(host.current()), prefix = storedRows(host, cut), admissions = host.launches.length;
    expect(cut.action).toMatchObject({ kind: "launched", role: "worker", key: first, runId: null });
    expect(readExecuteIntentContext(host.root, cut).intent).toMatchObject({ key: first, taskId: "change1", attempt: 1 });
    host.setStatus(ref => ref.includes(".t1.a1") ? { ok: true, results: [] } : copy(host.native.get(ref)!));
    host.setRespond((request, normal) => {
      if (request.key === successor) {
        expect(request.task).toContain(`"key":"${first}"`);
        restoreRecordedAttempt(host, request.key, first);
      }
      return normal();
    });
    const output = await host.execute();
    expect(output.status, output.reason).toBe("partial");
    expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
      .toEqual([first, successor]);
    const replay = host.launches.slice(admissions).filter(call => call.key.startsWith(`${first}.`));
    expect(replay.map(({ key, agent }) => ({ key, agent }))).toEqual([
      { key: `${first}.selection-replay.r1`, agent: "pitako.loop-selection" },
    ]);
    expect(JSON.parse(replay[0]!.task)).toMatchObject({
      expectedHead: cut.head, refs: { input: cut.action.input, uncertainWorker: cut.loop.attempt.intent },
    });
    expect(storedRows(host).slice(0, prefix.length)).toEqual(prefix);
    expect(storedRows(host).filter(row => row.kind === "intent" && (row.body as CheckpointIntent).key === first))
      .toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.calls.some(call => call.resume)).toBe(false);
    expect(host.history()[0]?.results).toContainEqual(expect.objectContaining({ taskId: "change1", status: "complete" }));
    expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
    expect(host.history()).toHaveLength(1);
  });

  test("dispatch-before-result can reconcile the exact settled original, without calling the writer key again", async () => {
    const host = fixture();
    const key = "invoke-human-1.l1.t1.a1";
    cutAfterOriginal(host, key);
    expect((await host.execute()).reason).toContain("Essential persistence failed"); host.setFailSave();
    const count = host.launches.length;
    const output = await host.execute();
    expect(output.status, output.reason).toBe("complete");
    expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key)).toEqual([key]);
    expect(host.statusCalls).toContain(key);
    expect(host.launches.slice(count).filter(call => call.key.startsWith(`${key}.recover`)).map(call => call.key)).toEqual([`${key}.recover.r1`]);
    expect(host.history()[0].results[0].ref).toMatchObject({ key, runId: host.native.get(key)!.runId });
  });

  test("native status may echo its queried run ID without changing the frozen dispatch or original report", async () => {
    const host = fixture();
    const key = "invoke-human-1.l1.t1.a1";
    cutAt(host, value => value.action.kind === "pending" && value.action.op === "gate" && value.action.opKey === `${key}.gate`);
    expect((await host.executeNative()).reason).toContain("Essential persistence failed");
    const original = copy(host.native.get(key)!);
    host.setFailSave();
    host.setStatus(ref => host.native.has(ref) ? { ...copy(host.native.get(ref)!), key: ref } : { ok: true, results: [] });
    expect((await host.executeNative()).status).toBe("complete");
    expect(host.statusCalls).toContain(original.runId!);
    expect(host.calls.filter(call => call.key === key)).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.history()[0].results[0].ref).toMatchObject({ key, runId: original.runId });
    expect(host.native.get(key)).toEqual(original);
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
          expect(host.current().action).toMatchObject({ kind: "launched", role: "execution-inspector", key: request.key });
          expect(request.task).toContain(original.runId);
          Object.assign(result.structuredOutput, { status: "recovered", original: copy(original.structuredOutput),
            originalAvailable: true, binding: "absent", comparison: "only-original" });
        }
        return result;
      });
      host.setStatus(ref => ref === original?.runId || ref === "invoke-human-1.l1.director"
        ? mode === "native-original" ? copy(original) : { ok: true, results: [] } : copy(host.native.get(ref)!));
      const output = await host.executeNative();
      expect(output.status, output.reason).toBe("complete");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector"))
        .toHaveLength(mode === "native-original" ? 0 : 1);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
      expect(host.history()[0].plan.stage).toBe("admitted");
      expect(host.history()[0].results[0]).toMatchObject({ taskId: "change1", status: "complete" });
      expect(host.history()).toHaveLength(2);
      expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(true);
    },
  );

  test.each(["none", "before-intent", "before-launch", "before-result", "before-cursor", "after-cursor"])(
    "a missing worker report uses checkpoint-first continuation across %s without an inspector or repeated writer", async cut => {
      const host = fixture(undefined, { realCheckout: true, readOnly: true });
      const initial = "invoke-human-1.l1.t1.a1", restored = "invoke-human-1.l1.t1.a2";
      host.setRespond((request, normal) => {
        if (request.key === initial) {
          host.worker(request); // Capture real preimages without publishing a worker report.
          return { ok: false, output: "", error: "Writer report unavailable" };
        }
        if (request.key === restored) {
          const receipt = restoreRecordedAttempt(host, request.key, initial);
          const restoredRef = receipt.partialRef.replace(/restore\.json$/, "restored.json");
          return host.result(request, { ...host.worker(request), restoreReceipt: { ...receipt, restoredRef } });
        }
        return normal();
      });
      if (cut !== "none") cutAt(host, value => {
        const loop = value.loop;
        const action = value.action;
        return cut === "before-intent" ? loop?.attempt?.number === 2 && loop.attempt.stage === "intention"
          : cut === "before-launch" ? action.kind === "launched" && action.key === restored && action.runId === null
          : cut === "before-result" ? host.native.has(restored)
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
      expect(output.status, output.reason).toBe("complete");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
      expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
        .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
      expect(host.history()[0].results.find((entry: any) => entry.taskId === "change1").status).toBe("complete");
      expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
      expect(host.calls.some(call => call.key.endsWith("review.director-prepare"))).toBe(true);
      expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(true);
      expect(host.current().budget).toMatchObject({ maxCycles: 3, consumedLoops: 2 });
    },
  );

  test("an uncertain inspector launch cannot authorize a replacement observation", async () => {
    const host = fixture(undefined, { readOnly: true });
    host.setRespond((request, normal) => request.key.endsWith(".director")
      ? { ...normal(), structuredOutput: undefined } : normal());
    const setter = host.state.set;
    host.state.set = async (key, value: any) => {
      await setter(key, value);
      if (value.action?.kind === "launched" && value.action.role === "execution-inspector" &&
          value.action.runId === null)
        throw Error("Controlled interruption after committed intent");
    };
    const interrupted = await host.execute();
    expect(interrupted.reason).toContain("Controlled interruption after committed intent");
    expect(host.current().action).toMatchObject({ kind: "launched", role: "execution-inspector", runId: null });
    host.state.set = setter;
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    expect(output.reason).toContain("invoke-human-1.l1.recover1");
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
    expect(host.history()).toHaveLength(0);
  });

  test("unresolved published plan retains scope impediment without replacement dispatch", async () => {
    const host = fixture();
    const reason = "Actor: artifact owner. Exact binding unreadable. Expansion needed: grant read access to that binding; do not change permissions here.";
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
      const inspector = host.native.get("invoke-human-1.l1.recover1")!;
      expect(host.current().action).toMatchObject({
        kind: "launched", role: "execution-inspector", key: "invoke-human-1.l1.recover1", runId: inspector.runId,
      });
      expect(inspector.structuredOutput).toMatchObject({ status: "unresolved", reason,
        provenance: ["/native/binding/invoke-human-1.l1.director.json"] });
      expect(host.current().halt).toEqual({ stage: "recovery", digest: canonicalDigest(output.loopReport.halt) });
      expect(executeField(atCursor(host).P.control, "ledger")).toEqual({ count: 0, head: null });
      expect(host.history()).toHaveLength(0);
      expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
    }
    const inspector = host.native.get("invoke-human-1.l1.recover1")!;
    const calls = host.launches.length, retained = copy(host.current());
    const forged = "Unverified replacement impediment";
    writeFileSync(inspector.results![0]!.savedOutputPath!, JSON.stringify({ ...inspector.structuredOutput, reason: forged }));
    const conflicted = await host.executeNative();
    expect(conflicted.status).toBe("blocked");
    expect(String(conflicted.reason)).toContain("Conflicting complete retained analysis originals");
    expect(String(conflicted.reason)).not.toContain(forged);
    expect(host.current()).toEqual(retained);
    expect(host.launches).toHaveLength(calls);
  });

  test("committed selection supplies the admitted plan after loss of its optional native body", async () => {
    const host = fixture(); host.setLimit(1);
    cutAt(host, value => value.loop?.phase === "implementation");
    const interrupted = await host.executeNative();
    expect(interrupted.reason).toContain("Essential persistence failed");
    host.setFailSave();
    const directorKey = "invoke-human-1.l1.director";
    const director = host.native.get(directorKey)!;
    const committed = storeTipRows(host).find(row => row.opKey === "operation:invoke-human-1.l1.selectionIO")!;
    expect(committed).toMatchObject({ kind: "operation", body: {
      operation: "selection", request: { plan: { ref: { key: directorKey, runId: director.runId } } },
    } });
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
    const count = host.launches.length;
    rmSync(director.results![0]!.savedOutputPath!);
    host.setStatus(ref => ref === director.runId ? { runId: ref, ok: true, results: [],
      output: `Run: ${ref}\nState: complete` } : copy(host.native.get(ref) ?? { ok: true, state: "unknown" }));
    const resumed = await host.executeNative();
    expect(resumed.status, resumed.reason).toBe("partial");
    expect(host.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", status: "complete" }));
    expect(storedRows(host).filter(row => row.opKey === committed.opKey)).toEqual([committed]);
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.launches.slice(count).filter(call => call.key.includes(".selectionIO")).map(call => call.key))
      .toEqual(["invoke-human-1.l1.selectionIO.committed.r1"]);
    expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
      .toEqual(["invoke-human-1.l1.t1.a1"]);
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
      const saved = copy(host.current());
      const rows = storedRows(host);
      const inspector = host.calls.find(call => call.agent === "pitako.execution-inspector")!;
      expect(saved.action).toMatchObject({ kind: "launched", role: "execution-inspector", key: inspector.key });
      host.setStatus(ref => ({ ...copy(host.native.get(ref)!), key: "renamed-query" }));
      expect((await host.executeNative()).status).toBe("blocked");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
      expect(host.history()).toHaveLength(0);
      expect(host.current()).toEqual(saved);
      expect(storeTipRows(host)).toEqual(rows);
      expect(host.current().budget.maxCycles).toBe(3);
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
    const firstKey = "invoke-human-1.l1.t1.a1";
    cutAfterOriginal(host, firstKey);
    expect((await host.execute()).reason).toContain("Essential persistence failed"); host.setFailSave();
    expect(host.current().action).toMatchObject({ kind: "launched", role: "worker", key: firstKey, runId: null });
    host.setRespond((request, normal) => {
      if (request.key === "invoke-human-1.l1.t1.a2") {
        restoreRecordedAttempt(host, request.key);
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
    expect(output.status, output.reason).toBe(active ? "blocked" : "complete");
    expect(host.statusCalls).toContain(firstKey);
    expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key.endsWith(".t1.a1"))).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(active ? 1 : 2);
    if (active) expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.filter(call => call.key.includes(".recover"))).toHaveLength(0);
  });

  test.each([["plan", "stopped"], ["writer", "stopped"], ["plan", "interrupted"], ["writer", "interrupted"]])("observed %s recovery %s preserves barriers without repeating work", async (phase, signal) => {
    const host = fixture(undefined, { realCheckout: true, readOnly: true });
    const kind = phase === "plan" ? "loop-plan" : "attempt-result";
    host.setRespond((request, normal) => {
      if (phase === "plan" && request.key.endsWith(".director")) return { ...normal(), structuredOutput: undefined };
      if (phase === "writer" && request.key.endsWith(".t1.a1"))
        return { ...normal(), ok: false, state: "interrupted", structuredOutput: undefined, results: [] };
      return (phase === "plan" ? request.phase === "recovery" && request.task.includes(`\n\nEXCEPTIONAL READ-ONLY ${kind}`) : request.key === "invoke-human-1.l1.t1.a2")
        ? { ...normal(), ok: false, [signal]: true } : normal();
    });
    const technicalInterruption = phase === "writer" && signal === "interrupted";
    const output = await host.execute();
    expect(output.status, output.reason).toBe(technicalInterruption ? "partial" : "cancelled");
    if (technicalInterruption) {
      expect(output.reason).toContain("Restoration remains pending with no new checkpoint evidence");
      const workers = host.calls.filter(call => call.agent === "pitako.worker"), cursor = copy(host.current());
      const before = storedRows(host), calls = host.launches.length, observations = host.statusCalls.length;
      expect(cursor.action).toMatchObject({ kind: "launched", role: "worker", op: "baseline",
        key: "invoke-human-1.l1.t1.a2", runId: host.native.get("invoke-human-1.l1.t1.a2")!.runId });
      const intent = before.find(row => row.seq === cursor.loop.attempt.intent.seq)!;
      expect(intent).toMatchObject({ kind: "intent", digest: cursor.loop.attempt.intent.digest,
        body: { key: cursor.action.key, attempt: 2 } });
      const replay = await host.execute();
      expect(replay).toMatchObject({ status: "partial", loopsConsumed: output.loopsConsumed, reason: output.reason });
      expect(host.statusCalls.slice(observations)).toContain(cursor.action.runId);
      const repeated = host.launches.slice(calls).filter(call => call.agent === "pitako.request-observer");
      expect(repeated).toHaveLength(1);
      expect(host.launches.slice(0, calls)).toContainEqual(repeated[0]!);
      expect(host.launches.slice(calls).filter(call => call.agent !== "pitako.request-observer").map(({ key, agent }) => [key, agent])).toEqual([
        ["invoke-human-1.l1.t1.a2.baseline-replay.r1", "pitako.loop-baseline"],
      ]);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toEqual(workers);
      expect(host.current()).toEqual(cursor);
      expect(storeTipRows(host)).toEqual(before);
    }
    expect(host.calls.some(call => phase === "plan" ? call.phase === "recovery" && call.task.includes(`\n\nEXCEPTIONAL READ-ONLY ${kind}`) : call.key === "invoke-human-1.l1.t1.a2")).toBe(true);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(phase === "plan" ? 0 : 2);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    expect(host.current().halt?.digest).toBe(canonicalDigest(output.loopReport.halt));
  });



  test.each(["plan", "writer"])("native rejected %s status preserves causal cancellation, not its error wording", async phase => {
    const host = fixture();
    const child = phase === "plan" ? "invoke-human-1.l1.director" : "invoke-human-1.l1.t1.a1";
    host.setSaveObserver(value => {
      if (phase === "plan" ? value.action.key === child && value.action.runId
        : value.action.opKey === `${child}.gate` && value.inFlight.some((ref: { key: string }) => ref.key === child))
        throw Error("Cut after native producer was recorded");
    });
    expect((await host.execute()).reason).toContain("Essential persistence failed");
    host.setSaveObserver(undefined);
    const runId = host.native.get(child)!.runId;
    if (phase === "plan") expect(host.current().action).toMatchObject({ key: child, runId });
    else expect(host.current().inFlight).toContainEqual({ key: child, runId, role: "worker" });
    host.setStatus(ref => {
      if (ref !== runId && ref !== child) {
        const settled = copy(host.native.get(ref)!);
        return { ...settled, output: JSON.stringify(settled.structuredOutput) };
      }
      return { ok: false, results: [], output:
        `Status target: run ${ref}\nSpawn budget: unlimited\nActive async capacity: 0/unlimited used\nRun: ${ref}\nState: stopped\nMode: single` };
    });
    const output = await host.executeNative();
    expect(output.status).toBe("cancelled");
    expect(output.reason).toBe("Positive native barrier: stopped");
    expect(host.statusCalls).toContain(runId!);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(phase === "plan" ? 0 : 1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
  });

  test.each(["stopped", "interrupted", "remembered-stop", "remembered-interruption", "permission"])("exact native status %s is classified without reattachment", async mode => {
    const host = fixture(undefined, { realCheckout: true, readOnly: true });
    const worker = "invoke-human-1.l1.t1.a1";
    cutAfterOriginal(host, worker);
    expect((await host.execute()).reason).toContain("Essential persistence failed"); host.setFailSave();
    const saved = copy(host.current()), before = host.launches.length;
    expect(saved.action).toMatchObject({ kind: "launched", role: "worker", key: worker, runId: null });
    expect(readExecuteIntentContext(host.root, saved).intent.key).toBe(worker);
    host.setRespond((request, normal) => {
      if (request.key === "invoke-human-1.l1.t1.a2") restoreRecordedAttempt(host, request.key);
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
    if (interruption) {
      expect(host.launches.slice(before).filter(call => call.key.startsWith(`${worker}.`) && call.key.endsWith(".r1"))
        .map(call => ({ key: call.key, agent: call.agent }))).toEqual([
        { key: `${worker}.selection-replay.r1`, agent: "pitako.loop-selection" },
      ]);
      expect(host.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", attempt: 2, status: "complete" }));
    } else {
      expect(host.launches).toHaveLength(before);
      expect(host.current()).toEqual(saved);
    }
    expect(host.calls.some(call => call.key.endsWith(".resume"))).toBe(false);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(interruption ? 2 : 1);
  });

  test("model reason cannot impersonate an observed native cancellation", async () => {
    const host = fixture(undefined, { realCheckout: true, readOnly: true });
    cutAfterOriginal(host, "invoke-human-1.l1.t1.a1");
    expect((await host.execute()).reason).toContain("Essential persistence failed"); host.setFailSave();
    host.setRespond((request, normal) => {
      if (request.key === "invoke-human-1.l1.t1.a2") restoreRecordedAttempt(host, request.key);
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
    const host = fixture(), key = "invoke-human-1.l1.t1.a1";
    cutAfterOriginal(host, key);
    expect((await host.execute()).reason).toContain("Essential persistence failed"); host.setFailSave();
    host.setStatus(ref => ref.includes(".t1.a1") ? { ok: true, state: "running" } : copy(host.native.get(ref)!));
    expect((await host.execute()).status).toBe("blocked");
    const observations = host.statusCalls.length;
    const count = host.calls.filter(call => call.agent === "pitako.worker").length;
    host.setStatus(ref => copy(host.native.get(ref) ?? { ok: true, results: [] }));
    expect((await host.execute()).status).toBe("complete");
    expect(host.statusCalls.slice(observations)).toContain(key);
    expect(host.calls.filter(call => call.key === key)).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(count);
  });

  test.each(["same", "changed"])("reused result is phase/candidate aware for %s candidate, not an automatic veto or success", async mode => {
    const host = fixture(undefined, { realCheckout: true, taskCount: 0 }); host.setLimit(1);
    host.setRespond((request, normal) => ({ ...normal(), reused: true }));
    cutAfterOriginal(host, "invoke-human-1.l1.checkout");
    expect((await host.execute()).reason).toContain("Essential persistence failed");
    const keys = host.launches.map(call => call.key), published = storeTipRows(host);
    host.setFailSave();
    if (mode === "changed") host.changeCheckout();
    const replay = await host.execute();
    expect(replay).toMatchObject({ status: mode === "changed" ? "partial" : "complete", loopsConsumed: 1, maxLoops: 1 });
    expect(replay.loopReport.verification.compliance.status).toBe(mode === "changed" ? "stale" : "fulfilled");
    expect(host.launches.map(call => call.key)).toEqual([...keys, "invoke-human-1.l1.compliance.closing-replay.r1"]);
    expect(storedRows(host).slice(0, published.length)).toEqual(published);
  });

  test("replay of already completed review/compliance does not rerun gates or double tokens after a closing persistence cut", async () => {
    const host = fixture(undefined, { taskCount: 0 }); cutAt(host, value => value.action.kind === "terminal");
    const first = await host.execute();
    expect(first.status).toBe("partial");
    expect(first.reason).toContain("Essential persistence failed");
    const retained = host.current(), rows = storeTipRows(host), keys = host.launches.map(call => call.key);
    expect(retained.action).toMatchObject({ kind: "launched", key: "invoke-human-1.l1.compliance" });
    host.setFailSave();
    const replay = await host.execute();
    expect(replay.status, replay.reason).toBe("complete");
    expect(host.launches.map(call => call.key)).toEqual([...keys, "invoke-human-1.l1.compliance.closing-replay.r1"]);
    expect(replay.tokens).toEqual(first.tokens);
    expect(storedRows(host).slice(0, rows.length)).toEqual(rows);
    expect(host.current().action.kind).toBe("terminal");
    expect(host.records().map((record: { kind: string }) => record.kind)).toEqual(["spec", "loop"]);
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.checkout")).toHaveLength(1);
  });

  test("candidate changed after closing persistence cut invalidates cached gates without a second close in that loop", async () => {
    const host = fixture(undefined, { realCheckout: true, taskCount: 0 }); cutAt(host, value => value.action.kind === "terminal");
    const output = await host.execute();
    expect(output.status).toBe("partial"); expect(output.reason).toContain("Essential persistence failed");
    const published = storeTipRows(host).reverse().find(row => row.kind === "ledger")!;
    expect(published).toBeDefined();
    host.setFailSave(); host.changeCheckout();
    expect((await host.execute()).status).toBe("complete");
    expect(host.history()).toHaveLength(2);
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.checkout")).toHaveLength(1);
    expect(storedRows(host).find(row => row.seq === published.seq)).toEqual(published);
    expect(host.history()[0].observation.checkout).not.toEqual(host.history()[1].observation.checkout);
    expect(host.history()[1].observation.checkout).toEqual(host.observedCandidate());
  });

  test.each(["detached", "recovery"])("positive %s review observation survives the shared library boundary and blocks another writer", async field => {
    const host = fixture(undefined, { taskCount: 0 }); host.setRespond((request, normal) => request.key.endsWith("director-prepare")
      ? { ...normal(), [field]: true } : normal());
    const output = await host.execute();
    expect(output.status).toBe("blocked"); expect(output.reason).toContain(field);
    expect(host.calls.filter(call => call.key.endsWith(".compliance"))).toHaveLength(0);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
    expectOpenHalt(host, output, "native-settlement");
  });

  test.each(["review", "compliance"])("native child capacity exhausted during %s preserves phase and refs without omitted phases, replacement mission or own budget", async phase => {
    const host = fixture("FULL SPEC", { findings: true, taskCount: 0 });
    host.setRespond((request, normal) => {
      if (phase === "review" ? request.key.endsWith("director-synthesis") : request.key.endsWith(".compliance"))
        throw Error("Run fan-out limit reached at root (64/64 used; 1 requested, 0 remaining). No children from this admission group were started. Start a new top-level run or raise config.maxSubagentSpawnsPerRun.");
      return normal();
    });
    const output = await host.execute(); expect(output.status).toBe("partial"); expect(output.loopsConsumed).toBe(1);
    expect(output.phase).toBe(phase); expect(output.reason).toContain("Run fan-out limit reached");
    const halt = expectOpenHalt(host, output);
    expect(halt.code).toBe("capacity");
    expect(output.loopReport.next).not.toContain("continue loop");
    const gate = host.native.get("invoke-human-1.l1.acceptance.gate")!;
    expect(gate.ok).toBe(true);
    expect(JSON.parse(gate.output!).gates).toMatchObject([{ id: "full", status: "pass" }]);
    if (phase === "review") expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
    const count = host.calls.length, cursor = copy(host.current());
    const replay = await host.execute();
    expect(replay.status).toBe("partial"); expect(replay.reason).toBe(output.reason);
    expect(replay.phase).toBe(phase); expect(replay.loopsConsumed).toBe(1);
    expect(replay.loopReport.halt).toEqual(halt);
    expect(replay.loopReport.pending[0].references).toContainEqual(halt.ref);
    expect(host.current()).toEqual(cursor); expect(host.calls).toHaveLength(count);
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
    const halt = expectOpenHalt(host, output);
    expect(halt.code).toBe("semantic-block");
    const phaseKey = `invoke-human-1.l1.${phase === "compliance" ? "" : "review."}${phase}`;
    const native = host.native.get(phaseKey)!;
    const path = native.results![0]!.savedOutputPath ?? native.results![0]!.structuredOutputPath!;
    expect(path).toEndWith(`${phaseKey}.json`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(native.structuredOutput);
    expect(host.current().action).toMatchObject({ kind: "launched", key: phaseKey, runId: native.runId });
    const cursor = copy(host.current()), rows = storedRows(host);
    const calls = host.calls.length, replay = await host.execute();
    expect(replay.reason).toBe(output.reason); expect(replay.status).toBe("blocked");
    expect(replay.phase).toBe(output.phase); expect(replay.loopsConsumed).toBe(1);
    // Reference-only synthesis revalidates its required originals without a verifier child.
    expect(host.calls).toHaveLength(calls);
    expect(expectOpenHalt(host, replay)).toEqual(halt);
    expect(host.current()).toEqual(cursor);
    expect(storeTipRows(host)).toEqual(rows);
    if (phase === "director-synthesis") {
      const original = host.calls.find(call => call.key === "invoke-human-1.l1.review.verify-synthesis")!;
      const { items } = JSON.parse(original.task);
      expect(items).toHaveLength(cursor.review.slots.filter((slot: { key: string }) => slot.key.includes(".independent-")).length);
      for (const item of items) {
        const slot = cursor.review.slots.find((slot: { key: string }) => slot.key === item.key);
        expect(item.digest).toBe(slot.digest);
        expect(canonicalDigest(JSON.parse(readFileSync(item.path, "utf8")))).toBe(slot.digest);
      }
      writeFileSync(items[0].path, JSON.stringify({ changed: true }));
      const rejected = await host.execute();
      expect(rejected.status).toBe("blocked");
      expect(rejected.reason).toContain("Conflicting complete retained analysis originals");
      expect(host.calls).toHaveLength(calls);
      expect(host.current()).toEqual(cursor);
      expect(storeTipRows(host)).toEqual(rows);
    }
  });

  test.each(["director", "worker", "review", "compliance"])("returned native capacity receipt at %s retains its actual run reference", async phase => {
    const reason = "Active async run capacity exhausted: 4/4 used.";
    const host = fixture(undefined, { taskCount: phase === "director" || phase === "worker" ? 1 : 0 });
    const suffix = phase === "review" ? "review.director-prepare" : phase === "worker" ? "t1.a1" : phase;
    host.setRespond((request, normal) => request.key.endsWith(suffix)
      ? { ...normal(), ok: false, error: reason } : normal());
    const output = await host.execute();
    expect(output.status).toBe("partial"); expect(output.reason).toContain(reason);
    const halt = expectOpenHalt(host, output);
    const key = `invoke-human-1.l1.${suffix}`;
    expect(halt).toMatchObject({ code: "capacity", reason,
      ref: { key, runId: host.native.get(key)!.runId } });
    const count = host.calls.length, replay = await host.execute();
    expect(replay.loopReport.halt).toEqual(halt);
    expect(replay.loopReport.pending[0].references).toContainEqual(halt.ref);
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
    const halt = expectOpenHalt(host, output), cursor = copy(host.current());
    expect(halt).toMatchObject({ code: "capacity", ref: { key: "invoke-human-1.l1.compliance" } });
    expect(cursor.action).toMatchObject({ kind: "launched", key: halt.ref.key, runId: null });
    const launches = copy(host.launches), rows = storeTipRows(host);
    const replay = await host.executeNative();
    expect(replay.reason).toBe(reason);
    expect(replay.loopReport.halt).toEqual(halt);
    expect(replay.loopReport.pending[0].references).toEqual([halt.ref]);
    expect(host.launches).toEqual(launches);
    expect(host.current()).toEqual(cursor);
    expect(storeTipRows(host)).toEqual(rows);
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
    expect(expectOpenHalt(host, output).code).toBe("semantic-block");
  });

  test.each(["director-prepare", "independent-angle1-r1"])("thrown native permission receipt at %s crosses the shared review boundary as a barrier", async phase => {
    const host = fixture(undefined, { taskCount: 0 });
    host.setRespond((request, normal) => {
      if (request.key.endsWith(phase)) throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      return normal();
    });
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    expect(expectOpenHalt(host, output, "permission")).toMatchObject({ code: "native-barrier", cause: "native permission denial" });
    expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
  });

  test("arbitrary native exception words are incomplete dispatch evidence, not a capacity certificate", async () => {
    const host = fixture(undefined, { taskCount: 0 });
    const reason = "Investigate timeout, capacity, spawn and budget diagnostics ".padEnd(360, "界");
    host.setRespond((request, normal) => {
      if (request.key.endsWith(".compliance")) throw Error(reason + "not retained");
      return normal();
    });
    const output = await host.execute();
    expect(output.status).toBe("partial");
    expect(expectOpenHalt(host, output)).toMatchObject({ code: "native-dispatch", reason });
    const count = host.calls.length, rows = storeTipRows(host);
    expect((await host.execute()).reason).toBe(reason);
    const cursor = copy(host.current());
    cursor.halt.reason = "changed diagnostic";
    host.storage.set("pitako-execute", cursor);
    const rejected = await host.execute();
    expect(rejected.status).toBe("blocked");
    expect(rejected.reason).toContain("halt digest integrity mismatch");
    expect(host.calls).toHaveLength(count);
    expect(host.current()).toEqual(cursor);
    expect(storeTipRows(host)).toEqual(rows);
  });

  test.each(["worker-stop", "review-stop", "permission", "timeout"])("native %s is not green or an inferred invocation timeout cancellation", async mode => {
    const host = fixture(undefined, { realCheckout: true, readOnly: true, taskCount: mode === "review-stop" ? 0 : 1 }); host.setRespond((request, normal) => {
      if (request.agent === "pitako.worker" && request.key.endsWith(".a2") && mode === "timeout") {
        restoreRecordedAttempt(host, request.key, "invoke-human-1.l1.t1.a1");
      }
      if (mode === "review-stop" && request.key.endsWith("director-prepare")) return { ...normal(), ok: false, stopped: true, error: "Observed Stop" };
      if (request.agent === "pitako.worker" && request.key.includes(".l1.")) {
        if (mode === "worker-stop") return { ...normal(), ok: false, stopped: true };
        if (mode === "permission") return { ...normal(), ok: false, error: "Blocked by pi-subagents permission rule: 'run' is denied." };
        if (mode === "timeout" && request.key.endsWith(".a1")) return { ...normal(), ok: false, terminalOutcome: { state: "partial", reason: "timeout" }, error: "Native deadline" };
      } return normal();
    });
    const output = await host.execute();
    expect(output.status, output.reason).toBe(mode.endsWith("stop") ? "cancelled" : mode === "timeout" ? "complete" : "blocked");
    if (mode === "timeout") expect(output.loopsConsumed).toBe(2);
    else expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
  });


  test.each(["before-director", "before-worker", "after-result"])("essential state failure %s halts dispatch at the retained cursor head", async phase => {
    const host = fixture(); host.storage.set("history", { retained: true });
    const worker = "invoke-human-1.l1.t1.a1";
    cutAt(host, value => phase === "before-director" ? value.action.role === "execution-director" :
      phase === "before-worker" ? value.action.role === "worker" && value.action.runId === null :
        !!host.native.get(worker));
    const output = await host.execute(); expect(output.status).toBe("partial"); expect(output.reason).toContain("Essential persistence failed");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(phase === "after-result" ? 1 : 0);
    const cursor = host.current();
    expect(atCursor(host).P.prompt.admission!.association.digest).toBe(digest("COMPLETE IMMUTABLE SPECS"));
    expect(host.storage.get("history")).toEqual({ retained: true });
    expect(host.records().filter((record: { kind: string }) => record.kind === "unit")).toEqual([]);
    if (phase === "after-result") {
      expect(cursor.loop).toMatchObject({ taskId: "change1", cursor: 0, attempt: { number: 1, stage: "launched" } });
      expect(cursor.action).toMatchObject({ kind: "launched", role: "worker",
        key: worker, runId: null });
      expect(host.native.get(worker)?.runId).toBeDefined();
      expect(host.calls.some(call => call.key.startsWith(`${worker}.`) && call.phase?.startsWith("task-review"))).toBe(false);
    }
  });

  test("native envelope overflow blocks the director and does not prune unrelated state", async () => {
    const host = fixture("s".repeat(MAX_SPEC_BYTES)); host.storage.set("unrelated", { bytes: "h".repeat(MISSION_STATE_MAX_BYTES - 400) });
    const before = copy(host.storage.get("unrelated"));
    expect((await host.execute()).reason).toContain("Essential persistence failed");
    expect(host.launches.map(call => call.key)).toEqual(["invoke-human-1.l1.advance"]);
    expect(host.current()).toBeUndefined();
    expect(host.storage.get("unrelated")).toEqual(before);
  });

  test("semantic progress preserves original elapsed waits and attributable token dedup, with missing metrics unavailable not zero", async () => {
    const host = fixture(); host.setRespond((request, normal) => {
      const result = normal(); if (request.key.endsWith(".director")) host.advance(5000);
      if (request.agent === "pitako.worker") Reflect.deleteProperty(result.results![0]!, "usage");
      return result;
    });
    const output = await host.execute(); expect(output.elapsedMs).toBeGreaterThanOrEqual(5000);
    expect(output.status, output.reason).toBe("complete");
    expect(output.tokens.coverage).toBe("partial"); expect(output.tokens.value).toBeGreaterThan(0);
    const progress = host.emits.filter(value => value.type === "execution-progress");
    expect(progress[0]).toMatchObject({ invocation: "human-1", loop: 1, loopsConsumed: 1, phase: "director", tokens: { value: null, coverage: "unavailable" } });
    expect(progress.find(value => value.phase === "implementation")).toMatchObject({ taskId: "change1", attempt: 1 });
    const rows = storedRows(host), usage = atCursor(host).P.preview.usage;
    const entries: { id: string; tokens: number | null }[] =
      host.history().flatMap((loop: { usage: { id: string; tokens: number | null }[] }) => loop.usage);
    expect(entries.some(entry => entry.tokens === null)).toBe(true);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    expect(usage).toEqual({
      tokens: output.tokens.value,
      known: entries.filter(entry => entry.tokens !== null).length,
      unknown: entries.filter(entry => entry.tokens === null).length,
    });
    const count = host.launches.length;
    host.advance(10000);
    expect((await host.execute()).status).toBe(output.status);
    expect(host.launches).toHaveLength(count);
    expect(storedRows(host)).toEqual(rows);
    expect(atCursor(host).P.preview.usage).toEqual(usage);
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

  test.each(["unblock", "mission-path", "source-drift"])("rejects %s without historical rewrites or slot renewal", async mode => {
    const host = fixture(); let before: any;
    if (["mission-path", "source-drift"].includes(mode)) expect((await host.execute()).status).toBe("complete");
    before = copy(Object.fromEntries(host.storage)); const count = host.calls.length;
    const output = await host.execute(mode === "unblock" ? { unblock: true }
      : mode === "mission-path" ? { missionPath: "/guessed/path" }
      : { preliminary: { binding: "f".repeat(64) } });
    expect(output.status).toBe("blocked"); expect(host.calls).toHaveLength(count); expect(Object.fromEntries(host.storage)).toEqual(before);
  });
});


describe("checkpoint-first interrupted selected-task continuation", () => {
  test("an interrupted task restores before a fresh same-task worker and reaches final verification", async () => {
    const fx = fixture(undefined, { realCheckout: true, readOnly: true });
    fx.setRespond((request, normal) => {
      if (request.key.endsWith(".t1.a1")) return {
        ...normal(), ok: false, structuredOutput: undefined, state: "interrupted", results: [],
      };
      if (request.key.endsWith(".t1.a2")) {
        restoreRecordedAttempt(fx, request.key, "invoke-human-1.l1.t1.a1");
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
    const successor = "invoke-human-1.l1.t1.a2";
    cutAt(fx, value => cut === "after-result-save" ? value.loop.cursor === 1
      : cut === "before-restoration-launch"
        ? value.action.key === successor && value.action.kind === "launched" && value.action.runId === null
        : value.loop.attempt?.number === 2 && value.loop.attempt.stage === "result");
    fx.setRespond((request, normal) => {
      if (request.key.endsWith(".t1.a1")) return { ...normal(), ok: false, state: "interrupted", structuredOutput: undefined, results: [] };
      if (request.key === successor) restoreRecordedAttempt(fx, request.key, "invoke-human-1.l1.t1.a1");
      return normal();
    });
    const first = await fx.executeNative();
    expect(first.status).toBe("partial");
    expect(first.reason).toContain("Essential persistence failed");
    const count = fx.launches.length;
    const retained = copy(fx.current());
    const sealPath = path.join(fx.root, ".pi/subagents/checkpoints", successor, "unit.json");
    const priorSeal = cut === "after-result-save" ? readFileSync(sealPath) : undefined;
    fx.setFailSave();
    const continued = await fx.executeNative();
    expect(continued.status, continued.reason).toBe("partial");
    expect(fx.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", attempt: 2, status: "complete" }));
    expect(fx.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
      .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
    expect(fx.calls.some(call => call.resume)).toBe(false);
    expect(fx.history()).toHaveLength(1);
    if (cut === "after-result-save") {
      expect(retained.action).toMatchObject({ kind: "launched", key: `${successor}.task-synthesis` });
      const added = fx.launches.slice(count);
      expect(added.filter(call => call.key.includes(".review-recovery")).map(call => [call.key, call.agent]))
        .toEqual([[`${successor}.task-synthesis.review-recovery.r1`, "pitako.loop-gate"]]);
      expect(added.some(call => call.agent === "pitako.checkpoint-sealer" || pitakoAgentFamily(call.agent) === "reviewer")).toBe(false);
      const result = fx.history()[0].results.find((entry: any) => entry.taskId === "change1" && entry.attempt === 2);
      expect(result.restore.receipt).toMatchObject({
        checkpointRef: path.join(fx.root, ".pi/subagents/checkpoints/invoke-human-1.l1.t1.a1/manifest.json"),
        restoredRef: path.join(fx.root, ".pi/subagents/checkpoints/invoke-human-1.l1.t1.a1/restored.json"),
      });
      expect(readFileSync(sealPath)).toEqual(priorSeal!);
    }
  });

  test.each(["running", "stopped", "permission"])(
    "a pending restoration successor observed as %s is never replaced by another key", async activity => {
    const fx = fixture(undefined, { realCheckout: true, readOnly: true }); fx.setLimit(1);
    fx.setRespond((request, normal) => {
      if (request.key.endsWith(".t1.a1")) return { ...normal(), ok: false, state: "interrupted", structuredOutput: undefined, results: [] };
      if (request.key.endsWith(".t1.a2")) {
        restoreRecordedAttempt(fx, request.key, "invoke-human-1.l1.t1.a1");
        return { ...normal(), ok: false, state: "running", structuredOutput: undefined, results: [] };
      }
      return normal();
    });
    expect((await fx.executeNative()).status).toBe("blocked");
    const key = "invoke-human-1.l1.t1.a2", runId = fx.native.get(key)!.runId;
    fx.setStatus(ref => {
      if (ref !== key && ref !== runId) return copy(fx.native.get(ref) ?? { ok: true, results: [] });
      if (activity === "permission") throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
      return { ok: true, state: activity, runId };
    });
    const callCount = fx.calls.length;
    const replay = await fx.executeNative();
    expect(replay.status, replay.reason).toBe(activity === "stopped" ? "cancelled" : "blocked");
    if (activity !== "running") {
      const halt = replay.loopReport.halt;
      expect(halt).toMatchObject({ ref: { key, runId },
        cause: activity === "stopped" ? "stopped" : "native permission denial" });
      expectOpenHalt(fx, replay, "native-barrier");
    }
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
        restoreRecordedAttempt(fx, request.key, "invoke-human-1.l1.t1.a1");
        successor = normal();
        return { ...successor, ok: false, state: "running", structuredOutput: undefined, results: [] };
      }
      return normal();
    });
    expect((await fx.executeNative()).status).toBe("blocked");
    const key = "invoke-human-1.l1.t1.a2";
    const { runId } = successor!;
    expect(fx.current()).toMatchObject({ action: { kind: "launched", role: "worker", key, runId },
      halt: { stage: "worker-activity" }, budget: { consumedLoops: 1, maxCycles: 1 } });
    const request = fx.calls.find(call => call.key === key)!;
    // Status alone is not a worker original. Publish the settled bytes under
    // the same admitted identity, as the native child does on completion.
    childResponse(key, request, { root: fx.root, workerRunId: runId }, undefined, 1, successor!.structuredOutput);
    fx.setStatus(ref => ref === runId ? { ...copy(successor!), state: "complete" }
      : copy(fx.native.get(ref) ?? { ok: true, results: [] }));
    const continued = await fx.executeNative();
    expect(continued.status, continued.reason).toBe("partial");
    expect(fx.history()[0].results).toContainEqual(expect.objectContaining({ taskId: "change1", attempt: 2, status: "complete" }));
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
      expect(atCursor(host).P.prompt.admission?.association.digest).toBe(digest(content));
      expect(host.current().budget.maxCycles).toBe(10);
      expect(host.hostCalls).toEqual(["inspect-initial"]);
      expect(request.agent).toBe("pitako.execution-director");
      return { ok: false, error: "Controlled director rejection after admission" };
    });
    await host.execute();
    expect(atCursor(host).P.prompt.admission?.association.digest).toBe(digest(content));
    expect([...host.storage.keys()]).toEqual(["pitako-execute"]);
    expect(host.current()).not.toHaveProperty("snapshot");
    expect(JSON.stringify(host.current())).not.toContain(JSON.stringify(content));
    expect(Buffer.byteLength(JSON.stringify(Object.fromEntries(host.storage), null, 2))).toBeLessThanOrEqual(16384);
    expect(host.launches.map(call => call.agent)).toEqual(["pitako.loop-advance", "pitako.execution-director"]);
  });
  test("later settings cannot replace the admitted budget and base changes preserve original bytes", async () => {
    const content = "ORIGINAL FULL SNAPSHOT";
    const host = fixture(content, { taskCount: 0 });
    expect((await host.execute()).status).toBe("complete");
    const original = copy(host.current());
    const retainedSpec = () => host.records().find((record: { kind: string }) => record.kind === "spec")?.body;
    expect(retainedSpec()).toEqual({ content, digest: digest(content) });
    host.setLimit(10);
    expect(await host.execute()).toMatchObject({ status: "complete", maxLoops: 3, loopsConsumed: 1 });
    expect(host.current()).toEqual(original);
    const before = host.calls.length;
    // Supply a different preliminary binding, just as a same-invocation resolve
    // against changed spec bytes would.
    const output = await host.execute({ preliminary: { binding: "b".repeat(64) } });
    expect(output.status).toBe("blocked");
    expect(output.reason).toContain("Restore reliable exact bytes");
    expect(host.current()).toEqual(original);
    expect(retainedSpec()).toEqual({ content, digest: digest(content) });
    expect(host.calls).toHaveLength(before);
  });
  test("the first cursor save failure prevents the first director after advance commits", async () => {
    const host = fixture();
    host.setFailSave(value => value.version === EXECUTE_STATE_VERSION);
    const output = await host.execute();
    expect(output.status).toBe("partial");
    expect(output.reason).toContain("Essential persistence failed");
    expect(host.launches.map(call => call.key)).toEqual(["invoke-human-1.l1.advance"]);
    expect(host.hostCalls).toEqual(["inspect-initial"]);
    expect(host.current()).toBeUndefined();
    const { store, scope } = executeStore(host.root, "human-1", false, 0);
    expect(store.read(scope).P.control.operation).toMatchObject({ operation: "advance", key: "invoke-human-1.l1.advance" });
  });
});


describe("native closing observations", () => {
  test("four host-free final closes interleaved with repair tasks preserve singleton implicit waiting and distinct evidence", async () => {
    // Closing evidence is the subject; real checkpoint sealing is covered by the sealer and recovery suites.
    const host = fixture(undefined, { readOnly: true }); host.setLimit(10);
    const observations: { loop: number; ref: Result }[] = [];
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
        const cursor = host.current();
        const number = Number(request.key.match(/\.l(\d+)\./)![1]);
        const complianceKey = `invoke-human-1.l${number}.compliance`;
        const compliance = host.native.get(complianceKey)!;
        expect(cursor.loop).toMatchObject({ phase: "closing", number, outcome: null });
        const seed = storedRows(host).reverse().find(row => row.kind === "review-originals" &&
          (row.body as { archiveSeed?: { complianceKey: string } }).archiveSeed?.complianceKey === complianceKey);
        const { archiveSeed } = seed!.body as { archiveSeed: { input: { seq: number; digest: string } } };
        expect(JSON.parse(request.task)).toEqual({
          invocation: cursor.invocation, storeId: cursor.storeId, input: archiveSeed.input,
          compliance: { key: complianceKey, runId: compliance.runId },
        });
        expect(atCursor(host).P.preview.closeReferences.some(reference => reference.loop === number)).toBe(false);
        expect(request).toMatchObject({ output: false, outputMode: "inline", cwd: host.root, context: "fresh" });
        expect(request.async).toBeUndefined(); expect(request.outputSchema).toBe(false);
        expect(request.task).not.toContain("IMMUTABLE");
        observations.push({ loop: number, ref: result });
      }
      return result;
    });
    expect(await host.executeNative()).toMatchObject({ status: "complete", maxLoops: 10, loopsConsumed: 10 });
    expect(host.calls.filter(call => call.agent === "pitako.checkout-observer").map(call => call.key)).toEqual([4, 6, 8, 10].map(loop => `invoke-human-1.l${loop}.checkout`));
    expect(observations.map(item => item.loop)).toEqual([4, 6, 8, 10]);
    expect(host.history().filter((loop: { kind: string }) => loop.kind === "final")
      .map((loop: { number: number }) => loop.number)).toEqual([4, 6, 8, 10]);
    const refs = observations.map(item => item.ref);
    expect(new Set(refs.map(ref => ref.asyncDir)).size).toBe(4);
    expect(new Set(refs.map(ref => ref.externalAdapter?.outputArtifacts?.stdoutPath)).size).toBe(4);
    expect(new Set(refs.map(ref => ref.externalAdapter?.outputArtifacts?.stderrPath)).size).toBe(4);
    expect(host.hostCalls).toEqual(["inspect-initial"]);
  });

  test.each(["before-publication", "after-publication", "before-terminal"])("%s cut resumes the final checkout without republishing", async cut => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
    const checkoutKey = "invoke-human-1.l1.checkout", complianceKey = "invoke-human-1.l1.compliance";
    const set = host.state.set;
    if (cut === "before-publication") host.state.set = async (key, value: any) => {
      await set(key, value);
      if (value.loop?.phase === "closing") throw Error("Lost acknowledgement of the closing cursor save");
    };
    else if (cut === "after-publication") cutAfterOriginal(host, checkoutKey);
    else cutAt(host, value => value.action.kind === "terminal");
    const output = await host.execute();
    expect(output.status).toBe("partial"); expect(output.reason).toContain("Essential persistence failed");
    const cursor = host.current();
    expect(cursor.loop).toMatchObject({ number: 1, phase: "closing", outcome: null });
    expect(cursor.action).toMatchObject({ kind: "launched", role: "reviewer", key: complianceKey,
      runId: host.native.get(complianceKey)!.runId });
    const checkouts = () => host.launches.filter(call => call.agent === "pitako.checkout-observer").map(call => call.key);
    expect(checkouts()).toEqual(cut === "before-publication" ? [] : [checkoutKey]);
    const publication = storeTipRows(host).find(row => row.kind === "ledger");
    expect(!!publication).toBe(cut !== "before-publication");
    if (cut === "after-publication") expect(storedRows(host).some(row => row.digest === publication!.digest)).toBe(false);
    host.setFailSave(); host.state.set = set;
    const admissions = host.launches.length;
    const resumed = await host.execute();
    expect(resumed.status, resumed.reason).toBe("complete");
    expect(host.launches.slice(admissions).map(call => call.key)).toEqual(cut === "before-publication"
      ? [checkoutKey, "invoke-human-1.l1.finishDrain"] : [`${complianceKey}.closing-replay.r1`]);
    expect(checkouts()).toEqual([checkoutKey]);
    if (publication) expect(storedRows(host).find(row => row.seq === publication.seq)).toEqual(publication);
    const native = host.native.get(checkoutKey)!;
    expect(native).toMatchObject({ runId: `native-${checkoutKey}`, asyncDir: `/native/async/${checkoutKey}`,
      externalAdapter: { outputArtifacts: {
        stdoutPath: `/native/async/${checkoutKey}/stdout.log`, stderrPath: `/native/async/${checkoutKey}/stderr.log`,
      } } });
    expect(host.history()[0].observation.checkout).toEqual(host.history()[0].candidate);
    expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "loop"]);
    expect(host.current().action).toEqual({ kind: "terminal" });
  });

  test.each(["admitted", "unadmitted"])("%s closing evidence after a save cut cannot certify a changed checkout", async mode => {
    const host = fixture(undefined, { realCheckout: true, taskCount: 0 }); host.setLimit(1);
    const key = "invoke-human-1.l1.checkout";
    if (mode === "admitted") cutAt(host, value => value.action.kind === "terminal");
    else cutAfterOriginal(host, key);
    const output = await host.execute();
    expect(output.status).toBe("partial");
    expect(output.reason).toContain("Essential persistence failed");
    expect(host.current().loop.outcome).toBeNull();
    const published = storeTipRows(host).reverse().find(row => row.kind === "ledger")!;
    expect(published).toBeDefined();
    expect(storedRows(host).some(row => row.digest === published.digest)).toBe(mode === "admitted");
    const originalCandidate = copy(host.observedCandidate());
    const admissions = host.launches.length;
    host.setFailSave(); host.changeCheckout();
    expect(host.observedCandidate()).not.toEqual(originalCandidate);
    const resumed = await host.execute();
    expect(resumed.status).toBe("partial");
    expect(resumed.loopsConsumed).toBe(1);
    expect(resumed.maxLoops).toBe(1);
    expect(host.history()).toHaveLength(1);
    expect(host.history()[0].observation.checkout).toEqual(originalCandidate);
    expect(storedRows(host).find(row => row.seq === published.seq)).toEqual(published);
    expect(resumed.loopReport.reason).toContain("Candidate changed");
    expect(resumed.loopReport.verification.compliance.status).toBe("stale");
    expect(host.launches.slice(admissions).map(call => call.key)).toEqual(["invoke-human-1.l1.compliance.closing-replay.r1"]);
    expect(host.launches.filter(call => call.agent === "pitako.checkout-observer").map(call => call.key)).toEqual([key]);
  });

  test.each(["missing", "wrong-workspace", "oversized", "producer-conflict", "active"])(
    "save-cut replay reconciles %s evidence and preserves current native barriers", async mode => {
      const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
      const checkoutKey = "invoke-human-1.l1.checkout", replayKey = "invoke-human-1.l1.compliance.closing-replay.r1";
      cutAfterOriginal(host, checkoutKey);
      expect((await host.execute()).reason).toContain("Essential persistence failed");
      const retained = copy(host.current()), published = storeTipRows(host).reverse().find(row => row.kind === "ledger");
      expect(published).toBeDefined();
      expect(storedRows(host).some(row => row.digest === published!.digest)).toBe(false);
      host.setFailSave();
      host.setStatus(ref => {
        const actual = copy(host.native.get(ref) ?? { ok: false, results: [] });
        if (ref !== checkoutKey && ref !== host.native.get(checkoutKey)!.runId) return actual;
        return { ...actual, ...(mode === "producer-conflict" ? { key: "invoke-human-1.l2.checkout" } : {}),
          results: [], output: `Run: ${actual.runId}\nState: ${mode === "active" ? "running" : "complete"}` };
      });
      host.setLaunchRespond(async (request, normal) => {
        const result = await normal();
        if (request.key !== replayKey) return result;
        if (mode === "wrong-workspace") {
          const receipt = JSON.parse(result.output!);
          receipt.P.prompt.closing.body.observation.root = "/other";
          result.output = JSON.stringify(receipt);
        }
        if (mode === "oversized") result.output = JSON.stringify({ ...JSON.parse(result.output!), padding: "x".repeat(61441) });
        return result;
      });
      const count = host.launches.length;
      const resumed = await host.execute();
      if (mode === "missing") {
        expect(resumed.status, resumed.reason).toBe("complete");
        expect(host.launches.slice(count).map(call => call.key)).toEqual([replayKey]);
        expect(storedRows(host).find(row => row.seq === published!.seq)).toEqual(published);
        expect(host.history()[0].observation.checkout).toEqual(host.history()[0].candidate);
      } else {
        expect(resumed.status).toBe("blocked");
        expect(resumed.reason).toContain(mode === "producer-conflict" ? "producer identity changed" :
          mode === "active" ? "native management activity" :
            mode === "oversized" ? "Execute replay has no terminal receipt" : "Invalid closing replay workspace evidence");
        expect(host.launches.slice(count).map(call => call.key)).toEqual(
          ["active", "producer-conflict"].includes(mode) ? [] : [replayKey]);
        expect(host.current()).toEqual(retained);
        expect(host.history()).toEqual([]);
      }
      expect(host.launches.filter(call => call.agent === "pitako.checkout-observer").map(call => call.key)).toEqual([checkoutKey]);
    });

  test("an unavailable completion is retried against the ledger rather than halted", async () => {
    const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
    const key = "invoke-human-1.l1.checkout";
    cutAfterOriginal(host, key);
    expect((await host.execute()).reason).toContain("Essential persistence failed");
    const original = host.launches.find(call => call.key === key)!;
    const publication = storeTipRows(host).reverse().find(row => row.kind === "ledger")!;
    expect(host.records()).toEqual([]);
    host.setFailSave();
    const runId = host.native.get(key)!.runId!;
    host.setStatus(ref => ref === key || ref === runId ? { ok: true, state: "unknown" } : copy(host.native.get(ref)!));
    const resumed = await host.execute();
    expect(resumed.status, resumed.reason).toBe("complete");
    expect(host.launches.filter(call => call.agent === "pitako.checkout-observer")).toEqual([original, original]);
    expect(host.statusCalls).toContain(runId);
    expect(storedRows(host).find(row => row.seq === publication.seq)).toEqual(publication);
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
      const output = await host.execute();
      expect(output.status).not.toBe("complete");
      expect(host.current().loop.outcome).toBeNull();
      // The controlled observer can commit before its native response is
      // damaged. The root must not admit that close into its cursor head.
      expect(host.history()).toEqual([]);
      const calls = copy(host.launches);
      expect((await host.execute()).status).not.toBe("complete");
      expect(host.launches).toEqual(calls);
      expect(host.current().loop.outcome).toBeNull();
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
    const key = "invoke-human-1.l1.checkout";
    expect(output.loopReport.halt).toMatchObject({ code: "capacity",
      reason: "Active async run capacity exhausted: 2/2 used.", ref: { key } });
    expect(output.loopReport.halt.ref.runId).toBeUndefined();
    expect(host.current().inFlight.some((ref: any) => ref.key === key)).toBe(false);
    expect(host.native.has(key)).toBe(false);
    expect(host.history()).toEqual([]);
  });
});
