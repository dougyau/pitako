import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import planExecute from "../extensions/plan-execute.ts";
import { copy, cutAt, executeControllerFixture } from "./fixtures/execute-workflow.ts";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";
import { applyCheckpoint, captureCheckpoint, checkpointDirectory, prepareCheckpoint, restoreCheckpoint, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
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
test.each([
  ["complete", [], "unit"], ["continue", ["pending"], "pause"],
  ["gaps", ["pending"], "pause"], ["gaps", [], null], ["continue", [], null],
] as const)("root chooses seal kind for %s remaining=%j", async (status, remaining, expected) => {
  const host = controller(undefined, { controlledCheckpoints: true });
  host.setLimit(1);
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const value = host.worker(request);
      expect(Object.keys(request.outputSchema.properties).sort()).toEqual([
        "checks", "continuation", "diagnosis", "git", "remaining", "status", "usefulProgress", "workDone",
      ]);
      expect(request.outputSchema.properties.git.properties).toEqual({ wip: { type: "string", minLength: 1 } });
      return host.result(request, { ...value, status, remaining, usefulProgress: false });
    }
    if (request.agent === "pitako.checkpoint-sealer") {
      const input = JSON.parse(request.task);
      if (input.intent.taskId === "change1") {
        expect(input.kind).toBe(expected);
        expect(host.current().loop.attempt).toMatchObject({ stage: "launched", seal: { retry: 1 } });
        expect(host.current().loop.attempt).not.toHaveProperty("result");
      }
    }
    if (request.agent === "pitako.execution-director") expect(request.outputSchema.properties).not.toHaveProperty("association");
    return normal();
  });
  const output = await host.execute();
  expect(output.status).toBe(status === "complete" ? "complete" : "partial");
  const receipt = host.history()[0].results.find((entry: any) => entry.taskId === "change1").checkpoint.confirmation;
  if (expected) expect(receipt.kind).toBe(expected); else expect(receipt).toBeUndefined();
});

test("a declared block that breaks the result contract still halts after kind-null journal verification", async () => {
  const host = controller();
  const sealed: unknown[] = [];
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1")
      return host.result(request, { ...host.worker(request), status: "blocked", remaining: ["needs a decision"], checks: [] });
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
  const host = controller();
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const value = host.worker(request);
      const descriptor = JSON.parse(request.task.split("FROZEN ATTEMPT:\n")[1]!.split("\n")[0]!);
      const file = "src/" + descriptor.taskId + ".ts";
      mkdirSync(path.dirname(path.join(host.root, file)), { recursive: true });
      writeFileSync(path.join(host.root, file), "not journaled");
      return host.result(request, mode === "pause" ? { ...value, status: "gaps", remaining: ["pending"] }
        : mode === "rejected" ? { ...value, checks: [] } : value);
    }
    return normal();
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(host.current().loop.halt).toMatchObject({ code: "checkpoint-integrity", ref: { agent: "pitako.checkpoint-sealer" } });
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
    if (request.agent === "pitako.worker") return host.result(request, { ...host.worker(request), checks: [] });
    if (request.agent === "pitako.checkpoint-sealer") expect(JSON.parse(request.task).kind).toBeNull();
    return normal();
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.history()[0].results[0].status).toBe("rejected");
  expect(host.current().lastConfirmed).toBeNull();
});

test("root observes missing manifests and rejects a complete implementation without one", async () => {
  const host = controller(); host.setLimit(1);
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker") {
      const value = host.worker(request);
      const descriptor = JSON.parse(request.task.split("FROZEN ATTEMPT:\n")[1]!.split("\n")[0]!);
      rmSync(path.join(host.root, ".pi/subagents/checkpoints", descriptor.key), { recursive: true });
      return host.result(request, value);
    }
    return normal();
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.history()[0].results[0].rejection).toContain("lacks required sealed file/progress checkpoint");
  expect(host.current().lastConfirmed).toBeNull();
});

test.each([false, true])("inspector recovery verifies without sealing (mismatch=%s)", async mismatch => {
  const host = controller(undefined, { readOnly: true });
  let original: any;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key === "invoke-human-1.l1.t1.a1") {
      original = result.structuredOutput;
      delete result.structuredOutput;
      if (mismatch) {
        const descriptor = JSON.parse(request.task.split("FROZEN ATTEMPT:\n")[1]!.split("\n")[0]!);
        captureCheckpoint(descriptor.checkpoint, ["src/change1.ts"]);
        const file = path.join(host.root, "src/change1.ts");
        mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "foreign");
      }
    }
    if (request.agent === "pitako.execution-inspector")
      Object.assign(result.structuredOutput, { status: "recovered", workerResult: original, original: null });
    if (request.agent === "pitako.checkpoint-sealer" && JSON.parse(request.task).intent.taskId === "change1")
      expect(JSON.parse(request.task).kind).toBeNull();
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe(mismatch ? "blocked" : "complete");
  if (mismatch) {
    expect(host.current().loop.halt).toMatchObject({ code: "checkpoint-integrity", ref: { agent: "pitako.checkpoint-sealer" } });
    expect(host.current().loop.attempt).not.toHaveProperty("result");
    expect(output.reason).toContain("src/change1.ts");
  } else {
    expect(host.history()[0].results[0]).toMatchObject({ status: "complete", checks: { current: true } });
    expect(host.history()[0].results[0].checkpoint).not.toHaveProperty("confirmation");
  }
});

test("sealer retry is restored when native budget rejects dispatch", async () => {
  const host = controller(undefined, { readOnly: true });
  let rejected = false;
  host.setRespond((request, normal) => {
    if (!rejected && request.agent === "pitako.checkpoint-sealer") {
      rejected = true;
      const error = new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: `workflow[${request.key}]`, used: 64, limit: 64, requested: 1, remaining: 0 }).message;
      return { key: request.key, ok: false, error, output: error, artifactPaths: [] };
    }
    return normal();
  });
  expect((await host.execute()).status).toBe("budget-exhausted");
  expect(host.current().loop.attempt.seal.retry).toBe(0);
  expect(host.current().loop.attempt).not.toHaveProperty("result");
});

test("integrity halt holds without input; restored journaled bytes plus current input re-seal under .r1", async () => {
  const host = controller();
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
  rmSync(file); // the human returns the file to its journaled absence
  const output = await host.execute({ unblock: true, resolution: { loop: 1, text: "Returned src/change1.ts to its journaled bytes." } });
  expect(output.status, output.reason).toBe("complete");
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer" && call.key.includes(".t1.")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.seal", "invoke-human-1.l1.t1.a1.seal.r1"]);
  expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
  expect(host.current().tasks.change1.admitted).toEqual(["complete"]);
});

test("a stopped sealer admits nothing; current input reconciles it before a fresh seal admits once", async () => {
  const host = controller();
  let stopped = false;
  host.setRespond((request, normal) => {
    const result = normal();
    if (!stopped && request.agent === "pitako.checkpoint-sealer") { stopped = true; return { ...result, ok: false, stopped: true }; }
    return result;
  });
  expect((await host.execute()).status).toBe("cancelled");
  expect(host.current().loop.halt).toMatchObject({ code: "native-barrier", cause: "stopped", ref: { agent: "pitako.checkpoint-sealer" } });
  expect(host.current().loop.attempt).not.toHaveProperty("result");
  const calls = host.calls.length;
  expect((await host.execute()).status).toBe("cancelled");
  expect(host.calls).toHaveLength(calls);
  const output = await host.execute({ unblock: true, resolution: { loop: 1, text: "Continue after the sealer stop." } });
  expect(output.status, output.reason).toBe("complete");
  expect(host.statusCalls).toContain("native-invoke-human-1.l1.t1.a1.seal");
  expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
  expect(host.calls.filter(call => call.key.startsWith("invoke-human-1.l1.t1.a1.seal")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.seal", "invoke-human-1.l1.t1.a1.seal.r1"]);
  expect(host.current().tasks.change1.admitted).toEqual(["complete"]);
});

test("an active retained sealer blocks fallback and re-seal; unknown status takes the existing route", async () => {
  const host = controller();
  let active = true;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.checkpoint-sealer" && request.key === "invoke-human-1.l1.t1.a1.seal") return { ...result, ok: false, state: "running" };
    return result;
  });
  host.setStatus(ref => {
    if (ref === "invoke-human-1.l1.t1.a1.seal") {
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
  expect(host.calls.filter(call => call.key.startsWith("invoke-human-1.l1.t1.a1.seal")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.seal", "invoke-human-1.l1.t1.a1.seal.r1"]);
});

test("replay with a seal record and unknown worker status observes the sealer, falls back, and admits nothing", async () => {
  const host = controller();
  cutAt(host, value => value.loop?.attempt?.taskId === "change1" && value.loop.attempt.stage === "result");
  expect((await host.execute()).status).toBe("partial");
  expect(host.current().loop.attempt).toMatchObject({ key: "invoke-human-1.l1.t1.a1", stage: "launched", seal: { retry: 1 } });
  host.setFailSave();
  host.setStatus(ref => { throw Error(`Status '${ref}' unavailable`); });
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a2") throw Error("Controlled fallback transport stop");
    return normal();
  });
  const calls = host.calls.length;
  await host.execute();
  expect(host.statusCalls.slice(0, 1)).toEqual(["invoke-human-1.l1.t1.a1.seal"]);
  expect(host.calls.slice(calls).some(call => call.agent === "pitako.checkpoint-sealer" && call.key.startsWith("invoke-human-1.l1.t1.a1.seal"))).toBe(false);
  expect(host.current().tasks.change1.admitted).toEqual([]);
  expect(host.current().lastConfirmed).toBeNull();
  expect(host.current().loop.attempt).toMatchObject({ taskId: "change1", number: 2, restore: expect.anything() });
});
