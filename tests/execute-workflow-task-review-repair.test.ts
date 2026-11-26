import { expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { EXECUTE_STATE_VERSION } from "../extensions/execute-state.ts";
import { readBacklog } from "../skills/execute/loop.ts";
import { digest } from "../extensions/spec-plans.ts";
import { executeControllerFixture, executeField, executeString, type Result } from "./fixtures/execute-workflow.ts";
import { pitakoAgentFamily } from "../skills/agent-names.mjs";
const { executeStore, canonicalJSON, executeProjection, fullExecuteProjection } = await import("../skills/execute/ledger.mjs");
const { resolveStoredGroupedInput } = await import("../skills/execute/loop-io.mjs");

const { fixture } = executeControllerFixture();
function reject(result: Result, conflict = false) {
  Object.assign(result.structuredOutput, {
    correctness: { verdict: "Unfinished required path", score: 8, findings: [{
      summary: "Required error path remains broken", evidence: "src/change1.ts:1",
      introducedByDelta: false, affectsTask: true,
    }] },
    conflict, remaining: ["Fix the required error path"], diagnosis: "Synthesis diagnosis",
    revival: "Repair the source-evidenced error path",
  });
  writeFileSync(result.results![0]!.savedOutputPath!, JSON.stringify(result.structuredOutput));
  return result;
}

test.each(["admit", "reject", "gate-failure", "incomplete", "conflict", "stalled"])(
  "one same-slot repair: %s", async outcome => {
    const host = fixture(); host.setLimit(1);
    let workers = 0, reviews = 0;
    const repairKnowledge = { findings: [], handoff: "a2-incomplete-knowledge-sentinel" };
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") {
        workers++;
        if (workers === 2 && outcome === "incomplete") {
          result.structuredOutput.status = "continue";
          result.structuredOutput.remaining = ["Still incomplete"];
          result.structuredOutput.knowledge = repairKnowledge;
        }
      }
      if (pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "gate") {
        const receipt = JSON.parse(result.output!);
        if (workers === 2 && outcome === "gate-failure") {
          receipt.gates[0].status = "fail"; receipt.gates[0].exit = 1;
          receipt.gates[0].tail = "Repair assertion failed";
        }
        if (workers === 1 && outcome === "stalled") {
          receipt.stalled = true; receipt.progress.nonImproving = 3;
        }
        result.output = JSON.stringify(receipt);
      }
      if (request.key.endsWith(".task-synthesis")) {
        reviews++;
        if (reviews === 1 || outcome === "reject") reject(result, outcome === "conflict");
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status, output.reason).toBe("partial");
    const admitted = outcome === "admit" || outcome === "stalled";
    expect(workers).toBe(outcome === "conflict" ? 1 : 2);
    expect(reviews).toBe(["gate-failure", "incomplete", "conflict"].includes(outcome) ? 1 : 2);
    const task = readBacklog(host.root, "spec").backlog!.tasks[0]!;
    expect(task.status).toBe(admitted ? "done" : "pending");
    expect(host.current().budget.consumedLoops).toBe(1);
    const units = host.records().filter((record: any) => record.kind === "unit");
    const { store, scope } = executeStore(host.root, host.current().invocation);
    const retained = store.read(scope, host.current().head);
    expect(canonicalJSON(retained.P)).toBe(canonicalJSON(fullExecuteProjection(retained.records)));
    for (let end = 0; end < retained.records.length; end++) {
      const rows = retained.records.slice(0, end);
      expect(canonicalJSON(executeProjection(rows))).toBe(canonicalJSON(fullExecuteProjection(rows)));
    }
    expect(units.some((record: any) => record.body.checkpoint.kind === "unit")).toBe(admitted);
    const seals = host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind);
    expect(seals).toEqual(outcome === "conflict" ? ["pause"] : ["pause", admitted ? "unit" : "pause"]);
    if (outcome !== "conflict") {
      const repair = host.launches.filter(call => call.agent === "pitako.worker")[1]!;
      expect(repair.key).toBe("invoke-human-1.l1.t1.a2");
      expect(repair.task).toContain("Required error path remains broken");
      expect(repair.task).toContain("invoke-human-1.l1.t1.a1.task-synthesis.json");
      expect(repair.task).toContain("Synthesis diagnosis");
      expect(repair.task).toContain("Repair the source-evidenced error path");
      expect(host.calls.some(call => call.key === "invoke-human-1.l1.t1.a2.baseline")).toBe(true);
      if (outcome === "incomplete") {
        expect(host.launches.some(call => call.key === `${repair.key}.gate`)).toBe(false);
        const close = retained.records.find(row => row.kind === "receipt" &&
          executeField(row.body, "key") === `${repair.key}.close`)!;
        const execution = store.read(scope, { seq: close.seq, hash: close.digest }).P.prompt.execution!;
        expect(execution.checkpoint).toMatchObject({ attempt: 3 });
        expect(execution.worker).toBeNull();
        const folded = execution.foldedContinuation;
        expect(executeField(folded, "worker", "value", "knowledge")).toEqual(repairKnowledge);
        expect(JSON.stringify(executeField(folded, "taskFrame"))).not.toContain(repairKnowledge.handoff);
        expect(units.at(-1)!.body.frame.workerKnowledge[repair.key]).toEqual(repairKnowledge);
      }
    }
    if (!admitted) {
      expect(host.history()[0].outcome).toBe("gaps");
      expect(units.some((record: any) => record.body.frame.reviewRepair?.exhausted)).toBe(true);
      expect(units.at(-1)!.body.checkpoint.kind).not.toBe("unit");
      if (outcome === "gate-failure") {
        const diagnosis = host.history()[0].results.at(-1).diagnosis;
        expect(diagnosis).toContain("change1-check: fail");
        expect(diagnosis).toContain("Required error path remains broken");
      }
    }
    if (reviews === 2) {
      const brief = host.launches.find(call => call.key === "invoke-human-1.l1.t1.a2.task-reviewer")!.task;
      expect(brief).toContain("verify every prior blocking finding is closed");
      expect(brief).toContain("Required error path remains broken");
      expect(brief).toContain('"src/change1.ts"');
    }
  },
);

test.each([false, true])("carried task inheritance requires evidenced provenance: %s", async predatesTask => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director")
      result.structuredOutput.changes[0].task.remaining = "Earlier-loop partial work";
    if (request.key.endsWith(".task-synthesis")) {
      result.structuredOutput.scope = { verdict: "Inherited issue", score: 9, findings: [{
        summary: "Pre-existing unrelated issue", introducedByDelta: false, affectsTask: false,
        predatesTask, evidence: predatesTask ? "Authenticated baseline before task" : "Provenance unknown",
      }] };
      writeFileSync(result.results![0]!.savedOutputPath!, JSON.stringify(result.structuredOutput));
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(host.launches.find(call => call.key.endsWith(".task-reviewer"))!.task).toContain("carried: true");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe(predatesTask ? "done" : "pending");
});

test.each(["reviewer-intention", "synthesis-intention", "reviewer-receipt", "synthesis-receipt", "reviewer-and-synthesis-receipts", "before-requests", "before-seal",
  "result-save", "before-baseline", "cancel-result-save", "cancel-before-seal", "missing-review", "changed-review",
  "missing-reviewer", "changed-reviewer", "missing-worker", "changed-worker"])(
  "saved rejection survives a %s cut without renewing the repair", async seam => {
  const cancelled = seam.startsWith("cancel-");
  const sequential = seam === "reviewer-and-synthesis-receipts";
  const cut = sequential ? "synthesis-receipt" : cancelled ? seam.slice("cancel-".length) : seam;
  const preAdmission = cut.endsWith("-intention");
  const setup = () => {
    const host = fixture(undefined, { realCheckout: cut === "before-seal" }); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".task-synthesis")) reject(result);
      if (cancelled && request.agent === "pitako.request-observer" && JSON.parse(request.task).observation) {
        const page = JSON.parse(result.output!);
        const cursor = JSON.parse(request.task).cursor;
        page.requests = cursor === 0 ? [{ v: 1, requestId: "cancel-review", invocation: "human-1",
          taskId: "change1", kind: "cancel", origin: "model" }] : [];
        if (cut === "before-seal" && cursor === 0) page.next = 1;
        result.output = JSON.stringify(page);
      }
      return result;
    });
    return host;
  };
  const host = setup();
  const execute = (value: typeof host) => cut === "synthesis-receipt" || preAdmission ? value.executeNative() : value.execute();
  const base = "invoke-human-1.l1.t1.a1";
  const cutKey = `${base}.task-${cut.startsWith("reviewer-") ? "reviewer" : "synthesis"}`;
  if (preAdmission || cut.endsWith("-receipt")) host.setStatus(ref => {
    // A fresh root cannot resolve workflow keys even when the prior root admitted one.
    if (/\.task-(reviewer|synthesis)$/.test(ref))
      throw new Error(`Status '${ref}' failed: Async run not found. Provide id or dir.`);
    const original = host.native.get(ref);
    return original ? { ...original, state: "complete" } : { ok: true, output: "", results: [] };
  });
  let synthesisSaves = 0;
  if (sequential) {
    host.setFailSave(() => host.native.has(`${base}.task-reviewer`));
    expect((await execute(host)).reason).toContain("Essential persistence failed");
    expect(host.current().action).toMatchObject({ kind: "launched", role: "reviewer",
      key: `${base}.task-reviewer` });
  }
  if (preAdmission) {
    host.setSaveObserver(value => {
      if (value.action?.key !== cutKey || value.action.runId !== null) return;
      host.setFailSave(() => true);
      throw new Error("Controlled cut after saving task-review launch intention");
    });
  } else host.setFailSave(value => {
    if (cut === "reviewer-receipt") return host.native.has(`${base}.task-reviewer`);
    if (cut === "synthesis-receipt") return host.native.has(`${base}.task-synthesis`);
    if (cut === "before-requests") return host.native.has(`${base}.task-synthesis`) && ++synthesisSaves === 2;
    if (cut === "before-seal") return host.native.has(`${base}.task-synthesis`) &&
      host.launches.some(call => call.agent === "pitako.request-observer" &&
        JSON.parse(call.task).observation && host.native.has(call.key));
    return cut === "before-baseline" ? value.loop?.attempt?.number === 2 :
      host.native.has(`${base}.seal`);
  });
  expect((await execute(host)).reason).toContain("Essential persistence failed");
  const cursor = host.current();
  expect(cursor.version).toBe(EXECUTE_STATE_VERSION);
  expect(cursor.action).toMatchObject({ kind: "launched", role: "reviewer", key: cutKey });
  if (cut.endsWith("-receipt") || preAdmission) expect(cursor.review.slots.at(-1).runId).toBeNull();
  if (preAdmission) {
    expect(cursor.action.runId).toBeNull();
    expect(host.launches.some(call => call.key === cutKey)).toBe(false);
    expect(host.native.has(cutKey)).toBe(false);
  }
  if (["reviewer-receipt", "synthesis-receipt", "before-requests"].includes(cut))
    expect(host.launches.some(call => call.agent === "pitako.request-observer" &&
      JSON.parse(call.task).observation)).toBe(false);
  if (cut === "before-seal") {
    expect(existsSync(`${host.root}/.pi/subagents/checkpoints/${base}/manifest.json`)).toBe(true);
    expect(existsSync(`${host.root}/.pi/subagents/checkpoints/${base}/pause.json`)).toBe(false);
  }
  expect(cursor.loop.attempt).toMatchObject({ number: 1, stage: "launched" });
  const { store, scope } = executeStore(host.root, cursor.invocation);
  const retained = store.read(scope, cursor.head);
  const input = retained.records.find(row => row.seq === cursor.action.input.seq)!;
  expect(input.digest).toBe(cursor.action.input.digest);
  expect(executeField(input.body, "operation")).toBe("gate");
  const damaged = seam.startsWith("missing-") || seam.startsWith("changed-");
  if (damaged) {
    const suffix = seam.endsWith("worker") ? "" : seam.endsWith("reviewer") ? ".task-reviewer" : ".task-synthesis";
    const original = seam.endsWith("worker") ? executeString(executeField(retained.P.prompt.execution!.worker, "reference", "path")) :
      host.native.get(`invoke-human-1.l1.t1.a1${suffix}`)!.results![0]!.savedOutputPath!;
    if (seam.startsWith("missing-")) rmSync(original);
    else writeFileSync(original, "{}");
  }
  host.setSaveObserver(undefined);
  host.setFailSave();
  const output = await execute(host);
  if (damaged) {
    expect(output.status).toBe("blocked");
    expect(output.reason).toMatch(seam.startsWith("missing-") ? /ENOENT/ : /original digest mismatch/);
    expect(host.launches.filter(call => call.key.endsWith(".review-recovery.r1"))).toHaveLength(1);
    expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.launches.filter(call => call.key.endsWith(".task-synthesis"))).toHaveLength(1);
    return;
  }
  expect(output.status, output.reason).toBe("partial");
  expect(host.launches.filter(call => call.key.endsWith(".task-synthesis")).map(call => call.key))
    .toEqual(cancelled ? [`${base}.task-synthesis`] :
      ["invoke-human-1.l1.t1.a1.task-synthesis", "invoke-human-1.l1.t1.a2.task-synthesis"]);
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(cancelled ? 1 : 2);
  const task = readBacklog(host.root, "spec").backlog!.tasks[0]!;
  expect(task.status).toBe(cancelled ? "obsolete" : "pending");
  if (cancelled) expect(output.cancelledScope[0].cancel)
    .toMatchObject({ requestId: "cancel-review", origin: "model", kind: "cancel" });
  expect(host.history()[0].outcome).toBe("gaps");
  const uninterrupted = setup();
  expect((await execute(uninterrupted)).status).toBe("partial");
  const admitted = (value: typeof host) => value.launches.filter(call => value.native.has(call.key));
  expect(admitted(host), JSON.stringify(admitted(host).map(call => call.key)
    .filter(key => !admitted(uninterrupted).some(call => call.key === key))))
    .toHaveLength(admitted(uninterrupted).length + (sequential ? 2 : 1));
  expect(host.launches.filter(call => /\.(?:review-context-recovery|review-recovery)\.r1$/.test(call.key)))
    .toHaveLength(sequential ? 2 : 1);
  expect(host.launches.filter(call => pitakoAgentFamily(call.agent) !== "loop-io").map(call => call.key))
    .toEqual(uninterrupted.launches.filter(call => pitakoAgentFamily(call.agent) !== "loop-io").map(call => call.key));
  if (sequential) {
    const tip = store.read(scope).head;
    for (const stage of ["reviewer", "synthesis"]) {
      const recovery = host.launches.find(call => call.key === `${base}.task-${stage}.review-recovery.r1`)!;
      const { operation, ...input } = JSON.parse(recovery.task);
      const row = store.read(scope).records.find((row: any) =>
        row.opKey === `task-review-recovery:${input.key}`)!;
      const committed = store.read(scope, { seq: row.seq, hash: row.digest });
      const replay = resolveStoredGroupedInput(operation, input).replay as Record<string, unknown>;
      expect(replay.head).toEqual(committed.head);
      expect(canonicalJSON(replay.P)).toBe(canonicalJSON(committed.P));
      expect(store.read(scope).head).toEqual(tip);
    }
  }
  const modelRequests = (value: typeof host) => JSON.stringify(value.launches.filter(call =>
    ["worker", "reviewer", "execution-director"].includes(pitakoAgentFamily(call.agent) ?? "")))
    .replaceAll(value.root, "<root>")
    .replaceAll(value.current().storeId, "<store>")
    .replace(/(digest\\":\\")[a-f0-9]{64}(?=\\",\\"lines\\")/g, "$1<store-record-digest>")
    .replace(/admitted backlog digest [a-f0-9]{64}/g, "admitted backlog digest <root-bound>")
    .replace(/(ledgerPath\\":\\"[^"]+\\",\\"head\\":\\")[a-f0-9]{64}/g, "$1<root-bound>");
  expect(modelRequests(host)).toBe(modelRequests(uninterrupted));
  const baselineRequest = (value: typeof host) => JSON.stringify(JSON.parse(value.launches
    .find(call => call.key.endsWith(".a2.baseline"))!.task)).replaceAll(value.root, "<root>")
    .replace(/[a-f0-9]{64}/g, "<root-bound-digest>");
  if (cancelled) expect(host.launches.some(call => call.key.endsWith(".a2.baseline"))).toBe(false);
  else expect(baselineRequest(host)).toBe(baselineRequest(uninterrupted));
  for (const value of host.snapshots) {
    if (value.review) expect(value.review.slots.every((ref: any) =>
      Object.keys(ref).sort().join(",") === "digest,key,phase,runId")).toBe(true);
    expect(value.inFlight.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(JSON.stringify({ "pitako-execute": value }, null, 2))).toBeLessThanOrEqual(16384);
  }
});

test("interrupted repair fallback retains the single repair allowance", async () => {
  // This asserts repair accounting, not restored bytes; checkpoint-sealer's
  // never-closed-effect case retains the real restoring-worker integration.
  const host = fixture(); host.setLimit(1);
  let descriptor: any;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker" && request.key.endsWith(".a2"))
      return { ...result, ok: false, interrupted: true, structuredOutput: undefined, results: [] };
    if (request.agent === "pitako.worker" && request.task.includes("CHECKPOINT FALLBACK (same pending task"))
      descriptor = { key: request.key, restore: JSON.parse(request.task.split("CHECKPOINT FALLBACK (same pending task, not a metadata repair):\n")[1]!.split("\n")[0]!) };
    if (request.agent === "pitako.checkpoint-sealer" && descriptor?.restore) {
      const manifest = descriptor.restore.observations[0].manifest;
      const directory = manifest.replace(/\/manifest\.json$/, "");
      const observed = JSON.parse(result.output!);
      observed.restored = { checkpointRef: manifest, digest: digest(descriptor.key),
        partialRef: `${directory}/restore.json`, restoredRef: `${directory}/restored.json`,
        position: { loop: 1, cursor: 0, phase: "implementation" }, candidate: host.observedCandidate() };
      for (const field of ["confirmedPause", "confirmedUnit"]) {
        const confirmed = descriptor.restore.authority[field];
        if (confirmed?.checkpointRef.startsWith(directory + "/"))
          observed.restored[field] = { checkpointRef: confirmed.checkpointRef, digest: confirmed.digest };
      }
      result.output = JSON.stringify(observed);
    }
    if (request.key.endsWith(".task-synthesis")) reject(result);
    return result;
  });
  host.setFailSave(value => value.loop?.attempt?.number === 2);
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  expect(host.current().loop.attempt.number).toBe(1);
  expect(host.current().loop.attempt.stage).toBe("launched");
  host.setFailSave();
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2", "invoke-human-1.l1.t1.a3"]);
  expect(host.launches.filter(call => call.key.endsWith(".task-synthesis")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.task-synthesis", "invoke-human-1.l1.t1.a3.task-synthesis"]);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
  expect(host.records().filter((record: any) => record.kind === "unit").at(-1).body.checkpoint.kind).toBe("pause");
  expect(host.current().budget.consumedLoops).toBe(1);
  expect(host.history()[0].outcome).toBe("gaps");
  host.expectProcessBudget(2); // Measured zero, plus two.
});
