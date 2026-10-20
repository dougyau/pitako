import { preparedTool } from "./fixtures/background-dispatch.ts";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cancelTeamWorker, cancelWorker, observeWorkerResults, shutdownBackground, spawnBackground, teamWorkerResult, teamWorkerStatus, workerResult, workerStatus, type ResultMessage } from "../extensions/agent/background.ts";
import type { Attempt, AttemptExecutor } from "../extensions/agent/run.ts";
import { bindBackgroundOwner, clearBackgroundOwner } from "../extensions/agent/background.ts";
import { listObservations, publishObservation, subscribeChanges } from "../extensions/agent/observe.ts";
import { registerExecution, unregisterExecution } from "../extensions/execution-identity.ts";
import { admitTeamMember, createTeam, disbandTeam, beginTeamEvaluation, hasTeamRoster, hasUnsettledTeamWork, recordPlanTeamWork, reserveTeamMember, retireTeamEvaluation, teamEvaluationForSession, firstTeamReservation, teamAssignments, selectTeamAssignments } from "../extensions/team.ts";
import { openBoard } from "../extensions/board/store.ts";
import { currentWorkspace, repositoryIdentity } from "../extensions/board/workspace.ts";
import boardExtension from "../extensions/board/index.ts";
import { ledgerFile, ledgerTemplate, openExecutionPlan, planFile, readLedgerTeamHolds, readPlan, planHash } from "../extensions/workflow.ts";
import { packageRoot } from "../extensions/stack.ts";
import agentExtension from "../extensions/agent/index.ts";
import { setBackgroundExecutor } from "../extensions/agent/background.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { controlledPi } from "./fixtures/pi-factories.ts";
import { WorkerHistory } from "../extensions/agent/history.ts";
import { createAgentController } from "../extensions/agent/controller.ts";
import { createAgentBridge } from "../extensions/agent/bridge/broker.ts";
import { connect } from "../extensions/agent/bridge/client.js";
import pitako from "../extensions/index.ts";

// File-local integration bound: parallel Git/agent setup must finish before
// Bun interrupts subprocesses; callback ownership still governs cleanup.
setDefaultTimeout(30_000);

const evaluations = new Set<ReturnType<typeof beginTeamEvaluation>>();
const fixture = agentFixtureOwnership();
const tempDirs = fixture.directories;
let previousAgentDir: string | undefined;

afterEach(async () => {
  fixture.requireReleasedFixture();
  for (const evaluation of evaluations) await retireTeamEvaluation(evaluation);
  evaluations.clear();
  clearBackgroundOwner();
  setBackgroundExecutor(undefined);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  previousAgentDir = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function evaluation(id: string) {
  const result = beginTeamEvaluation(id, false);
  if (!result) throw new Error("evaluation missing");
  evaluations.add(result);
  bindBackgroundOwner(owner(result.token));
  return result;
}

function hanging(): { executor: AttemptExecutor; started: Promise<void>; finish: (attempt: Attempt) => void; signal?: AbortSignal } {
  let start!: () => void;
  let finish!: (attempt: Attempt) => void;
  const started = new Promise<void>((resolve) => (start = resolve));
  const result = fixture.pendingAttempt((resolve) => (finish = resolve));
  const state: { signal?: AbortSignal } = {};
  return {
    started,
    finish,
    get signal() { return state.signal; },
    executor: {
      async start(input) {
        state.signal = input.signal;
        start();
        return result;
      },
    },
  };
}

function load() {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-team-"));
  tempDirs.push(dir);
  const userConfigPath = path.join(dir, "pitako", "config.toml");
  mkdirSync(path.dirname(userConfigPath), { recursive: true });
  writeFileSync(userConfigPath, `[model_policies.developer.primary]\nmodel = "example/primary"\nreasoning = "off"\n[model_policies.researcher.primary]\nmodel = "example/primary"\nreasoning = "off"\n[model_policies.architect.primary]\nmodel = "example/primary"\nreasoning = "off"\n[model_policies.reviewer.primary]\nmodel = "example/primary"\nreasoning = "off"\n`);
  writeFileSync(userConfigPath, `\n[model_policies.scout.primary]\nmodel = "example/primary"\n[model_policies.oracle.primary]\nmodel = "example/primary"\n`, { flag: "a" });
  return { userConfigPath, env: { PI_CODING_AGENT_DIR: dir } };
}

function owner(token: symbol) {
  const branch: (ResultMessage & { type: "custom_message" })[] = [];
  return { token, isIdle: () => false, hasUI: false, notify() {}, sendMessage() {},
    appendResult(message: ResultMessage) { branch.push({ type: "custom_message", ...message }); },
    getBranch: () => branch };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initWorktreePair(base: string, executionName = "execution"): { source: string; execution: string } {
  const source = path.join(base, "source");
  const execution = path.join(base, executionName);
  mkdirSync(source, { recursive: true });
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial", "-q"]);
  git(source, ["worktree", "add", "-q", "-b", "execution", execution]);
  return { source, execution };
}

async function spawn(evaluation: NonNullable<ReturnType<typeof beginTeamEvaluation>>, role: string, id: string, worker: ReturnType<typeof hanging>, onSettled: () => void, watch?: { planId: string; unitId: string }) {
  return spawnBackground({
    roleId: role,
    task: `work ${id}`,
    cwd: packageRoot(),
    executor: worker.executor,
    load: load(),
    watch,
    teamOwner: { token: evaluation.token, assignmentId: id, onSettled },
  });
}

const completed = (result = "done"): Attempt => ({ status: "completed", result, sideEffects: false });

describe("Team T1 ownership", () => {
  test("four successive members remain exact-ID accessible in admission-ordered status", fixture.ownedCase("exact assignment catalog", async () => {
    const current = evaluation("team-exact-catalog");
    bindBackgroundOwner(owner(current.token));
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)) } as unknown as ExtensionAPI);
    let finish!: (attempt: Attempt) => void;
    setBackgroundExecutor({ async start() { return fixture.pendingAttempt(resolve => { finish = resolve; }); } });
    const root = mkdtempSync(path.join(tmpdir(), "pitako-team-catalog-"));
    tempDirs.push(root);
    const context = { cwd: root, sessionManager: { getSessionId: () => current.sessionId } };
    const invoke = (name: string, params: unknown) => tools.get(name)!.execute("call", params, undefined, undefined, context);
    const ids: string[] = [];
    for (const [index, status] of (["completed", "failed", "cancelled", "completed"] as const).entries()) {
      const accepted = await invoke("team_assign", { role: "researcher", task: `assignment ${index}`, plan: "catalog-plan", unit: `T${index}` });
      expect(accepted.isError).toBe(false);
      ids.push(accepted.details.id);
      finish({ status, result: `result ${index}`, error: status === "failed" ? `result ${index}` : undefined, sideEffects: false });
      await fixture.settleRuns();
      expect(firstTeamReservation(current, "researcher")).toBeUndefined();
    }
    expect(teamAssignments(current).map(assignment => assignment.id)).toEqual(ids);
    expect(() => reserveTeamMember(current, "researcher", ids[0]!)).toThrow("already reserved");
    expect(teamAssignments(current).at(-1)?.id).toBe(ids[3]);
    expect((await invoke("team_status", {})).details.members[3]).toMatchObject({ assignmentId: ids[3], status: "completed" });
    for (const [index, id] of ids.entries()) {
      const read = await invoke("team_result", { assignmentId: id });
      expect(read.content[0].text).toContain(`result ${index}`);
      expect(read.isError).toBe(index === 1 || index === 2);
      expect((await invoke("team_status", { assignmentId: id })).details.members[0]).toMatchObject({ assignmentId: id, resultAvailable: true });
    }
    expect(hasUnsettledTeamWork(current, "catalog-plan")).toBe(true);
    expect((await invoke("team_result", { assignmentId: "foreign" })).isError).toBe(true);
  }));

  test("ledger holds are exact, durable, and fail closed", fixture.ownedCase("ledger holds are exact, durable, and fail closed", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-team-holds-"));
    tempDirs.push(cwd);
    const plan = planFile("persisted-plan", cwd);
    mkdirSync(path.dirname(plan), { recursive: true });
    const planText = "---\nid: persisted-plan\nrevision: 1\nstatus: frozen\nboard_topic_id: 1\n---\nBound workflow.\n";
    writeFileSync(plan, planText);
    const ledger = ledgerFile("persisted-plan", cwd);
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(ledger, `---\nplan_id: persisted-plan\nrevision: 1\nhash: ${planHash(planText)}\nstatus: running\n---\n\n## Team Holds\n\n<!-- pitako-team-holds:v1 -->\n[]\n<!-- /pitako-team-holds -->\n`);
    recordPlanTeamWork(cwd, "persisted-plan", "unit-a", "cancelled-assignment", "pending");
    recordPlanTeamWork(cwd, "persisted-plan", "unit-a", "cancelled-assignment", "cancelled");
    recordPlanTeamWork(cwd, "persisted-plan", "unit-b", "failed-assignment", "failed");
    expect(hasUnsettledTeamWork(undefined, "persisted-plan", cwd)).toBe(true);
    recordPlanTeamWork(cwd, "persisted-plan", "unit-c", "unrelated-success", "completed");
    expect(hasUnsettledTeamWork(undefined, "persisted-plan", cwd)).toBe(true);
    expect(readFileSync(ledger, "utf8")).toContain('"assignmentId":"cancelled-assignment"');
    expect(() => recordPlanTeamWork(cwd, "persisted-plan", "unit-d", "new", "pending")).not.toThrow();
    recordPlanTeamWork(cwd, "persisted-plan", "unit-d", "new", "completed");
    expect(hasUnsettledTeamWork(undefined, "persisted-plan", cwd)).toBe(true);
    writeFileSync(ledger, readFileSync(ledger, "utf8").replace("<!-- pitako-team-holds:v1 -->", ""));
    expect(() => hasUnsettledTeamWork(undefined, "persisted-plan", cwd)).toThrow("gate is missing or malformed");
    rmSync(ledger);
    expect(() => hasUnsettledTeamWork(undefined, "persisted-plan", cwd)).toThrow("ledger is missing");
    expect(() => recordPlanTeamWork(cwd, "persisted-plan", "unit-e", "blocked", "pending")).toThrow("ledger is missing");
  }));

  test("no-topic plans do not create a ledger or sidecar", fixture.ownedCase("no-topic plans do not create a ledger or sidecar", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-team-no-topic-"));
    tempDirs.push(cwd);
    const plan = planFile("no-topic", cwd);
    mkdirSync(path.dirname(plan), { recursive: true });
    writeFileSync(plan, "---\nid: no-topic\nrevision: 1\nstatus: frozen\n---\nNo Board topic.\n");
    recordPlanTeamWork(cwd, "no-topic", "unit", "assignment", "pending");
    expect(existsSync(path.join(path.dirname(ledgerFile("no-topic", cwd)), "team-state.json"))).toBe(false);
    expect(existsSync(ledgerFile("no-topic", cwd))).toBe(false);
  }));
  test("reserves independent same-role members and cancellation releases only its exact member", fixture.ownedCase("reserves independent same-role members and cancellation releases only its exact member", async () => {
    const current = evaluation("team-session-race");
    bindBackgroundOwner(owner(current.token));
    const developer = reserveTeamMember(current, "developer", "assignment-dev");
    const researcher = reserveTeamMember(current, "researcher", "assignment-research");
    const secondDeveloper = reserveTeamMember(current, "developer", "assignment-dev-2");
    expect(secondDeveloper.memberId).not.toBe(developer.memberId);
    secondDeveloper.commit();

    const devWorker = hanging();
    const researchWorker = hanging();
    const dev = await spawn(current, "developer", "assignment-dev", devWorker, developer.settled);
    await spawn(current, "researcher", "assignment-research", researchWorker, researcher.settled);
    developer.commit();
    researcher.commit();
    expect(hasTeamRoster(current)).toBe(true);
    await Promise.all([devWorker.started, researchWorker.started]);

    cancelTeamWorker(current.token, dev.instanceId);
    expect(developer.owns()).toBe(true);
    expect(secondDeveloper.owns()).toBe(true);
    expect(teamWorkerStatus(current.token, dev.instanceId)[0]?.status).toBe("cancelled");
    expect(() => workerResult(dev.instanceId)).toThrow("unknown worker");
    expect(() => cancelWorker(dev.instanceId)).toThrow("unknown worker");
    devWorker.finish({ status: "cancelled", result: "cancelled", sideEffects: false });
    researchWorker.finish(completed());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(developer.owns()).toBe(false);
    expect(secondDeveloper.owns()).toBe(true);
    secondDeveloper.settled();
    expect(firstTeamReservation(current, "developer")).toBeUndefined();
    expect(firstTeamReservation(current, "researcher")).toBeUndefined();
    const reused = reserveTeamMember(current, "developer", "assignment-next");
    reused.rollback();
    expect(workerStatus()).toEqual([]);
    expect(() => teamWorkerStatus(Symbol("foreign"), dev.instanceId)).toThrow("unknown Team worker");
  }));

  test("overlapping foreground leases deliver Team wakes only to their owning session", fixture.ownedCase("overlapping foreground leases deliver Team wakes only to their owning session", async () => {
    const first = evaluation("team-overlap-one");
    const second = evaluation("team-overlap-two");
    const firstMessages: string[] = [];
    const secondMessages: string[] = [];
    const firstOwner = owner(first.token), secondOwner = owner(second.token);
    bindBackgroundOwner({ ...firstOwner, isIdle: () => true, sendMessage: (text) => firstMessages.push(text) });
    const firstAdmission = reserveTeamMember(first, "developer", "first-assignment");
    const firstWorker = hanging();
    const firstHandle = await spawn(first, "developer", "first-assignment", firstWorker, firstAdmission.settled, { planId: "p", unitId: "u" });
    firstAdmission.commit();
    bindBackgroundOwner({ ...secondOwner, isIdle: () => true, sendMessage: (text) => secondMessages.push(text) });
    const secondAdmission = reserveTeamMember(second, "researcher", "second-assignment");
    const secondWorker = hanging();
    const secondHandle = await spawn(second, "researcher", "second-assignment", secondWorker, secondAdmission.settled, { planId: "p", unitId: "u" });
    secondAdmission.commit();
    firstWorker.finish(completed());
    secondWorker.finish(completed());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstMessages).toHaveLength(1);
    expect(secondMessages).toHaveLength(1);
    expect(firstOwner.getBranch()).toMatchObject([{ content: "done", details: { assignmentId: "first-assignment", instanceId: firstHandle.instanceId } }]);
    expect(secondOwner.getBranch()).toMatchObject([{ content: "done", details: { assignmentId: "second-assignment", instanceId: secondHandle.instanceId } }]);
    expect(firstMessages[0]).not.toContain("Use team_result");
  }));

  test("same-session reload retires only old Team rows and makes late settlement inert", fixture.ownedCase("same-session reload retires only old Team rows and makes late settlement inert", async () => {
    const old = evaluation("team-session-reload");
    bindBackgroundOwner(owner(old.token));
    const admission = reserveTeamMember(old, "developer", "old-assignment");
    const late = hanging();
    const oldWorker = await spawn(old, "developer", "old-assignment", late, admission.settled);
    admission.commit();
    await late.started;

    const retirement = retireTeamEvaluation(old);
    expect(late.signal?.aborted).toBe(true);
    expect(teamWorkerStatus(old.token)).toMatchObject([{ closure: { state: "pending" } }]);
    expect(firstTeamReservation(old, "developer")).toBe("old-assignment");
    expect(() => evaluation("team-session-reload")).toThrow("await retirement");
    late.finish(completed("late"));
    await retirement;
    const fresh = evaluation("team-session-reload");
    bindBackgroundOwner(owner(fresh.token));
    expect(teamWorkerStatus(old.token)).toEqual([]);
    expect(hasTeamRoster(fresh)).toBe(false);
    expect(() => teamWorkerStatus(fresh.token, oldWorker.instanceId)).toThrow("unknown Team worker");

    expect(firstTeamReservation(fresh, "developer")).toBeUndefined();
    expect(listObservations()).toEqual([]);
  }));

  test("session leases and tagged rows cannot cross session boundaries", fixture.ownedCase("session leases and tagged rows cannot cross session boundaries", async () => {
    const first = evaluation("team-session-one");
    const second = evaluation("team-session-two");
    const admission = reserveTeamMember(first, "architect", "first-assignment");
    const worker = hanging();
    const handle = await spawn(first, "architect", "first-assignment", worker, admission.settled);
    admission.commit();
    const otherAdmission = reserveTeamMember(second, "researcher", "second-assignment");
    const otherWorker = hanging();
    const otherHandle = await spawn(second, "researcher", "second-assignment", otherWorker, otherAdmission.settled);
    otherAdmission.commit();
    await Promise.all([worker.started, otherWorker.started]);
    bindBackgroundOwner(owner(first.token));

    expect(teamWorkerStatus(second.token)).toEqual([expect.objectContaining({ instanceId: otherHandle.instanceId })]);
    expect(teamWorkerStatus(first.token, handle.instanceId)).toHaveLength(1);
    expect(workerStatus()).toEqual([]);
    const retirement = Promise.all([shutdownBackground(first.token), retireTeamEvaluation(first)]);
    expect(worker.signal?.aborted).toBe(true);
    expect(otherWorker.signal?.aborted).toBe(false);
    expect(teamWorkerStatus(second.token, otherHandle.instanceId)).toHaveLength(1);
    worker.finish(completed());
    await retirement;
    expect(teamWorkerStatus(first.token)).toEqual([]);
  }));

  test("watched planning assignments deliver isolated completion wakes across busy and idle turns", fixture.ownedCase("watched planning assignments deliver isolated completion wakes across busy and idle turns", async () => {
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;
    const workers: { task: string; finish: (attempt: Attempt) => void }[] = [];
    setBackgroundExecutor({
      async start(input) {
        let finish!: (attempt: Attempt) => void;
        const result = fixture.pendingAttempt((resolve) => (finish = resolve));
        workers.push({ task: input.task, finish });
        return result;
      },
    });
    let idle = false;
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any>; promptGuidelines?: string[] }>();
    const handlers = new Map<string, Function>();
    const sent: { message: any; options: any }[] = [];
    const branch: unknown[] = [];
    const pi = {
      registerTool(tool: any) { tools.set(tool.name, preparedTool(tool)); },
      registerFlag() {}, registerCommand() {},
      on(event: string, handler: Function) { if (!handlers.has(event)) handlers.set(event, handler); },
      getFlag() { return undefined; }, getAllTools() { return []; }, getActiveTools() { return []; },
      setActiveTools() {}, getSessionName() { return undefined; }, setSessionName() {},
      sendMessage(message: any, options: any) {
        sent.push({ message, options });
        if (options.triggerTurn === false) {
          const cloned = structuredClone(message);
          branch.push({ type: "custom_message", ...cloned });
        }
      },
    };
    pitako(pi as unknown as ExtensionAPI);
    agentExtension(pi as unknown as ExtensionAPI);
    const sessionId = "team-plan-concurrent-wakes";
    const hostContext = {
      hasUI: false, isIdle: () => idle, ui: { notify() {}, setStatus() {} },
      sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
    };
    await handlers.get("session_start")?.({}, hostContext);
    const current = teamEvaluationForSession(sessionId, false)!;
    evaluations.add(current);
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-team-planning-"));
    tempDirs.push(cwd);
    const invoke = (name: string, params: unknown) => tools.get(name)!.execute("call", params, new AbortController().signal, undefined, {
      cwd, sessionManager: { getSessionId: () => sessionId },
    });
    const guidelines = tools.get("team_assign")?.promptGuidelines?.join(" ") ?? "";
    expect(guidelines).toContain("automatically supplied");
    expect(guidelines).toContain("team_result");
    const architectResult = await invoke("team_assign", {
      role: "developer", task: "Developer planning task", plan: "plan-frozen-a", unit: "developer-analysis",
    });
    const researcherResult = await invoke("team_assign", {
      role: "researcher", task: "Research planning task", plan: "plan-frozen-a", unit: "research-evidence",
    });
    expect(architectResult.isError).toBe(false);
    expect(researcherResult.isError).toBe(false);
    const architect = architectResult.details as { id: string; instanceId: string; unitId: string };
    const researcher = researcherResult.details as { id: string; instanceId: string; unitId: string };
    expect(architect.unitId).not.toBe(researcher.unitId);
    expect(workers).toHaveLength(2);

    const researchText = " \nresearch 🧬漢字\u0000e\u0301 \"quoted\"\\path\t\n ";
    const architectText = " \narchitect 🧬漢字\u0000e\u0301 \"quoted\"\\path\t\n ";
    let collected!: () => void;
    const researchReady = new Promise<void>(resolve => { collected = resolve; });
    const unsubscribe = subscribeChanges(row => {
      if (row.id === researcher.instanceId && row.handoff?.collection === "collected") collected();
    });
    fixture.beforeRelease(unsubscribe);
    workers.find((worker) => worker.task.includes("Research planning task"))!.finish(completed(researchText));
    await researchReady;
    unsubscribe();
    expect(teamWorkerStatus(current.token, researcher.instanceId)[0]?.status).toBe("completed");
    expect(sent).toEqual([]);
    const boundary = handlers.get("agent_before_settle")?.({ outcome: "completed", context: { canContinue: false } }, hostContext);
    const cloned = structuredClone(boundary.entries);
    expect(cloned).toEqual(boundary.entries);
    expect(cloned[0].details).not.toBe(boundary.entries[0].details);
    const restored = JSON.parse(JSON.stringify(boundary.entries));
    expect(boundary).toMatchObject({ continue: true, entries: [{ content: researchText, details: {
      instanceId: researcher.instanceId, assignmentId: researcher.id, ownerSessionId: sessionId,
      status: "completed", roleId: "researcher",
      planId: "plan-frozen-a", unitId: "research-evidence",
    } }] });
    expect(restored[0].content).toBe(researchText);
    expect(boundary.entries[0].details.deliveryId).toBeString();
    expect(typeof boundary.entries[0].details.foregroundRevision).toBe("number");
    expect(Object.hasOwn(boundary.entries[0].details, "ownerToken")).toBe(false);
    expect(Object.hasOwn(boundary.entries[0].details, "teamToken")).toBe(false);
    for (const [key, value] of Object.entries(boundary.entries[0].details)) {
      if (value !== undefined) expect(restored[0].details[key]).toEqual(value);
    }
    expect(listObservations(current.token).find(row => row.id === researcher.instanceId)?.teamOwnerToken).toBe(current.token);
    expect(listObservations(current.token).find(row => row.id === researcher.instanceId)?.resultTaken).not.toBe(true);
    branch.push(...restored);
    handlers.get("context")?.({}, hostContext);
    expect(listObservations(current.token).find(row => row.id === researcher.instanceId)?.handoff?.delivery).toBe("incorporated");
    expect(listObservations(current.token).find(row => row.id === researcher.instanceId)?.handoff?.continuation).toBe("requested");
    expect(listObservations(current.token).find(row => row.id === researcher.instanceId)?.resultTaken).not.toBe(true);
    handlers.get("turn_start")?.({}, hostContext);
    expect(listObservations(current.token).find(row => row.id === researcher.instanceId)?.handoff?.continuation).toBe("observed");
    expect(listObservations(current.token).find(row => row.id === researcher.instanceId)?.resultTaken).toBe(true);
    idle = true;
    handlers.get("agent_settled")?.({}, hostContext);
    expect(sent).toEqual([]);
    const consumed = await invoke("team_result", { assignmentId: researcher.id });
    expect(consumed.content[0].text).toContain(researchText);
    handlers.get("agent_settled")?.({}, hostContext);
    expect(sent).toEqual([]);

    workers.find((worker) => worker.task.includes("Developer planning task"))!.finish(completed(architectText));
    await fixture.settleRuns();
    expect(teamWorkerStatus(current.token, architect.instanceId)[0]?.status).toBe("completed");
    const architectResults = sent.filter((item) => item.message.customType === "pitako.worker.result");
    expect(architectResults).toHaveLength(1);
    const original = architectResults[0]!.message;
    expect(structuredClone(original)).toEqual(original);
    const json = JSON.parse(JSON.stringify(original));
    expect(json.content).toBe(architectText);
    for (const [key, value] of Object.entries(original.details)) {
      if (value !== undefined) expect(json.details[key]).toEqual(value);
    }
    const committed = branch.find((entry: any) => entry.details?.instanceId === architect.instanceId) as ResultMessage;
    expect(committed.content).toBe(architectText);
    expect(committed.details).toEqual(original.details);
    expect(committed.details).not.toBe(original.details);
    expect(original).toMatchObject({ content: architectText, details: {
      instanceId: architect.instanceId, assignmentId: architect.id, ownerSessionId: sessionId,
      status: "completed", roleId: "developer",
      planId: "plan-frozen-a", unitId: "developer-analysis",
    } });
    expect(original.details.deliveryId).toBeString();
    expect(typeof original.details.foregroundRevision).toBe("number");
    expect(Object.hasOwn(original.details, "ownerToken")).toBe(false);
    expect(Object.hasOwn(original.details, "teamToken")).toBe(false);
    expect(architectResults[0]?.options).toEqual({ triggerTurn: false });
    expect(sent[1]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(sent[1]?.message.content).toContain("already supplied");
    expect(sent).toHaveLength(2);
    expect(listObservations(current.token).find(row => row.id === architect.instanceId)?.teamOwnerToken).toBe(current.token);
    expect(listObservations(current.token).find(row => row.id === architect.instanceId)?.handoff).toMatchObject({
      bookkeeping: "inapplicable", delivery: "incorporated", continuation: "requested",
    });
    expect(listObservations(current.token).find(row => row.id === architect.instanceId)?.resultTaken).not.toBe(true);
    handlers.get("turn_start")?.({}, hostContext);
    expect(listObservations(current.token).find(row => row.id === architect.instanceId)?.handoff?.continuation).toBe("observed");
    expect(listObservations(current.token).find(row => row.id === architect.instanceId)?.resultTaken).toBe(true);
    const reread = await invoke("team_result", { assignmentId: architect.id });
    expect(reread.content[0].text).toContain(architectText);
    handlers.get("agent_settled")?.({}, hostContext);
    handlers.get("agent_settled")?.({}, hostContext);
    expect(sent).toHaveLength(2);
  }));

  test("public Team tools accept concurrent roles, isolate low-level controls, and retain complete results", fixture.ownedCase("public Team tools and complete results", async () => {
    const current = evaluation("team-public-tools");
    let idle = false;
    const wakes: string[] = [];
    bindBackgroundOwner({ ...owner(current.token), isIdle: () => idle, sendMessage: (text) => wakes.push(text) });
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)) } as unknown as ExtensionAPI);
    const workers: { task: string; started: Promise<void>; finish: (attempt: Attempt) => void }[] = [];
    setBackgroundExecutor({
      async start(input) {
        let start!: () => void;
        let finish!: (attempt: Attempt) => void;
        const started = new Promise<void>((resolve) => (start = resolve));
        const result = fixture.pendingAttempt((resolve) => (finish = resolve));
        workers.push({ task: input.task, started, finish });
        start();
        return result;
      },
    });
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-team-public-"));
    tempDirs.push(cwd);
    const draftPlan = planFile("plan-a", cwd);
    mkdirSync(path.dirname(draftPlan), { recursive: true });
    writeFileSync(draftPlan, "---\nid: plan-a\nrevision: 1\nstatus: draft\n---\n\nPlanning draft.\n");
    const ctx = { cwd, sessionManager: { getSessionId: () => current.sessionId } };
    const invoke = (name: string, params: unknown) => tools.get(name)!.execute("call", params, new AbortController().signal, undefined, ctx);
    const status = await invoke("team_status", {});
    expect(status.details.members).toEqual([]);
    const assignTool = tools.get("team_assign") as any;
    expect(assignTool.promptGuidelines.join(" ")).toContain("team_result");
    expect(assignTool.promptGuidelines.join(" ")).toContain("independent long work");
    expect((await invoke("team_assign", { role: "developer", task: "unrelated", boardTopicId: "1" })).isError).toBe(true);
    wakes.length = 0; // The no-worker failure has already been incorporated.
    const firstAssignment = await invoke("team_assign", { role: "developer", task: "Inspect lease\nsecond line", plan: "plan-a", unit: "unit-a" });
    expect(firstAssignment.isError).toBe(false);
    expect(existsSync(ledgerFile("plan-a", cwd))).toBe(false);
    const researchAssignment = await invoke("team_assign", { role: "researcher", task: "Inspect evidence" });
    expect(researchAssignment.isError).toBe(false);
    await Promise.all(workers.map((worker) => worker.started));
    expect(workers).toHaveLength(2);
    expect(workers[0]!.task).toContain(`Team ${firstAssignment.details.teamId}; member ${firstAssignment.details.memberId}; role developer; assignment `);
    expect(workers[0]!.task).not.toContain("Board topic");
    expect(workers[0]!.task).toContain("WorkBrief:\nInspect lease");
    expect(teamAssignments(current).find(member => member.id === firstAssignment.details.id)?.boardTopicId).toBeUndefined();
    const overlap = await invoke("team_assign", { role: "developer", task: "overlap" });
    expect(overlap.isError).toBe(false);
    expect(overlap.details.memberId).not.toBe(firstAssignment.details.memberId);
    for (const key of ["teamId", "memberId", "assignmentId", "instanceId", "dispatchId"]) {
      expect(firstAssignment.details[key]).toBeString();
      expect(firstAssignment.content[0].text).toContain(firstAssignment.details[key]);
    }
    expect((await invoke("team_status", { teamId: overlap.details.teamId, memberId: overlap.details.memberId })).details.members).toHaveLength(1);
    for (const [params, message] of [
      [{ teamId: "foreign", memberId: overlap.details.memberId }, "unknown Team"],
      [{ assignmentId: firstAssignment.details.id, memberId: overlap.details.memberId }, "unknown Team member or incompatible filters"],
    ] as const) {
      expect(await invoke("team_status", params)).toEqual({
        content: [{ type: "text", text: `Error: ${message}` }], details: { error: message }, isError: true,
      });
    }
    expect(await invoke("team_result", { assignmentId: firstAssignment.details.id })).toEqual({
      content: [{ type: "text", text: "Error: worker is still running" }],
      details: { error: "worker is still running" }, isError: true,
    });
    const unknown = "foreign".repeat(1000);
    expect(await invoke("team_result", { assignmentId: unknown })).toEqual({
      content: [{ type: "text", text: `Error: unknown Team assignment ${unknown}` }],
      details: { error: `unknown Team assignment ${unknown}` }, isError: true,
    });
    const paging = await invoke("team_result", { assignmentId: firstAssignment.details.id, cursor: unknown });
    expect(paging.details).toEqual({ table: true });
    expect(paging.isError).toBe(true);
    expect(JSON.parse(paging.content[0].text).error).toBe("table_request_failed");
    expect(Buffer.byteLength(JSON.stringify(paging), "utf8")).toBeLessThanOrEqual(4096);
    for (const name of ["team_status", "team_result"]) {
      const noSession = await tools.get(name)!.execute("call", { assignmentId: unknown }, undefined, undefined, { cwd });
      expect(noSession).toEqual({
        content: [{ type: "text", text: "Error: Team requires a foreground session identity" }],
        details: { error: "Team requires a foreground session identity" }, isError: true,
      });
    }
    const views = await invoke("team_status", {});
    expect((views.details as any).members.map((row: any) => row.status)).toEqual(["failed", "running", "running", "running"]);
    const developer = teamAssignments(current).find(member => member.id === firstAssignment.details.id);
    expect(developer).toBeDefined();
    publishObservation({
      id: developer!.instanceId, roleId: "developer", status: "running", phase: "working",
      task: "Inspect lease", acceptedAt: Date.now() - 2500, selectedModel: "example/model",
      appliedReasoning: "high", lastActivityKind: "tool", activeTool: { name: "grep", startedAt: Date.now() - 500 },
      teamOwnerToken: current.token,
      origin: { source: "team_assign", coordinatorSessionId: current.sessionId, assignmentId: developer!.id, workbrief: "Inspect lease\nsecond line" },
    });
    const devStatus = (await invoke("team_status", {})).details as any;
    expect(devStatus.members[1]).toMatchObject({
      task: "Inspect lease", model: "example/model", reasoning: "high", activity: { name: "grep" },
    });
    expect(devStatus.members[1].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(() => workerResult(developer!.instanceId)).toThrow("unknown worker");
    expect(() => cancelWorker(developer!.instanceId)).toThrow("unknown worker");
    const agentResult = await invoke("agent_result", { id: developer!.instanceId });
    expect(agentResult.isError).toBe(true);
    idle = true;
    workers[0]!.finish({
      ...completed("x".repeat(9000)),
      usage: {
        input: 10, output: 4, turns: 2, toolCalls: 6,
        tools: { edit: 1, write: 2, apply_patch: 3 },
      },
    });
    workers[1]!.finish(completed("research done"));
    workers[2]!.finish(completed("independent developer done"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wakes).toHaveLength(3);
    const ready = (await invoke("team_status", {})).details as any;
    expect(ready.members[1]).toMatchObject({ status: "completed", resultAvailable: true });
    expect(ready.members[0]).toMatchObject({ role: "developer", status: "failed" });
    const result = await invoke("team_result", { assignmentId: developer!.id });
    expect(result.content[0].text).toContain("x".repeat(9000));
    expect(result.details).not.toHaveProperty("truncated");
    expect((result.details as any).usage).toMatchObject({
      tools: { edit: 1, write: 2, apply_patch: 3 },
    });
    expect((await invoke("team_result", { assignmentId: researchAssignment.details.id })).content[0].text).toContain("research done");
    expect(wakes.every((text) => text.includes("already supplied"))).toBe(true);
    expect(wakes.some((text) => text.includes("Use agent_result"))).toBe(false);
    expect((await invoke("team_assign", { role: "developer", task: "Next task" })).isError).toBe(false);
    const cancelled = await invoke("team_assign", { role: "developer", task: "Cancel test", plan: "plan-a", unit: "cancel-test" });
    expect(cancelled.isError).toBe(false);
    const reviewer = teamAssignments(current).find(member => member.id === cancelled.details.id)!;
    await workers.at(-1)!.started;
    const cancelResult = await invoke("team_cancel", { assignmentId: reviewer.id });
    expect(cancelResult.isError).toBe(false);
    expect(cancelResult.details).toMatchObject({ assignmentId: reviewer.id, instanceId: reviewer.instanceId,
      status: "cancelled", closure: { state: "pending" } });
    expect(JSON.parse(cancelResult.content[0].text)).toEqual(cancelResult.details);
    expect(cancelResult.details).not.toHaveProperty("table");
    const cancelledStatus = await invoke("team_status", { assignmentId: reviewer.id });
    expect((cancelledStatus.details as any).members[0]).toMatchObject({ status: "cancelled", resultAvailable: false });
    workers.at(-1)!.finish({ status: "cancelled", result: "cancelled", sideEffects: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(((await invoke("team_status", { assignmentId: reviewer.id })).details as any).members[0].resultAvailable).toBe(true);
  }));

  test("team_result returns stable per-assignment execution summaries on diagnostic re-reads", fixture.ownedCase("Team diagnostic summaries", async () => {
    const current = evaluation("team-execution-summary");
    bindBackgroundOwner(owner(current.token));
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;
    writeFileSync(config.userConfigPath, `[model_policies.developer.primary]\nmodel = "provider-one/dev-model"\nreasoning = "high"\n[model_policies.researcher.primary]\nmodel = "provider-two/research-model"\nreasoning = "medium"\n`);

    const workers: { role: string; model: string; finish: (attempt: Attempt) => void }[] = [];
    setBackgroundExecutor({
      start(input) {
        if (input.role.id === "developer") input.onActivated?.("high");
        return fixture.pendingAttempt((resolve) => workers.push({ role: input.role.id, model: input.target.model, finish: resolve }));
      },
    });
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)) } as unknown as ExtensionAPI);
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-team-summary-"));
    tempDirs.push(cwd);
    const ctx = { cwd, sessionManager: { getSessionId: () => current.sessionId } };
    const invoke = (name: string, params: unknown) => tools.get(name)!.execute("call", params, new AbortController().signal, undefined, ctx);
    const [developerResult, researcherResult] = await Promise.all([
      invoke("team_assign", { role: "developer", task: "developer summary" }),
      invoke("team_assign", { role: "researcher", task: "research summary" }),
    ]);
    const developer = developerResult.details as { id: string; instanceId: string };
    const researcher = researcherResult.details as { id: string; instanceId: string };
    expect(workers.map(({ role }) => role).sort()).toEqual(["developer", "researcher"]);
    expect(workers.map(({ model }) => model).sort()).toEqual(["provider-one/dev-model", "provider-two/research-model"]);

    workers.find((worker) => worker.role === "developer")!.finish({
      status: "completed", result: "developer done", sideEffects: false, appliedReasoning: "high",
      usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 1, cost: 0.25, turns: 2, toolCalls: 3, tools: { read: 1, grep: 2 }, contextTokens: 512 },
    });
    workers.find((worker) => worker.role === "researcher")!.finish({
      status: "completed", result: "research done", sideEffects: false,
      usage: { input: 20, output: 4 },
    });
    for (let i = 0; i < 50 && (teamWorkerStatus(current.token, developer.instanceId)[0]?.status !== "completed" || teamWorkerStatus(current.token, researcher.instanceId)[0]?.status !== "completed"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const exactRun = teamWorkerResult(current.token, developer.instanceId);
    const developerRead = await invoke("team_result", { assignmentId: developer.id });
    const devDetails = developerRead.details as any;
    expect(devDetails.assignmentId).toBe(developer.id);
    expect(devDetails.summary).toEqual({
      assignmentId: developer.id, selectedModel: "provider-one/dev-model", provider: "provider-one", appliedReasoning: "high",
      elapsedMs: exactRun.watchdog?.elapsedMs, turns: 2, toolCalls: 3, tools: { read: 1, grep: 2 },
      input: 12, output: 3, cacheRead: 4, cacheWrite: 1, contextTokens: 512, estimatedCost: 0.25,
    });
    expect(developerRead.content[0].text).toContain(`execution summary: assignment=${developer.id}`);
    expect(developerRead.content[0].text).toContain("estimated_cost=$0.250000 (Pi estimate; not billing)");
    const developerReadAgain = await invoke("team_result", { assignmentId: developer.id });
    expect((developerReadAgain.details as any).summary).toEqual(devDetails.summary);
    expect(developerReadAgain.content[0].text).toBe(developerRead.content[0].text);

    const researcherRead = await invoke("team_result", { assignmentId: researcher.id });
    expect((researcherRead.details as any).summary).toMatchObject({
      assignmentId: researcher.id, selectedModel: "provider-two/research-model", provider: "provider-two", appliedReasoning: "unknown",
      input: 20, output: 4, cacheRead: null, cacheWrite: null, contextTokens: null, estimatedCost: null,
      turns: null, toolCalls: null, tools: null,
    });
    expect(researcherRead.content[0].text).toContain("cache_read=unavailable");
  }));

  test("watched Team assignments inherit only a validated plan topic", fixture.ownedCase("watched Team assignments inherit only a validated plan topic", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-team-binding-"));
    tempDirs.push(cwd);
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;
    const db = await openBoard();
    const bound = db.createTopic(cwd, { title: "Bound" });
    db.claimTopic(cwd, bound.id, "bound-plan");
    db.createTopic(cwd, { title: "Explicit conflict" });
    db.createTopic(cwd, { title: "Planning exception" });
    db.createTopic("/other-workspace", { title: "Foreign workspace" });
    db.close();
    const writePlan = (id: string, extra = "") => {
      const file = planFile(id, cwd);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `---\nid: ${id}\nrevision: 1\nstatus: frozen\n${extra}---\n\nPlan.\n`);
    };
    writePlan("bound-plan", "board_topic_id: 1\n");
    const boundMeta = readPlan("bound-plan", cwd).meta;
    const boundLedger = ledgerFile("bound-plan", cwd);
    mkdirSync(path.dirname(boundLedger), { recursive: true });
    writeFileSync(boundLedger, ledgerTemplate(boundMeta));
    writePlan("empty-plan");
    writePlan("stale-plan", "board_topic_id: 999\n");
    writePlan("mismatch-plan", "board_topic_id: 1\n");
    writePlan("foreign-plan", "board_topic_id: 3\n");
    const current = evaluation("team-plan-binding");
    let idle = false;
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    const handlers = new Map<string, Function>();
    const branch: unknown[] = [];
    pitako({
      registerTool(tool: any) { tools.set(tool.name, preparedTool(tool)); }, registerFlag() {}, registerCommand() {},
      on(event: string, handler: Function) { handlers.set(event, handler); }, getFlag() { return undefined; },
      getAllTools() { return []; }, getActiveTools() { return []; }, setActiveTools() {},
      getSessionName() { return undefined; }, setSessionName() {}, sendMessage(message: unknown) { branch.push({ type: "custom_message", ...(message as object) }); },
    } as unknown as ExtensionAPI);
    boardExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)), registerFlag() {}, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)) } as unknown as ExtensionAPI);
    const sessionContext = { hasUI: false, isIdle: () => idle, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => current.sessionId, getBranch: () => branch } };
    await handlers.get("session_start")?.({}, sessionContext);
    await handlers.get("session_start")?.({}, sessionContext);
    const afterReload = await openBoard();
    expect(afterReload.readTopic(cwd, 1).topic.status).toBe("open");
    afterReload.close();
    const tasks: string[] = [];
    const finishes: ((attempt: Attempt) => void)[] = [];
    setBackgroundExecutor({ async start(input) {
      tasks.push(input.task);
      return fixture.pendingAttempt((resolve) => finishes.push(resolve));
    } });
    const invoke = (params: unknown) => tools.get("team_assign")!.execute("call", params, new AbortController().signal, undefined, {
      cwd, sessionManager: { getSessionId: () => current.sessionId },
    });
    expect((await invoke({ role: "developer", task: "invalid", plan: "bound-plan", unit: "x", boardTopicId: "1; injected" })).isError).toBe(true);
    expect((await invoke({ role: "developer", task: "overflow", plan: "bound-plan", unit: "x", boardTopicId: "9007199254740992" })).isError).toBe(true);
    expect((await invoke({ role: "developer", task: "conflict", plan: "bound-plan", unit: "x", boardTopicId: "2" })).isError).toBe(true);
    expect((await invoke({ role: "developer", task: "stale", plan: "stale-plan", unit: "x" })).isError).toBe(true);
    expect((await invoke({ role: "developer", task: "owner mismatch", plan: "mismatch-plan", unit: "x" })).isError).toBe(true);
    expect((await invoke({ role: "developer", task: "foreign workspace", plan: "foreign-plan", unit: "x" })).isError).toBe(true);
    expect((await invoke({ role: "developer", task: "existing unbound explicit", plan: "empty-plan", unit: "x", boardTopicId: "3" })).isError).toBe(true);
    expect(tasks).toHaveLength(0);
    rmSync(boundLedger);
    const boundResult = await invoke({ role: "developer", task: "bound", plan: "bound-plan", unit: "T2", boardTopicId: "1" });
    expect(boundResult).toMatchObject({ isError: false });
    expect(existsSync(boundLedger)).toBe(true);
    expect(tasks.at(-1)).toContain("Board topic 1");
    const assigned = boundResult.details as { id: string };
    await tools.get("team_cancel")!.execute("cancel", { assignmentId: assigned.id }, undefined, undefined, { cwd, sessionManager: { getSessionId: () => current.sessionId } });
    const lifecycle = tools.get("board_workflow_lifecycle")!;
    const premature = await lifecycle.execute("lifecycle", { planId: "bound-plan", status: "resolved" }, undefined, undefined, { cwd, sessionManager: { getSessionId: () => current.sessionId } });
    expect(premature.isError).toBe(true);
    const stillOpen = await openBoard();
    expect(stillOpen.readTopic(cwd, 1).topic.status).toBe("open");
    stillOpen.close();
    expect((await invoke({ role: "developer", task: "unbound", plan: "empty-plan", unit: "T2" })).isError).toBe(false);
    expect(tasks.at(-1)).not.toContain("Board topic");
    const missingResult = await invoke({ role: "developer", task: "missing", plan: "missing-plan", unit: "T2", boardTopicId: "3" });
    expect(missingResult).toMatchObject({ isError: false });
    expect(tasks.at(-1)).toContain("Board topic 3");
    expect((await invoke({ role: "researcher", task: "unrelated" })).isError).toBe(false);
    expect(tasks.at(-1)).not.toContain("Board topic");
    const topicsAfterDispatch = await openBoard();
    expect(topicsAfterDispatch.listTopics(cwd, { status: "open" }).total).toBe(3);
    topicsAfterDispatch.close();
    finishes.forEach((finish) => finish(completed()));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }));

  test("individual Team roles inherit the execution worktree from a sibling frozen plan", fixture.ownedCase("individual Team roles inherit the execution worktree from a sibling frozen plan", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "pitako-team-execution-root-"));
    tempDirs.push(base);
    const { source, execution } = initWorktreePair(base);
    const id = "team-execution-root";
    const sourcePlan = planFile(id, source);
    mkdirSync(path.dirname(sourcePlan), { recursive: true });
    writeFileSync(sourcePlan, `---\nid: ${id}\nrevision: 1\nstatus: frozen\n---\n\nSibling source.\n`);
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;
    const current = evaluation("team-four-roles-execution-root");
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)) } as unknown as ExtensionAPI);
    const workers: { cwd: string; finish: (attempt: Attempt) => void }[] = [];
    setBackgroundExecutor({ async start(input) {
      return fixture.pendingAttempt((resolve) => workers.push({ cwd: input.cwd, finish: resolve }));
    } });
    const ctx = { cwd: execution, sessionManager: { getSessionId: () => current.sessionId } };
    for (const role of ["developer", "researcher", "scout", "oracle"]) {
      const result = await tools.get("team_assign")!.execute("call", {
        role, task: `work as ${role}`, plan: id, unit: "T3",
      }, new AbortController().signal, undefined, ctx);
      expect(result.isError).toBe(false);
      expect((result.details as { execution: { executionRoot: string } }).execution.executionRoot).toBe(execution);
    }
    for (let i = 0; i < 50 && workers.length !== 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workers).toHaveLength(4);
    expect(workers.map((worker) => worker.cwd)).toEqual([execution, execution, execution, execution]);
    expect(existsSync(ledgerFile(id, execution))).toBe(true);
    workers.forEach((worker) => worker.finish(completed()));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }));

  test("cold concurrent watched assignments admit only one execution root", fixture.ownedCase("cold concurrent watched assignments admit only one execution root", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "pitako-team-cold-admission-"));
    tempDirs.push(base);
    const { source, execution: executionA } = initWorktreePair(base);
    const executionB = path.join(base, "execution-b");
    git(source, ["worktree", "add", "-q", "-b", "execution-b", executionB]);
    const id = "team-cold-admission";
    const sourcePlan = planFile(id, source);
    mkdirSync(path.dirname(sourcePlan), { recursive: true });
    writeFileSync(sourcePlan, `---\nid: ${id}\nrevision: 1\nstatus: frozen\n---\n\nSibling source.\n`);
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;
    const first = evaluation("team-cold-admission-a");
    const second = evaluation("team-cold-admission-b");
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)) } as unknown as ExtensionAPI);
    const started: string[] = [];
    setBackgroundExecutor({ async start(input) {
      started.push(input.cwd);
      return completed("started");
    } });
    const assign = (team: ReturnType<typeof evaluation>, role: string, cwd: string, planId = id) =>
      tools.get("team_assign")!.execute("call", { role, task: `work in ${cwd}`, plan: planId, unit: "T3" }, new AbortController().signal, undefined, {
        cwd, sessionManager: { getSessionId: () => team.sessionId },
      });

    const results = await Promise.all([
      assign(first, "developer", executionA),
      assign(second, "researcher", executionB),
    ]);
    const accepted = results.filter((result) => !result.isError);
    const rejected = results.filter((result) => result.isError);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.content[0]!.text).toContain("competing ledger");
    const assignment = accepted[0]!.details as { execution: { executionRoot: string } };
    expect([executionA, executionB]).toContain(assignment.execution.executionRoot);
    expect(started).toEqual([assignment.execution.executionRoot]);
    expect(existsSync(ledgerFile(id, assignment.execution.executionRoot))).toBe(true);
    const loser = assignment.execution.executionRoot === executionA ? executionB : executionA;
    expect(existsSync(ledgerFile(id, loser))).toBe(false);

    const sequentialId = "team-sequential-admission";
    const sequentialPlan = planFile(sequentialId, source);
    writeFileSync(sequentialPlan, `---\nid: ${sequentialId}\nrevision: 1\nstatus: frozen\n---\n\nSibling source.\n`);
    const firstRoot = await assign(first, "developer", executionA, sequentialId);
    const secondRoot = await assign(second, "researcher", executionB, sequentialId);
    expect(firstRoot.isError).toBe(false);
    expect((firstRoot.details as { execution: { executionRoot: string } }).execution.executionRoot).toBe(executionA);
    expect(secondRoot.isError).toBe(true);
    expect(secondRoot.content[0]!.text).toContain("competing ledger");
    expect(started).toEqual([assignment.execution.executionRoot, executionA]);
    expect(existsSync(ledgerFile(sequentialId, executionA))).toBe(true);
    expect(existsSync(ledgerFile(sequentialId, executionB))).toBe(false);
  }));

  test("failed Team assignment leaves topic unpinned until ledger admission succeeds", fixture.ownedCase("failed Team assignment leaves topic unpinned until ledger admission succeeds", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "pitako-team-topic-admission-"));
    tempDirs.push(base);
    const { source, execution: executionA } = initWorktreePair(base);
    const executionB = path.join(base, "execution-b");
    git(source, ["worktree", "add", "-q", "-b", "execution-b", executionB]);
    const id = "team-topic-admission";
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;

    const board = await openBoard();
    const topic = board.createTopic(repositoryIdentity(source), { title: "Unpinned execution" });
    board.claimTopic(repositoryIdentity(source), topic.id, id);
    board.close();
    const sourcePlan = planFile(id, source);
    mkdirSync(path.dirname(sourcePlan), { recursive: true });
    writeFileSync(sourcePlan, `---\nid: ${id}\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\nexecution: expected\n---\n\nPlan.\n`);
    openExecutionPlan(id, executionB);

    const teamA = evaluation("team-topic-admission-a");
    const teamB = evaluation("team-topic-admission-b");
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)) } as unknown as ExtensionAPI);
    const started: string[] = [];
    setBackgroundExecutor({ async start(input) { started.push(input.cwd); return completed(); } });
    const assign = (team: ReturnType<typeof evaluation>, cwd: string) => tools.get("team_assign")!.execute("assign", {
      role: "developer", task: "claim only after admission", plan: id, unit: "T4",
    }, new AbortController().signal, undefined, { cwd, sessionManager: { getSessionId: () => team.sessionId } });

    const rejected = await assign(teamA, executionA);
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]!.text).toContain("competing ledger");
    expect(existsSync(ledgerFile(id, executionA))).toBe(false);
    const afterReject = await openBoard();
    expect(afterReject.readTopic(repositoryIdentity(executionA), topic.id).topic).toMatchObject({
      planRevision: null, planHash: null, executionRoot: null,
    });
    afterReject.close();

    const accepted = await assign(teamB, executionB);
    expect(accepted.isError).toBe(false);
    expect(started).toEqual([executionB]);
    expect((accepted.details as { execution: { executionRoot: string } }).execution.executionRoot).toBe(executionB);
    const afterAccept = await openBoard();
    expect(afterAccept.readTopic(repositoryIdentity(executionB), topic.id).topic.executionRoot).toBe(executionB);
    afterAccept.close();
  }));

  test("Team result and lifecycle keep using captured execution ledger after cwd changes", fixture.ownedCase("Team result and lifecycle keep using captured execution ledger after cwd changes", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "pitako-team-result-root-"));
    tempDirs.push(base);
    const { source, execution } = initWorktreePair(base, "execution ");
    const id = "team-result-root";
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;
    const workspace = currentWorkspace(execution);
    const board = await openBoard();
    const topic = board.createTopic(workspace, { title: "Bound execution" });
    board.claimTopic(workspace, topic.id, id);
    board.close();
    const sourcePlan = planFile(id, source);
    mkdirSync(path.dirname(sourcePlan), { recursive: true });
    const planText = `---\nid: ${id}\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\nexecution: expected\n---\n\nSibling source.\n`;
    writeFileSync(sourcePlan, planText);
    const opened = openExecutionPlan(id, execution);
    const current = evaluation("team-result-cwd-change");
    bindBackgroundOwner(owner(current.token));
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    boardExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)), registerFlag() {}, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)) } as unknown as ExtensionAPI);
    let finish!: (attempt: Attempt) => void;
    let workerCwd = "";
    setBackgroundExecutor({ async start(input) {
      workerCwd = input.cwd;
      return fixture.pendingAttempt((resolve) => (finish = resolve));
    } });
    const executionCtx = { cwd: execution, sessionManager: { getSessionId: () => current.sessionId } };
    const assigned = await tools.get("team_assign")!.execute("call", {
      role: "developer", task: "edit execution tree", plan: id, unit: "T3",
    }, new AbortController().signal, undefined, executionCtx);
    expect(assigned.isError).toBe(false);
    const assignment = assigned.details as { id: string; instanceId: string; execution: { executionRoot: string } };
    expect(workerCwd).toBe(execution);
    expect(assignment.execution.executionRoot).toBe(execution);
    expect(readLedgerTeamHolds(execution, id, opened.binding)).toEqual([
      { assignmentId: assignment.id, unitId: "T3", status: "pending" },
    ]);
    const ledger = ledgerFile(id, execution);
    writeFileSync(ledger, readFileSync(ledger, "utf8").replace("status: running", "status: completed"));
    const sourceCtx = { cwd: source, sessionManager: executionCtx.sessionManager };
    const foreignRootLifecycle = await tools.get("board_workflow_lifecycle")!.execute("call", {
      planId: id, status: "resolved",
    }, undefined, undefined, sourceCtx);
    expect(foreignRootLifecycle.isError).toBe(true);
    expect(foreignRootLifecycle.content[0].text).toContain("does not match Board topic execution worktree");
    const blockedLifecycle = await tools.get("board_workflow_lifecycle")!.execute("call", {
      planId: id, status: "resolved",
    }, undefined, undefined, executionCtx);
    expect(blockedLifecycle.isError).toBe(true);
    expect(blockedLifecycle.content[0].text).toContain("Team work for this plan is pending");

    finish(completed("result"));
    await fixture.settleRuns();
    expect(readLedgerTeamHolds(execution, id, opened.binding)).toEqual([]);
    const result = await tools.get("team_result")!.execute("call", { assignmentId: assignment.id }, undefined, undefined, sourceCtx);
    expect(result.content[0].text).toContain(`execution summary: assignment=${assignment.id}`);
    expect(result.content[0].text).toMatch(/\n\nresult$/);
    expect(readLedgerTeamHolds(execution, id, opened.binding)).toEqual([]);
    expect(existsSync(ledgerFile(id, source))).toBe(false);
    const resolved = await tools.get("board_workflow_lifecycle")!.execute("call", {
      planId: id, status: "resolved",
    }, undefined, undefined, executionCtx);
    expect(resolved.isError).not.toBe(true);
    const finalBoard = await openBoard();
    expect(finalBoard.readTopic(repositoryIdentity(execution), topic.id).topic.status).toBe("resolved");
    finalBoard.close();
  }));

  test("lifecycle rejects leave execution topic unpinned and allow execution from B", fixture.ownedCase("lifecycle rejects leave execution topic unpinned and allow execution from B", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "pitako-lifecycle-topic-preflight-"));
    tempDirs.push(base);
    const { source, execution } = initWorktreePair(base);
    const id = "lifecycle-topic-preflight";
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;

    const board = await openBoard();
    const topic = board.createTopic(repositoryIdentity(source), { title: "Expected execution" });
    board.claimTopic(repositoryIdentity(source), topic.id, id);
    board.close();
    const sourcePlan = planFile(id, source);
    mkdirSync(path.dirname(sourcePlan), { recursive: true });
    writeFileSync(sourcePlan, `---\nid: ${id}\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\nexecution: expected\n---\n\nPlan.\n`);

    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    boardExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)), registerFlag() {}, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)) } as unknown as ExtensionAPI);
    const lifecycle = tools.get("board_workflow_lifecycle")!;
    const fromA = { cwd: source, sessionManager: { getSessionId: () => "lifecycle-preflight-a" } };
    const noLedger = await lifecycle.execute("no-ledger", { planId: id, status: "resolved" }, undefined, undefined, fromA);
    expect(noLedger.isError).toBe(true);
    expect(noLedger.content[0]!.text).toContain("only after the ledger is completed");
    const afterNoLedger = await openBoard();
    expect(afterNoLedger.readTopic(repositoryIdentity(source), topic.id).topic).toMatchObject({
      status: "open", planRevision: null, planHash: null, executionRoot: null,
    });
    afterNoLedger.close();

    const meta = readPlan(id, source).meta;
    const ledger = ledgerFile(id, source);
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(ledger, ledgerTemplate(meta));
    recordPlanTeamWork(source, id, "T4", "pending-assignment", "pending");
    writeFileSync(ledger, readFileSync(ledger, "utf8").replace("status: running", "status: completed"));
    const pendingHold = await lifecycle.execute("pending-hold", { planId: id, status: "resolved" }, undefined, undefined, fromA);
    expect(pendingHold.isError).toBe(true);
    expect(pendingHold.content[0]!.text).toContain("Team work for this plan is pending");
    const afterPendingHold = await openBoard();
    expect(afterPendingHold.readTopic(repositoryIdentity(source), topic.id).topic).toMatchObject({
      status: "open", planRevision: null, planHash: null, executionRoot: null,
    });
    afterPendingHold.close();
    rmSync(ledger);

    const current = evaluation("lifecycle-topic-preflight-b");
    const started: string[] = [];
    setBackgroundExecutor({ async start(input) { started.push(input.cwd); return completed(); } });
    const assigned = await tools.get("team_assign")!.execute("assign", {
      role: "developer", task: "continue from B", plan: id, unit: "T4",
    }, new AbortController().signal, undefined, { cwd: execution, sessionManager: { getSessionId: () => current.sessionId } });
    expect(assigned.isError).toBe(false);
    expect(started).toEqual([execution]);
    const afterB = await openBoard();
    expect(afterB.readTopic(repositoryIdentity(execution), topic.id).topic.executionRoot).toBe(execution);
    afterB.close();

    const closeId = "lifecycle-close-no-pin";
    const closeTopic = await openBoard();
    const abandoned = closeTopic.createTopic(repositoryIdentity(source), { title: "Abandon without pin" });
    closeTopic.claimTopic(repositoryIdentity(source), abandoned.id, closeId);
    closeTopic.close();
    const closePlan = planFile(closeId, source);
    writeFileSync(closePlan, `---\nid: ${closeId}\nrevision: 1\nstatus: frozen\nboard_topic_id: ${abandoned.id}\n---\n\nPlan.\n`);
    const closed = await lifecycle.execute("close", { planId: closeId, status: "closed" }, undefined, undefined, fromA);
    expect(closed.isError).toBeFalsy();
    const afterClose = await openBoard();
    expect(afterClose.readTopic(repositoryIdentity(source), abandoned.id).topic).toMatchObject({
      status: "closed", planRevision: null, planHash: null, executionRoot: null,
    });
    afterClose.close();
  }));

  test("T4 migrates A topic into family, pins Team B, and lifecycle reload validates B ledger", fixture.ownedCase("T4 migrates A topic into family, pins Team B, and lifecycle reload validates B ledger", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "pitako-team-family-lifecycle-"));
    tempDirs.push(base);
    const { source, execution } = initWorktreePair(base);
    const id = "family-lifecycle";
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;

    const board = await openBoard();
    const topic = board.createTopic(currentWorkspace(source), { title: "A-owned topic" });
    board.claimTopic(currentWorkspace(source), topic.id, id);
    const originalPost = board.post(currentWorkspace(source), { topicId: topic.id, type: "FINDING", content: "legacy post stays" });
    board.close();
    const sourcePlan = planFile(id, source);
    mkdirSync(path.dirname(sourcePlan), { recursive: true });
    writeFileSync(sourcePlan, `---\nid: ${id}\nrevision: 4\nstatus: frozen\nboard_topic_id: ${topic.id}\nexecution: expected\n---\n\nFrozen family plan.\n`);

    const current = evaluation("team-family-admission");
    bindBackgroundOwner(owner(current.token));
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    boardExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)), registerFlag() {}, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)) } as unknown as ExtensionAPI);
    let finish!: (attempt: Attempt) => void;
    setBackgroundExecutor({ async start() { return fixture.pendingAttempt((resolve) => (finish = resolve)); } });
    const context = { cwd: execution, sessionManager: { getSessionId: () => current.sessionId } };
    const assigned = await tools.get("team_assign")!.execute("assign", {
      role: "developer", task: "work from B", plan: id, unit: "T4",
    }, new AbortController().signal, undefined, context);
    expect(assigned.isError).toBe(false);
    const assignment = assigned.details as { id: string; instanceId: string; execution: { executionRoot: string } };
    expect(assignment.execution.executionRoot).toBe(execution);

    const familyBoard = await openBoard();
    const familyTopic = familyBoard.readTopic(repositoryIdentity(execution), topic.id);
    expect(familyTopic.topic).toMatchObject({ ownerPlanId: id, planRevision: 4, executionRoot: execution });
    expect(familyTopic.posts.map((post) => post.id)).toEqual([originalPost.id]);
    expect(familyBoard.listTopics(repositoryIdentity(execution)).total).toBe(1);
    familyBoard.close();

    const ledger = ledgerFile(id, execution);
    let completedLedger = readFileSync(ledger, "utf8").replace("status: running", "status: completed");
    writeFileSync(ledger, completedLedger);
    const reloadedContext = { cwd: execution, sessionManager: { getSessionId: () => "team-family-reloaded-without-roster" } };
    const lifecycle = tools.get("board_workflow_lifecycle")!;
    const pending = await lifecycle.execute("pending", { planId: id, status: "resolved" }, undefined, undefined, reloadedContext);
    expect(pending.isError).toBe(true);
    expect(pending.content[0].text).toContain("Team work for this plan is pending");

    finish(completed("B result"));
    await fixture.settleRuns();
    const result = await tools.get("team_result")!.execute("result", { assignmentId: assignment.id }, undefined, undefined, context);
    expect(result.content[0].text).toContain(`execution summary: assignment=${assignment.id}`);
    expect(result.content[0].text).toMatch(/\n\nB result$/);
    completedLedger = readFileSync(ledger, "utf8");

    mkdirSync(path.dirname(ledgerFile(id, source)), { recursive: true });
    writeFileSync(ledgerFile(id, source), completedLedger);
    rmSync(ledger);
    const copied = await lifecycle.execute("copied", { planId: id, status: "resolved" }, undefined, undefined, reloadedContext);
    expect(copied.isError).toBe(true);
    expect(copied.content[0].text).toContain("competing ledger");
    expect(existsSync(ledger)).toBe(false);

    writeFileSync(ledger, completedLedger);
    rmSync(ledgerFile(id, source));
    const resolved = await lifecycle.execute("resolved", { planId: id, status: "resolved" }, undefined, undefined, reloadedContext);
    expect(resolved.isError).not.toBe(true);
    const finalBoard = await openBoard();
    expect(finalBoard.readTopic(repositoryIdentity(execution), topic.id).topic.status).toBe("resolved");
    finalBoard.close();
  }));

  test("Team B refuses a Board topic already pinned to physical root A before ledger changes", fixture.ownedCase("Team B refuses a Board topic already pinned to physical root A before ledger changes", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "pitako-team-foreign-root-"));
    tempDirs.push(base);
    const { source, execution } = initWorktreePair(base);
    const id = "foreign-team-root";
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;
    const topicBoard = await openBoard();
    const topic = topicBoard.createTopic(currentWorkspace(source), { title: "Pinned to A" });
    topicBoard.claimTopic(currentWorkspace(source), topic.id, id);
    const sourcePlan = planFile(id, source);
    mkdirSync(path.dirname(sourcePlan), { recursive: true });
    const planText = `---\nid: ${id}\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\nexecution: expected\n---\n\nPlan.\n`;
    writeFileSync(sourcePlan, planText);
    topicBoard.claimTopicExecution(currentWorkspace(source), topic.id, id, {
      revision: 1, hash: planHash(planText), executionRoot: source,
    });
    topicBoard.close();

    const current = evaluation("team-foreign-root-admission");
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, preparedTool(tool)) } as unknown as ExtensionAPI);
    let started = false;
    setBackgroundExecutor({ async start() { started = true; return completed(); } });
    const result = await tools.get("team_assign")!.execute("assign", {
      role: "developer", task: "must not start", plan: id, unit: "T4",
    }, new AbortController().signal, undefined, { cwd: execution, sessionManager: { getSessionId: () => current.sessionId } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pinned to execution worktree");
    expect(started).toBe(false);
    expect(existsSync(ledgerFile(id, execution))).toBe(false);
    const checked = await openBoard();
    expect(checked.readTopic(repositoryIdentity(execution), topic.id).topic.executionRoot).toBe(source);
    checked.close();
  }));

  test("/pitako team is compact, stable, session-scoped, and does not create a roster", fixture.ownedCase("/pitako team is compact, stable, session-scoped, and does not create a roster", async () => {
    const current = evaluation("team-command-inspect");
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    pitako({
      registerCommand(_name: string, command: any) { handler = command.handler; },
      registerFlag() {}, registerTool() {}, on() {}, getFlag() { return undefined; },
      getAllTools() { return []; }, getActiveTools() { return []; }, setActiveTools() {},
      getSessionName() { return undefined; }, setSessionName() {}, sendMessage() {},
    } as unknown as ExtensionAPI);
    const notes: string[] = [];
    await handler!("team", {
      hasUI: true,
      sessionManager: { getSessionId: () => current.sessionId },
      ui: { notify(message: string) { notes.push(message); }, setStatus() {} },
    });
    expect(JSON.parse(notes[0]!)).toEqual([]);
    expect(hasTeamRoster(current)).toBe(false);
    expect(notes.join(" ")).not.toContain("transcript");
  }));

  test("missing and child identities fail closed; preaccept rollback leaves no roster", fixture.ownedCase("missing and child identities fail closed; preaccept rollback leaves no roster", () => {
    expect(beginTeamEvaluation(undefined, false)).toBeUndefined();
    expect(beginTeamEvaluation("team-child", true)).toBeUndefined();
    registerExecution({ instanceId: "developer-child", roleId: "developer", sessionId: "registered-child-session" });
    expect(beginTeamEvaluation("registered-child-session", false)).toBeUndefined();
    unregisterExecution("registered-child-session");
    const current = evaluation("team-session-rollback");
    const admission = reserveTeamMember(current, "reviewer", "not-accepted");
    admission.rollback();
    expect(hasTeamRoster(current)).toBe(false);
    expect(firstTeamReservation(current, "reviewer")).toBeUndefined();
    expect(() => reserveTeamMember({ ...current, token: Symbol("stale") }, "reviewer", "stale")).toThrow("stale Team evaluation");
  }));
});


test("host Team retains one conversation, background lifetime and history across turns; bridge readers retain member metadata",
  fixture.ownedCase("maintained Team readers", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-team-lifetime-")); tempDirs.push(root);
    previousAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
    const config = path.join(root, "policy.toml");
    writeFileSync(config, '[model_policies.architect]\nprimary = { model = "fixture/selected" }\n');
    const current = evaluation("maintained-readers");
    bindBackgroundOwner({ ...owner(current.token), sessionId: current.sessionId });
    const sdk = controlledPi(root, { prompt(session, text) {
      session.stats.tokens.input += 7; session.stats.tokens.output += 3; session.stats.assistantMessages++;
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason: "stop" as const,
        api: "openai-completions" as const, provider: "fixture", model: "selected", timestamp: Date.now(),
        usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      session.messages.push(message); session.sessionManager.appendMessage(message);
      session.emit({ type: "message_end", message });
    } });
    const team = createTeam(current);
    const input = { roleId: "architect", task: "mandate", cwd: root, executor: createPiExecutor({ factories: sdk.factories }), load: { userConfigPath: config } };
    expect(() => admitTeamMember(team, Object.assign({}, input, { head: {} }))).toThrow("one-shot route");
    const first = admitTeamMember(team, input), second = admitTeamMember(team, input);
    expect(first.memberId).not.toBe(second.memberId);
    expect(sdk.sessions).toHaveLength(0); // Admission reserves synchronously; native startup is lazy.
    const binding = { sessionId: current.sessionId, token: current.token };
    const controller = createAgentController(binding, () => binding);
    mkdirSync(path.join(root, "bridge"), { mode: 0o700 });
    const bridge = createAgentBridge(controller, path.join(root, "bridge"), () => true);
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await bridge.ready;
      client = await connect(path.join(root, "bridge", "descriptor.json"), { expectedSessionId: current.sessionId });
      const one = await first.turn("first exchange");
      expect(one.status).toBe("completed");
      expect(teamWorkerStatus(current.token, first.instanceId)[0]).toMatchObject({ status: "running", closure: { state: "pending" } });
      expect(() => teamWorkerResult(current.token, first.instanceId)).toThrow("still running");
      let detail = await client.publicDetail(first.instanceId);
      if (!("lifecycle" in detail)) throw new Error("missing public detail");
      expect(detail.lifecycle).toMatchObject({ execution: "running", result: "pending", capture: "open" });
      expect(detail.worker).toMatchObject({ teamId: team.teamId, memberId: first.memberId, assignmentId: first.assignmentId, turnId: one.turnId });
      expect(detail.bindings).toHaveLength(1);
      const native = detail.bindings[0]!;
      const before = new WorkerHistory(root).list();
      expect(before).toHaveLength(1); expect(before[0]!.closure.state).toBe("unclosed");
      expect(before[0]!.members[0]!.terminal).toBeUndefined();
      const two = await first.turn("second exchange");
      expect(two.turnId).not.toBe(one.turnId);
      detail = await client.publicDetail(first.instanceId);
      if (!("lifecycle" in detail)) throw new Error("missing public detail");
      expect(detail.bindings[0]).toMatchObject({ historyId: native.historyId, sessionId: native.sessionId, capture: "open" });
      expect(new Set(detail.bindings[0]!.attemptIds).size).toBe(2);
      const rows = (await client.list()).items;
      expect(rows).toHaveLength(2);
      expect(rows.find(row => row.id === first.instanceId)).toMatchObject({ teamId: team.teamId, memberId: first.memberId,
        turnId: two.turnId, status: "running", phase: "idle" });
      expect(rows.find(row => row.id === second.instanceId)?.memberId).toBe(second.memberId);
      expect(sdk.sessions).toHaveLength(1); expect(sdk.sessions[0]!.events).not.toContain("dispose");
      await first.finish(); await first.finish();
      expect(teamWorkerResult(current.token, first.instanceId)).toMatchObject({ result: "second exchange", usage: { input: 14, output: 6, turns: 2 } });
      const history = await client.historyList({ workerId: first.instanceId });
      expect(history.items[0]).toMatchObject({ teamId: team.teamId, memberId: first.memberId, assignmentId: first.assignmentId,
        native: { state: "allocated", disposition: { state: "disposed" } } });
      const catalog = new WorkerHistory(root).list();
      expect(catalog).toHaveLength(1); expect(catalog[0]!.closure.state).toBe("closed");
      expect(sdk.sessions[0]!.events.filter(event => event === "dispose")).toHaveLength(1);
      expect((await second.turn("independent member")).status).toBe("completed");
      await second.finish();
      expect(sdk.sessions).toHaveLength(2);
      await disbandTeam(team);
      const closed = await client.publicDetail(first.instanceId);
      if (!("lifecycle" in closed)) throw new Error("missing closed capture");
      expect(closed.lifecycle).toMatchObject({ execution: "completed", capture: "closed" });
      expect(selectTeamAssignments(current, { memberId: first.memberId, teamId: team.teamId })[0]?.id).toBe(first.assignmentId);
      expect((await client.list()).items).toHaveLength(2);
    } finally {
      await client?.disconnect(); await bridge.settle(); controller.revoke(); await controller.settle();
      await disbandTeam(team);
    }
  }));

test("disband synchronously revokes admission and joins late native creation without touching another same-role Team",
  fixture.ownedCase("maintained late startup", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-team-late-")); tempDirs.push(root);
    previousAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
    const config = path.join(root, "policy.toml"); writeFileSync(config, '[model_policies.architect]\nprimary = { model = "fixture/selected" }\n');
    const current = evaluation("maintained-late");
    const sdk = controlledPi(root);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const executor = createPiExecutor({ factories: { ...sdk.factories, async createSession(options) {
      entered.resolve(); await release.promise; return sdk.factories.createSession(options);
    } } });
    const team = createTeam(current), other = createTeam(current);
    const input = { roleId: "architect", task: "mandate", cwd: root, executor, load: { userConfigPath: config } };
    const member = admitTeamMember(team, input), independent = admitTeamMember(other, input);
    const turn = member.turn("late native startup");
    try {
      await entered.promise;
      const closing = disbandTeam(team);
      expect(disbandTeam(team)).toBe(closing);
      expect(() => admitTeamMember(team, input)).toThrow("admission is closed");
      await expect(member.turn("revoked")).rejects.toThrow("stale Team member");
      let settled = false; void closing.then(() => { settled = true; }); await Promise.resolve();
      expect(settled).toBe(false);
      release.resolve(); await turn; await closing;
      expect(sdk.sessions[0]!.prompts).toEqual([]);
      expect(sdk.sessions[0]!.events.at(-1)).toBe("dispose");
      expect((await independent.turn("independent progress")).status).toBe("completed");
      await independent.finish();
    } finally { release.resolve(); await Promise.allSettled([turn, disbandTeam(team), disbandTeam(other)]); }
  }));
