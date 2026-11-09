import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as sdk from "@earendil-works/pi-coding-agent";
import { runToolCall } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import checkpointCreate from "../extensions/checkpoint-create.ts";
import pitako from "../extensions/index.ts";
import { captureCheckpoint, applyCheckpoint, checkpointDirectory, checkpointEvidence, restoreCheckpoint, sealCheckpoint, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { setSessionProfile } from "../extensions/profile.ts";
import { parseFrontmatter, parseFrontmatterList } from "../node_modules/pi-subagents/src/agents/frontmatter.js";
import { createDefaultChildSessionFactory } from "../node_modules/pi-subagents/src/runs/shared/child-session.js";
import { resolvePiLaunchToolPlan } from "../node_modules/pi-subagents/src/runs/shared/child-tool-plan.js";
import { createMission, missionRecordPath, resolveMissionStoreLocation } from "../node_modules/pi-subagents/src/missions/store.js";
import { createMissionWorkflowState } from "../node_modules/pi-subagents/src/missions/workflow-state.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const repo = path.resolve(import.meta.dir, "..");
const digest = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const artifact = (p: string) => { const v = JSON.parse(readFileSync(p, "utf8")); expect(digest(v.data)).toBe(v.sha256); return JSON.parse(v.data); };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-checkpoint-create-")); roots.push(root);
  const git = (...args: string[]) => { const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
  git("init", "--quiet"); writeFileSync(path.join(root, "modified"), "committed\n");
  git("add", "modified"); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Base");
  writeFileSync(path.join(root, "modified"), "prior uncommitted WIP\n");
  writeFileSync(path.join(root, "untracked"), "new untracked bytes\n");
  const location = resolveMissionStoreLocation({ projectRoot: root, agentDir: path.join(root, ".pi", "subagents", "agent") });
  const mission = createMission(location, { title: "Checkpoint fixture", objective: "Capture the pending writer unit" });
  const missionPath = missionRecordPath(location, mission.id);
  const state = createMissionWorkflowState(location, mission.id);
  const association = { root, commonDir: git("rev-parse", "--path-format=absolute", "--git-common-dir"), missionId: mission.id, missionPath,
    invocation: "fixture", source: path.join(root, "spec.md"), digest: "a".repeat(64), maxCycles: 5, sourceRefs: [] };
  const intent: CheckpointIntent = { version: 2, association, key: "invoke-fixture.l1.t1.a1", taskId: "owned", attempt: 1,
    loop: 1, cursor: 0, phase: "implementation", planRef: { key: "plan", runId: "director" },
    progress: { consumedLoops: 1, admitted: {}, previous: null } };
  const loop = { number: 1, kind: "task", task: { id: "owned" }, phase: "implementation", cursor: 0, manifest: ["owned"], results: [], plan: { stage: "admitted", ref: intent.planRef },
    attempt: { key: intent.key, taskId: "owned", index: 0, number: 1, stage: "intention", checkpoint: intent } };
  const record = { version: 6, association, loop, consumedLoops: 1, tasks: {}, lastConfirmed: null };
  const persist = () => state.set("invoke-fixture", record); persist();
  const binding = JSON.stringify({ "pitako.checkpoint/1": { association, key: intent.key } });
  let tool: any;
  const handlers = new Map<string, Function>();
  const old = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  try { process.env.PI_SUBAGENT_EXTENSION_BINDINGS = binding; checkpointCreate({ on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool(t: any) { tool = t; } } as unknown as ExtensionAPI); }
  finally { if (old === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS; else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = old; }
  const manager = {};
  const call = async (kind: string, paths?: string[], signal?: AbortSignal) => (await tool.execute("call", { kind, ...(paths ? { paths } : {}) }, signal, undefined, { cwd: root, sessionManager: manager })).structuredContent;
  return { root, git, intent, loop, record, persist, statePath: state.path, binding, call, tool, manager, handlers };
}
const paths = ["modified", "untracked", "absent"];

test("registered checkpoint_create captures actual WIP, untracked bytes, absence and admitted progress; repeats without overwrite", async () => {
  const f = fixture(), beforeState = readFileSync(f.statePath, "utf8");
  const beforeMission = readFileSync(f.intent.association.missionPath, "utf8");
  expect(JSON.parse(beforeMission)).not.toHaveProperty("invoke-fixture");
  expect(f.tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  const first = await f.call("pre", paths);
  expect(first).toMatchObject({ ok: true, status: "created", kind: "pre", confirmed: false, position: { cursor: 0 }, progress: { consumedLoops: 1, admitted: {}, previous: null } });
  expect(first.files).toEqual([
    { path: "modified", exists: true, sha256: digest("prior uncommitted WIP\n"), mode: statSync(path.join(f.root, "modified")).mode & 0o777 },
    { path: "untracked", exists: true, sha256: digest("new untracked bytes\n"), mode: statSync(path.join(f.root, "untracked")).mode & 0o777 },
    { path: "absent", exists: false, sha256: null, mode: null },
  ]);
  const manifest = artifact(first.manifestRef), bytes = readFileSync(first.manifestRef);
  expect(manifest.intent).toEqual(f.intent);
  expect(Buffer.from(manifest.files[0].image.bytes, "base64").toString()).toBe("prior uncommitted WIP\n");
  expect(manifest.files[2].image).toBeNull();
  expect(await f.call("pre", paths)).toEqual({ ...first, status: "existing" });
  expect(await f.call("pre", ["modified"])).toMatchObject({ ok: false, status: "failed" });
  writeFileSync(path.join(f.root, "modified"), "unrelated conflict");
  expect(await f.call("pre", paths)).toMatchObject({ ok: false });
  expect(readFileSync(first.manifestRef)).toEqual(bytes);
  expect(readFileSync(f.statePath, "utf8")).toBe(beforeState);
  expect(readFileSync(f.intent.association.missionPath, "utf8")).toBe(beforeMission);
});

test.each(["valid", "previous", "pending-budget", "seal-budget", "stopped", "stale"])(
  "registered later-loop first capture validates previous unit: %s", async mode => {
    const f = fixture();
    const earlier = structuredClone(f.intent);
    earlier.key += ".previous";
    if (mode === "seal-budget") earlier.progress!.consumedLoops = 2;
    captureCheckpoint(earlier, paths);
    const seal = sealCheckpoint(earlier, "unit", true);
    const resultRef = { key: "previous-result", runId: "previous-worker" };
    (f.record as any).lastConfirmed = { ...seal, kind: "unit", taskId: earlier.taskId,
      attempt: earlier.attempt, resultRef };
    f.intent.loop = f.loop.number = f.record.consumedLoops = 2;
    f.intent.progress = { consumedLoops: 2, admitted: {}, previous: {
      taskId: earlier.taskId, attempt: earlier.attempt, resultRef,
      checkpointRef: seal.checkpointRef, digest: seal.digest } };
    if (mode === "previous") f.intent.progress.previous!.resultRef = { key: "wrong" };
    if (mode === "pending-budget") f.record.consumedLoops = f.intent.progress.consumedLoops = 3;
    if (mode === "stopped") (f.loop as any).halt = { code: "stop" };
    if (mode === "stale") f.loop.attempt.stage = "result";
    f.persist();
    const beforeState = readFileSync(f.statePath, "utf8");
    const outcome = await f.call("pre", paths);
    expect(outcome.ok).toBe(mode === "valid");
    expect(existsSync(path.join(checkpointDirectory(f.intent), "manifest.json"))).toBe(mode === "valid");
    if (mode === "valid") expect(artifact(outcome.manifestRef).intent.progress).toEqual(f.intent.progress);
    expect(readFileSync(f.statePath, "utf8")).toBe(beforeState);
    expect(readFileSync(path.join(f.root, "modified"), "utf8")).toBe("prior uncommitted WIP\n");
  });

test.each(["unit", "pause"] as const)("worker cannot publish a %s seal, with or without pre-capture", async kind => {
  const f = fixture();
  expect(f.tool.parameters.properties.kind).toEqual({ type: "string", const: "pre" });
  expect(await f.call(kind)).toMatchObject({ ok: false, error: { message: "checkpoint_create accepts only kind pre; the execute root seals settled work." } });
  expect(existsSync(checkpointDirectory(f.intent))).toBe(false);
  const pre = await f.call("pre", paths), state = readFileSync(f.statePath, "utf8");
  applyCheckpoint(f.intent, [{ path: "modified", image: { bytes: Buffer.from("owned change").toString("base64"), mode: 0o644 } }]);
  expect(await f.call(kind)).toMatchObject({ ok: false });
  expect(existsSync(path.join(checkpointDirectory(f.intent), `${kind}.json`))).toBe(false);
  expect(readFileSync(f.statePath, "utf8")).toBe(state);
  expect(artifact(pre.manifestRef).intent.progress.admitted).toEqual({});
});

test("a tool publication remains a usable existing rollback source with unknown historical writer status", async () => {
  const f = fixture(); const pre = await f.call("pre", paths);
  applyCheckpoint(f.intent, [{ path: "modified", image: { bytes: Buffer.from("partial").toString("base64"), mode: 0o644 } },
    { path: "absent", image: { bytes: Buffer.from("new").toString("base64"), mode: 0o644 } }]);
  const restored = restoreCheckpoint(f.intent, { pending: true, stop: false, permissionDenied: false, activeWriter: null, references: [pre.checkpointRef] });
  expect(restored.position.cursor).toBe(0);
  expect(readFileSync(path.join(f.root, "modified"), "utf8")).toBe("prior uncommitted WIP\n");
  expect(existsSync(path.join(f.root, "absent"))).toBe(false);
  expect(readFileSync(path.join(f.root, "untracked"), "utf8")).toBe("new untracked bytes\n");
  expect(artifact(restored.partialRef).partial[0].image.bytes).toBe(Buffer.from("partial").toString("base64"));
});

// Rejects using a nominal intention, foreign/unadmitted seal, or the unit's
// preimages as the next task's baseline. Only the root seals metadata.
test.each(["valid", "cross-loop", "cross-loop-intervening", "cross-loop-admitted", "cross-loop-budget", "cross-loop-candidate", "missing", "foreign", "unadmitted", "corrupt", "conflict", "newer-corrupt", "previous-ref", "previous-digest", "previous-checkpoint", "previous-attempt", "cursor", "plan"])(
  "root-sealed admitted unit supplies postimages before the next capture: %s", async mode => {
    const f = fixture();
    await f.call("pre", paths);
    applyCheckpoint(f.intent, [{ path: "modified", image: { bytes: Buffer.from("confirmed WIP").toString("base64"), mode: 0o640 } },
      { path: "absent", image: { bytes: Buffer.from("created by confirmed unit").toString("base64"), mode: 0o644 } }]);
    const receipt = sealCheckpoint(f.intent, "unit", true);
    const ref = { key: f.intent.key, runId: "actual-unit-producer" };
    const result = { taskId: f.intent.taskId, attempt: 1, status: "complete", ref };
    const pending: CheckpointIntent = { ...f.intent, key: "invoke-fixture.l1.t2.a1", taskId: "next", cursor: 1,
      progress: { consumedLoops: 1, admitted: { owned: ["complete"] }, previous: { taskId: result.taskId, attempt: result.attempt, resultRef: ref, checkpointRef: receipt.checkpointRef, digest: receipt.digest } } };
    if (mode.startsWith("cross-loop")) {
      Object.assign(pending, { loop: 3, cursor: 0, key: "invoke-fixture.l3.t1.a1", planRef: { key: "next-director" } });
      pending.progress!.consumedLoops = 3; pending.progress!.admitted = {};
      if (mode === "cross-loop-intervening") pending.progress!.previous!.resultRef = { key: "intervening-unit" };
      if (mode === "cross-loop-admitted") pending.progress!.admitted = { intervening: ["complete"] };
      if (mode === "cross-loop-budget") pending.progress!.consumedLoops = 2;
    }
    const confirmedUnit = { ...receipt, kind: "unit" as const, taskId: result.taskId, attempt: result.attempt, resultRef: ref };
    const authority = { pending: true, stop: false, permissionDenied: false, activeWriter: null, references: [receipt.checkpointRef], confirmedUnit };
    if (mode === "cross-loop-candidate") confirmedUnit.candidate = { ...confirmedUnit.candidate, fingerprint: "0".repeat(64) };
    const originalSeal = readFileSync(receipt.checkpointRef);
    if (mode === "missing") rmSync(receipt.checkpointRef);
    if (mode === "corrupt") writeFileSync(receipt.checkpointRef, "corrupt seal");
    if (mode === "foreign") pending.association = { ...pending.association, invocation: "foreign" };
    if (mode === "unadmitted") pending.progress!.previous = null;
    if (mode === "previous-ref") pending.progress!.previous!.resultRef = { key: "other" };
    if (mode === "previous-digest") pending.progress!.previous!.digest = "0".repeat(64);
    if (mode === "previous-checkpoint") pending.progress!.previous!.checkpointRef += ".other";
    if (mode === "previous-attempt") pending.progress!.previous!.attempt++;
    if (mode === "cursor") pending.cursor++;
    if (mode === "plan") pending.planRef = { key: "other-plan" };
    if (mode === "conflict") writeFileSync(path.join(f.root, "modified"), "unattributed edit");
    if (mode === "newer-corrupt") {
      // Use the real shared capture, then damage its publication: absence-only
      // fallback must never hide this newer source behind the valid unit.
      const { captureCheckpoint } = await import("../extensions/execute-checkpoint.ts");
      captureCheckpoint(pending, ["modified"]);
      writeFileSync(path.join(checkpointDirectory(pending), "manifest.json"), "corrupt newer manifest");
    }
    const observe = () => checkpointEvidence([pending], pending.progress!, confirmedUnit);
    if (!["valid", "cross-loop"].includes(mode)) {
      expect(observe).toThrow(); expect(() => restoreCheckpoint(pending, authority)).toThrow();
      expect(readFileSync(path.join(f.root, "modified"), "utf8")).toBe(mode === "conflict" ? "unattributed edit" : "confirmed WIP");
      expect(existsSync(path.join(checkpointDirectory(f.intent), "restore.json"))).toBe(false);
      return;
    }
    expect(observe()).toMatch(/^[a-f0-9]{64}$/);
    const restored = restoreCheckpoint(pending, authority);
    expect(restored.position).toEqual({ loop: pending.loop, cursor: pending.cursor, phase: "implementation" });
    expect(restored.confirmedUnit).toEqual({ checkpointRef: receipt.checkpointRef, digest: receipt.digest });
    expect(readFileSync(path.join(f.root, "modified"), "utf8")).toBe("confirmed WIP");
    expect(statSync(path.join(f.root, "modified")).mode & 0o777).toBe(0o640);
    expect(readFileSync(path.join(f.root, "absent"), "utf8")).toBe("created by confirmed unit");
    expect(readFileSync(path.join(f.root, "untracked"), "utf8")).toBe("new untracked bytes\n");
    expect(artifact(restored.partialRef).partial[0].image.bytes).toBe(Buffer.from("confirmed WIP").toString("base64"));
    expect(restoreCheckpoint(pending, authority)).toEqual(restored);
    expect(observe()).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(receipt.checkpointRef)).toEqual(originalSeal);
    expect(existsSync(path.join(checkpointDirectory(pending), "manifest.json"))).toBe(false);
  });

test.each(["missing", "malformed", "metadata-only", "association", "progress", "attempt", "stopped", "v4", "v5"])(
  "invalid durable writer context cannot publish: %s", async mode => {
    const f = fixture();
    if (mode === "v4" || mode === "v5") (f.record as any).version = Number(mode.slice(1));
    if (mode === "association") f.record.association = { ...f.record.association, invocation: "other" };
    if (mode === "progress") f.loop.attempt.checkpoint.progress!.consumedLoops = 2;
    if (mode === "attempt") f.loop.attempt.key = "other";
    if (mode === "stopped") (f.loop as any).halt = { code: "stop", reason: "native Stop" };
    f.persist();
    if (mode === "missing") rmSync(f.statePath);
    if (mode === "malformed") writeFileSync(f.statePath, "{");
    if (mode === "metadata-only") {
      writeFileSync(f.intent.association.missionPath, JSON.stringify({ "invoke-fixture": f.record }));
      writeFileSync(f.statePath, "{}");
    }
    const result = await f.call("pre", paths);
    expect(result).toMatchObject({ ok: false, status: "failed" });
    if (mode === "v4" || mode === "v5") expect(JSON.stringify(result)).toContain(`created by an incompatible Pitako contract ${mode}; start a new mission`);
    expect(existsSync(checkpointDirectory(f.intent))).toBe(false);
    expect(readFileSync(path.join(f.root, "modified"), "utf8")).toBe("prior uncommitted WIP\n");
  });

test("missing, foreign and analysis context cannot publish; aborted calls cannot capture", async () => {
  const f = fixture();
  const abort = new AbortController(); abort.abort(new Error("Stop before capture"));
  expect(await f.call("pre", paths, abort.signal)).toMatchObject({ ok: false, error: { message: "Stop before capture" } });
  expect(existsSync(checkpointDirectory(f.intent))).toBe(false);
  setSessionProfile(f.manager, "analysis");
  expect(await f.call("pre", paths)).toMatchObject({ ok: false, error: { message: "Pitako analysis forbids checkpoint_create." } });
  setSessionProfile(f.manager, "coding");
  expect(existsSync(checkpointDirectory(f.intent))).toBe(false);
  for (const binding of [undefined, f.binding]) {
    let tool: any;
    const old = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    try {
      if (binding === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
      else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = binding;
      checkpointCreate({ on() {}, registerTool(t: any) { tool = t; } } as unknown as ExtensionAPI);
    } finally { if (old === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS; else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = old; }
    expect(process.env.PI_SUBAGENT_EXTENSION_BINDINGS).toBe(old);
    const rejected = await tool.execute("context", { kind: "pre", paths }, undefined, undefined,
      { cwd: binding === undefined ? f.root : path.join(f.root, "foreign"), sessionManager: {} });
    expect(rejected.structuredContent).toMatchObject({ ok: false, error: { message: binding === undefined
      ? "Missing native checkpoint execution context." : "Checkpoint execution workspace mismatch." } });
    expect(existsSync(checkpointDirectory(f.intent))).toBe(false);
  }
});

test("failed publication and conflicting effects cannot produce a seal or replace a confirmed artifact", async () => {
  const f = fixture(), directory = checkpointDirectory(f.intent);
  mkdirSync(path.join(directory, "manifest.json"), { recursive: true });
  expect(await f.call("pre", paths)).toMatchObject({ ok: false });
  expect(existsSync(path.join(directory, "unit.json"))).toBe(false);
  rmSync(path.join(directory, "manifest.json"), { recursive: true });
  const pre = await f.call("pre", paths);
  writeFileSync(path.join(f.root, "modified"), "unattributed foreign edit");
  expect(await f.call("unit")).toMatchObject({ ok: false });
  expect(() => sealCheckpoint(f.intent, "unit", true)).toThrow("Cannot seal incomplete or conflicting checkpoint effects.");
  expect(digest(readFileSync(pre.checkpointRef))).toBe(pre.digest);
  expect(existsSync(path.join(directory, "unit.json"))).toBe(false);
});

const assistant: AssistantMessage = { role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "fixture",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse", timestamp: 0 };
test("native loaded writer composition invokes directly and through codemode; inactive analysis registration is denied", async () => {
  const f = fixture(); let session!: sdk.AgentSession;
  const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({ ...sdk, async createAgentSession(options: Parameters<typeof sdk.createAgentSession>[0]) {
    const result = await sdk.createAgentSession(options); session = result.session; return result;
  } }) });
  const worker = parseFrontmatter(readFileSync(path.join(repo, "agents/worker.md"), "utf8")).frontmatter;
  const extensionPaths = parseFrontmatterList(worker.subagentOnlyExtensions)!.map(p => path.resolve(repo, "agents", p)).filter(p => p.endsWith("/extensions/checkpoint-create.ts"));
  expect(extensionPaths).toEqual([path.join(repo, "extensions/checkpoint-create.ts")]);
  const plan = resolvePiLaunchToolPlan({ cwd: f.root, agentName: "pitako.worker", tools: parseFrontmatterList(worker.tools), fast: false });
  expect(plan.effectiveToolAllowlist).not.toContain("checkpoint_create");
  expect(readFileSync(path.join(repo, "agents/worker.md"), "utf8")).not.toContain("checkpoint_create");
  // Retain direct legacy library/tool coverage with an explicit test-only allowlist.
  plan.effectiveToolAllowlist.push("checkpoint_create");
  const child = await factory.create({ cwd: f.root, projectTrusted: true, storage: { kind: "memory" },
    tools: plan.effectiveToolAllowlist, ambientExtensions: false, extensionPaths,
    hooks: [{ name: "owned-policy", factory: pitako }], noSkills: true, noContextFiles: true,
    processEnv: { PI_SUBAGENT_EXTENSION_BINDINGS: f.binding, PITAKO_PROFILE: "coding", PI_CODING_AGENT_DIR: path.join(f.root, "private-agent") }, restoreProcessEnv: true,
    runtime: { agent: "pitako.worker", fanoutChild: false, depth: 1, fast: false, waitTool: { enabled: false } } });
  const call = async (name: string, args: JsonObject) => {
    session.agent.state.messages = [assistant];
    return runToolCall({ type: "toolCall", id: "native-call", name, arguments: args }, { tools: session.agent.state.tools,
      assistantMessage: assistant, context: { messages: session.agent.state.messages, tools: session.agent.state.tools },
      beforeToolCall: session.agent.beforeToolCall, afterToolCall: session.agent.afterToolCall });
  };
  const text = (v: Awaited<ReturnType<typeof call>>) => v.result.content.map(p => p.type === "text" ? p.text : "").join("\n");
  try {
    const pre = await call("checkpoint_create", { kind: "pre", paths });
    expect(pre.isError, text(pre)).toBe(false);
    expect(pre.result.structuredContent).toMatchObject({ ok: true, status: "created" });
    const nested = await call("codemode", { code: `const result = await tools.checkpoint_create({kind:"pre",paths:${JSON.stringify(paths)}}); if (!result.ok || result.status !== "existing") throw new Error(JSON.stringify(result)); return result;` });
    expect(nested.isError, text(nested)).toBe(false); expect(text(nested)).toContain('"confirmed":false');
    setSessionProfile(session.sessionManager, "analysis");
    for (const name of ["checkpoint_create", "codemode"]) {
      const denied = await call(name, name === "codemode" ? { code: `await tools.checkpoint_create({kind:"pre",paths:["modified"]});` } : { kind: "pre", paths: ["modified"] });
      expect(denied.isError, text(denied)).toBe(true); expect(text(denied)).toContain("Pitako analysis forbids checkpoint_create");
    }
    session.setActiveToolsByName(session.getAllTools().map(t => t.name).filter(name => name !== "checkpoint_create"));
    const inactive = await call("checkpoint_create", { kind: "pause" });
    expect(inactive.isError).toBe(true);
    expect(text(inactive)).toContain("Tool checkpoint_create not found");
    const deferred = await call("codemode", { code: `await tools.checkpoint_create({kind:"pre",paths:["modified"]});` });
    expect(deferred.isError, text(deferred)).toBe(true);
    expect(text(deferred)).toContain("tools.checkpoint_create does not exist");
    expect(existsSync(path.join(checkpointDirectory(f.intent), "pause.json"))).toBe(false);
    const inspector = parseFrontmatter(readFileSync(path.join(repo, "agents/execution-inspector.md"), "utf8")).frontmatter;
    expect(parseFrontmatterList(inspector.tools)).not.toContain("checkpoint_create");
    expect(inspector.subagentOnlyExtensions ?? "").not.toContain("checkpoint-create");
  } finally { await child.dispose(); await factory.dispose(); }
});


test("journal image property order cannot turn owned writes into conflicts", async () => {
  const f = fixture(); await f.call("pre", paths);
  applyCheckpoint(f.intent, [{ path: "modified", image: { mode: 0o640, bytes: Buffer.from("first").toString("base64") } }]);
  applyCheckpoint(f.intent, [{ path: "modified", image: { bytes: Buffer.from("second").toString("base64"), mode: 0o640 } }]);
  expect(sealCheckpoint(f.intent, "unit", true)).toMatchObject({ kind: "unit" });
  expect(readFileSync(path.join(f.root, "modified"), "utf8")).toBe("second");
});

test("capture failure and actual filesystem write denial publish no valid checkpoint", async () => {
  const f = fixture(), directory = checkpointDirectory(f.intent);
  mkdirSync(path.join(f.root, "not-a-file"));
  expect(await f.call("pre", [...paths, "not-a-file"])).toMatchObject({ ok: false });
  expect(existsSync(path.join(directory, "manifest.json"))).toBe(false);
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o500);
  try {
    const denied = await f.call("pre", paths);
    expect(denied).toMatchObject({ ok: false });
    expect(denied.error.message).toContain("EACCES");
    expect(existsSync(path.join(directory, "manifest.json"))).toBe(false);
  } finally { chmodSync(directory, 0o700); }
  expect(await f.call("pre", paths)).toMatchObject({ ok: true, status: "created" });
});


test("interruption at atomic publication leaves only temporary bytes and cannot move confirmation", async () => {
  const f = fixture(), directory = checkpointDirectory(f.intent);
  const state = readFileSync(f.statePath);
  const original = fs.linkSync;
  const publish = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
    if (String(destination) === path.join(directory, "manifest.json")) throw new Error("Interrupted manifest publication");
    return original(source, destination);
  });
  try {
    expect(await f.call("pre", paths)).toMatchObject({ ok: false, error: { message: "Interrupted manifest publication" } });
    expect(existsSync(path.join(directory, "manifest.json"))).toBe(false);
    expect(await f.call("unit")).toMatchObject({ ok: false });
  } finally { publish.mockRestore(); }
  const pre = await f.call("pre", paths);
  expect(pre).toMatchObject({ ok: true, status: "created" });
  expect(await f.call("pause")).toMatchObject({ ok: false });
  expect(existsSync(path.join(directory, "pause.json"))).toBe(false);
  expect(digest(readFileSync(pre.manifestRef))).toBe(pre.digest);
  expect(readFileSync(f.statePath)).toEqual(state);
});

test("native inspector composition cannot discover or invoke checkpoint writes", async () => {
  const f = fixture(); let session!: sdk.AgentSession;
  const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({ ...sdk, async createAgentSession(options: Parameters<typeof sdk.createAgentSession>[0]) {
    const result = await sdk.createAgentSession(options); session = result.session; return result;
  } }) });
  const inspector = parseFrontmatter(readFileSync(path.join(repo, "agents/execution-inspector.md"), "utf8")).frontmatter;
  const plan = resolvePiLaunchToolPlan({ cwd: f.root, agentName: "pitako.execution-inspector", tools: parseFrontmatterList(inspector.tools), fast: false });
  const child = await factory.create({ cwd: f.root, projectTrusted: true, storage: { kind: "memory" },
    tools: plan.effectiveToolAllowlist, ambientExtensions: false,
    extensionPaths: parseFrontmatterList(inspector.subagentOnlyExtensions)!.map(p => path.resolve(repo, "agents", p)),
    hooks: [{ name: "owned-policy", factory: pitako }], noSkills: true, noContextFiles: true,
    processEnv: { PI_SUBAGENT_EXTENSION_BINDINGS: f.binding, PITAKO_PROFILE: "analysis", PI_CODING_AGENT_DIR: path.join(f.root, "private-inspector") }, restoreProcessEnv: true,
    runtime: { agent: "pitako.execution-inspector", fanoutChild: false, depth: 1, fast: false, waitTool: { enabled: false } } });
  try {
    expect(session.getAllTools().map(t => t.name)).not.toContain("checkpoint_create");
    for (const name of ["checkpoint_create", "codemode"]) {
      session.agent.state.messages = [assistant];
      const denied = await runToolCall({ type: "toolCall", id: "inspector-denied", name,
        arguments: name === "codemode" ? { code: `await tools.checkpoint_create({kind:"pre",paths:["modified"]});` } : { kind: "pre", paths: ["modified"] } },
        { tools: session.agent.state.tools, assistantMessage: assistant,
          context: { messages: session.agent.state.messages, tools: session.agent.state.tools },
          beforeToolCall: session.agent.beforeToolCall, afterToolCall: session.agent.afterToolCall });
      expect(denied.isError).toBe(true);
    }
    expect(existsSync(checkpointDirectory(f.intent))).toBe(false);
    expect(readFileSync(path.join(f.root, "modified"), "utf8")).toBe("prior uncommitted WIP\n");
  } finally { await child.dispose(); await factory.dispose(); }
});

// v3 hashes flattened logical pairs, not the references or attempts in history.
test("checkpoint evidence hashes logical admitted pairs independent of order", async () => {
  const f = fixture();
  await f.call("pre", paths);
  applyCheckpoint(f.intent, [{ path: "modified", image: { bytes: Buffer.from("owned change").toString("base64"), mode: 0o644 } }]);
  const progress = { consumedLoops: 1, admitted: { first: ["complete"], second: ["blocked", "continue"] } };
  const expected = checkpointEvidence([f.intent], progress);
  expect(checkpointEvidence([f.intent], { ...progress, admitted: { second: ["continue", "blocked"], first: ["complete"] } })).toBe(expected);
  expect(checkpointEvidence([f.intent], { ...progress, admitted: { first: ["complete"] } })).not.toBe(expected);
  expect(checkpointEvidence([f.intent], { ...progress, consumedLoops: 2 })).not.toBe(expected);
});


test("turn-end context peaks persist only maxima under the current attempt, without product writes", async () => {
  const f = fixture();
  f.loop.attempt.stage = "launched";
  (f.loop.attempt as any).bindingKey = f.intent.key;
  f.persist();
  const sample = f.handlers.get("turn_end")!;
  const ctx = (tokens: number | null | undefined) => ({ cwd: f.root, getContextUsage: () => tokens === undefined ? undefined : { tokens } });
  await sample({}, ctx(undefined));
  expect(existsSync(checkpointDirectory(f.intent))).toBe(false);
  await sample({}, ctx(700)); await sample({}, ctx(400)); await sample({}, ctx(null)); await sample({}, ctx(900));
  const directory = checkpointDirectory(f.intent);
  expect(artifact(path.join(directory, "context-peak-700.json"))).toEqual({ intent: f.intent, tokens: 700 });
  expect(artifact(path.join(directory, "context-peak-900.json"))).toEqual({ intent: f.intent, tokens: 900 });
  expect(existsSync(path.join(directory, "context-peak-400.json"))).toBe(false);
  expect(readFileSync(path.join(f.root, "modified"), "utf8")).toBe("prior uncommitted WIP\n");
  (f.loop.attempt as any).bindingKey = "stale"; f.persist();
  expect(() => sample({}, ctx(1000))).toThrow("stale");
  expect(existsSync(path.join(directory, "context-peak-1000.json"))).toBe(false);
});
