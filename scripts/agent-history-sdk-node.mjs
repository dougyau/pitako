import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { WorkerHistory, nativeHistoryStatus } from "../extensions/agent/history.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === "--read") {
  const history = new WorkerHistory(); // PI_CODING_AGENT_DIR, not a worktree locator.
  const groups = history.list();
  assert.equal(groups.length, 1);
  const [persisted, preassistant] = groups[0].members;
  assert.equal(nativeHistoryStatus(persisted).state, "present");
  assert.equal(nativeHistoryStatus(preassistant).state, "not-persisted-before-assistant");
  const before = readFileSync(persisted.native.path);
  const native = SessionManager.open(persisted.native.path);
  assert.equal(native.getSessionId(), persisted.native.sessionId);
  const entries = native.getEntries();
  assert(entries.some((entry) => entry.type === "message" && entry.message.role === "user"));
  assert(entries.some((entry) => entry.type === "message" && entry.message.role === "assistant" &&
    entry.message.content.some((part) => part.type === "text" && part.text === "T1 offline native assistant")));
  assert.deepEqual(readFileSync(persisted.native.path), before);
  console.log(JSON.stringify({ freshProcess: true, entries: entries.length, preassistant: "not-persisted-before-assistant" }));
} else {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-history-sdk-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "worktree");
  mkdirSync(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  let session;
  try {
    const history = new WorkerHistory();
    assert.equal(history.agentDir, agentDir);
    const group = history.createGroup(cwd);
    const member = history.admit(group.groupId, { roleId: "developer", coordinatorSessionId: "fixture-coordinator" });
    const manager = history.createSession(group.groupId, member.historyId, cwd);
    assert.equal(existsSync(manager.getSessionFile()), false);
    const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: () => "T1 offline native assistant" });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noContextFiles: true, noThemes: true,
      noSkills: true, noPromptTemplates: true,
    });
    await loader.reload();
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false,
    });
    session = (await createAgentSession({
      cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime: runtime,
      sessionManager: manager, tools: [],
    })).session;
    await session.bindExtensions({ mode: "rpc" });
    const model = runtime.getModel(provider.provider, provider.model);
    assert(model);
    await session.setModel(model);
    assert.equal(existsSync(manager.getSessionFile()), false);
    await session.prompt("T1 offline input");
    assert.equal(provider.trace.length, 1);
    assert.equal(existsSync(manager.getSessionFile()), true);
    const lines = readFileSync(manager.getSessionFile(), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(lines[0].type, "session");
    assert.equal(lines[0].id, manager.getSessionId());
    assert(lines.some((entry) => entry.type === "message" && entry.message.role === "assistant"));
    history.recordTerminal(group.groupId, member.historyId, { status: "completed", beforeFirstAssistant: false });
    await session.dispose();
    session = undefined;
    history.recordDisposition(group.groupId, member.historyId, { state: "disposed", at: new Date().toISOString() });
    const early = history.admit(group.groupId, { roleId: "developer" });
    const earlyManager = history.createSession(group.groupId, early.historyId, cwd);
    // Native user/custom records alone must not force first persistence.
    earlyManager.appendMessage({ role: "user", content: "preassistant input", timestamp: Date.now() });
    earlyManager.appendCustomEntry("fixture-preassistant", { version: 1 });
    assert.equal(existsSync(earlyManager.getSessionFile()), false);
    history.recordTerminal(group.groupId, early.historyId, { status: "cancelled", beforeFirstAssistant: true });
    history.recordDisposition(group.groupId, early.historyId, { state: "disposed", at: new Date().toISOString() });
    assert.equal(statSync(manager.getSessionDir()).mode & 0o777, 0o700);
    rmSync(cwd, { recursive: true });
    const reader = spawnSync(process.execPath, [script, "--read"], {
      env: process.env, encoding: "utf8", timeout: 30000,
    });
    assert.equal(reader.status, 0, reader.stderr);
    const observations = {
      sdk: "installed public SDK under Node", providerCalls: provider.trace.length, paidCalls: 0,
      nativeHeader: lines[0].type, recovered: JSON.parse(reader.stdout.trim()),
      removedWorktree: true, nativeDirectoryMode: "0700",
      catalogMode: (statSync(path.join(history.catalogDir, `${group.groupId}.json`)).mode & 0o777).toString(8),
    };
    if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(observations, null, 2)}\n`);
    console.log(JSON.stringify(observations));
  } finally {
    await session?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}
