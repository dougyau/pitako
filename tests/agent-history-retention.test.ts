import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkerHistory, type HistoryGroup } from "../extensions/agent/history.ts";
import { pruneWorkerHistory } from "../extensions/agent/history-retention.ts";
import { queryHistory } from "../extensions/agent/history-query.ts";
import { loadPitakoConfig } from "../extensions/roles/load.ts";
import pitako from "../extensions/index.ts";
import { agentScope } from "../extensions/agent/scope.ts";

const roots: string[] = [];
const original = process.env.PI_CODING_AGENT_DIR;
const originalInstance = process.env.PITAKO_INSTANCE_ID;
afterEach(() => {
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = original;
  if (originalInstance === undefined) delete process.env.PITAKO_INSTANCE_ID;
  else process.env.PITAKO_INSTANCE_ID = originalInstance;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const DAY = 86400000;
const closedAt = "2020-01-01T00:00:00.000Z";
const later = Date.parse(closedAt) + 200 * DAY;
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-retention-")); roots.push(root);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const history = new WorkerHistory();
  const group = history.createGroup(root);
  const member = history.admit(group.groupId, { roleId: "developer", coordinatorSessionId: "operator" });
  const manager = history.createSession(group.groupId, member.historyId, root);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "native sensitive transcript" }],
    api: "openai-responses", provider: "local", model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now() });
  history.recordTerminal(group.groupId, member.historyId, { status: "failed", beforeFirstAssistant: false });
  history.recordDisposition(group.groupId, member.historyId, { state: "disposed", at: closedAt });
  history.closeInvocation(group.groupId);
  history.mutate(group.groupId, (saved) => {
    saved.closure = { state: "closed", closedAt, evidenceRef: "fixture terminal and disposal" };
    saved.members[0]!.terminal!.at = closedAt;
  });
  const file = manager.getSessionFile()!;
  writeFileSync(`${file}.acp.json`, "ACP sensitive sidecar");
  const config = path.join(history.agentDir, "pitako/config.toml");
  writeFileSync(config, "");
  return { root, history, group, member, file, config };
}
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name); const stat = lstatSync(file);
      if (stat.isDirectory()) { result[file] = "directory"; visit(file); }
      else if (stat.isFile()) result[file] = createHash("sha256").update(readFileSync(file)).digest("hex");
      else result[file] = "symlink";
    }
  };
  visit(root); return result;
}

test("TTL uses latest settlement; disabled captures; config rejects unsupported input", async () => {
  const sample = fixture();
  expect(loadPitakoConfig({ userConfigPath: sample.config }).workerHistory.ttlDays).toBe(180);
  writeFileSync(sample.config, "[worker_history]\nttl_days = false\n");
  const ttl = loadPitakoConfig({ userConfigPath: sample.config }).workerHistory.ttlDays;
  expect((await pruneWorkerHistory(sample.history, ttl, { now: later })).disabled).toBe(true);
  expect(existsSync(sample.file)).toBe(true);
  const next = sample.history.createGroup(sample.root);
  const captured = sample.history.admit(next.groupId, { roleId: "developer" });
  expect(sample.history.createSession(next.groupId, captured.historyId, sample.root).getSessionFile()).toBeTruthy();
  for (const input of ["0", "-1", "1.5", "true", '"180"']) {
    writeFileSync(sample.config, `[worker_history]\nttl_days = ${input}\n`);
    expect(() => loadPitakoConfig({ userConfigPath: sample.config })).toThrow("positive integer or false");
  }
  writeFileSync(sample.config, "[worker_history]\nunknown = 1\n");
  expect(() => loadPitakoConfig({ userConfigPath: sample.config })).toThrow("unknown key worker_history.unknown");
  sample.history.mutate(sample.group.groupId, (saved) => {
    if (saved.members[0]!.native.state === "allocated")
      saved.members[0]!.native.disposition = { state: "disposed", at: new Date(later - DAY).toISOString() };
  });
  expect((await pruneWorkerHistory(sample.history, 180, { now: later })).groups.find((row) => row.groupId === sample.group.groupId)!.state).toBe("protected");
  expect((await pruneWorkerHistory(sample.history, 180, { now: later + 180 * DAY })).groups.find((row) => row.groupId === sample.group.groupId)!.state).toBe("pruned");
});

test("dry-run unchanged; prune only native, ACP and exact own alias; marker readable and sealed", async () => {
  const sample = fixture();
  const sentinel = path.join(path.dirname(sample.file), "foreign.jsonl");
  writeFileSync(sentinel, "foreign sentinel");
  const evidence = path.join(sample.root, "contract-evidence"); writeFileSync(evidence, "contract sentinel");
  const alias = path.join(sample.history.agentDir, "sessions", `--pitako-workers--${sample.group.groupId}-managed`);
  symlinkSync(path.dirname(sample.file), alias);
  sample.history.mutate(sample.group.groupId, (saved) => { saved.aliases = [{ path: alias, target: path.dirname(sample.file) }]; });
  const before = tree(sample.root);
  const dry = await pruneWorkerHistory(sample.history, 180, { now: later, dryRun: true });
  expect(dry.groups[0]!.state).toBe("eligible");
  expect(tree(sample.root)).toEqual(before);
  const pruned = await pruneWorkerHistory(sample.history, 180, { now: later });
  expect(pruned.groups[0]!.state).toBe("pruned");
  expect(existsSync(sample.file)).toBe(false);
  expect(existsSync(`${sample.file}.acp.json`)).toBe(false);
  expect(existsSync(alias)).toBe(false);
  expect(readFileSync(sentinel, "utf8")).toBe("foreign sentinel");
  expect(readFileSync(evidence, "utf8")).toBe("contract sentinel");
  expect((await queryHistory({ action: "read", historyId: sample.member.historyId })).diagnostics).toEqual([{ code: "history_pruned" }]);
  expect((await queryHistory({ action: "list", scope: "all" })).items[0]).toHaveProperty("historyState", "pruned");
  expect(() => sample.history.admit(sample.group.groupId, { roleId: "developer" })).toThrow("sealed");
  expect(readFileSync(path.join(sample.history.catalogDir, `${sample.group.groupId}.json`), "utf8")).not.toContain("sensitive");
});

test("active, unknown, partial, execution-linked and uncertain disposal remain protected", async () => {
  const sample = fixture();
  const cases = [
    (saved: HistoryGroup) => { saved.closure = { state: "unclosed" }; },
    (saved: HistoryGroup) => { saved.closure = { state: "unknown", reason: "crash" }; },
    (saved: HistoryGroup) => { saved.coverage = "partial"; },
    (saved: HistoryGroup) => { saved.identity = { kind: "execution", executionRoot: sample.root, executionRef: "legacy" }; },
    (saved: HistoryGroup) => { if (saved.members[0]!.native.state === "allocated") saved.members[0]!.native.disposition = { state: "unknown", reason: "dispose failed" }; },
  ];
  const baseline = sample.history.read(sample.group.groupId);
  for (const modify of cases) {
    sample.history.mutate(sample.group.groupId, (saved) => { Object.assign(saved, structuredClone(baseline)); modify(saved); });
    expect((await pruneWorkerHistory(sample.history, 180, { now: later })).groups[0]!.state).toBe("protected");
    expect(existsSync(sample.file)).toBe(true);
  }
});

test("closed preassistant failure is eligible; uncreated native stays distinct from pruned allocation", async () => {
  const sample = fixture();
  const group = sample.history.createGroup(sample.root);
  const member = sample.history.admit(group.groupId, { roleId: "developer" });
  sample.history.recordTerminal(group.groupId, member.historyId, { status: "cancelled", beforeFirstAssistant: true });
  sample.history.recordGap(group.groupId, member.historyId, "No assistant and no SDK session created");
  sample.history.closeInvocation(group.groupId);
  expect(sample.history.read(group.groupId).coverage).toBe("complete");
  expect((await pruneWorkerHistory(sample.history, 180, { now: Date.now() + 181 * DAY })).groups.find((row) => row.groupId === group.groupId)!.state).toBe("pruned");
  expect((await queryHistory({ action: "read", historyId: member.historyId })).diagnostics[0]!.code).toBe("native_not_created");
});

test("maintenance first yields to live admission and allocation without changing native bytes", async () => {
  const sample = fixture();
  sample.history.mutate(sample.group.groupId, (saved) => { saved.closure = { state: "unclosed" }; });
  const before = readFileSync(sample.file);
  // Starting production prune reaches its first await before these synchronous catalog mutations.
  const maintenance = pruneWorkerHistory(sample.history, 180, { now: later });
  const member = sample.history.admit(sample.group.groupId, { roleId: "reviewer", instanceId: "live-worker" });
  const manager = sample.history.createSession(sample.group.groupId, member.historyId, sample.root);
  const report = await maintenance;
  expect(report.groups[0]!.state).toBe("protected");
  const saved = sample.history.read(sample.group.groupId);
  expect(saved.members).toHaveLength(2);
  expect(saved.members[1]).toMatchObject({ historyId: member.historyId, instanceId: "live-worker",
    native: { state: "allocated", sessionId: manager.getSessionId(), path: manager.getSessionFile(),
      disposition: { state: "pending" } } });
  expect(saved.cleanup).toBeUndefined();
  expect(saved.closure.state).toBe("unclosed");
  expect(readFileSync(sample.file)).toEqual(before);
  expect(existsSync(manager.getSessionFile()!)).toBe(false); // No forced preassistant write.
});

test("preflight eligibility cannot authorize deletion after catalog protection changes", async () => {
  const sample = fixture();
  const before = readFileSync(sample.file);
  const maintenance = pruneWorkerHistory(sample.history, 180, { now: later });
  sample.history.recordDisposition(sample.group.groupId, sample.member.historyId,
    { state: "unknown", reason: "disposal evidence corrected during preflight" });
  expect((await maintenance).groups[0]!.state).toBe("protected");
  expect(sample.history.read(sample.group.groupId).cleanup).toBeUndefined();
  expect(readFileSync(sample.file)).toEqual(before);
});

test("symlinks and retargeted aliases preserve targets; partial deletion requires cleanup ownership", async () => {
  const sample = fixture();
  const target = path.join(sample.root, "user.jsonl"); writeFileSync(target, "user sentinel");
  rmSync(`${sample.file}.acp.json`); symlinkSync(target, `${sample.file}.acp.json`);
  expect((await pruneWorkerHistory(sample.history, 180, { now: later })).groups[0]!.state).toBe("failed");
  expect(readFileSync(target, "utf8")).toBe("user sentinel");
  expect(existsSync(sample.file)).toBe(true);
  rmSync(`${sample.file}.acp.json`);
  const alias = path.join(sample.history.agentDir, "sessions", `--pitako-workers--${sample.group.groupId}-alias`);
  symlinkSync(sample.root, alias);
  sample.history.mutate(sample.group.groupId, (saved) => { saved.aliases = [{ path: alias, target: path.dirname(sample.file) }]; });
  expect((await pruneWorkerHistory(sample.history, 180, { now: later })).groups[0]!.state).toBe("failed");
  expect(existsSync(sample.file)).toBe(true);
  sample.history.mutate(sample.group.groupId, (saved) => { delete saved.aliases; });
  const interrupted = await pruneWorkerHistory(sample.history, 180, { now: later,
    afterUnlink() { throw new Error("controlled interruption"); } });
  expect(interrupted.groups[0]!.state).toBe("failed");
  expect(sample.history.read(sample.group.groupId).cleanup!.state).toBe("deleting");
  expect((await queryHistory({ action: "read", historyId: sample.member.historyId })).diagnostics).toContainEqual({ code: "history_deletion_incomplete" });
  expect((await pruneWorkerHistory(sample.history, 180, { now: later })).groups[0]!.state).toBe("pruned");
  expect(readFileSync(target, "utf8")).toBe("user sentinel");
});

test("public command/startup prune and dry-run remain foreground-only; busy maintenance skips", async () => {
  const sample = fixture();
  delete process.env.PITAKO_INSTANCE_ID;
  // Make the fixture eligible under the public adapter's real clock.
  const hooks = new Map<string, any[]>(); let command: any; const messages: string[] = [];
  const pi = { registerCommand(name: string, definition: any) { if (name === "pitako") command = definition.handler; },
    registerFlag() {}, registerTool() {}, on(name: string, handler: any) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    getFlag() {}, getAllTools() { return []; }, getActiveTools() { return []; }, setActiveTools() {}, getSessionName() {},
    setSessionName() {},
  };
  pitako(pi as unknown as ExtensionAPI);
  const ctx = { cwd: sample.root, sessionManager: { getSessionId: () => "foreground", getEntries: () => [] },
    hasUI: true, ui: { notify(text: string) { messages.push(text); }, setStatus() {} } };
  const before = tree(sample.root);
  await command("history prune --dry-run", ctx);
  expect(JSON.parse(messages.pop()!).groups[0].state).toBe("eligible");
  expect(tree(sample.root)).toEqual(before);
  await agentScope.run({ instanceId: "child", roleId: "developer" }, () => command("history prune", ctx));
  expect(messages.pop()).toContain("cannot be called from an AgentInstance");
  await agentScope.run({ instanceId: "child", roleId: "developer" }, async () => {
    for (const hook of hooks.get("session_start")!) await hook({}, ctx);
  });
  expect(existsSync(sample.file)).toBe(true);
  const lock = path.join(sample.history.catalogDir, `${sample.group.groupId}.json.lock`); mkdirSync(lock);
  for (const hook of hooks.get("session_start")!) await hook({}, ctx);
  expect(existsSync(sample.file)).toBe(true);
  rmSync(lock, { recursive: true });
  for (const hook of hooks.get("session_start")!) await hook({}, ctx);
  expect(existsSync(sample.file)).toBe(false);
  await command("history read " + sample.member.historyId, ctx);
  expect(JSON.parse(messages.pop()!).diagnostics[0].code).toBe("history_pruned");
  const second = fixture();
  rmSync(`${second.file}.acp.json`);
  symlinkSync(sample.file, `${second.file}.acp.json`);
  for (const hook of hooks.get("session_start")!) await hook({}, ctx);
  expect(messages.some((message) => message.startsWith("Worker history maintenance failed:"))).toBe(true);
  expect(existsSync(second.file)).toBe(true);
  rmSync(`${second.file}.acp.json`);
  await command("history prune", ctx);
  expect(JSON.parse(messages.pop()!).groups[0].state).toBe("pruned");
  expect(existsSync(second.file)).toBe(false);
  // A dry run on an absent agent root must not initialize capture directories.
  process.env.PI_CODING_AGENT_DIR = path.join(sample.root, "absent-agent");
  await command("history prune --dry-run", ctx);
  expect(existsSync(process.env.PI_CODING_AGENT_DIR)).toBe(false);
});

test("Node multiprocess admission/prune race and crash leave honest state", () => {
  const child = spawnSync("node", ["--import", "./scripts/sdk-node-loader.mjs", "scripts/agent-history-retention-node.mjs"],
    { cwd: path.resolve(import.meta.dir, ".."), encoding: "utf8", timeout: 30000 });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("admitted writer protected; crash intent and uncertain lock preserved");
}, 40000);
