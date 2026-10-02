import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openMissionStore } from "../extensions/mission/store.ts";
import { MissionEngine } from "../extensions/mission/engine.ts";
import { reconcileMission } from "../extensions/mission/reconcile.ts";

const [dbPath, objectDir, missionId, root, mode = "resume"] = process.argv.slice(2);
const store = await openMissionStore({ dbPath, objectDir });
try {
  const paused = store.inspectMission(missionId);
  if (mode !== "unreceipted") assert.equal(paused.state, "paused");
  assert.ok(["retirement", "owner-death"].includes(store.ownerAcquisitionProof.source));
  const predecessor = paused.events.find(({ kind, payload }) => kind === "attempt.settled" && payload.interruption?.kind === "host-pause");
  const original = paused.events.find(({ kind, attemptId }) => kind === "attempt.reserved" && attemptId === predecessor.attemptId).payload.binding;
  const completed = paused.events.filter(({ kind }) => ["team.member.recorded", "team.barrier.recorded", "team.consultation.resolved"].includes(kind));
  const calls = [];
  const engine = new MissionEngine({ store, missionId, sessionsDirectory: `${dbPath}-recovery-sessions`,
    managedWorkspace: { sourceRoot: root },
    runRole: async ({ binding, brief }, durable) => {
      if (mode === "crash") process.kill(process.pid, "SIGKILL");
      calls.push(binding);
      if (binding.candidate === "managed") {
        assert.equal(readFileSync(path.join(durable.cwd, "src/parent-marker.txt"), "utf8"), "parent\n");
        assert.equal(readFileSync(path.join(durable.cwd, "src/target.txt"), "utf8"), "continued\n");
        if (binding.recoveryMode === "repair") {
          assert.equal((await durable.effects.invoke("write", { path: "src/recovered-marker.txt", content: "fresh recovery\n" })).status, "completed");
        }
      }
      const { provider, model } = store.inspectMission(missionId).definition.authority.rolePolicies[binding.role];
      const requestId = randomUUID();
      const ticket = await durable.onProviderDispatch({ requestId, provider, model });
      await durable.onProviderReceipt({ requestId, provider, model, ticket, inputTokens: 17, outputTokens: 8 });
      let result = "continuation result";
      if (binding.teamBundleHash) {
        const bundle = JSON.parse(store.readArtifact(binding.teamBundleHash).toString());
        const peer = bundle.priorFindings?.find(({ id }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
        result = JSON.stringify(bundle.round === "synthesis" ? {
          format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
          classifications: bundle.priorFindings.map(({ id, evidenceRefs }) => ({ findingId: id, evidenceRefs, category: "uncertainty", reason: "Host verification" })),
        } : {
          format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
          findings: [{ id: "f", claim: "Inspect", evidenceRefs: ["evidence:a"], detail: bundle.phase === "review" ?
            { criterion: "Correctness", observation: "Inspect" } : { recommendation: "Check", impact: "Bound" },
            ...(peer ? { respondsTo: { id: peer.id, evidenceRefs: peer.evidenceRefs } } : {}) }],
        });
      }
      return { instanceId: binding.attemptId, role: "developer", status: "completed", model: { selectedModel: `${provider}/${model}` }, result };
    },
    assessPredicate: ({ result }) => {
      const binding = calls.find((row) => row.attemptId === result.instanceId);
      return { verdict: mode === "repair" && binding?.recoveryMode === "verify" ? "fail" : "pass", method: "Node host check" };
    } });
  if (mode !== "unreceipted") {
    assert.throws(() => engine.start(), /paused/);
    assert.equal(calls.length, 0);
    await engine.control("resume");
  } else engine.start();
  await engine.waitForIdle();
  const final = store.inspectMission(missionId);
  const successors = final.events.filter(({ kind, payload }) => kind === "attempt.reserved" && payload.binding.recoveryOf === original.attemptId);
  assert.equal(successors.length, 1);
  const successor = successors[0].payload.binding;
  assert.equal(successor.continuationOf, original.continuationOf);
  assert.equal(successor.correctionNo, original.correctionNo);
  assert.equal(successor.attemptNo, original.attemptNo + 1);
  assert.equal(successor.checkpointHash, original.checkpointHash);
  assert.equal(successor.childResultHash, original.childResultHash);
  assert.equal(successor.teamBundleHash, original.teamBundleHash);
  assert.equal(final.events.filter(({ kind }) => kind === "unit.accepted").length, mode === "unreceipted" ? 0 : 1);
  if (mode === "unreceipted") assert.equal(calls.length, 0);
  else assert.equal(final.events.filter(({ kind }) => kind === "unit.blocked").length, 0);
  assert.equal(final.events.filter(({ kind, payload }) => kind === "team.barrier.recorded" && payload.status === "incomplete").length, 0);
  for (const event of completed) assert.deepEqual(final.events.find(({ eventId }) => eventId === event.eventId), event);
  if (mode === "repair") {
    const repair = calls.find(({ recoveryMode }) => recoveryMode === "repair");
    assert.equal(repair.correctionNo, original.correctionNo + 1);
    assert.equal(readFileSync(path.join(repair.candidateRoot, "src/recovered-marker.txt"), "utf8"), "fresh recovery\n");
  }
  const count = final.events.filter(({ kind }) => kind === "attempt.reserved").length;
  await reconcileMission({ store, missionId, sourceRoot: root, planFile: path.join(root, ".pitako/plans", `${final.planId}.md`),
    orderlyPause: { pauseEventId: predecessor.payload.interruption.pauseEventId } });
  assert.equal(store.inspectMission(missionId).events.filter(({ kind }) => kind === "attempt.reserved").length, count);
  assert.equal(readFileSync(path.join(root, "src/target.txt"), "utf8"), "source\n");
  assert.equal(final.events.some(({ kind }) => kind === "mission.completed"), false);
  console.log(JSON.stringify({ consumer: "production Node engine/store, deterministic runner", acquisition: store.ownerAcquisitionProof.source,
    predecessor: original, successor, calls, events: final.events, resources: final.reservations }));
  await engine.close();
} finally { store.close(); }
