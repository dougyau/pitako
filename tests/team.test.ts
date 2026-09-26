import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cancelTeamWorker, cancelWorker, shutdownBackground, spawnBackground, teamWorkerResult, teamWorkerStatus, workerResult, workerStatus } from "../extensions/agent/background.ts";
import type { Attempt, AttemptExecutor } from "../extensions/agent/run.ts";
import { bindBackgroundOwner, clearBackgroundOwner } from "../extensions/agent/background.ts";
import { listObservations, publishObservation } from "../extensions/agent/observe.ts";
import { registerExecution, unregisterExecution } from "../extensions/execution-identity.ts";
import { beginTeamEvaluation, hasTeamRoster, hasUnsettledTeamWork, recordPlanTeamWork, reserveTeamRole, retireTeamEvaluation, teamEvaluationForSession, teamRoleReservation, teamAssignments } from "../extensions/team.ts";
import { openBoard } from "../extensions/board/store.ts";
import { currentWorkspace, repositoryIdentity } from "../extensions/board/workspace.ts";
import boardExtension from "../extensions/board/index.ts";
import { ledgerFile, ledgerTemplate, openExecutionPlan, planFile, readLedgerTeamHolds, readPlan, planHash } from "../extensions/workflow.ts";
import { packageRoot } from "../extensions/stack.ts";
import agentExtension from "../extensions/agent/index.ts";
import { setBackgroundExecutor } from "../extensions/agent/background.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pitako from "../extensions/index.ts";

const evaluations = new Set<ReturnType<typeof beginTeamEvaluation>>();
const tempDirs: string[] = [];
let previousAgentDir: string | undefined;

afterEach(() => {
  for (const evaluation of evaluations) retireTeamEvaluation(evaluation);
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
  return result;
}

function hanging(): { executor: AttemptExecutor; started: Promise<void>; finish: (attempt: Attempt) => void; signal?: AbortSignal } {
  let start!: () => void;
  let finish!: (attempt: Attempt) => void;
  const started = new Promise<void>((resolve) => (start = resolve));
  const result = new Promise<Attempt>((resolve) => (finish = resolve));
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
  writeFileSync(userConfigPath, `[model_policies.developer.primary]\nmodel = "example/primary"\nreasoning = "off"\n[model_policies.researcher.primary]\nmodel = "example/primary"\nreasoning = "off"\n[model_policies.architect.primary]\nmodel = "example/primary"\nreasoning = "off"\n[model_policies.reviewer.primary]\nmodel = "example/primary"\nreasoning = "off"\n[model_policies.scout.primary]\nmodel = "example/primary"\nreasoning = "low"\n`);
  return { userConfigPath, env: { PI_CODING_AGENT_DIR: dir } };
}

function owner(token: symbol) {
  return { token, isIdle: () => false, hasUI: false, notify() {}, sendMessage() {} };
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
  test("ledger holds are exact, durable, and fail closed", () => {
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
  });

  test("no-topic plans do not create a ledger or sidecar", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-team-no-topic-"));
    tempDirs.push(cwd);
    const plan = planFile("no-topic", cwd);
    mkdirSync(path.dirname(plan), { recursive: true });
    writeFileSync(plan, "---\nid: no-topic\nrevision: 1\nstatus: frozen\n---\nNo Board topic.\n");
    recordPlanTeamWork(cwd, "no-topic", "unit", "assignment", "pending");
    expect(existsSync(path.join(path.dirname(ledgerFile("no-topic", cwd)), "team-state.json"))).toBe(false);
    expect(existsSync(ledgerFile("no-topic", cwd))).toBe(false);
  });
  test("reserves one assignment per role, allows other roles, and keeps cancellation occupied until settle", async () => {
    const current = evaluation("team-session-race");
    bindBackgroundOwner(owner(current.token));
    const developer = reserveTeamRole(current, "developer", "assignment-dev");
    const researcher = reserveTeamRole(current, "researcher", "assignment-research");
    expect(() => reserveTeamRole(current, "developer", "assignment-dev-2")).toThrow("already reserved");

    const devWorker = hanging();
    const researchWorker = hanging();
    const dev = await spawn(current, "developer", "assignment-dev", devWorker, developer.settled);
    await spawn(current, "researcher", "assignment-research", researchWorker, researcher.settled);
    developer.commit();
    researcher.commit();
    expect(hasTeamRoster(current)).toBe(true);
    await Promise.all([devWorker.started, researchWorker.started]);

    cancelTeamWorker(current.token, dev.instanceId);
    expect(() => reserveTeamRole(current, "developer", "assignment-next")).toThrow("already reserved");
    expect(teamWorkerStatus(current.token, dev.instanceId)[0]?.status).toBe("cancelled");
    expect(() => workerResult(dev.instanceId)).toThrow("unknown worker");
    expect(() => cancelWorker(dev.instanceId)).toThrow("unknown worker");
    devWorker.finish({ status: "cancelled", result: "cancelled", sideEffects: false });
    researchWorker.finish(completed());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(teamRoleReservation(current, "developer")).toBeUndefined();
    expect(teamRoleReservation(current, "researcher")).toBeUndefined();
    const reused = reserveTeamRole(current, "developer", "assignment-next");
    reused.rollback();
    expect(workerStatus()).toEqual([]);
    expect(() => teamWorkerStatus(Symbol("foreign"), dev.instanceId)).toThrow("unknown Team worker");
  });

  test("overlapping foreground leases deliver Team wakes only to their owning session", async () => {
    const first = evaluation("team-overlap-one");
    const second = evaluation("team-overlap-two");
    const firstMessages: string[] = [];
    const secondMessages: string[] = [];
    bindBackgroundOwner({ ...owner(first.token), isIdle: () => true, sendMessage: (text) => firstMessages.push(text) });
    const firstAdmission = reserveTeamRole(first, "developer", "first-assignment");
    const firstWorker = hanging();
    const firstHandle = await spawn(first, "developer", "first-assignment", firstWorker, firstAdmission.settled, { planId: "p", unitId: "u" });
    firstAdmission.commit();
    bindBackgroundOwner({ ...owner(second.token), isIdle: () => true, sendMessage: (text) => secondMessages.push(text) });
    const secondAdmission = reserveTeamRole(second, "researcher", "second-assignment");
    const secondWorker = hanging();
    const secondHandle = await spawn(second, "researcher", "second-assignment", secondWorker, secondAdmission.settled, { planId: "p", unitId: "u" });
    secondAdmission.commit();
    firstWorker.finish(completed());
    secondWorker.finish(completed());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstMessages).toEqual([expect.stringContaining("first-assignment")]);
    expect(secondMessages).toEqual([expect.stringContaining("second-assignment")]);
    expect(firstMessages[0]).toContain("Use team_result");
    expect(secondMessages[0]).toContain("Use team_result");
    expect(firstMessages[0]).not.toContain(secondHandle.instanceId);
    expect(secondMessages[0]).not.toContain(firstHandle.instanceId);
  });

  test("same-session reload retires only old Team rows and makes late settlement inert", async () => {
    const old = evaluation("team-session-reload");
    bindBackgroundOwner(owner(old.token));
    const admission = reserveTeamRole(old, "developer", "old-assignment");
    const late = hanging();
    const oldWorker = await spawn(old, "developer", "old-assignment", late, admission.settled);
    admission.commit();
    await late.started;

    const fresh = evaluation("team-session-reload");
    bindBackgroundOwner(owner(fresh.token));
    expect(late.signal?.aborted).toBe(true);
    expect(teamWorkerStatus(old.token)).toEqual([]);
    expect(hasTeamRoster(fresh)).toBe(false);
    expect(() => teamWorkerStatus(fresh.token, oldWorker.instanceId)).toThrow("unknown Team worker");

    late.finish(completed("late"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(teamRoleReservation(fresh, "developer")).toBeUndefined();
    expect(listObservations()).toEqual([]);
  });

  test("session leases and tagged rows cannot cross session boundaries", async () => {
    const first = evaluation("team-session-one");
    const second = evaluation("team-session-two");
    const admission = reserveTeamRole(first, "architect", "first-assignment");
    const worker = hanging();
    const handle = await spawn(first, "architect", "first-assignment", worker, admission.settled);
    admission.commit();
    const otherAdmission = reserveTeamRole(second, "researcher", "second-assignment");
    const otherWorker = hanging();
    const otherHandle = await spawn(second, "researcher", "second-assignment", otherWorker, otherAdmission.settled);
    otherAdmission.commit();
    await Promise.all([worker.started, otherWorker.started]);
    bindBackgroundOwner(owner(first.token));

    expect(teamWorkerStatus(second.token)).toEqual([expect.objectContaining({ instanceId: otherHandle.instanceId })]);
    expect(teamWorkerStatus(first.token, handle.instanceId)).toHaveLength(1);
    expect(workerStatus()).toEqual([]);
    shutdownBackground(first.token);
    retireTeamEvaluation(first);
    expect(worker.signal?.aborted).toBe(true);
    expect(otherWorker.signal?.aborted).toBe(false);
    expect(teamWorkerStatus(second.token, otherHandle.instanceId)).toHaveLength(1);
    worker.finish(completed());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(teamWorkerStatus(first.token)).toEqual([]);
  });

  test("watched planning assignments deliver isolated completion wakes across busy and idle turns", async () => {
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;
    const workers: { task: string; finish: (attempt: Attempt) => void }[] = [];
    setBackgroundExecutor({
      async start(input) {
        let finish!: (attempt: Attempt) => void;
        const result = new Promise<Attempt>((resolve) => (finish = resolve));
        workers.push({ task: input.task, finish });
        return result;
      },
    });
    let idle = false;
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any>; promptGuidelines?: string[] }>();
    const handlers = new Map<string, Function>();
    const sent: { message: any; options: any }[] = [];
    const pi = {
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerFlag() {}, registerCommand() {},
      on(event: string, handler: Function) { handlers.set(event, handler); },
      getFlag() { return undefined; }, getAllTools() { return []; }, getActiveTools() { return []; },
      setActiveTools() {}, getSessionName() { return undefined; }, setSessionName() {},
      sendMessage(message: any, options: any) { sent.push({ message, options }); },
    };
    pitako(pi as unknown as ExtensionAPI);
    agentExtension(pi as unknown as ExtensionAPI);
    const sessionId = "team-plan-concurrent-wakes";
    await handlers.get("session_start")?.({}, {
      hasUI: false, isIdle: () => idle, ui: { notify() {}, setStatus() {} },
      sessionManager: { getSessionId: () => sessionId },
    });
    const current = teamEvaluationForSession(sessionId, false)!;
    evaluations.add(current);
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-team-planning-"));
    tempDirs.push(cwd);
    const invoke = (name: string, params: unknown) => tools.get(name)!.execute("call", params, new AbortController().signal, undefined, {
      cwd, sessionManager: { getSessionId: () => sessionId },
    });
    const guidelines = tools.get("team_assign")?.promptGuidelines?.join(" ") ?? "";
    expect(guidelines).toContain("plan");
    expect(guidelines).toContain("team_result");
    const architectResult = await invoke("team_assign", {
      role: "architect", task: "Architect planning task", plan: "plan-frozen-a", unit: "architect-review",
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

    workers.find((worker) => worker.task.includes("Research planning task"))!.finish(completed("research result"));
    for (let i = 0; i < 50 && teamWorkerStatus(current.token, researcher.instanceId)[0]?.status !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(teamWorkerStatus(current.token, researcher.instanceId)[0]?.status).toBe("completed");
    expect(sent).toEqual([]);
    handlers.get("agent_settled")?.();
    expect(sent).toEqual([]);

    idle = true;
    handlers.get("agent_settled")?.();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.content).toContain(`assignment ${researcher.id}`);
    expect(sent[0]?.message.content).not.toContain(architect.id);
    expect(sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    const consumed = await invoke("team_result", { assignmentId: researcher.id });
    expect(consumed.content[0].text).toContain("research result");
    handlers.get("agent_settled")?.();
    expect(sent).toHaveLength(1);

    workers.find((worker) => worker.task.includes("Architect planning task"))!.finish(completed("architect result"));
    for (let i = 0; i < 50 && teamWorkerStatus(current.token, architect.instanceId)[0]?.status !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(teamWorkerStatus(current.token, architect.instanceId)[0]?.status).toBe("completed");
    const architectWakes = sent.filter((item) => item.message.content.includes(`assignment ${architect.id}`));
    expect(architectWakes).toHaveLength(1);
    expect(architectWakes[0]?.message.content).not.toContain(researcher.id);
    expect(architectWakes[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(sent).toHaveLength(2);
  });

  test("public Team tools accept concurrent roles, isolate low-level controls, and cap results", async () => {
    const current = evaluation("team-public-tools");
    let idle = false;
    const wakes: string[] = [];
    bindBackgroundOwner({ ...owner(current.token), isIdle: () => idle, sendMessage: (text) => wakes.push(text) });
    const config = load();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = config.env.PI_CODING_AGENT_DIR;
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
    const workers: { task: string; started: Promise<void>; finish: (attempt: Attempt) => void }[] = [];
    setBackgroundExecutor({
      async start(input) {
        let start!: () => void;
        let finish!: (attempt: Attempt) => void;
        const started = new Promise<void>((resolve) => (start = resolve));
        const result = new Promise<Attempt>((resolve) => (finish = resolve));
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
    expect((status.details as any).roles.map((row: any) => row.role)).toEqual(["architect", "developer", "reviewer", "researcher", "scout"]);
    const assignTool = tools.get("team_assign") as any;
    expect(assignTool.parameters.properties.role.enum).toEqual(["architect", "developer", "reviewer", "researcher", "scout"]);
    expect(assignTool.promptGuidelines.join(" ")).toContain("team_result");
    expect(assignTool.promptGuidelines.join(" ")).toContain("independent long work");
    expect((await invoke("team_assign", { role: "architect", task: "unrelated", boardTopicId: "1" })).isError).toBe(true);
    const firstAssignment = await invoke("team_assign", { role: "developer", task: "Inspect lease\nsecond line", plan: "plan-a", unit: "unit-a" });
    expect(firstAssignment.isError).toBe(false);
    expect(existsSync(ledgerFile("plan-a", cwd))).toBe(false);
    expect((await invoke("team_assign", { role: "researcher", task: "Inspect evidence" })).isError).toBe(false);
    const scoutAssignment = await invoke("team_assign", { role: "scout", task: "Map local callers" });
    expect(scoutAssignment.isError).toBe(false);
    expect((await invoke("team_assign", { role: "scout", task: "Overlapping Scout" })).isError).toBe(true);
    await Promise.all(workers.map((worker) => worker.started));
    expect(workers).toHaveLength(3);
    expect(workers[0]!.task).toContain(`Team ${current.sessionId}; role developer; assignment `);
    expect(workers[0]!.task).not.toContain("Board topic");
    expect(workers[0]!.task).toContain("WorkBrief:\nInspect lease");
    expect(teamAssignments(current)[1]?.current?.boardTopicId).toBeUndefined();
    expect((await invoke("team_assign", { role: "developer", task: "overlap" })).isError).toBe(true);
    const views = await invoke("team_status", {});
    expect((views.details as any).roles.map((row: any) => row.status)).toEqual(["idle", "running", "idle", "running", "running"]);
    expect((views.details as any).roles[4].role).toBe("scout");
    const developer = teamAssignments(current)[1]?.current;
    expect(developer).toBeDefined();
    publishObservation({
      id: developer!.instanceId, roleId: "developer", status: "running", phase: "working",
      task: "Inspect lease", acceptedAt: Date.now() - 2500, selectedModel: "example/model",
      appliedReasoning: "high", lastActivityKind: "tool", activeTool: { name: "grep", startedAt: Date.now() - 500 },
      teamOwnerToken: current.token,
    });
    const devStatus = (await invoke("team_status", {})).details as any;
    expect(devStatus.roles[1]).toMatchObject({
      task: "Inspect lease", model: "example/model", reasoning: "high", activity: { name: "grep" },
    });
    expect(devStatus.roles[1].elapsedMs).toBeGreaterThanOrEqual(0);
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
        patches: [{
          targets: ["src/change.ts"], committed: ["src/change.ts"], pending: [], uncertain: [],
          changedFiles: 1, changedHunks: 2, inputBytes: 90, status: "success", phase: "complete",
          errorCode: null, elapsedMs: 17, retry: false, truncated: false,
        }],
      },
    });
    workers[1]!.finish(completed("research done"));
    workers[2]!.finish({ status: "completed", result: "scout map", sideEffects: false, usage: { input: 12, output: 5, turns: 1, toolCalls: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wakes.some((text) => text.includes("plan plan-a unit unit-a"))).toBe(true);
    const ready = (await invoke("team_status", {})).details as any;
    expect(ready.roles[1]).toMatchObject({ status: "completed", resultAvailable: true });
    expect(ready.roles[0]).toMatchObject({ role: "architect", status: "idle" });
    const result = await invoke("team_result", { assignmentId: developer!.id });
    expect(result.content[0].text.length).toBe(8000);
    expect((result.details as any).truncated).toBe(true);
    expect((result.details as any).usage).toMatchObject({
      tools: { edit: 1, write: 2, apply_patch: 3 },
      patches: [{ targets: ["src/change.ts"], inputBytes: 90, changedHunks: 2 }],
    });
    expect((await invoke("team_result", { assignmentId: teamAssignments(current)[3]?.current?.id })).content[0].text).toContain("research done");
    const scoutResult = await invoke("team_result", { assignmentId: (scoutAssignment.details as any).id });
    expect(scoutResult.content[0].text).toContain("execution summary: assignment=");
    expect(scoutResult.content[0].text.endsWith("\n\nscout map")).toBe(true);
    expect(scoutResult.details).toMatchObject({ role: "scout", usage: { input: 12, output: 5, turns: 1, toolCalls: 2 } });
    const scoutAgain = await invoke("team_assign", { role: "scout", task: "Confirm released slot" });
    expect(scoutAgain.isError).toBe(false);
    await workers[3]!.started;
    workers[3]!.finish(completed("released"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wakes.some((text) => text.includes(`assignment ${developer!.id}`) && text.includes("Use team_result"))).toBe(true);
    expect(wakes.some((text) => text.includes("Use agent_result"))).toBe(false);
    expect((await invoke("team_assign", { role: "developer", task: "Next task" })).isError).toBe(false);
    const cancelled = await invoke("team_assign", { role: "architect", task: "Cancel test", plan: "plan-a", unit: "cancel-test" });
    expect(cancelled.isError).toBe(false);
    const reviewer = teamAssignments(current)[0]?.current!;
    await workers.at(-1)!.started;
    expect((await invoke("team_cancel", { assignmentId: reviewer.id })).isError).toBe(false);
    const cancelledStatus = await invoke("team_status", { assignmentId: reviewer.id });
    expect((cancelledStatus.details as any).roles[0]).toMatchObject({ status: "cancelled", resultAvailable: false });
    workers.at(-1)!.finish({ status: "cancelled", result: "cancelled", sideEffects: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(((await invoke("team_status", { assignmentId: reviewer.id })).details as any).roles[0].resultAvailable).toBe(true);
  });

  test("team_result returns stable per-assignment execution summaries after consumption", async () => {
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
        return new Promise<Attempt>((resolve) => workers.push({ role: input.role.id, model: input.target.model, finish: resolve }));
      },
    });
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
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
  });

  test("watched Team assignments inherit only a validated plan topic", async () => {
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
    pitako({
      registerTool(tool: any) { tools.set(tool.name, tool); }, registerFlag() {}, registerCommand() {},
      on(event: string, handler: Function) { handlers.set(event, handler); }, getFlag() { return undefined; },
      getAllTools() { return []; }, getActiveTools() { return []; }, setActiveTools() {},
      getSessionName() { return undefined; }, setSessionName() {}, sendMessage() {},
    } as unknown as ExtensionAPI);
    boardExtension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerFlag() {}, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
    const sessionContext = { hasUI: false, isIdle: () => idle, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => current.sessionId } };
    await handlers.get("session_start")?.({}, sessionContext);
    await handlers.get("session_start")?.({}, sessionContext);
    const afterReload = await openBoard();
    expect(afterReload.readTopic(cwd, 1).topic.status).toBe("open");
    afterReload.close();
    const tasks: string[] = [];
    const finishes: ((attempt: Attempt) => void)[] = [];
    setBackgroundExecutor({ async start(input) {
      tasks.push(input.task);
      return new Promise<Attempt>((resolve) => finishes.push(resolve));
    } });
    const invoke = (params: unknown) => tools.get("team_assign")!.execute("call", params, new AbortController().signal, undefined, {
      cwd, sessionManager: { getSessionId: () => current.sessionId },
    });
    expect((await invoke({ role: "architect", task: "invalid", plan: "bound-plan", unit: "x", boardTopicId: "1; injected" })).isError).toBe(true);
    expect((await invoke({ role: "architect", task: "overflow", plan: "bound-plan", unit: "x", boardTopicId: "9007199254740992" })).isError).toBe(true);
    expect((await invoke({ role: "architect", task: "conflict", plan: "bound-plan", unit: "x", boardTopicId: "2" })).isError).toBe(true);
    expect((await invoke({ role: "architect", task: "stale", plan: "stale-plan", unit: "x" })).isError).toBe(true);
    expect((await invoke({ role: "architect", task: "owner mismatch", plan: "mismatch-plan", unit: "x" })).isError).toBe(true);
    expect((await invoke({ role: "architect", task: "foreign workspace", plan: "foreign-plan", unit: "x" })).isError).toBe(true);
    expect((await invoke({ role: "architect", task: "existing unbound explicit", plan: "empty-plan", unit: "x", boardTopicId: "3" })).isError).toBe(true);
    expect(tasks).toHaveLength(0);
    rmSync(boundLedger);
    const boundResult = await invoke({ role: "architect", task: "bound", plan: "bound-plan", unit: "T2", boardTopicId: "1" });
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
    const missingResult = await invoke({ role: "reviewer", task: "missing", plan: "missing-plan", unit: "T2", boardTopicId: "3" });
    expect(missingResult).toMatchObject({ isError: false });
    expect(tasks.at(-1)).toContain("Board topic 3");
    expect((await invoke({ role: "researcher", task: "unrelated" })).isError).toBe(false);
    expect(tasks.at(-1)).not.toContain("Board topic");
    const topicsAfterDispatch = await openBoard();
    expect(topicsAfterDispatch.listTopics(cwd, { status: "open" }).total).toBe(3);
    topicsAfterDispatch.close();
    finishes.forEach((finish) => finish(completed()));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  test("all Team roles inherit the execution worktree from a sibling frozen plan", async () => {
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
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
    const workers: { cwd: string; finish: (attempt: Attempt) => void }[] = [];
    setBackgroundExecutor({ async start(input) {
      return new Promise<Attempt>((resolve) => workers.push({ cwd: input.cwd, finish: resolve }));
    } });
    const ctx = { cwd: execution, sessionManager: { getSessionId: () => current.sessionId } };
    for (const role of ["architect", "developer", "reviewer", "researcher"]) {
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
  });

  test("cold concurrent watched assignments admit only one execution root", async () => {
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
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
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
    const firstRoot = await assign(first, "architect", executionA, sequentialId);
    const secondRoot = await assign(second, "reviewer", executionB, sequentialId);
    expect(firstRoot.isError).toBe(false);
    expect((firstRoot.details as { execution: { executionRoot: string } }).execution.executionRoot).toBe(executionA);
    expect(secondRoot.isError).toBe(true);
    expect(secondRoot.content[0]!.text).toContain("competing ledger");
    expect(started).toEqual([assignment.execution.executionRoot, executionA]);
    expect(existsSync(ledgerFile(sequentialId, executionA))).toBe(true);
    expect(existsSync(ledgerFile(sequentialId, executionB))).toBe(false);
  });

  test("failed Team assignment leaves topic unpinned until ledger admission succeeds", async () => {
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
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
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
  });

  test("Team result and lifecycle keep using captured execution ledger after cwd changes", async () => {
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
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    boardExtension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerFlag() {}, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
    let finish!: (attempt: Attempt) => void;
    let workerCwd = "";
    setBackgroundExecutor({ async start(input) {
      workerCwd = input.cwd;
      return new Promise<Attempt>((resolve) => (finish = resolve));
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
    for (let i = 0; i < 50 && teamWorkerStatus(current.token, assignment.instanceId)[0]?.status !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
  });

  test("lifecycle rejects leave execution topic unpinned and allow execution from B", async () => {
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
    boardExtension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerFlag() {}, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
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
  });

  test("T4 migrates A topic into family, pins Team B, and lifecycle reload validates B ledger", async () => {
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
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    boardExtension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerFlag() {}, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
    let finish!: (attempt: Attempt) => void;
    setBackgroundExecutor({ async start() { return new Promise<Attempt>((resolve) => (finish = resolve)); } });
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
    for (let i = 0; i < 50 && teamWorkerStatus(current.token, assignment.instanceId)[0]?.status !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
  });

  test("Team B refuses a Board topic already pinned to physical root A before ledger changes", async () => {
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
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
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
  });

  test("/pitako team is compact, stable, session-scoped, and does not create a roster", async () => {
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
    expect(JSON.parse(notes[0]!)).toEqual([
      { role: "architect", status: "idle" },
      { role: "developer", status: "idle" },
      { role: "reviewer", status: "idle" },
      { role: "researcher", status: "idle" },
      { role: "scout", status: "idle" },
    ]);
    expect(notes.join(" ")).not.toContain("usage");
    expect(hasTeamRoster(current)).toBe(false);
    expect(notes.join(" ")).not.toContain("transcript");
  });

  test("missing and child identities fail closed; preaccept rollback leaves no roster", () => {
    expect(beginTeamEvaluation(undefined, false)).toBeUndefined();
    expect(beginTeamEvaluation("team-child", true)).toBeUndefined();
    registerExecution({ instanceId: "developer-child", roleId: "developer", sessionId: "registered-child-session" });
    expect(beginTeamEvaluation("registered-child-session", false)).toBeUndefined();
    unregisterExecution("registered-child-session");
    const current = evaluation("team-session-rollback");
    const admission = reserveTeamRole(current, "reviewer", "not-accepted");
    admission.rollback();
    expect(hasTeamRoster(current)).toBe(false);
    expect(teamRoleReservation(current, "reviewer")).toBeUndefined();
    expect(() => reserveTeamRole({ ...current, token: Symbol("stale") }, "reviewer", "stale")).toThrow("stale Team evaluation");
  });
});
