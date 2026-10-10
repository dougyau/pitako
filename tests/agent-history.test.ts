import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import path from "node:path";
import { InvocationHistory, WorkerHistory, nativeHistoryStatus } from "../extensions/agent/history.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
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

test("recorded historical aliases remain native-readable without managed production", () => {
  const { root, workspace, history, group, member } = fixture();
  const directory = path.join(root, "historical-sessions");
  mkdirSync(directory);
  const manager = SessionManager.create(workspace, directory);
  manager.appendMessage({ role: "user", content: "historical alias input", timestamp: Date.now() });
  const alias = path.join(history.agentDir, "sessions", "recorded-discovery-alias");
  mkdirSync(path.dirname(alias), { recursive: true });
  symlinkSync(directory, alias);
  const catalog = path.join(history.catalogDir, `${group.groupId}.json`);
  const recorded = history.read(group.groupId);
  recorded.identity = { kind: "mission", storeRoot: root, missionId: "historical" };
  recorded.missionStore = { dbPath: path.join(root, "absent-mission.db"), objectDir: root, sessionsDirectory: directory };
  recorded.aliases = [{ path: alias, target: directory }];
  recorded.members[0]!.native = { state: "allocated", sessionId: manager.getSessionId(),
    path: path.join(alias, path.basename(manager.getSessionFile()!)), disposition: { state: "disposed", at: "historical" } };
  writeFileSync(catalog, JSON.stringify(recorded));
  const before = readFileSync(catalog);
  const recovered = new WorkerHistory(history.agentDir).read(group.groupId);
  expect(recovered.aliases).toEqual(recorded.aliases);
  expect(recovered.members[0]!.historyId).toBe(member.historyId);
  expect(nativeHistoryStatus(recovered.members[0]!)).toMatchObject({ state: "present" });
  expect(SessionManager.open(recovered.members[0]!.native.state === "allocated"
    ? recovered.members[0]!.native.path : "").getEntries()).toEqual(manager.getEntries());
  expect(readFileSync(catalog)).toEqual(before);
  expect(existsSync(recorded.missionStore.dbPath)).toBe(false);
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
