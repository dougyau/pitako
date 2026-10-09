import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import path from "node:path";
import { InvocationHistory, WorkerHistory, nativeHistoryStatus } from "../extensions/agent/history.ts";
import { acquireHistoryFixture, finishHistoryFixture, requireReleasedHistoryFixture,
  type HistoryChildReceipt, type HistoryFixtureOwner, type HistoryNativeOutcome } from "./fixtures/history-fixture-ownership.ts";

let historyOwner: HistoryFixtureOwner | undefined;
beforeEach(() => requireReleasedHistoryFixture(historyOwner));

test("history ownership finalizer retains uncertainty and guards teardown/next-case admission", () => {
  const stopped = new Error("test stop sink");
  const stops: number[] = [];
  const stop = (code: number): never => { stops.push(code); throw stopped; };
  const setup = () => {
    const owner = acquireHistoryFixture(() => {});
    const child: HistoryChildReceipt = { attemptId: owner.attemptId, rootIdentity: owner.identity!,
      child: { ...owner.parent!, pid: 12345, ppid: process.pid }, phase: "complete",
      resources: {}, assertions: "ok", engineClose: "ok", storeClose: "ok", errors: [] };
    const result: SpawnSyncReturns<string> = { pid: 12345, status: 0, signal: null,
      stdout: '{"misleading":"success"}', stderr: "", output: [null, '{"misleading":"success"}', ""] };
    return { owner, child, result };
  };
  const cases: Array<{ name: string; change: (sample: ReturnType<typeof setup>) => void; missing?: boolean }> = [
    { name: "native error despite exit zero", change: ({ result }) => { result.error = new Error("native ETIMEDOUT"); } },
    { name: "native signal despite exit zero", change: ({ result }) => { result.signal = "SIGKILL"; } },
    { name: "nonzero status", change: ({ result }) => { result.status = 1; } },
    { name: "missing status", change: ({ result }) => { result.status = null; } },
    { name: "missing early ready", change: () => {}, missing: true },
    { name: "pending lifecycle", change: ({ child }) => { child.phase = "sdk-start:0"; } },
    { name: "pending assertions", change: ({ child }) => { child.assertions = "pending"; } },
    { name: "failed assertions", change: ({ child }) => { child.assertions = "failed"; } },
    { name: "pending engine cleanup", change: ({ child }) => { child.engineClose = "pending"; } },
    { name: "failed engine cleanup", change: ({ child }) => { child.engineClose = "failed"; } },
    { name: "pending store cleanup", change: ({ child }) => { child.storeClose = "pending"; } },
    { name: "failed store cleanup", change: ({ child }) => { child.storeClose = "failed"; } },
    { name: "child errors", change: ({ child }) => { child.errors.push("primary and cleanup errors"); } },
    { name: "attempt mismatch", change: ({ child }) => { child.attemptId = "other"; } },
    { name: "child root mismatch", change: ({ child }) => { child.rootIdentity = { device: "0", inode: "0" }; } },
    { name: "child PID mismatch", change: ({ child }) => { child.child.pid++; } },
    { name: "child parent mismatch", change: ({ child }) => { child.child.ppid++; } },
    { name: "child boot mismatch", change: ({ child }) => { child.child.bootId = "other"; } },
    { name: "missing birth identity", change: ({ child }) => { child.child.startTicks = ""; } },
  ];
  for (const scenario of cases) {
    const sample = setup();
    try {
      scenario.change(sample);
      if (!scenario.missing) writeFileSync(path.join(sample.owner.root, "child.json"), JSON.stringify(sample.child));
      expect(() => finishHistoryFixture(sample.owner, { kind: "returned", result: sample.result },
        () => {}, stop), scenario.name).toThrow(stopped);
      expect(sample.owner.state, scenario.name).toBe("owned");
      expect(existsSync(sample.owner.root), scenario.name).toBe(true);
      expect(sample.owner.errors.length, scenario.name).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(path.join(sample.owner.root, "parent.json"), "utf8")).native.stdout)
        .toBe(sample.result.stdout);
      let deleted = false;
      let nextCase = false;
      expect(() => { requireReleasedHistoryFixture(sample.owner, stop); deleted = true; }).toThrow(stopped);
      expect(() => { requireReleasedHistoryFixture(sample.owner, stop); nextCase = true; }).toThrow(stopped);
      expect([deleted, nextCase]).toEqual([false, false]);
    } finally { rmSync(sample.owner.root, { recursive: true }); }
  }
  for (const failure of ["threw", "assertion", "combined-causes", "interrupted", "truncated", "root-replaced", "removal", "receipt-output"] as const) {
    const { owner, child, result } = setup();
    const originalRoot = `${owner.root}-original`;
    const output = failure === "receipt-output"
      ? spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("receipt output cause"); }) : undefined;
    try {
      if (failure === "combined-causes") {
        result.error = new Error("original native cause");
        child.engineClose = "failed"; child.storeClose = "failed";
        child.errors = ["primary child cause", "engine cleanup cause", "store cleanup cause"];
      }
      writeFileSync(path.join(owner.root, "child.json"), JSON.stringify(child));
      if (failure === "truncated") writeFileSync(path.join(owner.root, "child.json"), "{");
      if (failure === "root-replaced") {
        renameSync(owner.root, originalRoot);
        mkdirSync(owner.root);
        writeFileSync(path.join(owner.root, "child.json"), JSON.stringify(child));
      }
      if (failure === "removal") {
        // Allow receipt renames but forbid recursive removal of an acquired resource.
        const locked = path.join(owner.root, "locked");
        mkdirSync(locked); writeFileSync(path.join(locked, "resource"), "retained");
        chmodSync(locked, 0o500);
      }
      const outcome: HistoryNativeOutcome = failure === "threw"
        ? { kind: "threw", error: new Error("original native cause") } : { kind: "returned", result };
      expect(() => {
        if (failure === "interrupted") requireReleasedHistoryFixture(owner, stop);
        else finishHistoryFixture(owner, outcome, () => {
          if (failure === "assertion" || failure === "combined-causes") throw new Error("original assertion cause");
        }, stop);
      }, failure).toThrow(stopped);
      expect(owner.state, failure).toBe("owned");
      expect(existsSync(owner.root), failure).toBe(true);
      if (failure === "threw" || failure === "assertion")
        expect(owner.errors.join("\n")).toContain(`original ${failure === "threw" ? "native" : "assertion"} cause`);
      if (failure === "interrupted") expect(owner.native).toEqual({ kind: "pending" });
      if (failure === "combined-causes") {
        expect(owner.errors.join("\n")).toContain("original native cause");
        expect(owner.errors.join("\n")).toContain("original assertion cause");
        expect(owner.child?.errors).toEqual(child.errors);
      }
      if (failure === "removal") {
        expect(owner.errors.join("\n")).toContain("EACCES");
        expect(JSON.parse(readFileSync(path.join(owner.root, "child.json"), "utf8"))).toEqual(child);
        expect(existsSync(path.join(owner.root, "locked", "resource"))).toBe(true);
      }
      if (failure === "receipt-output") expect(owner.errors.join("\n")).toContain("receipt output cause");
      expect(() => requireReleasedHistoryFixture(owner, stop)).toThrow(stopped);
    } finally {
      output?.mockRestore();
      const locked = path.join(owner.root, "locked");
      if (existsSync(locked)) chmodSync(locked, 0o700);
      rmSync(owner.root, { recursive: true });
      if (existsSync(originalRoot)) rmSync(originalRoot, { recursive: true });
    }
  }
  const { owner, child, result } = setup();
  writeFileSync(path.join(owner.root, "child.json"), JSON.stringify(child));
  let asserted = false;
  finishHistoryFixture(owner, { kind: "returned", result }, () => { asserted = true; }, stop);
  expect(asserted).toBe(true);
  expect(owner.state).toBe("released");
  expect(existsSync(owner.root)).toBe(false);
  requireReleasedHistoryFixture(owner, stop);
  expect(stops.every((code) => code === 1)).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  requireReleasedHistoryFixture(historyOwner);
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
