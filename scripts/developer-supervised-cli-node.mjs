import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { superviseAgent } from "../extensions/herdr/supervise.ts";
import { developerPreflight } from "../extensions/agent/routing.ts";
import { installLocalProvider } from "../tests/local-provider.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(tmpdir(), "pitako-developer-cli-"));
const cwd = path.join(root, "project"), agentDir = path.join(root, "private-agent");
mkdirSync(cwd); mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1"; process.env.PI_TELEMETRY = "0";
const env = { HERDR_ENV: "1", HERDR_PANE_ID: "parent-pane", HERDR_SOCKET_PATH: "/owned-scripted-not-connected" };
const native = file => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
const ok = value => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
let session, runtime, retained = false, pendingChild;
const childEnv = {};
const calls = [], classifications = [];
let cliArgs, childOutput;
try {
  mkdirSync(path.join(agentDir, "pitako"));
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
  writeFileSync(path.join(agentDir, "pitako/config.toml"), `
[model_policies.developer.primary]
model = "pitako-local/mid"
[model_policies.developer_senior.primary]
model = "pitako-local/senior"
reasoning = "high"
`);
  await installLocalProvider({ agentDir, model: "principal", toolForPrompt: () =>
    ({ name: "fixture_supervise", arguments: {} }) });
  const response = { api: "cli-fixture", provider: "opencode", model: "jev-1.13-free", stopReason: "stop", timestamp: 123,
    answers: { capacity: { type: "choice", choice: "developer_senior", confidence: 0.7123456789,
      probabilities: { developer_senior: 0.7123456789, developer_mid: 0.2, developer_junior: 0.05, indeterminate: 0.01 } } },
    fixtureExtra: "preserved complete response" };
  const runner = async args => {
    calls.push([...args]);
    if (args[0] === "integration") return ok("pi: current (fixture)");
    if (args[0] === "status") return ok({ server: { running: true, endpoint_compatible: true } });
    if (args[1] === "layout") return ok({ result: { layout: { area: { width: 100, height: 40 } } } });
    if (args[1] === "split") {
      assert.equal(classifications.length, 1);
      for (let i = 0; i < args.length; i++) if (args[i] === "--env") {
        const [key, ...value] = args[++i].split("="); childEnv[key] = value.join("=");
      }
      return ok({ result: { pane: { pane_id: "owned-child-pane" } } });
    }
    if (args[1] === "start") {
      cliArgs = args.slice(args.indexOf("--") + 1);
      return ok({ result: { agent: { agent_status: "idle" } } });
    }
    if (args[1] === "prompt") {
      // Native CLI consumes the actual supervised flags. Only Herdr command delivery is scripted.
      const cli = path.join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
      const childArgs = ["--import", path.join(packageRoot, "scripts/sdk-node-loader.mjs"),
        "--import", path.join(packageRoot, "tests/fixtures/developer-cli-preload.mjs"), cli,
        "--print", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
        "--extension", path.join(agentDir, "extensions/local-provider.js"),
        "--extension", path.join(packageRoot, "extensions/index.ts"), ...cliArgs, args[3]];
      pendingChild = new Promise((resolve, reject) => {
        const child = spawn(process.execPath, childArgs, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env, ...childEnv,
          PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" } });
        let stdout = "", stderr = "", error;
        child.stdout.on("data", b => { stdout += b; });
        child.stderr.on("data", b => { stderr += b; });
        child.on("error", e => { error = e; });
        child.on("close", code => { childOutput = { code, stdout, stderr };
          error ? reject(error) : resolve(childOutput); });
      });
      const output = await pendingChild;
      assert.equal(output.code, 0, JSON.stringify(output));
      assert.match(output.stdout, /Local fixture response/);
      return ok({ result: { agent: { agent_status: "done" } } });
    }
    throw new Error(`unexpected Herdr seam: ${args}`);
  };
  const extension = pi => {
    pi.registerProvider("opencode", { baseUrl: "http://127.0.0.1", apiKey: "owned-local-fixture",
      models: [{ type: "classifier", id: "jev-1.13-free", name: "Local", api: "cli-fixture", contextWindow: 8192 }],
      classifiers: { "cli-fixture": { async classify(_model, request, options) {
        assert.equal(options.maxRetries, 0); classifications.push(request); return response;
      } } } });
    pi.registerTool({ name: "fixture_supervise", label: "Fixture", description: "Owned delivery seam", parameters: Type.Object({}),
      async execute(toolCallId, _params, signal, _update, ctx) {
        const result = await superviseAgent({ roleId: "developer", task: "exact CLI WorkBrief", cwd, env, run: runner,
          signal, preflight: () => developerPreflight({ task: "exact CLI WorkBrief", toolCallId,
            source: "agent_supervise", ctx, pi, signal, owns: () => true }) });
        return { content: [{ type: "text", text: "supervised done" }], details: result };
      } });
  };
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true,
    extensionFactories: [extension] });
  await loader.reload();
  runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  session = (await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime: runtime,
    sessionManager: SessionManager.create(cwd, path.join(agentDir, "coordinator")) })).session;
  await session.bindExtensions({ mode: "rpc" });
  await session.setModel(runtime.getModel("pitako-local", "principal"));
  session.setActiveToolsByName(["fixture_supervise"]);
  await session.prompt("deliver");
  const entries = native(session.sessionFile);
  const tool = entries.find(e => e.type === "message" && e.message.role === "toolResult").message;
  assert(!tool.isError, JSON.stringify(tool));
  const result = tool.details;
  const routing = entries.find(e => e.customType === "pitako.developer-routing" && e.data.dispatchId === result.dispatchId).data;
  assert.equal(routing.toolCallId, tool.toolCallId); assert.deepEqual(routing.response, response);
  const matches = readdirSync(result.sessionDir).filter(name => name.endsWith(`_${result.sessionId}.jsonl`));
  assert.equal(matches.length, 1, "exact UUID; no newest-file search");
  const childFile = path.join(result.sessionDir, matches[0]), childEntries = native(childFile);
  assert.equal(SessionManager.findById(cwd, result.sessionId, result.sessionDir), childFile);
  assert.equal(childEntries[0].id, result.sessionId);
  const origin = childEntries.find(e => e.customType === "pitako.supervised-origin").data;
  assert.equal(origin.dispatchId, routing.dispatchId); assert.equal(origin.instanceId, result.instanceId);
  assert.equal(origin.sessionId, result.sessionId); assert.equal(origin.profile, routing.profile);
  assert.deepEqual(origin.model, { provider: "pitako-local", id: "senior" }); assert.equal(origin.reasoning, "high");
  const activation = JSON.parse(readFileSync(path.join(agentDir, "cli-activation.json"), "utf8"));
  assert.equal(activation.sessionId, result.sessionId); assert.equal(activation.model, "senior"); assert.equal(activation.reasoning, "high");
  assert(childEntries.some(e => e.type === "message" && e.message.role === "assistant" &&
    e.message.model === "senior" && e.message.usage.totalTokens === 27));
  assert(!childEntries.some(e => e.customType === "pitako.worker-history"));
  const coordinatorFile = session.sessionFile;
  await session.dispose(); session = undefined;
  const evidence = { retainedRoot: agentDir, coordinatorFile, childFile, result, routing, origin, activation, cliArgs,
    calls, classifications, childOutput, limitations: "Herdr delivery scripted; genuine Pi CLI/native hooks and local scripted chat/classifier; no paid providers or live Herdr service" };
  if (process.env.T2_EVIDENCE_DIR) {
    mkdirSync(process.env.T2_EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(process.env.T2_EVIDENCE_DIR, "cli.json"), JSON.stringify(evidence, null, 2) + "\n");
    retained = true; rmSync(cwd, { recursive: true });
  }
  console.log(JSON.stringify(evidence));
} finally {
  await Promise.allSettled(pendingChild ? [pendingChild] : []);
  await session?.dispose();
  delete globalThis.__pitako_local;
  if (!retained) rmSync(root, { recursive: true, force: true });
}
