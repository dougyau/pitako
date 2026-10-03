import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { MissionEngine, type MissionRoleRunner } from "../extensions/mission/engine.ts";
import agentExtension from "../extensions/agent/index.ts";
import { parseConsultationRequest, type TeamBundle } from "../extensions/mission/team-contract.ts";
import type { MissionDefinition } from "../extensions/mission/model.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore, type MissionFixture } from "./mission-fixtures.ts";

const fixtures: MissionFixture[] = [];
afterEach(() => { for (const sample of fixtures.splice(0)) rmSync(sample.base, { recursive: true, force: true }); });

function fixture(budget = 34): MissionFixture {
  const sample = createMissionFixture("pitako-consultation-");
  fixtures.push(sample);
  const definition = missionDefinition();
  definition.units = [{ id: "experts", dependencies: [], kind: "team", role: "developer", inputs: ["evidence:a"], outputs: ["advice"],
    acceptance: [{ id: "advice", kind: "manual", target: "host" }], risk: "medium", retryLimit: 0,
    team: { version: 1, phase: "review", synthesisRole: "developer", members: ["alpha", "beta", "gamma"].map((id) =>
      ({ id, role: "developer", perspective: id })) } }];
  definition.finalization.requiredPredicates = ["advice"];
  definition.budget = { roleLaunches: budget, providerRequests: budget, tokens: budget * 200,
    activeTimeMs: budget * 60000, artifactBytes: budget * 4000 };
  sample.definitionBytes = Buffer.from(JSON.stringify(definition));
  writeFileSync(sample.definitionFile, sample.definitionBytes);
  return sample;
}

function response(bundle: TeamBundle): string {
  if (bundle.round === "synthesis") return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase,
    round: bundle.round, memberId: bundle.memberId, classifications: bundle.priorFindings!.map(({ id, evidenceRefs }) =>
      ({ findingId: id, evidenceRefs, category: "uncertainty", reason: "advice only" })) });
  const target = bundle.priorFindings?.find(({ id }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
  return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round,
    memberId: bundle.memberId, findings: [{ id: "f", claim: "Inspect", evidenceRefs: ["evidence:a"],
      detail: { criterion: "Correctness", observation: "Inspect" },
      ...(target ? { respondsTo: { id: target.id, evidenceRefs: target.evidenceRefs } } : {}) }] });
}
function request(bundle: TeamBundle, firstRole = "developer"): string {
  return JSON.stringify({ format: "mission-consultation-request-v1", question: "Check evidence a", evidenceRefs: ["evidence:a"],
    members: ["one", "two", "three"].map((id) => ({ id, role: id === "one" ? firstRole : "developer", perspective: id })), synthesisRole: "developer" });
}

function worker(outputs: TeamBundle[], select: (bundle: TeamBundle) => string): MissionRoleRunner {
  return async ({ binding, unit, brief }, durable) => {
    const bundle = JSON.parse(brief.slice(brief.indexOf("\n") + 1)) as TeamBundle;
    outputs.push(bundle);
    expect(durable.readOnly).toBe(true);
    expect(durable.effects).toBeUndefined();
    return { instanceId: binding.attemptId, role: unit.role, status: "completed", model: { selectedModel: "fixture/local" }, result: select(bundle) };
  };
}

test("closed request rejects unbound pointers, unknown roles and extra spawn authority", () => {
  const bundle: TeamBundle = { format: "mission-team-bundle-v1", unitId: "experts", phase: "review", round: "independent",
    memberId: "alpha", perspective: "alpha", goal: "Examine", inputs: ["evidence:a"] };
  const bytes = Buffer.from(request(bundle));
  expect(parseConsultationRequest(bytes, bundle, { developer: {} }).members).toHaveLength(3);
  for (const patch of [
    { evidenceRefs: ["unbound"] },
    { members: [{ id: "one", role: "unfrozen", perspective: "unknown" },
      { id: "two", role: "developer", perspective: "two" }, { id: "three", role: "developer", perspective: "three" }] },
    { spawn: true },
  ]) expect(() => parseConsultationRequest(Buffer.from(JSON.stringify({ ...JSON.parse(request(bundle)), ...patch })),
    bundle, { developer: {} })).toThrow();
});

// A request is a terminal alternative, never a valid member response or a unit predicate.
test("read-only request yields once, completes child, resumes original slot with exact child result", async () => {
  const sample = fixture(23);
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const outputs: TeamBundle[] = [];
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    runRole: worker(outputs, (bundle) => !bundle.targetId && bundle.round === "independent" && bundle.memberId === "alpha" && !bundle.childResultHash
      ? request(bundle) : response(bundle)), assessPredicate: () => ({ verdict: "pass", method: "host observation" }) });
  try {
    engine.start(); await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    const admitted = events.filter(({ kind }) => kind === "team.consultation.admitted");
    expect(admitted).toHaveLength(1);
    const yielded = events.find((event) => event.kind === "attempt.settled" && event.payload.status === "yielded");
    expect(yielded?.payload.attemptId).toBe(admitted[0]!.payload.parentAttemptId);
    const resolved = events.filter(({ kind }) => kind === "team.consultation.resolved");
    expect(resolved).toHaveLength(1);
    expect(events.filter(({ kind, payload }) => kind === "attempt.reserved" && payload.targetId === admitted[0]!.payload.targetId)).toHaveLength(10);
    const continuation = events.find((event) => event.kind === "attempt.reserved" &&
      (event.payload.binding as { continuationOf?: string }).continuationOf === yielded!.payload.attemptId);
    expect(continuation).toBeDefined();
    expect((continuation!.payload.binding as { attemptNo: number }).attemptNo).toBe(2);
    expect(outputs.find((bundle) => bundle.childResultHash)?.childResultHash).toBe(String(resolved[0]!.payload.resultHash));
    expect(events.some((event) => event.kind === "team.member.recorded" && event.attemptId === yielded!.payload.attemptId)).toBe(false);
    expect(engine.snapshot().units.experts?.status).toBe("accepted");
    expect(events.some(({ kind }) => kind === "mission.completed")).toBe(false);
  } finally { await engine.close(); store.close(); }
}, 60000);

test("managed Team adapters project yielded parent and cancel its live child without continuation", async () => {
  const sample = fixture(35);
  const definition = JSON.parse(sample.definitionBytes.toString()) as MissionDefinition;
  definition.authority.rolePolicies.reviewer = { hash: "d".repeat(64), provider: "fixture", model: "local", fallbacks: [] };
  definition.units.push(missionDefinition().units[0]!);
  definition.finalization.requiredPredicates.push("snapshot-present");
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = sample.stateDir;
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  let release!: () => void;
  let childStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const child = new Promise<void>((resolve) => { childStarted = resolve; });
  const engine = new MissionEngine({ store, missionId: mission.id, ownerSessionId: "managed-consultation-test",
    sessionsDirectory: path.join(sample.base, "sessions"), assessPredicate: () => ({ verdict: "pass", method: "host observation" }),
    runRole: async ({ binding, unit, brief }, durable) => {
      if (!binding.teamBundleHash) return { instanceId: binding.attemptId, role: unit.role, status: "completed" as const,
        model: { selectedModel: "fixture/local" }, result: "PASS" };
      const bundle = JSON.parse(brief.slice(brief.indexOf("\n") + 1)) as TeamBundle;
      if (bundle.targetId && bundle.round === "independent" && bundle.memberId === "one") {
        childStarted();
        await gate; // Deliberately ignore abort: a late result must not resume its parent.
        expect(durable.signal?.aborted).toBe(true);
      }
      return { instanceId: binding.attemptId, role: unit.role, status: "completed", model: { selectedModel: "fixture/local" },
        result: !bundle.targetId && bundle.memberId === "alpha" && !bundle.childResultHash
          ? request(bundle, "reviewer") : response(bundle) };
    } });
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
  const invoke = (name: string, assignmentId: string) => tools.get(name)!.execute("call", { assignmentId },
    new AbortController().signal, undefined, { cwd: sample.root });
  try {
    engine.start(); await child;
    const before = store.inspectMission(mission.id);
    const admission = before.events.find(({ kind }) => kind === "team.consultation.admitted")!;
    const parentId = String(admission.payload.parentAttemptId);
    const childId = String(admission.payload.targetId);
    const childAttempt = before.events.find((event) => event.kind === "attempt.reserved" &&
      event.payload.targetId === childId && event.payload.roundId === "independent" && event.payload.memberId === "one")!;
    expect((await invoke("team_status", childAttempt.attemptId!)).details.assignments).toMatchObject([
      { role: "reviewer", targetId: childId, round: "independent", memberId: "one" },
    ]);
    const parentStatus = await invoke("team_status", parentId);
    expect(parentStatus.details.assignments).toMatchObject([{ assignmentId: parentId, role: "developer",
      targetId: "experts", round: "independent", memberId: "alpha", childTargetId: childId,
      status: "waiting-child", resultAvailable: false }]);
    const result = await invoke("team_result", parentId);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("mission-consultation-request-v1");
    expect(result.details).toMatchObject({ status: "waiting-child", resultAvailable: false, childTargetId: childId });
    expect((await invoke("team_status", parentId)).details).toEqual(parentStatus.details);
    expect((await invoke("team_result", parentId)).content).toEqual(result.content);
    expect(store.inspectMission(mission.id).events.filter((event) => event.attemptId === parentId)).toEqual(
      before.events.filter((event) => event.attemptId === parentId));
    const unknown = await invoke("team_cancel", randomUUID());
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("legacy team_cancel cannot target unknown assignment");
    expect(store.inspectMission(mission.id).events.some(({ kind }) => kind === "team.consultation.cancelled")).toBe(false);
    expect((await invoke("team_cancel", parentId)).isError).toBeFalsy();
    expect((await invoke("team_cancel", parentId)).isError).toBe(true);
    expect((await invoke("team_status", parentId)).details.assignments[0].status).toBe("cancelled");
    release(); await engine.waitForIdle();
    const after = store.inspectMission(mission.id);
    expect(after.events.some(({ kind }) => kind === "team.consultation.cancelled")).toBe(true);
    expect(after.events.some(({ kind }) => kind === "team.consultation.resolved")).toBe(false);
    expect(engine.snapshot().units.experts?.status).toBe("blocked");
    expect(engine.snapshot().units.snapshot?.status).toBe("accepted");
    expect(after.events.some((event) => event.kind === "attempt.reserved" &&
      (event.payload.binding as { continuationOf?: string }).continuationOf === parentId)).toBe(false);
    expect(after.events.some((event) => event.kind === "provider.request.dispatched" && event.payload.targetId === childId)).toBe(false);
    await engine.retireForShutdown("quit");
    const reopened = await openFixtureStore(sample);
    const next = new MissionEngine({ store: reopened, missionId: mission.id,
      sessionsDirectory: path.join(sample.base, "sessions-reopened"),
      runRole: async () => { throw new Error("cancelled branch must not dispatch on reopen"); } });
    try {
      await next.control("resume"); await next.waitForIdle();
      const persisted = reopened.inspectMission(mission.id);
      expect(persisted.events.filter(({ kind }) => kind === "team.consultation.cancelled")).toHaveLength(1);
      expect(persisted.events.some((event) => event.kind === "attempt.reserved" &&
        (event.payload.binding as { continuationOf?: string }).continuationOf === parentId)).toBe(false);
      expect(next.snapshot().units.snapshot?.status).toBe("accepted");
      const deadOwner = await invoke("team_cancel", parentId);
      expect(deadOwner.isError).toBe(true);
      expect(deadOwner.content[0].text).toContain("not live in this process");
    } finally { await next.close(); reopened.close(); }
  } finally {
    release(); await engine.retireForShutdown("quit");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}, 60000);

test("registered cancellation during predicate assessment fences acceptance; no cancellation accepts", async () => {
  for (const cancel of [true, false]) {
    const sample = fixture(40);
    const definition = JSON.parse(sample.definitionBytes.toString()) as MissionDefinition;
    definition.units.push({ id: "snapshot", dependencies: [], kind: "check", role: "developer", inputs: [], outputs: ["snapshot"],
      acceptance: [{ id: "snapshot-present", kind: "artifact_hash", target: "snapshot" }], risk: "low", retryLimit: 0 });
    definition.finalization.requiredPredicates.push("snapshot-present");
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = sample.stateDir;
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const assessing = new Promise<void>((resolve) => { entered = resolve; });
    const engine = new MissionEngine({ store, missionId: mission.id, ownerSessionId: `predicate-${randomUUID()}`,
      sessionsDirectory: path.join(sample.base, "sessions"),
      runRole: async ({ binding, unit, brief }) => {
        const bundle = binding.teamBundleHash ? JSON.parse(brief.slice(brief.indexOf("\n") + 1)) as TeamBundle : undefined;
        return { instanceId: binding.attemptId, role: unit.role, status: "completed", model: { selectedModel: "fixture/local" },
          result: !bundle ? "PASS" : !bundle.targetId && bundle.round === "independent" && bundle.memberId === "alpha" && !bundle.childResultHash
            ? request(bundle) : response(bundle) };
      }, assessPredicate: async ({ unit }) => {
        if (unit.id === "experts") { entered(); await gate; }
        return { verdict: "pass", method: "host observation", artifactBytes: Buffer.from("host check completed") };
      } });
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
    const invoke = (name: string, assignmentId: string) => tools.get(name)!.execute("call", { assignmentId },
      new AbortController().signal, undefined, { cwd: sample.root });
    try {
      engine.start(); await assessing;
      const before = store.inspectMission(mission.id);
      const parentId = before.events.find((event) => event.kind === "attempt.settled" && event.payload.status === "yielded")!.attemptId!;
      const continuation = before.events.find((event) => event.kind === "attempt.reserved" &&
        (event.payload.binding as { continuationOf?: string }).continuationOf === parentId)!;
      expect(continuation).toBeDefined();
      const synthesis = before.events.find((event) => event.kind === "attempt.reserved" &&
        event.unitId === "experts" && event.payload.targetId === "experts" && event.payload.roundId === "synthesis")!;
      expect(synthesis).toBeDefined();
      if (cancel) {
        expect((await invoke("team_status", parentId)).details.assignments[0].status).toBe("continued");
        expect((await invoke("team_cancel", parentId)).isError).toBeFalsy();
        expect(engine.snapshot().units.experts?.status).toBe("blocked");
      }
      release(); await engine.waitForIdle();
      const inspection = store.inspectMission(mission.id);
      const unitEvents = inspection.events.filter((event) => event.unitId === "experts");
      expect(engine.snapshot().units.snapshot?.status).toBe("accepted");
      expect(unitEvents.filter((event) => event.kind === "unit.accepted")).toHaveLength(cancel ? 0 : 1);
      expect(engine.snapshot().units.experts?.status).toBe(cancel ? "blocked" : "accepted");
      expect(unitEvents.some((event) => event.kind === "team.consultation.cancelled")).toBe(cancel);
      const evidence = unitEvents.filter((event) => event.kind === "evidence.recorded");
      expect(evidence).toHaveLength(1);
      expect(evidence[0]!.payload.verdict).toBe("pass");
      expect(store.readArtifact(String(evidence[0]!.payload.artifactHash)).toString()).toBe("host check completed");
      expect(unitEvents.find((event) => event.kind === "attempt.settled" && event.attemptId === synthesis.attemptId)?.payload.status)
        .toBe(cancel ? "cancelled" : "succeeded");
      const reservation = inspection.events.find((event) => event.kind === "reservation.created" &&
        event.attemptId === synthesis.attemptId && event.payload.resource === "artifact-bytes")!;
      const receipt = inspection.events.find((event) => event.kind === "attempt.receipt" && event.attemptId === synthesis.attemptId)!;
      const chargedBytes = store.readArtifact(String(receipt.payload.artifactHash)).byteLength + Buffer.byteLength("host check completed");
      expect(inspection.events.some((event) => event.kind === "budget.reservation.settled" &&
        event.payload.reservationId === reservation.payload.reservationId && event.payload.unknownCharge === 0 &&
        event.payload.knownCharge === chargedBytes)).toBe(true);
      expect((await invoke("team_result", parentId)).isError).toBe(true);
      if (cancel) {
        expect((await invoke("team_status", parentId)).details.assignments[0].status).toBe("cancelled");
        await engine.retireForShutdown("quit");
        const reopened = await openFixtureStore(sample);
        const next = new MissionEngine({ store: reopened, missionId: mission.id,
          sessionsDirectory: path.join(sample.base, "sessions-reopened"),
          runRole: async () => { throw new Error("cancelled branch must not dispatch after restart"); } });
        try {
          await next.control("resume"); await next.waitForIdle();
          expect(next.snapshot().units.experts?.status).toBe("blocked");
          expect(next.snapshot().units.snapshot?.status).toBe("accepted");
          expect(reopened.inspectMission(mission.id).events.filter((event) => event.kind === "unit.accepted" && event.unitId === "experts"))
            .toHaveLength(0);
          expect((await invoke("team_cancel", parentId)).isError).toBe(true);
        } finally { await next.close(); reopened.close(); }
      }
    } finally {
      release(); await engine.retireForShutdown("quit"); store.close();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
}, 60000);

test("insufficient ordinary allowance rejects before child dispatch", async () => {
  const sample = fixture(12);
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const outputs: TeamBundle[] = [];
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    runRole: worker(outputs, (bundle) => bundle.memberId === "alpha" ? request(bundle) : response(bundle)) });
  try {
    engine.start(); await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    expect(events.filter(({ kind }) => kind === "team.consultation.admitted")).toHaveLength(0);
    expect(events.filter(({ kind }) => kind === "team.consultation.denied")).toHaveLength(1);
    expect(events.some((event) => event.kind === "team.member.recorded" &&
      String(event.payload.reason).includes("consultation minimum role-launches"))).toBe(true);
    expect(outputs.every((bundle) => !bundle.targetId)).toBe(true);
    expect(engine.snapshot().units.experts?.status).toBe("blocked");
  } finally { await engine.close(); store.close(); }
}, 60000);

test("yielded parent frees a root session while two root siblings and child share the three-slot cap", async () => {
  const sample = fixture(26);
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  let release!: () => void;
  let childStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const child = new Promise<void>((resolve) => { childStarted = resolve; });
  const active = new Set<string>();
  let peak = 0;
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    runRole: async ({ binding, unit, brief }, durable) => {
      const bundle = JSON.parse(brief.slice(brief.indexOf("\n") + 1)) as TeamBundle;
      active.add(binding.attemptId);
      peak = Math.max(peak, active.size);
      try {
        const requestId = randomUUID();
        const ticket = await durable.onProviderDispatch!({ requestId, provider: "fixture", model: "local" });
        await durable.onProviderReceipt!({ requestId, provider: "fixture", model: "local", inputTokens: 1, outputTokens: 1, ticket });
        if (!bundle.targetId && bundle.round === "independent" && bundle.memberId !== "alpha") await gate;
        if (bundle.targetId && bundle.round === "independent" && bundle.memberId === "one") {
          childStarted(); await gate;
        }
        return { instanceId: binding.attemptId, role: unit.role, status: "completed", model: { selectedModel: "fixture/local" },
          result: !bundle.targetId && bundle.round === "independent" && bundle.memberId === "alpha" && !bundle.childResultHash
            ? request(bundle) : response(bundle) };
      } finally { active.delete(binding.attemptId); }
    }, assessPredicate: () => ({ verdict: "pass", method: "host observation" }) });
  try {
    engine.start(); await child;
    const before = store.inspectMission(mission.id).events;
    expect(before.some(({ kind, payload }) => kind === "attempt.settled" && payload.status === "yielded")).toBe(true);
    expect(active.size).toBe(3);
    expect(peak).toBe(3);
    expect(before.filter(({ kind }) => kind === "provider.request.dispatched")).toHaveLength(4);
    release(); await engine.waitForIdle();
    expect(peak).toBe(3);
    expect(engine.snapshot().units.experts?.status).toBe("accepted");
    expect(store.inspectMission(mission.id).events.some(({ kind }) => kind === "mission.completed")).toBe(false);
  } finally { release(); await engine.close(); store.close(); }
}, 60000);

test.each([23, 24])("fallback provider request uses only slack at budget %i", async (budget) => {
  const sample = fixture(budget); // 10 root slots + 10 child slots + continuation + 2 protected launches.
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  let extraDenied = false;
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    runRole: async ({ binding, unit, brief }, durable) => {
      const bundle = JSON.parse(brief.slice(brief.indexOf("\n") + 1)) as TeamBundle;
      const requestId = randomUUID();
      const ticket = await durable.onProviderDispatch!({ requestId, provider: "fixture", model: "local" });
      await durable.onProviderReceipt!({ requestId, provider: "fixture", model: "local", inputTokens: 1, outputTokens: 1, ticket });
      if (bundle.targetId && bundle.round === "independent" && bundle.memberId === "one") {
        try { await durable.onProviderDispatch!({ requestId: randomUUID(), provider: "fixture", model: "fallback" }); }
        catch { extraDenied = true; }
      }
      return { instanceId: binding.attemptId, role: unit.role, status: "completed", model: { selectedModel: "fixture/local" },
        result: !bundle.targetId && bundle.round === "independent" && bundle.memberId === "alpha" && !bundle.childResultHash
          ? request(bundle) : response(bundle) };
    }, assessPredicate: () => ({ verdict: "pass", method: "host observation" }) });
  try {
    engine.start(); await engine.waitForIdle();
    const inspection = store.inspectMission(mission.id);
    const child = inspection.events.find(({ kind }) => kind === "team.consultation.admitted")!;
    const childOne = inspection.events.find((event) => event.kind === "attempt.reserved" &&
      event.payload.targetId === child.payload.targetId && event.payload.roundId === "independent" && event.payload.memberId === "one")!;
    expect(extraDenied).toBe(budget === 23);
    expect(inspection.events.filter((event) => event.kind === "provider.request.dispatched" && event.attemptId === childOne.attemptId))
      .toHaveLength(budget === 23 ? 1 : 2);
    const heldProvider = inspection.events.filter((event) => event.kind === "budget.reservation.adjusted" &&
      event.payload.resource === "provider-requests" && event.attemptId === childOne.attemptId);
    expect(heldProvider).toHaveLength(1);
    expect(inspection.events.filter(({ kind }) => kind === "team.consultation.resolved")).toHaveLength(1);
    expect(inspection.events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(21);
    expect(engine.snapshot().units.experts?.status).toBe("accepted");
    expect(inspection.reservations.filter(({ purpose }) => purpose === "protected").map(({ amount }) => amount))
      .toEqual([2, 2, 400, 120000, 8000]);
    expect(inspection.events.some(({ kind }) => kind === "mission.completed")).toBe(false);
  } finally { await engine.close(); store.close(); }
}, 60000);

test("incomplete child releases its minimum while unrelated unit may finish", async () => {
  const sample = fixture(35);
  const definition = JSON.parse(sample.definitionBytes.toString()) as MissionDefinition;
  const independent = missionDefinition().units[0]!;
  definition.units.push(independent);
  definition.finalization.requiredPredicates.push(independent.acceptance[0]!.id);
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    runRole: async ({ binding, unit, brief }) => {
      const bundle = binding.teamBundleHash ? JSON.parse(brief.slice(brief.indexOf("\n") + 1)) as TeamBundle : undefined;
      return { instanceId: binding.attemptId, role: unit.role, status: "completed", model: { selectedModel: "fixture/local" },
        result: !bundle ? "PASS" : !bundle.targetId && bundle.memberId === "alpha" ? request(bundle) :
          bundle.targetId && bundle.memberId === "one" ? JSON.stringify({ ...JSON.parse(request(bundle)), extra: "invalid" }) : response(bundle) };
    }, assessPredicate: () => ({ verdict: "pass", method: "host observation" }) });
  try {
    engine.start(); await engine.waitForIdle();
    const inspection = store.inspectMission(mission.id);
    expect(engine.snapshot().units.experts?.status).toBe("blocked");
    expect(engine.snapshot().units.snapshot?.status).toBe("accepted");
    expect(inspection.events.filter(({ kind }) => kind === "team.consultation.admitted")).toHaveLength(1);
    expect(inspection.events.filter((event) => event.kind === "budget.reservation.adjusted" &&
      event.payload.reason === "release consultation minimum into a root dispatch grant" && event.payload.amount === 0)).toHaveLength(5);
    expect(inspection.events.some(({ kind }) => kind === "mission.completed")).toBe(false);
  } finally { await engine.close(); store.close(); }
}, 60000);

test("revision between child reservation and provider dispatch fences the old slot", async () => {
  const sample = fixture(34);
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  let allowDispatch!: () => void;
  let entered!: (id: string) => void;
  const gate = new Promise<void>((resolve) => { allowDispatch = resolve; });
  const started = new Promise<string>((resolve) => { entered = resolve; });
  let denied = "";
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    runRole: async ({ binding, unit, brief }, durable) => {
      const bundle = JSON.parse(brief.slice(brief.indexOf("\n") + 1)) as TeamBundle;
      if (bundle.targetId && bundle.memberId === "one" && bundle.round === "independent") {
        entered(binding.attemptId);
        await gate;
        try { await durable.onProviderDispatch?.({ requestId: randomUUID(), provider: "fixture", model: "local" }); }
        catch (error) { denied = String(error); }
        return { instanceId: binding.attemptId, role: unit.role, status: "failed", model: { selectedModel: "fixture/local" }, result: denied };
      }
      return { instanceId: binding.attemptId, role: unit.role, status: "completed", model: { selectedModel: "fixture/local" },
        result: !bundle.targetId && bundle.memberId === "alpha" && !bundle.childResultHash ? request(bundle) : response(bundle) };
    } });
  try {
    engine.start();
    const attemptId = await started;
    const current = store.inspectMission(mission.id);
    store.admitRevision({ missionId: mission.id, expectedVersion: current.version,
      planBytes: Buffer.from(sample.planBytes.toString().replace("revision: 1", "revision: 2")),
      definitionBytes: sample.definitionBytes, receiptId: randomUUID(), actor: "model", impact: ["experts"], retained: [] });
    allowDispatch();
    await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    expect(denied).toContain("fenced");
    expect(events.some((event) => event.kind === "provider.request.dispatched" && event.attemptId === attemptId)).toBe(false);
    expect(events.filter(({ kind }) => kind === "team.consultation.admitted")).toHaveLength(1);
    expect(events.filter(({ kind }) => kind === "team.consultation.denied")).toHaveLength(0);
    expect(events.some(({ kind }) => kind === "unit.accepted")).toBe(false);
  } finally { allowDispatch(); await engine.close(); store.close(); }
}, 60000);

test("mutating singleton parent request is explicitly denied, never a predicate success", async () => {
  const sample = createMissionFixture("pitako-mutating-consultation-");
  fixtures.push(sample);
  const definition = missionDefinition();
  definition.budget.artifactBytes = 1_050_000;
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    managedWorkspace: { sourceRoot: sample.root }, runRole: async ({ binding, unit }, durable) => {
      expect(durable.readOnly).toBe(false);
      return { instanceId: binding.attemptId, role: unit.role, status: "completed", model: { selectedModel: "fixture/local" },
        result: JSON.stringify({ format: "mission-consultation-request-v1", question: "Write files" }) };
    }, assessPredicate: () => ({ verdict: "pass", method: "must not assess request" }) });
  try {
    engine.start(); await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    expect(events.some((event) => event.kind === "attempt.settled" && event.payload.status === "failed" &&
      String(event.payload.reason).includes("singleton checkpoint unproven"))).toBe(true);
    expect(events.find(({ kind }) => kind === "team.consultation.denied")?.payload.reason).toContain("terminal SDK disposal is unproven");
    expect(events.some(({ kind }) => kind === "team.consultation.admitted" || kind === "unit.accepted")).toBe(false);
  } finally { await engine.close(); store.close(); }
}, 30000);

test("malformed request and depth-three request are explicit incomplete, never member success", async () => {
  for (const malformed of [true, false]) {
    const sample = fixture(48);
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const outputs: TeamBundle[] = [];
    const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      runRole: worker(outputs, (bundle) => {
        if (malformed && !bundle.targetId && bundle.memberId === "alpha") return JSON.stringify({ ...JSON.parse(request(bundle)), extra: "spawn" });
        if (!malformed && bundle.round === "independent" && bundle.memberId ===
          (!bundle.targetId ? "alpha" : bundle.question === "Check evidence a" ? "one" : "one") && !bundle.childResultHash)
          return request(bundle);
        return response(bundle);
      }) });
    try {
      engine.start(); await engine.waitForIdle();
      const events = store.inspectMission(mission.id).events;
      expect(events.some((event) => event.kind === "team.member.recorded" && event.payload.status === "invalid")).toBe(true);
      expect(events.some(({ kind }) => kind === "unit.accepted")).toBe(false);
      if (malformed) expect(events.filter(({ kind }) => kind === "team.consultation.admitted")).toHaveLength(0);
      else {
        expect(events.filter(({ kind }) => kind === "team.consultation.admitted")).toHaveLength(2);
        expect(events.some((event) => event.kind === "team.member.recorded" && String(event.payload.reason).includes("depth exceeds 2"))).toBe(true);
      }
    } finally { await engine.close(); store.close(); }
  }
}, 60000);
