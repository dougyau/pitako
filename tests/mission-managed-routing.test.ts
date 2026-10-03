import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import agentExtension from "../extensions/agent/index.ts";
import { inspectManagedAttempt, inspectManagedMission } from "../extensions/agent/managed-mission.ts";
import { bindBackgroundOwner, setBackgroundExecutor, shutdownBackground } from "../extensions/agent/background.ts";
import { openBoard } from "../extensions/board/store.ts";
import { registerBoard } from "../extensions/board/tools.ts";
import { repositoryIdentity } from "../extensions/board/workspace.ts";
import { missionCompletionCertificate } from "../extensions/mission/completion.ts";
import { createMissionWorkspace, currentProcessIdentity, registerCandidateWorkspace } from "../extensions/mission/workspace.ts";
import { openExecutionPlan } from "../extensions/workflow.ts";
import { createMissionFixture, missionInput, openFixtureStore, type MissionFixture } from "./mission-fixtures.ts";

const fixtures: MissionFixture[] = [];
function recordT4Observation(name: string, value: unknown): void {
  const directory = process.env.MISSION_T4_ARTIFACT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture.base, { recursive: true, force: true });
});

describe("managed Team and Board routing reads", () => {
  test("resolves managed plan and attempt through a read-only store without acquiring its writer", async () => {
    const sample = createMissionFixture("pitako-managed-routing-");
    fixtures.push(sample);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = sample.stateDir;
    const store = await openFixtureStore(sample);
    try {
      const mission = store.createMission(missionInput(sample));
      const attemptId = randomUUID();
      const ownerEpoch = store.ownerEpoch;
      if (ownerEpoch === null) throw new Error("fixture did not acquire writer reservation");
      const binding = {
        missionId: mission.id, revision: mission.revision, unitId: "snapshot", roundId: "main", memberId: "solo",
        attemptId, attemptNo: 1, ownerEpoch, candidate: "read-only", inputManifestHash: "a".repeat(64),
        briefHash: "b".repeat(64), rolePolicyHash: "c".repeat(64),
      };
      store.appendTransition(mission.id, mission.version, { events: [{
        revision: mission.revision, kind: "attempt.reserved", causalId: randomUUID(), unitId: "snapshot", attemptId,
        payload: { attemptId, binding, unitId: "snapshot", roundId: "main", memberId: "solo", attemptNo: 1 },
      }] });
      const epoch = store.ownerEpoch;
      const managed = await inspectManagedMission(sample.root, mission.planId);
      const attempt = await inspectManagedAttempt(sample.root, attemptId);
      expect(managed?.id).toBe(mission.id);
      expect(attempt?.id).toBe(mission.id);
      expect(store.ownerEpoch).toBe(epoch);
      expect(missionCompletionCertificate(managed!, store)).toBeUndefined();
    } finally {
      store.close();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  test("managed Team tools and Board completion never use completed legacy prose", async () => {
    const sample = createMissionFixture("pitako-managed-routing-fences-");
    fixtures.push(sample);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = sample.stateDir;
    try {
      const workspace = repositoryIdentity(sample.root);
      const board = await openBoard();
      const topic = board.createTopic(workspace, { title: "Managed mission" });
      board.claimTopic(workspace, topic.id, "durable-fixture");
      const originalPost = board.post(workspace, { topicId: topic.id, type: "FINDING", content: "preserve this post" });
      board.close();
      const plan = `---\nid: durable-fixture\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\nexecution: expected\n---\n\nManaged fixture.\n`;
      writeFileSync(sample.planFile, plan);
      const opened = openExecutionPlan("durable-fixture", sample.root);
      writeFileSync(opened.ledger, readFileSync(opened.ledger, "utf8").replace("status: running", "status: completed"));
      const legacyLedger = readFileSync(opened.ledger);
      const store = await openFixtureStore(sample);
      const mission = store.createMission(missionInput(sample));
      const attemptId = randomUUID();
      const attemptEpoch = store.ownerEpoch!;
      const candidate = createMissionWorkspace({
        missionId: mission.id, attemptId, sourceRoot: sample.root, storeRoot: store.storageRoot,
        candidateParent: path.join(sample.base, "candidates"), allowedPaths: [],
      });
      const candidateRegistration = registerCandidateWorkspace(candidate, {
        repositoryId: mission.repositoryId, owner: currentProcessIdentity(store.runtimeId, attemptEpoch),
      });
      const binding = {
        missionId: mission.id, revision: mission.revision, unitId: "snapshot", roundId: "main", memberId: "solo",
        attemptId, attemptNo: 1, ownerEpoch: attemptEpoch, candidate: "managed" as const,
        candidateId: candidate.candidateId, candidateRoot: candidate.candidateRoot, candidateRegistration,
        inputManifestHash: "a".repeat(64), briefHash: "b".repeat(64), rolePolicyHash: "c".repeat(64),
      };
      store.appendTransition(mission.id, mission.version, { events: [
        { revision: mission.revision, kind: "attempt.reserved", causalId: randomUUID(), unitId: "snapshot", attemptId,
          payload: { attemptId, binding, unitId: "snapshot", roundId: "main", memberId: "solo", attemptNo: 1 } },
        { revision: mission.revision, kind: "workspace.candidate.registered", causalId: randomUUID(), unitId: "snapshot", attemptId,
          payload: { ...candidateRegistration, locationHistory: [candidate.candidateRoot] } },
      ] });
      expect(missionCompletionCertificate(store.inspectMission(mission.id), store)).toBeUndefined();

      const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
      const registerTool = (tool: any) => tools.set(tool.name, tool);
      agentExtension({ registerTool } as any);
      registerBoard({ registerTool, registerFlag() {}, registerCommand() {}, on() {} } as any);
      const context = { cwd: sample.root, sessionManager: { getSessionId: () => "managed-route-test" } };
      const invokeAt = (cwd: string, name: string, params: unknown) => tools.get(name)!.execute("call", params, new AbortController().signal, undefined, { ...context, cwd });
      const invoke = (name: string, params: unknown) => invokeAt(context.cwd, name, params);
      const synchronous = await invoke("agent_run", { role: "developer", task: "must not bypass engine" });
      expect(synchronous.isError).toBe(true);
      expect(synchronous.content[0].text).toContain("managed mission");
      const assign = await invoke("team_assign", { role: "developer", task: "must not bypass engine", plan: "other-plan", unit: "T4" });
      expect(assign.isError).toBe(true);
      expect(assign.content[0].text).toContain("managed mission");
      const spawn = await invoke("agent_spawn", { role: "developer", task: "must not bypass engine", plan: "other-plan", unit: "T4" });
      expect(spawn.isError).toBe(true);
      expect(spawn.content[0].text).toContain("managed mission");
      const locator = path.join(sample.root, ".pitako", "runs", mission.planId, "mission.json");
      rmSync(locator, { force: true });
      expect(existsSync(locator)).toBe(false);
      const missingLocatorRun = await invoke("agent_run", { role: "developer", task: "must not bypass missing locator" });
      expect(missingLocatorRun.isError).toBe(true);
      expect(missingLocatorRun.content[0].text).toContain("managed mission");
      const candidateRun = await invokeAt(candidate.candidateRoot, "agent_run", { role: "developer", task: "must not bypass engine" });
      expect(candidateRun.isError).toBe(true);
      expect(candidateRun.content[0].text).toContain("managed mission");
      const renamedCandidate = path.join(sample.base, "renamed-candidate");
      renameSync(candidate.candidateRoot, renamedCandidate);
      const candidateAlias = path.join(sample.base, "candidate-alias");
      symlinkSync(renamedCandidate, candidateAlias, "dir");
      const candidateSpawn = await invokeAt(candidateAlias, "agent_spawn", { role: "developer", task: "must not bypass engine", plan: "other-plan" });
      expect(candidateSpawn.isError).toBe(true);
      expect(candidateSpawn.content[0].text).toContain("managed mission");
      const candidateAssign = await invokeAt(candidateAlias, "team_assign", { role: "developer", task: "must not bypass engine" });
      expect(candidateAssign.isError).toBe(true);
      expect(candidateAssign.content[0].text).toContain("managed mission");
      const status = await invoke("team_status", { assignmentId: attemptId });
      expect(status.isError).toBeFalsy();
      expect((status.details as any).assignments[0].assignmentId).toBe(attemptId);
      const repeatedStatus = await invoke("team_status", { assignmentId: attemptId });
      expect((repeatedStatus.details as any).assignments).toEqual((status.details as any).assignments);
      const result = await invoke("team_result", { assignmentId: attemptId });
      expect(result.content[0].text).toContain("no durable worker result; no result was fabricated");
      const repeatedResult = await invoke("team_result", { assignmentId: attemptId });
      expect(repeatedResult.content[0].text).toBe(result.content[0].text);
      const cancel = await invoke("team_cancel", { assignmentId: attemptId });
      expect(cancel.isError).toBe(true);
      expect(cancel.content[0].text).toContain("not live in this process");
      const repeatedCancel = await invoke("team_cancel", { assignmentId: attemptId });
      expect(repeatedCancel.content[0].text).toBe(cancel.content[0].text);
      const wrongPlanLifecycle = await invoke("board_workflow_lifecycle", { planId: "other-plan", status: "resolved" });
      expect(wrongPlanLifecycle.isError).toBe(true);
      expect(wrongPlanLifecycle.content[0].text).toContain("managed mission");
      const beforeBoard = store.inspectMission(mission.id);
      store.appendTransition(mission.id, beforeBoard.version, { events: [{ revision: beforeBoard.revision,
        kind: "mission.imported", causalId: randomUUID(), payload: { holdsKnown: false, holds: [] } }] });
      const lifecycle = await invoke("board_workflow_lifecycle", { planId: mission.planId, status: "resolved" });
      expect(lifecycle.isError).toBe(true);
      expect(lifecycle.content[0].text).toContain("no valid completion certificate");
      const unchanged = await openBoard();
      expect(unchanged.readTopic(repositoryIdentity(sample.root), topic.id).topic.status).toBe("open");
      expect(unchanged.readTopic(repositoryIdentity(sample.root), topic.id).posts.map(({ id }) => id)).toEqual([originalPost.id]);
      unchanged.close();
      expect(readFileSync(opened.ledger)).toEqual(legacyLedger);
      const closed = await invoke("board_workflow_lifecycle", { planId: mission.planId, status: "closed" });
      expect(closed.isError).toBeFalsy();
      const afterClose = await openBoard();
      expect(afterClose.readTopic(repositoryIdentity(sample.root), topic.id).topic.status).toBe("closed");
      afterClose.close();
      recordT4Observation(`managed-routing-${mission.id}`, {
        format: "mission-t4-managed-routing-v1",
        cases: [
          { tool: "agent_run", target: "managed-source", rejected: synchronous.isError, message: synchronous.content[0].text },
          { tool: "team_assign", target: "managed-source", requestedPlan: "other-plan", rejected: assign.isError, message: assign.content[0].text },
          { tool: "agent_spawn", target: "managed-source", requestedPlan: "other-plan", rejected: spawn.isError, message: spawn.content[0].text },
          { tool: "agent_run", target: "managed-source-without-locator", missingLocator: !existsSync(locator), rejected: missingLocatorRun.isError, message: missingLocatorRun.content[0].text },
          { tool: "agent_run", target: "registered-candidate", rejected: candidateRun.isError, message: candidateRun.content[0].text },
          { tool: "agent_spawn", target: "renamed-candidate-symlink", requestedPlan: "other-plan", rejected: candidateSpawn.isError, message: candidateSpawn.content[0].text },
          { tool: "team_assign", target: "renamed-candidate-symlink", rejected: candidateAssign.isError, message: candidateAssign.content[0].text },
          { tool: "board_workflow_lifecycle", target: "managed-source", requestedPlan: "other-plan", rejected: wrongPlanLifecycle.isError, message: wrongPlanLifecycle.content[0].text },
          { tool: "team_status", stable: JSON.stringify((status.details as any).assignments) === JSON.stringify((repeatedStatus.details as any).assignments) },
          { tool: "team_result", stable: result.content[0].text === repeatedResult.content[0].text },
          { tool: "team_cancel", stable: cancel.content[0].text === repeatedCancel.content[0].text },
          { tool: "board_workflow_lifecycle", requestedPlan: mission.planId, resolvedWithoutCertificateRejected: lifecycle.isError, closedWithMatchingPlan: !closed.isError },
        ],
      });
      store.close();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("allows ad hoc dispatch to an unrelated repository while another mission is active", async () => {
    const managed = createMissionFixture("pitako-managed-routing-owned-");
    const unrelated = createMissionFixture("pitako-managed-routing-ad-hoc-");
    fixtures.push(managed, unrelated);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = managed.stateDir;
    mkdirSync(path.join(managed.stateDir, "pitako"), { recursive: true });
    writeFileSync(path.join(managed.stateDir, "pitako", "config.toml"),
      `[model_policies.developer.primary]\nmodel = "example/primary"\nreasoning = "off"\n`);
    const store = await openFixtureStore(managed);
    store.createMission(missionInput(managed));
    store.close();
    const started: string[] = [];
    setBackgroundExecutor({ async start(input) {
      started.push(input.cwd);
      return { status: "completed", result: "ad hoc completed", sideEffects: false, appliedReasoning: "off" };
    } });
    const ownerToken = Symbol("ad-hoc-routing-test");
    const settled = new Promise<void>((resolve) => bindBackgroundOwner({
      token: ownerToken, isIdle: () => true, hasUI: true,
      notify: () => resolve(), sendMessage: () => resolve(),
    }));
    try {
      const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
      agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
      const result = await tools.get("agent_spawn")!.execute("call", {
        role: "developer", task: "work in unrelated repository",
      }, new AbortController().signal, undefined, { cwd: unrelated.root });
      expect(result.isError).toBeFalsy();
      expect(started).toEqual([unrelated.root]);
      await settled;
      const consumed = await tools.get("agent_result")!.execute("result", { id: result.details.instanceId },
        new AbortController().signal, undefined, { cwd: unrelated.root });
      expect(consumed.isError).toBeFalsy();
      expect(consumed.content[0].text).toContain("ad hoc completed");
      recordT4Observation(`ad-hoc-routing-${randomUUID()}`, {
        format: "mission-t4-ad-hoc-routing-v1", dispatched: !result.isError, target: unrelated.root, started,
      });
    } finally {
      shutdownBackground(ownerToken);
      setBackgroundExecutor(undefined);
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
