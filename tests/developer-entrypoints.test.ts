import { stubExternalFactories } from "./fixtures/offline.ts";
stubExternalFactories();
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import agentInstance from "../extensions/agent/index.ts";
import { subscribeChanges } from "../extensions/agent/observe.ts";
import { ownedDispatch, settlePendingDispatches } from "../extensions/agent/dispatch.ts";
import { setBackgroundExecutor, workerStatus, teamWorkerStatus, bindBackgroundOwner, clearBackgroundOwner, workerResult, shutdownBackground, cancelAllWorkers } from "../extensions/agent/background.ts";
import { beginTeamEvaluation, retireTeamEvaluation, reserveTeamRole, teamRoleReservation } from "../extensions/team.ts";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import { planFile, ledgerFile } from "../extensions/workflow.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const result = (stopReason = "stop") => ({ api: "fixture", provider: "opencode", model: "jev-1.13-free", timestamp: 1, stopReason,
  answers: { capacity: { type: "choice", choice: "developer_senior",
    probabilities: { developer_senior: 0.7, developer_mid: 0.1, developer_junior: 0.1, indeterminate: 0.1 } } } });
const fixture = agentFixtureOwnership();

test("registered background handles precede routing; reservation outlives pending cancellation", fixture.ownedCase("Developer entrypoints", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-entrypoints-"));
  fixture.directories.push(root);
  process.env.PI_CODING_AGENT_DIR = root;
  mkdirSync(path.join(root, "pitako"));
  writeFileSync(path.join(root, "pitako/config.toml"), `
[model_policies.developer.primary]
model = "fixture/mid"
[model_policies.developer_senior.primary]
model = "fixture/senior"
reasoning = "high"
`);
  const tools = new Map<string, { execute: Function }>();
  const hooks = new Map<string, Function>();
  let classifications = 0, starts = 0, seenSignal: AbortSignal | undefined, sessionId = "entrypoints";
  let gate = deferred<ReturnType<typeof result>>();
  let entered = deferred<void>();
  const records: unknown[] = [];
  const pi = { registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
    on(event: string, handler: Function) { hooks.set(event, handler); }, appendEntry(_type: string, data: unknown) { records.push(data); } } as unknown as ExtensionAPI;
  const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => path.join(root, "coordinator.jsonl") },
    modelRegistry: { async getAvailableOfType() { return [{ type: "classifier", provider: "opencode", id: "jev-1.13-free", contextWindow: 8192 }]; },
      async classify(_model: unknown, request: { state: { workbrief: string } }, options: { signal: AbortSignal }) {
        expect(request.state.workbrief).toBe("exact WorkBrief");
        classifications++; seenSignal = options.signal; entered.resolve();
        return gate.promise; // Deliberately does not settle on abort: cancellation must await us.
      } } } as unknown as ExtensionContext;
  agentInstance(pi);
  const evaluation = beginTeamEvaluation(sessionId, false)!;
  bindBackgroundOwner({ token: evaluation.token, isIdle: () => false, hasUI: true,
    notify() {}, sendMessage() {} });
  const execute = (name: string) => tools.get(name)!.execute(name, { role: "developer", task: "exact WorkBrief" }, undefined, undefined, ctx);
  let started = deferred<void>();
  setBackgroundExecutor({ async start(input) {
    starts++;
    expect(input.target.model).toBe("fixture/senior");
    expect(input.target.reasoning).toBe("high");
    expect(input.task.startsWith("Team assignment header:")
      ? teamWorkerStatus(evaluation.token, input.instanceId) : workerStatus(input.instanceId)).toHaveLength(1);
    started.resolve();
    return { status: "completed", result: "fixture", sideEffects: false };
  } });
  try {
    const spawned = await execute("agent_spawn");
    expect(spawned.details.dispatchPhase).toBe("preflight");
    expect(classifications).toBe(0);
    expect(starts).toBe(0);
    await entered.promise;
    expect(starts).toBe(0);
    gate.resolve(result());
    await started.promise;
    await fixture.settleRuns();
    expect(classifications).toBe(1);
    expect(workerStatus(spawned.details.instanceId)[0]?.status).toBe("completed");

    gate = deferred(); entered = deferred(); started = deferred();
    const acceptedTeam = await execute("team_assign");
    expect(acceptedTeam.details.dispatchPhase).toBe("preflight");
    await entered.promise;
    gate.resolve(result()); await started.promise; await fixture.settleRuns();
    expect(teamRoleReservation(evaluation, "developer")).toBeUndefined();
    expect(teamWorkerStatus(evaluation.token, acceptedTeam.details.instanceId)[0]?.status).toBe("completed");
    expect(classifications).toBe(2); expect(starts).toBe(2);

    gate = deferred(); entered = deferred();
    const aborted = await execute("agent_spawn");
    await entered.promise;
    const abortedOutcome = new Promise<void>(resolve => {
      const stop = subscribeChanges(row => { if (row.id === aborted.details.instanceId && row.lastActivityKind === "no-worker") { stop(); resolve(); } });
    });
    gate.resolve(result("aborted")); await abortedOutcome;
    expect(workerResult(aborted.details.instanceId).status).toBe("failed");
    expect(starts).toBe(2); expect(records).toHaveLength(2);

    gate = deferred(); entered = deferred();
    const frozen = planFile("pending-route", root);
    mkdirSync(path.dirname(frozen), { recursive: true });
    writeFileSync(frozen, "---\nid: pending-route\nrevision: 1\nstatus: frozen\n---\nOwned plan.\n");
    const team = await tools.get("team_assign")!.execute("watched-route",
      { role: "developer", task: "exact WorkBrief", plan: "pending-route", unit: "T2" }, undefined, undefined, ctx);
    expect(team.details.dispatchPhase).toBe("preflight");
    await entered.promise;
    const reserved = teamRoleReservation(evaluation, "developer");
    expect(reserved).toBe(team.details.id);
    expect((await execute("team_assign")).isError).toBe(true);
    expect(classifications).toBe(4);
    let settled = false;
    const shutdown = Promise.all([hooks.get("session_shutdown")!(), shutdownBackground(evaluation.token)]).then(() => { settled = true; });
    await Promise.resolve();
    expect(seenSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(teamRoleReservation(evaluation, "developer")).toBe(reserved);
    expect(existsSync(ledgerFile("pending-route", root))).toBe(false);
    expect((await execute("agent_spawn")).isError).toBe(true);
    gate.resolve(result());
    await shutdown;
    expect(starts).toBe(2);
    expect(teamRoleReservation(evaluation, "developer")).toBeUndefined();
    expect(existsSync(ledgerFile("pending-route", root))).toBe(false);

    await retireTeamEvaluation(evaluation);
    // New owner generation, then retire it while routing is physically pending.
    const fresh = beginTeamEvaluation(sessionId, false)!;
    bindBackgroundOwner({ token: fresh.token, isIdle: () => false, hasUI: false, notify() {}, sendMessage() {} });
    gate = deferred(); entered = deferred();
    await execute("team_assign");
    await entered.promise;
    const retiring = retireTeamEvaluation(fresh);
    expect(() => beginTeamEvaluation(sessionId, false)).toThrow("await retirement");
    gate.resolve(result());
    await retiring;
    const replacement = beginTeamEvaluation(sessionId, false)!;
    const replacementRole = reserveTeamRole(replacement, "developer", "replacement");
    expect(teamRoleReservation(replacement, "developer")).toBe("replacement");
    expect(starts).toBe(2);
    replacementRole.rollback();
    await retireTeamEvaluation(replacement);

    bindBackgroundOwner({ token: Symbol("changed-session"), isIdle: () => false, hasUI: false, notify() {}, sendMessage() {} });
    gate = deferred(); entered = deferred();
    await execute("agent_spawn");
    await entered.promise;
    sessionId = "changed-session";
    gate.resolve(result());
    await cancelAllWorkers();
    expect(starts).toBe(2);
    expect(records).toHaveLength(2);
  } finally {
    gate.resolve(result("aborted"));
    await cancelAllWorkers();
    await settlePendingDispatches();
    await retireTeamEvaluation(evaluation);
    setBackgroundExecutor(undefined);
    clearBackgroundOwner();
  }
}));

test("session-scoped preflight settlement does not cancel independent sessions", async () => {
  const gate = deferred<void>();
  const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id } }) as unknown as ExtensionContext;
  let signalA: AbortSignal | undefined, signalB: AbortSignal | undefined;
  const a = ownedDispatch(ctx("A"), undefined, () => true, async (signal, check) => {
    signalA = signal; await gate.promise; check();
  });
  const b = ownedDispatch(ctx("B"), undefined, () => true, async (signal, check) => {
    signalB = signal; await gate.promise; check(); return "independent";
  });
  const observed = Promise.allSettled([a, b]);
  await Promise.resolve();
  const settlement = settlePendingDispatches("A");
  expect(signalA?.aborted).toBe(true);
  expect(signalB?.aborted).toBe(false);
  gate.resolve();
  await settlement;
  const results = await observed;
  expect(results[0].status).toBe("rejected");
  expect(results[1]).toEqual({ status: "fulfilled", value: "independent" });
});
