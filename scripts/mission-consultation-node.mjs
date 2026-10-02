import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "../tests/mission-fixtures.ts";
import { MissionEngine } from "../extensions/mission/engine.ts";
import { cancelManagedAttempt, inspectManagedAttempt, managedAttemptRows } from "../extensions/agent/managed-mission.ts";

const script = fileURLToPath(import.meta.url);
function response(bundle) {
  if (!bundle.targetId && bundle.round === "independent" && bundle.memberId === "alpha" && !bundle.childResultHash)
    return JSON.stringify({ format: "mission-consultation-request-v1", question: "Examine evidence", evidenceRefs: ["evidence:a"],
      members: ["one", "two", "three"].map((id) => ({ id, role: "developer", perspective: id })), synthesisRole: "developer" });
  if (bundle.round === "synthesis") return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round,
    memberId: bundle.memberId, classifications: bundle.priorFindings.map(({ id, evidenceRefs }) => ({
      findingId: id, evidenceRefs, category: "uncertainty", reason: "Host verification required",
    })) });
  const peer = bundle.priorFindings?.find(({ id }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
  return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round,
    memberId: bundle.memberId, findings: [{ id: "f", claim: "Inspect", evidenceRefs: ["evidence:a"],
      detail: { criterion: "Correctness", observation: "Inspect" },
      ...(peer ? { respondsTo: { id: peer.id, evidenceRefs: peer.evidenceRefs } } : {}) }] });
}
if (process.argv[2] === "--child") {
  const [stateDir, missionId, stage] = process.argv.slice(3);
  const store = await openFixtureStore({ dbPath: path.join(stateDir, "pitako", "missions.db"),
    objectDir: path.join(stateDir, "pitako", "missions", "objects") });
  const original = store.appendTransition.bind(store);
  let paused = false;
  store.appendTransition = (id, version, transition) => {
    const result = original(id, version, transition);
    if (!paused && transition.events.some((event) => stage === "receipt" ? event.kind === "attempt.receipt" &&
      event.payload.status === "completed" && store.readArtifact(event.payload.artifactHash).toString().includes("mission-consultation-request-v1") :
      stage === "admission" ? event.kind === "team.consultation.admitted" :
      stage === "barrier" ? event.kind === "team.barrier.recorded" && event.payload.targetId !== "experts" && event.payload.round === "independent" :
      event.kind === "team.consultation.resolved")) {
      paused = true;
      const current = store.inspectMission(id);
      original(id, current.version, { events: [{ revision: current.revision, kind: "mission.paused", causalId: randomUUID(),
        payload: { reason: `Node restart after consultation ${stage}` } }] });
    }
    return result;
  };
  const trace = [];
  let fallbackDenied = null;
  const engine = new MissionEngine({ store, missionId, sessionsDirectory: path.join(stateDir, "sessions"),
    runRole: async ({ binding, unit, brief }, durable) => {
      trace.push(binding.attemptId);
      const bundle = binding.teamBundleHash ? JSON.parse(brief.slice(brief.indexOf("\n") + 1)) : undefined;
      if (!bundle?.targetId && bundle?.round === "independent" && bundle?.memberId === "alpha" && !bundle?.childResultHash)
        while (store.inspectMission(missionId).events.filter((event) => event.kind === "attempt.receipt" &&
          event.payload.unitId === "experts").length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
      const requestId = randomUUID();
      const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
      await durable.onProviderReceipt({ requestId, provider: "fixture", model: "local", inputTokens: 1, outputTokens: 1, ticket });
      if (bundle?.targetId && bundle.round === "independent" && bundle.memberId === "one") {
        try { await durable.onProviderDispatch({ requestId: randomUUID(), provider: "fixture", model: "fallback" });
          fallbackDenied = false; // An unreceipted fallback retains its full token grant as unknown.
        } catch { fallbackDenied = true; }
      }
      return { instanceId: binding.attemptId, role: unit.role, status: "completed", model: { selectedModel: "fixture/local" },
        result: bundle ? response(bundle) : "PASS" };
    }, assessPredicate: () => ({ verdict: "pass", method: "host observation" }) });
  if (engine.snapshot().state === "paused") await engine.control("resume");
  else engine.start();
  await engine.waitForIdle();
  const events = store.inspectMission(missionId).events;
  const observed = { state: engine.snapshot().state, units: engine.snapshot().units, trace, fallbackDenied,
    attempts: events.filter(({ kind }) => kind === "attempt.reserved").map(({ payload }) => payload.binding),
    providerDispatched: events.filter(({ kind }) => kind === "provider.request.dispatched").length,
    unknownTokens: store.inspectMission(missionId).reservations.filter(({ resource }) => resource === "tokens")
      .reduce((sum, grant) => sum + grant.unknownCharge, 0),
    protectedAmounts: store.inspectMission(missionId).reservations.filter(({ purpose }) => purpose === "protected")
      .map(({ amount }) => amount),
    admitted: events.filter(({ kind }) => kind === "team.consultation.admitted").length,
    resolved: events.filter(({ kind }) => kind === "team.consultation.resolved").length,
    accepted: events.filter(({ kind }) => kind === "unit.accepted").length };
  await engine.retireForShutdown("quit");
  console.log(JSON.stringify(observed));
} else test("Node restarts at receipt, admission, child barrier and resolution do not relaunch slots", async () => {
  for (const budget of [23, 24]) {
    const sample = createMissionFixture("pitako-consultation-node-");
    try {
    const definition = missionDefinition();
    definition.units = [{ id: "experts", kind: "team", role: "developer", dependencies: [], inputs: ["evidence:a"], outputs: ["advice"],
      acceptance: [{ id: "advice", kind: "manual", target: "host" }], risk: "low", retryLimit: 0,
      team: { version: 1, phase: "review", synthesisRole: "developer", members: ["alpha", "beta", "gamma"].map((id) =>
        ({ id, role: "developer", perspective: id })) } }];
    definition.finalization.requiredPredicates = ["advice"];
    definition.budget = { roleLaunches: budget, providerRequests: budget, tokens: budget * 200, activeTimeMs: budget * 60000, artifactBytes: budget * 4000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const { currentProcessIdentity } = await import("../extensions/mission/workspace.ts");
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [{ revision: 1,
      kind: "mission.owner.released", causalId: randomUUID(), payload: { owner: currentProcessIdentity(store.runtimeId, store.ownerEpoch),
        reason: "Node worker handoff", effectsQuiescent: true, resumablePause: false, interruptedAttempts: [] } }] });
    store.close();
    const results = [];
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = sample.stateDir;
    try {
      for (const stage of ["receipt", "admission", "barrier", "resolution", "done"]) {
        const child = spawnSync(process.execPath, [script, "--child", sample.stateDir, mission.id, stage], { encoding: "utf8", timeout: 90000 });
        assert.equal(child.status, 0, child.stderr);
        const observed = JSON.parse(child.stdout.trim());
        results.push(observed);
        const parent = observed.attempts.find(({ targetId, roundId, memberId, continuationOf }) =>
          targetId === "experts" && roundId === "independent" && memberId === "alpha" && !continuationOf);
        assert.ok(parent);
        const inspection = await inspectManagedAttempt(sample.root, parent.attemptId);
        assert.ok(inspection);
        const status = managedAttemptRows(inspection, parent.attemptId)[0];
        const repeated = await inspectManagedAttempt(sample.root, parent.attemptId);
        assert.deepEqual(managedAttemptRows(repeated, parent.attemptId)[0], status);
        assert.equal(repeated.version, inspection.version);
        assert.equal(status.resultAvailable, false);
        assert.equal(status.status, ({ receipt: "receipt-unsettled", admission: "waiting-child",
          barrier: "waiting-child", resolution: "child-complete-awaiting-continuation", done: "continued" })[stage]);
        assert.equal(status.role, "developer");
        if (stage !== "receipt") {
          assert.equal(status.childTargetId, inspection.events.find(({ kind }) => kind === "team.consultation.admitted")?.payload.targetId);
          assert.equal(cancelManagedAttempt(mission.id, parent.attemptId), false);
          assert.equal((await inspectManagedAttempt(sample.root, parent.attemptId)).version, inspection.version);
        }
        const childSynthesis = observed.attempts.find(({ targetId, roundId }) => targetId && targetId !== "experts" && roundId === "synthesis");
        if (childSynthesis) assert.equal(managedAttemptRows(inspection, childSynthesis.attemptId)[0].advisory, true);
      }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
    const final = results.at(-1);
    assert.equal(final.admitted, 1); assert.equal(final.resolved, 1); assert.equal(final.accepted, 1);
    assert.equal(final.attempts.length, 21);
    assert.equal(new Set(final.attempts.map(({ attemptId }) => attemptId)).size, 21);
    assert.equal(final.attempts.filter(({ continuationOf }) => continuationOf).length, 1);
    const slots = new Map();
    for (const attempt of final.attempts) {
      const slot = [attempt.targetId, attempt.roundId, attempt.memberId].join(":");
      slots.set(slot, (slots.get(slot) ?? 0) + 1);
    }
    assert.deepEqual([...slots.values()].sort((a, b) => b - a), [2, ...Array(19).fill(1)]);
    assert.equal(results.map(({ trace }) => trace.length).reduce((sum, count) => sum + count, 0), 21);
    assert.deepEqual(results.map(({ fallbackDenied }) => fallbackDenied), [null, null, budget === 23, null, null]);
    assert.equal(final.providerDispatched, budget === 23 ? 21 : 22);
    assert.equal(final.unknownTokens, budget === 23 ? 0 : 200);
    assert.deepEqual(final.protectedAmounts, [2, 2, 400, 120000, 8000]);
    assert.ok(results.every(({ protectedAmounts }) => JSON.stringify(protectedAmounts) === JSON.stringify(final.protectedAmounts)));
    assert.ok(results.every(({ providerDispatched }, index) => index === 0 || providerDispatched >= results[index - 1].providerDispatched));
    assert.ok(results.every(({ unknownTokens }, index) => index === 0 || unknownTokens >= results[index - 1].unknownTokens));
    } finally { rmSync(sample.base, { recursive: true, force: true }); }
  }
});
