import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import agentInstance from "../extensions/agent/index.ts";
import { WorkerHistory } from "../extensions/agent/history.ts";
import { installLocalProvider } from "../tests/local-provider.ts";

const root = mkdtempSync(path.join(tmpdir(), "pitako-developer-sdk-"));
const cwd = path.join(root, "disposable-project");
const agentDir = path.join(root, "retained-agent");
mkdirSync(cwd);
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const requests = [], activation = [];
let session, runtime, server, cancelSeen, retained = false;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pending = deferred();
const responseFor = mode => ({
  api: "routing-fixture", provider: "opencode", model: "jev-1.13-free", timestamp: 123456789,
  stopReason: mode === "aborted" ? "aborted" : mode === "error" ? "error" : "stop",
  answers: {
    capacity: { type: "choice", choice: mode === "indeterminate" ? "indeterminate" : "developer_senior",
      confidence: 0.6123456789,
      probabilities: { developer_senior: mode === "indeterminate" ? 0.1123456789 : 0.6123456789,
        developer_mid: 0.2123456789, developer_junior: 0.1123456789,
        indeterminate: mode === "indeterminate" ? 0.6123456789 : 0.0123456789, extra_label: 0.000123456789 } },
    extra: { type: "score", score: 4.123456789, confidence: 0.271828182 },
  },
  usage: { input: 19, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 24,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  fixtureExtra: { preserve: "complete public response" },
});
const native = file => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
try {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    if (request.state.workbrief === "cancel") {
      cancelSeen = new Promise(resolve => req.socket.once("close", resolve));
      pending.resolve();
      return; // Fetch cancellation settles the owned operation and closes this socket.
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(responseFor(request.state.workbrief)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  globalThis.__routing_classifier = {
    baseUrl: url, apiKey: "owned-local-no-user-credential",
    models: [{ type: "classifier", id: "jev-1.13-free", name: "Scripted local classifier",
      api: "routing-fixture", contextWindow: 8192 }],
    classifiers: { "routing-fixture": { async classify(_model, request, options) {
      assert.equal(options.maxRetries, 0);
      try {
        return await (await fetch(url, { method: "POST", body: JSON.stringify(request), signal: options.signal })).json();
      } catch (error) {
        if (options.signal?.aborted) return responseFor("aborted");
        throw error;
      }
    } } },
  };
  // A public provider with no configured access observes availability, not catalog membership.
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
  const chat = await installLocalProvider({ agentDir, model: "principal", additionalModels: ["senior", "mid", "junior"],
    reasoning: true, toolTurns: 1,
    toolForPrompt: prompt => prompt.startsWith("dispatch:")
      ? { name: "agent_run", arguments: { role: "developer", task: prompt.slice("dispatch:".length) } } : undefined });
  const original = globalThis.__pitako_local.streamSimple;
  globalThis.__pitako_local.streamSimple = (model, context, options) => {
    activation.push({ model: model.id, reasoning: options.reasoning, sessionId: options.sessionId });
    return original(model, context, options);
  };
  writeFileSync(path.join(agentDir, "extensions", "classifier.js"),
    'export default function(pi) { pi.registerProvider("opencode", globalThis.__routing_classifier); }\n');
  mkdirSync(path.join(agentDir, "pitako"));
  const config = path.join(agentDir, "pitako", "config.toml");
  const configText = senior => `
[model_policies.developer.primary]
model = "pitako-local/mid"
reasoning = "medium"
[model_policies.developer_senior.primary]
model = "pitako-local/${senior}"
reasoning = "high"
[model_policies.developer_junior.primary]
model = "pitako-local/junior"
reasoning = "low"
`;
  writeFileSync(config, configText("senior"));
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true,
    extensionFactories: [agentInstance] });
  await loader.reload();
  runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  session = (await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime: runtime,
    sessionManager: SessionManager.create(cwd, path.join(agentDir, "coordinator-native")) })).session;
  await session.bindExtensions({ mode: "rpc" });
  await session.setModel(runtime.getModel(chat.provider, chat.model));
  session.setActiveToolsByName(["agent_run"]);
  async function dispatch(task) {
    const before = session.sessionManager.getEntries().length;
    await session.prompt(`dispatch:${task}`);
    const result = session.sessionManager.getEntries().slice(before).find(entry => entry.type === "message" &&
      entry.message.role === "toolResult" && entry.message.toolName === "agent_run")?.message;
    assert(result, `real registered tool result for ${task}`);
    return result;
  }
  const outcomes = [];
  for (const mode of ["success", "indeterminate", "error", "aborted"]) {
    const before = new WorkerHistory().list().flatMap(group => group.members).length;
    const result = await dispatch(mode);
    const after = new WorkerHistory().list().flatMap(group => group.members);
    if (mode === "aborted") {
      assert(result.isError);
      assert.equal(after.length, before);
      continue;
    }
    assert.equal(result.isError, false, JSON.stringify(result));
    const selected = mode === "success" ? "senior" : "mid";
    assert.equal(result.details.model.selectedModel, `pitako-local/${selected}`);
    const entry = native(session.sessionFile).find(entry => entry.customType === "pitako.developer-routing" &&
      entry.data.dispatchId === result.details.dispatchId);
    assert(entry, "physical coordinator record");
    assert.equal(entry.data.toolCallId, result.toolCallId);
    assert(native(session.sessionFile).some(entry => entry.type === "message" && entry.message.role === "assistant" &&
      entry.message.content.some(part => part.type === "toolCall" && part.id === result.toolCallId && part.name === "agent_run")));
    assert.equal(entry.data.profile, `developer_${selected}`);
    assert.deepEqual(entry.data.request, requests.at(-1));
    assert.deepEqual(entry.data.response, responseFor(mode));
    const member = after.find(member => member.instanceId === result.details.instanceId);
    assert(member?.native.path.startsWith(agentDir + path.sep));
    const workerEntries = native(member.native.path);
    const origin = workerEntries.find(entry => entry.customType === "pitako.worker-history" && entry.data.event === "origin").data.data;
    assert.deepEqual(origin.origin.routing, entry.data);
    assert.equal(origin.origin.coordinatorSessionFile, session.sessionFile);
    assert.equal(member.coordinatorSessionId, session.sessionId);
    assert(workerEntries.some(entry => entry.type === "message" && entry.message.role === "assistant" &&
      entry.message.model === selected && entry.message.usage.totalTokens === 27));
    const applied = activation.find(row => row.model === selected && row.sessionId === member.native.sessionId);
    assert(applied, "real stream target");
    assert.equal(applied.reasoning, selected === "senior" ? "high" : "medium");
    outcomes.push({ mode, dispatchId: entry.data.dispatchId, historyId: member.historyId,
      workerFile: member.native.path, coordinatorFile: session.sessionFile, applied });
  }
  const beforeCancel = new WorkerHistory().list().flatMap(group => group.members).length;
  const prompting = session.prompt("dispatch:cancel");
  await pending.promise;
  await session.abort();
  await prompting;
  await cancelSeen;
  assert.equal(new WorkerHistory().list().flatMap(group => group.members).length, beforeCancel);
  assert(!native(session.sessionFile).some(entry => entry.customType === "pitako.developer-routing" &&
    entry.data.request?.state.workbrief === "cancel"));
  writeFileSync(config, configText("missing"));
  const requestCount = requests.length;
  const failed = await dispatch("activation-failure");
  assert(failed.isError);
  assert.equal(requests.length, requestCount + 1);
  const failedMember = new WorkerHistory().list().flatMap(group => group.members)
    .find(member => member.instanceId === failed.details.instanceId);
  assert(failedMember.terminal.beforeFirstAssistant);
  assert(failedMember.gaps.length);
  assert(!existsSync(failedMember.native.path), "native custom append did not fabricate first-assistant persistence");
  const failureAdvice = native(session.sessionFile).find(entry => entry.customType === "pitako.developer-routing" &&
    entry.data.dispatchId === failed.details.dispatchId);
  assert(failureAdvice);
  assert.equal(failureAdvice.data.resolvedPolicy.primary.model, "pitako-local/missing");
  writeFileSync(config, configText("senior"));
  // Real public availability miss: remove provider access in this coordinator runtime only.
  runtime.registerProvider("opencode", { ...globalThis.__routing_classifier, apiKey: "$PITAKO_ROUTING_OWNED_MISSING_KEY" });
  const beforeAbsent = requests.length;
  const absent = await dispatch("absent");
  assert(!absent.isError);
  assert.equal(absent.details.model.selectedModel, "pitako-local/mid");
  assert.equal(requests.length, beforeAbsent);
  const absentEntry = native(session.sessionFile).find(entry => entry.customType === "pitako.developer-routing" &&
    entry.data.dispatchId === absent.details.dispatchId);
  assert(!Object.hasOwn(absentEntry.data, "request"));
  assert(!Object.hasOwn(absentEntry.data, "response"));
  const coordinatorFile = session.sessionFile;
  await session.dispose();
  session = undefined;
  runtime.registerProvider("opencode", globalThis.__routing_classifier);
  const transientLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true,
    extensionFactories: [agentInstance] });
  await transientLoader.reload();
  session = (await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: transientLoader,
    modelRuntime: runtime, sessionManager: SessionManager.inMemory(cwd) })).session;
  await session.bindExtensions({ mode: "rpc" });
  await session.setModel(runtime.getModel(chat.provider, chat.model));
  session.setActiveToolsByName(["agent_run"]);
  const beforeTransient = requests.length;
  const transient = await dispatch("non-retained");
  assert(!transient.isError);
  assert.equal(transient.details.model.selectedModel, "pitako-local/mid");
  assert.equal(transient.details.routingEvidence.state, "unavailable");
  assert.equal(requests.length, beforeTransient);
  await session.dispose();
  session = undefined;
  rmSync(cwd, { recursive: true });
  for (const outcome of outcomes) {
    const recovered = SessionManager.open(outcome.workerFile).getEntries().find(entry =>
      entry.customType === "pitako.worker-history" && entry.data.event === "origin").data.data.origin.routing;
    assert.equal(recovered.dispatchId, outcome.dispatchId);
    assert.deepEqual(recovered.response.answers.capacity.probabilities, responseFor(outcome.mode).answers.capacity.probabilities);
  }
  const evidence = { retainedRoot: agentDir, coordinatorFile, requests, outcomes,
    cancelled: "owned HTTP fetch settled; no admission", fulfilledAborted: "no admission",
    activationFailure: { dispatchId: failed.details.dispatchId, historyId: failedMember.historyId,
      native: failedMember.native, gaps: failedMember.gaps }, absence: absent.details,
    nonRetained: transient.details,
    recovery: "physical coordinator/worker records reopened after disposable cwd removal; exact probabilities, target/reasoning and native assistant usage" };
  if (process.env.T1_EVIDENCE_DIR) {
    mkdirSync(process.env.T1_EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(process.env.T1_EVIDENCE_DIR, "sdk.json"), JSON.stringify(evidence, null, 2) + "\n");
    retained = true;
  }
  console.log(JSON.stringify(evidence));
} finally {
  await session?.dispose();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  delete globalThis.__pitako_local;
  delete globalThis.__routing_classifier;
  if (!retained) rmSync(root, { recursive: true, force: true });
}
