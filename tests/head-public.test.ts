import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodingTools, type AgentBeforeSettleEventResult, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import agentExtension from "../extensions/agent/index.ts";
import { bindBackgroundOwner, clearBackgroundOwner, setBackgroundExecutor, workerResult, teamWorkerResult } from "../extensions/agent/background.ts";
import { beginTeamEvaluation, retireTeamEvaluation, teamRoleReservation } from "../extensions/team.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import { controlledPi } from "./fixtures/pi-factories.ts";

const fixture = agentFixtureOwnership();
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

async function harness(options: { headPolicy?: boolean; final?: "stop" | "error" | "aborted"; missingCost?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-head-public-"));
  fixture.directories.push(root);
  process.env.PI_CODING_AGENT_DIR = root;
  const configFile = path.join(root, "pitako/config.toml");
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
[head_developer]
max_parallel = 3
[developer_routing]
classifier_provider = "fixture"
classifier_model = "classifier"
`);
  const headEntered = gate(), headDone = gate();
  const leaves = new Map<string, { entered: ReturnType<typeof gate>; done: ReturnType<typeof gate>;
    disposing: ReturnType<typeof gate>; dispose: ReturnType<typeof gate>; local?: Local; session?: any; task?: string }>();
  const leaf = (id: string) => {
    if (!leaves.has(id)) leaves.set(id, { entered: gate(), done: gate(), disposing: gate(), dispose: gate() });
    return leaves.get(id)!;
  };
  let headLocal!: Local, headSession: any;
  const locals = new Map<object, Local>();
  let classifications = 0;
  const modelRegistry = { getAvailableOfType: async () => [{ provider: "fixture", id: "classifier", contextWindow: 100000 }],
    classify: async () => { classifications++; return { stopReason: "stop", answers: { capacity: {
      type: "choice", choice: "developer_mid", probabilities: { developer_mid: 0.9, developer_senior: 0.1, developer_junior: 0, indeterminate: 0 },
    } } }; } };
  const publicSessionId = `owner-${path.basename(root)}`;
  const ctx = { cwd: root, sessionManager: { getSessionId: () => publicSessionId }, modelRegistry } as unknown as ExtensionContext;
  const evaluation = beginTeamEvaluation(publicSessionId, false)!;
  const delivery: any[] = [];
  bindBackgroundOwner({ token: Symbol(publicSessionId), sessionId: publicSessionId, isIdle: () => false,
    hasUI: false, notify() {}, sendMessage() {}, appendResult(message) { delivery.push({ type: "custom_message", ...message }); },
    getBranch: () => delivery });
  const headCtx = () => ({ ...ctx, sessionManager: headSession.sessionManager }) as ExtensionContext;
  const host = controlledPi(root, {
    bind: async session => {
      headSession = session;
      if (options.missingCost) Object.assign(session.stats, { cost: undefined });
      headLocal = await bind(host.loaderInputs[host.sessions.indexOf(session)].extensionFactories,
        (type, data) => { session.sessionManager.appendCustomEntry(type, data); });
      for (const tool of createCodingTools(root)) headLocal.tools.set(tool.name, tool);
      session.getAllTools = () => [...headLocal.tools.keys(), "agent_spawn", "team_assign"].map(name => ({ name }));
    },
    prompt: async session => {
      headEntered.resolve();
      await headDone.promise;
      Object.assign(session.stats, {
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: options.missingCost ? undefined : 0.01, assistantMessages: 1,
      });
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "unexamined final" }],
        stopReason: options.final ?? "stop", errorMessage: options.final === "error" ? "controlled failure" : undefined };
      session.messages.push(message);
      session.sessionManager.appendMessage(message as never);
    },
    abort: () => { headDone.resolve(); },
  });
  const workers = controlledPi(root, {
    bind: async session => {
      const local = await bind(workers.loaderInputs[workers.sessions.indexOf(session)].extensionFactories,
        (type, data) => { session.sessionManager.appendCustomEntry(type, data); });
      locals.set(session, local);
      (session as any).steer = async () => "queued";
      session.getAllTools = () => ["read", "bash", "agent_spawn", "team_assign", ...local.tools.keys()].map(name => ({ name }));
    },
    prompt: async (session, task) => {
      const id = JSON.parse(task).brief.split(" ").at(-1);
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
  const hostExecutor = createPiExecutor({ factories: host.factories }), leafExecutor = createPiExecutor({ factories: workers.factories });
  let starts = 0, leafStarts = 0;
  setBackgroundExecutor({ capturesHistory: true, start(input) {
    starts++;
    if (input.scope) leafStarts++;
    return input.head ? hostExecutor.start(input) : input.scope ? leafExecutor.start(input)
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
  const callPublic = (tool: string, params: unknown) => publicLocal.tools.get(tool).execute(`public-${tool}`, params, undefined, undefined, ctx);
  const call = async (name: string, params: unknown) => {
    for (const hook of headLocal.events.get("tool_call") ?? []) {
      const result = await hook({ toolName: name, toolCallId: name, input: params }, headCtx());
      if (result?.block) throw Error(result.reason);
    }
    headSession.emit({ type: "tool_execution_start", toolName: name, toolCallId: name });
    try {
      const result = await headLocal.tools.get(name).execute(name, params, undefined, undefined, headCtx());
      headSession.sessionManager.appendMessage({ role: "toolResult", toolName: name, toolCallId: name,
        content: result.content, details: result.details, isError: false, timestamp: Date.now() });
      return result.details;
    } finally { headSession.emit({ type: "tool_execution_end", toolName: name, toolCallId: name }); }
  };
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
  const settle = async () => { headDone.resolve(); await fixture.settleRuns(); };
  return { root, evaluation, ctx, leaf, host, workers, headEntered, callPublic, call, read, closed, settle,
    delivery, headLocal: () => headLocal, headSession: () => headSession,
    counts: () => ({ starts, leafStarts, classifications }),
    outcome: (id: string, team = false) => team ? teamWorkerResult(evaluation.token, id) : workerResult(id) };
}

test("public modes reject before effects and preserve ordinary routes", fixture.ownedCase("public mode admission", async () => {
  const h = await harness({ headPolicy: false });
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
  ]) {
    for (const tool of ["agent_spawn", "team_assign"]) expect((await h.callPublic(tool, { ...params, task: "invalid" })).isError).toBe(true);
  }
  expect((await h.callPublic("agent_run", { role: "developer", task: "sync", mode: "head", writes: [] })).isError).toBe(true);
  expect(h.counts()).toEqual({ starts: 0, leafStarts: 0, classifications: 0 });
  expect(teamRoleReservation(h.evaluation, "developer")).toBeUndefined();
  const developer = await h.callPublic("agent_spawn", { role: "developer", task: "ordinary" });
  const researcher = await h.callPublic("team_assign", { role: "researcher", task: "ordinary" });
  expect(developer.isError).not.toBe(true); expect(researcher.isError).not.toBe(true);
  await fixture.settleRuns();
  expect(h.outcome(developer.details.instanceId).head).toBeUndefined();
  expect(h.outcome(researcher.details.instanceId, true).head).toBeUndefined();
  expect(h.counts().starts).toBe(2);
}));

test("public Team Head completes direct product work with no leaves through the exclusive barrier", fixture.ownedCase("public no-leaf Head", async () => {
  const h = await harness();
  const admission = await h.callPublic("team_assign", {
    role: "developer", mode: "head", writes: ["direct.txt"], task: "Implement and check direct product work",
  });
  expect(admission.isError).not.toBe(true);
  await h.headEntered.promise;
  expect(teamRoleReservation(h.evaluation, "developer")).toBe(admission.details.id);
  const initial = await h.read();
  expect(initial.nodes).toEqual([]);
  await expect(h.call("write", { path: "direct.txt", content: "premature\n" })).rejects.toThrow("exclusive integration barrier");
  const barrier = await h.call("head_plan", { action: "beginIntegration", expectedRevision: initial.revision });
  await h.call("write", { path: "direct.txt", content: "direct\n" });
  await h.call("bash", { command: 'test "$(cat direct.txt)" = direct' });
  const checked = h.headSession().sessionManager.getLeafId();
  const candidates = (await h.read()).verificationCandidates;
  expect(candidates).toContainEqual({ entryId: checked, toolCallId: "bash", toolName: "bash" });
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
    metrics: {
      ownUsage: result.usage,
      aggregateUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.01, turns: 1, toolCalls: 0 },
      aggregateClassifierUsage: undefined,
      usageComplete: true, classifierUsage: [], elapsedMs: expect.any(Number), observedPeakParallelism: 0,
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
  expect(teamRoleReservation(h.evaluation, "developer")).toBe(admission.details.id);
  expect(h.headSession().active).toContain("head_finish");
  expect(h.headSession().active).not.toContain("agent_spawn");
  await expect(h.call("bash", { command: "touch forbidden" })).rejects.toThrow("exclusive integration barrier");
  await h.call("head_plan", { action: "edit", expectedRevision: 0, nodes: [node("a", ["shared"]), node("b")], supersede: [] });
  const [a, b] = await h.call("head_start", { expectedRevision: (await h.read()).revision, nodeIds: ["a", "b"] });
  await Promise.all([h.leaf("a").entered.promise, h.leaf("b").entered.promise]);
  expect(h.workers.sessions.every(session => !session.events.includes("dispose"))).toBe(true);
  expect(h.leaf("a").task).not.toContain("PARENT SECRET");
  expect([...h.leaf("a").local!.tools.keys()]).toEqual(["head_scope_ack"]);
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
  expect(result.head!.metrics).toMatchObject({ ownUsage: { input: 10, output: 5 }, aggregateUsage: { input: 16, output: 8 },
    usageComplete: true, observedPeakParallelism: 2, classifierUsage: [] });
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
  const first = await boundary(event), replay = await boundary(event);
  const envelope = first?.entries?.find(entry => entry.type === "custom_message" && entry.customType === "pitako.head.result");
  const repeated = replay?.entries?.find(entry => entry.type === "custom_message" && entry.customType === "pitako.head.result");
  if (envelope?.type !== "custom_message" || repeated?.type !== "custom_message" || typeof envelope.content !== "string") {
    throw Error("Expected full native Head result offers");
  }
  expect(repeated.details).toMatchObject({ envelopeId: JSON.parse(envelope.content).envelopeId,
    deliveryGap: expect.stringContaining("Prior offer") });
  h.headSession().sessionManager.appendCustomMessageEntry(envelope.customType, envelope.content, true, envelope.details);
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
  expect(teamRoleReservation(h.evaluation, "developer")).toBeUndefined();
  expect(() => h.outcome(admission.details.instanceId, true)).toThrow("unknown Team worker");
}));
