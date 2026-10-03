import assert from "node:assert/strict";
import { openMissionStore } from "../extensions/mission/store.ts";
import { MissionEngine } from "../extensions/mission/engine.ts";

const [dbPath, objectDir, missionId, root, continuationId, paid, effects, launches] = process.argv.slice(2);
const store = await openMissionStore({ dbPath, objectDir });
try {
  const paused = store.inspectMission(missionId);
  assert.equal(paused.state, "paused");
  assert.equal(paused.events.filter(({ kind }) => kind === "unit.accepted" || kind === "unit.blocked").length, 0);
  assert.equal(paused.events.filter(({ kind, attemptId }) => kind === "attempt.settled" && attemptId === continuationId).length, 0);
  const protectedIds = paused.events.filter(({ kind, payload }) => kind === "reservation.created" && payload.purpose === "protected")
    .map(({ payload }) => payload.reservationId);
  const engine = new MissionEngine({ store, missionId, sessionsDirectory: `${dbPath}-pause-sessions`,
    managedWorkspace: { sourceRoot: root }, runRole: async () => { throw new Error("paused continuation must not relaunch a writer"); },
    assessPredicate: ({ resultArtifact }) => ({ verdict: resultArtifact.toString() === "continuation result" ? "pass" : "fail",
      method: "reopened host continuation assessment" }) });
  await engine.control("resume", { id: "operator-resume-node", text: "/mission resume" });
  await engine.waitForIdle();
  const final = store.inspectMission(missionId).events;
  assert.equal(final.filter(({ kind, attemptId }) => kind === "unit.accepted" && attemptId === continuationId).length, 1);
  assert.equal(final.filter(({ kind }) => kind === "unit.blocked").length, 0);
  assert.equal(final.filter(({ kind, attemptId, payload }) => kind === "attempt.settled" && attemptId === continuationId && payload.status === "succeeded").length, 1);
  for (const [kind, expected] of [["provider.request.dispatched", paid], ["effect.intent", effects], ["attempt.reserved", launches]])
    assert.equal(final.filter((event) => event.kind === kind).length, Number(expected), kind);
  assert.equal(final.some(({ kind, payload }) => kind === "budget.reservation.adjusted" && protectedIds.includes(payload.reservationId)), false);
  assert.equal(final.some(({ kind }) => kind === "mission.completed"), false);
} finally { store.close(); }
