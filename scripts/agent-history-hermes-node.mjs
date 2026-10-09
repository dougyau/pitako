import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkerHistory } from "../extensions/agent/history.ts";
import agentInstance from "../extensions/agent/index.ts";
import pitako from "../extensions/index.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { runAgentInstance } from "../extensions/agent/run.ts";
import { installLocalProvider } from "../tests/local-provider.ts";

const script = fileURLToPath(import.meta.url);
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const markers = ["T6adhocunique", "T6failedunique", "T6ordinaryunique"];

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

if (process.argv[2] === "--observe") {
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
  const isolation = mkdtempSync(path.join(tmpdir(), "pitako-hermes-home-"));
  const cwd = path.join(isolation, "repo");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  const agentDir = path.join(isolation, "agent");
  process.env.HOME = isolation;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(isolation, "divergent");
  process.env.PI_OFFLINE = "1";
  process.env.PITAKO_DATA_DIR = path.join(isolation, "data");
  process.env.T6_CWD = cwd;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  writeFileSync(path.join(agentDir, "hermes-memory-config.json"), JSON.stringify({
    reviewEnabled: false, flushOnCompact: false, flushOnShutdown: false,
    correctionDetection: false, autoConsolidate: false, sessionSearch: { variant: "legacy" },
  }));
  const config = path.join(agentDir, "pitako/config.toml"); mkdirSync(path.dirname(config), { recursive: true });
  const provider = await installLocalProvider({ agentDir,
    responseForPrompt: (prompt) => prompt.includes("T6adhocunique") ? "T6adhocunique answer" :
      prompt.includes("T6failedunique") ? "T6failedunique answer" : "T6ordinaryunique answer",
    toolForPrompt: (prompt) => prompt.includes("T6adhocunique") || prompt.includes("T6failedunique")
      ? { name: "read", arguments: { path: "marker.txt" } } : undefined,
    errorForRequest: (prompt, _model, afterTool) => prompt.includes("T6failedunique") && afterTool ? "T6 controlled failure after native tool result" : undefined,
  });
  writeFileSync(path.join(cwd, "marker.txt"), "T6toolresultunique");
  writeFileSync(config, `[model_policies.developer]\nprimary = { model = "${provider.provider}/${provider.model}" }\n`);
  const sdk = createPiExecutor();
  try {
    for (const task of [...markers, markers[2]]) {
      const result = await runAgentInstance({ roleId: "developer", task, cwd, executor: sdk,
        load: { userConfigPath: config }, historyOrigin: { source: "agent_run", coordinatorSessionId: "T6old" } });
      assert.equal(result.status, task === markers[1] ? "failed" : "completed");
    }
    const history = new WorkerHistory();
    assert.equal(history.list().length, 4);
    for (const group of history.list()) {
      assert.equal(group.identity.kind, "invocation");
      assert.equal(group.aliases, undefined, "ordinary workers need no managed discovery aliases");
      for (const member of group.members) {
        assert(member.native.path.startsWith(path.join(agentDir, "sessions")));
        assert.equal(member.native.disposition.state, "disposed");
      }
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
      localRequests: provider.trace.length, ordinaryWorkers: true, native, divergent, matching }));
  } finally {
    rmSync(isolation, { recursive: true, force: true });
  }
}
