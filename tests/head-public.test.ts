import { expect, spyOn, test } from "bun:test";
import { preparedTool } from "./fixtures/background-dispatch.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { createCodingTools, type AgentBeforeSettleEventResult, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import agentExtension from "../extensions/agent/index.ts";
import { bindBackgroundOwner, clearBackgroundOwner, deliverWorkerResults, setBackgroundExecutor, workerResult, teamWorkerResult } from "../extensions/agent/background.ts";
import { beginTeamEvaluation, recordPlanTeamWork, retireTeamEvaluation, firstTeamReservation } from "../extensions/team.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import { controlledPi, controlledModel } from "./fixtures/pi-factories.ts";
import { adoptCheckpoint, listCheckpoints, readCheckpoint, type CheckpointOrigin } from "../extensions/agent/checkpoints.ts";
import { consultationStats, queryHistory } from "../extensions/agent/history-query.ts";
import { WorkerHistory } from "../extensions/agent/history.ts";
import { openBoard } from "../extensions/board/store.ts";
import { currentWorkspace } from "../extensions/board/workspace.ts";
import { openExecutionPlan, planFile, readLedgerTeamHolds } from "../extensions/workflow.ts";
import { principalLeases, reserveOperation } from "../extensions/agent/head/operation-leases.ts";
import { AgentClosureError } from "../extensions/agent/closure.ts";
import { classifyProviderFailure } from "../extensions/agent/fallback.ts";

// Always-on, synchronous stderr markers survive a blocked event loop. Keep the
// Git observer test-local and installed until owned callbacks/cleanup settle.
let activeCase = "", traceSequence = 0;
function startTrace(operation: string, details: object = {}) {
  const id = ++traceSequence, started = performance.now(), label = activeCase;
  const emit = (phase: string) => writeSync(2, `[head-public] ${JSON.stringify({
    pid: process.pid, case: label, id, operation, ...details, phase,
    at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
  })}\n`);
  emit("START");
  return emit;
}
async function traced<T>(operation: string, details: object, body: () => T | Promise<T>): Promise<T> {
  const finish = startTrace(operation, details);
  try {
    const result = await body();
    finish("END");
    return result;
  } catch (error) {
    finish("ERROR");
    throw error;
  }
}
const ownership = agentFixtureOwnership();
const fixture = { ...ownership, ownedCase(name: string, body: () => void | Promise<void>) {
  return async () => {
    activeCase = name;
    const original = childProcess.execFileSync;
    const capture = spyOn(childProcess, "execFileSync").mockImplementation(new Proxy(original, {
      apply(target, thisArg, args) {
        const finish = startTrace("execFileSync", { file: args[0], args: args[1],
          cwd: args[2]?.cwd });
        try {
          const result = Reflect.apply(target, thisArg, args);
          finish("END");
          return result;
        } catch (error) {
          finish("ERROR");
          throw error;
        }
      },
    }));
    try {
      await traced("case", {}, ownership.ownedCase(name, () => traced("body", {}, body)));
    } finally {
      ownership.requireReleasedFixture();
      capture.mockRestore();
      activeCase = "";
    }
  };
} };
const gate = () => Promise.withResolvers<void>();
const node = (id: string, writes = [id], deps: string[] = []) => ({
  id, brief: `Implement ${id}`, writes, deps, capacity: { route: "direct", profile: "developer_mid" },
});
type Local = { tools: Map<string, any>; events: Map<string, Function[]> };
async function bind(factories: ExtensionFactory[], appendEntry: ExtensionAPI["appendEntry"]): Promise<Local> {
  const tools = new Map<string, any>(), events = new Map<string, Function[]>();
  const pi = { registerTool(tool: any) { tools.set(tool.name, tool); }, appendEntry,
    on(name: string, callback: Function) { events.set(name, [...(events.get(name) ?? []), callback]); } } as unknown as ExtensionAPI;
  for (const factory of factories) await factory(pi);
  return { tools, events };
}

async function harness(options: { separateAgentDir?: boolean; headPolicy?: boolean; final?: "stop" | "error" | "aborted"; missingCost?: boolean; gitRepository?: boolean; headFallback?: boolean; ordinarySdk?: boolean;
  workerCreate?: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> };
  afterText?: (session: any, local: Local) => Promise<void>;
  root?: string; seed?: (root: string) => void | Promise<void>; cutReceipt?: boolean; finalError?: string; objectFormat?: "sha256" } = {}) {
  const root = options.root ?? mkdtempSync(path.join(tmpdir(), "pitako-head-public-"));
  if (!options.root) fixture.directories.push(root);
  if (options.gitRepository && !options.root) {
    execFileSync("git", ["init", "--quiet", ...(options.objectFormat ? [`--object-format=${options.objectFormat}`] : []), root]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "--allow-empty", "-m", "admission"]);
  }
  const agentDir = options.separateAgentDir ? mkdtempSync(path.join(tmpdir(), "pitako-head-agent-")) : root;
  if (agentDir !== root) fixture.directories.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await options.seed?.(root);
  const configFile = path.join(agentDir, "pitako/config.toml");
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(configFile, `
[model_policies.developer.primary]
model = "fixture/selected"
reasoning = "off"
[model_policies.researcher.primary]
model = "fixture/selected"
[model_policies.developer_mid.primary]
model = "fixture/selected"
${options.headPolicy === false ? "" : '[model_policies.developer_head.primary]\nmodel = "fixture/selected"\nreasoning = "off"'}
${options.headFallback ? '[[model_policies.developer_head.fallbacks]]\nmodel = "fixture/selected"\nreasoning = "high"' : ""}
[head_developer]
max_parallel = 3
[developer_routing]
classifier_provider = "fixture"
classifier_model = "classifier"
`);
  const headEntered = gate(), headDone = gate(), headAborted = gate();
  const leaves = new Map<string, { entered: ReturnType<typeof gate>; done: ReturnType<typeof gate>;
    disposing: ReturnType<typeof gate>; dispose: ReturnType<typeof gate>; local?: Local; session?: any; task?: string }>();
  const leaf = (id: string) => {
    if (!leaves.has(id)) leaves.set(id, { entered: gate(), done: gate(), disposing: gate(), dispose: gate() });
    return leaves.get(id)!;
  };
  let headLocal!: Local, headSession: any;
  const locals = new Map<object, Local>();
  let classifications = 0;
  const modelRegistry = { find: (provider: string, id: string) => provider === "fixture" && id === "selected" ? controlledModel() : undefined, getAvailableOfType: async () => [{ provider: "fixture", id: "classifier", contextWindow: 100000 }],
    classify: async () => { classifications++; return { stopReason: "stop", answers: { capacity: {
      type: "choice", choice: "developer_mid", probabilities: { developer_mid: 0.9, developer_senior: 0.1, developer_junior: 0, indeterminate: 0 },
    } } }; } };
  const publicSessionId = `owner-${path.basename(root)}`;
  const ctx = { cwd: root, sessionManager: { getSessionId: () => publicSessionId }, modelRegistry } as unknown as ExtensionContext;
  const ownerToken = Symbol(publicSessionId);
  const evaluation = beginTeamEvaluation(publicSessionId, false, ownerToken)!;
  const delivery: any[] = [];
  bindBackgroundOwner({ token: ownerToken, sessionId: publicSessionId, isIdle: () => false,
    hasUI: false, notify() {}, sendMessage() {}, appendResult(message) { delivery.push({ type: "custom_message", ...message }); },
    getBranch: () => delivery });
  const headCtx = () => ({ ...ctx, sessionManager: headSession.sessionManager }) as ExtensionContext;
  const host = controlledPi(root, {
    bind: async session => {
      headSession = session;
      if (options.missingCost) Object.assign(session.stats, { cost: undefined });
      headLocal = await bind(host.loaderInputs[host.sessions.indexOf(session)].extensionFactories,
        (type, data) => {
          if (options.cutReceipt && type === "pitako.head.checkpoint") throw new Error("controlled cut after ref before receipt");
          session.sessionManager.appendCustomEntry(type, data);
        });
      for (const tool of createCodingTools(root)) headLocal.tools.set(tool.name, tool);
      // Model the SDK's custom-definition precedence over builtins/loaded extension tools.
      for (const tool of host.sessionInputs.at(-1).customTools ?? []) headLocal.tools.set(tool.name, tool);
      session.getAllTools = () => [...headLocal.tools.keys(), "agent_spawn", "team_assign"].map(name => ({ name }));
    },
    prompt: async session => {
      (session as any).steer = async () => "queued";
      for (const hook of headLocal.events.get("turn_start") ?? []) await hook({});
      headEntered.resolve();
      await headDone.promise;
      Object.assign(session.stats, {
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: options.missingCost ? undefined : 0.01, assistantMessages: 1,
      });
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "unexamined final" }],
        stopReason: options.final ?? "stop", errorMessage: options.final === "error" ? options.finalError ?? "controlled failure" : undefined };
      session.messages.push(message);
      session.sessionManager.appendMessage(message as never);
      await options.afterText?.(session, headLocal).catch(error => { console.error(error); throw error; });
    },
    abort: () => { headAborted.resolve(); headDone.resolve(); },
  });
  const workers = controlledPi(root, {
    bind: async session => {
      const local = await bind(workers.loaderInputs[workers.sessions.indexOf(session)].extensionFactories,
        (type, data) => { session.sessionManager.appendCustomEntry(type, data); });
      for (const tool of workers.sessionInputs.at(-1).customTools ?? []) local.tools.set(tool.name, tool);
      locals.set(session, local);
      (session as any).steer = async () => "queued";
      session.getAllTools = () => ["read", "bash", "agent_spawn", "team_assign", ...local.tools.keys()].map(name => ({ name }));
    },
    prompt: async (session, task) => {
      const id = task.startsWith("{") ? JSON.parse(task).brief.split(" ").at(-1) : task;
      const state = leaf(id);
      state.session = session; state.local = locals.get(session); state.task = task;
      for (const hook of state.local!.events.get("turn_start") ?? []) await hook({});
      state.entered.resolve();
      await state.done.promise;
      Object.assign(session.stats, { tokens: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3 },
        cost: 0.002, assistantMessages: 1 });
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text: `closed ${id}` }], stopReason: "stop" as const };
      session.messages.push(message); session.sessionManager.appendMessage(message as never);
      session.emit({ type: "message_end", message });
    },
    abort: session => { [...leaves.values()].find(leaf => leaf.session === session)?.done.resolve(); },
    dispose: async session => {
      const state = [...leaves.values()].find(leaf => leaf.session === session);
      if (state) { state.disposing.resolve(); await state.dispose.promise; }
    },
  });
  if (options.workerCreate) {
    const create = workers.factories.createSession!;
    workers.factories.createSession = async input => { options.workerCreate!.entered.resolve(); await options.workerCreate!.release.promise; return create(input); };
    fixture.finishOnCleanup(() => options.workerCreate!.release.resolve());
  }
  const hostExecutor = createPiExecutor({ factories: host.factories }), leafExecutor = createPiExecutor({ factories: workers.factories });
  let starts = 0, leafStarts = 0;
  setBackgroundExecutor({ capturesHistory: true, start(input) {
    starts++;
    if (input.scope) leafStarts++;
    return input.head || options.ordinarySdk ? hostExecutor.start(input) : input.scope || input.consultant ? leafExecutor.start(input)
      : Promise.resolve({ status: "completed", result: "ordinary", sideEffects: false });
  } });
  fixture.finishOnCleanup(() => {
    headDone.resolve();
    for (const state of leaves.values()) { state.done.resolve(); state.dispose.resolve(); }
  });
  fixture.beforeRelease(async () => {
    await retireTeamEvaluation(evaluation);
    await fixture.settleRuns();
    clearBackgroundOwner(); setBackgroundExecutor(undefined);
  });
  const publicLocal = await bind([agentExtension], () => {});
  const callPublic = (tool: string, params: unknown) => traced(`public ${tool}`, { root },
    () => preparedTool(publicLocal.tools.get(tool)).execute(`public-${tool}`, params, undefined, undefined, ctx));
  let localCalls = 0;
  const call = (name: string, params: unknown, onUpdate?: (update: unknown) => unknown) => traced(`head ${name}`,
    { root, input: JSON.stringify(params)?.slice(0, 300) }, async () => {
    const id = `${name}-${++localCalls}`;
    for (const hook of headLocal.events.get("tool_call") ?? []) {
      const result = await hook({ toolName: name, toolCallId: id, input: params }, headCtx());
      if (result?.block) throw Error(result.reason);
    }
    headSession.emit({ type: "tool_execution_start", toolName: name, toolCallId: id });
    try {
      const result = await headLocal.tools.get(name).execute(id, params, undefined, onUpdate, headCtx());
      headSession.sessionManager.appendMessage({ role: "toolResult", toolName: name, toolCallId: id,
        content: result.content, details: result.details, isError: result.isError === true, timestamp: Date.now() });
      return result.details;
    } catch (error) {
      headSession.sessionManager.appendMessage({ role: "toolResult", toolName: name, toolCallId: id,
        content: [{ type: "text", text: String(error) }], isError: true, timestamp: Date.now() });
      throw error;
    } finally { headSession.emit({ type: "tool_execution_end", toolName: name, toolCallId: id }); }
  });
  const callLeaf = (nodeId: string, name: string, params: unknown) => traced(`leaf ${name}`,
    { root, nodeId, input: JSON.stringify(params)?.slice(0, 300) }, async () => {
    const state = leaf(nodeId), id = `leaf-${nodeId}-${name}-${++localCalls}`;
    const result = await state.local!.tools.get(name).execute(id, params, undefined, undefined,
      { ...ctx, sessionManager: state.session.sessionManager });
    state.session.sessionManager.appendMessage({ role: "toolResult", toolName: name, toolCallId: id,
      content: result.content, details: result.details, isError: result.isError === true, timestamp: Date.now() });
    return result;
  });
  const read = () => call("head_plan", { action: "read" });
  const closed = async (runId: string) => {
    let after = 0;
    for (;;) {
      const result = await call("head_result", { childId: runId });
      if (result.phase === "closed") return result;
      const event = await call("head_wait", { after });
      after = event.cursor;
    }
  };
  const settle = () => traced("settle", { root }, async () => { headDone.resolve(); await fixture.settleRuns(); });
  return { root, evaluation, ctx, leaf, host, workers, headEntered, headAborted, callPublic, call, callLeaf, read, closed, settle,
    headDone, delivery, deliver: () => deliverWorkerResults(ownerToken, true), publicTools: publicLocal.tools, headLocal: () => headLocal, headSession: () => headSession,
    counts: () => ({ starts, leafStarts, classifications }),
    outcome: (id: string, team = false) => team ? teamWorkerResult(evaluation.token, id) : workerResult(id) };
}

test("Head consultation composes native receipt, live Developer control, checkpoint and finish", fixture.ownedCase("composed consultation route", async () => {
  const h = await harness({ gitRepository: true });
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["shared"], task: "consult with Developer active" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "edit", expectedRevision: 0,
    nodes: [node("a", ["shared"])], supersede: [] });
  const [a] = await h.call("head_start", { expectedRevision: 1, nodeIds: ["a"] });
  await h.leaf("a").entered.promise;
  const handle = await h.call("head_consult", { role: "researcher", task: "advice", reasoning: { mode: "direct", level: "low" } });
  expect(handle.state).toBe("preparing");
  // No turn_end or before_settle releases preparation; wait in this same turn progresses.
  let after = (await h.read()).cursor;
  while (!h.leaf("advice").session) {
    const event = await h.call("head_wait", { after });
    after = event.cursor;
    const state = await h.call("head_result", { childId: handle.childId });
    if (state.phase === "closed") throw new Error(JSON.stringify(state.envelope));
  }
  await h.leaf("advice").entered.promise;
  const advice = h.leaf("advice");
  await expect(checkpoint(h, ["shared"], 1)).rejects.toThrow();
  await expect(h.call("head_plan", { action: "beginIntegration", expectedRevision: 1 })).rejects.toThrow();
  await expect(h.call("head_finish", { status: "completed", epoch: "not-integrated", summary: "early", verification: ["fake"], limits: [] })).rejects.toThrow();
  expect(advice.session.active).not.toContain("head_consult");
  expect(advice.local!.tools.has("head_scope_ack")).toBe(false);
  expect(advice.local!.tools.has("head_checkpoint")).toBe(false);
  await expect(h.callLeaf("advice", "write", { path: "shared", content: "bad" })).rejects.toThrow();
  await h.callLeaf("advice", "bash", { command: "test ! -f shared" });
  const nativeId = advice.session.sessionId;
  advice.session.sessionId = "wrong-native";
  try { await expect(h.callLeaf("advice", "bash", { command: "true" })).rejects.toThrow("native identity changed"); }
  finally { advice.session.sessionId = nativeId; }
  const active = await h.call("head_result", { childId: a.runId });
  const identity = { runId: a.runId, effectiveRevision: 1, ...active.native };
  expect((await h.call("head_observe", identity)).activity.active).toBe(true);
  expect(await h.call("head_input", { ...identity, intent: "query", text: "continue independently" })).toBeDefined();
  await h.callLeaf("a", "write", { path: "shared", content: "Developer change\n" });
  advice.done.resolve(); advice.dispose.resolve();
  const closedAdvice = await h.closed(handle.childId);
  expect(closedAdvice.envelope).toMatchObject({ purpose: "consultation", dispatchId: handle.dispatchId, outcome: "completed" });
  expect(closedAdvice.envelope).not.toHaveProperty("nodeId");
  await expect(h.call("head_review", { runId: handle.childId, effectiveRevision: 1, judgment: "satisfied", evidence: ["advice"], reason: "not a node" })).rejects.toThrow();
  h.leaf("a").done.resolve(); h.leaf("a").dispose.resolve(); await h.closed(a.runId);
  await expect(h.call("head_plan", { action: "beginIntegration", expectedRevision: 1 })).rejects.toThrow();
  const event = { outcome: "completed", context: { canContinue: true } };
  let offered: AgentBeforeSettleEventResult | undefined;
  for (const hook of h.headLocal().events.get("agent_before_settle") ?? []) offered = await hook(event) ?? offered;
  expect(offered?.entries?.filter(entry => entry.type === "custom_message" && entry.customType === "pitako.head.result")).toHaveLength(2);
  // Native SDK commit, not a substituted receipt consumer.
  for (const entry of offered!.entries!) {
    if (entry.type === "custom_message") h.headSession().sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  }
  expect((await h.call("head_result", { childId: handle.childId })).received).toBe(true);
  await h.call("head_review", { runId: a.runId, effectiveRevision: 1, judgment: "satisfied", evidence: ["native Developer result and managed diff"], reason: "inspected" });
  const barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: 1 });
  await expect(h.call("head_consult", { role: "oracle", task: "after barrier" })).rejects.toThrow("integration");
  const saved = await checkpoint(h, ["shared"], 1);
  expect(saved.status).toBe("committed");
  const consultationSources = saved.manifest.contributors.filter((entry: any) => entry.contribution.source.kind === "consultation");
  expect(consultationSources.length).toBeGreaterThan(0);
  for (const entry of consultationSources) {
    expect(entry.contribution.source).toMatchObject({ dispatchId: handle.dispatchId, observedRevision: 1 });
    expect(entry.contribution.source).not.toHaveProperty("effectiveRevision");
    expect(entry.contribution.source).not.toHaveProperty("runId");
    expect(entry.contribution.changes).toEqual([]);
  }
  expect(saved.manifest.native).toContainEqual(expect.objectContaining({ source: expect.objectContaining({ kind: "consultation", dispatchId: handle.dispatchId }) }));
  await h.call("bash", { command: "test -f shared" });
  h.headSession().sessionManager.appendMessage({ role: "toolResult", toolName: "consultation_feedback", toolCallId: "reserved-feedback",
    content: [{ type: "text", text: "advice is not verification" }], isError: false, timestamp: Date.now() });
  const candidates = (await h.read()).verificationCandidates;
  expect(candidates.some((entry: any) => entry.toolName === "consultation_feedback")).toBe(false);
  expect(candidates.every((entry: any) => entry.toolName !== "head_consult")).toBe(true);
  await h.call("head_finish", { status: "completed", epoch: barrier.epoch, summary: "Integrated Developer change", verification: candidates.map((entry: any) => entry.entryId), limits: ["Controlled PiFactories boundary"] });
  await h.settle();
  expect(h.outcome(admission.details.instanceId).head?.metrics).toMatchObject({ aggregateUsage: undefined, usageComplete: false, consultations: [expect.objectContaining({ dispatchId: handle.dispatchId, usage: expect.objectContaining({ input: 2, output: 1, cost: 0.002 }) })], observedPeakParallelism: 2 });
  expect(h.delivery).toHaveLength(0);
  h.deliver();
  expect(h.delivery).toHaveLength(1); // only the integrated Head handoff reaches the foreground
  const historical = readCheckpoint(h.root, saved.origin);
  expect(historical.historicalEvidence.closureGaps).toEqual([]);
  expect(adoptCheckpoint(h.root, saved.origin, [path.join(h.root, "shared")]).checkpointId).toBe(saved.origin.checkpointId);
  // Reconstruct from disk, not the live dispatch/Head object.
  const stats = await consultationStats(h.ctx.sessionManager.getSessionId(), handle.dispatchId, h.root);
  expect(stats.rows).toContainEqual(expect.objectContaining({ dispatchId: handle.dispatchId, evidence: "physically-persisted" }));
  expect(stats.rows).toContainEqual(expect.objectContaining({ dispatchId: handle.dispatchId, events: expect.arrayContaining([expect.objectContaining({ event: "decision", data: expect.objectContaining({ decisionId: handle.decisionId }) })]) }));
  const catalog = new WorkerHistory(h.root).list().flatMap(group => group.consultations ?? []);
  expect(catalog.find(row => row.dispatchId === handle.dispatchId)).toMatchObject({
    callerSessionId: h.headSession().sessionId, coordinatorSessionId: h.ctx.sessionManager.getSessionId() });
}));

test("Head shares capacity atomically and no-worker receipt releases without result getters", fixture.ownedCase("consultation capacity", async () => {
  const h = await harness();
  await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: [], task: "capacity" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "edit", expectedRevision: 0, nodes: [node("a", []), node("b", []), node("c", [])], supersede: [] });
  const handles = await Promise.all(["one", "two"].map(task => h.call("head_consult", { role: "oracle", task })));
  // Reservations precede preparation; even if preflight fails they need native receipts.
  await expect(h.call("head_start", { expectedRevision: 1, nodeIds: ["a", "b"] })).rejects.toThrow("parallel limit");
  expect((await h.read()).runs).toHaveLength(0);
  const third = await h.call("head_consult", { role: "oracle", task: "three" });
  await expect(h.call("head_consult", { role: "researcher", task: "full" })).rejects.toThrow("parallel limit");
  const event = { outcome: "completed", context: { canContinue: false } };
  const received: string[] = [];
  // Boundaries await progressing preflight, offer ready outcomes before correction, and never request unavailable continuation.
  while (received.length < 3) {
    let offered: AgentBeforeSettleEventResult | undefined;
    for (const hook of h.headLocal().events.get("agent_before_settle") ?? []) offered = await hook(event) ?? offered;
    expect(offered?.continue).not.toBe(true);
    const entries = offered!.entries!.filter(entry => entry.type === "custom_message" && entry.customType === "pitako.head.result");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) if (entry.type === "custom_message") {
      const envelope = JSON.parse(entry.content as string);
      expect(envelope).toMatchObject({ purpose: "consultation", outcome: "no-worker" });
      expect(envelope).not.toHaveProperty("instanceId");
      expect(envelope).not.toHaveProperty("result");
      expect(received).not.toContain(envelope.childId);
      received.push(envelope.childId);
      h.headSession().sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    }
  }
  // Admission observes branch receipts directly, with no head_result/read in between.
  const runs = await h.call("head_start", { expectedRevision: 1, nodeIds: ["a", "b", "c"] });
  expect(runs).toHaveLength(3);
  await expect(h.call("head_consult", { role: "researcher", task: "Developers full" })).rejects.toThrow("parallel limit");
  for (const id of ["a", "b", "c"]) { await h.leaf(id).entered.promise; h.leaf(id).done.resolve(); h.leaf(id).dispose.resolve(); }
  for (const run of runs) await h.closed(run.runId);
  for (const run of runs) await h.call("head_review", { runId: run.runId, effectiveRevision: 1, judgment: "satisfied", evidence: ["native result"], reason: "inspected" });
  const barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: 1 });
  await h.call("bash", { command: "true" });
  const verification = (await h.read()).verificationCandidates.map((entry: any) => entry.entryId);
  await h.call("head_finish", { status: "completed", epoch: barrier.epoch, summary: "No-worker receipt allowed valid independent progress", verification, limits: [] });
  await h.settle();
  expect(new Set([...handles, third].map(handle => handle.childId)).size).toBe(3);
}));

test("outer cancellation owns consultation startup and late disposal without retargeting", fixture.ownedCase("consultation startup cancellation", async () => {
  const workerCreate = { entered: gate(), release: gate() };
  const h = await harness({ workerCreate });
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: [], task: "cancel startup" });
  await h.headEntered.promise;
  await h.call("head_consult", { role: "researcher", task: "late" });
  await workerCreate.entered.promise;
  await h.callPublic("agent_cancel", { id: admission.details.instanceId });
  await h.headAborted.promise;
  let settled = false;
  const settling = h.settle().then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  workerCreate.release.resolve();
  await settling;
  expect(h.workers.sessions).toHaveLength(1);
  expect(h.workers.sessions[0].prompts).toEqual([]);
  expect(h.workers.sessions[0].events).toContain("dispose");
  expect(h.outcome(admission.details.instanceId).status).toBe("cancelled");
}));

test("public modes reject before effects and preserve ordinary routes", fixture.ownedCase("public mode admission", async () => {
  const h = await harness({ headPolicy: false });
  for (const tool of ["agent_spawn", "team_assign"]) {
    expect(h.publicTools.get(tool).parameters.properties).not.toHaveProperty("checkpoints");
    expect(h.publicTools.get(tool).parameters.properties).toHaveProperty("checkpoint_origin");
  }
  for (const tool of ["agent_spawn", "agent_run", "team_assign"]) {
    const result = await h.callPublic(tool, { role: "developer_head", task: "not public" });
    expect(result.isError).toBe(true);
  }
  for (const params of [
    { role: "developer", mode: "head" }, { role: "reviewer", mode: "head", writes: [] },
    { role: "developer", writes: [] }, { role: "developer", mode: "single", writes: ["."] },
    { role: "developer", mode: "head", writes: ["../escape"] },
    { role: "developer", mode: "head", writes: ["/absolute"] },
    { role: "developer", mode: "head", writes: [] },
    { role: "reviewer", checkpoint_origin: { assignmentId: "old", checkpointId: "old", commit: "abc" } },
    { role: "developer", checkpoint_origin: { assignmentId: "old", checkpointId: "old", commit: "abc" } },
  ]) {
    for (const tool of ["agent_spawn", "team_assign"]) expect((await h.callPublic(tool, { ...params, task: "invalid" })).isError).toBe(true);
  }
  expect((await h.callPublic("agent_run", { role: "developer", task: "sync", mode: "head", writes: [] })).isError).toBe(true);
  expect((await h.callPublic("agent_run", { role: "developer", task: "sync",
    checkpoint_origin: { assignmentId: "old", checkpointId: "old", commit: "abc" } })).isError).toBe(true);
  expect(h.counts()).toEqual({ starts: 0, leafStarts: 0, classifications: 0 });
  expect(firstTeamReservation(h.evaluation, "developer")).toBeUndefined();
  const developer = await h.callPublic("agent_spawn", { role: "developer", task: "ordinary" });
  const researcher = await h.callPublic("team_assign", { role: "researcher", task: "ordinary" });
  expect(developer.isError).not.toBe(true); expect(researcher.isError).not.toBe(true);
  await fixture.settleRuns();
  expect(h.outcome(developer.details.instanceId).head).toBeUndefined();
  expect(h.outcome(researcher.details.instanceId, true).head).toBeUndefined();
  expect(h.counts().starts).toBe(2);
}));

test("ordinary Developer and other roles keep native tools without Head checkpoint authority", fixture.ownedCase("ordinary SDK isolation", async () => {
  const h = await harness({ ordinarySdk: true });
  const developer = await h.callPublic("agent_spawn", { role: "developer", task: "ordinary" });
  await h.headEntered.promise;
  expect(h.headLocal().tools.has("head_checkpoint")).toBe(false);
  expect(h.host.sessionInputs[0].customTools).toBeUndefined();
  expect(h.host.loaderInputs[0].appendSystemPrompt.join("\n")).not.toContain("Managed local-source support:");
  await h.settle();
  expect(h.outcome(developer.details.instanceId).head).toBeUndefined();
  const researcher = await h.callPublic("team_assign", { role: "researcher", task: "ordinary" });
  await fixture.settleRuns();
  expect(h.headLocal().tools.has("head_checkpoint")).toBe(false);
  expect(h.host.sessionInputs[1].customTools).toBeUndefined();
  expect(h.outcome(researcher.details.instanceId, true).head).toBeUndefined();
}));

const gitAt = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args]).toString().trim();
const checkpoint = (h: Awaited<ReturnType<typeof harness>>, paths: string[], expectedRevision = 0) =>
  h.call("head_checkpoint", { action: "create", expectedRevision, paths, summary: "Save partial work",
    remaining: ["Independent review and remaining product work"], limits: ["Controlled SDK boundary"], evidence: [] });
function seedCheckpoint(root: string) {
  mkdirSync(path.join(root, "work"));
  for (const [name, text] of Object.entries({ a: "base\n", removed: "remove\n", mode: "mode\n", foreign: "base foreign\n" })) {
    writeFileSync(path.join(root, "work", name), text);
  }
  gitAt(root, "add", "--", "work");
  gitAt(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "seed");
  writeFileSync(path.join(root, "work/foreign"), "foreign index\n");
  gitAt(root, "add", "--", "work/foreign");
  writeFileSync(path.join(root, "work/foreign"), "foreign working\n");
  writeFileSync(path.join(root, "work/untracked"), "foreign untracked\n");
}

test("default spawn Head checkpoints save a no-leaf chain without index/branch or finish authority", fixture.ownedCase("public real checkpoint chain", async () => {
  const h = await harness({ gitRepository: true, seed: seedCheckpoint });
  const base = gitAt(h.root, "rev-parse", "HEAD"), branch = gitAt(h.root, "symbolic-ref", "HEAD");
  const index = readFileSync(path.join(h.root, ".git/index")), flags = gitAt(h.root, "ls-files", "-v");
  await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["work"], task: "Partial work" });
  await h.headEntered.promise;
  const barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  await h.call("write", { path: "work/a", content: "first\n" });
  await h.call("write", { path: "work/new", content: "new\n" });
  await h.call("write", { path: "work/omitted", content: "later\n" });
  await h.call("bash", { command: "rm work/removed; chmod +x work/mode" });
  const refused = await checkpoint(h, ["work/a", "work/foreign", "work/untracked", "../escape"]);
  expect(refused.status).toBe("refused");
  expect(refused.rejected.map((entry: any) => entry.path)).toEqual(["work/foreign", "work/untracked", "../escape"]);
  expect(listCheckpoints(h.root)).toEqual([]);
  const first = await checkpoint(h, ["work/a", "work/new", "work/removed", "work/mode"]);
  expect(first.status).toBe("committed");
  expect(first.manifest.parent).toBe(base);
  expect(gitAt(h.root, "show", `${first.origin.commit}:work/a`)).toBe("first");
  expect(gitAt(h.root, "ls-tree", first.origin.commit, "--", "work/mode")).toStartWith("100755");
  expect(gitAt(h.root, "ls-tree", first.origin.commit, "--", "work/removed")).toBe("");
  expect(first.manifest.omitted).toEqual(expect.arrayContaining(["work/foreign", "work/untracked", "work/omitted"]));
  expect(gitAt(h.root, "show", `${first.origin.commit}:work/foreign`)).toBe("base foreign");
  const checkpointEntry = h.headSession().sessionManager.getLeafId();
  await expect(h.call("head_finish", { status: "completed", epoch: barrier.epoch, summary: "Not verification",
    verification: [checkpointEntry], limits: [] })).rejects.toThrow("successful native tool results");
  await h.call("write", { path: "work/a", content: "second\n" });
  await h.call("write", { path: "work/new", content: "modified but omitted\n" });
  const second = await checkpoint(h, ["work/a"]);
  expect(second.status).toBe("committed");
  expect(gitAt(h.root, "rev-parse", `${second.origin.commit}^`)).toBe(first.origin.commit);
  expect(second.manifest.saved.map((entry: any) => entry.path).sort()).toEqual(["work/a", "work/mode", "work/new", "work/removed"]);
  expect(gitAt(h.root, "show", `${second.origin.commit}:work/new`)).toBe("new");
  expect(second.manifest.omitted).toContain("work/new");
  expect(second.manifest.native[0].entries).toContainEqual(expect.objectContaining({ toolName: "write", isError: false }));
  expect(second.manifest.native[0].testedSource).toBe("not_recorded");
  expect(readFileSync(path.join(h.root, ".git/index"))).toEqual(index);
  expect(gitAt(h.root, "ls-files", "-v")).toBe(flags);
  expect(gitAt(h.root, "rev-parse", "HEAD")).toBe(base);
  expect(gitAt(h.root, "symbolic-ref", "HEAD")).toBe(branch);
  expect(readFileSync(path.join(h.root, "work/foreign"), "utf8")).toBe("foreign working\n");
  await h.call("bash", { command: "test \"$(cat work/a)\" = second" });
  await h.call("head_finish", { status: "completed", epoch: barrier.epoch, summary: "Integrated",
    verification: [h.headSession().sessionManager.getLeafId()], limits: [] });
  await h.settle();
  const inspected = await h.callPublic("agent_checkpoints", { action: "read", ...second.origin });
  expect(inspected.details.current.filter((entry: any) => !entry.matches).map((entry: any) => entry.path)).toEqual(["work/new"]);
  expect(inspected.details.checkoutDirt.some((entry: string) => entry.includes("work/omitted"))).toBe(true);
  expect(inspected.details.historicalEvidence.closureGaps).toEqual([]);
}));

test("checkpoint exemption spans closed waves while product editing and stale verification remain fenced", fixture.ownedCase("public checkpoint waves", async () => {
  const h = await harness({ gitRepository: true });
  await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["shared"], task: "waves" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "edit", expectedRevision: 0, nodes: [node("a", ["shared"])], supersede: [] });
  const [a] = await h.call("head_start", { expectedRevision: 1, nodeIds: ["a"] });
  await h.leaf("a").entered.promise;
  expect(h.leaf("a").local!.tools.has("head_checkpoint")).toBe(false);
  const leafInstructions = h.workers.loaderInputs[0].appendSystemPrompt.join("\n");
  expect(leafInstructions).toContain("leaves do not stage or commit independently");
  expect(leafInstructions).toContain("Shell scope is cooperative, not confinement");
  await h.callLeaf("a", "write", { path: "shared", content: "leaf A\n" });
  await expect(checkpoint(h, ["shared"], 1)).rejects.toThrow("still settling");
  h.leaf("a").done.resolve(); h.leaf("a").dispose.resolve();
  await h.closed(a.runId);
  await h.call("head_review", { runId: a.runId, effectiveRevision: 1, judgment: "satisfied",
    evidence: ["read inspected native result"], reason: "Controlled leaf result inspected" });
  const barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: 1 });
  await h.call("write", { path: "shared", content: "leaf A + Head\n" });
  await h.call("bash", { command: "test -f shared" });
  const staleCheck = h.headSession().sessionManager.getLeafId();
  const first = await checkpoint(h, ["shared"], 1);
  expect(first.status).toBe("committed");
  await h.call("head_plan", { action: "reopen", epoch: barrier.epoch });
  await expect(h.call("write", { path: "shared", content: "outside integration" })).rejects.toThrow("exclusive integration barrier");
  await h.call("head_plan", { action: "edit", expectedRevision: 1, nodes: [
    node("b", ["shared"], ["a"]), node("future", ["shared"], ["b"]),
  ], supersede: [] });
  const [b] = await h.call("head_start", { expectedRevision: 2, nodeIds: ["b"] });
  await h.leaf("b").entered.promise;
  await h.callLeaf("b", "bash", { command: "test \"$(cat shared)\" = 'leaf A + Head'; printf ' + leaf B\\n' >> shared" });
  h.leaf("b").done.resolve(); h.leaf("b").dispose.resolve();
  await h.closed(b.runId);
  const second = await checkpoint(h, ["shared"], 2);
  expect(second.status).toBe("committed");
  expect(second.manifest.parent).toBe(first.origin.commit);
  expect(second.manifest.contributors.map((entry: any) => entry.contribution.source.kind)).toEqual(expect.arrayContaining(["leaf", "head"]));
  expect(JSON.stringify(second.manifest.graph)).toContain("future");
  expect((await h.read()).nodes.find((entry: any) => entry.id === "future").judgment).toBe("pending");
  await expect(h.call("head_plan", { action: "beginIntegration", expectedRevision: 2 })).rejects.toThrow();
  expect((await h.read()).verificationCandidates).not.toContainEqual(expect.objectContaining({ entryId: staleCheck }));
  await h.call("head_finish", { status: "failed", diagnostic: "Useful partial waves, not accepted work", evidence: [], limits: [] });
  await h.settle();
  expect(readCheckpoint(h.root, second.origin).historicalEvidence.closureGaps).toEqual([]);
}));

test("ref survives receipt loss; independent explicit recovery keeps dirt and fresh authority", fixture.ownedCase("public checkpoint recovery", async () => {
  const h = await harness({ gitRepository: true, seed: seedCheckpoint, cutReceipt: true, final: "aborted" });
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["work"], task: "Interrupted" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  await h.call("write", { path: "work/a", content: "saved\n" });
  const cut = await checkpoint(h, ["work/a"]);
  expect(cut.status).toBe("uncertain");
  const origin: CheckpointOrigin = cut.origin;
  expect(listCheckpoints(h.root)).toHaveLength(1);
  expect((await h.callPublic("agent_checkpoints", { action: "list" })).details).toHaveLength(1);
  const liveRecovery = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["work"],
    checkpoint_origin: origin, task: "Too soon" });
  expect(liveRecovery.isError).toBe(true);
  expect(h.counts().starts).toBe(1);
  await h.settle();
  expect(h.outcome(admission.details.instanceId).status).toBe("failed");
  const independent = readCheckpoint(h.root, origin);
  expect(independent.historicalEvidence.closureGaps).toEqual([]);
  writeFileSync(path.join(h.root, "work/post-checkpoint"), "keep subsequent dirt\n");
  await retireTeamEvaluation(h.evaluation);
  const replacement = await harness({ gitRepository: true, root: h.root });
  const parameters = { role: "developer", mode: "head", writes: ["work"], checkpoint_origin: origin, task: "Continue known state" };
  for (const change of [
    { writes: [] }, { checkpoint_origin: { ...origin, commit: gitAt(h.root, "rev-parse", "HEAD") } },
  ]) {
    expect((await replacement.callPublic("agent_spawn", { ...parameters, ...change })).isError).toBe(true);
  }
  const saved = path.join(h.root, "work/a");
  const other = mkdtempSync(path.join(tmpdir(), "pitako-checkpoint-wrong-root-"));
  fixture.directories.push(other);
  gitAt(other, "init", "--quiet");
  expect(() => adoptCheckpoint(other, origin, [path.join(other, "work")])).toThrow();
  const base = gitAt(h.root, "rev-parse", "HEAD"), index = readFileSync(path.join(h.root, ".git/index"));
  const moved = gitAt(h.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit-tree",
    `${base}^{tree}`, "-p", base, "-m", "different base");
  gitAt(h.root, "update-ref", "HEAD", moved);
  try {
    expect(readCheckpoint(h.root, origin).commit).toBe(origin.commit);
    expect((await replacement.callPublic("agent_spawn", parameters)).isError).toBe(true);
  } finally { gitAt(h.root, "update-ref", "HEAD", base); }
  gitAt(h.root, "update-index", "--assume-unchanged", "work/mode");
  try { expect((await replacement.callPublic("agent_spawn", parameters)).isError).toBe(true); }
  finally { writeFileSync(path.join(h.root, ".git/index"), index); }
  const fsmonitor = path.join(h.root, "fsmonitor"), sentinel = path.join(h.root, "fsmonitor-ran");
  writeFileSync(fsmonitor, `#!/bin/sh\nprintf ran > "${sentinel}"\n`);
  chmodSync(fsmonitor, 0o755);
  gitAt(h.root, "config", "core.fsmonitor", fsmonitor);
  try {
    expect(readCheckpoint(h.root, origin).checkoutObservationGaps.join()).toContain("unsupported");
    expect(existsSync(sentinel)).toBe(false);
    expect((await replacement.callPublic("agent_spawn", parameters)).isError).toBe(true);
  } finally { gitAt(h.root, "config", "--unset", "core.fsmonitor"); }
  writeFileSync(saved, "post-checkpoint edit\n");
  expect(readCheckpoint(h.root, origin).current[0]!.matches).toBe(false);
  expect((await replacement.callPublic("agent_spawn", parameters)).isError).toBe(true);
  writeFileSync(saved, "saved\n");
  chmodSync(saved, 0o755);
  expect((await replacement.callPublic("agent_spawn", parameters)).isError).toBe(true);
  chmodSync(saved, 0o644);
  const admitted = await replacement.callPublic("agent_spawn", parameters);
  expect(admitted.isError).not.toBe(true);
  await replacement.headEntered.promise;
  expect((await replacement.read()).nodes).toEqual([]);
  await replacement.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  const foreign = await checkpoint(replacement, ["work/post-checkpoint"]);
  expect(foreign.status).toBe("refused");
  await replacement.call("write", { path: "work/a", content: "continued\n" });
  const child = await checkpoint(replacement, ["work/a"]);
  expect(child.status).toBe("committed");
  expect(child.manifest.parent).toBe(origin.commit);
  expect(child.manifest.origin).toEqual(origin);
  expect(child.manifest.contributors.map((entry: any) => entry.inherited)).toEqual(expect.arrayContaining([true, false]));
  expect(readFileSync(path.join(h.root, "work/post-checkpoint"), "utf8")).toBe("keep subsequent dirt\n");
  expect(readFileSync(path.join(h.root, "work/foreign"), "utf8")).toBe("foreign working\n");
  await replacement.call("head_finish", { status: "failed", diagnostic: "Saved partial continuation", evidence: [], limits: [] });
  await replacement.settle();
}));

test("checkpoint lease is acquired synchronously and cancellation publishes nothing", fixture.ownedCase("public checkpoint lease", async () => {
  const h = await harness({ gitRepository: true });
  await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["direct.txt"], task: "Lease" });
  await h.headEntered.promise;
  const barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  await h.call("write", { path: "direct.txt", content: "save\n" });
  const tools = h.headLocal().tools, ctx = { ...h.ctx, sessionManager: h.headSession().sessionManager };
  const cancellation = new AbortController();
  const saving = tools.get("head_checkpoint").execute("lease-cp", { action: "create", expectedRevision: 0,
    paths: ["direct.txt"], summary: "lease", remaining: [], limits: [], evidence: [] }, cancellation.signal, undefined, ctx);
  const blockedReopen = tools.get("head_plan").execute("reopen", { action: "reopen", epoch: barrier.epoch });
  const guards = [
    ["head_plan", { action: "edit", expectedRevision: 0, nodes: [node("x", ["direct.txt"])], supersede: [] }],
    ["head_plan", { action: "beginIntegration", expectedRevision: 0 }],
    ["head_plan", { action: "confirm", runId: "unknown", effectiveRevision: 0, historyId: "unknown", sessionId: "unknown", proposalId: "unknown" }],
    ["head_review", { runId: "unknown", effectiveRevision: 0, judgment: "satisfied", evidence: ["no"], reason: "no" }],
    ["head_finish", { status: "completed", epoch: barrier.epoch, summary: "no", verification: ["no"], limits: [] }],
  ] as const;
  const guarded = [blockedReopen, ...guards.map(([tool, params]) =>
    Promise.resolve().then(() => tools.get(tool).execute("guard", params, undefined, undefined, ctx)))];
  const settledGuards = Promise.allSettled(guarded);
  expect(() => tools.get("head_start").execute("start", { expectedRevision: 0, nodeIds: ["x"] }, undefined, undefined, ctx)).toThrow("checkpoint lease");
  expect(() => tools.get("write").execute("write", { path: "direct.txt", content: "conflict" }, undefined, undefined, ctx)).toThrow("checkpoint lease");
  const conflictingAdmission = h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["direct.txt"],
    task: "Must not construct a new baseline while leased" });
  cancellation.abort();
  expect((await conflictingAdmission).isError).toBe(true);
  expect(h.counts().starts).toBe(1);
  for (const result of await settledGuards) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(String(result.reason)).toContain("checkpoint lease");
  }
  expect((await saving).details.status).toBe("refused");
  expect(listCheckpoints(h.root)).toEqual([]);
  await h.call("write", { path: "direct.txt", content: "lease released only after settlement\n" });
  expect((await checkpoint(h, ["direct.txt"])).status).toBe("committed");
  await h.call("head_finish", { status: "failed", diagnostic: "Lease observations complete", evidence: [], limits: [] });
  await h.settle();
}));

test("requested unsupported and foreign paths refuse the whole checkpoint without laundering", fixture.ownedCase("public checkpoint path rejection", async () => {
  const h = await harness({ gitRepository: true, seed: seedCheckpoint });
  await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["work"], task: "Reject mixed selection" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  await h.call("write", { path: "work/a", content: "eligible\n" });
  await h.call("write", { path: "work/foreign", content: "managed edit cannot claim the initial preimage\n" });
  await h.call("bash", { command: "ln -s a work/link; mkdir work/directory" });
  const result = await checkpoint(h, ["work/a", "work/foreign", "work/link", "work/directory", "work/a"]);
  expect(result.status).toBe("refused");
  expect(result.selected).toHaveLength(5);
  expect(result.rejected.map((entry: any) => entry.path)).toEqual(["work/a", "work/foreign", "work/link", "work/directory", "work/a"]);
  expect(result.rejected.every((entry: any) => entry.reasons.length > 0)).toBe(true);
  expect(listCheckpoints(h.root)).toEqual([]);
  const saved = await checkpoint(h, ["work/a"]);
  expect(saved.status).toBe("committed");
  expect(gitAt(h.root, "show", `${saved.origin.commit}:work/foreign`)).toBe("base foreign");
  await h.settle();
}));

for (const drift of ["source", "index", "configuration", "attributes"] as const) {
  test(`checkpoint rechecks ${drift} across its scheduling boundary`, fixture.ownedCase(`public checkpoint ${drift} drift`, async () => {
    const h = await harness({ gitRepository: true, seed: seedCheckpoint });
    await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["work"], task: "Recheck source authority" });
    await h.headEntered.promise;
    await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
    await h.call("write", { path: "work/a", content: "known\n" });
    await expect(checkpoint(h, ["work/a"], 9)).rejects.toThrow("stale");
    const ctx = { ...h.ctx, sessionManager: h.headSession().sessionManager };
    const saving = h.headLocal().tools.get("head_checkpoint").execute("drift", { action: "create", expectedRevision: 0,
      paths: ["work/a"], summary: "Recheck", remaining: [], limits: [], evidence: [] }, undefined, undefined, ctx);
    if (drift === "source") writeFileSync(path.join(h.root, "work/a"), "unattributed\n");
    if (drift === "index") gitAt(h.root, "update-index", "--assume-unchanged", "work/mode");
    if (drift === "configuration") gitAt(h.root, "config", "core.autocrlf", "true");
    if (drift === "attributes") writeFileSync(path.join(h.root, "work/.gitattributes"), "a filter=unsupported\n");
    expect((await saving).details.status).toBe("refused");
    expect(listCheckpoints(h.root)).toEqual([]);
    await h.settle();
  }));
}

for (const policy of ["hook", "hook-resolution", "signing", "fsmonitor", "promisor", "filter"] as const) {
  test(`checkpoint refuses unsupported ${policy} without executing repository programs`, fixture.ownedCase(`public checkpoint ${policy}`, async () => {
    const h = await harness({ gitRepository: true, seed: root => {
      seedCheckpoint(root);
      const sentinel = path.join(root, "repository-program-ran");
      if (policy === "hook") {
        const hook = path.join(root, ".git/hooks/reference-transaction");
        writeFileSync(hook, `#!/bin/sh\nprintf ran > "${sentinel}"\n`);
        chmodSync(hook, 0o755);
      }
      if (policy === "hook-resolution") gitAt(root, "config", "core.hooksPath", "/dev/null/not-a-directory");
      if (policy === "signing") gitAt(root, "config", "commit.gpgsign", "true");
      if (policy === "fsmonitor") gitAt(root, "config", "core.fsmonitor", `touch ${sentinel}`);
      if (policy === "promisor") gitAt(root, "config", "remote.origin.promisor", "true");
      if (policy === "filter") {
        gitAt(root, "config", "filter.unsupported.clean", `touch ${sentinel}`);
        writeFileSync(path.join(root, "work/.gitattributes"), "a filter=unsupported\n");
      }
    } });
    await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["work"], task: "Refuse unsupported policy" });
    await h.headEntered.promise;
    await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
    await h.call("write", { path: "work/a", content: "not checkpointable\n" });
    expect((await checkpoint(h, ["work/a"])).status).toBe("refused");
    expect(existsSync(path.join(h.root, "repository-program-ran"))).toBe(false);
    // Listing is read-only and does not run status/filter/fsmonitor.
    expect(listCheckpoints(h.root)).toEqual([]);
    await h.settle();
  }));
}

test("checkpoint supports SHA256 and EOL conversion while sanitizing inherited Git redirections", fixture.ownedCase("public checkpoint EOL", async () => {
  const h = await harness({ gitRepository: true, objectFormat: "sha256", seed: root => {
    seedCheckpoint(root);
    writeFileSync(path.join(root, ".gitattributes"), "work/a text eol=lf\n");
    gitAt(root, "add", "--", ".gitattributes");
    gitAt(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "attributes");
  } });
  await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["work/a"], task: "Save CRLF raw" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  await h.call("write", { path: "work/a", content: "saved\r\n" });
  const index = readFileSync(path.join(h.root, ".git/index"));
  const poison = { GIT_DIR: path.join(h.root, "nonexistent-git"), GIT_WORK_TREE: "/nonexistent-worktree",
    GIT_INDEX_FILE: path.join(h.root, "caller-index"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "true", GIT_TRACE: path.join(h.root, "caller-trace") };
  const prior = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]));
  const saved = await (async () => {
    try {
      Object.assign(process.env, poison);
      return await checkpoint(h, ["work/a"]);
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  })();
  expect(saved.status).toBe("committed");
  expect(saved.origin.commit).toHaveLength(64);
  expect(readFileSync(path.join(h.root, ".git/index"))).toEqual(index);
  expect(existsSync(poison.GIT_INDEX_FILE)).toBe(false);
  expect(existsSync(poison.GIT_TRACE)).toBe(false);
  expect(execFileSync("git", ["-C", h.root, "show", `${saved.origin.commit}:work/a`]).toString()).toBe("saved\n");
  expect(readFileSync(path.join(h.root, "work/a"), "utf8")).toBe("saved\r\n");
  await h.settle();
  expect(adoptCheckpoint(h.root, saved.origin, [path.join(h.root, "work/a")]).saved).toEqual(saved.manifest.saved);
}));

test("recovery proves linked sealed leaf members without sealing the plan execution group", fixture.ownedCase("public plan checkpoint recovery", async () => {
  const plan = "checkpoint-plan";
  const h = await harness({ gitRepository: true, cutReceipt: true, seed: async root => {
    const board = await openBoard();
    try {
      const workspace = currentWorkspace(root);
      const topic = board.createTopic(workspace, { title: "Checkpoint recovery" });
      board.claimTopic(workspace, topic.id, plan);
      const file = planFile(plan, root);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `---\nid: ${plan}\nrevision: 1\nstatus: frozen\nexecution: expected\nboard_topic_id: ${topic.id}\n---\n\nPartial work.\n`);
    } finally { board.close(); }
  } });
  const admitted = await h.callPublic("team_assign", { role: "developer", mode: "head", writes: ["work"],
    plan, unit: "T2", task: "Plan-bound useful partial work" });
  expect(admitted.isError).not.toBe(true);
  await h.headEntered.promise;
  await h.call("head_plan", { action: "edit", expectedRevision: 0, nodes: [node("a", ["work"])], supersede: [] });
  const [a] = await h.call("head_start", { expectedRevision: 1, nodeIds: ["a"] });
  await h.leaf("a").entered.promise;
  await h.callLeaf("a", "write", { path: "work/saved", content: "linked leaf\n" });
  h.leaf("a").done.resolve(); h.leaf("a").dispose.resolve();
  await h.closed(a.runId);
  const receipt = await checkpoint(h, ["work/saved"], 1);
  expect(receipt.status).toBe("uncertain");
  await h.settle();
  expect(h.outcome(admitted.details.instanceId, true).status).toBe("failed");
  const origin: CheckpointOrigin = receipt.origin;
  const read = readCheckpoint(h.root, origin);
  expect(read.historicalEvidence.closureGaps).toContain(`Unreconciled execution hold: ${admitted.details.id}`);
  const store = new WorkerHistory(h.root, { initialize: false });
  const headSource = read.manifest.head;
  const leafSource = read.manifest.contributors.find(entry => entry.contribution.source.kind === "leaf")!.contribution.source;
  expect(store.read(headSource.groupId).identity.kind).toBe("execution");
  expect(store.read(headSource.groupId).closure.state).toBe("unclosed");
  expect(store.read(leafSource.groupId).identity.kind).toBe("invocation");
  expect(store.read(leafSource.groupId).closure.state).toBe("closed");
  const binding = openExecutionPlan(plan, h.root, { createLedger: false }).binding;
  expect(readLedgerTeamHolds(h.root, plan, binding).map(hold => hold.assignmentId)).toContain(admitted.details.id);
  recordPlanTeamWork(h.root, plan, "T2", admitted.details.id, undefined, binding);
  expect(readCheckpoint(h.root, origin).historicalEvidence.closureGaps).toEqual([]);
  await retireTeamEvaluation(h.evaluation);
  const replacement = await harness({ gitRepository: true, root: h.root });
  const params = { role: "developer", mode: "head", writes: ["work"], checkpoint_origin: origin,
    plan, unit: "T2", task: "Continue released partial work" };
  const leafFile = path.join(store.catalogDir, `${leafSource.groupId}.json`), priorCatalog = readFileSync(leafFile, "utf8");
  renameSync(leafFile, `${leafFile}.missing`);
  try {
    expect(readCheckpoint(h.root, origin).historicalEvidence.closureGaps.join()).toContain(leafSource.groupId);
    expect((await replacement.callPublic("team_assign", params)).isError).toBe(true);
    expect(replacement.counts().starts).toBe(0);
  } finally { renameSync(`${leafFile}.missing`, leafFile); }
  for (const corrupt of [
    (group: ReturnType<WorkerHistory["read"]>) => { group.members[0]!.native = { state: "not-created" }; },
    (group: ReturnType<WorkerHistory["read"]>) => { group.members[0]!.assignmentId = "different-assignment"; },
    (group: ReturnType<WorkerHistory["read"]>) => { group.members[0]!.terminal = undefined; },
  ]) {
    const group = JSON.parse(priorCatalog);
    corrupt(group);
    writeFileSync(leafFile, JSON.stringify(group));
    try {
      expect(readCheckpoint(h.root, origin).historicalEvidence.closureGaps.length).toBeGreaterThan(0);
      expect((await replacement.callPublic("team_assign", params)).isError).toBe(true);
    } finally { writeFileSync(leafFile, priorCatalog); }
  }
  const missingHistory = path.join(h.root, "does-not-exist");
  expect(readCheckpoint(h.root, origin, missingHistory).historicalEvidence.closureGaps.length).toBeGreaterThan(0);
  expect(existsSync(missingHistory)).toBe(false);
  const replacementAdmission = await replacement.callPublic("team_assign", params);
  expect(replacementAdmission.isError).not.toBe(true);
  await replacement.headEntered.promise;
  expect((await replacement.read()).nodes).toEqual([]);
  await replacement.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  await replacement.call("write", { path: "work/saved", content: "linked leaf + new Head\n" });
  const next = await checkpoint(replacement, ["work/saved"]);
  expect(next.status).toBe("committed");
  expect(next.manifest.parent).toBe(origin.commit);
  expect(next.manifest.contributors.some((entry: any) => entry.inherited && entry.contribution.source.runId === a.runId)).toBe(true);
  await replacement.call("head_finish", { status: "failed", diagnostic: "Saved without acceptance", evidence: [], limits: [] });
  await replacement.settle();
  expect(store.read(headSource.groupId).closure.state).toBe("unclosed");
  expect(readCheckpoint(h.root, next.origin).historicalEvidence.closureGaps.join()).toContain("Unreconciled execution hold");
}));

test("public granted Head edits and checks through managed definitions without leaves", fixture.ownedCase("public managed Head", async () => {
  const h = await harness({ gitRepository: true });
  const admission = await h.callPublic("agent_spawn", {
    role: "developer", mode: "head", writes: ["direct.txt"], task: "Implement directly",
  });
  expect(admission.isError).not.toBe(true);
  await h.headEntered.promise;
  await expect(h.call("write", { path: "direct.txt", content: "early" })).rejects.toThrow("exclusive integration barrier");
  let barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  const inventory = (await h.read()).managed.inventory.admission;
  expect(inventory.root).toBe(h.root);
  expect(inventory.paths).toEqual([]);
  await h.call("write", { path: "direct.txt", content: "first integration\n" });
  await h.call("head_plan", { action: "reopen", epoch: barrier.epoch });
  await expect(h.call("write", { path: "direct.txt", content: "between waves" })).rejects.toThrow("exclusive integration barrier");
  barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  expect((await h.read()).managed.inventory.admission).toEqual(inventory);
  await h.call("write", { path: "direct.txt", content: "managed\n" });
  await expect(h.call("write", { path: "other.txt", content: "escape" })).rejects.toThrow("write reservation");
  await expect(h.call("codemode", { code: "unknown writer" })).rejects.toThrow("Unsupported writer");
  await h.call("bash", { command: "printf failed-check; exit 7" });
  const failedCheck = h.headSession().sessionManager.getLeafId();
  await expect(h.call("head_finish", { status: "completed", epoch: barrier.epoch, summary: "Not passed",
    verification: [failedCheck], limits: [] })).rejects.toThrow("successful native tool results");
  await h.call("bash", { command: 'test "$(cat direct.txt)" = managed' });
  const checked = h.headSession().sessionManager.getLeafId();
  await h.call("head_finish", { status: "completed", epoch: barrier.epoch, summary: "Managed native work",
    verification: [checked], limits: ["Controlled PiFactories; cooperative shell"] });
  await h.settle();
  expect(h.outcome(admission.details.instanceId).status).toBe("completed");
  const managed = h.outcome(admission.details.instanceId).head!.managed!;
  expect(managed.inventory.admission).toEqual(inventory);
  expect(managed.inventory.contributions.some((entry: any) => entry.source.toolName === "write" && entry.changes[0].path === "direct.txt")).toBe(true);
  expect(managed.native[0]).toMatchObject({ closure: "released", source: {
    kind: "head", instanceId: admission.details.instanceId, sessionId: h.headSession().sessionId,
  } });
  expect(managed.native[0].entries).toContainEqual(expect.objectContaining({ toolName: "bash", isError: true,
    entryId: expect.any(String), digest: expect.any(String) }));
  for (const contribution of managed.inventory.contributions) {
    expect(managed.native[0].entries).toContainEqual(expect.objectContaining({
      toolName: contribution.source.toolName, toolCallId: contribution.source.toolCallId,
    }));
  }
  expect(readFileSync(path.join(h.root, "direct.txt"), "utf8")).toBe("managed\n");
  expect(h.host.sessionInputs[0].customTools.map((tool: any) => tool.name)).toContain("bash");
  const instructions = h.host.loaderInputs[0].appendSystemPrompt.join("\n");
  expect(instructions).toContain("No daemons, detached/remote writers or escaped descendants");
  expect(instructions).toContain("Only the host-bound Head requests staging through head_checkpoint");
  expect(instructions).toContain("Choose useful quiescent progress points for fast recovery");
  expect(instructions).toContain("A ref, terminal status, missing history, or receipt alone");
  expect(h.counts()).toEqual({ starts: 1, leafStarts: 0, classifications: 0 });
}));

test("managed Head effects without leaves prevent fallback replay", fixture.ownedCase("managed fallback fence", async () => {
  const finalError = "HTTP 429 too many requests";
  expect(classifyProviderFailure(finalError)).toBe("rate_limit");
  const h = await harness({ gitRepository: true, headFallback: true, final: "error", finalError });
  const admission = await h.callPublic("team_assign", { role: "developer", mode: "head", writes: ["direct.txt"],
    task: "Head edit then provider failure" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  await h.call("write", { path: "direct.txt", content: "only once\n" });
  await h.settle();
  expect(h.outcome(admission.details.instanceId, true).status).toBe("failed");
  expect(h.host.sessions).toHaveLength(1);
  expect(readFileSync(path.join(h.root, "direct.txt"), "utf8")).toBe("only once\n");
}));

test("checkpoint object effects alone fence an eligible fresh-prompt fallback", fixture.ownedCase("checkpoint fallback fence", async () => {
  const finalError = "HTTP 429 too many requests";
  const h = await harness({ gitRepository: true, seed: seedCheckpoint });
  await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["work/a"], task: "Save partial source" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  await h.call("write", { path: "work/a", content: "saved\n" });
  const saved = await checkpoint(h, ["work/a"]);
  expect(saved.status).toBe("committed");
  await h.settle();
  await retireTeamEvaluation(h.evaluation);
  const replacement = await harness({ gitRepository: true, root: h.root, headFallback: true, final: "error", finalError });
  await replacement.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["work/a"],
    checkpoint_origin: saved.origin, task: "Save unchanged recovered source" });
  await replacement.headEntered.promise;
  const child = await checkpoint(replacement, ["work/a"]);
  expect(child.status).toBe("committed");
  expect(child.manifest.contributors.every((entry: any) => entry.inherited)).toBe(true);
  await replacement.settle();
  expect(replacement.host.sessions).toHaveLength(1);
  expect(listCheckpoints(h.root)).toHaveLength(2);
}));

test("native callback settlement retains the slot through cancellation and session disposal", fixture.ownedCase("managed native disposal join", async () => {
  const h = await harness({ gitRepository: true });
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["direct.txt"],
    task: "Owned callback" });
  await h.headEntered.promise;
  const barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  const entered = gate(), release = gate();
  fixture.finishOnCleanup(() => release.resolve());
  const native = h.call("bash", { command: "printf native" }, () => { entered.resolve(); return release.promise; });
  const nativeSettled = Promise.allSettled([native]);
  await entered.promise;
  await expect(h.call("head_plan", { action: "reopen", epoch: barrier.epoch })).rejects.toThrow("still settling");
  await expect(checkpoint(h, ["direct.txt"])).rejects.toThrow("still settling");
  let retirement: Promise<void> | undefined;
  let retired = false;
  try {
    const receipt = await h.callPublic("agent_cancel", { id: admission.details.instanceId });
    expect(receipt.isError).not.toBe(true); // Cancellation receipt is not a closure witness.
    await h.headAborted.promise;
    retirement = h.settle();
    void retirement.then(() => { retired = true; });
    await h.callPublic("agent_status", { id: admission.details.instanceId });
    expect(retired).toBe(false);
    expect(h.headSession().events).not.toContain("dispose");
  } finally {
    release.resolve(); await nativeSettled; await retirement;
  }
  expect(h.headSession().events).toContain("dispose");
  await h.settle();
}));

test("public Team Head completes direct product work with no leaves through the exclusive barrier", fixture.ownedCase("public no-leaf Head", async () => {
  const h = await harness();
  const admission = await h.callPublic("team_assign", {
    role: "developer", mode: "head", writes: ["direct.txt"], task: "Implement and check direct product work",
  });
  expect(admission.isError).not.toBe(true);
  await h.headEntered.promise;
  expect(h.headLocal().tools.has("head_checkpoint")).toBe(true);
  expect(h.host.loaderInputs[0].appendSystemPrompt.join("\n")).toContain("Managed local-source support:");
  expect(firstTeamReservation(h.evaluation, "developer")).toBe(admission.details.id);
  const initial = await h.read();
  expect(initial.nodes).toEqual([]);
  await expect(h.call("write", { path: "direct.txt", content: "premature\n" })).rejects.toThrow("exclusive integration barrier");
  const barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: initial.revision });
  await h.call("write", { path: "direct.txt", content: "direct\n" });
  const unavailable = await checkpoint(h, ["direct.txt"]);
  expect(unavailable.status).toBe("refused");
  expect(unavailable.reasons.join()).toContain("unavailable");
  expect(() => listCheckpoints(h.root)).toThrow();
  expect(existsSync(path.join(h.root, ".git"))).toBe(false);
  await h.call("bash", { command: 'test "$(cat direct.txt)" = direct' });
  const checked = h.headSession().sessionManager.getLeafId();
  const candidates = (await h.read()).verificationCandidates;
  expect(candidates).toContainEqual({ kind: "native-tool", entryId: checked,
    toolCallId: h.headSession().sessionManager.getEntry(checked).message.toolCallId, toolName: "bash" });
  const finish = {
    status: "completed" as const, epoch: barrier.epoch, summary: "Implemented and checked direct product work",
    verification: [checked], limits: ["Controlled SDK boundary, not autonomous model compliance"],
  };
  await h.call("head_finish", finish);
  await h.settle();
  const result = h.outcome(admission.details.instanceId, true);
  expect(result.status).toBe("completed");
  expect(result.role).toBe("developer");
  expect(result.result).toBe(finish.summary);
  expect(result.head).toEqual({
    assignmentId: admission.details.id, headInstanceId: result.instanceId, revision: initial.revision,
    finish, barrier, leaves: [],
    managed: expect.objectContaining({
      active: 0, closureFailures: [],
      inventory: expect.objectContaining({ admission: undefined, unavailable: expect.any(String) }),
      native: [expect.objectContaining({ closure: "released", source: expect.objectContaining({ kind: "head" }) })],
    }),
    metrics: {
      ownUsage: result.usage,
      aggregateUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.01, turns: 1, toolCalls: 0 },
      aggregateClassifierUsage: undefined,
      usageComplete: true, classifierUsage: [], consultations: [], combinedTotal: null, coverage: expect.any(String), elapsedMs: expect.any(Number), observedPeakParallelism: 0,
    },
  });
  expect(result.instanceId).toBe(admission.details.instanceId);
  expect(h.counts()).toEqual({ starts: 1, leafStarts: 0, classifications: 0 });
  expect(h.host.sessions).toHaveLength(1);
  expect(h.workers.sessions).toHaveLength(0);
  expect(readFileSync(path.join(h.root, "direct.txt"), "utf8")).toBe("direct\n");
  expect(h.headSession().sessionManager.getBranch()).toContainEqual(expect.objectContaining({
    type: "custom", customType: "pitako.head", data: expect.objectContaining({ kind: "barrier" }),
  }));
}));

test("public Team Head decomposes, overlaps, corrects, integrates and returns native-backed handoff", fixture.ownedCase("public integrated Head", async () => {
  const h = await harness();
  const admission = await h.callPublic("team_assign", { role: "developer", mode: "head", writes: ["."], task: "PARENT SECRET" });
  expect(admission.isError).not.toBe(true);
  await h.headEntered.promise;
  expect(firstTeamReservation(h.evaluation, "developer")).toBe(admission.details.id);
  expect(h.headSession().active).toContain("head_finish");
  expect(h.headSession().active).not.toContain("agent_spawn");
  await expect(h.call("bash", { command: "touch forbidden" })).rejects.toThrow("exclusive integration barrier");
  await h.call("head_plan", { action: "edit", expectedRevision: 0, nodes: [node("a", ["shared"]), node("b")], supersede: [] });
  const [a, b] = await h.call("head_start", { expectedRevision: (await h.read()).revision, nodeIds: ["a", "b"] });
  await Promise.all([h.leaf("a").entered.promise, h.leaf("b").entered.promise]);
  expect(h.workers.sessions.every(session => !session.events.includes("dispose"))).toBe(true);
  expect(h.leaf("a").task).not.toContain("PARENT SECRET");
  expect(h.leaf("a").local!.tools.has("head_scope_ack")).toBe(true);
  expect(h.leaf("a").local!.tools.has("head_checkpoint")).toBe(false);
  expect(h.leaf("a").local!.tools.has("write")).toBe(true);
  const current = await h.call("head_result", { childId: a.runId });
  const identity = { runId: a.runId, effectiveRevision: current.effectiveRevision, ...current.native };
  const observation = await h.call("head_observe", identity);
  const proposal = await h.call("head_plan", { action: "propose", ...identity, expectedRevision: (await h.read()).revision,
    next: { ...node("a", []), brief: "Inspect correction a" }, additions: [node("c", ["shared"])], progress: [observation.observationId] });
  expect(proposal.receipt.status).toBe("queued");
  expect(proposal.confirmed).not.toBe(true);
  await expect(h.call("head_plan", { action: "confirm", ...identity, proposalId: proposal.proposalId })).rejects.toThrow();
  const leafSession = h.leaf("a").session;
  const progress = leafSession.sessionManager.appendCustomEntry("controlled.progress", { inspected: true });
  const ackTool = h.leaf("a").local!.tools.get("head_scope_ack");
  const ack = await ackTool.execute("ack", { action: "ack", proposalId: proposal.proposalId,
    effectiveRevision: identity.effectiveRevision, accept: true, progress: [progress] });
  expect(ack.details.confirmed).toBe(false);
  await h.call("head_plan", { action: "confirm", ...identity, proposalId: proposal.proposalId });
  const effective = await ackTool.execute("current", { action: "current" });
  expect(effective.details.contract.brief).toBe("Inspect correction a");
  expect(effective.details.effectiveRevision).not.toBe(identity.effectiveRevision);
  await expect(h.call("head_start", { expectedRevision: (await h.read()).revision, nodeIds: ["c"] })).rejects.toThrow("write reservations");
  h.leaf("a").done.resolve(); await h.leaf("a").disposing.promise;
  await expect(h.call("head_start", { expectedRevision: (await h.read()).revision, nodeIds: ["c"] })).rejects.toThrow("write reservations");
  h.leaf("a").dispose.resolve(); await h.closed(a.runId);
  await h.call("head_review", { runId: a.runId, effectiveRevision: effective.details.effectiveRevision, judgment: "satisfied",
    evidence: [progress], reason: "Inspected corrected bounded scope and native progress" });
  const [c] = await h.call("head_start", { expectedRevision: (await h.read()).revision, nodeIds: ["c"] });
  await h.leaf("c").entered.promise;
  for (const [id, runId] of [["b", b.runId], ["c", c.runId]]) {
    h.leaf(id).done.resolve(); h.leaf(id).dispose.resolve(); const result = await h.closed(runId);
    await h.call("head_review", { runId, effectiveRevision: result.effectiveRevision, judgment: "satisfied",
      evidence: ["controlled diff inspected"], reason: "Inspected native result and bounded change" });
  }
  const barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: (await h.read()).revision });
  const successful = (verification: string[], epoch = barrier.epoch) => ({ status: "completed", epoch,
    summary: "Integrated correction and verified product", verification, limits: ["Controlled protocol, not autonomous reasoning"] });
  const oldNative = h.headSession().sessionManager.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "toolResult").id;
  for (const ref of [oldNative, progress, "invented"]) await expect(h.call("head_finish", successful([ref]))).rejects.toThrow("verification");
  await h.call("write", { path: "integrated.txt", content: "corrected\n" });
  await h.call("bash", { command: 'test "$(cat integrated.txt)" = corrected' });
  const checked = h.headSession().sessionManager.getLeafId();
  await h.call("head_plan", { action: "reopen", epoch: barrier.epoch });
  await expect(h.call("head_finish", successful([checked]))).rejects.toThrow("barrier");
  const next = await h.call("head_plan", { action: "beginIntegration", expectedRevision: (await h.read()).revision });
  await expect(h.call("head_finish", successful([checked], next.epoch))).rejects.toThrow("verification");
  await h.call("bash", { command: 'test "$(cat integrated.txt)" = corrected' });
  const checks = (await h.read()).verificationCandidates;
  expect(checks).toHaveLength(1);
  expect(checks[0].toolName).toBe("bash");
  const finalCheck = checks[0].entryId;
  await h.call("head_finish", successful([finalCheck], next.epoch));
  await h.settle();
  const result = h.outcome(admission.details.instanceId, true);
  expect(result.status).toBe("completed"); expect(result.result).toBe("Integrated correction and verified product");
  expect(result.head!.finish).toMatchObject({ status: "completed", verification: [finalCheck], epoch: next.epoch });
  expect(result.head!.metrics).toMatchObject({ ownUsage: { input: 10, output: 5 }, aggregateUsage: undefined,
    usageComplete: false, observedPeakParallelism: 2, classifierUsage: [] });
  expect(result.head!.headInstanceId).toBe(result.instanceId);
  expect(result.head!.leaves).toHaveLength(3);
  expect(JSON.stringify(result)).not.toContain('"role":"assistant"');
  expect(readFileSync(path.join(h.root, "integrated.txt"), "utf8")).toBe("corrected\n");
  const history = await h.callPublic("agent_history", { action: "list", assignmentId: admission.details.id });
  const members = history.details.items.filter((entry: any) => entry.kind === "member");
  expect(members.some((entry: any) => entry.head?.headInstanceId === result.instanceId && entry.head?.nodeId === "a" &&
    entry.head?.effectiveRevision === effective.details.effectiveRevision &&
    entry.coordinatorSessionId === h.headSession().sessionId)).toBe(true);
  expect(h.headSession().sessionManager.getBranch().some((entry: any) => entry.type === "custom" &&
    entry.customType === "pitako.head" && entry.data.kind === "barrier")).toBe(true);
}));

test("public spawn grants read-only Head; native offers are not receipts and invalid finals are bounded", fixture.ownedCase("public Head result delivery", async () => {
  const h = await harness();
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: [], task: "read only" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "edit", expectedRevision: 0, nodes: [node("a", [])], supersede: [] });
  const [a] = await h.call("head_start", { expectedRevision: (await h.read()).revision, nodeIds: ["a"] });
  await h.leaf("a").entered.promise;
  h.leaf("a").done.resolve(); h.leaf("a").dispose.resolve(); await h.closed(a.runId);
  const boundary = async (event: unknown) => {
    let result: AgentBeforeSettleEventResult | undefined;
    for (const hook of h.headLocal().events.get("agent_before_settle") ?? []) result = await hook(event) ?? result;
    return result;
  };
  const event = { outcome: "completed", context: { canContinue: true } };
  const first = await boundary(event);
  expect(await boundary(event)).toBeUndefined(); // An open offer waits for its receipt, not elapsed callbacks.
  for (const hook of h.headLocal().events.get("agent_settled") ?? []) await hook({});
  const replay = await boundary(event);
  const envelope = first?.entries?.find(entry => entry.type === "custom_message" && entry.customType === "pitako.head.result");
  const repeated = replay?.entries?.find(entry => entry.type === "custom_message" && entry.customType === "pitako.head.result");
  if (envelope?.type !== "custom_message" || repeated?.type !== "custom_message" || typeof envelope.content !== "string") {
    throw Error("Expected full native Head result offers");
  }
  expect(repeated.details).toMatchObject({ envelopeId: JSON.parse(envelope.content).envelopeId,
    deliveryGap: expect.stringContaining("Prior offer") });
  expect(repeated.content).toBe(envelope.content);
  h.headSession().sessionManager.appendCustomMessageEntry(envelope.customType, envelope.content, true, envelope.details);
  const correction = await boundary(event);
  expect(correction?.continue).toBe(true); // Offers do not consume the missing-finish correction.
  expect((await boundary(event))?.continue).toBe(true);
  const stopped = await boundary(event);
  expect(stopped?.continue).not.toBe(true);
  for (const event of [{ outcome: "aborted", context: { canContinue: true } },
    { outcome: "error", context: { canContinue: true } }, { outcome: "completed", context: { canContinue: false } }]) {
    expect(await boundary(event)).toBeUndefined();
  }
  await h.settle();
  const result = h.outcome(admission.details.instanceId);
  expect(result.status).toBe("failed");
  expect(result.result).toContain("without head_finish");
  expect(result.head!.finish.status).toBe("failed");
}));

test("Head usage keeps missing cost and classifier usage unknown", fixture.ownedCase("Head metrics unknowns", async () => {
  const h = await harness({ missingCost: true });
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: [], task: "bounded investigation" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "edit", expectedRevision: 0,
    nodes: [{ ...node("a", []), capacity: { route: "classify" } }], supersede: [] });
  const [a] = await h.call("head_start", { expectedRevision: (await h.read()).revision, nodeIds: ["a"] });
  await h.leaf("a").entered.promise;
  h.leaf("a").done.resolve(); h.leaf("a").dispose.resolve(); await h.closed(a.runId);
  await h.call("head_finish", { status: "failed", diagnostic: "Investigation inconclusive", evidence: [], limits: ["No integration"] });
  await h.settle();
  const metrics = h.outcome(admission.details.instanceId).head!.metrics;
  expect(metrics.ownUsage).toMatchObject({ input: 10, output: 5 });
  expect(metrics.ownUsage?.cost).toBeUndefined();
  expect(metrics.classifierUsage).toHaveLength(1);
  expect(metrics.classifierUsage[0].usage).toBeNull();
  expect(metrics.aggregateUsage).toBeUndefined();
  expect(metrics.aggregateClassifierUsage).toEqual({});
  expect(metrics.usageComplete).toBe(false);
  expect(h.counts().classifications).toBe(1);
}));

for (const final of ["error", "aborted"] as const) {
  test(`native ${final} after head_finish cannot become integrated success`, fixture.ownedCase(`Head ${final} final`, async () => {
    const h = await harness({ final });
    const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: [], task: "read only" });
    await h.headEntered.promise;
    const barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
    await h.call("bash", { command: "true" });
    const verification = (await h.read()).verificationCandidates.map((entry: any) => entry.entryId);
    await h.call("head_finish", { status: "completed", epoch: barrier.epoch, summary: "Candidate", verification, limits: [] });
    await h.settle();
    const result = h.outcome(admission.details.instanceId);
    expect(result.status).not.toBe("completed");
    expect(result.head!.finish.status).toBe("failed");
  }));
}

test("invalid final joins children before returning complete diagnostic closure", fixture.ownedCase("Head implicit failure closure", async () => {
  const h = await harness();
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["."], task: "premature final" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "edit", expectedRevision: 0, nodes: [node("a")], supersede: [] });
  const [a] = await h.call("head_start", { expectedRevision: (await h.read()).revision, nodeIds: ["a"] });
  await h.leaf("a").entered.promise;
  let returned = false;
  const settling = h.settle().then(() => { returned = true; });
  await h.leaf("a").disposing.promise;
  expect(returned).toBe(false);
  h.leaf("a").dispose.resolve(); await settling;
  const result = h.outcome(admission.details.instanceId);
  expect(result.status).toBe("failed");
  expect(result.head!.leaves[0]).toMatchObject({ runId: a.runId, closure: { state: "released" } });
}));

test("failed finish joins physical child disposal; another exterior worker keeps progressing", fixture.ownedCase("Head diagnostic closure", async () => {
  const h = await harness();
  const ordinary = await h.callPublic("agent_spawn", { role: "researcher", task: "independent" });
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["."], task: "failure" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "edit", expectedRevision: 0, nodes: [node("a")], supersede: [] });
  const [a] = await h.call("head_start", { expectedRevision: (await h.read()).revision, nodeIds: ["a"] });
  await h.leaf("a").entered.promise;
  let returned = false;
  const failing = h.call("head_finish", { status: "failed", diagnostic: "Cannot meet bounded contract",
    evidence: ["observed contradiction"], limits: ["No integrated verification"] }).then(value => { returned = true; return value; });
  await h.leaf("a").disposing.promise;
  expect(returned).toBe(false);
  expect(h.outcome(ordinary.details.instanceId).status).toBe("completed");
  h.leaf("a").dispose.resolve(); await failing; await h.settle();
  const result = h.outcome(admission.details.instanceId);
  expect(result.status).toBe("failed");
  expect(result.head!.finish).toMatchObject({ diagnostic: "Cannot meet bounded contract", evidence: ["observed contradiction"] });
  expect(result.head!.leaves[0]).toMatchObject({ runId: a.runId, closure: { state: "released" } });
}));

test("cancelled public Head cannot finish successfully and waits for its own child", fixture.ownedCase("public Head cancellation", async () => {
  const h = await harness({ final: "aborted" });
  const admission = await h.callPublic("team_assign", { role: "developer", mode: "head", writes: ["."], task: "cancel" });
  await h.headEntered.promise;
  await h.call("head_plan", { action: "edit", expectedRevision: 0, nodes: [node("a")], supersede: [] });
  await h.call("head_start", { expectedRevision: (await h.read()).revision, nodeIds: ["a"] });
  await h.leaf("a").entered.promise;
  let retired = false;
  const retirement = retireTeamEvaluation(h.evaluation).then(() => { retired = true; });
  await h.leaf("a").disposing.promise;
  expect(retired).toBe(false);
  h.leaf("a").dispose.resolve(); await retirement; await fixture.settleRuns();
  expect(h.headSession().events).toContain("abort");
  expect(h.headSession().events).toContain("dispose");
  expect(h.leaf("a").session.events).toContain("dispose");
  expect(firstTeamReservation(h.evaluation, "developer")).toBeUndefined();
  expect(() => h.outcome(admission.details.instanceId, true)).toThrow("unknown Team worker");
}));

test("accepted no-worker consultation fences initial Head prompt replay", fixture.ownedCase("consultation replay fence", async () => {
  const h = await harness({ headFallback: true, final: "error", finalError: "HTTP 429 too many requests" });
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: [], task: "Dispatch once" });
  await h.headEntered.promise;
  const handle = await h.call("head_consult", { role: "oracle", task: "missing policy" });
  expect((await h.closed(handle.childId)).envelope.outcome).toBe("no-worker");
  await h.settle();
  expect(h.outcome(admission.details.instanceId).status).toBe("failed");
  expect(h.host.sessions).toHaveLength(1);
  expect(h.host.sessions[0].prompts.filter(task => task.includes("Dispatch once"))).toHaveLength(1);
  expect(h.workers.sessions).toHaveLength(0);
}));

test("outer cancellation joins consultation disposal and records drop on the Head caller", fixture.ownedCase("consultation disposal cancellation", async () => {
  const h = await harness();
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: [], task: "cancel disposal" });
  await h.headEntered.promise;
  const handle = await h.call("head_consult", { role: "researcher", task: "disposing-advice" });
  const advice = h.leaf("disposing-advice");
  await advice.entered.promise;
  advice.done.resolve();
  await advice.disposing.promise;
  await h.callPublic("agent_cancel", { id: admission.details.instanceId });
  await h.headAborted.promise;
  let finished = false;
  const settling = h.settle().then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  advice.dispose.resolve();
  await settling;
  expect(h.outcome(admission.details.instanceId).status).toBe("cancelled");
  const stats = await consultationStats(h.ctx.sessionManager.getSessionId(), handle.dispatchId, h.root);
  expect(stats.rows).toContainEqual(expect.objectContaining({ dispatchId: handle.dispatchId, events: expect.arrayContaining([expect.objectContaining({ event: "delivery", data: { state: "dropped" } })]) }));
  expect(h.workers.sessions).toHaveLength(1);
}));


test("Head classify and voluntary feedback cross SDK-managed history, exact branch receipts and authorized followups", fixture.ownedCase("Head reasoning feedback", async () => {
  const h = await harness(), entered = gate(), release = gate();
  fixture.finishOnCleanup(() => release.resolve());
  const requests: any[] = [];
  h.ctx.modelRegistry.classify = (async (_model: any, request: any, options: any) => {
    expect(options.maxRetries).toBe(0); requests.push(request); entered.resolve(); await release.promise;
    return { api: "fixture", provider: "fixture", model: "classifier", timestamp: 1, stopReason: "stop", answers: { reasoning: {
      type: "choice", choice: "high", confidence: 0.9,
      probabilities: Object.fromEntries(Object.keys(request.questions.reasoning.criteria).map(key => [key, key === "high" ? 0.9 : 0.01])),
    } }, usage: { input: 5, output: 1, totalTokens: 6 } };
  }) as any;
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: [], task: "Head T3" });
  await h.headEntered.promise;
  const handle = await h.call("head_consult", { role: "researcher", task: "classified", reasoning: { mode: "classify" } });
  expect(requests).toEqual([]); expect(h.workers.sessions).toEqual([]);
  await entered.promise;
  expect((await h.call("head_result", { childId: handle.childId })).phase).toBe("preflight");
  expect(requests[0].questions).not.toHaveProperty("capacity");
  release.resolve(); await h.leaf("classified").entered.promise;
  expect(h.leaf("classified").session.thinkingLevel).toBe("high");
  h.leaf("classified").done.resolve(); h.leaf("classified").dispose.resolve(); await h.closed(handle.childId);
  const feedback = { dispatchId: handle.dispatchId, usefulness: "used" };
  await expect(h.call("consultation_feedback", feedback)).rejects.toThrow(); // getter/completion are not receipt
  const manager = h.headSession().sessionManager;
  const before = manager.getLeafId();
  let offered: AgentBeforeSettleEventResult | undefined;
  for (const hook of h.headLocal().events.get("agent_before_settle") ?? []) offered = await hook({ outcome: "completed", context: { canContinue: true } }) ?? offered;
  await expect(h.call("consultation_feedback", feedback)).rejects.toThrow(); // offered/draft is not receipt
  for (const entry of offered!.entries!) if (entry.type === "custom_message") manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  expect(await h.call("consultation_feedback", feedback)).toMatchObject({ usefulness: "used", author: { callerSessionId: h.headSession().sessionId } });
  const after = manager.getLeafId(); manager.branch(before!);
  await expect(h.call("consultation_feedback", feedback)).rejects.toThrow();
  manager.branch(after!);
  await h.call("head_plan", { action: "edit", expectedRevision: 0, nodes: [node("follow", [])], supersede: [] });
  const [follow] = await h.call("head_start", { expectedRevision: 1, nodeIds: ["follow"] });
  await h.leaf("follow").entered.promise; h.leaf("follow").done.resolve(); h.leaf("follow").dispose.resolve(); const followClosed = await h.closed(follow.runId);
  const followId = followClosed.envelope.result.instanceId;
  for (const followupInstances of [["fabricated"], [admission.details.instanceId], [followId, followId]])
    await expect(h.call("consultation_feedback", { ...feedback, followupInstances })).rejects.toThrow();
  await h.call("consultation_feedback", { ...feedback, usefulness: "partial", followupInstances: [followId] });
  const store = new WorkerHistory(), linked = store.list().find(group => group.consultations?.some(locator => locator.dispatchId === handle.dispatchId))!;
  const filler = store.createGroup(h.root);
  for (let i = 0; i < 201; i++) {
    const groupId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    writeFileSync(path.join(store.catalogDir, `${groupId}.json`), JSON.stringify({ ...filler, groupId }));
  }
  expect(store.list().findIndex(group => group.members.some(member => member.instanceId === followId))).toBeGreaterThan(200);
  const foreign = store.admit(filler.groupId, { roleId: "developer", instanceId: "foreign-followup", coordinatorSessionId: "foreign", head: { assignmentId: "foreign", headInstanceId: "foreign" } });
  for (const followupInstances of [[foreign.instanceId], ["fabricated"], [admission.details.instanceId], [followId, followId]])
    await expect(h.call("consultation_feedback", { ...feedback, followupInstances })).rejects.toThrow();
  expect(await h.call("consultation_feedback", { ...feedback, usefulness: "partial", note: "large catalog", followupInstances: [followId] })).toMatchObject({ followupInstances: [followId] });
  store.mutate(linked.groupId, group => { group.consultations!.push({ ...group.consultations![0]!, dispatchId: "ffffffff-ffff-4fff-8fff-ffffffffffff", followupInstances: [followId] }); });
  await expect(h.call("consultation_feedback", { ...feedback, followupInstances: [followId] })).rejects.toThrow("already linked");
  await h.call("head_finish", { status: "failed", diagnostic: "Controlled observation complete", evidence: [], limits: ["No product change"] });
  await h.settle();
  const coordinatorSessionId = h.ctx.sessionManager.getSessionId();
  const chunks: Buffer[] = [];
  let cursor: string | undefined;
  do {
    const persisted = await queryHistory({ action: "read", dispatchId: handle.dispatchId, groupId: linked.groupId, source: "caller", cursor, limit: 200 }, coordinatorSessionId, h.root);
    expect(persisted.diagnostics.some(item => item.code === "native_physical_order")).toBe(true);
    chunks.push(...persisted.items.map((item: any) => Buffer.from(item.data, "base64")));
    cursor = persisted.cursor ?? undefined;
  } while (cursor);
  const entries = Buffer.concat(chunks).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(entries.filter(entry => entry.data?.event === "feedback")).toHaveLength(3);
  expect(entries.filter(entry => entry.data?.event === "feedback").at(-1).data.data).toMatchObject({
    note: "large catalog", followupInstances: [followId], author: { callerSessionId: h.headSession().sessionId },
  });
  // The targeted reader above observes the large catalog. Keep the existing bounded stats check separate.
  for (let i = 0; i < 201; i++) unlinkSync(path.join(store.catalogDir, `00000000-0000-4000-8000-${String(i).padStart(12, "0")}.json`));
  const stats = await consultationStats(coordinatorSessionId, handle.dispatchId, h.root);
  const row = stats.rows[0] as any;
  expect(row.classifier).toMatchObject({ usage: { input: 5, output: 1 } });
  expect(row.attempts).toHaveLength(1); expect(row.attempts[0].usage).toMatchObject({ input: 2, output: 1 });
  expect(row.followups).toHaveLength(1); expect(row.followups[0].usage).toMatchObject({ input: 2, output: 1 });
  expect(row.latestFeedback.data).toMatchObject({ usefulness: "partial", followupInstances: [followId] });
  expect(row.events.filter((event: any) => event.event === "feedback")).toHaveLength(3);
  expect(h.outcome(admission.details.instanceId).head!.metrics).toMatchObject({ combinedTotal: null, usageComplete: false,
    classifierUsage: [expect.objectContaining({ dispatchId: handle.dispatchId, usage: { input: 5, output: 1, totalTokens: 6 } })],
    consultations: [expect.objectContaining({ dispatchId: handle.dispatchId })] });
}));


for (const stage of ["discovery", "classify"] as const) test(`Head cancellation joins held ${stage} without worker admission`, fixture.ownedCase("Head held " + stage, async () => {
  const h = await harness(), entered = gate(), release = gate();
  fixture.finishOnCleanup(() => release.resolve());
  h.ctx.modelRegistry.getAvailableOfType = (async () => {
    if (stage === "discovery") { entered.resolve(); await release.promise; }
    return [{ provider: "fixture", id: "classifier", contextWindow: 100000 }];
  }) as any;
  h.ctx.modelRegistry.classify = (async (_model: any, request: any) => {
    if (stage === "classify") { entered.resolve(); await release.promise; }
    return { stopReason: "stop", answers: { reasoning: { type: "choice", choice: "high", confidence: 1,
      probabilities: Object.fromEntries(Object.keys(request.questions.reasoning.criteria).map(key => [key, key === "high" ? 1 : 0])) } } };
  }) as any;
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: [], task: "cancel held advice" });
  await h.headEntered.promise;
  await h.call("head_consult", { role: "researcher", task: "held", reasoning: { mode: "classify" } });
  await entered.promise;
  await h.callPublic("agent_cancel", { id: admission.details.instanceId }); await h.headAborted.promise;
  let settled = false; const settling = h.settle().then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false); expect(h.workers.sessions).toHaveLength(0);
  release.resolve(); await settling;
  expect(h.workers.sessions).toHaveLength(0); expect(h.outcome(admission.details.instanceId).status).toBe("cancelled");
}));

const verificationGrant = { durationMs: 15000, captureBytes: 65536, invocations: 3, artifactRoots: [], scratchRoots: ["scratch"] };
test("granted admitted Head waits interruptibly, receives native failed gate and corrects in the SAME one-shot", fixture.ownedCase("owned gate early decisive route", async () => {
  const boundaryEntered = gate(), steeringContinuation = gate(), requestNext = gate(), finished = gate();
  let first: any, second: any, epoch: string, receipt: string, native: string | undefined;
  const delivered: any[] = [];
  const h = await harness({ gitRepository: true, separateAgentDir: true,
    seed(root) {
      writeFileSync(path.join(root, "GATES.md"), "# Checks\nRun the local selected shell. Manually review stdout and stderr.\n");
      mkdirSync(path.join(root, "scratch")); execFileSync("mkfifo", [path.join(root, "scratch/release")]);
    },
    afterText: async (session, local) => {
      // SDK boundary double controls only the event, native commit, and legal continuation.
      // The subprocess/outcome/capture are produced by the real host tool.
      const beforeSettle = async () => {
        let offered: any;
        boundaryEntered.resolve();
        for (const hook of local.events.get("agent_before_settle") ?? []) offered = await hook({ outcome: "completed", context: { canContinue: false } }) ?? offered;
        if (offered?.entries) for (const e of offered.entries) {
          const id = session.sessionManager.appendCustomMessageEntry(e.customType, e.content, e.display, e.details);
          delivered.push({ id, ...e });
        }
        return offered;
      };
      native = session.sessionId;
      const steering = await beforeSettle();
      expect(steering).toEqual({ continue: true }); // no result exists yet
      steeringContinuation.resolve();
      expect((await beforeSettle())?.continue).toBe(true);
      const failed = delivered.find(e => e.customType === "pitako.head.gates");
      first = JSON.parse(failed.content);
      expect(first).toMatchObject({ outcome: "failed", closure: "released", complete: false, commands: [{ exitCode: 7 }] });
      expect(first.commands[0].artifacts).toEqual(["0-stdout", "0-stderr"]);
      expect((await h.call("head_gates", { action: "read", runId: first.runId, artifact: "0-stdout" })).text).toBe("local stdout\n");
      expect((await h.call("head_gates", { action: "read", runId: first.runId, artifact: "0-stderr" })).text).toBe("local stderr\n");
      await h.call("write", { path: "product.md", content: "authorized correction\n" });
      const handle = await h.call("head_gates", { action: "request", epoch, expectedRevision: 0, coverage: "Check corrected Markdown; manual review remains", commands: [{ id: "corrected", shell: "test -f product.md && printf 'corrected pass\\n'", cwd: ".", env: {}, timeoutMs: 3000 }] });
      expect(handle.state).toBe("preparing");
      requestNext.resolve();
      expect((await beforeSettle())?.continue).toBe(true);
      second = JSON.parse(delivered.filter(e => e.customType === "pitako.head.gates").at(-1).content);
      expect(second).toMatchObject({ outcome: "passed", closure: "released", complete: true, stale: false });
      expect(second.candidate).not.toEqual(first.candidate);
      expect(second.runId).not.toBe(first.runId);
      expect(session.sessionId).toBe(native);
      const candidates = (await h.read()).verificationCandidates;
      const proof = candidates.find((c: any) => c.kind === "owned-gates");
      receipt = proof.entryId;
      expect(proof.runId).toBe(second.runId);
      await h.call("head_finish", { status: "completed", epoch, summary: "Selected gates passed after correction", verification: [receipt], limits: ["Manual review is not automated"] });
      finished.resolve();
    },
  });
  const admitted = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["product.md"], verification: verificationGrant, task: "owned gates" });
  await h.headEntered.promise;
  expect(h.headSession().active).toContain("head_gates");
  epoch = (await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 })).epoch;
  const handle = await h.call("head_gates", { action: "request", epoch, expectedRevision: 0, coverage: "Run failing local stdout/stderr selection; manual review unrun", commands: [{ id: "fails", shell: "printf 'local stdout\\n'; printf 'local stderr\\n' >&2; read -r release < scratch/release; exit 7", cwd: ".", env: {}, timeoutMs: 5000 }] });
  expect(handle.state).toBe("preparing");
  expect((await h.call("head_gates", { action: "status", runId: handle.runId })).phase).toBe("preparing");
  h.headDone.resolve(); await boundaryEntered.promise;
  const target = { kind: "background", instanceId: admitted.details.instanceId };
  const observed = (await h.callPublic("agent_observe", { target })).details;
  const input = await h.callPublic("agent_input", { target, historyId: observed.historyId, sessionId: observed.sessionId, intent: "steer", text: "Retain the failed outcome, then correct inside writes and run again" });
  expect(input.details.status).toBe("queued");
  await steeringContinuation.promise;
  expect(delivered).toEqual([]); // queued woke the wait BEFORE gate completion
  await writeFile(path.join(h.root, "scratch/release"), "release\n");
  await requestNext.promise; await finished.promise; await h.settle();
  expect(h.host.sessions).toHaveLength(1);
  expect(h.outcome(admitted.details.instanceId)?.status).toBe("completed");
  expect(receipt!).toBeTruthy();
  expect(native).toBeString();
  console.log("Observed early gate route identities: " + JSON.stringify({ native, receipt: receipt!,
    first: { runId: first.runId, deliveryId: first.deliveryId, candidate: first.candidate },
    second: { runId: second.runId, deliveryId: second.deliveryId, candidate: second.candidate } }));
}));

for (const final of ["stop", "aborted"] as const) test(`gate receipt never overrides final SDK ${final} without legal continuation`, fixture.ownedCase("gate SDK final " + final, async () => {
  let retained: any;
  const h = await harness({ final, separateAgentDir: true,
    seed(root) { writeFileSync(path.join(root, "GATES.md"), "# Checks\nVerify this Markdown guide exists; manual review remains.\n"); },
    afterText: async (session, local) => {
      let offered: any;
      for (const hook of local.events.get("agent_before_settle") ?? []) offered = await hook({ outcome: "completed", context: { canContinue: false } }) ?? offered;
      expect(offered.continue).toBe(true);
      for (const entry of offered.entries) {
        const id = session.sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
        retained = { id, ...JSON.parse(entry.content) };
      }
      // The SDK boundary double commits but refuses the requested continuation (or aborts).
      // No Head finish and no replacement prompt/session may manufacture success.
    } });
  const admitted = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: [], verification: verificationGrant, task: "SDK final boundary" });
  await h.headEntered.promise;
  const barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  await h.call("head_gates", { action: "request", epoch: barrier.epoch, expectedRevision: 0, coverage: "Markdown guide prerequisite; manual review unrun",
    commands: [{ id: "guide", shell: "test -s GATES.md", cwd: ".", env: {}, timeoutMs: 3000 }] });
  h.headDone.resolve(); await h.settle();
  expect(retained).toMatchObject({ outcome: "passed", closure: "released", complete: true });
  expect(h.outcome(admitted.details.instanceId)).toMatchObject({ status: "failed", head: { finish: { status: "failed" } } });
  expect(h.headSession().messages.at(-1).stopReason).toBe(final);
  expect(h.host.sessions).toHaveLength(1);
  expect(h.headSession().prompts).toHaveLength(1);
  expect(h.headSession().sessionManager.getBranch().some((entry: any) => entry.id === retained.id)).toBe(true);
}));

test("verification is exterior async Developer Head authority, never ordinary role or implicit capability", fixture.ownedCase("gate grant admission", async () => {
  const h = await harness();
  for (const params of [{ role: "reviewer", mode: "head", writes: [] }, { role: "developer", mode: "single" },
    { role: "scout" }, { role: "developer_head", mode: "head", writes: [] }]) {
    const refused = await h.callPublic("agent_spawn", { ...params, verification: verificationGrant, task: "must refuse" });
    expect(refused.isError).toBe(true);
  }
  for (const field of ["durationMs", "captureBytes", "invocations"]) {
    const refused = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: [], task: "must refuse",
      verification: { ...verificationGrant, [field]: 0 } });
    expect(refused.isError).toBe(true);
  }
  const admitted = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: [], task: "no grant" });
  await h.headEntered.promise;
  expect(h.headSession().active).not.toContain("head_gates");
  await h.call("head_finish", { status: "failed", diagnostic: "No grant, ordinary Head preserved", evidence: [], limits: [] });
  await h.settle(); expect(h.outcome(admitted.details.instanceId).status).toBe("failed");
}));


const unknownPrincipalCase = "unknown principal writer blocks Head lifecycle and second admission without blocking disjoint roots";
test(unknownPrincipalCase, fixture.ownedCase("unknown principal Head barrier", async () => {
  const phase = process.env.PITAKO_UNKNOWN_HEAD_HOST;
  if (!phase) {
    for (const phase of ["open", "integration"]) console.log(execFileSync(process.execPath, ["test", import.meta.path, "--test-name-pattern", `^${unknownPrincipalCase}$`], {
      env: { ...process.env, PITAKO_UNKNOWN_HEAD_HOST: phase, BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" }, encoding: "utf8",
      // Show child diagnostics while it runs, not only after execFileSync returns.
      stdio: ["pipe", "pipe", "inherit"],
    }));
    return;
  }
  const h = await harness({ gitRepository: true });
  await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["work"], task: "retain principal barrier" });
  await h.headEntered.promise;
  const barrier = phase === "integration" ? await h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 }) : undefined;
  if (barrier) await h.call("bash", { command: "printf valid-verification" });
  const verification = (await h.read()).verificationCandidates.map((entry: any) => entry.entryId);
  const principal = await bind([pi => principalLeases(pi, { async exec() {
    throw new AgentClosureError([new Error("controlled group observation failure")], "principal fixture");
  } })], () => {});
  const unsupported = reserveOperation(undefined, "writer");
  const hook = await principal.events.get("user_bash")![0]!({}, h.ctx);
  await expect(hook.operations.exec("controlled", h.root, { onData() {} })).rejects.toThrow("closure");
  const admission = await h.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["work"], task: "must be fenced" });
  expect(admission.isError).toBe(true);
  expect(JSON.stringify(admission)).toContain("unknown");
  expect(h.counts().starts).toBe(1);
  if (barrier) {
    await expect(h.call("head_plan", { action: "reopen", epoch: barrier.epoch })).rejects.toThrow("unknown");
    await expect(h.call("head_finish", { status: "completed", epoch: barrier.epoch, summary: "must be fenced", verification, limits: [] })).rejects.toThrow("unknown");
  } else await expect(h.call("head_plan", { action: "beginIntegration", expectedRevision: 0 })).rejects.toThrow("unknown");
  await expect(h.call("write", { path: "work/forbidden", content: "no" })).rejects.toThrow("unknown");
  expect(existsSync(path.join(h.root, "work/forbidden"))).toBe(false);
  const saving = await h.call("head_checkpoint", { action: "create", expectedRevision: 0, paths: ["work/forbidden"], summary: "no", remaining: [], limits: [], evidence: [] }).catch(error => error);
  expect(JSON.stringify(saving) + String(saving)).toContain("unknown");
  expect(listCheckpoints(h.root)).toHaveLength(0);
  expect(() => reserveOperation(h.root, "gates")).toThrow("unknown");
  // Failure can still join owned work. No synthetic observation error created a process.
  await h.call("head_finish", { status: "failed", diagnostic: "Unknown principal remains fenced", evidence: [], limits: [] });
  await h.settle();
  const other = await harness({ gitRepository: true });
  await other.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["independent"], task: "disjoint progress" });
  await other.headEntered.promise;
  const independentBarrier = await other.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  await other.call("write", { path: "independent", content: "legal" });
  await other.call("head_plan", { action: "reopen", epoch: independentBarrier.epoch });
  const finalBarrier = await other.call("head_plan", { action: "beginIntegration", expectedRevision: 0 });
  await other.call("bash", { command: "printf independent" });
  const independentVerification = (await other.read()).verificationCandidates.map((entry: any) => entry.entryId);
  await other.call("head_finish", { status: "completed", epoch: finalBarrier.epoch, summary: "disjoint root remains usable", verification: independentVerification, limits: [] });
  await other.settle();
  // An unsupported composition has no proven root. Retention must fence even
  // otherwise-disjoint admissions; do not erase global state to isolate this case.
  unsupported.unknown(""); unsupported.release();
  expect(() => reserveOperation(other.root, "writer")).toThrow("unknown");
  expect(() => reserveOperation(undefined, "writer")).toThrow("unknown");
  await expect(hook.operations.exec("blocked disjoint executor", other.root, { onData() {} })).rejects.toThrow("unknown");
  const unscopedAdmission = await other.callPublic("agent_spawn", { role: "developer", mode: "head", writes: ["independent"], task: "unscoped writer fences every root" });
  expect(unscopedAdmission.isError).toBe(true);
  expect(JSON.stringify(unscopedAdmission)).toContain("unknown");
  expect(other.counts().starts).toBe(1);
}));
