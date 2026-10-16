import { stubExternalFactories } from "./fixtures/offline.ts";
stubExternalFactories();
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import agentExtension from "../extensions/agent/index.ts";
import {
  bindBackgroundOwner, cancelWorker, clearBackgroundOwner, readWorkerResult,
  deliverWorkerResults, observeWorkerResults, revokeBackgroundOwner, settleWorkerResults, spawnBackground,
  type BackgroundOwner, type LiveTarget, type ResultMessage, type WorkerReadScope, type WorkerResultRead,
} from "../extensions/agent/background.ts";
import { listObservations } from "../extensions/agent/observe.ts";
import { createAgentController } from "../extensions/agent/controller.ts";
import type { AgentRunResult, Attempt, AttemptExecutor } from "../extensions/agent/run.ts";
import {
  beginTeamEvaluation, recordPlanTeamWork, recordTeamAssignment, reserveTeamMember,
  retireTeamEvaluation, teamAssignments, firstTeamReservation, type TeamEvaluation,
} from "../extensions/team.ts";
import { ledgerFile, planFile, planHash, readLedgerTeamHolds } from "../extensions/workflow.ts";

const fixture = agentFixtureOwnership();
const evaluations: TeamEvaluation[] = [];
afterEach(async () => {
  fixture.requireReleasedFixture();
  for (const evaluation of evaluations.splice(0)) await retireTeamEvaluation(evaluation);
  clearBackgroundOwner();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function setup(idle = true, token = Symbol("projection-owner")) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-result-projection-"));
  fixture.directories.push(root);
  const userConfigPath = path.join(root, "config.toml");
  writeFileSync(userConfigPath, '[model_policies.developer.primary]\nmodel = "example/primary"\nreasoning = "off"\n');
  const settled = deferred<void>();
  const notes: string[] = [], wakes: string[] = [];
  const branch: unknown[] = [];
  const foreground: BackgroundOwner = {
    token, hasUI: true,
    // This callback runs from completion delivery after the outcome is stored.
    isIdle() { settled.resolve(); return idle; },
    notify(text) { notes.push(text); }, sendMessage(text) { wakes.push(text); },
    appendResult(message: ResultMessage) { branch.push({ type: "custom_message", ...message }); },
    getBranch: () => branch,
  };
  bindBackgroundOwner(foreground);
  return {
    root, foreground, notes, wakes, settled, branch,
    load: { userConfigPath, env: { PI_CODING_AGENT_DIR: root } },
    scope: { ownerToken: token, coordinatorSessionId: "projection-coordinator" },
  };
}

function hanging() {
  const started = deferred<void>();
  let finish!: (attempt: Attempt) => void;
  const attempt = fixture.pendingAttempt((resolve) => { finish = resolve; });
  const executor: AttemptExecutor = { async start() { started.resolve(); return attempt; } };
  return { executor, started: started.promise, finish };
}

function ready(read: WorkerResultRead) {
  if (read.state !== "ready") throw new Error(`expected ready, got ${JSON.stringify(read)}`);
  return read;
}

function tools() {
  type Execute = Parameters<ExtensionAPI["registerTool"]>[0]["execute"];
  const registered = new Map<string, { execute(...args: Parameters<Execute>): ReturnType<Execute> }>();
  agentExtension({ registerTool(tool) { registered.set(tool.name, tool); } } as ExtensionAPI);
  return registered;
}

async function spawn(env: ReturnType<typeof setup>, executor: AttemptExecutor, watch = false) {
  return spawnBackground({
    roleId: "developer", task: "original WorkBrief", cwd: env.root, load: env.load, executor,
    historyOrigin: { source: "agent_spawn", workbrief: "original WorkBrief", coordinatorSessionId: env.scope.coordinatorSessionId },
    watch: watch ? { planId: "projection", unitId: "T2" } : undefined,
  });
}

test("terminal observation is not an outcome; abort without settlement is explicitly missing", fixture.ownedCase("projection settlement boundary", async () => {
  const env = setup();
  const worker = hanging();
  const disposing = deferred<void>(), releaseDisposal = deferred<void>();
  fixture.finishOnCleanup(() => releaseDisposal.resolve());
  const handle = await spawn(env, worker.executor);
  await worker.started;
  const target: LiveTarget = { kind: "background", instanceId: handle.instanceId };
  const owner = { sessionId: env.scope.coordinatorSessionId, token: env.scope.ownerToken };
  const controller = createAgentController(owner, () => owner), view = controller.openView();
  fixture.beforeRelease(async () => { controller.revoke(); await view.close(); await controller.settle(); });
  const hints: Array<{ revision: number; state: WorkerResultRead["state"] }> = [];
  view.subscribe(revision => { hints.push({ revision, state: readWorkerResult(target, env.scope).state }); });
  const before = listObservations();
  for (let i = 0; i < 3; i++) {
    expect(readWorkerResult(target, env.scope)).toEqual({ state: "pending", instanceId: handle.instanceId, generation: 0 });
  }
  expect(listObservations()).toEqual(before);
  expect(env.notes).toEqual([]);
  worker.finish({
    status: "completed", result: "not settled yet", sideEffects: false,
    session: {
      continueWith: async () => { throw new Error("unexpected continuation"); },
      async dispose() { disposing.resolve(); await releaseDisposal.promise; },
    },
  });
  await disposing.promise;
  expect(listObservations().find(row => row.id === handle.instanceId)?.status).toBe("completed");
  expect(readWorkerResult(target, env.scope).state).toBe("pending");
  expect(hints.at(-1)?.state).toBe("pending");
  const displayRevision = view.list().revision;
  cancelWorker(handle.instanceId);
  const unavailableObservation = listObservations();
  for (let i = 0; i < 3; i++) {
    expect(readWorkerResult(target, env.scope)).toEqual({ state: "unavailable", reason: "outcome_missing" });
  }
  expect(listObservations()).toEqual(unavailableObservation);
  expect(env.notes).toEqual([]);
  releaseDisposal.resolve();
  await env.settled.promise;
  expect(view.list().revision).toBeGreaterThan(displayRevision);
  expect(hints.at(-1)?.state).toBe("ready");
  expect(ready(readWorkerResult(target, env.scope))).toMatchObject({ status: "completed", text: { text: "not settled yet" } });
  expect(env.notes).toEqual([]);
  expect(env.branch).toMatchObject([{ content: "not settled yet" }]);
}));

test("a failed settled outcome is readable as failure, never fabricated empty success", fixture.ownedCase("projection failed outcome", async () => {
  const env = setup();
  const worker = hanging();
  const handle = await spawn(env, worker.executor);
  await worker.started;
  worker.finish({ status: "failed", result: "controlled failure", error: "controlled failure", sideEffects: false });
  await env.settled.promise;
  expect(ready(readWorkerResult({ kind: "background", instanceId: handle.instanceId }, env.scope)))
    .toMatchObject({ status: "failed", text: { text: "controlled failure" } });
}));

test("exact bounded UTF-16 pages survive pending/incorporated/acknowledged states without passive writes", fixture.ownedCase("projection pages and handoff", async () => {
  const env = setup(false);
  const worker = hanging();
  const manager = SessionManager.create(env.root, path.join(env.root, "native"));
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "native transcript sentinel" }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const handle = await spawn(env, {
    async start(input) {
      const unbind = input.bindLive!({
        historyId: "fixture-history", sessionId: manager.getSessionId(),
        observe() { throw new Error("result must not observe native activity"); },
        input() { throw new Error("result must not admit native input"); }, async close() {},
      });
      const attempt = await worker.executor.start(input);
      return { ...attempt, session: {
        continueWith: async () => { throw new Error("unexpected continuation"); }, async dispose() { unbind(); },
      } };
    },
  }, true);
  await worker.started;
  const result = "x".repeat(1023) + "😀\ud800X\udfff\\\"\n\t".repeat(650);
  const largeTools = Object.fromEntries(Array.from({ length: 240 }, (_, index) => [`tool-${index}-😀\\\"\n\ud800`, index]));
  worker.finish({
    status: "completed", result, sideEffects: false, usage: { input: 10, output: 20, tools: largeTools },
    requests: [{ model: "example/primary", fast_requested: false, returned_service_tier: "unavailable",
      time_to_first_model_output_ms: "unavailable" }],
  });
  await env.settled.promise;
  const target: LiveTarget = { kind: "background", instanceId: handle.instanceId };
  const historyBefore = readFileSync(manager.getSessionFile()!);
  const observationsBefore = listObservations();
  const first = ready(readWorkerResult(target, env.scope));
  expect(first).toMatchObject({ instanceId: handle.instanceId, generation: 1, status: "completed" });
  expect(first.text.text.length).toBe(1024);
  expect(first.text.text.charCodeAt(1023)).toBe(0xd83d);
  const reconstruct = (section: "text" | "metadata") => {
    let combined = "", offset = 0;
    while (true) {
      const page = ready(readWorkerResult(target, env.scope,
        section === "text" ? { offset } : { metadataOffset: offset }))[section];
      expect(page.offset).toBe(offset);
      expect(page.text.length).toBeLessThanOrEqual(1024);
      combined += page.text;
      if (page.nextOffset === null) break;
      expect(page.text.length).toBeGreaterThan(0);
      expect(page.nextOffset).toBe(offset + page.text.length);
      offset = page.nextOffset;
    }
    return combined;
  };
  expect(reconstruct("text")).toBe(result);
  const metadata = reconstruct("metadata");
  expect(metadata.length).toBeGreaterThan(1024);
  expect(JSON.parse(metadata)).toMatchObject({ usage: { input: 10, output: 20, tools: largeTools } });
  expect(JSON.parse(metadata)).not.toHaveProperty("requests");
  expect(JSON.parse(metadata)).not.toHaveProperty("result");
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(readWorkerResult(target, env.scope, { offset: invalid })).toEqual({ state: "invalid_cursor" });
    expect(readWorkerResult(target, env.scope, { metadataOffset: invalid })).toEqual({ state: "invalid_cursor" });
  }
  expect(readWorkerResult(target, env.scope, { offset: result.length + 1 })).toEqual({ state: "invalid_cursor" });
  expect(readWorkerResult(target, env.scope, { metadataOffset: metadata.length + 1 })).toEqual({ state: "invalid_cursor" });
  expect(ready(readWorkerResult(target, env.scope, { offset: result.length, metadataOffset: metadata.length })))
    .toMatchObject({ text: { text: "", offset: result.length, nextOffset: null },
      metadata: { text: "", offset: metadata.length, nextOffset: null } });
  first.text.text = "reader mutation";
  first.metadata.offset = 500;
  expect(ready(readWorkerResult(target, env.scope)).text.text).toBe(result.slice(0, 1024));
  expect(ready(readWorkerResult(target, env.scope)).metadata.offset).toBe(0);
  expect(listObservations()).toEqual(observationsBefore);
  expect(env.notes).toEqual([]);
  expect(env.wakes).toEqual([]);
  expect(readFileSync(manager.getSessionFile()!)).toEqual(historyBefore);
  env.foreground.isIdle = () => true;
  deliverWorkerResults(env.foreground.token);
  expect(env.branch).toMatchObject([{ content: result }]);
  expect(ready(readWorkerResult(target, env.scope)).text.text).toBe(result.slice(0, 1024));
  const tool = tools().get("agent_result")!;
  const consumed = await tool.execute("result", { id: handle.instanceId }, new AbortController().signal, undefined,
    { cwd: env.root } as Parameters<typeof tool.execute>[4]);
  expect(consumed).not.toHaveProperty("isError", true);
  const outcome = consumed.details as AgentRunResult & { handoff: unknown };
  const { result: _result, requests: _requests, handoff: _handoff, ...expectedMetadata } = outcome;
  expect(metadata).toBe(JSON.stringify(expectedMetadata));
  expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
  observeWorkerResults(env.foreground.token, true);
  expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).toBe(true);
  const consumedObservation = listObservations();
  for (let i = 0; i < 3; i++) expect(reconstruct("text")).toBe(result);
  expect(listObservations()).toEqual(consumedObservation);
  deliverWorkerResults(env.foreground.token);
  expect(env.branch).toHaveLength(1);
  expect(readFileSync(manager.getSessionFile()!)).toEqual(historyBefore);
}));

test("Team reads preserve occupancy and assignments; automatic bookkeeping is independent of passive reads", fixture.ownedCase("projection Team contracts", async () => {
  const evaluation = beginTeamEvaluation("projection-coordinator", false)!;
  evaluations.push(evaluation);
  const env = setup(true, evaluation.token);
  const plan = planFile("projection", env.root);
  const ledger = ledgerFile("projection", env.root);
  mkdirSync(path.dirname(plan), { recursive: true });
  mkdirSync(path.dirname(ledger), { recursive: true });
  const planText = "---\nid: projection\nrevision: 1\nstatus: frozen\nboard_topic_id: 1\n---\nTeam workflow.\n";
  writeFileSync(plan, planText);
  writeFileSync(ledger, `---\nplan_id: projection\nrevision: 1\nhash: ${planHash(planText)}\nstatus: running\n---\n\n## Team Holds\n\n<!-- pitako-team-holds:v1 -->\n[]\n<!-- /pitako-team-holds -->\n`);
  recordPlanTeamWork(env.root, "projection", "T2", "assignment", "pending");
  const admission = reserveTeamMember(evaluation, "developer", "assignment");
  const worker = hanging();
  const handle = await spawnBackground({
    roleId: "developer", task: "Team wrapper\nWorkBrief:\noriginal", cwd: env.root, load: env.load, executor: worker.executor,
    historyOrigin: { source: "team_assign", coordinatorSessionId: env.scope.coordinatorSessionId, assignmentId: "assignment" },
    watch: { planId: "projection", unitId: "T2" },
    teamOwner: { token: evaluation.token, assignmentId: "assignment", onSettled: admission.settled },
    reconcileBookkeeping: result => recordPlanTeamWork(env.root, "projection", "T2", "assignment", result.status),
  });
  admission.commit();
  recordTeamAssignment(evaluation, "developer", {
    id: "assignment", instanceId: handle.instanceId, roleId: "developer", task: "original",
    planId: "projection", unitId: "T2", boardTopicId: 1,
  });
  await worker.started;
  const target: LiveTarget = { kind: "team", assignmentId: "assignment" };
  const scope: WorkerReadScope = { ...env.scope, teamToken: evaluation.token };
  const slots = structuredClone(teamAssignments(evaluation));
  const ledgerBefore = readFileSync(ledger);
  const pendingObservation = listObservations(evaluation.token);
  for (let i = 0; i < 3; i++) {
    expect(readWorkerResult(target, scope).state).toBe("pending");
    expect(readWorkerResult({ kind: "team", assignmentId: "unknown" }, scope))
      .toEqual({ state: "unavailable", reason: "unknown_target" });
    expect(readWorkerResult({ kind: "background", instanceId: handle.instanceId }, scope))
      .toEqual({ state: "unavailable", reason: "unknown_target" });
    expect(readWorkerResult(target, { ...scope, teamToken: Symbol("foreign") })).toEqual({ state: "stale_owner" });
    expect(readWorkerResult(target, env.scope)).toEqual({ state: "stale_owner" });
  }
  expect(firstTeamReservation(evaluation, "developer")).toBe("assignment");
  expect(teamAssignments(evaluation)).toEqual(slots);
  expect(readFileSync(ledger)).toEqual(ledgerBefore);
  expect(listObservations(evaluation.token)).toEqual(pendingObservation);
  worker.finish({ status: "completed", result: "Team result", sideEffects: false });
  await env.settled.promise;
  // Actual settlement releases the role. Only compare read effects after it.
  expect(firstTeamReservation(evaluation, "developer")).toBeUndefined();
  expect(env.wakes).toHaveLength(1);
  const settledObservation = listObservations(evaluation.token);
  const reconciledLedger = readFileSync(ledger);
  expect(readLedgerTeamHolds(env.root, "projection")).toEqual([]);
  const wakesBefore = [...env.wakes];
  const unrelatedTeam = Symbol("registered unrelated Team");
  bindBackgroundOwner({ ...env.foreground, token: unrelatedTeam });
  bindBackgroundOwner(env.foreground);
  expect(readWorkerResult(target, { ...scope, teamToken: unrelatedTeam }))
    .toEqual({ state: "unavailable", reason: "unknown_target" });
  for (let i = 0; i < 3; i++) expect(ready(readWorkerResult(target, scope)).text.text).toBe("Team result");
  expect(firstTeamReservation(evaluation, "developer")).toBeUndefined();
  expect(teamAssignments(evaluation)).toEqual(slots);
  expect(readFileSync(ledger)).toEqual(reconciledLedger);
  expect(listObservations(evaluation.token)).toEqual(settledObservation);
  expect(env.wakes).toEqual(wakesBefore);
  const tool = tools().get("team_result")!;
  const consumed = await tool.execute("result", { assignmentId: "assignment" }, new AbortController().signal, undefined,
    { cwd: env.root, sessionManager: { getSessionId: () => evaluation.sessionId } } as Parameters<typeof tool.execute>[4]);
  expect(consumed).not.toHaveProperty("isError", true);
  expect(listObservations(evaluation.token).find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
  observeWorkerResults(evaluation.token, true);
  expect(listObservations(evaluation.token).find(row => row.id === handle.instanceId)?.resultTaken).toBe(true);
  expect(readLedgerTeamHolds(env.root, "projection")).toEqual([]);
  const consumedLedger = readFileSync(ledger);
  const consumedObservation = listObservations(evaluation.token);
  for (let i = 0; i < 3; i++) expect(ready(readWorkerResult(target, scope)).text.text).toBe("Team result");
  expect(readFileSync(ledger)).toEqual(consumedLedger);
  expect(listObservations(evaluation.token)).toEqual(consumedObservation);
  expect(teamAssignments(evaluation)).toEqual(slots);
  expect(env.wakes).toEqual(wakesBefore);
  await retireTeamEvaluation(evaluation);
  expect(readWorkerResult(target, scope)).toEqual({ state: "stale_owner" });
}));

test("owner/coordinator fences deny foreign, missing and retired authority without revealing results", fixture.ownedCase("projection owner fences", async () => {
  const env = setup();
  const worker = hanging();
  const handle = await spawn(env, worker.executor);
  await worker.started;
  worker.finish({ status: "completed", result: "private outcome", sideEffects: false });
  await env.settled.promise;
  const target: LiveTarget = { kind: "background", instanceId: handle.instanceId };
  for (const candidate of [target, { kind: "background" as const, instanceId: "unknown" }]) {
    expect(readWorkerResult(candidate, { ...env.scope, ownerToken: Symbol("foreign") })).toEqual({ state: "stale_owner" });
  }
  for (const candidate of [target, { kind: "background" as const, instanceId: "unknown" }]) {
    expect(readWorkerResult(candidate, { ...env.scope, coordinatorSessionId: "foreign" }))
      .toEqual({ state: "unavailable", reason: "unknown_target" });
  }
  expect(readWorkerResult(target, { ...env.scope, coordinatorSessionId: "" })).toEqual({ state: "stale_owner" });
  expect(readWorkerResult({ kind: "background", instanceId: "unknown" }, env.scope))
    .toEqual({ state: "unavailable", reason: "unknown_target" });
  const replacement = { ...env.foreground, token: Symbol("replacement") };
  bindBackgroundOwner(replacement);
  expect(readWorkerResult(target, env.scope)).toEqual({ state: "stale_owner" });
  expect(readWorkerResult(target, { ...env.scope, ownerToken: replacement.token }))
    .toEqual({ state: "unavailable", reason: "unknown_target" });
  revokeBackgroundOwner(replacement.token);
  expect(readWorkerResult(target, { ...env.scope, ownerToken: replacement.token })).toEqual({ state: "stale_owner" });
  expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
}));

test("automatic ledger failure never hides the full tool result; captured bookkeeping recovers without another delivery or acceptance", fixture.ownedCase("projection partial ledger failure", async () => {
  const evaluation = beginTeamEvaluation("projection-coordinator", false)!;
  evaluations.push(evaluation);
  const env = setup(true, evaluation.token);
  const plan = planFile("projection", env.root), ledger = ledgerFile("projection", env.root);
  mkdirSync(path.dirname(plan), { recursive: true });
  mkdirSync(path.dirname(ledger), { recursive: true });
  const planText = "---\nid: projection\nrevision: 1\nstatus: frozen\nboard_topic_id: 1\n---\nOwned ledger.\n";
  writeFileSync(plan, planText);
  writeFileSync(ledger, `---\nplan_id: projection\nrevision: 1\nhash: ${planHash(planText)}\nstatus: running\n---\n\n## Team Holds\n\n<!-- pitako-team-holds:v1 -->\n[]\n<!-- /pitako-team-holds -->\n`);
  recordPlanTeamWork(env.root, "projection", "T2", "assignment", "pending");
  const retainedLedger = readFileSync(ledger);
  const admission = reserveTeamMember(evaluation, "developer", "assignment"), worker = hanging();
  const handle = await spawnBackground({ roleId: "developer", task: "work", cwd: env.root, load: env.load, executor: worker.executor,
    historyOrigin: { source: "team_assign", coordinatorSessionId: evaluation.sessionId, assignmentId: "assignment" },
    teamOwner: { token: evaluation.token, assignmentId: "assignment", onSettled: admission.settled },
    reconcileBookkeeping: result => recordPlanTeamWork(env.root, "projection", "T2", "assignment", result.status) });
  admission.commit();
  recordTeamAssignment(evaluation, "developer", { id: "assignment", instanceId: handle.instanceId, roleId: "developer", task: "work",
    planId: "projection", unitId: "T2", boardTopicId: 1 });
  rmSync(ledger);
  const full = "\n漢😀e\u0301 ".repeat(3000) + "\n";
  worker.finish({ status: "completed", result: full, sideEffects: false });
  await fixture.settleRuns();
  expect(firstTeamReservation(evaluation, "developer")).toBeUndefined();
  const envelope = env.branch[0];
  const resultTool = tools().get("team_result")!;
  const context = { cwd: env.root, sessionManager: { getSessionId: () => evaluation.sessionId } } as Parameters<typeof resultTool.execute>[4];
  const reads = await Promise.all([resultTool.execute("one", { assignmentId: "assignment" }, undefined, undefined, context),
    resultTool.execute("two", { assignmentId: "assignment" }, undefined, undefined, context)]);
  for (const read of reads) {
    expect(read.isError).toBe(true);
    const text = read.content.find(part => part.type === "text")!.text;
    expect(text).toContain(full);
    expect(text).toContain("Bookkeeping blocked:");
  }
  observeWorkerResults(evaluation.token, true);
  expect(listObservations(evaluation.token).find(row => row.id === handle.instanceId)).toMatchObject({
    handoff: { bookkeeping: "blocked", delivery: "incorporated", continuation: "observed" },
  });
  expect(listObservations(evaluation.token).find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
  writeFileSync(ledger, retainedLedger);
  settleWorkerResults(evaluation.token, true);
  expect(readLedgerTeamHolds(env.root, "projection")).toEqual([]);
  expect(readFileSync(ledger, "utf8")).toContain("status: running");
  expect(listObservations(evaluation.token).find(row => row.id === handle.instanceId)?.resultTaken).toBe(true);
  expect(env.branch).toEqual([envelope]);
  expect(env.wakes).toHaveLength(1);
  expect((await resultTool.execute("again", { assignmentId: "assignment" }, undefined, undefined, context)).isError).toBe(false);
}));

for (const missing of ["owner", "coordinator"] as const) {
  test(`a row missing captured ${missing} identity cannot expose its outcome`, fixture.ownedCase(`projection missing ${missing}`, async () => {
    const env = setup();
    if (missing === "owner") clearBackgroundOwner();
    const worker = hanging();
    const handle = await spawnBackground({
      roleId: "developer", task: "private", cwd: env.root, load: env.load, executor: worker.executor,
      historyOrigin: { source: "agent_spawn", coordinatorSessionId: missing === "coordinator" ? undefined : env.scope.coordinatorSessionId },
    });
    await worker.started;
    bindBackgroundOwner(env.foreground);
    const target: LiveTarget = { kind: "background", instanceId: handle.instanceId };
    expect(readWorkerResult(target, env.scope)).toEqual({ state: "unavailable", reason: "unknown_target" });
    worker.finish({ status: "completed", result: "private", sideEffects: false });
    await fixture.settleRuns();
    expect(readWorkerResult(target, env.scope)).toEqual({ state: "unavailable", reason: "unknown_target" });
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
  }));
}

test("an authoritative empty completed result has an explicit end page", fixture.ownedCase("projection empty result", async () => {
  const env = setup();
  const worker = hanging();
  const handle = await spawn(env, worker.executor);
  await worker.started;
  worker.finish({ status: "completed", result: "", sideEffects: false });
  await env.settled.promise;
  const target: LiveTarget = { kind: "background", instanceId: handle.instanceId };
  expect(ready(readWorkerResult(target, env.scope))).toMatchObject({
    status: "completed", text: { text: "", offset: 0, nextOffset: null },
  });
  expect(readWorkerResult(target, env.scope, { offset: 1 })).toEqual({ state: "invalid_cursor" });
}));
