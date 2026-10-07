import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { WorkerHistory, nativeHistoryStatus } from "../extensions/agent/history.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { executionForSession } from "../extensions/execution-identity.ts";
import { ORCHESTRATION_TOOLS } from "../extensions/profile.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === "--read") {
  const history = new WorkerHistory(); // PI_CODING_AGENT_DIR, not a worktree locator.
  const groups = history.list();
  assert.equal(groups.length, 2);
  const [persisted, preassistant] = groups.find(group => group.members.length === 2).members;
  const ordinary = groups.flatMap(group => group.members).find(member => member.instanceId === "developer-ordinary-offline");
  assert.equal(nativeHistoryStatus(ordinary).state, "present");
  assert.equal(ordinary.native.disposition.state, "disposed");
  const ordinaryEntries = SessionManager.open(ordinary.native.path).getEntries();
  assert.equal(ordinaryEntries.filter(entry => entry.type === "message" && entry.message.role === "toolResult" &&
    entry.message.toolName === "codemode").length, 3);
  assert.equal(nativeHistoryStatus(persisted).state, "present");
  assert.equal(nativeHistoryStatus(preassistant).state, "present");
  assert.equal(preassistant.terminal.status, "cancelled");
  assert.equal(preassistant.terminal.beforeFirstAssistant, true);
  const earlyEntries = SessionManager.open(preassistant.native.path).getEntries();
  assert(earlyEntries.some((entry) => entry.type === "message" && entry.message.role === "user"));
  assert(!earlyEntries.some((entry) => entry.type === "message" && entry.message.role === "assistant"));
  const before = readFileSync(persisted.native.path);
  const native = SessionManager.open(persisted.native.path);
  assert.equal(native.getSessionId(), persisted.native.sessionId);
  const entries = native.getEntries();
  assert(entries.some((entry) => entry.type === "message" && entry.message.role === "user"));
  assert(entries.some((entry) => entry.type === "message" && entry.message.role === "assistant" &&
    entry.message.content.some((part) => part.type === "text" && part.text === "T1 offline native assistant")));
  assert.deepEqual(readFileSync(persisted.native.path), before);
  console.log(JSON.stringify({ freshProcess: true, entries: entries.length, preassistant: "cancelled-with-retained-user" }));
} else {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-history-sdk-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "worktree");
  mkdirSync(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  let session;
  let child;
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
    // Pi 1.0.4 persists user messages without an assistant; file existence
    // does not establish lifecycle completion.
    earlyManager.appendMessage({ role: "user", content: "preassistant input", timestamp: Date.now() });
    earlyManager.appendCustomEntry("fixture-preassistant", { version: 1 });
    assert.equal(existsSync(earlyManager.getSessionFile()), true);
    history.recordTerminal(group.groupId, early.historyId, { status: "cancelled", beforeFirstAssistant: true });
    history.recordDisposition(group.groupId, early.historyId, { state: "disposed", at: new Date().toISOString() });
    writeFileSync(path.join(cwd, "sample.txt"), "owned child text\n");
    const hooks = [];
    globalThis.__ordinaryChildHooks = hooks;
    writeFileSync(path.join(agentDir, "extensions", "child-hooks.js"), `export default function (pi) {
      pi.on("tool_call", event => {
        globalThis.__ordinaryChildHooks.push({ type: "call", name: event.toolName, input: event.input });
        if (event.toolName === "read" && event.input.path === "blocked.txt") return { block: true, reason: "owned hook denial" };
      });
      pi.on("tool_result", event => {
        globalThis.__ordinaryChildHooks.push({ type: "result", name: event.toolName, content: event.content });
        if (event.toolName === "read" && !event.isError) return { content: [{ type: "text", text: "hook transformed read" }] };
      });
    }\n`);
    const scripts = [
      `text(await tools.read({path:"sample.txt"})); text(await tools.bash({command:"pwd; printf child-shell"}));
       text(ALL_TOOLS.map(t => t.name));`,
      `for (const call of [() => tools.read({path:"blocked.txt"}), () => tools.bash({})]) {
         try { await call(); text("unexpected success"); } catch (error) { text(error.message); }
       }`,
      `await tools.read({path:"missing.txt"});`,
    ];
    const ordinaryProvider = await installMissionLocalProvider({
      agentDir, responseForPrompt: () => "ordinary child completed",
      toolTurns: 5,
      toolForPrompt(_prompt, completed) {
        return completed < 3 ? { name: "codemode", arguments: { code: scripts[completed] } }
          : completed === 3 ? { name: "read", arguments: { path: "sample.txt" } }
          : { name: "bash", arguments: { command: "printf direct-shell" } };
      },
    });
    const driver = globalThis.__pitako_mission_local;
    const stream = driver.streamSimple;
    driver.streamSimple = (model, context, options) => {
      const names = getCurrentTools(context.messages).map(tool => tool.name);
      for (const name of ["codemode", "read", "bash", "grep", "find", "ls"]) assert(names.includes(name), name);
      for (const name of ORCHESTRATION_TOOLS) assert(!names.includes(name), name);
      return stream(model, context, options);
    };
    const events = [];
    child = await createPiExecutor().start({
      instanceId: "developer-ordinary-offline",
      role: { id: "developer", name: "Developer", description: "fixture", instructionsPath: "roles/developer.md",
        instructions: "Offline fixture", skills: [], principles: [], modelPolicyId: "developer",
        modelPolicy: { id: "developer", fallbacks: [] } },
      task: "exercise ordinary public codemode", cwd,
      target: { model: `${ordinaryProvider.provider}/${ordinaryProvider.model}`, reasoning: "off" },
      signal: new AbortController().signal,
      onActivity(event) { if (event.type === "tool_execution_end") events.push(event); },
    });
    assert.equal(child.status, "completed", child.error);
    assert.equal(child.result, "ordinary child completed");
    const codeResults = events.filter(event => event.toolName === "codemode");
    assert.equal(codeResults.length, 3);
    const output = event => event.result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    assert.match(output(codeResults[0]), /Script completed/);
    assert.match(output(codeResults[0]), /hook transformed read/);
    assert.match(output(codeResults[0]), new RegExp(cwd));
    assert.match(output(codeResults[0]), /child-shell/);
    for (const name of ORCHESTRATION_TOOLS) assert(!output(codeResults[0]).includes(`"${name}"`), name);
    assert.match(output(codeResults[1]), /owned hook denial/);
    assert.match(output(codeResults[1]), /command/);
    assert(!output(codeResults[1]).includes("unexpected success"));
    assert.match(output(codeResults[2]), /Script failed/);
    assert.match(output(codeResults[2]), /missing.txt/);
    assert(hooks.some(event => event.type === "call" && event.name === "read" && event.input.path === "blocked.txt"));
    assert(!hooks.some(event => event.type === "call" && event.name === "bash" && !event.input.command));
    assert(hooks.some(event => event.type === "result" && event.name === "read" &&
      event.content.some(part => part.type === "text" && part.text.includes("owned child text"))));
    assert(hooks.some(event => event.type === "result" && event.name === "bash"));
    assert(events.some(event => event.toolName === "read" && event.parentToolCallId));
    assert(events.some(event => event.toolName === "bash" && event.parentToolCallId));
    assert.match(output(events.find(event => event.toolName === "bash" && !event.parentToolCallId)), /direct-shell/);
    const childMember = history.list().flatMap(group => group.members).find(member => member.instanceId === "developer-ordinary-offline");
    assert(childMember);
    const childEntries = SessionManager.open(childMember.native.path).getEntries();
    assert(childEntries.some(entry => entry.type === "message" && entry.message.role === "assistant"));
    assert.equal(executionForSession(childMember.native.sessionId).roleId, "developer");
    await child.session.dispose();
    child = undefined;
    assert.equal(executionForSession(childMember.native.sessionId), undefined);
    assert.equal(statSync(manager.getSessionDir()).mode & 0o777, 0o700);
    rmSync(cwd, { recursive: true });
    const reader = spawnSync(process.execPath, [...process.execArgv, script, "--read"], {
      env: process.env, encoding: "utf8", timeout: 30000,
    });
    assert.equal(reader.status, 0, reader.stderr);
    const observations = {
      sdk: "installed public SDK under Node", providerCalls: provider.trace.length, paidCalls: 0,
      nativeHeader: lines[0].type, recovered: JSON.parse(reader.stdout.trim()),
      removedWorktree: true, nativeDirectoryMode: "0700",
      catalogMode: (statSync(path.join(history.catalogDir, `${group.groupId}.json`)).mode & 0o777).toString(8),
      ordinaryChild: { providerCalls: ordinaryProvider.trace.length, codemodeCalls: codeResults.length,
        actualReadBash: true, hooks: true, validation: true, orchestrationExcluded: true, disposedIdentity: true },
    };
    if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(observations, null, 2)}\n`);
    console.log(JSON.stringify(observations));
  } finally {
    await session?.dispose();
    await child?.session?.dispose();
    delete globalThis.__ordinaryChildHooks;
    delete globalThis.__pitako_mission_local;
    rmSync(root, { recursive: true, force: true });
  }
}
