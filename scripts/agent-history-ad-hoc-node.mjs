import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { WorkerHistory, nativeHistoryStatus } from "../extensions/agent/history.ts";
import "./sdk-node-loader.mjs";
const { createPiExecutor } = await import("../extensions/agent/pi.ts");
import { runAgentInstance } from "../extensions/agent/run.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";

const script = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(script), "..");
const mode = process.argv[2];
const base = mode?.startsWith("--") ? process.argv[3] : mkdtempSync(path.join(tmpdir(), "pitako-ad-hoc-history-"));
const cwd = path.join(base, "worktree");
const agentDir = path.join(base, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";

function entries(member) {
  assert.equal(member.native.state, "allocated");
  return SessionManager.open(member.native.path).getEntries();
}

function provenance(member) {
  return entries(member).filter((entry) => entry.type === "custom" && entry.customType === "pitako.worker-history");
}

function config(primary = "fixture", fallback) {
  const file = path.join(agentDir, "pitako", "config.toml");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `[model_policies.developer]\nprimary = { model = "pitako-history-local/${primary}", reasoning = "off" }\n` +
    (fallback ? `fallbacks = [{ model = "pitako-history-local/${fallback}", reasoning = "off" }]\n` : ""));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 60000;
  while (!predicate()) {
    assert(Date.now() < deadline, "fixture completion deadline");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

if (mode === "--read") {
  assert.equal(existsSync(cwd), false);
  const groups = new WorkerHistory().list();
  const crash = groups.find((group) => group.members.some((member) => member.native.state === "allocated" &&
      member.native.disposition.state === "pending" && !member.terminal));
  assert(crash, "interrupted worker discoverable");
  assert.equal(crash.closure.state, "unclosed");
  const interrupted = crash.members[0];
  assert.equal(nativeHistoryStatus(interrupted).state, "present");
  assert(entries(interrupted).some((entry) => entry.type === "message" && entry.message.role === "toolResult"));
  for (const group of groups) {
    for (const member of group.members) {
      if (nativeHistoryStatus(member).state !== "present") continue;
      const before = readFileSync(member.native.path);
      const native = SessionManager.open(member.native.path);
      assert.equal(native.getSessionId(), member.native.sessionId);
      assert(native.getEntries().length > 0);
      assert(provenance(member).some((entry) => entry.data.event === "origin" && entry.data.data.workbrief));
      assert.deepEqual(readFileSync(member.native.path), before);
    }
  }
  console.log(JSON.stringify({ recoveredGroups: groups.length, interrupted: "unclosed", removedWorktree: true }));
} else {
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(cwd, "marker.txt"), "native tool result marker");
  config();
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  let foreground;
  try {
    const provider = await installMissionLocalProvider({
      agentDir, provider: "pitako-history-local", additionalModels: ["replacement"],
      responseForPrompt: () => "Offline worker completed.",
      toolForPrompt(prompt) {
        prompt = prompt.split("\n")[0];
        if (prompt.startsWith("dispatch ") || prompt.startsWith("watched ")) {
          const name = prompt.slice(prompt.indexOf(" ") + 1);
          return { name, arguments: { role: "developer", task: `original ${name} workbrief`,
            ...(prompt.startsWith("watched ") ? { plan: "history-shared", unit: "T1" } : {}) } };
        }
        if (prompt === "side-effect" || prompt === "crash") return {
          name: "bash", arguments: { command: `printf retained > ${prompt}-marker.txt` },
        };
        return { name: "read", arguments: { path: "marker.txt" } };
      },
      errorForRequest(prompt, model, afterTool, signal) {
        if (signal?.aborted) return "Request was aborted";
        prompt = prompt.split("\n")[0];
        if (mode === "--crash" && prompt === "crash" && afterTool) process.exit(73);
        if (model === "fixture" && (prompt === "replacement" || prompt === "side-effect" && afterTool)) {
          return "429 rate limit fixture";
        }
      },
      async responseGate(prompt, signal) {
        if (prompt.split("\n")[0] !== "cancel") return;
        if (!signal?.aborted) await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
      },
    });
    writeFileSync(path.join(agentDir, "extensions", "history-instructions.js"), `export default function(pi) {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: event.systemPrompt + "\\nT2 observable stream instruction"
      }));
    }\n`);
    const history = new WorkerHistory();
    const run = (task, extra = {}) => runAgentInstance({
      roleId: "developer", task, cwd, executor: createPiExecutor(),
      historyOrigin: { source: "agent_run", coordinatorSessionId: "lifecycle-coordinator", workbrief: task },
      ...extra,
    });
    if (mode === "--crash") {
      await run("crash");
      throw new Error("crash fixture did not reach persisted tool boundary");
    }

    // Actual package registration and SDK tool dispatch, not an imported adapter mock.
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [packageRoot],
      noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
    const manager = SessionManager.create(cwd, path.join(agentDir, "foreground"));
    foreground = (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, resourceLoader: loader,
      settingsManager: settings, sessionManager: manager })).session;
    const errors = [];
    await foreground.bindExtensions({ mode: "rpc", onError(error) { errors.push(error); } });
    await foreground.setModel(runtime.getModel(provider.provider, provider.model));
    for (const name of ["agent_run", "agent_spawn", "team_assign"]) {
      assert(foreground.getActiveToolNames().includes(name), `${name} reachable through public package`);
      await foreground.prompt(`dispatch ${name}`);
      const toolResult = [...manager.getEntries()].reverse().find((entry) =>
        entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === name);
      assert(toolResult, `${name} dispatched: ${JSON.stringify(provider.trace)}`);
      assert.equal(toolResult.message.isError, false, JSON.stringify(toolResult.message));
      await waitFor(() => history.list().filter((group) => group.members.some((member) =>
        member.coordinatorSessionId === manager.getSessionId())).length === ["agent_run", "agent_spawn", "team_assign"].indexOf(name) + 1 &&
        history.list().filter((group) => group.members.some((member) =>
          member.coordinatorSessionId === manager.getSessionId())).every((group) => group.closure.state === "closed"));
    }
    assert.deepEqual(errors, []);
    const dispatchGroups = history.list();
    assert.equal(dispatchGroups.length, 3);
    for (const group of dispatchGroups) {
      assert.equal(group.members.length, 1);
      const member = group.members[0];
      assert.equal(member.coordinatorSessionFile, manager.getSessionFile());
      const custom = provenance(member);
      const origin = custom.find((entry) => entry.data.event === "origin").data.data;
      assert.equal(origin.workbrief, `original ${origin.origin.source} workbrief`);
      assert.equal(origin.origin.assignmentId, member.assignmentId);
      if (origin.origin.source === "team_assign") assert(member.assignmentId);
      const native = entries(member);
      assert(native.some((entry) => entry.type === "message" && entry.message.role === "assistant" &&
        entry.message.content.some((part) => part.type === "toolCall" && part.name === "read")));
      assert(native.some((entry) => entry.type === "message" && entry.message.role === "toolResult" &&
        entry.message.toolName === "read"));
      assert(custom.some((entry) => entry.data.event === "selection"));
      assert(custom.some((entry) => entry.data.event === "stream-instructions" &&
        entry.data.data.effective?.includes("T2 observable stream instruction")));
      assert(custom.some((entry) => entry.data.event === "result"));
      assert(custom.some((entry) => entry.data.event === "disposal"));
      assert.equal(native.some((entry) => entry.type === "custom_message" && entry.customType === "pitako.worker-history"), false);
    }
    const parentNative = manager.getEntries();
    for (const name of ["agent_run", "agent_spawn", "team_assign"]) assert(parentNative.some((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === name && !entry.message.isError));
    const planDir = path.join(cwd, ".pitako", "plans");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(path.join(planDir, "history-shared.md"),
      "---\nid: history-shared\nrevision: 1\nstatus: frozen\n---\n\n## T1\n\nOffline history group fixture.\n");
    for (const [index, name] of ["agent_spawn", "team_assign"].entries()) {
      await foreground.prompt(`watched ${name}`);
      const result = [...manager.getEntries()].reverse().find((entry) =>
        entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === name);
      assert.equal(result?.message.isError, false, JSON.stringify(result?.message));
      await waitFor(() => {
        const group = history.list().find((group) => group.identity.kind === "execution");
        return group?.members.length === index + 1 && group.members.every((member) =>
          member.terminal && member.native.disposition.state === "disposed") && !foreground.isStreaming;
      });
    }
    const executionGroups = history.list().filter((group) => group.identity.kind === "execution");
    assert.equal(executionGroups.length, 1);
    assert.equal(executionGroups[0].members.length, 2);
    assert.equal(executionGroups[0].closure.state, "unclosed");
    assert.equal(executionGroups[0].identity.executionRoot, cwd);
    for (const member of executionGroups[0].members) {
      const origin = provenance(member).find((entry) => entry.data.event === "origin").data.data.origin;
      assert.equal(origin.coordinatorSessionId, manager.getSessionId());
      assert.equal(origin.execution.executionRef, executionGroups[0].identity.executionRef);
    }
    await foreground.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await foreground.dispose();
    foreground = undefined;

    config("fixture", "replacement");
    const replacement = await run("replacement");
    assert.equal(replacement.status, "completed");
    const replacementGroup = history.list().find((group) => group.members.some((member) => member.instanceId === replacement.instanceId));
    assert.equal(replacementGroup.members.length, 2);
    assert.deepEqual(replacementGroup.members.map((member) => member.terminal.status), ["failed", "completed"]);
    assert.equal(new Set(replacementGroup.members.map((member) => member.native.sessionId)).size, 2);
    assert(replacementGroup.members.every((member) => nativeHistoryStatus(member).state === "present"));
    const continued = await run("side-effect");
    assert.equal(continued.status, "completed");
    const continuedGroup = history.list().find((group) => group.members.some((member) => member.instanceId === continued.instanceId));
    assert.equal(continuedGroup.members.length, 1);
    assert.equal(continuedGroup.members[0].terminal.status, "completed");
    assert.equal(readFileSync(path.join(cwd, "side-effect-marker.txt"), "utf8"), "retained");
    assert.equal(provenance(continuedGroup.members[0]).filter((entry) => entry.data.event === "continuation").length, 1);
    const effectCalls = entries(continuedGroup.members[0]).filter((entry) => entry.type === "message" && entry.message.role === "assistant")
      .flatMap((entry) => entry.message.content).filter((part) => part.type === "toolCall" && part.name === "bash");
    assert.equal(effectCalls.length, 1, "side effect not replayed");

    config("missing");
    const beforeCalls = provider.trace.length;
    const failed = await run("preassistant");
    assert.equal(failed.status, "failed");
    assert.equal(provider.trace.length, beforeCalls);
    const failedMember = history.list().find((group) => group.members.some((member) => member.instanceId === failed.instanceId)).members[0];
    assert.equal(failedMember.terminal.beforeFirstAssistant, true);
    assert.equal(nativeHistoryStatus(failedMember).state, "not-persisted-before-assistant");
    assert(failedMember.gaps.length > 0);

    config();
    const controller = new AbortController();
    const cancelledRun = run("cancel", { signal: controller.signal });
    await waitFor(() => provider.trace.some((row) => row.prompt.split("\n")[0] === "cancel"));
    controller.abort();
    const cancelled = await cancelledRun;
    assert.equal(cancelled.status, "cancelled");
    const cancelledGroup = history.list().find((group) => group.members.some((member) => member.instanceId === cancelled.instanceId));
    assert.equal(cancelledGroup.members[0].terminal.status, "cancelled");
    assert.equal(cancelledGroup.closure.state, "closed");
    const earlyController = new AbortController();
    earlyController.abort();
    const earlyCalls = provider.trace.length;
    const early = await run("cancel before SDK start", { signal: earlyController.signal });
    assert.equal(early.status, "cancelled");
    assert.equal(provider.trace.length, earlyCalls);
    const earlyGroup = history.list().find((group) => group.members.some((member) => member.instanceId === early.instanceId));
    assert.equal(earlyGroup.members[0].native.state, "not-created");
    assert.equal(earlyGroup.members[0].terminal.status, "cancelled");
    assert.equal(earlyGroup.closure.state, "closed");

    const execution = { executionRoot: cwd, executionRef: "fixture@1:immutable-hash" };
    const knownOrigin = { source: "agent_run", coordinatorSessionId: "lifecycle-coordinator", execution };
    const a = await run("execution one", { historyOrigin: knownOrigin });
    const b = await run("execution two", { historyOrigin: knownOrigin });
    const shared = history.list().find((group) => group.identity.kind === "execution" &&
      group.identity.executionRoot === execution.executionRoot && group.identity.executionRef === execution.executionRef);
    assert.equal(shared.members.length, 2);
    assert.deepEqual(new Set(shared.members.map((member) => member.instanceId)), new Set([a.instanceId, b.instanceId]));
    assert.equal(shared.closure.state, "unclosed", "workers cannot infer execution closure");
    const crash = spawnSync(process.execPath, [script, "--crash", base], { env: process.env, encoding: "utf8", timeout: 60000 });
    assert.equal(crash.status, 73, crash.stderr);
    rmSync(cwd, { recursive: true });
    const reader = spawnSync(process.execPath, [script, "--read", base], { env: process.env, encoding: "utf8", timeout: 30000 });
    assert.equal(reader.status, 0, reader.stderr);
    console.log(JSON.stringify({ publicPaths: ["agent_run", "agent_spawn", "team_assign"], replacementSessions: 2,
      continuationSessions: 1, preassistant: nativeHistoryStatus(failedMember).state,
      cancelled: cancelled.status, crashExit: crash.status, paidCalls: 0, localRequests: provider.trace.length,
      recovered: JSON.parse(reader.stdout.trim()) }));
  } finally {
    if (foreground) {
      await foreground.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await foreground.dispose();
    }
    if (!mode?.startsWith("--")) rmSync(base, { recursive: true, force: true });
  }
}
