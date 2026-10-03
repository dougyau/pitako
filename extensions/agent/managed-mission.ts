import { existsSync, opendirSync } from "node:fs";
import path from "node:path";
import { getPitakoDataDir } from "../board/paths.ts";
import { openMissionStore, type ManagedTargetClaim, type MissionInspection, type MissionStore } from "../mission/store.ts";
import { cancelManagedMissionAttempt } from "../mission/lifecycle.ts";
import { WorkerHistory, type HistoryAdmission, type HistoryClosure, type HistoryGroup, type HistoryMember } from "./history.ts";
import type { MissionAttemptBinding } from "../mission/engine.ts";
import { missionEffectProcessesQuiescent, missionHasUnresolvedEffects } from "../mission/reconcile.ts";
import { nativeHeader } from "./history-native.ts";

/** Registration uses a known store, never worktree discovery or a writable discovery open. */
export function registerManagedHistory(store: MissionStore, missionId: string, sessionsDirectory: string, workspace: string,
  history = new WorkerHistory()): HistoryGroup {
  const mission = store.inspectMission(missionId);
  const legacy = mission.events.some((row) => row.kind === "attempt.reserved" ||
    row.kind === "mission.recovery.diagnosed" && row.payload.status === "started");
  return history.missionGroup(workspace, missionId, { ...store.historyLocator, sessionsDirectory: path.resolve(sessionsDirectory) }, legacy);
}

export function managedHistoryAdmission(mission: MissionInspection, binding: MissionAttemptBinding,
  coordinatorSessionId?: string, diagnosis?: { roleId: string; sourceAttemptId: string }): HistoryAdmission {
  const reserved = mission.events.find((row) => row.kind === "attempt.reserved" && row.attemptId === binding.attemptId);
  const retry = reserved && [...mission.events].reverse().find((row) => row.seq < reserved.seq &&
    row.kind === "unit.ready" && row.unitId === binding.unitId && typeof row.payload.retryOf === "string");
  return {
    roleId: diagnosis?.roleId ?? binding.role ?? mission.definition.units.find((unit) => unit.id === binding.unitId)?.role ?? binding.memberId,
    attemptId: binding.attemptId, assignmentId: binding.attemptId, memberId: binding.memberId,
    unitId: binding.unitId, roundId: binding.roundId,
    coordinatorSessionId, continuationOf: binding.continuationOf, recoveryOf: binding.recoveryOf,
    ...(diagnosis ? { diagnosisId: binding.attemptId, diagnosisOf: diagnosis.sourceAttemptId } : {}),
    ...(!binding.continuationOf && !binding.recoveryOf && retry ? { retryOf: String(retry.payload.retryOf) } : {}),
  };
}

export interface ManagedHistoryProjection {
  group: HistoryGroup;
  executionState?: string;
  closure: HistoryClosure;
  protected: boolean;
  reasons: string[];
  legacyTotal?: number;
}

/** Snapshot only: does not resume, accept, acquire an owner, or write either authority. */
export async function projectManagedHistory(group: HistoryGroup, options?: {
  consultation: true;
  catalogMembers?: () => Iterable<HistoryMember>;
  historyId?: string;
  legacyOffset?: number;
  legacyLimit?: number;
}): Promise<ManagedHistoryProjection> {
  const consultation = options?.consultation === true ? options : undefined;
  const reasons: string[] = [];
  let legacyTotal = 0;
  const result = (closure: HistoryClosure, executionState?: string): ManagedHistoryProjection =>
    ({ group, executionState, closure, protected: closure.state !== "closed", reasons,
      ...(consultation ? { legacyTotal } : {}) });
  if (group.identity.kind !== "mission" || !group.missionStore) {
    reasons.push("known mission store locator unavailable");
    return result({ state: "unknown", reason: reasons[0]! });
  }
  let store: MissionStore | undefined;
  try {
    store = await openMissionStore({ readOnly: true, dbPath: group.missionStore.dbPath, objectDir: group.missionStore.objectDir,
      ...(consultation ? { historyReadBudget: { databaseBytes: 8 * 1024 * 1024, objectBytes: 2 * 1024 * 1024 } } : {}) });
    const mission = store.inspectMission(group.identity.missionId);
    // Legacy discovery is an in-memory projection. A caller may explicitly save this catalog backfill.
    group = consultation ? { ...group, members: [] } : structuredClone(group);
    const catalogMembers = () => consultation?.catalogMembers?.() ?? group.members;
    const admitted = mission.events.filter((row) => row.kind === "attempt.reserved" ||
      row.kind === "mission.recovery.diagnosed" && row.payload.status === "started");
    const admittedIds = new Set(admitted.map((row) => row.attemptId));
    for (const member of catalogMembers()) {
      if (member.attemptId && admittedIds.has(member.attemptId)) continue;
      group.coverage = "partial";
      reasons.push("catalog member lacks an exact authoritative admission");
      break;
    }
    let legacyIndex = 0;
    const visited = new Set<string>();
    let missingAdmissionId = 0;
    for (const row of admitted) {
      const id = row.attemptId;
      if (!id) { group.coverage = "partial"; missingAdmissionId++; continue; }
      if (visited.has(id)) continue;
      visited.add(id);
      let exists = false;
      for (const member of catalogMembers()) if (member.attemptId === id) { exists = true; break; }
      if (exists) continue;
      group.coverage = "partial";
      legacyTotal++;
      if (consultation && (consultation.historyId ? consultation.historyId !== id :
        legacyIndex++ < (consultation.legacyOffset ?? 0) || group.members.length >= (consultation.legacyLimit ?? 200))) continue;
      const binding = row.payload.binding as MissionAttemptBinding | undefined;
      const directory = path.join(group.missionStore!.sessionsDirectory, mission.id, id);
      const files: string[] = [];
      let headerUncertain = false;
      if (existsSync(directory)) {
        const dir = opendirSync(directory);
        try {
          for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
            const name = entry.name;
            if (name !== `${id}.jsonl` && !name.endsWith(`_${id}.jsonl`)) continue;
            try {
              const header = nativeHeader(path.join(directory, name));
              if (header.type === "session" && header.id === id) files.push(name);
              else headerUncertain = true;
            } catch { headerUncertain = true; }
            if (files.length > 1) break;
          }
        } finally { dir.closeSync(); }
      }
      const member: HistoryMember = {
        ...(binding ? managedHistoryAdmission(mission, binding) : { roleId: String(row.payload.role ?? "unknown"),
          attemptId: id, diagnosisId: id, diagnosisOf: typeof row.payload.attemptId === "string" ? row.payload.attemptId : undefined }),
        historyId: id, admittedAt: row.occurredAt,
        native: files.length === 1 && !headerUncertain ? { state: "allocated", sessionId: id, path: path.join(directory, files[0]!),
          disposition: { state: "unknown", reason: "legacy SDK disposition not observed by history adapter" } } : { state: "not-created" },
        gaps: ["Legacy admission: original provenance, native allocation and disposal coverage incomplete",
          ...(files.length !== 1 || headerUncertain ? ["No unique, certain native session header found at the known attempt directory"] : [])],
      };
      group.members.push(member);
    }
    if (missingAdmissionId) reasons.push(`admission has no exact attempt identity (${missingAdmissionId})`);
    if (group.coverage !== "complete") reasons.push("membership coverage is partial");
    if (!["completed", "cancelled"].includes(mission.state)) reasons.push(`mission is ${mission.state}`);
    let settledAt = "";
    for (const member of catalogMembers()) {
      if (!member.terminal && (!consultation || reasons.length < 16)) reasons.push(`terminal lifecycle not observed: ${member.attemptId}`);
      if (member.native.state === "allocated" && member.native.disposition.state !== "disposed")
        if (!consultation || reasons.length < 16) reasons.push(`SDK disposal not confirmed: ${member.attemptId}`);
      if (member.terminal && member.terminal.at > settledAt) settledAt = member.terminal.at;
      if (member.native.state === "allocated" && member.native.disposition.state === "disposed" && member.native.disposition.at > settledAt)
        settledAt = member.native.disposition.at;
    }
    if (missionHasUnresolvedEffects(store, mission.events)) reasons.push("unresolved mission effects");
    if (store.historyReadLimitReached) reasons.push("history_authority_limit");
    if (mission.events.some((row) => ["effect.process.registered", "effect.released"].includes(row.kind) &&
      (!row.attemptId || !row.effectId))) reasons.push("unbound process obligation");
    const attemptIds = new Set(mission.events.filter((row) => row.attemptId).map((row) => row.attemptId!));
    if ([...attemptIds].some((id) => !missionEffectProcessesQuiescent(mission.events, id))) reasons.push("effect processes not proven quiescent");
    if (reasons.length) return result({ state: "unknown", reason: reasons.join("; ") }, mission.state);
    const terminal = [...mission.events].reverse().find((row) => row.kind === `mission.${mission.state}`)!;
    return result({ state: "closed", closedAt: [terminal.occurredAt, settledAt].sort().at(-1)!,
      evidenceRef: `${group.missionStore!.dbPath}#${mission.id}:${mission.latestSeq}` }, mission.state);
  } catch (error) {
    reasons.push(`mission authority unavailable: ${String(error)}`);
    return result({ state: "unknown", reason: reasons.join("; ") });
  } finally { store?.close(); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const engineAdmissions = new WeakMap<object, {
  missionId: string; attemptId: string; candidateId: string; ownerEpoch: number; rootIdentity: string; gitIdentity: string;
}>();

export interface EngineRoleDispatchAdmission { readonly __engineAdmission?: never }

export function mintEngineRoleDispatchAdmission(store: MissionStore, input: {
  missionId: string; attemptId: string; candidateId: string; ownerEpoch: number; rootIdentity: string; gitIdentity: string;
}): EngineRoleDispatchAdmission {
  const inspection = store.inspectMission(input.missionId);
  const reserved = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === input.attemptId);
  const binding = reserved?.payload.binding as Record<string, unknown> | undefined;
  const registration = [...inspection.events].reverse().find((event) => event.kind === "workspace.candidate.registered" && event.attemptId === input.attemptId);
  if (!reserved || !registration || binding?.candidateId !== input.candidateId || binding.ownerEpoch !== input.ownerEpoch ||
    registration.payload.candidateId !== input.candidateId || registration.payload.rootIdentity !== input.rootIdentity ||
    registration.payload.gitIdentity !== input.gitIdentity || store.ownerEpoch !== input.ownerEpoch ||
    ["completed", "cancelled"].includes(inspection.state)) {
    throw new Error("managed role admission does not match a live engine reservation and registered candidate");
  }
  const token = Object.freeze({});
  engineAdmissions.set(token, input);
  return token;
}

export async function inspectManagedMission(root: string, planId?: string): Promise<MissionInspection | undefined> {
  return withMissionStore(async (store) => store.findManagedMission(root, planId));
}

export async function authorizeRoleDispatch(root: string, options: {
  planId?: string;
  purpose?: "role" | "board-lifecycle";
  admission?: EngineRoleDispatchAdmission;
  store?: MissionStore;
} = {}): Promise<ManagedTargetClaim | undefined> {
  const claims = options.store
    ? options.store.findManagedTargetClaims(root, options.planId)
    : await withMissionStore(async (store) => store.findManagedTargetClaims(root, options.planId));
  if (!claims?.length) return undefined;

  const owned = claims.filter(({ targetKind, mission }) => targetKind === "candidate" || !["completed", "cancelled"].includes(mission.state));
  if (options.purpose === "board-lifecycle") {
    if (owned.length) {
      if (owned.length !== 1 || owned[0]!.targetKind !== "repository" || owned[0]!.mission.planId !== options.planId) {
        throw new Error(`managed mission ${owned[0]!.mission.id} owns this physical target; Board lifecycle plan does not match its claim`);
      }
      return owned[0];
    }
    const exact = claims.find(({ targetKind, mission }) => targetKind === "repository" && mission.planId === options.planId);
    if (exact) return exact;
    if (claims.some(({ targetKind }) => targetKind === "candidate")) {
      throw new Error(`managed mission ${claims[0]!.mission.id} candidate cannot authorize Board lifecycle`);
    }
    return undefined;
  }

  if (!owned.length) return undefined;
  const admission = options.admission && engineAdmissions.get(options.admission);
  const admitted = admission && owned.find(({ mission, targetKind, candidateId, rootIdentity, gitIdentity }) => {
    if (targetKind !== "candidate" || mission.id !== admission.missionId || candidateId !== admission.candidateId ||
      rootIdentity !== admission.rootIdentity || gitIdentity !== admission.gitIdentity) return false;
    const reserved = mission.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === admission.attemptId);
    const binding = reserved?.payload.binding as Record<string, unknown> | undefined;
    return binding?.candidateId === admission.candidateId && binding.ownerEpoch === admission.ownerEpoch;
  });
  if (admitted) return admitted;
  throw new Error(`managed mission ${owned[0]!.mission.id} owns this physical target; role dispatch requires engine admission`);
}

export async function inspectManagedAttempt(root: string, attemptId: string): Promise<MissionInspection | undefined> {
  if (!UUID.test(attemptId)) return undefined;
  return withMissionStore(async (store) => store.findManagedAttempt(root, attemptId));
}

export function cancelManagedAttempt(missionId: string, attemptId: string): boolean {
  return UUID.test(attemptId) && cancelManagedMissionAttempt(missionId, attemptId);
}

export async function readManagedAttemptArtifact(root: string, attemptId: string, hash: string): Promise<Buffer | undefined> {
  if (!UUID.test(attemptId) || !/^[0-9a-f]{64}$/.test(hash)) return undefined;
  return withMissionStore(async (store) => {
    const mission = store.findManagedAttempt(root, attemptId);
    if (!mission || !mission.events.some((event) => event.kind === "attempt.receipt" && event.attemptId === attemptId && event.payload.artifactHash === hash)) return undefined;
    return store.readArtifact(hash);
  });
}

export function managedAttemptRows(mission: MissionInspection, attemptId?: string) {
  return mission.events
    .filter((event) => event.kind === "attempt.reserved" && event.attemptId && (!attemptId || event.attemptId === attemptId))
    .map((event) => {
      const binding = event.payload.binding as { role?: string; targetId?: string; roundId?: string; memberId?: string; continuationOf?: string } | undefined;
      const id = event.attemptId!;
      const consultation = mission.events.find((row) => row.kind === "team.consultation.admitted" && row.payload.parentAttemptId === id);
      const resolution = consultation && mission.events.find((row) => row.kind === "team.consultation.resolved" &&
        row.payload.targetId === consultation.payload.targetId);
      const continuation = [...mission.events].reverse().find((row) => row.kind === "attempt.reserved" &&
        (row.payload.binding as { continuationOf?: string } | undefined)?.continuationOf === id);
      const status = managedAttemptStatus(mission, id);
      return {
        assignmentId: id, missionId: mission.id, unitId: event.unitId,
        role: binding?.role ?? mission.definition.units.find((unit) => unit.id === event.unitId)?.role ?? "unknown",
        targetId: binding?.targetId ?? event.unitId, round: binding?.roundId ?? event.payload.roundId,
        memberId: binding?.memberId ?? event.payload.memberId,
        ...(binding?.continuationOf ? { continuationOf: binding.continuationOf } : {}),
        ...(consultation ? { childTargetId: consultation.payload.targetId,
          ...(resolution ? { childResultHash: resolution.payload.resultHash } : {}),
          ...(continuation ? { continuationAssignmentId: continuation.attemptId } : {}) } : {}),
        status, resultAvailable: !["waiting-child", "child-complete-awaiting-continuation", "continued", "cancelled", "receipt-unsettled"].includes(status) &&
          !mission.events.some((row) => row.kind === "team.consultation.denied" && row.attemptId === id) &&
          mission.events.some((row) => row.kind === "attempt.receipt" && row.attemptId === id),
        advisory: binding?.targetId !== undefined && binding.targetId !== event.unitId && binding.roundId === "synthesis",
      };
    });
}

export function managedAttemptStatus(mission: MissionInspection, attemptId: string): string {
  const events = mission.events.filter((event) => event.attemptId === attemptId);
  const consultation = mission.events.find((event) => event.kind === "team.consultation.admitted" && event.payload.parentAttemptId === attemptId);
  if (consultation) {
    if (mission.events.some((event) => event.kind === "team.consultation.cancelled" && event.payload.parentAttemptId === attemptId)) return "cancelled";
    if (mission.events.some((event) => event.kind === "attempt.reserved" &&
      (event.payload.binding as { continuationOf?: string } | undefined)?.continuationOf === attemptId)) return "continued";
    if (mission.events.some((event) => event.kind === "team.consultation.resolved" &&
      event.payload.targetId === consultation.payload.targetId)) return "child-complete-awaiting-continuation";
    return "waiting-child";
  }
  const settled = [...events].reverse().find((event) => event.kind === "attempt.settled");
  if (settled) return settled.payload.status === "succeeded" ? "completed" : String(settled.payload.status ?? "unknown");
  if (events.some((event) => event.kind === "attempt.interrupted")) return "interrupted";
  if (events.some((event) => event.kind === "attempt.receipt")) return "receipt-unsettled";
  if (events.some((event) => event.kind === "attempt.started")) return "running-or-uncertain";
  return "reserved";
}

async function withMissionStore<T>(action: (store: Awaited<ReturnType<typeof openMissionStore>>) => Promise<T>): Promise<T | undefined> {
  const dbPath = path.join(getPitakoDataDir(), "missions.db");
  if (!existsSync(dbPath)) return undefined;
  const store = await openMissionStore({ readOnly: true });
  try {
    return await action(store);
  } catch (error) {
    if (error instanceof Error && /Git discovery failed.*not a git repository/i.test(error.message)) return undefined;
    throw error;
  } finally {
    store.close();
  }
}
