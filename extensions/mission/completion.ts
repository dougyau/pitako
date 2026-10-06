import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MissionInspection, MissionStore } from "./store.ts";
import { pendingMissionQuestions } from "./admission.ts";
import { reduceMissionEvents } from "./engine.ts";
import { importedHoldReconciled, readAcceptedWorkspaceContribution, readSealedWorkspaceImage, assertCompleteWorkspaceImage } from "./reconcile.ts";
import { auditCompletionEvidence } from "./completion-evidence.ts";
import { captureWorkspaceImage } from "./workspace.ts";
import { sha256 } from "./model.ts";
import { boardWorkspace } from "../board/workspace.ts";
import { FINALIZATION_PHASES, acceptedFinalizationInput, currentWholeResultApproval, finalizationInputIdentity,
  finalizationHash, parseFinalizationResponse, type FinalizationPhaseReceipt, type MissionFinalManifest } from "./finalization.ts";
import { MISSION_CHECK_IDENTITY, missionCheckRuntime } from "./checks.ts";
import { TEAM_ROUNDS } from "./team-contract.ts";
import { MissionSetup } from "./setup.ts";
import { missionInputIdentity } from "./inputs.ts";

export interface MissionCompletionCertificate {
  schemaVersion: 1;
  missionId: string;
  planId: string;
  revision: number;
  eventSequence: number;
  finalEvidence: Array<{ id: string; predicateId: string; artifactHash: string | null }>;
  unresolvedHolds: string[];
  unresolvedEffects: string[];
  manifestHash: string;
  approvalHash: string;
  resultImageHash: string;
  generation: number;
  runtimeIdentity: string;
  certificateHash: string;
  sourceIdentity?: ReturnType<typeof missionInputIdentity>;
}

/** Read-only artifact access is required: event payloads alone cannot prove stored results or effects. */
export function assessMissionCompletion(inspection: MissionInspection, store: MissionStore): {
  blockers: string[]; certificate?: MissionCompletionCertificate;
} {
  const { events, definition } = inspection;
  const state = reduceMissionEvents(inspection);
  const blockers: string[] = [];
  if (!new MissionSetup(store, inspection.id).quiescentFor(inspection)) blockers.push("setup:unresolved-mutation");
  if (inspection.prepared?.setup) {
    const setup = new MissionSetup(store, inspection.id).observe(inspection);
    if (setup.state === "blocked") blockers.push(`setup:${setup.reason}`);
  }
  if (state.revision !== inspection.revision || ["paused", "cancelled", "blocked"].includes(state.state)) blockers.push("mission:not-finalizable");
  if (state.admissionFenced) blockers.push("mission:resource-fenced");
  for (const question of pendingMissionQuestions(events, store)) blockers.push(`question:${question.id}`);

  for (const imported of events.filter(({ kind }) => kind === "mission.imported")) {
    if (imported.payload.holdsKnown !== true || !Array.isArray(imported.payload.holds)) {
      blockers.push(`hold:unknown:${imported.eventId}`);
      continue;
    }
    for (const hold of imported.payload.holds) {
      if (!hold || typeof hold !== "object" || Array.isArray(hold) || typeof hold.holdId !== "string" || !hold.holdId ||
        !["unresolved", "unknown"].includes(hold.disposition) ||
        (hold.disposition === "unresolved" && (typeof hold.unitId !== "string" || !hold.unitId)) ||
        ("unitId" in hold && typeof hold.unitId !== "string")) {
        blockers.push(`hold:malformed:${imported.eventId}`);
      } else if (hold.disposition === "unknown" || !importedHoldReconciled(store, events, imported, hold)) {
        blockers.push(`hold:${hold.holdId}`);
      }
    }
  }
  if (events.some(({ kind }) => kind === "mission.import.conflict")) blockers.push("recovery:import-conflict");
  const report = [...events].reverse().find(({ kind }) => kind === "mission.recovery.recorded");
  const acquisition = store.ownerAcquisitionProof;
  const ownerEpoch = acquisition?.epoch;
  if (report) {
    try {
      const artifact = store.readArtifact(String(report.payload.reportHash));
      const parsed: unknown = JSON.parse(artifact.toString("utf8"));
      const value = parsed as { format?: string; missionId?: string; episodeId?: string; revision?: number; status?: string;
        blockers?: unknown[]; owner?: { epoch?: number }; plan?: { status?: string; storedHash?: string; observedHash?: string };
        source?: { root?: string; manifest?: { hash?: string } }; disposition?: {
          version?: number; revision?: number; ownerEpoch?: number; observedSeq?: number; causes?: unknown[] } };
      if (sha256(artifact) !== report.payload.reportHash || value?.format !== "mission-recovery-report-v2" ||
        value.missionId !== inspection.id || value.episodeId !== report.payload.episodeId ||
        value.revision !== inspection.revision || report.revision !== inspection.revision ||
        value.status !== "resumed" || report.payload.status !== "resumed" ||
        value.disposition?.version !== 2 || value.disposition.revision !== inspection.revision ||
        !Number.isSafeInteger(ownerEpoch) || value.disposition.ownerEpoch !== ownerEpoch || value.owner?.epoch !== ownerEpoch ||
        !Number.isSafeInteger(value.disposition.observedSeq) || value.disposition.observedSeq! >= report.seq ||
        !Array.isArray(value.disposition.causes) || value.disposition.causes.length ||
        !Array.isArray(value.blockers) || value.blockers.length ||
        !["unchanged", "changed"].includes(String(value.plan?.status)) || value.plan?.storedHash !== inspection.snapshot.planHash ||
        value.plan.observedHash !== sha256(readFileSync(inspection.snapshot.sourcePath)) ||
        typeof value.source?.root !== "string" || boardWorkspace(value.source.root).physicalRoot !== value.source.root ||
        store.verifyRepositoryAssociation(value.source.root) !== inspection.repositoryId ||
        value.source.manifest?.hash !== captureWorkspaceImage(value.source.root).manifest.hash ||
        // Later effects and owner release carry their own whole-history proof
        // below; their occurrence alone does not stale a clean recovery report.
        events.some((event) => event.seq > value.disposition!.observedSeq! && event.seq !== report.seq &&
          ["mission.revised", "mission.import.conflict", "mission.blocked", "mission.imported", "mission.hold.reconciled",
            "effect.unknown", "effect.observation.recorded"].includes(event.kind))) {
        blockers.push("recovery:unresolved");
      }
    } catch { blockers.push("recovery:unproven"); }
  }
  if (events.some((event) => event.kind === "mission.owner.released" && event.payload.effectsQuiescent !== true))
    blockers.push("recovery:owner-not-quiescent");
  const exposure = auditCompletionEvidence(events, store, inspection);
  blockers.push(...exposure.effects, ...exposure.writers);
  if (events.some((event) => {
    if (event.kind !== "mission.blocked") return false;
    // A report label cannot erase an unclassified global cause. Only an exact
    // recovered producer, with its own settled receipt and audited effects, can.
    if (!report || event.seq > report.seq || !event.attemptId || !event.unitId ||
      exposure.writers.includes(`writer:${event.attemptId}`)) return true;
    return !Object.values(state.attempts).some((attempt) =>
      attempt.binding.recoveryOf === event.attemptId && attempt.binding.unitId === event.unitId &&
      attempt.binding.revision === inspection.revision && attempt.settled && attempt.status === "succeeded" &&
      attempt.receipt?.status === "completed");
  })) blockers.push("recovery:unproven");
  if (!definition.units.length || Object.values(state.units).some(({ status }) => status !== "accepted")) blockers.push("unit:incomplete");
  const predicateIds = definition.finalization.selections?.ordinary ??
    [...new Set(definition.units.flatMap(({ acceptance }) => acceptance.map(({ id }) => id)))];
  for (const predicateId of new Set([...predicateIds, ...(definition.schemaVersion === 1 ? definition.finalization.requiredPredicates : [])])) {
    const unit = definition.units.find(({ acceptance }) => acceptance.some(({ id }) => id === predicateId));
    const accepted = [...events].reverse().find((event) => event.kind === "unit.accepted" && event.revision === inspection.revision &&
      (event.unitId ?? event.payload.unitId) === unit?.id);
    const evidence = [...state.evidence].reverse().find((item) => item.predicateId === predicateId && item.unitId === unit?.id &&
      item.revision === inspection.revision && item.verdict === "pass" &&
      Array.isArray(accepted?.payload.evidenceIds) && accepted.payload.evidenceIds.includes(item.id));
    if (!unit || !evidence || !accepted || !state.units[unit.id] || state.units[unit.id].status !== "accepted") {
      blockers.push(`predicate:${predicateId}`);
      continue;
    }
    if (evidence.artifactHash) {
      try { store.readArtifact(evidence.artifactHash); }
      catch { blockers.push(`predicate:${predicateId}:artifact-missing`); }
    }
  }
  let manifest: MissionFinalManifest | undefined;
  let manifestHash = "", approvalHash = "";
  if (definition.finalization.contractVersion !== 1 || definition.finalization.independentReview !== true) {
    blockers.push("finalization:complete-result-contract-missing");
    blockers.push("finalization:integrated-manifest-and-checks-missing");
    blockers.push("finalization:cleanup-and-independent-review-missing");
  } else try {
    const reviewed = [...events].reverse().find((row) => row.kind === "mission.finalization.reviewed" && row.revision === inspection.revision);
    if (!reviewed) throw new Error("whole-result-approval-missing");
    manifestHash = String(reviewed.payload.manifestHash);
    approvalHash = String(reviewed.payload.approvalHash);
    manifest = JSON.parse(store.readArtifact(manifestHash).toString()) as MissionFinalManifest;
    const witness = JSON.parse(store.readArtifact(manifest.sourceWitnessHash).toString());
    if (store.verifyRepositoryAssociation(witness.root) !== inspection.repositoryId ||
      boardWorkspace(witness.root).physicalRoot !== witness.root) throw new Error("source-association");
    const approval = currentWholeResultApproval(inspection, store, witness.root);
    const identity = finalizationInputIdentity(inspection, captureWorkspaceImage(witness.root).manifest, witness.root, store);
    if (!approval || approval.manifestHash !== manifestHash || manifest.format !== "mission-final-manifest-v1" ||
      manifest.missionId !== inspection.id || manifest.revision !== inspection.revision ||
      manifest.planHash !== inspection.snapshot.planHash || manifest.definitionHash !== inspection.snapshot.definitionHash ||
      manifest.acceptedInputHash !== acceptedFinalizationInput(inspection) ||
      finalizationHash(identity) !== finalizationHash(manifest.inputIdentity)) throw new Error("stale-whole-result");
    const image = readSealedWorkspaceImage(store, manifest.resultImageHash);
    assertCompleteWorkspaceImage(image);
    if (image.manifest.hash !== manifest.resultManifestHash) throw new Error("result-manifest");
    const phaseRows = events.filter((row) => row.kind === "mission.finalization.phase.receipted" && row.revision === inspection.revision);
    if (phaseRows.length !== FINALIZATION_PHASES.length ||
      finalizationHash(phaseRows.slice(0, -1).map((row) => row.payload.receiptHash)) !== finalizationHash(manifest.phaseReceiptHashes))
      throw new Error("phase-order");
    let previous: FinalizationPhaseReceipt | undefined;
    for (const [index, row] of phaseRows.entries()) {
      const phase = JSON.parse(store.readArtifact(String(row.payload.receiptHash)).toString()) as FinalizationPhaseReceipt;
      const start = events.find((item) => item.kind === "mission.finalization.phase.started" && item.attemptId === row.attemptId);
      const attempt = state.attempts[phase.attemptId];
      if (phase.format !== "mission-finalization-phase-v1" || phase.missionId !== inspection.id || phase.revision !== inspection.revision ||
        phase.target.phase !== FINALIZATION_PHASES[index] || phase.attemptId !== row.attemptId || !start || start.seq >= row.seq ||
        previous && (phase.target.inputArtifactHash !== previous.outputArtifactHash || start.seq <= phaseRows[index - 1]!.seq) ||
        phase.target.acceptedInputHash !== manifest.acceptedInputHash || phase.target.sourceWitnessHash !== manifest.sourceWitnessHash ||
        phase.target.inputIdentityHash !== finalizationHash(identity) || phase.outputGeneration !== phase.target.generation ||
        phase.outputArtifactHash !== row.payload.outputArtifactHash ||
        finalizationHash(start.payload.target) !== finalizationHash(phase.target) ||
        !attempt?.settled || attempt.status !== "succeeded" ||
        finalizationHash(attempt.binding.finalization) !== finalizationHash(phase.target)) throw new Error("phase-binding");
      assertCompleteWorkspaceImage(readSealedWorkspaceImage(store, phase.outputArtifactHash));
      if (["integrated-checks", "affected-checks", "final-gates"].includes(phase.target.phase)) {
        if (phase.outputArtifactHash !== phase.target.inputArtifactHash) throw new Error("gate-edited-result");
        const observations = phase.evidenceHashes.map((hash) => {
          try { return JSON.parse(store.readArtifact(hash).toString()); } catch { return {}; }
        })
          .filter((value) => value.format === "mission-predicate-observation-v1");
        const selected = definition.finalization.selections?.[phase.target.phase === "integrated-checks" ? "integrated" :
          phase.target.phase === "affected-checks" ? "affected" : "final"] ?? definition.finalization.requiredPredicates;
        if (observations.length !== selected.length) throw new Error("phase-selection");
        for (const id of selected) {
          const predicate = definition.units.flatMap((unit) => unit.acceptance).find((item) => item.id === id);
          const matches = observations.filter((item) => item.predicate?.id === id);
          if (matches.length !== 1 || matches[0].verdict !== "pass" ||
            finalizationHash(matches[0].predicate) !== finalizationHash(predicate) ||
            matches[0].predicateHash !== finalizationHash(predicate) || matches[0].checkerIdentity !== MISSION_CHECK_IDENTITY ||
            matches[0].runtimeIdentity !== missionCheckRuntime() || matches[0].inputBindingHash !== finalizationHash(phase.target) ||
            finalizationHash(matches[0].subject) !== finalizationHash({ kind: "workspace", imageHash: phase.target.inputArtifactHash }))
            throw new Error(`gate:${id}`);
        }
      }
      if (["ponytail", "cleanup"].includes(phase.target.phase)) {
        const response = parseFinalizationResponse(store.readArtifact(String(attempt.receipt?.artifactHash)).toString());
        const expected = phase.target.phase === "ponytail" ? ["Ponytail"] : ["Unslop", "remove-ai-slops"];
        if (response.format !== "mission-finalization-cleanup-v1" || response.phase !== phase.target.phase ||
          response.inputArtifactHash !== phase.target.inputArtifactHash || !Array.isArray(response.scope) ||
          !Array.isArray(response.steps) || response.steps.length !== expected.length ||
          response.steps.some((step: { skill: string; changedPaths: string[]; noOpReason?: string }, i: number) =>
            step.skill !== expected[i] || !Array.isArray(step.changedPaths) ||
            step.changedPaths.some((name) => !response.scope.includes(name)) ||
            !step.changedPaths.length && !step.noOpReason?.trim())) throw new Error("cleanup-scope");
      }
      previous = phase;
    }
    if (previous!.outputGeneration !== manifest.generation || previous!.outputArtifactHash !== manifest.resultImageHash ||
      previous!.target.manifestHash !== manifestHash || approval.attemptId !== previous!.attemptId ||
      approval.instanceId !== state.attempts[approval.attemptId]?.receipt?.instanceId ||
      events.some((row) => row.kind === "attempt.receipt" && row.attemptId !== approval.attemptId &&
        row.payload.instanceId === approval.instanceId)) throw new Error("distinct-review");
    for (const unit of definition.units) {
      readAcceptedWorkspaceContribution(store, inspection, unit.id);
      if (unit.team) for (const round of TEAM_ROUNDS) {
        const barrier = [...events].reverse().find((row) => row.kind === "team.barrier.recorded" && row.revision === inspection.revision &&
          row.unitId === unit.id && (row.payload.targetId ?? unit.id) === unit.id && row.payload.round === round);
        if (barrier?.payload.status !== "complete") throw new Error(`team-barrier:${unit.id}:${round}`);
      }
    }
  } catch (error) { blockers.push(`finalization:${error instanceof Error ? error.message : "unproven"}`); }
  if (blockers.length || !manifest) return { blockers: [...new Set(blockers)] };
  const completion = [...events].reverse().find((row) => row.kind === "mission.completed");
  const publication = [...events].reverse().find((row) => row.kind === "mission.finalization.published");
  const finalEvidence = state.requiredPredicates.map((predicateId) => {
    const unit = definition.units.find((item) => item.acceptance.some((p) => p.id === predicateId))!;
    const accepted = [...events].reverse().find((row) => row.kind === "unit.accepted" && row.unitId === unit.id && row.revision === inspection.revision)!;
    const evidence = [...state.evidence].reverse().find((item) => item.predicateId === predicateId &&
      item.revision === state.revision && item.verdict === "pass" &&
      Array.isArray(accepted.payload.evidenceIds) && accepted.payload.evidenceIds.includes(item.id))!;
    return { id: evidence.id, predicateId, artifactHash: evidence.artifactHash };
  });
  const unsigned = {
    schemaVersion: 1 as const, missionId: inspection.id, planId: inspection.planId, revision: state.revision,
    eventSequence: completion?.seq ?? (publication?.seq ?? inspection.latestSeq + 1) + 1, finalEvidence,
    manifestHash, approvalHash, resultImageHash: manifest.resultImageHash, generation: manifest.generation,
    runtimeIdentity: missionCheckRuntime(),
    ...(inspection.prepared && inspection.revision !== inspection.prepared.binding.revision ?
      { sourceIdentity: missionInputIdentity(inspection, inspection.prepared.binding.executionRoot) } : {}),
    unresolvedHolds: [], unresolvedEffects: [],
  };
  const certificate = { ...unsigned, certificateHash: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") };
  if (completion) {
    try {
      if (!publication || publication.seq + 1 !== completion.seq ||
        publication.payload.manifestHash !== manifestHash || publication.payload.approvalHash !== approvalHash ||
        completion.payload.certificateArtifactHash !== publication.payload.certificateArtifactHash ||
        finalizationHash(certificate) !== publication.payload.certificateArtifactHash ||
        finalizationHash(JSON.parse(store.readArtifact(String(publication.payload.certificateArtifactHash)).toString())) !== finalizationHash(certificate))
        return { blockers: ["finalization:publication-unproven"] };
    } catch { return { blockers: ["finalization:publication-unproven"] }; }
  }
  return { blockers: [], certificate };
}

export function missionCompletionBlockers(inspection: MissionInspection, store: MissionStore): string[] {
  return assessMissionCompletion(inspection, store).blockers;
}

export function missionCompletionCertificate(inspection: MissionInspection, store: MissionStore): MissionCompletionCertificate | undefined {
  if (reduceMissionEvents(inspection).state !== "completed") return;
  return assessMissionCompletion(inspection, store).certificate;
}
