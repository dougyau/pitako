import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { InvocationHistory, WorkerHistory } from "../extensions/agent/history.ts";
import agentInstance from "../extensions/agent/index.ts";
import pitako from "../extensions/index.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { runAgentInstance } from "../extensions/agent/run.ts";
import { createPiMissionRunner, MissionEngine } from "../extensions/mission/engine.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "../tests/mission-fixtures.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";

const script = fileURLToPath(import.meta.url);
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const markers = ["T6adhocunique", "T6failedunique", "T6durableunique"];

// Public registration harness: only the real extension's registered handlers execute.
// No parser, indexer, SQLite writes or fabricated search results.
function registration() {
  const tools = new Map();
  const commands = new Map();
  const hooks = new Map();
  const notices = [];
  const pi = {
    registerTool(def) { tools.set(def.name, def); },
    registerCommand(name, def) { commands.set(name, def.handler); },
    on(name, handler) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
    registerFlag() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
    getFlag() {}, getAllTools() { return []; }, getActiveTools() { return []; },
    setActiveTools() {}, getSessionName() {}, setSessionName() {},
    events: { on() {}, emit() {} },
  };
  const ctx = { cwd: process.env.T6_CWD, hasUI: true,
    sessionManager: SessionManager.inMemory(process.env.T6_CWD),
    ui: { notify(text) { notices.push(text); }, setStatus() {}, setWidget() {} } };
  return { pi, tools, commands, notices, ctx,
    async emit(name) { for (const hook of hooks.get(name) ?? []) await hook({ type: name }, ctx); },
    async tool(name, args) {
      return tools.get(name).execute("t6-public", args, undefined, undefined, ctx);
    },
  };
}

if (process.argv[2] === "--setup-rejection") {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-history-rejection-"));
  const observations = [];
  try {
    for (const boundary of ["unsafe-root", "foreign-alias", "persisted-intent", "inherited-pending"]) {
      const agentDir = path.join(root, boundary);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.T6_CWD = root;
      const store = new WorkerHistory();
      const dbPath = path.join(agentDir, "mission.db");
      // Deliberately unavailable authority: consultation must protect, not infer closure.
      writeFileSync(dbPath, "unavailable authority fixture");
      const sessionsDirectory = path.join(agentDir, "private-sessions");
      const group = store.missionGroup(root, "mission", { dbPath, objectDir: root, sessionsDirectory }, false);
      const id = randomUUID();
      const invocation = new InvocationHistory(root, undefined, "setup rejected", false, {
        groupId: group.groupId, admission: { roleId: "developer", attemptId: id },
      });
      let history = invocation.admit("instance", "developer", { model: "fixture/local" });
      const target = path.join(sessionsDirectory, "mission", id);
      mkdirSync(target, { recursive: true });
      const manager = SessionManager.create(root, target, { id });
      const nativeFile = manager.getSessionFile();
      if (boundary === "foreign-alias" || boundary === "inherited-pending") manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "owned native bytes before rejection" }],
        api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      const nativeBefore = existsSync(nativeFile) ? readFileSync(nativeFile) : undefined;
      const discoveryRoot = path.join(agentDir, "sessions");
      const alias = path.join(discoveryRoot, `--pitako-workers--${group.groupId}-${id}`);
      const foreign = path.join(agentDir, "foreign");
      mkdirSync(foreign);
      const sentinel = path.join(foreign, "sentinel");
      writeFileSync(sentinel, "foreign bytes");
      if (boundary === "inherited-pending") {
        history.associate(manager); // Prior pending is produced by ordinary registration, not catalog mutation.
        history = invocation.admit("fresh-instance", "developer", { model: "fixture/local" });
        rmSync(alias, { recursive: true });
      } else if (boundary === "unsafe-root") symlinkSync(foreign, discoveryRoot, "dir");
      else mkdirSync(discoveryRoot);
      if (boundary === "foreign-alias" || boundary === "inherited-pending") symlinkSync(foreign, alias, "dir");
      const inherited = store.read(group.groupId).members[0].native;
      const registeredNativeBefore = existsSync(nativeFile) ? readFileSync(nativeFile) : nativeBefore;
      const originalSymlink = fs.symlinkSync;
      let safetyError;
      try {
        if (boundary === "persisted-intent") {
          // One file-operation fault only: production inner intent write executes first.
          fs.symlinkSync = () => { throw Object.assign(new Error("fixture discovery link denied"), { code: "EACCES" }); };
          syncBuiltinESMExports();
        }
        try { history.associate(manager); }
        catch (error) { safetyError = error; }
      } finally {
        fs.symlinkSync = originalSymlink;
        syncBuiltinESMExports();
      }
      assert(safetyError, "association must fail");
      assert.equal(safetyError.message, boundary === "unsafe-root" ? "unsafe worker discovery root" :
        boundary === "persisted-intent" ? "fixture discovery link denied" : "unsafe worker discovery alias");
      const attempt = { status: "failed", result: "", error: safetyError.message, sideEffects: false };
      assert.equal(history.result(attempt), attempt, "setup error/result survives lifecycle recording");
      invocation.settled();
      const saved = store.read(group.groupId);
      const member = saved.members[0];
      assert.equal(member.terminal.status, "failed");
      assert.equal(member.terminal.reason, safetyError.message);
      assert.equal(member.terminal.beforeFirstAssistant, true);
      assert.equal(member.gaps.length, 1);
      assert.equal(saved.closure.state, "unclosed");
      assert.equal(readFileSync(sentinel, "utf8"), "foreign bytes");
      if (registeredNativeBefore) assert.deepEqual(readFileSync(nativeFile), registeredNativeBefore, "rejected manager is not appended");
      else assert.equal(existsSync(nativeFile), false, "no native bootstrap on rejection");
      if (boundary === "persisted-intent") {
        assert.equal(member.native.state, "allocated");
        assert.equal(member.native.path, nativeFile);
        assert.equal(member.native.disposition.state, "unknown");
        assert.deepEqual(saved.aliases, [{ path: alias, target }]);
        assert.throws(() => lstatSync(alias), { code: "ENOENT" });
      } else if (boundary === "inherited-pending") {
        assert.equal(member.native.disposition.state, "pending");
        assert.deepEqual(member.native, inherited, "fresh prewrite rejection preserves inherited pending");
        assert.deepEqual(saved.aliases, [{ path: alias, target }]);
        assert.equal(readlinkSync(alias), foreign);
      } else {
        assert.equal(member.native.state, "not-created");
        assert.equal(saved.aliases, undefined);
        if (boundary === "unsafe-root") {
          assert.equal(readlinkSync(discoveryRoot), foreign);
          assert.throws(() => lstatSync(alias), { code: "ENOENT" });
        } else assert.equal(readlinkSync(alias), foreign);
      }
      const api = registration();
      agentInstance(api.pi);
      const listed = (await api.tool("agent_history", { action: "list", scope: "all" })).details;
      const visible = listed.items.find((item) => item.historyId === history.historyId);
      assert.equal(visible.terminal.reason, safetyError.message);
      assert.equal(visible.group.protected, true);
      const read = (await api.tool("agent_history", { action: "read", historyId: history.historyId })).details;
      if (boundary === "inherited-pending") assert(read.items.length > 0, "registered native assistant remains readable");
      else assert.equal(read.items.length, 0);
      assert(read.diagnostics.some((item) => item.code === "capture_gaps"));
      if (boundary !== "inherited-pending") assert(read.diagnostics.some((item) => item.code === (boundary === "persisted-intent"
        ? "native_not_persisted_before_assistant" : "native_not_created")));
      if (boundary === "persisted-intent") {
        // Recover the exact saved intent; repeated association must not duplicate/adopt.
        const recovery = new InvocationHistory(root, undefined, "recover allocation", false, {
          groupId: group.groupId, admission: { roleId: "developer", attemptId: id },
        }).admit("recovered-instance", "developer", { model: "fixture/local" });
        recovery.associate(manager);
        recovery.associate(manager);
        assert.equal(lstatSync(alias).isSymbolicLink(), true);
        assert.equal(readlinkSync(alias), target);
        const recovered = store.read(group.groupId);
        assert.equal(recovered.aliases.length, 1);
        assert.equal(recovered.members[0].native.path, nativeFile);
        assert.equal(recovered.members[0].native.disposition.state, "pending");
        assert.deepEqual(recovered.members[0].terminal, member.terminal);
        assert.equal(existsSync(nativeFile), false);
      }
      if (boundary === "inherited-pending") {
        rmSync(alias, { recursive: true });
        symlinkSync(target, alias, "dir");
        const registered = invocation.admit("registered-again", "developer", { model: "fixture/local" });
        registered.associate(manager);
        registered.result({ status: "failed", result: "", error: "setup without handle", sideEffects: false });
        const unknown = store.read(group.groupId).members[0].native;
        assert.equal(unknown.disposition.state, "unknown", "successful current registration without a handle remains uncertain");
        invocation.admit("no-registration", "developer", { model: "fixture/local" })
          .result({ status: "failed", result: "", error: "rejected before registration", sideEffects: false });
        assert.deepEqual(store.read(group.groupId).members[0].native, unknown, "inherited unknown reason survives fresh no-registration result");
        const recovered = invocation.admit("reassociated", "developer", { model: "fixture/local" });
        recovered.associate(manager);
        assert.equal(store.read(group.groupId).members[0].native.disposition.state, "pending");
      }
      observations.push({ boundary, error: safetyError.message, native: member.native,
        terminal: member.terminal, gaps: member.gaps, protected: visible.group.protected, diagnostics: read.diagnostics });
    }
    console.log(JSON.stringify({ publicSDK: true, productionSessionHistory: true, paidCalls: 0, providerCalls: 0, observations }));
  } finally { rmSync(root, { recursive: true, force: true }); }
} else if (process.argv[2] === "--observe") {
  const mode = process.argv[3];
  const api = registration();
  agentInstance(api.pi); pitako(api.pi);
  if (mode !== "native") {
    const { default: hermes } = await import("../node_modules/pi-hermes-memory/src/index.ts");
    hermes(api.pi);
    await api.emit("session_start");
    // Ordinary startup backfill is deferred by upstream setTimeout(0).
    // Wait on its observable public notification, not a private backfill promise.
    const deadline = Date.now() + 10000;
    while (!api.notices.some((text) => text.includes("Session backfill complete"))) {
      assert(Date.now() < deadline, JSON.stringify(api.notices));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(api.notices.some((text) => text.includes("4 indexed, 0 skipped, 7 messages")), JSON.stringify(api.notices));
  }
  const listed = (await api.tool("agent_history", { action: "list", scope: "all", limit: 1 })).details;
  const items = [...listed.items];
  let cursor = listed.cursor;
  while (cursor) {
    const page = (await api.tool("agent_history", { action: "list", scope: "all", cursor, limit: 1 })).details;
    items.push(...page.items); cursor = page.cursor;
  }
  const workers = items.filter((item) => item.historyId);
  assert(workers.length >= 4, JSON.stringify(items));
  assert(workers.some((item) => item.terminal?.status === "failed"), "operator sees failed worker summary");
  let output;
  await api.commands.get("pitako")("history list --scope all --limit 1", {
    ...api.ctx, ui: { notify(text) { output = JSON.parse(text); } },
  });
  assert.deepEqual(output, listed);
  const nativeBefore = new WorkerHistory().list().flatMap((group) => group.members)
    .filter((member) => member.native.state === "allocated")
    .map((member) => [member.native.path, hash(member.native.path)]);
  const records = [];
  for (const worker of workers) {
    const chunks = [];
    let cursor;
    let pages = 0;
    do {
      const page = (await api.tool("agent_history", { action: "read", historyId: worker.historyId, cursor, limit: 1 })).details;
      chunks.push(...page.items.map((part) => Buffer.from(part.data, "base64")));
      cursor = page.cursor; pages++;
    } while (cursor);
    const bytes = Buffer.concat(chunks);
    const rows = bytes.toString().trim().split("\n").map(JSON.parse);
    assert(rows.some((row) => row.customType === "pitako.worker-history" && row.data.event === "origin"));
    assert(rows.some((row) => row.type === "message" && row.message.role === "user"));
    assert(rows.some((row) => row.type === "message" && row.message.role === "assistant"));
    const conditions = rows.filter((row) => row.customType === "pitako.worker-history").map((row) => row.data.event);
    assert(conditions.includes("selection") && conditions.includes("result") && conditions.includes("disposal"));
    const toolResults = rows.filter((row) => row.type === "message" && row.message.role === "toolResult").length;
    records.push({ historyId: worker.historyId, terminal: worker.terminal, pages, conditions, toolResults });
  }
  assert(records.some((record) => record.toolResults > 0));
  assert.deepEqual(nativeBefore.map(([file]) => [file, hash(file)]), nativeBefore);
  const searches = [];
  if (mode !== "native") {
    for (const marker of markers) {
      const result = await api.tool("session_search", { query: marker });
      assert.equal(result.details.success, true, JSON.stringify(result));
      assert(result.details.count > 0 && result.content[0].text.includes(marker), JSON.stringify(result));
      searches.push({ marker, ...result.details });
    }
    const excluded = await api.tool("session_search", { query: "T6toolresultunique" });
    assert.equal(excluded.details.count, 0, "upstream omits tool results; native reader recovered them");
    await api.commands.get("memory-index-sessions")("", api.ctx);
    const found = api.notices.find((text) => text.includes("Found") && text.includes("session files"));
    assert(found?.includes(mode === "divergent" ? "Found 0 session files" : "Found 4 session files"), found);
    assert(api.notices.some((text) => text.includes("Session indexing complete")));
    await api.emit("session_shutdown");
  }
  console.log(JSON.stringify({ mode, freshProcess: true, workers: records, searches, notices: api.notices, nativeUnchanged: true }));
} else {
  const sample = createMissionFixture("pitako-history-hermes-");
  const isolation = mkdtempSync(path.join(tmpdir(), "pitako-hermes-home-"));
  const agentDir = path.join(isolation, "agent");
  process.env.HOME = isolation;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(isolation, "divergent");
  process.env.PI_OFFLINE = "1";
  process.env.PITAKO_DATA_DIR = path.join(isolation, "data");
  process.env.T6_CWD = sample.root;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  writeFileSync(path.join(agentDir, "hermes-memory-config.json"), JSON.stringify({
    reviewEnabled: false, flushOnCompact: false, flushOnShutdown: false,
    correctionDetection: false, autoConsolidate: false, sessionSearch: { variant: "legacy" },
  }));
  const config = path.join(agentDir, "pitako/config.toml"); mkdirSync(path.dirname(config), { recursive: true });
  const provider = await installMissionLocalProvider({ agentDir,
    responseForPrompt: (prompt) => prompt.includes("T6adhocunique") ? "T6adhocunique answer" :
      prompt.includes("T6failedunique") ? "T6failedunique answer" : "T6durableunique answer",
    toolForPrompt: (prompt) => prompt.includes("T6adhocunique") || prompt.includes("T6failedunique")
      ? { name: "read", arguments: { path: "marker.txt" } } : undefined,
    errorForRequest: (prompt, _model, afterTool) => prompt.includes("T6failedunique") && afterTool ? "T6 controlled failure after native tool result" : undefined,
  });
  writeFileSync(path.join(sample.root, "marker.txt"), "T6toolresultunique");
  writeFileSync(config, `[model_policies.developer]\nprimary = { model = "${provider.provider}/${provider.model}" }\n`);
  const sdk = createPiExecutor();
  const store = await openFixtureStore(sample);
  let engine;
  try {
    for (const task of markers.slice(0, 2)) {
      const result = await runAgentInstance({ roleId: "developer", task, cwd: sample.root, executor: sdk,
        load: { userConfigPath: config }, historyOrigin: { source: "agent_run", coordinatorSessionId: "T6old" } });
      assert.equal(result.status, task === markers[0] ? "completed" : "failed");
    }
    const definition = missionDefinition(); definition.units[0].retryLimit = 1;
    definition.budget = { roleLaunches: 10, providerRequests: 10, tokens: 10000, activeTimeMs: 600000, artifactBytes: 2500000 };
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    const mission = store.createMission(missionInput(sample));
    let assessments = 0;
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(isolation, "private-sessions"),
      runRole: createPiMissionRunner({ cwd: sample.root, executor: sdk, load: { userConfigPath: config } }),
      assessPredicate: async () => ({ verdict: ++assessments === 1 ? "fail" : "pass", method: "T6 controlled predicate" }),
    });
    engine.start(); await engine.waitForIdle();
    assert.equal(assessments, 2);
    await engine.control("cancel"); await engine.close(); engine = undefined;
    store.close();
    const history = new WorkerHistory();
    const managed = history.list().find((group) => group.identity.kind === "mission");
    assert.equal(managed.members.length, 2);
    assert.equal(managed.aliases.length, 2);
    for (const member of managed.members) {
      assert(member.native.path.startsWith(path.join(isolation, "private-sessions")));
      assert(!member.native.path.startsWith(path.join(agentDir, "sessions")));
    }
    const catalogBefore = history.list().map((group) => [path.join(history.catalogDir, `${group.groupId}.json`), hash(path.join(history.catalogDir, `${group.groupId}.json`))]);
    const observe = (mode) => {
      const env = { ...process.env, PI_CODING_AGENT_SESSION_DIR: mode === "matching" ? path.join(agentDir, "sessions") : process.env.PI_CODING_AGENT_SESSION_DIR };
      const child = spawnSync("node", ["--experimental-transform-types", "--import", "./scripts/sdk-node-loader.mjs", script, "--observe", mode],
        { env, encoding: "utf8", timeout: 60000 });
      assert.equal(child.status, 0, child.stderr + child.stdout);
      return JSON.parse(child.stdout.trim());
    };
    const native = observe("native");
    // SDK workers can index their own live messages. Remove that isolated index
    // before restart: discovery must succeed via ordinary backfill alone.
    rmSync(path.join(agentDir, "pi-hermes-memory"), { recursive: true });
    const divergent = observe("divergent");
    // Clear only the isolated secondary index so matching-root ordinary backfill runs anew.
    rmSync(path.join(agentDir, "pi-hermes-memory"), { recursive: true });
    const matching = observe("matching");
    assert.deepEqual(catalogBefore.map(([file]) => [file, hash(file)]), catalogBefore);
    console.log(JSON.stringify({ upstream: "pi-hermes-memory 0.9.9 installed ordinary mode", paidCalls: 0,
      localRequests: provider.trace.length, canonicalManaged: true, native, divergent, matching }));
  } finally {
    await engine?.close(); store.close();
    rmSync(sample.base, { recursive: true, force: true }); rmSync(isolation, { recursive: true, force: true });
  }
}
