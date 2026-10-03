import assert from "node:assert/strict";
import { openMissionStore } from "../extensions/mission/store.ts";
import { reconcileMission, missionHasUnresolvedEffects } from "../extensions/mission/reconcile.ts";
import { MissionEngine } from "../extensions/mission/engine.ts";

const [dbPath, objectDir, missionId, root, mode = "observe"] = process.argv.slice(2);
const store = await openMissionStore({ dbPath, objectDir });
try {
  assert.ok(mode === "run" ? ["retirement", "owner-death"].includes(store.ownerAcquisitionProof?.source) :
    store.ownerAcquisitionProof?.source === "owner-death");
  const initial = store.inspectMission(missionId);
  const receipt = initial.events.find((event) => event.kind === "attempt.receipt");
  assert.ok(receipt);
  const before = missionHasUnresolvedEffects(store, initial.events, receipt.attemptId);
  let report;
  if (mode === "observe") {
    report = await reconcileMission({ store, missionId, sourceRoot: root,
      planFile: `${root}/.pitako/plans/durable-fixture.md`, trigger: "engine-restart" });
  } else if (mode !== "inspect") {
    const append = store.appendTransition.bind(store);
    store.appendTransition = (id, version, transition) => {
      const committed = append(id, version, transition);
      if (transition.events.some(({ kind }) => mode === "admit-cut" && kind === "team.consultation.admitted" ||
        mode === "use-cut" && kind === "team.consultation.revalidated" ||
        mode === "before-use-cut" && kind === "mission.recovery.recorded")) process.kill(process.pid, "SIGKILL");
      return committed;
    };
    const engine = new MissionEngine({ store, missionId, sessionsDirectory: `${dbPath}-node-sessions`,
      managedWorkspace: { sourceRoot: root }, runRole: async ({ binding }) => {
        if (mode === "independent" && binding.unitId === "audit") return {
          instanceId: binding.attemptId, role: "reviewer", status: "completed",
          model: { selectedModel: "fixture/local" }, result: "independent audit",
        };
        throw new Error("Node runner must not relaunch original SDK source");
      }, assessPredicate: ({ unit, resultArtifact }) => ({
        verdict: unit.id === "audit" && resultArtifact.toString() === "independent audit" ? "pass" : "fail",
        method: "independent host control",
      }) });
    const pause = initial.events.filter(({ kind }) => kind === "mission.paused").at(-1);
    if (mode === "run" && pause?.payload.controlOrigin === "lifecycle") {
      await engine.control("resume"); await engine.waitForIdle();
    } else if (engine.snapshot().state !== "paused") { engine.start(); await engine.waitForIdle(); }
  }
  const final = store.inspectMission(missionId);
  console.log(JSON.stringify({ before, after: missionHasUnresolvedEffects(store, final.events, receipt.attemptId),
    ownerEpoch: store.ownerEpoch, proof: store.ownerAcquisitionProof, report: report && { status: report.status, effects: report.effects },
    rows: final.events.filter((event) => ["effect.reconciled", "effect.observation.recorded", "team.consultation.revalidated", "team.consultation.admitted", "team.consultation.denied", "attempt.settled", "workspace.snapshot.sealed", "unit.blocked"].includes(event.kind))
      .map((event) => ({ kind: event.kind, attemptId: event.attemptId, payload: event.payload })) }));
} finally { store.close(); }
