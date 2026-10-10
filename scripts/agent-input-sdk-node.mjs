import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installLocalProvider } from "../tests/local-provider.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createLiveHandle } from "../extensions/agent/live.ts";
import { InvocationHistory } from "../extensions/agent/history.ts";
import agentInstance from "../extensions/agent/index.ts";
import { bindBackgroundOwner, cancelAllWorkers, cancelWorker, clearBackgroundOwner, resolveLiveTarget, spawnBackground } from "../extensions/agent/background.ts";

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

// The coordinator uses shipped tools in an ordinary foreground SDK session.
// The offline provider scripts the detour and correction; it is not a utility sample.
async function reconductionFixture(root) {
  const detourHeld = deferred(), releaseDetour = deferred(), contextHeld = deferred(), releaseContext = deferred(), done = deferred();
  const workbrief = "T3 original WorkBrief: write corrected.txt containing assigned behavior. Dependency debugging is not the assigned outcome.";
  const gates = { detourHeld, releaseDetour, contextHeld, releaseContext };
  globalThis.__reconductionFixture = gates;
  let coordinator, worker, completion, workerTrace;
  const actions = [], specs = new Map(), dispatched = new Set();
  const awaitHeld = gate => Promise.race([gate.promise, done.promise.then(() => {
    throw new Error(`Worker finished before expected hold: ${completion}; trace: ${JSON.stringify(workerTrace)}`);
  })]);
  try {
    rmSync(path.join(root, "extensions", "live-hooks.js"));
    writeFileSync(path.join(root, "extensions", "reconduction-hooks.js"), `export default function(pi) {
      pi.on("tool_call", async event => {
        if (event.toolName !== "bash") return;
        const f = globalThis.__reconductionFixture;
        if (event.input.command === "printf dependency-debugging-detour") {
          f.detourHeld.resolve(); await f.releaseDetour.promise;
        }
        if (event.input.command === "printf context-ready") {
          f.contextHeld.resolve(); await f.releaseContext.promise;
        }
      });
    }`);
    writeFileSync(path.join(root, "dependency.txt"), "dependency-debugging detour: optional dependency unavailable\n");
    writeFileSync(path.join(root, "context.txt"), "Missing context: no dependency install needed; use existing bash to write assigned output.\n");
    writeFileSync(path.join(root, "pitako", "config.toml"),
      `[model_policies.developer.primary]\nmodel = "pitako-local/fixture"\nreasoning = "off"\n`);
    const scriptedWorker = await installLocalProvider({
      agentDir: root, toolTurns: 5,
      toolForPrompt: (prompt, completed) => {
        if (prompt.includes("intent: steer")) return completed === 4
          ? { name: "bash", arguments: { command: "printf 'assigned behavior\\n' > corrected.txt" } } : undefined;
        if (prompt.includes("intent: query")) return completed === 2
          ? { name: "read", arguments: { path: "context.txt" } }
          : completed === 3 ? { name: "bash", arguments: { command: "printf context-ready" } } : undefined;
        return completed === 0 ? { name: "read", arguments: { path: "dependency.txt" } }
          : completed === 1 ? { name: "bash", arguments: { command: "printf dependency-debugging-detour" } } : undefined;
      },
      responseForPrompt: prompt => `scripted candidate: ${prompt}`,
    });
    workerTrace = scriptedWorker.trace;
    const foreground = await installLocalProvider({
      agentDir: root, provider: "pitako-coordinator",
      toolForPrompt: prompt => {
        if (dispatched.has(prompt)) return undefined;
        dispatched.add(prompt);
        return specs.get(prompt);
      },
    });
    // installLocalProvider writes one discovery file; workers keep their own provider.
    writeFileSync(path.join(root, "extensions", "local-provider.js"),
      `export default function(pi) { pi.registerProvider("pitako-local", globalThis.__pitako_local); }\n`);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager, noContextFiles: true, noSkills: true, noThemes: true,
      extensionFactories: [agentInstance, pi => pi.registerProvider(foreground.provider, globalThis.__pitako_coordinator)],
    });
    await loader.reload();
    const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
    coordinator = (await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager,
      modelRuntime: runtime, sessionManager: SessionManager.create(root, path.join(root, "foreground-native")) })).session;
    await coordinator.bindExtensions({ mode: "rpc" });
    await coordinator.setModel(runtime.getModel(foreground.provider, foreground.model));
    const discovered = coordinator.getAllTools().map(tool => tool.name);
    for (const name of ["agent_spawn", "agent_observe", "agent_history", "agent_input"]) assert(discovered.includes(name), name);
    coordinator.setActiveToolsByName(["agent_spawn", "agent_observe", "agent_history", "agent_input"]);
    coordinator.subscribe(event => {
      if (event.type === "message_end" && event.message.role === "toolResult") actions.push(event.message);
    });
    bindBackgroundOwner({ token: Symbol("T3 foreground"), isIdle: () => !coordinator.isStreaming, hasUI: true,
      notify(text) { completion = text; done.resolve(); }, sendMessage(text) { completion = text; done.resolve(); } });
    async function call(name, args) {
      const prompt = `T3 action ${actions.length + 1}: ${name}`;
      specs.set(prompt, { name, arguments: args });
      const before = actions.length;
      await coordinator.prompt(prompt);
      assert.equal(actions.length, before + 1);
      const result = actions.at(-1);
      assert.equal(result.toolName, name);
      assert(!result.isError, JSON.stringify(result));
      return result.details;
    }
    async function history(historyId) {
      const pages = [], fragments = [];
      let cursor;
      do {
        const page = await call("agent_history", { action: "read", historyId, cursor, limit: 200 });
        pages.push(page);
        fragments.push(...page.items.map(item => Buffer.from(item.data, "base64")));
        cursor = page.cursor ?? undefined;
      } while (cursor);
      return { pages, bytes: Buffer.concat(fragments).toString() };
    }
    worker = await call("agent_spawn", { role: "developer", task: workbrief });
    await awaitHeld(detourHeld);
    const target = { kind: "background", instanceId: worker.instanceId };
    const earlier = await call("agent_observe", { target });
    assert.equal(earlier.workbrief.text, workbrief);
    const earlierHistory = await history(earlier.historyId);
    assert(earlierHistory.bytes.includes("dependency-debugging detour: optional dependency unavailable"));
    assert(earlierHistory.bytes.includes("dependency.txt"));
    assert(!existsSync(path.join(root, "corrected.txt")));
    const identity = { target, historyId: earlier.historyId, sessionId: earlier.sessionId };
    const query = await call("agent_input", { ...identity, intent: "query",
      text: "What missing context explains the dependency detour? Read context.txt before continuing." });
    assert.equal(query.status, "queued");
    assert(!scriptedWorker.trace.some(row => row.prompt.includes(query.interactionId)));
    releaseDetour.resolve();
    await awaitHeld(contextHeld);
    const contextual = await call("agent_observe", { target });
    const contextualHistory = await history(earlier.historyId);
    assert(contextualHistory.bytes.includes("Missing context: no dependency install needed"));
    assert(contextualHistory.bytes.includes(query.interactionId));
    assert(scriptedWorker.trace.some(row => row.prompt.includes(query.interactionId)));
    const decision = { advice: "no_sample", reason: "Scripted offline behavior; no genuine coordinator JEV consultation.",
      preAdviceProposal: "Query missing context; steer only if the context supports an in-scope correction.",
      selectedAction: "steer", target: identity, basis: "Observed dependency detour and native context read; original output still missing." };
    const steer = await call("agent_input", { ...identity, intent: "steer",
      text: "No install is needed. Return to the original WorkBrief: write corrected.txt containing assigned behavior using existing bash." });
    assert.equal(steer.status, "queued");
    assert(!existsSync(path.join(root, "corrected.txt")));
    assert(!scriptedWorker.trace.some(row => row.prompt.includes(steer.interactionId)));
    releaseContext.resolve();
    await done.promise;
    const correctedHistory = await history(earlier.historyId);
    const corrected = readFileSync(path.join(root, "corrected.txt"), "utf8");
    assert.equal(corrected, "assigned behavior\n");
    const entries = correctedHistory.bytes.trim().split("\n").map(JSON.parse);
    const nativeInputs = entries.filter(entry => entry.type === "message" && entry.message.role === "user");
    assert(nativeInputs.some(entry => JSON.stringify(entry).includes(query.interactionId)));
    assert(nativeInputs.some(entry => JSON.stringify(entry).includes(steer.interactionId)));
    const messages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
    const inputIndex = id => messages.findIndex(message => message.role === "user" && JSON.stringify(message).includes(id));
    const queryIndex = inputIndex(query.interactionId), steerIndex = inputIndex(steer.interactionId);
    const contextIndex = messages.findIndex(message => message.role === "toolResult" && message.toolName === "read" &&
      !message.isError && JSON.stringify(message).includes("Missing context: no dependency install needed"));
    const correctedCallIndex = messages.findIndex(message => message.role === "assistant" && message.content.some(part =>
      part.type === "toolCall" && part.name === "bash" && part.arguments.command === "printf 'assigned behavior\\n' > corrected.txt"));
    assert(queryIndex < contextIndex && contextIndex < steerIndex && steerIndex < correctedCallIndex);
    const correctedCall = messages[correctedCallIndex].content.find(part => part.type === "toolCall");
    assert(messages.slice(correctedCallIndex + 1).some(message => message.role === "toolResult" &&
      message.toolCallId === correctedCall.id && !message.isError));
    const coordinatorEntries = SessionManager.open(coordinator.sessionFile).getEntries();
    assert(coordinatorEntries.some(entry => entry.type === "message" && entry.message.role === "toolResult" &&
      entry.message.toolName === "agent_input" && entry.message.details.interactionId === steer.interactionId));
    return { discovered, worker, target, originalWorkbrief: workbrief, earlier, earlierHistory, query, contextual, contextualHistory,
      decision, steer, corrected, correctedHistory, nativeInputs, coordinatorEntries, actions,
      trace: scriptedWorker.trace, coordinatorTrace: foreground.trace, paidCalls: 0,
      nativeOrder: { queryIndex, contextIndex, steerIndex, correctedCallIndex },
      limits: ["Scripted offline provider, not model compliance or JEV utility.", "No genuine JEV advice sample; action remains nonblocking."] };
  } finally {
    releaseDetour.resolve(); releaseContext.resolve();
    if (worker) { try { cancelWorker(worker.instanceId); } catch {} await done.promise; }
    await coordinator?.dispose();
    cancelAllWorkers(); clearBackgroundOwner();
    delete globalThis.__reconductionFixture;
    delete globalThis.__pitako_coordinator;
  }
}
const root = mkdtempSync(path.join(tmpdir(), "pitako-input-sdk-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_OFFLINE = "1";
const held = deferred(), release = deferred(), hook = deferred(), releaseHook = deferred(), boundary = deferred();
const workerHeld = deferred(), releaseWorker = deferred(), replacementHeld = deferred(), releaseReplacement = deferred(), settled = deferred();
const order = [];
let session, run, raceLive, backgroundId;
try {
  const provider = await installLocalProvider({
    agentDir: root,
    toolForPrompt: (_prompt, completed) => completed === 0 ? { name: "fixture_hold", arguments: {} } : undefined,
    responseForPrompt: prompt => `candidate answer: ${prompt}`,
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager, noContextFiles: true, noSkills: true, noThemes: true,
    extensionFactories: [pi => {
      pi.registerTool({ name: "fixture_hold", label: "hold", description: "fixture hold", parameters: Type.Object({}),
        async execute() { held.resolve(); await release.promise; order.push("tool released"); return { content: [{ type: "text", text: "released" }], details: undefined }; } });
      pi.on("input", async event => {
        order.push(`input:${event.source}:${event.text}`);
        if (event.text.includes("settlement-race")) { hook.resolve(); await releaseHook.promise; }
        if (event.text.includes("consume")) return { action: "handled" };
      });
      pi.on("agent_before_settle", async () => {
        order.push("before settle");
        const joined = raceLive?.settle();
        boundary.resolve();
        await joined;
      });
      pi.on("turn_start", () => raceLive?.open());
    }],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
  const history = new InvocationHistory(root, { source: "agent_spawn", workbrief: "original WorkBrief" }, "original WorkBrief", true)
    .admit("fixture-race", "developer", { model: "pitako-local/fixture" });
  session = (await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager,
    modelRuntime: runtime, sessionManager: history.create() })).session;
  raceLive = createLiveHandle(session, history);
  session.subscribe(event => raceLive.event(event));
  await session.bindExtensions({ mode: "rpc" });
  await session.setModel(runtime.getModel(provider.provider, provider.model));
  session.setActiveToolsByName(["fixture_hold"]);
  run = session.prompt("original WorkBrief");
  await held.promise;
  const identity = { historyId: history.historyId, sessionId: session.sessionId };
  const compatQuery = await raceLive.handle.input({ ...identity, intent: "query", text: "interaction query" });
  const compatSteer = await raceLive.handle.input({ ...identity, intent: "steer", text: "interaction steer" });
  const consumed = await raceLive.handle.input({ ...identity, intent: "query", text: "consume" });
  assert.equal(compatQuery.status, "queued"); assert.equal(compatSteer.status, "queued"); assert.equal(consumed.status, "handled");
  const pending = raceLive.handle.input({ ...identity, intent: "steer", text: "settlement-race" });
  await hook.promise;
  release.resolve();
  await boundary.promise;
  const duringSettlement = await raceLive.handle.input({ ...identity, intent: "query", text: "closed admission" });
  assert.equal(duringSettlement.status, "rejected");
  releaseHook.resolve();
  const raced = await pending;
  assert.equal(raced.status, "queued");
  await run;
  run = undefined;
  assert(provider.trace.some(row => row.prompt.includes(compatQuery.interactionId)));
  assert(provider.trace.some(row => row.prompt.includes(compatSteer.interactionId)));
  assert(provider.trace.at(-1).prompt.includes(raced.interactionId));
  assert(provider.trace.findIndex(row => row.prompt.includes(compatQuery.interactionId)) <
    provider.trace.findIndex(row => row.prompt.includes(compatSteer.interactionId)));
  const observed = { sdkCompatibility: true, paidCalls: 0, order, compatQuery, compatSteer, consumed, duringSettlement, raced,
    observation: raceLive.handle.observe(), trace: provider.trace };
  const entries = SessionManager.open(session.sessionFile).getEntries().filter(entry =>
    entry.type === "custom" && entry.customType === "pitako.worker-history" && entry.data.event === "interaction");
  assert(entries.some(entry => entry.data.data.interactionId === raced.interactionId && entry.data.data.status === "pending"));
  assert(entries.some(entry => entry.data.data.interactionId === raced.interactionId && entry.data.data.status === "queued"));
  assert(entries.some(entry => entry.data.data.interactionId === duringSettlement.interactionId && entry.data.data.status === "rejected"));
  observed.nativeInteractionEntries = entries;
  await raceLive.handle.close();
  await session.dispose();
  session = undefined;
  globalThis.__liveFixture = { workerHeld, releaseWorker };
  writeFileSync(path.join(root, "extensions", "live-hooks.js"), `export default function(pi) {
    pi.on("tool_call", async event => {
      if(event.toolName === "read") { globalThis.__liveFixture.workerHeld.resolve(); await globalThis.__liveFixture.releaseWorker.promise; }
    });
  }`);
  writeFileSync(path.join(root, "sample.txt"), "fixture owned file\n");
  const production = await installLocalProvider({
    agentDir: root, additionalModels: ["replacement"],
    toolForPrompt: (_prompt, completed) => completed === 0 ? { name: "read", arguments: { path: "sample.txt" } } : undefined,
    errorForRequest: (prompt, model, afterTool) => model === "fixture" && (afterTool || !prompt.startsWith("original production WorkBrief")) ? "503 service unavailable" : undefined,
    responseGate: async prompt => {
      if (prompt.startsWith("original production WorkBrief") && workerReleased) { replacementHeld.resolve(); await releaseReplacement.promise; }
    },
    responseForPrompt: prompt => `reply mentioning ${prompt}`,
  });
  let workerReleased = false;
  writeFileSync(path.join(root, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const config = path.join(root, "pitako", "config.toml");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, `[model_policies.developer.primary]\nmodel = "pitako-local/fixture"\nreasoning = "off"\n[[model_policies.developer.fallbacks]]\nmodel = "pitako-local/replacement"\nreasoning = "off"\n`);
  bindBackgroundOwner({ token: Symbol("foreground"), isIdle: () => true, hasUI: true, notify() { settled.resolve(); }, sendMessage() { settled.resolve(); } });
  const driver = createPiExecutor();
  const handle = await spawnBackground({ roleId: "developer", task: "original production WorkBrief", cwd: root,
    historyOrigin: { source: "agent_spawn", workbrief: "original production WorkBrief", coordinatorSessionId: "coordinator" },
    load: { env: { PI_CODING_AGENT_DIR: root }, userConfigPath: config },
    executor: driver,
  });
  const target = { kind: "background", instanceId: handle.instanceId };
  backgroundId = handle.instanceId;
  await workerHeld.promise;
  const live = resolveLiveTarget(target, "coordinator");
  const first = live.observe();
  assert.equal(first.workbrief.text, "original production WorkBrief");
  assert.throws(() => resolveLiveTarget(target, "wrong-owner"), /foreground owner/);
  const query = await live.input({ historyId: first.historyId, sessionId: first.sessionId, intent: "query", text: "/not-a-command query" });
  const steer = await live.input({ historyId: first.historyId, sessionId: first.sessionId, intent: "steer", text: "keep the WorkBrief" });
  assert.equal(query.status, "queued"); assert.equal(steer.status, "queued");
  workerReleased = true;
  releaseWorker.resolve();
  await replacementHeld.promise;
  const replacement = resolveLiveTarget(target, "coordinator");
  const second = replacement.observe();
  assert.notEqual(second.sessionId, first.sessionId);
  assert.notEqual(second.historyId, first.historyId);
  const stale = await replacement.input({ historyId: first.historyId, sessionId: first.sessionId, intent: "query", text: "stale" });
  assert.equal(stale.status, "rejected");
  await live.close(); // old identity cleanup cannot revoke replacement
  const next = await replacement.input({ historyId: second.historyId, sessionId: second.sessionId, intent: "query", text: "replacement query" });
  assert.equal(next.status, "queued");
  releaseReplacement.resolve();
  await settled.promise;
  const closed = await replacement.input({ historyId: second.historyId, sessionId: second.sessionId, intent: "steer", text: "closed" });
  assert.equal(closed.status, "rejected");
  assert.throws(() => resolveLiveTarget(target, "coordinator"), /terminal|no native session binding/);
  assert(production.trace.some(row => row.prompt.includes(query.interactionId)));
  assert(production.trace.some(row => row.prompt.includes(steer.interactionId)));
  assert(production.trace.some(row => row.prompt.includes(next.interactionId)));
  observed.production = { target, first, query, steer, second, stale, next, closed,
    firstClosed: live.observe(), last: replacement.observe(), trace: production.trace };
  cancelAllWorkers();
  clearBackgroundOwner();
  delete globalThis.__liveFixture;
  observed.reconduction = await reconductionFixture(root);
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(observed, null, 2) + "\n");
  console.log(JSON.stringify(observed));
} finally {
  release.resolve(); releaseHook.resolve(); releaseWorker.resolve(); releaseReplacement.resolve();
  await Promise.allSettled([run, raceLive?.handle.close()]);
  await session?.dispose();
  if (backgroundId) {
    try { cancelWorker(backgroundId); } catch { /* successful case already cleared rows */ }
    await settled.promise;
  }
  cancelAllWorkers(); clearBackgroundOwner();
  delete globalThis.__liveFixture;
  delete globalThis.__pitako_local;
  rmSync(root, { recursive: true, force: true });
}
