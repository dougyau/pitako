import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openMissionStore } from "../extensions/mission/store.ts";
import { MissionEngine } from "../extensions/mission/engine.ts";
import { readSealedWorkspaceImage } from "../extensions/mission/reconcile.ts";

const [dbPath, objectDir, missionId] = process.argv.slice(2);
const store = await openMissionStore({ dbPath, objectDir });
try {
  const paused = store.inspectMission(missionId);
  const version = paused.version;
  assert.equal(paused.state, "paused");
  const pause = paused.events.find((event) => event.kind === "mission.paused");
  assert.ok(pause);
  const settled = paused.events.filter((event) => event.kind === "attempt.settled" && event.payload.status === "interrupted");
  assert.equal(settled.length, 1);
  const interruption = settled[0].payload.interruption;
  assert.equal(interruption.kind, "host-pause");
  assert.equal(interruption.pauseEventId, pause.eventId);
  const proofBytes = store.readArtifact(interruption.proofHash);
  assert.equal(createHash("sha256").update(proofBytes).digest("hex"), interruption.proofHash);
  const proof = JSON.parse(proofBytes.toString("utf8"));
  assert.equal(proof.format, "mission-pause-interruption-v1");
  assert.equal(proof.pauseEventId, pause.eventId);
  assert.equal(proof.attemptId, settled[0].attemptId);
  assert.equal(proof.sdkDisposed, true);
  assert.equal(proof.effectsQuiescent, true);
  assert.equal(proof.processesQuiescent, true);
  assert.ok(pause.payload.stoppedAttempts.some((row) => row.attemptId === proof.attemptId && row.bindingHash === proof.bindingHash));
  const receipt = paused.events.find((event) => event.kind === "attempt.receipt" && event.attemptId === proof.attemptId);
  assert.equal(receipt.payload.status, proof.receiptStatus);
  assert.equal(createHash("sha256").update(store.readArtifact(proof.observedImageHash)).digest("hex"), proof.observedImageHash);
  assert.equal(createHash("sha256").update(store.readArtifact(proof.baseImageHash)).digest("hex"), proof.baseImageHash);
  if (proof.candidate === "managed") {
    const start = paused.events.find((event) => event.eventId === proof.executionStartEventId);
    const registration = paused.events.find((event) => event.kind === "workspace.candidate.registered" && event.attemptId === proof.attemptId);
    const sourceBase = paused.events.find((event) => event.kind === "workspace.snapshot.sealed" && event.attemptId === proof.attemptId && event.payload.phase === "base");
    const binding = paused.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === proof.attemptId).payload.binding;
    const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    assert.equal(start.kind, "workspace.snapshot.sealed");
    assert.equal(start.payload.purpose, "execution-start");
    assert.equal(start.attemptId, binding.attemptId);
    assert.equal(start.revision, binding.revision);
    assert.equal(start.payload.ownerEpoch, binding.ownerEpoch);
    assert.equal(start.payload.bindingHash, hash(binding));
    assert.equal(proof.executionStartPayloadHash, hash(start.payload));
    assert.equal(start.payload.candidateRegistrationCausalId, registration.causalId);
    assert.equal(start.payload.candidateRegistrationHash, hash(registration.payload));
    assert.equal(start.payload.sourceBaseCausalId, sourceBase.causalId);
    assert.equal(start.payload.sourceBaseImageHash, sourceBase.payload.imageHash);
    assert.equal(start.payload.checkpointHash, binding.checkpointHash);
    assert.equal(start.payload.recoveryImageHash, null);
    assert.equal(start.payload.imageHash, proof.baseImageHash);
    assert.equal(proof.baseImageHash, JSON.parse(store.readArtifact(binding.checkpointHash)).imageHash);
    const base = readSealedWorkspaceImage(store, proof.baseImageHash);
    const observed = readSealedWorkspaceImage(store, proof.observedImageHash);
    const source = readSealedWorkspaceImage(store, sourceBase.payload.imageHash);
    const text = (image, name) => image.files.find((file) => file.path === name)?.bytes?.toString() ?? null;
    assert.equal(start.payload.manifestHash, base.manifest.hash);
    assert.equal(text(base, "src/parent-marker.txt"), "parent\n");
    assert.equal(text(base, "src/target.txt"), "source\n");
    assert.equal(text(observed, "src/parent-marker.txt"), "parent\n");
    assert.equal(text(observed, "src/target.txt"), "continued\n");
    assert.equal(text(source, "src/parent-marker.txt"), null);
    assert.equal(text(source, "src/target.txt"), "source\n");
    assert.equal(source.manifest.hash, binding.workspaceManifestHash);
    assert.notEqual(proof.baseImageHash, sourceBase.payload.imageHash);
    assert.ok(start.seq < paused.events.find((event) => event.kind === "attempt.started" && event.attemptId === binding.attemptId).seq);
    assert.ok(start.seq < paused.events.find((event) => event.kind === "effect.intent" && event.attemptId === binding.attemptId).seq);
  } else {
    assert.equal(proof.executionStartEventId, undefined);
    assert.equal(proof.executionStartPayloadHash, undefined);
    assert.equal(proof.baseImageHash, proof.observedImageHash);
  }
  assert.equal(paused.events.some((event) => event.kind === "unit.blocked" || event.kind === "unit.accepted"), false);
  assert.equal(paused.events.some((event) => event.kind === "mission.resumed"), false);
  const protectedIds = new Set(paused.events.filter((event) => event.kind === "reservation.created" && event.payload.purpose === "protected")
    .map((event) => event.payload.reservationId));
  assert.equal(paused.events.some((event) => event.seq > pause.seq && (
    event.kind === "attempt.reserved" || event.kind === "provider.request.dispatched" || event.kind === "effect.intent" ||
    event.kind === "budget.reservation.adjusted" && protectedIds.has(event.payload.reservationId))), false);
  const engine = new MissionEngine({
    store, missionId, sessionsDirectory: `${dbPath}-pause-sessions`,
    runRole: async () => { throw new Error("paused journal must not dispatch"); },
  });
  assert.equal(engine.snapshot().state, "paused");
  assert.equal(store.inspectMission(missionId).version, version);
  assert.equal(store.inspectMission(missionId).events.some((event) => event.kind === "mission.resumed"), false);
  await engine.close();
  assert.equal(store.inspectMission(missionId).version, version);
} finally {
  store.close();
}
