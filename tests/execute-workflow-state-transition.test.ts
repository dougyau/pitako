import { expect, test } from "bun:test";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";
import { copy, executeControllerFixture, executeField, executeRecord, executeString, maximalCursor, nativeRunId, source } from "./fixtures/execute-workflow.ts";
import { EXECUTE_STATE_VERSION } from "../extensions/execute-state.ts";
import {
  EXECUTE_CURSOR_KEY, EXECUTE_CURSOR_MAX_BYTES, executeCursorSchema, validateExecuteCursor, executeCursorValidationScript,
} from "../extensions/execute-cursor.ts";
import { canonicalDigest, canonicalJSON, sha256 } from "../extensions/canonical.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PitakoStore } from "../extensions/pitako-store.ts";
import { runInNewContext } from "node:vm";
import { readBacklog } from "../skills/execute/loop.ts";
import { pitakoAgentFamily } from "../skills/agent-names.mjs";
const { summarizeLoops, executeStore, executeProjection, fullExecuteProjection } = await import("../skills/execute/ledger.mjs");
const { resolveStoredGroupedInput, recoverStoredWorker } = await import("../skills/execute/loop-io.mjs");

const { fixture } = executeControllerFixture();
function unitBodies(host: ReturnType<typeof fixture>) {
  return JSON.parse(JSON.stringify(host.records().filter((record: any) => record.kind === "unit")
    .map((record: any) => record.body)).replaceAll(host.root, "<root>"));
}
function foldedCloseView(prefix: ReturnType<ReturnType<typeof executeStore>["store"]["read"]>) {
  const ref = executeField(prefix.P.prompt.execution!.foldedContinuation, "ref");
  const close = prefix.records.find(row => row.kind === "receipt" &&
    row.seq === executeField(ref, "seq") && row.digest === executeField(ref, "digest"));
  const steps = executeField(close?.body, "result", "steps");
  if (!Array.isArray(steps)) throw new Error("Expected committed close steps.");
  return executeField(steps.find(step => executeField(step, "operation") === "gate"), "result", "receipt", "view");
}
const validators: [string, (key: string, value: unknown) => void][] = [
  ["host", validateExecuteCursor],
  ["sandbox", runInNewContext(`${executeCursorValidationScript()}\nvalidateExecuteCursor;`)],
];

test.each(["before-close", "after-close", "saved-close"] as const)("a pending worker close resumes from its committed selection at %s", async seam => {
  const timeouts = { gateFloorMs: 20000000, workerMs: 12345 };
  const setup = () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => request.agent === "pitako.worker"
      ? host.result(request, { ...host.worker(request, "pause"), status: "blocked", remaining: ["Pending unit"] })
      : normal());
    return host;
  };
  const host = setup();
  let received = false;
  host.setSaveObserver(value => {
    if (value.action.kind === "pending" && value.action.op === "close" && value.inFlight.length) received = true;
    if (seam === "saved-close" && value.action.kind === "pending" && value.action.op === "close" &&
        !value.inFlight.length && value.loop.outcome === null) committed = true;
  });
  let committed = false;
  let closeOutput: string | undefined;
  if (seam === "after-close") host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (pitakoAgentFamily(request.agent) === "loop-io" && request.key.endsWith(".close")) {
      committed = true; closeOutput = result.output;
    }
    return result;
  });
  host.setFailSave(() => seam !== "before-close" ? committed : received);
  const first = await host.execute({ timeouts });
  expect(first.reason).toContain("Essential persistence failed");
  const cursor = host.current();
  expect(cursor.action.kind).toBe("pending");
  expect(cursor.action.op).toBe("close");
  const worker = { ...host.native.get("invoke-human-1.l1.t1.a1")!, key: "invoke-human-1.l1.t1.a1" };
  expect(worker.runId).toBeTruthy();
  expect(cursor.action.opKey).toBe(`${worker.key}.close`);
  expect(cursor.action.gateTimeoutMs).toBeGreaterThan(timeouts.gateFloorMs);
  host.setFailSave();
  host.setLaunchRespond();
  host.setSaveObserver(() => {});
  host.setStatus(ref => ref === worker.runId
    ? { ok: true, agent: "pitako.worker", runId: ref, output: "", results: [] }
    : copy(host.native.get(ref)!));
  const output = await host.execute();
  expect(output.status, output.reason).toBe("blocked");
  expect(output.reason).toContain("Pending unit");
  expect(host.current().inFlight.filter((ref: any) => ref.role === "worker")).toEqual([]);
  expect(host.statusCalls).toContain(worker.runId!);
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
  const closes = host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" &&
    JSON.parse(call.task).operation === "close");
  expect(closes).toHaveLength(seam === "before-close" ? 1 : 2);
  expect(closes[0]!.key).toBe(`${worker.key}.close`);
  expect(closes[0]!.timeoutMs).toBe(cursor.action.gateTimeoutMs);
  if (seam === "after-close") {
    expect(closes[1]).toEqual(closes[0]);
    expect(host.native.get(closes[0]!.key)!.output).toBe(closeOutput);
  }
  expect([...host.storage.keys()]).toEqual([EXECUTE_CURSOR_KEY]);
  const uninterrupted = setup();
  expect((await uninterrupted.execute({ timeouts })).status).toBe("blocked");
  const recoveryKey = `${worker.key}.close.r1`;
  expect(host.launches.filter(call => call.key === recoveryKey)).toHaveLength(seam === "saved-close" ? 1 : 0);
  expect([...new Map(host.launches.filter(call => call.key !== recoveryKey).map(call => [call.key, [call.key, call.agent]])).values()])
    .toEqual(uninterrupted.launches.map(call => [call.key, call.agent]));
});

test.each([
  { status: "blocked", attempt: 1 }, { status: "continue", attempt: 1 },
  { status: "complete", attempt: 1 }, { status: "complete", attempt: 2 },
  { status: "complete", attempt: 3 },
])("a terminal-launched $status worker attempt $attempt recovers with one deterministic read", async ({ status, attempt }) => {
  const setup = () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => request.agent === "pitako.worker"
      ? host.result(request, { ...host.worker(request, "pause"),
        status: Number(request.key.match(/\.a(\d+)$/)?.[1]) < attempt ? "continue" : status,
        remaining: Number(request.key.match(/\.a(\d+)$/)?.[1]) < attempt || status !== "complete" ? ["Pending unit"] : [] })
      : normal());
    return host;
  };
  const uninterrupted = setup();
  const expected = await uninterrupted.execute();
  const host = setup();
  let received = false;
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.agent === "pitako.worker" && request.key.endsWith(`.a${attempt}`)) received = true;
    return result;
  });
  host.setFailSave(() => received);
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  // Native result arrives after the last durable launched cursor.
  const cursor = host.current();
  expect(cursor.action.kind).toBe("launched");
  expect(cursor.loop.attempt.number).toBe(attempt);
  const worker = host.native.get(cursor.action.key)!;
  host.setFailSave();
  host.setLaunchRespond();
  host.setStatus(ref => [worker.runId, cursor.action.key].includes(ref)
    ? { ok: true, agent: "pitako.worker", runId: worker.runId, output: "", results: [] }
    : copy(host.native.get(ref)!));
  const output = await host.execute();
  expect(output.status, output.reason).toBe(expected.status);
  for (const request of host.launches.filter(call => call.agent === "pitako.worker"))
    expect(request.task).toContain(`read it from ${host.root}/.pitako/backlog/spec.json;`);
  const recoveries = host.launches.filter(call => call.key.endsWith(".recover.r1"));
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]!.agent).toBe("pitako.loop-close");
  expect(host.launches.filter(call => !call.key.endsWith(".recover.r1")).map(call => call.agent))
    .toEqual(uninterrupted.launches.map(call => call.agent));
  expect(unitBodies(host)).toEqual(unitBodies(uninterrupted));
  for (const record of host.records().filter((record: any) => record.kind === "unit")) {
    const ref = record.body.result.ref;
    expect(Object.keys(ref).sort()).toEqual(["digest", "key", "path", "runId"]);
    expect(sha256(readFileSync(ref.path))).toBe(ref.digest);
    expect(host.native.get(ref.key)?.runId).toBe(ref.runId);
  }
  expect(host.current().inFlight.filter((ref: any) => ref.role === "worker")).toEqual([]);
  for (const value of host.snapshots)
    expect(Buffer.byteLength(JSON.stringify({ [EXECUTE_CURSOR_KEY]: value }, null, 2)))
      .toBeLessThanOrEqual(EXECUTE_CURSOR_MAX_BYTES);
});

test.each([
  { seam: "before-gate", attempt: 1 }, { seam: "after-gate", attempt: 1 },
  { seam: "recovery-read", attempt: 1 }, { seam: "recovered-gate", attempt: 1 },
  { seam: "after-gate", attempt: 2 }, { seam: "recovery-read", attempt: 2 },
  { seam: "saved-gate", attempt: 1 }, { seam: "following-save", attempt: 1 },
  { seam: "saved-gate", attempt: 2 }, { seam: "following-save", attempt: 2 },
  { seam: "saved-gate", attempt: 1, noWrite: true }, { seam: "following-save", attempt: 1, noWrite: true },
  { seam: "saved-gate", attempt: 2, noWrite: true }, { seam: "following-save", attempt: 2, noWrite: true },
])(
  "completed worker attempt $attempt resumes its frozen pending gate after $seam (no-write: $noWrite)", async ({ seam, attempt, noWrite }) => {
    const setup = () => {
      const posts: any[] = [];
      const host = fixture(undefined, { humanPosts: posts }); host.setLimit(1);
      host.setRespond((request, normal) => {
        if (noWrite && request.agent === "pitako.worker") posts.push({
          id: posts.length + 1, type: "HANDOFF", content: `Attempt ${posts.length + 1} finished`,
        });
        return request.agent === "pitako.worker" &&
        Number(request.key.match(/\.a(\d+)$/)?.[1]) < attempt
        ? host.result(request, { ...host.worker(request, "pause"), status: "continue", remaining: ["Finish the task"] })
        : request.agent === "pitako.worker" && noWrite
          ? host.result(request, { status: "complete", work: "Read only observation", remaining: [] })
          : normal();
      });
      return host;
    };
    const host = setup();
    const timeouts = { gateFloorMs: 20000000, workerMs: 12345 };
    let received = false, committed = false, recovered = false, pending = false, savedGate = false, following = false;
    host.setLaunchRespond(async (request, normal) => {
      const result = await normal();
      if (request.agent === "pitako.worker" && request.key.endsWith(`.a${attempt}`)) received = true;
      if (request.key.endsWith(`.a${attempt}.gate`)) committed = true;
      if (request.key.endsWith(".recover.r1")) recovered = true;
      if (savedGate && request.key.endsWith(`.a${attempt}.delta`)) following = true;
      return result;
    });
    host.setSaveObserver(value => {
      if (value.loop.attempt?.number === attempt && value.action.kind === "pending" &&
          value.action.op === "gate" && value.inFlight.length) pending = true;
      if (committed && value.action.kind === "pending" && value.action.op === "gate" &&
          !value.inFlight.length) savedGate = true;
    });
    const recovery = seam.startsWith("recover");
    host.setFailSave(() => recovery ? received : seam === "saved-gate" ? savedGate :
      seam === "following-save" ? following : seam === "after-gate" ? committed : pending);
    expect((await host.execute({ timeouts })).reason).toContain("Essential persistence failed");
    if (recovery) {
      received = false;
      host.setFailSave(() => seam === "recovery-read" ? recovered : pending);
      expect((await host.execute()).reason).toContain("Essential persistence failed");
      expect(recovered).toBe(true);
    }
    const cursor = copy(host.current());
    if (!recovery) {
      expect(cursor.action).toMatchObject({ kind: "pending", op: "gate" });
      expect(cursor.inFlight.some((ref: any) => ref.role === "worker" &&
        ref.key.endsWith(`.a${attempt}`))).toBe(!["saved-gate", "following-save"].includes(seam));
    }
    expect(cursor.action.gateTimeoutMs).toBeGreaterThan(timeouts.gateFloorMs);
    if (["saved-gate", "following-save"].includes(seam)) {
      const { store, scope } = executeStore(host.root, cursor.invocation);
      const prefix = store.read(scope, cursor.head);
      const requestObservation = executeField(prefix.P.control, "requestObservation");
      expect(requestObservation).toBe(attempt + 1);
      expect(executeField(fullExecuteProjection(prefix.records).control, "requestObservation")).toBe(attempt + 1);
      const row = prefix.records.find(row => row.seq === cursor.action.input.seq)!;
      expect(executeField(row.body, "request", "requestObservation")).toBe(requestObservation);
      if (noWrite) {
        const gate = prefix.records.find(row => row.opKey ===
          `worker-gate:invoke-human-1.l1.t1.a${attempt}.gate`)!;
        const posts = executeField(gate.body, "result", "view", "posts");
        if (!Array.isArray(posts)) throw new Error("Expected gate Board posts.");
        expect(posts.map(post => executeField(post, "id"))).toContain(attempt);
        const selection = prefix.records.find(row => row.kind === "receipt" &&
          executeField(row.body, "result", "operation") === "selection");
        const steps = selection ? executeField(selection.body, "result", "steps") : [];
        if (!Array.isArray(steps)) throw new Error("Expected selection steps.");
        const launchView = attempt === 1
          ? executeField(steps.find(step => executeField(step, "operation") === "apply"), "result", "view")
          : foldedCloseView(prefix);
        const launchPosts = executeField(launchView, "posts");
        if (!Array.isArray(launchPosts)) throw new Error("Expected launch Board posts.");
        expect(launchPosts.map(post => executeField(post, "id"))).not.toContain(attempt);
      }
      for (const requestObservation of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
        const invalid = prefix.records.map((item: any) => item === row ? {
          ...item, body: { ...item.body, request: { ...item.body.request, requestObservation } },
        } : item);
        expect(() => executeProjection(invalid)).toThrow("Invalid stored request observation counter");
      }
    }
    host.setFailSave();
    host.setSaveObserver(() => {});
    let output: any;
    if (seam === "recovery-read") {
      const { store, scope } = executeStore(host.root, cursor.invocation);
      const originalPath = executeString(executeField(store.read(scope).P.prompt.execution!.worker, "reference", "path"));
      const bytes = readFileSync(originalPath);
      writeFileSync(originalPath, "unavailable after the committed recovery read");
      host.setLaunchRespond(async (request, normal) => {
        const result = await normal();
        // The consuming gate still validates the native original independently.
        if (request.key.endsWith(".recover.r1")) writeFileSync(originalPath, bytes);
        return result;
      });
      try { output = await host.execute({ timeouts: { gateFloorMs: 40000000 } }); }
      finally { writeFileSync(originalPath, bytes); }
    } else {
      if (seam === "after-gate") host.setLaunchRespond(async (request, normal) => {
        if (!request.key.endsWith(`.a${attempt}.gate.r1`)) return normal();
        const before = host.observedCandidate(), executions = host.gateExecutions();
        const { store, scope } = executeStore(host.root, cursor.invocation);
        const records = store.readRecords(scope).records;
        const result = await normal();
        expect(host.observedCandidate()).toEqual(before);
        expect(host.gateExecutions()).toBe(executions);
        expect(store.readRecords(scope).records).toEqual(records);
        return result;
      });
      output = await host.execute({ timeouts: { gateFloorMs: 40000000 } });
    }
    expect(output.status, output.reason).toBe("partial");
    expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(attempt);
    const reads = host.launches.filter(call => call.key.endsWith(".recover.r1"));
    expect(new Set(reads.map(call => call.key)).size).toBe(recovery ? 1 : 0);
    for (const read of reads) expect(read).toEqual(reads[0]);
    const gates = host.launches.filter(call => call.key.endsWith(`.a${attempt}.gate`));
    expect(gates.length).toBeGreaterThan(0);
    for (const gate of gates) {
      expect(gate.timeoutMs).toBe(cursor.action.gateTimeoutMs);
      expect(gate).toEqual(gates[0]);
    }
    const uninterrupted = setup();
    expect((await uninterrupted.execute({ timeouts })).status).toBe("partial");
    expect(uninterrupted.launches.filter(call => call.key.endsWith(`.a${attempt}.gate.r1`))).toHaveLength(0);
    const gateReplays = host.calls.filter(call => call.key.endsWith(`.a${attempt}.gate.r1`));
    const committedReplay = ["after-gate", "saved-gate", "following-save"].includes(seam);
    expect(gateReplays).toHaveLength(committedReplay ? 1 : 0);
    if (committedReplay) {
      expect(gates).toHaveLength(1);
      expect(host.gateExecutions()).toBe(uninterrupted.gateExecutions());
      const deltaKey = `invoke-human-1.l1.t1.a${attempt}.delta`;
      const deltas = host.launches.filter(call => call.key === deltaKey);
      const uninterruptedDelta = uninterrupted.launches.find(call => call.key === deltaKey);
      expect(uninterruptedDelta).toBeDefined();
      expect(deltas.length).toBeGreaterThan(0);
      for (const delta of deltas) {
        expect(delta).toEqual(deltas[0]);
        expect(JSON.parse(delta.task).requestObservation).toBe(attempt + 1);
        expect(JSON.stringify(delta).replaceAll(host.root, "<root>")
          .replace(/[a-f0-9]{64}/g, "<root-bound-digest>"))
          .toBe(JSON.stringify(uninterruptedDelta).replaceAll(uninterrupted.root, "<root>")
            .replace(/[a-f0-9]{64}/g, "<root-bound-digest>"));
      }
      const nativeAdmissions = (value: typeof host) => new Set(value.launches
        .filter(call => value.native.has(call.key)).map(call => call.key)).size;
      expect(nativeAdmissions(host)).toBe(nativeAdmissions(uninterrupted) + 1);
      if (noWrite) {
        const closeKey = `invoke-human-1.l1.t1.a${attempt}.close`;
        expect(host.launches.filter(call => call.key === closeKey)).toHaveLength(1);
        expect(uninterrupted.launches.filter(call => call.key === closeKey)).toHaveLength(1);
      }
      const subsequent = (value: typeof host) => JSON.stringify(value.launches.filter(call =>
        call.key.startsWith(`invoke-human-1.l1.t1.a${attempt}.`) &&
        !/\.gate(?:\.r1)?$/.test(call.key) && call.key !== deltaKey))
        .replaceAll(value.root, "<root>")
        .replaceAll(value.current().storeId, "<store>")
        .replace(/[a-f0-9]{64}/g, "<root-bound-digest>");
      expect(subsequent(host)).toBe(subsequent(uninterrupted));
      expect(unitBodies(host)).toEqual(unitBodies(uninterrupted));
    }
    expect([...new Map(host.calls.filter(call => !call.key.endsWith(".recover.r1") &&
      !call.key.endsWith(`.a${attempt}.gate.r1`))
      .map(call => [call.key, call.agent])).values()])
      .toEqual(uninterrupted.calls.map(call => call.agent));
  },
);

test.each([2, 3])("terminal worker attempt %s reads its folded intent and replays at its original head", async attempt => {
  const host = fixture(); host.setLimit(1);
  let received = false;
  host.setRespond((request, normal) => request.agent === "pitako.worker" &&
    Number(request.key.match(/\.a(\d+)$/)?.[1]) < attempt
    ? host.result(request, { ...host.worker(request, "pause"), status: "continue", remaining: ["Finish the task"] })
    : normal());
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.agent === "pitako.worker" && request.key.endsWith(`.a${attempt}`)) received = true;
    return result;
  });
  host.setFailSave(() => received);
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  const cursor = host.current();
  expect(cursor.loop.attempt.number).toBe(attempt);
  expect(cursor.action.kind).toBe("launched");
  const worker = host.native.get(cursor.action.key)!;
  const { store, scope } = executeStore(host.root, cursor.invocation);
  const prefix = store.read(scope, cursor.head);
  expect(prefix.P.prompt.execution!.checkpoint).toMatchObject({ key: cursor.action.key, attempt });
  expect(prefix.P.prompt.execution!.worker).toBeNull();
  const admission = prefix.P.prompt.admission!;
  const request = {
    root: cursor.root, invocation: cursor.invocation, key: `${cursor.action.key}.recover`,
    storeId: cursor.storeId, scope, expectedHead: cursor.head,
    refs: { input: cursor.action.input, intent: cursor.loop.attempt.intent,
      worker: { key: cursor.action.key, runId: worker.runId }, gateFloorMs: cursor.timeouts.gateFloorMs,
      request: { associationDigest: cursor.associationDigest, admissionBinding: cursor.admissionBinding,
        missionId: admission.association.missionId, missionPath: admission.association.missionPath,
        sourceRefs: admission.association.sourceRefs ?? [], amendments: admission.amendments, specId: "spec" } },
  };
  const admissions = copy(host.calls);
  expect(executeField(prefix.records.find(row => row.seq === cursor.action.input.seq)?.body, "operation"))
    .toBe("close");
  const resolved: any = resolveStoredGroupedInput("close", request);
  expect(resolved.recovery.checkpoint).toMatchObject({ key: cursor.action.key, attempt });
  expect(resolved.recovery.predecessor.operation).toBe("close");
  const recovered: any = recoverStoredWorker(resolved);
  expect(recovered.P.prompt.execution.checkpoint).toEqual(resolved.recovery.checkpoint);
  expect(recovered.P.prompt.execution.worker.value.status).toBe("complete");
  expect(recoverStoredWorker(resolveStoredGroupedInput("close", request))).toEqual(recovered);
  // A COMMIT followed by a lost cursor save reissues the old-head recovery read.
  // The committed original, not the native artifact's continued availability,
  // owns the result from that point onward.
  const originalPath = recovered.P.prompt.execution.worker.reference.path;
  const originalBytes = readFileSync(originalPath);
  try {
    writeFileSync(originalPath, "unavailable native original");
    expect(recoverStoredWorker(resolveStoredGroupedInput("close", request))).toEqual(recovered);
    expect(() => recoverStoredWorker({ ...resolved, recovery: {
      ...resolved.recovery, worker: { ...resolved.recovery.worker, runId: "different-producer" },
    } })).toThrow("replay differs");
  } finally {
    writeFileSync(originalPath, originalBytes);
  }
  expect(() => resolveStoredGroupedInput("close", {
    ...request, refs: { ...request.refs, intent: { seq: 1, digest: "f".repeat(64) } },
  })).toThrow();
  const staleIntent = prefix.records.find((row: any) => row.kind === "intent")!;
  expect(() => resolveStoredGroupedInput("close", {
    ...request, refs: { ...request.refs, intent: { seq: staleIntent.seq, digest: staleIntent.digest } },
  })).toThrow();
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(attempt);
  expect(host.calls).toEqual(admissions);
  for (const value of host.snapshots)
    expect(Buffer.byteLength(JSON.stringify({ [EXECUTE_CURSOR_KEY]: value }, null, 2)))
      .toBeLessThanOrEqual(EXECUTE_CURSOR_MAX_BYTES);

  // Later gates use the same head-bound transport on first dispatch and replay.
  const completed = fixture(); completed.setLimit(1);
  completed.setRespond((request, normal) => request.agent === "pitako.worker" &&
    Number(request.key.match(/\.a(\d+)$/)?.[1]) < attempt
    ? completed.result(request, { ...completed.worker(request, "pause"), status: "continue", remaining: ["Finish the task"] })
    : normal());
  expect((await completed.execute()).status).toBe("partial");
  const gate = completed.launches.find(call => call.key.endsWith(`.a${attempt}.gate`))!;
  const { operation, ...gateRequest } = JSON.parse(gate.task);
  const gateInput = resolveStoredGroupedInput(operation, gateRequest);
  const gateWorker = executeRecord(gateInput.worker);
  const gateReceipt = JSON.parse(completed.native.get(gate.key)!.output!);
  const committed = executeStore(completed.root, "human-1").store.read(scope, gateReceipt.head);
  const gateRow = committed.records.find((row: any) =>
    row.kind === "operation" && row.body.request.key === gate.key)!;
  const { gateTask, receiptReference, boardPostIds, ...replayedGate } = executeRecord(resolveStoredGroupedInput(operation, {
    root: completed.root, invocation: "human-1", key: gate.key,
    storeId: gateReceipt.storeId, scope, expectedHead: gateReceipt.head,
    refs: { input: { seq: gateRow.seq, digest: gateRow.digest } },
  }).replay);
  expect(replayedGate).toEqual(gateReceipt);
  expect(gateTask).toEqual(gateInput.task);
  const priorClose = JSON.parse(completed.native.get(`invoke-human-1.l1.t1.a${attempt - 1}.close`)!.output!);
  expect(receiptReference).toEqual({ path: priorClose.path, digest: priorClose.digest });
  const posts = executeField(foldedCloseView(committed), "posts");
  if (!Array.isArray(posts)) throw new Error("Expected continuation Board posts.");
  expect(boardPostIds).toEqual(posts.map(post => executeField(post, "id")));
  expect(executeField(gateRow.body, "request")).toEqual(gateInput);
  expect(committed.P.prompt.execution!.checkpoint).toMatchObject({ key: gateWorker.key, attempt });
  expect(executeField(committed.P.prompt.execution!.worker, "reference", "runId")).toBe(gateWorker.runId);
  expect(store.read(scope, cursor.head).P).toEqual(prefix.P);
});

test.each([2, 3].flatMap(attempt => ["pending", "committed", "saved"].flatMap(seam =>
  ["continue", "blocked"].map(status => ({ attempt, seam, status })))))(
  "later pending $status close attempt $attempt resumes at $seam with identical requests", async ({ attempt, seam, status }) => {
  const setup = () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => request.agent === "pitako.worker" &&
      Number(request.key.match(/\.a(\d+)$/)?.[1]) <= attempt
      ? host.result(request, { ...host.worker(request, "pause"),
        status: request.key.endsWith(`.a${attempt}`) ? status : "continue", remaining: ["Finish the task"] })
      : normal());
    return host;
  };
  const host = setup();
  let cut = false;
  const closeKey = `invoke-human-1.l1.t1.a${attempt}.close`;
  host.setSaveObserver(value => {
    if (value.action.kind === "pending" && value.action.opKey === closeKey &&
        seam === "saved" && value.inFlight.length === 0 && value.loop.outcome === null) cut = true;
  });
  host.setLaunchRespond(async (request, normal) => {
    if (seam === "pending" && request.key === closeKey) {
      cut = true;
      throw new Error("Controlled loss before close dispatch");
    }
    const result = await normal();
    if (seam === "committed" && request.key === closeKey) cut = true;
    return result;
  });
  host.setFailSave(() => cut);
  const interrupted = await host.execute();
  if (seam !== "pending") expect(interrupted.reason).toContain("Essential persistence failed");
  else host.storage.set(EXECUTE_CURSOR_KEY, copy([...host.snapshots].reverse().find(value =>
    value.action.kind === "pending" && value.action.opKey === closeKey && !value.halt && value.inFlight.length)!));
  const cursor = host.current();
  expect(cursor.action).toMatchObject({ kind: "pending", op: "close", opKey: closeKey });
  expect(cursor.loop.attempt.number).toBe(attempt);
  if (seam === "pending") {
    const { store, scope } = executeStore(host.root, cursor.invocation);
    const before = store.read(scope).head;
    const worker = cursor.inFlight.find((ref: any) => ref.role === "worker")!;
    const input = { root: host.root, invocation: cursor.invocation, storeId: cursor.storeId, scope,
      expectedHead: cursor.head, refs: { input: cursor.action.input, intent: cursor.loop.attempt.intent,
        worker: { key: worker.key, runId: worker.runId } } };
    expect(() => resolveStoredGroupedInput("close", { ...input,
      refs: { ...input.refs, intent: { ...input.refs.intent, digest: "0".repeat(64) } } }))
      .toThrow("predecessor integrity mismatch");
    const replay = resolveStoredGroupedInput("close", input).replay as any;
    expect(replay.recoveredWorker.value.status).toBe(status);
    expect(store.read(scope).head).toEqual(before);
  }
  host.setSaveObserver(() => {}); host.setLaunchRespond(); host.setFailSave();
  const output = await host.execute();
  expect(output.status, output.reason).toBe(status === "blocked" ? "blocked" : "partial");
  const uninterrupted = setup();
  expect((await uninterrupted.execute()).status).toBe(status === "blocked" ? "blocked" : "partial");
  const closes = host.launches.filter(call => call.key === closeKey);
  if (seam === "pending") {
    expect(closes).toHaveLength(2);
    expect(closes[1]).toEqual(closes[0]);
  }
  const recoveries = host.launches.filter(call => call.key.includes(".pending-close-replay.r") ||
    call.key === `${closeKey}.r1`);
  expect(recoveries).toHaveLength(1);
  if (seam !== "pending") {
    expect(closes).toHaveLength(1);
    expect(recoveries[0]!.key).toBe(`${closeKey}.r1`);
    expect(JSON.parse(recoveries[0]!.task).refs.committed).toBe(true);
  }
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(attempt + (status === "blocked" ? 0 : 1));
  const nativeAdmissions = (value: typeof host) => new Set(value.launches
    .filter(call => value.native.has(call.key)).map(call => call.key)).size;
  expect(nativeAdmissions(host)).toBe(nativeAdmissions(uninterrupted) + 1);
  expect(host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" &&
    host.native.has(call.key) && !uninterrupted.launches.some(expected => expected.key === call.key))).toHaveLength(1);
  expect([...new Map(host.calls.filter(call => !recoveries.some(recovery => recovery.key === call.key))
    .map(call => [call.key, call.agent])).values()]).toEqual(uninterrupted.calls.map(call => call.agent));
  // Independent roots bind different backlog and ledger hashes to their paths.
  const workerRequests = (value: typeof host) => JSON.stringify(value.launches
    .filter(call => call.agent === "pitako.worker")).replaceAll(value.root, "<root>")
    .replace(/admitted backlog digest [a-f0-9]{64}/g, "admitted backlog digest <root-bound>")
    .replace(/(ledgerPath\\":\\"[^"]+\\",\\"head\\":\\")[a-f0-9]{64}/g, "$1<root-bound>");
  expect(workerRequests(host)).toBe(workerRequests(uninterrupted));
  expect(unitBodies(host)).toEqual(unitBodies(uninterrupted));
  for (const value of host.snapshots)
    expect(Buffer.byteLength(JSON.stringify({ [EXECUTE_CURSOR_KEY]: value }, null, 2)))
      .toBeLessThanOrEqual(EXECUTE_CURSOR_MAX_BYTES);
});

test.each([{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }])(
  "worker attempt $attempt launched-before-dispatch replays its preceding op once with an identical request", async ({ attempt }) => {
  const setup = () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => request.agent === "pitako.worker" &&
      Number(request.key.match(/\.a(\d+)$/)?.[1]) < attempt
      ? host.result(request, { ...host.worker(request, "pause"), status: "continue", remaining: ["Finish the task"] })
      : normal());
    return host;
  };
  const host = setup();
  let interrupted = false;
  host.setLaunchRespond((request, normal) => {
    if (!interrupted && request.agent === "pitako.worker" && request.key.endsWith(`.a${attempt}`)) {
      interrupted = true;
      throw new Error("Controlled loss before worker dispatch");
    }
    return normal();
  });
  await host.execute();
  expect(interrupted).toBe(true);
  const original = host.launches.find(call => call.agent === "pitako.worker" && call.key.endsWith(`.a${attempt}`))!;
  const cursor = [...host.snapshots].reverse().find(value => value.action.kind === "launched" &&
    value.action.role === "worker" && value.action.runId === null && !value.halt)!;
  expect(cursor).toBeDefined();
  expect(cursor.loop.attempt.number).toBe(attempt);
  if (attempt > 1) {
    const close = host.launches.find(call => pitakoAgentFamily(call.agent) === "loop-io" &&
      call.key.endsWith(`.a${attempt - 1}.close`))!;
    const input = JSON.parse(close.task);
    // Attempt 2 follows reference-input close; attempt 3 follows full-input close.
    expect(!!input.refs).toBe(attempt === 2);
    const { store, scope } = executeStore(host.root, "human-1");
    const prefix = store.read(scope, cursor.head);
    const continuationRef = prefix.P.prompt.execution?.continuationRef!;
    const continuation: any = prefix.records.find((row: any) =>
      row.seq === continuationRef.seq && row.digest === continuationRef.digest)!;
    expect(continuation.kind).toBe("receipt");
    expect(continuation.body.continuation.attempt).toEqual(cursor.loop.attempt.intent);
    for (const ref of [{ seq: 0, digest: "0".repeat(64) },
      { ...continuation.body.continuation.gate, digest: "0".repeat(64) }]) {
      const damaged: any[] = [...copy(prefix.records)];
      damaged.find((row: any) => row.seq === continuation.seq).body.continuation.gate = ref;
      expect(() => executeProjection(damaged)).toThrow("continuation reference integrity mismatch");
    }
  }
  host.storage.set(EXECUTE_CURSOR_KEY, copy(cursor));
  host.setLaunchRespond();
  const resumed = await host.execute();
  expect(resumed.status, resumed.reason).toBe("partial");
  const workers = host.launches.filter(call => call.agent === "pitako.worker" && call.key.endsWith(`.a${attempt}`));
  expect(workers).toHaveLength(2); // The first dispatch never admitted a native child.
  expect(workers[1]).toEqual(original);
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(attempt);
  const predecessor = attempt === 1 ? "selection" : "close";
  const recoveries = host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" &&
    /\.r\d+$/.test(call.key) && JSON.parse(call.task).operation === predecessor);
  expect(recoveries).toHaveLength(1);
  expect(JSON.parse(recoveries[0]!.task).operation).toBe(predecessor);
  const uninterrupted = setup();
  expect((await uninterrupted.execute()).status).toBe("partial");
  expect(host.calls.filter(call => !recoveries.some(recovery => recovery.key === call.key)).map(call => call.agent))
    .toEqual(uninterrupted.calls.map(call => call.agent));
  expect(unitBodies(host)).toEqual(unitBodies(uninterrupted));
  for (const value of host.snapshots)
    expect(Buffer.byteLength(JSON.stringify({ [EXECUTE_CURSOR_KEY]: value }, null, 2)))
      .toBeLessThanOrEqual(EXECUTE_CURSOR_MAX_BYTES);
});

test.each(["before-commit", "after-commit", "before-model-dispatch"])("initial admission relaunch preserves the first advance at %s", async seam => {
  const ruling = "Retain the admitted error-path requirement after relaunch.";
  const host = fixture(undefined, { taskCount: 2,
    humanPosts: [{ id: 1, type: "HUMAN", content: ruling }] }); host.setLimit(1);
  let cut = true;
  host.setSaveObserver(() => {
    const value = host.current();
    expect(value.head).toBeTruthy();
    const { store, scope } = executeStore(host.root, value.invocation);
    const prefix = store.read(scope, value.head);
    expect(prefix.records.some((row: any) => row.kind === "root-admission")).toBe(true);
  });
  if (seam === "before-commit") {
    host.setLaunchRespond((request, normal) => {
      if (cut && /^invoke-human-1\.l1\.advance(?:\.r\d+)?$/.test(request.key)) {
        throw new Error("Controlled loss before advance COMMIT");
      }
      return normal();
    });
  } else host.setFailSave(value => seam === "after-commit" ||
    value.action.kind === "launched" && value.action.runId === null);
  const first = await host.execute({ timeouts: { reviewerMs: 12345 } });
  cut = false;
  expect(first.status).not.toBe("complete");
  expect(host.storage.size).toBe(seam === "before-model-dispatch" ? 1 : 0);
  host.setFailSave();
  if (seam === "after-commit") host.setLimit(7);
  const output = await host.execute({ timeouts: { reviewerMs: 54321 } });
  expect(output.status, output.reason).toBe("partial");
  expect(host.current().budget.maxCycles).toBe(1);
  expect(host.current().budget.consumedLoops).toBe(1);
  expect(host.current().timeouts.reviewerMs).toBe(seam === "after-commit" ? 12345 : 54321);
  expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
  for (const agent of ["pitako.execution-director", "pitako.worker"])
    expect(host.calls.find(call => call.agent === agent)!.task).toContain(ruling);
  for (const cursor of host.snapshots) {
    expect(cursor).not.toHaveProperty("currentView");
    expect(JSON.stringify(cursor)).not.toContain(ruling);
  }
  const advances = host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).operation === "advance")
    .map(call => call.key);
  if (seam === "after-commit") {
    expect(advances).toEqual(["invoke-human-1.l1.advance", "invoke-human-1.l1.advance.r1"]);
  } else {
    expect(advances.every(key => /^invoke-human-1\.l1\.advance(?:\.r\d+)?$/.test(key))).toBe(true);
  }
});



test.each(validators)("the closed execute cursor fits 16384 bytes at its maximum (%s)", (_name, validate) => {
  const value = maximalCursor(executeCursorSchema);
  const diagnostic = { ...value, halt: maximalCursor(executeCursorSchema.properties.halt),
    action: { ...maximalCursor(executeCursorSchema.properties.action.anyOf[2]), runId: null },
    hostHalt: null };
  expect(diagnostic.halt.reason).toHaveLength(360);
  expect(() => validate(EXECUTE_CURSOR_KEY, diagnostic)).not.toThrow();
  expect(Buffer.byteLength(JSON.stringify({ [EXECUTE_CURSOR_KEY]: diagnostic }, null, 2)))
    .toBeLessThanOrEqual(EXECUTE_CURSOR_MAX_BYTES);
  expect(value.budget.rejectedKeys).toHaveLength(8);
  expect(value.budget.rejectedKeys.every((key: string) => /^[a-f0-9]{64}$/.test(key))).toBe(true);
  expect(() => validate(EXECUTE_CURSOR_KEY, value)).not.toThrow();
  expect(Buffer.byteLength(JSON.stringify({ [EXECUTE_CURSOR_KEY]: value }, null, 2)))
    .toBeLessThanOrEqual(EXECUTE_CURSOR_MAX_BYTES);
  const pending = { ...value, action: { ...maximalCursor(executeCursorSchema.properties.action.anyOf[0]),
    op: "gate" } };
  expect(pending.action.gateTimeouts).toHaveLength(16);
  expect(() => validate(EXECUTE_CURSOR_KEY, pending)).not.toThrow();
  expect(Buffer.byteLength(JSON.stringify({ [EXECUTE_CURSOR_KEY]: pending }, null, 2)))
    .toBeLessThanOrEqual(EXECUTE_CURSOR_MAX_BYTES);
  function inspect(schema: any) {
    if (schema.type === "object") {
      expect(schema.additionalProperties).toBe(false);
      for (const [key, child] of Object.entries(schema.properties)) {
        expect(["status", "nextAction", "nextReadyAction"]).not.toContain(key);
        inspect(child);
      }
    }
    if (schema.type === "array") {
      expect(Number.isSafeInteger(schema.maxItems)).toBe(true);
      inspect(schema.items);
    }
    if (schema.type === "string" && schema.const === undefined)
      expect(Number.isSafeInteger(schema.maxLength)).toBe(true);
    schema.anyOf?.forEach(inspect);
  }
  inspect(executeCursorSchema);
});

test.each(validators)("the execute cursor boundary rejects unknown keys, invalid schemas and oversize input (%s)", (_name, validate) => {
  const value = maximalCursor(executeCursorSchema);
  expect(() => validate("invoke-history", value)).toThrow("Unknown execute cursor key");
  expect(() => validate(EXECUTE_CURSOR_KEY, { ...value, tasks: {} })).toThrow();
  expect(() => validate(EXECUTE_CURSOR_KEY, {
    ...value, action: { ...value.action, nextAction: "worker" },
  })).toThrow();
  expect(() => validate(EXECUTE_CURSOR_KEY, {
    ...value, action: { kind: "pending", op: "selection", opKey: "selection-1", input: null },
  })).toThrow();
  expect(() => validate(EXECUTE_CURSOR_KEY, {
    ...value, action: { kind: "launched", key: "worker-1", runId: null, role: "worker", input: value.action.input },
  })).toThrow("frozen gate deadline");
  for (const op of ["gate", "close"]) {
    const action = { kind: "pending", op, opKey: "worker-1.close", input: value.action.input };
    expect(() => validate(EXECUTE_CURSOR_KEY, { ...value, action })).toThrow("frozen gate deadline");
    expect(() => validate(EXECUTE_CURSOR_KEY, {
      ...value, action: { ...action, gateTimeoutMs: 2147483647,
        ...(op === "gate" ? { gateTimeouts: [2147483647], gateMetricMs: 1800000 } : {}) },
    })).not.toThrow();
  }
  expect(() => validate(EXECUTE_CURSOR_KEY, {
    ...value, action: { kind: "pending", op: "advance", opKey: "advance-1",
      input: value.action.input, gateTimeoutMs: 1 },
  })).toThrow("does not run task gates");
  expect(() => validate(EXECUTE_CURSOR_KEY, {
    ...value, inFlight: [...value.inFlight, value.inFlight[0]],
  })).toThrow();
  expect(() => validate(EXECUTE_CURSOR_KEY, { ...value, epoch: -1 })).toThrow();
  expect(() => validate(EXECUTE_CURSOR_KEY, {
    ...value, action: { kind: "waiting" }, loop: { ...value.loop, outcome: null },
  })).toThrow("pending or launched");
  expect(() => validate(EXECUTE_CURSOR_KEY, {
    ...value, action: { kind: "terminal" }, loop: { ...value.loop, outcome: null },
  })).toThrow("retained disposition");
  for (const outcome of ["blocked", "cancelled"]) {
    const paused = { ...value, loop: { ...value.loop, outcome },
      budget: { ...value.budget, consumedLoops: value.budget.maxCycles } };
    expect(() => validate(EXECUTE_CURSOR_KEY, paused)).not.toThrow();
    expect(() => validate(EXECUTE_CURSOR_KEY, {
      ...paused, action: { kind: "terminal" },
    })).toThrow("retained disposition");
    expect(() => validate(EXECUTE_CURSOR_KEY, {
      ...paused, action: { kind: "waiting" },
    })).toThrow("pending or launched");
  }
  // The runtime's default floor is zero: individual gates retain their own deadlines.
  expect(() => validate(EXECUTE_CURSOR_KEY, {
    ...value, timeouts: { ...value.timeouts, gateFloorMs: 0 },
  })).not.toThrow();
  expect(() => validate(EXECUTE_CURSOR_KEY, {
    ...value, timeouts: { ...value.timeouts, gateFloorMs: -1 },
  })).toThrow();
  expect(() => validate(EXECUTE_CURSOR_KEY, { ...value, root: "x".repeat(16384) })).toThrow();
  expect(() => validate(EXECUTE_CURSOR_KEY, { ...value, root: "é".repeat(1024) }))
    .toThrow("UTF-8 bound");
  expect(() => validate(EXECUTE_CURSOR_KEY, {
    ...value, models: { ...value.models, r1: "p/" + "é".repeat(126) },
  })).toThrow("UTF-8 bound");
});

test.each(validators)("a launched attempt requires an intent committed at or before its saved head (%s)", (_name, validate) => {
  const value = maximalCursor(executeCursorSchema);
  value.head.seq = 10;
  value.action.input.seq = 10;
  value.loop.attempt.stage = "launched";
  value.loop.attempt.intent = null;
  expect(() => validate(EXECUTE_CURSOR_KEY, value)).toThrow("committed intent");
  value.loop.attempt.intent = { seq: 11, digest: "a".repeat(64) };
  expect(() => validate(EXECUTE_CURSOR_KEY, value)).toThrow("ahead");
  for (const seq of [1, 10]) {
    value.loop.attempt.intent.seq = seq;
    expect(() => validate(EXECUTE_CURSOR_KEY, value)).not.toThrow();
  }
});

test("execute persistence validates before state.set and writes only the frozen cursor", async () => {
  const writes: { key: string; value: unknown }[] = [];
  // Exercise the production persistence boundary without starting the root's dispatch loop.
  const persistence = source.slice(source.indexOf("function deterministicSaveError("), source.indexOf("function maxCycles("));
  const persist = runInNewContext(`${executeCursorValidationScript()}
    let saveTail = Promise.resolve();
    ${persistence}
    persistState;`, {
    config: { stateVersion: EXECUTE_STATE_VERSION }, clone: copy,
    state: { set: async (key: string, value: unknown) => { writes.push({ key, value }); } },
  }) as (key: string, value: unknown) => Promise<void>;
  const cursor = maximalCursor(executeCursorSchema), frozen = copy(cursor);
  const saved = persist(EXECUTE_CURSOR_KEY, cursor);
  cursor.epoch = 0;
  await saved;
  expect(writes).toEqual([{ key: EXECUTE_CURSOR_KEY, value: frozen }]);
  for (const [key, value] of [
    ["invoke-history", frozen], [EXECUTE_CURSOR_KEY, { ...frozen, tasks: {} }],
    [EXECUTE_CURSOR_KEY, { ...frozen, activePlan: { tasks: [] } }],
    [EXECUTE_CURSOR_KEY, { ...frozen, root: "x".repeat(16384) }],
    [EXECUTE_CURSOR_KEY, { ...frozen, loop: { ...frozen.loop,
      attempt: { ...frozen.loop.attempt, stage: "launched", intent: null } } }],
  ] as const) expect(() => persist(key, value)).toThrow();
  expect(writes).toHaveLength(1);
});

test.each(["selection", "close", "baselineIO"])("the %s worker launch saves its committed store intent", async path => {
  const host = fixture(undefined, { taskCount: path === "baselineIO" ? 2 : 1 }); host.setLimit(1);
  let workers = 0, validated = 0;
  host.setSaveObserver(() => {
    const value = host.current();
    expect(value).not.toHaveProperty("P");
    const attempt = value.loop?.attempt;
    if (attempt?.stage !== "launched") return;
    const { store, scope } = executeStore(host.root, value.invocation);
    const row = store.read(scope, value.head).records.find((row: any) => row.seq === attempt.intent.seq);
    expect(row?.digest).toBe(attempt.intent.digest);
    expect(row?.kind).toBe("intent");
    expect(row?.body).toMatchObject({ taskId: value.loop.taskId,
      attempt: attempt.number, loop: value.loop.number, cursor: value.loop.cursor });
    validated++;
  });
  host.setRespond((request, normal) => {
    const result = normal();
    if (pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "baseline") {
      const receipt = JSON.parse(result.output!);
      const { store, scope } = executeStore(host.root, "human-1");
      const { P, identity } = store.read(scope, receipt.head);
      result.output = JSON.stringify({ ...receipt, P, storeId: identity.storeId });
    }
    // An incomplete request page prevents the selection from capturing a baseline.
    // The root must finish observing requests and use the existing baselineIO call.
    if (path === "baselineIO" && request.key.endsWith(".selectionIO.requests")) {
      const page = JSON.parse(result.output!);
      page.requests = [{ v: 1, requestId: "other-task", invocation: "human-1",
        taskId: "change2", kind: "cancel", origin: "model" }];
      page.next = 1;
      result.output = JSON.stringify(page);
    }
    if (request.agent === "pitako.worker" && ++workers === 1 && path === "close") {
      result.structuredOutput.status = "continue";
      result.structuredOutput.remaining = ["Finish assigned implementation"];
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(workers, output.reason).toBe(path === "close" ? 2 : 1);
  expect(validated).toBeGreaterThanOrEqual(workers);
  const settledWorkers = host.snapshots.filter(value => value.inFlight.some((ref: any) =>
    ref.role === "worker" && (value.action.kind === "pending" &&
      ["close", "gate"].some(op => value.action.opKey === `${ref.key}.${op}`) ||
      value.action.kind === "launched" && value.action.key === ref.key && value.action.runId === ref.runId)));
  expect(new Set(settledWorkers.flatMap(value =>
    value.inFlight.filter((ref: any) => ref.role === "worker").map((ref: any) => ref.key))).size).toBe(workers);
  expect(settledWorkers.every(value =>
    value.inFlight.filter((ref: any) => ref.role === "worker").length === 1)).toBe(true);
  expect(host.current().inFlight.filter((ref: any) => ref.role === "worker")).toEqual([]);
  const baselines = host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" &&
    JSON.parse(call.task).operation === "baseline");
  expect(baselines).toHaveLength(path === "baselineIO" ? 1 : 0);
});

test("the root refuses a baseline without a committed intent before worker dispatch", async () => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "baseline") {
      const receipt = JSON.parse(result.output!);
      delete receipt.intent;
      result.output = JSON.stringify(receipt);
    }
    return result;
  });
  const output = await host.execute();
  expect(output.reason).toContain("committed intent at or before the store head");
  expect(host.launches.some(call => call.agent === "pitako.worker")).toBe(false);
});

function transitionFixture(cancellation = false) {
  const host = fixture(undefined, {
    taskCount: cancellation ? 2 : 1,
    humanPosts: [{ id: 1, type: "HUMAN", content: "Context ".repeat(750) }] });
  host.setLimit(2);
  host.storage.set("unrelated", { content: "u".repeat(10000) });
  const saves: { bytes: number; value: any }[] = [];
  host.setSaveObserver((value, bytes, serialized) => {
    expect(bytes).toBe(Buffer.byteLength(serialized));
    saves.push({ bytes, value: copy(value) });
  });
  let cancellationRequested = false;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker" || request.resume) {
      Object.assign(result.structuredOutput, { status: request.key.includes(".l1.") ? "continue" : "blocked",
        work: "Useful scoped implementation", remaining: ["Finish remaining implementation"],
        knowledge: { findings: ["Scoped evidence ".repeat(150)], handoff: "Retained context ".repeat(150) } });
    }
    if (cancellation && request.key === "invoke-human-1.l1.nextAdvance.requests") cancellationRequested = true;
    if (cancellationRequested && request.agent === "pitako.request-observer") {
      const page = JSON.parse(result.output!);
      page.requests = [{ v: 1, requestId: "cancel-1", invocation: "human-1",
        taskId: "change1", kind: "cancel", origin: "model" }];
      result.output = JSON.stringify(page);
    }
    return result;
  });
  return { host, saves };
}

function diskReceipt(reference: any) {
  const bytes = readFileSync(reference.path);
  expect(sha256(bytes)).toBe(reference.digest);
  const marker = JSON.parse(bytes.toString());
  expect(canonicalDigest(marker.result)).toBe(marker.resultDigest);
  return marker.result;
}

test("at least three heavy attempts close gaps and advance with only a bounded execute cursor", async () => {
  const { host, saves } = transitionFixture();
  const output = await host.execute();
  expect(host.launches.filter(call => /\.l1\.t1\.a\d+$/.test(call.key)).length).toBeGreaterThanOrEqual(3);
  expect(host.history()[0]?.outcome, output.reason).toBe("gaps");
  for (const call of host.calls.filter(call => pitakoAgentFamily(call.agent) === "loop-io")) {
    const output = host.native.get(call.key)?.output;
    if (output) expect(Buffer.byteLength(output)).toBeLessThanOrEqual(61440);
  }
  expect(host.current().loop.number, output.reason).toBe(2);
  expect(host.storage.get("unrelated").content).toHaveLength(10000);
  expect([...host.storage.keys()].sort()).toEqual([EXECUTE_CURSOR_KEY, "unrelated"].sort());
  expect(saves.length).toBeGreaterThan(0);
  for (const { value } of saves) {
    validateExecuteCursor(EXECUTE_CURSOR_KEY, value);
    expect(Buffer.byteLength(JSON.stringify({ [EXECUTE_CURSOR_KEY]: value }, null, 2)))
      .toBeLessThanOrEqual(EXECUTE_CURSOR_MAX_BYTES);
  }
  const prepared = saves.find(save => save.value.action.kind === "pending" &&
    save.value.action.opKey === "invoke-human-1.l1.nextAdvance")!.value;
  const { store, scope } = executeStore(host.root, prepared.invocation);
  const prefix = store.read(scope, prepared.head);
  const operation = prefix.records.find((row: any) =>
    row.seq === prepared.action.input.seq && row.digest === prepared.action.input.digest)!;
  expect(operation.kind).toBe("operation");
  expect(executeField(operation.body, "operation")).toBe("advance");
  expect(executeField(operation.body, "request", "key")).toBe("invoke-human-1.l1.nextAdvance");
  for (const { value } of saves) {
    expect(value).not.toHaveProperty("preparedNext");
    expect(value).not.toHaveProperty("currentView");
    expect(value.loop).not.toHaveProperty("prepare");
  }
  const receipt = diskReceipt(JSON.parse(host.native.get("invoke-human-1.l1.nextAdvance")!.output!));
  expect(receipt.operation).toBe("advance");
  expect(host.records().some((record: any) => record.kind === "loop" && record.loop === 1)).toBe(true);
  expect(output.loopReport?.history?.summaries, output.reason).toEqual(summarizeLoops(host.records()));
});

test.each(["pending", "launched"])("a later director admission resumes from %s with committed history and frozen accounting", async position => {
  const { host } = transitionFixture();
  let interrupted = false;
  host.setLaunchRespond((request, normal) => {
    if (!interrupted && request.key === "invoke-human-1.l2.director") {
      interrupted = true;
      throw new Error("Controlled loss before the second director dispatch");
    }
    return normal();
  });
  await host.execute();
  expect(interrupted).toBe(true);
  // The dispatch error can save a halt; replay the last unimpeded admission cursor.
  const cursor = [...host.snapshots].reverse().find(value => value.loop?.number === 2 &&
    value.action.kind === position && !value.halt)!;
  expect(cursor).toBeDefined();
  host.storage.set(EXECUTE_CURSOR_KEY, copy(cursor));
  const { store, scope } = executeStore(host.root, cursor.invocation);
  const before = store.read(scope, cursor.head);
  expect(executeField(before.P.control, "ledger", "count")).toBeGreaterThan(0);
  const output = await host.execute();
  expect(output.reason).not.toContain("Execute replay lacks");
  expect(host.current().budget.consumedLoops).toBe(2);
  expect(host.current().budget.maxCycles).toBe(2);
  expect(host.calls.filter(call => call.key === "invoke-human-1.l1.director")).toHaveLength(1);
  const director = host.calls.find(call => call.key === "invoke-human-1.l2.director")!;
  const original = host.launches.find(call => call.key === "invoke-human-1.l2.director")!;
  expect(director.task).toBe(original.task);
  const summaries = executeField(before.P.prompt, "loopSummaries");
  if (!Array.isArray(summaries)) throw new Error("Expected committed loop summaries.");
  for (const summary of summaries)
    expect(director.task).toContain(JSON.stringify(summary));
  expect(host.records().filter((record: any) => record.kind === "loop" && record.loop === 1)).toHaveLength(1);
});

test.each(["producer", "publication", "exit", "partial", "stop"])(
  "director cursor replay fails closed on native %s before dispatch", async defect => {
    const host = fixture(); host.setLimit(1);
    host.setLaunchRespond((request, normal) => {
      if (request.key === "invoke-human-1.l1.director")
        throw new Error("Controlled loss before director dispatch");
      return normal();
    });
    await host.execute();
    const cursor = [...host.snapshots].reverse().find(value =>
      value.action.kind === "launched" && value.action.role === "execution-director" && !value.halt)!;
    expect(cursor).toBeDefined();
    host.storage.set(EXECUTE_CURSOR_KEY, copy(cursor));
    if (defect === "stop") {
      // The launch reached the native runtime, but the retained cursor has no runId.
      // Status reports a Stop, with no settlement or complete output to replay.
      expect(cursor.action.runId).toBeNull();
      const key = "invoke-human-1.l1.director", runId = nativeRunId(key);
      host.setStatus(ref => ref === key
        ? { ok: true, key, runId, results: [], output: `Run: ${runId}\nState: stopped` }
        : copy(host.native.get(ref) ?? { ok: true, output: "", results: [] }));
      host.setLaunchRespond();
      const launches = copy(host.launches);
      const calls = copy(host.calls);
      const output = await host.execute();
      expect(output.status, output.reason).toBe("cancelled");
      const reason = `Director status observation for ${key}: Positive native barrier: stopped`;
      const halt = { status: "cancelled", code: "host-observation", reason, ref: { key, runId: null } };
      const hostHalt = { stage: "host-stop", reason,
        digest: canonicalDigest({ action: cursor.action, command: "READ", halt }) };
      expect(output.loopReport?.halt).toEqual(halt);
      expect(host.current()).toEqual({ ...cursor, hostHalt });
      expect(host.launches).toEqual(launches);
      expect(host.calls).toEqual(calls);

      const activity = () => [host.launches.length, host.calls.length, host.hostCalls.length,
        host.statusCalls.length, host.snapshots.length];
      const saved = JSON.stringify(host.current()), beforeRelaunch = activity();
      expect(await host.execute()).toEqual(output);
      expect(JSON.stringify(host.current())).toBe(saved);
      expect(activity()).toEqual(beforeRelaunch);

      await host.state.set(EXECUTE_CURSOR_KEY, { ...cursor, hostHalt: { ...hostHalt, digest: "0".repeat(64) } });
      const beforeInvalid = activity();
      const invalid = await host.execute();
      expect(invalid.status, invalid.reason).toBe("blocked");
      expect(invalid.reason).toContain("Retained host halt integrity failure");
      expect(activity()).toEqual(beforeInvalid);
      return;
    }
    host.setLaunchRespond(async (request, normal) => {
      const result = await normal();
      if (request.key.endsWith(".advance-replay.r1")) {
        if (defect === "producer") result.agent = "pitako.worker";
        if (defect === "publication") delete result.externalAdapter;
        if (defect === "exit") result.results![0]!.exitCode = 1;
        if (defect === "partial") result.outputPartial = true;
      }
      return result;
    });
    const before = host.launches.filter(call => call.agent === "pitako.execution-director").length;
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    expect(output.reason).toContain("Execute replay has no terminal receipt");
    expect(host.current()).toEqual(cursor);
    expect(host.launches.filter(call => call.agent === "pitako.execution-director")).toHaveLength(before);
  },
);

test("consuming the last loop does not turn a worker pause into a terminal disposition", async () => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker")
      Object.assign(result.structuredOutput, { status: "blocked", remaining: ["Standing task ruling needed"] });
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("blocked");
  const cursor = host.current();
  expect(cursor.budget.consumedLoops).toBe(cursor.budget.maxCycles);
  expect(cursor.loop.outcome).toBe("blocked");
  expect(cursor.halt).not.toBeNull();
  expect(cursor.action.kind).not.toBe("terminal");
  validateExecuteCursor(EXECUTE_CURSOR_KEY, cursor);
  const workers = host.launches.filter(call => call.agent === "pitako.worker").length;
  expect((await host.execute()).status).toBe("blocked");
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(workers);
});

test.each(["plan-conflict", "inspector-conflict", "backlog-conflict", "view-overflow", "initial-view-overflow", "spawn-budget", "capacity"] as const)(
  "a committed %s holds the same halt with no children or state writes", async mode => {
    const host = fixture(); host.setLimit(1);
    const director = "invoke-human-1.l1.director";
    if (mode === "plan-conflict") {
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key === director) result.output = JSON.stringify({ ...result.structuredOutput, reason: "different binding" });
        return result;
      });
    } else if (mode === "inspector-conflict") {
      host.setRespond((request, normal) => {
        if (request.agent === "pitako.execution-inspector")
          return host.result(request, { status: "conflict", reason: "Director originals disagree",
            provenance: ["the two complete outputs"], originalAvailable: false });
        const result = normal();
        if (request.key === director) delete result.structuredOutput;
        return result;
      });
    } else if (mode === "initial-view-overflow") {
      host.setRespond((request, normal) => request.key === "invoke-human-1.l1.advance.prepare"
        ? { ...normal(), ok: false, output: JSON.stringify({ error: "loop-io",
          reason: "HUMAN + DECISION overflow: consolidate binding rulings", viewOverflow: true }) }
        : normal());
    } else if (mode === "backlog-conflict" || mode === "view-overflow") {
      host.setLaunchRespond((request, normal) => request.key === "invoke-human-1.l1.selectionIO"
        ? { ...host.result(request, {}), ok: false,
            output: JSON.stringify(mode === "view-overflow"
              ? { error: "loop-io", reason: "HUMAN + DECISION overflow: consolidate binding rulings", viewOverflow: true }
              : { error: "loop-io", reason: "backlog-conflict: controlled digest mismatch" }) }
        : normal());
    } else if (mode === "spawn-budget") {
      host.setAdmission(group => {
        if (group[0]?.key === director)
          throw new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: `workflow[${director}]`,
            used: 64, limit: 64, requested: 1, remaining: 0 });
      });
      expect((await host.executeNative()).status).toBe("budget-exhausted");
    } else {
      host.setLaunchRespond((request, normal) => {
        if (request.key === "invoke-human-1.l1.selectionIO") throw new Error("Active async run capacity exhausted: 1/1 used.");
        return normal();
      });
    }
    const execute = () => mode === "capacity" ? host.execute() : host.executeNative();
    const halted = await execute();
    expect(halted.status, halted.reason).toBe(mode === "capacity" ? "partial" : "blocked");
    expect(halted.loopReport?.halt?.code, halted.reason)
      .toBe(mode === "inspector-conflict" ? "plan-conflict" : mode === "initial-view-overflow" ? "view-overflow" : mode);
    if (mode === "initial-view-overflow") host.setRespond();
    const saved = copy(host.current()), count = host.launches.length, saves = host.snapshots.length;
    host.setAdmission();
    const held = await execute();
    expect(held.status, held.reason).toBe(halted.status);
    expect(held.reason).toBe(halted.reason);
    expect(held.loopReport?.halt).toEqual(halted.loopReport.halt);
    expect(host.launches).toHaveLength(count);
    expect(host.snapshots).toHaveLength(saves);
    expect(host.current()).toEqual(saved);
  },
);

function advanceSaveCut(position: number) {
  let saves = 0;
  return (value: any) => value.action.kind === "pending" &&
    value.action.opKey === "invoke-human-1.l1.nextAdvance" && ++saves >= position;
}

const cuts = {
  "advance-head": advanceSaveCut(1),
  "admitted-advance": advanceSaveCut(2),
  "observed-advance": advanceSaveCut(3),
  // These saves share the committed advance input; cancellation bodies live only in P.
  "cancellation-pending": advanceSaveCut(4),
  "cancellation-input": advanceSaveCut(5),
  "cancellation-drain": (value: any) => {
    if (value.action.kind !== "pending" || value.action.opKey !== "invoke-human-1.l1.nextAdvance") return false;
    const { store, scope } = executeStore(value.root, value.invocation);
    const row = store.read(scope, value.head).records.at(-1);
    return row?.kind === "receipt" && /^invoke-human-1\.l1\.cancellationDrain\d+$/.test(executeString(executeField(row.body, "key")));
  },
  "new-loop": (value: any) => value.loop?.number === 2 && !value.loop.plan,
};

test.each(Object.entries(cuts))("transition replays after the %s essential save cut", async (name, predicate) => {
  const cancellation = name.startsWith("cancellation-");
  const { host, saves } = transitionFixture(cancellation);
  host.setFailSave(predicate);
  const interrupted = await host.execute();
  expect(interrupted.reason).toContain("Essential persistence failed");
  host.setFailSave();
  const resumed = await host.execute();
  expect(host.current().loop.number, resumed.reason).toBe(2);
  if (cancellation) {
    const uninterrupted = transitionFixture(true).host;
    await uninterrupted.execute();
    expect(host.launches.length).toBe(uninterrupted.launches.length + 1);
    expect(host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" && /\.r\d+$/.test(call.key))).toHaveLength(1);
    expect(host.launches.filter(call => ["worker", "execution-director", "reviewer"].includes(pitakoAgentFamily(call.agent) ?? ""))
      .map(call => call.key)).toEqual(uninterrupted.launches
        .filter(call => ["worker", "execution-director", "reviewer"].includes(pitakoAgentFamily(call.agent) ?? "")).map(call => call.key));
    expect(host.current().loop.taskId).toBe(uninterrupted.current().loop.taskId);
    expect(host.current().budget.consumedLoops).toBe(uninterrupted.current().budget.consumedLoops);
    // Independent roots necessarily bind their own paths and backlog/ledger hashes.
    const modelRequests = (value: typeof host) => JSON.stringify(value.launches.filter(call =>
      ["worker", "execution-director", "reviewer"].includes(pitakoAgentFamily(call.agent) ?? "")))
      .replaceAll(value.root, "<root>")
      .replace(/(CURRENT BACKLOG DIGEST: \\")[a-f0-9]{64}/g, "$1<root-bound>")
      .replace(/admitted backlog digest [a-f0-9]{64}/g, "admitted backlog digest <root-bound>")
      .replace(/(ledgerPath\\":\\"[^"]+\\",\\"head\\":\\")[a-f0-9]{64}/g, "$1<root-bound>");
    expect(modelRequests(host)).toBe(modelRequests(uninterrupted));
    expect(host.current().loop.taskId).toBe("change2");
    const director = host.launches.find(call => call.key === "invoke-human-1.l2.director")!;
    const excluded = director.task!.split("\n").find(line => line.startsWith("EXCLUDED SCOPE"))!;
    expect(JSON.parse(excluded.slice(excluded.indexOf(": ") + 2))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "change1", completed: false,
        cancel: expect.objectContaining({ origin: "model", requestId: "cancel-1" }) }),
    ]));
    expect(director.task).toContain("Report this work as unfulfilled: cancelled by main-session request, with its origin.");
    const backlog = JSON.parse(readFileSync(`${host.root}/.pitako/backlog/spec.json`, "utf8"));
    const task = backlog.tasks.find((task: any) => task.id === "change1");
    const cancellations = task.history.filter((entry: any) => entry.event === "cancel");
    expect(cancellations).toHaveLength(1);
    expect(JSON.parse(cancellations[0].reason)).toMatchObject({ requestId: "cancel-1", origin: "model", kind: "cancel" });
    expect(resumed.loopReport.cancelledScope).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "change1", completed: false, cancel: expect.objectContaining({ origin: "model" }) }),
    ]));
    const drain = host.launches.find(call => call.key.includes(".cancellationDrain"))!;
    const evidence = diskReceipt(JSON.parse(host.native.get(drain.key)!.output!));
    expect(evidence.steps.find((step: any) => step.operation === "apply").result.cancelledScope)
      .toEqual(resumed.loopReport.cancelledScope);
  }
  const published = JSON.parse(host.native.get("invoke-human-1.l1.nextAdvance")!.output!);
  const reference = { path: published.path, digest: published.digest };
  const original = diskReceipt(reference);
  const ledger = host.records();
  const cursor = copy(host.current());
  expect(resumed.loopReport?.history?.summaries, resumed.reason).toEqual(summarizeLoops(ledger));
  const count = host.launches.length;
  const held = await host.execute();
  expect(host.launches).toHaveLength(count);
  if (cancellation) expect(held.loopReport.halt).toEqual(resumed.loopReport.halt);
  expect(host.records()).toEqual(ledger);
  expect(diskReceipt(reference)).toEqual(original);
  expect(host.current()).toEqual(cursor);
  expect(host.calls.filter(call => call.key === "invoke-human-1.l1.nextAdvance.requests")).toHaveLength(1);
  for (const { value } of saves)
    expect(Buffer.byteLength(JSON.stringify({ [EXECUTE_CURSOR_KEY]: value }, null, 2)))
      .toBeLessThanOrEqual(EXECUTE_CURSOR_MAX_BYTES);
  if (name === "cancellation-pending") {
    // A valid hash chain can still contain an inconsistent decision projection.
    const { scope } = executeStore(host.root, cursor.invocation);
    const raw = new PitakoStore(host.root);
    raw.commit(scope, raw.readRecords(scope).head, "invalid-observation", canonicalDigest({ invalid: true }),
      () => ({ kind: "operation", body: { operation: "advance",
        request: { key: "invalid-observation", requestObservation: -1 } } }));
    const backlog = readBacklog(host.root, "spec");
    const applyKey = "cancel-inconsistent-projection";
    const input = { operation: "drain", root: host.root, invocation: cursor.invocation,
      key: "drain-inconsistent-projection", intentions: [{ key: applyKey, operation: "apply", input: {
        root: host.root, specId: "spec", expectedDigest: backlog.digest, key: applyKey,
        invocation: cursor.invocation, loop: 2, authority: backlog.backlog!.authority,
        dbPath: `${host.root}/.pi/test-board.db`,
        director: { select: null, changes: [], reason: "Persist cancellation" },
        cancellations: [{ taskId: "change2", requestId: "cancel-2", kind: "cancel", origin: "model" }],
      } }] };
    const before = readFileSync(backlog.path, "utf8");
    const result = spawnSync(process.execPath, [new URL("../skills/execute/loop-io.mjs", import.meta.url).pathname],
      { cwd: host.root, input: JSON.stringify(input), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("Invalid stored request observation counter");
    expect(readFileSync(backlog.path, "utf8")).toBe(before);
    expect(raw.readRecords(scope).records.some(row => row.opKey.includes(applyKey))).toBe(false);
  }
});

test("changed committed transition reference is rejected before a next-loop director", async () => {
  const { host } = transitionFixture();
  host.setFailSave(cuts["new-loop"]);
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  const retained = host.current();
  retained.action.input.digest = "a".repeat(64);
  host.setFailSave();
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain("stored operation input integrity mismatch");
  expect(host.launches.some(call => call.key === "invoke-human-1.l2.director")).toBe(false);
});

test("final selection retains one acceptance history and delivers it to review and compliance", async () => {
  const host = fixture(undefined, { taskCount: 0 });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  const backlog = readBacklog(host.root, "spec").backlog!;
  expect(backlog.acceptanceHistory).toHaveLength(1);
  expect(backlog.acceptance).toHaveLength(1);
  for (const field of ["acceptance", "acceptanceHistory"]) {
    expect(host.current().loop).not.toHaveProperty(field);
  }
  const history = `Acceptance history: ${canonicalJSON(backlog.acceptanceHistory)}.`;
  for (const suffix of ["director-prepare", ".compliance"]) {
    const request = host.calls.find(call => call.key.endsWith(suffix))!;
    expect(request.task).toContain(history);
  }
  // This is the actual integrated-review root, not the isolated persistState boundary above.
  expect(host.calls.some(call => call.key.includes(".review."))).toBe(true);
  expect(host.launches.some(call => call.agent === "pitako.review-store")).toBe(false);
  expect([...host.storage.keys()]).toEqual([EXECUTE_CURSOR_KEY]);
  expect(host.snapshots.length).toBeGreaterThan(0);
  for (const value of host.snapshots) validateExecuteCursor(EXECUTE_CURSOR_KEY, value);
  const before = copy(Object.fromEntries(host.storage)), children = host.launches.length;
  expect((await host.execute()).status).toBe("complete");
  expect(host.launches).toHaveLength(children);
  expect(Object.fromEntries(host.storage)).toEqual(before);
});

test("execute admission leaves unrelated mission state unchanged", async () => {
  const host = fixture();
  const unrelatedKey = "unrelated-state";
  host.storage.set(unrelatedKey, { preserved: "unchanged" });
  const before = copy(Object.fromEntries(host.storage));
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  expect(host.storage.get(unrelatedKey)).toEqual(before[unrelatedKey]);
  expect([...host.storage.keys()]).toEqual([unrelatedKey, EXECUTE_CURSOR_KEY]);
  expect(host.launches.length).toBeGreaterThan(0);
  expect(host.current().version).toBe(EXECUTE_STATE_VERSION);
});
