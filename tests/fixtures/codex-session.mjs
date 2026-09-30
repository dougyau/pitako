import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Native Node cannot strip dependency TS or resolve upstream's source .js imports.
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

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
const { getCurrentTools } = await import("@earendil-works/pi-ai");
const { APPLY_PATCH_GRAMMAR } = await import("pi-codex-tools");
const { activateTarget, createPiExecutor } = await import("../../extensions/agent/pi.ts");
const { registerExecution, unregisterExecution } = await import("../../extensions/execution-identity.ts");
const { reconcileChildTools } = await import("../../extensions/profile.ts");
const root = fileURLToPath(new URL("../../", import.meta.url));
const cwd = process.env.HOME;
const agentDir = process.env.PI_CODING_AGENT_DIR;
const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
let patches = [];
let requests = [];
const provider = {
  api: "openai-responses", baseUrl: "http://127.0.0.1", apiKey: "fixture",
  models: [
    { id: "supported", compat: { supportsOpenAIGrammarTools: true } },
    { id: "codex", api: "openai-codex-responses", compat: { supportsOpenAIGrammarTools: true } },
    { id: "missing" },
    { id: "disabled", compat: { supportsOpenAIGrammarTools: false } },
    { id: "wrong-api", api: "openai-completions", compat: { supportsOpenAIGrammarTools: true } },
  ].map((model) => ({ name: model.id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 128, ...model })),
  streamSimple(model, context) {
    requests.push(context);
    const patch = patches.shift();
    const message = {
      role: "assistant", content: patch ? [{ type: "toolCall", id: `patch-${requests.length}`, name: "apply_patch", arguments: { patch } }] : [{ type: "text", text: "done" }],
      api: model.api, provider: model.provider, model: model.id, stopReason: patch ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); });
    return stream;
  },
};
runtime.registerProvider("codex-fixture", provider);
const model = (id) => runtime.getModel("codex-fixture", id);
async function create(id, child = false) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [root], noContextFiles: true, noSkills: true, noPrompts: true, noThemes: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const paths = loaded.extensions.map((extension) => extension.resolvedPath);
  assert.equal(new Set(paths).size, paths.length);
  const codexIndex = paths.findIndex((entry) => entry.endsWith("/pi-codex-tools/index.ts"));
  assert.ok(codexIndex >= 0 && codexIndex < paths.findIndex((entry) => entry === path.join(root, "extensions/index.ts")));
  assert.equal(loaded.extensions.filter((extension) => extension.tools.has("apply_patch")).length, 1);
  assert.ok(loaded.extensions.find((extension) => extension.tools.has("apply_patch")).resolvedPath.endsWith("/pi-codex-tools/index.ts"));
  const { session } = await createAgentSession({ cwd, agentDir, model: model(id), modelRuntime: runtime, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager });
  if (child) registerExecution({ instanceId: "reviewer-fixture", roleId: "reviewer", sessionId: session.sessionId });
  await session.bindExtensions({}); // T2 owns this production lifecycle step.
  if (child) reconcileChildTools(session);
  return session;
}
function editors(session, expected) {
  const actual = session.getActiveToolNames().filter((name) => ["edit", "write", "apply_patch", "lsp_rename"].includes(name)).sort();
  assert.deepEqual(actual, [...expected].sort());
}
const codingPatch = ["apply_patch", "lsp_rename"];
const codingEdit = ["edit", "write", "lsp_rename"];
const main = await create("supported");
try {
  editors(main, codingPatch);
  await main.prompt("/pitako profile analysis");
  editors(main, []);
  for (const id of ["missing", "codex", "disabled", "supported"]) {
    await main.setModel(model(id), { persist: false });
    editors(main, []);
  }
  await main.prompt("/pitako profile coding");
  editors(main, codingPatch);
  for (const id of ["missing", "supported", "disabled", "codex", "wrong-api", "supported"]) {
    await main.setModel(model(id), { persist: false });
    editors(main, ["supported", "codex"].includes(id) ? codingPatch : codingEdit);
  }
  mkdirSync(path.join(cwd, ".pitako/plans"), { recursive: true });
  patches = ["*** Begin Patch\n*** Add File: .pitako/plans/patch-plan.md\n+---\n+id: patch-plan\n+revision: 1\n+status: draft\n+---\n+# Upstream plan title\n*** End Patch"];
  await main.prompt("$plan patch-plan", { expandPromptTemplates: false });
  assert.equal(main.sessionManager.getSessionName(), "plan: Upstream plan title");
  assert.equal(readFileSync(path.join(cwd, ".pitako/plans/patch-plan.md"), "utf8"), "---\nid: patch-plan\nrevision: 1\nstatus: draft\n---\n# Upstream plan title\n");
  const declaration = getCurrentTools(requests.at(-1).messages).find((tool) => tool.name === "apply_patch");
  assert.deepEqual(declaration.constrainedSampling, { type: "grammar", variants: { openai_lark: APPLY_PATCH_GRAMMAR } });
  assert.ok(!getCurrentTools(requests.at(-1).messages).some((tool) => tool.name === "edit" || tool.name === "write"));
  patches = ["*** Begin Patch\n*** Update File: .pitako/plans/patch-plan.md\n*** Move to: .pitako/plans/moved-plan.md\n@@\n-id: patch-plan\n+id: moved-plan\n@@\n-# Upstream plan title\n+# Moved plan title\n*** End Patch"];
  await main.prompt("$plan moved-plan", { expandPromptTemplates: false });
  assert.equal(main.sessionManager.getSessionName(), "plan: Moved plan title");
  assert.equal(existsSync(path.join(cwd, ".pitako/plans/patch-plan.md")), false);
  patches = ["*** Begin Patch\n*** Update File: .pitako/plans/moved-plan.md\n@@\n-not in file\n+wrong\n*** End Patch"];
  await main.prompt("Fail a hunk");
  const results = main.messages.filter((message) => message.role === "toolResult" && message.toolName === "apply_patch");
  assert.deepEqual(results.map((result) => result.isError), [false, false, true]);
  assert.deepEqual(results[0].details.changes, [{ kind: "added", path: ".pitako/plans/patch-plan.md" }]);
  assert.deepEqual(results[2].details, {});
  assert.match(results[2].content[0].text, /Failed to find expected lines/);
  assert.ok(requests.at(-1).messages.some((message) => message.role === "toolResult" && message.isError));
  assert.equal(readFileSync(path.join(cwd, ".pitako/plans/moved-plan.md"), "utf8"), "---\nid: moved-plan\nrevision: 1\nstatus: draft\n---\n# Moved plan title\n");
  assert.equal(main.getSessionStats().toolCalls, 3);
  runtime.registerProvider("grammar-payload", {
    api: "openai-responses", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture",
    models: [{ ...provider.models[0], id: "payload" }],
  });
  await main.setModel(runtime.getModel("grammar-payload", "payload"), { persist: false });
  let payload;
  const originalStream = main.agent.streamFunction;
  main.agent.streamFunction = (selected, context, options) => originalStream(selected, context, {
    ...options, onPayload(body) { payload = body; throw new Error("fixture stops before HTTP"); },
  });
  await main.prompt("Inspect outgoing OpenAI grammar declaration");
  const outgoing = payload.tools.find((tool) => tool.name === "apply_patch");
  assert.equal(outgoing.type, "custom");
  assert.deepEqual(outgoing.format, { type: "grammar", syntax: "lark", definition: APPLY_PATCH_GRAMMAR });
  assert.ok(!payload.tools.some((tool) => tool.name === "edit" || tool.name === "write"));
  main.agent.streamFunction = originalStream;
} finally { main.dispose(); }
const unsupported = await create("missing");
try { editors(unsupported, codingEdit); } finally { unsupported.dispose(); }
// Parent profile never determines a child's initial profile, even without ALS.
process.env.PITAKO_PROFILE = "analysis";
const analysis = await create("codex");
try {
  editors(analysis, []);
  await analysis.setModel(model("missing"), { persist: false });
  editors(analysis, []);
} finally { analysis.dispose(); }
const child = await create("supported", true);
try {
  editors(child, codingPatch);
  assert.ok(!child.getActiveToolNames().some((name) => /^(agent_|team_|acp_delegate)/.test(name)));
  await child.prompt("/pitako profile analysis");
  child.setActiveToolsByName(["edit", "write", "apply_patch", "lsp_rename"]);
  assert.equal(await activateTarget(child, model("supported"), { model: "codex-fixture/supported" }), undefined);
  editors(child, []); // Same-model call emits no model_select, still reconciled.
  await child.prompt("/pitako profile coding");
  child.setActiveToolsByName(["edit", "write", "apply_patch"]);
  assert.equal(await activateTarget(child, model("supported"), { model: "codex-fixture/supported" }), undefined);
  editors(child, codingPatch);
  for (const id of ["missing", "supported", "supported", "disabled", "codex"]) {
    assert.equal(await activateTarget(child, model(id), { model: `codex-fixture/${id}` }), undefined);
    editors(child, ["supported", "codex"].includes(id) ? codingPatch : codingEdit);
    assert.ok(!child.getActiveToolNames().some((name) => /^(agent_|team_)/.test(name)));
  }
} finally { unregisterExecution(child.sessionId); child.dispose(); }
// Exercise the production child loader: no Pitako package in settings/agentDir.
mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
globalThis.__codexFixtureProvider = provider;
writeFileSync(path.join(agentDir, "extensions/provider.js"), 'export default function(pi) { pi.registerProvider("codex-fixture", globalThis.__codexFixtureProvider); }');
patches = ["*** Begin Patch\n*** Add File: child.txt\n+child edit\n*** End Patch", "*** Begin Patch\n*** Update File: child.txt\n@@\n-missing hunk\n+bad\n*** End Patch"];
const activity = [];
const attempt = await createPiExecutor().start({
  instanceId: "reviewer-production-fixture",
  role: { id: "reviewer", name: "Reviewer", description: "fixture", instructionsPath: "roles/reviewer.md", instructions: "Use the editing tool.", skills: [], principles: [], modelPolicyId: "reviewer", modelPolicy: { id: "reviewer", fallbacks: [] } },
  target: { model: "codex-fixture/supported" }, task: "Execute patches", cwd, signal: new AbortController().signal,
  onActivity(event) { if (event.type === "tool_execution_end") activity.push(event); },
});
try {
  assert.equal(attempt.status, "completed");
  assert.deepEqual(attempt.usage.tools, { apply_patch: 2 });
  assert.equal(attempt.usage.toolCalls, 2);
  assert.equal(Object.hasOwn(attempt.usage, "patches"), false);
  assert.deepEqual(activity.map((event) => event.isError), [false, true]);
  assert.equal(attempt.sideEffects, true);
  assert.equal(readFileSync(path.join(cwd, "child.txt"), "utf8"), "child edit\n");
} finally { await attempt.session?.dispose(); }
console.log("CODEX_SESSION_OK: real Pi 0.87; package entries once; grammar declaration; add/move/failed hunk; counts=3 (2 success, 1 error); main model/profile transitions; child same-model reconciliation without ALS");
