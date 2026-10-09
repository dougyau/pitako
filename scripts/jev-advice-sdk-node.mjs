import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getSystemMessageText } from "@earendil-works/pi-ai";
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
        assert.equal(slot, "pitako.jev.latest");
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
    assert.equal(result.writes, 1);
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
  const provider = await installLocalProvider({
    agentDir, toolTurns: inputs.length, responseForPrompt: () => "advice fixture settled",
    toolForPrompt(_prompt, completed) {
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
  console.log(JSON.stringify({ existingHistoryReader: true, physicalAndNativeRecords: 2,
    exactInputsAndResponses: true, removedOnlyCwd: true, principalUnavailableRetained: true,
    failedStagedInvocationNotCommitted: true, records: physical }));
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
        const response = responseFor(request.state.marker === "first" ? "continue_developer" : "useful_owned_observer");
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
    const expectedFile = path.join(root, "expected.json");
    writeFileSync(expectedFile, JSON.stringify({ requests, cwd, principalFile: files[0], principalRecords }));
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
      ordinaryClassifyCalls: requests.length, principalRecord: principalRecords[0],
      recovery: JSON.parse(reader.stdout.trim()),
    };
    if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify({ ...evidence, principalRecord: undefined,
      recovery: { ...evidence.recovery, records: undefined } }));
  } finally {
    await child?.session?.dispose();
    delete globalThis.__pitako_local;
    delete globalThis.__jev_owned_classifier;
    rmSync(root, { recursive: true, force: true });
  }
}
