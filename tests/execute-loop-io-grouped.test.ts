import { beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { apply, prepare, readBacklog, readTaskGateWire, topicOwner, type Task } from "../skills/execute/loop.ts";
import { openBoard } from "../extensions/board/store.ts";
import { repositoryIdentity } from "../extensions/board/workspace.ts";
import { canonicalDigest, canonicalJSON, sha256 } from "../extensions/canonical.mjs";
import { appendExecuteTodoRecords } from "../extensions/execute-todo-projection.ts";
import { PitakoStore } from "../extensions/pitako-store.ts";
import { openSqliteSync } from "../extensions/board/sqlite.ts";
import { EXECUTE_STATE_VERSION, executionStatePath } from "../extensions/execute-state.ts";
import { validateExecuteCursor } from "../extensions/execute-cursor.ts";
import { applyCheckpoint, beginHookEffect, captureCheckpoint, checkpointDirectory, recordContextPeak, restoreCheckpoint, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { childResponse, realCheckoutCompositionFixture, nativeCheckpointFixture } from "./fixtures/plan-execute-composition.ts";

const entry = path.resolve("skills/execute/loop-io.mjs");
const { verifyLedger, executeProjection } = await import(path.resolve("skills/execute/ledger.mjs"));
const composition = realCheckoutCompositionFixture();
const { roots } = composition;
const runtime = nativeCheckpointFixture(composition);
beforeAll(() => runtime.startNativeCheckpoint({ extension: false }));
const invocation = "drain-fixture";
const authority = { specDigest: "a".repeat(64), amendmentDigests: [] };
const scope = `exec:${invocation}.e0`;
function stored(root: string) {
  const records = new PitakoStore(root).read(scope).records;
  expect(JSON.stringify(records)).not.toContain('"P":');
  return records;
}
function storedOperation(root: string, operation: string, key: string) {
  const prefix = new PitakoStore(root).read(scope);
  const row = prefix.records.find(row => row.opKey === `operation:${key}`)!;
  return { operation, invocation, key: `${key}.r1`, storeId: prefix.identity.storeId, scope,
    expectedHead: { seq: row.seq, hash: row.digest }, refs: { input: { seq: row.seq, digest: row.digest } } };
}
function corruptRecord(root: string, opKey: string) {
  const db = openSqliteSync(path.join(root, ".pi/pitako/pitako.db"));
  try {
    expect(db.prepare("SELECT seq FROM records WHERE scope=? AND opKey=?").get(scope, opKey)).toBeDefined();
    db.prepare("UPDATE records SET body='{}' WHERE scope=? AND opKey=?").run(scope, opKey);
  } finally { db.close(); }
}
const markerKey = (key: string) => `loop-io:loop-io/steps/${sha256(key)}/000000.json`;

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-drain-")); roots.push(root);
  composition.fake.fakeRepo(root, { paths: ["product"] });
  writeFileSync(path.join(root, "product"), "original");
  const dbPath = path.join(root, ".pi/board.db");
  const task: Task = { id: "one", title: "One task", goal: "Implement one", expectedResult: "Done", status: "pending",
    origin: { kind: "spec", ref: "spec" }, specRefs: ["acceptance-1"], dependsOn: [],
    gates: [{ id: "focused", command: "true", cwd: ".", timeoutMs: 1000 }], metric: null,
    parent: null, remaining: "", progress: { nonImproving: 0, last5: [] }, history: [] };
  const first = apply({ root, specId: "example", key: "initial", invocation, loop: 1, authority, expectedDigest: null,
    acceptance: [{ id: "full", command: "true", cwd: "." }],
    director: { select: task.id, changes: [{ kind: "add", task, reason: "Spec" }], reason: "Initialize" } });
  await prepare({ root, specId: "example", dbPath, previousConfirmedUnit: null });
  const board = await openBoard(dbPath);
  try {
    const workspace = repositoryIdentity(root), topicId = board.findTopicOwnedByPlan(workspace, topicOwner(root, "example"))!;
    board.postOnce(workspace, "existing-finding", { topicId, type: "FINDING", content: "Existing gate finding" });
  } finally { board.close(); }
  const content = "# Frozen spec";
  const unitInput = { expected: { count: 0, head: null }, spec: { content, digest: sha256(content) },
    record: { kind: "unit", loop: 1, body: { taskId: "one", attempt: 1 } } };
  // Compute the expected anchor from the exact immutable ledger format, without publishing.
  const specBytes = canonicalJSON({ body: unitInput.spec, kind: "spec", loop: 0, prev: null, seq: 0 });
  const unitBytes = canonicalJSON({ ...unitInput.record, prev: sha256(specBytes), seq: 1 });
  const intentions = [
    { key: "unit-one", operation: "ledger", input: unitInput },
    { key: "cancel-one", operation: "apply", input: { specId: "example", dbPath, key: "cancel-one", invocation,
      loop: 1, authority, expectedDigest: first.digest, director: { select: null, changes: [], reason: "Cancel request" },
      cancellations: [{ taskId: "one", requestId: "request-1", kind: "cancel", origin: "main" }] } },
    { key: "gaps-one", operation: "ledger", input: { expected: { count: 2, head: sha256(unitBytes) },
      record: { kind: "loop", loop: 1, body: { results: [{ taskId: "one", remaining: ["Cancelled"] }] } } } },
  ];
  return { root, dbPath, request: { operation: "drain", key: "finish", invocation, intentions } };
}

function launch(f: Awaited<ReturnType<typeof fixture>>, request: any = f.request, interruption?: { key: string; phase: string }) {
  const result = launchCase(f, request, interruption);
  composition.workflowSettlements.push(result.then(() => {}, () => {}));
  return result;
}

async function launchCase(f: Awaited<ReturnType<typeof fixture>>, request: any, interruption?: { key: string; phase: string }) {
  // Reuse the file-owned loader, not operation state: every replay re-reads disk.
  // The fixture joins cancelled cases and the child before releasing owned roots.
  // loop-io loads its own Node hooks; these harnesses do not use the Pi SDK.
  if (!runtime.nativeCheckpoint) await runtime.startNativeCheckpoint({ sdk: false, executable: "node" });
  const result = await runtime.nativeCheckpointCase({ ...runtime.nativeCheckpointInput(),
    sdk: false, root: f.root, request, interruption }, `async ({request,interruption}) => {
    const {drain,grouped,receiptTransport}=await import(${JSON.stringify(pathToFileURL(entry).href)});
    const {operation,...input}=request;
    input.root=process.cwd();
    const stop=interruption;
    const hooks=stop ? {[stop.phase]: key => {
      if(key===stop.key) throw new Error("injected interruption");
    }} : {};
    try { const result=await (operation==="drain" ? drain(input,hooks) : grouped(operation,input,hooks));
      return {exit:0,stdout:JSON.stringify(receiptTransport(result))+"\\n",stderr:""}; }
    catch(error) {
      return {exit:1,stdout:stop ? "" : JSON.stringify({error:"loop-io",reason:error.message})+"\\n",
        stderr:stop ? error.message+"\\n" : ""};
    }
  }`);
  if (!result || result[0] !== 0) throw new Error(result?.[2] ?? "Grouped fixture cancelled");
  return JSON.parse(result[1]) as { exit: number; stdout: string; stderr: string };
}

function receipt(output: string) {
  const reference = JSON.parse(output.trim());
  expect(Object.keys(reference).sort()).toEqual(expect.arrayContaining(["digest", "path"]));
  const [root, relative] = reference.path.split("/.pi/subagents/execute/" + invocation + "/");
  const row = stored(root).find(row => row.opKey === "loop-io:" + relative)!;
  const bytes = canonicalJSON(row.body);
  expect(existsSync(reference.path)).toBe(false);
  expect(sha256(bytes)).toBe(reference.digest);
  const value = JSON.parse(bytes);
  expect(canonicalDigest(value.result)).toBe(value.resultDigest);
  return value.result;
}

async function finalState(f: Awaited<ReturnType<typeof fixture>>, output: string, posts = ["Existing gate finding"]) {
  const value = receipt(output);
  expect(value.steps.map((step: any) => step.key)).toEqual(["unit-one", "cancel-one", "gaps-one"]);
  const records = verifyLedger(f.root, invocation, {
    count: value.steps[2].result.count, head: value.steps[2].result.head,
  });
  expect(records.map((record: any) => record.kind)).toEqual(["spec", "unit", "loop"]);
  expect(stored(f.root).filter(row => row.kind === "ledger").flatMap(row => (row.body as any).entries)).toHaveLength(3);
  expect(existsSync(path.join(f.root, ".pi/subagents/execute", invocation, "000000.json"))).toBe(false);
  const backlog = readBacklog(f.root, "example").backlog!;
  expect(backlog.tasks[0]!.status).toBe("obsolete");
  expect(backlog.tasks[0]!.history.filter(event => event.event === "cancel")).toHaveLength(1);
  const board = await openBoard(f.dbPath);
  try {
    const workspace = repositoryIdentity(f.root), topicId = board.findTopicOwnedByPlan(workspace, topicOwner(f.root, "example"))!;
    expect(board.readTopic(workspace, topicId).posts.map(post => post.content)).toEqual(posts);
  } finally { board.close(); }
  const { lastApplied, ...domainBacklog } = backlog;
  return { records, backlog: domainBacklog, contentDigest: lastApplied!.contentDigest };
}

test("drains in persisted order and returns an immutable receipt by reference, including empty finish drains", () => {
  const work = (async () => {
  const f = await fixture();
  // Keep the external CLI boundary once; the interruption matrix owns disk replay.
  const child = Bun.spawn(["node", entry], { cwd: f.root, env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(f.request)); child.stdin.end();
  await composition.checkpointLifecycle(child, async ([exit, stdout, stderr]) => {
    expect(exit, stdout + stderr).toBe(0);
    const state = await finalState(f, stdout);
    const replay = await launch(f);
    expect(replay.exit, replay.stderr).toBe(0);
    expect(replay.stdout).toBe(stdout);
    expect(await finalState(f, replay.stdout)).toEqual(state);
    const empty = await launch(f, { ...f.request, key: "empty-finish", intentions: [] });
    expect(empty.exit, empty.stderr).toBe(0);
    expect(receipt(empty.stdout)).toEqual({ invocation, steps: [] });
    const original = JSON.parse(stdout), later = JSON.parse(empty.stdout);
    expect(later.head.seq).toBeGreaterThan(original.head.seq);
    expect((await launch(f)).stdout).toBe(stdout);
    const { head, P } = original;
    const { executeProjection } = await import("../skills/execute/ledger.mjs");
    expect(P).toEqual(new PitakoStore(f.root, executeProjection).read(scope, head).P);
    expect(P.preview.loopSummaries).toHaveLength(1);
    expect(P.preview.manifest.length).toBe(1);
  }).result;
  })();
  // Own the caller too: a runner timeout abandons its await of the lifecycle.
  composition.workflowSettlements.push(work.then(() => {}, () => {}));
  return work;
});

async function groupedFixture(operation: "advance" | "close", workerStatus = "complete", initialRequest = true) {
  const f = await fixture();
  const intent: CheckpointIntent = { version: 2, association: { root: f.root,
    commonDir: path.join(f.root, ".git"), missionId: "mission", missionPath: path.join(f.root, "mission.json"),
    invocation, source: path.join(f.root, "spec.md"), digest: authority.specDigest, maxCycles: 15, sourceRefs: [] },
    key: "worker.a1", taskId: "one", attempt: 1, loop: 1, cursor: 0, phase: "implementation", planRef: {},
    progress: { consumedLoops: 1, admitted: {}, previous: null } };
  const store = new PitakoStore(f.root), identity = store.activate(scope);
  const saved = store.commit(scope, store.read(scope).head, "fixture:intent", canonicalDigest(intent),
    () => ({ kind: "intent", body: intent }));
  if (saved.outcome !== "appended" || !saved.head) throw new Error("Expected fixture intent append.");
  const input = { seq: saved.head.seq, digest: saved.head.hash };
  const cursor = {
    version: EXECUTE_STATE_VERSION, storeId: identity.storeId, root: f.root, invocation, epoch: 0,
    associationDigest: canonicalDigest(intent.association), admissionBinding: "b".repeat(64), head: saved.head,
    action: { kind: "launched", key: intent.key, runId: null, role: "worker", input, gateTimeoutMs: 1000 },
    loop: { number: 1, phase: "implementation", cursor: 0, taskId: "one", outcome: null,
      attempt: { number: 1, stage: "launched", intent: input, revival: null } },
    inFlight: [], halt: null, hostHalt: null,
    timeouts: { reviewerMs: 1000, workerMs: 1000, gateFloorMs: 0 },
    models: { taskReviewer: "fixture/reviewer", taskSynthesis: "fixture/synthesis",
      r1: "fixture/r1", r2: "fixture/r2", synthesis: "fixture/synthesis" },
    budget: { consumedLoops: 1, maxCycles: 15, rejectedKeys: [], lastProgress: null },
    backlogDigest: null, boardTopicId: 1, review: null,
  };
  validateExecuteCursor("pitako-execute", cursor);
  const statePath = executionStatePath(intent.association);
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ "pitako-execute": cursor }));
  captureCheckpoint(intent, ["product"]);
  recordContextPeak(intent, 12000);
  applyCheckpoint(intent, [{ path: "product", image: { bytes: Buffer.from("completed").toString("base64"), mode: 0o644 } }]);
  const worker = childResponse(intent.key, { agent: "pitako.worker",
    extensionBindings: { "pitako.checkpoint/1": intent } }, { root: f.root }, undefined, 1,
    { work: "Settled attempt", status: workerStatus, remaining: [],
      continuation: { mode: workerStatus === "continue" ? "resume" : "fresh", reason: "Same task" },
      knowledge: { findings: ["Grouped finding"], handoff: "Grouped handoff" } });
  const request: any = { ...f.request, operation, key: operation, requests: { cursor: 0 } };
  request.prepare = { specId: "example", dbPath: f.dbPath, previousConfirmedUnit: null, loop: 1 };
  request.gate = { specId: "example", dbPath: f.dbPath, key: "worker.a1.gate", loop: 1, attempt: 1,
    task: { id: "one", gates: [{ id: "focused", command: "printf run >> .pi/gate-count", cwd: ".", timeoutMs: 1000 }],
      metric: null, progress: { nonImproving: 0, last5: [] } },
    workerStatus, writerSettled: true, checkpoint: intent, revival: { decision: "resume" },
    worker: { key: intent.key, runId: worker.runId } };
  request.seal = { unit: { v: 1, intent }, pause: { v: 1, intent } };
  const directory = path.join(f.root, ".pi/subagents/execute", invocation);
  mkdirSync(directory, { recursive: true });
  if (initialRequest) appendExecuteTodoRecords(f.root, invocation, "request", [{ v: 1, invocation,
    requestId: "request-1", taskId: "one", kind: "cancel", origin: "main", at: 1 } as any]);
  return { ...f, request, intent };
}

async function groupedState(f: Awaited<ReturnType<typeof groupedFixture>>, output: string) {
  const result = receipt(output);
  const { head, P } = JSON.parse(output);
  expect(P).toEqual(new PitakoStore(f.root, executeProjection).read(scope, head).P);
  const projection = JSON.parse(output).projection;
  const nestedApply = projection.steps[0].result.projection.steps.find((step: any) => step.operation === "apply").result;
  for (const field of ["acceptance", "acceptanceHistory", "view"])
    expect(nestedApply).not.toHaveProperty(field);
  const diskApply = receipt(JSON.stringify(result.steps[0].result)).steps.find((step: any) => step.operation === "apply").result;
  for (const field of ["acceptance", "acceptanceHistory"])
    expect(diskApply).toHaveProperty(field);
  expect(result.steps.map((step: any) => step.operation)).toEqual(result.operation === "advance"
    ? ["drain", "prepare", "requests"] : ["drain", "requests", "gate", "seal"]);
  expect(result.steps.find((step: any) => step.operation === "requests").result).toMatchObject({
    ok: true, invocation, next: null, requests: [{ requestId: "request-1", taskId: "one", kind: "cancel" }],
  });
  const drainReference = result.steps[0].result;
  const state = await finalState(f, JSON.stringify(drainReference), result.operation === "close"
    ? ["Existing gate finding", "Grouped finding", "Grouped handoff"] : ["Existing gate finding"]);
  if (result.operation === "advance") {
    const prepared = result.steps[1].result;
    for (const field of ["acceptance", "acceptanceHistory"]) {
      expect(prepared).toHaveProperty(field);
      expect(projection.steps[1].result).not.toHaveProperty(field);
    }
    expect(prepared.viewDigest).toBe(canonicalDigest(prepared.view));
    expect(prepared.viewBytes).toBe(Buffer.byteLength(canonicalJSON(prepared.view)));
    return { state, operations: result.steps.map((step: any) => step.operation) };
  }
  const gate = result.steps[2].result, seal = result.steps[3].result;
  expect(gate.receipt).toHaveProperty("view");
  expect(projection.view).toEqual(gate.receipt.view);
  expect(projection.steps[2].result.receipt).not.toHaveProperty("view");
  const projectedGate = { ...projection.steps[2].result.receipt, view: projection.view };
  expect(Buffer.byteLength(JSON.stringify(projectedGate) + "\n")).toBeLessThanOrEqual(8192);
  const decoded = readTaskGateWire(projectedGate, f.request.gate.task.gates, projection.steps[2].result.workerOriginal);
  expect(decoded.gates).toEqual(gate.receipt.gates.map((entry: Record<string, unknown>) => ({ ...entry, tail: "" })));
  expect(decoded.progress).toEqual(gate.receipt.progress);
  expect(decoded.workerOriginal).toEqual(gate.receipt.workerOriginal);
  expect(gate.receipt).not.toHaveProperty("contextPeak");
  expect(result.contextPeak).toBe(12000);
  expect(JSON.parse(output).P.control.lastAttempt).toMatchObject({
    taskId: "one", number: 1, checkpoint: { loop: 1 }, launch: f.request.gate.worker,
    revival: { decision: "resume" }, result: { status: "complete" },
    gate: { receipt: { contextPeak: 12000, after: gate.receipt.after,
      progress: { nonImproving: gate.receipt.progress.nonImproving }, stalled: gate.receipt.stalled } },
  });
  expect(seal).toMatchObject({ kind: "unit", workerStatus: "complete", mutated: false, receipt: { outcome: "sealed", kind: "unit" } });
  expect(existsSync(seal.gate.path)).toBe(false);
  expect(sha256(canonicalJSON(stored(f.root).find(row => row.opKey === markerKey("close.gate"))!.body))).toBe(seal.gate.digest);
  expect(readFileSync(path.join(f.root, ".pi/gate-count"), "utf8")).toBe("run");
  expect(readdirSync(checkpointDirectory(f.intent)).filter(name => ["unit.json", "pause.json"].includes(name))).toEqual(["unit.json"]);
  return { state, seal: { kind: seal.kind, outcome: seal.receipt.outcome }, content: readFileSync(path.join(f.root, "product"), "utf8") };
}

for (const operation of ["advance", "close"] as const) {
  const names = operation === "advance" ? ["drain", "prepare", "requests"] : ["drain", "requests", "gate", "seal"];
  for (const phase of ["afterEffect", "afterStep"]) for (const name of names) {
    test(`${operation} resumes ${phase} ${name} without duplicate effects`, async () => {
      const f = await groupedFixture(operation);
      // IDs are bound by the ordered gate request, not repeated on a large wire receipt.
      const longId = operation === "close" && phase === "afterStep" && name === "gate";
      if (longId) f.request.gate.task.gates[0].id = "focused".repeat(1200);
      const interrupted = await launch(f, f.request, { phase, key: `${operation}.${name}` });
      expect(interrupted.exit, interrupted.stderr).toBe(1);
      expect(interrupted.stderr).toContain("injected interruption");
      const resumed = await launch(f, storedOperation(f.root, operation, operation));
      expect(resumed.exit, resumed.stdout + resumed.stderr).toBe(0);
      const state = await groupedState(f, resumed.stdout);
      const replay = await launch(f, f.request, { phase: "afterEffect", key: `${operation}.${name}` });
      expect(replay.exit, replay.stderr).toBe(0);
      expect(replay.stdout).toBe(resumed.stdout);
      expect(await groupedState(f, replay.stdout)).toEqual(state);
      const clean = await groupedFixture(operation);
      if (longId) clean.request.gate.task.gates[0].id = f.request.gate.task.gates[0].id;
      const completed = await launch(clean);
      expect(completed.exit, completed.stdout + completed.stderr).toBe(0);
      expect(await groupedState(clean, completed.stdout)).toEqual(state);
    });
  }
}

test("close refuses an active writer before draining", async () => {
  const f = await groupedFixture("close");
  f.request.gate.writerSettled = false;
  const result = await launch(f);
  expect(result.exit).toBe(1);
  expect(JSON.parse(result.stdout).reason).toContain("settled worker");
  expect(readBacklog(f.root, "example").backlog!.tasks[0]!.status).toBe("pending");
});

for (const operation of ["selection", "close"] as const) for (const phase of ["afterEffect", "afterStep"])
  for (const name of operation === "selection" ? ["baseline"] : ["nextRequests", "nextBaseline"]) {
  test(`${operation} resumes ${phase} folded baseline step ${name} without changing attribution`, async () => {
    const f = await groupedFixture("close", "continue", false);
    const intent = { ...f.intent, key: "worker.a2", attempt: 2 };
    const request = operation === "selection" ? {
      operation, key: operation, invocation, intentions: [], requests: { cursor: 0 }, baseline: intent,
      apply: { specId: "example", dbPath: f.dbPath, key: "select", invocation, loop: 1, authority,
        expectedDigest: readBacklog(f.root, "example").digest,
        director: { select: "one", changes: [], reason: "Select task" } },
    } : { ...f.request, nextBaseline: { sealed: intent, observed: intent }, gate: { ...f.request.gate, workerStatus: "continue" } };
    const interrupted = await launch(f, request, { phase, key: `${operation}.${name}` });
    expect(interrupted.exit, interrupted.stdout + interrupted.stderr).toBe(1);
    const file = path.join(checkpointDirectory(intent), "baseline.json");
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    const resumed = await launch(f, { ...request, key: `${operation}.r1` });
    expect(resumed.exit, resumed.stdout + resumed.stderr).toBe(0);
    const result = receipt(resumed.stdout);
    expect(result.steps.at(-1).result).toMatchObject({ captured: true });
    const bytes = readFileSync(file, "utf8");
    if (before !== null) expect(bytes).toBe(before);
    const baseline = JSON.parse(JSON.parse(bytes).data);
    expect(baseline.intent.key).toBe(intent.key);
    expect(baseline.intent.baseline).toEqual(result.steps.at(-1).result.candidate);
    const intentRef = result.steps.at(-1).result.intent;
    const committed = stored(f.root).find(row => row.seq === intentRef.seq)!;
    expect(committed.kind).toBe("intent");
    expect(committed.digest).toBe(intentRef.digest);
    expect(committed.seq).toBeLessThanOrEqual(JSON.parse(resumed.stdout).head.seq);
    expect(committed.body).toEqual(baseline.intent);
  });
}

test.each(["sealed", "observed", "unit", "mismatch", "open", "blocked", "cancelled"])(
  "next baseline selects only the workflow-prepared progress for %s evidence", async outcome => {
    const f = await groupedFixture("close", outcome === "unit" ? "complete" : outcome === "blocked" ? "blocked" : "continue", false);
    const next = { ...f.intent, key: "worker.a2", attempt: 2,
      progress: { consumedLoops: 1, admitted: { one: ["continue"] }, previous: null } };
    const previous = { taskId: "previous", attempt: 1, resultRef: { key: "previous" },
      checkpointRef: path.join(f.root, ".pi/subagents/checkpoints/previous/unit.json"), digest: "b".repeat(64) };
    f.request.nextBaseline = { sealed: next, observed: { ...next, progress: { ...next.progress, previous } } };
    if (outcome === "observed") rmSync(path.join(checkpointDirectory(f.intent), "manifest.json"));
    if (outcome === "mismatch") writeFileSync(path.join(f.root, "product"), "unjournaled");
    if (outcome === "open") beginHookEffect(f.intent, "edit", ["product"]);
    const identity = new PitakoStore(f.root).readIdentity();
    let output: Awaited<ReturnType<typeof launch>>;
    if (outcome === "cancelled") {
      const late = { v: 1, invocation, requestId: "late", taskId: "one", kind: "cancel", origin: "main", at: 2 };
      const foreground = new URL("../extensions/execute-todo-projection.ts", import.meta.url).href;
      // Load the foreground module before the timed gate; publish only after the gate's signal.
      execFileSync("mkfifo", [".pi/todo-start", ".pi/todo-committed"], { cwd: f.root });
      const script = `import {readFileSync,writeFileSync} from "node:fs";
        import {appendExecuteTodoRecords} from ${JSON.stringify(foreground)};
        console.log("ready");
        if (readFileSync(".pi/todo-start", "utf8") !== "start\\n") throw new Error("Missing gate signal");
        appendExecuteTodoRecords(process.cwd(), ${JSON.stringify(invocation)}, "request", [${JSON.stringify(late)}]);
        writeFileSync(".pi/todo-committed", "committed\\n");`;
      const child = Bun.spawn([process.execPath, "-e", script], { cwd: f.root, stdout: "pipe", stderr: "inherit" });
      const settled = (async () => {
        const ready = await child.stdout.getReader().read();
        expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
        f.request.gate.task.gates[0].command = "printf 'start\\n' > .pi/todo-start && read receipt < .pi/todo-committed && test \"$receipt\" = committed";
        const result = await launch(f);
        expect(result.exit, result.stdout + result.stderr).toBe(0);
        expect(receipt(result.stdout).steps.find((step: any) => step.operation === "gate").result.receipt.gates)
          .toMatchObject([{ id: "focused", status: "pass" }]);
        expect(await child.exited).toBe(0);
        return result;
      })();
      // If the gate failed before the handshake, cancel the blocked foreground process.
      const run = settled.finally(async () => {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      });
      composition.workflowSettlements.push(run.then(() => {}, () => {}));
      output = await run;
    } else {
      output = await launch(f);
    }
    expect(output.exit, output.stdout + output.stderr).toBe(0);
    const result = receipt(output.stdout), baseline = result.steps.at(-1).result;
    if (outcome === "cancelled") {
      const store = new PitakoStore(f.root);
      expect(store.readIdentity()).toEqual(identity);
      const {head} = JSON.parse(output.stdout);
      expect(store.readRecords(scope, head).head).toEqual(head);
      expect(store.readRecords(`todo:${invocation}`).records.map(row => row.body)).toMatchObject([{requestId: "late"}]);
      expect(result.steps.find((step: any) => step.operation === "requests").result.requests).toEqual([]);
      expect(result.steps.find((step: any) => step.operation === "nextRequests").result.requests).toMatchObject([{ requestId: "late" }]);
    }
    const capture = ["sealed", "observed"].includes(outcome);
    expect(baseline.captured).toBe(capture);
    expect(baseline.variant).toBe(capture ? outcome : null);
    const file = path.join(checkpointDirectory(next), "baseline.json");
    if (capture) {
      const captured = JSON.parse(JSON.parse(readFileSync(file, "utf8")).data).intent;
      expect(captured.progress.admitted).toEqual({ one: ["continue"] });
      expect(captured.progress.previous).toEqual(outcome === "sealed" ? null : previous);
    } else {
      expect(existsSync(file)).toBe(false);
      expect(baseline.reason).toBe(outcome);
    }
  });

test.each(["truncate", "replace"])("nextRequests rejects %s of an earlier sticky request snapshot", async damage => {
  const f = await groupedFixture("close", "continue");
  const file = new PitakoStore(f.root).file;
  const sql = damage === "truncate" ? `DELETE FROM records WHERE scope='todo:${invocation}'` :
    `UPDATE records SET body='null' WHERE scope='todo:${invocation}'`;
  f.request.gate.task.gates[0].command = `node -e '${`const {DatabaseSync}=require("node:sqlite");
    const db=new DatabaseSync(${JSON.stringify(file)}); try {db.exec(${JSON.stringify(sql)});} finally {db.close();}`.replaceAll("'", "'\\''")}'`;
  const next = { ...f.intent, key: "worker.a2", attempt: 2 };
  f.request.nextBaseline = { sealed: next, observed: next };
  const output = await launch(f);
  expect(output.exit).toBe(1);
  expect(JSON.parse(output.stdout).reason).toContain(damage === "truncate" ? "request snapshot integrity conflict" : "Record body mismatch");
  expect(existsSync(path.join(checkpointDirectory(next), "baseline.json"))).toBe(false);
});

test.each(["worker", "failed", "missing", "mutated"])("close selects pause for %s evidence", async difference => {
  const f = await groupedFixture("close", difference === "worker" ? "continue" : "complete");
  if (difference === "worker") delete f.request.gate.revival;
  if (difference === "failed") f.request.gate.task.gates[0].command = "false";
  if (difference === "mutated") f.request.gate.task.gates[0].command = "printf drift > product";
  if (difference === "missing") {
    const output = execFileSync("node", ["--input-type=module", "-e",
      `import {closeSealKind} from ${JSON.stringify(pathToFileURL(entry).href)};
       console.log(closeSealKind("complete", [{id:"required"}], {mutated:false,gates:[]}));`], { encoding: "utf8" });
    expect(output.trim()).toBe("pause");
    return;
  }
  const result = await launch(f);
  expect(result.exit, result.stdout + result.stderr).toBe(0);
  expect(receipt(result.stdout).steps.at(-1).result.kind).toBe("pause");
  if (difference === "worker") expect(JSON.parse(result.stdout).P.control.lastAttempt.revival).toBeNull();
});

test("close transports a near-60 KiB sealer receipt by verified disk reference", async () => {
  const f = await groupedFixture("close");
  restoreCheckpoint(f.intent, { pending: true, stop: false, permissionDenied: false, activeWriter: null, references: ["settled"] });
  const restoredPath = path.join(checkpointDirectory(f.intent), "restored.json");
  const restored = JSON.parse(JSON.parse(readFileSync(restoredPath, "utf8")).data);
  restored.preserve = "x".repeat(59 * 1024);
  const data = JSON.stringify(restored);
  writeFileSync(restoredPath, JSON.stringify({ data, sha256: sha256(data) }));
  for (const variant of Object.values(f.request.seal) as any[]) variant.restoreSources = [f.intent];
  const result = await launch(f);
  expect(result.exit, result.stdout + result.stderr).toBe(0);
  expect(Buffer.byteLength(result.stdout)).toBeLessThan(61440);
  const value = receipt(result.stdout);
  const sealed = value.steps.at(-1).result.receipt;
  expect(Buffer.byteLength(JSON.stringify(sealed))).toBeGreaterThan(59 * 1024);
  expect(sealed.restored.preserve).toBe(restored.preserve);
  expect(JSON.parse(result.stdout).projection.steps.at(-1).result.receipt.restored).not.toHaveProperty("preserve");
});

test.each(["selection", "close"] as const)("%s transports a near-48 KiB request page with one bounded P", async operation => {
  const f = await groupedFixture("close", "continue", false);
  // A full planning packet must not consume the request page's transport budget.
  const body = f.request.intentions.at(-1).input.record.body;
  body.results[0].remaining = ["g".repeat(4096)];
  body.review = { verdict: "gaps", reason: "r".repeat(4096) };
  body.compliance = { status: "gaps", reason: "c".repeat(4096), unresolved: ["u".repeat(4096)] };
  body.plan = { rejection: { diagnostic: "d".repeat(4096) } };
  f.request.gate.task.gates[0].verifies = [1, 2, 3, 4, 5, 6, 7, 8];
  // Accumulated loops and full context pages must fit together, not just alone.
  const anchor = f.request.intentions.at(-1).input.expected;
  let seq = anchor.count;
  let head = sha256(canonicalJSON({ ...f.request.intentions.at(-1).input.record,
    seq, prev: anchor.head }));
  for (const loop of [2, 3]) {
    const record = { kind: "loop", loop, body };
    f.request.intentions.push({ key: `gaps-${loop}`, operation: "ledger",
      input: { expected: { count: ++seq, head }, record } });
    head = sha256(canonicalJSON({ ...record, seq, prev: head }));
  }
  const current = readBacklog(f.root, "example");
  const addTasks: Parameters<typeof apply>[0] & { dbPath: string } = {
    root: f.root, specId: "example", dbPath: f.dbPath, invocation,
    key: "more-tasks", loop: 1, authority, expectedDigest: current.digest,
    director: { select: "one", reason: "Full admitted task page", changes: [{
      kind: "update" as const, id: "one", patch: { goal: "Complete selected task ".repeat(30) },
      reason: "Full current prompt, not a display preview",
    }, ...[2, 3, 4].map(index => ({
      kind: "add" as const, reason: "Full page",
      task: { ...current.backlog!.tasks[0]!, id: `task${index}`,
        title: "t".repeat(80), goal: "g".repeat(128), remaining: "r".repeat(128) },
    }))] } };
  const added = apply(addTasks);
  f.request.intentions[1].input.expectedDigest = added.digest;
  const board = await openBoard(f.dbPath);
  try {
    const workspace = repositoryIdentity(f.root);
    const topicId = board.findTopicOwnedByPlan(workspace, topicOwner(f.root, "example"))!;
    for (let index = 0; index < 4; index++)
      board.postOnce(workspace, `full-page-${index}`, { topicId, type: "FINDING", content: "b".repeat(220) });
  } finally { board.close(); }
  const history = await launch(f, { operation: "drain", key: "prior-loops", invocation,
    intentions: f.request.intentions.filter((intention: any) => intention.operation === "ledger") });
  expect(history.exit, history.stdout + history.stderr).toBe(0);
  f.request.intentions = f.request.intentions.filter((intention: any) => intention.operation !== "ledger");
  const requests = Array.from({ length: 1000 }, (_, index) => ({ v: 1, invocation,
    requestId: "r".repeat(250) + index, taskId: `task${index}`, kind: "cancel", origin: "main", at: 1 }));
  // A valid identifier can exceed the text-preview budget when JSON-escaped.
  requests[0]!.requestId = "\\".repeat(256);
  const sourceStore = new PitakoStore(f.root, () => null);
  await sourceStore.withSession(() => {
    for (const body of requests) {
      const digest = canonicalDigest(body);
      sourceStore.commit(`todo:${invocation}`, undefined, digest, digest, () => ({kind: "request", body}));
    }
  });
  const request = operation === "close" ? f.request : {
    operation, key: operation, invocation, intentions: [], requests: { cursor: 0 },
    apply: { specId: "example", dbPath: f.dbPath, key: "select", invocation, loop: 1, authority,
      expectedDigest: readBacklog(f.root, "example").digest,
      director: { select: "one", changes: [], reason: "Select task" } },
  };
  request.admission = { association: { root: f.root, invocation, maxCycles: 30 },
    admissionBinding: "a".repeat(64), amendments: [], models: { taskReviewer: "test/reviewer" } };
  if (operation === "selection") request.plan = { ref: { key: "director", runId: "native-director" },
    stage: "published" };
  else {
    request.taskFrame = { taskId: "one", identities: ["attempt-one"],
      workerKnowledge: { "attempt-one": { work: "Exact retained knowledge ".repeat(500) } } };
    const next = { ...f.intent, key: "worker.a2", attempt: 2 };
    request.nextBaseline = { sealed: next, observed: next };
  }
  const output = await launch(f, request);
  expect(output.exit, output.stdout + output.stderr).toBe(0);
  expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(61440);
  const transport = JSON.parse(output.stdout), P = transport.P.preview;
  expect(Buffer.byteLength(JSON.stringify(P))).toBeLessThanOrEqual(8192);
  expect(transport.storeId).toBe(new PitakoStore(f.root).read(scope).identity.storeId);
  expect(transport.P.prompt.selectedTask).toEqual(readBacklog(f.root, "example").backlog!.tasks.find(task => task.id === "one"));
  expect(transport.P.control.selectedTask).toMatchObject({ id: "one", gates: transport.P.prompt.selectedTask.gates });
  expect(transport.projection.steps[0].result).not.toHaveProperty("P");
  expect(receipt(output.stdout).steps[0].result).not.toHaveProperty("P");
  const requestStep = operation === "close" ? "nextRequests" : "requests";
  const page = transport.projection.steps.find((step: any) => step.operation === requestStep).result;
  const retainedPage = receipt(output.stdout).steps.find((step: any) => step.operation === requestStep).result;
  expect(Buffer.byteLength(JSON.stringify(retainedPage.requests))).toBeGreaterThan(47 * 1024);
  expect(page.requests.length).toBeGreaterThan(0);
  if (operation === "close") {
    expect(page.requests.length).toBeLessThan(retainedPage.requests.length);
    expect(page.observed).toEqual({ count: retainedPage.requests.length, next: retainedPage.next,
      taskId: "one", requested: false });
    expect(transport.projection.steps.find((step: any) => step.operation === "requests").result.count)
      .toBe(page.observed.count);
    expect(transport.projection.steps.find((step: any) => step.operation === "nextBaseline").result.captured).toBe(false);
  }
  expect(page.requests).toEqual(requests.slice(0, page.next));
  const observation = await runtime.nativeCheckpointCase({ ...runtime.nativeCheckpointInput(),
    sdk: false, root: f.root, page, invocation }, `async ({page,invocation}) => {
      const {observeRequests}=await import(${JSON.stringify(pathToFileURL(path.resolve("skills/execute/observe.mjs")).href)});
      const requests=[...page.requests];
      while(page.next!==null) {
        page=observeRequests({invocation,cursor:page.next});
        requests.push(...page.requests);
      }
      return requests;
    }`);
  expect(observation?.[0], observation?.[2]).toBe(0);
  expect(JSON.parse(observation![1])).toEqual(requests);
  const replay = await launch(f, request);
  expect(replay.exit, replay.stdout + replay.stderr).toBe(0);
  expect(replay.stdout).toBe(output.stdout);
  const rows = stored(f.root);
  expect(transport.P).toEqual(new PitakoStore(f.root, executeProjection).read(scope, transport.head).P);
  const control = transport.P.control;
  const admissionRow = rows.find(row => row.seq === control.admission.seq)!;
  expect(admissionRow.digest).toBe(control.admission.digest);
  expect(admissionRow.body).toEqual(request.admission);
  const inputRow = rows.find(row => row.seq === control.operation.input.seq)!;
  expect(inputRow.digest).toBe(control.operation.input.digest);
  expect(inputRow.body).toMatchObject({ operation, request: {
    ...(operation === "selection" ? { plan: request.plan } : { taskFrame: request.taskFrame }),
  } });
  expect(control.operation).toMatchObject({ operation, key: request.key });
  expect(operation === "selection" ? control.plan : control.taskFrame).toEqual(control.operation.input);
  // Bodies stay in the store, not duplicated alongside the 48 KiB request page.
  expect(JSON.stringify(control)).not.toContain("Exact retained knowledge");
  const beforeEffect = new PitakoStore<ReturnType<typeof executeProjection>>(f.root, executeProjection).read(scope,
    { seq: inputRow.seq, hash: inputRow.digest });
  expect(beforeEffect.P.control.operation).toEqual(control.operation);
  expect(P.admittedTasks.items[0]).toMatchObject({ id: "one" });
  expect(P.admittedTasks.items[0].goal.length).toBeLessThan(transport.P.prompt.selectedTask.goal.length);
  expect(P.admittedTasks.items[1]).toMatchObject({ id: "task2", status: "pending" });
  expect(P.view.items).toEqual(expect.arrayContaining([
    expect.objectContaining(operation === "close"
      ? { type: "HANDOFF", content: "Grouped handoff" }
      : { type: "FINDING", content: expect.stringMatching(/^b+/) }),
  ]));
  expect(P.pendingDemand.requests.items.length).toBeGreaterThan(0);
  expect(P.pendingDemand.requests.items).toEqual(page.requests.slice(0, P.pendingDemand.requests.items.length));
  expect(P.pendingDemand.requests.total).toBe(retainedPage.requests.length);
  expect(P.pendingDemand.requests.omitted).toBeGreaterThan(0);
  for (const ref of [P.pendingDemand.requests.ref, P.admittedTasks.ref, P.view.ref]) {
    expect(ref.scope).toBe(scope);
    expect(ref.seq).toBeLessThanOrEqual(transport.head.seq);
    expect(rows.find(row => row.seq === ref.seq)?.digest).toBe(ref.digest);
  }
  const demand = rows.find(row => row.seq === P.pendingDemand.requests.ref.seq)!;
  expect((demand.body as any).result.requests).toEqual(retainedPage.requests);
  if (operation === "close") {
    expect(P.loopSummaries.map((summary: any) => summary.loop)).toEqual([1, 2, 3]);
    expect(P.loopSummaries[0]).toMatchObject({ loop: 1, status: "gaps" });
    expect(P.loopSummaries[0].gaps).toContain("work");
    expect(P.planRejections[0].diagnostic).toContain("ddd");
    expect(P.pendingDemand.sources[0].review).toContain("verdict");
    expect(P.criterionStatuses.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ criterion: 1, status: "passed" }),
    ]));
    const source = readFileSync(path.resolve("skills/execute/workflow.js"), "utf8");
    const decideRevival = new Function("const text = value => typeof value === 'string' && value.trim().length > 0;\n" +
      source.slice(source.indexOf("function same("), source.indexOf("function continuationIdentity(")) + "\nreturn decideRevival;")();
    const previous = transport.P.control.lastAttempt;
    const cfg = { taskId: "one", loop: 1, candidate: previous.gate.receipt.after };
    expect(previous.gate.receipt.contextPeak).toBe(12000);
    expect(decideRevival(previous, cfg, previous.gate.receipt.contextPeak)).toEqual({ decision: "resume", code: "eligible" });
    expect(decideRevival({ ...previous, gate: { receipt: { ...previous.gate.receipt,
      progress: { nonImproving: 1 } } } }, cfg, previous.gate.receipt.contextPeak)).toEqual({
      decision: "fresh", code: "revived-no-improvement",
    });
  }
  const replayRequest = storedOperation(f.root, operation, request.key);
  expect(Buffer.byteLength(JSON.stringify(replayRequest))).toBeLessThan(1024);
  expect((await launch(f, replayRequest)).stdout).toBe(output.stdout);
  const { key: _key, ...referencedReplay } = replayRequest;
  expect((await launch(f, referencedReplay)).stdout).toBe(output.stdout);
  const rowsBefore = stored(f.root);
  for (const invalid of [
    { ...replayRequest, storeId: "replaced-store" },
    { ...replayRequest, scope: `exec:another.e0` },
    { ...replayRequest, key: "another.r1" },
    { ...replayRequest, expectedHead: { seq: admissionRow.seq, hash: admissionRow.digest } },
    { ...replayRequest, refs: { input: { ...replayRequest.refs.input, digest: "0".repeat(64) } } },
    { ...replayRequest, intentions: [] },
  ]) {
    const rejected = await launch(f, invalid);
    expect(rejected.exit, rejected.stdout + rejected.stderr).toBe(1);
    expect(JSON.parse(rejected.stdout).reason).toContain("loop-io stored operation");
    expect(stored(f.root)).toEqual(rowsBefore);
  }
});

test("a later launch verifies referenced receipt bytes before any effects", async () => {
  const f = await groupedFixture("advance"), first = await launch(f);
  expect(first.exit, first.stdout + first.stderr).toBe(0);
  const { path: file, digest } = JSON.parse(first.stdout);
  const next = await launch(f, { ...f.request, key: "next-advance", intentions: [],
    receipts: [{ path: file, digest: digest.replace(/^./, (point: string) => point === "0" ? "1" : "0") }] });
  expect(next.exit).toBe(1);
  expect(JSON.parse(next.stdout).reason).toContain("receipt digest mismatch");
});

test("advance replay rejects changed prepared backlog evidence", async () => {
  const f = await groupedFixture("advance");
  const interrupted = await launch(f, f.request, { phase: "afterStep", key: "advance.prepare" });
  expect(interrupted.exit).toBe(1);
  const current = readBacklog(f.root, "example");
  current.backlog!.acceptance[0]!.command = "false";
  writeFileSync(current.path, JSON.stringify(current.backlog));
  const resumed = await launch(f, { ...f.request, key: "advance.r1" });
  expect(resumed.exit).toBe(1);
  expect(JSON.parse(resumed.stdout).reason).toMatch(/backlog-conflict|integrity/);
});

test("oversize admission projections fail closed with a bounded JSON error, never truncation", async () => {
  const f = await groupedFixture("advance");
  const current = readBacklog(f.root, "example");
  current.backlog!.tasks[0]!.status = "obsolete";
  current.backlog!.acceptance[0]!.command = "x".repeat(70 * 1024);
  current.backlog!.lastApplied = null;
  writeFileSync(current.path, JSON.stringify(current.backlog));
  const request = { operation: "selection", key: "oversize", invocation, intentions: [], requests: { cursor: 0 },
    apply: { specId: "example", dbPath: f.dbPath, key: "oversize-apply", invocation, loop: 1, authority,
      expectedDigest: readBacklog(f.root, "example").digest,
      director: { select: null, changes: [], reason: "No pending tasks" } } };
  const output = await launch(f, request);
  expect(output.exit).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({ error: "loop-io", reason: "loop-io admission projection exceeds 61440 bytes" });
  expect(Buffer.byteLength(output.stdout)).toBeLessThan(1024);
});

test("a finished long backlog crosses the final-phase selection as a bounded projection", async () => {
  const f = await groupedFixture("advance");
  const current = readBacklog(f.root, "example");
  const { title: _title, ...template } = current.backlog!.tasks[0]!;
  current.backlog!.tasks = Array.from({ length: 30 }, (_, index) => ({ ...structuredClone(template), id: `done-${index}`,
    ...(index % 2 ? { title: `Done task ${index}` } : {}), status: "done" as const, goal: `Goal ${index} ${"g".repeat(4096)}`,
    history: Array.from({ length: 8 }, (_, entry) => ({ invocation, loop: 1, event: "update",
      reason: `Reason ${index}.${entry} ${"r".repeat(2048)}` })) }));
  current.backlog!.lastApplied = null;
  writeFileSync(current.path, JSON.stringify(current.backlog));
  const request = { operation: "selection", key: "finished", invocation, intentions: [], requests: { cursor: 0 },
    apply: { specId: "example", dbPath: f.dbPath, key: "finished-apply", invocation, loop: 1, authority,
      expectedDigest: readBacklog(f.root, "example").digest,
      director: { select: null, changes: [], reason: "No pending tasks" } } };
  const output = await launch(f, request);
  expect(output.exit, output.stdout + output.stderr).toBe(0);
  expect(Buffer.byteLength(output.stdout)).toBeLessThan(61440);
  const applied = receipt(output.stdout).steps.find((step: any) => step.operation === "apply").result;
  const projected = JSON.parse(output.stdout).projection.steps.find((step: any) => step.operation === "apply").result;
  for (const field of ["acceptance", "acceptanceHistory", "view"])
    expect(projected[field]).toEqual(applied[field]);
  expect(applied.selected).toBeNull();
  const { tasks, omitted } = applied.completedTasks;
  expect(tasks.length).toBeGreaterThan(0);
  expect(tasks.length + omitted).toBe(30);
  expect(Buffer.byteLength(JSON.stringify(applied.completedTasks))).toBeLessThanOrEqual(16384);
  expect(tasks.map((task: any) => task.id)).toEqual(Array.from({ length: tasks.length }, (_, index) => `done-${index}`));
  expect(tasks[0]).toMatchObject({ id: "done-0", status: "done", summary: expect.stringMatching(/^Goal 0 g+…$/),
    reason: expect.stringMatching(/^Reason 0\.7 r+…$/) });
  expect(tasks[1]).toMatchObject({ id: "done-1", summary: "Done task 1" });
  // Complete goals and histories stay on disk.
  const kept = readBacklog(f.root, "example").backlog!.tasks[0]!;
  expect(kept.goal).toHaveLength("Goal 0 ".length + 4096);
  expect(kept.history).toHaveLength(8);
});

test.each(["request", "gate-marker", "candidate", "seal", "worker-original", "worker-native"])("close rejects changed %s on replay without rerunning gates", async damage => {
  const f = await groupedFixture("close"), first = await launch(f);
  expect(first.exit, first.stdout + first.stderr).toBe(0);
  if (damage === "request") f.request.gate.workerStatus = "continue";
  if (damage === "gate-marker") corruptRecord(f.root, markerKey("close.gate"));
  if (damage === "candidate") writeFileSync(path.join(f.root, "product"), "foreign");
  if (damage === "seal") writeFileSync(path.join(checkpointDirectory(f.intent), "unit.json"), "{}");
  const nativeDirectory = path.join(f.root, ".pi/native-originals", f.request.gate.worker.runId);
  if (damage === "worker-original") writeFileSync(path.join(nativeDirectory, `${f.intent.key}.json`), "{}");
  if (damage === "worker-native") {
    const file = path.join(nativeDirectory, "status.json"), status = JSON.parse(readFileSync(file, "utf8"));
    status.steps[0].interrupted = true;
    writeFileSync(file, JSON.stringify(status));
  }
  const replay = await launch(f, { ...f.request, key: "close.r1" });
  expect(replay.exit).toBe(1);
  expect(JSON.parse(replay.stdout).error).toBe("loop-io");
  expect(readFileSync(path.join(f.root, ".pi/gate-count"), "utf8")).toBe("run");
});

test("close verifies the native worker digest before gate or Board effects", async () => {
  const f = await groupedFixture("close");
  const original = path.join(f.root, ".pi/native-originals", f.request.gate.worker.runId, `${f.intent.key}.json`);
  writeFileSync(original, JSON.stringify({ status: "complete", knowledge: { findings: ["Unverified finding"] } }));
  const output = await launch(f);
  expect(output.exit).toBe(1);
  expect(JSON.parse(output.stdout).reason).toBe("Worker native original digest mismatch");
  expect(existsSync(path.join(f.root, ".pi/gate-count"))).toBe(false);
  const board = await openBoard(f.dbPath);
  try {
    const workspace = repositoryIdentity(f.root), topic = board.findTopicOwnedByPlan(workspace, topicOwner(f.root, "example"))!;
    expect(board.readTopic(workspace, topic).posts.map(post => post.content)).toEqual(["Existing gate finding"]);
  } finally { board.close(); }
});

for (const phase of ["afterEffect", "afterStep"]) {
  for (const key of ["unit-one", "cancel-one", "gaps-one"]) {
    test(`resumes after ${key} ${phase}, with no duplicate effects and identical final state`, async () => {
      const f = await fixture();
      const failed = await launch(f, f.request, { key, phase });
      expect(failed.exit).toBe(1);
      expect(failed.stderr).toContain("injected interruption");
      const interruptedBacklog = readBacklog(f.root, "example").backlog!;
      expect(interruptedBacklog.tasks[0]!.status).toBe(key === "unit-one" ? "pending" : "obsolete");
      expect(stored(f.root).filter(row => row.kind === "ledger").flatMap(row => (row.body as any).entries))
        .toHaveLength(key === "gaps-one" ? 3 : 2);
      const resumed = await launch(f, { ...f.request, key: "finish.r1" });
      expect(resumed.exit, resumed.stderr).toBe(0);
      const state = await finalState(f, resumed.stdout);
      const replay = await launch(f, f.request, { key, phase: "afterEffect" });
      expect(replay.exit, replay.stderr).toBe(0);
      expect(replay.stdout).toBe(resumed.stdout);
      expect(await finalState(f, replay.stdout)).toEqual(state);
      // The same persisted inputs in an uninterrupted workspace produce identical domain state.
      const clean = await fixture(), cleanRun = await launch(clean);
      expect(cleanRun.exit, cleanRun.stderr).toBe(0);
      expect(await finalState(clean, cleanRun.stdout)).toEqual(state);
    });
  }
}

test.each(["afterEffect", "afterStep"])("settlement apply resumes %s with unchanged progress and no duplicate history", async phase => {
  const f = await fixture(), request: any = structuredClone(f.request);
  const input = request.intentions[1].input;
  delete input.cancellations;
  input.settle = true;
  input.progress = { taskId: "one", progress: { nonImproving: 3, last5: [], stalls: 0 }, remaining: "Needs repair" };
  const failed = await launch(f, request, { key: "cancel-one", phase });
  expect(failed.exit).toBe(1);
  expect(failed.stderr).toContain("injected interruption");
  const resumed = await launch(f, { ...request, key: "finish.r2" });
  expect(resumed.exit, resumed.stderr).toBe(0);
  const state = readBacklog(f.root, "example");
  expect(state.backlog!.tasks[0]!.progress).toEqual({ nonImproving: 3, last5: [], stalls: 1 });
  expect(state.backlog!.tasks[0]!.history.filter(event => event.event === "stall")).toHaveLength(1);
  const replay = await launch(f, request, { key: "cancel-one", phase: "afterEffect" });
  expect(replay.exit, replay.stderr).toBe(0);
  expect(replay.stdout).toBe(resumed.stdout);
  expect(readBacklog(f.root, "example")).toEqual(state);
  expect(receipt(resumed.stdout).steps[1].result).not.toHaveProperty("view");
});

test("verifies superseded apply markers when the following apply published before interruption", async () => {
  const f = await fixture(), request: any = structuredClone(f.request);
  const cancellation = request.intentions[1];
  const settlement = { ...cancellation, key: "settle-one", input: { ...cancellation.input, key: "settle-one",
    settle: true, progress: { taskId: "one", progress: { nonImproving: 1, last5: [] }, remaining: "More work" } } };
  delete settlement.input.cancellations;
  // A publication-before-marker crash already happened for this first apply.
  const published = apply({ ...settlement.input, root: f.root });
  cancellation.input.expectedDigest = published.digest;
  request.intentions.splice(1, 0, settlement);
  const interrupted = await launch(f, request, { key: "cancel-one", phase: "afterEffect" });
  expect(interrupted.exit).toBe(1);
  expect(interrupted.stderr).toContain("injected interruption");
  const state = readBacklog(f.root, "example");
  const resumed = await launch(f, { ...request, key: "finish.r1" });
  expect(resumed.exit, resumed.stderr).toBe(0);
  const replay = await launch(f, request, { key: "settle-one", phase: "afterEffect" });
  expect(replay.exit, replay.stderr).toBe(0);
  expect(replay.stdout).toBe(resumed.stdout);
  expect(readBacklog(f.root, "example")).toEqual(state);
  expect(receipt(resumed.stdout).steps.map((step: any) => step.key)).toEqual(["unit-one", "settle-one", "cancel-one", "gaps-one"]);
});

test("a damaged ledger chain reaches the CLI boundary with a quarantined recovery identity", async () => {
  const f = await fixture(), first = await launch(f);
  expect(first.exit, first.stderr).toBe(0);
  corruptRecord(f.root, "ledger:0");
  const child = Bun.spawn(["node", entry], { cwd: f.root, env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(f.request)); child.stdin.end();
  const replay = (await composition.checkpointLifecycle(child,
    ([exit, stdout, stderr]) => ({ exit, stdout, stderr })).result)!;
  expect(replay.exit).toBe(1);
  const failure = JSON.parse(replay.stdout.trim().split("\n").at(-1)!);
  expect(failure).toMatchObject({ error: "loop-io", code: "store-corrupt", ledgerIntegrity: true });
  expect(failure.recovery.root).toBe(f.root);
  expect(existsSync(failure.recovery.quarantine)).toBe(true);
  const recovered = new PitakoStore(f.root).read(scope);
  expect(recovered.identity).toEqual({ root: f.root, storeId: failure.recovery.storeId });
  expect(recovered.records).toEqual([]);
  expect(failure.reason).toMatch(/ledger|record/i);
});

test.each(["request", "marker", "ledger", "backlog"])("rejects changed %s instead of redispatching", async damage => {
    const f = await fixture(), first = await launch(f);
    expect(first.exit, first.stderr).toBe(0);
    const request = structuredClone(f.request);
    if (damage === "request") request.intentions[0]!.input.record!.body = { taskId: "other", attempt: 1 } as any;
    if (damage === "marker") corruptRecord(f.root, markerKey("unit-one"));
    if (damage === "ledger") corruptRecord(f.root, "ledger:0");
    if (damage === "backlog") {
      const current = readBacklog(f.root, "example");
      current.backlog!.tasks[0]!.remaining = "outside change";
      writeFileSync(current.path, JSON.stringify(current.backlog));
    }
    const replay = await launch(f, request);
    expect(replay.exit, replay.stderr).toBe(1);
    expect(JSON.parse(replay.stdout).error).toBe("loop-io");
});
