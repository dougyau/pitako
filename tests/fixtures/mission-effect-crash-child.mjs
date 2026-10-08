import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { openMissionStore } from "../../extensions/mission/store.ts";
import { captureWorkspaceImage, createMissionWorkspace, currentProcessIdentity, filterWorkspaceImage, preflightContainment, registerCandidateWorkspace } from "../../extensions/mission/workspace.ts";
import { sealWorkspaceImage } from "../../extensions/mission/reconcile.ts";
import { MissionEffects } from "../../extensions/mission/effects.ts";

const {
  T3_SOURCE: sourceRoot, T3_STORE: storeRoot, T3_CANDIDATES: candidateParent,
  T3_DB: dbPath, T3_OBJECTS: objectDir, T3_MISSION: missionId, T3_ATTEMPT: attemptId,
  T3_LOG: eventLog, T3_META: metadataFile,
  T3_CRASH_KIND: crashKind, T3_CRASH_AFTER_KIND: crashAfterKind,
} = process.env;
if (!sourceRoot || !storeRoot || !candidateParent || !dbPath || !objectDir || !missionId || !attemptId || !eventLog || !metadataFile) {
  throw new Error("missing crash-test paths");
}
const durableStore = await openMissionStore({ dbPath, objectDir });
const ownerEpoch = durableStore.ownerEpoch;
if (ownerEpoch === null) throw new Error("crash child failed to claim mission writer");

const workspace = createMissionWorkspace({ missionId, attemptId, sourceRoot, storeRoot, candidateParent,
  allowedPaths: durableStore.inspectMission(missionId).definition.authority.allowedPaths });
await preflightContainment(workspace);
writeFileSync(metadataFile, JSON.stringify({ candidateRoot: workspace.candidateRoot, attemptId }));
if (process.env.T3_REGISTER_ATTEMPT === "true") {
  const inspection = durableStore.inspectMission(missionId);
  const registration = registerCandidateWorkspace(workspace, {
    repositoryId: inspection.repositoryId,
    owner: currentProcessIdentity(durableStore.runtimeId, ownerEpoch),
  });
  const image = filterWorkspaceImage({ ...captureWorkspaceImage(workspace.candidateRoot), manifest: workspace.manifest }, workspace.allowedPaths);
  const sealed = sealWorkspaceImage(image);
  const binding = {
    missionId, revision: inspection.revision, unitId: "snapshot", roundId: "main", memberId: "solo",
    attemptId, attemptNo: 1, ownerEpoch, candidate: "managed", candidateId: workspace.candidateId,
    candidateRoot: workspace.candidateRoot, candidateRegistration: registration,
    workspaceManifestHash: workspace.manifest.hash, inputManifestHash: workspace.manifest.hash,
    briefHash: "a".repeat(64), rolePolicyHash: "b".repeat(64),
  };
  durableStore.appendTransition(missionId, inspection.version, { events: [
    { revision: inspection.revision, kind: "attempt.reserved", causalId: randomUUID(), unitId: "snapshot", attemptId,
      payload: { attemptId, binding, unitId: "snapshot", roundId: "main", memberId: "solo", attemptNo: 1 } },
    { revision: inspection.revision, kind: "workspace.candidate.registered", causalId: randomUUID(), unitId: "snapshot", attemptId,
      payload: { ...registration, locationHistory: [registration.root] } },
    { revision: inspection.revision, kind: "attempt.started", causalId: randomUUID(), unitId: "snapshot", attemptId,
      payload: { attemptId, unitId: "snapshot" } },
    { revision: inspection.revision, kind: "workspace.snapshot.sealed", causalId: randomUUID(), unitId: "snapshot", attemptId,
      payload: { attemptId, phase: "base", imageHash: sealed.imageHash, manifestHash: workspace.manifest.hash,
        manifest: workspace.manifest, candidateRoot: workspace.candidateRoot,
        candidateIdentity: workspace.candidateIdentity, candidateGitIdentity: workspace.candidateGitIdentity,
        candidateArenaRoot: workspace.candidateArenaRoot, candidateArenaIdentity: workspace.candidateArenaIdentity } },
  ], artifacts: sealed.artifacts });
}
const store = {
  runtimeId: durableStore.runtimeId,
  ownerEpoch: durableStore.ownerEpoch,
  inspectMission: durableStore.inspectMission.bind(durableStore),
  appendTransition(id, expected, transition) {
    if (transition.events.some(({ kind }) => kind === crashKind)) process.kill(process.pid, "SIGKILL");
    const inserted = durableStore.appendTransition(id, expected, transition);
    const fd = openSync(eventLog, "a", 0o600);
    try {
      for (const event of inserted) appendFileSync(fd, `${JSON.stringify(event)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (transition.events.some(({ kind }) => kind === crashAfterKind)) process.kill(process.pid, "SIGKILL");
    return inserted;
  },
};
const operation = process.env.T3_OPERATION ?? "bash";
const effects = new MissionEffects({
  store,
  workspace,
  missionId: workspace.missionId,
  revision: 1,
  unitId: "snapshot",
  attemptId: workspace.attemptId,
  runtimeId: durableStore.runtimeId,
  ownerEpoch,
  allowedOperations: [operation],
  commandTime: { admit: async (requestedMs) => requestedMs ?? 120_000, remaining: () => 120_000 },
});
const input = operation === "bash"
  ? { command: process.env.T3_COMMAND ?? "printf started > /tmp/pitako/workspace/src/started; sleep 30; printf finished > /tmp/pitako/workspace/src/finished", timeoutMs: 60_000 }
  : JSON.parse(process.env.T3_EFFECT_INPUT ?? "{}");
await effects.invoke(operation, input);
