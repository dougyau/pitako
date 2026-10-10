import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { WorkerHistory, nativeHistoryStatus } from "../extensions/agent/history.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { executionForSession } from "../extensions/execution-identity.ts";
import { ORCHESTRATION_TOOLS } from "../extensions/profile.ts";
import { installLocalProvider } from "../tests/local-provider.ts";

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
    entry.message.toolName === "codemode").length, 4);
  assert(ordinaryEntries.some(entry => entry.type === "message" && entry.message.role === "toolResult" &&
    entry.message.toolName === "codemode" && entry.message.content.some(part =>
      part.type === "text" && part.text.includes('"status":"failed"') && part.text.includes('"status":"passed"'))));
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
  const cwd = path.join(root, "worktree's fixture");
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
    const provider = await installLocalProvider({ agentDir, responseForPrompt: () => "T1 offline native assistant" });
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
    mkdirSync(path.join(cwd, "scripts"));
    mkdirSync(path.join(cwd, "tests"));
    const recipeSource = readFileSync(new URL("./verification-recipe-v1.js", import.meta.url), "utf8");
    writeFileSync(path.join(cwd, "scripts", "verification-recipe-v1.js"), recipeSource);
    writeFileSync(path.join(cwd, "scripts", "truncated.js"), '// owned partial source\n'.repeat(2100) + '({version:1})');
    writeFileSync(path.join(cwd, "tests", "success.test.ts"), `import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
test("owned recipe success", async () => {
  console.log("recipe raw success"); writeFileSync("success.pid", String(process.pid));
  await Bun.sleep(30); expect(6 * 7).toBe(42);
});\n`);
    writeFileSync(path.join(cwd, "tests", "parallel.test.ts"), `import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
test("owned second process", async () => {
  writeFileSync("parallel.pid", String(process.pid)); await Bun.sleep(30); expect(true).toBe(true);
});\n`);
    writeFileSync(path.join(cwd, "tests", "failure.test.ts"), `import { test, expect } from "bun:test";
test("owned recipe failure", () => { console.error("recipe raw failure"); expect(1).toBe(2); });\n`);
    writeFileSync(path.join(root, "outside.test.ts"), 'throw Error("must not execute outside tests scope");\n');
    symlinkSync(path.join(root, "outside.test.ts"), path.join(cwd, "tests", "escape.test.ts"));
    const recipeEvidence = path.join(root, "recipe evidence's");
    const hooks = [];
    globalThis.__ordinaryChildHooks = hooks;
    writeFileSync(path.join(agentDir, "extensions", "child-hooks.js"), `export default function (pi) {
      pi.on("tool_call", event => {
        globalThis.__ordinaryChildHooks.push({ type: "call", name: event.toolName, input: event.input });
        if (event.toolName === "read" && event.input.path === "blocked.txt") return { block: true, reason: "owned hook denial" };
        if (event.toolName === "bash" && event.input.command?.includes("./tests/denied.test.ts"))
          return { block: true, reason: "owned recipe tool denial" };
      });
      pi.on("tool_result", event => {
        globalThis.__ordinaryChildHooks.push({ type: "result", name: event.toolName, content: event.content });
        if (event.toolName === "read" && event.input.path === "sample.txt" && !event.isError)
          return { content: [{ type: "text", text: "hook transformed read" }] };
      });
    }\n`);
    const scripts = [
      `text(await tools.read({path:"sample.txt"})); text(await tools.bash({command:"pwd; printf child-shell"}));
       text(ALL_TOOLS.map(t => t.name));`,
      `for (const call of [() => tools.read({path:"blocked.txt"}), () => tools.bash({})]) {
         try { await call(); text("unexpected success"); } catch (error) { text(error.message); }
       }`,
      `await tools.read({path:"missing.txt"});`,
      `const executionRoot = ${JSON.stringify(cwd)};
       const evaluate = source => {
         if (typeof source !== "string" || /\\[(?:Showing |.*more lines in file|Line .*exceeds)/.test(source))
           throw Error("Incomplete verification recipe source");
         const recipe = eval(source);
         if (recipe.version !== 1 || typeof recipe.run !== "function") throw Error("Unsupported verification recipe");
         return recipe;
       };
       const rejected = [];
       for (const candidate of [null, {type:"image"}, "({version:2})"]) {
         try { evaluate(candidate); throw Error("unexpected source admission"); }
         catch (error) { if (error.message === "unexpected source admission") throw error; rejected.push(error.message); }
       }
       for (const file of ["truncated.js", "absent.js"]) {
         try { evaluate(await tools.read({path: executionRoot + "/scripts/" + file})); throw Error("unexpected source admission"); }
         catch (error) { if (error.message === "unexpected source admission") throw error; rejected.push(error.message); }
       }
       const source = await tools.read({path: executionRoot + "/scripts/verification-recipe-v1.js"});
       const recipe = evaluate(source);
       const results = [];
       for (const file of ["success", "failure", "denied", "escape"]) {
         results.push(await recipe.run({root: executionRoot, evidenceDir: ${JSON.stringify(recipeEvidence)},
           selection: {kind:"focused", files:["tests/" + file + ".test.ts"]}}));
       }
       text({recipe: results, rejected});`,
    ];
    const ordinaryProvider = await installLocalProvider({
      agentDir, responseForPrompt: () => "ordinary child completed",
      toolTurns: 6,
      toolForPrompt(_prompt, completed) {
        return completed < 4 ? { name: "codemode", arguments: { code: scripts[completed] } }
          : completed === 4 ? { name: "read", arguments: { path: "sample.txt" } }
          : { name: "bash", arguments: { command: "printf direct-shell" } };
      },
    });
    const driver = globalThis.__pitako_local;
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
    assert.equal(codeResults.length, 4);
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
    assert.match(output(codeResults[3]), /Script completed/);
    const recipeOutput = JSON.parse(output(codeResults[3]).split("\n").find(line => line.startsWith('{"recipe":')));
    const recipeRuns = recipeOutput.recipe;
    assert.equal(recipeOutput.rejected.length, 5);
    assert.match(recipeOutput.rejected[3], /Incomplete verification recipe source/);
    assert.match(recipeOutput.rejected[4], /absent.js/);
    assert.deepEqual(recipeRuns.map(run => run.status), ["passed", "failed", "incomplete", "incomplete"]);
    assert.equal(recipeRuns[0].results[0].exitCode, 0);
    assert.equal(recipeRuns[1].results[0].exitCode, 1);
    assert.match(recipeRuns[2].results[0].error, /owned recipe tool denial/);
    assert.match(recipeRuns[3].results[0].error, /Missing or invalid terminal/);
    assert.equal(existsSync(recipeRuns[3].results[0].log), false);
    const recipeLogs = recipeRuns.slice(0, 2).map(run => {
      const result = run.results[0];
      const raw = readFileSync(result.log, "utf8");
      assert.equal(Number(readFileSync(path.join(result.evidenceDir, "exit-code.txt"), "utf8")), result.exitCode);
      assert.match(readFileSync(path.join(result.evidenceDir, "start.txt"), "utf8"), /^\d{4}-/);
      assert.match(readFileSync(path.join(result.evidenceDir, "end.txt"), "utf8"), /^\d{4}-/);
      const invocation = JSON.parse(readFileSync(path.join(result.evidenceDir, "invocation.json"), "utf8"));
      assert.equal(invocation.root, cwd);
      assert.deepEqual(invocation.selection, run.selection);
      return { status: run.status, exitCode: result.exitCode, raw, invocation,
        environment: readFileSync(path.join(result.evidenceDir, "environment.txt"), "utf8") };
    });
    assert.match(recipeLogs[0].raw, /recipe raw success/);
    assert.match(recipeLogs[1].raw, /recipe raw failure/);
    assert(hooks.some(event => event.type === "call" && event.name === "read" &&
      event.input.path === path.join(cwd, "scripts", "verification-recipe-v1.js")));
    const parallel = spawnSync("bun", ["test", "--parallel", "./tests/success.test.ts", "./tests/parallel.test.ts"], {
      cwd, encoding: "utf8", timeout: 10000,
    });
    assert.equal(parallel.status, 0, parallel.stdout + parallel.stderr);
    const workerPids = ["success", "parallel"].map(name => readFileSync(path.join(cwd, `${name}.pid`), "utf8"));
    assert.notEqual(workerPids[0], workerPids[1]);
    assert(workerPids.every(pid => Number(pid) !== process.pid));
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
        actualReadBash: true, hooks: true, validation: true, orchestrationExcluded: true, disposedIdentity: true,
        recipe: { sourceHash: createHash("sha256").update(recipeSource).digest("hex"), logs: recipeLogs,
          toolError: recipeRuns[2].status, scopeEscape: recipeRuns[3].status, rejectedSources: recipeOutput.rejected },
        parallel: { command: "bun test --parallel ./tests/success.test.ts ./tests/parallel.test.ts",
          exitCode: parallel.status, workerPids, raw: parallel.stdout + parallel.stderr } },
    };
    if (process.argv[2]) {
      writeFileSync(process.argv[2], `${JSON.stringify(observations, null, 2)}\n`);
      cpSync(recipeEvidence, process.argv[2] + ".raw", { recursive: true });
    }
    console.log(JSON.stringify(observations));
  } finally {
    await session?.dispose();
    await child?.session?.dispose();
    delete globalThis.__ordinaryChildHooks;
    delete globalThis.__pitako_local;
    rmSync(root, { recursive: true, force: true });
  }
}
