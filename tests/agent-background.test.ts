import { preparedTool } from "./fixtures/background-dispatch.ts";
import { runAgentInstance } from "../extensions/agent/run.ts";
import { stubExternalFactories } from "./fixtures/offline.ts";
stubExternalFactories();
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentInstance from "../extensions/agent/index.ts";
import {
  bindBackgroundOwner,
  cancelAllWorkers,
  cancelWorker,
  clearBackgroundOwner,
  setBackgroundExecutor,
  shutdownBackground,
  spawnBackground,
  draftWorkerResults,
  observeWorkerResults,
  settleWorkerResults,
  deliverWorkerResults,
  restrictWorkerContinuation,
  externallyStartedWorkerOwner,
  revokeBackgroundOwner,
  workerHandoff,
  type ResultMessage,
  workerResult,
  workerStatus,
  resolveLiveTarget,
  retireTeamWorkers,
  type BackgroundOwner,
} from "../extensions/agent/background.ts";
import type { Attempt, AttemptExecutor } from "../extensions/agent/run.ts";
import { agentScope } from "../extensions/agent/scope.ts";
import pitako from "../extensions/index.ts";
import { childActiveTools, ORCHESTRATION_TOOLS } from "../extensions/profile.ts";
import { packageRoot } from "../extensions/stack.ts";
import { ledgerFile, planFile } from "../extensions/workflow.ts";
import type { LoadOptions } from "../extensions/roles/load.ts";
import { listObservations } from "../extensions/agent/observe.ts";

const fixture = agentFixtureOwnership();
const tempDirs = fixture.directories;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
  fixture.requireReleasedFixture();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await cancelAllWorkers();
  clearBackgroundOwner();
  setBackgroundExecutor(undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function load(): LoadOptions {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-bg-"));
  tempDirs.push(dir);
  const userConfigPath = path.join(dir, "pitako", "config.toml");
  mkdirSync(path.dirname(userConfigPath), { recursive: true });
  writeFileSync(userConfigPath, `[model_policies.developer.primary]\nmodel = "example/primary"\nreasoning = "off"\n`);
  return { env: { PI_CODING_AGENT_DIR: dir }, userConfigPath };
}

function hang(): { executor: AttemptExecutor; started: Promise<void>; release: (attempt: Attempt) => void; signal: () => AbortSignal | undefined } {
  let markStarted: () => void = () => {};
  let finish: (attempt: Attempt) => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = fixture.pendingAttempt((resolve) => {
    finish = resolve;
  });
  let seen: AbortSignal | undefined;
  return {
    started,
    release: finish,
    signal: () => seen,
    executor: {
      async start(input) {
        seen = input.signal;
        markStarted();
        return await gate;
      },
    },
  };
}

function owner(idle: boolean): BackgroundOwner & { notes: string[]; wakes: string[]; results: ResultMessage[]; branch: unknown[] } {
  const notes: string[] = [];
  const wakes: string[] = [];
  const results: ResultMessage[] = [], branch: unknown[] = [];
  return {
    token: Symbol("test-owner"),
    isIdle: () => idle,
    hasUI: true,
    notify: (message) => notes.push(message),
    sendMessage: (content) => wakes.push(content),
    appendResult(message) { results.push(message); branch.push({ type: "custom_message", ...message }); },
    getBranch: () => branch,
    notes,
    wakes,
    results, branch,
  };
}

describe("pitako agents command", () => {
  test("live bindings require dispatch owner and exact Team lease; old cleanup preserves replacement", fixture.ownedCase("live binding authority", async () => {
    const foreground = owner(true);
    bindBackgroundOwner(foreground);
    const hanging = hang();
    let bind: NonNullable<Parameters<AttemptExecutor["start"]>[0]["bindLive"]> | undefined;
    const executor: AttemptExecutor = { async start(input) { bind = input.bindLive; return hanging.executor.start(input); } };
    const accepted = await spawnBackground({ roleId: "developer", task: "original", cwd: packageRoot(), executor, load: load(),
      historyOrigin: { source: "agent_spawn", workbrief: "original", coordinatorSessionId: "coordinator" } });
    await hanging.started;
    const live = (id: string) => ({
      historyId: id, sessionId: id, observe: () => ({ id }), input: async () => ({ status: "queued" }), close: async () => {},
    });
    const first = live("first"), second = live("second");
    const cleanFirst = bind!(first);
    bind!(second);
    cleanFirst();
    const target = { kind: "background" as const, instanceId: accepted.instanceId };
    expect(resolveLiveTarget(target, "coordinator")).toBe(second);
    expect(() => resolveLiveTarget(target, "other")).toThrow("foreground owner");
    const tools = new Map<string, { execute: Function }>();
    agentInstance({ registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI);
    const ctx = { sessionManager: { getSessionId: () => "coordinator" } };
    const observed = await tools.get("agent_observe")!.execute("observe", { target }, undefined, undefined, ctx);
    expect(observed.details).toMatchObject({ target, id: "second" });
    for (const intent of ["query", "steer"]) {
      const params = { target, historyId: "second", sessionId: "second", intent, text: "original" };
      const receipt = await tools.get("agent_input")!.execute("input", params, undefined, undefined, ctx);
      expect(receipt.details).toMatchObject({ target, status: "queued" });
      const denied = await tools.get("agent_input")!.execute("input", params, undefined, undefined,
        { sessionManager: { getSessionId: () => "other" } });
      expect(denied.details).toMatchObject({ target, historyId: "second", sessionId: "second", status: "rejected" });
      expect(denied.details.reason).toContain("foreground owner");
    }
    const nextOwner = owner(true);
    bindBackgroundOwner(nextOwner);
    const retired = shutdownBackground(foreground.token);
    expect(() => resolveLiveTarget(target, "coordinator")).toThrow("different foreground owner");

    const team = hang();
    let teamBind: typeof bind;
    const assigned = await spawnBackground({ roleId: "developer", task: "Team wrapper\nWorkBrief:\noriginal", cwd: packageRoot(), load: load(),
      executor: { async start(input) { teamBind = input.bindLive; return team.executor.start(input); } },
      historyOrigin: { source: "team_assign", workbrief: "original", coordinatorSessionId: "coordinator", assignmentId: "assignment" },
      teamOwner: { token: nextOwner.token, assignmentId: "assignment", onSettled() {} } });
    await team.started;
    const teamLive = live("team");
    teamBind!(teamLive);
    const teamTarget = { kind: "team" as const, assignmentId: "assignment" };
    expect(resolveLiveTarget(teamTarget, "coordinator", nextOwner.token)).toBe(teamLive);
    expect(() => resolveLiveTarget({ kind: "background", instanceId: assigned.instanceId }, "coordinator")).toThrow("unknown live target");
    expect(() => resolveLiveTarget(teamTarget, "coordinator", Symbol("retired"))).toThrow("unknown live target");
    const retiredTeam = retireTeamWorkers(nextOwner.token);
    expect(() => resolveLiveTarget(teamTarget, "coordinator", nextOwner.token)).toThrow("Team evaluation is retired");
    expect(hanging.signal()?.aborted).toBe(true);
    expect(() => resolveLiveTarget(target, "coordinator")).toThrow();
    hanging.release({ status: "cancelled", result: "cancelled", sideEffects: false });
    team.release({ status: "cancelled", result: "cancelled", sideEffects: false });
    await Promise.all([retired, retiredTeam]);
  }));
  test("empty list, running row, id filter, and unknown id", fixture.ownedCase("empty list, running row, id filter, and unknown id", async () => {
    const cmd = pitakoAgentsCommand();
    const empty = await cmd.run("agents");
    expect(empty.threw).toBe(false);
    expect(empty.notes).toEqual(["no workers"]);

    const hanging = hang();
    const handle = await spawnBackground({
      roleId: "developer",
      task: "change the widget\nSECRET-SECOND-LINE",
      historyOrigin: { source: "agent_spawn", coordinatorSessionId: "command-coordinator" },
      cwd: packageRoot(),
      executor: hanging.executor,
      load: load(),
      watch: { planId: "background-responsiveness-dogfood", unitId: "T1" },
    });
    await hanging.started;

    const listed = await cmd.run("agents");
    expect(listed.threw).toBe(false);
    expect(listed.notes).toHaveLength(1);
    const text = listed.notes[0] ?? "";
    expect(text).toContain("T1");
    expect(text).toContain(handle.instanceId);
    expect(text).toContain("developer");
    expect(text).toContain("change the widget");
    expect(text).not.toContain("SECRET-SECOND-LINE");

    const filtered = await cmd.run(`agents ${handle.instanceId}`);
    expect(filtered.threw).toBe(false);
    expect(filtered.notes).toHaveLength(1);
    expect(filtered.notes[0]).toContain(handle.instanceId);
    expect(filtered.notes[0]).toContain("change the widget");
    expect(filtered.notes[0]).not.toContain("SECRET-SECOND-LINE");

    const unknown = await cmd.run("agents missing-worker");
    expect(unknown.threw).toBe(false);
    expect(unknown.notes).toEqual([]);
    expect(unknown.errors).toEqual(["unknown worker missing-worker"]);

    cancelWorker(handle.instanceId);
    hanging.release({ status: "cancelled", result: "SECRET-RESULT", sideEffects: false });
    await waitFor(handle.instanceId);
  }));
});

describe("cancel before settle", () => {
  test("status is cancelled and result stays unavailable until the executor settles", fixture.ownedCase("status is cancelled and result stays unavailable until the executor settles", async () => {
    const hanging = hang();
    const handle = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: hanging.executor,
      load: load(),
    });
    await hanging.started;
    const cancelled = cancelWorker(handle.instanceId);
    expect(cancelled.status).toBe("cancelled");
    expect(workerStatus(handle.instanceId)[0]?.status).toBe("cancelled");
    expect(() => workerResult(handle.instanceId)).toThrow("result is not available");
    hanging.release({ status: "cancelled", result: "cancelled", sideEffects: false });
    await waitFor(handle.instanceId);
    expect(workerResult(handle.instanceId).status).toBe("cancelled");
  }));
});

describe("background registry", () => {
  test("ad hoc idle worker automatically supplies complete Unicode without UI or a getter", fixture.ownedCase("idle automatic handoff", async () => {
    const bound = owner(true);
    bound.hasUI = false;
    let appended!: () => void;
    let cloneFailed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { appended = resolve; cloneFailed = reject; });
    bound.appendResult = message => {
      bound.results.push(message);
      try {
        const cloned = structuredClone(message);
        bound.branch.push({ type: "custom_message", ...cloned });
        appended();
      } catch (error) { cloneFailed(error); }
    };
    bindBackgroundOwner(bound);
    const hanging = hang();
    const handle = await spawnBackground({ roleId: "developer", task: "work", cwd: packageRoot(),
      executor: hanging.executor, load: load() });
    const complete = " \n🧬漢字\u0000e\u0301 ".repeat(4000) + "\n ";
    hanging.release({ status: "completed", result: complete, sideEffects: false });
    await ready;
    await fixture.settleRuns();
    expect(bound.results).toHaveLength(1);
    const original = bound.results[0]!;
    const committed = bound.branch[0] as ResultMessage;
    expect(original.content).toBe(complete);
    expect(committed.content).toBe(complete);
    expect(committed.details).toEqual(original.details);
    expect(committed.details).not.toBe(original.details);
    expect(original.details).toMatchObject({ instanceId: handle.instanceId, status: "completed", roleId: "developer" });
    expect(original.details.deliveryId).toBeString();
    expect(Object.hasOwn(original.details, "ownerToken")).toBe(false);
    expect(Object.hasOwn(original.details, "teamToken")).toBe(false);
    expect(bound.wakes).toHaveLength(1);
    expect(bound.wakes[0]).not.toContain("agent_result");
    expect(workerHandoff(handle.instanceId)).toMatchObject({
      collection: "collected", bookkeeping: "inapplicable", delivery: "incorporated", continuation: "requested",
    });
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    observeWorkerResults(bound.token, true);
    expect(workerHandoff(handle.instanceId)?.continuation).toBe("observed");
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).toBe(true);
    observeWorkerResults(bound.token, true);
    settleWorkerResults(bound.token, true);
    bound.branch.length = 0;
    observeWorkerResults(bound.token);
    expect(workerHandoff(handle.instanceId)?.delivery).toBe("incorporated");
    settleWorkerResults(bound.token, true);
    expect(bound.results).toHaveLength(1);
    expect(bound.wakes).toHaveLength(1);
  }));

  test("busy full draft is not a receipt and requests continuation only after new context", fixture.ownedCase("busy draft commitment", async () => {
    const bound = owner(false);
    bindBackgroundOwner(bound);
    const hanging = hang();
    const handle = await spawnBackground({ roleId: "developer", task: "work", cwd: packageRoot(),
      executor: hanging.executor, load: load() });
    hanging.release({ status: "completed", result: "complete text", sideEffects: false });
    await fixture.settleRuns();
    expect(bound.results).toEqual([]);
    const offered = draftWorkerResults(bound.token, "completed")!;
    const cloned = structuredClone(offered.entries);
    expect(cloned).toEqual(offered.entries);
    expect(cloned[0]?.details).not.toBe(offered.entries[0]?.details);
    const restored = JSON.parse(JSON.stringify(offered.entries));
    const original = offered.entries[0]!;
    expect(original.details).toMatchObject({ instanceId: handle.instanceId, status: "completed", roleId: "developer" });
    expect(original.details.deliveryId).toBeString();
    expect(Object.hasOwn(original.details, "ownerToken")).toBe(false);
    expect(Object.hasOwn(original.details, "teamToken")).toBe(false);
    for (const [key, value] of Object.entries(original.details)) {
      if (value !== undefined) expect(restored[0].details[key]).toEqual(value);
    }
    expect(restored[0].content).toBe(original.content);
    expect(offered.continue).toBe(true);
    expect(offered.entries[0]?.content).toBe("complete text");
    expect(workerHandoff(handle.instanceId)?.delivery).toBe("offered");
    expect(workerHandoff(handle.instanceId)?.continuation).toBe("requested");
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    expect(draftWorkerResults(bound.token, "completed")).toBeUndefined();
    observeWorkerResults(bound.token, true);
    expect(workerHandoff(handle.instanceId)?.continuation).toBe("requested");
    bound.branch.push(...restored);
    const foreign = Symbol("foreign");
    observeWorkerResults(foreign, true);
    expect(workerHandoff(handle.instanceId)?.delivery).toBe("offered");
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    observeWorkerResults(bound.token);
    expect(workerHandoff(handle.instanceId)?.delivery).toBe("incorporated");
    expect(workerHandoff(handle.instanceId)?.continuation).toBe("requested");
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    observeWorkerResults(foreign, true);
    expect(workerHandoff(handle.instanceId)?.continuation).toBe("requested");
    observeWorkerResults(bound.token, true);
    expect(workerHandoff(handle.instanceId)?.continuation).toBe("observed");
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).toBe(true);
    settleWorkerResults(bound.token, true);
    expect(draftWorkerResults(bound.token, "completed")).toBeUndefined();
    expect(bound.results).toEqual([]);
    expect(bound.wakes).toEqual([]);
  }));

  test("void sends and preview-only or mismatched entries never acknowledge; recovery is bounded and late receipt still works", fixture.ownedCase("uncertain delivery and late receipt", async () => {
    const bound = owner(true);
    bound.appendResult = message => { bound.results.push(message); };
    bindBackgroundOwner(bound);
    const hanging = hang();
    const handle = await spawnBackground({ roleId: "developer", task: "work", cwd: packageRoot(),
      executor: hanging.executor, load: load() });
    hanging.release({ status: "completed", result: " \n😀\ud800 unchanged \t", sideEffects: false });
    await fixture.settleRuns();
    const original = bound.results[0]!;
    expect(workerHandoff(handle.instanceId)).toMatchObject({ delivery: "offered", continuation: "not-requested" });
    expect(bound.wakes).toEqual([]);
    bound.branch.push({ type: "message", message: { role: "custom", ...original } },
      { type: "custom_message", ...original, content: original.content.trim() },
      { type: "custom_message", ...original, details: { deliveryId: "foreign" } });
    for (let i = 0; i < 3; ++i) {
      observeWorkerResults(bound.token, true);
      deliverWorkerResults(bound.token);
      draftWorkerResults(bound.token, "completed");
    }
    expect(bound.results).toHaveLength(1);
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    // Closing an unresolved operation does not retry it within that callback.
    settleWorkerResults(bound.token, true);
    expect(bound.results).toHaveLength(1);
    settleWorkerResults(bound.token, true);
    expect(bound.results).toHaveLength(2);
    expect(bound.results[1]).toBe(original);
    for (let i = 0; i < 5; ++i) settleWorkerResults(bound.token, true);
    expect(bound.results).toHaveLength(2);
    expect(workerHandoff(handle.instanceId)?.delivery).toBe("blocked");
    expect(bound.wakes).toEqual([]);
    bound.branch.push({ type: "custom_message", ...original });
    observeWorkerResults(bound.token);
    expect(workerHandoff(handle.instanceId)?.delivery).toBe("incorporated");
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    observeWorkerResults(bound.token, true);
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).toBe(true);
    expect(bound.results).toHaveLength(2);
  }));

  test("rejected appends recover once at a later boundary; failed wakes never resend incorporated text", fixture.ownedCase("rejected operations", async () => {
    const bound = owner(true);
    let appends = 0, wakes = 0;
    const commit = bound.appendResult!;
    bound.appendResult = message => { if (++appends === 1) throw new Error("append rejected"); commit(message); };
    bound.sendMessage = () => { ++wakes; throw new Error("wake rejected"); };
    bindBackgroundOwner(bound);
    const hanging = hang();
    const handle = await spawnBackground({ roleId: "developer", task: "work", cwd: packageRoot(),
      executor: hanging.executor, load: load() });
    hanging.release({ status: "completed", result: "still complete", sideEffects: false });
    await fixture.settleRuns();
    expect(appends).toBe(1);
    expect(workerHandoff(handle.instanceId)).toMatchObject({ delivery: "blocked", continuation: "not-requested" });
    settleWorkerResults(bound.token, true);
    expect(appends).toBe(2);
    expect(wakes).toBe(1);
    expect(workerHandoff(handle.instanceId)).toMatchObject({ delivery: "incorporated", continuation: "blocked-unconfirmed" });
    for (let i = 0; i < 5; ++i) settleWorkerResults(bound.token, true);
    expect(wakes).toBe(2);
    expect(appends).toBe(2);
    expect(bound.results).toHaveLength(1);
    expect(workerResult(handle.instanceId).result).toBe("still complete");
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    observeWorkerResults(bound.token, true);
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).toBe(true);
  }));

  test("an idle void wake is requested, not accepted; duplicate boundaries cannot replenish recovery", fixture.ownedCase("unobserved idle continuation", async () => {
    const bound = owner(true);
    bindBackgroundOwner(bound);
    const hanging = hang();
    const handle = await spawnBackground({ roleId: "developer", task: "work", cwd: packageRoot(),
      executor: hanging.executor, load: load(), reconcileBookkeeping() { throw new Error("ledger unavailable"); } });
    hanging.release({ status: "completed", result: "retained complete result", sideEffects: false });
    await fixture.settleRuns();
    for (let i = 0; i < 5; ++i) settleWorkerResults(bound.token, true);
    expect(bound.results).toHaveLength(1);
    expect(bound.wakes).toHaveLength(2);
    expect(workerHandoff(handle.instanceId)).toMatchObject({
      delivery: "incorporated", continuation: "requested", bookkeeping: "blocked",
    });
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    observeWorkerResults(bound.token, true);
    expect(workerHandoff(handle.instanceId)?.continuation).toBe("observed");
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
  }));

  test("busy commitment without a subsequent turn stays blocked and never falls back to idle wake", fixture.ownedCase("rejected busy continuation", async () => {
    const bound = owner(false);
    bindBackgroundOwner(bound);
    const hanging = hang();
    const handle = await spawnBackground({ roleId: "developer", task: "work", cwd: packageRoot(),
      executor: hanging.executor, load: load() });
    hanging.release({ status: "completed", result: "complete", sideEffects: false });
    await fixture.settleRuns();
    const drafts = draftWorkerResults(bound.token, "completed")!;
    bound.branch.push(...drafts.entries);
    bound.isIdle = () => true;
    for (let i = 0; i < 5; ++i) settleWorkerResults(bound.token, true);
    expect(workerHandoff(handle.instanceId)).toMatchObject({ delivery: "incorporated", continuation: "blocked-unconfirmed" });
    expect(bound.results).toEqual([]);
    expect(bound.wakes).toEqual([]);
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    observeWorkerResults(bound.token, true);
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).toBe(true);
  }));

  test("a valid live-handle rebind changes worker generation but preserves its foreground handoff", fixture.ownedCase("handoff after live rebind", async () => {
    const bound = owner(true);
    bound.sessionId = "coordinator";
    bound.revision = 12;
    bindBackgroundOwner(bound);
    const hanging = hang();
    const handle = await spawnBackground({ roleId: "developer", task: "work", cwd: packageRoot(), load: load(),
      historyOrigin: { source: "agent_spawn", coordinatorSessionId: "coordinator" },
      executor: { async start(input) {
        const live = (id: string) => ({ sessionId: id, historyId: id, observe: () => ({}), input: async () => ({}), close: async () => {} });
        const old = input.bindLive!(live("old"));
        const latest = input.bindLive!(live("latest"));
        old();
        const attempt = await hanging.executor.start(input);
        return { ...attempt, session: { continueWith: async () => { throw new Error("unexpected continuation"); }, async dispose() { latest(); } } };
      } } });
    hanging.release({ status: "completed", result: "rebound result", sideEffects: false });
    await fixture.settleRuns();
    expect(bound.results).toMatchObject([{ content: "rebound result", details: {
      instanceId: handle.instanceId, ownerSessionId: "coordinator", foregroundRevision: 12,
    } }]);
    expect(bound.wakes).toHaveLength(1);
    observeWorkerResults(bound.token, true);
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).toBe(true);
  }));

  test("partial bookkeeping retains delivery and concurrent diagnostic re-reads share the same collection", fixture.ownedCase("independent bookkeeping recovery", async () => {
    const bound = owner(true);
    bindBackgroundOwner(bound);
    let attempts = 0, applied = false;
    const hanging = hang();
    const handle = await spawnBackground({ roleId: "developer", task: "work", cwd: packageRoot(),
      executor: hanging.executor, load: load(), reconcileBookkeeping() {
        ++attempts;
        applied = true;
        if (attempts === 1) throw new Error("partial ledger failure after update");
      } });
    hanging.release({ status: "completed", result: "full result despite ledger failure", sideEffects: false });
    await fixture.settleRuns();
    expect(applied).toBe(true);
    const reads = await Promise.all([Promise.resolve().then(() => workerResult(handle.instanceId)),
      Promise.resolve().then(() => workerResult(handle.instanceId))]);
    expect(reads[0]).toBe(reads[1]);
    expect(attempts).toBe(1);
    const envelope = bound.results[0];
    observeWorkerResults(bound.token, true);
    expect(workerHandoff(handle.instanceId)).toMatchObject({ bookkeeping: "blocked", delivery: "incorporated", continuation: "observed" });
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    settleWorkerResults(bound.token, true);
    expect(attempts).toBe(2);
    expect(bound.results).toEqual([envelope!]);
    expect(workerHandoff(handle.instanceId)?.bookkeeping).toBe("reconciled");
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).toBe(true);
    for (let i = 0; i < 3; ++i) settleWorkerResults(bound.token, true);
    expect(attempts).toBe(2);
  }));

  for (const outcome of ["aborted", "error"] as const) {
    test(`parent ${outcome} permits result drafts but no forced continuation until an external run`, fixture.ownedCase(`parent ${outcome}`, async () => {
      const bound = owner(false);
      bindBackgroundOwner(bound);
      const hanging = hang();
      const handle = await spawnBackground({ roleId: "developer", task: "work", cwd: packageRoot(),
        executor: hanging.executor, load: load() });
      restrictWorkerContinuation(bound.token, outcome);
      hanging.release({ status: "completed", result: "settled after parent termination", sideEffects: false });
      await fixture.settleRuns();
      const drafts = draftWorkerResults(bound.token, outcome)!;
      expect(drafts.continue).toBe(false);
      bound.branch.push(...drafts.entries);
      settleWorkerResults(bound.token, true);
      expect(workerHandoff(handle.instanceId)).toMatchObject({ delivery: "incorporated", continuation: "blocked-unconfirmed" });
      expect(bound.wakes).toEqual([]);
      expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
      externallyStartedWorkerOwner(bound.token);
      observeWorkerResults(bound.token, true);
      expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).toBe(true);
      expect(bound.results).toEqual([]);
    }));
  }

  test("captured lease retirement fences pending results and callbacks without retargeting", fixture.ownedCase("handoff lease retirement", async () => {
    const old = owner(false);
    let live = true, books = 0, releases = 0;
    old.owns = () => live;
    bindBackgroundOwner(old);
    const first = hang(), late = hang();
    const firstHandle = await spawnBackground({ roleId: "developer", task: "first", cwd: packageRoot(),
      executor: first.executor, load: load(), reconcileBookkeeping() { ++books; } });
    await spawnBackground({ roleId: "developer", task: "late", cwd: packageRoot(),
      executor: late.executor, load: load(), reconcileBookkeeping() { ++books; },
      teamOwner: { token: old.token, assignmentId: "late-assignment", onSettled() { ++releases; } } });
    first.release({ status: "completed", result: "first", sideEffects: false });
    // Await the settled result while the independently owned late attempt remains active.
    await waitFor(firstHandle.instanceId);
    expect(books).toBe(1);
    expect(releases).toBe(0);
    live = false;
    revokeBackgroundOwner(old.token);
    const fresh = owner(true);
    bindBackgroundOwner(fresh);
    late.release({ status: "completed", result: "late", sideEffects: false });
    await fixture.settleRuns();
    settleWorkerResults(old.token, true);
    settleWorkerResults(fresh.token, true);
    expect(books).toBe(1);
    expect(releases).toBe(0);
    expect(old.results).toEqual([]);
    expect(fresh.results).toEqual([]);
    expect(fresh.wakes).toEqual([]);
  }));
  test("receipt observation cannot admit effects after its branch callback retires the captured lease", fixture.ownedCase("receipt callback retirement", async () => {
    const bound = owner(false);
    bindBackgroundOwner(bound);
    const hanging = hang();
    const handle = await spawnBackground({ roleId: "developer", task: "work", cwd: packageRoot(),
      executor: hanging.executor, load: load() });
    hanging.release({ status: "completed", result: "captured result", sideEffects: false });
    await fixture.settleRuns();
    const draft = draftWorkerResults(bound.token, "completed")!;
    bound.getBranch = () => {
      revokeBackgroundOwner(bound.token);
      return draft.entries;
    };
    observeWorkerResults(bound.token, true);
    expect(workerHandoff(handle.instanceId)).toMatchObject({ delivery: "offered", continuation: "requested" });
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    expect(bound.wakes).toEqual([]);
  }));
  test("spawn returns while the executor is pending", fixture.ownedCase("spawn returns while the executor is pending", async () => {
    const hanging = hang();
    const handle = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: hanging.executor,
      load: load(),
    });
    expect(handle.status).toBe("running");
    expect(handle.instanceId).toMatch(/^developer-/);
    expect(workerStatus(handle.instanceId)[0]?.status).toBe("running");
    await hanging.started;
    expect(() => workerResult(handle.instanceId)).toThrow("worker is still running");
    hanging.release({ status: "completed", result: "SECRET-RESULT", sideEffects: false });
    await waitFor(handle.instanceId);
    const result = workerResult(handle.instanceId);
    expect(result.result).toBe("SECRET-RESULT");
    expect(workerResult(handle.instanceId).result).toBe("SECRET-RESULT");
  }));

  test("pre-abort starts nothing", fixture.ownedCase("pre-abort starts nothing", async () => {
    const hanging = hang();
    const foreground = new AbortController();
    foreground.abort();
    await expect(
      spawnBackground({
        roleId: "developer",
        task: "change the widget",
        cwd: packageRoot(),
        foreground: foreground.signal,
        executor: hanging.executor,
        load: load(),
      }),
    ).rejects.toThrow("agent_spawn cancelled");
    expect(workerStatus()).toEqual([]);
  }));

  test("foreground abort after accept does not cancel the worker", fixture.ownedCase("foreground abort after accept does not cancel the worker", async () => {
    const hanging = hang();
    const foreground = new AbortController();
    const handle = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      foreground: foreground.signal,
      executor: hanging.executor,
      load: load(),
    });
    await hanging.started;
    foreground.abort();
    expect(hanging.signal()?.aborted).toBe(false);
    expect(workerStatus(handle.instanceId)[0]?.status).toBe("running");
    cancelWorker(handle.instanceId);
    expect(hanging.signal()?.aborted).toBe(true);
  }));

  test("two workers stay independent", fixture.ownedCase("two workers stay independent", async () => {
    const a = hang();
    const b = hang();
    const first = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: a.executor,
      load: load(),
    });
    const second = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: b.executor,
      load: load(),
    });
    expect(workerStatus()).toHaveLength(2);
    cancelWorker(first.instanceId);
    expect(a.signal()?.aborted ?? true).toBe(true);
    expect(workerStatus(second.instanceId)[0]?.status).toBe("running");
    b.release({ status: "completed", result: "B", sideEffects: false });
    a.release({ status: "cancelled", result: "cancelled", sideEffects: false });
    await waitFor(second.instanceId);
    expect(workerResult(second.instanceId).result).toBe("B");
    expect(workerResult(second.instanceId).instanceId).toBe(second.instanceId);
  }));

  test("completion is one full result and shutdown drops a late settle", fixture.ownedCase("completion and shutdown", async () => {
    const bound = owner(true);
    bindBackgroundOwner(bound);
    const hanging = hang();
    const handle = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: hanging.executor,
      load: load(),
      watch: { planId: "background-agent-delegation", unitId: "T2" },
    });
    hanging.release({ status: "completed", result: "SECRET-RESULT", sideEffects: false });
    await waitFor(handle.instanceId);
    expect(bound.results).toHaveLength(1);
    expect(bound.results[0]?.content).toBe("SECRET-RESULT");
    expect(bound.results[0]?.details.planId).toBe("background-agent-delegation");
    expect(bound.wakes).toHaveLength(1);
    expect(bound.wakes[0]).not.toContain("SECRET-RESULT");

    const late = hang();
    const held = owner(false);
    bindBackgroundOwner(held);
    const running = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: late.executor,
      load: load(),
    });
    const retirement = shutdownBackground(held.token);
    expect(workerStatus(running.instanceId)[0]?.closure).toEqual({ state: "pending" });
    await shutdownBackground(bound.token);
    expect(workerStatus().map(row => row.instanceId)).toEqual([running.instanceId]);
    late.release({ status: "completed", result: "LATE", sideEffects: false });
    await retirement;
    expect(held.notes).toEqual([]);
    expect(() => workerStatus(running.instanceId)).toThrow(/unknown worker/);
  }));

  test("a foreign token does not flush or cancel", fixture.ownedCase("a foreign token does not flush or cancel", async () => {
    const bound = owner(false);
    bindBackgroundOwner(bound);
    const hanging = hang();
    const handle = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: hanging.executor,
      load: load(),
      watch: { planId: "background-agent-delegation", unitId: "T3" },
    });
    hanging.release({ status: "failed", result: "SECRET-RESULT", error: "SECRET-RESULT", sideEffects: false });
    await waitFor(handle.instanceId);
    settleWorkerResults(Symbol("other"), true);
    expect(bound.results).toEqual([]);
    expect(workerStatus(handle.instanceId)).toHaveLength(1);
    await shutdownBackground(Symbol("other"));
    expect(workerStatus(handle.instanceId)[0]?.status).toBe("failed");
    bound.isIdle = () => true;
    settleWorkerResults(bound.token, true);
    expect(bound.results[0]?.content).toBe("SECRET-RESULT");
    observeWorkerResults(bound.token, true);
    settleWorkerResults(bound.token, true);
    expect(bound.results).toHaveLength(1);
  }));
});

describe("background tools", () => {
  test("public terminal boundaries handle stale-idle compaction/tree and post-snapshot completion without restarting aborted/error parents", fixture.ownedCase("terminal adapter boundaries", async () => {
    const handlers = new Map<string, Function>(), branch: unknown[] = [], sent: { message: ResultMessage | { customType: string; content: string }; options: { triggerTurn: boolean } }[] = [];
    const pi = {
      registerFlag() {}, registerCommand() {}, registerTool() {}, getFlag() {}, getAllTools: () => [],
      getActiveTools: () => [], setActiveTools() {}, getSessionName() {}, setSessionName() {},
      on(name: string, handler: Function) { handlers.set(name, handler); },
      sendMessage(message: ResultMessage, options: { triggerTurn: boolean }) {
        sent.push({ message, options });
        if (!options.triggerTurn) branch.push({ type: "custom_message", ...message });
      },
    };
    pitako(pi as unknown as ExtensionAPI);
    const ctx = { cwd: packageRoot(), hasUI: false, isIdle: () => false, signal: undefined as AbortSignal | undefined,
      ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => "terminal-parent", getBranch: () => branch } };
    await handlers.get("session_start")!({}, ctx);
    const finish = async (text: string) => {
      const hanging = hang();
      const handle = await spawnBackground({ roleId: "developer", task: text, cwd: packageRoot(), load: load(), executor: hanging.executor });
      hanging.release({ status: "completed", result: text, sideEffects: false });
      await fixture.settleRuns();
      return handle.instanceId;
    };
    const compacted = await finish("manual compaction result");
    await handlers.get("session_compact")!({ reason: "threshold" }, ctx);
    expect(sent).toEqual([]);
    await handlers.get("session_compact")!({ reason: "manual" }, ctx);
    expect(sent.map(item => item.options.triggerTurn)).toEqual([false, true]);
    await handlers.get("turn_start")!({}, ctx);
    expect(workerHandoff(compacted)?.continuation).toBe("observed");
    const tree = await finish("tree result");
    await handlers.get("session_tree")!({}, ctx);
    expect(sent.map(item => item.options.triggerTurn)).toEqual([false, true, false, true]);
    await handlers.get("turn_start")!({}, ctx);
    expect(workerHandoff(tree)?.continuation).toBe("observed");
    // The worker finishes after the final pre-settlement snapshot.
    expect(await handlers.get("agent_before_settle")!({ outcome: "completed", context: { canContinue: false } }, ctx)).toBeUndefined();
    const late = await finish("post-snapshot result");
    await handlers.get("agent_settled")!({}, ctx);
    expect(workerHandoff(late)).toMatchObject({ delivery: "incorporated", continuation: "requested" });
    expect(sent).toHaveLength(6);
    await handlers.get("turn_start")!({}, ctx);
    // Abort skips the pre-settle boundary; the public final events still fence wakes.
    const abort = new AbortController();
    abort.abort();
    ctx.signal = abort.signal;
    await handlers.get("agent_end")!({ messages: [] }, ctx);
    const aborted = await finish("settled after skipped parent abort");
    await handlers.get("agent_settled")!({}, ctx);
    expect(sent).toHaveLength(7);
    expect(workerHandoff(aborted)).toMatchObject({ delivery: "incorporated", continuation: "blocked-unconfirmed" });
    ctx.signal = undefined;
    await handlers.get("before_agent_start")!({ prompt: "new authorized run", systemPrompt: "" }, ctx);
    await handlers.get("turn_start")!({}, ctx);
    expect(workerHandoff(aborted)?.continuation).toBe("observed");
    await handlers.get("message_end")!({ message: { role: "assistant", stopReason: "error" } }, ctx);
    const failed = await finish("settled after parent error");
    await handlers.get("agent_settled")!({}, ctx);
    expect(sent).toHaveLength(8);
    expect(workerHandoff(failed)).toMatchObject({ delivery: "incorporated", continuation: "blocked-unconfirmed" });
    expect(listObservations().find(row => row.id === failed)?.resultTaken).not.toBe(true);
    await handlers.get("session_shutdown")!({}, ctx);
  }));

  test("spawn tool returns before the executor finishes and does not steer", fixture.ownedCase("spawn tool returns before the executor finishes and does not steer", async () => {
    process.env.PI_CODING_AGENT_DIR = load().env?.PI_CODING_AGENT_DIR;
    const hanging = hang();
    setBackgroundExecutor(hanging.executor);
    const tools = new Map<string, { execute: Function }>();
    const sent: unknown[] = [];
    const handlers = new Map<string, Function>();
    const branch: unknown[] = [];
    let idle = false;
    const pi = {
      registerTool(def: { name: string; execute: Function }) {
        tools.set(def.name, def);
      },
      sendMessage(message: unknown, options: unknown) {
        sent.push({ message, options });
        if (!(options as { triggerTurn?: boolean }).triggerTurn)
          branch.push({ type: "custom_message", ...(message as object) });
      },
      on(event: string, handler: Function) {
        const previous = handlers.get(event);
        handlers.set(event, previous
          ? async (...args: unknown[]) => { await previous(...args); return handler(...args); }
          : handler);
      },
      registerFlag() {},
      registerCommand() {},
      getFlag() {
        return undefined;
      },
      getAllTools() {
        return [{ name: "read" }];
      },
      getActiveTools() {
        return ["read"];
      },
      setActiveTools() {},
      getSessionName() {
        return "pitako:coding";
      },
      setSessionName() {},
    };
    agentInstance(pi as unknown as ExtensionAPI);
    pitako(pi as unknown as ExtensionAPI);
    const ctx = { cwd: packageRoot(), hasUI: false, isIdle: () => idle, ui: { notify() {}, setStatus() {} },
      sessionManager: { getSessionId: () => "parent", getBranch: () => branch } };
    await handlers.get("session_start")?.({}, ctx);
    const spawn = tools.get("agent_spawn");
    if (!spawn) throw new Error("agent_spawn missing");
    const result = await spawn.execute("call", { role: "developer", task: "change the widget", plan: "background-agent-delegation-test-only", unit: "T3" }, new AbortController().signal, undefined, { cwd: packageRoot() });
    expect(result.content[0].text).toContain("status: running");
    expect(hanging.started).toBeInstanceOf(Promise);
    const status = tools.get("agent_status");
    const listed = await status?.execute("call", {}, undefined, undefined, { cwd: packageRoot() });
    expect(listed.content[0].text).toContain("status: running");
    expect(listed.content[0].text).not.toContain("change the widget");
    const early = await tools.get("agent_result")?.execute("call", { id: result.details.instanceId }, undefined, undefined, { cwd: packageRoot() });
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toContain("worker is still running");
    hanging.release({ status: "completed", result: "SECRET-RESULT", sideEffects: false });
    await waitFor(result.details.instanceId);
    expect(sent).toEqual([]);
    const drafted = await handlers.get("agent_before_settle")?.({ outcome: "completed", context: { canContinue: false } }, ctx);
    expect(drafted.continue).toBe(true);
    expect(drafted.entries[0].content).toBe("SECRET-RESULT");
    expect(sent).toHaveLength(0);
    expect(workerHandoff(result.details.instanceId)?.delivery).toBe("offered");
    branch.push(...drafted.entries);
    await handlers.get("context")?.({ messages: [] }, ctx);
    expect(workerHandoff(result.details.instanceId)?.delivery).toBe("incorporated");
    expect(workerHandoff(result.details.instanceId)?.continuation).toBe("requested");
    await handlers.get("turn_start")?.({}, ctx);
    expect(workerHandoff(result.details.instanceId)?.continuation).toBe("observed");
    idle = true;
    await handlers.get("agent_settled")?.({}, ctx);
    expect(sent).toHaveLength(0);
    const childHandlers = new Map<string, Function>();
    pitako({
      ...pi,
      on(event: string, handler: Function) {
        const previous = childHandlers.get(event);
        childHandlers.set(event, previous
          ? async (...args: unknown[]) => { await previous(...args); return handler(...args); }
          : handler);
      },
      sendMessage(message: unknown, options: unknown) {
        sent.push({ message, options, child: true });
      },
    } as unknown as ExtensionAPI);
    childHandlers.get("agent_settled")?.();
    expect(sent.filter((item) => (item as { child?: boolean }).child)).toEqual([]);
  }));

  test("watched low-level workers inherit the pinned execution worktree", fixture.ownedCase("watched low-level workers inherit the pinned execution worktree", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "pitako-bg-frozen-root-"));
    tempDirs.push(base);
    const source = path.join(base, "source");
    const execution = path.join(base, "execution");
    mkdirSync(source, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: source, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial", "-q"], { cwd: source, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-q", "-b", "execution", execution], { cwd: source, stdio: "ignore" });
    const plan = planFile("background-frozen-root", source);
    mkdirSync(path.dirname(plan), { recursive: true });
    writeFileSync(plan, "---\nid: background-frozen-root\nrevision: 1\nstatus: frozen\n---\n\nPlan.\n");
    const config = load();
    const agentDir = config.env?.PI_CODING_AGENT_DIR;
    if (!agentDir) throw new Error("test agent directory missing");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let finish!: (attempt: Attempt) => void;
    let workerCwd = "";
    setBackgroundExecutor({ async start(input) {
      workerCwd = input.cwd;
      return fixture.pendingAttempt((resolve) => (finish = resolve));
    } });
    const tools = new Map<string, { execute: Function }>();
    agentInstance({ registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, preparedTool(tool)); } } as unknown as ExtensionAPI);
    bindBackgroundOwner({ token: Symbol("pinned-tree"), isIdle: () => false, hasUI: false, notify() {}, sendMessage() {} });
    const result = await tools.get("agent_spawn")!.execute("call", {
      role: "developer", task: "work in pinned tree", plan: "background-frozen-root", unit: "T3",
    }, new AbortController().signal, undefined, { cwd: execution });
    expect(result.isError).not.toBe(true);
    expect(workerCwd).toBe(execution);
    expect(existsSync(ledgerFile("background-frozen-root", execution))).toBe(true);
    finish({ status: "completed", result: "done", sideEffects: false });
    await waitFor(result.details.instanceId);
    expect(workerResult(result.details.instanceId).result).toBe("done");
  }));

  test("childActiveTools drops orchestration tools", fixture.ownedCase("childActiveTools drops orchestration tools", () => {
    const names = childActiveTools(["read", ...ORCHESTRATION_TOOLS]);
    for (const name of ORCHESTRATION_TOOLS) expect(names).not.toContain(name);
    expect(names).toContain("read");
  }));

  test("agent_spawn is refused inside an instance", fixture.ownedCase("agent_spawn is refused inside an instance", async () => {
    const tools = new Map<string, { execute: Function }>();
    agentInstance({
      registerTool(def: { name: string; execute: Function }) {
        tools.set(def.name, def);
      },
    } as unknown as ExtensionAPI);
    const result = await agentScope.run({ instanceId: "developer-child" }, () =>
      tools.get("agent_spawn")?.execute("call", { role: "developer", task: "nope" }, undefined, undefined, { cwd: packageRoot() }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cannot be called");
  }));
});

describe("parent turn during child prompt", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete (globalThis as { __pitakoHangProvider?: unknown }).__pitakoHangProvider;
  });

  test("a parent prompt completes while the child prompt is pending", fixture.ownedCase("a parent prompt completes while the child prompt is pending", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-hang-cwd-"));
    tempDirs.push(cwd);
    const config = path.join(cwd, "config.toml");
    writeFileSync(config, '[model_policies.developer.primary]\nmodel = "fixture/hang"\n');
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const attempt = fixture.pendingAttempt(() => {});
    const handle = await spawnBackground({ roleId: "developer", task: "keep working", cwd,
      load: { userConfigPath: config, env: {} },
      executor: { async start() { started(); return attempt; } } });
    await entered;
    expect(workerStatus(handle.instanceId)[0]?.status).toBe("running");
    const parent = await runAgentInstance({ roleId: "developer", task: "continue planning", cwd,
      load: { userConfigPath: config, env: {} },
      executor: { async start() { return { status: "completed", result: "parent-ok", sideEffects: false }; } } });
    expect(parent.result).toBe("parent-ok");
    expect(workerStatus(handle.instanceId)[0]?.status).toBe("running");
    cancelWorker(handle.instanceId);
  }), 60_000);
});

function pitakoAgentsCommand(): {
  run: (args: string) => Promise<{ notes: string[]; errors: string[]; threw: boolean }>;
} {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    registerFlag() {},
    registerTool() {},
    registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      handler = def.handler;
    },
    on() {},
    getFlag() {
      return undefined;
    },
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
    getSessionName() {
      return undefined;
    },
    setSessionName() {},
    sendMessage() {},
  };
  pitako(pi as unknown as ExtensionAPI);
  return {
    async run(args: string) {
      const notes: string[] = [];
      const errors: string[] = [];
      let threw = false;
      try {
        await handler?.(args, {
          hasUI: true,
          sessionManager: { getSessionId: () => "command-coordinator" },
          ui: {
            notify(message: string, kind?: string) {
              if (kind === "error") errors.push(message);
              else notes.push(message);
            },
            setStatus() {},
          },
        });
      } catch {
        threw = true;
      }
      return { notes, errors, threw };
    },
  };
}

async function waitFor(instanceId: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    try {
      workerResult(instanceId);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`worker ${instanceId} did not settle`);
}
