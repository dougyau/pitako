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
import { applyCheckpoint, checkpointDirectory, checkpointEvidence, restoreCheckpoint, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
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
  const intent: CheckpointIntent = { version: 1, association, key: "invoke-fixture.l1.t1.a1", taskId: "owned", attempt: 1,
    loop: 1, cursor: 0, phase: "implementation", planRef: { key: "plan", runId: "director" },
    progress: { consumedLoops: 1, admittedResults: [] } };
  const loop = { number: 1, phase: "implementation", cursor: 0, manifest: ["owned", "next"], results: [], plan: { stage: "admitted", ref: intent.planRef },
    attempt: { key: intent.key, taskId: "owned", index: 0, number: 1, stage: "intention", checkpoint: intent } };
  const record = { version: 3, association, loops: [loop] };
  const persist = () => state.set("invoke-fixture", record); persist();
  const binding = JSON.stringify({ "pitako.checkpoint/1": { association, key: intent.key } });
  let tool: any;
  const old = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  try { process.env.PI_SUBAGENT_EXTENSION_BINDINGS = binding; checkpointCreate({ registerTool(t: any) { tool = t; } } as ExtensionAPI); }
  finally { if (old === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS; else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = old; }
  const manager = {};
  const call = async (kind: string, paths?: string[], signal?: AbortSignal) => (await tool.execute("call", { kind, ...(paths ? { paths } : {}) }, signal, undefined, { cwd: root, sessionManager: manager })).structuredContent;
  return { root, git, intent, loop, record, persist, statePath: state.path, binding, call, tool, manager };
}
const paths = ["modified", "untracked", "absent"];

test("registered checkpoint_create captures actual WIP, untracked bytes, absence and admitted progress; repeats without overwrite", async () => {
  const f = fixture(), beforeState = readFileSync(f.statePath, "utf8");
  const beforeMission = readFileSync(f.intent.association.missionPath, "utf8");
  expect(JSON.parse(beforeMission)).not.toHaveProperty("invoke-fixture");
  expect(f.tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  const first = await f.call("pre", paths);
  expect(first).toMatchObject({ ok: true, status: "created", kind: "pre", confirmed: false, position: { cursor: 0 }, progress: { consumedLoops: 1, admittedResults: [] } });
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

test.each(["unit", "pause"] as const)("%s seal has actual journaled bytes but no task admission or root cursor effect", async kind => {
  const f = fixture(); const pre = await f.call("pre", paths), state = readFileSync(f.statePath, "utf8");
  applyCheckpoint(f.intent, [{ path: "modified", image: { bytes: Buffer.from("owned change").toString("base64"), mode: 0o644 } }]);
  const sealed = await f.call(kind);
  expect(sealed).toMatchObject({ ok: true, confirmed: false, kind, position: { cursor: kind === "unit" ? 1 : 0 }, checkpointReceipt: { kind } });
  expect(Buffer.from(artifact(sealed.checkpointRef).files[0].image.bytes, "base64").toString()).toBe("owned change");
  expect(sealed.checkpointReceipt.digest).toBe(digest(readFileSync(sealed.checkpointRef)));
  expect((await f.call(kind)).status).toBe("existing");
  expect(readFileSync(f.statePath, "utf8")).toBe(state);
  expect(artifact(pre.manifestRef).intent.progress.admittedResults).toEqual([]);
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
// preimages as the next task's baseline. The seal is an actual registered call.
test.each(["valid", "missing", "foreign", "unadmitted", "corrupt", "conflict", "newer-corrupt"])(
  "tool-published admitted unit supplies postimages before the next capture: %s", async mode => {
    const f = fixture();
    await f.call("pre", paths);
    applyCheckpoint(f.intent, [{ path: "modified", image: { bytes: Buffer.from("confirmed WIP").toString("base64"), mode: 0o640 } },
      { path: "absent", image: { bytes: Buffer.from("created by confirmed unit").toString("base64"), mode: 0o644 } }]);
    const sealed = await f.call("unit"), receipt = sealed.checkpointReceipt;
    expect(sealed.ok).toBe(true);
    const ref = { key: f.intent.key, runId: "actual-unit-producer" };
    const result = { taskId: f.intent.taskId, attempt: 1, status: "complete", ref };
    const pending: CheckpointIntent = { ...f.intent, key: "invoke-fixture.l1.t2.a1", taskId: "next", cursor: 1,
      progress: { consumedLoops: 1, admittedResults: [result] } };
    const confirmedUnit = { ...receipt, taskId: result.taskId, attempt: result.attempt, resultRef: ref };
    const authority = { pending: true, stop: false, permissionDenied: false, activeWriter: null, references: [receipt.checkpointRef], confirmedUnit };
    const originalSeal = readFileSync(receipt.checkpointRef);
    if (mode === "missing") rmSync(receipt.checkpointRef);
    if (mode === "corrupt") writeFileSync(receipt.checkpointRef, "corrupt seal");
    if (mode === "foreign") pending.association = { ...pending.association, invocation: "foreign" };
    if (mode === "unadmitted") pending.progress!.admittedResults = [];
    if (mode === "conflict") writeFileSync(path.join(f.root, "modified"), "unattributed edit");
    if (mode === "newer-corrupt") {
      // Use the real shared capture, then damage its publication: absence-only
      // fallback must never hide this newer source behind the valid unit.
      const { captureCheckpoint } = await import("../extensions/execute-checkpoint.ts");
      captureCheckpoint(pending, ["modified"]);
      writeFileSync(path.join(checkpointDirectory(pending), "manifest.json"), "corrupt newer manifest");
    }
    const observe = () => checkpointEvidence([pending], { consumedLoops: 1, admittedResults: [result] }, confirmedUnit);
    if (mode !== "valid") {
      expect(observe).toThrow(); expect(() => restoreCheckpoint(pending, authority)).toThrow();
      expect(readFileSync(path.join(f.root, "modified"), "utf8")).toBe(mode === "conflict" ? "unattributed edit" : "confirmed WIP");
      expect(existsSync(path.join(checkpointDirectory(f.intent), "restore.json"))).toBe(false);
      return;
    }
    expect(observe()).toMatch(/^[a-f0-9]{64}$/);
    const restored = restoreCheckpoint(pending, authority);
    expect(restored.position).toEqual({ loop: 1, cursor: 1, phase: "implementation" });
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

test.each(["missing", "malformed", "metadata-only", "association", "progress", "attempt", "stopped"])(
  "invalid durable writer context cannot publish: %s", async mode => {
    const f = fixture();
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
    expect(await f.call("pre", paths)).toMatchObject({ ok: false, status: "failed" });
    expect(existsSync(checkpointDirectory(f.intent))).toBe(false);
    expect(readFileSync(path.join(f.root, "modified"), "utf8")).toBe("prior uncommitted WIP\n");
  });

test("missing and analysis context cannot publish; aborted calls cannot capture", async () => {
  const f = fixture();
  const abort = new AbortController(); abort.abort(new Error("Stop before capture"));
  expect(await f.call("pre", paths, abort.signal)).toMatchObject({ ok: false, error: { message: "Stop before capture" } });
  expect(existsSync(checkpointDirectory(f.intent))).toBe(false);
  setSessionProfile(f.manager, "analysis");
  expect(await f.call("pre", paths)).toMatchObject({ ok: false, error: { message: "Pitako analysis forbids checkpoint_create." } });
  setSessionProfile(f.manager, "coding");
  expect(existsSync(checkpointDirectory(f.intent))).toBe(false);
  let tool: any; checkpointCreate({ registerTool(t: any) { tool = t; } } as ExtensionAPI);
  const missing = await tool.execute("missing", { kind: "pre", paths }, undefined, undefined, { cwd: f.root, sessionManager: {} });
  expect(missing.structuredContent).toMatchObject({ ok: false, error: { message: "Missing native checkpoint execution context." } });
});

test("failed publication and conflicting effects cannot produce a seal or replace a confirmed artifact", async () => {
  const f = fixture(), directory = checkpointDirectory(f.intent);
  mkdirSync(path.join(directory, "manifest.json"), { recursive: true });
  expect(await f.call("pre", paths)).toMatchObject({ ok: false });
  expect(existsSync(path.join(directory, "unit.json"))).toBe(false);
  rmSync(path.join(directory, "manifest.json"), { recursive: true });
  const pre = await f.call("pre", paths);
  writeFileSync(path.join(f.root, "modified"), "unattributed foreign edit");
  expect(await f.call("unit")).toMatchObject({ ok: false, error: { message: "Cannot seal incomplete or conflicting checkpoint effects." } });
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
  expect(plan.effectiveToolAllowlist).toContain("checkpoint_create");
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
      const denied = await call(name, name === "codemode" ? { code: `await tools.checkpoint_create({kind:"pause"});` } : { kind: "pause" });
      expect(denied.isError, text(denied)).toBe(true); expect(text(denied)).toContain("Pitako analysis forbids checkpoint_create");
    }
    session.setActiveToolsByName(session.getAllTools().map(t => t.name).filter(name => name !== "checkpoint_create"));
    const inactive = await call("checkpoint_create", { kind: "pause" });
    expect(inactive.isError).toBe(true);
    expect(text(inactive)).toContain("Tool checkpoint_create not found");
    const deferred = await call("codemode", { code: `await tools.checkpoint_create({kind:"pause"});` });
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
  expect(await f.call("unit")).toMatchObject({ ok: true, kind: "unit" });
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
  const seal = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
    if (String(destination) === path.join(directory, "pause.json")) throw new Error("Interrupted pause publication");
    return original(source, destination);
  });
  try {
    expect(await f.call("pause")).toMatchObject({ ok: false, error: { message: "Interrupted pause publication" } });
    expect(existsSync(path.join(directory, "pause.json"))).toBe(false);
    expect(digest(readFileSync(pre.manifestRef))).toBe(pre.digest);
  } finally { seal.mockRestore(); }
  expect(await f.call("pause")).toMatchObject({ ok: true, status: "created", position: { cursor: 0 } });
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
