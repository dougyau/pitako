import { existsSync } from "node:fs";
import path from "node:path";
import { getPitakoDataDir } from "../board/paths.ts";
import { openMissionStore, type ManagedTargetClaim, type MissionInspection, type MissionStore } from "../mission/store.ts";
import { cancelManagedMissionAttempt } from "../mission/lifecycle.ts";

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
