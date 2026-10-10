import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSystemMessageText, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { installLocalProvider } from "../tests/local-provider.ts";

const script = fileURLToPath(import.meta.url);
const checkout = path.resolve(path.dirname(script), "..");
const relativeHelper = "skills/practical/verify-behavior/jev-advice.js";
const model = { type: "classifier", provider: "opencode", id: "jev-1.13-free", api: "owned-classifier", contextWindow: 8192 };
const clone = value => JSON.parse(JSON.stringify(value));
const responseFor = (choice = "continue_developer") => ({
  api: model.api, provider: model.provider, model: model.id, timestamp: 123456789,
  stopReason: "stop",
  answers: {
    orientation: { type: "choice", choice, confidence: 0.623456789,
      probabilities: { [choice]: 0.623456789, unselected: 0.234567891, unknown_provider_label: 0.14197532 } },
    extraBool: { type: "bool", probability: 0.314159265 },
    extraScore: { type: "score", score: 4.123456789, confidence: 0.271828182 },
  },
  usage: { input: 19, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 24,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const inputFor = (subject, marker = "selected") => ({
  subject,
  context: { assignedResult: "retain optional advice", scope: "owned helper", proposal: "native store",
    evidence: ["observed failure remains a failure"], remainingUncertainty: "which boundary owns the defect?",
    question: "Does the existing proposal retain all answers?", marker },
  evidenceRefs: ["evidence/not-read.txt", "https://invalid.example/provenance"],
});

async function branches() {
  const source = readFileSync(path.join(checkout, relativeHelper), "utf8");
  const outcomes = [];
  for (const read of [async () => { throw new Error("owned read failed"); },
    async () => "partial source\n[Showing lines 1-20 of 200. Use offset=21 to continue.]",
    async () => "({version: 2, advise() { throw new Error('must not call'); }})"]) {
    await assert.rejects(vm.runInNewContext(`(async () => { ${invocation("/advertised/helper.js", inputFor("failure"))} })()`,
      { tools: { read } }), /owned read failed|Incomplete advisory source read|Unsupported advisory helper/);
  }
  async function run(input, options = {}) {
    const records = [], requests = [];
    let availability = 0, writes = 0;
    const helper = vm.runInNewContext(source, {
      models: {
        async getAvailableOfType(type) {
          assert.equal(type, "classifier");
          availability++;
          if (options.availabilityError) throw new Error("owned availability failure");
          return options.absent ? [] : [model];
        },
        async classify(selected, request) {
          assert.equal(selected, model);
          requests.push(clone(request));
          if (options.throwProvider) throw new Error("owned thrown provider failure");
          return options.response === undefined ? responseFor() : options.response;
        },
      },
      store(slot, record) {
        assert(slot === "pitako.jev.latest" || slot.startsWith("pitako.jev.advice."));
        writes++;
        if (options.storeError) throw new Error("codemode store exceeds active total limit");
        records.push(clone(record));
      },
    });
    assert.equal(helper.version, 1);
    const summary = clone(await helper.advise(input));
    return { summary, records, requests, availability, writes };
  }
  const categories = {
    failure: ["product", "fixture", "prerequisite", "unknown"],
    "test-audit": ["useful_owned_observer", "delegated_duplicate_detail_only", "insufficient_context"],
    consultation: ["continue_developer", "consult_architect", "consult_reviewer", "insufficient_context"],
  };
  for (const [subject, labels] of Object.entries(categories)) {
    const input = inputFor(subject);
    const response = responseFor(labels[0]);
    const result = await run(input, { response });
    assert.equal(result.summary.outcome, "advice");
    assert.equal(result.summary.evidence, "staged"); // Store is not a commit receipt.
    assert.equal(result.requests.length, 1);
    assert.equal(result.availability, 1);
    const record = result.records[0];
    assert.equal(record.subject, subject);
    assert.equal(record.helperVersion, 1);
    assert.deepEqual(record.state, input.context);
    assert.deepEqual(record.evidenceRefs, input.evidenceRefs);
    assert.deepEqual(Object.keys(record.questions.orientation.criteria), labels);
    assert.deepEqual(record.request, result.requests[0]);
    assert.deepEqual(record.response, response);
    assert.deepEqual(result.summary.advice, response.answers.orientation);
    outcomes.push(subject);
  }
  for (const options of [{ absent: true }, { availabilityError: true }]) {
    const result = await run(inputFor("failure"), options);
    assert.equal(result.summary.outcome, "unavailable");
    assert.equal(result.requests.length, 0);
    assert.equal(result.writes, 2);
    assert(!("request" in result.records[0]));
    assert(!("response" in result.records[0]));
  }
  for (const stopReason of ["error", "aborted"]) {
    const response = { ...responseFor(), stopReason, errorMessage: "nonthrow provider outcome" };
    const result = await run(inputFor("failure"), { response });
    assert.equal(result.summary.outcome, stopReason);
    assert.deepEqual(result.records[0].response, response);
  }
  for (const response of [null, { ...responseFor(), stopReason: "unexpected" },
    { ...responseFor(), answers: {} },
    { ...responseFor(), answers: { orientation: { type: "choice", choice: "product", confidence: 0.5 } } },
    { ...responseFor(), answers: { orientation: { type: "choice", choice: "product", confidence: 0.5, probabilities: {} } } },
    { ...responseFor(), answers: { orientation: { type: "bool", probability: 0.5 } } }]) {
    const result = await run(inputFor("failure"), { response });
    assert.equal(result.summary.outcome, "malformed");
    assert.deepEqual(result.records[0].response, response);
  }
  const thrown = await run(inputFor("failure"), { throwProvider: true });
  assert.equal(thrown.summary.outcome, "error");
  assert.equal(thrown.requests.length, 1);
  assert(!("response" in thrown.records[0]));
  const invalidJsonResponse = await run(inputFor("failure"), { response: { ...responseFor(), unexpected: Infinity } });
  assert.equal(invalidJsonResponse.summary.outcome, "malformed");
  assert.equal(invalidJsonResponse.summary.evidence, "incomplete");
  assert.equal(invalidJsonResponse.writes, 0);
  const storeFailure = await run(inputFor("failure"), { storeError: true });
  assert.equal(storeFailure.summary.evidence, "incomplete");
  assert.equal(storeFailure.records.length, 0);
  assert.equal(storeFailure.writes, 1);
  const retained = new Map();
  const helper = vm.runInNewContext(source, {
    models: { getAvailableOfType: async () => [model], classify: async () => responseFor() },
    load: id => retained.get(id), store: (id, value) => value === undefined ? retained.delete(id) : retained.set(id, clone(value)),
  });
  const older = await helper.advise(inputFor("consultation"));
  const newer = await helper.advise(inputFor("test-audit"));
  assert.notEqual(older.id, newer.id);
  assert.equal(retained.get("pitako.jev.latest").id, newer.id);
  assert.deepEqual(retained.get(older.slot).response, responseFor());
  const decision = helper.recordDecision({ adviceId: older.id,
    target: { kind: "background", instanceId: "fixture", historyId: "history", sessionId: "session" },
    selectedAction: { intent: "query", text: "deterministic action" }, reason: "owned evidence", evidenceRefs: [] });
  assert.equal(decision.evidence, "staged");
  const observation = helper.recordObservation({ decisionId: decision.id,
    observedOutcome: "receipt is not correctness", evidenceRefs: [] });
  assert.equal(observation.evidence, "staged");
  const laterDecision = helper.recordDecision({ adviceId: newer.id,
    target: { kind: "team", assignmentId: "assignment", historyId: "new-history", sessionId: "new-session" },
    selectedAction: { intent: "steer", text: "independent selection" }, reason: "later decision", evidenceRefs: [] });
  assert.equal(retained.get("pitako.jev.decision.latest").id, laterDecision.id);
  assert.equal(retained.get(decision.slot).adviceId, older.id);
  const laterObservation = helper.recordObservation({ decisionId: decision.id,
    observedOutcome: "old decision still retrievable", evidenceRefs: [] });
  assert.equal(laterObservation.evidence, "staged");
  assert.equal(retained.get("pitako.jev.observation.latest").id, laterObservation.id);
  assert.equal(retained.get(observation.slot).decisionId, decision.id);
  assert.equal(helper.recordDecision({ adviceId: "missing", evidenceRefs: [] }).evidence, "incomplete");
  assert.equal(helper.recordObservation({ decisionId: "missing", observedOutcome: "unknown", evidenceRefs: [] }).evidence, "incomplete");
  let writes = 0;
  const failing = vm.runInNewContext(source, {
    models: { getAvailableOfType: async () => [model], classify: async () => responseFor() },
    store(id, value) {
      writes++;
      if (id === "pitako.jev.latest") throw new Error("latest limit");
      if (value === undefined) retained.delete(id); else retained.set(id, clone(value));
    },
  });
  const failed = await failing.advise(inputFor("failure"));
  assert.equal(failed.evidence, "incomplete");
  assert(!retained.has(failed.slot));
  assert.equal(writes, 3);
  const oversizedResponse = responseFor();
  oversizedResponse.answers.orientation.probabilities["x".repeat(262144)] = 0.1;
  const tooLarge = await run(inputFor("failure"), { response: oversizedResponse });
  assert.equal(tooLarge.summary.evidence, "incomplete");
  assert.equal(tooLarge.requests.length, 1);
  assert.equal(tooLarge.writes, 0);
  for (const input of [{ ...inputFor("failure"), context: { log: "x".repeat(262144) } },
    { ...inputFor("failure"), questions: "executable user policy" },
    { ...inputFor("failure"), subject: "dispatch" },
    { ...inputFor("failure"), context: { secretFunction() {} } },
    { ...inputFor("failure"), context: { nonfinite: Infinity } }]) {
    const result = await run(input);
    assert.equal(result.summary.outcome, "rejected");
    assert.equal(result.availability, 0);
    assert.equal(result.requests.length, 0);
    assert.equal(result.writes, 0);
  }
  return { subjects: outcomes, unavailable: "no requests", errors: "nonthrow/throw/aborted/malformed",
    recording: "staged or explicit incomplete; no retry/truncation/second writer", oversizedInput: "rejected before availability" };
}

// This is the invocation given to the local chat driver, not a copy of helper logic.
function invocation(helperPath, input) {
  return `const source = await tools.read({path:${JSON.stringify(helperPath)}});
    if (typeof source !== "string" || /\\[(?:Showing |.*more lines in file|Line .*exceeds)/.test(source))
      throw new Error("Incomplete advisory source read");
    const helper = eval(source);
    if (helper.version !== 1) throw new Error("Unsupported advisory helper");
    ${input.context.marker === "uncommitted"
      ? `text(await helper.advise(${JSON.stringify(input)})); throw new Error("owned failure after staging");`
      : `return await helper.advise(${JSON.stringify(input)});`}`;
}

function advertisedHelper(context, installed) {
  const system = [context.systemPrompt ?? "", ...(context.messages ?? [])
    .filter(message => message.role === "system").map(getSystemMessageText)].join("\n");
  const match = system.match(/<name>verify-behavior<\/name>[\s\S]*?<location>(.*?)<\/location>/);
  assert(match, "verify-behavior must be advertised to caller");
  const helperPath = path.join(path.dirname(match[1]), "jev-advice.js");
  assert.equal(helperPath, path.join(installed, relativeHelper));
  return helperPath;
}

async function localChat(agentDir, installed, inputs) {
  let helperPath;
  const principal = inputs[0].context.marker === "principal-unavailable";
  const provider = await installLocalProvider({
    agentDir, toolTurns: inputs.length + (principal ? 1 : 0), responseForPrompt: () => "advice fixture settled",
    toolForPrompt(_prompt, completed) {
      if (principal && completed === inputs.length)
        return { name: "bash", arguments: { command: "printf 'T2 optional unavailable action executed\\n'" } };
      return completed < inputs.length ? { name: "codemode",
        arguments: { code: invocation(helperPath, inputs[completed]) } } : undefined;
    },
  });
  const driver = globalThis.__pitako_local;
  const original = driver.streamSimple;
  driver.streamSimple = (selected, context, options) => {
    helperPath = advertisedHelper(context, installed);
    return original(selected, context, options);
  };
  return provider;
}

async function coordinatorFixture(agentDir, installed, cwd) {
  const { default: agentInstance } = await import(pathToFileURL(path.join(installed, "extensions/agent/index.ts")).href);
  const { bindBackgroundOwner, clearBackgroundOwner, spawnBackground, resolveLiveTarget, cancelAllWorkers } =
    await import(pathToFileURL(path.join(installed, "extensions/agent/background.ts")).href);
  const { createPiExecutor } = await import(pathToFileURL(path.join(installed, "extensions/agent/pi.ts")).href);
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
  const held = deferred(), release = deferred(), settled = deferred();
  globalThis.__jev_hold = { held, release, first: true };
  writeFileSync(path.join(agentDir, "extensions", "hold.js"), `export default function(pi) {
    pi.on("tool_call", async event => {
      if (event.toolName === "read" && globalThis.__jev_hold.first) {
        globalThis.__jev_hold.first = false;
        globalThis.__jev_hold.held.resolve(); await globalThis.__jev_hold.release.promise;
      }
    });
  }`);
  let nextTool, session;
  const provider = await installLocalProvider({ agentDir, toolTurns: 0,
    toolForPrompt: prompt => prompt.startsWith("T2 original") ? { name: "read", arguments: { path: "sample.txt" } } :
      prompt.startsWith("coordinator") ? nextTool : undefined,
    responseForPrompt: prompt => `candidate reply ${prompt}`,
  });
  writeFileSync(path.join(cwd, "sample.txt"), "owned worker data\n");
  const config = path.join(agentDir, "pitako", "t2-config.toml");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, `[model_policies.developer.primary]\nmodel = "${provider.provider}/${provider.model}"\nreasoning = "off"\n`);
  let worker, observed, settledDone = false;
  try {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true,
      extensionFactories: [agentInstance, createCodemodeExtension({ mode: "on" })] });
    await loader.reload();
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    session = (await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader,
      modelRuntime: runtime, sessionManager: SessionManager.create(cwd, path.join(agentDir, "coordinator-native")) })).session;
    await session.bindExtensions({ mode: "rpc" });
    await session.setModel(runtime.getModel(provider.provider, provider.model));
    session.setActiveToolsByName(["codemode", "read", "agent_input"]);
    bindBackgroundOwner({ token: Symbol("T2 coordinator"), isIdle: () => true, hasUI: true,
      notify() { settledDone = true; settled.resolve(); }, sendMessage() { settledDone = true; settled.resolve(); } });
    worker = await spawnBackground({ roleId: "developer", task: "T2 original worker WorkBrief", cwd,
      historyOrigin: { source: "agent_spawn", workbrief: "T2 original worker WorkBrief",
        coordinatorSessionId: session.sessionId, coordinatorSessionFile: session.sessionFile },
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config }, executor: createPiExecutor() });
    await held.promise;
    const live = resolveLiveTarget({ kind: "background", instanceId: worker.instanceId }, session.sessionId);
    observed = live.observe();
    const target = { kind: "background", instanceId: worker.instanceId,
      historyId: observed.historyId, sessionId: observed.sessionId };
    const helperSource = `const helper = eval(await tools.read({path:${JSON.stringify(path.join(installed, relativeHelper))}}));`;
    let step = 0;
    async function code(body) {
      nextTool = { name: "codemode", arguments: { code: helperSource + body } };
      await session.prompt(`coordinator step ${step++}`);
    }
    const firstInput = inputFor("consultation", "coordinator-first");
    firstInput.context.proposal = "query exact active worker; do not dispatch from recommendation";
    await code(`const result = await helper.advise(${JSON.stringify(firstInput)}); store("fixture.first",result); return result;`);
    await code(`const result = await helper.advise(${JSON.stringify(inputFor("test-audit", "coordinator-second"))}); store("fixture.second",result); return result;`);
    const selectedAction = { intent: "query", text: "T2 deterministic query" };
    await code(`const result = helper.recordDecision({adviceId:load("fixture.first").id,target:${JSON.stringify(target)},
      selectedAction:${JSON.stringify(selectedAction)},reason:"Owned evidence selects query independently of advice",evidenceRefs:["fixture/selected"]});
      store("fixture.decision",result); return result;`);
    await code(`return helper.recordDecision({adviceId:"missing",target:${JSON.stringify(target)},
      selectedAction:${JSON.stringify(selectedAction)},reason:"missing link",evidenceRefs:[]});`);
    await code(`text(helper.recordDecision({adviceId:load("fixture.first").id,target:${JSON.stringify(target)},
      selectedAction:{intent:"steer",text:"never submitted"},reason:"failed staging",evidenceRefs:[]}));
      throw new Error("owned interrupted decision after staging");`);
    const records = physicalRecords(session.sessionFile);
    const decision = JSON.parse(readFileSync(session.sessionFile, "utf8").trim().split("\n")
      .find(line => line.includes('"pitako.jev.decision.latest"'))).data.set["pitako.jev.decision.latest"];
    nextTool = { name: "agent_input", arguments: { target: { kind: target.kind, instanceId: target.instanceId },
      historyId: target.historyId, sessionId: target.sessionId, ...selectedAction, decisionId: decision.id } };
    await session.prompt(`coordinator input step ${step++}`);
    const receipt = session.sessionManager.getEntries().filter(entry => entry.type === "message" &&
      entry.message.role === "toolResult" && entry.message.toolName === "agent_input").at(-1).message.details;
    assert.equal(receipt.status, "queued");
    assert.equal(receipt.decisionId, decision.id);
    release.resolve();
    await settled.promise;
    assert(provider.trace.some(row => row.prompt.includes(receipt.interactionId)));
    const outcome = live.observe().interactions.find(item => item.interactionId === receipt.interactionId);
    assert.equal(outcome.status, "unconfirmed");
    assert(outcome.candidateAnswer); // Mentions ID only; not adequate-answer proof.
    await code(`return helper.recordObservation({decisionId:load("fixture.decision").id,
      interactionReceipt:${JSON.stringify(receipt)},observedOutcome:${JSON.stringify(outcome)},evidenceRefs:["fixture/provider-boundary"]});`);
    await code(`text(helper.recordObservation({decisionId:load("fixture.decision").id,observedOutcome:"not committed",evidenceRefs:[]}));
      throw new Error("owned interrupted observation after staging");`);
    await code(`return helper.recordObservation({decisionId:"missing",observedOutcome:"unknown",evidenceRefs:[]});`);
    assert.equal(records.length, 2);
    return { historyId: target.historyId, groupId: observed.groupId, target, advice: records, decision, receipt,
      coordinatorFile: session.sessionFile, coordinatorSessionId: session.sessionId, outcome, trace: provider.trace };
  } finally {
    release.resolve();
    if (worker && !settledDone) await settled.promise;
    await session?.dispose();
    cancelAllWorkers(); clearBackgroundOwner(); delete globalThis.__jev_hold;
    rmSync(path.join(agentDir, "extensions", "hold.js"), { force: true });
  }
}

const physicalRecords = file => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)
  .filter(entry => entry.type === "custom" && entry.customType === "codemode-store")
  .flatMap(entry => Object.hasOwn(entry.data.set, "pitako.jev.latest") ? [entry.data.set["pitako.jev.latest"]] : []);

if (process.argv[2] === "--principal") {
  const installed = process.argv[3];
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const provider = await localChat(agentDir, installed, [inputFor("failure", "principal-unavailable")]);
  // Exercise Pi's own principal registration, not another codemode factory.
  const mainPath = path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "main.js");
  const { main } = await import(pathToFileURL(mainPath).href);
  await main(["--offline", "--mode", "json", "--provider", provider.provider, "--model", provider.model,
    "--thinking", "off", "--tools", "read,bash,codemode", "--approve", "optional advice from installed skill"]);
} else if (process.argv[2] === "--read") {
  const installed = process.argv[3];
  const expected = JSON.parse(readFileSync(process.argv[4], "utf8"));
  const { WorkerHistory, nativeHistoryStatus } = await import(pathToFileURL(path.join(installed, "extensions/agent/history.ts")).href);
  const history = new WorkerHistory();
  const member = history.list().flatMap(group => group.members).find(item => item.instanceId === "developer-jev-offline");
  assert.equal(nativeHistoryStatus(member).state, "present");
  assert.equal(member.terminal.status, "completed");
  assert.equal(member.native.disposition.state, "disposed");
  assert.equal(existsSync(expected.cwd), false);
  assert(member.native.path.startsWith(process.env.PI_CODING_AGENT_DIR + path.sep));
  const bytes = readFileSync(member.native.path);
  const physical = physicalRecords(member.native.path);
  assert.equal(physical.length, 2);
  assert.notEqual(physical[0].id, physical[1].id);
  assert.notEqual(physical[0].time, physical[1].time);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(physical[i].state, expected.requests[i].request.state);
    assert.deepEqual(physical[i].request, expected.requests[i].request);
    assert.deepEqual(physical[i].response, expected.requests[i].response);
    assert.deepEqual(physical[i].evidenceRefs, inputFor("consultation").evidenceRefs);
  }
  const entries = SessionManager.open(member.native.path).getEntries();
  const nativeRecords = entries.filter(entry => entry.type === "custom" && entry.customType === "codemode-store")
    .flatMap(entry => Object.hasOwn(entry.data.set, "pitako.jev.latest") ? [entry.data.set["pitako.jev.latest"]] : []);
  assert.deepEqual(nativeRecords, physical);
  const outputs = entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult" &&
    entry.message.toolName === "codemode");
  assert.equal(outputs.length, 3);
  for (const output of outputs.slice(0, 2)) assert.match(JSON.stringify(output), /Script completed/);
  assert.match(JSON.stringify(outputs[2]), /owned failure after staging/);
  assert.match(JSON.stringify(outputs[2]), /Script failed/);
  assert.match(JSON.stringify(outputs[2]), /staged/);
  assert(!physical.some(record => record.state.marker === "uncommitted"));
  assert.deepEqual(physicalRecords(expected.principalFile), expected.principalRecords);
  assert.deepEqual(readFileSync(member.native.path), bytes);
  const { default: agentInstance } = await import(pathToFileURL(path.join(installed, "extensions/agent/index.ts")).href);
  let historyTool;
  agentInstance({ registerTool(tool) { if (tool.name === "agent_history") historyTool = tool; },
    registerCommand() {}, on() {}, getActiveTools() { return []; }, getAllTools() { return []; } });
  async function publicRead(historyId, source) {
    const fragments = [];
    let cursor;
    do {
      const result = await historyTool.execute("fresh-read", { action: "read", historyId, source, cursor, limit: 2 },
        undefined, undefined, { cwd: "/removed/fixture", sessionManager: { getSessionId: () => "fresh-reader" } });
      const page = result.details;
      assert(!result.isError, JSON.stringify(result));
      assert(!page.diagnostics.some(row => !row.code.startsWith("sidecar_") && row.code !== "native_physical_order"),
        JSON.stringify(page.diagnostics));
      assert(Buffer.byteLength(result.content[0].text) <= 32768);
      fragments.push(...page.items.map(item => Buffer.from(item.data, "base64")));
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return Buffer.concat(fragments);
  }
  const coordinatorBytes = await publicRead(expected.linkage.historyId, "coordinator");
  const linkageMember = history.list().flatMap(group => group.members).find(item => item.historyId === expected.linkage.historyId);
  assert.equal(linkageMember.terminal.status, "completed");
  assert.equal(linkageMember.native.disposition.state, "disposed");
  assert.equal(linkageMember.coordinatorSessionId, expected.linkage.coordinatorSessionId);
  assert.equal(linkageMember.coordinatorSessionFile, expected.linkage.coordinatorFile);
  assert.deepEqual(coordinatorBytes, readFileSync(expected.linkage.coordinatorFile));
  const coordinatorEntries = coordinatorBytes.toString().trim().split("\n").map(JSON.parse);
  const stored = coordinatorEntries.filter(entry => entry.type === "custom" && entry.customType === "codemode-store")
    .flatMap(entry => Object.entries(entry.data.set).filter(([key]) => /^pitako\.jev\.(advice|decision|observation)\./.test(key) &&
      !key.endsWith(".latest")).map(([, value]) => value));
  const advice = stored.filter(record => record.outcome === "advice");
  const decisions = stored.filter(record => record.outcome === "decision");
  const observations = stored.filter(record => record.outcome === "observation");
  assert.equal(advice.length, 2);
  assert.deepEqual(advice, expected.linkage.advice);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].adviceId, advice[0].id);
  assert.deepEqual(decisions[0], expected.linkage.decision);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].decisionId, decisions[0].id);
  assert.deepEqual(observations[0].interactionReceipt, expected.linkage.receipt);
  const workerBytes = await publicRead(expected.linkage.historyId, "worker");
  const workerEntries = workerBytes.toString().trim().split("\n").map(JSON.parse);
  assert(workerEntries.some(entry => entry.customType === "pitako.worker-history" &&
    entry.data.event === "interaction" && entry.data.data.interactionId === expected.linkage.receipt.interactionId &&
    entry.data.data.status === "queued" && entry.data.data.decisionId === decisions[0].id));
  const call = coordinatorEntries.find(entry => entry.type === "message" && entry.message.role === "assistant" &&
    entry.message.content.some(part => part.type === "toolCall" && part.name === "agent_input"));
  assert(call);
  const result = coordinatorEntries.find(entry => entry.type === "message" && entry.message.role === "toolResult" &&
    entry.message.toolName === "agent_input");
  assert.deepEqual(result.message.details, expected.linkage.receipt);
  const errors = coordinatorEntries.filter(entry => entry.type === "message" && entry.message.role === "toolResult" &&
    entry.message.toolName === "codemode" && JSON.stringify(entry).includes("Script failed"));
  assert.equal(errors.length, 2);
  assert(errors.every(entry => JSON.stringify(entry).includes("staged")));
  assert(coordinatorEntries.some(entry => entry.type === "message" && entry.message.role === "toolResult" &&
    JSON.stringify(entry).includes("record unavailable on this native branch")));
  const principalEntries = readFileSync(expected.principalFile, "utf8").trim().split("\n").map(JSON.parse);
  assert(principalEntries.some(entry => entry.type === "message" && entry.message.role === "toolResult" &&
    entry.message.toolName === "bash" && !entry.message.isError &&
    JSON.stringify(entry).includes("T2 optional unavailable action executed")));
  console.log(JSON.stringify({ existingHistoryReader: true, physicalAndNativeRecords: 2,
    exactInputsAndResponses: true, removedOnlyCwd: true, principalUnavailableRetained: true,
    failedStagedInvocationNotCommitted: true, records: physical,
    coordinatorPhysical: { retainedAdvice: advice, decisions, observations, nativeInputCall: call, nativeInputResult: result,
      failedStagingResults: errors, workerInteraction: workerEntries.filter(entry => entry.customType === "pitako.worker-history" &&
        entry.data.event === "interaction"), freshShippedHistoryTool: true, optionalUnavailableNativeAction: true } }));
} else {
  const branchEvidence = await branches();
  const root = mkdtempSync(path.join(tmpdir(), "pitako-jev-sdk-"));
  const installed = path.join(root, "installed", "pitako");
  const cwd = path.join(root, "unrelated-project");
  const agentDir = path.join(root, "private-agent");
  mkdirSync(installed, { recursive: true });
  mkdirSync(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  let child;
  try {
    // Installed package-layout fixture: shipped assets are independent copies;
    // only the already-verified dependency installation is reused.
    const manifest = JSON.parse(readFileSync(path.join(checkout, "package.json"), "utf8"));
    assert(manifest.files.includes("skills"));
    assert(manifest.pi.skills.includes("./skills/practical"));
    for (const item of ["extensions", "config", "roles", "skills", "package.json"]) {
      cpSync(path.join(checkout, item), path.join(installed, item), { recursive: true });
    }
    symlinkSync(path.join(checkout, "node_modules"), path.join(installed, "node_modules"), "dir");
    assert.equal(existsSync(path.join(cwd, "GATES.md")), false);
    assert.equal(existsSync(path.join(cwd, relativeHelper)), false);
    mkdirSync(agentDir);
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      packages: [{ source: installed, extensions: [], prompts: [], themes: [] }],
      codemode: { mode: "on" }, compaction: { enabled: false },
    }));
    const principal = spawnSync(process.execPath, [...process.execArgv, script, "--principal", installed], {
      cwd, env: process.env, encoding: "utf8", timeout: 45000, maxBuffer: 4 * 1048576,
    });
    assert.equal(principal.status, 0, principal.stderr + principal.stdout);
    const principalEvents = principal.stdout.split("\n").filter(line => line.startsWith("{")).map(JSON.parse);
    const principalOutput = principalEvents.filter(event => event.type === "tool_execution_end");
    assert(principalOutput.length, JSON.stringify(principalEvents.filter(event =>
      event.type === "message_end" && event.message?.role === "assistant")));
    assert.match(JSON.stringify(principalOutput) + principal.stderr, /Script completed/);
    assert.match(JSON.stringify(principalOutput), /unavailable/);
    assert(principalOutput.some(event => event.toolName === "bash" && !event.isError &&
      JSON.stringify(event.result).includes("T2 optional unavailable action executed")));
    // Discover the principal's native file in its private native directory.
    const files = readdirSync(path.join(agentDir, "sessions"), { recursive: true })
      .filter(file => file.endsWith(".jsonl")).map(file => path.join(agentDir, "sessions", file));
    assert.equal(files.length, 1);
    const principalRecords = physicalRecords(files[0]);
    assert.equal(principalRecords.length, 1);
    assert.equal(principalRecords[0].outcome, "unavailable");
    assert(!("request" in principalRecords[0]));
    assert(!("response" in principalRecords[0]));
    assert.deepEqual(principalRecords[0].state, inputFor("failure", "principal-unavailable").context);

    const inputs = [inputFor("consultation", "first"), inputFor("test-audit", "second"),
      inputFor("failure", "uncommitted")];
    const chat = await localChat(agentDir, installed, inputs);
    const requests = [];
    globalThis.__jev_owned_classifier = {
      baseUrl: "http://127.0.0.1", apiKey: "offline-owned-fixture",
      models: [{ type: "classifier", id: model.id, name: "Owned JEV substitute",
        api: model.api, contextWindow: model.contextWindow }],
      classifiers: { [model.api]: { async classify(selected, request) {
        assert.equal(selected.provider, model.provider);
        assert.equal(selected.id, model.id);
        const response = responseFor(["first", "coordinator-first"].includes(request.state.marker) ? "continue_developer" : "useful_owned_observer");
        requests.push({ request: clone(request), response: clone(response) });
        await new Promise(resolve => setTimeout(resolve, 5));
        return response;
      } } },
    };
    writeFileSync(path.join(agentDir, "extensions", "jev-owned-classifier.js"),
      `export default function(pi) { pi.registerProvider("opencode", globalThis.__jev_owned_classifier); }\n`);
    const { createPiExecutor } = await import(pathToFileURL(path.join(installed, "extensions/agent/pi.ts")).href);
    child = await createPiExecutor().start({
      instanceId: "developer-jev-offline",
      role: { id: "developer", name: "Developer", description: "fixture", instructionsPath: "roles/developer.md",
        instructions: "Offline optional advice", skills: ["verify-behavior"], principles: [], modelPolicyId: "developer",
        modelPolicy: { id: "developer", fallbacks: [] } },
      task: "retain two separate optional advice invocations", cwd,
      target: { model: `${chat.provider}/${chat.model}`, reasoning: "off" },
      signal: new AbortController().signal,
    });
    assert.equal(child.status, "completed", child.error);
    assert.equal(child.result, "advice fixture settled");
    assert.equal(requests.length, 3);
    await child.session.dispose();
    child = undefined;
    const linkage = await coordinatorFixture(agentDir, installed, cwd);
    const expectedFile = path.join(root, "expected.json");
    writeFileSync(expectedFile, JSON.stringify({ requests: requests.slice(0, 3), cwd, principalFile: files[0], principalRecords, linkage }));
    rmSync(cwd, { recursive: true });
    assert(existsSync(agentDir));
    const reader = spawnSync(process.execPath, [...process.execArgv, script, "--read", installed, expectedFile], {
      env: process.env, encoding: "utf8", timeout: 30000,
    });
    assert.equal(reader.status, 0, reader.stderr + reader.stdout);
    const evidence = {
      branchEvidence, installedLayout: true, advertisedDiscovery: ["principal CLI/Pi-owned builtin", "production ordinary child"],
      unrelatedCwdWithoutCheckoutOrGates: true, classifier: "owned public provider substitute; no live JEV",
      paidCalls: 0, principalUnavailable: "retained; zero classify calls",
      ordinaryClassifyCalls: 3, coordinatorClassifyCalls: requests.length - 3, principalRecord: principalRecords[0],
      linkage, recovery: JSON.parse(reader.stdout.trim()),
    };
    if (process.argv[2]) {
      const { WorkerHistory } = await import(pathToFileURL(path.join(installed, "extensions/agent/history.ts")).href);
      const worker = new WorkerHistory().list().flatMap(group => group.members).find(member => member.historyId === linkage.historyId);
      evidence.nativeArtifacts = {};
      for (const [name, file] of Object.entries({ coordinator: linkage.coordinatorFile, worker: worker.native.path, principal: files[0] })) {
        const bytes = readFileSync(file);
        const artifact = path.join(path.dirname(process.argv[2]), `${name}-native.jsonl`);
        writeFileSync(artifact, bytes);
        evidence.nativeArtifacts[name] = { artifact, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      }
      writeFileSync(process.argv[2], JSON.stringify(evidence, null, 2) + "\n");
    }
    console.log(JSON.stringify({ ...evidence, principalRecord: undefined,
      recovery: { ...evidence.recovery, records: undefined } }));
  } finally {
    await child?.session?.dispose();
    delete globalThis.__pitako_local;
    delete globalThis.__jev_owned_classifier;
    rmSync(root, { recursive: true, force: true });
  }
}
