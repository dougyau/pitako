import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "../tests/mission-fixtures.ts";
import { MissionEngine } from "../extensions/mission/engine.ts";

const script = fileURLToPath(import.meta.url);
function response(prompt) {
  const bundle = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
  const detail = { proposal: "Inspect artifacts", constraints: "No implementation authority" };
  if (bundle.round === "synthesis") return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase,
    round: bundle.round, memberId: bundle.memberId, classifications: bundle.priorFindings.map(({ id, evidenceRefs }) => ({
      findingId: id, evidenceRefs, category: "uncertainty", reason: "Requires independent host verification",
    })) });
  const peer = bundle.priorFindings?.find(({ id }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
  return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
    findings: [{ id: "claim", claim: "Check evidence", evidenceRefs: [`object:${bundle.memberId}`], detail,
      ...(peer ? { respondsTo: { id: peer.id, evidenceRefs: peer.evidenceRefs } } : {}) }] });
}

if (process.argv[2] === "--child") {
  const [root, stateDir, missionId, barrier] = process.argv.slice(3);
  const trace = [];
  const store = await openFixtureStore({ dbPath: path.join(stateDir, "pitako", "missions.db"), objectDir: path.join(stateDir, "pitako", "missions", "objects") });
  const original = store.appendTransition.bind(store);
  let paused = false;
  store.appendTransition = (id, version, transition) => {
    const result = original(id, version, transition);
    if (!paused && transition.events.some((event) => event.kind === "team.barrier.recorded" && event.payload.round === barrier)) {
      paused = true;
      const inspection = store.inspectMission(id);
      original(id, inspection.version, { events: [{ revision: inspection.revision, kind: "mission.paused", causalId: randomUUID(), payload: { reason: `Node restart after ${barrier}` } }] });
    }
    return result;
  };
  const engine = new MissionEngine({ store, missionId, sessionsDirectory: path.join(stateDir, "sessions"),
    runRole: async ({ binding, brief }) => {
      trace.push({ round: binding.roundId, attemptId: binding.attemptId });
      return { instanceId: binding.attemptId, role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: response(brief) };
    }, assessPredicate: () => ({ verdict: "pass", method: "fixture host assessment" }) });
  const state = engine.snapshot();
  if (state.state === "paused") await engine.control("resume");
  else engine.start();
  await engine.waitForIdle();
  const inspection = store.inspectMission(missionId);
  const observed = {
    state: engine.snapshot().state,
    barriers: inspection.events.filter(({ kind }) => kind === "team.barrier.recorded").map(({ payload }) => ({
      round: payload.round, status: payload.status, members: payload.members,
    })),
    rounds: inspection.events.filter(({ kind }) => kind === "team.barrier.recorded").map(({ payload }) => payload.round),
    slots: inspection.events.filter(({ kind }) => kind === "attempt.reserved").map(({ payload }) => `${payload.roundId}:${payload.memberId}`),
    bundles: inspection.events.filter(({ kind }) => kind === "attempt.reserved").map(({ payload }) => {
      const binding = payload.binding;
      const bundle = JSON.parse(store.readArtifact(binding.teamBundleHash).toString());
      return { round: bundle.round, memberId: bundle.memberId, bundleHash: binding.teamBundleHash,
        peerFindings: bundle.priorFindings?.map(({ id, evidenceRefs }) => ({ id, evidenceRefs })) ?? null };
    }),
    memberReceipts: inspection.events.filter(({ kind }) => kind === "team.member.recorded").map(({ payload }) => ({
      round: payload.round, memberId: payload.memberId, status: payload.status, responseHash: payload.responseHash,
      receiptHash: payload.receiptHash,
    })),
    trace,
    accepted: inspection.events.some(({ kind }) => kind === "unit.accepted"),
  };
  await engine.retireForShutdown("quit");
  console.log(JSON.stringify(observed));
} else test("production Node process resumes at each team barrier without relaunch", async () => {
  const sample = createMissionFixture("pitako-team-node-");
  try {
    const definition = missionDefinition();
    definition.goal = "Node barrier fixture";
    definition.units = [{ id: "experts", kind: "team", role: "developer", dependencies: [], inputs: ["question"], outputs: ["advice"],
      acceptance: [{ id: "team-reviewed", kind: "manual", target: "host" }], risk: "low", retryLimit: 0,
      team: { version: 1, phase: "planning", synthesisRole: "developer", members: ["alpha", "beta", "gamma"].map((id) => ({ id, role: "developer", perspective: id })) } }];
    definition.finalization.requiredPredicates = ["team-reviewed"];
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: "pitako-mission-local", model: "fixture", fallbacks: [] };
    definition.budget = { roleLaunches: 20, providerRequests: 20, tokens: 4000, activeTimeMs: 1200000, artifactBytes: 100000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const { currentProcessIdentity } = await import("../extensions/mission/workspace.ts");
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [{ revision: 1,
      kind: "mission.owner.released", causalId: randomUUID(), payload: { owner: currentProcessIdentity(store.runtimeId, store.ownerEpoch),
        reason: "handoff to Node SDK worker", effectsQuiescent: true, resumablePause: false, interruptedAttempts: [] } }] });
    store.close();
    const traces = [];
    for (const barrier of ["independent", "critique", "rebuttal", "synthesis"]) {
      const child = spawnSync(process.execPath, [script, "--child", sample.root, sample.stateDir, mission.id, barrier], { encoding: "utf8", timeout: 60000 });
      assert.equal(child.status, 0, child.stderr);
      const observed = JSON.parse(child.stdout.trim());
      traces.push(observed);
    }
    assert.deepEqual(traces.map(({ slots }) => slots.length), [3, 6, 9, 10]);
    assert.deepEqual(traces.map(({ trace }) => trace.length), [3, 3, 3, 1]);
    assert.equal(new Set(traces.at(-1).slots).size, 10);
    assert.equal(traces.at(-1).bundles.filter(({ round, peerFindings }) => round === "independent" && peerFindings === null).length, 3);
    assert.equal(traces.at(-1).memberReceipts.length, 10);
    assert.equal(traces.at(-1).accepted, true);
    assert.deepEqual(traces.at(-1).rounds, ["independent", "critique", "rebuttal", "synthesis"]);
    if (process.env.MISSION_TEAM_EVIDENCE_PATH) writeFileSync(process.env.MISSION_TEAM_EVIDENCE_PATH, JSON.stringify(traces, null, 2));
  } finally { rmSync(sample.base, { recursive: true, force: true }); }
});
