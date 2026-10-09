import { parentPort } from "node:worker_threads";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureWorkspacePaths, captureWorkspaceImage, assertPreparedCandidate, verifyPrivateCandidate, filterWorkspaceImage, discoverPrivateCandidate, type WorkspaceManifest } from "./workspace.ts";
import { assertCompleteWorkspaceImage, canonicalDeliveryManifest, sealWorkspaceImage, readSealedWorkspaceImage, readAcceptedWorkspaceContribution, readContributionInput, validateRecoveryImages, candidateIdentityMatches, observeEffectCandidatePaths, missionHasUnresolvedEffects } from "./reconcile.ts";
import { hydrateWorkspaceImage } from "./physical-observation.ts";
import type { MissionAttemptBinding, SingletonCheckpointProof } from "./engine.ts";
import { missionNeedsRecovery } from "./engine.ts";
import { openMissionStore } from "./store.ts";
import { MissionSetup, assertSetupInputs, captureSetupOutputs, captureSetupIdentity } from "./setup.ts";
import { createHash } from "node:crypto";
import { copyPublication, copyStorageBytes } from "./setup-copy.ts";
import { assessMissionCompletion, physicalResultBinding } from "./completion.ts";
import { finalizationInputIdentity, finalizationHash, observeSourceMutation, sourceWitnessCurrent } from "./finalization.ts";
import { missionInputIdentity } from "./inputs.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./model.ts";
import { missionHasUnresolvedEffectBindings, readHistoricalPauseInterruption, pauseInterruption, lifecycleInterruption } from "./reconcile.ts";

type Request = { id: string } & (
  | { operation: "setupReadiness"; input: { dbPath: string; objectDir: string; missionId: string } }
  | { operation: "setupInputs" | "setupOutputs"; input: Parameters<typeof assertSetupInputs>[0] }
  | { operation: "copyPublication"; input: Parameters<typeof copyPublication>[0] }
  | { operation: "copyStorage"; input: Parameters<typeof copyStorageBytes>[0] }
  | { operation: "candidatePrepared"; input: Parameters<typeof assertPreparedCandidate>[0] }
  | { operation: "completion"; input: { dbPath: string; objectDir: string; missionId: string; binding: string } }
  | { operation: "finalization"; input: { dbPath: string; objectDir: string; missionId: string; root: string; witnessHash?: string } }
  | { operation: "admissionSource"; input: { dbPath: string; objectDir: string; missionId: string; root: string; continuations?: string[] } }
  | { operation: "sealedImage"; input: { dbPath: string; objectDir: string; hash: string; complete?: boolean } }
  | { operation: "checkpointProof"; input: { dbPath: string; objectDir: string; hash: string } }
  | { operation: "unresolvedEffects" | "effectBindingsValid"; input: { dbPath: string; objectDir: string; missionId: string; attemptId?: string; effectId?: string } }
  | { operation: "recoveryNeeded"; input: { dbPath: string; objectDir: string; missionId: string; root: string; planFile: string } }
  | { operation: "pauseInterruption" | "lifecycleInterruption" | "historicalInterruption" | "historicalContribution"; input: { dbPath: string; objectDir: string; missionId: string; attemptId: string; root: string; pauseEventId?: string } }
  | { operation: "contributionInput"; input: { dbPath: string; objectDir: string; missionId: string; binding: MissionAttemptBinding } }
  | { operation: "inputIdentity"; input: { dbPath: string; objectDir: string; missionId: string; root: string } }
  | { operation: "sealImage"; input: { image: Parameters<typeof sealWorkspaceImage>[0] } }
  | { operation: "acceptedContribution"; input: { dbPath: string; objectDir: string; missionId: string; unitId: string } }
  | { operation: "candidateIdentity"; input: { root: string; sourceRoot: string } }
  | { operation: "candidateDiscovery"; input: { registration: Parameters<typeof discoverPrivateCandidate>[0]; sourceRoot: string } }
  | { operation: "candidateMatches"; input: { root: string; sourceRoot: string; payload: Record<string, unknown> } }
  | { operation: "effectCandidatePaths"; input: Parameters<typeof observeEffectCandidatePaths>[0] }
  | { operation: "seal"; input: { root: string; manifest?: WorkspaceManifest; allowedPaths?: string[]; complete?: boolean } }
  | { operation: "setupIdentity"; input: { binding: Parameters<typeof captureSetupIdentity>[0]; values: Parameters<typeof captureSetupIdentity>[1] } }
  | { operation: "setupIdentityMatches"; input: { binding: Parameters<typeof captureSetupIdentity>[0]; values: Parameters<typeof captureSetupIdentity>[1]; hash: string } }
  | { operation: "probe" }
  | { operation: "paths" | "image"; input: { root: string; complete?: boolean } }
  | { operation: "predicatePaths"; input: { root: string } }
  | { operation: "pathsMatch"; input: { root: string; hash: string } }
);

/** Fixed read-only bridge; not a mission extension and never opens a writer store. */
export default function physicalObserver(_pi: ExtensionAPI): void {
  if (!parentPort) throw new Error("physical observer requires a worker");
  parentPort.on("message", async (request: Request) => {
    try {
      const value = request.operation === "setupReadiness" ? await setupReadiness(request.input) :
        request.operation === "pauseInterruption" || request.operation === "lifecycleInterruption" || request.operation === "historicalInterruption" || request.operation === "historicalContribution" ? await interruptionObservation(request) :
        request.operation === "recoveryNeeded" || request.operation === "effectBindingsValid" || request.operation === "unresolvedEffects" || request.operation === "checkpointProof" || request.operation === "sealedImage" || request.operation === "acceptedContribution" || request.operation === "contributionInput" || request.operation === "inputIdentity" ? await artifactObservation(request) :
        request.operation === "sealImage" ? sealWorkspaceImage(hydrateWorkspaceImage(request.input.image)) :
        request.operation === "candidateIdentity" ? verifyPrivateCandidate(request.input.root, request.input.sourceRoot) :
        request.operation === "candidateDiscovery" ? discoverPrivateCandidate(request.input.registration, request.input.sourceRoot) :
        request.operation === "candidateMatches" ? candidateIdentityMatches(request.input.root, request.input.payload, request.input.sourceRoot) :
        request.operation === "effectCandidatePaths" ? observeEffectCandidatePaths(request.input) :
        request.operation === "seal" ? sealObservation(request.input) :
        request.operation === "completion" || request.operation === "finalization" || request.operation === "admissionSource" ? await missionObservation(request) :
        request.operation === "setupInputs" ? (assertSetupInputs(request.input), true) :
        request.operation === "setupOutputs" ? captureSetupOutputs(request.input) :
        request.operation === "copyPublication" ? copyPublication(request.input) :
        request.operation === "copyStorage" ? copyStorageBytes(request.input) :
        request.operation === "candidatePrepared" ? (assertPreparedCandidate(request.input), true) :
         request.operation === "setupIdentity" ? captureSetupIdentity(request.input.binding, request.input.values) :
         request.operation === "setupIdentityMatches" ? createHash("sha256").update(JSON.stringify(captureSetupIdentity(request.input.binding, request.input.values))).digest("hex") === request.input.hash :
        request.operation === "probe" ? { bridge: "physical-observer-v1" } :
        request.operation === "paths" ? captureWorkspacePaths(request.input.root, true) :
        request.operation === "predicatePaths" ? { paths: captureWorkspacePaths(request.input.root), indexEntries: captureWorkspaceImage(request.input.root).manifest.indexEntries } :
        request.operation === "pathsMatch" ? createHash("sha256").update(JSON.stringify(captureWorkspacePaths(request.input.root, true))).digest("hex") === request.input.hash :
        request.operation === "image" ? imageObservation(request.input) :
        (() => { throw new Error("unknown physical observation"); })();
      parentPort!.postMessage({ kind: "result", id: request.id, value });
    } catch (error) {
      parentPort!.postMessage({ kind: "error", id: request.id, error: String(error) });
    }
  });
}

function imageObservation(input: { root: string; complete?: boolean }) {
  const image = captureWorkspaceImage(input.root);
  if (input.complete) assertCompleteWorkspaceImage(image, captureWorkspacePaths(input.root, true));
  return image;
}

function sealObservation(input: Extract<Request, { operation: "seal" }>["input"]) {
  const captured = captureWorkspaceImage(input.root);
  const image = input.allowedPaths ? filterWorkspaceImage(captured, input.allowedPaths) :
    input.manifest ? { ...captured, manifest: canonicalDeliveryManifest(captured.manifest, input.manifest) } : captured;
  if (input.complete) assertCompleteWorkspaceImage(image, captureWorkspacePaths(input.root, true));
  const sealed = sealWorkspaceImage(image);
  if (captureWorkspaceImage(input.root).manifest.hash !== captured.manifest.hash)
    throw new Error("candidate changed while sealing image");
  return { image, sealed };
}

async function artifactObservation(request: Extract<Request, { operation: "recoveryNeeded" | "unresolvedEffects" | "effectBindingsValid" | "checkpointProof" | "sealedImage" | "acceptedContribution" | "contributionInput" | "inputIdentity" }>) {
  const store = await openMissionStore({ ...request.input, readOnly: true });
  try {
    if (request.operation === "recoveryNeeded")
      return await missionNeedsRecovery(store, store.inspectMission(request.input.missionId), request.input.root,
        request.input.planFile, async () => captureWorkspaceImage(request.input.root));
    if (request.operation === "unresolvedEffects")
      return missionHasUnresolvedEffects(store, store.inspectMission(request.input.missionId).events
        .filter(event => !request.input.effectId || event.effectId === request.input.effectId), request.input.attemptId);
    if (request.operation === "effectBindingsValid") {
      const events = store.inspectMission(request.input.missionId).events;
      const ids = new Set(events.filter(event => event.effectId &&
        (!request.input.attemptId || event.attemptId === request.input.attemptId)).map(event => event.effectId!));
      return [...ids].every(id => {
        const rows = events.filter(event => event.effectId === id);
        return missionHasUnresolvedEffects(store, rows) === missionHasUnresolvedEffectBindings(store, rows);
      });
    }
    if (request.operation === "checkpointProof") {
      const bytes = store.readArtifact(request.input.hash);
      if (sha256(bytes) !== request.input.hash) throw new Error("checkpoint artifact hash changed");
      const proof = JSON.parse(bytes.toString("utf8")) as SingletonCheckpointProof;
      if (sha256(store.readArtifact(proof.requestHash)) !== proof.requestHash) throw new Error("checkpoint request artifact hash changed");
      return proof;
    }
    if (request.operation === "sealedImage") {
      const image = readSealedWorkspaceImage(store, request.input.hash);
      if (request.input.complete) assertCompleteWorkspaceImage(image);
      return image;
    }
    if (request.operation === "inputIdentity") return missionInputIdentity(store.inspectMission(request.input.missionId), request.input.root);
    if (request.operation === "contributionInput") return readContributionInput(store, store.inspectMission(request.input.missionId), request.input.binding);
    if (request.operation === "acceptedContribution")
      return readAcceptedWorkspaceContribution(store, store.inspectMission(request.input.missionId), request.input.unitId);
    throw new Error("unknown artifact observation");
  } finally { store.close(); }
}

async function interruptionObservation(request: Extract<Request, { operation: "pauseInterruption" | "lifecycleInterruption" | "historicalInterruption" | "historicalContribution" }>) {
  const store = await openMissionStore({ ...request.input, readOnly: true });
  try {
    const inspection = store.inspectMission(request.input.missionId);
    if (request.operation === "historicalContribution") {
      const source = lifecycleInterruption(store, inspection, request.input.attemptId);
      return readContributionInput(store, { ...inspection, revision: source.binding.revision, definition: source.definition }, source.binding);
    }
    return request.operation === "pauseInterruption"
      ? pauseInterruption(store, inspection, request.input.attemptId, request.input.root, request.input.pauseEventId)
      : request.operation === "lifecycleInterruption"
        ? lifecycleInterruption(store, inspection, request.input.attemptId)
        : readHistoricalPauseInterruption(store, inspection, request.input.attemptId, request.input.pauseEventId);
  } finally { store.close(); }
}

async function missionObservation(request: Extract<Request, { operation: "completion" | "finalization" | "admissionSource" }>) {
  const { input } = request;
  const store = await openMissionStore({ dbPath: input.dbPath, objectDir: input.objectDir, readOnly: true });
  try {
    const inspection = store.inspectMission(input.missionId);
    if (request.operation === "completion") {
      if (physicalResultBinding(inspection) !== request.input.binding)
        throw new Error("mission completion observation became stale");
      return assessMissionCompletion(inspection, store);
    }
    if (request.operation === "admissionSource") {
      const root = request.input.root;
      for (const id of request.input.continuations ?? []) validateRecoveryImages(store, inspection, id);
      return { manifestHash: captureWorkspaceImage(root).manifest.hash,
        inputIdentityHash: inspection.prepared ? sha256(Buffer.from(JSON.stringify(missionInputIdentity(inspection, root)))) : undefined,
        planHash: inspection.prepared ? undefined : sha256(readFileSync(path.join(root, ".pitako", "plans", `${inspection.planId}.md`))) };
    }
    const { root, witnessHash } = request.input;
    const source = captureWorkspaceImage(root);
    const witness = observeSourceMutation(root, source.manifest, inspection.prepared ? undefined : inspection.planId, inspection.snapshot.sourceBinding);
    return { identity: finalizationInputIdentity(inspection, source.manifest, root, store),
      witness, witnessHash: finalizationHash(witness),
      witnessCurrent: !witnessHash || sourceWitnessCurrent(store, witnessHash, root) };
  } finally { store.close(); }
}

async function setupReadiness(input: { dbPath: string; objectDir: string; missionId: string }) {
  const store = await openMissionStore({ dbPath: input.dbPath, objectDir: input.objectDir, readOnly: true });
  try { return new MissionSetup(store, input.missionId).observePhysical(); }
  finally { store.close(); }
}
