import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkoutEvidence, checkoutSnapshot } from "../extensions/spec-plans.ts";
import planExecute from "../extensions/plan-execute.ts";
import { copy, cutAt, executeControllerFixture } from "./fixtures/execute-workflow.ts";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";
import { captureBaseline, beginHookEffect, closeHookEffect, applyCheckpoint, captureCheckpoint, checkpointDirectory, prepareCheckpoint, restoreCheckpoint, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { buildExternalCliPrompt } from "../node_modules/pi-subagents/src/runs/shared/external-cli-runner.js";
const sealerPrompt = "Fixed checkpoint sealer; stdin is a JSON {v, intent, kind, restoreSources?} request.";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const script = path.resolve("skills/execute/checkpoint.mjs");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(paths = ["owned"]) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-sealer-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-q"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "base");
  writeFileSync(path.join(root, "owned"), "before");
  const intent: CheckpointIntent = { version: 2, association: { root, commonDir: git("rev-parse", "--path-format=absolute", "--git-common-dir"), missionId: "mission", missionPath: path.join(root, "mission.json"), invocation: "test", source: path.join(root, "spec.md"), digest: "a".repeat(64), maxCycles: 3, sourceRefs: [] }, key: "test.a1", taskId: "task", attempt: 1, loop: 1, cursor: 0, phase: "implementation", planRef: {}, progress: { consumedLoops: 1, admitted: {}, previous: null } };
  const run = (kind: "unit" | "pause" | null, extra = {}, cwd = root) => {
    const result = spawnSync("node", [script, "--seal-stdin"], { cwd, encoding: "utf8",
      // The registered runtime agent's actual stdin framing, not bare JSON.
      input: buildExternalCliPrompt(sealerPrompt, JSON.stringify({ v: 1, intent, kind, ...extra })) });
    return { ...result, value: result.status === 0 ? JSON.parse(result.stdout) : undefined };
  };
  const capture = () => captureCheckpoint(intent, paths);
  const change = (value: string) => applyCheckpoint(intent, [{ path: "owned", image: { bytes: Buffer.from(value).toString("base64"), mode: 0o644 } }]);
  return { root, intent, run, capture, change, directory: checkpointDirectory(intent) };
}

test.each([null, "unit", "pause"] as const)("no manifest observes candidate without metadata (%s)", kind => {
  const f = fixture(), result = f.run(kind);
  expect(result.status, result.stderr).toBe(0);
  expect(result.value).toMatchObject({ v: 1, outcome: "observed", kind, candidate: { head: expect.any(String), fingerprint: expect.any(String) } });
  expect(existsSync(f.directory)).toBe(false);
});

test.each(["unit", "pause"] as const)("%s seals journaled bytes and identical publication is idempotent", kind => {
  const f = fixture(); f.capture(); f.change("after");
  const first = f.run(kind); expect(first.status, first.stderr).toBe(0);
  expect(first.value).toMatchObject({ outcome: "sealed", kind, position: { cursor: kind === "unit" ? 1 : 0 } });
  const bytes = readFileSync(first.value.checkpointRef, "utf8");
  expect(first.value.digest).toBe(sha(bytes));
  expect(f.run(kind).value).toEqual(first.value);
  // Unrelated checkout drift after sealing does not change the sealed content:
  // replay identifies the same seal with its sealing candidate.
  writeFileSync(path.join(f.root, "unrelated"), "drift");
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

test("invalid input, wrong cwd, corrupt artifacts and oversized output fail nonzero", () => {
  const f = fixture();
  expect(f.run(null, { v: 2 }).status).not.toBe(0);
  expect(f.run(null, {}, tmpdir()).status).not.toBe(0);
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
// These cases change real worker bytes; the controlled gate must observe them,
// rather than the fixture's unchanged synthetic candidate.
function observeGate(host: ReturnType<typeof controller>, request: any, normal: () => any) {
  const result = normal();
  if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "gate" && JSON.parse(request.task).task.id !== "final-acceptance") {
    const receipt = JSON.parse(result.output), candidate = host.observedCandidate();
    result.output = JSON.stringify({ ...receipt, before: candidate, after: candidate });
  }
  return result;
}
test.each([
  ["complete", [], "unit"], ["continue", ["pending"], "pause"],
  ["gaps", ["pending"], "pause"], ["gaps", [], "pause"], ["continue", [], "pause"],
] as const)("root chooses seal kind for %s remaining=%j", async (status, remaining, expected) => {
  const host = controller(undefined, { controlledCheckpoints: true });
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
        expect(host.current().loop.attempt).toMatchObject({ stage: "launched", close: { dispatched: true } });
        expect(host.current().loop.attempt).not.toHaveProperty("result");
      }
    }
    if (request.agent === "pitako.execution-director") expect(request.outputSchema.properties).not.toHaveProperty("association");
    return observeGate(host, request, normal);
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial"); // One slot completes the task, not the separate final phase.
  const receipt = host.history()[0].results.find((entry: any) => entry.taskId === "change1").checkpoint.confirmation;
  expect(receipt.kind).toBe(expected);
});

test("a schema-invalid declared block still halts after kind-null journal verification", async () => {
  const host = controller();
  const sealed: unknown[] = [];
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1")
      return host.result(request, { ...host.worker(request), status: "blocked", remaining: ["needs a decision"], work: null });
    if (request.agent === "pitako.checkpoint-sealer") sealed.push(JSON.parse(request.task).kind);
    return observeGate(host, request, normal);
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(sealed).toEqual([null]);
  expect(host.calls.filter((call: any) => call.agent === "pitako.worker")).toHaveLength(1);
  expect(host.current().loop.attempt).not.toHaveProperty("result");
});

test.each(["complete", "pause", "rejected"])("journal mismatch for %s blocks before admission with actionable paths", async mode => {
  const host = controller();
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
    return observeGate(host, request, normal);
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(host.current().loop.halt).toMatchObject({ code: "checkpoint-integrity",
    ref: { agent: mode === "rejected" ? "pitako.checkpoint-sealer" : "pitako.loop-io" } });
  expect(output.reason).toContain("src/change1.ts");
  expect(output.reason).toContain("journaled sha256 absence");
  expect(output.reason).toContain("last step partially applied: false");
  expect(output.reason).toContain("Return the files to their journaled bytes and resume");
  expect(output.reason).toContain("start a new mission");
  expect(host.current().loop.attempt).not.toHaveProperty("result");
  expect(host.current().tasks.change1.completed).toBeNull();
});

test("structurally rejected worker reports verify the journal without sealing", async () => {
  const host = controller(undefined, { controlledCheckpoints: true }); host.setLimit(1);
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker") return host.result(request, { ...host.worker(request), work: null });
    if (request.agent === "pitako.checkpoint-sealer") expect(JSON.parse(request.task).kind).toBeNull();
    return observeGate(host, request, normal);
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.history()[0].results[0].status).toBe("rejected");
  expect(host.current().lastConfirmed).toBeNull();
});

test("root observes missing manifests and blocks changed candidates without a journal-backed unit", async () => {
  const host = controller(); host.setLimit(1);
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker") {
      const value = host.worker(request);
      const descriptor = JSON.parse(request.task.split("PRE-WRITE CHECKPOINT INTENTION (not a backup until published):\n")[1]!.split("\n")[0]!);
      host.changeCheckout();
      rmSync(path.join(host.root, ".pi/subagents/checkpoints", descriptor.key, "manifest.json"));
      return host.result(request, value);
    }
    return observeGate(host, request, normal);
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain("candidate-drift");
  expect(host.current().loop.attempt).not.toHaveProperty("result");
  expect(host.current().lastConfirmed).toBeNull();
});

test.each([false, true])("missing implementation result restores before the next capture (written=%s)", async written => {
  const host = controller();
  let source: CheckpointIntent;
  let restored: any;
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const result = normal();
      source = host.current().loop.attempt.checkpoint;
      if (written) applyCheckpoint(source, [{ path: "src/change1.ts", image: {
        bytes: Buffer.from("interrupted owned bytes").toString("base64"), mode: 0o644,
      } }]);
      delete result.structuredOutput;
      return result;
    }
    if (request.key === "invoke-human-1.l1.t1.a2") {
      restored = restoreCheckpoint(source, host.current().loop.attempt.restore.authority);
      expect(existsSync(path.join(host.root, "src/change1.ts"))).toBe(false);
    }
    return observeGate(host, request, normal);
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
  expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
  expect(host.history()[0].results[0]).toMatchObject({ status: "complete", attempt: 2,
    checks: { current: true }, checkpoint: { confirmation: { kind: "unit" } } });
  const partial = JSON.parse(JSON.parse(readFileSync(restored.partialRef, "utf8")).data).partial;
  expect(partial[0].image).toEqual(written ? {
    bytes: Buffer.from("interrupted owned bytes").toString("base64"), mode: 0o644,
  } : null);
});

test("grouped close retry is restored when native budget rejects dispatch", async () => {
  const host = controller(undefined, { readOnly: true });
  let rejected = false;
  host.setLaunchRespond((request, normal) => {
    if (!rejected && request.key.endsWith(".close")) {
      rejected = true;
      const error = new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: `workflow[${request.key}]`, used: 64, limit: 64, requested: 1, remaining: 0 }).message;
      return { key: request.key, ok: false, error, output: error, artifactPaths: [] };
    }
    return normal();
  });
  expect((await host.execute()).status).toBe("budget-exhausted");
  expect(host.current().loop.attempt.close.retry).toBe(0);
  expect(host.current().loop.attempt).not.toHaveProperty("result");
});

test("integrity halt holds without input; repaired bytes cannot reuse a different saved gate candidate", async () => {
  const host = controller();
  const file = path.join(host.root, "src/change1.ts");
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const value = host.worker(request);
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "not journaled");
      return host.result(request, value);
    }
    return observeGate(host, request, normal);
  });
  expect((await host.execute()).status).toBe("blocked");
  const calls = host.calls.length;
  expect((await host.execute()).status).toBe("blocked");
  expect(host.calls).toHaveLength(calls);
  rmSync(file); // the human returns the file to its journaled absence
  const output = await host.execute({ unblock: true, resolution: { loop: 1, text: "Returned src/change1.ts to its journaled bytes." } });
  expect(output.status, output.reason).toBe("blocked");
  expect(output.reason).toContain("Sealer candidate differs from the saved gate receipt");
  expect(host.current().loop.attempt).not.toHaveProperty("result");
  expect(host.current().lastConfirmed).toBeNull();
  expect(host.calls.filter(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "gate")).toHaveLength(1);
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer" && call.key.includes(".t1.")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.seal", "invoke-human-1.l1.t1.a1.seal.r1"]);
  expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
  expect(host.history()[0].results.filter((entry: any) => entry.taskId === "change1")).toEqual([]);
});

test("a stopped sealer admits nothing; current input reconciles it before a fresh seal admits once", async () => {
  const host = controller();
  let stopped = false;
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (!stopped && request.key.endsWith(".close")) { stopped = true; return { ...result, ok: false, stopped: true }; }
    return result;
  });
  expect((await host.execute()).status).toBe("cancelled");
  expect(host.current().loop.halt).toMatchObject({ code: "native-barrier", cause: "stopped", ref: { agent: "pitako.loop-io" } });
  expect(host.current().loop.attempt).not.toHaveProperty("result");
  const calls = host.calls.length;
  expect((await host.execute()).status).toBe("cancelled");
  expect(host.calls).toHaveLength(calls);
  const output = await host.execute({ unblock: true, resolution: { loop: 1, text: "Continue after the sealer stop." } });
  expect(output.status, output.reason).toBe("complete");
  expect(host.statusCalls).toContain("native-invoke-human-1.l1.t1.a1.close");
  expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
  expect(host.launches.filter(call => call.key.startsWith("invoke-human-1.l1.t1.a1.close")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.close", "invoke-human-1.l1.t1.a1.close.r1"]);
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer")).toHaveLength(1);
  expect(host.history()[0].results.filter((entry: any) => entry.taskId === "change1").map((entry: any) => entry.status)).toEqual(["complete"]);
});

test("an active retained sealer blocks fallback and re-seal; unknown status takes the existing route", async () => {
  const host = controller();
  let active = true;
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.key === "invoke-human-1.l1.t1.a1.close") return { ...result, ok: false, state: "running" };
    return result;
  });
  host.setStatus(ref => {
    if (["invoke-human-1.l1.t1.a1.close", "native-invoke-human-1.l1.t1.a1.close"].includes(ref)) {
      if (active) return { ok: false, state: "running", results: [] };
      throw Error("Status unavailable");
    }
    return copy(host.native.get(ref) ?? { ok: true, output: "", results: [] });
  });
  expect((await host.execute()).status).toBe("blocked");
  const calls = host.calls.length;
  expect((await host.execute()).status).toBe("blocked");
  expect(host.calls).toHaveLength(calls);
  expect(host.current().loop.attempt).not.toHaveProperty("result");
  expect(host.current().loop.attempt.restore).toBeUndefined();
  active = false;
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
  expect(host.launches.filter(call => call.key.startsWith("invoke-human-1.l1.t1.a1.close")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.close", "invoke-human-1.l1.t1.a1.close.r1"]);
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer")).toHaveLength(1);
});

test("replay with a seal record and a retained worker result re-seals idempotently and admits it once", async () => {
  const host = controller();
  cutAt(host, value => value.loop?.attempt?.taskId === "change1" && value.loop.attempt.stage === "result");
  expect((await host.execute()).status).toBe("partial");
  expect(host.current().loop.attempt).toMatchObject({ key: "invoke-human-1.l1.t1.a1", stage: "launched", seal: { retry: 1 } });
  host.setFailSave();
  host.setStatus(ref => { throw Error(`Status '${ref}' unavailable`); });
  const calls = host.calls.length;
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  expect(host.statusCalls.slice(0, 1)).toEqual(["native-invoke-human-1.l1.t1.a1.close"]);
  expect(host.calls.slice(calls).filter(call => call.agent === "pitako.checkpoint-sealer")).toEqual([]);
  expect(host.calls.some(call => call.key === "invoke-human-1.l1.t1.a2")).toBe(false);
  expect(host.history()[0].results.filter((entry: any) => entry.taskId === "change1").map((entry: any) => entry.status)).toEqual(["complete"]);
  expect(host.history()[0].results.find((entry: any) => entry.taskId === "change1")).toMatchObject({ attempt: 1, status: "complete" });
});

test("replay with a seal record and unknown worker status observes the sealer, falls back, and admits nothing", async () => {
  const host = controller();
  cutAt(host, value => value.loop?.attempt?.taskId === "change1" && value.loop.attempt.stage === "result");
  expect((await host.execute()).status).toBe("partial");
  expect(host.current().loop.attempt).toMatchObject({ key: "invoke-human-1.l1.t1.a1", stage: "launched", seal: { retry: 1 } });
  host.setFailSave();
  // Without a retained received result the worker result is unknown.
  const retained = host.current(); delete retained.loop.attempt.received;
  host.storage.set("invoke-human-1", retained);
  host.setStatus(ref => { throw Error(`Status '${ref}' unavailable`); });
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a2") throw Error("Controlled fallback transport stop");
    return observeGate(host, request, normal);
  });
  const calls = host.calls.length;
  await host.execute();
  expect(host.statusCalls.slice(0, 1)).toEqual(["native-invoke-human-1.l1.t1.a1.close"]);
  expect(host.calls.slice(calls).some(call => call.agent === "pitako.checkpoint-sealer" && call.key.startsWith("invoke-human-1.l1.t1.a1.seal"))).toBe(false);
  expect(host.history()[0].results.filter((entry: any) => entry.taskId === "change1").map((entry: any) => entry.status)).toEqual([]);
  expect(host.current().lastConfirmed).toBeNull();
  expect(host.current().loop.attempt).toMatchObject({ taskId: "change1", number: 2, restore: expect.anything() });
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
  const f = fixture(); const seq = beginHookEffect(f.intent, "write", ["owned"]);
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
  const host = controller(); host.setLimit(1);
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const value = host.worker(request), intent = host.current().loop.attempt.checkpoint;
      expect(host.current().loop.attempt).toMatchObject({ stage: "launched", bindingKey: intent.key });
      const file = path.join(host.root, "src/change1.ts"); mkdirSync(path.dirname(file), { recursive: true });
      const first = beginHookEffect(intent, "write", ["src/change1.ts"]);
      writeFileSync(file, "first write"); closeHookEffect(intent, first);
      const late = beginHookEffect(intent, "write", ["late.ts"]);
      writeFileSync(path.join(host.root, "late.ts"), "late discovery"); closeHookEffect(intent, late);
      return host.result(request, value);
    }
    return observeGate(host, request, normal);
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1"]);
  expect(host.history()[0].results[0]).toMatchObject({ status: "complete", attempt: 1,
    checkpoint: { confirmation: { kind: "unit" } } });
  expect(readFileSync(path.join(host.root, "late.ts"), "utf8")).toBe("late discovery");
});

test("controller routes a never-closed effect to a restoring worker before admission", async () => {
  const host = controller(); host.setLimit(1);
  let source: CheckpointIntent;
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const value = host.worker(request); source = host.current().loop.attempt.checkpoint;
      beginHookEffect(source, "write", ["src/change1.ts"]);
      mkdirSync(path.join(host.root, "src"), { recursive: true });
      writeFileSync(path.join(host.root, "src/change1.ts"), "uncertain partial bytes");
      return host.result(request, value);
    }
    if (request.key === "invoke-human-1.l1.t1.a2") {
      expect(host.current().loop.attempt.restore).toBeDefined();
      const restored = restoreCheckpoint(source, host.current().loop.attempt.restore.authority);
      const partial = JSON.parse(JSON.parse(readFileSync(restored.partialRef, "utf8")).data).partial;
      expect(Buffer.from(partial[0].image.bytes, "base64").toString()).toBe("uncertain partial bytes");
      expect(existsSync(path.join(host.root, "src/change1.ts"))).toBe(false);
    }
    return observeGate(host, request, normal);
  });
  const output = await host.execute(); expect(output.status, output.reason).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
  expect(host.history()[0].results[0]).toMatchObject({ status: "complete", attempt: 2 });
});

function dispatchBaseline(f: ReturnType<typeof fixture>) {
  const { head, fingerprint } = checkoutEvidence(f.root);
  f.intent.baseline = { head, fingerprint };
  expect(captureBaseline({ intent: f.intent }).candidate).toEqual(f.intent.baseline!);
}
test("dispatch map uses checkoutEvidence paths, absence, modes and ignored-output exclusions", () => {
  const f = fixture();
  writeFileSync(path.join(f.root, "deleted"), "tracked");
  execFileSync("git", ["add", "deleted"], { cwd: f.root });
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
  const host = controller(); host.setLimit(1);
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker") {
      const attempt = host.current().loop.attempt;
      expect(attempt.checkpoint.baseline).toEqual(attempt.baseline);
      expect(host.current().loop.selection.stage).toBe("receipt");
      const file = path.join(host.root, ".pi/subagents/checkpoints", attempt.key, "baseline.json");
      const baseline = JSON.parse(JSON.parse(readFileSync(file, "utf8")).data);
      expect(baseline.candidate).toEqual(host.observedCandidate());
      expect(host.calls.findIndex((call: any) => call.key === attempt.key + ".baseline")).toBeLessThan(host.calls.findIndex((call: any) => call.key === request.key));
    }
    return observeGate(host, request, normal);
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.history()[0].results.find((entry: any) => entry.taskId === "change1").status).toBe("complete");
});
