import { beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { apply, prepare, readBacklog, topicOwner, type Task } from "../skills/execute/loop.ts";
import { openBoard } from "../extensions/board/store.ts";
import { repositoryIdentity } from "../extensions/board/workspace.ts";
import { canonicalDigest, canonicalJSON, sha256 } from "../extensions/canonical.mjs";
import { applyCheckpoint, beginHookEffect, captureCheckpoint, checkpointDirectory, recordContextPeak, restoreCheckpoint, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { compositionFixture, nativeCheckpointFixture } from "./fixtures/plan-execute-composition.ts";

const entry = path.resolve("skills/execute/loop-io.mjs");
const { verifyLedger } = await import(path.resolve("skills/execute/ledger.mjs"));
const composition = compositionFixture();
const { roots } = composition;
const runtime = nativeCheckpointFixture(composition);
beforeAll(() => runtime.startNativeCheckpoint());
const invocation = "drain-fixture";
const authority = { specDigest: "a".repeat(64), amendmentDigests: [] };

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-drain-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe",
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  writeFileSync(path.join(root, "product"), "original");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial");
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

async function launch(f: Awaited<ReturnType<typeof fixture>>, request: any = f.request, interruption?: { key: string; phase: string }) {
  // Reuse the file-owned loader, not operation state: every replay re-reads disk.
  // The fixture joins cancelled cases and the child before releasing owned roots.
  const result = await runtime.nativeCheckpointCase({ ...runtime.nativeCheckpointInput(),
    root: f.root, request, interruption }, `async ({request,interruption}) => {
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
  const bytes = readFileSync(reference.path, "utf8");
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
  expect(readdirSync(path.join(f.root, ".pi/subagents/execute", invocation)).filter(name => name.endsWith(".json"))).toHaveLength(3);
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

test("drains in persisted order and returns an immutable receipt by reference, including empty finish drains", async () => {
  const f = await fixture();
  // Keep the external CLI boundary once; the interruption matrix owns disk replay.
  const child = Bun.spawn(["node", entry], { cwd: f.root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(f.request)); child.stdin.end();
  const first = (await composition.checkpointLifecycle(child,
    ([exit, stdout, stderr]) => ({ exit, stdout, stderr })).result)!;
  expect(first.exit, first.stderr).toBe(0);
  const state = await finalState(f, first.stdout);
  const replay = await launch(f);
  expect(replay.exit, replay.stderr).toBe(0);
  expect(replay.stdout).toBe(first.stdout);
  expect(await finalState(f, replay.stdout)).toEqual(state);
  const empty = await launch(f, { ...f.request, key: "empty-finish", intentions: [] });
  expect(empty.exit, empty.stderr).toBe(0);
  expect(receipt(empty.stdout)).toEqual({ invocation, steps: [] });
});

async function groupedFixture(operation: "advance" | "close") {
  const f = await fixture();
  const intent: CheckpointIntent = { version: 2, association: { root: f.root,
    commonDir: path.join(f.root, ".git"), missionId: "mission", missionPath: path.join(f.root, "mission.json"),
    invocation, source: path.join(f.root, "spec.md"), digest: authority.specDigest, maxCycles: 15, sourceRefs: [] },
    key: "worker.a1", taskId: "one", attempt: 1, loop: 1, cursor: 0, phase: "implementation", planRef: {},
    progress: { consumedLoops: 1, admitted: {}, previous: null } };
  captureCheckpoint(intent, ["product"]);
  recordContextPeak(intent, 12000);
  applyCheckpoint(intent, [{ path: "product", image: { bytes: Buffer.from("completed").toString("base64"), mode: 0o644 } }]);
  const request: any = { ...f.request, operation, key: operation, requests: { cursor: 0 } };
  request.prepare = { specId: "example", dbPath: f.dbPath, previousConfirmedUnit: null, loop: 1 };
  request.gate = { specId: "example", dbPath: f.dbPath, key: "worker.a1.gate", loop: 1, attempt: 1,
    task: { id: "one", gates: [{ id: "focused", command: "printf run >> .pi/gate-count", cwd: ".", timeoutMs: 1000 }],
      metric: null, progress: { nonImproving: 0, last5: [] } },
    workerStatus: "complete", writerSettled: true, checkpoint: intent,
    knowledge: { findings: ["Grouped finding"], handoff: "Grouped handoff" } };
  request.seal = { unit: { v: 1, intent }, pause: { v: 1, intent } };
  const directory = path.join(f.root, ".pi/subagents/execute", invocation);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "requests.jsonl"), JSON.stringify({ v: 1, invocation,
    requestId: "request-1", taskId: "one", kind: "cancel", origin: "main", at: 1 }) + "\n");
  return { ...f, request, intent };
}

async function groupedState(f: Awaited<ReturnType<typeof groupedFixture>>, output: string) {
  const result = receipt(output);
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
    expect(prepared.viewDigest).toBe(canonicalDigest(prepared.view));
    expect(prepared.viewBytes).toBe(Buffer.byteLength(canonicalJSON(prepared.view)));
    return { state, operations: result.steps.map((step: any) => step.operation) };
  }
  const gate = result.steps[2].result, seal = result.steps[3].result;
  expect(gate.receipt).not.toHaveProperty("contextPeak");
  expect(result.contextPeak).toBe(12000);
  expect(seal).toMatchObject({ kind: "unit", workerStatus: "complete", mutated: false, receipt: { outcome: "sealed", kind: "unit" } });
  expect(sha256(readFileSync(seal.gate.path))).toBe(seal.gate.digest);
  expect(readFileSync(path.join(f.root, ".pi/gate-count"), "utf8")).toBe("run");
  expect(readdirSync(checkpointDirectory(f.intent)).filter(name => ["unit.json", "pause.json"].includes(name))).toEqual(["unit.json"]);
  return { state, seal: { kind: seal.kind, outcome: seal.receipt.outcome }, content: readFileSync(path.join(f.root, "product"), "utf8") };
}

for (const operation of ["advance", "close"] as const) {
  const names = operation === "advance" ? ["drain", "prepare", "requests"] : ["drain", "requests", "gate", "seal"];
  for (const phase of ["afterEffect", "afterStep"]) for (const name of names) {
    test(`${operation} resumes ${phase} ${name} without duplicate effects`, async () => {
      const f = await groupedFixture(operation);
      const interrupted = await launch(f, f.request, { phase, key: `${operation}.${name}` });
      expect(interrupted.exit, interrupted.stderr).toBe(1);
      expect(interrupted.stderr).toContain("injected interruption");
      const resumed = await launch(f, { ...f.request, key: `${operation}.r1` });
      expect(resumed.exit, resumed.stdout + resumed.stderr).toBe(0);
      const state = await groupedState(f, resumed.stdout);
      const replay = await launch(f, f.request, { phase: "afterEffect", key: `${operation}.${name}` });
      expect(replay.exit, replay.stderr).toBe(0);
      expect(replay.stdout).toBe(resumed.stdout);
      expect(await groupedState(f, replay.stdout)).toEqual(state);
      const clean = await groupedFixture(operation), completed = await launch(clean);
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
    const f = await groupedFixture("close");
    writeFileSync(path.join(f.root, ".pi/subagents/execute", invocation, "requests.jsonl"), "");
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
  });
}

test.each(["sealed", "observed", "unit", "mismatch", "open", "blocked", "cancelled"])(
  "next baseline selects only the workflow-prepared progress for %s evidence", async outcome => {
    const f = await groupedFixture("close");
    writeFileSync(path.join(f.root, ".pi/subagents/execute", invocation, "requests.jsonl"), "");
    if (outcome === "cancelled") {
      const late = { v: 1, invocation, requestId: "late", taskId: "one", kind: "cancel", origin: "main", at: 2 };
      f.request.gate.task.gates[0].command = `printf '%s\\n' '${JSON.stringify(late)}' >> .pi/subagents/execute/${invocation}/requests.jsonl`;
    }
    f.request.gate.workerStatus = outcome === "unit" ? "complete" : outcome === "blocked" ? "blocked" : "continue";
    const next = { ...f.intent, key: "worker.a2", attempt: 2,
      progress: { consumedLoops: 1, admitted: { one: ["continue"] }, previous: null } };
    const previous = { taskId: "previous", attempt: 1, resultRef: { key: "previous" },
      checkpointRef: path.join(f.root, ".pi/subagents/checkpoints/previous/unit.json"), digest: "b".repeat(64) };
    f.request.nextBaseline = { sealed: next, observed: { ...next, progress: { ...next.progress, previous } } };
    if (outcome === "observed") rmSync(path.join(checkpointDirectory(f.intent), "manifest.json"));
    if (outcome === "mismatch") writeFileSync(path.join(f.root, "product"), "unjournaled");
    if (outcome === "open") beginHookEffect(f.intent, "edit", ["product"]);
    const output = await launch(f);
    expect(output.exit, output.stdout + output.stderr).toBe(0);
    const result = receipt(output.stdout), baseline = result.steps.at(-1).result;
    if (outcome === "cancelled") {
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
  const f = await groupedFixture("close");
  const file = `.pi/subagents/execute/${invocation}/requests.jsonl`;
  f.request.gate.workerStatus = "continue";
  f.request.gate.task.gates[0].command = damage === "truncate" ? `: > ${file}`
    : `printf '%s\\n' '${JSON.stringify({ v: 1, invocation, requestId: "replacement", taskId: "one", kind: "cancel", origin: "main", at: 2 })}' > ${file}`;
  const next = { ...f.intent, key: "worker.a2", attempt: 2 };
  f.request.nextBaseline = { sealed: next, observed: next };
  const output = await launch(f);
  expect(output.exit).toBe(1);
  expect(JSON.parse(output.stdout).reason).toContain("request snapshot integrity conflict");
  expect(existsSync(path.join(checkpointDirectory(next), "baseline.json"))).toBe(false);
});

test.each(["worker", "failed", "missing", "mutated"])("close selects pause for %s evidence", async difference => {
  const f = await groupedFixture("close");
  if (difference === "worker") f.request.gate.workerStatus = "continue";
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

test("a later launch verifies referenced receipt bytes before any effects", async () => {
  const f = await groupedFixture("advance"), first = await launch(f);
  expect(first.exit, first.stdout + first.stderr).toBe(0);
  const { path: file, digest } = JSON.parse(first.stdout);
  writeFileSync(file, readFileSync(file, "utf8") + "\n");
  const next = await launch(f, { ...f.request, key: "next-advance", intentions: [], receipts: [{ path: file, digest }] });
  expect(next.exit).toBe(1);
  expect(JSON.parse(next.stdout).reason).toContain("receipt digest mismatch");
});

test("oversize admission projections fail closed with a bounded JSON error, never truncation", async () => {
  const f = await groupedFixture("advance");
  const current = readBacklog(f.root, "example");
  current.backlog!.tasks[0]!.status = "obsolete";
  current.backlog!.tasks[0]!.goal = "x".repeat(70 * 1024);
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

test.each(["request", "gate-marker", "candidate", "seal"])("close rejects changed %s on replay without rerunning gates", async damage => {
  const f = await groupedFixture("close"), first = await launch(f);
  expect(first.exit, first.stdout + first.stderr).toBe(0);
  if (damage === "request") f.request.gate.workerStatus = "continue";
  if (damage === "gate-marker") writeFileSync(path.join(f.root, ".pi/subagents/execute", invocation,
    "loop-io/steps", sha256("close.gate"), "000000.json"), "{}");
  if (damage === "candidate") writeFileSync(path.join(f.root, "product"), "foreign");
  if (damage === "seal") writeFileSync(path.join(checkpointDirectory(f.intent), "unit.json"), "{}");
  const replay = await launch(f, { ...f.request, key: "close.r1" });
  expect(replay.exit).toBe(1);
  expect(JSON.parse(replay.stdout).error).toBe("loop-io");
  expect(readFileSync(path.join(f.root, ".pi/gate-count"), "utf8")).toBe("run");
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
      const interruptedDirectory = path.join(f.root, ".pi/subagents/execute", invocation);
      expect(readdirSync(interruptedDirectory).filter(name => name.endsWith(".json"))).toHaveLength(key === "gaps-one" ? 3 : 2);
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

test("a damaged ledger chain reaches the CLI boundary as a human-only ledger integrity failure", async () => {
  const f = await fixture(), first = await launch(f);
  expect(first.exit, first.stderr).toBe(0);
  writeFileSync(path.join(f.root, ".pi/subagents/execute", invocation, "000001.json"), "{}");
  const child = Bun.spawn(["node", entry], { cwd: f.root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(f.request)); child.stdin.end();
  const replay = (await composition.checkpointLifecycle(child,
    ([exit, stdout, stderr]) => ({ exit, stdout, stderr })).result)!;
  expect(replay.exit).toBe(1);
  const failure = JSON.parse(replay.stdout.trim().split("\n").at(-1)!);
  expect(failure).toMatchObject({ error: "loop-io", ledgerIntegrity: true });
  expect(failure.reason).toMatch(/ledger/i);
});

test.each(["request", "marker", "ledger", "backlog"])("rejects changed %s instead of redispatching", async damage => {
    const f = await fixture(), first = await launch(f);
    expect(first.exit, first.stderr).toBe(0);
    const request = structuredClone(f.request);
    if (damage === "request") request.intentions[0]!.input.record!.body = { taskId: "other", attempt: 1 } as any;
    if (damage === "marker") writeFileSync(path.join(f.root, ".pi/subagents/execute", invocation,
      "loop-io/steps", sha256("unit-one"), "000000.json"), "{}");
    if (damage === "ledger") writeFileSync(path.join(f.root, ".pi/subagents/execute", invocation, "000001.json"), "{}");
    if (damage === "backlog") {
      const current = readBacklog(f.root, "example");
      current.backlog!.tasks[0]!.remaining = "outside change";
      writeFileSync(current.path, JSON.stringify(current.backlog));
    }
    const replay = await launch(f, request);
    expect(replay.exit, replay.stderr).toBe(1);
    expect(JSON.parse(replay.stdout).error).toBe("loop-io");
});
