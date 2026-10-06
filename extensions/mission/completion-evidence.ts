import { sha256, type MissionEvent } from "./model.ts";
import type { MissionStore } from "./store.ts";
import { assertCompleteWorkspaceImage, readHistoricalPauseInterruption, readSealedWorkspaceImage,
  recoveryEffectObservationIsBound } from "./reconcile.ts";
import type { MissionAttemptBinding } from "./engine.ts";

// This is a completion-only audit, not the operational effect resolver. Keep this
// catalog exhaustive with store.EVENT_KINDS; an unfamiliar persisted row fails closed.
export const COMPLETION_AUDIT_POLICY: Record<string, "ordinary" | "attempt" | "effect" | "snapshot" | "report" | "owner"> = Object.fromEntries([
  ...[
    "mission.created", "mission.activated", "mission.result.integrated", "mission.completed", "mission.blocked", "mission.active.duration",
    "mission.finalization.generation", "mission.finalization.phase.started", "mission.finalization.phase.receipted",
    "mission.finalization.invalidated", "mission.finalization.reviewed", "mission.finalization.output.inconclusive", "mission.finalization.published",
    "mission.revised", "mission.paused", "mission.resumed", "mission.cancelled", "mission.input.recorded",
    "mission.input.visible", "mission.notification.delivered", "mission.imported", "mission.import.conflict",
    "mission.hold.reconciled", "reservation.created", "measurement.recorded", "evaluation.observed",
    "unit.ready", "unit.verifying", "unit.accepted", "unit.blocked", "evidence.recorded", "evidence.invalidated",
    "team.member.recorded", "team.barrier.recorded", "team.consultation.admitted", "team.consultation.denied", "team.consultation.resolved", "team.consultation.cancelled", "team.consultation.revalidated",
    "evidence.reused", "provider.request.dispatched", "provider.request.receipt", "provider.usage.claimed",
    "budget.reservation.adjusted", "budget.reservation.settled", "budget.admission.fenced",
    "mission.active.window.opened", "mission.active.window.checkpointed", "mission.active.window.closed",
    "resource.wait", "dispatch.observed", "workspace.candidate.registered", "workspace.candidate.relocated",
    "mission.recovery.diagnosed", "mission.recovery.continuation", "mission.recovery.continuation.recorded",
    "mission.recovery.repair.authorized", "mission.recovery.repair.started", "mission.recovery.repair.settled",
    // Root setup has its own physical-disposal/input/output audit in assessMissionCompletion.
    "mission.setup.intent", "mission.setup.invoking", "mission.setup.receipt", "mission.setup.reconciled", "mission.setup.reused",
  ].map((kind) => [kind, "ordinary"]),
  ...["attempt.reserved", "attempt.started", "attempt.interrupted", "attempt.receipt", "attempt.settled"].map((kind) => [kind, "attempt"]),
  ...["effect.denied", "effect.intent", "effect.invoking", "effect.process.registered", "effect.released",
    "effect.receipt", "effect.unknown", "effect.observation.recorded", "effect.reconciled"].map((kind) => [kind, "effect"]),
  ["workspace.snapshot.sealed", "snapshot"], ["mission.recovery.recorded", "report"], ["mission.owner.released", "owner"],
]) as Record<string, "ordinary" | "attempt" | "effect" | "snapshot" | "report" | "owner">;

const ATTEMPT_ROLES: Record<string, string> = {
  "mission.recovery.continuation.recorded": "sourceAttemptId",
  "mission.recovery.repair.authorized": "verificationAttemptId",
  "mission.recovery.repair.started": "repairAttemptId",
};

type CompletionRow = Pick<MissionEvent, "kind" | "effectId" | "attemptId" | "payload"> &
  Partial<Pick<MissionEvent, "eventId" | "seq" | "revision" | "missionId" | "unitId">>;
type EffectRow = Pick<MissionEvent, "kind" | "payload">;
type NoEffect = "denied" | "unstarted" | "launch-gate" | null;
const hash = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object evidence missing");
  return value as Record<string, unknown>;
}

/** Positive discharge is the actual contained producer chain, never a recovery label. */
function containedEffect(rows: readonly CompletionRow[], store: MissionStore): boolean {
  try {
    if (rows.map((row) => row.kind).join() !== [
      "effect.intent", "effect.invoking", "effect.process.registered", "effect.released",
      "effect.receipt", "workspace.snapshot.sealed",
    ].join()) return false;
    const [intent, invoking, registered, released, terminal, snapshot] = rows;
    const p = intent!.payload;
    const plan = JSON.parse(store.readArtifact(String(p.effectPlanHash)).toString());
    const identity = object(registered!.payload.identity);
    const process = object(terminal!.payload.process);
    if (plan.format !== "mission-effect-plan-v1" || plan.operation !== p.operation ||
      hash(plan.request) !== p.requestHash || invoking!.payload.requestHash !== p.requestHash ||
      invoking!.payload.effectPlanHash !== p.effectPlanHash ||
      hash(invoking!.payload.owner) !== hash(p.owner) || hash(registered!.payload.owner) !== hash(p.owner) ||
      released!.payload.requestHash !== p.requestHash || hash(released!.payload.processIdentity) !== hash(identity) ||
      terminal!.payload.requestHash !== p.requestHash || terminal!.payload.operation !== p.operation ||
      hash(terminal!.payload.owner) !== hash(p.owner) || !["completed", "failed"].includes(String(terminal!.payload.status)) ||
      process?.descendantsQuiescent !== true ||
      process.namespaceEmptyAfterExit !== true || hash({ ...process, descendantsQuiescent: undefined, namespaceEmptyAfterExit: undefined }) !== hash(identity) ||
      !Number.isSafeInteger(identity.pid) || !Number.isSafeInteger(identity.birthTicks) ||
      typeof identity.pidNamespace !== "string" || !identity.pidNamespace ||
      snapshot!.payload.phase !== "effect" || hash(snapshot!.payload.candidateIdentity) !== hash(p.candidateIdentity) ||
      hash(snapshot!.payload.candidateGitIdentity) !== hash(p.candidateGitIdentity) ||
      rows.some((row) => row.attemptId !== intent!.attemptId || row.revision !== intent!.revision ||
        row.missionId !== intent!.missionId || row.unitId !== intent!.unitId) ||
      rows.some((row, index) => index > 0 && row.seq! <= rows[index - 1]!.seq!)) return false;
    const image = readSealedWorkspaceImage(store, String(snapshot!.payload.imageHash));
    return image.manifest.hash === snapshot!.payload.manifestHash && Array.isArray(terminal!.payload.paths);
  } catch { return false; }
}

function positiveEffect(rows: readonly CompletionRow[], store: MissionStore,
  inspection?: ReturnType<MissionStore["inspectMission"]>): boolean {
  const prefix = rows.slice(0, 6);
  const intent = prefix[0];
  return prefix.find((row) => row.kind === "effect.receipt")?.payload.termination === "exit" &&
    containedEffect(prefix, store) && rows.slice(6).every((row) => recoveryEffectObservationIsBound(store,
      inspection ?? store.inspectMission(String(intent!.missionId)), row, prefix));
}

/** Safety/accounting discharge only. The persisted receipt remains failed/signal. */
function interruptedEffect(rows: readonly CompletionRow[], store: MissionStore,
  inspection?: ReturnType<MissionStore["inspectMission"]>): boolean {
  try {
    const intent = rows.find((row) => row.kind === "effect.intent");
    if (!intent?.attemptId || !intent.missionId || String(intent.payload.operation).startsWith("external:") ||
      intent.payload.recovery === "external-probe-required") return false;
    const source = readHistoricalPauseInterruption(store, inspection ?? store.inspectMission(intent.missionId), intent.attemptId);
    const prefix = rows.filter((row) => row.seq! <= source.proof.journalWatermark);
    const terminal = prefix.find((row) => row.kind === "effect.receipt");
    return source.proof.effects.some(({ effectId }) => effectId === intent.effectId) &&
      terminal?.payload.status === "failed" && terminal.payload.termination === "signal" &&
      Number.isSafeInteger(terminal.payload.exitCode) && terminal.payload.exitCode !== 0 && containedEffect(prefix, store);
  } catch { return false; }
}

function terminalWriter(rows: readonly CompletionRow[], store: MissionStore, effectsClear: boolean,
  inspection?: ReturnType<MissionStore["inspectMission"]>): boolean {
  try {
    if (!effectsClear) return false;
    const reserved = rows.filter((row) => row.kind === "attempt.reserved");
    const started = rows.filter((row) => row.kind === "attempt.started");
    const receipts = rows.filter((row) => row.kind === "attempt.receipt");
    const settlements = rows.filter((row) => row.kind === "attempt.settled");
    if (reserved.length !== 1 || started.length !== 1 || settlements.length !== 1) return false;
    const r = reserved[0]!, s = started[0]!, t = settlements[0]!;
    const binding = object(r.payload.binding) as unknown as MissionAttemptBinding;
    const history = inspection ?? store.inspectMission(binding.missionId);
    const recoveryBookkeeping = (row: CompletionRow) => {
      if (!["effect.reconciled", "mission.recovery.recorded"].includes(row.kind)) return false;
      return history.events.some((observation) => observation.kind === "effect.reconciled" &&
        observation.attemptId === binding.attemptId &&
        (row.kind === "effect.reconciled" ? observation.eventId === row.eventId :
          observation.payload.episodeId === row.payload.episodeId) &&
        recoveryEffectObservationIsBound(store, history, observation, history.events.filter((event) =>
          event.effectId === observation.effectId &&
          (event.kind.startsWith("effect.") || event.kind === "workspace.snapshot.sealed" && event.payload.phase === "effect")).slice(0, 6)));
    };
    if (t.payload.status === "interrupted" && t.payload.interruption && object(t.payload.interruption).kind === "host-pause") {
      readHistoricalPauseInterruption(store, inspection ?? store.inspectMission(binding.missionId), binding.attemptId);
      return true;
    }
    if (r.seq! >= s.seq! || s.seq! >= t.seq! || binding.attemptId !== r.attemptId ||
      binding.missionId !== r.missionId || binding.revision !== r.revision ||
      rows.some((row) => row.revision !== r.revision && !recoveryBookkeeping(row) || row.seq! > t.seq! &&
        ["attempt.started", "dispatch.observed", "provider.request.dispatched", "workspace.candidate.registered"].includes(row.kind))) return false;
    // Host phases launch no SDK writer; their exact receipt proves synchronous settlement.
    if (binding.finalization && ["integrate", "integrated-checks", "affected-checks", "final-gates"].includes(binding.finalization.phase)) {
      const bytes = store.readArtifact(String(t.payload.resultHash));
      const phase = JSON.parse(bytes.toString());
      return receipts.length === 0 && t.payload.status === "succeeded" &&
        phase.format === "mission-finalization-phase-v1" && phase.attemptId === r.attemptId &&
        hash(phase.target) === hash(binding.finalization) && phase.sessionId === null && phase.instanceId === null;
    }
    if (receipts.length !== 1) return false;
    const c = receipts[0]!;
    if (c.seq! <= s.seq! || c.seq! >= t.seq! || c.payload.sdkDisposed !== true ||
      c.payload.artifactHash !== c.payload.resultHash || t.payload.resultHash !== c.payload.artifactHash ||
      sha256(store.readArtifact(String(c.payload.artifactHash))) !== c.payload.artifactHash) return false;
    const checkpoint = rows.find((row) => row.kind === "workspace.snapshot.sealed" && row.payload.purpose === "consultation");
    if (checkpoint && t.payload.status === "yielded") {
      const proof = JSON.parse(store.readArtifact(String(checkpoint.payload.checkpointHash)).toString());
      return proof.format === "mission-consultation-checkpoint-v1" && proof.sourceAttemptId === r.attemptId &&
        proof.sourceBindingHash === hash(binding) && proof.receiptEventId === c.eventId &&
        proof.receiptHash === hash(c.payload) && proof.sdkDisposed === true && proof.effectsShutdown === true &&
        checkpoint.seq! > c.seq! && checkpoint.seq! < t.seq! &&
        !rows.some((row) => row.seq! > checkpoint.seq! && (row.kind.startsWith("effect.") || row.kind === "workspace.snapshot.sealed"));
    }
    // A completed SDK writer may fail host verification. The terminal proof
    // discharges that writer, not its acceptance predicates.
    if (c.payload.status !== "completed" || !["succeeded", "failed"].includes(String(t.payload.status)) ||
      !c.payload.terminalOutputHash) return false;
    const proof = JSON.parse(store.readArtifact(String(c.payload.terminalOutputHash)).toString());
    if (proof.format !== "mission-terminal-output-v1" || proof.bindingHash !== hash(binding) ||
      proof.resultHash !== c.payload.artifactHash || proof.instanceId !== c.payload.instanceId ||
      proof.sdkDisposed !== true || proof.effectsQuiescent !== true || proof.writersQuiescent !== true) return false;
    assertCompleteWorkspaceImage(readSealedWorkspaceImage(store, proof.terminalImageHash));
    // Post-receipt verification owns its own fully proven contained process, not the SDK writer.
    return !rows.some((row) => row.seq! > c.seq! &&
      ["attempt.started", "dispatch.observed", "provider.request.dispatched", "workspace.candidate.registered", "attempt.interrupted"].includes(row.kind));
  } catch { return false; }
}
const keys: Record<string, readonly string[]> = {
  "effect.intent": ["effectId", "operation", "requestHash", "effectPlanHash", "missionId", "revision", "unitId", "attemptId",
    "owner", "candidate", "candidateId", "candidateIdentity", "candidateGitIdentity", "candidateGitDir",
    "candidateArenaRoot", "candidateArenaIdentity", "inputManifestHash", "candidateManifestHash", "recovery",
    "recoveryMode", "recoveryImageHash", "repairAuthorizationId", "grantId", "target", "operationKey",
    "idempotencyKey", "adapterId", "adapterVersion"],
  "effect.invoking": ["effectId", "operation", "owner", "requestHash", "effectPlanHash"],
  "effect.denied": ["effectId", "operation", "reason", "missionId", "revision", "unitId", "attemptId", "owner"],
  "effect.receipt": ["effectId", "operation", "status", "paths", "requestHash", "owner", "reason", "process"],
  "effect.reconciled": ["effectId", "disposition", "reason", "observedBy", "episodeId"],
  "workspace.snapshot.sealed": ["attemptId", "effectId", "phase", "imageHash", "manifestHash", "manifest",
    "candidateRoot", "candidateIdentity", "candidateGitIdentity", "candidateArenaRoot", "candidateArenaIdentity", "artifactBytes"],
};

/** Closed grammar also recognizes a prelaunch-only launch gate for T4 observation. */
export function classifyNoEffect(rows: readonly EffectRow[]): NoEffect {
  if (!rows.length) return null;
  const history = rows.filter(({ kind, payload }) => kind !== "workspace.snapshot.sealed" || payload.phase !== "base");
  const intent = rows.find(({ kind }) => kind === "effect.intent")?.payload;
  for (const { kind, payload } of rows) {
    if (intent && ["operation", "requestHash", "effectPlanHash", "owner"].some((key) =>
      payload[key] !== undefined && intent[key] !== undefined &&
      JSON.stringify(payload[key]) !== JSON.stringify(intent[key]))) return null;
    if (kind === "workspace.snapshot.sealed" && payload.phase === "base" &&
      Object.keys(payload).every((key) => keys[kind]!.includes(key))) continue;
    if (!keys[kind] || Object.keys(payload).some((key) => !keys[kind]!.includes(key))) return null;
    if (kind === "effect.receipt" && (payload.status !== "denied" || payload.process !== null ||
      !Array.isArray(payload.paths) || payload.paths.length !== 0)) return null;
    if (kind === "effect.reconciled" && payload.disposition !== "unstarted") return null;
  }
  if (history.length === 1 && history[0]!.kind === "effect.denied") return "denied";
  if (history[0]?.kind !== "effect.intent") return null;
  let stage: "intent" | "invoking" | "terminal" = "intent";
  let terminal: "denied" | "unstarted" | null = null;
  let receipt = false;
  for (const { kind } of history.slice(1)) {
    if (kind === "effect.invoking" && stage === "intent") stage = "invoking";
    else if (kind === "effect.denied" && stage !== "terminal") { stage = "terminal"; terminal = "denied"; }
    else if (kind === "effect.receipt" && !receipt && (stage !== "terminal" || terminal === "denied")) {
      receipt = true; stage = "terminal"; terminal = "denied";
    } else if (kind === "effect.reconciled" && stage === "intent") { stage = "terminal"; terminal = "unstarted"; }
    else if (kind === "effect.reconciled" && stage === "terminal") { /* Repeated plain summaries do not launch work. */ }
    else return null;
  }
  return terminal ?? (stage === "intent" ? "launch-gate" : null);
}

export interface CompletionExposure { effects: string[]; writers: string[] }

export function auditCompletionEvidence(events: readonly CompletionRow[], store: MissionStore,
  inspection?: ReturnType<MissionStore["inspectMission"]>): CompletionExposure {
  const effects = new Map<string, { rows: CompletionRow[]; exposed: boolean; conflicting: boolean; attemptIds: Set<string> }>();
  const attempts = new Map<string, { rows: CompletionRow[]; conflicting: boolean }>();
  const effectBlocks = new Set<string>();
  const writerBlocks = new Set<string>();
  const effect = (id: string) => {
    let group = effects.get(id);
    if (!group) { group = { rows: [], exposed: false, conflicting: false, attemptIds: new Set() }; effects.set(id, group); }
    return group;
  };
  const attempt = (id: string) => {
    let group = attempts.get(id);
    if (!group) { group = { rows: [], conflicting: false }; attempts.set(id, group); }
    return group;
  };
  const bind = (category: "effect" | "writer", canonical: unknown, aliases: unknown[], row?: CompletionRow) => {
    const block = category === "effect" ? effectBlocks : writerBlocks;
    const names = [canonical, ...aliases.filter((value) => value !== undefined && value !== null)];
    const ids = [...new Set(names.filter((value): value is string => typeof value === "string" && value.length > 0))];
    const mismatch = ids.length > 1 || names.some((value) => typeof value !== "string" || !value);
    if (typeof canonical !== "string" || !canonical) block.add(`${category}:unbound`);
    for (const id of ids) {
      const group = category === "effect" ? effect(id) : attempt(id);
      group.conflicting ||= mismatch || canonical !== id;
      if (row) group.rows.push(row);
    }
    if (!ids.length) block.add(`${category}:unbound`);
    return ids;
  };
  const effectClaim = (id: unknown, exposed: boolean, attemptId?: unknown) => {
    const ids = bind("effect", id, []);
    for (const name of ids) {
      effect(name).exposed ||= exposed;
      if (typeof attemptId === "string" && attemptId) effect(name).attemptIds.add(attemptId);
      else if (attemptId !== undefined && attemptId !== null) {
        effect(name).conflicting = true;
        writerBlocks.add("writer:unbound");
      }
    }
    if (exposed && attemptId !== undefined && attemptId !== null) bind("writer", attemptId, []);
  };
  for (const row of events) {
    const { kind, payload } = row;
    const policy = COMPLETION_AUDIT_POLICY[kind];
    if (!Object.hasOwn(COMPLETION_AUDIT_POLICY, kind)) {
      effectBlocks.add("effect:unbound"); writerBlocks.add("writer:unbound"); continue;
    }
    if (policy === "effect" || policy === "snapshot" && row.effectId !== null) {
      const ids = bind("effect", row.effectId, [payload.effectId], policy === "effect" || payload.phase === "effect" ? row : undefined);
      if (policy === "snapshot" && payload.phase !== "base") for (const id of ids) effect(id).exposed = true;
      if (policy === "effect" && !keys[kind]) for (const id of ids) effect(id).exposed = true;
      for (const id of ids) {
        const group = effect(id);
        if (row.attemptId) group.attemptIds.add(row.attemptId);
        if (typeof payload.attemptId === "string" && payload.attemptId) group.attemptIds.add(payload.attemptId);
        if (payload.attemptId !== undefined && payload.attemptId !== row.attemptId) {
          group.conflicting = true;
          bind("writer", row.attemptId, [payload.attemptId]);
        }
      }
    } else if (row.effectId !== null || payload.effectId !== undefined) {
      const ids = bind("effect", row.effectId, [payload.effectId]);
      for (const id of ids) effect(id).exposed = true;
    }
    if (policy === "snapshot") {
      if (payload.phase !== "base" && row.effectId === null && payload.effectId !== undefined) effectClaim(payload.effectId, true, row.attemptId);
      if (payload.phase !== "base" && row.effectId === null && payload.effectId === undefined &&
        (!(["observed", "recovered"].includes(String(payload.phase))) ||
          row.attemptId === null)) effectBlocks.add("effect:unbound");
      if (payload.phase !== "base" && row.effectId === null && payload.effectId === undefined &&
        row.attemptId === null) writerBlocks.add("writer:unbound");
      if (payload.phase === "base" && Object.keys(payload).some((key) => !keys[kind]!.includes(key))) {
        if (row.effectId) effect(row.effectId).exposed = true;
        else effectBlocks.add("effect:unbound");
      }
      if (payload.phase === "base" && payload.attemptId !== undefined && payload.attemptId !== row.attemptId)
        bind("writer", row.attemptId, [payload.attemptId]);
    }
    // Recovery diagnosis has its own read-only diagnosis attempt ID. Its source attempt
    // is a different role; it is not a worker receipt for either subject.
    if (kind === "mission.recovery.diagnosed") {
      const admission = payload.admission as Record<string, unknown> | undefined;
      if (payload.attemptId !== undefined && admission?.attemptId !== undefined &&
        payload.attemptId !== admission.attemptId) bind("writer", payload.attemptId, [admission.attemptId]);
      continue;
    }
    if (policy === "attempt" || policy === "ordinary" && (row.attemptId !== null || payload.attemptId !== undefined ||
      ATTEMPT_ROLES[kind] && payload[ATTEMPT_ROLES[kind]!] !== undefined)) {
      const aliases = [payload[ATTEMPT_ROLES[kind] ?? "attemptId"],
        ...(kind === "attempt.reserved" ? [(payload.binding as Record<string, unknown> | undefined)?.attemptId] : [])];
      bind("writer", row.attemptId, aliases, policy === "attempt" ||
        ["dispatch.observed", "provider.request.dispatched", "provider.request.receipt", "workspace.candidate.registered"].includes(kind)
        ? row : undefined);
      if (kind === "mission.recovery.repair.authorized" && payload.sourceAttemptId !== undefined)
        bind("writer", payload.sourceAttemptId, []);
    }
    if (policy === "effect" && (row.attemptId !== null || payload.attemptId !== undefined))
      bind("writer", row.attemptId, [payload.attemptId], row);
    if (policy === "snapshot" && payload.phase !== "base" && (row.attemptId !== null || payload.attemptId !== undefined))
      bind("writer", row.attemptId, [payload.attemptId], row);
    if (policy === "owner") {
      if (!Array.isArray(payload.interruptedAttempts) && payload.interruptedAttempts !== undefined) writerBlocks.add("writer:unbound");
      else for (const id of (payload.interruptedAttempts as unknown[] | undefined) ?? []) bind("writer", id, []);
    }
    if (policy === "report") {
      try {
        const hash = payload.reportHash;
        if (typeof hash !== "string") throw new Error("missing report");
        const bytes = store.readArtifact(hash);
        if (sha256(bytes) !== hash) throw new Error("changed report");
        const report = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        if (report.format !== "mission-recovery-report-v2" || report.missionId !== row.missionId ||
          report.revision !== row.revision || report.episodeId !== payload.episodeId ||
          !Array.isArray(report.effects)) throw new Error("malformed report");
        for (const item of report.effects) {
          if (!item || typeof item !== "object" || Array.isArray(item)) { effectBlocks.add("effect:unbound"); continue; }
          const claim = item as Record<string, unknown>;
          const originalOperation = effects.get(String(claim.effectId))?.rows
            .find(({ kind }) => kind === "effect.intent")?.payload.operation;
          const plain = Object.keys(claim).every((key) =>
            ["effectId", "attemptId", "operation", "disposition", "reason"].includes(key)) &&
            claim.disposition === "unstarted" && typeof claim.effectId === "string" && !!claim.effectId &&
            (claim.attemptId === null || typeof claim.attemptId === "string" && !!claim.attemptId) &&
            typeof claim.operation === "string" && !!claim.operation &&
            (originalOperation === undefined || claim.operation === originalOperation) &&
            (claim.reason === undefined || typeof claim.reason === "string");
          effectClaim(claim.effectId, !plain, claim.attemptId);
          if (!plain && claim.attemptId !== null && claim.attemptId !== undefined)
            bind("writer", claim.attemptId, [], row);
        }
        const causes = (report.disposition as Record<string, unknown> | undefined)?.causes;
        if (causes !== undefined && !Array.isArray(causes)) effectBlocks.add("effect:unbound");
        for (const cause of Array.isArray(causes) ? causes : []) {
          if (cause && typeof cause === "object" && typeof cause.id === "string" && cause.id.startsWith("effect:"))
            effectClaim(cause.id.slice(7), true);
        }
      } catch { effectBlocks.add("effect:unbound"); }
    }
    if (kind === "mission.recovery.continuation.recorded") {
      if (!Array.isArray(payload.effectIds)) effectBlocks.add("effect:unbound");
      else for (const id of payload.effectIds) effectClaim(id, true, payload.sourceAttemptId);
    }
  }
  for (const [id, group] of effects) {
    if (group.conflicting || group.attemptIds.size > 1 ||
      !(positiveEffect(group.rows, store, inspection) || interruptedEffect(group.rows, store, inspection) ||
        !group.exposed && ["denied", "unstarted"].includes(classifyNoEffect(group.rows) ?? ""))) effectBlocks.add(`effect:${id}`);
  }
  for (const [id, group] of attempts) {
    const rows = group.rows;
    const activity = rows.filter((row) => {
      const { kind, payload } = row;
      if (kind === "attempt.receipt" || kind === "attempt.settled") return false;
      if (kind.startsWith("effect.")) {
        if (kind === "effect.denied" || kind === "effect.reconciled" && payload.disposition === "unstarted" ||
          kind === "effect.receipt" && payload.status === "denied") {
          const group = effects.get(String(row.effectId));
          if (group && ["denied", "unstarted"].includes(classifyNoEffect(group.rows) ?? "")) return false;
        }
        return true;
      }
      return kind.startsWith("attempt.") || kind === "workspace.snapshot.sealed" && payload.phase !== "base" ||
        kind === "dispatch.observed" || kind.startsWith("provider.request.") || kind === "workspace.candidate.registered" ||
        kind === "mission.recovery.recorded";
    });
    const reserved = rows.filter(({ kind }) => kind === "attempt.reserved");
    const receipt = rows.filter(({ kind }) => kind === "attempt.receipt");
    const settled = rows.filter(({ kind }) => kind === "attempt.settled");
    const started = rows.filter(({ kind }) => kind === "attempt.started");
    let clear = !group.conflicting && !rows.some(({ kind }) => kind === "attempt.interrupted") &&
      reserved.length === 1 && receipt.length === 1 && settled.length === 1 && started.length === 1;
    if (clear) {
      const [r] = reserved, [s] = started, [c] = receipt, [t] = settled;
      const binding = r!.payload.binding as Record<string, unknown> | undefined;
      clear = typeof r!.missionId === "string" && typeof r!.unitId === "string" && r!.unitId.length > 0 &&
        Number.isSafeInteger(r!.revision) && r!.seq! < s!.seq! && s!.seq! < c!.seq! && c!.seq! < t!.seq! &&
        activity.every((row) => row.seq !== undefined && c!.seq !== undefined && row.seq < c!.seq) &&
        r!.revision === s!.revision && r!.revision === c!.revision && r!.revision === t!.revision &&
        binding?.missionId === r!.missionId && binding.revision === r!.revision && binding.attemptId === id &&
        binding.unitId === r!.unitId && c!.unitId === r!.unitId && t!.unitId === r!.unitId &&
        c!.payload.unitId === r!.unitId &&
        ["completed", "failed", "cancelled"].includes(String(c!.payload.status)) &&
        (c!.payload.status === "completed" ? ["succeeded", "failed"].includes(String(t!.payload.status)) :
          c!.payload.status === "failed" ? t!.payload.status === "failed" : t!.payload.status === "cancelled") &&
        typeof c!.payload.artifactHash === "string" && c!.payload.artifactHash === c!.payload.resultHash &&
        t!.payload.resultHash === c!.payload.artifactHash && !c!.payload.recoveryDisposition && !t!.payload.recoveryDisposition;
      if (clear) {
        try { clear = sha256(store.readArtifact(String(c!.payload.artifactHash))) === c!.payload.artifactHash; }
        catch { clear = false; }
      }
    }
    if (!clear && !group.conflicting && terminalWriter(rows, store,
      ![...effects].some(([effectId, effect]) => effect.attemptIds.has(id) && effectBlocks.has(`effect:${effectId}`)), inspection)) clear = true;
    if (!clear) writerBlocks.add(`writer:${id}`);
  }
  return { effects: [...effectBlocks].sort(), writers: [...writerBlocks].sort() };
}
