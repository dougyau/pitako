import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AttemptExecutor, AgentRunResult, DurableAttemptContext, ProviderRequestReceipt } from "../agent/run.ts";
import { runAgentInstance } from "../agent/run.ts";
import type { LoadOptions } from "../roles/load.ts";
import type { ModelTarget } from "../roles/types.ts";
import type { MissionEvent, MissionMeasurement, MissionUnit } from "./model.ts";
import type { MissionEventDraft, MissionStore, Reservation } from "./store.ts";
import { captureWorkspaceImage, captureWorkspacePaths, createMissionWorkspace, filterWorkspaceImage, preflightContainment, quarantineWorkspace, registerCandidateWorkspace, restoreWorkspaceImage, verifyPrivateCandidate, type CandidateRegistration, type ManifestPath, type MissionWorkspace } from "./workspace.ts";
import { readAcceptedWorkspaceContribution, readContributionInput, type ContributionInput, canonicalDeliveryManifest, integrateAcceptedMissionOutputs, assertCompleteWorkspaceImage, pauseRecoveryCurrent, importedHoldReconciled, mergeWorkspaceImages, missionEffectProcessesQuiescent, missionHasUnresolvedEffects, readSealedWorkspaceImage, reconcileLegacyHolds, reconcileMission, recoveryDiagnosisBrief, recoveryObservationCurrent, sealWorkspaceImage, serializeRecoveryOverlapAnswer, sensitiveArtifactPath, type LegacyHoldVerificationInput, type LegacyHoldVerificationProof, type RecoveryDiagnosisAdmission, type RecoveryReport, type RecoveryOverlapAnswer, type RecoveryOverlapRequest } from "./reconcile.ts";
import { MissionEffects } from "./effects.ts";
import { lifecycleRecoveryCurrent } from "./reconcile.ts";
import { assessMissionPredicate, MISSION_CHECK_IDENTITY, type BoundPredicateSubject } from "./checks.ts";
import { pendingMissionQuestions, pendingQuestionClosure } from "./admission.ts";
import { registerMissionOwner } from "./lifecycle.ts";
import { currentProcessIdentity, ownerProcessState, type ProcessIdentity } from "./workspace.ts";
import { authorizeRoleDispatch, mintEngineRoleDispatchAdmission } from "../agent/managed-mission.ts";
import { TEAM_ROUNDS, parseConsultationRequest, parseTeamResponse, type ConsultationRequest, type TeamBundle, type TeamFinding, type TeamRound } from "./team-contract.ts";
import { FINALIZATION_OWNER, FINALIZATION_PHASES, acceptedFinalizationInput, compileFinalizationGrants, finalizationInputIdentity,
  observeSourceMutation, sourceWitnessCurrent, parseWholeResultResponse, type FinalizationTarget, type FinalizationPhaseReceipt,
  type MissionFinalManifest, type WholeResultApproval } from "./finalization.ts";

export type MissionState = "prepared" | "running" | "blocked" | "completing" | "completed" | "paused" | "cancelled";
export type MissionUnitState = "pending" | "ready" | "running" | "verifying" | "accepted" | "blocked";
export type AttemptState = "reserved" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "yielded";

export interface MissionAttemptBinding {
  finalization?: FinalizationTarget;
  missionId: string;
  revision: number;
  unitId: string;
  roundId: string;
  memberId: string;
  attemptId: string;
  attemptNo: number;
  correctionNo?: number;
  recoveryOf?: string;
  ownerEpoch: number;
  candidate: "read-only" | "managed";
  candidateId?: string;
  candidateRoot?: string;
  candidateRegistration?: CandidateRegistration;
  predicateInputBindingsHash?: string;
  predicateInputBindingsComplete?: boolean;
  recoveryContinuationId?: string;
  recoveryImageHash?: string;
  recoveryMode?: "verify" | "repair";
  repairAuthorizationId?: string;
  workspaceManifestHash?: string;
  inputManifestHash: string;
  briefHash: string;
  rolePolicyHash: string;
  role?: string;
  targetId?: string;
  consultationId?: string;
  continuationOf?: string;
  checkpointHash?: string;
  childResultHash?: string;
  teamBundleHash?: string;
  teamOutputContractHash?: string;
}

export interface MissionEvidence {
  id: string;
  unitId: string;
  predicateId: string;
  revision: number;
  verdict: "pass" | "fail" | "inconclusive";
  inputManifestHash: string;
  outputManifestHash: string;
  method: string;
  artifactHash: string | null;
  attemptId: string;
  predicateHash?: string;
  inputPatterns?: string[];
  inputBindingHash?: string;
  inputIndexEntries?: MissionPredicateInputBinding["inputIndexEntries"];
  rolePolicyHash?: string;
  dependencyEvidence?: MissionPredicateInputBinding["dependencyEvidence"];
  assessmentToolIdentity?: string;
  runtimeIdentity?: string;
  assessmentAuthority?: "production-checker" | "injected-test";
}

export interface MissionPredicateInputBinding {
  predicateId: string;
  predicateHash: string;
  inputPatterns: string[];
  inputPaths: ManifestPath[];
  inputIndexEntries: Array<{ path: string; mode: string; objectId: string; stage: number }>;
  rolePolicyHash: string;
  dependencyEvidence: Array<{ unitId: string; evidenceId: string; predicateId: string; outputManifestHash: string }>;
  assessmentToolIdentity: string;
  runtimeIdentity: string;
  inputBindingHash: string;
  complete: boolean;
}

export interface MissionAttemptProjection {
  binding: MissionAttemptBinding;
  status: AttemptState;
  receipt?: Record<string, unknown>;
  settled: boolean;
}

export interface MissionEngineSnapshot {
  missionId: string;
  revision: number;
  state: MissionState;
  units: Record<string, { status: MissionUnitState; evidenceIds: string[]; reason?: string }>;
  attempts: Record<string, MissionAttemptProjection>;
  evidence: MissionEvidence[];
  providerRequests: Array<Record<string, unknown>>;
  resourceWaits: Array<Record<string, unknown>>;
  activeTimeMs: number;
  admissionFenced: boolean;
  admissionFenceReason?: string;
  canFinalize: boolean;
  requiredPredicates: string[];
}

export interface MissionPredicateObservation {
  verdict: "pass" | "fail" | "inconclusive";
  method: string;
  outputManifestHash?: string;
  artifactHash?: string;
  artifactBytes?: Uint8Array;
  artifactMediaType?: string;
  artifacts?: Array<{ bytes: Uint8Array; mediaType: string }>;
  authority?: "production-checker";
}

export interface MissionRoleInput {
  missionId: string;
  unit: MissionUnit;
  binding: MissionAttemptBinding;
  brief: string;
}

export type MissionRoleRunner = (input: MissionRoleInput, durable: DurableAttemptContext) => Promise<AgentRunResult>;

export interface MissionExternalProbeInput {
  missionId: string;
  effectId: string;
  operation: string;
  grantId: string;
  target: string;
  operationKey: string;
  requestHash: string;
  adapterId: string;
  adapterVersion: string;
}

export interface MissionExternalEffectProbeAdapter {
  grantId: string;
  adapterId: string;
  adapterVersion: string;
  probe(input: MissionExternalProbeInput): Promise<{ disposition: "applied" | "not-applied" | "unknown"; evidence: unknown }>;
}

export interface MissionEngineOptions {
  store: MissionStore;
  missionId: string;
  sessionsDirectory: string;
  runRole: MissionRoleRunner;
  managedWorkspace?: { sourceRoot: string; candidateParent?: string; productRoot?: string; bwrapPath?: string; otherCandidates?: string[] };
  externalEffectProbes?: Readonly<Record<string, MissionExternalEffectProbeAdapter>>;
  verifyLegacyHold?: (hold: LegacyHoldVerificationInput) => Promise<LegacyHoldVerificationProof>;
  ownerSessionId?: string;
  /** Test-only seam; injected verdicts cannot publish accepted output or integrated delivery authority. */
  assessPredicate?: (input: {
    unit: MissionUnit;
    predicate: MissionUnit["acceptance"][number];
    result: AgentRunResult;
    resultArtifact: Buffer;
    inputManifestHash: string;
  }) => Promise<MissionPredicateObservation> | MissionPredicateObservation;
  maxConcurrent?: number;
  now?: () => number;
  wallNow?: () => string;
  /** Private observational sink; never supplies admission authority. */
  captureRejection?: (observation: Record<string, unknown>) => void;
}

const RESOURCE_KEYS = ["role-launches", "provider-requests", "tokens", "active-time-ms", "artifact-bytes"] as const;
type BudgetResource = typeof RESOURCE_KEYS[number];
type ReservationPurpose = "ordinary" | "protected" | "finalization";
const ACTIVE_TIME_QUANTUM_MS = 60_000;
// Only the bundled Pi runner can attest that its awaited result followed SDK session disposal.
const disposedPiResults = new WeakMap<AgentRunResult, string>();

interface ManagedAttemptRuntime {
  workspace: MissionWorkspace;
  effects: MissionEffects;
  baseImage?: ReturnType<typeof captureWorkspaceImage>;
  contributionInput?: ContributionInput;
  dependencyOutputs: ContributionInput["dependencyOutputs"];
  verificationOnly: boolean;
  recoveryContinuationId?: string;
  recoveryImageHash?: string;
  recoveryMode?: "verify" | "repair";
  repairAuthorizationId?: string;
}

class ManagedWorkspaceError extends Error {}
class RecoveryAdmissionError extends Error {}
class ComputeSlotBusyError extends RecoveryAdmissionError {}

class HostPauseAbort extends Error {
  readonly pauseEventId: string;
  readonly attemptId: string;
  constructor(pauseEventId: string, attemptId: string) {
    super("host pause");
    this.name = "HostPauseAbort";
    this.pauseEventId = pauseEventId;
    this.attemptId = attemptId;
  }
}

function isHostPauseAbort(value: unknown): value is HostPauseAbort {
  return value instanceof HostPauseAbort;
}

function linkedPauseId(payload: Record<string, unknown>): string | undefined {
  const interruption = payload.interruption;
  if (!interruption || typeof interruption !== "object") return undefined;
  const id = (interruption as Record<string, unknown>).pauseEventId;
  return typeof id === "string" ? id : undefined;
}

interface ActiveTimeWindow {
  id: string;
  reservationId: string;
  grantAmount: number;
  knownCharge: number;
  unknownCharge: number;
  released: number;
  fractionalMs: number;
  lastCheckpointAt: number;
  ownerEpoch: number;
  runtimeId: string;
}

export function reduceMissionEvent(state: MissionEngineSnapshot, event: MissionEvent): MissionEngineSnapshot {
  if (event.missionId !== state.missionId) return state;
  if (event.kind === "mission.revised") {
    const next = structuredClone(state);
    const impact = new Set((event.payload.impact as string[]) ?? []);
    const retained = new Set((event.payload.retained as string[]) ?? []);
    next.revision = event.revision;
    next.units = Object.fromEntries((event.payload.snapshot as { units: Array<{ id: string }> }).units.map(({ id }) =>
      [id, retained.has(id) && next.units[id] ? next.units[id] : { status: "pending", evidenceIds: [] }]));
    next.evidence = next.evidence.filter(({ unitId }) => retained.has(unitId) && !impact.has(unitId));
    next.requiredPredicates = (event.payload.requiredPredicates as string[]) ?? next.requiredPredicates;
    if (next.state === "completing") next.state = "running";
    next.canFinalize = allRequiredPredicatesAccepted(next);
    return next;
  }
  if (event.revision !== state.revision) {
    if (event.kind !== "attempt.receipt" && event.kind !== "attempt.settled" && event.kind !== "attempt.interrupted") return state;
    const next = structuredClone(state);
    const attempt = next.attempts[String(event.payload.attemptId)];
    if (!attempt) return state;
    if (event.kind === "attempt.receipt") attempt.receipt = event.payload;
    else { attempt.settled = true; attempt.status = "interrupted"; }
    return next;
  }
  const next = structuredClone(state);
  const payload = event.payload;
  switch (event.kind) {
    case "mission.activated": next.state = "running"; break;
    case "mission.blocked": if (next.state !== "paused" && next.state !== "cancelled" && next.state !== "completed") next.state = "blocked"; break;
    case "mission.completed": next.state = "completed"; break;
    case "mission.paused": next.state = "paused"; break;
    case "mission.resumed": next.state = "running"; break;
    case "mission.cancelled": next.state = "cancelled"; break;
    case "mission.recovery.recorded":
      if (!["paused", "cancelled", "completed"].includes(next.state))
        next.state = payload.status === "resumed" ? "running" : "blocked";
      break;
    case "evidence.invalidated": {
      const ids = new Set(Array.isArray(payload.evidenceIds) ? payload.evidenceIds.map(String) : []);
      next.evidence = next.evidence.filter(({ id }) => !ids.has(id));
      const unit = next.units[event.unitId ?? String(payload.unitId)];
      if (unit) { unit.status = "ready"; delete unit.reason; }
      break;
    }
    case "unit.ready": {
      const unit = next.units[event.unitId ?? String(payload.unitId)];
      if (unit) { unit.status = "ready"; delete unit.reason; }
      break;
    }
    case "unit.verifying": {
      const unit = next.units[event.unitId ?? String(payload.unitId)];
      if (unit) unit.status = "verifying";
      break;
    }
    case "unit.accepted": {
      const unit = next.units[event.unitId ?? String(payload.unitId)];
      if (unit) { unit.status = "accepted"; unit.evidenceIds = Array.isArray(payload.evidenceIds) ? payload.evidenceIds.map(String) : []; }
      break;
    }
    case "unit.blocked": {
      const unit = next.units[event.unitId ?? String(payload.unitId)];
      if (unit) { unit.status = "blocked"; unit.reason = String(payload.reason ?? "blocked"); }
      break;
    }
    case "attempt.reserved": {
      const binding = payload.binding as MissionAttemptBinding;
      next.attempts[binding.attemptId] = { binding, status: "reserved", settled: false };
      if (!binding.finalization) next.units[binding.unitId]!.status = "running";
      break;
    }
    case "attempt.started": {
      const attempt = next.attempts[String(payload.attemptId)];
      if (attempt) attempt.status = "running";
      break;
    }
    case "attempt.receipt": {
      const attempt = next.attempts[String(payload.attemptId)];
      if (attempt) {
        attempt.receipt = payload;
        attempt.status = payload.status === "completed" ? "succeeded" : payload.status === "cancelled" ? "cancelled" : "failed";
      }
      break;
    }
    case "attempt.settled": {
      const attempt = next.attempts[String(payload.attemptId)];
      if (attempt) {
        attempt.status = payload.status === "succeeded" ? "succeeded" : payload.status === "cancelled" ? "cancelled" : payload.status === "yielded" ? "yielded" : payload.status === "interrupted" ? "interrupted" : "failed";
        attempt.settled = true;
      }
      break;
    }
    case "attempt.interrupted": {
      const attemptId = String(payload.attemptId);
      const attempt = next.attempts[attemptId];
      if (attempt) {
        attempt.status = "interrupted";
        attempt.settled = true;
        const unit = next.units[attempt.binding.unitId];
        if (unit) { unit.status = "blocked"; unit.reason = String(payload.reason ?? "attempt interrupted"); }
      }
      break;
    }
    case "evidence.recorded":
      next.evidence.push(payload as unknown as MissionEvidence);
      break;
    case "provider.request.dispatched":
    case "provider.request.receipt":
      next.providerRequests.push(payload);
      break;
    case "budget.admission.fenced":
      next.admissionFenced = true;
      next.admissionFenceReason = String(payload.reason ?? event.reason ?? "resource overage");
      break;
    case "resource.wait":
      next.resourceWaits.push(payload);
      break;
    case "mission.active.duration":
      next.activeTimeMs += event.monotonicDurationMs ?? Number(payload.durationMs ?? 0);
      break;
    case "mission.active.window.checkpointed":
    case "mission.active.window.closed":
      next.activeTimeMs += Number(payload.durationMs ?? 0);
      break;
  }
  if (next.state === "running" && Object.values(next.units).length > 0 && Object.values(next.units).every(({ status }) => status === "accepted")) {
    next.state = "completing";
  }
  next.canFinalize = allRequiredPredicatesAccepted(next);
  return next;
}

export function reduceMissionEvents(inspection: ReturnType<MissionStore["inspectMission"]>): MissionEngineSnapshot {
  const original = inspection.events.find((event) => event.kind === "mission.created");
  const empty = initialSnapshot(inspection.id, original?.revision ?? inspection.revision, inspection.definition);
  if (original && Array.isArray(original.payload.unitIds)) {
    for (const id of original.payload.unitIds) empty.units[String(id)] ??= { status: "pending", evidenceIds: [] };
  }
  return inspection.events.reduce(reduceMissionEvent, empty);
}

/** Legacy reservations predate the counter; structured retry/repair lineage remains authoritative. */
export function missionCorrectionNo(events: readonly MissionEvent[], binding: MissionAttemptBinding, seen = new Set<string>()): number {
  if (binding.correctionNo !== undefined) return binding.correctionNo;
  if (seen.has(binding.attemptId)) throw new Error("correction lineage is cyclic");
  seen.add(binding.attemptId);
  const reserved = events.find((event) => event.kind === "attempt.reserved" && event.attemptId === binding.attemptId);
  const source = (id: unknown) => {
    const row = events.find((event) => event.kind === "attempt.reserved" && event.attemptId === id);
    if (!row) throw new Error("correction predecessor is missing");
    return missionCorrectionNo(events, row.payload.binding as MissionAttemptBinding, seen);
  };
  if (binding.recoveryOf) return source(binding.recoveryOf);
  if (binding.recoveryMode === "repair") {
    const authorization = events.find((event) => event.kind === "mission.recovery.repair.authorized" &&
      event.payload.authorizationId === binding.repairAuthorizationId);
    return source(authorization?.payload.verificationAttemptId) + 1;
  }
  if (binding.recoveryContinuationId) {
    const continuation = events.find((event) => event.kind === "mission.recovery.continuation.recorded" &&
      event.payload.continuationId === binding.recoveryContinuationId);
    if (continuation) return source(continuation.payload.sourceAttemptId);
  }
  const previous = [...events].reverse().find((event) => {
    if (event.kind !== "attempt.reserved" || event.seq >= (reserved?.seq ?? Infinity)) return false;
    const prior = event.payload.binding as MissionAttemptBinding;
    return prior.unitId === binding.unitId && (prior.targetId ?? prior.unitId) === (binding.targetId ?? binding.unitId) &&
      prior.roundId === binding.roundId && prior.memberId === binding.memberId;
  });
  if (previous && events.some((event) => event.kind === "unit.ready" && event.payload.retryOf === previous.attemptId &&
    event.seq > previous.seq && event.seq < (reserved?.seq ?? Infinity))) return source(previous.attemptId) + 1;
  if (binding.continuationOf) return source(binding.continuationOf);
  return previous ? source(previous.attemptId) : 0;
}

export function missionPolicyTargets(definition: ReturnType<MissionStore["inspectMission"]>["definition"], roleId: string): { primary: ModelTarget; fallbacks: ModelTarget[] } {
  const policy = definition.authority.rolePolicies[roleId];
  if (!policy) throw new Error(`mission has no frozen role policy for ${roleId}`);
  const qualify = (name: string) => name.includes("/") ? name : `${policy.provider}/${name}`;
  return {
    primary: { model: `${policy.provider}/${policy.model}` },
    fallbacks: policy.fallbacks.map((model) => ({ model: qualify(model) })),
  };
}

export function createPiMissionRunner(options: {
  cwd: string;
  executor: AttemptExecutor;
  load?: LoadOptions;
}): MissionRoleRunner {
  return async ({ unit, brief }, durable) => {
    const result = await runAgentInstance({
      roleId: unit.role,
      task: brief,
      cwd: durable.cwd ?? options.cwd,
      executor: options.executor,
      signal: durable.signal,
      load: options.load,
      durable,
    });
    disposedPiResults.set(result, hashJson(result));
    return result;
  };
}

export class MissionEngine {
  private readonly store: MissionStore;
  private readonly missionId: string;
  private readonly sessionsDirectory: string;
  private readonly runRole: MissionRoleRunner;
  private readonly assessPredicate?: MissionEngineOptions["assessPredicate"];
  private readonly captureRejection?: MissionEngineOptions["captureRejection"];
  private readonly managedWorkspace?: MissionEngineOptions["managedWorkspace"];
  private readonly externalEffectProbes: MissionEngineOptions["externalEffectProbes"];
  private readonly verifyLegacyHold: MissionEngineOptions["verifyLegacyHold"];
  private readonly ownerSessionId?: string;
  private readonly attemptControllers = new Map<string, AbortController>();
  private readonly effectRunners = new Set<MissionEffects>();
  private readonly attemptEffects = new Map<string, MissionEffects>();
  // An observational artifact alone cannot authorize a restart or a new writer.
  private readonly liveSingletonCheckpoints = new Map<string, string>();
  private unregisterOwner?: () => void;
  private retirement?: Promise<void>;
  private retired = false;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly wallNow: () => string;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly requestStarted = new Map<string, number>();
  private readonly attemptStarted = new Map<string, number>();
  private pumpPromise?: Promise<void>;
  private activeWindow?: ActiveTimeWindow;
  private activeTimer?: ReturnType<typeof setInterval>;
  private activeCheckpoint = Promise.resolve();
  private activeTimeFailure?: string;
  private recoveryChecked = false;
  private readonly engineId = randomUUID();
  private closed = false;

  constructor(options: MissionEngineOptions) {
    this.store = options.store;
    this.missionId = options.missionId;
    this.sessionsDirectory = path.resolve(options.sessionsDirectory);
    this.runRole = options.runRole;
    this.assessPredicate = options.assessPredicate;
    this.captureRejection = options.captureRejection;
    this.managedWorkspace = options.managedWorkspace;
    this.externalEffectProbes = options.externalEffectProbes;
    this.verifyLegacyHold = options.verifyLegacyHold;
    this.ownerSessionId = options.ownerSessionId;
    if (this.ownerSessionId) this.unregisterOwner = registerMissionOwner(this.ownerSessionId, this.missionId, this);
    this.maxConcurrent = Math.min(3, Math.max(1, Math.floor(options.maxConcurrent ?? 3)));
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => new Date().toISOString());
  }

  snapshot(): MissionEngineSnapshot {
    return reduceMissionEvents(this.store.inspectMission(this.missionId));
  }

  /** Records activation and starts the pump; caller receives no worker result. */
  start(operator?: { id: string; text: string }): void {
    if (this.closed) throw new Error("mission engine is closed");
    const inspection = this.store.inspectMission(this.missionId);
    const snapshot = reduceMissionEvents(inspection);
    if (snapshot.state === "prepared") this.activate(inspection, operator);
    else if (["paused", "cancelled", "completed"].includes(snapshot.state)) throw new Error(`mission ${snapshot.state} cannot start`);
    if (!this.pumpPromise) {
      if (snapshot.state === "blocked") this.recoveryChecked = false;
      const run = this.pump();
      const wrapped = run.finally(() => { if (this.pumpPromise === wrapped) this.pumpPromise = undefined; });
      this.pumpPromise = wrapped;
    }
  }

  async control(action: "pause" | "resume" | "cancel", operator?: { id: string; text: string }): Promise<void> {
    const inspection = this.store.inspectMission(this.missionId);
    const state = reduceMissionEvents(inspection);
    if (state.state === "cancelled" || state.state === "completed") throw new Error("terminal mission cannot be controlled");
    if (action === "resume") {
      await this.resumePaused("explicit operator resume", operator);
      return;
    }
    const latestPause = [...inspection.events].reverse().find((event) => event.kind === "mission.paused");
    if (action === "pause" && state.state === "paused" && latestPause?.payload.controlOrigin !== "lifecycle") {
      await this.closeActiveWindow();
      return;
    }
    const stopping = action === "pause" ? this.pauseTargets(inspection, state) : [];
    const committed = this.emit([this.event(inspection.revision, action === "pause" ? "mission.paused" : "mission.cancelled",
      `${this.missionId}:${action}:${inspection.version}`, {
        reason: `explicit operator ${action}`, resumeAfterClose: false,
        ...(operator ? { operatorInputId: operator.id, operatorText: operator.text, intervention: "operator_choice" } : {}),
        ...(action === "pause" ? {
          ...this.pauseBindings(stopping), controlOrigin: "operator",
        } : {}),
      })]);
    const pauseEvent = committed.find((event) => event.kind === "mission.paused");
    for (const effects of this.effectRunners) effects.fence();
    if (action === "pause" && pauseEvent) {
      for (const target of stopping) target.controller.abort(new HostPauseAbort(pauseEvent.eventId, target.attemptId));
    } else {
      for (const controller of this.attemptControllers.values()) controller.abort(new Error(`mission ${action}`));
    }
    if (action === "pause") {
      // Accounting ends at the durable pause, not at assessment or SDK drain completion.
      // This does not establish disposal/quiescence or authorize receipt replay.
      await this.closeActiveWindow();
      await Promise.allSettled(stopping.map(({ attemptId }) => this.inFlight.get(attemptId)).filter((job): job is Promise<void> => Boolean(job)));
    }
    if (!await waitForSettlement(this.waitForIdle(), 5_000)) {
      await Promise.all([...this.effectRunners].map((effects) => effects.terminateOutstanding()));
      if (!await waitForSettlement(this.waitForIdle(), 5_000)) throw new Error(`mission ${action} is fenced; active worker still needs reconciliation`);
    }
    if (pauseEvent) this.denyUnprovenPauseStops(pauseEvent);
  }

  async resumeAfterClose(): Promise<void> {
    const inspection = this.store.inspectMission(this.missionId);
    const pause = [...inspection.events].reverse().find((event) => event.kind === "mission.paused");
    const release = [...inspection.events].reverse().find((event) => event.kind === "mission.owner.released");
    if (!inspection.definition.authority.resumeAfterClose || pause?.payload.controlOrigin !== "lifecycle" ||
      pause.payload.resumeAfterClose !== true || release?.payload.pauseEventId !== pause.eventId ||
      release.payload.effectsQuiescent !== true) throw new Error("saved close policy does not authorize automatic resume");
    await this.resumePaused("saved automatic resume after orderly close");
  }

  private async resumePaused(reason: string, operator?: { id: string; text: string }): Promise<void> {
    const inspection = this.store.inspectMission(this.missionId);
    if (reduceMissionEvents(inspection).state !== "paused") throw new Error("only a paused mission can resume");
    await Promise.allSettled([...this.inFlight.values()]);
    await this.pumpPromise;
    const current = this.store.inspectMission(this.missionId);
    if (current.revision !== inspection.revision || reduceMissionEvents(current).state !== "paused")
      throw new Error("pause or revision changed before resume");
    this.emit([this.event(inspection.revision, "mission.resumed", `${this.missionId}:resume:${inspection.version}`, {
      reason, ...(operator ? { operatorInputId: operator.id, operatorText: operator.text, intervention: "operator_choice" } : {}),
    })]);
    this.recoveryChecked = false;
    this.start();
  }

  async waitForIdle(): Promise<void> {
    await this.pumpPromise;
  }

  fenceRevisedUnits(impact: readonly string[]): void {
    this.recoveryChecked = false;
    const affected = new Set(impact);
    for (const [attemptId, controller] of this.attemptControllers) {
      const attempt = this.snapshot().attempts[attemptId];
      if (!attempt || !affected.has(attempt.binding.unitId) || attempt.binding.revision === this.snapshot().revision) continue;
      this.attemptEffects.get(attemptId)?.fence();
      controller.abort(new Error("mission unit contract was revised"));
    }
    if (!this.pumpPromise && !this.closed && this.snapshot().state === "running") this.start();
  }

  fenceQuestionUnits(impact: readonly string[]): void {
    const affected = new Set(impact);
    for (const [attemptId, controller] of this.attemptControllers) {
      const attempt = this.snapshot().attempts[attemptId];
      if (attempt && affected.has(attempt.binding.unitId)) {
        this.attemptEffects.get(attemptId)?.fence();
        controller.abort(new Error("operator choice pending for this unit"));
      }
    }
  }

  async releaseQuestionUnits(impact: readonly string[]): Promise<void> {
    const affected = new Set(impact);
    await Promise.allSettled([...this.inFlight].filter(([id]) => {
      const attempt = this.snapshot().attempts[id];
      return attempt && affected.has(attempt.binding.unitId);
    }).map(([, job]) => job));
    const inspection = this.store.inspectMission(this.missionId);
    const state = reduceMissionEvents(inspection);
    const stillHeld = pendingQuestionUnits(inspection.events, inspection.definition, this.store);
    const recovery = recoveryBlockedUnits(this.store, inspection, this.managedWorkspace?.sourceRoot);
    const events = [...affected].filter((id) => state.units[id]?.status === "blocked" && !stillHeld.has(id) &&
      recovery !== null && !recovery.has(id)).map((id) =>
      this.event(inspection.revision, "unit.ready", `${this.missionId}:${id}:question-released:${inspection.version}`, {
        unitId: id, reason: "operator withdrew pending choice", readyRuntimeId: this.store.runtimeId, readyMonotonicMs: this.now(),
      }, id));
    if (events.length) this.emit(events);
    if (!this.pumpPromise && !this.closed && this.snapshot().state === "running") this.start();
  }

  cancelAttempt(attemptId: string): boolean {
    if (this.closed || this.retired || this.retirement || this.store.ownerEpoch === null) return false;
    const inspection = this.store.inspectMission(this.missionId);
    const state = reduceMissionEvents(inspection);
    const attempt = state.attempts[attemptId];
    const consultation = inspection.events.find((event) => event.kind === "team.consultation.admitted" &&
      event.payload.parentAttemptId === attemptId);
    if (consultation && attempt?.status === "yielded" &&
      !inspection.events.some((event) => event.kind === "team.consultation.cancelled" && event.payload.parentAttemptId === attemptId) &&
      !["accepted", "cancelled", "completed"].includes(state.units[attempt.binding.unitId]?.status ?? "") &&
      !["cancelled", "completed"].includes(state.state)) {
      const targets = new Set([String(consultation.payload.targetId)]);
      for (const event of inspection.events) if (event.kind === "team.consultation.admitted" &&
        targets.has(String(event.payload.parentTargetId))) targets.add(String(event.payload.targetId));
      this.emit([
        this.event(inspection.revision, "team.consultation.cancelled", `${attemptId}:consultation-cancelled`, {
          parentAttemptId: attemptId, targetId: consultation.payload.targetId, requestId: consultation.payload.requestId,
          reason: "managed assignment cancellation requested",
        }, attempt.binding.unitId, attemptId),
        this.event(inspection.revision, "unit.blocked", `${attemptId}:consultation-cancelled-unit`, {
          unitId: attempt.binding.unitId, attemptId, reason: "managed consultation branch cancelled; no continuation authorized",
        }, attempt.binding.unitId, attemptId),
      ]);
      for (const [id, controller] of this.attemptControllers) {
        const binding = state.attempts[id]?.binding;
        if (binding && (targets.has(binding.targetId ?? binding.unitId) || binding.continuationOf === attemptId)) {
          this.attemptEffects.get(id)?.fence();
          controller.abort(new Error("managed consultation branch cancelled"));
        }
      }
      return true;
    }
    const pauseRecovery = attempt?.binding.recoveryContinuationId && inspection.events.some((event) =>
      event.kind === "mission.recovery.continuation.recorded" && event.payload.pauseEventId &&
      event.payload.continuationId === attempt.binding.recoveryContinuationId);
    if (attempt && attempt.binding.revision === inspection.revision &&
      (attempt.status === "interrupted" && inspection.events.some((event) => event.kind === "attempt.settled" &&
        event.attemptId === attemptId && linkedPauseId(event.payload)) || !attempt.settled && pauseRecovery) &&
      !["cancelled", "completed"].includes(state.state) && state.units[attempt.binding.unitId]?.status !== "accepted" &&
      !inspection.events.some((event) => event.kind === "team.consultation.cancelled" && event.unitId === attempt.binding.unitId)) {
      this.emit([this.event(inspection.revision, "team.consultation.cancelled", `${attemptId}:pause-recovery-cancelled`, {
        parentAttemptId: attempt.binding.continuationOf ?? attemptId, requestId: attempt.binding.consultationId ?? null,
        targetId: attempt.binding.targetId ?? attempt.binding.unitId, reason: "managed pause-recovery assignment cancellation requested",
      }, attempt.binding.unitId, attemptId), this.event(inspection.revision, "unit.blocked", `${attemptId}:pause-recovery-cancelled-unit`, {
        unitId: attempt.binding.unitId, reason: "managed pause-recovery assignment cancelled; no recovery authorized",
      }, attempt.binding.unitId)]);
      for (const [id, controller] of this.attemptControllers) if (state.attempts[id]?.binding.unitId === attempt.binding.unitId) {
        this.attemptEffects.get(id)?.fence();
        controller.abort(new Error("managed pause-recovery assignment cancelled"));
      }
      return true;
    }
    const controller = this.attemptControllers.get(attemptId);
    if (!attempt || attempt.settled || attempt.receipt || !controller) return false;
    this.attemptEffects.get(attemptId)?.fence();
    controller.abort(new Error("managed assignment cancellation requested"));
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.pumpPromise;
    if (this.activeTimer) clearInterval(this.activeTimer);
    this.activeTimer = undefined;
    await this.activeCheckpoint;
    await this.closeActiveWindow();
    this.closed = true;
  }

  async retireForShutdown(reason: string): Promise<void> {
    if (this.retirement) return this.retirement;
    this.retirement = this.retireOwner(reason);
    return this.retirement;
  }

  private async retireOwner(reason: string): Promise<void> {
    const initial = this.store.inspectMission(this.missionId);
    const state = reduceMissionEvents(initial);
    const stopping = this.pauseTargets(initial, state);
    const navigation = ["new", "fork", "resume"].includes(reason);
    const pause = ["running", "blocked", "completing"].includes(state.state)
      ? this.emit([this.event(initial.revision, "mission.paused", `${this.missionId}:lifecycle-pause:${initial.version}`, {
        ...this.pauseBindings(stopping), controlOrigin: "lifecycle",
        reason: navigation ? `Pi session ${reason} requires explicit attach and resume` : `Pi session ${reason}`,
        resumeAfterClose: !navigation && initial.definition.authority.resumeAfterClose,
      })])[0] : undefined;
    this.closed = true;
    for (const effects of this.effectRunners) effects.fence();
    for (const [attemptId, controller] of this.attemptControllers)
      controller.abort(pause && stopping.some((target) => target.attemptId === attemptId)
        ? new HostPauseAbort(pause.eventId, attemptId) : new Error(`Pi session ${reason}`));
    await this.closeActiveWindow();
    const roleJobs = () => Promise.allSettled([...this.inFlight.values()]);
    let settled = await waitForSettlement(roleJobs(), 5_000);
    if (!settled) {
      await Promise.all([...this.effectRunners].map((effects) => effects.terminateOutstanding()));
      settled = await waitForSettlement(roleJobs(), 5_000);
    }
    if ([...this.effectRunners].some((effects) => !effects.quiescent)) {
      throw new Error("managed effects remain live; mission owner cannot be released");
    }
    if (pause) this.denyUnprovenPauseStops(pause);
    if (!settled) {
      const inspection = this.store.inspectMission(this.missionId);
      const ownerEpoch = this.store.ownerEpoch;
      if (ownerEpoch === null) throw new Error("mission owner epoch disappeared during retirement");
      const owner = currentProcessIdentity(this.store.runtimeId, ownerEpoch);
      const events = [...this.inFlight.keys()].flatMap((attemptId) => {
        const attempt = reduceMissionEvents(inspection).attempts[attemptId];
        if (!attempt) return [];
        return [
          this.event(inspection.revision, "attempt.interrupted", `${attemptId}:interrupted:${ownerEpoch}`, {
            attemptId, unitId: attempt.binding.unitId, reason: "Pi shutdown grace expired; late result fenced by owner release",
            owner, candidate: attempt.binding.candidateRoot ?? null,
          }, attempt.binding.unitId, attemptId),
          this.event(inspection.revision, "unit.blocked", `${attemptId}:shutdown-blocked:${ownerEpoch}`, {
            unitId: attempt.binding.unitId, attemptId, reason: "attempt interrupted during Pi shutdown; reconcile before retry",
          }, attempt.binding.unitId, attemptId),
        ];
      });
      events.push(this.event(inspection.revision, "mission.blocked", `${this.missionId}:shutdown-interrupted:${ownerEpoch}`, {
        reason: "one or more SDK sessions did not settle before Pi shutdown; results and provider exposure require reconciliation",
      }));
      this.emit(events);
    }
    if (this.activeTimer) clearInterval(this.activeTimer);
    this.activeTimer = undefined;
    await this.activeCheckpoint;
    await this.closeActiveWindow();
    const ownerEpoch = this.store.ownerEpoch;
    if (ownerEpoch === null) throw new Error("mission owner epoch disappeared before release");
    const releaseInspection = this.store.inspectMission(this.missionId);
    const resumablePause = this.inFlight.size === 0
      && ["prepared", "running"].includes(reduceMissionEvents(releaseInspection).state);
    this.retired = true;
    this.emit([this.event(releaseInspection.revision, "mission.owner.released", `${this.missionId}:owner-release:${ownerEpoch}`, {
      owner: currentProcessIdentity(this.store.runtimeId, ownerEpoch), reason, effectsQuiescent: true, resumablePause,
      ...(pause ? { pauseEventId: pause.eventId } : {}),
      interruptedAttempts: stopping.filter(({ attemptId }) =>
        !reduceMissionEvents(releaseInspection).attempts[attemptId]?.settled).map(({ attemptId }) => attemptId),
    })]);
    this.store.close();
    this.unregisterOwner?.();
    this.unregisterOwner = undefined;
  }

  private activate(inspection: ReturnType<MissionStore["inspectMission"]>, operator?: { id: string; text: string }): void {
    const { definition } = inspection;
    const launches = definition.units.reduce((total, unit) => total + (unit.team ? unit.team.members.length * 3 + 1 : 1), 0);
    const finalizationLaunches = definition.finalization.contractVersion === 1 ? 3 : 1 + Number(definition.finalization.independentReview);
    const mandatoryLaunches = launches + finalizationLaunches;
    if (mandatoryLaunches > definition.budget.roleLaunches) throw new Error(`mandatory path needs ${mandatoryLaunches} role launches; budget allows ${definition.budget.roleLaunches}`);
    if (mandatoryLaunches > definition.budget.providerRequests) throw new Error(`mandatory path needs ${mandatoryLaunches} provider requests; budget allows ${definition.budget.providerRequests}`);
    const tokensPerRequest = Math.max(1, Math.ceil(definition.budget.tokens / definition.budget.providerRequests));
    if (mandatoryLaunches * tokensPerRequest > definition.budget.tokens) throw new Error(`mandatory path needs ${mandatoryLaunches * tokensPerRequest} tokens; budget allows ${definition.budget.tokens}`);
    const activePerLaunch = Math.max(1, Math.ceil(definition.budget.activeTimeMs / definition.budget.roleLaunches));
    const artifactPerLaunch = Math.max(1, Math.ceil(definition.budget.artifactBytes / definition.budget.roleLaunches));
    let protectedAmounts: Record<BudgetResource, number> = {
      "role-launches": finalizationLaunches,
      "provider-requests": finalizationLaunches,
      tokens: finalizationLaunches * tokensPerRequest,
      "active-time-ms": finalizationLaunches * activePerLaunch,
      "artifact-bytes": finalizationLaunches * artifactPerLaunch,
    };
    const compiled = compileFinalizationGrants(definition);
    if (definition.finalization.contractVersion === 1) protectedAmounts = compiled.protectedAmounts;
    const pathAmounts: Record<BudgetResource, number> = {
      "role-launches": launches,
      "provider-requests": launches,
      tokens: launches * tokensPerRequest,
      "active-time-ms": launches * activePerLaunch,
      "artifact-bytes": launches * artifactPerLaunch,
    };
    const caps = budgetMap(definition.budget);
    for (const resource of RESOURCE_KEYS) {
      if (definition.finalization.contractVersion !== 1 && pathAmounts[resource] + protectedAmounts[resource] > caps[resource]) {
        throw new Error(`mandatory path plus protected finalization needs ${pathAmounts[resource] + protectedAmounts[resource]} ${resource}; budget allows ${caps[resource]}`);
      }
    }
    const events: MissionEventDraft[] = RESOURCE_KEYS.map((resource) => reservationDraft(
      this.missionId, inspection.revision, stableId(`${this.missionId}:protected:${resource}`), resource, protectedAmounts[resource], "protected", this.wallNow(),
    ));
    events.push(this.event(inspection.revision, "mission.activated", `${this.missionId}:activated`, {
      missionId: this.missionId, ...(definition.finalization.contractVersion === 1 ? { finalizationGrants: compiled.stages } : {}),
      rootLimits: { maxSessions: this.maxConcurrent, maxMutatingDevelopers: 1, maxDepth: 2 }, ...(operator ? { operatorInputId: operator.id, operatorText: operator.text, intervention: "operator_choice" } : {}),
    }));
    this.store.appendTransition(this.missionId, inspection.version, { events });
  }

  private sessionLimit(inspection: ReturnType<MissionStore["inspectMission"]>): number {
    const activated = inspection.events.find(({ kind }) => kind === "mission.activated");
    const saved = (activated?.payload.rootLimits as { maxSessions?: number } | undefined)?.maxSessions;
    return Math.min(this.maxConcurrent, Number.isSafeInteger(saved) && saved! >= 1 && saved! <= 3 ? saved! : 3);
  }

  private async pump(): Promise<void> {
    while (!this.closed) {
      if (!this.recoveryChecked) {
        const beforeRecovery = this.store.inspectMission(this.missionId);
        const root = this.managedWorkspace?.sourceRoot;
        const planFile = root ? path.join(root, ".pitako", "plans", `${beforeRecovery.planId}.md`) : undefined;
        if (this.managedWorkspace && root && planFile && !this.canReuseFinalization(beforeRecovery) &&
          missionNeedsRecovery(this.store, beforeRecovery, root, planFile)) {
          const imported = [...beforeRecovery.events].reverse().find((event) => event.kind === "mission.imported");
          if (this.verifyLegacyHold && imported?.payload.holdsKnown === true && typeof imported.payload.importKey === "string" &&
            Array.isArray(imported.payload.holds) && imported.payload.holds.some((hold: Record<string, unknown>) => hold.disposition === "unresolved")) {
            await reconcileLegacyHolds({
              store: this.store, missionId: this.missionId, importKey: imported.payload.importKey, verify: this.verifyLegacyHold,
            });
          }
          const pause = [...beforeRecovery.events].reverse().find((event) => event.kind === "mission.paused" &&
            Array.isArray(event.payload.stoppedAttempts) && event.payload.stoppedAttempts.length);
          let report: RecoveryReport;
          try {
            report = await reconcileMission({
              store: this.store, missionId: this.missionId, sourceRoot: root,
              ...(pause ? { orderlyPause: { pauseEventId: pause.eventId } } : {}),
              candidateParent: this.managedWorkspace.candidateParent,
              productRoot: this.managedWorkspace.productRoot,
              bwrapPath: this.managedWorkspace.bwrapPath,
              planFile,
              trigger: "engine-restart",
              assessmentToolIdentity: missionAssessmentToolIdentity(this.assessPredicate),
              runtimeIdentity: missionRuntimeIdentity(),
              probeExternal: async (input) => {
                const adapter = this.externalEffectProbes?.[input.grantId];
                if (!beforeRecovery.definition.authority.externalEffects.includes(input.grantId) || !adapter ||
                  adapter.grantId !== input.grantId || adapter.adapterId !== input.adapterId || adapter.adapterVersion !== input.adapterVersion) {
                  return { disposition: "unknown", evidence: { reason: "the saved external grant or adapter version is unavailable" } };
                }
                return adapter.probe(input);
              },
              resolveOverlap: {
                diagnose: (input) => this.consultRecoveryOverlap("developer", input),
                expertDisposition: (input) => {
                  if (!input.developerDiagnosis) return Promise.resolve({ disposition: "unresolved", reason: "Developer diagnosis receipt is unavailable" });
                  const expert = ["architect", "reviewer"].find((role) => beforeRecovery.definition.authority.rolePolicies[role]);
                  return expert
                    ? this.consultRecoveryOverlap(expert, input)
                    : Promise.resolve({ disposition: "unresolved", reason: "mission has no frozen architect or reviewer policy for expert disposition" });
                },
              },
            });
          } catch (error) {
            if (this.closed || this.retired || this.store.ownerEpoch === null) return;
            const current = this.store.inspectMission(this.missionId);
            if (["paused", "cancelled", "completed"].includes(reduceMissionEvents(current).state)) return;
            if (current.revision !== beforeRecovery.revision) continue;
            this.emit([this.event(current.revision, "mission.blocked", `${this.missionId}:recovery-observation-stale:${current.version}`, {
              reason: `recovery observation failed; no dispatch authorized: ${messageOf(error)}`,
            })]);
            return;
          }
          const observed = this.store.inspectMission(this.missionId);
          if (pause && (pause.payload.stoppedAttempts as Array<{ attemptId: string }>).some(({ attemptId }) =>
            !observed.events.some((event) => event.kind === "attempt.reserved" &&
              (event.payload.binding as MissionAttemptBinding).recoveryOf === attemptId) &&
            observed.events.find((event) => event.kind === "attempt.receipt" && event.attemptId === attemptId)?.payload.status !== "completed") &&
            report.status === "blocked" && !observed.events.some((event) =>
              event.kind === "mission.recovery.recorded" && event.payload.episodeId === report.episodeId)) {
            this.emit([this.event(observed.revision, "mission.blocked", `${this.missionId}:recovery-unproven:${observed.version}`, {
              reason: report.blockers.join("; "),
            })]);
            return;
          }
        }
        await this.reconcileRecoveredActiveWindow();
        await this.reconcileMissingProviderUsage();
        this.revalidateSingletonCheckpoints();
        this.recoveryChecked = true;
      }
      await this.reconcileReceipts();
      const inspection = this.store.inspectMission(this.missionId);
      const state = reduceMissionEvents(inspection);
      if (state.state === "completed" || state.state === "paused" || state.state === "cancelled") return;
      const recoveryScope = recoveryBlockedUnits(this.store, inspection, this.managedWorkspace?.sourceRoot);
      const questionUnits = pendingQuestionUnits(inspection.events, inspection.definition, this.store);
      if (recoveryScope === null || state.state === "blocked" && recoveryScope.size === 0) {
        if (this.inFlight.size) { await Promise.race(this.inFlight.values()); continue; }
        if (recoveryScope === null && missionHasUnresolvedEffects(this.store, inspection.events) && state.state !== "blocked")
          this.emit([this.event(inspection.revision, "mission.blocked", `${this.missionId}:unresolved-effect:${inspection.version}`, {
            reason: "unresolved local effect requires explicit recovery before dispatch",
          })]);
        return;
      }
      let launched = 0;
      for (const unit of state.admissionFenced ? [] : inspection.definition.units.filter(({ id }) => !recoveryScope.has(id) && !questionUnits.has(id))) {
        if (this.attemptControllers.size >= this.sessionLimit(inspection)) break;
        const current = state.units[unit.id]!;
        if (current.status === "accepted" || current.status === "blocked" || current.status === "verifying") continue;
        if (!unit.dependencies.every((id) => state.units[id]?.status === "accepted")) continue;
        if (unit.kind === "team" && !unit.team) {
          this.emit([this.event(inspection.revision, "unit.blocked", `${unit.id}:${inspection.revision}:team-contract-missing`, {
            unitId: unit.id, reason: "team unit lacks a versioned protocol contract; singleton dispatch is forbidden",
          }, unit.id)]);
          launched++;
          continue;
        }
        const singletonAdmission = !unit.team && inspection.events.find((event) =>
          event.kind === "team.consultation.admitted" && event.unitId === unit.id &&
          event.payload.parentTargetId === unit.id && typeof event.payload.checkpointHash === "string");
        if (singletonAdmission) {
          try {
            if (singletonAdmission.revision !== inspection.revision) throw new Error("consultation revision changed");
            this.singletonCheckpoint(inspection, String(singletonAdmission.payload.parentAttemptId),
              String(singletonAdmission.payload.checkpointHash));
          } catch (error) {
            this.emit([this.event(inspection.revision, "unit.blocked",
              `${singletonAdmission.payload.parentAttemptId}:singleton-lineage-fenced:${inspection.revision}`, {
                unitId: unit.id, reason: `singleton consultation cannot resume without its live checkpoint: ${messageOf(error)}`,
              }, unit.id)]);
            launched++;
            continue;
          }
        }
        if (unit.team || singletonAdmission) {
          const targets = inspection.events.filter((event) => event.kind === "team.consultation.admitted" &&
            event.unitId === unit.id && event.revision === inspection.revision).reverse();
          for (const target of targets) {
            if (this.attemptControllers.size >= this.sessionLimit(inspection)) break;
            launched += await this.advanceTeam(unit, String(target.payload.targetId));
          }
          if (unit.team && !launched) launched += await this.advanceTeam(unit);
          else if (!unit.team) launched += await this.advanceSingletonContinuation(unit);
          continue;
        }
        if (current.status === "running") continue;
        if (Object.values(state.attempts).some((attempt) => attempt.binding.unitId === unit.id && !attempt.settled)) continue;
        if (current.status === "pending") {
          const ready = this.event(inspection.revision, "unit.ready", `${this.missionId}:${unit.id}:ready:${this.nextAttemptNo(state, unit.id)}`, {
            unitId: unit.id,
            readyRuntimeId: this.store.runtimeId,
            readyMonotonicMs: this.now(),
          }, unit.id);
          this.emit([ready]);
        }
        const fresh = this.store.inspectMission(this.missionId);
        const freshState = reduceMissionEvents(fresh);
        if (freshState.units[unit.id]?.status !== "ready") continue;
        try {
          await this.checkActiveTimeBeforeEffect();
          const dispatchInspection = this.store.inspectMission(this.missionId);
          const dispatchState = reduceMissionEvents(dispatchInspection);
          const dispatchScope = recoveryBlockedUnits(this.store, dispatchInspection, this.managedWorkspace?.sourceRoot);
          if (!["running", "blocked"].includes(dispatchState.state) || dispatchScope === null || dispatchScope.has(unit.id) ||
            dispatchState.units[unit.id]?.status !== "ready" ||
            pendingQuestionUnits(dispatchInspection.events, dispatchInspection.definition, this.store).has(unit.id)) continue;
          const interrupted = Object.values(dispatchState.attempts).find((attempt) => attempt.binding.unitId === unit.id &&
            attempt.status === "interrupted" && this.pauseContinuation(dispatchInspection, attempt.binding));
          const attempt = await this.reserveAttempt(dispatchInspection, unit, dispatchState, undefined, undefined, interrupted?.binding);
          this.launchAttempt(unit, attempt.binding, attempt.runtime);
          launched += 1;
        } catch (error) {
          if (error instanceof RecoveryAdmissionError) continue;
          if (error instanceof ManagedWorkspaceError) {
            this.emit([
              this.event(fresh.revision, "unit.blocked", `${this.missionId}:${unit.id}:containment:${this.nextAttemptNo(freshState, unit.id)}`, {
                unitId: unit.id, reason: error.message, retryable: false,
              }, unit.id),
              this.event(fresh.revision, "mission.blocked", `${this.missionId}:${unit.id}:containment-blocked`, { reason: error.message }, unit.id),
            ]);
          } else {
            this.recordResourceWait(unit, this.nextAttemptNo(freshState, unit.id), error);
            this.emit([this.event(fresh.revision, "unit.blocked", `${this.missionId}:${unit.id}:budget:${this.nextAttemptNo(freshState, unit.id)}`, {
              unitId: unit.id, reason: `resource budget: ${messageOf(error)}`, retryable: false,
            }, unit.id)]);
          }
        }
      }
      if (launched > 0) continue;
      if (this.inFlight.size > 0) {
        await Promise.race(this.inFlight.values());
        continue;
      }
      const integrationInput = this.store.inspectMission(this.missionId);
      if (integrationInput.definition.finalization.contractVersion === 1 && !this.assessPredicate && this.managedWorkspace &&
        Object.values(reduceMissionEvents(integrationInput).units).every(({ status }) => status === "accepted")) {
        try {
          await this.finishActiveInterval();
          if (await this.advanceFinalization()) continue;
        } catch (error) {
          this.emit([this.event(integrationInput.revision, "mission.blocked", `${this.missionId}:integration-inconclusive:${integrationInput.version}`,
            { reason: `private finalization inconclusive: ${messageOf(error)}` })]);
        }
      }
      await this.finishActiveInterval();
      const settledInspection = this.store.inspectMission(this.missionId);
      const settledState = reduceMissionEvents(settledInspection);
      if (settledState.admissionFenced) {
        this.emit([this.event(settledInspection.revision, "mission.blocked", `${this.missionId}:budget-fenced`, {
          reason: `resource overage fenced new admission: ${settledState.admissionFenceReason ?? "budget overage"}`,
        })]);
        return;
      }
      if (Object.values(settledState.attempts).some((attempt) => attempt.receipt && !attempt.settled)) continue;
      const unresolvedAttempts = Object.values(settledState.attempts).filter((attempt) => !attempt.settled && !attempt.receipt);
      if (unresolvedAttempts.length) {
        const blocked = new Set(unresolvedAttempts.map(({ binding }) => binding.unitId));
        const events = unresolvedAttempts.map(({ binding }) => this.event(settledInspection.revision, "unit.blocked", `${binding.attemptId}:unreconciled`, {
          unitId: binding.unitId,
          attemptId: binding.attemptId,
          reason: "attempt has no durable receipt; writer disposition remains unresolved for T3",
        }, binding.unitId, binding.attemptId));
        let changed = true;
        while (changed) {
          changed = false;
          for (const unit of settledInspection.definition.units) {
            if (blocked.has(unit.id) || !unit.dependencies.some((id) => blocked.has(id))) continue;
            const unitState = settledState.units[unit.id];
            if (unitState?.status === "accepted" || unitState?.status === "blocked") continue;
            blocked.add(unit.id);
            changed = true;
            events.push(this.event(settledInspection.revision, "unit.blocked", `${this.missionId}:${unit.id}:unreconciled-dependency`, {
              unitId: unit.id,
              reason: "dependency has an unresolved attempt without a durable receipt",
            }, unit.id));
          }
        }
        events.push(this.event(settledInspection.revision, "mission.blocked", `${this.missionId}:unreconciled-active-attempt`, {
          reason: "unresolved attempts remain after independent ready work settled; T3 owner recovery is required",
        }));
        this.emit(events);
        return;
      }
      if (settledState.state === "blocked") return;
      const unresolved = Object.values(settledState.units).some(({ status }) => status === "pending" || status === "ready" || status === "verifying");
      if (!unresolved) return;
      const blockedDependencies = settledInspection.definition.units.filter((unit) => {
        const unitState = settledState.units[unit.id]!;
        return unitState.status === "pending" && unit.dependencies.some((id) => settledState.units[id]?.status === "blocked");
      });
      if (blockedDependencies.length) {
        const events = blockedDependencies.map((unit) => this.event(settledInspection.revision, "unit.blocked", `${this.missionId}:${unit.id}:dependency-blocked`, {
          unitId: unit.id, reason: "dependency lacks current accepted evidence",
        }, unit.id));
        this.emit(events);
      }
      return;
    }
  }

  private finalizationTargetCurrent(inspection: ReturnType<MissionStore["inspectMission"]>, target: FinalizationTarget): boolean {
    const started = [...inspection.events].reverse().find((event) => event.kind === "mission.finalization.phase.started" &&
      event.revision === inspection.revision);
    const generation = [...inspection.events].reverse().find((event) => event.kind === "mission.finalization.generation");
    return !!started?.payload.target && hashJson(started.payload.target) === hashJson(target) &&
      generation?.revision === inspection.revision && generation.payload.generation === target.generation &&
      !inspection.events.some((event) => event.kind === "mission.finalization.invalidated" && event.seq > started.seq) &&
      !!this.managedWorkspace && sourceWitnessCurrent(this.store, target.sourceWitnessHash, this.managedWorkspace.sourceRoot) &&
      target.inputIdentityHash === hashJson(finalizationInputIdentity(inspection, captureWorkspaceImage(this.managedWorkspace.sourceRoot).manifest, this.managedWorkspace.sourceRoot)) &&
      acceptedFinalizationInput(inspection) === target.acceptedInputHash;
  }

  private canReuseFinalization(inspection: ReturnType<MissionStore["inspectMission"]>): boolean {
    try {
      if (inspection.definition.finalization.contractVersion !== 1 || !this.managedWorkspace ||
        unresolvedLegacyHoldUnits(this.store, inspection.events, inspection.definition.units).size ||
        inspection.events.some((row) => row.kind === "mission.import.conflict") ||
        missionHasUnresolvedEffects(this.store, inspection.events)) return false;
      const attempts = Object.values(reduceMissionEvents(inspection).attempts);
      if (attempts.some((row) => !missionEffectProcessesQuiescent(inspection.events, row.binding.attemptId) ||
        !row.settled && (!row.binding.finalization || row.receipt?.sdkDisposed !== true))) return false;
      const latest = [...inspection.events].reverse().find((row) => row.kind === "mission.finalization.phase.started" &&
        row.revision === inspection.revision);
      if (!latest || !this.finalizationTargetCurrent(inspection, latest.payload.target as FinalizationTarget)) return false;
      for (const unit of inspection.definition.units) readAcceptedWorkspaceContribution(this.store, inspection, unit.id);
      return true;
    } catch { return false; }
  }

  private requireFinalizationCapacity(inspection: ReturnType<MissionStore["inspectMission"]>, resource: BudgetResource,
    amount: number, phase: FinalizationTarget["phase"]): void {
    const compiled = compileFinalizationGrants(inspection.definition);
    const use = budgetAmounts(inspection.events, resource);
    const later = FINALIZATION_PHASES.slice(FINALIZATION_PHASES.indexOf(phase) + 1);
    const roles = later.filter((item) => ["ponytail", "cleanup", "whole-review"].includes(item)).length;
    const retained = resource === "role-launches" || resource === "provider-requests" ? roles :
      resource === "tokens" ? roles * compiled.tokens : later.length * (resource === "active-time-ms" ? compiled.active : compiled.artifacts);
    if (use.protected - use.finalization - amount < retained)
      throw new Error(`protected ${resource} cannot fund ${phase} while retaining remaining mandatory stages`);
  }

  private async finalizationRuntime(inspection: ReturnType<MissionStore["inspectMission"]>, attemptId: string, imageHash: string, readOnly: boolean): Promise<ManagedAttemptRuntime> {
    const input = readSealedWorkspaceImage(this.store, imageHash);
    assertCompleteWorkspaceImage(input);
    const workspace = createMissionWorkspace({ ...this.managedWorkspace!, missionId: this.missionId, attemptId,
      candidateParent: this.managedWorkspace!.candidateParent ?? path.join(path.dirname(this.store.storageRoot), `${path.basename(this.store.storageRoot)}-candidates`),
      storeRoot: this.store.storageRoot, allowedPaths: inspection.definition.authority.allowedPaths });
    restoreWorkspaceImage(workspace, input.files);
    workspace.manifest = input.manifest;
    await preflightContainment(workspace);
    const ownerEpoch = this.store.ownerEpoch!;
    const effects = new MissionEffects({ store: this.store, workspace, missionId: this.missionId, revision: inspection.revision,
      unitId: FINALIZATION_OWNER, attemptId, runtimeId: this.store.runtimeId, ownerEpoch,
      allowedOperations: inspection.definition.authority.operations,
      canInvoke: (effectId) => this.attemptAdmitted({ revision: inspection.revision, ownerEpoch, unitId: FINALIZATION_OWNER, attemptId }, undefined, effectId) });
    if (readOnly) effects.enableVerificationOnly(true);
    return { workspace, effects, verificationOnly: readOnly, baseImage: input, dependencyOutputs: [] };
  }

  private openFinalizationWindow(inspection: ReturnType<MissionStore["inspectMission"]>, phase: FinalizationTarget["phase"], id: string): MissionEventDraft[] {
    const quantum = compileFinalizationGrants(inspection.definition).active;
    this.requireFinalizationCapacity(inspection, "active-time-ms", quantum, phase);
    const windowId = randomUUID();
    const reservationId = stableId(`${id}:active-time`);
    const startedAt = this.now();
    this.activeWindow = { id: windowId, reservationId, grantAmount: quantum, knownCharge: 0, unknownCharge: 0, released: 0,
      fractionalMs: 0, lastCheckpointAt: startedAt, ownerEpoch: this.store.ownerEpoch!, runtimeId: this.store.runtimeId };
    return [this.event(inspection.revision, "reservation.created", `${id}:active-time-grant`,
      { reservationId, revision: inspection.revision, resource: "active-time-ms", amount: quantum, purpose: "finalization" }),
      this.event(inspection.revision, "mission.active.window.opened", `${windowId}:opened`, {
        windowId, reservationId, grantAmount: quantum, runtimeId: this.store.runtimeId, ownerEpoch: this.store.ownerEpoch,
        engineId: this.engineId, startedMonotonicMs: startedAt, purpose: "finalization", phase,
      })];
  }

  private async advanceFinalization(): Promise<boolean> {
    let inspection = this.store.inspectMission(this.missionId);
    const state = reduceMissionEvents(inspection);
    if (!["running", "completing"].includes(state.state) || state.admissionFenced ||
      pendingMissionQuestions(inspection.events, this.store).length || Object.values(state.attempts).some((attempt) => !attempt.settled) ||
      [...this.effectRunners].some((runner) => !runner.quiescent)) return false;
    const currentRows = inspection.events.filter((event) => event.revision === inspection.revision);
    if (currentRows.some((event) => event.kind === "mission.finalization.invalidated")) return false;
    const receipts = currentRows.filter((event) => event.kind === "mission.finalization.phase.receipted");
    const previous = receipts.at(-1) ? JSON.parse(this.store.readArtifact(String(receipts.at(-1)!.payload.receiptHash)).toString()) as FinalizationPhaseReceipt : undefined;
    if (previous && (!sourceWitnessCurrent(this.store, previous.target.sourceWitnessHash, this.managedWorkspace!.sourceRoot) ||
      previous.target.acceptedInputHash !== acceptedFinalizationInput(inspection))) {
      this.emit([this.event(inspection.revision, "mission.finalization.invalidated", `${this.missionId}:finalization-stale:${inspection.version}`,
        { generation: previous.outputGeneration, reason: "source mutation witness or accepted input changed" })]);
      return false;
    }
    if (receipts.length === FINALIZATION_PHASES.length) {
      this.store.completeMission(this.missionId, inspection.version);
      return false;
    }
    const phase = FINALIZATION_PHASES[receipts.length]!;
    const active = currentRows.find((event) => event.kind === "mission.finalization.phase.started" &&
      (event.payload.target as FinalizationTarget).phase === phase);
    if (active) throw new Error(`${phase} has no durable phase receipt; unreceipted work cannot advance or replay`);
    let generation = previous?.outputGeneration ?? Math.max(0, ...inspection.events.filter((event) =>
      event.kind === "mission.finalization.generation").map((event) => Number(event.payload.generation)));
    if (["integrate", "ponytail", "cleanup"].includes(phase)) generation++;
    const source = captureWorkspaceImage(this.managedWorkspace!.sourceRoot);
    assertCompleteWorkspaceImage(source);
    const witnessBytes = Buffer.from(JSON.stringify(observeSourceMutation(this.managedWorkspace!.sourceRoot, source.manifest, inspection.planId)));
    const witnessHash = sha256(witnessBytes);
    const acceptedInputHash = acceptedFinalizationInput(inspection);
    const target: FinalizationTarget = { version: 1, kind: "finalization", generation, phase,
      inputArtifactHash: previous?.outputArtifactHash ?? acceptedInputHash, acceptedInputHash, sourceWitnessHash: previous?.target.sourceWitnessHash ?? witnessHash,
      inputIdentityHash: hashJson(finalizationInputIdentity(inspection, source.manifest, this.managedWorkspace!.sourceRoot)) };
    let manifestBytes: Buffer | undefined;
    if (phase === "whole-review") {
      const integrated = currentRows.find((event) => event.kind === "mission.result.integrated")!;
      const report = JSON.parse(this.store.readArtifact(String(integrated.payload.reportHash)).toString());
      const image = readSealedWorkspaceImage(this.store, target.inputArtifactHash);
      const manifest: MissionFinalManifest = { format: "mission-final-manifest-v1", missionId: this.missionId,
        revision: inspection.revision, generation, planHash: inspection.snapshot.planHash, definitionHash: inspection.snapshot.definitionHash,
        originalBaseImageHash: report.originalBaseImageHash, deliveryBaseImageHash: report.deliveryBaseImageHash,
        resultImageHash: target.inputArtifactHash, resultManifestHash: image.manifest.hash, acceptedInputHash,
        sourceWitnessHash: target.sourceWitnessHash, inputIdentity: finalizationInputIdentity(inspection, source.manifest, this.managedWorkspace!.sourceRoot),
        phaseReceiptHashes: receipts.map((event) => String(event.payload.receiptHash)),
        producerAttempts: inspection.events.filter((event) => event.kind === "attempt.reserved" &&
          !(event.payload.binding as MissionAttemptBinding).finalization).map((event) => event.attemptId!) };
      manifestBytes = Buffer.from(JSON.stringify(manifest));
      target.manifestHash = sha256(manifestBytes);
    }
    const id = randomUUID();
    const role = phase === "whole-review" ? "reviewer" : "developer";
    const isRole = ["ponytail", "cleanup", "whole-review"].includes(phase);
    if (isRole && (!inspection.definition.authority.rolePolicies.developer || !inspection.definition.authority.rolePolicies.reviewer))
      throw new Error("finalization role path requires frozen developer and reviewer policies; no policy may be supplied");
    const grants = compileFinalizationGrants(inspection.definition);
    const integrationReceipt: FinalizationPhaseReceipt = { format: "mission-finalization-phase-v1", missionId: this.missionId,
      revision: inspection.revision, target, outputGeneration: generation, outputArtifactHash: target.inputArtifactHash,
      attemptId: id, sessionId: null, instanceId: null, rolePolicyHash: null, evidenceHashes: [] };
    const artifactGrant = phase === "integrate" ?
      witnessBytes.byteLength + Buffer.byteLength(JSON.stringify(integrationReceipt)) : grants.artifacts;
    this.requireFinalizationCapacity(inspection, "artifact-bytes", grants.artifacts, phase);
    if (artifactGrant >= grants.artifacts && phase === "integrate") throw new Error("integration grant cannot hold source witness, phase receipt and result");
    if (isRole) this.requireFinalizationCapacity(inspection, "role-launches", 1, phase);
    const runtime = phase === "integrate" ? undefined : await this.finalizationRuntime(inspection, id, target.inputArtifactHash, !["ponytail", "cleanup"].includes(phase));
    const deliveryBase = previous ? readSealedWorkspaceImage(this.store,
      String(JSON.parse(this.store.readArtifact(String(currentRows.find((event) => event.kind === "mission.result.integrated")!.payload.reportHash)).toString()).deliveryBaseImageHash)) : undefined;
    const changedScope = deliveryBase ? mergeWorkspaceImages(deliveryBase,
      readSealedWorkspaceImage(this.store, target.inputArtifactHash), deliveryBase).changedPaths : [];
    const expectedReview = { format: "mission-whole-result-response-v1" as const, scope: "whole-result" as const,
      missionId: this.missionId, revision: inspection.revision, generation, manifestHash: target.manifestHash ?? "",
      rolePolicyHash: inspection.definition.authority.rolePolicies[role]?.hash ?? hashJson({ authority: "host" }),
      evidenceHashes: receipts.map((event) => String(event.payload.receiptHash)) };
    const brief = JSON.stringify({ format: "mission-finalization-brief-v1", target, goal: inspection.definition.goal,
      criteria: inspection.definition.units.map(({ id, acceptance }) => ({ id, acceptance })), changedScope,
      instructions: phase === "whole-review" ? "Read-only independent review of the complete result, integrated delta, criteria, cleanup receipts and gates. Return only the exact structured response with verdict approve/reject/inconclusive." :
        phase === "cleanup" ? "Perform Unslop, then remove-ai-slops, scoped to changedScope. Return ordered steps with changedPaths or a non-empty scope-bound no-op reason for each." :
        "Apply Ponytail full to changedScope. Preserve behavior. Return steps with changedPaths or a non-empty scope-bound no-op reason.",
      ...(phase === "whole-review" ? { manifest: JSON.parse(manifestBytes!.toString()), expectedResponse: expectedReview } :
        { expectedResponse: { format: "mission-finalization-cleanup-v1", phase, inputArtifactHash: target.inputArtifactHash,
          scope: changedScope, steps: phase === "cleanup" ? ["Unslop", "remove-ai-slops"] : ["Ponytail"] } }) });
    const descriptor: MissionUnit = { id: FINALIZATION_OWNER, kind: "implementation", role, dependencies: [], inputs: ["."],
      outputs: [], acceptance: [], risk: "high", retryLimit: 0 };
    const binding: MissionAttemptBinding = { missionId: this.missionId, revision: inspection.revision, unitId: FINALIZATION_OWNER,
      targetId: FINALIZATION_OWNER, roundId: phase, memberId: isRole ? role : "host", attemptId: id, attemptNo: 1,
      ownerEpoch: this.store.ownerEpoch!, candidate: runtime ? "managed" : "read-only", role, finalization: target,
      inputManifestHash: target.inputArtifactHash, briefHash: hashJson(brief), rolePolicyHash: inspection.definition.authority.rolePolicies[role]?.hash ?? hashJson({ authority: "host" }),
      ...(runtime ? { candidateId: runtime.workspace.candidateId, candidateRoot: runtime.workspace.candidateRoot,
        workspaceManifestHash: runtime.workspace.manifest.hash, candidateRegistration: registerCandidateWorkspace(runtime.workspace, {
          repositoryId: inspection.repositoryId, owner: currentProcessIdentity(this.store.runtimeId, this.store.ownerEpoch!) }) } : {}) };
    const startEvents = [
      ...(generation !== previous?.outputGeneration ? [this.event(inspection.revision, "mission.finalization.generation", `${id}:generation`,
        { generation, phase, inputArtifactHash: target.inputArtifactHash, acceptedInputHash })] : []),
      this.event(inspection.revision, "mission.finalization.phase.started", `${id}:phase-started`, { target, attemptId: id,
        initialArtifactBytes: witnessBytes.byteLength + (manifestBytes?.byteLength ?? 0), grant: grants.stages.find((item) => item.phase === phase) }, FINALIZATION_OWNER, id),
      this.event(inspection.revision, "attempt.reserved", `${id}:reserved`, { binding, attemptId: id,
        unitId: FINALIZATION_OWNER, targetId: FINALIZATION_OWNER, roundId: phase, memberId: binding.memberId, attemptNo: 1 }, FINALIZATION_OWNER, id),
      ...(runtime ? [this.event(inspection.revision, "workspace.candidate.registered", `${id}:registered`,
        { ...binding.candidateRegistration!, locationHistory: [runtime.workspace.candidateRoot] }, FINALIZATION_OWNER, id),
        this.event(inspection.revision, "workspace.snapshot.sealed", `${id}:workspace-base`, { phase: "base", imageHash: target.inputArtifactHash,
          manifestHash: runtime.workspace.manifest.hash }, FINALIZATION_OWNER, id),
        this.event(inspection.revision, "workspace.snapshot.sealed", `${id}:execution-start`, { phase: "observed", purpose: "execution-start",
          imageHash: target.inputArtifactHash, bindingHash: hashJson(binding) }, FINALIZATION_OWNER, id)] : []),
      ...(isRole ? [this.event(inspection.revision, "reservation.created", `${id}:launch`,
        { reservationId: stableId(`${id}:launch`), revision: inspection.revision, resource: "role-launches", amount: 1, purpose: "finalization" }, FINALIZATION_OWNER, id)] : []),
      ...(artifactGrant ? [this.event(inspection.revision, "reservation.created", `${id}:artifact`,
        { reservationId: stableId(`${id}:artifact`), revision: inspection.revision, resource: "artifact-bytes", amount: artifactGrant, purpose: "finalization" }, FINALIZATION_OWNER, id)] : []),
      ...this.openFinalizationWindow(inspection, phase, id),
      this.event(inspection.revision, "attempt.started", `${id}:started`, { attemptId: id, unitId: FINALIZATION_OWNER }, FINALIZATION_OWNER, id),
    ];
    this.store.appendTransition(this.missionId, inspection.version, { events: startEvents,
      artifacts: [{ bytes: witnessBytes, mediaType: "application/json" }, ...(manifestBytes ? [{ bytes: manifestBytes, mediaType: "application/json" }] : [])] });
    this.armActiveCheckpoint();
    if (isRole) {
      this.launchAttempt(descriptor, binding, runtime, brief);
      return true;
    }
    const artifacts: Array<{ bytes: Uint8Array; mediaType: string }> = [];
    let outputArtifactHash = target.inputArtifactHash;
    try {
      if (phase === "integrate") {
        const report = await integrateAcceptedMissionOutputs({ store: this.store, missionId: this.missionId, ...this.managedWorkspace!,
          candidateParent: this.managedWorkspace!.candidateParent ?? path.join(path.dirname(this.store.storageRoot), `${path.basename(this.store.storageRoot)}-candidates`),
          artifactLimit: grants.artifacts - artifactGrant });
        outputArtifactHash = report.resultImageHash;
      } else {
        for (const predicate of inspection.definition.units.flatMap((unit) => unit.acceptance)
          .filter((predicate) => inspection.definition.finalization.requiredPredicates.includes(predicate.id))) {
          // Command assessment shuts down its runner; each command owns a fresh fenced lifecycle.
          const effects = predicate.kind === "command_exit" ? new MissionEffects({ store: this.store, workspace: runtime!.workspace,
            missionId: this.missionId, revision: binding.revision, unitId: binding.unitId, attemptId: binding.attemptId,
            runtimeId: this.store.runtimeId, ownerEpoch: binding.ownerEpoch, allowedOperations: inspection.definition.authority.operations,
            canInvoke: (effectId) => this.attemptAdmitted(binding, undefined, effectId) }) : undefined;
          if (effects) this.effectRunners.add(effects);
          const observation = await assessMissionPredicate({ predicate, subject: { kind: "workspace", imageHash: target.inputArtifactHash } },
            { store: this.store, inputBindingHash: hashJson(target), scopeEstablished: true, effects,
              timeoutLimitMs: Math.max(0, this.activeWindow!.grantAmount - this.activeWindow!.knownCharge -
                this.activeWindow!.unknownCharge - this.activeWindow!.released - Math.ceil(this.now() - this.activeWindow!.lastCheckpointAt)) });
          artifacts.push(...(observation.artifacts ?? []), ...(observation.artifactBytes ? [{ bytes: observation.artifactBytes, mediaType: "application/json" }] : []));
          if (observation.verdict !== "pass") throw new Error(`${phase}:${predicate.id}: ${observation.method}`);
        }
      }
      await this.checkActiveTimeBeforeEffect();
      const current = this.store.inspectMission(this.missionId);
      if (!this.finalizationTargetCurrent(current, target) || !["running", "completing"].includes(reduceMissionEvents(current).state))
        throw new Error("host phase inputs or operator state changed");
      this.commitFinalizationPhase(binding, outputArtifactHash, null, artifacts, witnessBytes.byteLength + (manifestBytes?.byteLength ?? 0));
    } catch (error) {
      const failed = this.store.inspectMission(this.missionId);
      const reservation = failed.reservations.find((row) => row.id === stableId(`${id}:artifact`));
      const charge = witnessBytes.byteLength + artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0);
      this.store.appendTransition(this.missionId, failed.version, { artifacts, events: [
        this.event(binding.revision, "attempt.settled", `${id}:settled`, {
          attemptId: id, status: "failed", reason: messageOf(error), evidenceHashes: artifacts.map((artifact) => sha256(artifact.bytes)),
        }, FINALIZATION_OWNER, id),
        ...(reservation ? [this.reservationSettlement(binding.revision, reservation, { knownCharge: charge,
          unknownCharge: 0, released: Math.max(0, reservation.grantAmount - charge), source: "unsuccessful host finalization evidence" },
        `${id}:artifacts-failed`, FINALIZATION_OWNER, id)] : []),
      ] });
      throw error;
    } finally {
      await runtime?.effects.shutdown();
      await this.finishActiveInterval();
    }
    return true;
  }

  private commitFinalizationPhase(binding: MissionAttemptBinding, outputArtifactHash: string, attempt: MissionAttemptProjection | null,
    artifacts: Array<{ bytes: Uint8Array; mediaType: string }>, initialBytes = 0, approval?: WholeResultApproval): void {
    const inspection = this.store.inspectMission(this.missionId);
    const receipt: FinalizationPhaseReceipt = { format: "mission-finalization-phase-v1", missionId: this.missionId,
      revision: binding.revision, target: binding.finalization!, outputGeneration: binding.finalization!.generation,
      outputArtifactHash, attemptId: binding.attemptId, sessionId: attempt ? binding.attemptId : null,
      instanceId: attempt ? String(attempt.receipt!.instanceId) : null, rolePolicyHash: attempt ? binding.rolePolicyHash : null,
      evidenceHashes: artifacts.map((artifact) => sha256(artifact.bytes)) };
    const bytes = Buffer.from(JSON.stringify(receipt));
    artifacts.push({ bytes, mediaType: "application/json" });
    const events = [this.event(binding.revision, "mission.finalization.phase.receipted", `${binding.attemptId}:phase-receipt`,
      { target: binding.finalization!, receiptHash: sha256(bytes), outputArtifactHash }, FINALIZATION_OWNER, binding.attemptId),
      this.event(binding.revision, "attempt.settled", `${binding.attemptId}:settled`,
        { attemptId: binding.attemptId, status: "succeeded", resultHash: attempt?.receipt?.artifactHash ?? sha256(bytes) }, FINALIZATION_OWNER, binding.attemptId)];
    if (approval) {
      const approvalBytes = Buffer.from(JSON.stringify(approval));
      artifacts.push({ bytes: approvalBytes, mediaType: "application/json" });
      events.push(this.event(binding.revision, "mission.finalization.reviewed", `${binding.attemptId}:reviewed`,
        { approvalHash: sha256(approvalBytes), manifestHash: approval.manifestHash, generation: approval.generation, verdict: approval.verdict }, FINALIZATION_OWNER, binding.attemptId));
    }
    const reservation = inspection.reservations.find((row) => row.id === stableId(`${binding.attemptId}:artifact`));
    const artifactCharge = initialBytes + artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0);
    if (!reservation || artifactCharge > reservation.grantAmount) throw new Error("finalization evidence exceeds its protected artifact grant; no phase or approval may be receipted");
    if (reservation) events.push(this.reservationSettlement(binding.revision, reservation, {
      knownCharge: artifactCharge,
      unknownCharge: 0, released: Math.max(0, reservation.grantAmount - artifactCharge),
      source: "host finalization artifacts and exact phase evidence",
    }, `${binding.attemptId}:artifacts-settled`, FINALIZATION_OWNER, binding.attemptId));
    this.store.appendTransition(this.missionId, inspection.version, { events, artifacts });
  }

  private async settleFinalizationReceipt(attempt: MissionAttemptProjection): Promise<void> {
    const binding = attempt.binding;
    const target = binding.finalization!;
    const inspection = this.store.inspectMission(this.missionId);
    const state = reduceMissionEvents(inspection);
    if (state.state === "paused") return;
    try {
      await this.checkActiveTimeBeforeEffect();
      if (!this.finalizationTargetCurrent(inspection, target) || !["running", "completing"].includes(state.state) ||
        attempt.receipt!.status !== "completed" || attempt.receipt!.sdkDisposed !== true || !attempt.receipt!.instanceId ||
        Object.values(state.attempts).some((row) => !row.settled && row.binding.attemptId !== binding.attemptId) ||
        missionHasUnresolvedEffects(this.store, inspection.events) || !missionEffectProcessesQuiescent(inspection.events, binding.attemptId))
        throw new Error("finalization receipt lacks current inputs, completed disposal or writer/effect quiescence");
      const proof = JSON.parse(this.store.readArtifact(String(attempt.receipt!.terminalOutputHash)).toString());
      if (proof.bindingHash !== hashJson(binding) || proof.resultHash !== attempt.receipt!.artifactHash ||
        proof.sdkDisposed !== true || proof.writersQuiescent !== true || proof.effectsQuiescent !== true) throw new Error("finalization terminal output is unproven");
      const result = this.store.readArtifact(String(attempt.receipt!.artifactHash));
      const image = readSealedWorkspaceImage(this.store, proof.terminalImageHash);
      const before = readSealedWorkspaceImage(this.store, target.inputArtifactHash);
      const changed = mergeWorkspaceImages(before, image, before).changedPaths;
      const prior = inspection.events.filter((row) => row.kind === "attempt.receipt" && row.attemptId !== binding.attemptId);
      if (prior.some((row) => row.payload.instanceId === attempt.receipt!.instanceId))
        throw new Error("finalization requires a fresh actual instance distinct from every earlier producer and finalizer");
      let approval: WholeResultApproval | undefined;
      if (target.phase === "whole-review") {
        if (proof.terminalImageHash !== target.inputArtifactHash || changed.length) throw new Error("read-only Reviewer changed whole-result input");
        const manifest = JSON.parse(this.store.readArtifact(target.manifestHash!).toString()) as MissionFinalManifest;
        const response = parseWholeResultResponse(result.toString(), { format: "mission-whole-result-response-v1", scope: "whole-result",
          missionId: this.missionId, revision: binding.revision, generation: target.generation, manifestHash: target.manifestHash!,
          rolePolicyHash: binding.rolePolicyHash, evidenceHashes: manifest.phaseReceiptHashes });
        approval = { ...response, format: "mission-whole-result-approval-v1", attemptId: binding.attemptId,
          sessionId: binding.attemptId, instanceId: String(attempt.receipt!.instanceId),
          reviewArtifactHash: String(attempt.receipt!.artifactHash), sourceWitnessHash: target.sourceWitnessHash };
      } else {
        const response = JSON.parse(result.toString());
        const expected = target.phase === "cleanup" ? ["Unslop", "remove-ai-slops"] : ["Ponytail"];
        const integrated = inspection.events.find((row) => row.kind === "mission.result.integrated" && row.revision === binding.revision)!;
        const report = JSON.parse(this.store.readArtifact(String(integrated.payload.reportHash)).toString());
        const deliveryBase = readSealedWorkspaceImage(this.store, report.deliveryBaseImageHash);
        const scope = mergeWorkspaceImages(deliveryBase, before, deliveryBase).changedPaths;
        if (response.format !== "mission-finalization-cleanup-v1" || response.phase !== target.phase ||
          response.inputArtifactHash !== target.inputArtifactHash || hashJson(response.scope) !== hashJson(scope) ||
          !Array.isArray(response.steps) || response.steps.length !== expected.length) throw new Error("cleanup scope or ordered step receipt is missing");
        const claimed = new Set<string>();
        response.steps.forEach((step: { skill: string; changedPaths: string[]; noOpReason?: string }, index: number) => {
          if (step.skill !== expected[index] || !Array.isArray(step.changedPaths) ||
            step.changedPaths.some((name) => !scope.includes(name)) ||
            (!step.changedPaths.length && (typeof step.noOpReason !== "string" || !step.noOpReason.trim())))
            throw new Error("cleanup lacks ordered skill, changed paths or justified scope-bound no-op");
          step.changedPaths.forEach((name) => claimed.add(name));
        });
        if (changed.some((name) => !claimed.has(name)) || [...claimed].some((name) => !changed.includes(name)))
          throw new Error("cleanup path receipt does not describe the actual output delta");
      }
      const artifacts = [{ bytes: result, mediaType: "application/json" }];
      this.commitFinalizationPhase(binding, proof.terminalImageHash, attempt, artifacts,
        Number(attempt.receipt!.terminalOutputArtifactBytes ?? 0) + Number(inspection.events.find((row) =>
          row.kind === "mission.finalization.phase.started" && row.attemptId === binding.attemptId)?.payload.initialArtifactBytes ?? 0), approval);
      await this.finishActiveInterval();
    } catch (error) {
      const current = this.store.inspectMission(this.missionId);
      this.emit([this.event(binding.revision, "attempt.settled", `${binding.attemptId}:settled`, {
        attemptId: binding.attemptId, status: "failed", reason: messageOf(error),
      }, FINALIZATION_OWNER, binding.attemptId), this.event(current.revision, "mission.finalization.invalidated", `${binding.attemptId}:invalidated`,
        { generation: target.generation, reason: messageOf(error) }),
      this.event(current.revision, "mission.blocked", `${binding.attemptId}:finalization-blocked`, { reason: messageOf(error) })]);
      await this.finishActiveInterval();
    }
  }

  private async advanceTeam(unit: MissionUnit, targetId = unit.id): Promise<number> {
    const inspection = this.store.inspectMission(this.missionId);
    const state = reduceMissionEvents(inspection);
    const admitted = inspection.events.find((event) => event.kind === "team.consultation.admitted" &&
      event.payload.targetId === targetId && event.unitId === unit.id);
    const request = admitted?.payload.request as ConsultationRequest | undefined;
    const contract = request ? { phase: unit.team?.phase ?? "execution", members: request.members,
      synthesisRole: request.synthesisRole } : unit.team!;
    if (["accepted", "blocked"].includes(state.units[unit.id]?.status ?? "") ||
      inspection.events.some((event) => event.kind === "team.consultation.cancelled" && event.unitId === unit.id) ||
      !["running", "blocked"].includes(state.state)) return 0;
    const barriers = inspection.events.filter((event) => event.kind === "team.barrier.recorded" &&
      event.revision === inspection.revision && event.unitId === unit.id && (event.payload.targetId ?? unit.id) === targetId);
    const round = TEAM_ROUNDS.find((name) => !barriers.some((event) => event.payload.round === name));
    if (!round) {
      if (admitted && !inspection.events.some((event) => event.kind === "team.consultation.resolved" &&
        event.payload.targetId === targetId)) {
        const result = inspection.events.find((event) => event.kind === "team.member.recorded" &&
          event.payload.targetId === targetId && event.payload.round === "synthesis" && event.payload.status === "valid");
        if (result) this.emit([this.event(inspection.revision, "team.consultation.resolved", `${targetId}:resolved`, {
          targetId, requestId: admitted.payload.requestId, parentTargetId: admitted.payload.parentTargetId,
          parentAttemptId: admitted.payload.parentAttemptId, resultHash: result.payload.responseHash,
          synthesisReceiptHash: result.payload.receiptHash,
        }, unit.id)]);
        return result ? 1 : 0;
      }
      return 0;
    }
    if (!contract || barriers.some((event) => event.payload.status !== "complete")) return 0;
    const members = round === "synthesis"
      ? [{ id: "synthesis", role: contract.synthesisRole, perspective: "Classify findings. Agreement is not proof." }]
      : contract.members;
    const attempts = Object.values(state.attempts).filter(({ binding }) => binding.unitId === unit.id &&
      (binding.targetId ?? unit.id) === targetId && binding.revision === inspection.revision && binding.roundId === round);
    const recorded = inspection.events.filter((event) => event.kind === "team.member.recorded" &&
      event.revision === inspection.revision && event.unitId === unit.id && event.payload.round === round &&
      (event.payload.targetId ?? unit.id) === targetId);
    if (members.every(({ id }) => recorded.some((event) => event.payload.memberId === id))) {
      const invalid = recorded.filter((event) => event.payload.status !== "valid");
      this.emit([...(invalid.length ? this.releaseConsultationBranch(inspection, targetId) : []),
        this.event(inspection.revision, "team.barrier.recorded", `${targetId}:${inspection.revision}:${round}:barrier`, {
        unitId: unit.id, targetId, round, status: invalid.length ? "incomplete" : "complete",
        members: members.map(({ id }) => ({ id, receiptHash: recorded.find((event) => event.payload.memberId === id)?.payload.receiptHash })),
        ...(invalid.length ? { missing: invalid.map((event) => event.payload.memberId) } : {}),
      }, unit.id), ...(invalid.length ? [this.event(inspection.revision, "unit.blocked", `${targetId}:${inspection.revision}:${round}:incomplete`, {
        unitId: unit.id, reason: `team ${round} incomplete: ${invalid.map((event) => event.payload.memberId).join(", ")}`,
      }, unit.id)] : [])]);
      return 1;
    }
    // A reserved, unreceipted slot cannot be silently replaced after a restart.
    if (attempts.some((attempt) => !attempt.receipt && !this.inFlight.has(attempt.binding.attemptId))) {
      this.emit([...this.releaseConsultationBranch(inspection, targetId),
        this.event(inspection.revision, "team.barrier.recorded", `${targetId}:${inspection.revision}:${round}:barrier`, {
        unitId: unit.id, targetId, round, status: "incomplete",
        missing: members.filter(({ id }) => !recorded.some((event) => event.payload.memberId === id)).map(({ id }) => id),
      }, unit.id), this.event(inspection.revision, "unit.blocked", `${targetId}:${inspection.revision}:${round}:incomplete`, {
        unitId: unit.id, reason: `team ${round} has unreceipted member attempts`,
      }, unit.id)]);
      return 1;
    }
    let launched = 0;
    for (const member of members) {
      if (this.attemptControllers.size >= this.sessionLimit(inspection)) break;
      if (recorded.some((event) => event.payload.memberId === member.id)) continue;
      const interrupted = [...attempts].reverse().find((attempt) => attempt.binding.memberId === member.id &&
        attempt.status === "interrupted" && !attempts.some((row) => row.binding.recoveryOf === attempt.binding.attemptId));
      const recovery = interrupted && this.pauseContinuation(inspection, interrupted.binding);
      const prior = attempts.find((attempt) => attempt.binding.memberId === member.id &&
        !attempt.binding.continuationOf);
      const consultation = prior && inspection.events.find((event) => event.kind === "team.consultation.admitted" &&
        event.payload.parentAttemptId === prior.binding.attemptId);
      const resolution = consultation && inspection.events.find((event) => event.kind === "team.consultation.resolved" &&
        event.payload.targetId === consultation.payload.targetId);
      if (!recovery && prior && (!consultation || !resolution || attempts.some((attempt) =>
        attempt.binding.continuationOf === prior.binding.attemptId))) continue;
      const fresh = this.store.inspectMission(this.missionId);
      const scope = recoveryBlockedUnits(this.store, fresh, this.managedWorkspace?.sourceRoot);
      if (scope === null || scope.has(unit.id) || pendingQuestionUnits(fresh.events, fresh.definition, this.store).has(unit.id) ||
        fresh.events.some((event) => event.kind === "team.consultation.cancelled" && event.unitId === unit.id) ||
        reduceMissionEvents(fresh).units[unit.id]?.status === "blocked" ||
        !["running", "blocked"].includes(reduceMissionEvents(fresh).state)) break;
      try {
        await this.checkActiveTimeBeforeEffect();
        const current = this.store.inspectMission(this.missionId);
        if (!unit.team) {
          const root = current.events.find((event) => event.kind === "team.consultation.admitted" &&
            event.unitId === unit.id && event.payload.parentTargetId === unit.id &&
            typeof event.payload.checkpointHash === "string");
          if (!root || root.revision !== current.revision) throw new Error("singleton consultation lineage changed");
          this.singletonCheckpoint(current, String(root.payload.parentAttemptId), String(root.payload.checkpointHash));
        }
        const childResultHash = resolution ? String(resolution.payload.resultHash) : undefined;
        const childResult = childResultHash ? this.store.readArtifact(childResultHash).toString("utf8") : undefined;
        if (childResultHash && sha256(Buffer.from(childResult!)) !== childResultHash)
          throw new Error("child result artifact changed");
        const bundle: TeamBundle = recovery
          ? JSON.parse(this.store.readArtifact(interrupted!.binding.teamBundleHash!).toString("utf8")) : {
          format: "mission-team-bundle-v1", unitId: unit.id, phase: contract.phase, round,
          memberId: member.id, perspective: member.perspective, goal: request?.question ?? current.definition.goal,
          inputs: request?.evidenceRefs ?? unit.inputs,
          ...(targetId === unit.id ? {} : { targetId, question: request!.question }),
          ...(childResultHash ? { childResultHash, childResult } : {}),
          ...(round === "independent" ? {} : { priorFindings: this.teamFindings(current, unit.id, round, targetId) }),
        };
        const brief = `Read-only ${contract.phase} team judgment. Do not implement or invoke mutating tools. Return mission-team-response-v1 JSON or a terminal mission-consultation-request-v1 JSON. Votes are not evidence.\n${JSON.stringify(bundle)}`;
        const assigned = { ...unit, role: member.role };
        const attempt = await this.reserveAttempt(current, assigned, reduceMissionEvents(current), {
          bundle, brief, targetId,
          ...(admitted ? { consultationId: String(admitted.payload.requestId) } : {}),
          ...(recovery ? { continuationOf: interrupted!.binding.continuationOf, consultationId: interrupted!.binding.consultationId }
            : prior ? { continuationOf: prior.binding.attemptId, consultationId: String(consultation!.payload.requestId) } : {}),
        }, undefined, recovery ? interrupted!.binding : undefined);
        this.launchAttempt(assigned, attempt.binding, undefined, brief);
        launched++;
      } catch (error) {
        if (error instanceof RecoveryAdmissionError) break;
        const current = this.store.inspectMission(this.missionId);
        this.recordResourceWait(unit, this.nextAttemptNo(reduceMissionEvents(current), unit.id), error);
        if (recovery) return launched;
        this.emit([...this.releaseConsultationBranch(current, targetId),
          this.event(current.revision, "team.barrier.recorded", `${targetId}:${current.revision}:${round}:barrier`, {
          unitId: unit.id, targetId, round, status: "incomplete",
          missing: members.filter(({ id }) => !recorded.some((event) => event.payload.memberId === id)).map(({ id }) => id),
          reason: `team admission failed: ${messageOf(error)}`,
        }, unit.id), this.event(current.revision, "unit.blocked", `${targetId}:${current.revision}:${round}:incomplete`, {
          unitId: unit.id, reason: `team ${round} incomplete: ${messageOf(error)}`,
        }, unit.id)]);
        return launched + 1;
      }
    }
    return launched;
  }

  private async advanceSingletonContinuation(unit: MissionUnit): Promise<number> {
    const inspection = this.store.inspectMission(this.missionId);
    const admitted = inspection.events.find((event) => event.kind === "team.consultation.admitted" &&
      event.unitId === unit.id && event.payload.parentTargetId === unit.id &&
      event.payload.round === "main" && event.payload.memberId === "solo");
    const resolved = admitted && inspection.events.find((event) => event.kind === "team.consultation.resolved" &&
      event.payload.targetId === admitted.payload.targetId);
    if (!admitted || !resolved) return 0;
    const previous = [...inspection.events].reverse().find((event) => event.kind === "attempt.reserved" &&
      (event.payload.binding as MissionAttemptBinding).continuationOf === admitted.payload.parentAttemptId);
    const previousAttempt = previous && reduceMissionEvents(inspection).attempts[previous.attemptId!];
    const recovery = previousAttempt?.status === "interrupted" && this.pauseContinuation(inspection, previousAttempt.binding);
    if (previous && !recovery) {
      const state = reduceMissionEvents(inspection);
      if (state.units[unit.id]?.status !== "ready" || previousAttempt?.status !== "failed" ||
        missionCorrectionNo(inspection.events, previousAttempt.binding) >= unit.retryLimit ||
        !inspection.events.some((event) => event.kind === "unit.ready" && event.payload.retryOf === previous.attemptId)) return 0;
    }
    try {
      await this.checkActiveTimeBeforeEffect();
      const fresh = this.store.inspectMission(this.missionId);
      if (!this.singletonContinuationCurrent(fresh, String(admitted.payload.parentAttemptId),
        String(admitted.payload.checkpointHash), String(resolved.payload.resultHash), Boolean(previous)))
        throw new Error("singleton checkpoint or child result is stale");
      const childResultHash = String(resolved.payload.resultHash);
      const childResult = this.store.readArtifact(childResultHash);
      const brief = `${createBrief(fresh.definition.goal, unit, reduceMissionEvents(fresh), recovery ? "verify" :
        previousAttempt?.binding.recoveryContinuationId ? "repair" : undefined)}\n` +
        JSON.stringify({ format: "mission-singleton-continuation-v1",
          sourceAttemptId: admitted.payload.parentAttemptId, checkpointHash: admitted.payload.checkpointHash,
          childTargetId: admitted.payload.targetId, childResultHash, childResult: childResult.toString("utf8"),
          ...(previous ? { retryOf: previous.attemptId } : {}),
          instruction: "Continue on the fresh private candidate. Child synthesis is advice, not acceptance." });
      const attempt = await this.reserveAttempt(fresh, unit, reduceMissionEvents(fresh), undefined, {
        sourceAttemptId: String(admitted.payload.parentAttemptId), checkpointHash: String(admitted.payload.checkpointHash),
        childResultHash, consultationId: String(admitted.payload.requestId), brief,
      }, previousAttempt?.binding.recoveryContinuationId || recovery ? previousAttempt?.binding : undefined);
      this.launchAttempt(unit, attempt.binding, attempt.runtime, brief);
      return 1;
    } catch (error) {
      if (error instanceof ComputeSlotBusyError) return 0;
      const fresh = this.store.inspectMission(this.missionId);
      if (recovery) {
        this.recordResourceWait(unit, this.nextAttemptNo(reduceMissionEvents(fresh), unit.id), error);
        return 0;
      }
      if (this.store.ownerEpoch !== null && fresh.revision === inspection.revision &&
        !fresh.events.some((event) => event.kind === "unit.blocked" && event.unitId === unit.id)) {
        this.emit([...this.releaseConsultationBranch(fresh, String(admitted.payload.targetId)),
          this.event(fresh.revision, "unit.blocked", `${admitted.payload.parentAttemptId}:continuation-denied`, {
            unitId: unit.id, reason: `singleton continuation denied: ${messageOf(error)}`,
          }, unit.id)]);
      }
      return 1;
    }
  }

  private pauseContinuation(inspection: ReturnType<MissionStore["inspectMission"]>, binding: MissionAttemptBinding) {
    const event = [...inspection.events].reverse().find((row) => row.kind === "mission.recovery.continuation.recorded" &&
      row.payload.sourceAttemptId === binding.attemptId && row.payload.pauseEventId && row.payload.ownerEpoch === this.store.ownerEpoch);
    if (!event || inspection.events.some((row) => row.kind === "attempt.reserved" &&
      (row.payload.binding as MissionAttemptBinding).recoveryOf === binding.attemptId)) return undefined;
    try {
      return pauseRecoveryCurrent(this.store, inspection, String(event.payload.continuationId), this.managedWorkspace!.sourceRoot).event;
    } catch { return undefined; }
  }

  private singletonContinuationCurrent(inspection: ReturnType<MissionStore["inspectMission"]>,
    sourceAttemptId: string, checkpointHash: string, childResultHash: string, allowReady = false): boolean {
    try {
      const { proof, unit } = this.singletonCheckpoint(inspection, sourceAttemptId, checkpointHash);
      const state = reduceMissionEvents(inspection);
      const admitted = inspection.events.find((event) => event.kind === "team.consultation.admitted" &&
        event.payload.parentAttemptId === sourceAttemptId);
      const resolved = inspection.events.find((event) => event.kind === "team.consultation.resolved" &&
        event.payload.targetId === admitted?.payload.targetId);
      const member = inspection.events.find((event) => event.kind === "team.member.recorded" &&
        event.payload.targetId === admitted?.payload.targetId && event.payload.round === "synthesis" &&
        event.payload.status === "valid");
      const barriers = inspection.events.filter((event) => event.kind === "team.barrier.recorded" &&
        event.payload.targetId === admitted?.payload.targetId && event.payload.status === "complete");
      return state.attempts[sourceAttemptId]?.status === "yielded" &&
        (state.units[unit.id]?.status === "running" || allowReady && state.units[unit.id]?.status === "ready") &&
        ["running", "blocked"].includes(state.state) && !state.admissionFenced &&
        admitted?.payload.checkpointHash === checkpointHash &&
        admitted.payload.sourceManifestHash === proof.sourceManifestHash &&
        admitted.payload.receiptHash === proof.receiptHash &&
        admitted.payload.requestHash === proof.requestHash &&
        resolved?.payload.resultHash === childResultHash && member?.payload.responseHash === childResultHash &&
        sha256(this.store.readArtifact(childResultHash)) === childResultHash &&
        TEAM_ROUNDS.every((round) => barriers.some((event) => event.payload.round === round)) &&
        !inspection.events.some((event) => event.kind === "team.consultation.cancelled" && event.unitId === unit.id) &&
        pendingQuestionUnits(inspection.events, inspection.definition, this.store).has(unit.id) === false &&
        recoveryBlockedUnits(this.store, inspection, this.managedWorkspace?.sourceRoot)?.has(unit.id) === false;
    } catch { return false; }
  }

  private teamFindings(inspection: ReturnType<MissionStore["inspectMission"]>, unitId: string, round: TeamRound, targetId = unitId): TeamFinding[] {
    const preceding = TEAM_ROUNDS.slice(0, TEAM_ROUNDS.indexOf(round));
    return inspection.events.filter((event) => event.kind === "team.member.recorded" && event.unitId === unitId &&
      (event.payload.targetId ?? unitId) === targetId &&
      event.revision === inspection.revision && event.payload.status === "valid" &&
      preceding.includes(event.payload.round as TeamRound)).flatMap((event) => {
        const bytes = this.store.readArtifact(String(event.payload.responseHash));
        if (sha256(bytes) !== event.payload.responseHash) throw new Error("team member response artifact changed");
        const bundleBytes = this.store.readArtifact(String(event.payload.bundleHash));
        if (sha256(bundleBytes) !== event.payload.bundleHash) throw new Error("team input bundle artifact changed");
        return parseTeamResponse(bytes, JSON.parse(bundleBytes.toString("utf8")) as TeamBundle).findings;
      });
  }

  private async consultRecoveryOverlap(
    role: string,
    input: RecoveryOverlapRequest & { diagnosisId: string; developerDiagnosis?: RecoveryOverlapAnswer },
  ): Promise<RecoveryOverlapAnswer> {
    const inspection = this.store.inspectMission(this.missionId);
    const ownerEpoch = this.store.ownerEpoch;
    const unresolved = (reason: string): RecoveryOverlapAnswer => ({ disposition: "unresolved", reason });
    if (this.closed || this.retired || ownerEpoch === null) return unresolved("mission owner is fenced");
    if (this.attemptControllers.size >= this.sessionLimit(inspection)) return unresolved("root simultaneous-session limit reached");
    if (!inspection.definition.authority.rolePolicies[role]) return unresolved(`mission has no frozen ${role} policy`);
    if (input.conflicts.some(({ path: name }) => sensitiveArtifactPath(name))) return unresolved("conflict includes a sensitive path; model consultation was not sent");

    const prompt = recoveryDiagnosisBrief(role, input);
    if (Buffer.byteLength(prompt) > 64 * 1024) return unresolved("conflict evidence exceeds the bounded 64 KiB consultation limit");
    const briefHash = createHash("sha256").update(prompt).digest("hex");
    if (!this.diagnosisAdmitted(input, role, briefHash, inspection)) return unresolved("recovery diagnosis admission is stale or unbound");

    const launchUse = budgetAmounts(inspection.events, "role-launches");
    if (launchUse.ordinary + launchUse.protected + launchUse.finalization >= inspection.definition.budget.roleLaunches) {
      return unresolved("role-launch budget has no ordinary capacity for diagnosis");
    }
    const artifactUse = budgetAmounts(inspection.events, "artifact-bytes");
    const artifactRemaining = inspection.definition.budget.artifactBytes - artifactUse.ordinary - artifactUse.protected - artifactUse.finalization;
    const artifactAllowance = Math.min(
      Math.max(1, Math.ceil(inspection.definition.budget.artifactBytes / inspection.definition.budget.roleLaunches)), artifactRemaining,
    );
    if (artifactAllowance < 512) return unresolved("artifact budget has no bounded capacity for a durable diagnosis");
    try {
      this.requireRootSlack(inspection, "role-launches", 1);
      this.requireRootSlack(inspection, "artifact-bytes", artifactAllowance);
      if (!this.activeWindow) {
        const timeUse = budgetAmounts(inspection.events, "active-time-ms");
        const quantum = Math.min(ACTIVE_TIME_QUANTUM_MS,
          Math.max(1, Math.ceil(inspection.definition.budget.activeTimeMs / inspection.definition.budget.roleLaunches)),
          inspection.definition.budget.activeTimeMs - timeUse.ordinary - timeUse.protected - timeUse.finalization);
        this.requireRootSlack(inspection, "active-time-ms", quantum);
      }
    } catch (error) { return unresolved(messageOf(error)); }
    if (!this.activeWindow) this.openNextActiveWindow();
    if (!this.activeWindow) return unresolved("active-time budget has no capacity for diagnosis");

    const roleReservationId = stableId(`${input.diagnosisId}:role-launch`);
    const artifactReservationId = stableId(`${input.diagnosisId}:artifact`);
    this.emit([
      this.event(inspection.revision, "reservation.created", `${input.diagnosisId}:role-launch`, {
        reservationId: roleReservationId, revision: inspection.revision, resource: "role-launches", amount: 1, purpose: "ordinary",
      }, input.unitId, input.diagnosisId),
      this.event(inspection.revision, "reservation.created", `${input.diagnosisId}:artifact`, {
        reservationId: artifactReservationId, revision: inspection.revision, resource: "artifact-bytes", amount: artifactAllowance, purpose: "ordinary",
      }, input.unitId, input.diagnosisId),
    ]);
    const binding: MissionAttemptBinding = {
      missionId: this.missionId, revision: inspection.revision, unitId: input.unitId, roundId: "recovery",
      memberId: role, attemptId: input.diagnosisId, attemptNo: 1, ownerEpoch,
      candidate: "read-only", inputManifestHash: input.sourceManifestHash,
      briefHash, rolePolicyHash: inspection.definition.authority.rolePolicies[role]!.hash,
    };
    const unit: MissionUnit = {
      id: input.unitId, dependencies: [], kind: "consultation", role,
      inputs: input.conflicts.map(({ path: name }) => name), outputs: [], acceptance: [], risk: "high", retryLimit: 0,
    };
    const controller = new AbortController();
    const startedAt = this.now();
    this.attemptStarted.set(input.diagnosisId, startedAt);
    this.attemptControllers.set(input.diagnosisId, controller);
    mkdirSync(path.join(this.sessionsDirectory, this.missionId, input.diagnosisId), { recursive: true });
    let answer: RecoveryOverlapAnswer;
    try {
      const result = await this.runRole({ missionId: this.missionId, unit, binding, brief: prompt }, {
        attemptId: input.diagnosisId,
        sessionDir: path.join(this.sessionsDirectory, this.missionId, input.diagnosisId),
        sessionId: input.diagnosisId,
        readOnly: true,
        rolePolicy: missionPolicyTargets(inspection.definition, role),
        signal: controller.signal,
        onProviderDispatch: (request) => this.dispatchProviderRequest(binding, request),
        onProviderReceipt: (receipt) => this.recordProviderReceipt(binding, receipt),
        onOutcome: () => {},
      });
      if (!this.diagnosisAdmitted(input, role, briefHash)) answer = unresolved("recovery diagnosis observation changed during consultation");
      else if (result.status !== "completed") answer = unresolved(`${role} diagnosis ended with status ${result.status}`);
      else {
        const parsed = JSON.parse(result.result) as Record<string, unknown>;
        const resolutions = Array.isArray(parsed.resolutions) ? parsed.resolutions.map((entry) => {
          const row = entry as Record<string, unknown>;
          return { path: row.path, kind: row.kind, mode: row.mode, bytes: typeof row.bytesBase64 === "string" ? parseRecoveryBase64(row.bytesBase64) : null };
        }) : undefined;
        answer = {
          disposition: parsed.disposition as RecoveryOverlapAnswer["disposition"],
          reason: typeof parsed.reason === "string" ? parsed.reason : "diagnosis omitted its reason",
          ...(typeof parsed.question === "string" ? { question: parsed.question } : {}),
          ...(resolutions ? { resolutions: resolutions as RecoveryOverlapAnswer["resolutions"] } : {}),
        };
      }
    } catch (error) {
      answer = unresolved(`${role} diagnosis failed: ${messageOf(error)}`);
    } finally {
      this.attemptControllers.delete(input.diagnosisId);
      this.attemptStarted.delete(input.diagnosisId);
      await this.finishActiveInterval();
    }
    let bytes = serializeRecoveryOverlapAnswer(answer);
    if (bytes.length > artifactAllowance) {
      answer = unresolved("diagnosis result exceeds its durable artifact reservation");
      bytes = serializeRecoveryOverlapAnswer(answer);
    }
    const latest = this.store.inspectMission(this.missionId);
    const artifactReservation = latest.reservations.find(({ id }) => id === artifactReservationId);
    if (artifactReservation) this.emit([this.reservationSettlement(latest.revision, artifactReservation, {
      knownCharge: bytes.length, unknownCharge: 0, released: artifactAllowance - bytes.length, source: "recovery diagnosis artifact",
    }, `${input.diagnosisId}:artifact-settled`, input.unitId, input.diagnosisId)]);
    return answer;
  }

  private diagnosisAdmitted(
    input: RecoveryOverlapRequest & { diagnosisId: string; developerDiagnosis?: RecoveryOverlapAnswer },
    role: string,
    briefHash: string,
    inspection = this.store.inspectMission(this.missionId),
  ): boolean {
    const started = inspection.events.find((event) => event.kind === "mission.recovery.diagnosed" &&
      event.attemptId === input.diagnosisId && event.payload.status === "started");
    const admission = started?.payload.admission as RecoveryDiagnosisAdmission | undefined;
    const state = reduceMissionEvents(inspection);
    if (!started || !admission || admission.version !== 1 || this.closed || this.retired ||
      ["paused", "cancelled", "completed"].includes(state.state) || state.admissionFenced ||
      this.store.ownerEpoch !== admission.ownerEpoch || admission.revision !== inspection.revision ||
      !Number.isSafeInteger(admission.observedSeq) || admission.observedSeq >= started.seq ||
      !recoveryObservationCurrent(inspection.events, admission.observedSeq) ||
      inspection.events.some((event) => event.kind === "mission.import.conflict") ||
      started.payload.diagnosisId !== input.diagnosisId || started.payload.fingerprint !== input.fingerprint ||
      started.payload.unitId !== input.unitId || started.payload.attemptId !== input.attemptId ||
      started.payload.role !== (role === "developer" ? "developer" : "expert") ||
      admission.fingerprint !== input.fingerprint || admission.attemptId !== input.attemptId ||
      admission.unitId !== input.unitId || admission.sourceManifestHash !== input.sourceManifestHash ||
      admission.planStatus !== input.planStatus || admission.memberRole !== role || admission.briefHash !== briefHash ||
      admission.rolePolicyHash !== inspection.definition.authority.rolePolicies[role]?.hash ||
      !inspection.events.some((event) => event.kind === "attempt.reserved" && event.attemptId === input.attemptId &&
        event.eventId === admission.sourceEventId &&
        (event.payload.binding as MissionAttemptBinding | undefined)?.unitId === input.unitId &&
        createHash("sha256").update(JSON.stringify(event.payload)).digest("hex") === admission.sourceProofHash)) return false;
    if (this.managedWorkspace) {
      try { if (captureWorkspaceImage(this.managedWorkspace.sourceRoot).manifest.hash !== input.sourceManifestHash) return false; }
      catch { return false; }
    }
    return true;
  }

  private async prepareManagedAttempt(
    inspection: ReturnType<MissionStore["inspectMission"]>,
    unit: MissionUnit,
    attemptId: string,
    checkpoint?: { sourceAttemptId: string; checkpointHash: string },
    recovery?: MissionAttemptBinding,
  ): Promise<ManagedAttemptRuntime> {
    const config = this.managedWorkspace!;
    const ownerEpoch = this.store.ownerEpoch;
    if (ownerEpoch === null) throw new ManagedWorkspaceError("managed writes require an exclusive mission-store owner claim");
    const storeRoot = this.store.storageRoot;
    const pauseRecovery = recovery && reduceMissionEvents(inspection).attempts[recovery.attemptId]?.status === "interrupted"
      ? this.pauseContinuation(inspection, recovery) : undefined;
    const candidateParent = config.candidateParent ?? path.join(path.dirname(storeRoot), `${path.basename(storeRoot)}-candidates`);
    const otherCandidates = [...new Set([
      ...(config.otherCandidates ?? []),
      ...[...this.effectRunners].map((runner) => runner.workspace.candidateRoot),
    ])];
    let workspace: MissionWorkspace;
    let recovered: MissionEvent | undefined;
    let baseImage: ReturnType<typeof captureWorkspaceImage> | undefined;
    let contributionInput: ContributionInput | undefined;
    const dependencyOutputs: ContributionInput["dependencyOutputs"] = [];
    const inheritContribution = (id: string) => {
      if (inspection.definition.finalization.contractVersion !== 1) return;
      const prior = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === id);
      const binding = prior?.payload.binding as MissionAttemptBinding | undefined;
      if (!binding || binding.unitId !== unit.id || binding.revision !== inspection.revision) throw new Error("owned contribution predecessor is missing");
      contributionInput = readContributionInput(this.store, inspection, binding);
    };
    try {
      workspace = createMissionWorkspace({
        missionId: this.missionId, attemptId, sourceRoot: config.sourceRoot, storeRoot, candidateParent,
        allowedPaths: inspection.definition.authority.allowedPaths, otherCandidates,
        productRoot: config.productRoot, bwrapPath: config.bwrapPath,
      });
      await preflightContainment(workspace);
      if (inspection.definition.finalization.contractVersion === 1 && unit.dependencies.length && !checkpoint && !recovery) {
        baseImage = { ...captureWorkspaceImage(workspace.candidateRoot), manifest: workspace.manifest };
        const visited = new Set<string>();
        const restoreDependency = (id: string) => {
          if (visited.has(id)) return;
          for (const parent of inspection.definition.units.find((row) => row.id === id)!.dependencies.slice().sort()) restoreDependency(parent);
          visited.add(id);
          const { outputHash, output, base, terminal } = readAcceptedWorkspaceContribution(this.store, inspection, id);
          dependencyOutputs.push({ unitId: id, attemptId: output.attemptId, outputBindingHash: outputHash });
          if (!base || !terminal) return;
          const merged = mergeWorkspaceImages(base, terminal, captureWorkspaceImage(workspace.candidateRoot));
          if (merged.conflicts.length) throw new Error(`dependency output overlap: ${merged.conflicts.map(({ path }) => path).join(", ")}`);
          restoreWorkspaceImage(workspace, merged.files);
        };
        for (const id of unit.dependencies.slice().sort()) restoreDependency(id);
      }
      if (checkpoint && !recovery) {
        inheritContribution(checkpoint.sourceAttemptId);
        const { proof, image } = this.singletonCheckpoint(inspection, checkpoint.sourceAttemptId, checkpoint.checkpointHash);
        baseImage = { ...captureWorkspaceImage(workspace.candidateRoot), manifest: workspace.manifest };
        const source = inspection.definition.finalization.contractVersion === 1 ? baseImage : filterWorkspaceImage(baseImage, workspace.allowedPaths);
        const original = readSealedWorkspaceImage(this.store, String(proof.baseImageHash));
        const merged = mergeWorkspaceImages(original, image, source);
        if (merged.conflicts.length || source.manifest.hash !== proof.sourceManifestHash)
          throw new Error("checkpoint source has a changed or overlapping path");
        restoreWorkspaceImage(workspace, merged.files);
        const restored = captureWorkspaceImage(workspace.candidateRoot);
        if ((inspection.definition.finalization.contractVersion === 1 ? canonicalDeliveryManifest(restored.manifest, image.manifest).hash : restored.manifest.hash) !== proof.candidateManifestHash)
          throw new Error("fresh candidate does not match the sealed checkpoint image");
      }
      recovered = checkpoint && !recovery ? undefined : [...inspection.events].reverse().find((event) => event.kind === "workspace.snapshot.sealed" &&
        event.revision === inspection.revision &&
        event.unitId === unit.id && event.payload.phase === "recovered" && typeof event.payload.imageHash === "string" &&
        (!recovery || event.payload.imageHash === (pauseRecovery?.payload.sourceImageHash ?? recovery.recoveryImageHash)));
      if (recovered) {
        if (recovered.payload.lifecycle) {
          const continuation = inspection.events.find((row) => row.kind === "mission.recovery.continuation.recorded" &&
            row.revision === inspection.revision && row.payload.sourceImageHash === recovered!.payload.imageHash &&
            row.payload.lifecycle && row.payload.sourceAttemptId === recovered!.attemptId);
          if (!continuation) throw new Error("lifecycle contribution observation is missing");
          const current = lifecycleRecoveryCurrent(this.store, inspection, String(continuation.payload.continuationId), config.sourceRoot,
            recovery?.attemptId);
          contributionInput = recovery ? readContributionInput(this.store, inspection, recovery) :
            { originAttemptId: attemptId, baseImageHash: current.lifecycle.basisImageHash,
              dependencyOutputs: current.lifecycle.dependencyOutputs };
        } else inheritContribution(String(recovered.attemptId));
        baseImage = { ...captureWorkspaceImage(workspace.candidateRoot), manifest: workspace.manifest };
        const image = readSealedWorkspaceImage(this.store, String(recovered.payload.imageHash));
        restoreWorkspaceImage(workspace, image.files);
      }
    } catch (error) {
      throw new ManagedWorkspaceError(`managed containment preflight failed; no worker or writer launched: ${messageOf(error)}`);
    }
    const continuation = checkpoint && !recovery ? undefined : [...inspection.events].reverse().find((event) => event.kind === "mission.recovery.continuation.recorded" &&
      event.revision === inspection.revision && event.payload.unitId === unit.id && event.payload.mode === "verify" &&
      (!recovery || (pauseRecovery ? event.payload.continuationId === pauseRecovery.payload.continuationId :
        event.payload.continuationId === recovery.recoveryContinuationId)));
    const continuationId = typeof continuation?.payload.continuationId === "string" ? continuation.payload.continuationId : undefined;
    const recoveryImageHash = typeof continuation?.payload.sourceImageHash === "string" ? continuation.payload.sourceImageHash : undefined;
    if (continuation && (!recovered || recovered.payload.imageHash !== recoveryImageHash)) {
      throw new ManagedWorkspaceError("recovered candidate image no longer matches its persisted continuation; no worker or writer launched");
    }
    const repairAuthorization = recoveryImageHash ? [...inspection.events].reverse().find((event) =>
      event.kind === "mission.recovery.repair.authorized" && event.payload.unitId === unit.id &&
      event.payload.sourceImageHash === recoveryImageHash && event.payload.continuationId === continuationId) : undefined;
    const repairAuthorizationId = typeof repairAuthorization?.payload.authorizationId === "string"
      ? repairAuthorization.payload.authorizationId : undefined;
    const repairStarted = repairAuthorizationId && inspection.events.some((event) => event.kind === "mission.recovery.repair.started" &&
      event.payload.authorizationId === repairAuthorizationId);
    let recoveryMode: "verify" | "repair" | undefined = continuation ? "verify" : undefined;
    if (repairAuthorizationId && !repairStarted) recoveryMode = "repair";
    let verificationOnly = recoveryMode === "verify";
    if (!continuation && !checkpoint) {
      const priorReportEvent = [...inspection.events].reverse().find((event) => event.kind === "mission.recovery.recorded" &&
        event.revision === inspection.revision && typeof event.payload.reportHash === "string");
      const priorAttempts = new Set(inspection.events.filter((event) => event.kind === "attempt.reserved" &&
        event.revision === inspection.revision && event.unitId === unit.id)
        .map((event) => String(event.payload.attemptId)));
      if (priorReportEvent) {
        try {
          const report = JSON.parse(this.store.readArtifact(String(priorReportEvent.payload.reportHash)).toString("utf8")) as { effects?: Array<{ attemptId?: string | null; disposition?: string }> };
          verificationOnly = report.effects?.some((effect) => effect.attemptId && priorAttempts.has(effect.attemptId) &&
            (effect.disposition === "applied" || effect.disposition === "partial")) ?? false;
          if (verificationOnly) recoveryMode = "verify";
        } catch { /* a missing report cannot grant repeat-write authority */ }
      }
    }
    const effects = new MissionEffects({
      store: this.store, workspace, missionId: this.missionId, revision: inspection.revision,
      unitId: unit.id, attemptId, runtimeId: this.store.runtimeId, ownerEpoch,
      allowedOperations: inspection.definition.authority.operations,
      recoveryMode, recoveryImageHash, repairAuthorizationId,
      canInvoke: (effectId) => this.attemptAdmitted({ revision: inspection.revision, ownerEpoch, unitId: unit.id, attemptId }, undefined, effectId),
    });
    if (verificationOnly) effects.enableVerificationOnly();
    return {
      workspace, effects, baseImage, contributionInput, dependencyOutputs, verificationOnly, recoveryMode,
      recoveryContinuationId: continuationId, recoveryImageHash,
      repairAuthorizationId: recoveryMode === "repair" ? repairAuthorizationId : undefined,
    };
  }

  private async reserveAttempt(inspection: ReturnType<MissionStore["inspectMission"]>, unit: MissionUnit, state: MissionEngineSnapshot,
    team?: { bundle: TeamBundle; brief: string; targetId: string; continuationOf?: string; consultationId?: string },
    singleton?: { sourceAttemptId: string; checkpointHash: string; childResultHash: string; consultationId: string; brief: string },
    recovery?: MissionAttemptBinding,
  ): Promise<{ binding: MissionAttemptBinding; runtime?: ManagedAttemptRuntime }> {
    if (this.attemptControllers.size >= this.sessionLimit(inspection))
      throw new ComputeSlotBusyError("root simultaneous-session limit reached");
    if (this.managedWorkspace && !team && unit.role === "developer" &&
      (Object.values(state.attempts).some(({ binding, settled }) => !settled && binding.candidate === "managed" && binding.role === "developer") ||
        [...this.effectRunners].some((runner) => !runner.quiescent)))
      throw new ComputeSlotBusyError("one mutating Developer remains active or unquiescent");
    const attemptNo = singleton ? Object.values(state.attempts).filter(({ binding }) =>
      binding.unitId === unit.id && binding.roundId === "main" && binding.memberId === "solo" &&
      (binding.targetId ?? unit.id) === unit.id).length + 1
      : team ? Object.values(state.attempts).filter(({ binding }) =>
      binding.unitId === unit.id && (binding.targetId ?? unit.id) === team.targetId &&
      binding.roundId === team.bundle.round && binding.memberId === team.bundle.memberId).length + 1
      : this.nextAttemptNo(state, unit.id);
    const attemptId = randomUUID();
    const runtime = this.managedWorkspace && !team ? await this.prepareManagedAttempt(inspection, unit, attemptId, singleton && {
      sourceAttemptId: singleton.sourceAttemptId, checkpointHash: singleton.checkpointHash,
    }, recovery) : undefined;
    const pauseRecovery = recovery && state.attempts[recovery.attemptId]?.status === "interrupted"
      ? this.pauseContinuation(inspection, recovery) : undefined;
    if (recovery && state.attempts[recovery.attemptId]?.status === "interrupted" && !pauseRecovery)
      throw new RecoveryAdmissionError("pause recovery proof has no unspent current observation");
    const retry = [...inspection.events].reverse().find((event) => event.kind === "unit.ready" && event.unitId === unit.id && event.payload.retryOf);
    const retryPredecessor = retry && state.attempts[String(retry.payload.retryOf)]?.binding;
    const verification = runtime?.recoveryMode === "verify" && inspection.events.find((event) =>
      event.kind === "mission.recovery.continuation.recorded" && event.payload.continuationId === runtime.recoveryContinuationId);
    const predecessor = recovery ?? (verification ? state.attempts[String(verification.payload.sourceAttemptId)]?.binding :
      retryPredecessor && (!team || retryPredecessor.roundId === team.bundle.round && retryPredecessor.memberId === team.bundle.memberId)
        ? retryPredecessor : singleton ? state.attempts[singleton.sourceAttemptId]?.binding :
      team?.continuationOf ? state.attempts[team.continuationOf]?.binding : undefined);
    const correctionNo = (predecessor ? missionCorrectionNo(inspection.events, predecessor) : 0) + Number(Boolean(predecessor && !pauseRecovery && !verification &&
      state.attempts[predecessor.attemptId]?.status === "failed"));
    if (correctionNo > unit.retryLimit) throw new RecoveryAdmissionError("logical correction limit is exhausted");
    const baseInputManifestHash = hashJson({
      revision: inspection.revision,
      unit: unit.id,
      inputs: unit.inputs,
      dependencies: unit.dependencies.map((id) => ({ id, evidence: state.units[id]?.evidenceIds ?? [] })),
    });
    const inputManifestHash = runtime
      ? hashJson({ baseInputManifestHash, workspaceManifestHash: runtime.workspace.manifest.hash })
      : baseInputManifestHash;
    const policy = inspection.definition.authority.rolePolicies[unit.role]!;
    const assessmentToolIdentity = missionAssessmentToolIdentity(this.assessPredicate);
    const runtimeIdentity = missionRuntimeIdentity();
    const dependencyEvidence = unit.dependencies.flatMap((dependencyId) => (state.units[dependencyId]?.evidenceIds ?? []).flatMap((evidenceId) => {
      const evidence = state.evidence.find((row) => row.id === evidenceId);
      return evidence ? [{ unitId: dependencyId, evidenceId, predicateId: evidence.predicateId, outputManifestHash: evidence.outputManifestHash }] : [];
    })).sort((left, right) => left.unitId.localeCompare(right.unitId) || left.predicateId.localeCompare(right.predicateId));
    const dependenciesComplete = unit.dependencies.every((dependencyId) => state.units[dependencyId]?.status === "accepted" &&
      (state.units[dependencyId]?.evidenceIds.length ?? 0) > 0 && (state.units[dependencyId]?.evidenceIds ?? []).every((evidenceId) =>
        state.evidence.some((evidence) => evidence.id === evidenceId)));
    const brief = team?.brief ?? singleton?.brief ?? createBrief(inspection.definition.goal, unit, state, runtime?.recoveryMode);
    const inputBindings = team ? [] : capturePredicateInputBindings(
      inspection.definition.finalization.contractVersion === 1 ? this.managedWorkspace?.sourceRoot : runtime?.workspace.candidateRoot ?? this.managedWorkspace?.sourceRoot,
      unit,
      inspection.definition.authority.allowedPaths,
      policy.hash,
      dependencyEvidence,
      dependenciesComplete,
      assessmentToolIdentity,
      runtimeIdentity,
    );
    const inputBindingsBytes = Buffer.from(JSON.stringify({ format: "mission-predicate-input-bindings-v1", bindings: inputBindings }));
    const binding: MissionAttemptBinding = {
      missionId: this.missionId,
      revision: inspection.revision,
      unitId: unit.id,
      roundId: team?.bundle.round ?? "main",
      memberId: team?.bundle.memberId ?? "solo",
      attemptId,
      attemptNo, correctionNo,
      ...(pauseRecovery ? { recoveryOf: recovery!.attemptId,
        recoveryContinuationId: String(pauseRecovery.payload.continuationId),
        recoveryImageHash: String(pauseRecovery.payload.sourceImageHash) } : {}),
      ownerEpoch: this.store.ownerEpoch ?? 0,
      candidate: runtime ? "managed" : "read-only",
      ...(runtime ? {
        candidateId: runtime.workspace.candidateId, candidateRoot: runtime.workspace.candidateRoot,
        candidateRegistration: registerCandidateWorkspace(runtime.workspace, {
          repositoryId: inspection.repositoryId, owner: currentProcessIdentity(this.store.runtimeId, this.store.ownerEpoch ?? 0),
        }), workspaceManifestHash: runtime.workspace.manifest.hash,
        recoveryContinuationId: runtime.recoveryContinuationId, recoveryImageHash: runtime.recoveryImageHash,
        recoveryMode: runtime.recoveryMode, repairAuthorizationId: runtime.repairAuthorizationId,
      } : {}),
      predicateInputBindingsHash: sha256(inputBindingsBytes),
      predicateInputBindingsComplete: inputBindings.every(({ complete }) => complete),
      inputManifestHash,
      briefHash: hashJson(brief),
      rolePolicyHash: policy.hash,
      role: unit.role,
      ...(singleton ? { continuationOf: singleton.sourceAttemptId, checkpointHash: singleton.checkpointHash,
        childResultHash: singleton.childResultHash, consultationId: singleton.consultationId } : {}),
      ...(team ? { targetId: team.targetId,
        ...(team.consultationId ? { consultationId: team.consultationId } : {}),
        ...(team.continuationOf ? { continuationOf: team.continuationOf, childResultHash: team.bundle.childResultHash } : {}) } : {}),
      ...(team ? { teamBundleHash: hashJson(team.bundle),
        teamOutputContractHash: hashJson({ version: 1, phase: team.bundle.phase, round: team.bundle.round }) } : {}),
    };
    const rootFirstSlot = !singleton && (team?.targetId ?? unit.id) === unit.id && !team?.continuationOf &&
      !Object.values(state.attempts).some(({ binding: prior }) => prior.unitId === unit.id &&
        prior.revision === inspection.revision && (prior.targetId ?? unit.id) === unit.id &&
        prior.roundId === (team?.bundle.round ?? "main") && prior.memberId === (team?.bundle.memberId ?? "solo") &&
        !prior.continuationOf);
    const pendingRootLaunches = this.remainingRootSlots(inspection) - Number(rootFirstSlot);
    this.requireRootSlack(inspection, "role-launches", 1,
      binding.consultationId ? Math.min(1, this.consultationHold(inspection, binding.consultationId, "role-launches")) : 0,
      pendingRootLaunches);
    const reviewed = [...inspection.events].reverse().find((row) => row.kind === "mission.finalization.reviewed");
    const events: MissionEventDraft[] = [
      ...(reviewed ? [
        this.event(inspection.revision, "mission.finalization.invalidated", `${attemptId}:approval-invalidated`,
          { reason: "a new ordinary attempt was admitted after whole-result review", approvalEventId: reviewed.eventId }),
        this.event(inspection.revision, "mission.finalization.generation", `${attemptId}:generation`,
          { generation: 1 + Math.max(0, ...inspection.events.filter((row) => row.kind === "mission.finalization.generation")
            .map((row) => Number(row.payload.generation))), reason: "post-review ordinary attempt admission" }),
      ] : []),
      this.event(inspection.revision, "attempt.reserved", `${attemptId}:reserved`, {
      attemptId, binding, unitId: unit.id, targetId: binding.targetId ?? unit.id,
      roundId: binding.roundId, memberId: binding.memberId, attemptNo,
    }, unit.id, attemptId)];
    if (runtime?.recoveryMode === "repair" && runtime.repairAuthorizationId) events.push(this.event(
      inspection.revision, "mission.recovery.repair.started", `${attemptId}:repair-started`, {
        authorizationId: runtime.repairAuthorizationId, continuationId: runtime.recoveryContinuationId,
        sourceImageHash: runtime.recoveryImageHash, repairAttemptId: attemptId,
      }, unit.id, attemptId,
    ));
    const artifacts: Array<{ bytes: Uint8Array; mediaType: string }> = [
      { bytes: inputBindingsBytes, mediaType: "application/json" },
      ...(team ? [{ bytes: Buffer.from(JSON.stringify(team.bundle)), mediaType: "application/json" }] : []),
    ];
    if (runtime) {
      const registration = binding.candidateRegistration!;
      const registered = this.event(inspection.revision, "workspace.candidate.registered", `${attemptId}:candidate-registered`, {
        ...registration, locationHistory: [registration.root],
      }, unit.id, attemptId);
      events.push(registered);
      try {
        const captured = runtime.baseImage ?? captureWorkspaceImage(runtime.workspace.candidateRoot);
        const baseImage = inspection.definition.finalization.contractVersion === 1
          ? { ...captured, manifest: runtime.workspace.manifest }
          : filterWorkspaceImage({ ...captured, manifest: runtime.workspace.manifest }, runtime.workspace.allowedPaths);
        const sealed = sealWorkspaceImage(baseImage);
        artifacts.push(...sealed.artifacts);
        const base = this.event(inspection.revision, "workspace.snapshot.sealed", `${attemptId}:workspace-base`, {
          attemptId, phase: "base", imageHash: sealed.imageHash,
          manifestHash: runtime.workspace.manifest.hash, manifest: runtime.workspace.manifest,
          ...(inspection.definition.finalization.contractVersion === 1 ? { artifactBytes: sealed.artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0) } : {}),
          candidateRoot: runtime.workspace.candidateRoot,
          candidateIdentity: runtime.workspace.candidateIdentity,
          candidateGitIdentity: runtime.workspace.candidateGitIdentity,
          candidateArenaRoot: runtime.workspace.candidateArenaRoot,
          candidateArenaIdentity: runtime.workspace.candidateArenaIdentity,
        }, unit.id, attemptId);
        events.push(base);
        // T4's source/delivery baseline is not the post-restore execution starting tree.
        const capturedStart = captureWorkspaceImage(runtime.workspace.candidateRoot);
        const startImage = inspection.definition.finalization.contractVersion === 1
          ? { ...capturedStart, manifest: canonicalDeliveryManifest(capturedStart.manifest, runtime.workspace.manifest) }
          : filterWorkspaceImage(capturedStart, runtime.workspace.allowedPaths);
        const start = sealWorkspaceImage(startImage);
        if (captureWorkspaceImage(runtime.workspace.candidateRoot).manifest.hash !== capturedStart.manifest.hash)
          throw new Error("candidate changed while sealing execution-start image");
        artifacts.push(...start.artifacts);
        events.push(this.event(inspection.revision, "workspace.snapshot.sealed", `${attemptId}:execution-start`, {
          attemptId, phase: "observed", purpose: "execution-start", imageHash: start.imageHash,
          manifestHash: startImage.manifest.hash, bindingHash: hashJson(binding), ownerEpoch: binding.ownerEpoch,
          candidateRegistrationCausalId: registered.causalId, candidateRegistrationHash: hashJson(registered.payload),
          sourceBaseCausalId: base.causalId, sourceBaseImageHash: sealed.imageHash,
          ...(inspection.definition.finalization.contractVersion === 1 ? { contributionInput: runtime.contributionInput ?? {
            originAttemptId: attemptId, baseImageHash: start.imageHash, dependencyOutputs: runtime.dependencyOutputs,
          } satisfies ContributionInput } : {}),
          checkpointHash: binding.checkpointHash ?? null, recoveryImageHash: binding.recoveryImageHash ?? null,
          ...(inspection.definition.finalization.contractVersion === 1 ? { artifactBytes: start.artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0) } : {}),
        }, unit.id, attemptId));
      } catch (error) {
        quarantineWorkspace(runtime.workspace, `baseline could not be safely sealed: ${messageOf(error)}`);
        throw new ManagedWorkspaceError(`managed candidate baseline could not be sealed; no worker launched: ${messageOf(error)}`);
      }
    }
    events.push(this.event(inspection.revision, "reservation.created", `reservation:${attemptId}:launch`, {
      reservationId: stableId(`${attemptId}:launch`), revision: inspection.revision, resource: "role-launches", amount: 1, purpose: "ordinary",
    }, unit.id, attemptId));
    const artifactAllowance = inspection.definition.finalization.contractVersion === 1 ? compileFinalizationGrants(inspection.definition).artifacts :
      Math.max(1, Math.ceil(inspection.definition.budget.artifactBytes / inspection.definition.budget.roleLaunches));
    this.requireRootSlack(inspection, "artifact-bytes", artifactAllowance,
      binding.consultationId ? Math.min(artifactAllowance, this.consultationHold(inspection, binding.consultationId, "artifact-bytes")) : 0,
      pendingRootLaunches);
    events.push(this.event(inspection.revision, "reservation.created", `reservation:${attemptId}:artifact`, {
      reservationId: stableId(`${attemptId}:artifact`), revision: inspection.revision, resource: "artifact-bytes", amount: artifactAllowance, purpose: "ordinary",
    }, unit.id, attemptId));
    let openedWindow: ActiveTimeWindow | undefined;
    if (!this.activeWindow) {
      const activeUse = budgetAmounts(inspection.events, "active-time-ms");
      const remaining = inspection.definition.budget.activeTimeMs - activeUse.ordinary - activeUse.protected - activeUse.finalization +
        (binding.consultationId ? this.consultationHold(inspection, binding.consultationId, "active-time-ms") : 0);
      const quantum = Math.min(
        ACTIVE_TIME_QUANTUM_MS,
        inspection.definition.finalization.contractVersion === 1 ? compileFinalizationGrants(inspection.definition).active :
          Math.max(1, Math.ceil(inspection.definition.budget.activeTimeMs / inspection.definition.budget.roleLaunches)),
        remaining,
      );
      if (quantum < 1) throw new Error("active-time-ms budget has no ordinary capacity for another time quantum");
      this.requireRootSlack(inspection, "active-time-ms", quantum,
        binding.consultationId ? Math.min(quantum, this.consultationHold(inspection, binding.consultationId, "active-time-ms")) : 0,
        pendingRootLaunches);
      const windowId = randomUUID();
      const reservationId = stableId(`${this.missionId}:active-window:${windowId}`);
      const startedAt = this.now();
      openedWindow = {
        id: windowId, reservationId, grantAmount: quantum, knownCharge: 0, unknownCharge: 0, released: 0,
        fractionalMs: 0, lastCheckpointAt: startedAt, ownerEpoch: this.store.ownerEpoch ?? 0, runtimeId: this.store.runtimeId,
      };
      events.push(this.event(inspection.revision, "reservation.created", `reservation:${windowId}:active-time`, {
        reservationId, revision: inspection.revision, resource: "active-time-ms", amount: quantum, purpose: "ordinary",
      }));
      events.push(this.event(inspection.revision, "mission.active.window.opened", `${windowId}:opened`, {
        windowId, reservationId, grantAmount: quantum, runtimeId: openedWindow.runtimeId,
        ownerEpoch: openedWindow.ownerEpoch, engineId: this.engineId, startedMonotonicMs: startedAt,
      }));
    }
    if (binding.consultationId) events.unshift(...this.releaseConsultationMinimum(inspection, binding.consultationId,
      { "role-launches": 1, "artifact-bytes": artifactAllowance,
        ...(openedWindow ? { "active-time-ms": openedWindow.grantAmount } : {}) }, unit.id, attemptId));
    events.push(this.event(inspection.revision, "attempt.started", `${attemptId}:started`, { attemptId, unitId: unit.id }, unit.id, attemptId));
    const readyEvent = [...inspection.events].reverse().find((event) => event.kind === "unit.ready" && event.unitId === unit.id);
    const readyMonotonicMs = readyEvent?.payload.readyRuntimeId === this.store.runtimeId && typeof readyEvent.payload.readyMonotonicMs === "number"
      ? readyEvent.payload.readyMonotonicMs
      : undefined;
    const queueWaitMs = readyMonotonicMs === undefined ? null : Math.max(0, this.now() - readyMonotonicMs);
    events.push(this.event(inspection.revision, "dispatch.observed", `${attemptId}:dispatch`, {
      attemptId, unitId: unit.id, queueWaitMs,
      waitUnknownReason: queueWaitMs === null ? "ready timestamp belongs to another runtime or is unavailable" : undefined,
      dispatchedAt: this.wallNow(),
    }, unit.id, attemptId));
    const latest = this.store.inspectMission(this.missionId);
    const scope = recoveryBlockedUnits(this.store, latest, this.managedWorkspace?.sourceRoot);
    if (latest.version !== inspection.version || scope === null || scope.has(unit.id) ||
      (team && latest.events.some((event) => event.kind === "team.consultation.cancelled" && event.unitId === unit.id)) ||
      !["running", "blocked"].includes(reduceMissionEvents(latest).state) ||
      binding.recoveryContinuationId && !this.recoveryBindingCurrent(binding, latest))
      throw new RecoveryAdmissionError("recovery or operator state changed before attempt reservation");
    this.store.appendTransition(this.missionId, inspection.version, { events, artifacts });
    if (openedWindow) {
      this.activeWindow = openedWindow;
      this.armActiveCheckpoint();
    }
    return { binding, runtime };
  }

  private launchAttempt(unit: MissionUnit, binding: MissionAttemptBinding, runtime?: ManagedAttemptRuntime, teamBrief?: string): void {
    const startedAt = this.now();
    this.attemptStarted.set(binding.attemptId, startedAt);
    let callbackOutcome: AgentRunResult | undefined;
    const sessionDir = path.join(this.sessionsDirectory, this.missionId, binding.attemptId);
    mkdirSync(sessionDir, { recursive: true });
    const rolePolicy = missionPolicyTargets(this.store.inspectMission(this.missionId).definition, unit.role);
    const durable: DurableAttemptContext = {
      attemptId: binding.attemptId,
      sessionDir,
      sessionId: binding.attemptId,
      readOnly: !runtime || runtime.verificationOnly,
      ...(runtime ? { cwd: runtime.workspace.candidateRoot, effects: runtime.effects } : {}),
      rolePolicy,
      onProviderDispatch: (request) => this.dispatchProviderRequest(binding, request),
      onProviderReceipt: (receipt) => this.recordProviderReceipt(binding, receipt),
      onOutcome: (result) => { callbackOutcome ??= result; },
    };
    const brief = teamBrief ?? createBrief(this.store.inspectMission(this.missionId).definition.goal, unit, this.snapshot(), runtime?.recoveryMode);
    const controller = new AbortController();
    durable.signal = controller.signal;
    this.attemptControllers.set(binding.attemptId, controller);
    const finalizationTimer = binding.finalization ? setTimeout(() => controller.abort("finalization phase active-time grant expired"),
      compileFinalizationGrants(this.store.inspectMission(this.missionId).definition).active) : undefined;
    if (runtime) {
      this.effectRunners.add(runtime.effects);
      this.attemptEffects.set(binding.attemptId, runtime.effects);
    }
    const job = (async () => {
      let result: AgentRunResult;
      try {
        const current = this.store.inspectMission(this.missionId);
        const scope = recoveryBlockedUnits(this.store, current, this.managedWorkspace?.sourceRoot);
        if (binding.revision !== current.revision || this.store.ownerEpoch !== binding.ownerEpoch ||
          scope === null || scope.has(binding.unitId) ||
          current.events.some((event) => event.kind === "team.consultation.cancelled" && event.unitId === binding.unitId) ||
          !["running", "blocked", ...(binding.finalization ? ["completing"] : [])].includes(reduceMissionEvents(current).state) ||
          !this.recoveryBindingCurrent(binding, current) ||
          pendingQuestionUnits(current.events, current.definition, this.store).has(binding.unitId))
          throw new Error("recovery or operator state changed before role dispatch");
        if (runtime) {
          const admission = mintEngineRoleDispatchAdmission(this.store, {
            missionId: this.missionId, attemptId: binding.attemptId, candidateId: runtime.workspace.candidateId,
            ownerEpoch: binding.ownerEpoch, rootIdentity: runtime.workspace.candidateIdentity,
            gitIdentity: runtime.workspace.candidateGitIdentity,
          });
          await authorizeRoleDispatch(runtime.workspace.candidateRoot, { admission, store: this.store });
        }
        if (!this.attemptAdmitted(binding)) throw new Error("attempt changed during role admission");
        result = await this.runRole({ missionId: this.missionId, unit, binding, brief }, durable);
      } catch (error) {
        result = callbackOutcome ?? failedRun(error);
        // A callback preceding a failed SDK run is not quiescence proof.
        if (result.status === "completed" && isConsultationOutput(result.result)) result = { ...result, status: "failed" };
      }
      if (!this.retired && runtime && result.status === "completed" && !isConsultationOutput(result.result) &&
        this.store.inspectMission(this.missionId).definition.finalization.contractVersion === 1)
        await this.sealTerminalOutput(binding, runtime, result);
      this.persistAttemptReceipt(binding, result);
      if (runtime && isConsultationOutput(result.result)) await this.checkpointSingletonRequest(binding, runtime, result);
      const pause = controller.signal.reason;
      if (isHostPauseAbort(pause) && pause.attemptId === binding.attemptId && result.status !== "completed") {
        await this.commitHostPauseInterruption(binding, runtime, result, pause);
      }
      void startedAt;
    })().finally(() => {
      if (finalizationTimer) clearTimeout(finalizationTimer);
      this.inFlight.delete(binding.attemptId);
      this.attemptControllers.delete(binding.attemptId);
      this.attemptEffects.delete(binding.attemptId);
    });
    this.inFlight.set(binding.attemptId, job);
  }

  private pauseTargets(
    inspection: ReturnType<MissionStore["inspectMission"]>,
    state: MissionEngineSnapshot,
  ): Array<{ attemptId: string; binding: MissionAttemptBinding; bindingHash: string; controller: AbortController }> {
    const targets = [];
    for (const [attemptId, controller] of this.attemptControllers) {
      if (controller.signal.aborted) continue;
      const attempt = state.attempts[attemptId];
      if (!attempt || attempt.settled || attempt.receipt?.status === "completed") continue;
      const reserved = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === attemptId);
      if (!reserved) continue;
      targets.push({ attemptId, binding: attempt.binding, bindingHash: hashJson(reserved.payload.binding), controller });
    }
    return targets;
  }

  private pauseBindings(targets: ReturnType<MissionEngine["pauseTargets"]>): Record<string, unknown> {
    const ownerEpoch = this.store.ownerEpoch;
    return {
      ownerEpoch, runtimeId: this.store.runtimeId,
      owner: ownerEpoch === null ? null : currentProcessIdentity(this.store.runtimeId, ownerEpoch),
      stoppedAttempts: targets.map(({ attemptId, binding, bindingHash }) => ({
        attemptId, bindingHash, unitId: binding.unitId, ownerEpoch: binding.ownerEpoch,
        targetId: binding.targetId ?? binding.unitId, roundId: binding.roundId, memberId: binding.memberId,
        continuationOf: binding.continuationOf ?? null, consultationId: binding.consultationId ?? null,
        checkpointHash: binding.checkpointHash ?? null, childResultHash: binding.childResultHash ?? null,
        teamBundleHash: binding.teamBundleHash ?? null,
      })),
    };
  }

  private async commitHostPauseInterruption(
    binding: MissionAttemptBinding,
    runtime: ManagedAttemptRuntime | undefined,
    result: AgentRunResult,
    cause: HostPauseAbort,
  ): Promise<void> {
    if (this.retired || this.closed && !this.retirement) return;
    const sdkDisposed = disposedPiResults.get(result) === hashJson(result);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const built = await this.buildPauseProof(binding, runtime, result, cause, sdkDisposed);
        if (!built) return;
        this.store.appendTransition(this.missionId, built.version, { events: built.events, artifacts: built.artifacts });
        return;
      } catch (error) {
        if (attempt < 2 && /version conflict/.test(messageOf(error))) continue;
        this.recordPauseDenial(cause.pauseEventId, binding, `pause interruption unproven: ${messageOf(error)}`);
        return;
      }
    }
  }

  private async buildPauseProof(
    binding: MissionAttemptBinding,
    runtime: ManagedAttemptRuntime | undefined,
    result: AgentRunResult,
    cause: HostPauseAbort,
    sdkDisposed: boolean,
  ): Promise<{ version: number; events: MissionEventDraft[]; artifacts: Array<{ bytes: Uint8Array; mediaType: string }> } | undefined> {
    if (!sdkDisposed) throw new Error("SDK disposal is unproven");
    if (runtime) {
      runtime.effects.fence();
      await runtime.effects.shutdown();
      if (!runtime.effects.quiescent) throw new Error("managed effects did not quiesce");
    }
    const inspection = this.store.inspectMission(this.missionId);
    const state = reduceMissionEvents(inspection);
    if (state.attempts[binding.attemptId]?.settled) return undefined;
    if (cause.attemptId !== binding.attemptId) throw new Error("pause cause is not bound to this attempt");
    if (this.store.ownerEpoch !== binding.ownerEpoch || inspection.revision !== binding.revision) {
      throw new Error("pause owner or revision changed");
    }
    const pause = inspection.events.find((event) => event.eventId === cause.pauseEventId && event.kind === "mission.paused");
    const reserved = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === binding.attemptId);
    const bindingHash = reserved ? hashJson(reserved.payload.binding) : "";
    const stopped = Array.isArray(pause?.payload.stoppedAttempts) ? pause.payload.stoppedAttempts as Array<Record<string, unknown>> : [];
    if (!pause || !stopped.some((row) => row.attemptId === binding.attemptId && row.bindingHash === bindingHash)) {
      throw new Error("attempt was not listed on the committed host pause");
    }
    const receipt = inspection.events.find((event) => event.kind === "attempt.receipt" && event.attemptId === binding.attemptId);
    if (!receipt) throw new Error("missing receipt");
    if (receipt.payload.status !== "cancelled" && receipt.payload.status !== "failed") {
      throw new Error("receipt is not a preserved terminal stop");
    }
    if (receipt.payload.status !== result.status) throw new Error("persisted receipt does not match the runner result");
    const effectRows = inspection.events.filter((event) => event.attemptId === binding.attemptId &&
      (event.kind.startsWith("effect.") || event.kind === "workspace.snapshot.sealed" && event.payload.effectId));
    if (effectRows.some((event) => event.kind === "effect.unknown" ||
      event.kind === "effect.observation.recorded" && event.payload.disposition === "unknown" ||
      event.kind === "effect.reconciled" && event.payload.disposition === "unknown") ||
      missionHasUnresolvedEffects(this.store, inspection.events, binding.attemptId)) {
      throw new Error("unknown or unresolved effect denies pause interruption");
    }
    const afterDrain = this.store.inspectMission(this.missionId);
    if (afterDrain.version !== inspection.version) throw new Error("version conflict");
    if (!missionEffectProcessesQuiescent(afterDrain.events, binding.attemptId)) {
      throw new Error("effect processes are not quiescent");
    }
    const artifacts: Array<{ bytes: Uint8Array; mediaType: string }> = [];
    let baseImageHash: string;
    let observedImageHash: string;
    let sourceManifestHash: string;
    let executionStart: MissionEvent | undefined;
    if (binding.candidate === "managed") {
      if (!runtime || !binding.candidateRoot || !this.managedWorkspace) throw new Error("managed candidate image is unavailable");
      const base = afterDrain.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
        event.attemptId === binding.attemptId && event.payload.phase === "base");
      if (!base || typeof base.payload.imageHash !== "string") throw new Error("base image is missing");
      const registered = afterDrain.events.find((event) => event.kind === "workspace.candidate.registered" && event.attemptId === binding.attemptId);
      executionStart = afterDrain.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
        event.attemptId === binding.attemptId && event.payload.purpose === "execution-start");
      if (!registered || !executionStart || executionStart.revision !== binding.revision ||
        executionStart.payload.bindingHash !== bindingHash || bindingHash !== hashJson(binding) ||
        executionStart.payload.ownerEpoch !== binding.ownerEpoch ||
        hashJson(registered.payload) !== hashJson({ ...binding.candidateRegistration, locationHistory: [binding.candidateRoot] }) ||
        executionStart.payload.candidateRegistrationCausalId !== registered.causalId ||
        executionStart.payload.candidateRegistrationHash !== hashJson(registered.payload) ||
        executionStart.payload.sourceBaseCausalId !== base.causalId || executionStart.payload.sourceBaseImageHash !== base.payload.imageHash ||
        executionStart.payload.checkpointHash !== (binding.checkpointHash ?? null) ||
        executionStart.payload.recoveryImageHash !== (binding.recoveryImageHash ?? null) ||
        typeof executionStart.payload.imageHash !== "string" ||
        readSealedWorkspaceImage(this.store, executionStart.payload.imageHash).manifest.hash !== executionStart.payload.manifestHash)
        throw new Error("execution-start image or lineage is missing or changed");
      const candidate = verifyPrivateCandidate(binding.candidateRoot, this.managedWorkspace.sourceRoot);
      if (candidate.identity !== binding.candidateRegistration?.rootIdentity ||
        candidate.gitIdentity !== binding.candidateRegistration?.gitIdentity) {
        throw new Error("candidate identity changed before pause image");
      }
      const capturedImage = captureWorkspaceImage(runtime.workspace.candidateRoot);
      const image = inspection.definition.finalization.contractVersion === 1
        ? { ...capturedImage, manifest: canonicalDeliveryManifest(capturedImage.manifest, runtime.workspace.manifest) }
        : filterWorkspaceImage(capturedImage, runtime.workspace.allowedPaths);
      if (inspection.definition.finalization.contractVersion === 1) assertCompleteWorkspaceImage(image, captureWorkspacePaths(runtime.workspace.candidateRoot, true));
      const sealed = sealWorkspaceImage(image);
      if (captureWorkspaceImage(runtime.workspace.candidateRoot).manifest.hash !== capturedImage.manifest.hash) {
        throw new Error("candidate changed while sealing interrupted image");
      }
      artifacts.push(...sealed.artifacts);
      baseImageHash = executionStart.payload.imageHash;
      observedImageHash = sealed.imageHash;
      sourceManifestHash = captureWorkspaceImage(this.managedWorkspace.sourceRoot).manifest.hash;
    } else {
      if (!this.managedWorkspace) throw new Error("read-only source image is unavailable");
      const captured = captureWorkspaceImage(this.managedWorkspace.sourceRoot);
      const witness = Buffer.from(JSON.stringify({
        format: "mission-pause-readonly-image-v1", manifestHash: captured.manifest.hash, manifest: captured.manifest,
      }));
      artifacts.push({ bytes: witness, mediaType: "application/json" });
      baseImageHash = observedImageHash = sha256(witness);
      sourceManifestHash = captured.manifest.hash;
    }
    let checkpointEventId: string | null = null;
    if (binding.checkpointHash) {
      const seal = afterDrain.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
        event.payload.purpose === "consultation" && event.payload.checkpointHash === binding.checkpointHash);
      if (!seal || sha256(this.store.readArtifact(binding.checkpointHash)) !== binding.checkpointHash) {
        throw new Error("consultation checkpoint is missing or changed");
      }
      if (executionStart) {
        const checkpoint = JSON.parse(this.store.readArtifact(binding.checkpointHash).toString("utf8"));
        if (checkpoint.sourceAttemptId !== binding.continuationOf || seal.attemptId !== binding.continuationOf ||
          (binding.recoveryImageHash ?? checkpoint.imageHash) !== baseImageHash)
          throw new Error("execution-start image does not match the expected checkpoint");
      }
      checkpointEventId = seal.eventId;
    }
    if (binding.childResultHash && sha256(this.store.readArtifact(binding.childResultHash)) !== binding.childResultHash) {
      throw new Error("child result bytes changed");
    }
    if (binding.teamBundleHash && sha256(this.store.readArtifact(binding.teamBundleHash)) !== binding.teamBundleHash) {
      throw new Error("team bundle bytes changed");
    }
    const role = binding.role ?? afterDrain.definition.units.find(({ id }) => id === binding.unitId)?.role;
    if (!role || afterDrain.definition.authority.rolePolicies[role]?.hash !== binding.rolePolicyHash) {
      throw new Error("role policy changed");
    }
    this.store.readArtifact(afterDrain.snapshot.definitionHash);
    const effectIds = [...new Set(effectRows.map((event) => event.effectId).filter((id): id is string => !!id))];
    const proof = {
      format: "mission-pause-interruption-v1", missionId: this.missionId, pauseEventId: cause.pauseEventId,
      attemptId: binding.attemptId, bindingHash, ownerEpoch: binding.ownerEpoch,
      owner: currentProcessIdentity(this.store.runtimeId, binding.ownerEpoch), runtimeId: this.store.runtimeId,
      revision: binding.revision, definitionHash: afterDrain.snapshot.definitionHash,
      rolePolicyHash: binding.rolePolicyHash, inputManifestHash: binding.inputManifestHash,
      receiptEventId: receipt.eventId, receiptHash: hashJson(receipt.payload), receiptStatus: receipt.payload.status,
      candidate: binding.candidate, baseImageHash, observedImageHash, sourceManifestHash,
      ...(executionStart ? { executionStartEventId: executionStart.eventId,
        executionStartPayloadHash: hashJson(executionStart.payload) } : {}),
      checkpointHash: binding.checkpointHash ?? null, checkpointEventId,
      childResultHash: binding.childResultHash ?? null, teamBundleHash: binding.teamBundleHash ?? null,
      consultationId: binding.consultationId ?? null, journalWatermark: afterDrain.latestSeq,
      effects: effectIds.map((effectId) => ({
        effectId, witnesses: effectRows.filter((event) => event.effectId === effectId).map((event) => ({
          eventId: event.eventId, seq: event.seq, kind: event.kind, payloadHash: hashJson(event.payload),
        })),
      })),
      sdkDisposed: true, effectsQuiescent: true, processesQuiescent: true,
    };
    const proofBytes = Buffer.from(JSON.stringify(proof));
    const proofHash = sha256(proofBytes);
    artifacts.push({ bytes: proofBytes, mediaType: "application/json" });
    return {
      version: afterDrain.version,
      artifacts,
      events: [this.event(binding.revision, "attempt.settled", `${binding.attemptId}:pause-interrupted:${cause.pauseEventId}`, {
        attemptId: binding.attemptId, status: "interrupted", resultHash: receipt.payload.artifactHash ?? null,
        interruption: { kind: "host-pause", pauseEventId: cause.pauseEventId, proofHash },
      }, binding.unitId, binding.attemptId)],
    };
  }

  private recordPauseDenial(pauseEventId: string, binding: MissionAttemptBinding, reason: string): void {
    if (this.retired || this.closed && !this.retirement) return;
    const inspection = this.store.inspectMission(this.missionId);
    if (inspection.events.some((event) => event.attemptId === binding.attemptId && (
      event.kind === "attempt.settled" && event.payload.status === "interrupted" &&
        linkedPauseId(event.payload) === pauseEventId ||
      event.kind === "resource.wait" && event.payload.pauseEventId === pauseEventId))) return;
    try {
      this.emit([this.event(binding.revision, "resource.wait", `${binding.attemptId}:pause-unproven:${pauseEventId}`, {
        attemptId: binding.attemptId, pauseEventId, reason, resource: "pause-interruption",
      }, binding.unitId, binding.attemptId)]);
    } catch { /* the pause backstop records a durable denial if this commit loses the version race */ }
  }

  private denyUnprovenPauseStops(pauseEvent: { eventId: string; payload: Record<string, unknown> }): void {
    if (this.retired || this.closed && !this.retirement) return;
    const stopped = Array.isArray(pauseEvent.payload.stoppedAttempts) ? pauseEvent.payload.stoppedAttempts as Array<Record<string, unknown>> : [];
    const inspection = this.store.inspectMission(this.missionId);
    for (const row of stopped) {
      const attemptId = String(row.attemptId ?? "");
      const attempt = reduceMissionEvents(inspection).attempts[attemptId];
      if (!attempt) continue;
      if (inspection.events.some((event) => event.attemptId === attemptId && (
        event.kind === "attempt.settled" && event.payload.status === "interrupted" &&
          linkedPauseId(event.payload) === pauseEvent.eventId ||
        event.kind === "resource.wait" && event.payload.pauseEventId === pauseEvent.eventId))) continue;
      const receipt = inspection.events.find((event) => event.kind === "attempt.receipt" && event.attemptId === attemptId);
      if (receipt?.payload.status === "completed") continue;
      this.recordPauseDenial(pauseEvent.eventId, attempt.binding,
        receipt ? "pause interruption unproven: terminal receipt was not bound to the committed host pause"
          : "pause interruption unproven: missing receipt");
    }
  }

  private async sealTerminalOutput(binding: MissionAttemptBinding, runtime: ManagedAttemptRuntime, result: AgentRunResult): Promise<void> {
    try {
      if (disposedPiResults.get(result) !== hashJson(result)) throw new Error("terminal SDK disposal is unproven");
      runtime.effects.fence();
      await runtime.effects.shutdown();
      const inspection = this.store.inspectMission(this.missionId);
      if (inspection.revision !== binding.revision || this.store.ownerEpoch !== binding.ownerEpoch || !runtime.effects.quiescent ||
        missionHasUnresolvedEffects(this.store, inspection.events, binding.attemptId) ||
        !missionEffectProcessesQuiescent(inspection.events, binding.attemptId)) throw new Error("terminal effects or owner are unresolved");
      restoreWorkspaceImage(runtime.workspace, []);
      const base = inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" && event.attemptId === binding.attemptId && event.payload.phase === "base");
      const start = inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" && event.attemptId === binding.attemptId && event.payload.purpose === "execution-start");
      if (!base || !start || start.payload.bindingHash !== hashJson(binding)) throw new Error("execution start or source base is missing");
      const capturedTerminal = captureWorkspaceImage(runtime.workspace.candidateRoot);
      const image = { ...capturedTerminal, manifest: canonicalDeliveryManifest(capturedTerminal.manifest, runtime.workspace.manifest) };
      const sourceBase = readSealedWorkspaceImage(this.store, String(base.payload.imageHash));
      assertCompleteWorkspaceImage(sourceBase);
      assertCompleteWorkspaceImage(image, captureWorkspacePaths(runtime.workspace.candidateRoot, true));
      const authorized = new Set(filterWorkspaceImage(image, runtime.workspace.allowedPaths).files.map(({ path }) => path));
      for (const name of mergeWorkspaceImages(sourceBase, image, sourceBase).changedPaths)
        if (!authorized.has(name) && !filterWorkspaceImage(sourceBase, runtime.workspace.allowedPaths).files.some((file) => file.path === name))
          throw new Error(`terminal contribution exceeds allowed paths: ${name}`);
      const sealed = sealWorkspaceImage(image);
      if (captureWorkspaceImage(runtime.workspace.candidateRoot).manifest.hash !== capturedTerminal.manifest.hash) throw new Error("terminal writer changed image during seal");
      const proof = {
        format: "mission-terminal-output-v1", missionId: this.missionId, revision: binding.revision,
        attemptId: binding.attemptId, instanceId: result.instanceId, sessionId: binding.attemptId, bindingHash: hashJson(binding),
        sourceBaseImageHash: base.payload.imageHash, executionStartImageHash: start.payload.imageHash,
        ...(binding.finalization ? { finalization: binding.finalization } : { contributionInput: readContributionInput(this.store, inspection, binding) }),
        terminalImageHash: sealed.imageHash, inputManifestHash: binding.inputManifestHash,
        checkpointHash: binding.checkpointHash ?? null, continuationOf: binding.continuationOf ?? null,
        recoveryOf: binding.recoveryOf ?? null, recoveryImageHash: binding.recoveryImageHash ?? null,
        resultHash: sha256(Buffer.from(result.result)), sdkDisposed: true, effectsQuiescent: true, writersQuiescent: true,
        effectCutSeq: inspection.latestSeq,
        effectWitnesses: inspection.events.filter((event) => event.attemptId === binding.attemptId && event.effectId).map((event) =>
          ({ eventId: event.eventId, seq: event.seq, kind: event.kind, payloadHash: hashJson(event.payload) })),
      };
      const bytes = Buffer.from(JSON.stringify(proof));
      const artifactBytes = sealed.artifacts.reduce((total, artifact) => total + artifact.bytes.byteLength, bytes.byteLength);
      this.store.appendTransition(this.missionId, inspection.version, { events: [this.event(binding.revision, "workspace.snapshot.sealed",
        `${binding.attemptId}:terminal-output`, { attemptId: binding.attemptId, phase: "observed", purpose: "terminal-output",
          proofHash: sha256(bytes), imageHash: sealed.imageHash, manifestHash: image.manifest.hash, artifactBytes }, binding.unitId, binding.attemptId)],
        artifacts: [...sealed.artifacts, { bytes, mediaType: "application/json" }] });
    } catch (error) {
      // Ordinary progress remains inspectable; absence of a seal cannot authorize integrated delivery.
      if (!this.retired) this.emit([this.event(binding.revision, binding.finalization ? "mission.finalization.output.inconclusive" : "unit.verifying", `${binding.attemptId}:output-inconclusive`,
        { unitId: binding.unitId, attemptId: binding.attemptId, reason: `output seal inconclusive: ${messageOf(error)}` }, binding.unitId, binding.attemptId)]);
    }
  }

  private persistAttemptReceipt(binding: MissionAttemptBinding, result: AgentRunResult): void {
    if (this.retired) return;
    const artifact = Buffer.from(result.result ?? "");
    const artifactHash = sha256(artifact);
    const payload = {
      attemptId: binding.attemptId,
      unitId: binding.unitId,
      status: result.status,
      resultHash: artifactHash,
      artifactHash,
      artifactMediaType: "text/plain; charset=utf-8",
      model: result.model,
      usage: result.usage ?? null,
      requests: result.requests ?? [],
      role: result.role,
      error: result.status === "failed" ? result.result : undefined,
      quiescent: binding.candidate === "read-only" && !this.attemptEffects.has(binding.attemptId),
      sdkDisposed: disposedPiResults.get(result) === hashJson(result),
      instanceId: result.instanceId,
      initialOutputArtifactBytes: this.store.inspectMission(this.missionId).events.filter((event) => event.kind === "workspace.snapshot.sealed" &&
        event.attemptId === binding.attemptId && (event.payload.phase === "base" || event.payload.purpose === "execution-start"))
        .reduce((sum, event) => sum + Number(event.payload.artifactBytes ?? 0), 0),
      terminalOutputArtifactBytes: Number(this.store.inspectMission(this.missionId).events.find((event) =>
        event.kind === "workspace.snapshot.sealed" && event.attemptId === binding.attemptId && event.payload.purpose === "terminal-output")?.payload.artifactBytes ?? 0),
      terminalOutputHash: this.store.inspectMission(this.missionId).events.find((event) =>
        event.kind === "workspace.snapshot.sealed" && event.attemptId === binding.attemptId && event.payload.purpose === "terminal-output")?.payload.proofHash ?? null,
    };
    const inspection = this.store.inspectMission(this.missionId);
    const receipt = this.event(binding.revision, "attempt.receipt", `${binding.attemptId}:receipt`, payload, binding.unitId, binding.attemptId);
    const events = [receipt];
    for (const dispatch of inspection.events.filter(({ kind, payload }) =>
      kind === "provider.request.dispatched" && payload.attemptId === binding.attemptId)) {
      const requestId = String(dispatch.payload.requestId);
      if (inspection.events.some((event) => event.kind === "provider.request.receipt" && event.payload.requestId === requestId)) continue;
      const reservationId = String(dispatch.payload.tokenReservationId);
      const reservation = inspection.reservations.find(({ id }) => id === reservationId);
      if (!reservation) throw new Error(`provider request token grant is missing for ${requestId}`);
      const unknown = reservation.grantAmount - reservation.knownCharge - reservation.unknownCharge - reservation.released;
      if (unknown > 0) events.push(this.reservationSettlement(binding.revision, reservation, {
        knownCharge: reservation.knownCharge,
        unknownCharge: reservation.unknownCharge + unknown,
        released: reservation.released,
        source: "runner completed without canonical provider usage",
        unknownReason: "provider usage hook did not produce a durable receipt",
      }, `${requestId}:usage-unknown`, binding.unitId, binding.attemptId));
    }
    for (const request of result.requests ?? []) {
      const requestId = request.requestId;
      if (!requestId) continue;
      const canonical = inspection.events.find((event) =>
        event.kind === "provider.request.receipt" && event.payload.requestId === requestId);
      const claim = {
        source: "runner-result",
        requestId,
        provider: request.provider,
        model: request.model,
        inputTokens: request.inputTokens ?? null,
        outputTokens: request.outputTokens ?? null,
        canonicalReceiptEventId: canonical?.eventId ?? null,
        matchesCanonical: canonical
          ? canonical.payload.provider === request.provider &&
            (String(canonical.payload.model).split("/").at(-1) ?? canonical.payload.model) === (request.model.split("/").at(-1) ?? request.model) &&
            canonical.payload.inputTokens === (request.inputTokens ?? null) &&
            canonical.payload.outputTokens === (request.outputTokens ?? null)
          : null,
      };
      events.push(this.event(binding.revision, "provider.usage.claimed",
        `provider-usage-claim:runner:${requestId}:${hashJson(claim)}`, claim, binding.unitId, binding.attemptId));
    }
    this.store.appendTransition(this.missionId, inspection.version, {
      events,
      artifacts: [{ bytes: artifact, mediaType: "text/plain; charset=utf-8" }],
    });
  }

  private async checkpointSingletonRequest(binding: MissionAttemptBinding, runtime: ManagedAttemptRuntime, result: AgentRunResult): Promise<void> {
    const requestHash = sha256(Buffer.from(result.result));
    const receipt = this.store.inspectMission(this.missionId).events.find((event) => event.kind === "attempt.receipt" &&
      event.attemptId === binding.attemptId);
    let reason = "singleton consultation remains denied until a child and fresh continuation are proven";
    let checkpoint: { event: MissionEventDraft; artifacts: Array<{ bytes: Uint8Array; mediaType: string }>; size: number } | undefined;
    try {
      // A callback, an arbitrary runner, or an empty controller set cannot attest SDK disposal.
      if (disposedPiResults.get(result) !== hashJson(result)) throw new Error("terminal SDK disposal is unproven");
      runtime.effects.fence();
      await runtime.effects.shutdown();
      if (!runtime.effects.quiescent) throw new Error("managed effects remain active after shutdown");
      if (result.status !== "completed" || !receipt || receipt.payload.status !== "completed" ||
        receipt.payload.artifactHash !== requestHash || receipt.payload.quiescent !== false ||
        receipt.revision !== binding.revision || receipt.unitId !== binding.unitId ||
        receipt.payload.role !== binding.role || result.role !== binding.role)
        throw new Error("terminal request and persisted receipt do not match");
      const inspection = this.store.inspectMission(this.missionId);
      const state = reduceMissionEvents(inspection);
      if (this.closed || this.retired || this.store.ownerEpoch !== binding.ownerEpoch || inspection.revision !== binding.revision ||
        !["running", "blocked"].includes(state.state) || state.units[binding.unitId]?.status !== "running" ||
        pendingQuestionUnits(inspection.events, inspection.definition, this.store).has(binding.unitId) ||
        state.attempts[binding.attemptId]?.settled ||
        inspection.events.some((event) => event.kind === "workspace.snapshot.sealed" && event.attemptId === binding.attemptId &&
          event.payload.purpose === "consultation")) throw new Error("checkpoint owner, revision or attempt changed");
      const unit = inspection.definition.units.find(({ id }) => id === binding.unitId);
      if (!unit || unit.team || unit.role !== "developer" || binding.candidate !== "managed" ||
        binding.roundId !== "main" || binding.memberId !== "solo" || binding.rolePolicyHash !== inspection.definition.authority.rolePolicies.developer?.hash)
        throw new Error("request is not a bound singleton Developer attempt");
      parseConsultationRequest(Buffer.from(result.result), {
        format: "mission-team-bundle-v1", unitId: unit.id, phase: "execution", round: "independent",
        memberId: "solo", perspective: "solo", goal: inspection.definition.goal, inputs: unit.inputs,
      }, inspection.definition.authority.rolePolicies);
      const reserved = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === binding.attemptId);
      const registered = inspection.events.find((event) => event.kind === "workspace.candidate.registered" && event.attemptId === binding.attemptId);
      const base = inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
        event.attemptId === binding.attemptId && event.payload.phase === "base");
      if (!reserved || hashJson(reserved.payload.binding) !== hashJson(binding) || !registered || !base ||
        hashJson(registered.payload) !== hashJson({ ...binding.candidateRegistration, locationHistory: [binding.candidateRoot] }) ||
        registered.payload.sourceManifestHash !== binding.workspaceManifestHash ||
        base.payload.manifestHash !== binding.workspaceManifestHash ||
        readSealedWorkspaceImage(this.store, String(base.payload.imageHash)).manifest.hash !== binding.workspaceManifestHash)
        throw new Error("candidate registration or base image does not match source attempt");
      const effectRows = inspection.events.filter((event) => event.attemptId === binding.attemptId &&
        (event.kind.startsWith("effect.") || event.kind === "workspace.snapshot.sealed" && event.payload.effectId));
      const effectIds = [...new Set(effectRows.map((event) => event.effectId).filter((id): id is string => !!id))];
      if (effectRows.some((event) => !event.effectId) || effectRows.some((event) =>
        event.kind === "effect.unknown" || event.kind === "effect.observation.recorded" && event.payload.disposition === "unknown" ||
        event.kind === "effect.reconciled" && event.payload.disposition === "unknown" ||
        event.kind === "effect.intent" && (String(event.payload.operation).startsWith("external:") ||
          event.payload.recovery === "external-probe-required")) ||
        missionHasUnresolvedEffects(this.store, inspection.events, binding.attemptId))
        throw new Error("source effect disposition is active or uncertain");
      // restoreWorkspaceImage checks the physical candidate identity before any host capture; an empty image changes no bytes.
      restoreWorkspaceImage(runtime.workspace, []);
      if (captureWorkspaceImage(this.managedWorkspace!.sourceRoot).manifest.hash !== binding.workspaceManifestHash)
        throw new Error("source manifest changed before checkpoint");
      const capturedImage = captureWorkspaceImage(runtime.workspace.candidateRoot);
      const image = inspection.definition.finalization.contractVersion === 1
        ? { ...capturedImage, manifest: canonicalDeliveryManifest(capturedImage.manifest, runtime.workspace.manifest) }
        : filterWorkspaceImage(capturedImage, runtime.workspace.allowedPaths);
      if (inspection.definition.finalization.contractVersion === 1) assertCompleteWorkspaceImage(image, captureWorkspacePaths(runtime.workspace.candidateRoot, true));
      const sealed = sealWorkspaceImage(image);
      if (captureWorkspaceImage(runtime.workspace.candidateRoot).manifest.hash !== capturedImage.manifest.hash)
        throw new Error("candidate changed while sealing terminal image");
      const proof = {
        format: "mission-consultation-checkpoint-v1", missionId: this.missionId, revision: binding.revision,
        unitId: unit.id, roundId: "main", memberId: "solo", sourceAttemptId: binding.attemptId,
        sourceBindingHash: hashJson(binding), sourceReservationEventId: reserved.eventId,
        receiptEventId: receipt.eventId, receiptHash: hashJson(receipt.payload), requestHash,
        candidateRegistrationEventId: registered.eventId, candidateRegistrationHash: hashJson(registered.payload),
        baseEventId: base.eventId, baseImageHash: base.payload.imageHash, imageHash: sealed.imageHash,
        candidateManifestHash: image.manifest.hash, sourceManifestHash: binding.workspaceManifestHash,
        inputManifestHash: binding.inputManifestHash,
        rolePolicyHash: binding.rolePolicyHash, ownerEpoch: binding.ownerEpoch,
        effectCutSeq: inspection.latestSeq,
        effects: effectIds.map((effectId) => ({ effectId, disposition: "operationally-resolved",
          witnesses: effectRows.filter((event) => event.effectId === effectId).map((event) => ({
            eventId: event.eventId, seq: event.seq, kind: event.kind, payloadHash: hashJson(event.payload),
          })) })),
        sdkDisposed: true, effectsShutdown: true,
      };
      const proofBytes = Buffer.from(JSON.stringify(proof));
      const proofHash = sha256(proofBytes);
      const size = sealed.artifacts.reduce((total, artifact) => total + artifact.bytes.byteLength, proofBytes.byteLength);
      const allowance = inspection.reservations.find(({ id }) => id === stableId(`${binding.attemptId}:artifact`));
      if (!allowance || requestHash !== receipt.payload.resultHash || size + Buffer.byteLength(result.result) > allowance.grantAmount)
        throw new Error("terminal checkpoint exceeds artifact allowance");
      if (this.store.ownerEpoch !== binding.ownerEpoch || this.store.inspectMission(this.missionId).version !== inspection.version ||
        this.store.inspectMission(this.missionId).revision !== binding.revision)
        throw new Error("checkpoint owner or version changed before commit");
      checkpoint = { size, artifacts: [...sealed.artifacts, { bytes: proofBytes, mediaType: "application/json" }],
        event: this.event(binding.revision, "workspace.snapshot.sealed", `${binding.attemptId}:consultation-checkpoint`, {
          attemptId: binding.attemptId, phase: "observed", purpose: "consultation", imageHash: sealed.imageHash,
          manifestHash: image.manifest.hash, checkpointHash: proofHash, receiptEventId: receipt.eventId,
          candidateId: binding.candidateId, ownerEpoch: binding.ownerEpoch, effectCutSeq: inspection.latestSeq,
        }, unit.id, binding.attemptId) };
      this.store.appendTransition(this.missionId, inspection.version, { events: [checkpoint.event], artifacts: checkpoint.artifacts });
      this.liveSingletonCheckpoints.set(binding.attemptId, proofHash);
      this.admitSingletonConsultation(binding, checkpoint.size);
      return;
    } catch (error) { reason = checkpoint ? `singleton consultation denied: ${messageOf(error)}` :
      `singleton checkpoint unproven: ${messageOf(error)}`; }
    const latest = this.store.inspectMission(this.missionId);
    if (this.store.ownerEpoch !== binding.ownerEpoch || latest.revision !== binding.revision || this.closed || this.retired) return;
    if (!latest.events.some((event) => event.kind === "team.consultation.denied" && event.attemptId === binding.attemptId))
      this.store.appendTransition(this.missionId, latest.version, { events: [this.event(binding.revision,
        "team.consultation.denied", `${binding.attemptId}:consultation-denied`, {
          parentAttemptId: binding.attemptId,
          requestId: stableId(`${this.missionId}:consultation:${binding.unitId}:${binding.unitId}:main:solo`),
          requestHash, receiptHash: receipt ? hashJson(receipt.payload) : null,
          ...(checkpoint ? { checkpointHash: checkpoint.event.payload.checkpointHash, checkpointBytes: checkpoint.size } : {}), reason,
        }, binding.unitId, binding.attemptId)] });
  }

  private revalidateSingletonCheckpoints(): void {
    if (!this.managedWorkspace || this.closed || this.retired || this.store.ownerEpoch === null) return;
    const acquisition = this.store.ownerAcquisitionProof;
    const previous = acquisition?.previous as { epoch?: number; owner?: ProcessIdentity } | undefined;
    if (!previous || !["owner-death", "retirement"].includes(String(acquisition?.source)) ||
      acquisition?.epoch !== this.store.ownerEpoch) return;
    if (acquisition?.source === "owner-death") {
      try { if (!previous.owner || ownerProcessState(previous.owner) !== "dead") return; }
      catch { return; }
    }
    if (acquisition?.source === "retirement") {
      const release = this.store.inspectMission(this.missionId).events.find((event) =>
        event.kind === "mission.owner.released" && event.eventId === acquisition.retirementEventId &&
        event.payload.effectsQuiescent === true &&
        hashJson(event.payload.owner) === hashJson(previous.owner));
      if (!release) return;
    }
    for (const seal of this.store.inspectMission(this.missionId).events.filter((event) =>
      event.kind === "workspace.snapshot.sealed" && event.payload.purpose === "consultation")) {
      const inspection = this.store.inspectMission(this.missionId);
      const attemptId = String(seal.attemptId);
      const binding = reduceMissionEvents(inspection).attempts[attemptId]?.binding;
      if (!binding || binding.revision !== inspection.revision ||
        ["paused", "cancelled", "completed"].includes(reduceMissionEvents(inspection).state) ||
        inspection.events.some((event) => event.kind === "team.consultation.cancelled" && event.unitId === binding.unitId) ||
        inspection.events.some((event) => event.kind === "team.consultation.denied" && event.attemptId === attemptId)) continue;
      const predecessorUse = [...inspection.events].reverse().find((event) => event.kind === "team.consultation.revalidated" &&
        event.attemptId === attemptId && event.payload.ownerEpoch === previous.epoch);
      try {
        if (predecessorUse && predecessorUse.payload.checkpointHash !== seal.payload.checkpointHash)
          throw new Error("predecessor checkpoint use names another seal");
        if (binding.ownerEpoch !== previous.epoch && !predecessorUse) {
          // A directly intervening owner may die before using a valid seal. The
          // source process and immediate predecessor must both be proven dead.
          if (binding.ownerEpoch !== previous.epoch! - 1 ||
            !binding.candidateRegistration?.owner ||
            ownerProcessState(binding.candidateRegistration.owner) !== "dead")
            throw new Error("predecessor checkpoint-use chain or source owner-death proof is unavailable");
        }
        if (predecessorUse) {
          const bytes = this.store.readArtifact(String(predecessorUse.payload.useHash));
          const prior = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
          const rows = inspection.events.filter((event) => event.seq <= Number(prior.watermark) && event.attemptId === attemptId &&
            (event.kind.startsWith("effect.") || event.kind === "workspace.snapshot.sealed" && event.payload.effectId));
          if (sha256(bytes) !== predecessorUse.payload.useHash ||
            prior.format !== "mission-singleton-checkpoint-use-v1" ||
            prior.checkpointHash !== seal.payload.checkpointHash || prior.sourceAttemptId !== attemptId ||
            prior.revision !== inspection.revision || prior.ownerEpoch !== previous.epoch ||
            prior.acquisitionProofHash !== predecessorUse.payload.acquisitionProofHash ||
            !Number.isSafeInteger(prior.watermark) || Number(prior.watermark) >= predecessorUse.seq ||
            prior.effectWitnessHash !== hashJson(rows.map((event) => [event.eventId, event.seq, event.kind, hashJson(event.payload)])))
            throw new Error("predecessor checkpoint use or classified effect witness is unproven");
        }
        const checkpointHash = String(seal.payload.checkpointHash);
        if (inspection.events.some((event) => event.kind === "team.consultation.revalidated" &&
          event.attemptId === attemptId && event.payload.ownerEpoch === this.store.ownerEpoch)) {
          this.singletonCheckpoint(inspection, attemptId, checkpointHash);
          continue;
        }
        const { proof, image, unit } = this.singletonCheckpoint(inspection, attemptId, checkpointHash, false);
        const disposition = inspection.events.find((event) => event.kind === "team.consultation.admitted" &&
          event.payload.parentAttemptId === attemptId);
        const state = reduceMissionEvents(inspection);
        if (disposition ? state.attempts[attemptId]?.status !== "yielded" :
          state.attempts[attemptId]?.settled || state.units[unit.id]?.status !== "running") continue;
        const effectWitnessHash = hashJson(inspection.events.filter((event) => event.attemptId === attemptId &&
          (event.kind.startsWith("effect.") || event.kind === "workspace.snapshot.sealed" && event.payload.effectId))
          .map((event) => [event.eventId, event.seq, event.kind, hashJson(event.payload)]));
        const use = {
          format: "mission-singleton-checkpoint-use-v1", checkpointHash, sourceAttemptId: attemptId,
          revision: inspection.revision, ownerEpoch: this.store.ownerEpoch,
          acquisitionProofHash: hashJson(acquisition), watermark: inspection.latestSeq, effectWitnessHash,
        };
        const bytes = Buffer.from(JSON.stringify(use));
        if (proof.receiptEventId !== seal.payload.receiptEventId || this.store.ownerEpoch !== acquisition.epoch ||
          this.store.inspectMission(this.missionId).version !== inspection.version) continue;
        this.store.appendTransition(this.missionId, inspection.version, {
          artifacts: [{ bytes, mediaType: "application/json" }],
          events: [this.event(inspection.revision, "team.consultation.revalidated",
            `${attemptId}:checkpoint-use:${this.store.ownerEpoch}`, {
              checkpointHash, sourceAttemptId: attemptId, ownerEpoch: this.store.ownerEpoch,
              acquisitionProofHash: use.acquisitionProofHash, useHash: sha256(bytes),
              watermark: use.watermark, effectWitnessHash,
            }, unit.id, attemptId)],
        });
        if (!disposition) {
          const imageArtifacts = sealWorkspaceImage(image);
          if (imageArtifacts.imageHash !== proof.imageHash) throw new Error("checkpoint image bytes changed");
          const checkpointBytes = imageArtifacts.artifacts.reduce((total, artifact) => total + artifact.bytes.byteLength,
            this.store.readArtifact(checkpointHash).byteLength);
          this.admitSingletonConsultation(binding, checkpointBytes);
        }
      } catch (error) {
        const current = this.store.inspectMission(this.missionId);
        if (current.revision === binding.revision &&
          !current.events.some((event) => event.kind === "unit.blocked" && event.unitId === binding.unitId))
          this.emit([this.event(current.revision, "unit.blocked", `${attemptId}:checkpoint-revalidation-blocked`, {
            unitId: binding.unitId, reason: `singleton checkpoint revalidation blocked: ${messageOf(error)}`,
          }, binding.unitId)]);
      }
    }
  }

  private singletonCheckpoint(inspection: ReturnType<MissionStore["inspectMission"]>, attemptId: string, checkpointHash: string,
    verifyCurrentUse = true) {
    if (this.closed || this.retired || this.store.ownerEpoch === null || !this.managedWorkspace)
      throw new Error("checkpoint lacks a current owner");
    const binding = reduceMissionEvents(inspection).attempts[attemptId]?.binding;
    const receipt = inspection.events.find((event) => event.kind === "attempt.receipt" && event.attemptId === attemptId);
    const reserved = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === attemptId);
    const registered = inspection.events.find((event) => event.kind === "workspace.candidate.registered" && event.attemptId === attemptId);
    const base = inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
      event.attemptId === attemptId && event.payload.phase === "base");
    const seal = inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
      event.attemptId === attemptId && event.payload.purpose === "consultation");
    const bytes = this.store.readArtifact(checkpointHash);
    if (sha256(bytes) !== checkpointHash) throw new Error("checkpoint artifact hash changed");
    const proof = JSON.parse(bytes.toString("utf8")) as {
      format: string; missionId: string; revision: number; unitId: string; sourceAttemptId: string;
      sourceBindingHash: string; sourceReservationEventId: string; receiptEventId: string; receiptHash: string;
      requestHash: string; candidateRegistrationEventId: string; candidateRegistrationHash: string;
      baseEventId: string; baseImageHash: string; imageHash: string; candidateManifestHash: string;
      sourceManifestHash: string; inputManifestHash: string; rolePolicyHash: string; ownerEpoch: number;
      effectCutSeq: number; effects: Array<{ effectId: string; witnesses: Array<{ eventId: string; seq: number; kind: string; payloadHash: string }> }>;
      sdkDisposed: boolean; effectsShutdown: boolean;
    };
    const unit = inspection.definition.units.find(({ id }) => id === binding?.unitId);
    const state = reduceMissionEvents(inspection);
    const dependencyHash = unit && binding && hashJson({
      baseInputManifestHash: hashJson({ revision: inspection.revision, unit: unit.id, inputs: unit.inputs,
        dependencies: unit.dependencies.map((id) => ({ id, evidence: state.units[id]?.evidenceIds ?? [] })) }),
      workspaceManifestHash: binding.workspaceManifestHash,
    });
    if (!binding || !unit || unit.team || unit.role !== "developer" || binding.candidate !== "managed" ||
      binding.roundId !== "main" || binding.memberId !== "solo" ||
      binding.revision !== inspection.revision || binding.rolePolicyHash !== inspection.definition.authority.rolePolicies.developer?.hash ||
      proof.format !== "mission-consultation-checkpoint-v1" || proof.missionId !== this.missionId ||
      proof.revision !== inspection.revision || proof.unitId !== unit.id || proof.sourceAttemptId !== attemptId ||
      proof.ownerEpoch !== binding.ownerEpoch || proof.sourceBindingHash !== hashJson(binding) ||
      proof.sourceReservationEventId !== reserved?.eventId || proof.receiptEventId !== receipt?.eventId ||
      proof.receiptHash !== hashJson(receipt?.payload) || proof.requestHash !== receipt?.payload.artifactHash ||
      proof.candidateRegistrationEventId !== registered?.eventId || proof.candidateRegistrationHash !== hashJson(registered?.payload) ||
      proof.baseEventId !== base?.eventId || proof.baseImageHash !== base?.payload.imageHash ||
      proof.imageHash !== seal?.payload.imageHash || seal.payload.checkpointHash !== checkpointHash ||
      seal.payload.receiptEventId !== receipt?.eventId || proof.sourceManifestHash !== binding.workspaceManifestHash ||
      proof.inputManifestHash !== binding.inputManifestHash || proof.inputManifestHash !== dependencyHash ||
      !unit.dependencies.every((id) => state.units[id]?.status === "accepted") ||
      proof.rolePolicyHash !== binding.rolePolicyHash ||
      proof.sdkDisposed !== true || proof.effectsShutdown !== true || receipt?.payload.status !== "completed" ||
      receipt.payload.quiescent !== false || receipt.payload.role !== binding.role ||
      receipt.payload.artifactHash !== proof.requestHash || receipt.payload.resultHash !== proof.requestHash ||
      receipt.unitId !== unit.id || receipt.revision !== binding.revision ||
      receipt.seq >= (seal?.seq ?? 0) || proof.effectCutSeq >= (seal?.seq ?? 0) ||
      sha256(this.store.readArtifact(proof.requestHash)) !== proof.requestHash ||
      proof.candidateManifestHash !== seal.payload.manifestHash ||
      hashJson(registered?.payload) !== hashJson({ ...binding.candidateRegistration, locationHistory: [binding.candidateRoot] }) ||
      registered?.payload.candidateId !== binding.candidateId ||
      base?.payload.manifestHash !== binding.workspaceManifestHash ||
      captureWorkspaceImage(this.managedWorkspace.sourceRoot).manifest.hash !== binding.workspaceManifestHash)
      throw new Error("checkpoint source, receipt, policy or owner changed");
    const effectRows = inspection.events.filter((event) => event.attemptId === attemptId &&
      (event.kind.startsWith("effect.") || event.kind === "workspace.snapshot.sealed" && event.payload.effectId));
    const expected = effectRows.map((event) => ({
      effectId: event.effectId, eventId: event.eventId, seq: event.seq, kind: event.kind, payloadHash: hashJson(event.payload),
    })).sort((a, b) => a.seq - b.seq);
    const witnesses = proof.effects?.flatMap(({ effectId, witnesses }) => witnesses.map((row) => ({ effectId, ...row })));
    const prefix = expected.filter((row) => row.seq <= proof.effectCutSeq);
    const effectIds = new Set(proof.effects?.map(({ effectId }) => effectId));
    const suffix = effectRows.filter((event) => event.seq > proof.effectCutSeq);
    let failedPredicate: string | undefined;
    const processes: Record<string, unknown>[] = [];
    const rejected = (name: string, failed: boolean) => {
      if (failed) failedPredicate = name;
      return failed;
    };
    if (rejected("witness-groups", !Array.isArray(witnesses) || !Array.isArray(proof.effects) || effectIds.size !== proof.effects.length) ||
      rejected("witness-prefix", JSON.stringify(witnesses.sort((a, b) => a.seq - b.seq)) !== JSON.stringify(prefix)) ||
      rejected("recovery-suffix", suffix.some((event) => !event.effectId || !effectIds.has(String(event.effectId)) ||
        event.kind !== "effect.reconciled" || event.payload.observedBy !== "mission-recovery" ||
        !(event.payload.disposition === "applied" || event.payload.disposition === "unstarted" &&
          !effectRows.some((row) => row.effectId === event.effectId && row.seq <= proof.effectCutSeq &&
            (row.kind === "effect.released" || row.kind === "effect.receipt" && row.payload.status !== "denied"))))) ||
      rejected("unresolved-effects", missionHasUnresolvedEffects(this.store, inspection.events, attemptId)) ||
      rejected("process-quiescence", !missionEffectProcessesQuiescent(inspection.events, attemptId, processes))) {
      try { this.captureRejection?.({ boundary: "singleton-checkpoint", missionId: this.missionId, attemptId,
        checkpointHash, failedPredicate, proof, effectRows, processes }); } catch { /* capture cannot change admission */ }
      throw new Error("checkpoint effect history changed or is unresolved");
    }
    if (verifyCurrentUse && (this.liveSingletonCheckpoints.get(attemptId) !== checkpointHash || binding.ownerEpoch !== this.store.ownerEpoch)) {
      const use = [...inspection.events].reverse().find((event) => event.kind === "team.consultation.revalidated" &&
        event.attemptId === attemptId && event.payload.ownerEpoch === this.store.ownerEpoch);
      const acquisition = this.store.ownerAcquisitionProof;
      if (!use || use.payload.checkpointHash !== checkpointHash || !acquisition ||
        use.payload.acquisitionProofHash !== hashJson(acquisition))
        throw new Error("checkpoint lacks current-owner verification");
      const useBytes = this.store.readArtifact(String(use.payload.useHash));
      if (sha256(useBytes) !== use.payload.useHash ||
        hashJson(JSON.parse(useBytes.toString("utf8"))) !== hashJson({
          format: "mission-singleton-checkpoint-use-v1", checkpointHash, sourceAttemptId: attemptId,
          revision: inspection.revision, ownerEpoch: this.store.ownerEpoch,
          acquisitionProofHash: hashJson(acquisition), watermark: use.payload.watermark,
          effectWitnessHash: use.payload.effectWitnessHash,
        })) throw new Error("checkpoint use record changed");
    }
    const image = readSealedWorkspaceImage(this.store, proof.imageHash);
    if (image.manifest.hash !== proof.candidateManifestHash ||
      readSealedWorkspaceImage(this.store, proof.baseImageHash).manifest.hash !== proof.sourceManifestHash)
      throw new Error("checkpoint image or baseline changed");
    return { proof, image, binding, receipt, unit };
  }

  private admitSingletonConsultation(binding: MissionAttemptBinding, checkpointBytes: number): void {
    const inspection = this.store.inspectMission(this.missionId);
    const seal = inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
      event.attemptId === binding.attemptId && event.payload.purpose === "consultation");
    const checkpointHash = String(seal?.payload.checkpointHash ?? "");
    const { proof, image, receipt, unit } = this.singletonCheckpoint(inspection, binding.attemptId, checkpointHash);
    const state = reduceMissionEvents(inspection);
    if (!this.attemptAdmitted(binding, inspection, undefined, true) || state.attempts[binding.attemptId]?.settled ||
      inspection.events.some((event) => ["team.consultation.admitted", "team.consultation.denied"].includes(event.kind) &&
        event.payload.parentAttemptId === binding.attemptId)) throw new Error("singleton slot already disposed or fenced");
    const requestBytes = this.store.readArtifact(proof.requestHash);
    if (sha256(requestBytes) !== proof.requestHash) throw new Error("consultation request bytes changed");
    const request = parseConsultationRequest(requestBytes, {
      format: "mission-team-bundle-v1", unitId: unit.id, phase: "execution", round: "independent",
      memberId: "solo", perspective: "solo", goal: inspection.definition.goal, inputs: unit.inputs,
    }, inspection.definition.authority.rolePolicies);
    if (binding.ownerEpoch === this.store.ownerEpoch || existsSync(String(binding.candidateRoot))) {
      const candidate = verifyPrivateCandidate(String(binding.candidateRoot), this.managedWorkspace!.sourceRoot);
      const observed = captureWorkspaceImage(candidate.root).manifest;
      if (candidate.identity !== binding.candidateRegistration?.rootIdentity ||
        candidate.gitIdentity !== binding.candidateRegistration?.gitIdentity ||
        (inspection.definition.finalization.contractVersion === 1 ? canonicalDeliveryManifest(observed, image.manifest).hash : observed.hash) !== proof.candidateManifestHash)
        throw new Error("sealed writer candidate changed before admission");
    }
    const reservation = inspection.reservations.find(({ id }) => id === stableId(`${binding.attemptId}:artifact`));
    const charge = requestBytes.length + checkpointBytes;
    if (!reservation || charge > reservation.grantAmount) throw new Error("checkpoint exceeds original artifact grant");
    const requestId = stableId(`${this.missionId}:consultation:${unit.id}:${unit.id}:main:solo`);
    if (inspection.events.some((event) => ["team.consultation.admitted", "team.consultation.denied"].includes(event.kind) &&
      event.payload.requestId === requestId)) throw new Error("singleton logical slot already disposed a consultation");
    const targetId = stableId(`${requestId}:target`);
    const launches = request.members.length * 3 + 2;
    const perRequest = Math.max(1, Math.ceil(inspection.definition.budget.tokens / inspection.definition.budget.providerRequests));
    const perLaunch = inspection.definition.finalization.contractVersion === 1 ? compileFinalizationGrants(inspection.definition).active :
      Math.max(1, Math.ceil(inspection.definition.budget.activeTimeMs / inspection.definition.budget.roleLaunches));
    const perArtifact = inspection.definition.finalization.contractVersion === 1 ? compileFinalizationGrants(inspection.definition).artifacts :
      Math.max(1, Math.ceil(inspection.definition.budget.artifactBytes / inspection.definition.budget.roleLaunches));
    const minimum: Record<BudgetResource, number> = {
      "role-launches": launches, "provider-requests": launches, tokens: launches * perRequest,
      "active-time-ms": launches * perLaunch, "artifact-bytes": launches * perArtifact,
    };
    const budget = budgetMap(inspection.definition.budget);
    for (const resource of RESOURCE_KEYS) {
      const use = budgetAmounts(inspection.events, resource);
      const available = budget[resource] - use.ordinary - use.protected +
        (resource === "artifact-bytes" ? reservation.amount - charge : 0);
      const required = minimum[resource] + this.remainingRootSlots(inspection,
        resource === "provider-requests" || resource === "tokens" ? "request" : "launch") *
        (resource === "role-launches" || resource === "provider-requests" ? 1 :
          resource === "tokens" ? perRequest : resource === "active-time-ms" ? perLaunch : perArtifact);
      if (available < required) throw new Error(`consultation minimum ${resource} needs ${required}; ordinary allowance ${available}`);
    }
    const events: MissionEventDraft[] = [
      this.event(binding.revision, "attempt.settled", `${binding.attemptId}:settled`, {
        attemptId: binding.attemptId, status: "yielded", resultHash: proof.requestHash, requestId, childTargetId: targetId,
      }, unit.id, binding.attemptId),
      this.reservationSettlement(binding.revision, reservation, {
        knownCharge: charge, unknownCharge: reservation.unknownCharge,
        released: Math.max(0, reservation.grantAmount - charge - reservation.unknownCharge),
        source: "terminal singleton consultation and checkpoint",
      }, `${binding.attemptId}:artifacts-settled`, unit.id, binding.attemptId),
      ...RESOURCE_KEYS.map((resource) => reservationDraft(this.missionId, binding.revision,
        stableId(`${requestId}:minimum:${resource}`), resource, minimum[resource], "ordinary", this.wallNow())),
      this.event(binding.revision, "team.consultation.admitted", `${requestId}:admitted`, {
        requestId, targetId, parentTargetId: unit.id, parentAttemptId: binding.attemptId,
        unitId: unit.id, round: "main", memberId: "solo", depth: 1,
        requestHash: proof.requestHash, receiptHash: hashJson(receipt.payload),
        checkpointHash, checkpointEventId: seal!.eventId, sourceManifestHash: proof.sourceManifestHash,
        inputManifestHash: binding.inputManifestHash, rolePolicyHash: binding.rolePolicyHash,
        ownerEpoch: this.store.ownerEpoch, minimum, request,
      }, unit.id, binding.attemptId),
    ];
    if (this.store.ownerEpoch === null || this.store.inspectMission(this.missionId).version !== inspection.version)
      throw new Error("checkpoint admission changed before commit");
    this.store.appendTransition(this.missionId, inspection.version, { events });
  }

  private async reconcileReceipts(): Promise<void> {
    const inspection = this.store.inspectMission(this.missionId);
    const state = reduceMissionEvents(inspection);
    if (["paused", "cancelled", "completed"].includes(state.state)) return;
    for (const attempt of Object.values(state.attempts)) {
      if (!attempt.receipt) continue;
      if (attempt.binding.finalization) {
        if (!attempt.settled && !this.inFlight.has(attempt.binding.attemptId)) await this.settleFinalizationReceipt(attempt);
        continue;
      }
      const unit = inspection.definition.units.find((entry) => entry.id === attempt.binding.unitId);
      if (!unit) continue;
      const reserved = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === attempt.binding.attemptId);
      const receipt = inspection.events.find((event) => event.kind === "attempt.receipt" && event.attemptId === attempt.binding.attemptId);
      if (!attempt.settled && attempt.receipt.status !== "completed" && inspection.events.some((event) => event.kind === "mission.paused" &&
        (Array.isArray(event.payload.stoppedAttempts) && event.payload.stoppedAttempts.some((row: Record<string, unknown>) => row.attemptId === attempt.binding.attemptId) ||
          event.seq > (reserved?.seq ?? Infinity) && event.seq < (receipt?.seq ?? -1)))) {
        if (!inspection.events.some((event) => event.kind === "unit.blocked" && event.attemptId === attempt.binding.attemptId)) {
          const reason = "host pause stop has no proven interruption; receipt does not authorize replay";
          this.emit([this.event(inspection.revision, "unit.blocked", `${attempt.binding.attemptId}:pause-unresolved-unit`, {
            unitId: unit.id, attemptId: attempt.binding.attemptId, reason,
          }, unit.id, attempt.binding.attemptId), this.event(inspection.revision, "mission.blocked", `${attempt.binding.attemptId}:pause-unresolved`, { reason })]);
        }
        continue;
      }
      if (!unit.team && !attempt.settled &&
        isConsultationOutput(this.store.readArtifact(String(attempt.receipt.artifactHash)).toString("utf8"))) {
        // The live owner may still be draining effects and sealing the terminal checkpoint.
        if (this.inFlight.has(attempt.binding.attemptId) && this.store.ownerEpoch === attempt.binding.ownerEpoch &&
          !this.closed && !this.retired) continue;
        const denied = inspection.events.find((event) => event.kind === "team.consultation.denied" &&
          event.attemptId === attempt.binding.attemptId);
        const reason = String(denied?.payload.reason ?? "singleton checkpoint unproven: terminal host proof is unavailable");
        const reservation = inspection.reservations.find(({ id }) => id === stableId(`${attempt.binding.attemptId}:artifact`));
        const charge = this.store.readArtifact(String(attempt.receipt.artifactHash)).byteLength +
          Number(denied?.payload.checkpointBytes ?? 0);
        this.emit([...(denied ? [] : [this.event(attempt.binding.revision, "team.consultation.denied",
          `${attempt.binding.attemptId}:consultation-denied`, {
            parentAttemptId: attempt.binding.attemptId, requestHash: String(attempt.receipt.artifactHash),
            requestId: stableId(`${this.missionId}:consultation:${unit.id}:${unit.id}:main:solo`),
            receiptHash: hashJson(attempt.receipt), reason,
          }, unit.id, attempt.binding.attemptId)]),
          this.event(attempt.binding.revision, "attempt.settled", `${attempt.binding.attemptId}:settled`, {
          attemptId: attempt.binding.attemptId, status: "failed", resultHash: attempt.receipt.artifactHash, reason,
        }, unit.id, attempt.binding.attemptId), this.event(attempt.binding.revision, "unit.blocked",
          `${attempt.binding.attemptId}:consultation-denied-unit`, { unitId: unit.id, reason }, unit.id),
        ...(reservation ? [this.reservationSettlement(attempt.binding.revision, reservation, {
          knownCharge: Math.min(charge, reservation.grantAmount), unknownCharge: reservation.unknownCharge,
          released: Math.max(0, reservation.grantAmount - charge - reservation.unknownCharge),
          source: "denied singleton consultation and terminal checkpoint",
        }, `${attempt.binding.attemptId}:artifacts-settled`, unit.id, attempt.binding.attemptId)] : [])]);
        continue;
      }
      if (attempt.binding.teamBundleHash) {
        if (attempt.settled && (attempt.status === "yielded" || attempt.status === "interrupted")) continue;
        if (!inspection.events.some((event) => event.kind === "team.member.recorded" &&
          event.revision === attempt.binding.revision && event.attemptId === attempt.binding.attemptId &&
          event.payload.responseHash === attempt.receipt?.artifactHash && event.payload.bundleHash === attempt.binding.teamBundleHash &&
          (event.payload.targetId ?? unit.id) === (attempt.binding.targetId ?? unit.id) &&
          event.unitId === unit.id && event.payload.memberId === attempt.binding.memberId &&
          event.payload.round === attempt.binding.roundId)) await this.settleTeamReceipt(unit, attempt);
      } else if (!attempt.settled) await this.settleReceipt(unit, attempt);
    }
  }

  private async settleTeamReceipt(unit: MissionUnit, attempt: MissionAttemptProjection): Promise<void> {
    const binding = attempt.binding;
    const inspection = this.store.inspectMission(this.missionId);
    if (reduceMissionEvents(inspection).state === "paused") return;
    if (inspection.events.some((event) => event.kind === "team.consultation.cancelled" && event.unitId === unit.id)) {
      if (!attempt.settled) this.emit([this.event(binding.revision, "attempt.settled", `${binding.attemptId}:settled`, {
        attemptId: binding.attemptId, status: "cancelled", reason: "consultation branch cancelled",
      }, unit.id, binding.attemptId)]);
      return;
    }
    if (binding.revision !== inspection.revision) {
      if (!attempt.settled) this.emit([this.event(binding.revision, "attempt.settled", `${binding.attemptId}:settled`, {
        attemptId: binding.attemptId, status: "cancelled", reason: "superseded team response",
      }, unit.id, binding.attemptId)]);
      return;
    }
    if (!this.recoveryBindingCurrent(binding, inspection)) { this.fenceStaleRecoveryReceipt(inspection, attempt); return; }
    const responseHash = String(attempt.receipt?.artifactHash);
    const responseBytes = this.store.readArtifact(responseHash);
    if (isConsultationOutput(responseBytes.toString("utf8"))) {
      this.settleConsultation(unit, attempt, responseBytes);
      return;
    }
    let status: "valid" | "invalid" = "invalid";
    let reason = "role did not complete";
    try {
      const bytes = responseBytes;
      const bundleBytes = this.store.readArtifact(binding.teamBundleHash!);
      const bundle = JSON.parse(bundleBytes.toString("utf8")) as TeamBundle;
      if (sha256(bytes) !== responseHash || sha256(bundleBytes) !== binding.teamBundleHash ||
        binding.teamOutputContractHash !== hashJson({ version: 1, phase: bundle.phase, round: binding.roundId }))
        throw new Error("team input or output contract hash changed");
      const target = inspection.events.find((event) => event.kind === "team.consultation.admitted" &&
        event.payload.targetId === binding.targetId);
      const contract = target?.payload.request as ConsultationRequest | undefined;
      if (bundle.unitId !== unit.id || bundle.round !== binding.roundId ||
        bundle.memberId !== binding.memberId || bundle.phase !== (unit.team?.phase ?? "execution") ||
        (bundle.targetId ?? unit.id) !== (binding.targetId ?? unit.id) ||
        (binding.continuationOf && (bundle.childResultHash !== binding.childResultHash ||
          sha256(Buffer.from(bundle.childResult ?? "")) !== binding.childResultHash)) ||
        attempt.receipt?.status !== "completed" || attempt.receipt?.role !==
          (binding.memberId === "synthesis" ? contract?.synthesisRole ?? unit.team?.synthesisRole :
            (contract?.members ?? unit.team?.members)?.find(({ id }) => id === binding.memberId)?.role))
        throw new Error("team role, phase, round or member receipt does not match the bundle");
      parseTeamResponse(bytes, bundle);
      status = "valid";
    } catch (error) { reason = messageOf(error); }
    const child = (binding.targetId ?? unit.id) !== unit.id;
    if (binding.roundId === "synthesis" && status === "valid" && !attempt.settled && !child) {
      // Synthesis is advice; host predicate assessment remains the sole unit acceptance gate.
      await this.settleReceipt(unit, attempt);
    }
    const fresh = this.store.inspectMission(this.missionId);
    if (reduceMissionEvents(fresh).state === "paused") return;
    if (!this.recoveryBindingCurrent(binding, fresh)) { this.fenceStaleRecoveryReceipt(fresh, attempt); return; }
    const unitStatus = reduceMissionEvents(fresh).units[unit.id]?.status;
    if (!child && binding.roundId === "synthesis" && status === "valid" &&
      !reduceMissionEvents(fresh).attempts[binding.attemptId]?.settled) return;
    const events: MissionEventDraft[] = [];
    if (!attempt.settled && (binding.roundId !== "synthesis" || status === "invalid" || child)) {
      events.push(this.event(binding.revision, "attempt.settled", `${binding.attemptId}:settled`, {
        attemptId: binding.attemptId, status: status === "valid" ? "succeeded" : "failed", resultHash: responseHash,
      }, unit.id, binding.attemptId));
    }
    events.push(this.event(binding.revision, "team.member.recorded", `${binding.attemptId}:team-member`, {
      unitId: unit.id, targetId: binding.targetId ?? unit.id, round: binding.roundId, memberId: binding.memberId,
      status, responseHash, bundleHash: binding.teamBundleHash, receiptHash: hashJson(attempt.receipt),
      ...(status === "invalid" ? { reason } : {}),
    }, unit.id, binding.attemptId));
    if (binding.roundId === "synthesis" && status === "valid") events.push(this.event(binding.revision,
      "team.barrier.recorded", `${binding.targetId ?? unit.id}:${binding.revision}:synthesis:barrier`, {
        unitId: unit.id, targetId: binding.targetId ?? unit.id,
        round: "synthesis", status: child || unitStatus === "accepted" ? "complete" : "incomplete",
        members: [{ id: binding.memberId, receiptHash: hashJson(attempt.receipt) }],
        ...(child || unitStatus === "accepted" ? {} : { reason: "host predicate assessment did not accept synthesis" }),
      }, unit.id));
    if (binding.continuationOf) events.push(...this.releaseConsultationMinimum(fresh, binding.consultationId!,
      Object.fromEntries(RESOURCE_KEYS.map((resource) => [resource, this.consultationHold(fresh, binding.consultationId!, resource)])),
      unit.id, binding.attemptId));
    const reservation = fresh.reservations.find(({ id }) => id === stableId(`${binding.attemptId}:artifact`));
    if (reservation && events.some(({ kind }) => kind === "attempt.settled")) {
      const size = this.store.readArtifact(responseHash).byteLength;
      events.push(this.reservationSettlement(binding.revision, reservation, {
        knownCharge: size, unknownCharge: reservation.unknownCharge,
        released: Math.max(0, reservation.grantAmount - size - reservation.unknownCharge),
        source: "team member response artifact",
      }, `${binding.attemptId}:artifacts-settled`, unit.id, binding.attemptId));
    }
    this.emit(events);
  }

  private settleConsultation(unit: MissionUnit, attempt: MissionAttemptProjection, bytes: Buffer): void {
    const binding = attempt.binding;
    const inspection = this.store.inspectMission(this.missionId);
    const targetId = binding.targetId ?? unit.id;
    const requestId = stableId(`${this.missionId}:consultation:${unit.id}:${targetId}:${binding.roundId}:${binding.memberId}`);
    const childTargetId = stableId(`${requestId}:target`);
    const parent = inspection.events.find((event) => event.kind === "team.consultation.admitted" &&
      event.payload.targetId === targetId);
    const priorDisposition = inspection.events.find((event) =>
      ["team.consultation.admitted", "team.consultation.denied"].includes(event.kind) && event.payload.requestId === requestId);
    const depth = parent ? Number(parent.payload.depth) + 1 : 1;
    const reservation = inspection.reservations.find(({ id }) => id === stableId(`${binding.attemptId}:artifact`));
    const events: MissionEventDraft[] = [];
    let reason: string | undefined;
    try {
      const bundleBytes = this.store.readArtifact(binding.teamBundleHash!);
      const bundle = JSON.parse(bundleBytes.toString("utf8")) as TeamBundle;
      if (sha256(bytes) !== attempt.receipt?.artifactHash || sha256(bundleBytes) !== binding.teamBundleHash ||
        binding.teamOutputContractHash !== hashJson({ version: 1, phase: bundle.phase, round: binding.roundId }))
        throw new Error("consultation source artifact or contract changed");
      const role = binding.memberId === "synthesis" ? (parent?.payload.request as ConsultationRequest | undefined)?.synthesisRole ?? unit.team?.synthesisRole :
        ((parent?.payload.request as ConsultationRequest | undefined)?.members ?? unit.team?.members)?.find(({ id }) => id === binding.memberId)?.role;
      if (bundle.unitId !== unit.id || bundle.round !== binding.roundId || bundle.memberId !== binding.memberId ||
        (bundle.targetId ?? unit.id) !== targetId || bundle.phase !== (unit.team?.phase ?? "execution") ||
        attempt.receipt?.role !== role || attempt.receipt?.status !== "completed" || attempt.receipt?.quiescent !== true ||
        binding.candidate !== "read-only" || binding.continuationOf || binding.rolePolicyHash !==
          inspection.definition.authority.rolePolicies[role!]?.hash ||
        binding.revision !== inspection.revision || !this.consultationOwnerCurrent(binding.ownerEpoch) ||
        pendingQuestionUnits(inspection.events, inspection.definition, this.store).has(unit.id) ||
        recoveryBlockedUnits(this.store, inspection, this.managedWorkspace?.sourceRoot)?.has(unit.id) !== false ||
        !["running", "blocked"].includes(reduceMissionEvents(inspection).state))
        throw new Error("consultation source is not a current quiescent read-only member");
      if (depth > 2) throw new Error("consultation depth exceeds 2");
      if (priorDisposition) throw new Error("logical member slot already disposed a consultation");
      const request = parseConsultationRequest(bytes, bundle, inspection.definition.authority.rolePolicies);
      if (!reservation || bytes.byteLength > reservation.grantAmount) throw new Error("consultation request exceeds artifact allowance");
      const launches = request.members.length * 3 + 2; // child rounds + synthesis + fresh parent continuation
      const perRequest = Math.max(1, Math.ceil(inspection.definition.budget.tokens / inspection.definition.budget.providerRequests));
      const perLaunch = inspection.definition.finalization.contractVersion === 1 ? compileFinalizationGrants(inspection.definition).active :
        Math.max(1, Math.ceil(inspection.definition.budget.activeTimeMs / inspection.definition.budget.roleLaunches));
      const perArtifact = inspection.definition.finalization.contractVersion === 1 ? compileFinalizationGrants(inspection.definition).artifacts :
        Math.max(1, Math.ceil(inspection.definition.budget.artifactBytes / inspection.definition.budget.roleLaunches));
      const minimum: Record<BudgetResource, number> = {
        "role-launches": launches, "provider-requests": launches, tokens: launches * perRequest,
        "active-time-ms": launches * perLaunch, "artifact-bytes": launches * perArtifact,
      };
      const spent = budgetMap(inspection.definition.budget);
      const rootRemaining = this.remainingRootSlots(inspection);
      const receiptRelease = reservation.amount - bytes.byteLength;
      const unitCost: Record<BudgetResource, number> = {
        "role-launches": 1, "provider-requests": 1, tokens: perRequest,
        "active-time-ms": perLaunch, "artifact-bytes": perArtifact,
      };
      for (const resource of RESOURCE_KEYS) {
        const use = budgetAmounts(inspection.events, resource);
        const available = spent[resource] - use.ordinary - use.protected +
          (resource === "artifact-bytes" ? receiptRelease : 0);
        const required = minimum[resource] + (resource === "provider-requests" || resource === "tokens"
          ? this.remainingRootSlots(inspection, "request") : rootRemaining) * unitCost[resource];
        if (available < required)
          throw new Error(`consultation minimum ${resource} needs ${required}; ordinary root allowance ${available}`);
      }
      events.push(this.event(binding.revision, "attempt.settled", `${binding.attemptId}:settled`, {
        attemptId: binding.attemptId, status: "yielded", resultHash: sha256(bytes), requestId, childTargetId,
      }, unit.id, binding.attemptId));
      if (reservation) events.push(this.reservationSettlement(binding.revision, reservation, {
        knownCharge: bytes.byteLength, unknownCharge: reservation.unknownCharge,
        released: Math.max(0, reservation.grantAmount - bytes.byteLength - reservation.unknownCharge),
        source: "terminal consultation request artifact",
      }, `${binding.attemptId}:artifacts-settled`, unit.id, binding.attemptId));
      for (const resource of RESOURCE_KEYS) events.push(reservationDraft(this.missionId, binding.revision,
        stableId(`${requestId}:minimum:${resource}`), resource, minimum[resource], "ordinary", this.wallNow()));
      events.push(this.event(binding.revision, "team.consultation.admitted", `${requestId}:admitted`, {
        requestId, targetId: childTargetId, parentTargetId: targetId, parentAttemptId: binding.attemptId,
        unitId: unit.id, round: binding.roundId, memberId: binding.memberId, depth,
        requestHash: sha256(bytes), receiptHash: hashJson(attempt.receipt), bundleHash: binding.teamBundleHash,
        inputManifestHash: binding.inputManifestHash, rolePolicyHash: binding.rolePolicyHash,
        ownerEpoch: binding.ownerEpoch, minimum, request,
      }, unit.id, binding.attemptId));
    } catch (error) { reason = messageOf(error); }
    if (reason) {
      if (!priorDisposition) events.push(this.event(binding.revision, "team.consultation.denied", `${binding.attemptId}:consultation-denied`, {
        requestId, targetId: childTargetId, parentTargetId: targetId, parentAttemptId: binding.attemptId,
        unitId: unit.id, round: binding.roundId, memberId: binding.memberId,
        requestHash: sha256(bytes), receiptHash: hashJson(attempt.receipt), reason,
      }, unit.id, binding.attemptId));
      events.push(this.event(binding.revision, "attempt.settled", `${binding.attemptId}:settled`, {
        attemptId: binding.attemptId, status: "failed", resultHash: sha256(bytes), reason,
      }, unit.id, binding.attemptId), this.event(binding.revision, "team.member.recorded", `${binding.attemptId}:team-member`, {
        unitId: unit.id, targetId, round: binding.roundId, memberId: binding.memberId,
        status: "invalid", reason, responseHash: sha256(bytes), bundleHash: binding.teamBundleHash,
        receiptHash: hashJson(attempt.receipt),
      }, unit.id, binding.attemptId));
      if (reservation) events.push(this.reservationSettlement(binding.revision, reservation, {
        knownCharge: Math.min(bytes.byteLength, reservation.grantAmount),
        unknownCharge: reservation.unknownCharge,
        released: Math.max(0, reservation.grantAmount - bytes.byteLength - reservation.unknownCharge),
        source: "denied consultation request artifact",
      }, `${binding.attemptId}:artifacts-settled`, unit.id, binding.attemptId));
      if (binding.continuationOf) events.push(...(targetId === unit.id
        ? this.releaseConsultationMinimum(inspection, binding.consultationId!,
          Object.fromEntries(RESOURCE_KEYS.map((resource) => [resource, this.consultationHold(inspection, binding.consultationId!, resource)])),
          unit.id, binding.attemptId)
        : this.releaseConsultationBranch(inspection, targetId)));
    }
    this.emit(events);
  }

  private consultationOwnerCurrent(epoch: number): boolean {
    if (epoch === this.store.ownerEpoch) return true;
    const proof = this.store.ownerAcquisitionProof;
    return proof?.epoch === this.store.ownerEpoch &&
      (proof.source === "retirement" || proof.source === "owner-death") &&
      (proof.previous as { epoch?: number } | undefined)?.epoch === epoch;
  }

  private releaseConsultationBranch(inspection: ReturnType<MissionStore["inspectMission"]>, targetId: string): MissionEventDraft[] {
    const events: MissionEventDraft[] = [];
    let current = targetId;
    while (true) {
      const admission = inspection.events.find((event) => event.kind === "team.consultation.admitted" &&
        event.payload.targetId === current);
      if (!admission) break;
      const requestId = String(admission.payload.requestId);
      events.push(...this.releaseConsultationMinimum(inspection, requestId,
        Object.fromEntries(RESOURCE_KEYS.map((resource) => [resource, this.consultationHold(inspection, requestId, resource)])),
        String(admission.unitId), String(admission.payload.parentAttemptId)));
      current = String(admission.payload.parentTargetId);
    }
    return events;
  }

  private consultationHold(inspection: ReturnType<MissionStore["inspectMission"]>, requestId: string, resource: BudgetResource): number {
    return inspection.reservations.find(({ id }) => id === stableId(`${requestId}:minimum:${resource}`))?.amount ?? 0;
  }

  private remainingRootSlots(inspection: ReturnType<MissionStore["inspectMission"]>, resource: "launch" | "request" = "launch"): number {
    const state = reduceMissionEvents(inspection);
    const dispatched = new Set(inspection.events.filter(({ kind }) => kind === "provider.request.dispatched")
      .map(({ attemptId }) => attemptId));
    return inspection.definition.units.reduce((count, entry) => {
      if (state.units[entry.id]?.status === "accepted") return count;
      const slots = entry.team ? [
        ...TEAM_ROUNDS.slice(0, 3).flatMap((round) => entry.team!.members.map(({ id }) => `${round}:${id}`)),
        "synthesis:synthesis",
      ] : ["main:solo"];
      const attempted = new Set(Object.values(state.attempts).filter(({ binding }) =>
        binding.unitId === entry.id && binding.revision === inspection.revision && (binding.targetId ?? entry.id) === entry.id &&
        !binding.continuationOf && (resource === "launch" || dispatched.has(binding.attemptId)))
        .map(({ binding }) => `${binding.roundId}:${binding.memberId}`));
      return count + slots.filter((slot) => !attempted.has(slot)).length;
    }, 0);
  }

  private requireRootSlack(inspection: ReturnType<MissionStore["inspectMission"]>, resource: BudgetResource,
    charge: number, releasedHold = 0, remainingSlots = this.remainingRootSlots(inspection,
      resource === "provider-requests" || resource === "tokens" ? "request" : "launch")): void {
    const use = budgetAmounts(inspection.events, resource);
    const budget = budgetMap(inspection.definition.budget);
    const grants = inspection.definition.finalization.contractVersion === 1 ? compileFinalizationGrants(inspection.definition) : undefined;
    const perSlot = resource === "role-launches" || resource === "provider-requests" ? 1
      : grants && resource === "active-time-ms" ? grants.active : grants && resource === "artifact-bytes" ? grants.artifacts
      : Math.max(1, Math.ceil(budget[resource] / budget[resource === "tokens" ? "provider-requests" : "role-launches"]));
    if (budget[resource] - use.ordinary - use.protected + releasedHold - charge < remainingSlots * perSlot)
      throw new RecoveryAdmissionError(`ordinary ${resource} is reserved for remaining root slots`);
  }

  private releaseConsultationMinimum(
    inspection: ReturnType<MissionStore["inspectMission"]>, requestId: string,
    amounts: Partial<Record<BudgetResource, number>>, unitId: string, attemptId: string,
  ): MissionEventDraft[] {
    return Object.entries(amounts).flatMap(([key, amount]) => {
      const resource = key as BudgetResource;
      const hold = this.consultationHold(inspection, requestId, resource);
      const released = Math.min(hold, amount!);
      if (!released) return [];
      const remaining = hold - released;
      return [this.event(inspection.revision, "budget.reservation.adjusted",
        `${requestId}:minimum:${resource}:remaining:${remaining}`, {
          reservationId: stableId(`${requestId}:minimum:${resource}`), resource, amount: remaining,
          reason: "release consultation minimum into a root dispatch grant",
        }, unitId, attemptId)];
    });
  }

  private blockSingletonContinuation(inspection: ReturnType<MissionStore["inspectMission"]>,
    attempt: MissionAttemptProjection): void {
    const binding = attempt.binding;
    if (this.closed || this.retired || this.store.ownerEpoch !== binding.ownerEpoch ||
      inspection.revision !== binding.revision || reduceMissionEvents(inspection).attempts[binding.attemptId]?.settled) return;
    const reservation = inspection.reservations.find(({ id }) => id === stableId(`${binding.attemptId}:artifact`));
    const size = this.store.readArtifact(String(attempt.receipt?.artifactHash)).byteLength;
    this.store.appendTransition(this.missionId, inspection.version, { events: [
      this.event(binding.revision, "attempt.settled", `${binding.attemptId}:settled`, {
        attemptId: binding.attemptId, status: "failed", resultHash: attempt.receipt?.artifactHash,
        reason: "singleton checkpoint, child result or source changed",
      }, binding.unitId, binding.attemptId),
      this.event(binding.revision, "unit.blocked", `${binding.attemptId}:continuation-fenced`, {
        unitId: binding.unitId, reason: "singleton checkpoint, child result or source changed",
      }, binding.unitId, binding.attemptId),
      ...(reservation ? [this.reservationSettlement(binding.revision, reservation, {
        knownCharge: size, unknownCharge: reservation.unknownCharge,
        released: Math.max(0, reservation.grantAmount - size - reservation.unknownCharge),
        source: "fenced singleton continuation artifact",
      }, `${binding.attemptId}:artifacts-settled`, binding.unitId, binding.attemptId)] : []),
      ...this.releaseConsultationMinimum(inspection, binding.consultationId!,
        Object.fromEntries(RESOURCE_KEYS.map((resource) => [resource, this.consultationHold(inspection, binding.consultationId!, resource)])),
        binding.unitId, binding.attemptId),
    ] });
  }

  private outputLineage(inspection: ReturnType<MissionStore["inspectMission"]>, binding: MissionAttemptBinding) {
    const lineage: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const pending: MissionAttemptBinding[] = [binding];
    while (pending.length) {
      const current = pending.shift()!;
      if (seen.has(current.attemptId)) continue;
      seen.add(current.attemptId);
      const id: string = current.attemptId;
      const base = inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" && event.attemptId === id && event.payload.phase === "base");
      const start = inspection.events.find((event) => event.kind === "workspace.snapshot.sealed" && event.attemptId === id && event.payload.purpose === "execution-start");
      const checkpointHash: string | undefined = current.checkpointHash;
      if (checkpointHash) this.singletonCheckpoint(inspection, current.continuationOf!, checkpointHash);
      const recovery: MissionEvent | undefined = current.recoveryContinuationId ? inspection.events.find((event) => event.kind === "mission.recovery.continuation.recorded" &&
        event.payload.continuationId === current!.recoveryContinuationId) : undefined;
      lineage.push({ attemptId: id, bindingHash: hashJson(current), sourceBaseImageHash: base?.payload.imageHash ?? null,
        executionStartImageHash: start?.payload.imageHash ?? null, contributionInput: start?.payload.contributionInput ?? null,
        checkpointHash: checkpointHash ?? null,
        recoveryImageHash: current.recoveryImageHash ?? null, recoveryProofHash: recovery && recovery.payload.proofHash || null });
      const reserved = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === id);
      const predecessors = [current.recoveryOf, current.continuationOf,
        recovery?.payload.lifecycle ? undefined : recovery?.payload.sourceAttemptId].filter((value): value is string => typeof value === "string");
      for (const predecessor of [...new Set(predecessors)]) {
        const prior = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === predecessor);
        if (!prior || !reserved || prior.seq >= reserved.seq) throw new Error("output predecessor binding is missing or cyclic");
        pending.push(prior.payload.binding as MissionAttemptBinding);
      }
    }
    return lineage;
  }

  private async assessProductionPredicate(inspection: ReturnType<MissionStore["inspectMission"]>, attempt: MissionAttemptProjection,
    predicate: MissionUnit["acceptance"][number], artifactHash: string): Promise<MissionPredicateObservation> {
    const binding = attempt.binding;
    const input = readPredicateInputBinding(this.store, binding, predicate.id);
    let subject: BoundPredicateSubject = { kind: "artifact", artifactHash };
    let effects: MissionEffects | undefined;
    let scopeEstablished = !!input && attempt.receipt!.sdkDisposed === true;
    const processes: Record<string, unknown>[] = [];
    let scopeFailure = !input ? "predicate-input-binding" : attempt.receipt!.sdkDisposed !== true ? "sdk-disposal" : undefined;
    try {
      this.outputLineage(inspection, binding);
      if (binding.candidate === "managed") {
        if (!attempt.receipt!.terminalOutputHash) throw new Error("terminal output seal is missing");
        const proof = JSON.parse(this.store.readArtifact(String(attempt.receipt!.terminalOutputHash)).toString());
        if (proof.format !== "mission-terminal-output-v1" || proof.bindingHash !== hashJson(binding) || proof.resultHash !== artifactHash ||
          proof.sdkDisposed !== true || proof.effectsQuiescent !== true || proof.writersQuiescent !== true) throw new Error("terminal output proof is invalid");
        assertCompleteWorkspaceImage(readSealedWorkspaceImage(this.store, proof.terminalImageHash));
        subject = { kind: "workspace", imageHash: proof.terminalImageHash };
        const runtime = [...this.effectRunners].find((runner) => runner.workspace.attemptId === binding.attemptId);
        if (runtime && predicate.kind === "command_exit") effects = new MissionEffects({ store: this.store, workspace: runtime.workspace,
          missionId: this.missionId, revision: binding.revision, unitId: binding.unitId, attemptId: binding.attemptId,
          runtimeId: this.store.runtimeId, ownerEpoch: binding.ownerEpoch, allowedOperations: inspection.definition.authority.operations,
          canInvoke: (effectId) => this.attemptAdmitted(binding, undefined, effectId) });
      }
      if (missionHasUnresolvedEffects(this.store, inspection.events, binding.attemptId)) {
        scopeFailure = "unresolved-effects";
        scopeEstablished = false;
      } else if (!missionEffectProcessesQuiescent(inspection.events, binding.attemptId, processes)) {
        scopeFailure = "process-quiescence";
        scopeEstablished = false;
      }
    } catch (error) { scopeEstablished = false; scopeFailure = error instanceof Error ? error.message : String(error); }
    const time = budgetAmounts(inspection.events, "active-time-ms");
    if (effects) this.effectRunners.add(effects);
    const observation = await assessMissionPredicate({ predicate, subject }, { store: this.store,
      inputBindingHash: input?.inputBindingHash ?? binding.inputManifestHash, scopeEstablished, effects,
      timeoutLimitMs: this.activeWindow ? Math.max(0, this.activeWindow.grantAmount - this.activeWindow.knownCharge -
        this.activeWindow.unknownCharge - this.activeWindow.released - Math.ceil(this.now() - this.activeWindow.lastCheckpointAt)) :
        Math.max(0, inspection.definition.budget.activeTimeMs - time.ordinary - time.protected) });
    if (observation.verdict !== "pass") {
      try { this.captureRejection?.({ boundary: "production-predicate", missionId: this.missionId,
        attemptId: binding.attemptId, predicate, scopeEstablished, scopeFailure, processes,
        observation: observation.artifactBytes && Buffer.from(observation.artifactBytes).toString(), receipt: attempt.receipt }); } catch { /* capture cannot change assessment */ }
    }
    return observation;
  }

  private async settleReceipt(unit: MissionUnit, attempt: MissionAttemptProjection): Promise<void> {
    const ownerEpoch = this.store.ownerEpoch;
    const inspection = this.store.inspectMission(this.missionId);
    if (attempt.binding.revision !== inspection.revision) {
      this.emit([this.event(attempt.binding.revision, "attempt.settled", `${attempt.binding.attemptId}:settled`, {
        attemptId: attempt.binding.attemptId, status: "cancelled", reason: "superseded by admitted revision",
      }, attempt.binding.unitId, attempt.binding.attemptId)]);
      return;
    }
    if (reduceMissionEvents(inspection).state === "paused") return;
    if (!this.recoveryBindingCurrent(attempt.binding, inspection)) { this.fenceStaleRecoveryReceipt(inspection, attempt); return; }
    if (attempt.binding.checkpointHash && !this.singletonContinuationCurrent(inspection,
      attempt.binding.continuationOf!, attempt.binding.checkpointHash, attempt.binding.childResultHash!)) {
      this.blockSingletonContinuation(inspection, attempt);
      return;
    }
    if (pendingQuestionUnits(inspection.events, inspection.definition, this.store).has(unit.id)) {
      this.emit([this.event(inspection.revision, "attempt.settled", `${attempt.binding.attemptId}:question-settled`, {
        attemptId: attempt.binding.attemptId, status: "cancelled", reason: "operator choice pending",
      }, unit.id, attempt.binding.attemptId), this.event(inspection.revision, "unit.ready", `${attempt.binding.attemptId}:question-ready`, {
        unitId: unit.id, reason: "waiting for operator choice", readyRuntimeId: this.store.runtimeId, readyMonotonicMs: this.now(),
      }, unit.id)]);
      return;
    }
    const scope = recoveryBlockedUnits(this.store, inspection, this.managedWorkspace?.sourceRoot);
    const unresolvedBeforeReport = scope === null && missionHasUnresolvedEffects(this.store, inspection.events) &&
      !inspection.events.some((event) => event.kind === "mission.recovery.recorded");
    if ((!unresolvedBeforeReport && (scope === null || scope.has(unit.id))) ||
      !["running", "blocked"].includes(reduceMissionEvents(inspection).state)) return;
    const artifactHash = String(attempt.receipt!.artifactHash ?? "");
    const resultArtifact = this.store.readArtifact(artifactHash);
    const status = String(attempt.receipt!.status);
    const artifactReservation = inspection.reservations.find(({ id }) => id === stableId(`${attempt.binding.attemptId}:artifact`));
    const artifactUsage = budgetAmounts(inspection.events, "artifact-bytes");
    const actualArtifactBytes = artifactUsage.protected + artifactUsage.finalization + artifactUsage.ordinary -
      (artifactReservation?.amount ?? 0) + resultArtifact.byteLength;
    const events: MissionEventDraft[] = [];
    const artifacts: Array<{ bytes: Uint8Array; mediaType: string }> = [];
    const evidenceIds: string[] = [];
    let evidenceArtifactBytes = 0;
    let accepted = status === "completed" && unit.acceptance.length > 0 && !unresolvedBeforeReport;
    if (status === "completed" && !unresolvedBeforeReport) {
      events.push(this.event(inspection.revision, "unit.verifying", `${attempt.binding.attemptId}:verifying`, {
        unitId: unit.id, attemptId: attempt.binding.attemptId,
      }, unit.id, attempt.binding.attemptId));
      for (const predicate of unit.acceptance) {
        const observation = this.assessPredicate ? await this.assessPredicate({ unit, predicate,
          result: resultFromReceipt(attempt), resultArtifact, inputManifestHash: attempt.binding.inputManifestHash })
          : await this.assessProductionPredicate(inspection, attempt, predicate, artifactHash);
        for (const artifact of observation.artifacts ?? []) {
          artifacts.push(artifact);
          evidenceArtifactBytes += artifact.bytes.byteLength;
        }
        const evidenceBytes = observation.artifactBytes ? Buffer.from(observation.artifactBytes) : undefined;
        const evidenceArtifactHash = evidenceBytes ? sha256(evidenceBytes) : observation.artifactHash ?? null;
        if (evidenceBytes && observation.artifactHash && observation.artifactHash !== evidenceArtifactHash) {
          throw new Error(`predicate artifact hash does not match bytes for ${predicate.id}`);
        }
        if (evidenceBytes) {
          evidenceArtifactBytes += evidenceBytes.byteLength;
          artifacts.push({ bytes: evidenceBytes, mediaType: observation.artifactMediaType ?? "application/octet-stream" });
        }
        const outputManifestHash = observation.outputManifestHash ?? hashJson({ resultArtifact: artifactHash, predicate: predicate.id, artifact: evidenceArtifactHash });
        const predicateBinding = readPredicateInputBinding(this.store, attempt.binding, predicate.id);
        const evidence: MissionEvidence = {
          id: stableId(`${attempt.binding.attemptId}:evidence:${predicate.id}`),
          unitId: unit.id,
          predicateId: predicate.id,
          revision: inspection.revision,
          verdict: observation.verdict,
          inputManifestHash: attempt.binding.inputManifestHash,
          outputManifestHash,
          method: observation.method,
          assessmentAuthority: this.assessPredicate ? "injected-test" : observation.authority ?? "injected-test",
          artifactHash: evidenceArtifactHash,
          attemptId: attempt.binding.attemptId,
          ...(predicateBinding ? {
            predicateHash: predicateBinding.predicateHash,
            inputPatterns: predicateBinding.inputPatterns,
            inputBindingHash: predicateBinding.inputBindingHash,
            inputIndexEntries: predicateBinding.inputIndexEntries,
            rolePolicyHash: predicateBinding.rolePolicyHash,
            dependencyEvidence: predicateBinding.dependencyEvidence,
            assessmentToolIdentity: predicateBinding.assessmentToolIdentity,
            runtimeIdentity: predicateBinding.runtimeIdentity,
          } : {}),
        };
        evidenceIds.push(evidence.id);
        events.push(this.event(inspection.revision, "evidence.recorded", `${attempt.binding.attemptId}:evidence:${predicate.id}`, evidence as unknown as Record<string, unknown>, unit.id, attempt.binding.attemptId));
        if (observation.verdict !== "pass") accepted = false;
      }
    } else {
      accepted = false;
    }
    let artifactCharge = resultArtifact.byteLength + evidenceArtifactBytes + Number(attempt.receipt!.terminalOutputArtifactBytes ?? 0) + Number(attempt.receipt!.initialOutputArtifactBytes ?? 0);
    const artifactOverrun = actualArtifactBytes + artifactCharge - resultArtifact.byteLength > budgetMap(inspection.definition.budget)["artifact-bytes"];
    if (artifactOverrun) accepted = false;
    const usedAttempts = Object.values(reduceMissionEvents(inspection).attempts).filter(({ binding }) =>
      binding.unitId === unit.id && (!attempt.binding.checkpointHash ||
        binding.roundId === "main" && binding.memberId === "solo" && (binding.targetId ?? unit.id) === unit.id)).length;
    const continuationId = attempt.binding.recoveryContinuationId;
    const continuation = continuationId ? [...inspection.events].reverse().find((event) =>
      event.kind === "mission.recovery.continuation.recorded" && event.payload.continuationId === continuationId) : undefined;
    const repairAuthorization = attempt.binding.recoveryImageHash ? inspection.events.find((event) =>
      event.kind === "mission.recovery.repair.authorized" && event.payload.unitId === unit.id &&
      event.payload.sourceImageHash === attempt.binding.recoveryImageHash) : undefined;
    const repairAttempt = attempt.binding.recoveryMode === "repair" && Boolean(attempt.binding.repairAuthorizationId);
    const repairCount = inspection.events.filter((event) => event.kind === "mission.recovery.repair.authorized" &&
      event.unitId === unit.id).length;
    const canAuthorizeRepair = !accepted && !artifactOverrun && !unresolvedBeforeReport && status === "completed" &&
      attempt.binding.recoveryMode === "verify" && continuation && !repairAuthorization && repairCount < Number(continuation.payload.repairLimit ?? 0) && missionCorrectionNo(inspection.events, attempt.binding) < unit.retryLimit;
    const normalRetry = !accepted && !artifactOverrun && !unresolvedBeforeReport && status !== "cancelled" && !continuationId &&
      missionCorrectionNo(inspection.events, attempt.binding) < unit.retryLimit;
    const retry = Boolean(canAuthorizeRepair || normalRetry);
    if (canAuthorizeRepair && continuation && continuationId) {
      const authorizationId = stableId(`${continuationId}:repair:${attempt.binding.attemptId}`);
      events.push(this.event(inspection.revision, "mission.recovery.repair.authorized", `${authorizationId}:authorized`, {
        authorizationId, continuationId, unitId: unit.id, sourceImageHash: continuation.payload.sourceImageHash,
        sourceAttemptId: continuation.payload.sourceAttemptId, verificationAttemptId: attempt.binding.attemptId,
        repairNo: repairCount + 1, allowedPaths: inspection.definition.authority.allowedPaths,
        allowedOperations: inspection.definition.authority.operations, evidenceIds,
      }, unit.id, attempt.binding.attemptId));
    }
    let outputBindingHash: string | undefined;
    if (accepted && !this.assessPredicate) {
      const currentOutput = this.store.inspectMission(this.missionId);
      const bytes = Buffer.from(JSON.stringify({ format: "mission-accepted-output-v1", missionId: this.missionId,
        revision: inspection.revision, unitId: unit.id, attemptId: attempt.binding.attemptId,
        binding: attempt.binding, resultArtifactHash: artifactHash, terminalOutputHash: attempt.receipt!.terminalOutputHash ?? null,
        evidenceIds, evidenceHashes: events.filter((event) => event.kind === "evidence.recorded").map((event) => event.payload.artifactHash),
        lineage: this.outputLineage(currentOutput, attempt.binding),
        effectWitnesses: currentOutput.events.filter((event) => event.attemptId === attempt.binding.attemptId && event.effectId)
          .map((event) => ({ eventId: event.eventId, seq: event.seq, kind: event.kind, payloadHash: hashJson(event.payload) })),
        sdkDisposed: attempt.receipt!.sdkDisposed === true, effectsQuiescent: !missionHasUnresolvedEffects(this.store, currentOutput.events, attempt.binding.attemptId),
        writersQuiescent: missionEffectProcessesQuiescent(currentOutput.events, attempt.binding.attemptId),
      }));
      outputBindingHash = sha256(bytes);
      artifactCharge += bytes.byteLength;
      if (actualArtifactBytes - resultArtifact.byteLength + artifactCharge > budgetMap(inspection.definition.budget)["artifact-bytes"]) accepted = false;
      artifacts.push({ bytes, mediaType: "application/json" });
    }
    if (accepted) {
      if (continuationId) events.push(this.event(inspection.revision, "mission.recovery.continuation", `${continuationId}:verified:${attempt.binding.attemptId}`, {
        continuationId, unitId: unit.id, disposition: "verified", attemptId: attempt.binding.attemptId,
        sourceImageHash: attempt.binding.recoveryImageHash,
      }, unit.id, attempt.binding.attemptId));
      if (repairAttempt) events.push(this.event(inspection.revision, "mission.recovery.repair.settled", `${attempt.binding.repairAuthorizationId}:settled`, {
        authorizationId: attempt.binding.repairAuthorizationId, disposition: "verified", attemptId: attempt.binding.attemptId,
      }, unit.id, attempt.binding.attemptId));
      events.push(this.event(inspection.revision, "unit.accepted", `${attempt.binding.attemptId}:accepted`, {
        unitId: unit.id, attemptId: attempt.binding.attemptId, evidenceIds,
        inputManifestHash: attempt.binding.inputManifestHash,
        outputManifestHash: outputBindingHash ?? hashJson(evidenceIds),
        ...(outputBindingHash ? { outputBindingHash } : {}),
      }, unit.id, attempt.binding.attemptId));
    } else if (unresolvedBeforeReport) {
      const reason = "attempt has an unresolved local effect; quarantined candidate requires reconciliation before retry";
      events.push(this.event(inspection.revision, "unit.blocked", `${attempt.binding.attemptId}:effect-unresolved`, {
        unitId: unit.id, attemptId: attempt.binding.attemptId, reason, retryable: false,
      }, unit.id, attempt.binding.attemptId));
      events.push(this.event(inspection.revision, "mission.blocked", `${attempt.binding.attemptId}:effect-blocks-mission`, { reason }, unit.id, attempt.binding.attemptId));
    } else if (repairAttempt) {
      events.push(this.event(inspection.revision, "mission.recovery.repair.settled", `${attempt.binding.repairAuthorizationId}:settled`, {
        authorizationId: attempt.binding.repairAuthorizationId, disposition: "blocked", attemptId: attempt.binding.attemptId,
        reason: "bounded fresh-candidate repair did not pass required evidence",
      }, unit.id, attempt.binding.attemptId));
      events.push(this.event(inspection.revision, "unit.blocked", `${attempt.binding.attemptId}:repair-blocked`, {
        unitId: unit.id, attemptId: attempt.binding.attemptId,
        reason: artifactOverrun ? "result artifact exceeded its reserved byte budget" : "bounded fresh-candidate repair did not pass required evidence",
      }, unit.id, attempt.binding.attemptId));
    } else if (retry) {
      events.push(this.event(inspection.revision, "unit.ready", `${unit.id}:retry:${usedAttempts + 1}`, {
        unitId: unit.id, retryOf: attempt.binding.attemptId,
        readyRuntimeId: this.store.runtimeId,
        readyMonotonicMs: this.now(),
        reason: "bounded correction attempt after failed or inconclusive evidence",
      }, unit.id));
    } else {
      events.push(this.event(inspection.revision, "unit.blocked", `${attempt.binding.attemptId}:blocked`, {
        unitId: unit.id, attemptId: attempt.binding.attemptId,
        reason: artifactOverrun ? "result artifact exceeded its reserved byte budget" : status === "completed" ? "required evidence did not pass" : `role ended ${status}`,
      }, unit.id, attempt.binding.attemptId));
    }
    events.push(this.event(inspection.revision, "attempt.settled", `${attempt.binding.attemptId}:settled`, {
      attemptId: attempt.binding.attemptId,
      status: accepted ? "succeeded" : status === "cancelled" ? "cancelled" : "failed",
      resultHash: artifactHash,
    }, unit.id, attempt.binding.attemptId));
    if (artifactReservation) events.push(this.reservationSettlement(inspection.revision, artifactReservation, {
      knownCharge: artifactCharge,
      unknownCharge: artifactReservation.unknownCharge,
      released: Math.max(0, artifactReservation.grantAmount - artifactCharge - artifactReservation.unknownCharge),
      source: "attempt artifact and verification evidence",
    }, `${attempt.binding.attemptId}:artifacts-settled`, unit.id, attempt.binding.attemptId));
    if (attempt.binding.checkpointHash && !retry) events.push(...this.releaseConsultationMinimum(inspection,
      attempt.binding.consultationId!, Object.fromEntries(RESOURCE_KEYS.map((resource) =>
        [resource, this.consultationHold(inspection, attempt.binding.consultationId!, resource)])),
      unit.id, attempt.binding.attemptId));
    if (this.store.inspectMission(this.missionId).revision !== attempt.binding.revision) {
      this.emit([this.event(attempt.binding.revision, "attempt.settled", `${attempt.binding.attemptId}:settled`, {
        attemptId: attempt.binding.attemptId, status: "cancelled", reason: "superseded during verification",
      }, attempt.binding.unitId, attempt.binding.attemptId)]);
      return;
    }
    const current = this.store.inspectMission(this.missionId);
    const currentState = reduceMissionEvents(current);
    if (current.revision !== inspection.revision || ownerEpoch === null || this.store.ownerEpoch !== ownerEpoch ||
      this.closed || this.retired || currentState.attempts[attempt.binding.attemptId]?.settled || currentState.state === "paused") return;
    if (!this.recoveryBindingCurrent(attempt.binding, current)) { this.fenceStaleRecoveryReceipt(current, attempt); return; }
    if (attempt.binding.checkpointHash && !this.singletonContinuationCurrent(current,
      attempt.binding.continuationOf!, attempt.binding.checkpointHash, attempt.binding.childResultHash!)) {
      this.blockSingletonContinuation(current, attempt);
      return;
    }
    if (current.events.some((event) => event.kind === "team.consultation.cancelled" && event.unitId === unit.id)) {
      this.store.appendTransition(this.missionId, current.version, {
        events: [...events.filter((event) => event.kind === "evidence.recorded" || event.kind === "budget.reservation.settled"),
          this.event(current.revision, "attempt.settled", `${attempt.binding.attemptId}:settled`, {
            attemptId: attempt.binding.attemptId, status: "cancelled", resultHash: artifactHash,
            reason: "consultation branch cancelled during verification",
          }, unit.id, attempt.binding.attemptId)],
        artifacts,
      });
      return;
    }
    const currentScope = recoveryBlockedUnits(this.store, current, this.managedWorkspace?.sourceRoot);
    if (accepted && (currentScope === null || currentScope.has(unit.id) ||
      !["running", "blocked"].includes(currentState.state) ||
      pendingQuestionUnits(current.events, current.definition, this.store).has(unit.id))) return;
    this.store.appendTransition(this.missionId, current.version, { events, artifacts });
  }

  private async dispatchProviderRequest(binding: MissionAttemptBinding, request: { requestId: string; provider: string; model: string }): Promise<{ tokenReservationId: string }> {
    if (this.closed || this.retired) throw new Error("mission owner is fenced; provider request was not admitted");
    await this.checkActiveTimeBeforeEffect();
    if (this.closed || this.retired) throw new Error("mission owner is fenced; provider request was not admitted");
    const inspection = this.store.inspectMission(this.missionId);
    const state = reduceMissionEvents(inspection);
    const consultation = inspection.events.find((event) => event.kind === "mission.recovery.diagnosed" &&
      event.payload.status === "started" && event.payload.diagnosisId === binding.attemptId);
    const admission = consultation?.payload.admission as RecoveryDiagnosisAdmission | undefined;
    const recoveryConsultationActive = Boolean(consultation && admission && admission.version === 1 &&
      consultation.seq > admission.observedSeq && admission.revision === binding.revision &&
      admission.ownerEpoch === binding.ownerEpoch && admission.memberRole === binding.memberId &&
      admission.unitId === binding.unitId && admission.briefHash === binding.briefHash &&
      admission.rolePolicyHash === binding.rolePolicyHash && admission.sourceManifestHash === binding.inputManifestHash &&
      admission.fingerprint === consultation.payload.fingerprint &&
      consultation.payload.attemptId === admission.attemptId &&
      inspection.events.some((event) => event.kind === "attempt.reserved" && event.attemptId === admission.attemptId &&
        event.eventId === admission.sourceEventId &&
        (event.payload.binding as MissionAttemptBinding | undefined)?.unitId === binding.unitId &&
        createHash("sha256").update(JSON.stringify(event.payload)).digest("hex") === admission.sourceProofHash) &&
      recoveryObservationCurrent(inspection.events, admission.observedSeq) &&
      !inspection.events.some((event) => event.kind === "mission.import.conflict") &&
      (!this.managedWorkspace || captureWorkspaceImage(this.managedWorkspace.sourceRoot).manifest.hash === binding.inputManifestHash));
    if (!recoveryConsultationActive && !this.attemptAdmitted(binding, inspection))
      throw new Error("attempt was fenced by current recovery or operator admission");
    if (binding.revision !== inspection.revision || state.state === "paused" || state.state === "cancelled" ||
      this.store.ownerEpoch !== binding.ownerEpoch ||
      (state.units[binding.unitId]?.status !== "running" && !binding.finalization && !recoveryConsultationActive)) throw new Error("attempt was fenced by mission revision or operator control");
    if (state.admissionFenced) throw new Error(`mission admission is fenced: ${state.admissionFenceReason ?? "resource overage"}`);
    if ((!state.attempts[binding.attemptId] || state.attempts[binding.attemptId]!.settled) && !recoveryConsultationActive) {
      throw new Error("provider request has no active mission attempt or bounded recovery consultation");
    }
    const tokensPerRequest = Math.max(1, Math.ceil(inspection.definition.budget.tokens / inspection.definition.budget.providerRequests));
    const requestReservationId = stableId(`${request.requestId}:provider-request`);
    const tokenReservationId = stableId(`${request.requestId}:tokens`);
    const startedAt = this.attemptStarted.get(binding.attemptId);
    const requestDuration = startedAt === undefined ? null : Math.max(0, this.now() - startedAt);
    const events = [
      this.event(binding.revision, "reservation.created", `reservation:${request.requestId}:provider`, {
        reservationId: requestReservationId, revision: binding.revision, resource: "provider-requests", amount: 1, purpose: binding.finalization ? "finalization" : "ordinary",
      }, binding.unitId, binding.attemptId),
      this.event(binding.revision, "reservation.created", `reservation:${request.requestId}:tokens`, {
        reservationId: tokenReservationId, revision: binding.revision, resource: "tokens", amount: tokensPerRequest, purpose: binding.finalization ? "finalization" : "ordinary",
      }, binding.unitId, binding.attemptId),
      this.event(binding.revision, "provider.request.dispatched", `${request.requestId}:dispatched`, {
        requestId: request.requestId, attemptId: binding.attemptId, unitId: binding.unitId,
        provider: request.provider, model: request.model, tokenReservationId, ownerEpoch: binding.ownerEpoch,
      }, binding.unitId, binding.attemptId, undefined, requestDuration ?? undefined),
    ];
    const firstRequest = !inspection.events.some((event) =>
      event.kind === "provider.request.dispatched" && event.attemptId === binding.attemptId);
    const releasedProvider = binding.consultationId && firstRequest
      ? Math.min(1, this.consultationHold(inspection, binding.consultationId, "provider-requests")) : 0;
    const releasedTokens = binding.consultationId && firstRequest
      ? Math.min(tokensPerRequest, this.consultationHold(inspection, binding.consultationId, "tokens")) : 0;
    const pendingRootRequest = firstRequest && !binding.consultationId && !binding.continuationOf &&
      (binding.targetId ?? binding.unitId) === binding.unitId && binding.roundId !== "recovery" &&
      !Object.values(state.attempts).some(({ binding: prior }) => prior.revision === binding.revision &&
        prior.unitId === binding.unitId && (prior.targetId ?? prior.unitId) === binding.unitId &&
        prior.roundId === binding.roundId && prior.memberId === binding.memberId && !prior.continuationOf &&
        inspection.events.some((event) => event.kind === "provider.request.dispatched" && event.attemptId === prior.attemptId)) ? 1 : 0;
    const remainingRequests = this.remainingRootSlots(inspection, "request") - pendingRootRequest;
    if (binding.finalization) {
      this.requireFinalizationCapacity(inspection, "provider-requests", 1, binding.finalization.phase);
      this.requireFinalizationCapacity(inspection, "tokens", tokensPerRequest, binding.finalization.phase);
    } else {
      this.requireRootSlack(inspection, "provider-requests", 1, releasedProvider, remainingRequests);
      this.requireRootSlack(inspection, "tokens", tokensPerRequest, releasedTokens, remainingRequests);
    }
    if (binding.consultationId && firstRequest) events.unshift(...this.releaseConsultationMinimum(inspection, binding.consultationId,
      { "provider-requests": 1, tokens: tokensPerRequest }, binding.unitId, binding.attemptId));
    this.store.appendTransition(this.missionId, inspection.version, { events });
    this.requestStarted.set(request.requestId, this.now());
    return { tokenReservationId };
  }

  private fenceStaleRecoveryReceipt(inspection: ReturnType<MissionStore["inspectMission"]>, attempt: MissionAttemptProjection): void {
    if (this.closed || this.retired || this.store.ownerEpoch === null ||
      reduceMissionEvents(inspection).attempts[attempt.binding.attemptId]?.settled) return;
    const reason = "pause recovery observation changed; no stale response or acceptance authorized";
    this.emit([this.event(attempt.binding.revision, "attempt.settled", `${attempt.binding.attemptId}:recovery-fenced`, {
      attemptId: attempt.binding.attemptId, status: "cancelled", reason,
    }, attempt.binding.unitId, attempt.binding.attemptId), this.event(inspection.revision, "unit.blocked", `${attempt.binding.attemptId}:recovery-fenced-unit`, {
      unitId: attempt.binding.unitId, attemptId: attempt.binding.attemptId, reason,
    }, attempt.binding.unitId)]);
  }

  private recoveryBindingCurrent(binding: MissionAttemptBinding, inspection: ReturnType<MissionStore["inspectMission"]>): boolean {
    if (!binding.recoveryContinuationId) return true;
    const continuation = inspection.events.find((event) => event.kind === "mission.recovery.continuation.recorded" &&
      event.payload.continuationId === binding.recoveryContinuationId);
    if (continuation?.payload.lifecycle) {
      try {
        lifecycleRecoveryCurrent(this.store, inspection, binding.recoveryContinuationId, this.managedWorkspace!.sourceRoot,
          binding.attemptId);
        return binding.revision === inspection.revision && binding.ownerEpoch === this.store.ownerEpoch &&
          binding.recoveryImageHash === continuation.payload.sourceImageHash;
      } catch { return false; }
    }
    if (!continuation?.payload.pauseEventId) return true;
    try {
      const source = pauseRecoveryCurrent(this.store, inspection, binding.recoveryContinuationId, this.managedWorkspace!.sourceRoot);
      const original = source.binding;
      return binding.revision === inspection.revision && binding.ownerEpoch === this.store.ownerEpoch &&
        binding.unitId === original.unitId && (binding.targetId ?? binding.unitId) === (original.targetId ?? original.unitId) &&
        binding.roundId === original.roundId && binding.memberId === original.memberId && binding.role === original.role &&
        binding.continuationOf === original.continuationOf && binding.checkpointHash === original.checkpointHash &&
        binding.childResultHash === original.childResultHash && binding.teamBundleHash === original.teamBundleHash &&
        binding.teamOutputContractHash === original.teamOutputContractHash && binding.consultationId === original.consultationId &&
        binding.recoveryImageHash === source.proof.observedImageHash &&
        (binding.recoveryMode === "repair" || missionCorrectionNo(inspection.events, binding) === missionCorrectionNo(inspection.events, original)) &&
        (!binding.recoveryOf || binding.recoveryOf === original.attemptId && !inspection.events.some((event) =>
          event.kind === "attempt.reserved" && event.attemptId !== binding.attemptId &&
          (event.payload.binding as MissionAttemptBinding).recoveryOf === original.attemptId));
    } catch { return false; }
  }

  private attemptAdmitted(
    binding: Pick<MissionAttemptBinding, "revision" | "ownerEpoch" | "unitId" | "attemptId">,
    inspection = this.store.inspectMission(this.missionId),
    invokingEffectId?: string,
    currentCheckpointUse = false,
  ): boolean {
    if (this.closed || this.retired || (!currentCheckpointUse && this.store.ownerEpoch !== binding.ownerEpoch) ||
      this.store.ownerEpoch === null || inspection.revision !== binding.revision) return false;
    const state = reduceMissionEvents(inspection);
    // An admitted effect's own prepared/invoking stamps are not a new recovery cause for itself.
    const observed = invokingEffectId ? { ...inspection, events: inspection.events.filter((event) =>
      event.effectId !== invokingEffectId || !["effect.intent", "effect.invoking"].includes(event.kind)) } : inspection;
    const continuation = inspection.events.find((event) => event.kind === "attempt.reserved" &&
      event.attemptId === binding.attemptId)?.payload.binding as MissionAttemptBinding | undefined;
    if (continuation?.finalization)
      return ["running", "completing"].includes(state.state) && !state.admissionFenced &&
        !pendingMissionQuestions(inspection.events, this.store).length && !state.attempts[binding.attemptId]?.settled &&
        this.finalizationTargetCurrent(inspection, continuation.finalization) &&
        !missionHasUnresolvedEffects(this.store, observed.events, binding.attemptId);
    if (continuation && !this.recoveryBindingCurrent(continuation, inspection)) return false;
    if (continuation?.checkpointHash && !this.singletonContinuationCurrent(observed,
      continuation.continuationOf!, continuation.checkpointHash, continuation.childResultHash!)) return false;
    const scope = recoveryBlockedUnits(this.store, observed, this.managedWorkspace?.sourceRoot);
    return ["running", "blocked"].includes(state.state) && !state.admissionFenced &&
      !inspection.events.some((event) => event.kind === "team.consultation.cancelled" && event.unitId === binding.unitId) &&
      scope !== null && !scope.has(binding.unitId) &&
      !pendingQuestionUnits(inspection.events, inspection.definition, this.store).has(binding.unitId) &&
      state.units[binding.unitId]?.status === "running" &&
      !!state.attempts[binding.attemptId] && !state.attempts[binding.attemptId]!.settled;
  }

  private recordProviderReceipt(binding: MissionAttemptBinding, receipt: ProviderRequestReceipt): void {
    if (this.retired) return;
    const inspection = this.store.inspectMission(this.missionId);
    const prior = inspection.events.find((event) => event.causalId === stableId(`${receipt.requestId}:receipt`));
    if (prior) {
      if (prior.payload.provider !== receipt.provider || prior.payload.model !== receipt.model ||
        prior.payload.inputTokens !== receipt.inputTokens || prior.payload.outputTokens !== receipt.outputTokens) {
        const claim = {
          source: "provider-hook-duplicate",
          requestId: receipt.requestId,
          provider: receipt.provider,
          model: receipt.model,
          inputTokens: receipt.inputTokens ?? null,
          outputTokens: receipt.outputTokens ?? null,
          canonicalReceiptEventId: prior.eventId,
          usageUnknownReason: receipt.usageUnknownReason ?? null,
        };
        this.emit([this.event(binding.revision, "provider.usage.claimed",
          `provider-usage-claim:hook:${receipt.requestId}:${hashJson(claim)}`, claim, binding.unitId, binding.attemptId)]);
      }
      return;
    }
    const dispatch = inspection.events.find((event) =>
      event.kind === "provider.request.dispatched" && event.payload.requestId === receipt.requestId);
    if (!dispatch) {
      throw new Error(`provider receipt has no durable dispatch for ${receipt.requestId}`);
    }
    const ticket = receipt.ticket as { tokenReservationId?: string } | undefined;
    const tokenReservationId = ticket?.tokenReservationId ?? stableId(`${receipt.requestId}:tokens`);
    const validInput = Number.isSafeInteger(receipt.inputTokens) && Number(receipt.inputTokens) >= 0;
    const validOutput = Number.isSafeInteger(receipt.outputTokens) && Number(receipt.outputTokens) >= 0;
    const known = validInput && validOutput;
    const inputTokens = validInput ? Number(receipt.inputTokens) : null;
    const outputTokens = validOutput ? Number(receipt.outputTokens) : null;
    const tokens = known ? inputTokens! + outputTokens! : null;
    const elapsed = this.requestStarted.get(receipt.requestId);
    const duration = elapsed === undefined ? null : Math.max(0, this.now() - elapsed);
    const reservation = inspection.reservations.find(({ id }) => id === tokenReservationId);
    if (!reservation) throw new Error(`provider request token grant is missing for ${receipt.requestId}`);
    const usageUnknownReason = known
      ? undefined
      : receipt.usageUnknownReason ?? "provider usage was missing or invalid";
    const event = this.event(binding.revision, "provider.request.receipt", `${receipt.requestId}:receipt`, {
      requestId: receipt.requestId,
      attemptId: binding.attemptId,
      unitId: binding.unitId,
      provider: receipt.provider,
      model: receipt.model,
      inputTokens,
      outputTokens,
      usageUnknownReason,
      estimatedCost: receipt.estimatedCost ?? null,
      pricingBasis: receipt.pricingBasis ?? "unknown",
      tokenReservationId,
      durationMs: duration,
    }, binding.unitId, binding.attemptId, undefined, duration);
    const events: MissionEventDraft[] = [event, this.reservationSettlement(binding.revision, reservation, {
      knownCharge: known ? tokens! : reservation.knownCharge,
      unknownCharge: known ? reservation.unknownCharge : reservation.grantAmount - reservation.knownCharge - reservation.released,
      released: known ? Math.max(0, reservation.grantAmount - tokens! - reservation.unknownCharge) : reservation.released,
      source: "host SDK terminal provider hook",
      ...(usageUnknownReason ? { unknownReason: usageUnknownReason } : {}),
    }, `${receipt.requestId}:tokens-settled`, binding.unitId, binding.attemptId)];
    const measurement: MissionMeasurement = {
      schemaVersion: 1,
      id: stableId(`${receipt.requestId}:measurement`),
      missionId: this.missionId,
      revision: binding.revision,
      causalId: stableId(`${receipt.requestId}:measurement-fact`),
      metric: "provider-tokens",
      value: known ? tokens! : null,
      unit: "tokens",
      source: "Pi SDK provider response",
      occurredAt: this.wallNow(),
      runtimeId: this.store.runtimeId,
      durationMs: duration,
      ...(!known ? { unknownReason: usageUnknownReason!, usageUnknownReason: usageUnknownReason! } : {}),
      unitId: binding.unitId,
      attemptId: binding.attemptId,
      provider: receipt.provider,
      model: receipt.model,
      inputTokens,
      outputTokens,
    };
    events.push(this.event(binding.revision, "measurement.recorded", `${receipt.requestId}:measurement`, measurement as unknown as Record<string, unknown>, binding.unitId, binding.attemptId, undefined, duration));
    this.store.appendTransition(this.missionId, inspection.version, { events });
    this.requestStarted.delete(receipt.requestId);
  }

  private async reconcileRecoveredActiveWindow(): Promise<void> {
    const inspection = this.store.inspectMission(this.missionId);
    const opened = [...inspection.events].reverse().find((event) => {
      if (event.kind !== "mission.active.window.opened") return false;
      return !inspection.events.some((candidate) => candidate.kind === "mission.active.window.closed" &&
        candidate.payload.windowId === event.payload.windowId);
    });
    if (!opened) return;
    const ownerEpoch = Number(opened.payload.ownerEpoch);
    if (ownerEpoch === this.store.ownerEpoch) {
      if (this.activeWindow?.id === opened.payload.windowId) return;
      this.emit([this.event(inspection.revision, "mission.blocked", `${this.missionId}:active-window-owned`, {
        reason: "active-time window belongs to current writer epoch; T3 must establish owner retirement before recovery",
        windowId: opened.payload.windowId,
      })]);
      return;
    }
    const reservation = inspection.reservations.find(({ id }) => id === opened.payload.reservationId);
    if (!reservation) throw new Error(`active-time grant is missing for window ${String(opened.payload.windowId)}`);
    const unknownTail = Math.max(0, reservation.grantAmount - reservation.knownCharge - reservation.unknownCharge - reservation.released);
    const windowId = String(opened.payload.windowId);
    const settlement = this.reservationSettlement(inspection.revision, reservation, {
      knownCharge: reservation.knownCharge,
      unknownCharge: reservation.unknownCharge + unknownTail,
      released: reservation.released,
      source: "recovery after owner epoch changed",
      unknownReason: "unobservable crash tail retained as unknown authorization; wall time not metered",
    }, `${windowId}:recovery-settlement`);
    const closed = this.event(inspection.revision, "mission.active.window.closed", `${windowId}:recovered-closed`, {
      windowId,
      reservationId: reservation.id,
      durationMs: 0,
      knownCharge: reservation.knownCharge,
      unknownCharge: reservation.unknownCharge + unknownTail,
      unknownTailMs: unknownTail,
      measured: false,
      reason: "owner runtime changed; closed wall time is not measured",
    });
    this.emit([settlement, closed]);
  }

  private async reconcileMissingProviderUsage(): Promise<void> {
    const inspection = this.store.inspectMission(this.missionId);
    const dispatched = inspection.events.filter((event) =>
      event.kind === "provider.request.dispatched" && event.payload.ownerEpoch !== this.store.ownerEpoch);
    const events: MissionEventDraft[] = [];
    for (const dispatch of dispatched) {
      const requestId = String(dispatch.payload.requestId);
      if (inspection.events.some((event) => event.kind === "provider.request.receipt" && event.payload.requestId === requestId)) continue;
      const reservation = inspection.reservations.find(({ id }) => id === dispatch.payload.tokenReservationId);
      if (!reservation) continue;
      const unknownTail = Math.max(0, reservation.grantAmount - reservation.knownCharge - reservation.unknownCharge - reservation.released);
      if (unknownTail === 0) continue;
      const attemptId = String(dispatch.payload.attemptId);
      events.push(this.reservationSettlement(inspection.revision, reservation, {
        knownCharge: reservation.knownCharge,
        unknownCharge: reservation.unknownCharge + unknownTail,
        released: reservation.released,
        source: "recovery of dispatched request without canonical receipt",
        unknownReason: "full bounded provider-token grant retained as unknown exposure",
      }, `${requestId}:recovered-usage-unknown`, optionalString(dispatch.payload.unitId), attemptId));
      const unknownMeasurement: MissionMeasurement = {
        schemaVersion: 1,
        id: stableId(`${requestId}:measurement`),
        missionId: this.missionId,
        revision: inspection.revision,
        causalId: stableId(`${requestId}:measurement-fact`),
        metric: "provider-tokens",
        value: null,
        unit: "tokens",
        source: "unreceipted dispatched provider request",
        occurredAt: this.wallNow(),
        runtimeId: this.store.runtimeId,
        durationMs: null,
        unknownReason: "canonical provider usage receipt is missing after owner runtime change",
        usageUnknownReason: "full bounded provider-token grant retained as unknown exposure",
        unitId: optionalString(dispatch.payload.unitId),
        attemptId,
        provider: optionalString(dispatch.payload.provider) ?? "unknown",
        model: optionalString(dispatch.payload.model) ?? "unknown",
        inputTokens: null,
        outputTokens: null,
      };
      events.push(this.event(inspection.revision, "measurement.recorded", `${requestId}:measurement`, unknownMeasurement as unknown as Record<string, unknown>,
        optionalString(dispatch.payload.unitId), attemptId));
    }
    if (events.length) this.emit(events);
  }

  private async finishActiveInterval(): Promise<void> {
    await this.activeCheckpoint;
    await this.checkActiveTime();
    await this.closeActiveWindow();
  }

  private armActiveCheckpoint(): void {
    if (this.activeTimer) return;
    this.activeTimer = setInterval(() => {
      const check = this.activeCheckpoint.then(() => this.checkActiveTime());
      this.activeCheckpoint = check.catch((error) => {
        this.activeTimeFailure = messageOf(error);
      });
    }, 1000);
  }

  private async checkActiveTimeBeforeEffect(): Promise<void> {
    await this.activeCheckpoint;
    if (this.activeTimeFailure) throw new Error(`active-time checkpoint failed; effects are fenced: ${this.activeTimeFailure}`);
    await this.checkActiveTime();
    const state = this.snapshot();
    if (state.admissionFenced) throw new Error(`mission admission is fenced: ${state.admissionFenceReason ?? "resource overage"}`);
    if (this.activeTimeFailure) throw new Error(`active-time renewal failed; effects are fenced: ${this.activeTimeFailure}`);
  }

  private async checkActiveTime(): Promise<void> {
    const window = this.activeWindow;
    if (!window || this.snapshot().state === "paused") return;
    const now = this.now();
    const elapsed = window.fractionalMs + Math.max(0, now - window.lastCheckpointAt);
    const duration = Math.floor(elapsed);
    if (duration < 1) {
      window.fractionalMs = elapsed;
      window.lastCheckpointAt = now;
      return;
    }
    const remaining = window.grantAmount - window.knownCharge - window.unknownCharge - window.released;
    if (duration < remaining) {
      const inspection = this.store.inspectMission(this.missionId);
      const reservation = inspection.reservations.find(({ id }) => id === window.reservationId);
      if (!reservation) throw new Error(`active-time reservation disappeared for window ${window.id}`);
      this.emit([
        this.reservationSettlement(inspection.revision, reservation, {
          knownCharge: window.knownCharge + duration,
          unknownCharge: window.unknownCharge,
          released: window.released,
          source: "mission active-time checkpoint",
        }, `${window.id}:checkpoint:${window.knownCharge + duration}`),
        this.event(inspection.revision, "mission.active.window.checkpointed", `${window.id}:checkpoint:${window.knownCharge + duration}`, {
          windowId: window.id,
          reservationId: window.reservationId,
          durationMs: duration,
          cumulativeKnownMs: window.knownCharge + duration,
          measured: true,
        }),
      ]);
      window.knownCharge += duration;
      window.fractionalMs = elapsed - duration;
      window.lastCheckpointAt = now;
      return;
    }
    // A delayed checkpoint can span a quantum. Charge its tail to newly admitted
    // ordinary capacity, not as an overage on the already exhausted grant.
    await this.closeActiveWindow(remaining);
    if (!this.snapshot().admissionFenced) {
      this.openNextActiveWindow();
      if (this.activeWindow) {
        this.activeWindow.fractionalMs = elapsed - remaining;
        await this.checkActiveTime();
        return;
      }
    }
    // Failed renewal does not erase the measured tail or borrow protected grants.
    const tail = Math.ceil(elapsed - remaining);
    if (tail > 0) {
      const inspection = this.store.inspectMission(this.missionId);
      const reservation = inspection.reservations.find(({ id }) => id === window.reservationId)!;
      this.emit([this.reservationSettlement(inspection.revision, reservation, {
        knownCharge: reservation.knownCharge + tail, unknownCharge: reservation.unknownCharge,
        released: reservation.released, source: "unfunded measured active-time tail",
      }, `${window.id}:unfunded-tail`), this.event(inspection.revision, "mission.active.duration", `${window.id}:unfunded-duration`,
        { durationMs: tail, windowId: window.id }, undefined, undefined, undefined, tail)]);
    }
  }

  private async closeActiveWindow(duration?: number): Promise<void> {
    const window = this.activeWindow;
    if (!window) return;
    const measuredDuration = duration ?? Math.ceil(Math.max(0, window.fractionalMs + this.now() - window.lastCheckpointAt));
    if (this.activeTimer) clearInterval(this.activeTimer);
    this.activeTimer = undefined;
    const inspection = this.store.inspectMission(this.missionId);
    const reservation = inspection.reservations.find(({ id }) => id === window.reservationId);
    if (!reservation) throw new Error(`active-time reservation disappeared for window ${window.id}`);
    const knownCharge = window.knownCharge + measuredDuration;
    const released = Math.max(0, window.grantAmount - knownCharge - window.unknownCharge);
    this.emit([
      this.reservationSettlement(inspection.revision, reservation, {
        knownCharge,
        unknownCharge: window.unknownCharge,
        released,
        source: "mission active-time window close",
      }, `${window.id}:closed-settlement`),
      this.event(inspection.revision, "mission.active.window.closed", `${window.id}:closed`, {
        windowId: window.id,
        reservationId: window.reservationId,
        durationMs: measuredDuration,
        knownCharge,
        unknownCharge: window.unknownCharge,
        measured: true,
      }),
    ]);
    this.activeWindow = undefined;
  }

  private openNextActiveWindow(): void {
    const inspection = this.store.inspectMission(this.missionId);
    const state = reduceMissionEvents(inspection);
    if (state.admissionFenced || ["paused", "cancelled", "completed"].includes(state.state)) return;
    const usage = budgetAmounts(inspection.events, "active-time-ms");
    const active = reduceMissionEvents(inspection).attempts;
    if (Object.values(active).some((attempt) => !attempt.settled && attempt.binding.finalization)) {
      this.emit([this.event(inspection.revision, "budget.admission.fenced", `${this.missionId}:finalization-time-exhausted:${inspection.version}`, {
        reason: "finalization phase exhausted its compiled finite active-time grant",
      })]);
      return;
    }
    const child = Object.values(active).filter((attempt) => !attempt.settled).map(({ binding }) => binding)
      .find((binding) => binding?.consultationId && this.consultationHold(inspection, binding.consultationId, "active-time-ms") > 0 &&
        !inspection.events.some((event) => event.kind === "budget.reservation.adjusted" &&
          event.attemptId === binding.attemptId && event.payload.resource === "active-time-ms"));
    const remaining = inspection.definition.budget.activeTimeMs - usage.ordinary - usage.protected - usage.finalization +
      (child ? this.consultationHold(inspection, child.consultationId!, "active-time-ms") : 0);
    const quantum = Math.min(
      ACTIVE_TIME_QUANTUM_MS,
      inspection.definition.finalization.contractVersion === 1 ? compileFinalizationGrants(inspection.definition).active :
        Math.max(1, Math.ceil(inspection.definition.budget.activeTimeMs / inspection.definition.budget.roleLaunches)),
      remaining,
    );
    if (quantum < 1) {
      this.emit([this.event(inspection.revision, "budget.admission.fenced", `${this.missionId}:active-time-exhausted`, {
        reason: "active-time-ms quantum renewal failed; no ordinary capacity remains",
      })]);
      return;
    }
    try {
      this.requireRootSlack(inspection, "active-time-ms", quantum,
        child ? Math.min(quantum, this.consultationHold(inspection, child.consultationId!, "active-time-ms")) : 0);
    } catch (error) {
      this.emit([this.event(inspection.revision, "budget.admission.fenced", `${this.missionId}:active-time-exhausted`, {
        reason: messageOf(error),
      })]);
      return;
    }
    const windowId = randomUUID();
    const reservationId = stableId(`${this.missionId}:active-window:${windowId}`);
    const startedAt = this.now();
    const window: ActiveTimeWindow = {
      id: windowId, reservationId, grantAmount: quantum, knownCharge: 0, unknownCharge: 0, released: 0,
      fractionalMs: 0, lastCheckpointAt: startedAt, ownerEpoch: this.store.ownerEpoch ?? 0, runtimeId: this.store.runtimeId,
    };
    this.emit([
      ...(child ? this.releaseConsultationMinimum(inspection, child.consultationId!, { "active-time-ms": quantum },
        child.unitId, child.attemptId) : []),
      this.event(inspection.revision, "reservation.created", `reservation:${windowId}:active-time`, {
        reservationId, revision: inspection.revision, resource: "active-time-ms", amount: quantum, purpose: "ordinary",
      }),
      this.event(inspection.revision, "mission.active.window.opened", `${windowId}:opened`, {
        windowId, reservationId, grantAmount: quantum, runtimeId: window.runtimeId,
        ownerEpoch: window.ownerEpoch, engineId: this.engineId, startedMonotonicMs: startedAt,
      }),
    ]);
    this.activeWindow = window;
    this.armActiveCheckpoint();
  }

  private recordResourceWait(unit: MissionUnit, attemptNo: number, error: unknown): void {
    const inspection = this.store.inspectMission(this.missionId);
    const events = [this.event(inspection.revision, "resource.wait", `${this.missionId}:${unit.id}:wait:${attemptNo}`, {
      unitId: unit.id, attemptNo, resource: "root-budget", reason: messageOf(error), waitedMs: 0,
    }, unit.id)];
    this.emit(events);
  }

  private reservationSettlement(
    revision: number,
    reservation: Reservation,
    fields: {
      knownCharge: number;
      unknownCharge: number;
      released: number;
      source: string;
      unknownReason?: string;
    },
    key: string,
    unitId?: string | null,
    attemptId?: string,
  ): MissionEventDraft {
    return this.event(revision, "budget.reservation.settled", key, {
      reservationId: reservation.id,
      resource: reservation.resource,
      ...fields,
    }, unitId ?? undefined, attemptId);
  }

  private emit(
    events: MissionEventDraft[],
    artifacts?: Array<{ bytes: Uint8Array; mediaType: string }>,
  ): MissionEvent[] {
    const inspection = this.store.inspectMission(this.missionId);
    return this.store.appendTransition(this.missionId, inspection.version, { events, artifacts });
  }

  private event(
    revision: number,
    kind: string,
    key: string,
    payload: Record<string, unknown>,
    unitId?: string,
    attemptId?: string,
    durationMs?: number | null,
    monotonicDurationMs?: number | null,
  ): MissionEventDraft {
    return {
      revision,
      kind,
      causalId: stableId(key),
      occurredAt: this.wallNow(),
      monotonicDurationMs: monotonicDurationMs ?? durationMs ?? null,
      unitId: unitId ?? null,
      attemptId: attemptId ?? null,
      reason: typeof payload.reason === "string" ? payload.reason : null,
      payload,
    };
  }

  private nextAttemptNo(state: MissionEngineSnapshot, unitId: string): number {
    return Object.values(state.attempts).filter(({ binding }) => binding.unitId === unitId).length + 1;
  }

}

async function waitForSettlement(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  try { return await Promise.race([promise.then(() => true, () => true), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

function initialSnapshot(missionId: string, revision: number, definition: ReturnType<MissionStore["inspectMission"]>["definition"]): MissionEngineSnapshot {
  return {
    missionId,
    revision,
    state: "prepared",
    units: Object.fromEntries(definition.units.map(({ id }) => [id, { status: "pending" as const, evidenceIds: [] }])),
    attempts: {},
    evidence: [],
    providerRequests: [],
    resourceWaits: [],
    activeTimeMs: 0,
    admissionFenced: false,
    canFinalize: false,
    requiredPredicates: [...definition.finalization.requiredPredicates],
  };
}

function reservationDraft(
  missionId: string,
  revision: number,
  id: string,
  resource: BudgetResource,
  amount: number,
  purpose: ReservationPurpose,
  occurredAt: string,
): MissionEventDraft {
  return {
    revision,
    kind: "reservation.created",
    causalId: stableId(`reservation:${id}`),
    occurredAt,
    unitId: null,
    attemptId: null,
    payload: { reservationId: id, missionId, revision, resource, amount, purpose },
  };
}

function budgetMap(budget: ReturnType<MissionStore["inspectMission"]>["definition"]["budget"]): Record<BudgetResource, number> {
  return {
    "role-launches": budget.roleLaunches,
    "provider-requests": budget.providerRequests,
    tokens: budget.tokens,
    "active-time-ms": budget.activeTimeMs,
    "artifact-bytes": budget.artifactBytes,
  };
}

function isConsultationOutput(result: string): boolean {
  try { return JSON.parse(result)?.format === "mission-consultation-request-v1"; }
  catch { return false; }
}

function budgetAmounts(events: MissionEvent[], resource: BudgetResource): { ordinary: number; protected: number; finalization: number } {
  const totals = { ordinary: 0, protected: 0, finalization: 0 };
  for (const grant of events) {
    if (grant.kind !== "reservation.created" || grant.payload.resource !== resource) continue;
    const id = String(grant.payload.reservationId);
    const settlement = events.filter((event) =>
      (event.kind === "budget.reservation.settled" || event.kind === "budget.reservation.adjusted") &&
      event.payload.reservationId === id).at(-1);
    const amount = settlement?.kind === "budget.reservation.settled"
      ? Number(settlement.payload.knownCharge) + Number(settlement.payload.unknownCharge) +
        Math.max(0, Number(grant.payload.amount) - Number(settlement.payload.knownCharge) -
          Number(settlement.payload.unknownCharge) - Number(settlement.payload.released))
      : settlement
        ? Number(settlement.payload.amount)
        : Number(grant.payload.amount);
    const purpose = grant.payload.purpose ?? "ordinary";
    if (purpose === "protected") totals.protected += amount;
    else if (purpose === "finalization") totals.finalization += amount;
    else totals.ordinary += amount;
  }
  return totals;
}

function allRequiredPredicatesAccepted(state: MissionEngineSnapshot): boolean {
  return Object.values(state.units).every(({ status }) => status === "accepted") && state.requiredPredicates.every((id) =>
    state.evidence.some((evidence) => evidence.predicateId === id && evidence.verdict === "pass"));
}

function createBrief(goal: string, unit: MissionUnit, state: MissionEngineSnapshot, recoveryMode?: "verify" | "repair"): string {
  const dependencies = unit.dependencies.map((id) => {
    const result = state.units[id];
    return `${id}: accepted evidence ${result?.evidenceIds.join(", ") || "unavailable"}`;
  });
  return [
    `Mission goal: ${goal}`,
    `Unit: ${unit.id} (${unit.kind})`,
    ...(recoveryMode === "verify" ? ["Recovery mode: verify the observed recovered candidate first. Do not repeat the original effect or modify candidate files; use read-only checks and report the actual result."] : []),
    ...(recoveryMode === "repair" ? ["Recovery mode: the recovered candidate failed verification. Make only the bounded correction needed for the current predicate, on this fresh candidate. Use existing allowed paths and operations; never repeat the original effect or any external operation."] : []),
    `Role: ${unit.role}`,
    `Inputs: ${unit.inputs.join(", ") || "none"}`,
    `Dependencies: ${dependencies.join("; ") || "none"}`,
    `Outputs: ${unit.outputs.join(", ") || "none"}`,
    "Return findings only. Do not claim completion, evidence, or budget authority.",
  ].join("\n");
}

function resultFromReceipt(attempt: MissionAttemptProjection): AgentRunResult {
  const receipt = attempt.receipt!;
  return {
    instanceId: attempt.binding.attemptId,
    role: String(receipt.role ?? "unknown"),
    status: receipt.status === "completed" ? "completed" : receipt.status === "cancelled" ? "cancelled" : "failed",
    model: (receipt.model ?? { selectedModel: "unknown" }) as AgentRunResult["model"],
    result: "",
    usage: receipt.usage === null ? undefined : receipt.usage as AgentRunResult["usage"],
    requests: receipt.requests as AgentRunResult["requests"],
  };
}

function failedRun(error: unknown): AgentRunResult {
  return {
    instanceId: "mission-runner",
    role: "unknown",
    status: "failed",
    model: { selectedModel: "unknown" },
    result: messageOf(error),
  };
}

function parseRecoveryBase64(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("diagnosis returned non-canonical file bytes");
  return bytes;
}

function unresolvedLegacyHoldUnits(
  store: MissionStore,
  events: readonly MissionEvent[],
  units: readonly MissionUnit[],
): Set<string> {
  const imported = [...events].reverse().find((event) => event.kind === "mission.imported");
  if (!imported) return new Set();
  const allUnits = () => new Set(units.map(({ id }) => id));
  if (imported.payload.holdsKnown !== true || !Array.isArray(imported.payload.holds)) return allUnits();
  const knownUnits = new Set(units.map(({ id }) => id));
  const blocked = new Set<string>();
  for (const hold of imported.payload.holds as Array<Record<string, unknown>>) {
    if (!hold || typeof hold !== "object" || Array.isArray(hold) || typeof hold.holdId !== "string" ||
      !["unresolved", "unknown"].includes(String(hold.disposition)) ||
      (hold.disposition === "unresolved" && typeof hold.unitId !== "string") ||
      ("unitId" in hold && typeof hold.unitId !== "string") || hold.disposition === "unknown") return allUnits();
    if (hold.disposition !== "unresolved" || importedHoldReconciled(store, events, imported, hold)) continue;
    if (typeof hold.unitId !== "string" || !knownUnits.has(hold.unitId)) return allUnits();
    blocked.add(hold.unitId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of units) {
      if (blocked.has(unit.id) || !unit.dependencies.some((dependency) => blocked.has(dependency))) continue;
      blocked.add(unit.id);
      changed = true;
    }
  }
  return blocked;
}

function pendingQuestionUnits(events: readonly MissionEvent[], definition: ReturnType<MissionStore["inspectMission"]>["definition"], store: MissionStore): Set<string> {
  return new Set(pendingQuestionClosure(pendingMissionQuestions(events, store), definition));
}

function recoveryBlockedUnits(
  store: MissionStore,
  inspection: ReturnType<MissionStore["inspectMission"]>,
  sourceRoot?: string,
): Set<string> | null {
  const { events, definition, revision } = inspection;
  if (store.ownerEpoch === null || events.some(({ kind }) => kind === "mission.import.conflict")) return null;
  const reportEvent = [...events].reverse().find(({ kind }) => kind === "mission.recovery.recorded");
  const holds = unresolvedLegacyHoldUnits(store, events, definition.units);
  if (!reportEvent) return holds.size || missionHasUnresolvedEffects(store, events) ||
    reduceMissionEvents(inspection).state === "blocked" ? null : new Set();
  let report: RecoveryReport;
  try {
    const bytes = store.readArtifact(String(reportEvent.payload.reportHash));
    if (sha256(bytes) !== reportEvent.payload.reportHash) return null;
    report = JSON.parse(bytes.toString("utf8")) as RecoveryReport;
  } catch { return null; }
  const disposition = report.disposition;
  if (report.format !== "mission-recovery-report-v2" || report.missionId !== inspection.id ||
    report.revision !== revision || reportEvent.revision !== revision || report.status !== reportEvent.payload.status ||
    !disposition || disposition.version !== 2 || disposition.revision !== revision ||
    disposition.ownerEpoch !== store.ownerEpoch || !Number.isSafeInteger(disposition.observedSeq) ||
    disposition.observedSeq > reportEvent.seq || !Array.isArray(disposition.causes) ||
    report.status === "blocked" && disposition.causes.length === 0 ||
    report.status === "resumed" && disposition.causes.length > 0 ||
    !sourceRoot || !["unchanged", "changed"].includes(report.plan.status) ||
    report.plan.storedHash !== inspection.snapshot.planHash || !report.source.manifest) return null;
  try {
    if (captureWorkspaceImage(sourceRoot).manifest.hash !== report.source.manifest.hash ||
      sha256(readFileSync(path.join(sourceRoot, ".pitako", "plans", `${inspection.planId}.md`))) !== report.plan.observedHash) return null;
  } catch { return null; }
  if (events.some((event) => event.seq > disposition.observedSeq && event.seq !== reportEvent.seq &&
    (event.kind === "effect.observation.recorded" && event.payload.episodeId !== report.episodeId ||
      ["mission.revised", "mission.import.conflict", "mission.blocked", "mission.hold.reconciled", "effect.unknown"].includes(event.kind)))) return null;
  const roots = new Set<string>();
  const coveredHolds = new Set<string>();
  const coveredEffects = new Set<string>();
  for (const cause of disposition.causes) {
    if (cause.scope !== "unit" || typeof cause.unitId !== "string" ||
      !definition.units.some((unit) => unit.id === cause.unitId)) return null;
    const source = events.find((event) => event.eventId === cause.sourceEventId && event.seq <= disposition.observedSeq);
    if (!source || sha256(Buffer.from(JSON.stringify(source.payload))) !== cause.proofHash && !cause.id.startsWith("overlap:")) return null;
    if (cause.id.startsWith("hold:")) {
      const holdId = cause.id.slice(5);
      if (source.kind !== "mission.imported" || source.payload.holdsKnown !== true ||
        !Array.isArray(source.payload.holds) || !source.payload.holds.some((hold: Record<string, unknown>) =>
          hold.holdId === holdId && hold.unitId === cause.unitId && hold.disposition === "unresolved") ||
        importedHoldReconciled(store, events, source, source.payload.holds.find((hold: Record<string, unknown>) => hold.holdId === holdId))) return null;
      coveredHolds.add(holdId);
    } else if (cause.id.startsWith("effect:")) {
      const effectId = cause.id.slice(7);
      const reserved = events.find((event) => event.kind === "attempt.reserved" && event.attemptId === source.attemptId);
      if (source.kind !== "effect.intent" || source.effectId !== effectId ||
        (reserved?.payload.binding as MissionAttemptBinding | undefined)?.unitId !== cause.unitId ||
        !missionHasUnresolvedEffects(store, events.filter((event) => !event.effectId || event.effectId === effectId))) return null;
      coveredEffects.add(effectId);
    } else if (cause.id.startsWith("overlap:")) {
      if (source.kind !== "attempt.reserved" || (source.payload.binding as MissionAttemptBinding | undefined)?.unitId !== cause.unitId ||
        cause.proofHash !== cause.id.slice(8)) return null;
    } else if (cause.id.startsWith("pause:")) {
      if (source.kind !== "attempt.reserved" || (source.payload.binding as MissionAttemptBinding).unitId !== cause.unitId ||
        source.attemptId !== cause.id.slice(6)) return null;
    } else return null;
    roots.add(cause.unitId);
  }
  const imported = [...events].reverse().find((event) => event.kind === "mission.imported");
  if (imported && (imported.payload.holdsKnown !== true || !Array.isArray(imported.payload.holds) ||
    imported.payload.holds.some((hold: Record<string, unknown>) => hold.disposition === "unresolved" &&
      !importedHoldReconciled(store, events, imported, hold) &&
      !coveredHolds.has(String(hold.holdId))))) return null;
  const effectIds = new Set(events.filter((event) => event.effectId).map((event) => event.effectId!));
  for (const effectId of effectIds) {
    if (missionHasUnresolvedEffects(store, events.filter((event) => !event.effectId || event.effectId === effectId)) &&
      !coveredEffects.has(effectId)) return null;
  }
  const blocked = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of definition.units) {
      if (blocked.has(unit.id) || !unit.dependencies.some((dependency) => blocked.has(dependency))) continue;
      blocked.add(unit.id);
      changed = true;
    }
  }
  if ([...holds].some((unitId) => !blocked.has(unitId))) return null;
  return blocked;
}

function missionNeedsRecovery(
  store: MissionStore,
  inspection: ReturnType<MissionStore["inspectMission"]>,
  sourceRoot: string,
  planFile: string,
): boolean {
  if (inspection.events.some(({ kind }) => kind === "mission.import.conflict")) return true;
  if (inspection.events.some((event) => event.kind === "attempt.settled" && event.payload.status === "interrupted" &&
    linkedPauseId(event.payload) && !inspection.events.some((row) => row.kind === "attempt.reserved" &&
      (row.payload.binding as MissionAttemptBinding).recoveryOf === event.attemptId))) return true;
  if ([...inspection.events].reverse().find(({ kind }) => kind === "mission.recovery.recorded")?.payload.status === "blocked") return true;
  const attempts = inspection.events.filter((event) => event.kind === "attempt.reserved");
  if (attempts.some((event) => {
    const attemptId = String(event.payload.attemptId);
    const relevant = inspection.events.filter((row) => row.attemptId === attemptId || row.payload.attemptId === attemptId);
    return !relevant.some((row) => row.kind === "attempt.settled") &&
      (relevant.some((row) => row.kind === "attempt.interrupted") ||
        (relevant.some((row) => row.kind === "attempt.started") && !relevant.some((row) => row.kind === "attempt.receipt")));
  })) return true;
  if (reduceMissionEvents(inspection).state === "blocked") return true;
  if (missionHasUnresolvedEffects(store, inspection.events) || inspection.events.some((event) =>
    event.kind === "effect.intent" && typeof event.payload.effectPlanHash === "string")) return true;
  const imported = [...inspection.events].reverse().find((event) => event.kind === "mission.imported");
  if (imported && imported.payload.holdsKnown !== true) return true;
  if (Array.isArray(imported?.payload.holds) && imported!.payload.holds.some((hold: Record<string, unknown>) =>
    hold.disposition === "unresolved" && !importedHoldReconciled(store, inspection.events, imported!, hold))) return true;
  if (!inspection.events.some((event) => event.kind === "evidence.recorded")) return false;
  const prior = [...inspection.events].reverse().find((event) => event.kind === "mission.recovery.recorded");
  if (!prior) return true;
  try {
    const report = JSON.parse(store.readArtifact(String(prior.payload.reportHash)).toString("utf8")) as {
      source?: { manifest?: { hash?: string } | null };
      plan?: { observedHash?: string | null };
    };
    if (report.source?.manifest?.hash !== captureWorkspaceImage(sourceRoot).manifest.hash) return true;
    const currentPlanHash = existsSync(planFile) ? sha256(readFileSync(planFile)) : null;
    return report.plan?.observedHash !== currentPlanHash;
  } catch { return true; }
}

function readPredicateInputBinding(
  store: MissionStore,
  binding: MissionAttemptBinding,
  predicateId: string,
): MissionPredicateInputBinding | undefined {
  if (!binding.predicateInputBindingsHash) return undefined;
  try {
    const bytes = store.readArtifact(binding.predicateInputBindingsHash);
    if (sha256(bytes) !== binding.predicateInputBindingsHash) return undefined;
    const artifact = JSON.parse(bytes.toString("utf8")) as { format?: string; bindings?: MissionPredicateInputBinding[] };
    if (artifact.format !== "mission-predicate-input-bindings-v1" || !Array.isArray(artifact.bindings)) return undefined;
    const found = artifact.bindings.find((row) => row.predicateId === predicateId);
    if (!found || !found.complete || found.inputBindingHash !== hashJson({
      predicateId: found.predicateId, predicateHash: found.predicateHash, inputPatterns: found.inputPatterns, inputPaths: found.inputPaths,
      inputIndexEntries: found.inputIndexEntries, rolePolicyHash: found.rolePolicyHash, dependencyEvidence: found.dependencyEvidence,
      assessmentToolIdentity: found.assessmentToolIdentity, runtimeIdentity: found.runtimeIdentity,
    })) return undefined;
    return found;
  } catch { return undefined; }
}

function capturePredicateInputBindings(
  root: string | undefined,
  unit: MissionUnit,
  allowedPaths: readonly string[],
  rolePolicyHash: string,
  dependencyEvidence: MissionPredicateInputBinding["dependencyEvidence"],
  dependenciesComplete: boolean,
  assessmentToolIdentity: string,
  runtimeIdentity: string,
): MissionPredicateInputBinding[] {
  let paths: ManifestPath[] = [];
  let indexEntries: MissionPredicateInputBinding["inputIndexEntries"] = [];
  let complete = Boolean(root) && dependenciesComplete;
  try {
    if (root) {
      paths = captureWorkspacePaths(root);
      indexEntries = captureWorkspaceImage(root).manifest.indexEntries;
    }
  } catch { complete = false; }
  return unit.acceptance.map((predicate) => {
    const production = assessmentToolIdentity === MISSION_CHECK_IDENTITY;
    const inputPatterns = [...new Set(production && !unit.inputs.length ? ["."] : unit.inputs)].sort();
    const inScope = (name: string) => inputPatterns.some((pattern) => missionPathMatches(pattern, name)) &&
      (production || allowedPaths.some((pattern) => missionPathMatches(pattern, name)));
    const inputPaths = complete ? paths.filter(({ path: name }) => inScope(name)) : [];
    const inputIndexEntries = complete ? indexEntries.filter(({ path: name }) => inScope(name)) : [];
    const predicateHash = hashJson(predicate);
    const inputBindingHash = hashJson({ predicateId: predicate.id, predicateHash, inputPatterns, inputPaths, inputIndexEntries,
      rolePolicyHash, dependencyEvidence, assessmentToolIdentity, runtimeIdentity });
    return { predicateId: predicate.id, predicateHash, inputPatterns, inputPaths, inputIndexEntries, rolePolicyHash,
      dependencyEvidence, assessmentToolIdentity, runtimeIdentity, inputBindingHash, complete };
  });
}

function missionPathMatches(pattern: string, name: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/\/\*\*$/, "").replace(/\/$/, "");
  return normalized === "." || normalized === "*" || normalized === "/" || normalized === name || name.startsWith(`${normalized}/`);
}

function stableId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const raw = hex.join("");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export function missionAssessmentToolIdentity(adapter: MissionEngineOptions["assessPredicate"]): string {
  return adapter ? sha256(Buffer.from(adapter.toString())) : MISSION_CHECK_IDENTITY;
}

export function missionRuntimeIdentity(): string {
  return process.versions.bun ? `bun:${process.versions.bun}` : `node:${process.version}`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
