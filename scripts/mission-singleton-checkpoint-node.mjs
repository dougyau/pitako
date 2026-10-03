import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openMissionStore } from "../extensions/mission/store.ts";
import { readSealedWorkspaceImage } from "../extensions/mission/reconcile.ts";
import { managedAttemptRows } from "../extensions/agent/managed-mission.ts";
import { MissionEngine } from "../extensions/mission/engine.ts";

const [dbPath, objectDir, missionId, expectedCheckpoint, sourceRoot] = process.argv.slice(2);
const store = await openMissionStore({ dbPath, objectDir, readOnly: !sourceRoot });
try {
  const inspection = store.inspectMission(missionId);
  const receipt = inspection.events.find(({ kind }) => kind === "attempt.receipt");
  assert.ok(receipt);
  const seal = inspection.events.find(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.purpose === "consultation");
  assert.equal(seal?.payload.checkpointHash ?? "none", expectedCheckpoint);
  const denied = inspection.events.find(({ kind }) => kind === "team.consultation.denied");
  if (denied || !sourceRoot) assert.equal(denied?.payload.requestHash, receipt.payload.artifactHash);
  if (seal) {
    const bytes = store.readArtifact(seal.payload.checkpointHash);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), seal.payload.checkpointHash);
    const proof = JSON.parse(bytes.toString());
    assert.equal(proof.receiptEventId, receipt.eventId);
    assert.equal(proof.sourceAttemptId, receipt.attemptId);
    assert.equal(proof.imageHash, seal.payload.imageHash);
    assert.ok(readSealedWorkspaceImage(store, seal.payload.imageHash).files.length);
  }
  assert.equal(managedAttemptRows(inspection, receipt.attemptId)[0].resultAvailable, false);
  assert.equal(inspection.events.some(({ kind }) => kind === "unit.accepted" || kind === "team.consultation.admitted" || kind === "mission.completed"), false);
  store.replayMission(missionId);
  if (sourceRoot) {
    const engine = new MissionEngine({ store, missionId, sessionsDirectory: `${dbPath}-node-sessions`,
      managedWorkspace: { sourceRoot }, runRole: async () => { throw new Error("denied source must not dispatch after owner restart"); } });
    await engine.control("resume"); await engine.waitForIdle();
    const after = store.inspectMission(missionId);
    assert.equal(after.events.find(({ kind }) => kind === "team.consultation.denied")?.payload.requestHash, receipt.payload.artifactHash);
    assert.equal(after.events.some(({ kind }) => kind === "unit.accepted" || kind === "team.consultation.admitted"), false);
    assert.equal(after.events.filter(({ kind }) => kind === "attempt.reserved").length, 1);
    assert.equal(after.events.find(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.purpose === "consultation")?.payload.checkpointHash ?? "none",
      expectedCheckpoint);
    await engine.retireForShutdown("quit");
  }
  console.log(JSON.stringify({ receipt: receipt.eventId, checkpoint: seal?.payload.checkpointHash ?? null, denied: denied?.payload.reason ?? null }));
} finally { store.close(); }
