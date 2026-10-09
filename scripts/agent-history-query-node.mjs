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
import { installLocalProvider } from "../tests/local-provider.ts";

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
if (process.argv[2] === "--read") {
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
    const provider = await installLocalProvider({
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

    console.log(JSON.stringify({
      restart: JSON.parse(restarted.stdout.trim()), Hermes: "not installed in fixture; not imported by query",
      childRequests: available.length, childHistoryTool: "excluded including model transition and attempted call",
      branch: "SDK branch excludes old tool result from context; registered native reader retains it byte-for-byte",
      bounded, paidProviderCalls: 0,
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
