import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPlanId, parsePlanDocument } from "../workflow.ts";
import { isUuid, sha256, type MissionDefinition } from "./model.ts";
import { auditCompletionEvidence, classifyNoEffect } from "./completion-evidence.ts";
import type { LegacyImportArchive, MissionEventDraft, MissionStore } from "./store.ts";
import type { MissionEvent } from "./model.ts";
import type { MissionAttemptBinding } from "./engine.ts";
import { missionInputIdentity } from "./inputs.ts";
import { MissionSetup } from "./setup.ts";
import {
  captureWorkspaceImage,
  captureWorkspacePaths,
  filterWorkspaceImage,
  applyWorkspaceImageToRoot,
  createMissionWorkspace,
  ownerProcessState,
  preflightContainment,
  processBirthTicks,
  processNamespaceId,
  processesInNamespace,
  restoreWorkspaceImage,
  verifyPrivateCandidate,
  quarantineCandidateRoot,
  discoverPrivateCandidate,
  type CandidateRegistration,
  type ManifestPath,
  type ProcessIdentity,
  type WorkspaceImage,
  type WorkspaceImageFile,
  type WorkspaceManifest,
  type MissionWorkspace,
} from "./workspace.ts";

export type EffectDisposition = "unstarted" | "applied" | "not-applied" | "partial" | "unknown";

export interface RecoveryFileConflict {
  path: string;
  base: WorkspaceImageFile;
  mission: WorkspaceImageFile;
  current: WorkspaceImageFile;
}

export interface ConditionalMissionPatch {
  format: "mission-conditional-patch-v1";
  deliveryBaseManifestHash: string;
  acceptedManifestHash: string;
  changes: Array<{ path: string; before: WorkspaceImageFile; after: WorkspaceImageFile }>;
}

export interface RecoveryReport {
  format: "mission-recovery-report-v2";
  missionId: string;
  episodeId: string;
  revision: number;
  disposition: {
    version: 2;
    revision: number;
    ownerEpoch: number;
    observedSeq: number;
    causes: Array<{ id: string; sourceEventId: string; proofHash: string; scope: "mission" | "unit"; unitId?: string }>;
  };
  status: "resumed" | "blocked";
  owner: { source: string; epoch: number | null; previousEpoch: number | null };
  plan: { status: "unchanged" | "changed" | "missing" | "malformed" | "unavailable"; storedHash: string; observedHash: string | null;
    inputIdentityHash?: string; inputIdentity?: ReturnType<typeof missionInputIdentity> };
  source: {
    root: string;
    manifest: WorkspaceManifest | null;
    headChanged: boolean;
    indexChanged: boolean;
    branchChanged: boolean;
    changedPaths: string[];
  };
  effects: Array<{ effectId: string; attemptId: string | null; operation: string; disposition: EffectDisposition; reason: string; probe?: unknown }>;
  candidate: { root: string | null; imageHash: string | null; manifestHash: string | null; restored: boolean };
  delivery: { baseManifestHash: string | null; acceptedManifestHash: string | null; patchHash: string | null };
  evidence: { retained: string[]; invalidated: string[] };
  holds: Array<{ holdId: string; unitId?: string; disposition: "unresolved" | "reconciled_without_outcome" | "unknown" }>;
  legacyConflicts: Array<{ eventId: string; importKey: string; archiveHashes: string[] }>;
  frontier: string[];
  blockers: string[];
  diagnoses: Array<{ fingerprint: string; role: "developer" | "expert"; disposition: "compatible" | "genuine-conflict" | "unresolved"; reason: string; resultHash: string | null }>;
  lifecycle?: LifecycleRecovery[];
}

export interface LifecycleRecovery {
  sourceAttemptId: string; proofHash: string; pauseEventId: string; retirementEventId: string;
  historicalBaseImageHash: string; observedImageHash: string; basisImageHash: string;
  dependencyOutputs: ContributionInput["dependencyOutputs"];
  definitionHash: string; sourceManifestHash: string; ownerEpoch: number;
  acquisitionProofHash: string; observedSeq: number; controlEventId: string | null;
}

export interface RecoveryOverlapRequest {
  missionId: string;
  fingerprint: string;
  attemptId: string;
  unitId: string;
  conflicts: RecoveryFileConflict[];
  sourceManifestHash: string;
  planStatus: RecoveryReport["plan"]["status"];
}

export interface RecoveryOverlapAnswer {
  disposition: "compatible" | "genuine-conflict" | "unresolved";
  reason: string;
  resolutions?: WorkspaceImageFile[];
  question?: string;
}

export interface RecoveryDiagnosisAdmission {
  version: 1;
  revision: number;
  ownerEpoch: number;
  observedSeq: number;
  fingerprint: string;
  attemptId: string;
  unitId: string;
  sourceEventId: string;
  sourceProofHash: string;
  sourceManifestHash: string;
  planStatus: RecoveryReport["plan"]["status"];
  memberRole: string;
  briefHash: string;
  rolePolicyHash: string;
}

// Only bookkeeping and diagnosis evidence can follow a classified recovery observation.
// A changed workspace, input, effect, hold, owner, or control fact requires fresh classification.
export function recoveryObservationCurrent(
  events: readonly { seq: number; kind: string; causalId: string; payload: Record<string, any> }[],
  observedSeq: number,
  localObservations: ReadonlySet<string> = new Set(),
): boolean {
  return events.every((event) => event.seq <= observedSeq || localObservations.has(event.causalId) ||
    ["mission.recovery.diagnosed", "reservation.created", "budget.reservation.settled", "budget.reservation.adjusted",
      "provider.request.dispatched", "provider.request.receipt", "provider.usage.claimed", "measurement.recorded",
      "mission.input.visible", "mission.notification.delivered",
      "mission.active.window.opened", "mission.active.window.checkpointed", "mission.active.window.closed"].includes(event.kind));
}

export function recoveryDiagnosisBrief(role: string, input: RecoveryOverlapRequest & { developerDiagnosis?: RecoveryOverlapAnswer }): string {
  const files = input.conflicts.map(({ path: name, base, mission, current }) => ({
    path: name,
    base: { kind: base.kind, mode: base.mode, bytesBase64: base.bytes?.toString("base64") ?? null },
    mission: { kind: mission.kind, mode: mission.mode, bytesBase64: mission.bytes?.toString("base64") ?? null },
    current: { kind: current.kind, mode: current.mode, bytesBase64: current.bytes?.toString("base64") ?? null },
  }));
  return JSON.stringify({
    task: role === "developer"
      ? "Diagnose whether the conflicting mission and current source edits are semantically compatible. If compatible, return exact resolved file bytes for every conflict. Return one JSON object with disposition compatible, genuine-conflict, or unresolved; include reason."
      : "Provide expert disposition for the genuine internal conflict identified by the Developer. Resolve only when exact combined file bytes are justified. Return one JSON object with disposition compatible, genuine-conflict, or unresolved; include reason and exact resolutions.",
    planStatus: input.planStatus, sourceManifestHash: input.sourceManifestHash,
    developerDiagnosis: input.developerDiagnosis, conflicts: files,
    responseSchema: { disposition: "compatible|genuine-conflict|unresolved", reason: "string", question: "optional string", resolutions: [{ path: "exact conflict path", kind: "file|symlink|directory|missing", mode: "number|null", bytesBase64: "base64|null" }] },
    constraints: ["Use only supplied evidence.", "Do not infer missing file content.", "Resolve every conflicting path exactly once.", "Return raw JSON only."],
  });
}

export function importedHoldReconciled(store: MissionStore, events: readonly MissionEvent[], imported: MissionEvent, hold: Record<string, unknown>): boolean {
  if (imported.payload.holdsKnown !== true || hold.disposition !== "unresolved" || typeof imported.payload.importKey !== "string" ||
    typeof hold.holdId !== "string") return false;
  return events.some((event) => {
    if (event.kind !== "mission.hold.reconciled" || event.seq <= imported.seq ||
      event.payload.importKey !== imported.payload.importKey || event.payload.holdId !== hold.holdId ||
      event.payload.disposition !== "reconciled_without_outcome" ||
      event.payload.assignmentId !== (hold.assignmentId ?? null) || event.payload.unitId !== (hold.unitId ?? null) ||
      event.payload.originalStatus !== (hold.status ?? null)) return false;
    try { return validLegacyHoldProof(store.readArtifact(String(event.payload.proofHash)), event.payload.proofHash, hold.holdId); }
    catch { return false; }
  });
}

export function validLegacyHoldProof(bytes: Uint8Array, hash: unknown, holdId: unknown): boolean {
  if (sha256(bytes) !== hash) return false;
  try {
    const proof = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    if (proof.format !== "legacy-hold-proof-v1" || proof.holdId !== holdId || proof.quiescent !== true ||
      !Array.isArray(proof.artifacts) || !proof.artifacts.length) return false;
    const names = new Set<string>();
    return proof.artifacts.every((row: unknown) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return false;
      const artifact = row as Record<string, unknown>;
      if (typeof artifact.path !== "string" || !artifact.path || names.has(artifact.path) ||
        typeof artifact.bytesBase64 !== "string" || typeof artifact.hash !== "string") return false;
      names.add(artifact.path);
      const content = Buffer.from(artifact.bytesBase64, "base64");
      return content.toString("base64") === artifact.bytesBase64 && sha256(content) === artifact.hash;
    });
  } catch { return false; }
}

export interface LegacyHoldVerificationInput { holdId: string; assignmentId?: string; unitId?: string; status?: string }
export interface LegacyHoldVerificationProof { quiescent: true; artifacts: Array<{ path: string; bytes: Uint8Array }> }

export interface ReconcileMissionOptions {
  store: MissionStore;
  missionId: string;
  sourceRoot: string;
  candidateParent?: string;
  candidateRoots?: Readonly<Record<string, string>>;
  productRoot?: string;
  bwrapPath?: string;
  planFile?: string;
  trigger?: string;
  assessmentToolIdentity?: string;
  runtimeIdentity?: string;
  orderlyPause?: { pauseEventId: string };
  probeExternal?: (input: {
    missionId: string;
    effectId: string;
    operation: string;
    grantId: string;
    target: string;
    operationKey: string;
    requestHash: string;
    adapterId: string;
    adapterVersion: string;
  }) => Promise<{ disposition: "applied" | "not-applied" | "unknown"; evidence?: unknown }>;
  resolveOverlap?: {
    diagnose: (input: RecoveryOverlapRequest & { diagnosisId: string }) => Promise<RecoveryOverlapAnswer>;
    expertDisposition: (input: RecoveryOverlapRequest & { diagnosisId: string; developerDiagnosis?: RecoveryOverlapAnswer }) => Promise<RecoveryOverlapAnswer>;
  };
}

/** A terminal host stop is authority only for this physical predecessor. */
export function readHistoricalPauseInterruption(
  store: MissionStore, inspection: ReturnType<MissionStore["inspectMission"]>, attemptId: string,
  pauseEventId?: string,
) {
  const hash = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));
  const reserved = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === attemptId);
  const binding = reserved?.payload.binding as MissionAttemptBinding | undefined;
  const settled = inspection.events.find((event) => event.kind === "attempt.settled" && event.attemptId === attemptId);
  const interruption = settled?.payload.interruption as { kind?: string; pauseEventId?: string; proofHash?: string } | undefined;
  if (!binding || settled?.payload.status !== "interrupted" || interruption?.kind !== "host-pause" ||
    !interruption.proofHash || !interruption.pauseEventId || pauseEventId && interruption.pauseEventId !== pauseEventId)
    throw new Error("exact terminal host-pause interruption is missing");
  const bytes = store.readArtifact(interruption.proofHash);
  const proof = JSON.parse(bytes.toString("utf8")) as {
    format: string; missionId: string; pauseEventId: string; attemptId: string; bindingHash: string;
    ownerEpoch: number; owner: ProcessIdentity; runtimeId: string; revision: number; definitionHash: string;
    rolePolicyHash: string; inputManifestHash: string; receiptEventId: string; receiptHash: string; receiptStatus: string;
    candidate: string; baseImageHash: string; observedImageHash: string; sourceManifestHash: string;
    executionStartEventId?: string; executionStartPayloadHash?: string; checkpointHash: string | null;
    checkpointEventId: string | null; childResultHash: string | null; teamBundleHash: string | null;
    consultationId: string | null; journalWatermark: number;
    effects: Array<{ effectId: string; witnesses: Array<{ eventId: string; seq: number; kind: string; payloadHash: string }> }>;
    sdkDisposed: boolean; effectsQuiescent: boolean; processesQuiescent: boolean;
  };
  const pause = inspection.events.find((event) => event.kind === "mission.paused" && event.eventId === interruption.pauseEventId);
  const receipt = inspection.events.find((event) => event.kind === "attempt.receipt" && event.attemptId === attemptId);
  const snapshot = inspection.events.find((event) =>
    ["mission.created", "mission.revised"].includes(event.kind) && event.revision === binding.revision);
  const definition = JSON.parse(store.readArtifact(proof.definitionHash).toString("utf8")) as MissionDefinition;
  const unit = definition.units.find(({ id }) => id === binding.unitId);
  const input = hash({ revision: binding.revision, unit: binding.unitId, inputs: unit?.inputs,
    dependencies: unit?.dependencies.map((id) => ({ id, evidence: [...inspection.events].reverse().find((event) =>
      event.seq < reserved!.seq && event.kind === "unit.accepted" && event.unitId === id)?.payload.evidenceIds ?? [] })) });
  if (sha256(bytes) !== interruption.proofHash || proof.format !== "mission-pause-interruption-v1" ||
    proof.missionId !== inspection.id || proof.attemptId !== attemptId || proof.pauseEventId !== pause?.eventId ||
    !unit || proof.revision !== binding.revision ||
    proof.definitionHash !== snapshot?.payload.definitionHash || proof.bindingHash !== hash(binding) ||
    proof.ownerEpoch !== binding.ownerEpoch || pause?.payload.ownerEpoch !== binding.ownerEpoch ||
    proof.runtimeId !== pause.payload.runtimeId || hash(proof.owner) !== hash(pause.payload.owner) ||
    !Array.isArray(pause.payload.stoppedAttempts) || !pause.payload.stoppedAttempts.some((row: Record<string, unknown>) =>
      row.attemptId === attemptId && row.bindingHash === proof.bindingHash) ||
    proof.receiptEventId !== receipt?.eventId || proof.receiptHash !== hash(receipt?.payload) ||
    proof.receiptStatus !== receipt?.payload.status || !["cancelled", "failed"].includes(proof.receiptStatus) ||
    pause.seq >= receipt.seq || receipt.seq > proof.journalWatermark || proof.journalWatermark >= settled.seq ||
    proof.sdkDisposed !== true || proof.effectsQuiescent !== true || proof.processesQuiescent !== true ||
    proof.candidate !== binding.candidate || proof.inputManifestHash !== binding.inputManifestHash ||
    binding.inputManifestHash !== (binding.candidate === "managed" ? hash({ baseInputManifestHash: input,
      workspaceManifestHash: binding.workspaceManifestHash }) : input) ||
    proof.rolePolicyHash !== binding.rolePolicyHash ||
    definition.authority.rolePolicies[binding.role ?? unit.role]?.hash !== binding.rolePolicyHash ||
    proof.checkpointHash !== (binding.checkpointHash ?? null) || proof.childResultHash !== (binding.childResultHash ?? null) ||
    proof.teamBundleHash !== (binding.teamBundleHash ?? null) || proof.consultationId !== (binding.consultationId ?? null) ||
    binding.workspaceManifestHash && binding.workspaceManifestHash !== proof.sourceManifestHash)
    throw new Error("pause source, input, definition, policy, receipt or control changed");
  for (const artifactHash of [proof.definitionHash, binding.predicateInputBindingsHash, proof.checkpointHash,
    proof.childResultHash, proof.teamBundleHash].filter((value): value is string => !!value))
    if (sha256(store.readArtifact(artifactHash)) !== artifactHash) throw new Error("pause lineage artifact changed");
  if (binding.childResultHash && !inspection.events.some((event) => event.kind === "team.consultation.resolved" &&
    event.payload.parentAttemptId === binding.continuationOf && event.payload.resultHash === binding.childResultHash))
    throw new Error("pause child result changed");
  if (binding.teamBundleHash) {
    const bundle = JSON.parse(store.readArtifact(binding.teamBundleHash).toString("utf8"));
    if (bundle.unitId !== binding.unitId || bundle.memberId !== binding.memberId || bundle.round !== binding.roundId ||
      (bundle.targetId ?? binding.unitId) !== (binding.targetId ?? binding.unitId) ||
      hash({ version: 1, phase: bundle.phase, round: bundle.round }) !== binding.teamOutputContractHash ||
      (bundle.childResultHash ?? null) !== (binding.childResultHash ?? null) ||
      binding.childResultHash && sha256(Buffer.from(bundle.childResult ?? "")) !== binding.childResultHash)
      throw new Error("pause bundle or output contract changed");
  }
  const rows = inspection.events.filter((event) => event.attemptId === attemptId &&
    (event.kind.startsWith("effect.") || event.kind === "workspace.snapshot.sealed" && event.payload.effectId));
  const prefix = rows.filter((event) => event.seq <= proof.journalWatermark).map((event) =>
    ({ effectId: event.effectId, eventId: event.eventId, seq: event.seq, kind: event.kind, payloadHash: hash(event.payload) }));
  const witnessed = proof.effects.flatMap(({ effectId, witnesses }) => witnesses.map((row) => ({ effectId, ...row })));
  const ids = new Set(proof.effects.map(({ effectId }) => effectId));
  if (ids.size !== proof.effects.length || JSON.stringify(witnessed.sort((a, b) => a.seq - b.seq)) !== JSON.stringify(prefix) ||
    missionHasUnresolvedEffects(store, inspection.events.filter((event) => event.seq <= proof.journalWatermark), attemptId) ||
    !missionEffectProcessesQuiescent(inspection.events, attemptId))
    throw new Error("pause effect prefix or recovery-only suffix is unresolved");
  if (binding.candidate === "managed") {
    const start = inspection.events.find((event) => event.eventId === proof.executionStartEventId);
    const registration = inspection.events.find((event) => event.kind === "workspace.candidate.registered" && event.attemptId === attemptId);
    const base = inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
      event.attemptId === attemptId && event.payload.phase === "base");
    if (!start || start.attemptId !== attemptId || start.payload.purpose !== "execution-start" ||
      hash(start.payload) !== proof.executionStartPayloadHash || start.payload.bindingHash !== proof.bindingHash ||
      start.payload.imageHash !== proof.baseImageHash || start.payload.ownerEpoch !== binding.ownerEpoch ||
      start.payload.candidateRegistrationCausalId !== registration?.causalId ||
      start.payload.candidateRegistrationHash !== hash(registration?.payload) ||
      hash(registration?.payload) !== hash({ ...binding.candidateRegistration, locationHistory: [binding.candidateRoot] }) ||
      start.payload.sourceBaseCausalId !== base?.causalId || start.payload.sourceBaseImageHash !== base?.payload.imageHash ||
      start.payload.checkpointHash !== (binding.checkpointHash ?? null) ||
      start.payload.recoveryImageHash !== (binding.recoveryImageHash ?? null) ||
      readSealedWorkspaceImage(store, proof.baseImageHash).manifest.hash !== start.payload.manifestHash)
      throw new Error("pause execution-start or candidate registration changed");
    readSealedWorkspaceImage(store, proof.observedImageHash);
    if (binding.checkpointHash) {
      const checkpoint = JSON.parse(store.readArtifact(binding.checkpointHash).toString("utf8"));
      const seal = inspection.events.find((event) => event.eventId === proof.checkpointEventId);
      if (checkpoint.sourceAttemptId !== binding.continuationOf || seal?.attemptId !== binding.continuationOf ||
        seal?.payload.checkpointHash !== binding.checkpointHash ||
        proof.baseImageHash !== (binding.recoveryImageHash ?? checkpoint.imageHash))
        throw new Error("pause recovery start or original checkpoint provenance changed");
    }
  } else {
    const image = JSON.parse(store.readArtifact(proof.observedImageHash).toString("utf8"));
    if (image.format !== "mission-pause-readonly-image-v1" || image.manifestHash !== proof.sourceManifestHash ||
      proof.baseImageHash !== proof.observedImageHash) throw new Error("pause read-only image changed");
  }
  const historical = { binding, proof, proofHash: interruption.proofHash, settled, receipt: receipt!, pause: pause!, definition };
  validateInterruptionSuffix(store, inspection, historical);
  return historical;
}

/** Manual pause still requires the original admission to be current. */
export function pauseInterruption(
  store: MissionStore, inspection: ReturnType<MissionStore["inspectMission"]>, attemptId: string,
  sourceRoot: string, pauseEventId?: string,
) {
  const source = readHistoricalPauseInterruption(store, inspection, attemptId, pauseEventId);
  const { binding, proof } = source;
  if (binding.revision !== inspection.revision || proof.definitionHash !== inspection.snapshot.definitionHash ||
    inspection.events.some((event) => event.kind === "mission.cancelled" ||
      event.kind === "team.consultation.cancelled" && event.unitId === binding.unitId) ||
    store.verifyRepositoryAssociation(sourceRoot) !== inspection.repositoryId ||
    captureWorkspaceImage(sourceRoot).manifest.hash !== proof.sourceManifestHash)
    throw new Error("pause source, input, definition, policy, receipt or control changed");
  return source;
}

export function pauseRecoveryCurrent(
  store: MissionStore, inspection: ReturnType<MissionStore["inspectMission"]>,
  continuationId: string, sourceRoot: string,
) {
  const event = inspection.events.find((row) => row.kind === "mission.recovery.continuation.recorded" &&
    row.payload.continuationId === continuationId && row.payload.pauseEventId);
  if (!event) throw new Error("pause recovery observation is missing");
  const source = pauseInterruption(store, inspection, String(event.payload.sourceAttemptId), sourceRoot,
    String(event.payload.pauseEventId));
  if (event.revision !== inspection.revision || event.payload.ownerEpoch !== store.ownerEpoch ||
    event.payload.proofHash !== source.proofHash ||
    event.payload.acquisitionProofHash !== sha256(Buffer.from(JSON.stringify(store.ownerAcquisitionProof))) ||
    event.payload.sourceImageHash !== source.proof.observedImageHash ||
    event.payload.sourceManifestHash !== source.proof.sourceManifestHash ||
    !Number.isSafeInteger(event.payload.observedSeq) || Number(event.payload.observedSeq) >= event.seq ||
    !missionEffectProcessesQuiescent(inspection.events, source.binding.attemptId))
    throw new Error("pause recovery owner or image observation changed");
  return { ...source, event };
}

/** Lifecycle provenance is historical; it cannot itself admit a current worker. */
export function lifecycleInterruption(store: MissionStore, inspection: ReturnType<MissionStore["inspectMission"]>, attemptId: string) {
  const source = readHistoricalPauseInterruption(store, inspection, attemptId);
  const release = inspection.events.find((row) => row.kind === "mission.owner.released" &&
    row.payload.pauseEventId === source.pause.eventId);
  if (source.pause.payload.controlOrigin !== "lifecycle" || source.binding.candidate !== "managed" ||
    !release || release.seq <= source.settled.seq || release.payload.effectsQuiescent !== true ||
    sha256(Buffer.from(JSON.stringify(release.payload.owner))) !== sha256(Buffer.from(JSON.stringify(source.proof.owner))))
    throw new Error("lifecycle stop lacks its exact owner retirement");
  return { ...source, release };
}

function validateInterruptionSuffix(
  store: MissionStore, inspection: ReturnType<MissionStore["inspectMission"]>,
  source: { binding: MissionAttemptBinding; proof: { journalWatermark: number; effects: Array<{ effectId: string }>;
    observedImageHash: string; sourceManifestHash: string; pauseEventId: string }; proofHash: string; settled: MissionEvent },
): void {
  const ids = new Set(source.proof.effects.map(({ effectId }) => effectId));
  const reports = inspection.events.filter((row) => row.kind === "mission.recovery.recorded").map((row) => {
    const bytes = store.readArtifact(String(row.payload.reportHash));
    const report = JSON.parse(bytes.toString("utf8")) as RecoveryReport;
    if (sha256(bytes) !== row.payload.reportHash || report.format !== "mission-recovery-report-v2" ||
      report.missionId !== inspection.id || report.episodeId !== row.payload.episodeId || report.revision !== row.revision)
      throw new Error("interruption suffix report changed");
    for (const effect of report.effects) {
      if (effect.attemptId === source.binding.attemptId || ids.has(effect.effectId)) {
        if (effect.attemptId !== source.binding.attemptId || !ids.has(effect.effectId) || effect.disposition === "unknown")
          throw new Error("interruption report has unknown or conflicting exposure");
      }
    }
    return { row, report };
  });
  for (const row of inspection.events.filter((event) => event.seq > source.proof.journalWatermark &&
    (event.attemptId === source.binding.attemptId || event.effectId && ids.has(event.effectId)))) {
    if (row === source.settled) continue;
    if (row.kind === "effect.reconciled" && ids.has(row.effectId!) && row.payload.observedBy === "mission-recovery") {
      const report = reports.find(({ report }) => report.episodeId === row.payload.episodeId)?.report;
      const claim = report?.effects.find(({ effectId }) => effectId === row.effectId);
      const rows = inspection.events.filter((event) => event.effectId === row.effectId);
      const intent = rows.find((event) => event.kind === "effect.intent")?.payload;
      if (claim && intent && claim.attemptId === source.binding.attemptId &&
        claim.disposition === row.payload.disposition && JSON.stringify(claim.probe ?? null) === JSON.stringify(row.payload.probe ?? null) &&
        (["unstarted"].includes(claim.disposition) ? classifyNoEffect(rows) === "unstarted" :
          effectReconciliationEventIsBound(rows, intent, row.payload) &&
          ((row.payload.probe as Record<string, unknown> | undefined)?.proofKind !== "candidate-after-image-v1" || storedEffectReconciliationIsProven(store, rows, intent, row.payload))))
        continue;
      // Opaque local Bash observations have no deterministic probe. They must link
      // to the exact stopped receipt/image, not make a new outcome assertion.
      const terminal = rows.find((event) => event.kind === "effect.receipt");
      if (claim?.operation === "bash" && claim.disposition === "partial" && terminal?.payload.status === "failed" &&
        terminal.payload.termination === "signal" && claim.probe === undefined && row.payload.probe === undefined) continue;
    }
    if (row.kind === "workspace.snapshot.sealed" && row.payload.phase === "recovered" && row.payload.proofHash === source.proofHash) {
      const found = reports.find(({ report }) => report.episodeId === row.payload.episodeId);
      const lifecycle = found?.report.lifecycle?.find(({ sourceAttemptId }) => sourceAttemptId === source.binding.attemptId);
      if (lifecycle && JSON.stringify(lifecycle) === JSON.stringify(row.payload.lifecycle) &&
        found!.report.candidate.imageHash === row.payload.imageHash) {
        validateLifecycleImage(store, inspection, lifecycle, row);
        continue;
      }
      if (row.payload.pauseEventId && reports.some(({ report }) => report.frontier.includes(source.binding.unitId)) &&
        row.payload.imageHash === readHistoricalImageHash(store, source.proofHash)) continue;
    }
    if (row.kind === "mission.recovery.continuation.recorded" && row.payload.sourceAttemptId === source.binding.attemptId &&
      row.payload.proofHash === source.proofHash) {
      const snapshot = inspection.events.find((event) => event.attemptId === source.binding.attemptId &&
        event.kind === "workspace.snapshot.sealed" && event.payload.phase === "recovered" &&
        event.payload.imageHash === row.payload.sourceImageHash && event.seq < row.seq);
      if (snapshot && (!row.payload.lifecycle || JSON.stringify(row.payload.lifecycle) === JSON.stringify(snapshot.payload.lifecycle))) continue;
      // Read-only pauses have no writable recovered snapshot. Their existing
      // observation binds the unchanged image and the exact report frontier.
      if (source.binding.candidate === "read-only" && !row.payload.lifecycle &&
        row.payload.pauseEventId === source.proof.pauseEventId &&
        row.payload.sourceImageHash === source.proof.observedImageHash &&
        row.payload.sourceManifestHash === source.proof.sourceManifestHash &&
        reports.some(({ report }) => report.frontier.includes(source.binding.unitId) &&
          report.owner.epoch === row.payload.ownerEpoch && report.disposition.observedSeq === row.payload.observedSeq &&
          row.payload.continuationId === sha256(Buffer.from(JSON.stringify({ episodeId: report.episodeId,
            attemptId: source.binding.attemptId, proofHash: source.proofHash, ownerEpoch: report.owner.epoch })))))
        continue;
    }
    throw new Error(`interruption suffix contains unbound or renewed execution: ${row.kind}`);
  }
}

function readHistoricalImageHash(store: MissionStore, proofHash: string): string {
  return JSON.parse(store.readArtifact(proofHash).toString("utf8")).observedImageHash;
}

/** Recovery may observe an outcome, but may not add execution to its producer chain. */
export function recoveryEffectObservationIsBound(
  store: MissionStore, inspection: ReturnType<MissionStore["inspectMission"]>,
  row: Partial<MissionEvent>, prefix: readonly Partial<MissionEvent>[],
): boolean {
  try {
    const intent = prefix.find((event) => event.kind === "effect.intent");
    const receipt = prefix.find((event) => event.kind === "effect.receipt");
    if (!intent?.payload || !row.payload || row.kind !== "effect.reconciled" ||
      row.effectId !== intent.effectId || row.attemptId !== intent.attemptId ||
      row.missionId !== intent.missionId ||
      row.unitId !== null && row.unitId !== intent.unitId ||
      !Number.isSafeInteger(row.seq) || row.seq! <= prefix.at(-1)!.seq! ||
      row.payload.observedBy !== "mission-recovery") return false;
    const reportRow = inspection.events.find((event) => event.kind === "mission.recovery.recorded" &&
      event.payload.episodeId === row.payload!.episodeId && event.seq < row.seq!);
    if (!reportRow) return false;
    const bytes = store.readArtifact(String(reportRow.payload.reportHash));
    const report = JSON.parse(bytes.toString()) as RecoveryReport;
    const claim = report.effects.find((effect) => effect.effectId === intent.effectId);
    if (sha256(bytes) !== reportRow.payload.reportHash || report.format !== "mission-recovery-report-v2" ||
      report.missionId !== inspection.id || report.revision !== reportRow.revision || row.revision !== reportRow.revision ||
      !Number.isSafeInteger(report.disposition.observedSeq) || report.disposition.observedSeq >= reportRow.seq ||
      report.episodeId !== reportRow.payload.episodeId || !claim || claim.attemptId !== intent.attemptId ||
      claim.operation !== intent.payload.operation || claim.disposition !== row.payload.disposition ||
      JSON.stringify(claim.probe ?? null) !== JSON.stringify(row.payload.probe ?? null)) return false;
    if (intent.payload.operation === "bash")
      return claim.disposition === "applied" && claim.probe === undefined &&
        receipt?.payload?.status === "completed" && receipt.payload.termination === "exit" && receipt.payload.exitCode === 0;
    const rows = prefix as Array<{ kind: string; payload: Record<string, any> }>;
    return effectReconciliationEventIsBound(rows, intent.payload, row.payload) &&
      storedEffectReconciliationIsProven(store, rows, intent.payload, row.payload);
  } catch { return false; }
}

function validateLifecycleImage(store: MissionStore, inspection: ReturnType<MissionStore["inspectMission"]>,
  lifecycle: LifecycleRecovery, snapshot: MissionEvent): void {
  const basis = readSealedWorkspaceImage(store, lifecycle.basisImageHash);
  const base = readSealedWorkspaceImage(store, lifecycle.historicalBaseImageHash);
  const observed = readSealedWorkspaceImage(store, lifecycle.observedImageHash);
  const recovered = readSealedWorkspaceImage(store, String(snapshot.payload.imageHash));
  for (const image of [basis, base, observed, recovered]) assertCompleteWorkspaceImage(image);
  const merged = mergeWorkspaceImages(base, observed, basis);
  let files = merged.files;
  if (merged.conflicts.length) {
    const uses = snapshot.payload.diagnosisUses as Array<{ resultHash: string; fingerprint: string }> | undefined;
    const use = uses?.at(-1);
    const completed = use && inspection.events.find((row) => row.kind === "mission.recovery.diagnosed" &&
      row.payload.status === "completed" && row.payload.resultHash === use.resultHash && row.payload.fingerprint === use.fingerprint);
    if (!completed) throw new Error("lifecycle merge lacks exact diagnosis");
    const answer = validateOverlapAnswer(deserializeOverlapAnswer(store.readArtifact(use!.resultHash)), merged.conflicts);
    if (answer.disposition !== "compatible" || !answer.resolutions) throw new Error("lifecycle overlap remains unresolved");
    files = applyOverlapResolutions(files, answer.resolutions);
  }
  if (JSON.stringify(files) !== JSON.stringify(recovered.files)) throw new Error("lifecycle recovered image differs from bounded merge");
}

export function lifecycleRecoveryCurrent(store: MissionStore, inspection: ReturnType<MissionStore["inspectMission"]>,
  continuationId: string, sourceRoot: string, consumingAttemptId?: string) {
  const event = inspection.events.find((row) => row.kind === "mission.recovery.continuation.recorded" &&
    row.payload.continuationId === continuationId);
  const lifecycle = event?.payload.lifecycle as LifecycleRecovery | undefined;
  if (!event || !lifecycle) throw new Error("lifecycle recovery observation is missing");
  const source = lifecycleInterruption(store, inspection, lifecycle.sourceAttemptId);
  const snapshot = inspection.events.find((row) => row.kind === "workspace.snapshot.sealed" &&
    row.attemptId === lifecycle.sourceAttemptId && row.payload.imageHash === event.payload.sourceImageHash &&
    JSON.stringify(row.payload.lifecycle) === JSON.stringify(lifecycle));
  const control = [...inspection.events].reverse().find((row) => ["mission.paused", "mission.resumed", "mission.cancelled"].includes(row.kind));
  const consumers = inspection.events.filter((row) => row.kind === "attempt.reserved" &&
    (row.payload.binding as MissionAttemptBinding).recoveryContinuationId === continuationId);
  if (event.revision !== inspection.revision || lifecycle.definitionHash !== inspection.snapshot.definitionHash ||
    lifecycle.ownerEpoch !== store.ownerEpoch || lifecycle.acquisitionProofHash !== sha256(Buffer.from(JSON.stringify(store.ownerAcquisitionProof))) ||
    lifecycle.proofHash !== source.proofHash || lifecycle.retirementEventId !== source.release.eventId ||
    lifecycle.pauseEventId !== source.pause.eventId || lifecycle.observedImageHash !== source.proof.observedImageHash ||
    event.payload.sourceAttemptId !== source.binding.attemptId || event.payload.unitId !== source.binding.unitId ||
    !snapshot || !Number.isSafeInteger(lifecycle.observedSeq) || lifecycle.observedSeq >= snapshot.seq ||
    lifecycle.controlEventId !== (control?.eventId ?? null) || control?.kind === "mission.paused" || control?.kind === "mission.cancelled" ||
    inspection.events.some((row) => row.kind === "mission.cancelled" ||
      row.kind === "team.consultation.cancelled" && row.unitId === source.binding.unitId) ||
    store.verifyRepositoryAssociation(sourceRoot) !== inspection.repositoryId ||
    captureWorkspaceImage(sourceRoot).manifest.hash !== lifecycle.sourceManifestHash ||
    consumers.some((row) => row.attemptId !== consumingAttemptId &&
      (row.payload.binding as MissionAttemptBinding).recoveryMode !== "repair"))
    throw new Error("lifecycle recovery current owner, source, control or consumption changed");
  validateLifecycleImage(store, inspection, lifecycle, snapshot);
  for (const dependency of lifecycle.dependencyOutputs) {
    const current = readAcceptedWorkspaceContribution(store, inspection, dependency.unitId);
    if (current.outputHash !== dependency.outputBindingHash || current.output.attemptId !== dependency.attemptId)
      throw new Error("lifecycle recovery current dependency changed");
  }
  return { ...source, event, lifecycle };
}

export function mergeWorkspaceImages(base: WorkspaceImage, mission: WorkspaceImage, current: WorkspaceImage): {
  files: WorkspaceImageFile[];
  conflicts: RecoveryFileConflict[];
  changedPaths: string[];
} {
  const baseRows = new Map(base.files.map((file) => [file.path, file]));
  const missionRows = new Map(mission.files.map((file) => [file.path, file]));
  const currentRows = new Map(current.files.map((file) => [file.path, file]));
  const names = [...new Set([...baseRows.keys(), ...missionRows.keys(), ...currentRows.keys()])].sort();
  const files: WorkspaceImageFile[] = [];
  const conflicts: RecoveryFileConflict[] = [];
  const changedPaths: string[] = [];
  for (const name of names) {
    const before = baseRows.get(name) ?? missingImage(name);
    const intended = missionRows.get(name) ?? missingImage(name);
    const observed = currentRows.get(name) ?? missingImage(name);
    let result: WorkspaceImageFile;
    if (sameImage(before, intended)) result = observed;
    else if (sameImage(before, observed) || sameImage(intended, observed)) result = intended;
    else {
      conflicts.push({ path: name, base: before, mission: intended, current: observed });
      result = observed;
    }
    if (!sameImage(observed, result)) changedPaths.push(name);
    files.push(result);
  }
  return { files, conflicts, changedPaths };
}

function imageFromFiles(manifest: WorkspaceManifest, files: WorkspaceImageFile[]): WorkspaceImage {
  const tracked = new Set(manifest.tracked.map(({ path }) => path));
  const rows = files.map(({ path, kind, mode, bytes }) => ({ path, kind, mode, hash: bytes ? sha256(bytes) : null }));
  const { hash: _hash, ...body } = manifest;
  const next = { ...body, tracked: rows.filter(({ path }) => tracked.has(path)),
    untracked: rows.filter(({ path, kind }) => !tracked.has(path) && kind !== "missing") };
  return { manifest: { ...next, hash: sha256(Buffer.from(JSON.stringify(next))) }, files };
}

export function assertCompleteWorkspaceImage(image: WorkspaceImage, physicalPaths?: readonly ManifestPath[]): void {
  const { hash: manifestHash, ...body } = image.manifest;
  if (sha256(Buffer.from(JSON.stringify(body))) !== manifestHash) throw new Error("workspace manifest identity is corrupt");
  const expected = [...image.manifest.tracked, ...image.manifest.untracked].sort((a, b) => a.path.localeCompare(b.path));
  const observed = image.files.map(({ path, kind, mode, bytes }) => ({ path, kind, mode, hash: bytes ? sha256(bytes) : null }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(observed.map(({ path }) => path)).size !== observed.length || JSON.stringify(expected) !== JSON.stringify(observed))
    throw new Error("workspace image is incomplete or its bytes do not match the full manifest");
  const stored = new Map(observed.map((row) => [row.path, row]));
  for (const row of physicalPaths ?? []) {
    if (row.kind !== "file" && row.kind !== "symlink") continue;
    const file = stored.get(row.path);
    if (!file || file.kind !== row.kind || file.mode !== row.mode || file.hash !== row.hash)
      throw new Error(`workspace image omits physical output bytes or identity: ${row.path}`);
  }
}

export function createConditionalMissionPatch(base: WorkspaceImage, accepted: WorkspaceImage): ConditionalMissionPatch {
  const acceptedManifestHash = canonicalDeliveryManifest(accepted.manifest, base.manifest).hash;
  const left = new Map(base.files.map((file) => [file.path, file]));
  const right = new Map(accepted.files.map((file) => [file.path, file]));
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes = names.flatMap((name) => {
    const before = left.get(name) ?? missingImage(name);
    const after = right.get(name) ?? missingImage(name);
    return sameImage(before, after) ? [] : [{ path: name, before, after }];
  });
  const sensitive = changes.find(({ path: name }) => sensitiveArtifactPath(name));
  if (sensitive) throw new Error(`conditional patch would archive a sensitive path: ${sensitive.path}`);
  return {
    format: "mission-conditional-patch-v1",
    deliveryBaseManifestHash: base.manifest.hash,
    acceptedManifestHash,
    changes,
  };
}

export interface ContributionInput {
  originAttemptId: string;
  baseImageHash: string;
  dependencyOutputs: Array<{ unitId: string; attemptId: string; outputBindingHash: string }>;
}

// This is the tree before this unit's own work, not before its final continuation.
export function readContributionInput(store: MissionStore, inspection: ReturnType<MissionStore["inspectMission"]>,
  binding: MissionAttemptBinding): ContributionInput {
  const start = inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
    event.attemptId === binding.attemptId && event.payload.purpose === "execution-start");
  const input = start?.payload.contributionInput as ContributionInput | undefined;
  const hash = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));
  if (!input || start?.payload.bindingHash !== hash(binding) || !Array.isArray(input.dependencyOutputs))
    throw new Error("contribution input is missing or unbound");
  const pending = [binding];
  const seen = new Set<string>();
  let origin: MissionAttemptBinding | undefined;
  while (pending.length) {
    const current = pending.shift()!;
    if (seen.has(current.attemptId)) continue;
    seen.add(current.attemptId);
    if (current.attemptId === input.originAttemptId) { origin = current; break; }
    const reserved = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === current.attemptId);
    const recovery = inspection.events.find((event) => event.kind === "mission.recovery.continuation.recorded" &&
      event.payload.continuationId === current.recoveryContinuationId);
    for (const id of new Set([current.continuationOf, current.recoveryOf, recovery?.payload.sourceAttemptId])) {
      if (!id) continue;
      const prior = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === id);
      const predecessor = prior?.payload.binding as MissionAttemptBinding | undefined;
      if (!reserved || !prior || prior.seq >= reserved.seq || !predecessor || predecessor.unitId !== binding.unitId ||
        predecessor.revision !== binding.revision || predecessor.missionId !== binding.missionId)
        throw new Error("contribution predecessor is missing or changed");
      const predecessorStart = inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
        event.attemptId === predecessor.attemptId && event.payload.purpose === "execution-start");
      if (hash(predecessorStart?.payload.contributionInput) !== hash(input)) throw new Error("owned contribution input lineage changed");
      pending.push(predecessor);
    }
  }
  const originStart = origin && inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
    event.attemptId === origin.attemptId && event.payload.purpose === "execution-start");
  const lifecycleEvent = origin?.recoveryContinuationId && inspection.events.find((row) =>
    row.kind === "mission.recovery.continuation.recorded" && row.payload.continuationId === origin!.recoveryContinuationId &&
    row.revision === origin!.revision && row.payload.lifecycle);
  const lifecycle = lifecycleEvent && lifecycleEvent.payload.lifecycle as LifecycleRecovery | undefined;
  const lifecycleSnapshot = lifecycle && inspection.events.find((row) => row.kind === "workspace.snapshot.sealed" &&
    row.payload.imageHash === lifecycleEvent!.payload.sourceImageHash && row.attemptId === lifecycle.sourceAttemptId &&
    JSON.stringify(row.payload.lifecycle) === JSON.stringify(lifecycle));
  if (!origin || originStart?.payload.bindingHash !== hash(origin) || hash(originStart.payload.contributionInput) !== hash(input) ||
    (lifecycle ? !lifecycleSnapshot || lifecycleEvent!.seq >= originStart.seq || lifecycle.basisImageHash !== input.baseImageHash ||
      lifecycleEvent!.payload.sourceImageHash !== originStart.payload.recoveryImageHash ||
      JSON.stringify(lifecycle.dependencyOutputs) !== JSON.stringify(input.dependencyOutputs) :
      origin.continuationOf || origin.recoveryOf || origin.recoveryContinuationId || originStart.payload.imageHash !== input.baseImageHash))
    throw new Error("contribution base is not its owned lineage origin");
  if (lifecycle && lifecycleSnapshot) {
    lifecycleInterruption(store, inspection, lifecycle.sourceAttemptId);
    validateLifecycleImage(store, inspection, lifecycle, lifecycleSnapshot);
    const restored = readSealedWorkspaceImage(store, String(originStart.payload.imageHash));
    const recovered = readSealedWorkspaceImage(store, String(lifecycleSnapshot.payload.imageHash));
    assertCompleteWorkspaceImage(restored);
    // A fresh candidate has a new Git index checksum, not new owned bytes.
    if (JSON.stringify(restored.files) !== JSON.stringify(recovered.files))
      throw new Error("lifecycle contribution origin did not restore its recovered image");
  }
  const dependencies = new Set<string>();
  const visit = (id: string) => {
    for (const parent of inspection.definition.units.find((unit) => unit.id === id)!.dependencies) {
      if (dependencies.has(parent)) continue;
      dependencies.add(parent); visit(parent);
    }
  };
  visit(binding.unitId);
  if (input.dependencyOutputs.length !== dependencies.size || new Set(input.dependencyOutputs.map((row) => row.unitId)).size !== dependencies.size)
    throw new Error("contribution dependency set changed");
  for (const row of input.dependencyOutputs) {
    const accepted = [...inspection.events].reverse().find((event) => event.kind === "unit.accepted" &&
      event.unitId === row.unitId && event.revision === binding.revision);
    if (!dependencies.has(row.unitId) || !accepted || accepted.attemptId !== row.attemptId ||
      accepted.payload.outputBindingHash !== row.outputBindingHash || accepted.seq >= originStart.seq)
      throw new Error("contribution accepted dependency changed");
    store.readArtifact(row.outputBindingHash);
  }
  assertCompleteWorkspaceImage(readSealedWorkspaceImage(store, input.baseImageHash));
  return input;
}

export function readAcceptedWorkspaceContribution(store: MissionStore, inspection: ReturnType<MissionStore["inspectMission"]>, unitId: string) {
  const event = [...inspection.events].reverse().find((row) => row.kind === "unit.accepted" && row.unitId === unitId && row.revision === inspection.revision);
  if (!event?.payload.outputBindingHash) throw new Error(`dependency ${unitId} has no accepted host output`);
  const outputHash = String(event.payload.outputBindingHash);
  const bytes = store.readArtifact(outputHash);
  const output = JSON.parse(bytes.toString("utf8"));
  const binding = output.binding as MissionAttemptBinding;
  const receipt = inspection.events.find((row) => row.kind === "attempt.receipt" && row.attemptId === event.attemptId);
  if (sha256(bytes) !== outputHash || output.format !== "mission-accepted-output-v1" || output.missionId !== inspection.id ||
    output.revision !== inspection.revision || output.unitId !== unitId || output.attemptId !== event.attemptId ||
    binding.missionId !== inspection.id || binding.revision !== inspection.revision || binding.unitId !== unitId ||
    binding.attemptId !== event.attemptId || output.sdkDisposed !== true || output.effectsQuiescent !== true || output.writersQuiescent !== true ||
    receipt?.payload.sdkDisposed !== true || receipt.payload.status !== "completed" || output.resultArtifactHash !== receipt.payload.artifactHash ||
    !missionEffectProcessesQuiescent(inspection.events, binding.attemptId)) throw new Error(`unproven accepted producer ${unitId}`);
  for (const evidenceId of output.evidenceIds) {
    const evidence = inspection.events.find((row) => row.kind === "evidence.recorded" && row.payload.id === evidenceId);
    if (!evidence || evidence.payload.assessmentAuthority !== "production-checker" || evidence.payload.verdict !== "pass" ||
      inspection.events.some((row) => row.kind === "evidence.invalidated" && row.payload.evidenceId === evidenceId) ||
      !output.evidenceHashes.includes(evidence.payload.artifactHash)) throw new Error(`current production evidence is missing for ${unitId}`);
    store.readArtifact(String(evidence.payload.artifactHash));
  }
  if (binding.candidate !== "managed") return { outputHash, output };
  const proofBytes = store.readArtifact(String(output.terminalOutputHash));
  const proof = JSON.parse(proofBytes.toString());
  const start = inspection.events.find((row) => row.kind === "workspace.snapshot.sealed" && row.attemptId === binding.attemptId && row.payload.purpose === "execution-start");
  if (sha256(proofBytes) !== output.terminalOutputHash || receipt.payload.terminalOutputHash !== output.terminalOutputHash ||
    proof.format !== "mission-terminal-output-v1" || proof.missionId !== inspection.id || proof.revision !== inspection.revision || proof.attemptId !== binding.attemptId ||
    proof.executionStartImageHash !== start?.payload.imageHash || proof.sourceBaseImageHash !== start?.payload.sourceBaseImageHash ||
    proof.bindingHash !== sha256(Buffer.from(JSON.stringify(binding))) || proof.sdkDisposed !== true ||
    proof.effectsQuiescent !== true || proof.writersQuiescent !== true) throw new Error(`terminal producer proof is missing for ${unitId}`);
  const input = readContributionInput(store, inspection, binding);
  if (JSON.stringify(proof.contributionInput) !== JSON.stringify(input)) throw new Error(`terminal contribution input changed for ${unitId}`);
  const base = readSealedWorkspaceImage(store, input.baseImageHash);
  const terminal = readSealedWorkspaceImage(store, proof.terminalImageHash);
  for (const image of [base, terminal, readSealedWorkspaceImage(store, proof.sourceBaseImageHash), readSealedWorkspaceImage(store, proof.executionStartImageHash)])
    assertCompleteWorkspaceImage(image);
  return { outputHash, output, proof, base, terminal, input };
}

export async function integrateAcceptedMissionOutputs(options: {
  store: MissionStore; missionId: string; sourceRoot: string; candidateParent: string; productRoot?: string; bwrapPath?: string;
  artifactLimit?: number;
}) {
  const { store, missionId } = options;
  let inspection = store.inspectMission(missionId);
  if (inspection.definition.finalization.contractVersion !== 1) throw new Error("legacy definition is completion-ineligible");
  const accepted = new Map(inspection.definition.units.map((unit) => [unit.id, [...inspection.events].reverse().find((event) =>
    event.kind === "unit.accepted" && event.unitId === unit.id && event.revision === inspection.revision)]));
  const ordered: string[] = [];
  const visit = (id: string) => {
    if (ordered.includes(id)) return;
    for (const dependency of inspection.definition.units.find((unit) => unit.id === id)!.dependencies.slice().sort()) visit(dependency);
    ordered.push(id);
  };
  for (const id of [...accepted.keys()].sort()) visit(id);
  if ([...accepted.values()].some((event) => !event?.payload.outputBindingHash)) throw new Error("current accepted host output is missing; injected PASS is not delivery authority");
  if (missionHasUnresolvedEffects(store, inspection.events)) throw new Error("integration has unresolved effects");
  const deliveryBase = captureWorkspaceImage(options.sourceRoot);
  assertCompleteWorkspaceImage(deliveryBase);
  if (store.verifyRepositoryAssociation(options.sourceRoot) !== inspection.repositoryId) throw new Error("delivery repository identity changed");
  const protectedBytes = inspection.reservations.filter((row) => row.resource === "artifact-bytes" && row.purpose === "protected").reduce((sum, row) => sum + row.amount, 0);
  const usedFinalizationBytes = inspection.reservations.filter((row) => row.resource === "artifact-bytes" && row.purpose === "finalization").reduce((sum, row) => sum + row.amount, 0);
  const grant = Math.min(protectedBytes - usedFinalizationBytes, options.artifactLimit ?? Infinity);
  if (grant < 1) throw new Error("integration has no admitted protected artifact capacity");
  const reservationId = stableUuid(`integration-artifacts:${missionId}:${inspection.revision}:${inspection.latestSeq}`);
  store.appendTransition(missionId, inspection.version, { events: [{ revision: inspection.revision, kind: "reservation.created",
    causalId: reservationId, payload: { reservationId, revision: inspection.revision, resource: "artifact-bytes", amount: grant, purpose: "finalization" } }] });
  inspection = store.inspectMission(missionId);
  const workspace = createMissionWorkspace({ ...options, attemptId: stableUuid(`integration:${missionId}:${inspection.revision}:${inspection.latestSeq}`),
    dependencyBacking: new MissionSetup(store, missionId).dependencyBacking(),
    storeRoot: store.storageRoot, allowedPaths: inspection.definition.authority.allowedPaths });
  const originalBaseImageHash = inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" && event.payload.phase === "base")?.payload.imageHash;
  const contributions: Array<Record<string, unknown>> = [];
  let retainedArtifactBytes = 0;
  try {
    for (const unitId of ordered) {
      const { outputHash, output, proof, base, terminal, input } = readAcceptedWorkspaceContribution(store, inspection, unitId);
      if (base && terminal && proof && input) {
        // Exclude accepted dependency inputs, but retain this unit's full checkpoint/recovery delta.
        const current = captureWorkspaceImage(workspace.candidateRoot);
        const merged = mergeWorkspaceImages(base, terminal, current);
        if (merged.conflicts.length) {
          const currentSeal = sealWorkspaceImage(current);
          const deliverySeal = sealWorkspaceImage(deliveryBase);
          const reason = `accepted contribution overlap: ${merged.conflicts.map(({ path }) => path).join(", ")}`;
          const bytes = Buffer.from(JSON.stringify({ format: "mission-integration-conflict-v1", missionId, revision: inspection.revision,
            unitId, outputHash, reason, paths: merged.conflicts.map(({ path }) => path), sourceBaseImageHash: proof.sourceBaseImageHash,
            contributionInput: input, intendedImageHash: proof.terminalImageHash, currentImageHash: currentSeal.imageHash, deliveryBaseImageHash: deliverySeal.imageHash, contributions }));
          const conflictArtifacts = [...currentSeal.artifacts, ...deliverySeal.artifacts, { bytes, mediaType: "application/json" }];
          const conflictBytes = conflictArtifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0);
          if (conflictBytes > grant) throw new Error(`${reason}; conflict artifacts exceed admitted capacity`);
          store.appendTransition(missionId, inspection.version, { events: [{ revision: inspection.revision, kind: "mission.blocked",
            causalId: stableUuid(`integration-conflict:${missionId}:${inspection.revision}:${inspection.latestSeq}`),
            payload: { reason, integrationConflictHash: sha256(bytes) } }],
            artifacts: conflictArtifacts });
          retainedArtifactBytes = conflictBytes;
          throw new Error(reason);
        }
        restoreWorkspaceImage(workspace, merged.files);
        contributions.push({ unitId, outputHash, sourceBaseImageHash: proof.sourceBaseImageHash,
          executionStartImageHash: proof.executionStartImageHash, contributionInput: input, terminalImageHash: proof.terminalImageHash, lineage: output.lineage });
      } else contributions.push({ unitId, outputHash, resultArtifactHash: output.resultArtifactHash });
    }
    const result = captureWorkspaceImage(workspace.candidateRoot);
    assertCompleteWorkspaceImage(result);
    const resultSeal = sealWorkspaceImage(result);
    const baseSeal = sealWorkspaceImage(deliveryBase);
    const patch = createConditionalMissionPatch(deliveryBase, result);
    const disposable = createMissionWorkspace({ ...options, attemptId: stableUuid(`patch-proof:${missionId}:${inspection.revision}:${inspection.latestSeq}`),
      dependencyBacking: new MissionSetup(store, missionId).dependencyBacking(),
      storeRoot: store.storageRoot, allowedPaths: [] });
    const reproduced = applyConditionalMissionPatch(patch, disposable);
    if (reproduced.hash !== patch.acceptedManifestHash || captureWorkspaceImage(options.sourceRoot).manifest.hash !== deliveryBase.manifest.hash)
      throw new Error("conditional patch or delivery base changed during integration");
    const patchBytes = Buffer.from(JSON.stringify(patch));
    const report = { format: "mission-integrated-result-v1", missionId, revision: inspection.revision,
      planHash: inspection.snapshot.planHash, definitionHash: inspection.snapshot.definitionHash,
      originalBaseImageHash: originalBaseImageHash ?? baseSeal.imageHash, deliveryBaseImageHash: baseSeal.imageHash,
      deliveryBaseManifestHash: deliveryBase.manifest.hash, resultImageHash: resultSeal.imageHash, resultManifestHash: result.manifest.hash,
      acceptedManifestHash: patch.acceptedManifestHash, patchHash: sha256(patchBytes),
      acceptedInputHash: sha256(Buffer.from(JSON.stringify(contributions))), contributions,
      candidateRoot: workspace.candidateRoot, conditionalPatchProof: { candidateRoot: disposable.candidateRoot, reproducedManifestHash: reproduced.hash },
      inputIdentity: { source: deliveryBase.manifest, predicates: inspection.definition.units.map(({ id, inputs, acceptance }) => ({ id, inputs, acceptance })),
        rolePolicies: inspection.definition.authority.rolePolicies,
        checks: inspection.events.filter((event) => event.kind === "evidence.recorded" && event.revision === inspection.revision &&
          [...accepted.values()].some((row) => Array.isArray(row?.payload.evidenceIds) && row.payload.evidenceIds.includes(event.payload.id)))
          .map((event) => ({ predicateId: event.payload.predicateId, predicateHash: event.payload.predicateHash,
            inputBindingHash: event.payload.inputBindingHash, assessmentToolIdentity: event.payload.assessmentToolIdentity,
            runtimeIdentity: event.payload.runtimeIdentity, rolePolicyHash: event.payload.rolePolicyHash, artifactHash: event.payload.artifactHash })) },
    };
    const reportBytes = Buffer.from(JSON.stringify(report));
    if (store.inspectMission(missionId).version !== inspection.version) throw new Error("integration inputs changed before publication");
    const artifacts = [...resultSeal.artifacts, ...baseSeal.artifacts, { bytes: patchBytes, mediaType: "application/json" }, { bytes: reportBytes, mediaType: "application/json" }];
    const artifactBytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0);
    if (artifactBytes > grant) throw new Error(`integration artifacts need ${artifactBytes} bytes; admitted grant is ${grant}`);
    store.appendTransition(missionId, inspection.version, { events: [{ revision: inspection.revision, kind: "budget.reservation.settled",
      causalId: stableUuid(`${reservationId}:settled`), payload: { reservationId, resource: "artifact-bytes", knownCharge: artifactBytes,
        unknownCharge: 0, released: grant - artifactBytes, source: "host integrated images, conditional patch and report" } },
      { revision: inspection.revision, kind: "mission.result.integrated",
      causalId: stableUuid(`integrated:${missionId}:${inspection.revision}:${inspection.latestSeq}`), payload: { reportHash: sha256(reportBytes),
        resultImageHash: resultSeal.imageHash, deliveryBaseManifestHash: deliveryBase.manifest.hash, acceptedInputHash: report.acceptedInputHash } }],
      artifacts });
    return report;
  } catch (error) {
    const current = store.inspectMission(missionId);
    if (current.revision === inspection.revision && !current.events.some((event) => event.kind === "budget.reservation.settled" && event.payload.reservationId === reservationId))
      store.appendTransition(missionId, current.version, { events: [{ revision: inspection.revision, kind: "budget.reservation.settled",
        causalId: stableUuid(`${reservationId}:failed`), payload: { reservationId, resource: "artifact-bytes", knownCharge: retainedArtifactBytes,
          unknownCharge: 0, released: grant - retainedArtifactBytes, source: "integration inconclusive before immutable output publication" } }] });
    quarantineCandidateRoot(workspace.candidateRoot, workspace.sourceRoot, workspace.candidateIdentity, workspace.candidateGitIdentity, `integration inconclusive: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export function applyConditionalMissionPatch(patch: ConditionalMissionPatch, workspace: MissionWorkspace): WorkspaceManifest {
  if (patch.format !== "mission-conditional-patch-v1") throw new Error("unsupported mission patch format");
  const identity = verifyPrivateCandidate(workspace.candidateRoot, workspace.sourceRoot);
  if (identity.identity !== workspace.candidateIdentity || identity.gitIdentity !== workspace.candidateGitIdentity) {
    throw new Error("conditional patch target is not the verified private delivery copy");
  }
  const observedSource = captureWorkspaceImage(workspace.sourceRoot).manifest;
  if (observedSource.hash !== patch.deliveryBaseManifestHash || workspace.manifest.hash !== patch.deliveryBaseManifestHash) {
    throw new Error(`mission patch precondition mismatch: expected ${patch.deliveryBaseManifestHash}, observed ${observedSource.hash}`);
  }
  const candidateImage = captureWorkspaceImage(workspace.candidateRoot);
  if (canonicalDeliveryManifest(candidateImage.manifest, workspace.manifest).hash !== patch.deliveryBaseManifestHash)
    throw new Error("mission patch preimage mismatch for private delivery copy");
  const changes = patch.changes.map(({ path: name, before, after }) => ({
    path: name, before: hydratePatchFile(before), after: hydratePatchFile(after),
  }));
  const files = new Map(candidateImage.files.map((file) => [file.path, file]));
  for (const change of changes) {
    const observed = files.get(change.path) ?? missingImage(change.path);
    if (!sameImage(observed, change.before)) throw new Error(`mission patch preimage mismatch at ${change.path}`);
    if (change.after.kind === "missing") files.delete(change.path);
    else files.set(change.path, change.after);
  }
  applyWorkspaceImageToRoot(workspace.candidateRoot, [...files.values()].sort((a, b) => a.path.localeCompare(b.path)));
  const accepted = canonicalDeliveryManifest(captureWorkspaceImage(workspace.candidateRoot).manifest, workspace.manifest);
  if (accepted.hash !== patch.acceptedManifestHash) {
    throw new Error(`mission patch result mismatch: expected ${patch.acceptedManifestHash}, observed ${accepted.hash}`);
  }
  return accepted;
}

export async function importLegacyMission(input: {
  store: MissionStore;
  repositoryRoot: string;
  planId: string;
  planFile: string;
  definitionFile: string;
  ledgerFile: string;
  evidence?: Array<{ path: string; file: string }>;
  admissionReceiptId: string;
  occurredAt?: string;
}): Promise<{ missionId: string; importKey: string; disposition: "imported" | "already_imported" | "conflict" | "unknown"; holdsKnown: boolean; warnings: string[] }> {
  const planId = assertPlanId(input.planId);
  const rawPlan = readFileSync(input.planFile);
  const rawLedger = readFileSync(input.ledgerFile);
  const evidence = (input.evidence ?? []).map(({ path: name, file }) => ({ path: name, bytes: readFileSync(file) }));
  const preview = input.store.previewLegacyImport({ planId, planBytes: rawPlan, ledgerBytes: rawLedger, evidence });
  if (preview.generatedLedger) return {
    missionId: "", importKey: "", disposition: "unknown", holdsKnown: false,
    warnings: [...preview.warnings, "generated managed ledger cannot be imported as legacy authority"],
  };
  const repositoryId = input.store.ensureRepositoryIdentity(input.repositoryRoot);
  const importKey = sha256(Buffer.from(`${repositoryId}\0${planId}\0${preview.ledgerHash}`));
  const archive: LegacyImportArchive = { importKey, preview, rawPlan, rawLedger, evidence };
  const prior = input.store.findMissionForPlan(input.repositoryRoot, planId);
  const commandId = stableUuid(`legacy-import-command:${importKey}`);
  const missionId = stableUuid(`legacy-import-mission:${importKey}`);
  if (prior) {
    const imported = prior.events.find((event) => event.kind === "mission.imported" && event.payload.importKey === importKey);
    if (prior.id === missionId && (!imported || imported.payload.planHash === preview.planHash)) {
      let stored;
      try { stored = input.store.recordLegacyImport(prior.id, prior.version, archive); }
      catch (error) {
        input.store.recordLegacyImportConflict(prior.id, input.store.inspectMission(prior.id).version, archive);
        return { missionId: prior.id, importKey, disposition: "conflict", holdsKnown: false, warnings: [error instanceof Error ? error.message : String(error)] };
      }
      writeMissionLocator(input.repositoryRoot, {
        format: "mission-locator-v1", missionId: prior.id, repositoryId: prior.repositoryId,
        planId, revision: prior.revision, eventSeq: stored.seq,
      });
      return { missionId: prior.id, importKey, disposition: imported ? "already_imported" : "imported", holdsKnown: stored.payload.holdsKnown === true, warnings: Array.isArray(stored.payload.warnings) ? stored.payload.warnings.map(String) : [] };
    }
    input.store.recordLegacyImportConflict(prior.id, prior.version, archive);
    return { missionId: prior.id, importKey, disposition: "conflict", holdsKnown: false, warnings: ["another mission, plan image, or legacy ledger already owns this repository and plan; exact conflicting bytes were archived"] };
  }
  let mission;
  try {
    mission = input.store.createMission({
      repositoryRoot: input.repositoryRoot,
      planId,
      planFile: input.planFile,
      definitionFile: input.definitionFile,
      commandId,
      admissionReceiptId: input.admissionReceiptId,
      missionId,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    });
  } catch (error) {
    const conflict = input.store.findMissionForPlan(input.repositoryRoot, planId);
    if (!conflict) throw error;
    input.store.recordLegacyImportConflict(conflict.id, conflict.version, archive);
    return { missionId: conflict.id, importKey, disposition: "conflict", holdsKnown: false, warnings: [error instanceof Error ? error.message : String(error)] };
  }
  const stored = input.store.recordLegacyImport(mission.id, mission.version, archive);
  writeMissionLocator(input.repositoryRoot, {
    format: "mission-locator-v1", missionId: mission.id, repositoryId: mission.repositoryId,
    planId, revision: mission.revision, eventSeq: stored.seq,
  });
  return { missionId: mission.id, importKey, disposition: "imported", holdsKnown: preview.holdsKnown, warnings: preview.warnings };
}

export interface MissionLocator {
  format: "mission-locator-v1";
  missionId: string;
  repositoryId: string;
  planId: string;
  revision: number;
  eventSeq: number;
}

export function readMissionLocator(repositoryRoot: string, planId: string): MissionLocator | undefined {
  const file = locatorPath(repositoryRoot, planId);
  try {
    const state = lstatSync(file);
    if (!state.isFile() || state.isSymbolicLink()) throw new Error("managed mission locator is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`managed mission locator is malformed: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("managed mission locator is malformed");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "eventSeq,format,missionId,planId,repositoryId,revision" ||
    row.format !== "mission-locator-v1" || row.planId !== assertPlanId(planId) || !isUuid(row.missionId) || !isUuid(row.repositoryId) ||
    !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !Number.isSafeInteger(row.eventSeq) || Number(row.eventSeq) < 1) {
    throw new Error("managed mission locator has invalid identity fields");
  }
  return row as unknown as MissionLocator;
}

export async function reconcileMission(options: ReconcileMissionOptions): Promise<RecoveryReport> {
  const { store, missionId } = options;
  const initial = store.inspectMission(missionId);
  // Recovery can account for a lost result without proving a terminal SDK pause.
  const lostResultSettlements = new Set(initial.events.filter((event) =>
    event.kind === "attempt.settled" && event.payload.status === "failed" &&
    event.payload.resultHash === null &&
    event.payload.recoveryDisposition === "interrupted-without-worker-result",
  ).map((event) => event.eventId));
  const scopedImage = (image: WorkspaceImage) => initial.definition.finalization.contractVersion === 1
    ? image : filterWorkspaceImage(image, initial.definition.authority.allowedPaths);
  const ownerProof = store.ownerAcquisitionProof;
  const previous = ownerProof?.previous as Record<string, unknown> | undefined;
  const owner = {
    source: typeof ownerProof?.source === "string" ? ownerProof.source : "unproven",
    epoch: store.ownerEpoch,
    previousEpoch: Number.isSafeInteger(previous?.epoch) ? Number(previous!.epoch) : null,
  };
  const blockers: string[] = [];
  const localObservations = new Set<string>();
  const scopedBlockers = new Map<string, { id: string; sourceEventId: string; proofHash: string; scope: "unit"; unitId: string }>();
  const pauseRecoveries = new Map<string, ReturnType<typeof pauseInterruption>>();
  const lifecycleSources = new Map<string, ReturnType<typeof lifecycleInterruption>>();
  const pauseTargets = options.orderlyPause && initial.events.find((event) =>
    event.kind === "mission.paused" && event.eventId === options.orderlyPause!.pauseEventId);
  for (const stopped of (Array.isArray(pauseTargets?.payload.stoppedAttempts) ? pauseTargets.payload.stoppedAttempts : []) as Array<{ attemptId: string }>) {
    // Reservation spends the proof, including a reservation followed by a crash.
    if (initial.events.some((event) => event.kind === "attempt.reserved" &&
      ((event.payload.binding as MissionAttemptBinding).recoveryOf === stopped.attemptId ||
        initial.events.some((row) => row.kind === "mission.recovery.continuation.recorded" &&
          row.payload.continuationId === (event.payload.binding as MissionAttemptBinding).recoveryContinuationId &&
          (row.payload.lifecycle as LifecycleRecovery | undefined)?.sourceAttemptId === stopped.attemptId)))) continue;
    // A close intent is not a completed SDK pause. A successor with an acquired
    // owner proof must reconcile an unreceipted attempt through crash recovery.
    if (pauseTargets?.payload.controlOrigin === "lifecycle" &&
      ["owner-death", "retirement"].includes(owner.source) &&
        !initial.events.some((event) => event.attemptId === stopped.attemptId &&
          (event.kind === "attempt.receipt" ||
            event.kind === "attempt.settled" && !lostResultSettlements.has(event.eventId)))) continue;
    try {
      const reserved = initial.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === stopped.attemptId);
      if (initial.definition.finalization.contractVersion === 1 && pauseTargets?.payload.controlOrigin === "lifecycle" &&
        (reserved?.payload.binding as MissionAttemptBinding | undefined)?.candidate === "managed") {
        lifecycleSources.set(stopped.attemptId, lifecycleInterruption(store, initial, stopped.attemptId));
        continue;
      }
      const interruption = pauseInterruption(store, initial, stopped.attemptId, options.sourceRoot, options.orderlyPause!.pauseEventId);
      if (interruption.binding.ownerEpoch === store.ownerEpoch) {
        if (ownerProcessState(interruption.proof.owner) !== "live" ||
          interruption.proof.runtimeId !== store.runtimeId) throw new Error("same-owner pause stop identity is not current");
      } else {
        const predecessorUse = initial.events.find((event) => event.kind === "mission.recovery.continuation.recorded" &&
          event.payload.sourceAttemptId === stopped.attemptId && event.payload.proofHash === interruption.proofHash &&
          event.payload.ownerEpoch === owner.previousEpoch);
        if (interruption.binding.ownerEpoch === owner.previousEpoch ?
          sha256(Buffer.from(JSON.stringify(interruption.proof.owner))) !== sha256(Buffer.from(JSON.stringify(previous?.owner))) : !predecessorUse)
          throw new Error("pause predecessor owner lineage is missing");
      }
      pauseRecoveries.set(stopped.attemptId, interruption);
    } catch (error) {
      const reason = `pause recovery denied for ${stopped.attemptId}: ${error instanceof Error ? error.message : String(error)}`;
      blockers.push(reason);
      const reserved = initial.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === stopped.attemptId);
      if (reserved?.unitId) scopedBlockers.set(reason, { id: `pause:${stopped.attemptId}`, sourceEventId: reserved.eventId,
        proofHash: sha256(Buffer.from(JSON.stringify(reserved.payload))), scope: "unit", unitId: reserved.unitId });
    }
  }
  if (store.ownerEpoch === null) blockers.push("mission store is read-only; another owner is live or death is unproven");
  const hasPriorWork = initial.events.some((event) => ["attempt.started", "attempt.interrupted", "effect.invoking", "effect.released"].includes(event.kind));
  if (previous) {
    const priorOwner = previous.owner as ProcessIdentity | undefined;
    let state: "live" | "dead" | "unknown" = "unknown";
    try { if (priorOwner) state = ownerProcessState(priorOwner); } catch { state = "unknown"; }
    if (state !== "dead" && owner.source === "owner-death") blockers.push(`prior mission owner death proof is no longer verifiable (${state})`);
    if (owner.source === "retirement") {
      const release = initial.events.find((event) => event.kind === "mission.owner.released" && event.eventId === ownerProof?.retirementEventId);
      if (!release || release.payload.effectsQuiescent !== true ||
        sha256(Buffer.from(JSON.stringify(release.payload.owner))) !== sha256(Buffer.from(JSON.stringify(previous.owner))))
        blockers.push("stored owner retirement acknowledgement does not prove effect quiescence");
    }
  }
  const sameOwnerPause = Boolean(pauseRecoveries.size && pauseTargets && pauseTargets.payload.ownerEpoch === store.ownerEpoch &&
    pauseTargets.payload.runtimeId === store.runtimeId && [...pauseRecoveries.values()].every(({ binding }) => binding.ownerEpoch === store.ownerEpoch));
  if (hasPriorWork && !["owner-death", "retirement"].includes(owner.source) && !sameOwnerPause) {
    blockers.push("prior mission owner release or positive death proof is missing");
  }
  const ownershipSafe = store.ownerEpoch !== null && !blockers.some((reason) => /owner|death proof|retirement acknowledgement/i.test(reason));

  let sourceImage: WorkspaceImage | undefined;
  let sourceAssociation: string | undefined;
  try {
    sourceAssociation = store.verifyRepositoryAssociation(options.sourceRoot);
    if (sourceAssociation !== initial.repositoryId) throw new Error("proposed source root belongs to a different repository family");
    sourceImage = captureWorkspaceImage(options.sourceRoot);
  } catch (error) {
    blockers.push(`source identity or inventory is unproven: ${error instanceof Error ? error.message : String(error)}`);
  }

  const storedPlanHash = initial.snapshot.planHash;
  let plan: RecoveryReport["plan"] = { status: "unavailable", storedHash: storedPlanHash, observedHash: null };
  if (initial.prepared) {
    try {
      const identity = missionInputIdentity(initial, options.sourceRoot);
      plan = { status: "unchanged", storedHash: storedPlanHash, observedHash: identity.pinHash,
        inputIdentityHash: sha256(Buffer.from(JSON.stringify(identity))), inputIdentity: identity };
    } catch {
      plan = { status: "malformed", storedHash: storedPlanHash, observedHash: null };
    }
  } else if (options.planFile) {
    try {
      const bytes = readFileSync(options.planFile);
      const observedHash = sha256(bytes);
      const observedPlan = parsePlanDocument(bytes.toString("utf8"));
      if (observedPlan.id !== initial.planId) throw new Error("plan id changed");
      plan = { status: observedHash === storedPlanHash ? "unchanged" : "changed", storedHash: storedPlanHash, observedHash };
    } catch (error) {
      plan = { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "malformed", storedHash: storedPlanHash, observedHash: null };
    }
  }
  const planCurrent = () => {
    try {
      if (initial.prepared) return plan.inputIdentityHash ===
        sha256(Buffer.from(JSON.stringify(missionInputIdentity(store.inspectMission(options.missionId), options.sourceRoot))));
      return !options.planFile || sha256(readFileSync(options.planFile)) === plan.observedHash;
    } catch (error) {
      return !initial.prepared && !!options.planFile && plan.status === "missing" &&
        (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  };

  const attempts = initial.events.filter((event) => event.kind === "attempt.reserved").map((event) => ({
    event,
    binding: event.payload.binding as Record<string, unknown>,
    attemptId: String(event.payload.attemptId),
  }));
  const pending = attempts.filter(({ attemptId }) => {
    const relevant = initial.events.filter((event) => event.attemptId === attemptId || event.payload.attemptId === attemptId);
    return !relevant.some((event) => event.kind === "attempt.settled" &&
      !lostResultSettlements.has(event.eventId)) && (
      relevant.some((event) => event.kind === "attempt.interrupted") ||
      (relevant.some((event) => event.kind === "attempt.started") && !relevant.some((event) => event.kind === "attempt.receipt"))
    );
  });
  const candidateRoots = new Map<string, string>();
  const candidateRelocations: Array<{ attemptId: string; registration: CandidateRegistration; fromRoot: string; toRoot: string; history: string[] }> = [];
  if (ownershipSafe) for (const { attemptId, binding } of attempts) {
    const registration = candidateRegistrationForAttempt(initial.events, attemptId, binding, {
      missionId, repositoryId: initial.repositoryId, ownerEpoch: Number(binding.ownerEpoch),
    });
    if (!registration) continue;
    const root = discoverPrivateCandidate(registration, options.sourceRoot);
    if (!root) continue;
    candidateRoots.set(attemptId, root);
    const history = candidateLocationHistory(initial.events, attemptId, registration.root);
    const fromRoot = history.at(-1) ?? registration.root;
    if (root !== fromRoot) candidateRelocations.push({ attemptId, registration, fromRoot, toRoot: root, history: [...history, root] });
  }
  const effects = ownershipSafe ? await observeEffects(
    initial.events, options, blockers, candidateRoots, initial.definition.authority.externalEffects,
  ) : [];
  const effectsWithBlockers = effects.map((effect) => {
    if (effect.disposition === "unknown") {
      const reason = `effect ${effect.effectId} remains unknown: ${effect.reason}`;
      blockers.push(reason);
      const intent = initial.events.find((event) => event.kind === "effect.intent" && event.effectId === effect.effectId);
      const attempt = attempts.find((row) => row.attemptId === effect.attemptId);
      const unitId = attempt?.binding.unitId;
      const binding = intent?.payload;
      if (intent && binding && typeof unitId === "string" && initial.definition.units.some((unit) => unit.id === unitId) &&
        (effect.operation.startsWith("external:") || binding?.recovery === "external-probe-required") &&
        typeof binding.grantId === "string" && initial.definition.authority.externalEffects.includes(binding.grantId) &&
        typeof binding.target === "string" && binding.target &&
        typeof (binding.operationKey ?? binding.idempotencyKey) === "string" &&
        /^[0-9a-f]{64}$/.test(String(binding.requestHash)) &&
        typeof binding.adapterId === "string" && binding.adapterId &&
        typeof binding.adapterVersion === "string" && binding.adapterVersion) {
        scopedBlockers.set(reason, { id: `effect:${effect.effectId}`, sourceEventId: intent.eventId,
          proofHash: sha256(Buffer.from(JSON.stringify(intent.payload))), scope: "unit", unitId });
      }
    }
    return effect;
  });
  const pendingAttemptIds = new Set(pending.map(({ attemptId }) => attemptId));
  const acceptedBeforeRecovery = new Set(initial.events.filter((event) => event.kind === "unit.accepted")
    .map((event) => String(event.payload.unitId ?? event.unitId ?? "")));
  const effectRecoveryAttempts = attempts.filter(({ attemptId, event, binding }) => !pendingAttemptIds.has(attemptId) &&
    acceptedBeforeRecovery.has(String(binding.unitId ?? event.unitId ?? "")) &&
    effectsWithBlockers.some((effect) => effect.attemptId === attemptId && ["partial", "not-applied"].includes(effect.disposition)))
    .filter(({ attemptId, event, binding }) => {
      if (binding.ownerEpoch !== store.ownerEpoch) return true;
      const reason = `attempt ${attemptId} belongs to the live owner but has no exact pause stop proof`;
      blockers.push(reason);
      scopedBlockers.set(reason, { id: `pause:${attemptId}`, sourceEventId: event.eventId,
        proofHash: sha256(Buffer.from(JSON.stringify(event.payload))), scope: "unit", unitId: String(binding.unitId) });
      return false;
    });
  const ordinaryPending = pending.filter((attempt) => {
    const pauseLineage = attempt.binding.recoveryOf || initial.events.some((event) =>
      event.kind === "mission.recovery.continuation.recorded" && event.payload.pauseEventId &&
      event.payload.continuationId === attempt.binding.recoveryContinuationId);
    if (!pauseLineage && attempt.binding.ownerEpoch !== store.ownerEpoch) return true;
    const reason = `attempt ${attempt.attemptId} has no new terminal pause proof; predecessor recovery authority cannot be spent again`;
    blockers.push(reason);
    scopedBlockers.set(reason, { id: `pause:${attempt.attemptId}`, sourceEventId: attempt.event.eventId,
      proofHash: sha256(Buffer.from(JSON.stringify(attempt.event.payload))), scope: "unit", unitId: String(attempt.binding.unitId) });
    return false;
  });
  const recoveryAttempts = [...ordinaryPending, ...effectRecoveryAttempts,
    ...attempts.filter(({ attemptId }) => pauseRecoveries.has(attemptId) || lifecycleSources.has(attemptId))];
  const effectReviewUnitIds = new Set(effectsWithBlockers.filter(({ disposition }) =>
    ["partial", "not-applied", "unknown"].includes(disposition)).flatMap(({ attemptId }) => {
    const attempt = attempts.find((row) => row.attemptId === attemptId);
    return attempt ? [String(attempt.binding.unitId ?? attempt.event.unitId ?? "")] : [];
  }));
  const { holds: importedHolds, malformed: malformedImportedHolds } = latestImportedHolds(initial.events);
  const definitionUnitIds = new Set(initial.definition.units.map((unit) => unit.id));
  const importedEvent = [...initial.events].reverse().find((event) => event.kind === "mission.imported");
  const holdIsReconciled = (holdId: string) => Boolean(importedEvent && Array.isArray(importedEvent.payload.holds) &&
    importedEvent.payload.holds.some((hold: Record<string, unknown>) => hold?.holdId === holdId &&
      importedHoldReconciled(store, initial.events, importedEvent, hold)));
  const legacyConflicts = initial.events.filter((event) => event.kind === "mission.import.conflict").map((event) => ({
    eventId: event.eventId, importKey: String(event.payload.importKey),
    archiveHashes: Array.isArray(event.payload.archiveHashes) ? event.payload.archiveHashes.map(String) : [],
  }));
  if (legacyConflicts.length) blockers.push("conflicting legacy ledger bytes are archived but unresolved; no second mission was created");
  const candidateEvidence = attempts.map(({ attemptId }) => {
    const identitySnapshot = initial.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
      event.attemptId === attemptId && event.payload.phase === "base");
    const candidateRoot = candidateRoots.get(attemptId) ?? "";
    let currentManifestHash: string | null = null;
    if (identitySnapshot && candidateRoot && candidateIdentityMatches(candidateRoot, identitySnapshot.payload, options.sourceRoot)) {
      try { currentManifestHash = captureWorkspaceImage(candidateRoot).manifest.hash; } catch { /* missing candidates use sealed observations */ }
    }
    return {
      attemptId,
      candidateRoot: candidateRoot || null,
      baseImageHash: typeof identitySnapshot?.payload.imageHash === "string" ? identitySnapshot.payload.imageHash : null,
      currentManifestHash,
      effects: initial.events.filter((event) => event.attemptId === attemptId && event.effectId && event.kind !== "effect.reconciled")
        .map((event) => [event.kind, event.effectId, sha256(Buffer.from(JSON.stringify(event.payload)))]),
    };
  });
  const episodeId = sha256(Buffer.from(JSON.stringify({
    missionId, trigger: options.trigger ?? "startup", revision: initial.revision,
    source: sourceImage?.manifest.hash ?? null, plan: [plan.status, plan.observedHash], ownerEpoch: store.ownerEpoch,
    candidateEvidence, orderlyPause: options.orderlyPause?.pauseEventId,
    ...(options.orderlyPause ? { controlEventId: [...initial.events].reverse().find((event) =>
      ["mission.paused", "mission.resumed", "mission.cancelled"].includes(event.kind))?.eventId } : {}),
    pauseProofs: [...pauseRecoveries].map(([id, value]) => [id, value.proofHash]),
    effects: effectsWithBlockers.map(({ effectId, disposition }) => [effectId, disposition]),
    holds: importedHolds.map(({ holdId }) => [holdId, holdIsReconciled(holdId)]),
    holdsKnown: importedEvent?.payload.holdsKnown ?? null, importedEventId: importedEvent?.eventId ?? null, legacyConflicts,
  })));
  const previousReport = [...initial.events].reverse().find((event) => event.kind === "mission.recovery.recorded" && event.payload.episodeId === episodeId);
  if (previousReport && typeof previousReport.payload.reportHash === "string") {
    try {
      const saved = JSON.parse(store.readArtifact(previousReport.payload.reportHash).toString("utf8")) as RecoveryReport;
      const overlapNeedsRouting = saved.format === "mission-recovery-report-v2" && saved.episodeId === episodeId &&
        saved.blockers.some((reason) => /semantic source overlap|internal conflict/i.test(reason));
      if (!malformedImportedHolds && saved.format === "mission-recovery-report-v2" && saved.episodeId === episodeId && (!overlapNeedsRouting || !options.resolveOverlap)) return saved;
    } catch { /* regenerate report when its sealed artifact is missing or corrupt */ }
  }
  let candidateRoot: string | null = null;
  let candidateImageHash: string | null = null;
  let acceptedManifestHash: string | null = null;
  let candidateWorkspaceManifestHash: string | null = null;
  let patchHash: string | null = null;
  let deliveryBaseManifestHash: string | null = sourceImage?.manifest.hash ?? null;
  let restored = false;
  let stale = { retained: [] as string[], invalidated: [] as string[] };
  const frontier: string[] = [];
  const overlapAttempts = new Set<string>();
  const diagnoses: RecoveryReport["diagnoses"] = [];
  const lifecycleAdmissions: LifecycleRecovery[] = [];
  let patch: ConditionalMissionPatch | undefined;
  let finalCandidateImage: WorkspaceImage | undefined;
  let originalBaseImage: WorkspaceImage | undefined;
  const firstBaseSnapshot = initial.events.find((event) => event.kind === "workspace.snapshot.sealed" && event.payload.phase === "base");
  if (firstBaseSnapshot && typeof firstBaseSnapshot.payload.imageHash === "string") {
    try { originalBaseImage = readSealedWorkspaceImage(store, firstBaseSnapshot.payload.imageHash); }
    catch (error) { blockers.push(`sealed source baseline is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }

  if (sourceImage && recoveryAttempts.length > 0 && ownershipSafe) {
    for (const attempt of recoveryAttempts) {
      const pauseRecovery = pauseRecoveries.get(attempt.attemptId);
      if (pauseRecovery) {
        try {
          if (plan.status !== "unchanged") throw new Error("pause plan or revision changed");
          // Observe the stopped tree, never infer it from the yielded parent's checkpoint.
          if (!missionEffectProcessesQuiescent(store.inspectMission(missionId).events, attempt.attemptId))
            throw new Error("pause effect namespace is not freshly quiescent");
          if (pauseRecovery.binding.candidate === "managed") {
            const image = readSealedWorkspaceImage(store, pauseRecovery.proof.observedImageHash);
            const root = candidateRoots.get(attempt.attemptId);
            if (root) {
              const stopped = captureWorkspaceImage(root);
              const observed = initial.definition.finalization.contractVersion === 1
                ? { ...stopped, manifest: canonicalDeliveryManifest(stopped.manifest, image.manifest) } : scopedImage(stopped);
              if (sealWorkspaceImage(observed).imageHash !== pauseRecovery.proof.observedImageHash)
                throw new Error("stopped candidate changed since pause image");
            }
            const observation: MissionEventDraft = {
              revision: initial.revision, kind: "workspace.snapshot.sealed", attemptId: attempt.attemptId,
              unitId: String(attempt.binding.unitId),
              causalId: stableUuid(`pause-observation:${episodeId}:${attempt.attemptId}`),
              payload: { attemptId: attempt.attemptId, phase: "recovered", imageHash: pauseRecovery.proof.observedImageHash,
                manifestHash: image.manifest.hash, candidateRoot: null, pauseEventId: pauseRecovery.proof.pauseEventId,
                proofHash: pauseRecovery.proofHash },
            };
            await appendRecoveryEvents(store, missionId, initial.revision, [observation], [], () =>
              store.ownerEpoch === owner.epoch && recoveryObservationCurrent(store.inspectMission(missionId).events, initial.latestSeq, localObservations) &&
              !!pauseInterruption(store, store.inspectMission(missionId), attempt.attemptId, options.sourceRoot, pauseRecovery.proof.pauseEventId));
            localObservations.add(observation.causalId);
          }
          frontier.push(String(attempt.binding.unitId));
        } catch (error) {
          pauseRecoveries.delete(attempt.attemptId);
          const reason = `pause observation denied for ${attempt.attemptId}: ${error instanceof Error ? error.message : String(error)}`;
          blockers.push(reason);
          scopedBlockers.set(reason, { id: `pause:${attempt.attemptId}`, sourceEventId: attempt.event.eventId,
            proofHash: sha256(Buffer.from(JSON.stringify(attempt.event.payload))), scope: "unit", unitId: String(attempt.binding.unitId) });
        }
        continue;
      }
      const diagnosisUses: Array<{ resultHash: string; fingerprint: string; revision: number; ownerEpoch: number; observedSeq: number; sourceEventId: string; sourceProofHash: string }> = [];
      let currentUse: (() => boolean) | undefined;
      const lifecycleSource = lifecycleSources.get(attempt.attemptId);
      const baseSnapshot = initial.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
        event.attemptId === attempt.attemptId && event.payload.phase === "base");
      if (!baseSnapshot || typeof baseSnapshot.payload.imageHash !== "string") {
        blockers.push(`attempt ${attempt.attemptId} has no sealed source baseline; safe three-way recovery is unavailable`);
        continue;
      }
      const historicalInput = lifecycleSource && readContributionInput(store, {
        ...initial, revision: lifecycleSource.binding.revision, definition: lifecycleSource.definition,
      }, lifecycleSource.binding);
      const baseImage = readSealedWorkspaceImage(store, historicalInput?.baseImageHash ?? baseSnapshot.payload.imageHash);
      originalBaseImage ??= baseImage;
      const recordedRoot = String(attempt.binding.candidateRoot ?? "");
      const proposedRoot = candidateRoots.get(attempt.attemptId) ?? "";
      let missionImage: WorkspaceImage | undefined;
      let liveRoot: string | undefined;
      const identitySnapshot = initial.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
        event.attemptId === attempt.attemptId && event.payload.phase === "base");
      if (!lifecycleSource && proposedRoot && isPrivateCandidate(proposedRoot, options.sourceRoot) && identitySnapshot &&
        candidateIdentityMatches(proposedRoot, identitySnapshot.payload, options.sourceRoot)) {
        liveRoot = proposedRoot;
        try { missionImage = scopedImage(captureWorkspaceImage(proposedRoot)); }
        catch { missionImage = undefined; }
      }
      if (lifecycleSource) missionImage = readSealedWorkspaceImage(store, lifecycleSource.proof.observedImageHash);
      if (!missionImage) {
        const latest = [...initial.events].reverse().find((event) => event.kind === "workspace.snapshot.sealed" &&
          event.attemptId === attempt.attemptId && event.payload.phase !== "base" &&
          event.payload.purpose !== "execution-start" && typeof event.payload.imageHash === "string");
        if (latest) missionImage = readSealedWorkspaceImage(store, String(latest.payload.imageHash));
      }
      if (!missionImage) {
        blockers.push(recordedRoot
          ? `attempt ${attempt.attemptId} candidate is missing and no sealed after-image proves its interrupted bytes; base snapshot was not treated as recovered work`
          : `attempt ${attempt.attemptId} has no recoverable private candidate image`);
        continue;
      }
      const partialEffect = effectsWithBlockers.find((effect) => effect.attemptId === attempt.attemptId && effect.disposition === "partial");
      if (liveRoot && partialEffect && identitySnapshot) quarantineCandidateRoot(liveRoot, options.sourceRoot,
        String(identitySnapshot.payload.candidateIdentity), String(identitySnapshot.payload.candidateGitIdentity),
        `recovered partial effect ${partialEffect.effectId}; fresh-candidate repair only`);
      if (!liveRoot && !lifecycleSource) {
        const sealed = sealWorkspaceImage(missionImage);
        const observationId = stableUuid(`recovery-observation:${attempt.attemptId}:${sealed.imageHash}`);
        await appendRecoveryEvent(store, missionId, initial.revision, {
          revision: initial.revision, kind: "workspace.snapshot.sealed", causalId: observationId,
          attemptId: attempt.attemptId, unitId: String(attempt.binding.unitId),
          payload: { attemptId: attempt.attemptId, phase: "observed", imageHash: sealed.imageHash, manifestHash: missionImage.manifest.hash, candidateRoot: null },
        }, sealed.artifacts);
        localObservations.add(observationId);
      }
      let allowedSourceImage = scopedImage(sourceImage);
      let lifecycle: LifecycleRecovery | undefined;
      let basisArtifacts: Array<{ bytes: Uint8Array; mediaType: string }> = [];
      if (lifecycleSource) {
        const unit = initial.definition.units.find(({ id }) => id === lifecycleSource.binding.unitId);
        if (!unit || unit.role !== lifecycleSource.binding.role || unit.kind !== "implementation" ||
          lifecycleSource.binding.roundId !== "main" || lifecycleSource.binding.memberId !== "solo" ||
          lifecycleSource.binding.targetId && lifecycleSource.binding.targetId !== unit.id ||
          plan.status !== "unchanged") {
          blockers.push(`lifecycle source ${attempt.attemptId} has no current unit or plan mapping`);
          continue;
        }
        const owned = mergeWorkspaceImages(baseImage, missionImage, baseImage);
        if (owned.changedPaths.some((name) => !allowedPathMatches(name, initial.definition.authority.allowedPaths))) {
          blockers.push(`lifecycle source ${attempt.attemptId} exceeds current allowed paths`);
          continue;
        }
        const dependencyOutputs: ContributionInput["dependencyOutputs"] = [];
        const visited = new Set<string>();
        const restoreDependency = (id: string) => {
          if (visited.has(id)) return;
          for (const parent of initial.definition.units.find((row) => row.id === id)!.dependencies.slice().sort()) restoreDependency(parent);
          visited.add(id);
          const { outputHash, output, base, terminal } = readAcceptedWorkspaceContribution(store, initial, id);
          dependencyOutputs.push({ unitId: id, attemptId: output.attemptId, outputBindingHash: outputHash });
          if (base && terminal) {
            const merged = mergeWorkspaceImages(base, terminal, allowedSourceImage);
            if (merged.conflicts.length) throw new Error("current dependency output overlap");
            allowedSourceImage = imageFromFiles(allowedSourceImage.manifest, merged.files);
          }
        };
        for (const id of unit.dependencies.slice().sort()) restoreDependency(id);
        const basis = sealWorkspaceImage(allowedSourceImage);
        basisArtifacts = basis.artifacts;
        lifecycle = {
          sourceAttemptId: attempt.attemptId, proofHash: lifecycleSource.proofHash,
          pauseEventId: lifecycleSource.pause.eventId, retirementEventId: lifecycleSource.release.eventId,
          historicalBaseImageHash: historicalInput!.baseImageHash, observedImageHash: lifecycleSource.proof.observedImageHash,
          basisImageHash: basis.imageHash, dependencyOutputs, definitionHash: initial.snapshot.definitionHash,
          sourceManifestHash: sourceImage.manifest.hash, ownerEpoch: owner.epoch!,
          acquisitionProofHash: sha256(Buffer.from(JSON.stringify(store.ownerAcquisitionProof))), observedSeq: initial.latestSeq,
          controlEventId: [...initial.events].reverse().find((row) => ["mission.paused", "mission.resumed", "mission.cancelled"].includes(row.kind))?.eventId ?? null,
        };
      }
      const merged = mergeWorkspaceImages(baseImage, missionImage, allowedSourceImage);
      let mergedFiles = merged.files;
      if (merged.conflicts.length) {
        const fingerprint = fingerprintOverlap(attempt.attemptId, baseImage, missionImage, allowedSourceImage, merged.conflicts, plan,
          initial.revision, initial.definition.authority.rolePolicies);
        const request: RecoveryOverlapRequest = {
          missionId, fingerprint, attemptId: attempt.attemptId, unitId: String(attempt.binding.unitId),
          conflicts: merged.conflicts, sourceManifestHash: sourceImage.manifest.hash, planStatus: plan.status,
        };
        const developer = await runOverlapDisposition(store, initial.revision, initial.latestSeq, localObservations, request, "developer", options.resolveOverlap?.diagnose);
        diagnoses.push({ fingerprint, role: "developer", disposition: developer.answer.disposition, reason: developer.answer.reason, resultHash: developer.resultHash });
        let disposition = developer.answer;
        let dispositionHash = developer.resultHash;
        if (disposition.disposition === "genuine-conflict") {
          const expert = await runOverlapDisposition(store, initial.revision, initial.latestSeq, localObservations, request, "expert", options.resolveOverlap?.expertDisposition, developer.answer);
          diagnoses.push({ fingerprint, role: "expert", disposition: expert.answer.disposition, reason: expert.answer.reason, resultHash: expert.resultHash });
          disposition = expert.answer;
          dispositionHash = expert.resultHash;
        }
        if (disposition.disposition === "compatible" && disposition.resolutions) {
          currentUse = () => {
            const current = store.inspectMission(missionId);
            const affectsUnit = (unitId: string, target = request.unitId): boolean => unitId === target ||
              Boolean(initial.definition.units.find((unit) => unit.id === target)?.dependencies.some((dependency) => affectsUnit(unitId, dependency)));
            return ownershipSafe && store.ownerEpoch === owner.epoch && current.revision === initial.revision &&
              recoveryObservationCurrent(current.events, initial.latestSeq, localObservations) &&
              !blockers.some((reason) => !scopedBlockers.has(reason) || affectsUnit(scopedBlockers.get(reason)!.unitId)) &&
              !legacyConflicts.length && !malformedImportedHolds && !(importedEvent && importedEvent.payload.holdsKnown !== true) &&
              !importedHolds.some(({ holdId, unitId, known }) => !known ||
                !holdIsReconciled(holdId) &&
                (!unitId || !definitionUnitIds.has(unitId) || affectsUnit(unitId))) &&
              [...current.events].reverse().find((event) => ["mission.paused", "mission.resumed", "mission.cancelled"].includes(event.kind))?.kind !== "mission.paused" &&
              !current.events.some((event) => event.kind === "mission.cancelled") &&
              store.verifyRepositoryAssociation(options.sourceRoot) === sourceAssociation &&
              captureWorkspaceImage(options.sourceRoot).manifest.hash === sourceImage.manifest.hash &&
              planCurrent();
          };
          if (!currentUse()) {
            overlapAttempts.add(attempt.attemptId);
            const reason = `compatible diagnosis cannot apply until recovery causes are reclassified for ${request.unitId}`;
            blockers.push(reason);
            if (!legacyConflicts.length && !blockers.some((blocker) => blocker !== reason && !scopedBlockers.has(blocker))) {
              scopedBlockers.set(reason, { id: `overlap:${fingerprint}`, sourceEventId: attempt.event.eventId,
                proofHash: fingerprint, scope: "unit", unitId: request.unitId });
            }
            continue;
          }
          mergedFiles = applyOverlapResolutions(merged.files, disposition.resolutions);
          const completed = [...store.inspectMission(missionId).events].reverse().find((event) =>
            event.kind === "mission.recovery.diagnosed" && event.payload.status === "completed" &&
            event.payload.resultHash === dispositionHash &&
            event.payload.fingerprint === fingerprint);
          const start = completed && store.inspectMission(missionId).events.find((event) => event.kind === "mission.recovery.diagnosed" &&
            event.payload.status === "started" && event.payload.diagnosisId === completed.payload.diagnosisId);
          if (!completed || !start?.payload.admission) throw new Error("compatible diagnosis lacks bound evidence");
          const admission = start.payload.admission as RecoveryDiagnosisAdmission;
          diagnosisUses.push({ resultHash: String(completed.payload.resultHash), fingerprint, revision: initial.revision,
            ownerEpoch: owner.epoch!, observedSeq: initial.latestSeq, sourceEventId: admission.sourceEventId,
            sourceProofHash: admission.sourceProofHash });
        } else {
          overlapAttempts.add(attempt.attemptId);
          const reason = `semantic source overlap remains unresolved for ${merged.conflicts.map(({ path: name }) => name).join(", ")}: ${disposition.question ?? disposition.reason}`;
          blockers.push(reason);
          if (initial.definition.units.some((unit) => unit.id === request.unitId)) scopedBlockers.set(reason, {
            id: `overlap:${fingerprint}`, sourceEventId: attempt.event.eventId,
            proofHash: fingerprint, scope: "unit", unitId: request.unitId,
          });
        }
      }
      const image: WorkspaceImage = {
        manifest: sourceImage.manifest,
        files: mergedFiles,
      };
      try {
        const parent = options.candidateParent ?? path.join(path.dirname(store.storageRoot), `${path.basename(store.storageRoot)}-candidates`);
        const workspace = createMissionWorkspace({
          dependencyBacking: new MissionSetup(store, missionId).dependencyBacking(),
          missionId, attemptId: stableUuid(`${attempt.attemptId}:recovery-candidate`),
          sourceRoot: options.sourceRoot, storeRoot: store.storageRoot, candidateParent: parent,
          allowedPaths: initial.definition.authority.allowedPaths, productRoot: options.productRoot, bwrapPath: options.bwrapPath,
        });
        await preflightContainment(workspace);
        if (currentUse && !currentUse()) {
          throw new Error("recovery observation changed before recovered snapshot publication");
        }
        restoreWorkspaceImage(workspace, image.files);
        finalCandidateImage = captureWorkspaceImage(workspace.candidateRoot);
        candidateRoot = workspace.candidateRoot;
        const sealed = sealWorkspaceImage(scopedImage(finalCandidateImage));
        candidateImageHash = sealed.imageHash;
        candidateWorkspaceManifestHash = finalCandidateImage.manifest.hash;
        restored = true;
        patch = createConditionalMissionPatch(sourceImage, finalCandidateImage);
        acceptedManifestHash = patch.acceptedManifestHash;
        patchHash = sha256(Buffer.from(JSON.stringify(patch)));
        const snapshotEvent: MissionEventDraft = {
          revision: initial.revision, kind: "workspace.snapshot.sealed",
          causalId: stableUuid(`recovered-workspace:${attempt.attemptId}:${candidateImageHash}`),
          unitId: String(attempt.binding.unitId), attemptId: attempt.attemptId,
          payload: {
            attemptId: attempt.attemptId, phase: "recovered", imageHash: candidateImageHash,
            manifestHash: finalCandidateImage.manifest.hash, candidateRoot,
            candidateIdentity: workspace.candidateIdentity, candidateGitIdentity: workspace.candidateGitIdentity,
            ...(diagnosisUses.length ? { diagnosisUses: [...diagnosisUses] } : {}),
            ...(lifecycle ? { lifecycle, proofHash: lifecycle.proofHash, episodeId } : {}),
          },
        };
        await appendRecoveryEvents(store, missionId, initial.revision, [snapshotEvent], [...basisArtifacts, ...sealed.artifacts,
          { bytes: Buffer.from(JSON.stringify(patch)), mediaType: "application/octet-stream" }],
          () => (!currentUse || currentUse()) && store.ownerEpoch === owner.epoch &&
            recoveryObservationCurrent(store.inspectMission(missionId).events, initial.latestSeq, localObservations) &&
            captureWorkspaceImage(options.sourceRoot).manifest.hash === sourceImage.manifest.hash &&
            planCurrent());
        localObservations.add(snapshotEvent.causalId);
        if (lifecycle) lifecycleAdmissions.push(lifecycle);
        frontier.push(String(attempt.binding.unitId));
      } catch (error) {
        blockers.push(`private candidate restoration failed for ${attempt.attemptId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (sourceImage) {
    const observedEvidenceImage = scopedImage(finalCandidateImage ?? sourceImage);
    if (originalBaseImage) stale = staleEvidence(store, initial.events, initial.definition.units, initial.definition.authority.rolePolicies,
      initial.definition.authority.allowedPaths, originalBaseImage, observedEvidenceImage, plan.status !== "unchanged",
      options.assessmentToolIdentity, options.runtimeIdentity);
    else stale = { retained: [], invalidated: initial.events.filter((event) => event.kind === "evidence.recorded")
      .map((event) => String(event.payload.id ?? event.payload.evidenceId ?? "")).filter(Boolean) };
  } else {
    stale = { retained: [], invalidated: initial.events.filter((event) => event.kind === "evidence.recorded")
      .map((event) => String(event.payload.id ?? event.payload.evidenceId ?? "")).filter(Boolean) };
  }

  const holds = importedHolds.map(({ holdId, unitId, known }) => {
    const resolved = holdIsReconciled(holdId);
    return { holdId, ...(unitId ? { unitId } : {}), disposition: !known ? "unknown" as const : resolved ? "reconciled_without_outcome" as const : "unresolved" as const };
  });
  if (malformedImportedHolds || importedEvent && importedEvent.payload.holdsKnown !== true) blockers.push("legacy Team holds are malformed or unknown; no hold was cleared");
  if (holds.some(({ disposition }) => disposition === "unknown")) blockers.push("legacy Team holds are malformed or unknown; no hold was cleared");
  if (holds.some(({ disposition }) => disposition === "unresolved")) {
    const reason = "one or more exact legacy Team holds remain unresolved";
    blockers.push(reason);
    if (importedEvent && holds.filter(({ disposition }) => disposition === "unresolved").every(({ unitId }) =>
      unitId && definitionUnitIds.has(unitId))) {
      for (const hold of holds.filter(({ disposition }) => disposition === "unresolved")) {
        scopedBlockers.set(`${reason}:${hold.holdId}`, { id: `hold:${hold.holdId}`,
          sourceEventId: importedEvent.eventId, proofHash: sha256(Buffer.from(JSON.stringify(importedEvent.payload))),
          scope: "unit", unitId: hold.unitId! });
      }
    }
  }

  for (const event of initial.events.filter((row) => row.kind === "evidence.recorded" &&
    effectReviewUnitIds.has(String(row.payload.unitId ?? row.unitId ?? "")))) {
    const evidenceId = String(event.payload.id ?? event.payload.evidenceId ?? "");
    if (evidenceId) {
      stale.invalidated = [...new Set([...stale.invalidated, evidenceId])].sort();
      stale.retained = stale.retained.filter((id) => id !== evidenceId);
    }
  }
  const changedPaths = sourceImage ? changedImagePaths(originalBaseImage, scopedImage(sourceImage)) : [];
  const unknownAttempts = new Set(effectsWithBlockers.filter(({ disposition }) => disposition === "unknown").map(({ attemptId }) => attemptId));
  const unknownEffectUnits = new Set(effectsWithBlockers.filter(({ disposition }) => disposition === "unknown").flatMap(({ attemptId }) => {
    const attempt = attempts.find((row) => row.attemptId === attemptId);
    return attempt ? [String(attempt.binding.unitId ?? attempt.event.unitId ?? "")] : [];
  }));
  const unresolvedHoldUnits = new Set(holds.filter(({ disposition }) => disposition !== "reconciled_without_outcome")
    .map(({ unitId }) => unitId).filter((id): id is string => Boolean(id)));
  const heldUnits = new Set(unresolvedHoldUnits);
  let holdDependencyChanged = true;
  while (holdDependencyChanged) {
    holdDependencyChanged = false;
    for (const unit of initial.definition.units) {
      if (heldUnits.has(unit.id) || !unit.dependencies.some((dependency) => heldUnits.has(dependency))) continue;
      heldUnits.add(unit.id);
      holdDependencyChanged = true;
    }
  }
  const unknownHoldScope = malformedImportedHolds || Boolean(importedEvent && importedEvent.payload.holdsKnown !== true) ||
    holds.some(({ disposition, unitId }) => disposition === "unknown" || disposition === "unresolved" && !definitionUnitIds.has(unitId ?? ""));
  const staleEvidenceIds = new Set(stale.invalidated);
  const staleUnitIds = new Set(initial.events.filter((event) => event.kind === "evidence.recorded" &&
    staleEvidenceIds.has(String(event.payload.id ?? event.payload.evidenceId ?? ""))).map((event) => String(event.payload.unitId ?? event.unitId ?? "")));
  const acceptedUnits = acceptedUnitIds(initial.events, staleUnitIds);
  for (const unitId of [...heldUnits, ...unknownEffectUnits]) acceptedUnits.delete(unitId);
  const readyCandidates = new Set(sourceImage ? frontier.filter((unitId) => {
    const attempt = recoveryAttempts.find(({ binding }) => binding.unitId === unitId);
    return Boolean(attempt && !unknownAttempts.has(attempt.attemptId) && !overlapAttempts.has(attempt.attemptId) && !heldUnits.has(unitId) &&
      !unknownEffectUnits.has(unitId) && initial.definition.units.find((unit) => unit.id === unitId)?.dependencies.every((dependency) => acceptedUnits.has(dependency)));
  }) : []);
  for (const unit of initial.definition.units) {
    if (heldUnits.has(unit.id) || unknownEffectUnits.has(unit.id) || unit.dependencies.some((dependency) => !acceptedUnits.has(dependency))) continue;
    const status = unitStatus(initial.events, unit.id);
    if ((status === "pending" || status === "ready" || (status === "accepted" && staleUnitIds.has(unit.id))) &&
      !recoveryAttempts.some(({ binding }) => binding.unitId === unit.id && unknownAttempts.has(String(binding.attemptId)))) readyCandidates.add(unit.id);
  }
  for (const { unitId } of scopedBlockers.values()) readyCandidates.delete(unitId);
  if (unknownHoldScope) readyCandidates.clear();
  frontier.splice(0, frontier.length, ...[...readyCandidates].sort());
  const status = blockers.length === 0 ? "resumed" : "blocked";
  const causes = [...new Set(blockers)].flatMap((reason) => {
    if (reason === "one or more exact legacy Team holds remain unresolved" &&
      holds.filter(({ disposition }) => disposition === "unresolved").every(({ holdId }) => scopedBlockers.has(`${reason}:${holdId}`))) {
      return holds.filter(({ disposition }) => disposition === "unresolved").map(({ holdId }) => scopedBlockers.get(`${reason}:${holdId}`)!);
    }
    return [scopedBlockers.get(reason) ?? { id: `global:${sha256(Buffer.from(reason))}`, sourceEventId: "",
      proofHash: sha256(Buffer.from(reason)), scope: "mission" as const }];
  });
  const report: RecoveryReport = {
    format: "mission-recovery-report-v2", missionId, episodeId, revision: initial.revision, status, owner,
    disposition: { version: 2, revision: initial.revision, ownerEpoch: store.ownerEpoch ?? -1,
      observedSeq: initial.latestSeq, causes },
    plan,
    source: {
      root: path.resolve(options.sourceRoot), manifest: sourceImage?.manifest ?? null,
      headChanged: Boolean(sourceImage && originalBaseImage && originalBaseImage.manifest.head !== sourceImage.manifest.head),
      indexChanged: Boolean(sourceImage && originalBaseImage && originalBaseImage.manifest.indexHash !== sourceImage.manifest.indexHash),
      branchChanged: Boolean(sourceImage && originalBaseImage && originalBaseImage.manifest.branch !== sourceImage.manifest.branch),
      changedPaths,
    },
    effects: effectsWithBlockers,
    candidate: { root: candidateRoot, imageHash: candidateImageHash, manifestHash: candidateWorkspaceManifestHash, restored },
    delivery: { baseManifestHash: deliveryBaseManifestHash, acceptedManifestHash, patchHash },
    evidence: stale,
    holds,
    legacyConflicts,
    diagnoses,
    ...(lifecycleAdmissions.length ? { lifecycle: lifecycleAdmissions } : {}),
    frontier: [...new Set(frontier)].sort(),
    blockers: [...new Set(blockers)].sort(),
  };
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2));
  const reportHash = sha256(reportBytes);
  const reportDraft: MissionEventDraft = {
    revision: initial.revision,
    kind: "mission.recovery.recorded",
    causalId: stableUuid(`mission-recovery:${episodeId}:${reportHash}`),
    payload: { episodeId, reportHash, status, frontier: report.frontier, blockers: report.blockers, candidateImageHash, patchHash },
  };
  if (!ownershipSafe) return report;
  const drafts: MissionEventDraft[] = candidateRelocations.map(({ attemptId, registration, fromRoot, toRoot, history }) => ({
    revision: initial.revision, kind: "workspace.candidate.relocated",
    causalId: stableUuid(`candidate-relocated:${episodeId}:${attemptId}:${toRoot}`), attemptId,
    unitId: attempts.find((attempt) => attempt.attemptId === attemptId)?.event.unitId ?? undefined,
    payload: { fromRoot, toRoot, ...registration, locationHistory: history },
  }));
  drafts.push(reportDraft);
  for (const lifecycle of lifecycleAdmissions) {
    const source = lifecycleSources.get(lifecycle.sourceAttemptId)!;
    if (!report.frontier.includes(source.binding.unitId)) continue;
    const continuationId = sha256(Buffer.from(JSON.stringify({ episodeId, lifecycle, candidateImageHash })));
    drafts.push({
      revision: initial.revision, kind: "mission.recovery.continuation.recorded", attemptId: source.binding.attemptId, unitId: source.binding.unitId,
      causalId: stableUuid(`lifecycle-recovery:${continuationId}`),
      payload: { continuationId, unitId: source.binding.unitId, sourceAttemptId: source.binding.attemptId,
        sourceImageHash: candidateImageHash, lifecycle, proofHash: lifecycle.proofHash,
        effectIds: source.proof.effects.map(({ effectId }) => effectId), repairLimit: 1, mode: "verify" },
    });
  }
  for (const [attemptId, recovery] of pauseRecoveries) {
    if (!report.frontier.includes(recovery.binding.unitId)) continue;
    const continuationId = sha256(Buffer.from(JSON.stringify({ episodeId, attemptId, proofHash: recovery.proofHash, ownerEpoch: owner.epoch })));
    drafts.push({
      revision: initial.revision, kind: "mission.recovery.continuation.recorded", attemptId, unitId: recovery.binding.unitId,
      causalId: stableUuid(`pause-recovery:${continuationId}`),
      payload: { continuationId, unitId: recovery.binding.unitId, sourceAttemptId: attemptId,
        sourceImageHash: recovery.proof.observedImageHash, sourceManifestHash: recovery.proof.sourceManifestHash,
        pauseEventId: recovery.proof.pauseEventId, proofHash: recovery.proofHash, ownerEpoch: owner.epoch,
        acquisitionProofHash: sha256(Buffer.from(JSON.stringify(store.ownerAcquisitionProof))),
        observedSeq: initial.latestSeq, effectIds: recovery.proof.effects.map(({ effectId }) => effectId),
        repairLimit: 1, mode: "verify" },
    });
  }
  if (report.status === "resumed" && candidateImageHash && report.candidate.restored) {
    const continuations = new Map<string, { attemptId: string; effectIds: string[]; disposition: "applied" | "partial" }>();
    for (const effect of effectsWithBlockers) {
      if ((effect.disposition !== "applied" && effect.disposition !== "partial") || !effect.attemptId) continue;
      if (pauseRecoveries.has(effect.attemptId) || lifecycleSources.has(effect.attemptId)) continue;
      const attempt = attempts.find(({ attemptId }) => attemptId === effect.attemptId);
      const unitId = attempt?.event.unitId;
      if (!unitId || !report.frontier.includes(unitId)) continue;
      const prior = continuations.get(unitId);
      if (prior) {
        prior.effectIds.push(effect.effectId);
        if (effect.disposition === "partial") prior.disposition = "partial";
      } else continuations.set(unitId, { attemptId: effect.attemptId, effectIds: [effect.effectId], disposition: effect.disposition });
    }
    for (const [unitId, continuation] of continuations) {
      const continuationId = sha256(Buffer.from(JSON.stringify({ episodeId, unitId, imageHash: candidateImageHash, ...continuation })));
      drafts.push({
        revision: initial.revision, kind: "mission.recovery.continuation.recorded", attemptId: continuation.attemptId, unitId,
        causalId: stableUuid(`recovery-continuation:${continuationId}`),
        payload: {
          continuationId, unitId, sourceAttemptId: continuation.attemptId, sourceImageHash: candidateImageHash,
          disposition: continuation.disposition, effectIds: continuation.effectIds.sort(), repairLimit: 1, mode: "verify",
        },
      });
    }
  }
  for (const attempt of ordinaryPending.filter(({ attemptId }) => !initial.events.some((event) =>
    event.attemptId === attemptId && event.kind === "attempt.settled",
  ))) drafts.push({
    revision: initial.revision, kind: "attempt.settled", attemptId: attempt.attemptId,
    unitId: attempt.event.unitId ?? undefined,
    causalId: stableUuid(`attempt-recovered-without-result:${episodeId}:${attempt.attemptId}`),
    payload: { attemptId: attempt.attemptId, status: "failed", resultHash: null, recoveryDisposition: "interrupted-without-worker-result", episodeId },
  });
  for (const effect of effectsWithBlockers) {
    const rows = initial.events.filter((event) => event.effectId === effect.effectId);
    const priorObservation = [...rows].reverse().find((event) => event.kind === "effect.reconciled");
    if (priorObservation && priorObservation.payload.disposition === effect.disposition &&
      JSON.stringify(priorObservation.payload.probe ?? null) === JSON.stringify(effect.probe ?? null)) continue;
    const draft: MissionEventDraft = {
      revision: initial.revision,
      kind: effect.disposition === "unknown" ? "effect.observation.recorded" : "effect.reconciled",
      effectId: effect.effectId,
      attemptId: effect.attemptId ?? undefined,
      unitId: effect.attemptId ? attempts.find(({ attemptId }) => attemptId === effect.attemptId)?.event.unitId ?? undefined : undefined,
      causalId: stableUuid(`effect-observation:${episodeId}:${effect.effectId}`),
      payload: {
        effectId: effect.effectId, disposition: effect.disposition, reason: effect.reason, observedBy: "mission-recovery", episodeId,
        ...(effect.probe !== undefined ? { probe: effect.probe } : {}),
        ...(effect.probe && typeof effect.probe === "object" && "proofKind" in effect.probe
          ? { proofKind: (effect.probe as Record<string, unknown>).proofKind }
          : {}),
      },
    };
    drafts.push(draft);
  }
  const invalidatedEvents = initial.events.filter((event) => event.kind === "evidence.recorded" &&
    stale.invalidated.includes(String(event.payload.id ?? event.payload.evidenceId ?? "")));
  const invalidatedByUnit = new Map<string, string[]>();
  for (const event of invalidatedEvents) {
    const unitId = String(event.payload.unitId ?? event.unitId ?? "");
    const ids = invalidatedByUnit.get(unitId) ?? [];
    ids.push(String(event.payload.id ?? event.payload.evidenceId));
    invalidatedByUnit.set(unitId, ids);
  }
  for (const [unitId, evidenceIds] of invalidatedByUnit) drafts.push({
    revision: initial.revision, kind: "evidence.invalidated",
    causalId: stableUuid(`evidence-invalidated:${episodeId}:${unitId}`), unitId,
    payload: { unitId, evidenceIds, reason: "input manifest changed during recovery", changedPaths: report.source.changedPaths },
  });
  for (const event of initial.events.filter((row) => row.kind === "evidence.recorded" &&
    stale.retained.includes(String(row.payload.id ?? row.payload.evidenceId ?? "")))) {
    const evidenceId = String(event.payload.id ?? event.payload.evidenceId);
    drafts.push({ revision: initial.revision, kind: "evidence.reused", unitId: event.unitId ?? undefined,
      causalId: stableUuid(`evidence-reused:${episodeId}:${evidenceId}`),
      payload: { evidenceId, reason: "declared input paths are unchanged", changedPaths: report.source.changedPaths },
    });
  }
  for (const unitId of frontier) {
    if (unitStatus(initial.events, unitId) === "ready") continue;
    drafts.push({
      revision: initial.revision, kind: "unit.ready",
      causalId: stableUuid(`recovery-ready:${episodeId}:${unitId}`), unitId,
      payload: { unitId, reason: "recovered candidate requires a fresh attempt and current evidence", episodeId },
    });
  }
  await appendRecoveryEvents(store, missionId, initial.revision, drafts, [
    { bytes: reportBytes, mediaType: "application/json" },
    ...(patch ? [{ bytes: Buffer.from(JSON.stringify(patch)), mediaType: "application/octet-stream" }] : []),
  ], () => store.ownerEpoch === owner.epoch && recoveryObservationCurrent(store.inspectMission(missionId).events, initial.latestSeq, localObservations) &&
    (!sourceImage || captureWorkspaceImage(options.sourceRoot).manifest.hash === sourceImage.manifest.hash) &&
    planCurrent());
  return report;
}

async function runOverlapDisposition(
  store: MissionStore,
  revision: number,
  observedSeq: number,
  localObservations: ReadonlySet<string>,
  request: RecoveryOverlapRequest,
  role: "developer" | "expert",
  consult: ((input: RecoveryOverlapRequest & { diagnosisId: string; developerDiagnosis?: RecoveryOverlapAnswer }) => Promise<RecoveryOverlapAnswer>) | undefined,
  developerDiagnosis?: RecoveryOverlapAnswer,
): Promise<{ answer: RecoveryOverlapAnswer; resultHash: string | null }> {
  const current = store.inspectMission(request.missionId);
  const matching = current.events.filter((event) => event.kind === "mission.recovery.diagnosed" &&
    event.payload.fingerprint === request.fingerprint && event.payload.role === role);
  const complete = [...matching].reverse().find((event) => event.payload.status === "completed");
  const diagnosisId = stableUuid(`recovery-diagnosis:${request.fingerprint}:${role}`);
  const memberRole = role === "developer" ? "developer" : ["architect", "reviewer"].find((name) => current.definition.authority.rolePolicies[name]) ?? "expert";
  const policy = current.definition.authority.rolePolicies[memberRole];
  const sourceAttempt = current.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === request.attemptId &&
    (event.payload.binding as { unitId?: string } | undefined)?.unitId === request.unitId);
  const imported = [...current.events].reverse().find((event) => event.kind === "mission.imported");
  if (complete) {
    const started = matching.find((event) => event.payload.status === "started" && event.payload.diagnosisId === complete.payload.diagnosisId);
    const admission = started?.payload.admission as RecoveryDiagnosisAdmission | undefined;
    if (!started || !admission || admission.version !== 1 || admission.revision !== revision ||
      admission.fingerprint !== request.fingerprint || admission.attemptId !== request.attemptId ||
      admission.unitId !== request.unitId || admission.sourceManifestHash !== request.sourceManifestHash ||
      admission.planStatus !== request.planStatus || admission.memberRole !== memberRole ||
      admission.briefHash !== sha256(Buffer.from(recoveryDiagnosisBrief(memberRole, { ...request, developerDiagnosis }))) ||
      admission.rolePolicyHash !== (policy?.hash ?? "") || !sourceAttempt ||
      admission.sourceEventId !== sourceAttempt.eventId ||
      admission.sourceProofHash !== sha256(Buffer.from(JSON.stringify(sourceAttempt.payload))) ||
      complete.payload.diagnosisId !== diagnosisId || complete.payload.attemptId !== request.attemptId ||
      complete.payload.unitId !== request.unitId || complete.revision !== revision || started.seq >= complete.seq ||
      typeof complete.payload.resultHash !== "string" || !Number.isSafeInteger(admission.ownerEpoch) || admission.ownerEpoch < 1 ||
      !Number.isSafeInteger(admission.observedSeq) || admission.observedSeq > started.seq) {
      return { answer: { disposition: "unresolved", reason: `${role} cached diagnosis does not match current evidence` }, resultHash: null };
    }
    try {
      const bytes = store.readArtifact(complete.payload.resultHash);
      if (sha256(bytes) !== complete.payload.resultHash) throw new Error("diagnosis artifact hash mismatch");
      return { answer: validateOverlapAnswer(deserializeOverlapAnswer(bytes), request.conflicts), resultHash: complete.payload.resultHash };
    } catch {
      return { answer: { disposition: "unresolved", reason: `${role} diagnosis artifact is missing or corrupt` }, resultHash: null };
    }
  }
  if (matching.some((event) => event.payload.status === "started")) {
    return { answer: { disposition: "unresolved", reason: `prior ${role} diagnosis has no durable result; consultation was not repeated` }, resultHash: null };
  }
  if (!consult) return { answer: { disposition: "unresolved", reason: `bounded ${role} diagnosis is unavailable` }, resultHash: null };
  if (current.revision !== revision || store.ownerEpoch === null || !sourceAttempt ||
    current.events.some((event) => event.kind === "mission.import.conflict") ||
    imported && (imported.payload.holdsKnown !== true || !Array.isArray(imported.payload.holds) ||
      imported.payload.holds.some((hold: Record<string, unknown>) => hold.disposition === "unresolved" &&
        !current.definition.units.some((unit) => unit.id === hold.unitId))) ||
    !recoveryObservationCurrent(current.events, observedSeq, localObservations)) {
    return { answer: { disposition: "unresolved", reason: "recovery observation changed before diagnosis" }, resultHash: null };
  }
  const admission: RecoveryDiagnosisAdmission = {
    version: 1, revision, ownerEpoch: store.ownerEpoch, observedSeq,
    fingerprint: request.fingerprint, attemptId: request.attemptId, unitId: request.unitId,
    sourceEventId: sourceAttempt.eventId, sourceProofHash: sha256(Buffer.from(JSON.stringify(sourceAttempt.payload))),
    sourceManifestHash: request.sourceManifestHash, planStatus: request.planStatus,
    memberRole, briefHash: sha256(Buffer.from(recoveryDiagnosisBrief(memberRole, { ...request, developerDiagnosis }))),
    rolePolicyHash: policy?.hash ?? "",
  };
  await appendRecoveryEvent(store, request.missionId, revision, {
    revision, kind: "mission.recovery.diagnosed", causalId: stableUuid(`recovery-diagnosis:${request.fingerprint}:${role}:started`),
    attemptId: diagnosisId, unitId: request.unitId,
    payload: { fingerprint: request.fingerprint, diagnosisId, role, status: "started", attemptId: request.attemptId, unitId: request.unitId, admission },
  });
  let answer: RecoveryOverlapAnswer;
  try {
    const proposed = await consult({ ...request, diagnosisId, ...(developerDiagnosis ? { developerDiagnosis } : {}) });
    answer = validateOverlapAnswer(proposed, request.conflicts);
  } catch (error) {
    answer = { disposition: "unresolved", reason: `${role} diagnosis failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (store.ownerEpoch !== admission.ownerEpoch || !recoveryObservationCurrent(store.inspectMission(request.missionId).events, admission.observedSeq, localObservations)) {
    answer = { disposition: "unresolved", reason: "recovery observation changed during diagnosis" };
  }
  const bytes = serializeRecoveryOverlapAnswer(answer);
  const resultHash = sha256(bytes);
  await appendRecoveryEvent(store, request.missionId, revision, {
    revision, kind: "mission.recovery.diagnosed", causalId: stableUuid(`recovery-diagnosis:${request.fingerprint}:${role}:completed:${resultHash}`),
    attemptId: diagnosisId, unitId: request.unitId,
    payload: { fingerprint: request.fingerprint, diagnosisId, role, status: "completed", attemptId: request.attemptId, unitId: request.unitId, resultHash },
  }, [{ bytes, mediaType: "application/json" }]);
  return { answer, resultHash };
}

function fingerprintOverlap(
  attemptId: string,
  base: WorkspaceImage,
  mission: WorkspaceImage,
  source: WorkspaceImage,
  conflicts: RecoveryFileConflict[],
  plan: RecoveryReport["plan"],
  revision: number,
  rolePolicies: Record<string, { hash: string }>,
): string {
  const fileHash = (file: WorkspaceImageFile) => [file.path, file.kind, file.mode, file.bytes ? sha256(file.bytes) : null];
  return sha256(Buffer.from(JSON.stringify({
    attemptId, revision, rolePolicies: Object.entries(rolePolicies).map(([name, policy]) => [name, policy.hash]).sort(),
    base: base.manifest.hash, mission: mission.manifest.hash, source: source.manifest.hash,
    plan: [plan.status, plan.storedHash, plan.observedHash, ...(plan.inputIdentityHash ? [plan.inputIdentityHash] : [])],
    conflicts: conflicts.map(({ path: name, base: before, mission: proposed, current }) => [name, fileHash(before), fileHash(proposed), fileHash(current)]),
  })));
}

function validateOverlapAnswer(answer: RecoveryOverlapAnswer, conflicts: RecoveryFileConflict[]): RecoveryOverlapAnswer {
  if (!answer || typeof answer !== "object" || !["compatible", "genuine-conflict", "unresolved"].includes(answer.disposition) ||
    typeof answer.reason !== "string" || !answer.reason.trim()) {
    return { disposition: "unresolved", reason: "diagnosis returned a malformed or empty disposition" };
  }
  if (answer.disposition !== "compatible") return {
    disposition: answer.disposition,
    reason: answer.reason.slice(0, 2000),
    ...(typeof answer.question === "string" ? { question: answer.question.slice(0, 2000) } : {}),
  };
  if (!Array.isArray(answer.resolutions) || answer.resolutions.length !== conflicts.length) {
    return { disposition: "unresolved", reason: "compatible diagnosis omitted one or more exact conflicting path resolutions" };
  }
  const expected = new Set(conflicts.map(({ path: name }) => name));
  const resolved = new Set<string>();
  const resolutions: WorkspaceImageFile[] = [];
  for (const row of answer.resolutions) {
    if (!row || typeof row.path !== "string" || !expected.has(row.path) || resolved.has(row.path) || sensitiveArtifactPath(row.path) ||
      !["file", "missing"].includes(row.kind) ||
      (row.mode !== null && (!Number.isSafeInteger(row.mode) || Number(row.mode) < 0 || Number(row.mode) > 0o7777)) ||
      (row.kind === "file" && !(row.bytes instanceof Uint8Array)) ||
      (row.kind === "missing" && (row.bytes !== null || row.mode !== null))) {
      return { disposition: "unresolved", reason: "compatible diagnosis returned an invalid path resolution" };
    }
    resolved.add(row.path);
    resolutions.push({ path: row.path, kind: row.kind, mode: row.mode, bytes: row.bytes ? Buffer.from(row.bytes) : null });
  }
  if (resolved.size !== expected.size) return { disposition: "unresolved", reason: "compatible diagnosis did not cover the exact conflict set" };
  return { disposition: "compatible", reason: answer.reason.slice(0, 2000), resolutions };
}

export function serializeRecoveryOverlapAnswer(answer: RecoveryOverlapAnswer): Buffer {
  return Buffer.from(JSON.stringify({
    format: "mission-overlap-diagnosis-v1", disposition: answer.disposition, reason: answer.reason,
    ...(answer.question ? { question: answer.question } : {}),
    ...(answer.resolutions ? { resolutions: answer.resolutions.map(({ path: name, kind, mode, bytes }) => ({
      path: name, kind, mode, bytes: bytes?.toString("base64") ?? null,
    })) } : {}),
  }));
}

function deserializeOverlapAnswer(bytes: Buffer): RecoveryOverlapAnswer {
  const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (value.format !== "mission-overlap-diagnosis-v1") throw new Error("unsupported diagnosis artifact format");
  return {
    disposition: value.disposition as RecoveryOverlapAnswer["disposition"], reason: String(value.reason),
    ...(typeof value.question === "string" ? { question: value.question } : {}),
    ...(Array.isArray(value.resolutions) ? { resolutions: value.resolutions.map((entry) => {
      const row = entry as Record<string, unknown>;
      return { path: String(row.path), kind: row.kind as WorkspaceImageFile["kind"], mode: row.mode as number | null,
        bytes: typeof row.bytes === "string" ? Buffer.from(row.bytes, "base64") : null };
    }) } : {}),
  };
}

function applyOverlapResolutions(files: WorkspaceImageFile[], resolutions: WorkspaceImageFile[]): WorkspaceImageFile[] {
  const byPath = new Map(resolutions.map((file) => [file.path, file]));
  return files.map((file) => byPath.get(file.path) ?? file);
}

export async function reconcileLegacyHolds(input: {
  store: MissionStore;
  missionId: string;
  importKey: string;
  verify: (hold: LegacyHoldVerificationInput) => Promise<LegacyHoldVerificationProof>;
}): Promise<Array<{ holdId: string; disposition: "reconciled_without_outcome" | "unresolved" }>> {
  const inspection = input.store.inspectMission(input.missionId);
  const imported = inspection.events.find((event) => event.kind === "mission.imported" && event.payload.importKey === input.importKey);
  if (!imported || imported.payload.holdsKnown !== true) throw new Error("legacy holds are unknown; no hold can be retired");
  const rows = imported.payload.holds as Array<Record<string, unknown>>;
  const result = [];
  for (const hold of rows) {
    const prior = importedHoldReconciled(input.store, input.store.inspectMission(input.missionId).events, imported, hold);
    if (prior) {
      result.push({ holdId: String(hold.holdId), disposition: "reconciled_without_outcome" as const });
      continue;
    }
    if (hold.disposition !== "unresolved" || typeof hold.holdId !== "string") {
      result.push({ holdId: String(hold.holdId ?? "unknown"), disposition: "unresolved" as const });
      continue;
    }
    try {
      const proof = await input.verify({
        holdId: hold.holdId,
        ...(typeof hold.assignmentId === "string" ? { assignmentId: hold.assignmentId } : {}),
        ...(typeof hold.unitId === "string" ? { unitId: hold.unitId } : {}),
        ...(typeof hold.status === "string" ? { status: hold.status } : {}),
      });
      if (proof.quiescent !== true || proof.artifacts.length === 0) throw new Error("legacy hold verification lacks exact quiescence or artifact evidence");
      const proofRows = proof.artifacts.map(({ path: name, bytes }) => ({ path: name, hash: sha256(bytes), bytesBase64: Buffer.from(bytes).toString("base64") }));
      const proofBytes = Buffer.from(JSON.stringify({ format: "legacy-hold-proof-v1", holdId: hold.holdId, quiescent: true, artifacts: proofRows }));
      const current = input.store.inspectMission(input.missionId);
      input.store.recordLegacyHoldReconciled(input.missionId, current.version, {
        importKey: input.importKey, holdId: hold.holdId, proofBytes, proofHash: sha256(proofBytes),
      });
      result.push({ holdId: hold.holdId, disposition: "reconciled_without_outcome" as const });
    } catch {
      result.push({ holdId: hold.holdId, disposition: "unresolved" as const });
    }
  }
  return result;
}

function evidenceInputBindingIsCurrent(
  store: MissionStore,
  events: readonly { kind: string; payload: Record<string, any>; unitId: string | null }[],
  evidence: Record<string, any>,
  unit: { id: string; role: string; inputs: string[]; dependencies: string[]; acceptance?: Array<{ id: string }> },
  currentImage: WorkspaceImage,
  planChanged: boolean,
  changed: string[],
  rolePolicyHash: string | undefined,
  invalidatedEvidenceIds: ReadonlySet<string>,
  allowedPaths: readonly string[],
  assessmentToolIdentity: string | undefined,
  runtimeIdentity: string | undefined,
): boolean {
  const predicateId = String(evidence.predicateId ?? "");
  const predicate = unit.acceptance?.find((row) => row.id === predicateId);
  if (!predicate) return false;
  const attemptId = String(evidence.attemptId ?? "");
  const attempt = events.find((event) => event.kind === "attempt.reserved" && String(event.payload.attemptId) === attemptId);
  if (typeof evidence.inputBindingHash !== "string" || typeof evidence.predicateHash !== "string" || !Array.isArray(evidence.inputPatterns)) {
    if (typeof attempt?.payload.binding?.predicateInputBindingsHash === "string") return false;
    return !planChanged && unit.inputs.length > 0 && !changed.some((name) => unit.inputs.some((input) => pathMatches(input, name)));
  }
  const predicateHash = sha256(Buffer.from(JSON.stringify(predicate)));
  const patterns = [...new Set(unit.inputs)].sort();
  if (evidence.predicateHash !== predicateHash || JSON.stringify(evidence.inputPatterns) !== JSON.stringify(patterns)) return false;
  const bindingHash = attempt?.payload.binding?.predicateInputBindingsHash;
  if (typeof bindingHash !== "string" || attempt?.payload.binding?.predicateInputBindingsComplete !== true) return false;
  try {
    const bytes = store.readArtifact(bindingHash);
    if (sha256(bytes) !== bindingHash) return false;
    const artifact = JSON.parse(bytes.toString("utf8")) as { format?: string; bindings?: Array<Record<string, any>> };
    const binding = artifact.format === "mission-predicate-input-bindings-v1"
      ? artifact.bindings?.find((row) => row.predicateId === predicateId)
      : undefined;
    if (!binding || binding.complete !== true || binding.predicateHash !== predicateHash ||
      binding.inputBindingHash !== evidence.inputBindingHash ||
      JSON.stringify(binding.inputPatterns) !== JSON.stringify(patterns) ||
      binding.rolePolicyHash !== rolePolicyHash || binding.inputBindingHash !== sha256(Buffer.from(JSON.stringify({
        predicateId, predicateHash, inputPatterns: binding.inputPatterns, inputPaths: binding.inputPaths,
        inputIndexEntries: binding.inputIndexEntries, rolePolicyHash: binding.rolePolicyHash, dependencyEvidence: binding.dependencyEvidence,
        assessmentToolIdentity: binding.assessmentToolIdentity, runtimeIdentity: binding.runtimeIdentity,
      }))) || !Array.isArray(binding.inputPaths) || !Array.isArray(binding.inputIndexEntries) ||
      !Array.isArray(binding.dependencyEvidence)) return false;
    if (JSON.stringify(evidence.rolePolicyHash) !== JSON.stringify(binding.rolePolicyHash) ||
      JSON.stringify(evidence.dependencyEvidence) !== JSON.stringify(binding.dependencyEvidence) ||
      binding.assessmentToolIdentity !== assessmentToolIdentity || binding.runtimeIdentity !== runtimeIdentity ||
      evidence.assessmentToolIdentity !== binding.assessmentToolIdentity || evidence.runtimeIdentity !== binding.runtimeIdentity) return false;
    if (unit.dependencies.length !== new Set(binding.dependencyEvidence.map((row: Record<string, unknown>) => row.unitId)).size && unit.dependencies.length > 0) return false;
    for (const dependency of binding.dependencyEvidence as Array<Record<string, unknown>>) {
      const dependencyEvent = events.find((event) => event.kind === "evidence.recorded" &&
        String(event.payload.id ?? event.payload.evidenceId ?? "") === dependency.evidenceId);
      if (!dependencyEvent || invalidatedEvidenceIds.has(String(dependency.evidenceId)) ||
        String(dependencyEvent.payload.unitId ?? dependencyEvent.unitId ?? "") !== dependency.unitId ||
        dependencyEvent.payload.predicateId !== dependency.predicateId || dependencyEvent.payload.verdict !== "pass" ||
        dependencyEvent.payload.outputManifestHash !== dependency.outputManifestHash) return false;
    }
    const currentPaths = currentImage.files.filter((file) => patterns.some((pattern) => pathMatches(pattern, file.path)) &&
      allowedPaths.some((pattern) => pathMatches(pattern, file.path)))
      .map((file) => ({ path: file.path, kind: file.kind, mode: file.mode, hash: file.bytes === null ? null : sha256(file.bytes) }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const currentIndexEntries = currentImage.manifest.indexEntries.filter((entry) => patterns.some((pattern) => pathMatches(pattern, entry.path)) &&
      allowedPaths.some((pattern) => pathMatches(pattern, entry.path)));
    return JSON.stringify(currentPaths) === JSON.stringify(binding.inputPaths) &&
      JSON.stringify(currentIndexEntries) === JSON.stringify(binding.inputIndexEntries);
  } catch { return false; }
}

function staleEvidence(
  store: MissionStore,
  events: readonly { kind: string; payload: Record<string, any>; unitId: string | null }[],
  units: readonly { id: string; role: string; inputs: string[]; dependencies: string[]; acceptance?: Array<{ id: string }> }[],
  rolePolicies: Record<string, { hash: string }>,
  allowedPaths: readonly string[],
  base: WorkspaceImage,
  finalImage: WorkspaceImage,
  planChanged: boolean,
  assessmentToolIdentity: string | undefined,
  runtimeIdentity: string | undefined,
): RecoveryReport["evidence"] {
  const changed = changedImagePaths(base, finalImage);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const retained: string[] = [];
  const invalidated: string[] = [];
  const invalidatedEvidenceIds = new Set(events.filter((event) => event.kind === "evidence.invalidated")
    .map((event) => String(event.payload.id ?? event.payload.evidenceId ?? "")).filter(Boolean));
  const evidence = events.filter((event) => event.kind === "evidence.recorded");
  for (const event of evidence) {
    const id = String(event.payload.id ?? event.payload.evidenceId ?? "");
    const unit = byId.get(String(event.payload.unitId ?? event.unitId ?? ""));
    const stale = !unit || !evidenceInputBindingIsCurrent(store, events, event.payload, unit, finalImage, planChanged, changed,
      rolePolicies[unit.role]?.hash, invalidatedEvidenceIds, allowedPaths, assessmentToolIdentity, runtimeIdentity);
    (stale ? invalidated : retained).push(id || `${event.unitId ?? "unknown"}:${event.payload.predicateId ?? "predicate"}`);
    if (stale && id) invalidatedEvidenceIds.add(id);
  }
  return { retained: [...new Set(retained)].sort(), invalidated: [...new Set(invalidated)].sort() };
}

async function observeEffects(
  events: readonly { kind: string; effectId: string | null; attemptId: string | null; payload: Record<string, any> }[],
  options: ReconcileMissionOptions,
  blockers: string[],
  candidateRoots: ReadonlyMap<string, string>,
  externalGrants: readonly string[],
) {
  const grouped = new Map<string, Array<{ kind: string; attemptId: string | null; payload: Record<string, any> }>>();
  for (const event of events) {
    if (!event.effectId) continue;
    const rows = grouped.get(event.effectId) ?? [];
    rows.push(event);
    grouped.set(event.effectId, rows);
  }
  const output: RecoveryReport["effects"] = [];
  for (const [effectId, rows] of grouped) {
    const intent = rows.find((event) => event.kind === "effect.intent");
    if (!intent) continue;
    const operation = String(intent.payload.operation ?? "unknown");
    const reconciled = [...rows].reverse().find((event) => event.kind === "effect.reconciled");
    const attemptId = rows.find(({ attemptId: id }) => id)?.attemptId ?? null;
    const deniedBeforeGo = prelaunchDenial(rows);
    if (deniedBeforeGo) {
      output.push({ effectId, attemptId, operation, disposition: "unstarted", reason: "durable denial precedes any process release" });
      continue;
    }
    const external = operation.startsWith("external:") || intent.payload.recovery === "external-probe-required";
    if (external) {
      if (reconciled && effectOutcomeResolved(options.store, events, effectId)) {
        output.push({ effectId, attemptId, operation,
          disposition: reconciled.payload.disposition as EffectDisposition,
          reason: String(reconciled.payload.reason ?? "prior exact host probe was reused"),
          ...(reconciled.payload.probe !== undefined ? { probe: reconciled.payload.probe } : {}),
        });
        continue;
      }
      const binding = {
        missionId: options.missionId,
        effectId,
        operation,
        grantId: String(intent.payload.grantId ?? ""),
        target: String(intent.payload.target ?? ""),
        operationKey: String(intent.payload.operationKey ?? intent.payload.idempotencyKey ?? ""),
        requestHash: String(intent.payload.requestHash ?? ""),
        adapterId: String(intent.payload.adapterId ?? ""),
        adapterVersion: String(intent.payload.adapterVersion ?? ""),
      };
      if (!externalGrants.includes(binding.grantId) || !binding.target || !binding.operationKey ||
        !/^[0-9a-f]{64}$/.test(binding.requestHash) || !binding.adapterId || !binding.adapterVersion || !options.probeExternal) {
        output.push({ effectId, attemptId, operation, disposition: "unknown", reason: "grant-bound external probe identity is incomplete or unavailable; effect is never retried" });
        continue;
      }
      try {
        const observed = await options.probeExternal(binding);
        const encodedEvidence = observed.evidence === undefined ? undefined : JSON.stringify(observed.evidence);
        if (!encodedEvidence || !["applied", "not-applied", "unknown"].includes(observed.disposition)) {
          throw new Error("host probe returned no serializable observation evidence");
        }
        const proof = {
          proofKind: "host-external-probe-v1", ...binding, disposition: observed.disposition,
          evidenceHash: sha256(Buffer.from(encodedEvidence)), evidence: JSON.parse(encodedEvidence),
        };
        output.push({
          effectId, attemptId, operation, disposition: observed.disposition,
          reason: "read-only grant-bound probe used the original target, adapter version, request hash, and idempotency key",
          probe: proof,
        });
      } catch (error) {
        output.push({ effectId, attemptId, operation, disposition: "unknown", reason: `original effect probe failed: ${error instanceof Error ? error.message : String(error)}` });
      }
      continue;
    }
    const released = rows.some((event) => event.kind === "effect.released");
    const receipt = [...rows].reverse().find((event) => event.kind === "effect.receipt");
    const unknown = rows.some((event) => event.kind === "effect.unknown");
    if (!released && !unknown && !receipt && ["launch-gate", "unstarted"].includes(classifyNoEffect(rows) ?? "")) {
      output.push({ effectId, attemptId, operation, disposition: "unstarted", reason: "launch gate was not released; original operation did not receive GO" });
      continue;
    }
    const registered = [...rows].reverse().find((event) => event.kind === "effect.process.registered")?.payload.identity;
    const releasedIdentity = [...rows].reverse().find((event) => event.kind === "effect.released")?.payload.processIdentity;
    if (!released || !isProcessIdentity(registered) || !isProcessIdentity(releasedIdentity) ||
      !sameProcessIdentity(registered, releasedIdentity) || !effectProcessMatchesIntent(intent.payload, registered)) {
      output.push({ effectId, attemptId, operation, disposition: "unknown", reason: "released effect lacks matching registered process identity; uncertainty stays sticky" });
      continue;
    }
    const quiescent = receipt || registered.namespaceInit
      ? observeEmptyEffectNamespace(registered, blockers)
      : await quiesceNamespace(registered.pidNamespace, registered.ancestry, blockers);
    if (!quiescent) {
      output.push({ effectId, attemptId, operation, disposition: "unknown", reason: receipt
        ? "completed receipt is not accepted because its exact process namespace is still live or unobservable"
        : "registered effect namespace could not be proven empty" });
      continue;
    }
    const observedRoot = attemptId ? candidateRoots.get(attemptId) ?? "" : "";
    const baseSnapshot = attemptId && events.find((event) => event.kind === "workspace.snapshot.sealed" && event.attemptId === attemptId && event.payload.phase === "base");
    const plan = readEffectPlan(options.store, intent.payload.effectPlanHash);
    let disposition: EffectDisposition = "unknown";
    let reason = "released effect has no exact deterministic after-image or provable candidate image";
    let probe: unknown;
    if (operation === "bash") {
      const receiptRow = receipt?.payload;
      const effectImage = rows.find((event) => event.kind === "workspace.snapshot.sealed" &&
        event.payload.phase === "effect" && event.payload.effectId === effectId && event.attemptId === attemptId);
      try {
        if (receipt && receiptRow?.status === "completed" && receiptRow.exitCode === 0 &&
          receiptRow.operation === "bash" && receiptRow.effectId === effectId &&
          receiptRow.requestHash === intent.payload.requestHash &&
          receiptRow.requestHash === rows.find((event) => event.kind === "effect.released")?.payload.requestHash &&
          rows.filter((event) => event.kind === "effect.receipt").length === 1 &&
          !rows.some((event) => event.kind === "effect.unknown" ||
            event.kind === "effect.observation.recorded" && event.payload.disposition === "unknown" ||
            event.kind === "effect.reconciled" && event.payload.disposition !== "applied" ||
            ["effect.invoking", "effect.process.registered", "effect.released"].includes(event.kind) && rows.indexOf(event) > rows.indexOf(receipt)) &&
          plan && effectPlanMatchesIntent(plan, intent.payload) && effectImage &&
          rows.indexOf(effectImage) === rows.indexOf(receipt) + 1 && effectImage.payload.manifestHash ===
            readSealedWorkspaceImage(options.store, String(effectImage.payload.imageHash)).manifest.hash &&
          effectOutcomeResolved(options.store, events, effectId)) {
          disposition = "applied";
          reason = "bound completed Bash receipt and sealed effect image survive empty process namespace observation";
        } else if (receiptRow?.status === "failed" && receiptRow.termination === "signal" && attemptId &&
          plan && effectPlanMatchesIntent(plan, intent.payload) && effectImage) {
          const stopped = readHistoricalPauseInterruption(options.store, options.store.inspectMission(options.missionId), attemptId);
          if (!stopped.proof.effects.some((row) => row.effectId === effectId)) throw new Error("Bash is outside stop proof");
          disposition = "partial";
          reason = "exact stopped failed/signal Bash receipt and sealed image preserve interrupted bytes; not execution success";
        } else reason = "opaque bash outcome has no bound terminal completed receipt and sealed image";
      } catch { reason = "opaque bash outcome has no verifiable sealed effect image"; }
    } else if (baseSnapshot && plan && effectPlanMatchesIntent(plan, intent.payload)) {
      try {
        const allowedPaths = Array.isArray(plan.allowedPaths) ? plan.allowedPaths.map(String) : [];
        const liveCandidate = observedRoot && candidateIdentityMatches(observedRoot, baseSnapshot.payload, options.sourceRoot) &&
          candidateMatchesEffectPlan(observedRoot, plan, options.sourceRoot);
        let observed: ManifestPath[];
        if (liveCandidate) {
          observed = captureWorkspacePaths(observedRoot, true).filter(({ path: name }) => allowedPathMatches(name, allowedPaths));
          assertCompleteWorkspaceImage(captureWorkspaceImage(observedRoot), observed);
        } else {
          const sealedEffect = [...rows].reverse().find((event) => event.kind === "workspace.snapshot.sealed" &&
            event.attemptId === attemptId && event.payload.effectId === effectId && event.payload.phase === "effect" &&
            typeof event.payload.imageHash === "string");
          if (!sealedEffect) throw new Error("candidate is unavailable and no host-sealed effect after-image exists");
          const image = readSealedWorkspaceImage(options.store, String(sealedEffect.payload.imageHash));
          if (image.manifest.hash !== sealedEffect.payload.manifestHash) throw new Error("sealed effect after-image manifest does not match its event");
          observed = image.files.filter(({ path: name }) => allowedPathMatches(name, allowedPaths)).map(({ path: name, kind, mode, bytes }) => ({
            path: name, kind, mode, hash: bytes ? sha256(bytes) : null,
          }));
        }
        const preconditions = plan.preconditions;
        const expectedAfter = plan.expectedAfter;
        if (!Array.isArray(preconditions) || !Array.isArray(expectedAfter) || !Array.isArray(plan.expectedAfterFiles) || plan.deterministic !== true) {
          throw new Error("effect plan has no deterministic after-image");
        }
        const comparable = (paths: ManifestPath[]) => paths.filter(({ kind }) => kind !== "directory");
        const observedHash = sha256(Buffer.from(JSON.stringify(comparable(observed))));
        const beforeHash = sha256(Buffer.from(JSON.stringify(comparable(preconditions))));
        const afterHash = sha256(Buffer.from(JSON.stringify(comparable(expectedAfter))));
        if (observedHash === afterHash) disposition = "applied";
        else if (observedHash === beforeHash) disposition = "not-applied";
        else disposition = "partial";
        reason = disposition === "applied"
          ? "quiescent registered process and exact host-observed after-image prove the effect applied"
          : disposition === "not-applied"
            ? "quiescent registered process and exact preimages prove the effect did not apply"
            : "quiescent registered process and complete candidate inventory prove a partial delta; bytes are preserved for repair";
        probe = {
          proofKind: "candidate-after-image-v1", effectPlanHash: intent.payload.effectPlanHash,
          candidateId: plan.candidate.candidateId,
          candidateIdentity: plan.candidate.rootIdentity, candidateGitIdentity: plan.candidate.gitIdentity,
          processIdentity: { ...registered, descendantsQuiescent: true, namespaceEmptyAfterExit: true },
          observedImageHash: observedHash, beforeImageHash: beforeHash,
          expectedAfterHash: afterHash, imageSource: liveCandidate ? "live-candidate" : "sealed-effect-snapshot",
        };
      } catch (error) {
        reason = `candidate image observation is incomplete: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (unknown && disposition === "unknown") reason = "T3 unknown exposure remains sticky because no independent exact image resolved it";
    output.push({ effectId, attemptId, operation, disposition, reason, ...(probe !== undefined ? { probe } : {}) });
  }
  return output;
}

export function missionEffectProcessesQuiescent(
  events: readonly { kind: string; effectId: string | null; attemptId: string | null; payload: Record<string, any> }[],
  attemptId: string,
  observations?: Record<string, unknown>[],
): boolean {
  const ids = new Set(events.filter((event) => event.attemptId === attemptId && event.effectId).map((event) => event.effectId));
  return [...ids].every((id) => {
    const rows = events.filter((event) => event.attemptId === attemptId && event.effectId === id);
    const registered = rows.find((event) => event.kind === "effect.process.registered")?.payload.identity;
    const released = rows.find((event) => event.kind === "effect.released")?.payload.processIdentity;
    if (!registered && !released) return true;
    const blockers: string[] = [];
    const observation: Record<string, unknown> = { effectId: id, registered, released, blockers };
    const quiescent = isProcessIdentity(registered) && (!released || isProcessIdentity(released) &&
      sameProcessIdentity(registered, released)) && observeEmptyEffectNamespace(registered, blockers, observation);
    observations?.push({ ...observation, quiescent });
    return quiescent;
  });
}

export function missionHasUnresolvedEffects(
  store: MissionStore,
  events: readonly { kind: string; effectId: string | null; attemptId: string | null; payload: Record<string, any> }[],
  attemptId?: string,
): boolean {
  const effectIds = new Set(events.filter((event) => event.effectId && (!attemptId || event.attemptId === attemptId))
    .map((event) => event.effectId as string));
  return [...effectIds].some((effectId) => !effectOutcomeResolved(store, events, effectId));
}

// Completion requires independently stored outcome proof; operational recovery may reuse host probe observations.
export function missionHasUnprovenCompletionEffects(
  store: MissionStore,
  events: readonly { kind: string; effectId: string | null; attemptId: string | null; payload: Record<string, any> }[],
): boolean {
  return auditCompletionEvidence(events, store).effects.length > 0;
}

function effectOutcomeResolved(
  store: MissionStore,
  events: readonly { kind: string; effectId: string | null; attemptId: string | null; payload: Record<string, any> }[],
  effectId: string,
): boolean {
  const rows = events.filter((event) => event.effectId === effectId);
  if (!effectOutcomeResolvedFromEvents(rows, effectId)) return false;
  if (prelaunchDenial(rows)) return true;
  const intent = rows.find((event) => event.kind === "effect.intent");
  const reconciled = [...rows].reverse().find((event) => event.kind === "effect.reconciled");
  if (!intent) return false;
  if (reconciled?.payload.disposition === "unstarted" &&
    effectReconciliationEventIsBound(rows, intent.payload, reconciled.payload)) return true;
  if (intent.payload.recovery !== "external-probe-required" && !String(intent.payload.operation).startsWith("external:")) {
    const plan = readEffectPlan(store, intent.payload.effectPlanHash);
    if (!plan || !effectPlanMatchesIntent(plan, intent.payload)) return false;
  }
  return !reconciled || reconciled.payload.probe?.proofKind !== "candidate-after-image-v1" ||
    storedEffectReconciliationIsProven(store, rows, intent.payload, reconciled.payload);
}

export function effectOutcomeResolvedFromEvents(
  events: readonly { kind: string; effectId: string | null; attemptId?: string | null; payload: Record<string, any> }[],
  effectId: string,
): boolean {
  const rows = events.filter((event) => event.effectId === effectId);
  const intent = rows.find((event) => event.kind === "effect.intent");
  if (!intent || prelaunchDenial(rows)) return prelaunchDenial(rows);
  const uncertainty = rows.reduce((last, event, index) =>
    event.kind === "effect.unknown" || event.kind === "effect.observation.recorded" && event.payload.disposition === "unknown" ? index : last, -1);
  const reconciled = [...rows].reverse().find((event) => event.kind === "effect.reconciled");
  if (reconciled && rows.indexOf(reconciled) > uncertainty &&
    effectReconciliationEventIsBound(rows, intent.payload, reconciled.payload)) return true;
  if (uncertainty >= 0) return false;
  if (rows.some((event) => event.kind === "effect.denied")) return prelaunchDenial(rows);
  const receipt = [...rows].reverse().find((event) => event.kind === "effect.receipt");
  return Boolean(receipt && validLocalEffectReceipt(rows, receipt.payload) && effectProcessMatchesIntent(intent.payload, receipt.payload.process));
}

function effectReconciliationEventIsBound(
  rows: readonly { kind: string; payload: Record<string, any> }[],
  intent: Record<string, any>,
  event: Record<string, any>,
): boolean {
  const disposition = String(event.disposition);
  if (!["unstarted", "applied", "not-applied", "partial"].includes(disposition)) return false;
  if (disposition === "unstarted") return classifyNoEffect(rows) === "unstarted" ||
    classifyNoEffect(rows) === "denied";
  const proof = event.probe;
  if (!proof || typeof proof !== "object") return false;
  if (proof.proofKind === "candidate-after-image-v1") {
    const registered = rows.find(({ kind }) => kind === "effect.process.registered")?.payload.identity;
    const released = rows.find(({ kind }) => kind === "effect.released")?.payload.processIdentity;
    const process = proof.processIdentity;
    if (proof.effectPlanHash !== intent.effectPlanHash || !isProcessIdentity(registered) || !isProcessIdentity(released) ||
      !isProcessIdentity(process) || !sameProcessIdentity(registered, released) || !sameProcessIdentity(registered, process) ||
      process.descendantsQuiescent !== true || process.namespaceEmptyAfterExit !== true ||
      proof.candidateId !== intent.candidateId || proof.candidateIdentity !== intent.candidateIdentity ||
      proof.candidateGitIdentity !== intent.candidateGitIdentity || !/^[0-9a-f]{64}$/.test(String(proof.observedImageHash)) ||
      !/^[0-9a-f]{64}$/.test(String(proof.beforeImageHash)) || !/^[0-9a-f]{64}$/.test(String(proof.expectedAfterHash))) return false;
    if (disposition === "applied") return proof.observedImageHash === proof.expectedAfterHash;
    if (disposition === "not-applied") return proof.observedImageHash === proof.beforeImageHash;
    return proof.observedImageHash !== proof.expectedAfterHash && proof.observedImageHash !== proof.beforeImageHash;
  }
  if (proof.proofKind === "host-external-probe-v1") {
    const operationKey = intent.operationKey ?? intent.idempotencyKey;
    if (proof.effectId !== intent.effectId || proof.operation !== intent.operation || proof.operationKey !== operationKey ||
      proof.requestHash !== intent.requestHash || proof.grantId !== intent.grantId || proof.target !== intent.target ||
      proof.adapterId !== intent.adapterId || proof.adapterVersion !== intent.adapterVersion || proof.disposition !== disposition ||
      typeof proof.evidenceHash !== "string" || !/^[0-9a-f]{64}$/.test(proof.evidenceHash)) return false;
    try { return sha256(Buffer.from(JSON.stringify(proof.evidence))) === proof.evidenceHash; } catch { return false; }
  }
  return false;
}

function prelaunchDenial(rows: readonly { kind: string; payload: Record<string, any> }[]): boolean {
  return classifyNoEffect(rows) === "denied";
}

function validLocalEffectReceipt(rows: readonly { kind: string; payload: Record<string, any> }[], receipt: Record<string, any>): boolean {
  const registered = rows.find((event) => event.kind === "effect.process.registered")?.payload.identity;
  const released = rows.find((event) => event.kind === "effect.released")?.payload.processIdentity;
  const process = receipt.process;
  if (!isProcessIdentity(process) || !isProcessIdentity(registered) || !isProcessIdentity(released)) return false;
  return sameProcessIdentity(process, registered) && sameProcessIdentity(released, registered) &&
    process.descendantsQuiescent === true && process.namespaceEmptyAfterExit === true && Array.isArray(receipt.paths) &&
    ["completed", "failed"].includes(String(receipt.status));
}

function readEffectPlan(store: MissionStore, value: unknown): Record<string, any> | undefined {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return undefined;
  try {
    const bytes = store.readArtifact(value);
    if (sha256(bytes) !== value) return undefined;
    const plan = JSON.parse(bytes.toString("utf8")) as Record<string, any>;
    if (plan.format !== "mission-effect-plan-v1" || !plan.request || typeof plan.requestHash !== "string" ||
      sha256(Buffer.from(JSON.stringify(plan.request))) !== plan.requestHash || !Array.isArray(plan.preconditions) ||
      sha256(Buffer.from(JSON.stringify(plan.preconditions))) !== plan.beforeImageHash ||
      plan.deterministic === true && (!Array.isArray(plan.expectedAfter) || !Array.isArray(plan.expectedAfterFiles) ||
        sha256(Buffer.from(JSON.stringify(plan.expectedAfter))) !== plan.expectedAfterHash)) return undefined;
    return plan;
  } catch { return undefined; }
}

function storedEffectReconciliationIsProven(
  store: MissionStore,
  rows: readonly { kind: string; payload: Record<string, any> }[],
  intent: Record<string, any>,
  event: Record<string, any>,
): boolean {
  if (!effectReconciliationEventIsBound(rows, intent, event)) return false;
  if (event.probe?.proofKind !== "candidate-after-image-v1") return true;
  const plan = readEffectPlan(store, intent.effectPlanHash);
  const comparableHash = (paths: ManifestPath[]) => sha256(Buffer.from(JSON.stringify(paths.filter(({ kind }) => kind !== "directory"))));
  return Boolean(plan && effectPlanMatchesIntent(plan, intent) &&
    (!rows.some(({ kind, payload }) => kind === "effect.unknown" && Array.isArray(payload.paths) && payload.paths.length > 0) ||
      sealedEffectImageProvesObservation(store, rows, intent, event)) &&
    event.probe.effectPlanHash === intent.effectPlanHash &&
    event.probe.beforeImageHash === comparableHash(plan.preconditions) &&
    event.probe.expectedAfterHash === comparableHash(plan.expectedAfter));
}

function sealedEffectImageProvesObservation(
  store: MissionStore,
  rows: readonly { kind: string; payload: Record<string, any> }[],
  intent: Record<string, any>,
  event: Record<string, any>,
): boolean {
  const snapshot = [...rows].reverse().find(({ kind, payload }) => kind === "workspace.snapshot.sealed" &&
    payload.phase === "effect" && payload.effectId === intent.effectId && payload.attemptId === intent.attemptId &&
    payload.candidateIdentity === intent.candidateIdentity && payload.candidateGitIdentity === intent.candidateGitIdentity);
  if (typeof snapshot?.payload.imageHash !== "string") return false;
  try {
    const image = readSealedWorkspaceImage(store, snapshot.payload.imageHash);
    const plan = readEffectPlan(store, intent.effectPlanHash);
    if (!plan || image.manifest.hash !== snapshot.payload.manifestHash || !Array.isArray(plan.allowedPaths)) return false;
    const paths = image.files.filter(({ path: name }) => allowedPathMatches(name, plan.allowedPaths))
      .filter(({ kind }) => kind !== "directory")
      .map(({ path: name, kind, mode, bytes }) => ({ path: name, kind, mode, hash: bytes ? sha256(bytes) : null }));
    return sha256(Buffer.from(JSON.stringify(paths))) === event.probe.observedImageHash;
  } catch { return false; }
}

function effectPlanMatchesIntent(plan: Record<string, any>, intent: Record<string, any>): boolean {
  const candidate = plan.candidate;
  return Boolean(candidate && typeof candidate === "object" && plan.requestHash === intent.requestHash &&
    candidate.candidateId === intent.candidateId && candidate.candidateId === `${intent.missionId}:${intent.attemptId}` &&
    candidate.root === intent.candidate && candidate.rootIdentity === intent.candidateIdentity &&
    candidate.gitDir === intent.candidateGitDir && candidate.gitIdentity === intent.candidateGitIdentity &&
    candidate.arenaRoot === intent.candidateArenaRoot && candidate.arenaIdentity === intent.candidateArenaIdentity);
}

function candidateMatchesEffectPlan(root: string, plan: Record<string, any>, sourceRoot: string): boolean {
  try {
    const candidate = verifyPrivateCandidate(root, sourceRoot);
    return candidate.identity === plan.candidate.rootIdentity && candidate.gitIdentity === plan.candidate.gitIdentity;
  } catch { return false; }
}

function effectProcessMatchesIntent(intent: Record<string, any>, process: unknown): boolean {
  const owner = intent.owner;
  if (!isProcessIdentity(process) || !owner || typeof owner !== "object") return false;
  return process.hostId === owner.hostId && process.bootId === owner.bootId &&
    process.runtimeId === owner.runtimeId && process.epoch === owner.epoch;
}

function isProcessIdentity(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if ("namespaceInit" in row) {
    const init = row.namespaceInit;
    if (!init || typeof init !== "object" || Array.isArray(init)) return false;
    const identity = init as Record<string, unknown>;
    if (!Number.isSafeInteger(identity.pid) || Number(identity.pid) < 1 ||
        !Number.isSafeInteger(identity.birthTicks) || Number(identity.birthTicks) < 0 ||
        identity.pid === row.pid || !Array.isArray(row.ancestry) ||
        !row.ancestry.some((member) => member && member.pid === identity.pid &&
          member.birthTicks === identity.birthTicks && member.parentPid === row.pid)) return false;
  }
  return typeof row.hostId === "string" && row.hostId.length > 0 && typeof row.bootId === "string" && row.bootId.length > 0 &&
    Number.isSafeInteger(row.pid) && Number(row.pid) > 0 && Number.isSafeInteger(row.birthTicks) && Number(row.birthTicks) >= 0 &&
    Number.isSafeInteger(row.containedPid) && Number(row.containedPid) > 0 &&
    typeof row.pidNamespace === "string" && typeof row.networkNamespace === "string" &&
    typeof row.runtimeId === "string" && Number.isSafeInteger(row.epoch);
}

function sameProcessIdentity(left: Record<string, any>, right: Record<string, any>): boolean {
  return ["hostId", "bootId", "pid", "birthTicks", "containedPid", "pidNamespace", "networkNamespace", "runtimeId", "epoch"]
    .every((key) => left[key] === right[key]) &&
    left.namespaceInit?.pid === right.namespaceInit?.pid && left.namespaceInit?.birthTicks === right.namespaceInit?.birthTicks;
}

function observeEmptyEffectNamespace(process: Record<string, any>, blockers: string[], observation?: Record<string, unknown>): boolean {
  if (process.namespaceInit) {
    let state: "live" | "dead" | "unknown" = "unknown";
    try { state = ownerProcessState({ ...process, ...process.namespaceInit }); } catch { /* unreadable identity is not proof */ }
    if (observation) observation.namespaceInitState = state;
    if (state === "dead") return true;
    blockers.push(`owned namespace init ${process.namespaceInit.pid} is ${state}`);
    return false;
  }
  try {
    if (processBirthTicks(process.pid) === process.birthTicks && processNamespaceId(process.pid) === process.pidNamespace) {
      blockers.push(`registered effect PID ${process.pid} is still live in namespace ${process.pidNamespace}`);
      return false;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ESRCH") {
      blockers.push(`registered effect PID ${process.pid} cannot be observed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  const members = processesInNamespace(process.pidNamespace);
  if (observation) observation.members = members;
  if (members.length > 0) {
    blockers.push(`registered effect namespace ${process.pidNamespace} still contains live processes`);
    return false;
  }
  return true;
}

async function quiesceNamespace(namespace: string, ancestry: unknown, blockers: string[]): Promise<boolean> {
  const recorded = Array.isArray(ancestry) ? new Map(ancestry.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    return Number.isSafeInteger(item.pid) && Number.isSafeInteger(item.birthTicks) ? [[Number(item.pid), Number(item.birthTicks)] as const] : [];
  })) : new Map<number, number>();
  const current = processesInNamespace(namespace);
  if (current.some((process) => recorded.get(process.pid) !== process.birthTicks)) {
    blockers.push(`process namespace ${namespace} contains an identity absent from the durable launch inventory`);
    return false;
  }
  for (const process of current) {
    try {
      if (processBirthTicks(process.pid) === process.birthTicks && processNamespaceId(process.pid) === namespace) {
        globalThis.process.kill(process.pid, "SIGKILL");
      }
    } catch { /* exact process exited during fencing */ }
  }
  for (let tries = 0; tries < 50; tries += 1) {
    if (processesInNamespace(namespace).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  blockers.push(`registered effect namespace ${namespace} did not quiesce`);
  return false;
}

async function appendRecoveryEvent(store: MissionStore, missionId: string, revision: number, event: MissionEventDraft, artifacts: Array<{ bytes: Uint8Array; mediaType: string }> = []): Promise<void> {
  return appendRecoveryEvents(store, missionId, revision, [event], artifacts);
}

async function appendRecoveryEvents(store: MissionStore, missionId: string, revision: number, events: MissionEventDraft[], artifacts: Array<{ bytes: Uint8Array; mediaType: string }> = [], currentObservation?: () => boolean): Promise<void> {
  for (let restart = 0; restart <= 2; restart += 1) {
    const current = store.inspectMission(missionId);
    if (current.revision !== revision) throw new Error("mission revision changed during recovery; rerun bounded reconciliation");
    if (currentObservation && !currentObservation()) throw new Error("recovery observation changed; rerun bounded reconciliation");
    try {
      store.appendTransition(missionId, current.version, { events: events.map((event) => ({ ...event, revision })), artifacts });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/version conflict/.test(error.message) || restart === 2) throw error;
    }
  }
  throw new Error("recovery CAS retries exhausted");
}

export function sealWorkspaceImage(image: WorkspaceImage): { imageHash: string; artifacts: Array<{ bytes: Uint8Array; mediaType: string }> } {
  const artifacts: Array<{ bytes: Uint8Array; mediaType: string }> = [];
  const files = image.files.map((file) => {
    if (file.bytes && sensitiveArtifactPath(file.path)) throw new Error(`workspace image contains a sensitive path: ${file.path}`);
    const hash = file.bytes ? sha256(file.bytes) : null;
    if (hash && file.bytes) artifacts.push({ bytes: file.bytes, mediaType: "application/octet-stream" });
    return { path: file.path, kind: file.kind, mode: file.mode, hash, size: file.bytes?.length ?? 0 };
  });
  const bytes = Buffer.from(JSON.stringify({ format: "mission-workspace-image-v1", manifest: image.manifest, files }));
  const imageHash = sha256(bytes);
  artifacts.push({ bytes, mediaType: "application/octet-stream" });
  return { imageHash, artifacts };
}

export function readSealedWorkspaceImage(store: MissionStore, imageHash: string): WorkspaceImage {
  const encoded = store.readArtifact(imageHash);
  if (sha256(encoded) !== imageHash) throw new Error(`sealed workspace image is corrupt: ${imageHash}`);
  const raw = JSON.parse(encoded.toString("utf8")) as Record<string, any>;
  if (raw.format !== "mission-workspace-image-v1" || !Array.isArray(raw.files) || !raw.manifest || raw.manifest.schemaVersion !== 1) {
    throw new Error(`sealed workspace image has an unsupported format: ${imageHash}`);
  }
  const files = raw.files.map((entry: Record<string, any>): WorkspaceImageFile => {
    if (typeof entry.path !== "string" || !["file", "symlink", "directory", "missing"].includes(entry.kind) ||
      (entry.mode !== null && !Number.isSafeInteger(entry.mode)) || (entry.hash !== null && !/^[0-9a-f]{64}$/.test(entry.hash))) {
      throw new Error(`sealed workspace image contains an invalid path entry: ${imageHash}`);
    }
    const bytes = entry.hash === null ? null : store.readArtifact(entry.hash);
    if (bytes && (sha256(bytes) !== entry.hash || bytes.length !== entry.size)) throw new Error(`sealed workspace path image is corrupt: ${entry.path}`);
    return { path: entry.path, kind: entry.kind, mode: entry.mode, bytes };
  });
  return { manifest: raw.manifest as WorkspaceManifest, files };
}

function writeMissionLocator(repositoryRoot: string, locator: MissionLocator): void {
  const file = locatorPath(repositoryRoot, locator.planId);
  ensureLocatorDirectories(repositoryRoot, locator.planId);
  if (existsSync(file)) {
    const current = readMissionLocator(repositoryRoot, locator.planId);
    if (current?.missionId === locator.missionId && current.repositoryId === locator.repositoryId) return;
    throw new Error(`managed mission locator already exists with a different identity: ${file}`);
  }
  const temporary = `${file}.${process.pid}.${stableUuid(JSON.stringify(locator))}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(locator)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { linkSync(temporary, file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = readMissionLocator(repositoryRoot, locator.planId);
    if (current?.missionId !== locator.missionId || current.repositoryId !== locator.repositoryId) throw error;
  } finally { rmSync(temporary, { force: true }); }
  const directory = openSync(path.dirname(file), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function locatorPath(root: string, planId: string): string {
  const workspace = realpathSync(root);
  const relative = path.join(".pitako", "runs", assertPlanId(planId));
  let current = workspace;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const state = lstatSync(current);
      if (!state.isDirectory() || state.isSymbolicLink()) throw new Error(`managed mission locator directory is not private: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  return path.join(workspace, relative, "mission.json");
}

function ensureLocatorDirectories(root: string, planId: string): void {
  const workspace = realpathSync(root);
  let current = workspace;
  for (const part of [".pitako", "runs", assertPlanId(planId)]) {
    current = path.join(current, part);
    try {
      const state = lstatSync(current);
      if (!state.isDirectory() || state.isSymbolicLink()) throw new Error(`managed mission locator directory is not private: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
}

function latestImportedHolds(events: readonly { kind: string; payload: Record<string, any> }[]): {
  holds: Array<{ holdId: string; unitId?: string; known: boolean }>;
  malformed: boolean;
} {
  const imported = [...events].reverse().find((event) => event.kind === "mission.imported");
  if (!imported) return { holds: [], malformed: false };
  if (!Array.isArray(imported.payload.holds)) return { holds: [], malformed: true };
  const malformed = imported.payload.holds.some((hold: unknown) => !hold || typeof hold !== "object" || Array.isArray(hold) ||
    typeof (hold as Record<string, unknown>).holdId !== "string" ||
    !["unresolved", "unknown"].includes(String((hold as Record<string, unknown>).disposition)) ||
    ((hold as Record<string, unknown>).disposition === "unresolved" && typeof (hold as Record<string, unknown>).unitId !== "string") ||
    ("unitId" in hold && typeof (hold as Record<string, unknown>).unitId !== "string"));
  const holds = (imported.payload.holds as unknown[]).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const hold = value as Record<string, unknown>;
    if (typeof hold.holdId !== "string") return [];
    return [{ holdId: hold.holdId, known: imported.payload.holdsKnown === true && hold.disposition !== "unknown",
      ...(typeof hold.unitId === "string" ? { unitId: hold.unitId } : {}) }];
  });
  return { holds, malformed };
}

function unitStatus(events: readonly { kind: string; unitId: string | null; payload: Record<string, any> }[], unitId: string): "pending" | "ready" | "running" | "accepted" | "blocked" {
  let status: "pending" | "ready" | "running" | "accepted" | "blocked" = "pending";
  for (const event of events) {
    if (String(event.payload.unitId ?? event.unitId ?? "") !== unitId) continue;
    if (event.kind === "unit.ready" || event.kind === "evidence.invalidated") status = "ready";
    else if (event.kind === "unit.accepted") status = "accepted";
    else if (event.kind === "unit.blocked" || event.kind === "attempt.interrupted") status = "blocked";
    else if (event.kind === "attempt.reserved" || event.kind === "attempt.started") status = "running";
  }
  return status;
}

function acceptedUnitIds(events: readonly { kind: string; unitId: string | null; payload: Record<string, any> }[], staleUnits: Set<string>): Set<string> {
  return new Set(events.filter((event) => event.kind === "unit.accepted" && !staleUnits.has(String(event.payload.unitId ?? event.unitId ?? "")))
    .map((event) => String(event.payload.unitId ?? event.unitId ?? "")));
}

function changedImagePaths(base: WorkspaceImage | undefined, current: WorkspaceImage): string[] {
  if (!base) return current.files.map(({ path: name }) => name).sort();
  const changed = new Set<string>();
  const left = new Map(base.files.map((file) => [file.path, file]));
  const right = new Map(current.files.map((file) => [file.path, file]));
  for (const name of [...new Set([...left.keys(), ...right.keys()])]) {
    if (!sameImage(left.get(name) ?? missingImage(name), right.get(name) ?? missingImage(name))) changed.add(name);
  }
  const leftIndex = new Map(base.manifest.indexEntries.map((entry) => [entry.path, JSON.stringify(entry)]));
  const rightIndex = new Map(current.manifest.indexEntries.map((entry) => [entry.path, JSON.stringify(entry)]));
  for (const name of new Set([...leftIndex.keys(), ...rightIndex.keys()])) if (leftIndex.get(name) !== rightIndex.get(name)) changed.add(name);
  if (base.manifest.head !== current.manifest.head) {
    for (const entry of [...base.manifest.tracked, ...base.manifest.untracked, ...current.manifest.tracked, ...current.manifest.untracked]) changed.add(entry.path);
  }
  return [...changed].sort();
}

function candidateRegistrationForAttempt(
  events: readonly { kind: string; attemptId: string | null; runtimeId: string; payload: Record<string, any> }[],
  attemptId: string,
  binding: Record<string, unknown>,
  expected: { missionId: string; repositoryId: string; ownerEpoch: number },
): CandidateRegistration | undefined {
  const registrationEvent = [...events].reverse().find((event) => event.kind === "workspace.candidate.registered" && event.attemptId === attemptId);
  const reservedEvent = events.find((event) => event.kind === "attempt.reserved" && event.attemptId === attemptId);
  const registered = registrationEvent?.payload;
  const candidate = registered ?? binding.candidateRegistration;
  if (!candidate || typeof candidate !== "object") return undefined;
  const row = candidate as Record<string, unknown>;
  const owner = row.owner as Record<string, unknown> | undefined;
  if ([row.missionId, row.repositoryId, row.attemptId, row.candidateId, row.root, row.rootIdentity, row.gitDir, row.gitIdentity,
    row.arenaRoot, row.arenaIdentity, row.sourceManifestHash].some((value) => typeof value !== "string") ||
    !owner || [owner.hostId, owner.bootId, owner.runtimeId].some((value) => typeof value !== "string") ||
    typeof owner.epoch !== "number" || typeof owner.pid !== "number" || typeof owner.birthTicks !== "number") return undefined;
  if (row.missionId !== expected.missionId || row.repositoryId !== expected.repositoryId || row.attemptId !== attemptId ||
    owner.epoch !== expected.ownerEpoch || row.candidateId !== binding.candidateId ||
    row.sourceManifestHash !== binding.workspaceManifestHash ||
    registrationEvent && registrationEvent.runtimeId !== owner.runtimeId ||
    reservedEvent && reservedEvent.runtimeId !== owner.runtimeId) return undefined;
  return row as unknown as CandidateRegistration;
}

function candidateLocationHistory(
  events: readonly { kind: string; attemptId: string | null; payload: Record<string, any> }[],
  attemptId: string,
  initialRoot: string,
): string[] {
  let history = [initialRoot];
  for (const event of events) {
    if (event.attemptId !== attemptId || event.kind !== "workspace.candidate.registered" && event.kind !== "workspace.candidate.relocated") continue;
    if (Array.isArray(event.payload.locationHistory) && event.payload.locationHistory.every((value: unknown) => typeof value === "string")) {
      history = [...event.payload.locationHistory];
    } else if (typeof event.payload.toRoot === "string" && history.at(-1) !== event.payload.toRoot) {
      history.push(event.payload.toRoot);
    }
  }
  return history;
}

function candidateIdentityMatches(root: string, payload: Record<string, unknown>, sourceRoot: string): boolean {
  try {
    const candidate = verifyPrivateCandidate(root, sourceRoot);
    const rootIdentity = payload.candidateIdentity ?? payload.rootIdentity;
    const gitIdentity = payload.candidateGitIdentity ?? payload.gitIdentity;
    return rootIdentity === candidate.identity && gitIdentity === candidate.gitIdentity;
  } catch { return false; }
}

function isPrivateCandidate(root: string, sourceRoot: string): boolean {
  try { verifyPrivateCandidate(root, sourceRoot); return true; }
  catch { return false; }
}

export function sensitiveArtifactPath(name: string): boolean {
  return name.split("/").some((part, index, parts) =>
    /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.netrc|\.npmrc|credentials?(?:\..*)?|secrets?(?:\..*)?)$/i.test(part) ||
    (index === parts.length - 1 && /\.(?:pem|p12|pfx|key)$/i.test(part)));
}

function hydratePatchFile(file: WorkspaceImageFile): WorkspaceImageFile {
  const value = file.bytes as unknown;
  if (value === null || Buffer.isBuffer(value)) return file;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as { type?: unknown; data?: unknown };
    if (row.type === "Buffer" && Array.isArray(row.data) && row.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      return { ...file, bytes: Buffer.from(row.data) };
    }
  }
  throw new Error(`conditional patch contains invalid bytes at ${file.path}`);
}

export function canonicalDeliveryManifest(accepted: WorkspaceManifest, base: Pick<WorkspaceManifest, "indexHash" | "branch" | "head">): WorkspaceManifest {
  const body = { ...accepted, indexHash: base.indexHash, branch: base.branch, head: base.head };
  const { hash: _candidateHash, ...manifestBody } = body;
  return { ...body, hash: sha256(Buffer.from(JSON.stringify(manifestBody))) };
}

function sameImage(left: WorkspaceImageFile, right: WorkspaceImageFile): boolean {
  return left.kind === right.kind && left.mode === right.mode &&
    (left.bytes === null ? right.bytes === null : right.bytes !== null && left.bytes.equals(right.bytes));
}

function missingImage(name: string): WorkspaceImageFile {
  return { path: name, kind: "missing", mode: null, bytes: null };
}

function allowedPathMatches(name: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some((allowed) => allowed === "*" || allowed === "/" || pathMatches(allowed, name));
}

function pathMatches(pattern: string, name: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/\/\*\*$/, "").replace(/\/$/, "");
  return normalized === "." || normalized === name || name.startsWith(`${normalized}/`);
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
