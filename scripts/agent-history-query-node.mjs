import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerHistory } from "../extensions/agent/history.ts";
import agentInstance from "../extensions/agent/index.ts";
import pitako from "../extensions/index.ts";
import { nativeHeader } from "../extensions/agent/history-native.ts";
import { runAgentInstance } from "../extensions/agent/run.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { MissionEngine } from "../extensions/mission/engine.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";
import { createMissionFixture, missionInput, openFixtureStore } from "../tests/mission-fixtures.ts";
import { openSqlite } from "../extensions/board/sqlite.ts";
import { openMissionStore } from "../extensions/mission/store.ts";

// Also run under Bun: the same registered adapters must consult its real SQLite backend.
async function authorityProof() {
  const sample = createMissionFixture("pitako-history-authority-");
  process.env.PI_CODING_AGENT_DIR = path.join(sample.base, "agent");
  const history = new WorkerHistory();
  let store;
  let observer;
  let engine;
  try {
    store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const locator = { dbPath: store.dbPath, objectDir: store.objectDir,
      sessionsDirectory: path.join(sample.base, "sessions") };
    const group = history.missionGroup(sample.root, mission.id, locator, false);
    history.admit(group.groupId, { roleId: "developer", attemptId: "fixture-pending",
      coordinatorSessionId: "old-coordinator" });
    const native = path.join(locator.sessionsDirectory, "fixture.jsonl");
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, '{"type":"session","id":"fixture","version":3}\n');
    fs.writeFileSync(`${native}.acp.json`, '{"fixture":"unchanged"}');
    history.mutate(group.groupId, (saved) => {
      saved.members[0].native = { state: "allocated", sessionId: "fixture", path: native,
        disposition: { state: "pending" } };
      saved.members[0].terminal = { status: "cancelled", at: "2026-01-01T00:00:00Z" };
      saved.closure = { state: "closed", closedAt: "stale", evidenceRef: "not authority" };
    });
    const api = adapter("new-coordinator");
    const logical = (db) => Object.fromEntries(
      ["store_meta", "missions", "mission_events", "reservations", "measurements", "evaluation_observations"]
        .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const files = (directory) => {
      const result = {};
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) Object.assign(result, files(file));
        else if (entry.isFile()) result[file] = fs.readFileSync(file);
      }
      return result;
    };
    const unchangedFiles = () => ({ ...files(history.catalogDir), ...files(locator.objectDir),
      ...files(locator.sessionsDirectory), [locator.dbPath]: fs.readFileSync(locator.dbPath) });
    const query = () => api.read({ action: "list", missionId: mission.id });

    // Fixture-only checkpoint and close: a valid cold WAL-mode DB with no sidecars.
    observer = await openSqlite(locator.dbPath, { setWal: false });
    assert.equal(observer.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: locator.sessionsDirectory,
      runRole: async () => { throw new Error("no role dispatch expected"); } });
    await engine.retireForShutdown("fixture cold authority");
    const expectedColdState = logical(observer);
    observer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    observer.close(); observer = undefined;
    store.close(); store = undefined;
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${locator.dbPath}${suffix}`, { force: true });
    assert(!fs.existsSync(`${locator.dbPath}-wal`) && !fs.existsSync(`${locator.dbPath}-shm`));
    const coldBytes = unchangedFiles();
    const cold = await query();
    assert.equal(cold.items[0].group.executionState, "prepared");
    assert.equal(cold.items[0].group.protected, true);
    assert.equal(cold.items[0].group.closure.state, "unknown");
    assert.deepEqual(unchangedFiles(), coldBytes);
    observer = await openSqlite(locator.dbPath, { readOnly: true });
    const coldState = logical(observer);
    assert.equal(coldState.missions[0].state, "prepared");
    assert.deepEqual(coldState, expectedColdState);
    const coldAgain = await query();
    assert.deepEqual(coldAgain, cold);
    assert.deepEqual(logical(observer), coldState);
    assert.deepEqual(unchangedFiles(), coldBytes);
    assert.throws(() => observer.exec("UPDATE missions SET state = 'cancelled'"), /readonly|read.only/i);
    assert.deepEqual(logical(observer), coldState);
    observer.close(); observer = undefined;

    // Independent engine control commits fresh terminal authority to WAL.
    // No writer runs during the snapshots/query comparisons below.
    store = await openFixtureStore(sample);
    observer = await openSqlite(locator.dbPath, { setWal: false });
    observer.exec("PRAGMA wal_autocheckpoint = 0");
    observer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const mainBeforeCancel = fs.readFileSync(locator.dbPath);
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: locator.sessionsDirectory,
      runRole: async () => { throw new Error("no role dispatch expected"); } });
    await engine.control("cancel");
    assert(fs.statSync(`${locator.dbPath}-wal`).size > 32, "committed uncheckpointed WAL exists");
    assert.deepEqual(fs.readFileSync(locator.dbPath), mainBeforeCancel, "new state is in WAL, not main DB");
    const terminalState = logical(observer);
    const terminalBytes = unchangedFiles();
    const terminal = await query();
    assert.equal(terminal.items[0].group.executionState, "cancelled");
    assert.equal(terminal.items[0].group.protected, true);
    assert.equal(terminal.items[0].group.closure.state, "unknown");
    assert(terminal.items[0].group.reasons.join(";").includes("SDK disposal not confirmed"));
    assert.deepEqual(await api.command(`history list --mission-id ${mission.id}`), terminal);
    assert.deepEqual(logical(observer), terminalState);
    assert.deepEqual(unchangedFiles(), terminalBytes);
    // Unknown/unbound membership remains protected even after disposal.
    history.mutate(group.groupId, (saved) => {
      saved.members[0].native.disposition = { state: "disposed", at: "2026-01-02T00:00:00Z" };
      saved.closure = { state: "unknown", reason: "stale catalog" };
    });
    const unbound = await query();
    assert.equal(unbound.items[0].group.protected, true);
    assert(unbound.items[0].group.reasons.join(";").includes("lacks an exact authoritative admission"));
    // This mission had no engine attempts. Restore that exact empty membership.
    history.mutate(group.groupId, (saved) => { saved.members = []; });
    const disposedBytes = unchangedFiles();
    const disposed = await query();
    assert.equal(disposed.items[0].executionState, "cancelled");
    assert.equal(disposed.items[0].closure.state, "closed", JSON.stringify(disposed));
    assert.equal(disposed.items[0].protected, false);
    assert.notEqual(disposed.items[0].closure.evidenceRef, "not authority");
    assert.deepEqual(logical(observer), terminalState);
    assert.deepEqual(unchangedFiles(), disposedBytes);
    const readonly = await openSqlite(locator.dbPath, { readOnly: true });
    try { assert.throws(() => readonly.exec("DELETE FROM mission_events"), /readonly|read.only/i); }
    finally { readonly.close(); }
    assert.deepEqual(logical(observer), terminalState);
    await assert.rejects(openMissionStore({ ...locator, readOnly: true,
      historyReadBudget: { databaseBytes: fs.statSync(locator.dbPath).size, objectBytes: 2 * 1024 * 1024 } }),
    /history_authority_limit/); // Main alone fits; committed WAL must count.
    const objectLimited = await openMissionStore({ ...locator, readOnly: true,
      historyReadBudget: { databaseBytes: 8 * 1024 * 1024, objectBytes: 1 } });
    try { assert.throws(() => objectLimited.inspectMission(mission.id), /history_authority_limit/); }
    finally { objectLimited.close(); }

    // Fixture-only rollback-journal authority lets an exclusive writer block readers.
    const busyFile = path.join(sample.base, "busy.db");
    const blocker = await openSqlite(busyFile, { setWal: false });
    try {
      blocker.exec("CREATE TABLE fixture (id INTEGER)");
      blocker.exec("PRAGMA journal_mode = DELETE");
      blocker.exec("BEGIN EXCLUSIVE");
      history.mutate(group.groupId, (saved) => { saved.missionStore.dbPath = busyFile; });
      const busyBytes = fs.readFileSync(busyFile);
      const busy = await query();
      assert.equal(busy.items[0].executionState, undefined);
      assert.equal(busy.items[0].protected, true);
      assert(busy.items[0].reasons.join(";").match(/locked|busy/i), JSON.stringify(busy));
      assert.deepEqual(fs.readFileSync(busyFile), busyBytes);
    } finally { blocker.exec("ROLLBACK"); blocker.close(); }

    // Genuine authority failures still override saved closure without mutating files.
    const bad = [
      ["missing.db", undefined, "does not exist"],
      ["corrupt.db", Buffer.from("not a SQLite database"), "mission authority unavailable"],
      ["non-file.db", null, "mission authority unavailable"],
      ["inaccessible.db", Buffer.alloc(512), "EACCES"],
      ["oversized.db", Buffer.alloc(9 * 1024 * 1024), "history_authority_limit"],
    ];
    for (const [name, bytes, reason] of bad) {
      const file = path.join(sample.base, name);
      if (bytes === null) fs.mkdirSync(file); // Non-file locator: inaccessible to SQLite, independent of UID.
      else if (bytes !== undefined) fs.writeFileSync(file, bytes);
      if (name === "inaccessible.db") fs.chmodSync(file, 0);
      history.mutate(group.groupId, (saved) => {
        saved.missionStore.dbPath = file;
        saved.closure = { state: "closed", closedAt: "stale", evidenceRef: "not authority" };
      });
      const before = unchangedFiles();
      const unavailable = await query();
      assert.equal(unavailable.items[0].executionState, undefined);
      assert.equal(unavailable.items[0].protected, true);
      assert.equal(unavailable.items[0].closure.state, "unknown");
      assert(unavailable.items[0].reasons.join(";").includes(reason), JSON.stringify(unavailable));
      assert.deepEqual(unchangedFiles(), before);
      if (name === "inaccessible.db") fs.chmodSync(file, 0o600);
      if (bytes !== undefined && bytes !== null) assert.deepEqual(fs.readFileSync(file), bytes);
      if (bytes === undefined) assert(!fs.existsSync(file));
    }
    return { coldAuthority: "prepared from closed WAL-mode DB without sidecars",
      liveAuthority: "cancelled from committed uncheckpointed WAL; pending disposal/unbound membership protected; empty exact membership closes",
      logicalAndMainBytesUnchanged: true, catalogNativeAcpObjectsUnchanged: true,
      sqliteSidecarBookkeeping: "allowed; not byte-compared", readonlyMutation: "rejected",
      failures: "missing/corrupt/inaccessible/non-file/busy/DB+WAL and object budget protected", paidProviderCalls: 0 };
  } finally {
    await engine?.close();
    observer?.close();
    store?.close();
    fs.rmSync(sample.base, { recursive: true, force: true });
  }
}

function adapter(coordinator) {
  let tool;
  let command;
  const pi = {
    registerTool(def) { if (def.name === "agent_history") tool = def; },
    registerCommand(name, def) { if (name === "pitako") command = def.handler; },
    registerFlag() {}, on() {}, getFlag() {}, getAllTools() { return []; }, getActiveTools() { return []; },
  };
  agentInstance(pi);
  pitako(pi);
  const ctx = { cwd: "/gone", sessionManager: { getSessionId: () => coordinator }, hasUI: true };
  return {
    async read(input) {
      const result = await tool.execute("node-consult", input, undefined, undefined, ctx);
      assert(Buffer.byteLength(result.content[0].text) <= 32768);
      return result.details;
    },
    async command(args) {
      let output;
      await command(args, { ...ctx, ui: { notify(text) { output = text; } } });
      return JSON.parse(output);
    },
  };
}
async function reconstruct(api, historyId) {
  let cursor;
  const parts = [];
  do {
    const page = await api.read({ action: "read", historyId, cursor });
    for (const fragment of page.items) {
      assert.equal(fragment.byteOffset, parts.reduce((sum, bytes) => sum + bytes.length, 0));
      parts.push(Buffer.from(fragment.data, "base64"));
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return Buffer.concat(parts);
}

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === "--authority-only") {
  console.log(JSON.stringify(await authorityProof()));
} else if (process.argv[2] === "--read") {
  const api = adapter("new-coordinator");
  const current = await api.read({ action: "list" });
  assert.equal(current.items.length, 0);
  const old = await api.read({ action: "list", coordinatorSessionId: "old-coordinator" });
  assert(old.items.length);
  assert.deepEqual(await api.command("history list --coordinator-session-id old-coordinator"), old);
  const all = await api.read({ action: "list", scope: "all" });
  assert(all.items.length >= old.items.length);
  const native = await reconstruct(api, old.items[0].historyId);
  const rows = native.toString().trim().split("\n").map(JSON.parse);
  assert(rows.some((row) => row.type === "message" && row.message.role === "toolResult"));
  assert(rows.some((row) => row.type === "message" && row.message.role === "assistant"));
  console.log(JSON.stringify({ historyId: old.items[0].historyId, nativeBytes: native.length, freshProcess: true }));
} else {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pitako-history-query-node-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "worktree");
  fs.mkdirSync(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  process.env.PITAKO_DATA_DIR = path.join(root, "data");
  try {
    const config = path.join(agentDir, "pitako/config.toml");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const provider = await installMissionLocalProvider({
      agentDir, additionalModels: ["alternate"],
      toolForPrompt: () => ({ name: "agent_history", arguments: { action: "list", scope: "all" } }),
    });
    fs.writeFileSync(config, `[model_policies.developer]\nprimary = { model = "${provider.provider}/${provider.model}" }\n`);
    const available = [];
    const providerImplementation = globalThis[`__${provider.provider.replace(/\W/g, "_")}`];
    const originalStream = providerImplementation.streamSimple;
    providerImplementation.streamSimple = (...args) => {
      const names = (args[1].tools ?? []).map((tool) => tool.name);
      available.push(names);
      assert(!names.includes("agent_history"), "real child provider cannot receive history tool");
      return originalStream(...args);
    };
    const sdk = createPiExecutor();
    const result = await runAgentInstance({
      roleId: "developer", task: "Exercise excluded native history tool", cwd,
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config },
      historyOrigin: { source: "agent_run", coordinatorSessionId: "old-coordinator" },
      executor: { ...sdk, async start(input) {
        const first = await sdk.start(input);
        assert(first.session);
        return first.session.continueWith({ ...input.target, model: `${provider.provider}/alternate` },
          "Try history again after model transition", input.signal);
      } },
    });
    assert.equal(result.status, "completed");
    assert(available.length >= 4);
    const history = new WorkerHistory();
    const group = history.list().find((row) => row.identity.kind === "invocation");
    const member = group.members[0];
    const file = member.native.path;
    const before = fs.readFileSync(file);
    const native = before.toString().trim().split("\n").map(JSON.parse);
    assert(native.some((row) => row.type === "message" && row.message.role === "toolResult" &&
      row.message.isError && JSON.stringify(row).includes("agent_history")));
    const branchGroup = history.createGroup(cwd);
    const branchMember = history.admit(branchGroup.groupId, { roleId: "developer", coordinatorSessionId: "old-coordinator" });
    const manager = history.createSession(branchGroup.groupId, branchMember.historyId, cwd);
    const user = manager.appendMessage({ role: "user", content: "branch root", timestamp: Date.now() });
    const assistant = { role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
      timestamp: Date.now(), stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    manager.appendMessage({ ...assistant, content: [{ type: "toolCall", id: "branch-call-id",
      name: "read", arguments: { path: "old-branch-source" } }] });
    manager.appendMessage({ role: "toolResult", toolCallId: "branch-call-id", toolName: "read",
      content: [{ type: "text", text: "old branch native result" }], isError: false, timestamp: Date.now() });
    manager.branch(user);
    manager.appendCustomEntry("fixture.branch-action", { selected: "new branch" });
    manager.appendMessage({ ...assistant, content: [{ type: "text", text: "new branch answer" }] });
    const branchedBytes = fs.readFileSync(manager.getSessionFile());
    assert(!JSON.stringify(manager.buildSessionContext()).includes("old branch native result"), "old branch outside active context");
    assert.deepEqual(await reconstruct(adapter("old-coordinator"), branchMember.historyId), branchedBytes);
    assert(branchedBytes.toString().includes("old branch native result"));
    fs.rmSync(cwd, { recursive: true });
    const restarted = spawnSync(process.execPath, [...process.execArgv, script, "--read"], {
      env: process.env, encoding: "utf8", timeout: 30000,
    });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(fs.readFileSync(file), before);

    // Instrument actual fs windows: a 16MiB JSONL line must not be preloaded for its first fragment/header.
    const huge = path.join(root, "huge.jsonl");
    fs.writeFileSync(huge, `{"type":"session","id":"huge","version":3}\n{"type":"custom","data":"${"x".repeat(16 * 1024 * 1024)}"}\n`);
    history.mutate(group.groupId, (saved) => { saved.members[0].native.path = huge; });
    let requested = 0;
    let largest = 0;
    const originalRead = fs.readSync;
    fs.readSync = (...args) => {
      const length = args[3];
      requested += length; largest = Math.max(largest, length);
      return originalRead(...args);
    };
    syncBuiltinESMExports();
    let first;
    try {
      assert.equal(nativeHeader(huge).id, "huge");
      const api = adapter("old-coordinator");
      const headerPage = await api.read({ action: "read", historyId: member.historyId, limit: 1 });
      requested = 0;
      first = await api.read({ action: "read", historyId: member.historyId, limit: 1, cursor: headerPage.cursor });
      assert(first.cursor);
      assert(first.items[0].data);
      assert(largest <= 4096);
      assert(requested < 64 * 1024, `first large fragment read only ${requested} bytes`);
    } finally { fs.readSync = originalRead; syncBuiltinESMExports(); }
    const bounded = { fileBytes: fs.statSync(huge).size, fragmentReadBytes: requested, maxWindow: largest };

    const authority = await authorityProof();
    console.log(JSON.stringify({
      restart: JSON.parse(restarted.stdout.trim()), Hermes: "not installed in fixture; not imported by query",
      childRequests: available.length, childHistoryTool: "excluded including model transition and attempted call",
      branch: "SDK branch excludes old tool result from context; registered native reader retains it byte-for-byte",
      authority, bounded, paidProviderCalls: 0,
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
