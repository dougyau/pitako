import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cancelTeamWorker, cancelWorker, shutdownBackground, spawnBackground, teamWorkerStatus, workerResult, workerStatus } from "../extensions/agent/background.ts";
import type { Attempt, AttemptExecutor } from "../extensions/agent/run.ts";
import { bindBackgroundOwner, clearBackgroundOwner } from "../extensions/agent/background.ts";
import { listObservations, publishObservation } from "../extensions/agent/observe.ts";
import { registerExecution, unregisterExecution } from "../extensions/execution-identity.ts";
import { beginTeamEvaluation, hasTeamRoster, hasUnsettledTeamWork, recordPlanTeamWork, reserveTeamRole, retireTeamEvaluation, teamEvaluationForSession, teamRoleReservation, teamAssignments } from "../extensions/team.ts";
import { openBoard } from "../extensions/board/store.ts";
import boardExtension from "../extensions/board/index.ts";
import { ledgerFile, ledgerTemplate, planFile, readPlan, planHash } from "../extensions/workflow.ts";
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
  writeFileSync(userConfigPath, `[model_policies.developer.primary]\nmodel = "example/primary"\nreasoning = "off"\n[model_policies.researcher.primary]\nmodel = "example/primary"\nreasoning = "off"\n[model_policies.architect.primary]\nmodel = "example/primary"\nreasoning = "off"\n[model_policies.reviewer.primary]\nmodel = "example/primary"\nreasoning = "off"\n`);
  return { userConfigPath, env: { PI_CODING_AGENT_DIR: dir } };
}

function owner(token: symbol) {
  return { token, isIdle: () => false, hasUI: false, notify() {}, sendMessage() {} };
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
    expect(consumed.content[0].text).toBe("research result");
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
    const ctx = { cwd, sessionManager: { getSessionId: () => current.sessionId } };
    const invoke = (name: string, params: unknown) => tools.get(name)!.execute("call", params, new AbortController().signal, undefined, ctx);
    const status = await invoke("team_status", {});
    expect((status.details as any).roles.map((row: any) => row.role)).toEqual(["architect", "developer", "reviewer", "researcher"]);
    const assignTool = tools.get("team_assign") as any;
    expect(assignTool.promptGuidelines.join(" ")).toContain("team_result");
    expect(assignTool.promptGuidelines.join(" ")).toContain("independent long work");
    expect((await invoke("team_assign", { role: "architect", task: "unrelated", boardTopicId: "1" })).isError).toBe(true);
    const firstAssignment = await invoke("team_assign", { role: "developer", task: "Inspect lease\nsecond line", plan: "plan-a", unit: "unit-a" });
    expect(firstAssignment.isError).toBe(false);
    expect((await invoke("team_assign", { role: "researcher", task: "Inspect evidence" })).isError).toBe(false);
    await Promise.all(workers.map((worker) => worker.started));
    expect(workers).toHaveLength(2);
    expect(workers[0]!.task).toContain(`Team ${current.sessionId}; role developer; assignment `);
    expect(workers[0]!.task).not.toContain("Board topic");
    expect(workers[0]!.task).toContain("WorkBrief:\nInspect lease");
    expect(teamAssignments(current)[1]?.current?.boardTopicId).toBeUndefined();
    expect((await invoke("team_assign", { role: "developer", task: "overlap" })).isError).toBe(true);
    const views = await invoke("team_status", {});
    expect((views.details as any).roles.map((row: any) => row.status)).toEqual(["idle", "running", "idle", "running"]);
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
    workers[0]!.finish(completed("x".repeat(9000)));
    workers[1]!.finish(completed("research done"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wakes.some((text) => text.includes("plan plan-a unit unit-a"))).toBe(true);
    const ready = (await invoke("team_status", {})).details as any;
    expect(ready.roles[1]).toMatchObject({ status: "completed", resultAvailable: true });
    expect(ready.roles[0]).toMatchObject({ role: "architect", status: "idle" });
    const result = await invoke("team_result", { assignmentId: developer!.id });
    expect(result.content[0].text.length).toBeLessThan(8100);
    expect((result.details as any).truncated).toBe(true);
    expect((await invoke("team_result", { assignmentId: teamAssignments(current)[3]?.current?.id })).content[0].text).toContain("research done");
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
    expect((await invoke({ role: "architect", task: "gate missing", plan: "bound-plan", unit: "T2", boardTopicId: "1" })).isError).toBe(true);
    expect(tasks).toHaveLength(0);
    writeFileSync(boundLedger, ledgerTemplate(boundMeta));
    const boundResult = await invoke({ role: "architect", task: "bound", plan: "bound-plan", unit: "T2", boardTopicId: "1" });
    expect(boundResult).toMatchObject({ isError: false });
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
    ]);
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
