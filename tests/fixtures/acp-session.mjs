import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Only the two source-distributed dependencies need native Node TS support.
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); } catch (error) {
      if (error.code === "ERR_MODULE_NOT_FOUND" && specifier.endsWith(".js") && /node_modules\/(pi-codex-tools|pi-lsp-client)\//.test(context.parentURL ?? "")) {
        const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
        if (existsSync(url)) return { url: url.href, shortCircuit: true };
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (url.endsWith(".ts") && /node_modules\/(pi-codex-tools|pi-lsp-client)\//.test(url)) {
      return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true };
    }
    return next(url, context);
  },
});
const { AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
const { spawnBackground, workerStatus } = await import("../../extensions/agent/background.ts");
const { createPiExecutor, activateTarget } = await import("../../extensions/agent/pi.ts");
const { executionForSession } = await import("../../extensions/execution-identity.ts");
const root = fileURLToPath(new URL("../../", import.meta.url));
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
const mode = process.argv[2] ?? "default";
const updaterMarker = path.join(cwd, "updater-check");
process.env.ACP_UPDATE_THROTTLE_FILE = updaterMarker;
const projectConfig = path.join(cwd, ".pi/acp.json");
const globalConfig = path.join(process.env.HOME, ".pi/acp.json");
mkdirSync(path.dirname(projectConfig), { recursive: true });
mkdirSync(path.dirname(globalConfig), { recursive: true });
// All config files belong to this disposable fixture, never the user's HOME.
if (mode === "override") writeFileSync(projectConfig, '{"delegate":true,"autoUpdate":true}');
if (mode === "process-disabled-child") writeFileSync(projectConfig, '{"enabled":false}');
if (mode === "global-disabled") writeFileSync(globalConfig, '{"enabled":false}');
const initialConfigs = [globalConfig, projectConfig].filter(existsSync).map((file) => [file, readFileSync(file, "utf8")]);
let network = [];
globalThis.fetch = async (url) => {
  network.push(String(url));
  // Never let an explicit updater test install anything or contact a provider.
  if (String(url).includes("registry.npmjs.org")) return new Response(JSON.stringify({ version: "0.1.83" }), { headers: { "content-type": "application/json" } });
  // Hermes may make secondary summary requests during shutdown. Keep those
  // credential-free too, while observing them separately from ACP's updater.
  if (String(url).endsWith("/responses")) {
    const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "No durable memories.", annotations: [] }] };
    const response = { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, total_tokens: 2 } };
    const events = [
      { type: "response.created", response: { id: response.id } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "No durable memories." },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }
  throw new Error(`Unexpected network request: ${url}`);
};
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const requests = [];
const plans = new Map();
let sequence = 0;
const provider = {
  api: "openai-responses", baseUrl: mode === "proxy" ? "https://example.test/bili/https://api.openai.com/v1" : "http://127.0.0.1", apiKey: "fixture",
  models: [
    { id: "supported", compat: { supportsOpenAIGrammarTools: true }, contextWindow: 1000000 },
    { id: "missing", contextWindow: 1000000 },
    { id: "small", contextWindow: 1000 },
  ].map((model) => ({ name: model.id, reasoning: false, input: ["text"], cost, maxTokens: 128, ...model })),
  streamSimple(model, context, options) {
    requests.push({ sessionId: options?.sessionId, model: model.id, context: structuredClone(context) });
    const step = plans.get(options?.sessionId)?.shift();
    const content = step ? step(context) : [{ type: "text", text: "fixture response" }];
    const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: model.id === "small" ? 950 : 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: model.id === "small" ? 951 : 2, cost: { ...cost, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); });
    return stream;
  },
};
const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider("acp-fixture", provider);
const model = (id) => runtime.getModel("acp-fixture", id);
const call = (name, args) => () => [{ type: "toolCall", id: `acp-call-${sequence++}`, name, arguments: args }];
const text = (value) => JSON.stringify(value);
const resultText = (session, tool) => session.messages.filter((message) => message.role === "toolResult" && message.toolName === tool).at(-1)?.content.map((part) => part.text ?? "").join("\n");
const compactions = (session) => session.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
const acpTools = ["compress", "search_context", "decompress", "acp_status", "acp_cache"];
const errors = [];
async function create(manager = SessionManager.inMemory(cwd), id = "supported") {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 128, keepRecentTokens: 0 }, retry: { enabled: false }, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [root], noContextFiles: true, noSkills: true, noPrompts: true, noThemes: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, model: model(id), modelRuntime: runtime, resourceLoader: loader, sessionManager: manager, settingsManager });
  await session.bindExtensions({ onError(error) { errors.push(error); } });
  return session;
}
async function close(session) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
async function tool(session, name, args) {
  plans.set(session.sessionId, [call(name, args)]);
  await session.prompt(`Exercise ${name}`);
  const result = session.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1);
  assert.equal(result?.isError, false, text(result));
  return resultText(session, name);
}
async function seed(session, marker) {
  // Upstream pins the first user message and protects a 5000-token recent tail.
  await session.prompt("Initial task remains available");
  await session.prompt(`${marker} original detail: ${"payload ".repeat(1000)}`);
  for (let i = 0; i < 4; i++) await session.prompt(`unrelated later turn ${i}: ${"padding ".repeat(1000)}`);
}
async function compress(session, marker) {
  plans.set(session.sessionId, [(context) => {
    const original = context.messages.find((message) => message.role === "user" && text(message.content).includes(`${marker} original detail`));
    assert.ok(original, text(context.messages));
    const ref = text(original).match(/m\d{5}/)?.[0];
    assert.ok(ref, text(original));
    return call("compress", { content: [{ startId: ref, endId: ref, topic: marker, summary: `${marker} concise stored conclusion: retain the original detail for later retrieval, without repeating its payload.` }] })();
  }]);
  await session.prompt("Compress old detail");
  assert.match(resultText(session, "compress"), /blocks: b1=/);
  const outbound = requests.filter((request) => request.sessionId === session.sessionId).at(-1).context.messages;
  assert.ok(!text(outbound).includes(`${marker} original detail`));
  assert.match(text(outbound), new RegExp(`${marker} concise stored conclusion`));
  assert.ok(session.sessionManager.getEntries().some((entry) => text(entry).includes(`${marker} original detail`)));
  assert.match(await tool(session, "search_context", { query: marker }), /b1/);
}
const main = await create(mode === "default" ? SessionManager.create(cwd, path.join(cwd, "sessions")) : undefined);
const enabled = !["global-disabled", "process-disabled-child"].includes(mode);
for (const name of acpTools) assert.equal(main.getActiveToolNames().includes(name), enabled, name);
const override = mode === "override";
assert.equal(main.getActiveToolNames().includes("acp_delegate"), override);
if (override) {
  assert.ok(main.getActiveToolNames().includes("acp_delegate_wait"));
  assert.ok(existsSync(updaterMarker), "explicit autoUpdate enters upstream updater (pinned spec skips fetching)");
} else {
  assert.deepEqual(network, []);
  assert.ok(!existsSync(updaterMarker), "defaults never enter updater");
}

if (mode === "default") {
  const paths = main.extensionRunner.getExtensionPaths();
  assert.equal(new Set(paths).size, paths.length);
  const acpIndex = paths.indexOf(path.join(root, "extensions/acp.ts"));
  assert.ok(acpIndex >= 0 && acpIndex < paths.findIndex((entry) => entry.includes("/pi-hermes-memory/")));
  assert.equal(paths.filter((entry) => entry.endsWith("/pi-codex-tools/index.ts")).length, 1);
  await seed(main, "amber");
  await compress(main, "amber");
  const sessionFile = main.sessionFile;
  const sidecar = `${sessionFile}.acp.json`;
  assert.ok(existsSync(sidecar));
  assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).blocks.length, 1);
  await close(main);
  // A distinct stored summary proves read-on-restart, not replay from compress calls.
  const state = JSON.parse(readFileSync(sidecar, "utf8"));
  state.blocks[0].summary = "amber recovered directly from sidecar";
  writeFileSync(sidecar, JSON.stringify(state));
  const restarted = await create(SessionManager.open(sessionFile));
  await restarted.prompt("Inspect restored context");
  assert.ok(!requests.at(-1).context.messages.some((message) => message.role === "user" && text(message.content).includes("amber original detail")));
  const recovered = await tool(restarted, "search_context", { query: "amber" });
  assert.match(recovered, /b1/);
  assert.match(recovered, /amber recovered directly from sidecar/);
  assert.match(text(requests.at(-1).context.messages), /amber recovered directly from sidecar/);
  assert.match(await tool(restarted, "decompress", { blockId: "b1", inline: true }), /amber original detail/);
  assert.match(text(requests.at(-1).context.messages), /amber original detail/);
  await assert.rejects(restarted.compact(), /Compaction cancelled/);
  assert.equal(compactions(restarted).length, 0);
  await close(restarted);
} else {
  if (mode === "global-disabled" || mode === "proxy") {
    await main.prompt("Native context to compact");
    const before = requests.length;
    await main.compact();
    assert.equal(compactions(main).length, 1);
    assert.ok(requests.length > before, "native summary reaches provider");
  }
  await close(main);
}

if (mode === "default") {
  // Exercise actual threshold admission, not emit-only substitutes.
  const threshold = await create(undefined, "small");
  const events = [];
  threshold.subscribe((event) => events.push(event));
  await threshold.prompt("older context " + "large ".repeat(1000));
  threshold.setAutoCompactionEnabled(true);
  const before = requests.length;
  await threshold.prompt("threshold turn");
  assert.ok(events.some((event) => event.type === "compaction_start" && event.reason === "threshold"));
  assert.equal(requests.length - before, 1, "no native summary or threshold retry");
  assert.equal(compactions(threshold).length, 0);
  await close(threshold);

  // Keep a live parent owner while children bind and shut down outside ALS.
  const foreground = await create();
  const parentOwner = globalThis[Symbol.for("pitako.backgroundWorkers")].owner.token;
  // Production SDK children load package entries even when the parent used -e .
  mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
  globalThis.__acpFixtureProvider = provider;
  const lifecycle = [];
  const children = new Map();
  const originalBind = AgentSession.prototype.bindExtensions;
  const originalDispose = AgentSession.prototype.dispose;
  AgentSession.prototype.bindExtensions = async function(bindings) {
    const identity = executionForSession(this.sessionId);
    assert.ok(identity, "production registers before bind without ALS");
    children.set(identity.instanceId, this);
    lifecycle.push([identity.instanceId, "bind", this.sessionId]);
    if (identity.instanceId === "bind-failure") throw new Error("injected bind failure");
    await originalBind.call(this, { ...bindings, onError(error) { errors.push(error); } });
    if (identity.instanceId === "post-bind-failure") {
      this.getAllTools = () => { throw new Error("injected post-bind failure"); };
    }
  };
  AgentSession.prototype.dispose = function() {
    const identity = executionForSession(this.sessionId);
    assert.ok(identity, "identity remains until after runner disposal");
    lifecycle.push([identity.instanceId, "dispose", this.sessionId]);
    return originalDispose.call(this);
  };
  globalThis.__acpLifecycle = (ctx) => {
    const identity = executionForSession(ctx.sessionManager.getSessionId());
    assert.ok(identity);
    lifecycle.push([identity.instanceId, "shutdown", ctx.sessionManager.getSessionId()]);
  };
  writeFileSync(path.join(agentDir, "extensions/provider.js"), 'export default function(pi) { pi.registerProvider("acp-fixture", globalThis.__acpFixtureProvider); pi.on("session_shutdown", async (_event, ctx) => { await new Promise(resolve => setTimeout(resolve, 5)); globalThis.__acpLifecycle(ctx); }); }');
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false }));
  process.env.PITAKO_PROFILE = "analysis";
  const role = { id: "reviewer", name: "Reviewer", description: "fixture", instructionsPath: "roles/reviewer.md", instructions: "fixture", skills: [], principles: [], modelPolicyId: "reviewer", modelPolicy: { id: "reviewer", fallbacks: [] } };
  const start = (instanceId, target = "supported") => createPiExecutor().start({ instanceId, role, target: { model: `acp-fixture/${target}` }, task: "production child start", cwd, signal: new AbortController().signal });
  const [one, two] = await Promise.all([start("one"), start("two")]);
  try {
    for (const [id, attempt] of [["one", one], ["two", two]]) {
      assert.equal(attempt.status, "completed", text(attempt));
      const child = children.get(id);
      const paths = child.extensionRunner.getExtensionPaths();
      assert.equal(new Set(paths).size, paths.length);
      assert.equal(paths.filter((entry) => entry.endsWith("/extensions/acp.ts")).length, 1);
      assert.equal(paths.filter((entry) => entry.endsWith("/pi-codex-tools/index.ts")).length, 1);
      assert.equal(globalThis[Symbol.for("pitako.backgroundWorkers")].owner.token, parentOwner);
      assert.equal(child.sessionFile, undefined);
      for (const name of acpTools) assert.ok(child.getActiveToolNames().includes(name));
      assert.ok(child.getActiveToolNames().includes("apply_patch"));
      assert.ok(!child.getActiveToolNames().some((name) => /^(agent_|team_|acp_delegate)/.test(name)));
    }
    const childOne = children.get("one"), childTwo = children.get("two");
    await Promise.all([seed(childOne, "scarlet"), seed(childTwo, "cobalt")]);
    await Promise.all([compress(childOne, "scarlet"), compress(childTwo, "cobalt")]);
    assert.match(await tool(childOne, "decompress", { blockId: "b1", inline: true }), /scarlet original detail/);
    assert.ok(!resultText(childOne, "decompress").includes("cobalt"));
    assert.match(await tool(childTwo, "decompress", { blockId: "b1", inline: true }), /cobalt original detail/);
    assert.ok(!resultText(childTwo, "decompress").includes("scarlet"));
    await childOne.prompt("/pitako profile analysis");
    childOne.setActiveToolsByName(["edit", "write", "apply_patch", "lsp_rename"]);
    await activateTarget(childOne, model("supported"), { model: "acp-fixture/supported" });
    assert.ok(!childOne.getActiveToolNames().some((name) => ["edit", "write", "apply_patch", "lsp_rename"].includes(name)));
    assert.ok(childTwo.getActiveToolNames().includes("apply_patch"));
    assert.ok(childOne.getActiveToolNames().includes("compress"));
    const next = await one.session.continueWith({ model: "acp-fixture/missing" }, "same child fallback", new AbortController().signal);
    await Promise.all([one.session.dispose(), next.session.dispose(), two.session.dispose()]);
    for (const id of ["one", "two"]) {
      assert.deepEqual(lifecycle.filter((row) => row[0] === id).map((row) => row[1]), ["bind", "shutdown", "dispose"]);
      assert.equal(executionForSession(children.get(id).sessionId), undefined);
    }
    for (const id of ["bind-failure", "post-bind-failure"]) {
      const failed = await start(id);
      assert.equal(failed.status, "failed");
      assert.match(failed.error, /injected/);
      assert.deepEqual(lifecycle.filter((row) => row[0] === id).map((row) => row[1]), id === "bind-failure" ? ["bind", "dispose"] : ["bind", "shutdown", "dispose"]);
      assert.equal(executionForSession(children.get(id).sessionId), undefined);
    }
    const originalSetModel = AgentSession.prototype.setModel;
    AgentSession.prototype.setModel = async function() { throw new Error("injected activation failure"); };
    try {
      const failed = await start("activation-failure");
      assert.equal(failed.status, "failed");
      assert.match(failed.error, /injected activation failure/);
      assert.deepEqual(lifecycle.filter((row) => row[0] === "activation-failure").map((row) => row[1]), ["bind", "shutdown", "dispose"]);
      assert.equal(executionForSession(children.get("activation-failure").sessionId), undefined);
      // A models.json fixture makes the model available before loading/binding,
      // exercising runTarget's other startup branch as well as bindThenRun.
      writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "acp-fixture": { api: provider.api, baseUrl: provider.baseUrl, apiKey: "fixture", models: provider.models } } }));
      const knownFailure = await start("known-activation-failure");
      assert.equal(knownFailure.status, "failed");
      assert.match(knownFailure.error, /injected activation failure/);
      assert.deepEqual(lifecycle.filter((row) => row[0] === "known-activation-failure").map((row) => row[1]), ["bind", "shutdown", "dispose"]);
      assert.equal(executionForSession(children.get("known-activation-failure").sessionId), undefined);
    } finally { AgentSession.prototype.setModel = originalSetModel; }
    assert.equal(globalThis[Symbol.for("pitako.backgroundWorkers")].owner.token, parentOwner);
    assert.equal(readdirSync(path.join(cwd, "sessions")).filter((name) => name.endsWith(".acp.json")).length, 1);
  } finally {
    await Promise.all([one.session?.dispose(), two.session?.dispose()]);
    AgentSession.prototype.bindExtensions = originalBind;
    AgentSession.prototype.dispose = originalDispose;
  }
  // A worker actually settles while the parent streams; ACP's manual cancellation
  // skips session_compact but session_compact_failed must still flush its signal.
  let entered;
  const streaming = new Promise((resolve) => { entered = resolve; });
  const streamFunction = foreground.agent.streamFunction;
  let hold = true;
  foreground.agent.streamFunction = (selected, context, options) => {
    if (!hold) return streamFunction(selected, context, options);
    hold = false;
    const stream = createAssistantMessageEventStream();
    options.signal.addEventListener("abort", () => {
      const message = { role: "assistant", content: [], api: selected.api, provider: selected.provider, model: selected.id, stopReason: "aborted", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } } };
      stream.push({ type: "error", reason: "aborted", error: message });
      stream.end(message);
    }, { once: true });
    entered();
    return stream;
  };
  const pendingPrompt = foreground.prompt("Hold parent turn for worker completion");
  await streaming;
  let finishWorker;
  const pendingWorker = new Promise((resolve) => { finishWorker = resolve; });
  const userConfigPath = path.join(agentDir, "fixture.toml");
  writeFileSync(userConfigPath, '[model_policies.reviewer.primary]\nmodel = "acp-fixture/supported"\n');
  const worker = await spawnBackground({ roleId: "reviewer", task: "fixture completion", cwd, watch: { planId: "fixture", unitId: "T2" }, executor: { start() { return pendingWorker; } }, load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath } });
  finishWorker({ status: "completed", result: "private worker result", sideEffects: false });
  for (let i = 0; i < 50 && workerStatus(worker.instanceId)[0].status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(workerStatus(worker.instanceId)[0].status, "completed");
  assert.ok(globalThis[Symbol.for("pitako.backgroundWorkers")].held.some((item) => item.instanceId === worker.instanceId));
  await assert.rejects(foreground.compact(), /Compaction cancelled/);
  await pendingPrompt;
  await new Promise((resolve) => setTimeout(resolve, 10));
  await foreground.waitForIdle();
  assert.equal(compactions(foreground).length, 0);
  const signals = foreground.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "pitako.worker");
  assert.equal(signals.length, 1);
  assert.match(text(signals), new RegExp(worker.instanceId));
  assert.ok(!text(signals).includes("private worker result"));
  assert.match(text(requests.filter((request) => request.sessionId === foreground.sessionId).at(-1).context.messages), new RegExp(worker.instanceId));
  await close(foreground);
}

if (override || ["default", "process-disabled-child"].includes(mode)) {
  // Factory master switch uses process.cwd(), whereas session_start reloads
  // delegate/autoUpdate from ctx.cwd. These are deliberately different boundaries.
  const childCwd = path.join(cwd, "child");
  mkdirSync(path.join(childCwd, ".pi"), { recursive: true });
  const childConfig = path.join(childCwd, ".pi/acp.json");
  if (!override) writeFileSync(childConfig, JSON.stringify({ enabled: mode === "process-disabled-child" }));
  mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
  globalThis.__acpFixtureProvider = provider;
  writeFileSync(path.join(agentDir, "extensions/provider.js"), 'export default function(pi) { pi.registerProvider("acp-fixture", globalThis.__acpFixtureProvider); }');
  let child;
  const originalBind = AgentSession.prototype.bindExtensions;
  AgentSession.prototype.bindExtensions = async function(bindings) {
    child = this;
    assert.ok(executionForSession(this.sessionId));
    await originalBind.call(this, bindings);
  };
  const role = { id: "reviewer", name: "Reviewer", description: "fixture", instructionsPath: "roles/reviewer.md", instructions: "fixture", skills: [], principles: [], modelPolicyId: "reviewer", modelPolicy: { id: "reviewer", fallbacks: [] } };
  let attempt;
  try {
    attempt = await createPiExecutor().start({ instanceId: "explicit-child", role, target: { model: "acp-fixture/supported" }, task: "child config boundary", cwd: override ? cwd : childCwd, signal: new AbortController().signal });
    assert.equal(attempt.status, "completed", text(attempt));
    for (const name of acpTools) assert.equal(child.getActiveToolNames().includes(name), enabled);
    assert.equal(child.getActiveToolNames().includes("acp_delegate"), override);
    assert.ok(!child.getActiveToolNames().some((name) => /^(agent_|team_)/.test(name)));
    if (!override) assert.equal(readFileSync(childConfig, "utf8"), JSON.stringify({ enabled: mode === "process-disabled-child" }));
  } finally {
    await attempt?.session?.dispose();
    AgentSession.prototype.bindExtensions = originalBind;
  }
  assert.equal(executionForSession(child.sessionId), undefined);
}
for (const [file, contents] of initialConfigs) assert.equal(readFileSync(file, "utf8"), contents);
if (!override) {
  assert.ok(!network.some((url) => url.includes("registry.npmjs.org")), "no updater fetch during context/tool/lifecycle work");
  assert.ok(!existsSync(updaterMarker), "no updater during context/tool/lifecycle work");
}
assert.deepEqual(errors, []);
console.log(`ACP_SESSION_OK ${mode}`);
