import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import agentInstance from "../extensions/agent/index.ts";
import { ownedDispatch, settlePendingDispatches } from "../extensions/agent/dispatch.ts";
import { setBackgroundExecutor, workerStatus, teamWorkerStatus, teamWorkerResult, bindBackgroundOwner, clearBackgroundOwner } from "../extensions/agent/background.ts";
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

test("registered spawn and Team route once before synchronous acceptance; reservation outlives pending cancellation", fixture.ownedCase("Developer entrypoints", async () => {
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
  let completed = deferred<void>();
  bindBackgroundOwner({ token: evaluation.token, isIdle: () => false, hasUI: true,
    notify() { completed.resolve(); }, sendMessage() { completed.resolve(); } });
  setBackgroundExecutor({ async start(input) {
    starts++;
    expect(input.target.model).toBe("fixture/senior");
    expect(input.target.reasoning).toBe("high");
    // The row is admitted synchronously before executor's first suspension.
    expect(input.task.startsWith("Team assignment header:")
      ? teamWorkerStatus(evaluation.token, input.instanceId) : workerStatus(input.instanceId)).toHaveLength(1);
    return { status: "completed", result: "fixture", sideEffects: false };
  } });
  const execute = (name: string) => tools.get(name)!.execute(name, { role: "developer", task: "exact WorkBrief" }, undefined, undefined, ctx);
  try {
    const spawn = execute("agent_spawn");
    await entered.promise;
    expect(starts).toBe(0);
    gate.resolve(result());
    const spawned = await spawn;
    expect(spawned.isError).not.toBe(true);
    expect(starts).toBe(1);
    expect(classifications).toBe(1);
    await completed.promise;

    gate = deferred(); entered = deferred();
    const frozen = planFile("pending-route", root);
    mkdirSync(path.dirname(frozen), { recursive: true });
    writeFileSync(frozen, "---\nid: pending-route\nrevision: 1\nstatus: frozen\n---\nOwned plan.\n");
    const team = tools.get("team_assign")!.execute("watched-route",
      { role: "developer", task: "exact WorkBrief", plan: "pending-route", unit: "T2" }, undefined, undefined, ctx);
    await entered.promise;
    const reserved = teamRoleReservation(evaluation, "developer");
    expect(reserved).toBeDefined();
    const competing = await execute("team_assign");
    expect(competing.isError).toBe(true);
    expect(classifications).toBe(2);
    let settled = false;
    const shutdown = Promise.resolve(hooks.get("session_shutdown")!()).then(() => { settled = true; });
    expect(seenSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(teamRoleReservation(evaluation, "developer")).toBe(reserved);
    expect(existsSync(ledgerFile("pending-route", root))).toBe(false);
    expect((await execute("agent_spawn")).isError).toBe(true);
    expect(starts).toBe(1);
    expect(classifications).toBe(2);
    gate.resolve(result());
    expect((await team).isError).toBe(true);
    await shutdown;
    expect(starts).toBe(1);
    expect(teamRoleReservation(evaluation, "developer")).toBeUndefined();
    expect(existsSync(ledgerFile("pending-route", root))).toBe(false);

    gate = deferred(); entered = deferred();
    completed = deferred();
    const valid = execute("team_assign");
    await entered.promise;
    gate.resolve(result());
    const accepted = await valid;
    expect(accepted.isError).not.toBe(true);
    expect(accepted.details.dispatchId).toBeDefined();
    await completed.promise;
    expect(teamWorkerResult(evaluation.token, accepted.details.instanceId).status).toBe("completed");
    expect(starts).toBe(2);
    expect(records).toHaveLength(2);

    gate = deferred(); entered = deferred();
    const aborted = execute("agent_spawn");
    await entered.promise;
    gate.resolve(result("aborted"));
    expect((await aborted).isError).toBe(true);
    expect(starts).toBe(2);
    expect(records).toHaveLength(2);

    gate = deferred(); entered = deferred();
    const stale = execute("team_assign");
    await entered.promise;
    // Replacement lease cannot be erased by the old operation's rollback.
    const replacement = beginTeamEvaluation(sessionId, false)!;
    const fresh = reserveTeamRole(replacement, "developer", "replacement");
    gate.resolve(result());
    expect((await stale).isError).toBe(true);
    expect(teamRoleReservation(replacement, "developer")).toBe("replacement");
    expect(starts).toBe(2);
    fresh.rollback(); retireTeamEvaluation(replacement);

    gate = deferred(); entered = deferred();
    const changed = execute("agent_spawn");
    await entered.promise;
    sessionId = "changed-session";
    gate.resolve(result());
    expect((await changed).isError).toBe(true);
    expect(starts).toBe(2);
  } finally {
    gate.resolve(result("aborted"));
    await settlePendingDispatches();
    retireTeamEvaluation(evaluation);
    clearBackgroundOwner(); setBackgroundExecutor(undefined);
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
