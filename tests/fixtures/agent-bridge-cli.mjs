import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync, existsSync, realpathSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const source = fileURLToPath(new URL("../../", import.meta.url));
// Each private state file has one synchronous writer. Publish complete JSON by
// replacing its directory entry; observers watch the directory, not the inode.
const publishJSON = `function publishJSON(file, value) {
  writeFileSync(file + ".tmp", JSON.stringify(value));
  renameSync(file + ".tmp", file);
}`;
const guard = process.argv[2];
const root = mkdtempSync(path.join(tmpdir(), "pitako-bridge-cli-"));
const installed = path.join(root, "node_modules/pitako"), cwd = path.join(root, "workspace");
const agentDir = path.join(root, "agent"), bridge = path.join(root, "bridge");
const processes = new Set();
let retained = false;
const logs = [];
const readCapabilities = ["workers.list", "workers.detail", "workers.requests", "workers.activity", "workers.result", "subscribe", "unsubscribe",
  "history.list", "history.read", "route.read", "view.grant", "input", "cancel", "request.status"];
const workerMode = ["workers", "subscriptions", "streaming", "history", "controls"].includes(guard);
function child(command, args, options) {
  const process = spawn(command, args, options);
  processes.add(process);
  const closed = new Promise(resolve => process.once("close", (code, signal) => { processes.delete(process); resolve({ code, signal }); }));
  return { process, closed };
}
const bounded = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} deadline`)), 60_000); })])
    .finally(() => clearTimeout(timer));
};
try {
  for (const directory of [installed, cwd, agentDir, bridge]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const resource of ["package.json", "extensions", "config", "roles", "skills", "prompts"])
    cpSync(path.join(source, resource), path.join(installed, resource), { recursive: true });
  mkdirSync(path.join(installed, "node_modules"));
  for (const entry of readdirSync(path.join(source, "node_modules"))) {
    const from = path.join(source, "node_modules", entry), to = path.join(installed, "node_modules", entry);
    if (entry === "pi-codex-tools") cpSync(from, to, { recursive: true, dereference: true });
    else symlinkSync(from, to);
  }
  const provider = path.join(root, "fixture-provider.mjs"), calls = path.join(root, "provider-calls.json");
  writeFileSync(provider, `
import { writeFileSync, renameSync, watch, existsSync } from "node:fs";
${publishJSON}
import { ownedDispatch } from ${JSON.stringify(path.join(installed, "extensions/agent/dispatch.ts"))};
import { createAssistantMessageEventStream } from ${JSON.stringify(path.join(installed, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js"))};
let calls = 0;
const save = () => publishJSON(${JSON.stringify(calls)}, { calls });
const stateFile = ${JSON.stringify(path.join(root, "fixture-state.json"))};
const releaseFile = ${JSON.stringify(path.join(root, "release"))};
const observed = { phase: "cold" };
const saveState = () => publishJSON(stateFile, observed);
let dispatch, watcher, release, foregroundRelease, foregroundWatch, foregroundWork;
export default function(pi) {
  save(); saveState();
  pi.registerProvider("bridge-fixture", {
    api: "openai-responses", baseUrl: "http://127.0.0.1", apiKey: "fixture",
    models: [{ id: "cold", name: "Bridge cold fixture", compat: { supportsOpenAIGrammarTools: true },
      reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      calls++; save();
      if (!${JSON.stringify(guard === "streaming")}) throw new Error("Coordinator provider must not be called");
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: "intentional held foreground" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const held = new Promise(resolve => { foregroundRelease = resolve; });
      foregroundWatch = watch(${JSON.stringify(root)}, (_event, file) => {
        if (String(file) === "release-stream") { foregroundWatch.close(); foregroundWatch = undefined; foregroundRelease(); }
      });
      foregroundWork = (async () => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        observed.phase = "streaming"; saveState();
        await held;
        stream.push({ type: "done", reason: "stop", message }); stream.end(message);
      })();
      return stream;
    }
  });
  pi.registerCommand("fixture-hold", { description: "Own a controllable native cleanup await", handler: (_args, ctx) => {
    observed.phase = "held"; saveState();
    const held = new Promise(resolve => { release = resolve; });
    watcher = watch(${JSON.stringify(root)}, (_event, file) => {
      if (String(file) === "release" && existsSync(releaseFile)) { watcher.close(); watcher = undefined; release(); }
    });
    dispatch = ownedDispatch(ctx, undefined, () => true, async signal => {
      signal.addEventListener("abort", () => { observed.phase = "retirement-held"; saveState(); }, { once: true });
      await held;
    });
  } });
  pi.on("session_shutdown", async () => {
    release?.(); foregroundRelease?.(); await foregroundWork; await dispatch;
    watcher?.close(); foregroundWatch?.close(); save();
  });
}
`);
  const integration = path.join(root, "fixture-workers.mjs");
  if (workerMode) {
    mkdirSync(path.join(agentDir, "extensions"));
    mkdirSync(path.join(agentDir, "pitako"));
    writeFileSync(path.join(agentDir, "pitako/config.toml"), `
[model_policies.researcher.primary]
model = "bridge-worker/controlled"
reasoning = "off"
[model_policies.developer.primary]
model = "bridge-worker/controlled"
reasoning = "off"
`);
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      enableInstallTelemetry: false, compaction: { enabled: false }, cacheWarming: "off",
    }));
    writeFileSync(path.join(agentDir, "extensions/worker.js"), `
import { createAssistantMessageEventStream } from ${JSON.stringify(path.join(installed, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js"))};
export default function(pi) {
  pi.on("input", async event => {
    const held = event.text.endsWith("Text (not a command):\\nfixture-held-receipt");
    if (!held && !event.text.endsWith("Text (not a command):\\nfixture-receipt-only")) return;
    const fixture = globalThis[Symbol.for("pitako.fixture.bridge-workers")];
    fixture.inputEffects = (fixture.inputEffects ?? 0) + 1; fixture.save();
    if (held) await fixture.inputRelease;
    return { action: "handled" };
  });
  pi.registerProvider("bridge-worker", {
    api: "openai-responses", baseUrl: "http://127.0.0.1", apiKey: "fixture",
    models: [{ id: "controlled", name: "Controlled child", compat: { supportsOpenAIGrammarTools: true },
      reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const fixture = globalThis[Symbol.for("pitako.fixture.bridge-workers")];
      if (!fixture) throw Error("Only fixture-owned children may use this provider");
      fixture.childCalls++;
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: fixture.result }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(async () => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "live child", partial: { ...message, content: [{ type: "text", text: "live child" }] } });
        fixture.save();
        await fixture.release;
        stream.push({ type: "text_end", contentIndex: 0, content: fixture.result, partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    }
  });
}
`);
    writeFileSync(integration, `
import { watch, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
${publishJSON}
import { createHash } from "node:crypto";
import { AgentSession } from ${JSON.stringify(path.join(installed, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"))};
import { spawnBackground, backgroundExecutor, workerResult, teamWorkerResult, resolveLiveBinding } from ${JSON.stringify(path.join(installed, "extensions/agent/background.ts"))};
import { listObservations } from ${JSON.stringify(path.join(installed, "extensions/agent/observe.ts"))};
import { executionForSession } from ${JSON.stringify(path.join(installed, "extensions/execution-identity.ts"))};
import { teamEvaluationForSession, reserveTeamRole, recordTeamAssignment, teamAssignments, recordPlanTeamWork } from ${JSON.stringify(path.join(installed, "extensions/team.ts"))};
import { openExecutionPlan, ledgerFile } from ${JSON.stringify(path.join(installed, "extensions/workflow.ts"))};
const root = ${JSON.stringify(root)}, stateFile = root + "/worker-state.json";
const brief = "\\u0000\\\"\\\\\\ud800😀".repeat(1300), result = "terminal\\u0000\\\"\\\\\\udc00😀".repeat(1500);
let release, inputRelease, ctx, evaluation, admission, observer, execution, checking = false;
const fixture = { childCalls: 0, result, brief, phase: "cold", handles: [], disposed: [], natives: [],
  release: new Promise(resolve => { release = resolve; }), inputRelease: new Promise(resolve => { inputRelease = resolve; }) };
globalThis[Symbol.for("pitako.fixture.bridge-workers")] = fixture;
const save = fixture.save = () => publishJSON(stateFile, { phase: fixture.phase, childCalls: fixture.childCalls,
  handles: fixture.handles, disposed: fixture.disposed, receipts: fixture.receipts, inputEffects: fixture.inputEffects, brief, result, before: fixture.before, after: fixture.after,
  consumed: fixture.consumed, error: fixture.error });
const dispose = AgentSession.prototype.dispose;
AgentSession.prototype.dispose = async function(...args) {
  const identity = executionForSession(this.sessionId), file = this.sessionFile;
  const value = await dispose.apply(this, args);
  if (identity) { fixture.disposed.push(this.sessionId); fixture.natives.push({ id: this.sessionId, file }); save(); }
  return value;
};
function snapshot() {
  const bag = globalThis[Symbol.for("pitako.backgroundWorkers")];
  return { rows: fixture.handles.map(handle => {
    const row = bag.rows.get(handle.instanceId);
    return { id: row.instanceId, outcome: !!row.outcome, signal: row.signal, live: !!row.live,
      resultTaken: listObservations(evaluation.token, ctx.sessionManager.getSessionId()).find(item => item.id === row.instanceId)?.resultTaken ?? false };
  }), assignments: teamAssignments(evaluation), roles: [...globalThis[Symbol.for("pitako.teamRegistry")].evaluations.get(evaluation.sessionId).roles],
    held: bag.held.map(item => ({ id: item.instanceId, text: item.text })),
    workflow: readFileSync(ledgerFile("bridge-native", ctx.cwd), "utf8"),
    history: fixture.natives.map(item => ({ id: item.id, registered: !!executionForSession(item.id),
      bytes: existsSync(item.file) ? createHash("sha256").update(readFileSync(item.file)).digest("hex") : null })) };
}
async function inspect() {
  if (existsSync(root + "/release-input")) inputRelease();
  if (checking) return; checking = true;
  try {
    if (fixture.phase === "cold" && existsSync(root + "/start-workers")) {
      fixture.phase = "admitting"; save();
      admission = (async () => {
        evaluation = teamEvaluationForSession(ctx.sessionManager.getSessionId(), false);
        mkdirSync(ctx.cwd + "/.pitako/plans", { recursive: true });
        writeFileSync(ctx.cwd + "/.pitako/plans/bridge-native.md",
          "---\\nid: bridge-native\\nrevision: 1\\nstatus: frozen\\nboard_topic_id: 1\\n---\\nOwned fixture plan.\\n");
        execution = openExecutionPlan("bridge-native", ctx.cwd, { createLedger: true }).binding;
        const background = await spawnBackground({ roleId: "researcher", task: brief, cwd: ctx.cwd, executor: backgroundExecutor(),
          historyOrigin: { source: "agent_spawn", coordinatorSessionId: ctx.sessionManager.getSessionId(), workbrief: brief } });
        fixture.handles.push(background);
        const assignmentId = "native-team-assignment", reservation = reserveTeamRole(evaluation, "developer", assignmentId);
        const team = await spawnBackground({ roleId: "developer", task: brief, cwd: ctx.cwd, executor: backgroundExecutor(),
          teamOwner: { token: reservation.token, assignmentId, onSettled: () => reservation.settled() },
          historyOrigin: { source: "team_assign", coordinatorSessionId: ctx.sessionManager.getSessionId(), assignmentId, workbrief: brief } });
        reservation.commit();
        recordPlanTeamWork(ctx.cwd, "bridge-native", "T2", assignmentId, "pending", execution);
        recordTeamAssignment(evaluation, "developer", { id: assignmentId, instanceId: team.instanceId, roleId: "developer", task: brief });
        fixture.handles.push(team); fixture.phase = "live"; save();
      })();
      await admission;
    }
    if (existsSync(root + "/probe-workers") && fixture.phase === "live" && !fixture.receipts) {
      fixture.receipts = [];
      for (const [index, row] of fixture.handles.entries()) {
        const target = index === 0 ? { kind: "background", instanceId: row.instanceId }
          : { kind: "team", assignmentId: "native-team-assignment" };
        const { handle } = resolveLiveBinding(target, ctx.sessionManager.getSessionId(), evaluation.token);
        // Local fixture control, never a bridge mutation or another provider request.
        fixture.receipts.push(await handle.input({ intent: "query", text: "fixture-receipt-only",
          historyId: handle.historyId, sessionId: handle.sessionId }));
      }
      save();
    }
    if (existsSync(root + "/release-workers") && fixture.phase === "live") {
      fixture.phase = "settling"; release(); save();
      const bag = globalThis[Symbol.for("pitako.backgroundWorkers")];
      while (fixture.handles.some(handle => !bag.rows.get(handle.instanceId)?.outcome))
        await new Promise(resolve => setImmediate(resolve));
      fixture.before = snapshot(); fixture.phase = "terminal"; save();
    }
    if (existsSync(root + "/compare-workers") && fixture.phase === "terminal") {
      fixture.after = snapshot();
      const background = workerResult(fixture.handles[0].instanceId);
      const team = teamWorkerResult(evaluation.token, fixture.handles[1].instanceId);
      recordPlanTeamWork(ctx.cwd, "bridge-native", "T2", "native-team-assignment", team.status, execution);
      fixture.consumed = { background: background.status, team: team.status, snapshot: snapshot() };
      fixture.phase = "compared"; save();
    }
  } catch (error) { fixture.error = String(error.stack); save(); }
  finally { checking = false; }
}
export default function(pi) {
  save();
  pi.on("session_start", (_event, context) => {
    ctx = context;
    observer = watch(root, (_event, file) => {
      if (["start-workers", "probe-workers", "release-workers", "compare-workers", "release-input"].includes(String(file))) void inspect();
    });
  });
  pi.on("session_shutdown", async () => {
    release(); inputRelease(); await admission; observer?.close();
    AgentSession.prototype.dispose = dispose;
  });
}
`);
  }
  const consumer = path.join(root, "consumer.mjs");
  writeFileSync(consumer, `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const before = readFileSync(process.argv[2], "utf8");
const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
let timers = 0;
globalThis.setTimeout = (...args) => { timers++; return timeout(...args); };
globalThis.setInterval = (...args) => { timers++; return interval(...args); };
const { connect } = await import("pitako/extensions/agent/bridge/client.js");
assert.equal(timers, 0, "passive import must create no timers");
assert.equal(typeof globalThis.Bun, "undefined");
assert.equal(readFileSync(process.argv[2], "utf8"), before, "passive import must not change discovery");
globalThis.setTimeout = timeout; globalThis.setInterval = interval;
const client = await connect(process.argv[2], { expectedSessionId: process.argv[3] });
try {
  const page = await client.list();
  assert.deepEqual(page.items, []);
  assert.equal(page.cursor, null);
  assert.equal(page.owner.coordinatorSessionId, process.argv[3]);
  assert.deepEqual(client.capabilities, ${JSON.stringify(readCapabilities)});
  console.log(JSON.stringify({ owner: client.owner, page, capabilities: client.capabilities }));
} finally { await client.disconnect(); }
`);
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PITAKO_PROFILE: "coding" };
  for (const key of Object.keys(env))
    if (/API_KEY|TOKEN|SECRET|PASSWORD/.test(key) || /^(PITAKO_INSTANCE_ID|PITAKO_ROLE_ID|BILLION_CONTEXT_PROXY|BILLION_CONTEXT_NATIVE)$/.test(key))
      delete env[key];
  if (guard === "child") env.PITAKO_INSTANCE_ID = "fixture-child";
  const cli = realpathSync(path.join(source, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
  const args = [cli, "--mode", "rpc", "--offline", "--no-session", "--no-extensions", "-e", installed, "-e", provider,
    ...(workerMode ? ["-e", integration] : []),
    "--provider", "bridge-fixture", "--model", "cold",
    ...(guard === "disabled" ? [] : [`--pitako-agent-bridge=${bridge}`]),
    ...(guard === "history" ? ["--pitako-agent-bridge-grants=history,route"] :
      guard === "controls" ? ["--pitako-agent-bridge-grants=control"] : [])];
  logs.push({ command: [process.execPath, ...args], cwd, node: process.version, pi: cli,
    foregroundHash: createHash("sha256").update(readFileSync(path.join(installed, "extensions/index.ts"))).digest("hex"),
    framingHashes: Object.fromEntries(["extensions/agent/framing.js", "extensions/agent/framing.d.ts",
      "extensions/agent/bridge/client.js", "extensions/agent/bridge/broker.ts",
      "extensions/herdr/agents-ui/protocol.ts"].map(file => [file,
      createHash("sha256").update(readFileSync(path.join(installed, file))).digest("hex")])),
    sourceHashes: Object.fromEntries(["extensions/agent/background.ts", "extensions/agent/observe.ts", "extensions/agent/live.ts",
      "extensions/agent/pi.ts", "extensions/agent/owner.ts", "extensions/agent/controller.ts",
      "extensions/agent/history-query.ts", "extensions/agent/history-native.ts",
      "extensions/agent/bridge/protocol.js", "extensions/agent/bridge/protocol.d.ts", "extensions/agent/bridge/client.d.ts"]
      .map(file => [file, createHash("sha256").update(readFileSync(path.join(installed, file))).digest("hex")])) });
  const rpc = child(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const records = [], replies = new Map();
  let stdout = "", stderr = "", sequence = 0, onSettled;
  rpc.process.stderr.on("data", chunk => { stderr += chunk; });
  rpc.process.stdout.on("data", chunk => {
    stdout += chunk.toString("utf8");
    let end;
    while ((end = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      try {
        const record = JSON.parse(line); records.push(record);
        if (record.type === "agent_settled") onSettled?.();
        const pending = replies.get(record.id);
        if (pending && record.type === "response") { replies.delete(record.id); pending.resolve(record); }
      } catch (error) {
        for (const pending of replies.values()) pending.reject(error);
      }
    }
  });
  rpc.process.once("close", () => {
    for (const pending of replies.values()) pending.reject(Error(`Pi exited before RPC reply: ${stderr}`));
  });
  const request = (type, extra = {}) => bounded(new Promise((resolve, reject) => {
    const id = String(++sequence);
    replies.set(id, { resolve, reject });
    rpc.process.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
  }), `RPC ${type}`);
  const waitState = predicate => {
    let observer;
    return bounded(new Promise((resolve, reject) => {
    const inspect = () => {
      try {
        const state = JSON.parse(readFileSync(path.join(root, "fixture-state.json")));
        if (predicate(state)) { observer.close(); resolve(state); }
      } catch (error) { if (error.code !== "ENOENT") { observer.close(); reject(error); } }
    };
    observer = watch(root, (_event, file) => { if (String(file) === "fixture-state.json") inspect(); });
    inspect();
    }), "fixture observation").finally(() => observer?.close());
  };
  const waitFile = file => {
    let observer;
    return bounded(new Promise(resolve => {
      const inspect = () => { if (existsSync(path.join(root, file))) resolve(); };
      observer = watch(root, (_event, name) => { if (String(name) === file) inspect(); }); inspect();
    }), file).finally(() => observer?.close());
  };
  const state = await request("get_state");
  assert.equal(state.success, true, stderr);
  assert.equal(state.data.isStreaming, false);
  assert.equal(state.data.model.provider, "bridge-fixture");
  assert.equal(state.data.model.id, "cold");
  if (guard === "disabled" || guard === "child") {
    assert.deepEqual(readdirSync(bridge), []);
    assert.equal(JSON.parse(readFileSync(calls)).calls, 0);
    rpc.process.stdin.end();
    assert.deepEqual(await bounded(rpc.closed, "guarded Pi shutdown"), { code: 0, signal: null }, stderr);
    assert.deepEqual(readdirSync(bridge), []);
    logs.push({ guard, state, providerCalls: 0, closure: "actual guarded CLI closed; bridge empty" });
    console.log(JSON.stringify({ kind: "BRIDGE_DISABLED_OK", evidence: logs }, null, 2));
  } else {
  const descriptorPath = path.join(bridge, "descriptor.json");
  assert(existsSync(descriptorPath), `No ready descriptor after cold get_state: ${stderr}`);
  // This is a separate clean native Node consumer using the normal deep import.
  const consumed = child(process.execPath, [consumer, descriptorPath, state.data.sessionId],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let consumerOut = "", consumerErr = "";
  consumed.process.stdout.on("data", chunk => { consumerOut += chunk; });
  consumed.process.stderr.on("data", chunk => { consumerErr += chunk; });
  assert.deepEqual(await bounded(consumed.closed, "consumer"), { code: 0, signal: null }, consumerErr);
  const result = JSON.parse(consumerOut);
  assert.equal(JSON.parse(readFileSync(calls)).calls, 0);
  assert(records.every(record => !Object.hasOwn(record, "clientId") && !Object.hasOwn(record, "token")));
  logs.push({ cold: { state, consumer: result, providerCalls: 0 } });
  if (guard !== "independent") {
    const typed = path.join(root, "consumer.mts"), typedConfig = path.join(root, "consumer-tsconfig.json");
    writeFileSync(typed, `
import { connect, type BridgeClient } from "pitako/extensions/agent/bridge/client.js";
const client: BridgeClient = await connect("/private/descriptor.json", { expectedSessionId: "explicit-owner" });
for (const worker of (await client.list()).items) {
  const requestModel: string | undefined = worker.sdkRequest?.model;
  const terminal: number | undefined = worker.terminalAt;
  const detail = await client.detail(worker.id);
  const brief: string = detail.workbrief.text;
  const requests = await client.requests(worker.id);
  const observed: string = requests.page.text;
  const activity = await client.activity(detail.ref);
  if (activity.state === "ready") {
    const active: boolean = activity.page.active;
    await client.activity(detail.ref, activity.next);
  }
  const result = await client.result(detail.ref);
  if (result.state === "ready") {
    const text: string = result.text.text;
    if (result.nextText) await client.result(detail.ref, result.nextText);
  }
}
const histories = await client.historyList({ limit: 1 });
const historyCursor: string | null = histories.cursor;
for (const member of histories.items) {
  const historyId: string = member.historyId;
  await client.grant("history", true);
  const raw = await client.historyRead({ historyId, workerId: member.instanceId, groupId: member.groupId });
  for (const fragment of raw.items) {
    const bytes: string = fragment.data;
    const offset: number = fragment.byteOffset;
    const source: "worker" = fragment.source;
  }
}
await client.grant("route", true);
// @ts-expect-error Acknowledgement is explicit, not inferred.
await client.grant("history");
// @ts-expect-error Control requires a complete selection.
await client.grant("control", true);
const controlDetail = await client.detail("worker");
if (controlDetail.controls.selection) {
  await client.grant("control", true, controlDetail.controls.selection);
  const receipt = await client.input(controlDetail.controls.selection, { intent: "query", text: "native text" }, 1);
  if (receipt.state === "recorded" && receipt.receipt.kind === "input") {
    const nativeStatus: "queued" | "handled" | "rejected" | "unconfirmed" = receipt.receipt.native.status;
  }
  await client.cancel(controlDetail.controls.selection, 2);
  await client.requestStatus(1);
}
await connect("/private/descriptor.json", { expectedSessionId: "explicit-owner", resume: client.lease });
// @ts-expect-error Scope is internal authority.
await client.historyList({ scope: "all" });
// @ts-expect-error Coordinator native history is not a client capability.
await client.historyRead({ historyId: "id", source: "coordinator" });
const route = await client.routeRead("worker-id");
const routingState: "captured" | "not-routed" | "unavailable" = route.state;
if (route.page.nextOffset !== null) await client.routeRead("worker-id", route.page.nextOffset);
const subscription = await client.subscribe(hint => {
  const revision: number = hint.revision;
  const gap: boolean = hint.gap;
  const refresh: true = hint.refreshRequired;
});
const initialRevision: number = subscription.snapshot.revision;
const refreshed = await subscription.refresh();
await client.list(refreshed.cursor ?? undefined, refreshed.revision);
await subscription.dispose(); await subscription.dispose();
await client.disconnect();
`);
    writeFileSync(typedConfig, JSON.stringify({ compilerOptions: { noEmit: true, strict: true,
      module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", types: [] }, files: [typed] }));
    const typeArgs = [realpathSync(path.join(source, "node_modules/typescript/bin/tsc")), "--project", typedConfig];
    const typedConsumer = child(process.execPath, typeArgs, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let typedOut = "", typedErr = "";
    typedConsumer.process.stdout.on("data", chunk => { typedOut += chunk; });
    typedConsumer.process.stderr.on("data", chunk => { typedErr += chunk; });
    const typedExit = await bounded(typedConsumer.closed, "consumer declarations");
    logs.push({ declarations: { command: [process.execPath, ...typeArgs], types: [], exit: typedExit,
      stdout: typedOut, stderr: typedErr } });
    assert.deepEqual(typedExit, { code: 0, signal: null }, typedOut + typedErr);
  }
  if (workerMode) {
    const workerConsumer = path.join(root, "worker-consumer.mjs");
    writeFileSync(workerConsumer, `
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { connect } from "pitako/extensions/agent/bridge/client.js";
const root = ${JSON.stringify(root)}, stateFile = root + "/worker-state.json";
const wait = predicate => new Promise((resolve, reject) => {
  const observer = watch(root, (_event, file) => { if (String(file) === "worker-state.json") inspect(); });
  const timer = setTimeout(() => { observer.close(); reject(Error("native child observation deadline")); }, 60000);
  function inspect() { try {
    const state = JSON.parse(readFileSync(stateFile));
    if (state.error) throw Error(state.error);
    if (predicate(state)) { observer.close(); clearTimeout(timer); resolve(state); }
  } catch (error) {
    if (error.code === "ENOENT") return;
    observer.close(); clearTimeout(timer); reject(error);
  } }
  inspect();
});
let client = await connect(process.argv[2], { expectedSessionId: process.argv[3] });
const evidence = [];
const hints = [];
let wake, latest = 0, subscription;
const subscribed = ${JSON.stringify(!["workers", "history", "controls"].includes(guard))};
if (subscribed) {
  subscription = await client.subscribe(hint => { hints.push(hint); latest = hint.revision; wake?.(); });
  assert.deepEqual(subscription.snapshot.items, []);
  assert.equal(subscription.snapshot.revision, 0);
  evidence.push({ initial: subscription.snapshot });
}
const changed = async revision => {
  if (latest > revision) return;
  let timer;
  try { await new Promise((resolve, reject) => {
    wake = resolve;
    timer = setTimeout(() => reject(Error("subscription hint deadline")), 60000);
  }); } finally { wake = undefined; clearTimeout(timer); }
};
const collect = async (first, field, next, read) => {
  let value = first, text = "";
  for (;;) { text += value[field].text; if (!value[next]) return text; value = await read(value[next]); }
};
try {
  if (${JSON.stringify(guard === "streaming")}) {
    writeFileSync(root + "/stream-subscribed", "");
    await new Promise((resolve, reject) => {
      const observer = watch(root, (_event, file) => { if (String(file) === "stream-confirmed") {
        observer.close(); clearTimeout(timer); resolve();
      } });
      const timer = setTimeout(() => { observer.close(); reject(Error("foreground streaming deadline")); }, 60000);
    });
  }
  writeFileSync(root + "/start-workers", "");
  const live = await wait(state => state.phase === "live" && state.childCalls === 2);
  if (${JSON.stringify(guard !== "controls")}) {
    writeFileSync(root + "/probe-workers", "");
    const probed = await wait(state => state.receipts?.length === 2);
    assert(probed.receipts.every(receipt => receipt.status === "handled"));
  } else {
    const worker = (await client.list()).items.find(item => item.source === "agent_spawn"), detail = await client.detail(worker.id);
    const selection = detail.controls.selection;
    assert(selection);
    const input = { intent: "query", text: "fixture-receipt-only" };
    await assert.rejects(client.input(selection, input, 1), { code: "forbidden" });
    assert.equal((await client.requestStatus(1)).state, "not_admitted");
    await client.grant("control", true, selection);
    const receipt = await client.input(selection, input, 1);
    assert.equal(receipt.state, "recorded"); assert.equal(receipt.receipt.kind, "input");
    assert.equal(receipt.receipt.native.status, "handled");
    assert.equal(receipt.receipt.native.sessionId, selection.sessionId);
    assert.equal((await wait(state => state.inputEffects === 1)).childCalls, 2);
    evidence.push({ firstNativeBridgeControl: { defaultDenied: true, receipt, inputEffects: 1, childCalls: 2 } });
    const heldInput = { intent: "steer", text: "fixture-held-receipt", decisionId: "native-loss-witness" };
    const lost = client.input(selection, heldInput, 2).catch(error => error);
    await wait(state => state.inputEffects === 2);
    const lease = client.lease;
    await client.disconnect();
    assert.equal((await lost).code, "disconnected");
    client = await connect(process.argv[2], { expectedSessionId: process.argv[3], resume: lease });
    assert.equal(client.lease.highWater, 2);
    assert.equal((await client.requestStatus(2)).state, "pending");
    assert.equal((await client.input(selection, heldInput, 2)).state, "pending");
    await assert.rejects(client.input(selection, { ...heldInput, text: "changed" }, 2), { code: "sequence_conflict" });
    await assert.rejects(client.input(selection, input, 3), { code: "forbidden" });
    writeFileSync(root + "/release-input", "");
    let recovered = await client.requestStatus(2);
    while (recovered.state === "pending") {
      await new Promise(resolve => setImmediate(resolve)); recovered = await client.requestStatus(2);
    }
    assert.equal(recovered.receipt.native.status, "handled");
    assert.deepEqual(await client.input(selection, heldInput, 2), recovered);
    assert.equal(JSON.parse(readFileSync(stateFile)).inputEffects, 2);
    await client.grant("control", true, selection);
    const cancel = await client.cancel(selection, 3);
    assert.equal(cancel.receipt.native.status, "requested");
    assert.deepEqual(await client.cancel(selection, 3), cancel);
    assert.deepEqual(await client.result(detail.ref), { state: "unavailable", reason: "outcome_missing" });
    evidence.push({ nativeRecoveryAndCancel: { recovered, inputEffects: 2, duplicateDidNotRepeat: true,
      resumedActivationDenied: true, cancel, physicalSettlementPending: true } });
    const other = (await client.list()).items.find(item => item.id !== worker.id);
    const otherSelection = (await client.detail(other.id)).controls.selection;
    await client.grant("control", true, otherSelection);
    const otherReceipt = await client.input(otherSelection, { intent: "steer", text: "fixture-receipt-only" }, 4);
    assert.equal(otherReceipt.receipt.native.status, "handled");
    await wait(state => state.inputEffects === 3);
    await client.disconnect();
    client = await connect(process.argv[2], { expectedSessionId: process.argv[3] });
  }
  const list = await client.list();
  assert.equal(list.items.length, 2);
  const refs = [];
  for (const worker of list.items) {
    const detail = await client.detail(worker.id);
    assert.equal(detail.status, "running"); assert(detail.ref.native); assert.equal(detail.controls.grant, "denied");
    assert.equal(await collect(detail, "workbrief", "nextBrief", cursor => client.detail(worker.id, cursor)), live.brief);
    const metadata = JSON.parse(await collect(detail, "metadata", "nextMetadata", cursor => client.detail(worker.id, cursor)));
    assert.equal(metadata.selected.requestedModel, "bridge-worker/controlled");
    assert.equal(metadata.activated.model, "bridge-worker/controlled");
    assert.equal(metadata.sdkRequest.model, "bridge-worker/controlled");
    const requests = await client.requests(worker.id);
    const observed = JSON.parse(await collect(requests, "page", "next", cursor => client.requests(worker.id, cursor)));
    assert.equal(observed.requests.length, 1); assert.equal(observed.requests[0].returned_service_tier, "unavailable");
    const activity = await client.activity(detail.ref);
    const cancelled = ${JSON.stringify(guard === "controls")} && detail.ref.source === "agent_spawn";
    assert.equal(activity.state, "ready"); assert.equal(activity.page.active, !cancelled);
    assert(activity.page.activity.length > 0); assert(activity.page.activity.every(item => item.source === "event-only"));
    assert(activity.page.interactions.some(receipt => receipt.status === "handled"));
    assert.deepEqual(await client.result(detail.ref), cancelled ? { state: "unavailable", reason: "outcome_missing" } :
      { state: "pending", instanceId: detail.ref.instanceId, generation: detail.ref.native.generation });
    refs.push({ ref: detail.ref, cursor: activity.next });
    evidence.push({ live: { detail, observed, activity } });
  }
  const beforeRelease = latest;
  writeFileSync(root + "/release-workers", "");
  if (subscribed) {
    let revision = beforeRelease;
    for (;;) {
      await changed(revision);
      const snapshot = await subscription.refresh();
      revision = snapshot.revision;
      const results = await Promise.all(refs.map(({ ref }) => client.result(ref)));
      evidence.push({ terminalHintRefresh: { snapshot, results, latest } });
      if (results.every(result => result.state === "ready")) break;
    }
    assert(hints.length > 0);
    assert(hints.every(hint => hint.refreshRequired && hint.owner.epoch === client.owner.epoch));
  }
  const terminal = await wait(state => state.phase === "terminal");
  assert.equal(terminal.disposed.length, 2);
  assert(terminal.before.rows.every(row => row.outcome && !row.live && !row.resultTaken));
  assert(terminal.before.history.every(item => !item.registered && item.bytes));
  assert.deepEqual(terminal.before.roles, [], "normal Team settlement releases occupancy independently of reads");
  if (${JSON.stringify(guard === "history")}) {
    const metadata = await client.historyList();
    assert.equal(metadata.items.length, 2);
    const first = metadata.items[0];
    await assert.rejects(client.historyRead({ historyId: first.historyId }), { code: "forbidden" });
    await assert.rejects(client.routeRead(first.instanceId), { code: "forbidden" });
    await client.grant("history", true);
    const page = await client.historyRead({ historyId: first.historyId, workerId: first.instanceId });
    assert(page.items.length > 0);
    assert(page.diagnostics.some(item => item.code === "native_physical_order"));
    evidence.push({ firstSensitiveNativeWitness: { metadata, deniedBeforeAcknowledgement: true, page } });
    const listed = await client.historyList({ limit: 1 });
    assert.equal(listed.items.length, 1); assert(listed.cursor);
    const listedNext = await client.historyList({ cursor: listed.cursor, limit: 1 });
    assert.deepEqual([...listed.items, ...listedNext.items], metadata.items);
    for (const member of metadata.items) {
      assert.equal(member.coordinatorSessionId, client.owner.coordinatorSessionId);
      assert.equal(member.native.path, undefined);
      assert.equal(member.coordinatorSessionFile, undefined);
      const chunks = [], pages = [];
      let cursor, offset = 0;
      do {
        const raw = await client.historyRead({ historyId: member.historyId, groupId: member.groupId,
          workerId: member.instanceId, cursor, limit: 200 });
        assert(raw.items.length > 0);
        for (const item of raw.items) {
          assert.equal(item.byteOffset, offset);
          const bytes = Buffer.from(item.data, "base64"); chunks.push(bytes); offset += bytes.length;
        }
        pages.push({ items: raw.items.length, cursor: raw.cursor, diagnostics: raw.diagnostics });
        cursor = raw.cursor ?? undefined;
      } while (cursor);
      const hash = createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
      assert.equal(hash, terminal.before.history.find(item => item.id === member.native.sessionId).bytes);
      assert(Buffer.concat(chunks).toString("utf8").includes("terminal"));
      const scoped = await client.historyList({ workerId: member.instanceId });
      assert.deepEqual(scoped.items, [member]);
      const wrongWorker = metadata.items.find(item => item.instanceId !== member.instanceId);
      const denied = await client.historyRead({ historyId: member.historyId, workerId: wrongWorker.instanceId });
      assert.deepEqual(denied.diagnostics, [{ code: "history_outside_scope" }]);
      evidence.push({ exactNativeHistory: { member, pages, bytes: offset, hash, wrongWorker: denied } });
    }
    await client.grant("route", true);
    const routes = await Promise.all(metadata.items.map(member => client.routeRead(member.instanceId)));
    assert(routes.every(route => route.page.text === "null"));
    assert.deepEqual(new Set(routes.map(route => route.state)), new Set(["unavailable", "not-routed"]));
    evidence.push({ truthfulNativeRoutes: routes, routingInvocationObserved: false });
    await client.disconnect();
    client = await connect(process.argv[2], { expectedSessionId: process.argv[3] });
    await client.historyList();
    await assert.rejects(client.historyRead({ historyId: first.historyId }), { code: "forbidden" });
    await assert.rejects(client.routeRead(first.instanceId), { code: "forbidden" });
    await client.grant("history", true); await client.grant("route", true);
    assert((await client.historyRead({ historyId: first.historyId })).items.length > 0);
    assert.equal((await client.routeRead(first.instanceId)).page.text, "null");
    evidence.push({ nativeReconnect: { freshAcknowledgementsRequired: true, independentlyAcknowledgedSuccess: true } });
  }
  for (const { ref, cursor } of refs) {
    const after = await client.activity(ref, cursor);
    assert.equal(after.state, "ready"); assert.equal(after.page.active, false);
    assert(after.page.interactions.some(receipt => receipt.status === "handled"));
    const result = await client.result(ref);
    assert.equal(result.state, "ready");
    assert.equal(result.status, ${JSON.stringify(guard === "controls")} && ref.source === "agent_spawn" ? "cancelled" : "completed");
    assert.equal(await collect(result, "text", "nextText", cursor => client.result(ref, cursor)),
      ${JSON.stringify(guard === "controls")} && ref.source === "agent_spawn" ? "cancelled" : terminal.result);
    const metadata = JSON.parse(await collect(result, "metadata", "nextMetadata", cursor => client.result(ref, cursor)));
    assert.equal(metadata.status, result.status);
    assert.deepEqual(await client.result(ref), result);
    assert.deepEqual(await client.activity(ref, cursor), after);
    evidence.push({ terminal: { ref, activity: after, result, metadata } });
  }
  writeFileSync(root + "/compare-workers", "");
  const compared = await wait(state => state.phase === "compared");
  assert.deepEqual(compared.before, compared.after, "bridge reads must not consume, deliver completion, change Team assignment or native history");
  assert(compared.consumed.snapshot.rows.every(row => row.resultTaken), "normal result readers still consume");
  assert.notEqual(compared.consumed.snapshot.workflow, compared.before.workflow, "normal Team workflow completion still writes");
  if (subscription) {
    const page = await subscription.refresh();
    evidence.push({ finalRevision: page.revision, hints });
    await subscription.dispose(); await subscription.dispose();
    assert.equal(subscription.active, false);
  }
  console.log(JSON.stringify({ evidence, comparison: compared, childCalls: compared.childCalls, subscribed }));
} finally { await subscription?.dispose(); await client.disconnect(); }
`);
    const native = child(process.execPath, [workerConsumer, descriptorPath, state.data.sessionId],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let nativeOut = "", nativeErr = "";
    native.process.stdout.on("data", chunk => { nativeOut += chunk; });
    native.process.stderr.on("data", chunk => { nativeErr += chunk; });
    let foregroundSettled;
    if (guard === "streaming") {
      await waitFile("stream-subscribed");
      foregroundSettled = new Promise(resolve => { onSettled = resolve; });
      assert.equal((await request("prompt", { message: "intentional controlled offline foreground" })).success, true);
      await waitState(value => value.phase === "streaming");
      const streaming = await request("get_state");
      assert.equal(streaming.data.isStreaming, true);
      assert.equal(JSON.parse(readFileSync(calls)).calls, 1);
      logs.push({ intentionalForegroundStreamingBeforeAdmission: streaming, foregroundCalls: 1, bridgeInducedCalls: 0 });
      writeFileSync(path.join(root, "stream-confirmed"), "");
    }
    const nativeExit = await bounded(native.closed, "assembled native worker consumer");
    logs.push({ nativeWorkers: { command: [process.execPath, workerConsumer, descriptorPath, state.data.sessionId],
      exit: nativeExit, stderr: nativeErr, output: nativeOut } });
    assert.deepEqual(nativeExit, { code: 0, signal: null }, nativeErr);
    if (guard === "streaming") {
      const held = await request("get_state");
      assert.equal(held.data.isStreaming, true);
      logs.push({ intentionalForegroundStreamingAfterTerminalReads: held, foregroundCalls: 1, bridgeInducedCalls: 0 });
      writeFileSync(path.join(root, "release-stream"), "");
      await bounded(foregroundSettled, "intentional foreground settlement"); onSettled = undefined;
    }
    const idle = await request("get_state");
    assert.equal(idle.data.isStreaming, false);
    logs.push({ idleAfterSubscription: idle });
    rpc.process.stdin.end();
    assert.deepEqual(await bounded(rpc.closed, "worker Pi shutdown"), { code: 0, signal: null }, stderr);
    assert.deepEqual(readdirSync(bridge), []);
    const expectedCalls = guard === "streaming" ? 1 : 0;
    assert.equal(JSON.parse(readFileSync(calls)).calls, expectedCalls);
    logs.push({ providerCalls: expectedCalls, intentionalForegroundCalls: expectedCalls, bridgeInducedCalls: 0,
      stdoutRecords: records, stderr,
      closure: "both production children disposed/unregistered and outcomes settled; native consumer and CLI closed; bridge empty" });
    console.log(JSON.stringify({ kind: "BRIDGE_WORKERS_OK", evidence: logs }, null, 2));
  } else if (guard === "independent") {
    const { connect } = await import(path.join(installed, "extensions/agent/bridge/client.js"));
    await assert.rejects(connect(descriptorPath, { expectedSessionId: process.argv[3] }));
    rpc.process.stdin.end();
    assert.deepEqual(await bounded(rpc.closed, "independent Pi shutdown"), { code: 0, signal: null }, stderr);
    assert.deepEqual(readdirSync(bridge), []);
    logs.push({ foreignExpectedSessionRejected: process.argv[3],
      closure: "independent foreground and consumer closed; bridge empty" });
    console.log(JSON.stringify({ kind: "BRIDGE_INDEPENDENT_OK", evidence: logs }, null, 2));
  } else {
  const second = child(process.execPath, [fileURLToPath(import.meta.url), "independent", state.data.sessionId],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let secondOut = "", secondErr = "";
  second.process.stdout.on("data", chunk => { secondOut += chunk; });
  second.process.stderr.on("data", chunk => { secondErr += chunk; });
  assert.deepEqual(await bounded(second.closed, "independent foreground"), { code: 0, signal: null }, secondOut + secondErr);
  const secondEvidence = JSON.parse(secondOut);
  assert.equal(secondEvidence.kind, "BRIDGE_INDEPENDENT_OK");
  assert.notEqual(secondEvidence.evidence[1].cold.consumer.owner.coordinatorSessionId, state.data.sessionId);
  logs.push({ simultaneousIsolatedForeground: secondEvidence });
  const { connect } = await import(path.join(installed, "extensions/agent/bridge/client.js"));
  const old = await connect(descriptorPath, { expectedSessionId: state.data.sessionId });
  assert.equal((await request("prompt", { message: "/fixture-hold" })).success, true);
  await waitState(value => value.phase === "held");
  let transitionFinished = false;
  const replacement = request("new_session").then(value => { transitionFinished = true; return value; });
  void replacement.catch(() => {});
  await waitState(value => value.phase === "retirement-held");
  assert.equal(transitionFinished, false);
  await assert.rejects(old.list());
  await assert.rejects(connect(descriptorPath, { expectedSessionId: state.data.sessionId }));
  writeFileSync(path.join(root, "release"), "");
  assert.equal((await replacement).success, true);
  await old.disconnect();
  const replacedState = await request("get_state");
  assert.notEqual(replacedState.data.sessionId, state.data.sessionId);
  await assert.rejects(connect(descriptorPath, { expectedSessionId: state.data.sessionId }));
  const fresh = await connect(descriptorPath, { expectedSessionId: replacedState.data.sessionId });
  assert.notEqual(fresh.owner.epoch, result.owner.epoch);
  assert.deepEqual((await fresh.list()).items, []);
  logs.push({ replacement: { heldBeforeCleanup: true, oldReadAndConnectRejected: true,
    explicitFreshOwner: fresh.owner, reply: replacedState } });

  // EOF shutdown uses the same packaged first-await boundary.
  rmSync(path.join(root, "release"));
  assert.equal((await request("prompt", { message: "/fixture-hold" })).success, true);
  await waitState(value => value.phase === "held");
  rpc.process.stdin.end();
  await waitState(value => value.phase === "retirement-held");
  assert(processes.has(rpc.process), "native shutdown must still be held");
  await assert.rejects(fresh.list());
  await assert.rejects(connect(descriptorPath, { expectedSessionId: replacedState.data.sessionId }));
  writeFileSync(path.join(root, "release"), "");
  await fresh.disconnect();
  logs.push({ shutdown: { heldBeforeCleanup: true, oldReadAndConnectRejected: true } });
  assert.deepEqual(await bounded(rpc.closed, "Pi shutdown"), { code: 0, signal: null }, stderr);
  assert.deepEqual(readdirSync(bridge), []);
  assert.equal(JSON.parse(readFileSync(calls)).calls, 0);
  logs.push({ providerCalls: 0, stdoutRecords: records, stderr,
    closure: "native consumer closed; RPC EOF shutdown exited 0; host bridge directory retained and empty" });
  console.log(JSON.stringify({ kind: "BRIDGE_COLD_OK", evidence: logs }, null, 2));
  }
  }
} catch (error) {
  retained = true;
  console.error(`Bridge fixture failure; diagnostic root retained: ${root}`);
  console.error(JSON.stringify(logs, null, 2));
  throw error;
} finally {
  // Never delete owned roots until every child has actually closed.
  for (const process of processes) process.kill("SIGTERM");
  await Promise.all([...processes].map(process => new Promise(resolve => process.once("close", resolve))));
  if (!retained) rmSync(root, { recursive: true, force: true });
}
