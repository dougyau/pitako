import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, test } from "bun:test";
import { MissionEngine, type MissionRoleRunner } from "../extensions/mission/engine.ts";
import { parseTeamResponse, type TeamBundle } from "../extensions/mission/team-contract.ts";
import type { MissionDefinition } from "../extensions/mission/model.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore, type MissionFixture } from "./mission-fixtures.ts";

const fixtures: MissionFixture[] = [];
const observations: unknown[] = [];
afterAll(() => {
  if (process.env.MISSION_TEAM_PROTOCOL_OBSERVATION_PATH)
    writeFileSync(process.env.MISSION_TEAM_PROTOCOL_OBSERVATION_PATH, JSON.stringify(observations, null, 2));
});
afterEach(() => { for (const sample of fixtures.splice(0)) rmSync(sample.base, { recursive: true, force: true }); });

function configure(phase: "planning" | "execution" | "review", budget = 20): MissionFixture {
  const sample = createMissionFixture("pitako-team-");
  fixtures.push(sample);
  const definition = missionDefinition();
  definition.goal = "Compare bounded specialist findings";
  definition.units = [{
    id: "experts", dependencies: [], kind: "team", role: "developer", inputs: ["question"], outputs: ["advice"],
    acceptance: [{ id: "team-assessed", kind: "manual", target: "host-assessed" }], risk: "medium", retryLimit: 0,
    team: { version: 1, phase, synthesisRole: "developer", members: ["alpha", "beta", "gamma"].map((id) => ({ id, role: "developer", perspective: `${id} perspective` })) },
  }];
  definition.finalization.requiredPredicates = ["team-assessed"];
  definition.budget = { roleLaunches: budget, providerRequests: budget, tokens: budget * 200, activeTimeMs: budget * 60000, artifactBytes: budget * 4000 };
  sample.definitionBytes = Buffer.from(JSON.stringify(definition));
  writeFileSync(sample.definitionFile, sample.definitionBytes);
  return sample;
}

function output(bundle: TeamBundle): string {
  const detail = bundle.phase === "planning" ? { proposal: "Investigate evidence", constraints: "No implementation" }
    : bundle.phase === "execution" ? { recommendation: "Inspect implementation", impact: "Read-only advice" }
      : { criterion: "Correctness", observation: "Inspect evidence" };
  if (bundle.round === "synthesis") return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round,
    memberId: bundle.memberId, classifications: bundle.priorFindings!.map(({ id, evidenceRefs }) => ({ findingId: id, evidenceRefs,
      category: "uncertainty", reason: "Needs host verification, not vote count" })) });
  const target = bundle.priorFindings?.find(({ id }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
  return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
    findings: [{ id: "observation", claim: "Provisional finding", evidenceRefs: [`artifact:${bundle.memberId}`], detail,
      ...(target ? { respondsTo: { id: target.id, evidenceRefs: target.evidenceRefs } } : {}) }] });
}

function runner(bundles: TeamBundle[], overrides: (bundle: TeamBundle) => string = output): MissionRoleRunner {
  return async ({ unit, binding, brief }, durable) => {
    const bundle = JSON.parse(brief.slice(brief.indexOf("\n") + 1)) as TeamBundle;
    bundles.push(bundle);
    expect(binding.roundId).toBe(bundle.round);
    expect(binding.memberId).toBe(bundle.memberId);
    expect(durable.readOnly).toBe(true);
    expect(durable.effects).toBeUndefined();
    const result = { instanceId: binding.attemptId, role: unit.role, status: "completed" as const,
      model: { selectedModel: "fixture/local" }, result: overrides(bundle) };
    durable.onOutcome?.(result);
    durable.onOutcome?.({ ...result, result: "duplicate conflicting callback" });
    return result;
  };
}

for (const phase of ["planning", "execution", "review"] as const) test(`${phase} team executes three member rounds plus separate synthesis without peer anchoring`, async () => {
  const sample = configure(phase);
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const bundles: TeamBundle[] = [];
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    ...(phase === "planning" ? { managedWorkspace: { sourceRoot: sample.root } } : {}),
    runRole: runner(bundles), assessPredicate: () => ({ verdict: "pass", method: "host fixture observation" }) });
  try {
    engine.start(); await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    expect(bundles.map(({ round }) => round)).toEqual([
      "independent", "independent", "independent", "critique", "critique", "critique", "rebuttal", "rebuttal", "rebuttal", "synthesis",
    ]);
    expect(bundles.slice(0, 3).every((bundle) => !("priorFindings" in bundle))).toBe(true);
    expect(bundles.slice(3).every((bundle) => bundle.priorFindings!.length >= 3)).toBe(true);
    expect(events.filter(({ kind }) => kind === "team.barrier.recorded").map(({ payload }) => payload.status)).toEqual(["complete", "complete", "complete", "complete"]);
    expect(events.filter(({ kind }) => kind === "attempt.receipt")).toHaveLength(10);
    expect(events.filter(({ kind }) => kind === "attempt.reserved").every(({ payload }) =>
      (payload.binding as { candidate: string }).candidate === "read-only")).toBe(true);
    expect(events.some(({ kind }) => kind === "workspace.candidate.registered" || kind === "effect.intent")).toBe(false);
    expect(engine.snapshot().units.experts?.status).toBe("accepted");
    expect(events.some(({ kind }) => kind === "mission.completed")).toBe(false);
    observations.push({ phase, bundles, events, accepted: true, protocolOnly: true });
  } finally { await engine.close(); store.close(); }
}, 30000);

for (const [name, corrupt] of [
  ["wrong round", (bundle: TeamBundle) => output(bundle).replace(`"round":"${bundle.round}"`, '"round":"wrong"')],
  ["missing member", (bundle: TeamBundle) => bundle.memberId === "beta" ? "" : output(bundle)],
  ["peer pointer mismatch", (bundle: TeamBundle) => bundle.round === "critique" ? output(bundle).replace(/"respondsTo":\{"id":"[^"]+","evidenceRefs":\[[^\]]+\]\}/, '"respondsTo":{"id":"unknown","evidenceRefs":[]}') : output(bundle)],
] as const) test(`team ${name} is incomplete and never synthesizes`, async () => {
  const sample = configure("planning");
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const bundles: TeamBundle[] = [];
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"), runRole: runner(bundles, corrupt) });
  try {
    engine.start(); await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    expect(events.some((event) => event.kind === "team.barrier.recorded" && event.payload.status === "incomplete")).toBe(true);
    expect(events.some((event) => event.kind === "unit.accepted")).toBe(false);
    expect(bundles.some(({ round }) => round === "synthesis")).toBe(false);
    observations.push({ negative: name, bundles, events, accepted: false });
  } finally { await engine.close(); store.close(); }
}, 30000);

test("output contracts reject planning implementation claims and unmatched peer evidence", () => {
  const bundle: TeamBundle = { format: "mission-team-bundle-v1", unitId: "experts", phase: "planning", round: "independent",
    memberId: "alpha", perspective: "alpha", goal: "plan", inputs: [] };
  const valid = JSON.parse(output(bundle));
  valid.findings[0].detail.implementation = "write files";
  expect(() => parseTeamResponse(Buffer.from(JSON.stringify(valid)), bundle)).toThrow(/planning output/);
  const wrong = { ...bundle, round: "critique" as const, priorFindings: [{ id: "independent:beta:observation", claim: "x", evidenceRefs: ["artifact:beta"], detail: { proposal: "p", constraints: "c" } }] };
  const critique = JSON.parse(output(wrong));
  critique.findings[0].respondsTo.evidenceRefs = ["other"];
  expect(() => parseTeamResponse(Buffer.from(JSON.stringify(critique)), wrong)).toThrow(/unbound/);
});

test("empty team rounds require no eligible peer or challenge", () => {
  const own = { id: "independent:alpha:f", claim: "Evidence", evidenceRefs: ["object:a"], detail: { criterion: "Correctness", observation: "Inspect" } };
  const empty = (bundle: TeamBundle) => Buffer.from(JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase,
    round: bundle.round, memberId: bundle.memberId, findings: [] }));
  const critique: TeamBundle = { format: "mission-team-bundle-v1", unitId: "experts", phase: "review", round: "critique",
    memberId: "alpha", perspective: "alpha", goal: "Review", inputs: [], priorFindings: [own] };
  expect(parseTeamResponse(empty(critique), critique).findings).toEqual([]);
  const peerCritique = { ...critique, memberId: "beta" };
  expect(() => parseTeamResponse(empty(peerCritique), peerCritique)).toThrow(/omitted peer references/);
  const challenge = { ...own, id: "critique:beta:c", respondsTo: { id: own.id, evidenceRefs: own.evidenceRefs } };
  const rebuttal = { ...critique, round: "rebuttal" as const, memberId: "gamma", priorFindings: [own, challenge] };
  expect(parseTeamResponse(empty(rebuttal), rebuttal).findings).toEqual([]);
  const challenged = { ...rebuttal, memberId: "alpha" };
  expect(() => parseTeamResponse(empty(challenged), challenged)).toThrow(/omitted peer references/);
  const defense = JSON.parse(output(challenged));
  expect(defense.findings[0].respondsTo).toEqual({ id: challenge.id, evidenceRefs: challenge.evidenceRefs });
  expect(parseTeamResponse(Buffer.from(JSON.stringify(defense)), challenged).findings).toHaveLength(1);
  defense.findings[0].respondsTo.evidenceRefs = ["wrong"];
  expect(() => parseTeamResponse(Buffer.from(JSON.stringify(defense)), challenged)).toThrow(/unbound/);
});

test("one independent finding traverses all rounds without invented critique or rebuttal", async () => {
  const sample = configure("review");
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const bundles: TeamBundle[] = [];
  const oneFinding = (bundle: TeamBundle): string => {
    if (bundle.round === "independent" && bundle.memberId !== "alpha" ||
      bundle.round === "critique" && bundle.memberId === "alpha" ||
      bundle.round === "rebuttal" && bundle.memberId !== "alpha")
      return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round,
        memberId: bundle.memberId, findings: [] });
    return output(bundle);
  };
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    runRole: runner(bundles, oneFinding), assessPredicate: () => ({ verdict: "pass", method: "fixture host observation" }) });
  try {
    engine.start(); await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    expect(bundles.map(({ round }) => round)).toEqual([
      "independent", "independent", "independent", "critique", "critique", "critique", "rebuttal", "rebuttal", "rebuttal", "synthesis",
    ]);
    expect(events.filter(({ kind }) => kind === "team.barrier.recorded").map(({ payload }) => payload.status))
      .toEqual(["complete", "complete", "complete", "complete"]);
    expect(bundles.find(({ round, memberId }) => round === "synthesis" && memberId === "synthesis")?.priorFindings)
      .toHaveLength(4);
    expect(events.filter(({ kind, payload }) => kind === "team.member.recorded" && payload.status === "valid")).toHaveLength(10);
    expect(engine.snapshot().units.experts?.status).toBe("accepted");
    expect(events.some(({ kind }) => kind === "mission.completed")).toBe(false);
  } finally { await engine.close(); store.close(); }
}, 30000);

test("eligible peer omitted in a solo-finding critique blocks synthesis", async () => {
  const sample = configure("review");
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const bundles: TeamBundle[] = [];
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    runRole: runner(bundles, (bundle) => bundle.round === "critique" && bundle.memberId !== "gamma" ||
      bundle.round === "independent" && bundle.memberId !== "alpha"
      ? JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round,
        memberId: bundle.memberId, findings: [] }) : output(bundle)) });
  try {
    engine.start(); await engine.waitForIdle();
    const critique = store.inspectMission(mission.id).events.filter(({ kind, payload }) =>
      kind === "team.member.recorded" && payload.round === "critique");
    expect(critique.map(({ payload }) => [payload.memberId, payload.status]))
      .toEqual([["alpha", "valid"], ["beta", "invalid"], ["gamma", "valid"]]);
    expect(bundles.some(({ round }) => round === "synthesis")).toBe(false);
    expect(engine.snapshot().units.experts?.status).toBe("blocked");
  } finally { await engine.close(); store.close(); }
}, 30000);

test("member policies follow declared roles and never inherit singleton dispatch", async () => {
  const sample = configure("review");
  const definition = JSON.parse(sample.definitionBytes.toString()) as MissionDefinition;
  definition.authority.rolePolicies.reviewer = { hash: "b".repeat(64), provider: "fixture", model: "local", fallbacks: [] };
  definition.authority.rolePolicies.architect = { hash: "c".repeat(64), provider: "fixture", model: "local", fallbacks: [] };
  definition.units[0]!.team!.members[1]!.role = "reviewer";
  definition.units[0]!.team!.members[2]!.role = "architect";
  definition.units[0]!.team!.synthesisRole = "reviewer";
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    runRole: runner([]), assessPredicate: () => ({ verdict: "pass", method: "host fixture assessment" }) });
  try {
    engine.start(); await engine.waitForIdle();
    const bindings = store.inspectMission(mission.id).events.filter(({ kind }) => kind === "attempt.reserved")
      .map(({ payload }) => payload.binding as { memberId: string; rolePolicyHash: string });
    expect(bindings.filter(({ memberId }) => memberId === "beta").every(({ rolePolicyHash }) => rolePolicyHash === "b".repeat(64))).toBe(true);
    expect(bindings.filter(({ memberId }) => memberId === "gamma").every(({ rolePolicyHash }) => rolePolicyHash === "c".repeat(64))).toBe(true);
    expect(bindings.find(({ memberId }) => memberId === "synthesis")?.rolePolicyHash).toBe("b".repeat(64));
    expect(engine.snapshot().units.experts?.status).toBe("accepted");
  } finally { await engine.close(); store.close(); }
});

test("unreceipted required member leaves a durable incomplete barrier after restart", async () => {
  const sample = configure("execution");
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const attemptId = "11111111-1111-4111-8111-111111111111";
  const binding = { missionId: mission.id, revision: 1, unitId: "experts", roundId: "independent",
    memberId: "alpha", attemptId, attemptNo: 1, ownerEpoch: store.ownerEpoch!, candidate: "read-only",
    inputManifestHash: "a".repeat(64), briefHash: "b".repeat(64), rolePolicyHash: "a".repeat(64),
    teamBundleHash: "c".repeat(64), teamOutputContractHash: "d".repeat(64) };
  store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [
    { revision: 1, kind: "mission.activated", causalId: "22222222-2222-4222-8222-222222222222", payload: {} },
    { revision: 1, kind: "attempt.reserved", causalId: "33333333-3333-4333-8333-333333333333",
      unitId: "experts", attemptId, payload: { attemptId, unitId: "experts", roundId: "independent", memberId: "alpha", binding } },
    { revision: 1, kind: "attempt.started", causalId: "44444444-4444-4444-8444-444444444444",
      unitId: "experts", attemptId, payload: { attemptId, unitId: "experts" } },
  ] });
  const attempts: string[] = [];
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    runRole: async ({ binding }) => { attempts.push(binding.memberId); throw new Error("must not relaunch"); } });
  try {
    engine.start(); await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    expect(attempts).toEqual([]);
    expect(events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(1);
    expect(events.find(({ kind }) => kind === "team.barrier.recorded")?.payload).toMatchObject({
      status: "incomplete", missing: ["alpha", "beta", "gamma"],
    });
    expect(engine.snapshot().units.experts?.status).toBe("blocked");
  } finally { await engine.close(); store.close(); }
});

test("unanimous team advice cannot pass failed host evidence", async () => {
  const sample = configure("review");
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    runRole: runner([]), assessPredicate: () => ({ verdict: "fail", method: "independent host observation" }) });
  try {
    engine.start(); await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    expect(events.filter(({ kind }) => kind === "team.barrier.recorded").map(({ payload }) => payload.status))
      .toEqual(["complete", "complete", "complete", "incomplete"]);
    expect(events.some(({ kind }) => kind === "unit.accepted")).toBe(false);
    expect(engine.snapshot().units.experts?.status).toBe("blocked");
  } finally { await engine.close(); store.close(); }
});

test("team activation funds ten launches plus protected finalization", async () => {
  const sample = configure("review", 11);
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"), runRole: runner([]) });
  try { expect(() => engine.start()).toThrow(/mandatory path needs 12 role launches/); }
  finally { await engine.close(); store.close(); }
});

test("legacy team bytes remain readable but never fall through singleton dispatch", async () => {
  const sample = configure("planning");
  const definition = JSON.parse(sample.definitionBytes.toString()) as MissionDefinition;
  delete definition.units[0]!.team;
  definition.units.push({ id: "independent", dependencies: [], kind: "consultation", role: "developer", inputs: [], outputs: ["advice"],
    acceptance: [{ id: "independent-checked", kind: "manual", target: "host" }], risk: "low", retryLimit: 0 });
  definition.finalization.requiredPredicates.push("independent-checked");
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const starts: string[] = [];
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    runRole: async ({ binding }) => { starts.push(binding.unitId); return { instanceId: binding.attemptId, role: "developer",
      status: "completed", model: { selectedModel: "fixture/local" }, result: "independent work" }; },
    assessPredicate: () => ({ verdict: "pass", method: "fixture host" }) });
  try {
    engine.start(); await engine.waitForIdle();
    expect(starts).toEqual(["independent"]);
    expect(engine.snapshot().units.experts).toMatchObject({ status: "blocked", reason: expect.stringContaining("versioned protocol") });
    expect(engine.snapshot().units.independent?.status).toBe("accepted");
    expect(store.inspectMission(mission.id).definitionBytes).toEqual(Buffer.from(JSON.stringify(definition)));
  } finally { await engine.close(); store.close(); }
});
