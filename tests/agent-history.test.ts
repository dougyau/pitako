import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { InvocationHistory, WorkerHistory, nativeHistoryStatus } from "../extensions/agent/history.ts";

test("public Node setup rejection records the original error before and after persisted discovery intent", () => {
  const child = spawnSync("node", ["--experimental-transform-types", "--import", "./scripts/sdk-node-loader.mjs",
    "scripts/agent-history-hermes-node.mjs", "--setup-rejection"],
  { cwd: path.resolve(import.meta.dir, ".."), encoding: "utf8", timeout: 30000, env: { ...process.env, PI_OFFLINE: "1" } });
  expect(child.status, child.stderr + child.stdout).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.observations.map((row: { boundary: string }) => row.boundary))
    .toEqual(["unsafe-root", "foreign-alias", "persisted-intent", "inherited-pending"]);
});

test("managed no-side-effect fallback preserves actual SDK disposal on a fresh no-association start", () => {
  const child = spawnSync("node", ["--experimental-transform-types", "--import", "./scripts/sdk-node-loader.mjs",
    "scripts/managed-history-node.mjs", "--reuse-fallback"],
  { cwd: path.resolve(import.meta.dir, ".."), encoding: "utf8", timeout: 30000, env: { ...process.env, PI_OFFLINE: "1" } });
  expect(child.status, child.stderr + child.stdout).toBe(0);
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-history-"));
  roots.push(root);
  const workspace = path.join(root, "worktree");
  mkdirSync(workspace);
  const history = new WorkerHistory(path.join(root, "agent"));
  const group = history.createGroup(workspace);
  const member = history.admit(group.groupId, { roleId: "developer", assignmentId: "assignment" });
  return { root, workspace, history, group, member };
}

test("catalog survives worktree removal; preassistant absence and disposition are independent", () => {
  const { workspace, history, group, member } = fixture();
  const manager = history.createSession(group.groupId, member.historyId, workspace);
  expect(manager.getSessionFile()).toContain(`--pitako-workers--${group.groupId}`);
  expect(nativeHistoryStatus(history.read(group.groupId).members[0]!)).toMatchObject({ state: "missing" });
  history.recordTerminal(group.groupId, member.historyId, {
    status: "cancelled", beforeFirstAssistant: true, reason: "cancelled before provider",
  });
  expect(history.read(group.groupId).members[0]!.native).toMatchObject({ disposition: { state: "pending" } });
  history.recordDisposition(group.groupId, member.historyId, { state: "disposed", at: new Date().toISOString() });
  rmSync(workspace, { recursive: true });
  const recovered = new WorkerHistory(history.agentDir).list()[0]!;
  expect(recovered.identity).toMatchObject({ kind: "invocation" });
  expect(recovered.members[0]!.assignmentId).toBe("assignment");
  expect(nativeHistoryStatus(recovered.members[0]!)).toEqual({ state: "not-persisted-before-assistant" });
  expect(recovered.closure.state).toBe("unclosed");
  expect(statSync(history.catalogDir).mode & 0o777).toBe(0o700);
  expect(statSync(path.join(history.catalogDir, `${group.groupId}.json`)).mode & 0o777).toBe(0o600);
  expect(statSync(manager.getSessionDir()).mode & 0o777).toBe(0o700);
});

test("preparation fails closed, leaves admission, and does not overwrite an allocated file", () => {
  const { root, workspace, history, group, member } = fixture();
  writeFileSync(path.join(history.agentDir, "sessions"), "blocked");
  expect(() => history.createSession(group.groupId, member.historyId, workspace)).toThrow();
  expect(history.read(group.groupId).members[0]!.native.state).toBe("not-created");
  expect(() => history.recordDisposition(group.groupId, member.historyId, { state: "disposed", at: "now" })).toThrow();
  rmSync(path.join(history.agentDir, "sessions"));
  const manager = history.createSession(group.groupId, member.historyId, workspace);
  const file = manager.getSessionFile()!;
  writeFileSync(file, "sentinel");
  expect(() => history.createSession(group.groupId, member.historyId, workspace)).toThrow();
  expect(readFileSync(file, "utf8")).toBe("sentinel");
  // Native public API itself refuses collision on its first persistence.
  expect(() => manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "offline" }], api: "openai-completions",
    provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  })).toThrow();
  expect(readFileSync(file, "utf8")).toBe("sentinel");
  expect(nativeHistoryStatus({ ...history.read(group.groupId).members[0]!,
    native: { state: "allocated", path: path.join(root, "lost.jsonl"), sessionId: "lost", disposition: { state: "pending" } },
    terminal: { status: "failed", at: "now", beforeFirstAssistant: false },
  })).toMatchObject({ state: "missing" });
});

test("group references canonical authorities and rejects invalid locators and uncertain locks", () => {
  const { root, workspace, history, group } = fixture();
  expect(history.createGroup(workspace, { kind: "mission", storeRoot: root, missionId: "mission" }).identity)
    .toEqual({ kind: "mission", storeRoot: root, missionId: "mission" });
  expect(history.createGroup(workspace, { kind: "execution", executionRoot: root, executionRef: "execution" }).identity)
    .toEqual({ kind: "execution", executionRoot: root, executionRef: "execution" });
  expect(() => history.read("../other")).toThrow();
  mkdirSync(path.join(history.catalogDir, `${group.groupId}.json.lock`));
  expect(() => history.admit(group.groupId, { roleId: "developer" })).toThrow();
  expect(history.read(group.groupId).members).toHaveLength(1);
  const independent = history.createGroup(workspace);
  expect(history.admit(independent.groupId, { roleId: "developer" }).native.state).toBe("not-created");
  const file = path.join(history.catalogDir, `${independent.groupId}.json`);
  writeFileSync(file, JSON.stringify({ ...history.read(independent.groupId),
    closure: { state: "closed", closedAt: "now", evidenceRef: "fixture" } }));
  expect(() => history.admit(independent.groupId, { roleId: "developer" })).toThrow();
  writeFileSync(file, JSON.stringify({ ...independent, version: 2 }));
  expect(() => history.read(independent.groupId)).toThrow("unsupported or invalid");
});

test("execution grouping is shared by authoritative root/ref while independent invocations stay separate", () => {
  const { workspace, history } = fixture();
  const identity = { kind: "execution" as const, executionRoot: workspace, executionRef: "plan@1:hash" };
  const a = history.executionGroup(workspace, identity);
  const b = new WorkerHistory(history.agentDir).executionGroup(workspace, identity);
  expect(b.groupId).toBe(a.groupId);
  expect(history.executionGroup(workspace, { ...identity, executionRef: "plan@2:new-hash" }).groupId).not.toBe(a.groupId);
  expect(history.createGroup(workspace).groupId).not.toBe(history.createGroup(workspace).groupId);
  const member = history.admit(a.groupId, { roleId: "developer" });
  history.recordTerminal(a.groupId, member.historyId, { status: "completed", beforeFirstAssistant: true });
  history.closeInvocation(a.groupId);
  expect(history.read(a.groupId).closure.state).toBe("unclosed");
});

test("a live handle can continue despite an attempt without a handle; terminal result and disposal stay separate", () => {
  const { workspace, history } = fixture();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = history.agentDir;
  try {
    const invocation = new InvocationHistory(workspace, { source: "agent_run" }, "original workbrief");
    const session = invocation.admit("instance", "developer", { model: "local/primary" });
    session.create();
    session.attached();
    session.result({ status: "failed", result: "", error: "unavailable target", sideEffects: true });
    expect(history.read(invocation.group.groupId).members[0]!.terminal).toBeUndefined();
    session.result({ status: "completed", result: "native answer", sideEffects: true });
    session.disposition(new Error("shutdown uncertain"));
    invocation.settled();
    const group = history.read(invocation.group.groupId);
    expect(group.members[0]!.terminal?.status).toBe("completed");
    expect(group.members[0]!.native).toMatchObject({ disposition: { state: "unknown" } });
    expect(group.closure.state).toBe("unclosed");
    expect(session.manager!.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
    expect(session.manager!.getEntries().filter((entry) => entry.type === "custom")
      .some((entry) => JSON.stringify(entry).includes("native answer"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("durable and diagnosis aliases are registered exact-target discovery only; no forced native write", () => {
  const sample = fixture();
  const sessionsDirectory = path.join(sample.root, "private-sessions");
  const dbPath = path.join(sample.root, "mission.db");
  writeFileSync(dbPath, "locator");
  const group = sample.history.missionGroup(sample.workspace, "mission", { dbPath, objectDir: sample.root, sessionsDirectory }, false);
  for (const diagnosis of [false, true]) {
    const id = randomUUID();
    const member = sample.history.admit(group.groupId, { roleId: diagnosis ? "architect" : "developer",
      attemptId: id, ...(diagnosis ? { diagnosisId: id, diagnosisOf: "prior" } : {}) });
    const directory = path.join(sessionsDirectory, "mission", id);
    mkdirSync(directory, { recursive: true });
    const manager = SessionManager.create(sample.workspace, directory, { id });
    sample.history.associateSession(group.groupId, member.historyId, manager);
    const saved = sample.history.read(group.groupId);
    const alias = saved.aliases!.at(-1)!;
    expect(path.dirname(alias.path)).toBe(path.join(sample.history.agentDir, "sessions"));
    expect(readlinkSync(alias.path)).toBe(directory);
    expect(alias.target).toBe(directory);
    expect(saved.members.at(-1)!.native).toMatchObject({ path: manager.getSessionFile() });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(existsSync(manager.getSessionFile()!)).toBe(false);
    sample.history.associateSession(group.groupId, member.historyId, manager);
    expect(sample.history.read(group.groupId).aliases).toHaveLength(diagnosis ? 2 : 1);
    rmSync(alias.path);
    symlinkSync(sample.workspace, alias.path);
    expect(() => sample.history.associateSession(group.groupId, member.historyId, manager)).toThrow("unsafe worker discovery alias");
    expect(readlinkSync(alias.path)).toBe(sample.workspace);
  }
});

test("an unregistered alias collision is not adopted; sealed or busy groups cannot create discovery", () => {
  const sample = fixture();
  const dbPath = path.join(sample.root, "mission.db"); writeFileSync(dbPath, "locator");
  const sessionsDirectory = path.join(sample.root, "private-sessions");
  const group = sample.history.missionGroup(sample.workspace, "mission", { dbPath, objectDir: sample.root, sessionsDirectory }, false);
  const id = randomUUID();
  const member = sample.history.admit(group.groupId, { roleId: "developer", attemptId: id });
  const directory = path.join(sessionsDirectory, "mission", id); mkdirSync(directory, { recursive: true });
  const manager = SessionManager.create(sample.workspace, directory, { id });
  const alias = path.join(sample.history.agentDir, "sessions", `--pitako-workers--${group.groupId}-${id}`);
  mkdirSync(path.dirname(alias), { recursive: true });
  symlinkSync(directory, alias);
  expect(() => sample.history.associateSession(group.groupId, member.historyId, manager)).toThrow("unsafe worker discovery alias");
  expect(sample.history.read(group.groupId).aliases).toBeUndefined();
  expect(sample.history.read(group.groupId).members[0]!.native.state).toBe("not-created");
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  rmSync(alias);
  const lock = path.join(sample.history.catalogDir, `${group.groupId}.json.lock`); mkdirSync(lock);
  expect(() => sample.history.associateSession(group.groupId, member.historyId, manager)).toThrow();
  expect(existsSync(alias)).toBe(false);
  rmSync(lock, { recursive: true });
  sample.history.mutate(group.groupId, (saved) => { saved.closure = { state: "closed", closedAt: "now", evidenceRef: "fixture" }; });
  expect(() => sample.history.associateSession(group.groupId, member.historyId, manager)).toThrow("sealed");
  expect(existsSync(alias)).toBe(false);
});
