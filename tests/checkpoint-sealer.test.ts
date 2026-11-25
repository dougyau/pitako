import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkoutEvidence, checkoutSnapshot } from "../extensions/spec-plans.ts";
import planExecute from "../extensions/plan-execute.ts";
import { copy, cutAt, executeControllerFixture, nativeRunId, type Result } from "./fixtures/execute-workflow.ts";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";
import { captureBaseline, beginHookEffect, closeHookEffect, applyCheckpoint, captureCheckpoint, checkpointDirectory, prepareCheckpoint, restoreCheckpoint, sealCheckpoint, sealCheckpointRequest, observeTaskReviewSeal, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { buildExternalCliPrompt } from "../node_modules/pi-subagents/src/runs/shared/external-cli-runner.js";
import { gitFakeFixture } from "./fixtures/git-fake-fixture.ts";
import { readExecuteIntentContext, verifyExecuteSealerIntents } from "../extensions/execute-intent.ts";
import { readExecuteAdmission } from "../extensions/execute-progress.ts";
import { PitakoStore } from "../extensions/pitako-store.ts";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { executionStatePath } from "../extensions/execute-state.ts";
import type { ExecuteCursor } from "../extensions/execute-cursor.ts";
import { processBudget, expectProcessBudget } from "./fixtures/process-budget.ts";
import { gitFakeBootstrap } from "./fixtures/git-fake-env.ts";
import { openSqliteSync } from "../extensions/board/sqlite.ts";
const sealerPrompt = "Fixed checkpoint sealer; stdin is a JSON {v, intent, kind, restoreSources?} request.";

const roots: string[] = [];
const processDisposers: (() => void)[] = [];
afterEach(() => {
  const errors: unknown[] = [];
  for (const dispose of processDisposers.splice(0).reverse()) {
    try { dispose(); } catch (error) { errors.push(error); }
  }
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Sealer fixture cleanup failed");
});
const script = path.resolve("skills/execute/checkpoint.mjs");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(paths = ["owned"]) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-sealer-")); roots.push(root);
  const budget = processBudget();
  const fake = gitFakeFixture();
  processDisposers.push(fake.dispose);
  fake.fakeRepo(root, { paths: [...new Set([...paths, "owned", "foreign", "deleted", ".gitignore", "other", "new", "late", "unrelated"])], ignored: ["build"] });
  writeFileSync(path.join(root, "owned"), "before");
  const intent: CheckpointIntent = { version: 2, association: { root, commonDir: path.join(root, ".git"), missionId: "mission", missionPath: path.join(root, "mission.json"), invocation: "test", source: path.join(root, "spec.md"), digest: "a".repeat(64), maxCycles: 3, sourceRefs: [] }, key: "test.a1", taskId: "task", attempt: 1, loop: 1, cursor: 0, phase: "implementation", planRef: {}, progress: { consumedLoops: 1, admitted: {}, previous: null } };
  fake.set(root, ["rev-parse", "--git-path", "info/exclude"], { stdout: ".git/info/exclude\n", stderr: "", status: 0 });
  const store = new PitakoStore(root), scope = "exec:test.e0", identity = store.activate(scope);
  const admit = (current: CheckpointIntent) => {
    const head = store.read(scope).head;
    const saved = store.commit(scope, head, `intent:${head?.seq ?? 0}`, canonicalDigest(current),
      () => ({ kind: "intent", body: current }));
    if (saved.outcome !== "appended" || !saved.head) throw Error("Expected fixture intent append");
    const input = { seq: saved.head.seq, digest: saved.head.hash };
    const cursor: ExecuteCursor = {
      version: 10, storeId: identity.storeId, root, invocation: "test", epoch: 0,
      associationDigest: canonicalDigest(current.association), admissionBinding: "b".repeat(64), head: saved.head,
      action: { kind: "launched", key: current.key, runId: null, role: "worker", input, gateTimeoutMs: 1000 },
      loop: { number: current.loop, phase: current.phase, cursor: current.cursor, taskId: current.taskId,
        outcome: null, attempt: { number: current.attempt, stage: "launched", intent: input, revival: null } },
      inFlight: [], halt: null, hostHalt: null,
      timeouts: { reviewerMs: 1000, workerMs: 1000, gateFloorMs: 0 },
      models: { taskReviewer: "fixture/reviewer", taskSynthesis: "fixture/synthesis", r1: "fixture/r1", r2: "fixture/r2", synthesis: "fixture/synthesis" },
      budget: { consumedLoops: 1, maxCycles: 3, rejectedKeys: [], lastProgress: null },
      backlogDigest: null, boardTopicId: 1, review: null,
    };
    const file = executionStatePath(current.association);
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ "pitako-execute": cursor }));
    return cursor;
  };
  admit(intent);
  const run = (kind: "unit" | "pause" | null, extra = {}, cwd = root) => {
    budget.counts.sealer++;
    const result = spawnSync("node", [script, "--seal-stdin"], { cwd, env: process.env, encoding: "utf8",
      // The registered runtime agent's actual stdin framing, not bare JSON.
      input: buildExternalCliPrompt(sealerPrompt, JSON.stringify({ v: 1, intent, kind, ...extra })) });
    return { ...result, value: result.status === 0 ? JSON.parse(result.stdout) : undefined };
  };
  const capture = () => captureCheckpoint(intent, paths);
  const change = (value: string) => applyCheckpoint(intent, [{ path: "owned", image: { bytes: Buffer.from(value).toString("base64"), mode: 0o644 } }]);
  return { root, fake, intent, run, capture, change, admit, store, scope, directory: checkpointDirectory(intent),
    processes: budget.processes, expectProcessBudget: (maximum: number) => expectProcessBudget(budget.processes(), maximum) };
}

test.each([null, "unit", "pause"] as const)("no manifest observes candidate without metadata (%s)", kind => {
  const f = fixture(), result = f.run(kind);
  expect(result.status, result.stderr).toBe(0);
  expect(result.value).toMatchObject({ v: 1, outcome: "observed", kind, candidate: { head: expect.any(String), fingerprint: expect.any(String) } });
  expect(existsSync(f.directory)).toBe(false);
});

test("successor cursor permits only an identical head-bound committed seal replay", () => {
  const f = fixture();
  const request = { v: 1 as const, intent: f.intent, kind: "pause" as const };
  const successor = { ...f.intent, key: "test.a2", attempt: 2 };
  const beforeSeal = f.admit(successor);
  expect(() => verifyExecuteSealerIntents(f.root, beforeSeal, request)).toThrow("committed original");
  const selection = { kind: "pause", workerStatus: "continue", mutated: false,
    after: checkoutEvidence(f.root), gate: { path: "gate", digest: "a".repeat(64) } };
  f.store.commit(f.scope, f.store.read(f.scope).head, "seal:test.a1",
    canonicalDigest({ sealRequest: request, selection }), () => ({
      kind: "seal", body: { requestDigest: canonicalDigest({ sealRequest: request, selection }),
        result: { ...selection, receipt: { outcome: "observed" } } },
    }));
  // A newer tip alone grants nothing to the earlier cursor.
  expect(() => verifyExecuteSealerIntents(f.root, beforeSeal, request)).toThrow("committed original");
  const cursor = f.admit(successor);
  expect(() => verifyExecuteSealerIntents(f.root, cursor, request)).not.toThrow();
  expect(() => verifyExecuteSealerIntents(f.root, cursor, { ...request, kind: "unit" })).toThrow("committed original");
});

test.each(["missing", "legacy", "ahead"] as const)("sealer refuses unavailable cursor authority without creating or quarantining (%s)", mode => {
  const f = fixture(), statePath = executionStatePath(f.intent.association);
  const cursor = JSON.parse(readFileSync(statePath, "utf8"))["pitako-execute"];
  if (mode === "missing") rmSync(statePath);
  if (mode === "legacy") writeFileSync(statePath, JSON.stringify({ "invoke-test": { version: 9, loop: { attempt: { checkpoint: f.intent } } } }));
  if (mode === "ahead") { cursor.head.seq++; writeFileSync(statePath, JSON.stringify({ "pitako-execute": cursor })); }
  const before = readFileSync(f.store.file);
  const result = f.run("unit");
  if (mode === "ahead") expect(result.value).toMatchObject({ code: "cursor-ahead" });
  else expect(result.status).not.toBe(0);
  expect(existsSync(f.directory)).toBe(false);
  expect(readFileSync(f.store.file)).toEqual(before);
});

test.each(["unit", "pause"] as const)("%s seals journaled bytes and identical publication is idempotent", kind => {
  const f = fixture(); f.capture(); f.change("after");
  const first = f.run(kind); expect(first.status, first.stderr).toBe(0);
  expect(first.value).toMatchObject({ outcome: "sealed", kind, position: { cursor: kind === "unit" ? 1 : 0 } });
  const bytes = readFileSync(first.value.checkpointRef, "utf8");
  expect(first.value.digest).toBe(sha(bytes));
  expect(observeTaskReviewSeal(f.intent)).toEqual(first.value);
  expect(readFileSync(first.value.checkpointRef, "utf8")).toBe(bytes);
  expect(f.run(kind).value).toEqual(first.value);
  // Unrelated checkout drift after sealing does not change the sealed content:
  // replay identifies the same seal with its sealing candidate.
  writeFileSync(path.join(f.root, "unrelated"), "drift");
  expect(() => observeTaskReviewSeal(f.intent)).toThrow("checkout differs");
  expect(f.run(kind).value).toEqual(first.value);
  expect(readFileSync(first.value.checkpointRef, "utf8")).toBe(bytes);
  expect(f.run(kind === "unit" ? "pause" : "unit").value.outcome).toBe("mismatch");
  writeFileSync(path.join(f.root, "owned"), "foreign");
  const conflict = f.run(kind).value;
  expect(conflict).toMatchObject({ outcome: "mismatch", paths: [{ path: "owned", journaled: sha("after"), actual: sha("foreign"), partiallyApplied: false }] });
  expect(readFileSync(first.value.checkpointRef, "utf8")).toBe(bytes);
});

test("null verifies without seal; all modes explain mismatches and partial application", () => {
  const f = fixture(); f.capture();
  expect(f.run(null).value.outcome).toBe("observed");
  expect(existsSync(path.join(f.directory, "unit.json"))).toBe(false);
  prepareCheckpoint(f.intent, [{ path: "owned", image: { bytes: Buffer.from("after").toString("base64"), mode: 0o644 } }]);
  for (const kind of [null, "unit", "pause"] as const) {
    expect(f.run(kind).value).toMatchObject({ outcome: "mismatch", paths: [{ path: "owned", journaled: sha("after"), actual: sha("before"), partiallyApplied: true }] });
  }
});

test("mismatch reports absence and caps differing paths at ten", () => {
  const paths = Array.from({ length: 12 }, (_, i) => `file-${i}`), f = fixture(paths); f.capture();
  for (const file of paths) writeFileSync(path.join(f.root, file), "foreign");
  const result = f.run(null);
  expect(result.value.paths).toHaveLength(10);
  expect(result.value.paths[0]).toMatchObject({ journaled: null, actual: sha("foreign") });
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(60 * 1024);
});

test("restoration is read from durable artifacts, never executed by the sealer", () => {
  const f = fixture(); f.capture(); f.change("after");
  restoreCheckpoint(f.intent, { pending: true, stop: false, permissionDenied: false, activeWriter: null, references: ["unknown writer"] });
  const result = f.run(null, { restoreSources: [f.intent] });
  expect(result.status, result.stderr).toBe(0);
  expect(result.value).toMatchObject({ outcome: "observed", restored: { checkpointRef: path.join(f.directory, "manifest.json"), restoredRef: path.join(f.directory, "restored.json") } });
  expect(readFileSync(path.join(f.root, "owned"), "utf8")).toBe("before");
  writeFileSync(path.join(f.root, "owned"), "foreign");
  expect(f.run(null, { restoreSources: [f.intent] }).value).toMatchObject({ outcome: "mismatch", paths: [{ journaled: sha("before"), actual: sha("foreign") }] });
});

test.each(["unit", "pause", null] as const)("restored workers can journal new effects before root %s", kind => {
  const f = fixture(); f.capture(); f.change("interrupted");
  const restored = restoreCheckpoint(f.intent, { pending: true, stop: false, permissionDenied: false, activeWriter: null, references: ["unknown"] });
  const next = { ...f.intent, key: "test.a2", attempt: 2 };
  f.admit(next);
  captureCheckpoint(next, ["owned"]);
  applyCheckpoint(next, [{ path: "owned", image: { bytes: Buffer.from("completed").toString("base64"), mode: 0o644 } }]);
  const result = f.run(kind, { intent: next, restoreSources: [f.intent] });
  expect(result.status, result.stderr).toBe(0);
  expect(result.value).toMatchObject({ outcome: kind ? "sealed" : "observed", kind,
    restored: { candidate: restored.candidate, checkpointRef: restored.checkpointRef } });
  expect(result.value.candidate).not.toEqual({ head: restored.candidate.head, fingerprint: restored.candidate.fingerprint });
  if (kind) expect(result.value.checkpointRef).toBe(path.join(checkpointDirectory(next), `${kind}.json`));
  writeFileSync(path.join(f.root, "owned"), "foreign");
  expect(f.run(kind, { intent: next, restoreSources: [f.intent] }).value).toMatchObject({
    outcome: "mismatch", paths: [{ journaled: sha("completed"), actual: sha("foreign") }],
  });
});

test("wrong cwd reports a store outcome; invalid input, corrupt artifacts and oversized output fail nonzero", () => {
  const f = fixture();
  expect(f.run(null, { v: 2 }).status).not.toBe(0);
  expect(f.run(null, {}, tmpdir()).value).toMatchObject({ code: "wrong-cwd" });
  f.capture();
  writeFileSync(path.join(f.directory, "manifest.json"), "{}");
  expect(f.run(null).status).not.toBe(0);
  const long = fixture(); long.capture();
  restoreCheckpoint(long.intent, { pending: true, stop: false, permissionDenied: false, activeWriter: null, references: ["unknown"] });
  const receipt = path.join(long.directory, "restored.json");
  const value = JSON.parse(JSON.parse(readFileSync(receipt, "utf8")).data);
  value.preserve = "x".repeat(60 * 1024);
  const data = JSON.stringify(value);
  writeFileSync(receipt, JSON.stringify({ data, sha256: sha(data) }));
  const oversized = long.run(null, { restoreSources: [long.intent] });
  expect(oversized.status).not.toBe(0);
  expect(oversized.stderr).toContain("output exceeds 60 KiB");
  expect(oversized.stdout).toBe("");
});

test("runtime registration includes a model-free sealer and rolls all agents back on failure", () => {
  for (const fail of [false, true]) {
    const hooks = new Map<string, any>(), registrations: any[] = [], disposed: string[] = [];
    planExecute({ on: (name: string, hook: any) => hooks.set(name, hook), events: { emit: (_: string, request: any) => {
      registrations.push(request);
      request.result = fail && request.name === "pitako.checkpoint-sealer" ? { ok: false, error: "controlled conflict" } : { ok: true, registration: { dispose: () => disposed.push(request.name) } };
    } } } as unknown as ExtensionAPI);
    const start = () => hooks.get("session_start")({}, { sessionManager: { getSessionId: () => randomUUID() } });
    if (fail) expect(start).toThrow("No fallback was registered"); else start();
    const sealer = registrations.find(item => item.name === "pitako.checkpoint-sealer");
    expect(sealer.definition).toMatchObject({ tools: [], allowNestedSubagents: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, acceptanceRole: "read-only", runner: { type: "external-cli", args: [script, "--seal-stdin"], promptDelivery: "stdin" } });
    if (!fail) hooks.get("session_shutdown")();
    expect(disposed).toContain("pitako.checkout-observer");
    expect(disposed).toContain("pitako.execution-ledger");
    expect(disposed).toContain("pitako.request-observer");
  }
});

// The real CLI tests above verify bytes; these controller cases verify dispatch,
// admission ordering and the absence of model-owned checkpoint identities.
const { fixture: controller } = executeControllerFixture();
test.each([
  ["complete", [], "unit"], ["continue", ["pending"], "pause"],
  ["gaps", ["pending"], "pause"], ["gaps", [], "pause"], ["continue", [], "pause"],
] as const)("root chooses seal kind for %s remaining=%j", async (status, remaining, expected) => {
  const host = controller();
  host.setLimit(1);
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker") {
      const value = host.worker(request);
      expect(Object.keys(request.outputSchema.properties).sort()).toEqual([
        "continuation", "knowledge", "remaining", "status", "work",
      ]);
      expect(request.outputSchema.required).not.toContain("continuation");
      return host.result(request, { ...value, status, remaining });
    }
    if (request.agent === "pitako.checkpoint-sealer") {
      const input = JSON.parse(request.task);
      if (input.intent.taskId === "change1") {
        expect(input.kind).toBe(expected);
        expect(host.current().loop.attempt).toMatchObject({ stage: "launched",
          intent: { seq: expect.any(Number), digest: expect.any(String) } });
        if (status === "complete") {
          const synthesis = host.current().review.slots.find((slot: any) => slot.key.endsWith(".task-synthesis"));
          expect(synthesis).toBeDefined();
          expect(host.native.get(synthesis.key)!.structuredOutput.correctness.score).toBeGreaterThanOrEqual(9);
        } else {
          expect(host.current().action).toMatchObject({ kind: "pending", op: "close" });
        }
        expect(host.current().loop.attempt).not.toHaveProperty("result");
      }
    }
    if (request.agent === "pitako.execution-director") expect(request.outputSchema.properties).not.toHaveProperty("association");
    return normal();
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial"); // One slot completes the task, not the separate final phase.
  const unit = host.records().find((record: any) => record.kind === "unit" && record.body.taskId === "change1");
  expect(unit, output.reason).toBeDefined();
  const receipt = unit.body.result.checkpoint.confirmation;
  expect(receipt.kind).toBe(expected);
});

test("a busy checkpoint seal commit retries only the sealer and admits the retained file once", async () => {
  const host = controller(undefined, { realCheckout: true });
  host.setLimit(1);
  const attempt = "invoke-human-1.l1.t1.a1", key = `${attempt}.seal`;
  const file = path.join(host.root, ".pi/subagents/checkpoints", attempt, "unit.json");
  let inode: number, bytes: string;
  // Inject the exhausted store result at the commit boundary, after the real CLI publishes the file.
  const busyPreload = `data:text/javascript,${encodeURIComponent(`
    await import(${JSON.stringify(pathToFileURL(path.resolve("skills/execute/loader.mjs")).href)});
    const { PitakoStore, StoreError } = await import(${JSON.stringify(pathToFileURL(path.resolve("extensions/pitako-store.ts")).href)});
    const commit = PitakoStore.prototype.commit;
    PitakoStore.prototype.commit = function (...args) {
      if (args[2].startsWith("seal:")) throw new StoreError("store-busy", "Store remained busy.");
      return commit.apply(this, args);
    };
  `)}`;
  host.setRespond((request, normal) => {
    if (request.agent !== "pitako.checkpoint-sealer") return normal();
    const first = request.key === key;
    const result = spawnSync("node", [...(first ? ["--import", busyPreload] : []), script, "--seal-stdin"],
      { cwd: host.root, encoding: "utf8", input: buildExternalCliPrompt(sealerPrompt, request.task) });
    expect(result.status, result.stderr).toBe(0);
    if (first) {
      expect(JSON.parse(result.stdout)).toEqual({ v: 1, kind: "unit", outcome: "store-busy" });
      inode = statSync(file).ino; bytes = readFileSync(file, "utf8");
    } else {
      expect(statSync(file).ino).toBe(inode);
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
    return { ok: true, key: request.key, agent: request.agent, runId: nativeRunId(request.key),
      asyncDir: "/native/sealer", output: result.stdout, results: [{ exitCode: 0 }],
      externalAdapter: { outputArtifacts: { stdoutPath: "/native/sealer/stdout", stderrPath: "/native/sealer/stderr" } } } as Result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  const seals = host.launches.filter(call => call.agent === "pitako.checkpoint-sealer");
  expect(seals.map(call => call.key), output.reason).toEqual([key, `${key}.r1`]);
  expect(seals[1]!.task).toBe(seals[0]!.task);
  expect(host.gateExecutions()).toBe(1);
  const cursor: ExecuteCursor = host.current();
  const stored = new PitakoStore(host.root).read(`exec:${cursor.invocation}.e${cursor.epoch}`, cursor.head);
  expect(stored.records.filter(record => record.kind === "seal" && record.opKey.startsWith(`seal:${attempt}:`))).toHaveLength(1);
  expect(host.records().filter((record: { kind: string }) => record.kind === "unit")).toHaveLength(1);
});

test.each(["store-corrupt", "superseded"] as const)("checkpoint sealer transports %s to the execute root", async code => {
  const host = controller(undefined, { realCheckout: code === "superseded" });
  host.setLimit(3);
  host.setStatus(ref => {
    const value = host.native.get(ref);
    return value ? { ...value, state: "complete" } : { ok: true, output: "", results: [] };
  });
  const key = "invoke-human-1.l1.t1.a1.seal", storeCheck = `${key}.store-check`;
  const store = new PitakoStore(host.root);
  let before: ExecuteCursor | undefined, saves = -1, quarantine = "";
  host.setLaunchRespond((request, normal) => {
    if (request.key !== key && request.key !== storeCheck) return normal();
    const sealer = request.key === key;
    if (sealer) {
      before = copy(host.current()); saves = host.snapshots.length;
      if (code === "superseded") store.activate("exec:replacement.e0");
      else {
        const db = openSqliteSync(store.file);
        try { db.exec("PRAGMA user_version=2"); } finally { db.close(); }
      }
    }
    const result = sealer
      ? spawnSync("node", [script, "--seal-stdin"], { cwd: host.root, encoding: "utf8",
        input: buildExternalCliPrompt(sealerPrompt, request.task) })
      : spawnSync(process.execPath, ["--preload", gitFakeBootstrap, path.resolve("skills/execute/loop-io.mjs")],
        { cwd: host.root, encoding: "utf8", input: request.task });
    expect(result.status, result.stderr).toBe(sealer ? 0 : 1);
    const failure = JSON.parse(result.stdout);
    expect(failure.code).toBe(code);
    if (sealer) expect(failure.recovery).toBeUndefined(); // The intent reader does not quarantine.
    else quarantine = failure.recovery.quarantine;
    return { ok: sealer, key: request.key, agent: request.agent, runId: nativeRunId(request.key),
      asyncDir: "/native/child", output: result.stdout, results: [{ exitCode: result.status! }],
      externalAdapter: { outputArtifacts: { stdoutPath: "/native/child/stdout", stderrPath: "/native/child/stderr" } } } as Result;
  });
  const output = code === "store-corrupt" ? await host.executeNative() : await host.execute();
  expect(before).toBeDefined();
  if (code === "superseded") {
    expect(output.status, output.reason).toBe("partial");
    expect(output.reason).toContain("superseded");
    expect(host.launches.at(-1)?.key).toBe(key);
    expect(host.current()).toEqual(before!);
    expect(host.snapshots).toHaveLength(saves);
  } else {
    expect(["partial", "complete"], output.reason).toContain(output.status);
    expect(host.hostCalls.filter(key => key.startsWith("inspect-initial"))).toEqual(["inspect-initial"]);
    expect(quarantine).toStartWith(`${store.file}.v2.`);
    expect(existsSync(quarantine)).toBe(true);
    expect(host.current()).toMatchObject({ epoch: 1, halt: null, budget: { maxCycles: before!.budget.maxCycles } });
    expect(host.current().storeId).not.toBe(before!.storeId);
    expect(host.current().budget.consumedLoops).toBeGreaterThan(before!.budget.consumedLoops);
    expect(host.snapshots.slice(saves).every(cursor => cursor.epoch === 1)).toBe(true);
    expect(host.launches.some(call => call.key.startsWith("invoke-human-1.e1."))).toBe(true);
  }
});

test("a schema-invalid declared block still halts after kind-null journal verification", async () => {
  const host = controller();
  const sealed: unknown[] = [];
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1")
      return host.result(request, { ...host.worker(request), status: "blocked", remaining: ["needs a decision"], work: null });
    if (request.agent === "pitako.checkpoint-sealer") sealed.push(JSON.parse(request.task).kind);
    return normal();
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(sealed).toEqual([null]);
  expect(host.calls.filter((call: any) => call.agent === "pitako.worker")).toHaveLength(1);
  expect(host.current().loop.attempt).not.toHaveProperty("result");
});

test.each(["complete", "pause", "rejected"])("journal mismatch for %s blocks before admission with actionable paths", async mode => {
  const host = controller(undefined, { realCheckout: true });
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const value = host.worker(request);
      const descriptor = JSON.parse(request.task.split("PRE-WRITE CHECKPOINT INTENTION (not a backup until published):\n")[1]!.split("\n")[0]!);
      const file = "src/" + descriptor.taskId + ".ts";
      mkdirSync(path.dirname(path.join(host.root, file)), { recursive: true });
      writeFileSync(path.join(host.root, file), "not journaled");
      return host.result(request, mode === "pause" ? { ...value, status: "gaps", remaining: ["pending"] }
        : mode === "rejected" ? { ...value, work: null } : value);
    }
    return normal();
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(copy(host.current().halt)).toMatchObject({ stage: "checkpoint-integrity", digest: expect.any(String) });
  expect(output.loopReport.halt).toMatchObject({ code: "checkpoint-integrity",
    ref: { agent: mode === "pause" ? "pitako.loop-io" : "pitako.checkpoint-sealer" } });
  expect(output.reason).toContain("src/change1.ts");
  expect(output.reason).toContain("journaled sha256 absence");
  expect(output.reason).toContain("last step partially applied: false");
  expect(output.reason).toContain("Return the files to their journaled bytes before starting a new invocation");
  expect(output.reason).not.toMatch(/new mission/i);
  expect(host.current().loop.attempt).not.toHaveProperty("result");
  expect(host.records().filter((row: any) => row.kind === "unit")).toEqual([]);
  const cursor = host.current(), count = host.launches.length;
  const held = await host.execute();
  expect(held.status, held.reason).toBe("blocked");
  expect(held.reason).toBe(output.reason);
  expect(held.loopReport.halt).toEqual(output.loopReport.halt);
  expect(host.launches).toHaveLength(count);
  expect(host.current()).toEqual(cursor);
});

test("structurally rejected worker reports verify the journal without sealing", async () => {
  const host = controller(); host.setLimit(1);
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker") return host.result(request, { ...host.worker(request), work: null });
    if (request.agent === "pitako.checkpoint-sealer") expect(JSON.parse(request.task).kind).toBeNull();
    return normal();
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.history()[0].results[0].status).toBe("rejected");
  expect(host.records().filter((row: any) => row.kind === "unit")).toEqual([]);
});

test("root observes missing manifests and blocks changed candidates without a journal-backed unit", async () => {
  const host = controller(undefined, { realCheckout: true }); host.setLimit(1);
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker") {
      const value = host.worker(request);
      const descriptor = JSON.parse(request.task.split("PRE-WRITE CHECKPOINT INTENTION (not a backup until published):\n")[1]!.split("\n")[0]!);
      host.changeCheckout();
      rmSync(path.join(host.root, ".pi/subagents/checkpoints", descriptor.key, "manifest.json"));
      return host.result(request, value);
    }
    return normal();
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain("candidate-drift");
  expect(host.current().loop.attempt).not.toHaveProperty("result");
  expect(host.records().filter((row: any) => row.kind === "unit")).toEqual([]);
});

test.each([false, true])("missing implementation result restores before the next capture (written=%s)", async written => {
  const host = controller(undefined, { realCheckout: true });
  let source: CheckpointIntent;
  let restored: any;
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const result = normal();
      source = readExecuteIntentContext(host.root, host.current()).intent;
      if (written) applyCheckpoint(source, [{ path: "src/change1.ts", image: {
        bytes: Buffer.from("interrupted owned bytes").toString("base64"), mode: 0o644,
      } }]);
      delete result.structuredOutput;
      return result;
    }
    if (request.key === "invoke-human-1.l1.t1.a2") {
      const fallback = JSON.parse(request.task.split("CHECKPOINT FALLBACK (same pending task, not a metadata repair):\n")[1]!.split("\n")[0]!);
      restored = restoreCheckpoint(source, fallback.authority);
      expect(existsSync(path.join(host.root, "src/change1.ts"))).toBe(false);
    }
    return normal();
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
  expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key), output.reason)
    .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
  expect(host.records().find((record: any) => record.kind === "unit" && record.body.attempt === 2).body.result).toMatchObject({ status: "complete", attempt: 2,
    checks: { current: true }, checkpoint: { confirmation: { kind: "unit" } } });
  const partial = JSON.parse(JSON.parse(readFileSync(restored.partialRef, "utf8")).data).partial;
  expect(partial[0].image).toEqual(written ? {
    bytes: Buffer.from("interrupted owned bytes").toString("base64"), mode: 0o644,
  } : null);
});

test.each(["gate", "seal"])("native budget refusal preserves the pending %s without publishing a child", async stage => {
  const host = controller(undefined, { readOnly: stage === "gate" });
  let rejected = false;
  host.setLaunchRespond((request, normal) => {
    if (!rejected && request.key.endsWith(`.${stage}`)) {
      rejected = true;
      const error = new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: `workflow[${request.key}]`, used: 64, limit: 64, requested: 1, remaining: 0 }).message;
      return { key: request.key, ok: false, error, output: error, artifactPaths: [] };
    }
    return normal();
  });
  expect((await host.execute()).status).toBe("budget-exhausted");
  if (stage === "gate")
    expect(host.current().action).toMatchObject({ kind: "pending", op: "gate", opKey: "invoke-human-1.l1.t1.a1.gate" });
  else {
    expect(host.current().action).toMatchObject({ kind: "launched", key: "invoke-human-1.l1.t1.a1.task-synthesis" });
    const { admission } = readExecuteAdmission(host.root, host.current());
    const mission = JSON.parse(readFileSync(admission.association.missionPath, "utf8"));
    expect(mission.workflowChildren.filter((child: any) => child.agent === "pitako.checkpoint-sealer")).toEqual([]);
  }
  expect(host.launches.filter(call => call.key.startsWith(`invoke-human-1.l1.t1.a1.${stage}`))).toHaveLength(1);
  expect(host.current().loop.attempt).not.toHaveProperty("result");
});

test("integrity halt holds without input and rejects changed original", async () => {
  const host = controller(undefined, { realCheckout: true });
  const file = path.join(host.root, "src/change1.ts");
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const value = host.worker(request);
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "not journaled");
      return host.result(request, value);
    }
    return normal();
  });
  expect((await host.execute()).status).toBe("blocked");
  const calls = host.calls.length;
  expect((await host.execute()).status).toBe("blocked");
  expect(host.calls).toHaveLength(calls);
  const journal = path.join(host.root, ".pi/native-review", nativeRunId("workflow"), "workflow-children.jsonl");
  const original = readFileSync(journal, "utf8");
  try {
    writeFileSync(journal, original.split("\n").map(line => {
      if (!line) return line;
      const entry = JSON.parse(line);
      if (entry.key.endsWith(".seal")) {
        const receipt = JSON.parse(entry.result.output);
        receipt.paths[0].journaled = "f".repeat(64);
        entry.result.output = JSON.stringify(receipt);
      }
      return JSON.stringify(entry);
    }).join("\n"));
    const conflict = await host.execute();
    expect(conflict.status).toBe("blocked");
    expect(conflict.reason).toContain("original or digest integrity mismatch");
    expect(host.calls).toHaveLength(calls);
  } finally { writeFileSync(journal, original); }
});

test.each(["stopped", "detached"] as const)("a %s sealer admits nothing and holds on relaunch", async cause => {
  const host = controller();
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.agent === "pitako.checkpoint-sealer") {
      return { ...result, ok: false, [cause]: true };
    }
    return result;
  });
  const stoppedOutput = await host.execute();
  expect(stoppedOutput.status).toBe(cause === "stopped" ? "cancelled" : "blocked");
  expect(copy(stoppedOutput.loopReport.halt)).toMatchObject({ code: "native-barrier", cause,
    ref: { agent: "pitako.checkpoint-sealer" } });
  expect(host.current().loop.attempt).not.toHaveProperty("result");
  const calls = host.calls.length;
  const replay = await host.execute();
  expect(replay.status, replay.reason).toBe(stoppedOutput.status);
  expect(host.calls).toHaveLength(calls);
  expect(replay.reason).toBe(stoppedOutput.reason);
  expect(replay.loopReport.halt).toEqual(stoppedOutput.loopReport.halt);
  expect(host.launches.filter(call => call.agent === "pitako.checkpoint-sealer")).toHaveLength(1);
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  const count = host.launches.length;
  expect((await host.execute({ unblock: true })).reason).toBe("Unsupported execution argument: unblock.");
  expect((await host.execute({ resolution: null })).reason).toBe("Unsupported execution argument: resolution.");
  expect(host.launches).toHaveLength(count);
});

test.each([false, true])("an active retained sealer blocks fallback and re-seal; subsequent Stop=%s", async stopped => {
  const host = controller();
  let active = true;
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.key === "invoke-human-1.l1.t1.a1.seal") return { ...result, ok: false, state: "running" };
    return result;
  });
  host.setStatus(ref => {
    if (["invoke-human-1.l1.t1.a1.seal", nativeRunId("invoke-human-1.l1.t1.a1.seal")].includes(ref)) {
      if (active) return { ok: false, state: "running", results: [] };
      if (stopped) return { ok: false, state: "stopped", results: [] };
      return { ok: false, state: "failed", runId: nativeRunId("invoke-human-1.l1.t1.a1.seal"),
        agent: "pitako.checkpoint-sealer", results: [] };
    }
    return copy(host.native.get(ref) ?? { ok: true, output: "", results: [] });
  });
  expect((await host.execute()).status).toBe("blocked");
  const calls = host.calls.length;
  const replayed = await host.execute();
  expect(replayed.status, replayed.reason).toBe("blocked");
  expect(host.calls).toHaveLength(calls);
  expect(host.current().loop.attempt).not.toHaveProperty("result");
  expect(host.current().loop.attempt.restore).toBeUndefined();
  active = false;
  const output = await host.execute();
  if (stopped) {
    expect(output.status, output.reason).toBe("cancelled");
    expect(output.reason).toContain("stopped");
    expect(host.calls).toHaveLength(calls);
    expect(host.current().loop.attempt).not.toHaveProperty("result");
    // Management has a Stop, but the native journal still has only the
    // earlier activity receipt. Neither proof of completion nor a retry.
    const launches = [...host.launches], cursor = host.current();
    const unverified = await host.execute();
    expect(unverified.status).toBe("blocked");
    expect(unverified.reason).toContain("integrity");
    expect(host.launches).toEqual(launches);
    expect(host.current()).toEqual(cursor);
    return;
  }
  expect(output.status, `${output.reason} (${host.calls.slice(calls).map(call => call.key).join(", ")})`).toBe("complete");
  expect(host.current().inFlight.filter((ref: any) => ref.role === "checkpoint-sealer")).toEqual([]);
  expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
  expect(host.launches.filter(call => call.key.startsWith("invoke-human-1.l1.t1.a1.seal")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.seal", "invoke-human-1.l1.t1.a1.seal.r1"]);
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer")).toHaveLength(2);
});

function hasCommittedUnit(root: string, cursor: ExecuteCursor, taskId: string) {
  return new PitakoStore(root).read(`exec:${cursor.invocation}.e${cursor.epoch}`, cursor.head).records
    .some(row => row.kind === "ledger" && (row.body as any).entries.some((entry: any) =>
      entry.kind === "unit" && entry.body.taskId === taskId));
}

test("replay with a committed seal and worker original admits once without repeating the seal", async () => {
  const host = controller();
  cutAt(host, value => hasCommittedUnit(host.root, value, "change1"));
  expect((await host.execute()).status).toBe("partial");
  expect(host.current().loop).toMatchObject({ taskId: "change1", attempt: { stage: "launched" } });
  host.setFailSave();
  host.setStatus(ref => {
    const reviewer = host.native.get(ref);
    if (reviewer?.agent === "pitako.reviewer") return copy(reviewer);
    throw Error(`Status '${ref}' unavailable`);
  });
  const calls = host.calls.length;
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  expect(host.calls.slice(calls).filter(call => call.key.endsWith(".review-recovery.r1")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.task-synthesis.review-recovery.r1"]);
  expect(host.launches.filter(call => call.key === "invoke-human-1.l1.nextAdvance")).toHaveLength(1);
  expect(host.calls.slice(calls).filter(call => call.agent === "pitako.checkpoint-sealer").map(call => call.key))
    .toEqual([]);
  expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1.seal")).toHaveLength(1);
  expect(host.calls.some(call => call.key === "invoke-human-1.l1.t1.a2")).toBe(false);
  expect(host.history()[0].results.filter((entry: any) => entry.taskId === "change1").map((entry: any) => entry.status)).toEqual(["complete"]);
  expect(host.history()[0].results.find((entry: any) => entry.taskId === "change1")).toMatchObject({ attempt: 1, status: "complete" });
});

test("replay with a committed seal but a missing worker original admits nothing", async () => {
  const host = controller();
  cutAt(host, value => hasCommittedUnit(host.root, value, "change1"));
  expect((await host.execute()).status).toBe("partial");
  expect(host.current().loop).toMatchObject({ taskId: "change1", attempt: { stage: "launched" } });
  host.setFailSave();
  // A v10 cursor carries no received body. Replay must verify the native original.
  const { admission } = readExecuteAdmission(host.root, host.current());
  const mission = JSON.parse(readFileSync(admission.association.missionPath, "utf8"));
  const worker = mission.workflowChildren.find((child: any) => child.key === "invoke-human-1.l1.t1.a1");
  const original = worker.artifactPaths.find((file: string) => file.endsWith("/invoke-human-1.l1.t1.a1.json"));
  expect(original).toBeDefined();
  rmSync(original);
  host.setStatus(ref => {
    if (/\.task-(reviewer|synthesis)$/.test(ref)) return copy(host.native.get(ref)!);
    throw Error(`Status '${ref}' unavailable`);
  });
  const calls = host.calls.length;
  expect((await host.execute()).status).toBe("blocked");
  expect(host.calls.slice(calls).some(call => call.agent === "pitako.checkpoint-sealer" && call.key.startsWith("invoke-human-1.l1.t1.a1.seal"))).toBe(false);
  expect(host.records().filter((row: any) => row.kind === "unit")).toEqual([]);
  expect(host.calls.slice(calls).some(call => call.agent === "pitako.worker")).toBe(false);
  expect(host.current().loop).toMatchObject({ taskId: "change1", attempt: { number: 1 } });
});


test("append-only first touches seal late paths and retain the original preimage", () => {
  const f = fixture();
  const first = beginHookEffect(f.intent, "edit", ["owned"]);
  const manifest = readFileSync(path.join(f.directory, "manifest.json"), "utf8");
  const capture = readFileSync(path.join(f.directory, "capture-000000.json"), "utf8");
  writeFileSync(path.join(f.root, "owned"), "first"); closeHookEffect(f.intent, first);
  const late = beginHookEffect(f.intent, "apply_patch", ["owned", "late"]);
  writeFileSync(path.join(f.root, "owned"), "second"); writeFileSync(path.join(f.root, "late"), "discovered");
  closeHookEffect(f.intent, late);
  expect(readFileSync(path.join(f.directory, "manifest.json"), "utf8")).toBe(manifest);
  expect(readFileSync(path.join(f.directory, "capture-000000.json"), "utf8")).toBe(capture);
  expect(existsSync(path.join(f.directory, "capture-000002.json"))).toBe(false);
  const result = f.run("unit"); expect(result.status, result.stderr).toBe(0);
  expect(result.value.outcome).toBe("sealed");
  const point = JSON.parse(JSON.parse(readFileSync(result.value.checkpointRef, "utf8")).data);
  expect(point.files.map((file: any) => file.path)).toEqual(["owned", "late"]);
  expect(f.run("unit").value).toEqual(result.value);
});

test("never-closed effects prevent sealing without product writes and retain arbitrary bytes before restore", () => {
  const f = fixture(); beginHookEffect(f.intent, "write", ["owned", "late"]);
  writeFileSync(path.join(f.root, "owned"), "arbitrary partial bytes");
  writeFileSync(path.join(f.root, "late"), "partial new file");
  for (const kind of [null, "unit", "pause"] as const) {
    const result = f.run(kind); expect(result.status, result.stderr).toBe(0);
    expect(result.value).toMatchObject({ outcome: "open", paths: ["owned", "late"] });
    expect(readFileSync(path.join(f.root, "owned"), "utf8")).toBe("arbitrary partial bytes");
  }
  expect(existsSync(path.join(f.directory, "unit.json"))).toBe(false);
  const restored = restoreCheckpoint(f.intent, { pending: true, stop: false, permissionDenied: false,
    activeWriter: null, references: ["unknown writer"] });
  const partial = JSON.parse(JSON.parse(readFileSync(restored.partialRef, "utf8")).data).partial;
  expect(Buffer.from(partial[0].image.bytes, "base64").toString()).toBe("arbitrary partial bytes");
  expect(Buffer.from(partial[1].image.bytes, "base64").toString()).toBe("partial new file");
  expect(readFileSync(path.join(f.root, "owned"), "utf8")).toBe("before");
  expect(existsSync(path.join(f.root, "late"))).toBe(false);
  expect(f.run(null, { restoreSources: [f.intent] }).value.outcome).toBe("observed");
});

test.each(["capture", "effect", "postimage"])("insufficient %s evidence halts restoration without overwriting product bytes", missing => {
  const f = fixture(["owned"]); const seq = beginHookEffect(f.intent, "write", ["owned"]);
  writeFileSync(path.join(f.root, "owned"), "partial bytes");
  if (missing === "capture") rmSync(path.join(f.directory, "capture-000000.json"));
  else {
    closeHookEffect(f.intent, seq);
    if (missing === "effect") rmSync(path.join(f.directory, "hook-effect-000000.json"));
    else {
      const data = JSON.stringify({ after: null });
      writeFileSync(path.join(f.directory, "hook-effect-000000-closed.json"), JSON.stringify({ data, sha256: sha(data) }));
    }
  }
  expect(() => restoreCheckpoint(f.intent, { pending: true, stop: false, permissionDenied: false,
    activeWriter: null, references: ["unknown writer"] })).toThrow(missing === "capture" ? "reconstructible preimages"
      : missing === "effect" ? "closure lacks an effect intent" : "Invalid hook effect postimages");
  expect(readFileSync(path.join(f.root, "owned"), "utf8")).toBe("partial bytes");
  expect(existsSync(path.join(f.directory, "restore.json"))).toBe(false);
});

test("controller admits a late-discovered path in the original worker attempt", async () => {
  const host = controller(undefined, { realCheckout: true }); host.setLimit(1);
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const value = host.worker(request), intent = readExecuteIntentContext(host.root, host.current()).intent;
      expect(host.current().action).toMatchObject({ kind: "launched", key: intent.key, role: "worker" });
      const file = path.join(host.root, "src/change1.ts"); mkdirSync(path.dirname(file), { recursive: true });
      const first = beginHookEffect(intent, "write", ["src/change1.ts"]);
      writeFileSync(file, "first write"); closeHookEffect(intent, first);
      const late = beginHookEffect(intent, "write", ["late.ts"]);
      writeFileSync(path.join(host.root, "late.ts"), "late discovery"); closeHookEffect(intent, late);
      return host.result(request, value);
    }
    return normal();
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1"]);
  expect(host.records().find((record: any) => record.kind === "unit").body.result).toMatchObject({ status: "complete", attempt: 1,
    checkpoint: { confirmation: { kind: "unit" } } });
  expect(readFileSync(path.join(host.root, "late.ts"), "utf8")).toBe("late discovery");
});

test.each([false, true])("controller restores a never-closed effect only with an available witness (%s)", async witnessError => {
  const host = controller(undefined, { realCheckout: true }); host.setLimit(1);
  if (witnessError) host.setHostResponse((_key, value) => ({ ...value,
    checkpointObservation: { key: "invoke-human-1.l1.t1.a1", taskId: "change1", attempt: 1, loop: 1, cursor: 0,
      error: "Checkpoint evidence was unavailable at admission" } }));
  let source: CheckpointIntent;
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const value = host.worker(request); source = readExecuteIntentContext(host.root, host.current()).intent;
      beginHookEffect(source, "write", ["src/change1.ts"]);
      mkdirSync(path.join(host.root, "src"), { recursive: true });
      writeFileSync(path.join(host.root, "src/change1.ts"), "uncertain partial bytes");
      return host.result(request, value);
    }
    if (request.key === "invoke-human-1.l1.t1.a2") {
      const fallback = JSON.parse(request.task.split("CHECKPOINT FALLBACK (same pending task, not a metadata repair):\n")[1]!.split("\n")[0]!);
      const restored = restoreCheckpoint(source, fallback.authority);
      const partial = JSON.parse(JSON.parse(readFileSync(restored.partialRef, "utf8")).data).partial;
      expect(Buffer.from(partial[0].image.bytes, "base64").toString()).toBe("uncertain partial bytes");
      expect(existsSync(path.join(host.root, "src/change1.ts"))).toBe(false);
    }
    return normal();
  });
  const output = await host.execute();
  if (witnessError) {
    expect(output.status, output.reason).toBe("blocked");
    expect(output.reason).toContain("Checkpoint observation unavailable:");
    const cursor = host.current(), launches = [...host.launches], writes = host.snapshots.length;
    host.setHostResponse();
    const held = await host.execute();
    expect(held.loopReport?.halt, held.reason).toEqual(output.loopReport.halt);
    expect(held.reason).toBe(output.reason);
    expect(host.launches).toEqual(launches);
    expect(host.snapshots).toHaveLength(writes);
    expect(host.current()).toEqual(cursor);
    const { key, runId } = held.loopReport.halt.ref;
    const original = path.join(host.root, ".pi/subagents/artifacts/outputs", runId, "host", `${key}.log`);
    const changed = JSON.parse(readFileSync(original, "utf8"));
    changed.checkpointObservation.error = "Changed historical observation";
    writeFileSync(original, JSON.stringify(changed));
    const mismatched = await host.execute();
    expect(mismatched.reason).toContain("digest integrity mismatch");
    expect(host.launches).toEqual(launches);
    expect(host.snapshots).toHaveLength(writes);
    return;
  }
  expect(output.status, output.reason).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key), output.reason)
    .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
  expect(host.history()[0].results[0]).toMatchObject({ status: "complete", attempt: 2 });
  expect(host.calls.filter(call => /\.task-(reviewer|synthesis)$/.test(call.key)).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a2.task-reviewer", "invoke-human-1.l1.t1.a2.task-synthesis"]);
  // Measured 71 direct processes, plus eight.
  host.expectProcessBudget(79);
});

function dispatchBaseline(f: ReturnType<typeof fixture>) {
  const { head, fingerprint } = checkoutEvidence(f.root);
  f.intent.baseline = { head, fingerprint };
  f.admit(f.intent);
  expect(captureBaseline({ intent: f.intent }).candidate).toEqual(f.intent.baseline!);
}
test("sealing observes the checkout once per request", () => {
  const f = fixture(["owned"]); dispatchBaseline(f); f.capture(); f.change("after");
  const cwd = process.cwd();
  try {
    process.chdir(f.root);
    const observed = checkoutEvidence(f.root);
    const before = f.fake!.calls.length;
    expect(sealCheckpointRequest({ v: 1, intent: f.intent, kind: "unit" }).outcome).toBe("sealed");
    // Three workspace reads, four HEAD/index reads (combined HEAD/branch,
    // cached diff, stage listing, HEAD), and one full observation's file listing
    // + status. Before sealing reuse there were six listings/statuses: 19 Git calls.
    expect(f.fake!.calls.length - before).toBe(9);
    const point = JSON.parse(JSON.parse(readFileSync(path.join(f.directory, "unit.json"), "utf8")).data);
    expect(point.candidate).toEqual(observed); // Includes status and branch, not only fingerprint.
    // Standalone publication still performs attribution and retains deep equality.
    expect(sealCheckpoint(f.intent, "unit", true).digest).toBe(sha(readFileSync(path.join(f.directory, "unit.json"), "utf8")));
    const again = f.fake!.calls.length;
    expect(sealCheckpointRequest({ v: 1, intent: f.intent, kind: "unit" }).outcome).toBe("sealed");
    expect(f.fake!.calls.length - again).toBe(9);
    // A later call must not reuse the earlier observation, including in the
    // attribution-error catch inside the operation's stable-checkout scope.
    writeFileSync(path.join(f.root, "foreign"), "unjournaled");
    const changed = f.fake!.calls.length;
    expect(sealCheckpointRequest({ v: 1, intent: f.intent, kind: "unit" })).toMatchObject({
      outcome: "mismatch", paths: [{ path: "foreign", actual: sha("unjournaled") }],
    });
    expect(f.fake!.calls.length - changed).toBe(9);
    expect(() => sealCheckpoint(f.intent, "unit", true)).toThrow("Unjournaled candidate change");
  } finally { process.chdir(cwd); }
});
test.each(["HEAD", "index"])("in-process sealing rejects a %s change between requests", changed => {
  const f = fixture(["owned"]); dispatchBaseline(f); f.capture(); f.change("after");
  const cwd = process.cwd();
  try {
    process.chdir(f.root);
    expect(sealCheckpointRequest({ v: 1, intent: f.intent, kind: null }).outcome).toBe("observed");
    if (changed === "index") f.fake!.set(f.root, ["ls-files", "--stage", "-z"], { stdout: `100644 ${"2".repeat(40)} 0\towned\0`, stderr: "", status: 0 });
    else {
      f.fake!.set(f.root, ["rev-parse", "HEAD"], { stdout: "2".repeat(40) + "\n", stderr: "", status: 0 });
      f.fake!.set(f.root, ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], { stdout: "2".repeat(40) + "\nmain\n", stderr: "", status: 0 });
    }
    expect(() => sealCheckpointRequest({ v: 1, intent: f.intent, kind: "unit" })).toThrow("HEAD/index changed");
    expect(existsSync(path.join(f.directory, "unit.json"))).toBe(false);
  } finally { process.chdir(cwd); }
});
test("dispatch map uses checkoutEvidence paths, absence, modes and ignored-output exclusions", () => {
  const f = fixture(["owned"]);
  writeFileSync(path.join(f.root, "deleted"), "tracked");
  f.fake!.set(f.root, ["ls-files", "--stage", "-z"], { stdout: `100644 ${"2".repeat(40)} 0\tdeleted\0`, stderr: "", status: 0 });
  const { unlinkSync } = require("node:fs"); unlinkSync(path.join(f.root, "deleted"));
  writeFileSync(path.join(f.root, ".gitignore"), "ignored\n");
  writeFileSync(path.join(f.root, "ignored"), "build");
  mkdirSync(path.join(f.root, ".pitako")); writeFileSync(path.join(f.root, ".pitako", "data"), "metadata");
  dispatchBaseline(f);
  const baseline = JSON.parse(JSON.parse(readFileSync(path.join(f.directory, "baseline.json"), "utf8")).data);
  expect(baseline.files).toEqual(checkoutSnapshot(f.root).files);
  expect(baseline.files.deleted).toBeNull();
  expect(baseline.files.owned).toEqual({ hash: sha("before"), mode: require("node:fs").statSync(path.join(f.root, "owned")).mode });
  expect(baseline.files).not.toHaveProperty("ignored");
  expect(baseline.files).not.toHaveProperty(".pitako/data");
  expect(baseline.candidate).toEqual(f.intent.baseline!);
  expect(captureBaseline({ intent: f.intent }).candidate).toEqual(f.intent.baseline!);
  writeFileSync(path.join(f.root, "owned"), "changed");
  expect(() => captureBaseline({ intent: f.intent })).toThrow("conflicts with retained original");
});
test.each(["new", "existing", "deleted", "mode", "preimage", "no-manifest"])("strict dispatch attribution rejects %s changes", mode => {
  const f = fixture();
  writeFileSync(path.join(f.root, "other"), "baseline");
  dispatchBaseline(f);
  if (mode === "preimage") writeFileSync(path.join(f.root, "owned"), "unjournaled before capture");
  if (mode !== "no-manifest") { f.capture(); f.change("after"); }
  if (mode === "new" || mode === "no-manifest") writeFileSync(path.join(f.root, "new"), "foreign");
  if (mode === "existing") writeFileSync(path.join(f.root, "other"), "foreign");
  if (mode === "deleted") require("node:fs").unlinkSync(path.join(f.root, "other"));
  if (mode === "mode") require("node:fs").chmodSync(path.join(f.root, "other"), 0o755);
  const result = f.run("unit");
  expect(result.status, result.stderr).toBe(0);
  expect(result.value).toMatchObject({ outcome: "mismatch", paths: [{ path: mode === "preimage" ? "owned" : mode === "new" || mode === "no-manifest" ? "new" : "other" }] });
  expect(existsSync(path.join(f.directory, "unit.json"))).toBe(false);
});
test("strict attribution admits same-attempt late paths and ignores build outputs", () => {
  const f = fixture(); writeFileSync(path.join(f.root, ".gitignore"), "build\n"); dispatchBaseline(f);
  f.capture(); f.change("after");
  const effect = beginHookEffect(f.intent, "write", ["late"]);
  writeFileSync(path.join(f.root, "late"), "discovered late"); closeHookEffect(f.intent, effect);
  writeFileSync(path.join(f.root, "build"), "ignored");
  const result = f.run("unit"); expect(result.status, result.stderr).toBe(0);
  expect(result.value.outcome).toBe("sealed");
});
test.each([false, true])("restoration uses restored images only for restored paths (foreign=%s)", foreign => {
  const f = fixture(); writeFileSync(path.join(f.root, "other"), "dispatch bytes");
  f.capture(); f.change("interrupted");
  const next: CheckpointIntent = { ...f.intent, key: "test.a2", attempt: 2 };
  const { head, fingerprint } = checkoutEvidence(f.root); next.baseline = { head, fingerprint };
  f.admit(next);
  captureBaseline({ intent: next });
  restoreCheckpoint(f.intent, { pending: true, stop: false, permissionDenied: false, activeWriter: null, references: ["settled"] });
  const restore = JSON.parse(JSON.parse(readFileSync(path.join(f.directory, "restore.json"), "utf8")).data);
  expect(restore.restored).toEqual([{ path: "owned", image: { bytes: Buffer.from("before").toString("base64"), mode: require("node:fs").statSync(path.join(f.root, "owned")).mode & 0o777 } }]);
  captureCheckpoint(next, ["owned"]);
  applyCheckpoint(next, [{ path: "owned", image: { bytes: Buffer.from("completed").toString("base64"), mode: 0o644 } }]);
  if (foreign) {
    writeFileSync(path.join(f.root, "other"), "foreign before capture");
    const effect = beginHookEffect(next, "edit", ["other"]); closeHookEffect(next, effect);
  }
  const result = f.run("unit", { intent: next, restoreSources: [f.intent] });
  if (foreign) {
    expect(result.status, result.stderr).toBe(0); expect(result.value).toMatchObject({ outcome: "mismatch", paths: [{ path: "other", journaled: sha("dispatch bytes"), actual: sha("foreign before capture") }] });
  } else { expect(result.status, result.stderr).toBe(0); expect(result.value.outcome).toBe("sealed"); }
});
test("controller records the actual dispatch map before launching a writer", async () => {
  const host = controller(undefined, { realCheckout: true }); host.setLimit(1);
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker") {
      const { intent } = readExecuteIntentContext(host.root, host.current());
      expect(intent.baseline).toEqual(host.observedCandidate());
      const file = path.join(host.root, ".pi/subagents/checkpoints", intent.key, "baseline.json");
      const baseline = JSON.parse(JSON.parse(readFileSync(file, "utf8")).data);
      expect(baseline.candidate).toEqual(host.observedCandidate());
      const baselineCall = host.calls.findIndex((call: any) => call.key === intent.key + ".baseline");
      expect(baselineCall).toBeGreaterThanOrEqual(0);
      expect(baselineCall).toBeLessThan(host.calls.findIndex((call: any) => call.key === request.key));
    }
    return normal();
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.history()[0].results.find((entry: any) => entry.taskId === "change1").status).toBe("complete");
});
