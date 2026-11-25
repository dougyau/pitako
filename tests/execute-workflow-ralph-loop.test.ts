import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { TASK_UPDATE_KEYS, gate as runGate, readBacklog, taskGateWire, topicOwner } from "../skills/execute/loop.ts";
import { executeControllerFixture, copy, type Result } from "./fixtures/execute-workflow.ts";
import { realCheckoutCompositionFixture } from "./fixtures/plan-execute-composition.ts";
import { expectProcessBudget } from "./fixtures/process-budget.ts";
import { PitakoStore } from "../extensions/pitako-store.ts";
import { openSqliteSync } from "../extensions/board/sqlite.ts";
import { openBoard } from "../extensions/board/store.ts";
import { repositoryIdentity } from "../extensions/board/workspace.ts";
import { appendExecuteTodoRecords } from "../extensions/execute-todo-projection.ts";
import { MAX_SPEC_BYTES, SPEC_SECTIONS, inspectionSnapshot, validateSpec } from "../extensions/spec-plans.ts";
import { canonicalDigest, canonicalJSON, sha256 } from "../extensions/canonical.mjs";
import { executeStore } from "../skills/execute/ledger.mjs";
import { resolveStoredGroupedInput, commitFinalGate, commitStoredGate } from "../skills/execute/loop-io.mjs";
import { pitakoAgentFamily } from "../skills/agent-names.mjs";

const acceptanceComposition = realCheckoutCompositionFixture();
const { fixture } = executeControllerFixture(acceptanceComposition.fake);
const acceptanceScripts = acceptanceComposition.scripts;
function acceptanceCheckout(host: ReturnType<typeof fixture>, request: { agent?: string; key: string; task: string }) {
  if (request.agent === "pitako.checkpoint-sealer" ||
      pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "taskDelta")
    return acceptanceScripts.runDeterministic(request.key, request,
      { ...acceptanceScripts, root: host.root, inlineSealer: true }, undefined);
}
const isGate = (call: { agent?: string; task: string }) => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).operation === "gate";
const isFinalGate = (call: { agent?: string; task: string }) => isGate(call) && JSON.parse(call.task).task?.id === "final-acceptance";
const taskFixture = (realCheckout = false) => { const host = fixture(undefined, { realCheckout }); host.setLimit(1); return host; };
function committed(host: ReturnType<typeof fixture>, cursor = host.current()) {
  const { store, scope } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
  return store.read(scope, cursor.head);
}
const checkOrigin = (ref: string) => {
  expect(Buffer.byteLength(ref)).toBeLessThanOrEqual(512);
  const output = JSON.parse(ref);
  expect(Object.keys(output).sort()).toEqual(["key", "path", "sha256"]);
  expect(output.sha256).toBe(createHash("sha256").update(readFileSync(output.path)).digest("hex"));
  return output;
};
const gateReceipt = (normal: () => Result) => {
  const result = normal();
  return { result, receipt: JSON.parse(result.output!) };
};
const storeBody = <T>(body: unknown) => body as T;

test("a complete worker with failed focused gates seals pause and continues the same task", async () => {
  const host = taskFixture();
  let failed = false;
  host.setRespond((request, normal) => {
    if (isGate(request) && !failed) {
      failed = true;
      const { result, receipt } = gateReceipt(normal);
      receipt.gates[0] = { ...receipt.gates[0], status: "fail", exit: 1, tail: "Observable failing assertion" };
      receipt.progress.nonImproving = 1;
      return { ...result, output: JSON.stringify(receipt) };
    }
    return normal();
  });
  const output = await host.execute();
  expect(output.status).toBe("partial");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  expect(output.boardTopicId).toBe(1);
  expect(host.calls.filter(call => /\.a1\.task-/.test(call.key))).toHaveLength(0);
  expect(host.calls.filter(call => /\.a2\.task-/.test(call.key))).toHaveLength(2);
  expect(host.snapshots.every(state => !state.activePlan && !state.loop?.selection?.receipt?.backlog)).toBe(true);
  const workers = host.calls.filter(call => call.agent === "pitako.worker");
  expect(workers[0]!.key).toContain(".l1.t1.a1");
  expect(workers[1]!.key).toContain(".l1.t1.a2");
  expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
  const firstWorker = host.calls.indexOf(workers[0]!);
  const firstGate = host.calls.findIndex(call => isGate(call));
  const firstSeal = host.calls.findIndex(call => call.agent === "pitako.checkpoint-sealer");
  expect(firstWorker).toBeLessThan(firstGate); expect(firstGate).toBeLessThan(firstSeal);
  const seals = host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task));
  expect(seals[0].kind).toBe("pause");
  expect(seals[1].kind).toBe("unit");
  expect(workers[1]!.task).toContain("change1-check: fail");
  expect(workers[1]!.task).toContain("/native/gates/invoke-human-1.l1.t1.a1.gate/change1-check.log");
  expect(workers[1]!.task).not.toContain("Observable failing assertion");
  expect(workers[1]!.task).toContain("TASK CONTINUATION");
  expect(workers[1]!.task).not.toContain("FROZEN ATTEMPT");
  expect(workers[1]!.task).not.toContain("checkoutEvidence before/after");
  expect(workers[1]!.task).toContain("do not ask the supervisor about concurrency");
  expect(workers[1]!.task).toContain("Current DECISIONs are binding working rules");
  expect(workers[1]!.task).toContain("COMPLETE IMMUTABLE SPEC SNAPSHOT");
  expect(host.calls.filter(call => isGate(call)).every(call => call.timeoutMs === 14400000)).toBe(true);
  expect(host.snapshots.some(value => value.action?.op === "gate" && committed(host, value).records.some(row =>
    row.opKey === `worker-gate:${value.action.opKey}`))).toBe(true);
});

test.each(["intact", "id-conflict", "digest-conflict"])("compact selection receipt survives admission save failure: %s", async mode => {
  const host = taskFixture();
  const selectionKey = "invoke-human-1.l1.selectionIO";
  let selection: { path: string; head: { seq: number; hash: string } } | undefined;
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.key === selectionKey) selection = JSON.parse(result.output!);
    return result;
  });
  host.setFailSave(() => Boolean(selection));
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  const cursor = host.current();
  const { records, P } = committed(host, { ...cursor, head: selection!.head });
  const { digest, backlog } = readBacklog(host.root, "spec");
  const retained = storeBody<{ result: { steps: { operation: string; result: { selected: { id: string }; digest: string } }[] } }>(records.at(-1)!.body);
  const applied = retained.result.steps.find(step => step.operation === "apply")!.result;
  expect(P.prompt.selectedTask?.id).toBe(backlog!.tasks[0]!.id);
  expect(applied.selected.id).toBe(P.prompt.selectedTask!.id);
  expect(applied.digest).toBe(digest!);
  if (mode !== "intact") {
    const transport = copy(retained);
    const changed = transport.result.steps.find(step => step.operation === "apply")!.result;
    if (mode === "id-conflict") changed.selected.id = "other";
    else changed.digest = "f".repeat(64);
    const db = openSqliteSync(new PitakoStore(host.root).file);
    try { db.prepare("UPDATE records SET body=? WHERE scope=? AND seq=?")
      .run(canonicalJSON(transport), "exec:human-1.e0", selection!.head.seq); }
    finally { db.close(); }
    expect(() => committed(host, { ...cursor, head: selection!.head })).toThrow("Record body mismatch");
  }
  host.setFailSave(undefined);
  const output = await host.execute();
  if (mode === "intact") {
    expect(output.status, output.reason).toBe("partial");
    expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  } else {
    expect(output.status, output.reason).toBe("blocked");
    expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
  }
  expect(host.launches.filter(call => call.key.startsWith(selectionKey)).map(call => call.key))
    .toEqual(mode === "intact" ? [selectionKey, `${selectionKey}.r1`] : [selectionKey]);
  expect(host.calls.filter(call => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).operation === "apply" && !JSON.parse(call.task).settle)).toHaveLength(1);
});

test("malformed knowledge does not reject an otherwise valid worker result", async () => {
  const host = taskFixture();
  let workers = 0;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker") result.structuredOutput.knowledge = { findings: false,
      handoff: workers++ === 0 ? "🧵".repeat(600) + "\ud800" : 42 };
    return result;
  });
  expect((await host.execute()).status).toBe("partial");
  const request = host.calls.find(call => call.agent === "pitako.worker")!;
  expect(Object.keys(request.outputSchema.properties)).toEqual(["work", "status", "remaining", "knowledge", "continuation"]);
  expect(request.outputSchema.required).not.toContain("knowledge");
  const unit = host.records().find((record: { kind: string }) => record.kind === "unit")!;
  const { frame } = storeBody<{ frame: { workerKnowledge: Record<string, { handoff: string; findings: string[] }> } }>(unit.body);
  const knowledge = Object.values(frame.workerKnowledge)[0]!;
  expect(Buffer.byteLength(knowledge.handoff)).toBe(2048);
  expect(knowledge.findings).toEqual([]);
  expect(host.history()[0]!.results.every((value: any) => value.status === "complete")).toBe(true);
});

test("a saved gate receipt is reused after the seal intention survives a failed result save", async () => {
  const host = taskFixture();
  let sealed = false;
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.agent === "pitako.checkpoint-sealer") sealed = true;
    return result;
  });
  host.setFailSave(() => sealed);
  const first = await host.execute();
  expect(first.reason).toContain("Essential persistence failed");
  const key = "invoke-human-1.l1.t1.a1";
  expect(committed(host).records.some(row => row.opKey === `worker-gate:${key}.gate`)).toBe(true);
  expect(host.native.get(`${key}.seal`)?.ok).toBe(true);
  const gatesBefore = host.gateExecutions();
  host.setFailSave(undefined);
  host.setLaunchRespond(undefined);
  const resumed = await host.execute();
  expect(resumed.status, resumed.reason).toBe("partial");
  expect(host.gateExecutions()).toBe(gatesBefore);
  expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key === key)).toHaveLength(1);
  expect(gatesBefore).toBe(1);
});

function expectBoundedStallProjection(host: ReturnType<typeof fixture>, loop: number) {
  const { store, scope } = executeStore(host.root, "human-1");
  const prefix = `invoke-human-1.l${loop}.t1.`;
  const keys = [1, 2, 3].map(n => `${prefix}a${n}.close`);
  const closes = store.readRecords(scope).records.filter(row => row.kind === "receipt" &&
    keys.includes(storeBody<{ key: string }>(row.body).key));
  expect(closes.map(row => storeBody<{ key: string }>(row.body).key)).toEqual(keys);
  for (const row of closes) {
    const { P } = store.read(scope, { seq: row.seq, hash: row.digest });
    expect(Buffer.byteLength(JSON.stringify(P))).toBeLessThanOrEqual(61440);
  }
}

test("three non-improving gate attempts end the task loop", async () => {
  const host = taskFixture(); host.setLimit(1);
  let attempts = 0;
  host.setRespond((request, normal) => {
    if (isGate(request)) {
      const { result, receipt } = gateReceipt(normal); attempts++;
      receipt.gates[0] = { ...receipt.gates[0], status: "timeout", exit: null, tail: "Focused gate timed out" };
      receipt.progress.nonImproving = attempts; receipt.stalled = attempts >= 3;
      return { ...result, output: JSON.stringify(receipt) };
    }
    return normal();
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(3);
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind)).toEqual(["pause", "pause", "pause"]);
  expect(host.calls.some(call => call.key.includes(".review."))).toBe(false);
  expect(host.history()[0]!.results.at(-1)!.diagnosis).toContain("Three consecutive non-improving");
  expectBoundedStallProjection(host, 1);
});

test("the sealer cannot admit a candidate changed after gates", async () => {
  const host = taskFixture(true); let changed = false;
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.checkpoint-sealer" && !changed) { changed = true; host.changeCheckout(); }
    return normal();
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain("Sealer candidate differs from the saved gate receipt");
  expect(host.records().filter((record: { kind: string; body: unknown }) => record.kind === "unit" &&
    storeBody<{ checkpoint: unknown }>(record.body).checkpoint)).toHaveLength(0);
  expect(host.calls.filter(call => isGate(call))).toHaveLength(1);
});

test("a transport retry uses a new .rN close key and keeps the long explicit deadline", async () => {
  const host = taskFixture(); let failed = false;
  host.setRespond((request, normal) => request.agent === "pitako.worker"
    ? host.result(request, { status: "complete", work: "No writes needed", remaining: [] }) : normal());
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "close" && !failed) {
      failed = true; return { ...result, output: "Transport output unavailable" };
    }
    return result;
  });
  expect((await host.execute()).status).toBe("partial");
  const calls = host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).operation === "close");
  expect(calls[1]!.key).toBe(calls[0]!.key + ".r1");
  expect(calls.every(call => call.timeoutMs === 14400000)).toBe(true);
  expect(host.calls.filter(isGate)).toHaveLength(1);
});

test("v5 retained state is rejected before any resume or dispatch", async () => {
  const host = taskFixture();
  expect((await host.execute()).status).toBe("partial");
  const retained = copy(host.current()); retained.version = 5;
  host.storage.set("pitako-execute", retained);
  const count = host.calls.length;
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain("incompatible Pitako contract v5. No migration or replay is supported; retained unchanged.");
  expect(host.calls).toHaveLength(count);
});

test("a non-complete worker with passing gates still seals pause", async () => {
  const host = taskFixture(); let paused = false;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker" && !paused) {
      paused = true; result.structuredOutput.status = "continue";
      result.structuredOutput.knowledge.handoff = "src/change1.ts is the current implementation seam.";
    }
    return result;
  });
  expect((await host.execute()).status).toBe("partial");
  const seals = host.calls.filter(call => call.agent === "pitako.checkpoint-sealer");
  expect(JSON.parse(seals[0]!.task).kind).toBe("pause");
  const continuation = host.calls.filter(call => call.agent === "pitako.worker")[1]!;
  expect(continuation.task).toContain("src/change1.ts is the current implementation seam");
  expect(continuation.task).toContain("previousResult");
});

test.each([false, true])("a no-write complete attempt is admitted as unit (gate continuation: %s)", async continuation => {
  const host = taskFixture();
  let failed = false;
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker") return host.result(request,
      { work: "Already satisfied", status: "complete", remaining: [], knowledge: null });
    if (isGate(request) && continuation && !failed) {
      failed = true;
      const { result, receipt } = gateReceipt(normal);
      receipt.gates[0] = { ...receipt.gates[0], status: "fail", exit: 1, tail: "Gate failed" };
      return { ...result, output: JSON.stringify(receipt) };
    }
    return normal();
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  expect(host.history()[0]!.results.at(-1)!.status).toBe("complete");
  expect(host.history()[0]!.cursor).toBe(1);
  const kinds = host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind);
  expect(kinds).toEqual(continuation ? ["pause", "unit"] : ["unit"]);
  // No fabricated journal receipt or confirmed checkpoint for an observed unit.
  expect(host.records().filter((record: { kind: string; body: unknown }) => record.kind === "unit" &&
    storeBody<{ checkpoint: unknown }>(record.body).checkpoint)).toHaveLength(0);
});

test("the gate-before-seal controller is portable through the native workflow sandbox", async () => {
  const host = taskFixture(true), dbPath = `${host.root}/.pi/task-gate-board.db`;
  const board = await openBoard(dbPath);
  try {
    const workspace = repositoryIdentity(host.root);
    const topic = board.ensureOwnedTopic(workspace, topicOwner(host.root, "spec"), { title: "Gate evidence" });
    board.post(workspace, { topicId: topic.id, type: "DECISION", content: "x".repeat(5200) });
  } finally { board.close(); }
  host.setRespond(async (request, normal) => {
    if (request.agent === "pitako.execution-director") {
      const plan = normal();
      Object.assign(plan.structuredOutput.changes[0].task.gates[0], { id: "focused".repeat(440), command: "true" });
      return plan;
    }
    if (!isGate(request) || isFinalGate(request)) return normal();
    const { operation, ...envelope } = JSON.parse(request.task);
    const input = envelope.refs ? resolveStoredGroupedInput(operation, envelope) : envelope;
    const receipt = await runGate({ ...input, dbPath });
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeGreaterThan(8191);
    return { ok: true, agent: request.agent, key: request.key, runId: `native-${request.key}`,
      output: JSON.stringify(taskGateWire(commitStoredGate(input, receipt) as typeof receipt)), results: [{ exitCode: 0 }] } as Result;
  });
  const output = await host.executeNative();
  expect(output.status, output.reason).toBe("partial");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  expect(host.calls.some(call => isGate(call))).toBe(true);
});


test.each(["selection", "unknown-update", "reused-id"])("invalid director %s retries in the same loop with its diagnosis", async mode => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key.endsWith(".l1.director")) {
      if (mode === "selection") result.structuredOutput.select = "unknown";
      else result.structuredOutput.changes.push(mode === "unknown-update"
        ? { kind: "update", id: "unknown", patch: { goal: "Unknown task" }, reason: "Reconcile" }
        : copy(result.structuredOutput.changes[0]));
    }
    return result;
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(2);
  expect(host.calls.find(call => call.key.endsWith(".l1.director.d1"))!.task).toContain(mode === "selection" ? "Selected task must be pending"
    : mode === "unknown-update" ? "Cannot change unknown task or tombstone" : "Task ID never reused");
  expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1"]);
  expect(host.history()[0]!.plan.stage).toBe("admitted");
  const rejected = committed(host).records.find(row => row.opKey === "operation:invoke-human-1.l1.selectionIO");
  expect(storeBody<{ request: { plan: { ref: { key: string } } } }>(rejected?.body).request.plan.ref.key)
    .toBe("invoke-human-1.l1.director");
});

test.each(["conflict", "schema", "decisions"])("backlog %s halts without a writer", async mode => {
  const host = taskFixture();
  host.setRespond((request, normal) => {
    if (pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "prepare" && mode !== "conflict")
      return { ok: false, agent: request.agent, runId: "native-prepare", output: JSON.stringify({ error: "loop-io",
        reason: mode === "schema" ? `${host.root}/.pitako/backlog/spec.json: Invalid tasks` : "DECISION overflow: ask the human to consolidate current Board decisions" }), results: [{ index: 0, agent: request.agent, task: request.task, exitCode: 1,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] };
    const result = normal();
    if (request.agent === "pitako.execution-director" && mode === "conflict") {
      // Human edit after the director's prepared view must not be overwritten.
      const file = `${host.root}/.pitako/backlog/spec.json`;
      const input = result.structuredOutput;
      // A preceding independent human initialization is equivalent to a file appearing between prepare/apply.
      const payload = { version: 1, specId: "spec", authority: { specDigest: "a".repeat(64), amendmentDigests: [] },
        acceptance: input.acceptance, acceptanceHistory: [], lastApplied: null, tasks: input.changes.map((change: any) => change.task) };
      mkdirSync(`${host.root}/.pitako/backlog`, { recursive: true });
      writeFileSync(file, JSON.stringify(payload));
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain(mode === "conflict" ? "backlog-conflict" : mode === "schema" ? "/.pitako/backlog/spec.json: Invalid tasks" : "DECISION overflow");
  expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
});

test.each(["unchanged", "changed", "second-stall"])("stalled task selection: %s", async mode => {
  const host = fixture(); host.setLimit(mode === "changed" ? 2 : 3);
  const attempts = new Map<string, number>();
  let persistedFirstStall = false;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director" && request.key.endsWith(".l2.director")) {
      const persisted = readBacklog(host.root, "spec").backlog!;
      persistedFirstStall = persisted.lastApplied?.key === "invoke-human-1.l1.settlement" &&
        persisted.tasks[0]!.progress.nonImproving === 3 && persisted.tasks[0]!.progress.stalls === 1;
      if (mode !== "unchanged") result.structuredOutput.changes.push({ kind: "update", id: "change1",
        patch: { goal: "Narrowed task definition" }, reason: "Address the first stall by narrowing the goal" });
    }
    if (isGate(request) && (request.key.includes(".l1.") || mode === "second-stall")) {
      const receipt = JSON.parse(result.output!);
      const loop = request.key.match(/\.l\d+\./)![0];
      const count = (attempts.get(loop) ?? 0) + 1; attempts.set(loop, count);
      receipt.gates[0].status = "fail"; receipt.gates[0].exit = 1;
      receipt.progress.nonImproving = count; receipt.stalled = count >= 3;
      result.output = JSON.stringify(receipt);
    }
    return result;
  });
  const output = await host.execute();
  const task = readBacklog(host.root, "spec").backlog!.tasks[0]!;
  const secondDirector = host.calls.find(call => call.key.endsWith(".l2.director"));
  expect(secondDirector, output.reason).toBeDefined();
  expect(secondDirector!.task).toContain("Three consecutive non-improving");
  expect(persistedFirstStall).toBe(true);
  expectBoundedStallProjection(host, 1);
  if (mode === "unchanged") {
    expect(output.status).toBe("partial");
    expect(host.history()[1]).toMatchObject({ outcome: "gaps", plan: { stage: "rejected",
      rejection: { diagnostic: "stalled task re-selected without a changed definition" } } });
    expect(host.calls.find(call => call.key.endsWith(".l3.director"))!.task).toContain("stalled task re-selected without a changed definition");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(3);
    expect(task.progress.stalls).toBe(1);
  } else if (mode === "changed") {
    expect(output.status).toBe("partial");
    expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key)).toEqual([
      "invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2", "invoke-human-1.l1.t1.a3", "invoke-human-1.l2.t1.a1"]);
    expect(task).toMatchObject({ goal: "Narrowed task definition", status: "done", progress: { stalls: 1 } });
    expect(host.emits.some(value => value.schema === "pitako.execute-todo" && value.tasks.some((row: any) => row.subject.includes("stalls 1/2")))).toBe(true);
  } else {
    expect(output.status).toBe("needs-decision");
    expect(output.action.actor).toBe("human");
    const diagnoses = task.history.filter(entry => entry.event === "stall").map(entry => entry.reason);
    expect(diagnoses).toHaveLength(2);
    expect(output.loopReport.halt).toMatchObject({ code: "needs-decision", taskId: task.id,
      metricSeries: task.progress.last5, diagnoses });
    expect(output.reason).toContain(task.id);
    expect(output.reason).toContain(JSON.stringify(task.progress.last5));
    expect(output.reason).toContain(JSON.stringify(diagnoses));
    expect(task.progress.stalls).toBe(2);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(6);
    expectBoundedStallProjection(host, 2);
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(2);
    expect(host.calls.some(call => call.key.includes(".review."))).toBe(false);
    const count = host.calls.length;
    const held = await host.execute();
    expect(held.status, held.reason).toBe("needs-decision");
    expect(host.calls.slice(count).some(call => ["pitako.worker", "pitako.execution-director"].includes(call.agent!))).toBe(false);
    expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.progress.stalls).toBe(2);
    expect(host.emits.some(value => value.schema === "pitako.execute-todo" && value.tasks.some((row: any) => row.subject.includes("stalls 2/2")))).toBe(true);

  }
});


test("relaunch adopts a human backlog after a digest conflict without reusing its director", async () => {
  const host = fixture(); host.setLimit(2); let edited = false;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director" && !edited) {
      edited = true;
      const selection = result.structuredOutput;
      const payload = { version: 1, specId: "spec", authority: { specDigest: committed(host).P.prompt.admission!.association.digest, amendmentDigests: [] },
        acceptance: selection.acceptance, acceptanceHistory: [], lastApplied: null,
        tasks: selection.changes.map((change: any) => ({ ...change.task, goal: "Human backlog goal" })) };
      mkdirSync(`${host.root}/.pitako/backlog`, { recursive: true });
      writeFileSync(`${host.root}/.pitako/backlog/spec.json`, JSON.stringify(payload));
    }
    return result;
  });
  expect((await host.execute()).reason).toContain("backlog-conflict");
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
  const count = host.launches.length;
  const held = await host.execute();
  expect(held.reason).toContain("backlog-conflict");
  expect(host.launches).toHaveLength(count);
  host.setInvocation("human-2");
  host.setLimit(1);
  expect((await host.execute()).status).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.execution-director").map(call => call.key)).toEqual([
    "invoke-human-1.l1.director", "invoke-human-2.l1.director"]);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]).toMatchObject({ goal: "Human backlog goal", status: "done" });
});


test.each(["pass", "fail", "stale", "missing-log", "missing-review-receipt"])("final acceptance %s uses workflow gates before completion", async mode => {
  const host = fixture(undefined, { realCheckout: true }); host.setLimit(3);
  const missingLog = mode === "missing-log", missingReceipt = mode === "missing-review-receipt";
  let acceptanceRan = false, driftVersion = 0, quarantine: string | undefined;
  let priorBudget: { consumedLoops: number; maxCycles: number } | undefined;
  let persistedRepairs: NonNullable<ReturnType<typeof readBacklog>["backlog"]>["tasks"] = [];
  let selectedRepair = null as string | null;
  host.setRespond((request, normal) => {
    const checkout = acceptanceCheckout(host, request);
    if (checkout) return checkout;
    if (request.agent === "pitako.worker")
      return host.result(request, { status: "complete", work: "No product changes", remaining: [] });
    const result = normal();
    if (request.agent === "pitako.execution-director" && request.key.includes(".l1."))
      result.structuredOutput.acceptance = [{ id: "acceptance", command: mode === "fail" || missingLog
        ? "false" : "true", cwd: "." }];
    if (isFinalGate(request)) {
      acceptanceRan = true;
      if (mode === "stale") host.changeCheckout(++driftVersion);
    }
    if (pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).recordGaps)
      persistedRepairs = copy(readBacklog(host.root, "spec").backlog!.tasks);
    if (request.agent === "pitako.execution-director" && request.key.includes(".l3."))
      selectedRepair = result.structuredOutput.select;
    return result;
  });
  if (missingLog || missingReceipt) host.setLaunchRespond(async (request, normal) => {
    if (request.agent === "pitako.execution-director" && request.key.startsWith("invoke-human-1.e1."))
      throw new Error("Controlled cut after epoch admission");
    if (pitakoAgentFamily(request.agent) !== "loop-io") return normal();
    const input = JSON.parse(request.task);
    const gaps = input.intentions?.find((entry: { input: { recordGaps?: boolean } }) => entry.input.recordGaps)?.input;
    if (missingLog ? !gaps : input.operation !== "reviewOriginals" || !request.key.endsWith(".reviewOriginals")) return normal();
    priorBudget = host.current().budget;
    const db = openSqliteSync(new PitakoStore(host.root).file);
    try {
      if (missingLog) db.prepare("DELETE FROM blobs WHERE digest=?").run(gaps.finalGapOutputs[0].logRef);
      else {
        const { store } = host.verifications.find(entry => entry.request.gate.endsWith(".review.synthesis"))!.output.receipt;
        expect(db.prepare("SELECT seq FROM records WHERE scope=? AND seq=?").get(store.scope, store.seq)).toBeDefined();
        db.prepare("DELETE FROM records WHERE scope=? AND seq=?").run(store.scope, store.seq);
      }
    }
    finally { db.close(); }
    const response = missingLog
      ? await acceptanceScripts.runDeterministic(request.key, request, { ...acceptanceScripts, root: host.root }, undefined)
      : await normal();
    const failure = JSON.parse(response.output!);
    expect(failure, response.output).toMatchObject({ code: "store-corrupt" });
    quarantine = failure.recovery?.quarantine;
    return response;
  });
  const output = await host.execute();
  expect(acceptanceRan).toBe(true);
  expect(output.status === "complete").toBe(mode === "pass");
  const gate = host.calls.findIndex(isFinalGate);
  const review = host.calls.findIndex(call => call.key.endsWith("review.director-prepare"));
  if (mode === "pass") expect(review).toBeGreaterThan(gate);
  const repairs = readBacklog(host.root, "spec").backlog!.tasks.filter(task => task.origin.kind === "final-phase");
  if (missingLog || missingReceipt) {
    expect(quarantine && existsSync(quarantine), output.reason).toBe(true);
    expect(host.current().epoch).toBe(1);
    expect(host.current().budget.maxCycles).toBe(priorBudget!.maxCycles);
    expect(host.current().budget.consumedLoops).toBeGreaterThanOrEqual(priorBudget!.consumedLoops);
    expect(repairs).toEqual([]);
    expect(host.calls.filter(isFinalGate)).toHaveLength(1);
    if (missingReceipt) {
      expect(review).toBeGreaterThan(gate);
      expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
    }
    return;
  }
  if (mode === "fail") {
    expect(review).toBe(-1);
    const pending = persistedRepairs.filter(task => task.origin.kind === "final-phase");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "pending", origin: { kind: "final-phase" },
      specRefs: ["Final acceptance gate acceptance"] });
    expect(pending[0]!.origin.ref).toContain("invoke-human-1.l2.acceptance");
    const origin = JSON.parse(pending[0]!.origin.ref);
    expect(Object.keys(origin).sort()).toEqual(["key", "logRef"]);
    expect(Buffer.byteLength(pending[0]!.origin.ref)).toBeLessThanOrEqual(512);
    const { logRef } = origin;
    expect(new PitakoStore(host.root).readBlob(logRef).truncated).toBe(false);
    expect(origin.key).toBe("invoke-human-1.l2.acceptance.gate");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ id: pending[0]!.id, status: "done", origin: pending[0]!.origin });
    const director = host.calls.find(call => call.key.endsWith(".l3.director"))!;
    expect(director.task).toContain(`${host.root}/.pitako/backlog/spec.json`);
    expect(selectedRepair).toBe(pending[0]!.id);
    const repair = host.calls.find(call => call.agent === "pitako.worker" && call.key.includes(".l3."))!;
    expect(repair.task).toContain(pending[0]!.id);
    const gapWrite = host.calls.findIndex(call => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).recordGaps);
    expect(gapWrite).toBeLessThan(host.calls.indexOf(director));
  } else expect(repairs).toEqual([]);
  // Measured 73 including IPC Git and one shared runtime, plus eight.
  if (mode === "fail") expectProcessBudget([host.processes(), acceptanceComposition.processes()], 81);
});

test("a no-task final loop resumes its committed mandatory checks and closes complete", async () => {
  const host = fixture(undefined, { realCheckout: true, taskCount: 0 }); host.setLimit(1);
  const gateKey = "invoke-human-1.l1.acceptance.gate";
  const reviewKey = "invoke-human-1.l1.review.director-prepare";
  let cut: ReturnType<typeof host.current>, initialReview: string | undefined, comparedReview = false;
  host.setSaveObserver(value => {
    if (value.action?.opKey === gateKey && value.loop.phase === "review") cut = copy(value);
  });
  host.setLaunchRespond((request, normal) => {
    if (request.key === reviewKey && initialReview === undefined) {
      initialReview = request.task;
      throw new Error("Controlled interruption before native review dispatch");
    }
    if (request.key === reviewKey) {
      expect(request.task).toBe(initialReview!);
      comparedReview = true;
    }
    return normal();
  });
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.execution-director") {
      const plan = normal();
      plan.structuredOutput.acceptance = ["typecheck", "suite"].map(id => ({
        id, command: "echo run >> .pi/final-gate-runs", cwd: ".",
      }));
      return plan;
    }
    if (!request.key.endsWith(".compliance")) return normal();
    // A compliance child can certify only checks it can recover from committed evidence.
    const evidence = /Blocking final acceptance \(mandatory checks\): (.*)\.\n/.exec(request.task)?.[1];
    const { store: ref, digest, gates, after, mutated, currentAcceptance } = JSON.parse(evidence ?? "null") ?? {};
    const store = new PitakoStore(host.root);
    const saved = ref && store.readRecords(ref.scope, { seq: ref.seq, hash: digest });
    const row = saved?.records.at(-1);
    const committedReceipt = storeBody<{ receipt: { after: { fingerprint: string }; gates: typeof gates } }>(row?.body)?.receipt;
    const passed = saved?.identity.storeId === ref?.storeId && row?.digest === digest && currentAcceptance && !mutated &&
      after.fingerprint === host.observedCandidate().fingerprint &&
      after.fingerprint === committedReceipt?.after.fingerprint &&
      ["typecheck", "suite"].every(id => gates.some((gate: any) =>
        gate.id === id && gate.status === "pass" && gate.exit === 0 &&
        committedReceipt?.gates.some((stored: any) => stored.id === id && stored.logRef === gate.logRef &&
          stored.status === "pass" && stored.exit === 0)));
    return passed ? normal() : host.result(request, { status: "blocked", reason: "no mandatory checks" });
  });
  await host.execute();
  expect(initialReview).toBeDefined();
  expect(cut).toBeDefined();
  host.storage.set("pitako-execute", cut);
  const before = host.launches.length, gateRuns = host.gateExecutions(), candidate = host.observedCandidate();
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  expect(host.history().at(-1)!.outcome).toBe("complete");
  expect(comparedReview).toBe(true);
  expect(host.launches.slice(before).filter(call => call.key.startsWith(gateKey)).map(call => call.key)).toEqual([`${gateKey}.r1`]);
  expect(host.launches.slice(0, before).filter(call => call.key.startsWith(gateKey)).map(call => call.key)).toEqual([gateKey]);
  expect(host.gateExecutions()).toBe(gateRuns);
  expect(readFileSync(`${host.root}/.pi/final-gate-runs`, "utf8")).toBe("run\nrun\n");
  expect(host.observedCandidate()).toEqual(candidate);
  expect(host.launches.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(1);
  expect(host.launches.some(call => call.agent === "pitako.worker")).toBe(false);
});


test.each(["intact", "store-ahead", "pre-commit", "paginated", "retry-diagnostic", "stale"])("final acceptance %s receipt on replay authorizes only current completion", async mode => {
  const host = fixture(undefined, { realCheckout: true, taskCount: 0 }); host.setLimit(mode === "intact" ? 2 : 1);
  const gateKey = "invoke-human-1.l1.acceptance.gate", runLog = `${host.root}/.pi/final-gate-runs`;
  let beforeGate: ReturnType<typeof host.current>;
  const paginated = mode === "paginated" || mode === "retry-diagnostic";
  const retryDiagnostic = mode === "retry-diagnostic";
  const interrupted = mode === "pre-commit" || retryDiagnostic;
  const losesSave = mode === "store-ahead" || paginated || interrupted;
  let originalDigest: string | undefined, retryTask: string | undefined;
  if (losesSave) {
    host.setSaveObserver(value => {
      if (!beforeGate && value.action?.opKey === gateKey) beforeGate = copy(value);
    });
    host.setRespond(async (request, normal) => {
      if (request.agent === "pitako.execution-director") {
        const plan = normal();
        plan.structuredOutput.acceptance = [{ id: "suite", command: "echo run >> .pi/final-gate-runs", cwd: "." }];
        return plan;
      }
      if (paginated && request.agent === "pitako.request-observer" &&
          (request.key.endsWith(".selectionIO.requests") || /\.l1\.requests-\d+$/.test(request.key))) {
        if (request.key.endsWith(".selectionIO.requests")) {
          appendExecuteTodoRecords(host.root, "human-1", "request", Array.from({ length: 140 }, (_, i) => ({
            v: 1, invocation: "human-1", kind: "cancel", origin: "fixture", taskId: "unselected",
            at: 1, requestId: `${i}-${"x".repeat(240)}`,
          })));
        }
        const output = execFileSync(process.execPath, [fileURLToPath(new URL("../skills/execute/observe.mjs", import.meta.url)), "--requests"],
          { cwd: host.root, input: request.task, encoding: "utf8" });
        return { ...normal(), output };
      }
      if (retryDiagnostic && request.key === `${gateKey}.r1`) {
        if (retryTask !== undefined) {
          expect(request.task).toBe(retryTask);
          return normal();
        }
        retryTask = request.task;
        const { operation, ...envelope } = JSON.parse(request.task);
        const resolved = resolveStoredGroupedInput(operation, envelope);
        const input = (resolved.finalAcceptanceReplay as { request: Parameters<typeof runGate>[0] }).request;
        expect(canonicalDigest(input)).toBe(originalDigest!);
        await runGate({ ...input, dbPath: `${host.root}/.pi/final-gate-board.db` },
          { digest: originalDigest!, producer: request.key });
        throw new Error("Controlled second interruption after the retry diagnostic, before the final gate commit");
      }
      if (!isFinalGate(request)) return normal();
      const { operation: _, ...input } = JSON.parse(request.task);
      originalDigest = canonicalDigest(input);
      if (retryDiagnostic) {
        mkdirSync(`${host.root}/.pi/subagents/execute/human-1/gates/${gateKey}`, { recursive: true });
        return { ok: false, agent: request.agent, key: request.key, runId: `native-${request.key}`,
          output: "Controlled missing receipt from the first gate transport", results: [{ exitCode: 1 }] } as Result;
      }
      const receipt = await runGate({ ...input, dbPath: `${host.root}/.pi/final-gate-board.db` },
        { digest: originalDigest, producer: request.key });
      if (interrupted) throw new Error("Controlled interruption before the final gate commit");
      return { ok: true, agent: request.agent, key: request.key, runId: `native-${request.key}`,
        output: JSON.stringify(receipt), results: [{ exitCode: 0 }] } as Result;
    });
  }
  host.setFailSave(value => value.action?.key?.endsWith(".review.director-prepare"));
  const first = await host.execute();
  if (interrupted) expect(first.status).not.toBe("complete");
  else expect(first.status).toBe("partial");
  const retained = interrupted ? beforeGate! : copy(host.current());
  expect(retained.loop.taskId).toBeNull();
  expect(retained.action.opKey).toBe(gateKey);
  if (!interrupted) expect(committed(host, retained).records.at(-1)!.opKey).toBe(`final-gate:${gateKey}`);
  if (paginated) {
    const { store, scope } = executeStore(host.root, retained.invocation);
    const intervening = store.readRecords(scope).records.slice(beforeGate!.head.seq);
    expect(intervening.some(row => row.kind === "observation")).toBe(true);
    if (retryDiagnostic) {
      expect(retryTask).toBeDefined();
      expect(intervening.at(-1)!.opKey).toBe(`gate:${gateKey}.r1`);
    }
  }
  if (mode === "stale") host.changeCheckout();
  host.storage.set("pitako-execute", losesSave ? beforeGate! : retained);
  host.setFailSave(undefined);
  const gates = host.gateExecutions(), launches = host.launches.length;
  const output = await host.execute();
  expect(output.status === "complete", output.reason).toBe(mode !== "stale");
  expect(host.gateExecutions()).toBe(gates);
  expect(host.launches.slice(launches).filter(call => call.key.startsWith(gateKey)).map(call => call.key)).toEqual([`${gateKey}.r1`]);
  if (mode === "intact") {
    // Valid-looking stdout is not sufficient when it differs from the committed receipt.
    host.storage.set("pitako-execute", copy(retained));
    const beforeMismatch = host.launches.length;
    host.setLaunchRespond(async (request, normal) => {
      const response = await normal();
      if (request.key !== `${gateKey}.r1`) return response;
      const replay = JSON.parse(response.output!);
      replay.receipt.gates[0].logRef += "-mismatch";
      return { ...response, output: JSON.stringify(replay) };
    });
    const mismatch = await host.execute();
    expect(mismatch.status).not.toBe("complete");
    expect(mismatch.reason).toContain("Final acceptance replay record integrity mismatch");
    expect(host.launches.slice(beforeMismatch).map(call => call.key)).toEqual([`${gateKey}.r1`]);
    expect(host.gateExecutions()).toBe(gates);

    const cut = copy(retained);
    cut.head = { seq: cut.head.seq + 1, hash: "f".repeat(64) };
    host.storage.set("pitako-execute", cut);
    const beforeCheck = host.launches.length;
    let quarantine: string | undefined;
    host.setLaunchRespond(async (request, normal) => {
      if (request.key === "invoke-human-1.e1.l2.director")
        throw new Error("Controlled cut after new epoch admission, before gates");
      if (request.key !== `${gateKey}.store-check`) return normal();
      const response = await acceptanceScripts.runDeterministic(request.key, request,
        { ...acceptanceScripts, root: host.root }, undefined);
      quarantine = JSON.parse(response.output!).recovery.quarantine;
      return response;
    });
    await host.execute();
    expect(quarantine && existsSync(quarantine)).toBe(true);
    expect(host.current().epoch).toBe(1);
    expect(host.launches.slice(beforeCheck).filter(call => call.key.startsWith(gateKey)).map(call => call.key))
      .toEqual([`${gateKey}.store-check`]);
    expect(host.gateExecutions()).toBe(gates);
  }
  if (losesSave) expect(readFileSync(runLog, "utf8")).toBe("run\n");
  if (paginated) {
    expect(host.current().epoch).toBe(0);
    expect(readdirSync(`${host.root}/.pi/pitako`).filter(name => name.startsWith("pitako.db.v"))).toEqual([]);
  }
  expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
});


test.each(["timeout", "error"])("final acceptance %s retains actionable logs with no repair task", async status => {
  const host = fixture(undefined, { taskCount: 0 }); host.setLimit(2);
  host.setRespond((request, normal) => {
    if (isGate(request)) {
      const { result, receipt } = gateReceipt(normal);
      receipt.gates[0] = { ...receipt.gates[0], status, exit: null, logRef: "/owned/final-suite.log" };
      return { ...result, output: JSON.stringify(receipt) };
    }
    return normal();
  });
  const output = await host.execute();
  expect(output.status).toBe(status === "timeout" ? "partial" : "blocked");
  expect(output.reason).toContain(status === "timeout" ? "gateFloorMs strictly greater" : "environment failure");
  expect(output.reason).toContain("/owned/final-suite.log");
  expect(host.current().halt.stage).toBe(status === "timeout" ? "timeout" : "environment");
  expect(host.records().some((record: any) => record.kind === "loop" && record.body.kind === "final")).toBe(false);
  expect(host.calls.some(call => call.agent === "pitako.worker" || call.key.includes(".review.") || call.key.endsWith(".compliance"))).toBe(false);
  expect(readBacklog(host.root, "spec").backlog!.tasks).toEqual([]);
});

test.each(["review", "compliance"])("final-phase %s findings become durable tasks for the next director", async phase => {
  // The live save observer measures every mission write; historical copies are unused here.
  const host = fixture(undefined, { taskCount: 0, findings: true, retainSnapshots: false }); host.setLimit(3);
  let peakBytes = 0, consumed = false;
  host.setSaveObserver((value, bytes, serialized) => {
    peakBytes = Math.max(peakBytes, bytes);
    for (const original of value.review?.slots ?? []) expect(original).not.toHaveProperty("value");
    expect(serialized).not.toContain("LARGE_REVIEW_");
    if (value.loop?.taskId && !value.loop.outcome) {
      const selected = committed(host, value).P.prompt.selectedTask;
      expect(selected?.id).toBe(value.loop.taskId);
      expect(serialized).not.toContain(storeBody<{ ref: string }>(selected?.origin).ref);
    }
  });
  host.setRespond((request, normal) => {
    if (request.key.endsWith(".l2.director")) {
      const retained = host.records().find((record: any) => record.kind === "loop" && record.loop === 1).body.integratedReview;
      expect(retained.originals.length).toBeGreaterThan(0);
      for (const original of retained.originals) {
        expect(Object.keys(original).sort()).toEqual(["id", "key", "path", "runId", "sha256"]);
        expect(original.sha256).toBe(createHash("sha256").update(readFileSync(original.path)).digest("hex"));
      }
      if (phase === "review") {
        const advance = committed(host).records.filter(row => /^operation:invoke-human-1\.l[12]\.(?:nextAdvance|advance)$/.test(row.opKey)).at(-1);
        const demand = storeBody<{ request: { demand: { sources: { loop: number; sources: { kind: string; ref: unknown }[] }[] } } }>(advance?.body)
          .request.demand;
        const source = demand.sources.find(item => item.loop === 1)?.sources.find(item => item.kind === phase)!;
        expect(Object.keys(source.ref as object).sort()).toEqual(["key", "path", "sha256"]);
        expect(source).not.toHaveProperty("references");
      }
      consumed = true;
    }
    const result = normal();
    if (request.key.includes(".review.independent-"))
      result.structuredOutput.coverage = `LARGE_REVIEW_${request.key}:` + "x".repeat(12 * 1024);
    if (request.key.includes(".l1.")) {
      if (phase === "review" && request.key.endsWith("director-synthesis")) {
        result.structuredOutput.screening.verdict = "material-gaps";
        result.structuredOutput.screening.reason = "Required observable behavior missing";
        result.structuredOutput.screening.assessments[0].material = true;
      }
      if (phase === "compliance" && request.key.endsWith(".compliance")) {
        result.structuredOutput.status = "gaps";
        result.structuredOutput.reason = "Required observable behavior missing";
        result.structuredOutput.requirements[0].status = "gap";
      }
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  expect(consumed).toBe(true);
  console.log(`consumed ${phase} review/repair/final mission peak: ${peakBytes} bytes`);
  expect(peakBytes).toBeLessThan(80 * 1024);
  const backlog = readBacklog(host.root, "spec").backlog!;
  expect(backlog.tasks).toHaveLength(1);
  expect(backlog.tasks[0]).toMatchObject({ status: "done", origin: { kind: "final-phase" } });
  expect(backlog.tasks[0]!.origin.ref).toContain(phase === "review" ? ".review." : ".compliance");
  const origin = checkOrigin(backlog.tasks[0]!.origin.ref);
  expect(origin.key).toBe(`invoke-human-1.l1.${phase === "review" ? "review.director-synthesis" : "compliance"}`);
  const original = JSON.parse(readFileSync(origin.path, "utf8"));
  expect(phase === "review" ? original.screening.reason : original.reason).toBe("Required observable behavior missing");
  expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(3);
  expect(host.calls.filter(call => call.agent === "pitako.worker").every(call => call.key.includes(".l2."))).toBe(true);
  expect(host.calls.some(call => call.key.includes(".l2.review.") || call.key === "invoke-human-1.l2.compliance")).toBe(false);
  if (phase === "review") expect(host.calls.some(call => call.key === "invoke-human-1.l1.compliance")).toBe(false);
  const repair = host.calls.find(call => call.agent === "pitako.worker")!;
  const gapWrite = host.calls.findIndex(call => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).recordGaps);
  expect(gapWrite).toBeLessThan(host.calls.indexOf(repair));
});

test("final review receives done and obsolete reasons, current DECISIONs, and follows acceptance", async () => {
  const host = fixture(); host.setLimit(2);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key.endsWith(".l1.director")) {
      const task = copy(result.structuredOutput.changes[0].task); task.id = "obsolete-task";
      result.structuredOutput.changes.push({ kind: "add", task, reason: "Initial requirement" },
        { kind: "obsolete", id: task.id, reason: "Superseded by selected implementation" });
    }
    if (isGate(request)) {
      const receipt = JSON.parse(result.output!);
      receipt.view.posts = [{ id: 1, type: "DECISION", content: "Keep required boundary validation" }];
      result.output = JSON.stringify(receipt);
    }
    return result;
  });
  expect((await host.execute()).status).toBe("complete");
  const review = host.calls.find(call => call.key.endsWith("review.director-prepare"))!;
  expect(review.task).toContain("Workflow-confirmed gated unit");
  expect(review.task).toContain("Superseded by selected implementation");
  expect(review.task).toContain("Keep required boundary validation");
  const gateIndex = host.calls.findIndex(isFinalGate);
  expect(host.calls.indexOf(review)).toBeGreaterThan(gateIndex);
  expect(host.calls.findIndex(call => call.key.endsWith(".compliance"))).toBeGreaterThan(host.calls.indexOf(review));
  expect(host.current().budget.consumedLoops).toBe(2);
});

test.each(["pass", "fail", "timeout", "error", "superseded", "blocking-failure"])("final verdict honors only current HUMAN exceptions: %s", async mode => {
  const human = { id: 42, type: "HUMAN", content: "Loader may fail", author: "root", createdAt: "2026-11-08",
    metadata: { quote: "Loader may fail", saidAt: "2026-11-08" } };
  const host = fixture(undefined, { realCheckout: true, taskCount: 0, humanPosts: [human] }); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director") result.structuredOutput.acceptance = [
      { id: "blocking", command: "true", cwd: "." },
      { id: "loader", command: "true", cwd: ".", verifies: [1], exception: { humanRef: 42, reason: "Loader may fail" } },
    ];
    if (isGate(request)) {
      const receipt = JSON.parse(result.output!);
      if (mode !== "pass") Object.assign(receipt.gates[1], { status: ["timeout", "error"].includes(mode) ? mode : "fail",
        exit: ["timeout", "error"].includes(mode) ? null : 1 });
      if (mode === "blocking-failure") Object.assign(receipt.gates[0], { status: "fail", exit: 1 });
      // Authority changed while the gate ran: the fresh receipt, not the selection, decides.
      if (mode === "superseded") receipt.view.posts = [{ ...human, id: 43, content: "Loader must now pass" }];
      result.output = JSON.stringify(receipt);
    }
    return result;
  });
  const output = await host.execute({ originalProblem: { criteria: [1] } });
  const blocked = ["superseded", "blocking-failure"].includes(mode);
  expect(output.status, output.reason).toBe(blocked ? "partial" : "complete");
  const repairs = readBacklog(host.root, "spec").backlog!.tasks;
  if (blocked) {
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.specRefs).toEqual([`Final acceptance gate ${mode === "superseded" ? "loader" : "blocking"}`]);
    expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
  } else {
    expect(repairs).toEqual([]);
    for (const suffix of ["review.director-prepare", ".compliance"]) {
      const brief = host.calls.find(call => call.key.endsWith(suffix))!.task;
      expect(brief).toContain("Loader may fail");
      expect(brief).toContain('"humanRef":42');
      expect(brief).toContain("Excepted acceptance results:");
      expect(brief).toContain("Acceptance history:");
      expect(brief).toContain("Inspect acceptanceHistory and report as a gap any acceptance replacement that narrows, filters or relaxes a command and cites no HUMAN post ID that is current in this execute topic.");
      expect(brief).toContain('"kind":"init"');
      expect(brief).toContain("not a gap or repair task");
    }
    if (mode === "pass") {
      expect(output.heading).toBe("Execution complete");
      expect(output).not.toHaveProperty("exceptions");
      expect(output.originalProblem.status).toBe("fulfilled");
    } else {
      expect(output.heading).toBe("Execution complete with exceptions");
      expect(output.exceptions).toEqual([{ id: "loader", status: mode, exit: mode === "fail" ? 1 : null,
        logRef: expect.any(String), humanRef: 42, reason: "Loader may fail" }]);
      expect(output.originalProblem.status).toBe("unfulfilled");
    }
  }
});


const finalGates = (host: ReturnType<typeof fixture>) => host.calls.filter(isFinalGate);
function repeatedAcceptanceFixture() {
  const humanPosts: any[] = [];
  const host = fixture(undefined, { realCheckout: true, taskCount: 0, humanPosts }); host.setLimit(5);
  let allowException = false;
  host.setRespond((request, normal) => {
    const checkout = acceptanceCheckout(host, request);
    if (checkout) return checkout;
    // This fixture asserts real acceptance commands/log reuse, not product edits.
    if (request.agent === "pitako.worker")
      return host.result(request, { status: "complete", work: "No product changes", remaining: [] });
    const result = normal();
    if (request.agent === "pitako.execution-director" && (request.key.includes(".l1.") || allowException))
      result.structuredOutput.acceptance = [
        { id: "blocking", command: "true", cwd: "." },
        { id: "suite", command: "echo run >> .pi/suite-runs; false", cwd: ".",
          ...(allowException ? { exception: { humanRef: 42, reason: "Human permits suite failure" } } : {}) },
      ];
    return result;
  });
  return { host, authorizeException: () => {
    allowException = true;
    humanPosts.push({ id: 42, type: "HUMAN", content: "Suite may fail", metadata: { quote: "Suite may fail", saidAt: "2026-11-08" } });
  } };
}

test("fresh then reused acceptance failure halts with original logs and relaunch re-finishes unchanged", async () => {
  const { host } = repeatedAcceptanceFixture();
  const output = await host.execute();
  expect(output.status, output.reason).toBe("blocked");
  expect(output.loopReport?.halt?.code, output.reason).toBe("repeat-acceptance");
  const record = JSON.parse(finalGates(host)[1]!.task).reuse;
  expect(record).toMatchObject({ loop: 1, gateKey: "invoke-human-1.l1.acceptance.gate" });
  expect(Object.keys(record).sort()).toEqual(["candidate", "exec", "gateKey", "loop", "results"]);
  expect(finalGates(host)).toHaveLength(2);
  expect(JSON.parse(finalGates(host)[1]!.task).reuse).toEqual(record);
  expect(readFileSync(`${host.root}/.pi/suite-runs`, "utf8")).toBe("run\n");
  expect(output.reason).toContain(record.results[1].logRef);
  const calls = host.calls.length, hostCalls = host.hostCalls.length;
  const replay = await host.execute();
  expect(replay.status).toBe("blocked");
  expect(replay.reason).toBe(output.reason);
  expect(host.calls).toHaveLength(calls);
  expect(host.hostCalls.slice(hostCalls)).toEqual(["inspect-initial"]);
  expect(replay.loopReport.halt).toEqual(output.loopReport.halt);
  expect(host.current().budget.consumedLoops).toBe(3);
});



test("a reused passing receipt proceeds through review on the unchanged candidate", async () => {
  const host = fixture(undefined, { realCheckout: true, taskCount: 0, findings: true }); host.setLimit(3);
  const gateKey = "invoke-human-1.l3.acceptance.gate";
  let pending: ReturnType<typeof host.current>, original: string | undefined;
  host.setSaveObserver(value => {
    if (!pending && value.action?.opKey === gateKey) pending = copy(value);
  });
  host.setRespond(async (request, normal) => {
    if (request.key === gateKey) {
      original = request.task;
      throw new Error("Controlled cut before the reused gate commits");
    }
    if (request.key === `${gateKey}.r1`) {
      const { operation, ...envelope } = JSON.parse(request.task);
      const resolved = resolveStoredGroupedInput(operation, envelope);
      const pendingGate = resolved.finalAcceptanceReplay as { request: Parameters<typeof runGate>[0] } | undefined;
      if (pendingGate) {
        const { request: gate } = pendingGate;
        expect(canonicalJSON({ operation, ...gate })).toBe(canonicalJSON(JSON.parse(original!)));
        const receipt = await runGate({ ...gate, dbPath: `${host.root}/.pi/final-gate-board.db` },
          { digest: canonicalDigest(gate), producer: request.key });
        commitFinalGate(gate, receipt, request.key);
      }
    }
    const result = normal();
    if (request.key.includes(".l1.") && request.key.endsWith("director-synthesis")) {
      result.structuredOutput.screening.verdict = "material-gaps";
      result.structuredOutput.screening.reason = "Required behavior missing";
      result.structuredOutput.screening.assessments[0].material = true;
    }
    return result;
  });
  expect((await host.execute()).status).not.toBe("complete");
  expect(original).toBeDefined();
  host.storage.set("pitako-execute", pending!);
  const launches = host.launches.length, gateRuns = host.gateExecutions();
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  expect(host.launches.slice(launches).filter(call => isGate(call)).map(call => call.key)).toEqual([`${gateKey}.r1`]);
  expect(host.gateExecutions()).toBe(gateRuns);
  const gates = finalGates(host);
  expect(gates).toHaveLength(2);
  expect(JSON.parse(gates[1]!.task).reuse.loop).toBe(1);
  expect(storeBody<{ finalAttempt: { gate: { receipt: { reused: { loop: number } } } } }>(host.records().at(-1)!.body)
    .finalAttempt.gate.receipt.reused.loop).toBe(1);
  expect(host.calls.some(call => call.key === "invoke-human-1.l3.review.director-prepare")).toBe(true);
});




test("a new invocation has no reusable final acceptance record", async () => {
  const first = fixture(undefined, { taskCount: 0 }); first.setLimit(1);
  expect((await first.execute()).status).toBe("complete");
  expect(committed(first).records.find(row => row.opKey === "final-gate:invoke-human-1.l1.acceptance.gate")?.body).toBeDefined();
  const second = fixture(undefined, { taskCount: 0 }); second.setLimit(1);
  second.setInvocation("human-2");
  expect((await second.execute()).status).toBe("complete");
  expect(finalGates(second)).toHaveLength(1);
  expect(JSON.parse(finalGates(second)[0]!.task)).not.toHaveProperty("reuse");
});


test.each(["missing", "changed"])("a compact review demand blocks on a %s original with its expected digest", async mode => {
  const host = fixture(undefined, { taskCount: 0, findings: true }); host.setLimit(3);
  let expected = "";
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key === "invoke-human-1.l1.review.director-synthesis") {
      result.structuredOutput.screening.verdict = "material-gaps";
      result.structuredOutput.screening.reason = "Required observable behavior missing";
      result.structuredOutput.screening.assessments[0].material = true;
    }
    if (request.agent === "pitako.checkout-observer" && request.key.includes(".l1.")) {
      const publication = committed(host).records.filter(row => row.kind === "review-originals").at(-1);
      const ref = storeBody<{ originals: { path: string; sha256: string }[] }>(publication?.body).originals.at(-1)!;
      expected = ref.sha256;
      if (mode === "missing") unlinkSync(ref.path);
      else writeFileSync(ref.path, "{}");
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(expected).toMatch(/^[a-f0-9]{64}$/);
  expect(output.reason).toContain(expected);
  expect(host.calls.some(call => call.key === "invoke-human-1.l2.demand-observation")).toBe(false);
  expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
});


test.each(["before", "after", "conflicting-agent"])("consumed review compaction replays %s without replaying reviewers", async mode => {
  const cut = mode === "before" ? "before" : "after";
  const template = "---\npitako-spec: 1\nid: spec\nstatus: complete\n---\n" +
    SPEC_SECTIONS.map(section => `## ${section}\nAgreed ${section}.\n`).join("");
  const content = template + "\\".repeat(MAX_SPEC_BYTES - Buffer.byteLength(template));
  expect(validateSpec(content, "spec")).toBeNull();
  expect(inspectionSnapshot({}, content).packets).toHaveLength(26);
  const host = fixture(content, { taskCount: 0 });
  const loop = cut === "before" ? 2 : 1;
  host.setLimit(loop);
  if (loop === 2) host.setObservationResponse((key, observation) => key === "invoke-human-1.l1.checkout"
    ? { ...observation, checkout: { ...observation.checkout, fingerprint: "f".repeat(64) } } : observation);
  const base = `invoke-human-1.l${loop}`, synthesis = `${base}.review.director-synthesis`;
  const publicationKey = `${base}.reviewOriginals`;
  let reached = false, publicationHead: { seq: number; hash: string } | undefined;
  let normalPublication: string | undefined, recoveredPublication: string | undefined, normalCompliance: string | undefined;
  host.setSaveObserver(value => {
    if (cut === "before" && value.action.key === synthesis && value.action.runId) reached = true;
  });
  host.setLaunchRespond(async (request, normal) => {
    if (cut === "after" && request.key === `${base}.compliance` && normalCompliance === undefined) {
      normalCompliance = request.task;
      throw new Error("Observe the uninterrupted compliance prompt without settling the child");
    }
    const result = await normal();
    if (cut === "after" && request.key === publicationKey) {
      normalPublication = result.output;
      publicationHead = JSON.parse(result.output!).head;
    }
    if (request.key === `${publicationKey}.r1`) recoveredPublication = result.output;
    return result;
  });
  host.setFailSave(() => reached);
  const initial = await host.execute();
  if (cut === "before") expect(initial.reason).toContain("Essential persistence failed");
  else expect(normalCompliance).toBeDefined();
  // Use the same store rows and native originals for the byte comparison.
  const retained = cut === "after" ? [...host.snapshots].reverse().find(value => value.action.key === synthesis && value.action.runId) : copy(host.current());
  expect(retained.action).toMatchObject({ kind: "launched", role: "reviewer", key: synthesis });
  expect(typeof retained.action.runId).toBe("string");
  expect(retained.review.slots.every((original: any) => !Object.hasOwn(original, "value") && Boolean(original.digest))).toBe(true);
  expect(committed(host, { ...retained, head: publicationHead ?? retained.head }).records
    .some(row => row.kind === "review-originals" && row.opKey === `review-originals:${publicationKey}`)).toBe(cut === "after");
  if (loop === 2) expect(host.launches.some(call =>
    ["invoke-human-1.l1.nextAdvance", "invoke-human-1.l2.advance"].includes(call.key))).toBe(false);
  const reviewers = host.calls.filter(call => call.key.includes(".review.")).length;
  const before = host.launches.length, hostReads = host.hostCalls.length;
  host.setFailSave(undefined);
  if (cut === "after") await host.state.set("pitako-execute", retained);
  if (mode === "conflicting-agent") host.setStatus(ref => {
    const result = host.native.get(ref);
    return ref === retained.action.runId ? { ...result!, agent: "pitako.review-angle" }
      : result ?? { ok: false, state: "unknown" };
  });
  const output = await host.execute();
  if (mode === "conflicting-agent") {
    expect(output.status, output.reason).toBe("blocked");
    expect(output.reason).toContain("Final review replay producer integrity mismatch");
    expect(host.launches.slice(before).map(call => call.key)).toEqual([`${publicationKey}.r1`]);
    expect(host.current()).toEqual(retained);
    return;
  }
  expect(output.status, output.reason).toBe("complete");
  expect(host.calls.filter(call => call.key.includes(".review."))).toHaveLength(reviewers);
  expect(host.launches.slice(before).map(call => call.key)).toEqual([
    `${publicationKey}.r1`, `${base}.compliance`, `${base}.checkout`, `${base}.finishDrain`,
  ]);
  if (cut === "after") expect(recoveredPublication).toBe(normalPublication!);
  expect(host.hostCalls).toHaveLength(hostReads);
  const genesis = host.records()[0]!;
  expect(canonicalJSON(genesis)).toBe(canonicalJSON({
    prev: null, seq: 0, kind: "spec", loop: 0, body: { content, digest: sha256(content) },
  }));
  const archive = storeBody<{ startedAt: number; integratedReview: { originals: { sha256: string }[] } }>(host.records().at(-1)!.body);
  expect(archive.integratedReview.originals.every(original => !Object.hasOwn(original, "value") && Boolean(original.sha256))).toBe(true);
  expect(host.current().loop).not.toHaveProperty("reviewOriginals");
  if (loop === 2) {
    const selection = committed(host).records.find(row => row.opKey === `operation:${base}.selectionIO`);
    expect(archive.startedAt).toBe(storeBody<{ request: { loopStartedAt: number } }>(selection?.body).request.loopStartedAt);
  }
  const compliance = host.calls.find(call => call.key === `${base}.compliance`)!;
  expect(compliance.task).toContain("Completed review originals:");
  expect(compliance.task).toContain(archive.integratedReview.originals[0]!.sha256);
  if (cut === "after") {
    expect(compliance.task).toBe(normalCompliance!);
  } else {
    const invalid = fixture(undefined, { taskCount: 0, findings: true });
    invalid.setLimit(1);
    const invalidSynthesis = "invoke-human-1.l1.review.director-synthesis";
    invalid.setLaunchRespond(async (request, normal) => {
      const result = await normal();
      if (request.key === invalidSynthesis)
        result.structuredOutput.dispositions[0].classification = "uncertain";
      return result;
    });
    const reason = "Director returned invalid finding scope or unsupported inclusion.";
    expect((await invalid.execute()).reason).toContain(reason);
    const pending = invalid.snapshots.find(value => value.action.key === invalidSynthesis && value.action.runId);
    expect(pending).toBeDefined();
    await invalid.state.set("pitako-execute", pending);
    const beforeReplay = invalid.launches.length;
    expect((await invalid.execute()).reason).toContain(reason);
    expect(invalid.launches.slice(beforeReplay).map(call => call.key)).toEqual(["invoke-human-1.l1.reviewOriginals.r1"]);
    expect(committed(invalid).records.some(row => row.kind === "review-originals")).toBe(false);
    expect(invalid.launches.some(call => call.key.endsWith(".compliance"))).toBe(false);
  }
});


test("director guidance and update schema match the runtime update whitelist", async () => {
  const host = taskFixture();
  await host.execute();
  const director = host.calls.find(call => call.agent === "pitako.execution-director")!;
  expect(director.task).toContain("acceptance: [{id, command, cwd, verifies?, exception?: {humanRef, reason}}]");
  expect(director.task).toContain("only when a current HUMAN in the view exempts that command; humanRef is that post's id");
  expect(director.task).toContain("At least one entry stays blocking");
  expect(director.task).toContain("update patches only goal, expectedResult, specRefs, dependsOn, gates, metric, remaining and title");
  expect(director.task).toContain("never change id, origin or status (use obsolete, split or add)");
  const update = director.outputSchema.properties.changes.items.anyOf.find((schema: any) => schema.properties.kind.const === "update");
  expect(Object.keys(update.properties.patch.properties).sort()).toEqual([...TASK_UPDATE_KEYS].sort());
  expect(update.properties.patch.additionalProperties).toBe(false);
  const tool = { name: "selection", description: "Backlog selection", parameters: director.outputSchema };
  const validate = (patch: any) => validateToolArguments(tool, { type: "toolCall", id: "plan", name: tool.name,
    arguments: { select: null, changes: [{ kind: "update", id: "task", patch, reason: "Revise task" }], reason: "Revise" } });
  expect(() => validate({ title: "Short title", remaining: "" })).not.toThrow();
  for (const key of ["id", "origin", "status", "unknown"]) expect(() => validate({ [key]: "changed" })).toThrow();
});


test.each(["HUMAN + DECISION overflow: ask the human to consolidate", "Gate receipt exceeds 8 KiB"])("%s halts without redispatching the gate", async reason => {
  const host = taskFixture();
  host.setRespond((request, normal) => {
    if (!isGate(request)) return normal();
    return { ...host.result(request, null), ok: false,
      output: JSON.stringify({ error: "loop-io", reason, viewOverflow: true }) };
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toBe(reason);
  expect(host.calls.filter(isGate)).toHaveLength(1);
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  expect(host.calls.some(call => call.agent === "pitako.checkpoint-sealer")).toBe(false);
  const launches = [...host.launches], cursor = host.current();
  host.setRespond();
  const held = await host.execute();
  expect(held.loopReport.halt).toEqual(output.loopReport.halt);
  expect(host.launches).toEqual(launches);
  expect(host.current()).toEqual(cursor);
});

test("prepare binding overflow stops before any worker launch", async () => {
  const host = taskFixture();
  host.setRespond((request, normal) => {
    if (pitakoAgentFamily(request.agent) !== "loop-io" || JSON.parse(request.task).operation !== "prepare") return normal();
    return { ...host.result(request, null), ok: false,
      output: JSON.stringify({ error: "loop-io", reason: "HUMAN + DECISION overflow: ask the human to consolidate", viewOverflow: true }) };
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain("consolidate");
  expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
});


test.each(["missing", "fresh", "resume", "too-long", "bad-mode", "missing-reason"])("worker continuation opinion validates and stays separate from diagnosis: %s", async mode => {
  const host = taskFixture();
  let first = true;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker" && first) {
      first = false;
      if (mode !== "missing") result.structuredOutput.continuation = mode === "missing-reason" ? { mode: "resume" }
        : { mode: mode === "bad-mode" ? "invalid" : mode === "fresh" ? "fresh" : "resume", reason: "x".repeat(mode === "too-long" ? 201 : 200) };
    }
    return result;
  });
  expect((await host.execute()).status).toBe("partial");
  const value = host.records().find((record: any) => record.kind === "loop" && record.loop === 1)!.body.results[0];
  if (["too-long", "bad-mode", "missing-reason"].includes(mode)) {
    expect(value.status).toBe("rejected"); expect(value.rejection).toContain("continuation opinion");
  } else {
    expect(value.status).toBe("complete");
    expect(value.revival).toEqual({ opinion: mode === "resume" ? "resume" : "fresh", reason: mode === "missing" ? "" : "x".repeat(200),
      decision: "fresh", code: "missing-peak", peak: null });
    const schema = host.calls.find(call => call.agent === "pitako.worker")!.outputSchema;
    expect(schema.required).not.toContain("continuation");
    expect(schema.properties.continuation.properties.reason.maxLength).toBe(200);
    const validate = (length: number) => validateToolArguments({ name: "worker", description: "Worker result", parameters: schema },
      { type: "toolCall", id: "report", name: "worker", arguments: { work: "Done", status: "complete", remaining: [],
        continuation: { mode: "resume", reason: "x".repeat(length) } } });
    expect(() => validate(200)).not.toThrow();
    expect(() => validate(201)).toThrow();
  }
});

test("attempt metadata preserves a resume opinion alongside gate diagnosis and peak", async () => {
  const host = taskFixture(); let first = true;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker") result.structuredOutput.continuation = { mode: "resume", reason: "Context remains useful" };
    if (isGate(request)) {
      const input = JSON.parse(request.task);
      const intent = input.refs?.intent;
      const checkpoint = input.checkpoint ?? committed(host).records.find(row =>
        row.kind === "intent" && row.seq === intent?.seq && row.digest === intent.digest)?.body;
      expect(checkpoint.key).toBe(request.key.replace(/\.gate$/, ""));
      const receipt = JSON.parse(result.output!); receipt.contextPeak = 1234;
      if (first) { first = false; receipt.gates[0].status = "fail"; receipt.gates[0].exit = 1; receipt.gates[0].tail = "Fix this assertion"; }
      result.output = JSON.stringify(receipt);
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  const firstResult = host.records().find((record: { kind: string; body: { attempt?: number } }) =>
    record.kind === "unit" && record.body.attempt === 1)?.body.result;
  expect(firstResult).toBeDefined();
  expect(firstResult.status).toBe("continue"); expect(firstResult.usefulContinuation).toBe(true);
  expect(firstResult.diagnosis).toContain("change1-check: fail");
  expect(firstResult.diagnosis).toContain("/native/gates/invoke-human-1.l1.t1.a1.gate/change1-check.log");
  expect(firstResult.diagnosis).not.toContain("Fix this assertion");
  expect(firstResult.revival).toEqual({ opinion: "resume", reason: "Context remains useful", decision: "fresh", code: "fresh-dispatch", peak: 1234 });
});
