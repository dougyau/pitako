import { observeArchitectureAssignment, retireArchitectureRooms } from "./architecture/rooms.ts";
import { retireReviewRooms } from "./review/index.ts";
import { randomUUID } from "node:crypto";
import { reserveBackground, turnTeamWorker, finishTeamWorker, type SpawnInput, retireTeamMembers, retireTeamWorkers, teamWorkerHasOutcome, teamWorkerStatus } from "./agent/background.ts";
import { executionForSession } from "./execution-identity.ts";
import { readLedgerTeamHolds, type ExecutionBinding } from "./workflow.ts";
import { captureCallContext, reconcileTeamHold, type ReleaseReceipt, type TeamHoldRecord, type AttemptRecord } from "./workflow-engine.ts";
import { WorkflowState, type Reservation } from "./workflow-state.ts";
import { currentWorkspace } from "./board/workspace.ts";

const KEY = Symbol.for("pitako.teamRegistry");
const TEAM_ROLES = new Set(["architect", "developer", "reviewer", "researcher", "scout", "oracle"]);

export interface TeamAssignment {
  id: string;
  teamId: string;
  memberId: string;
  ordinal: number;
  admittedAt: number;
  instanceId: string;
  roleId: string;
  task: string;
  planId?: string;
  unitId?: string;
  boardTopicId?: number;
  execution?: ExecutionBinding;
  dispatchId?: string;
}

interface Evaluation {
  sessionId: string;
  token: symbol;
  members: Map<string, { teamId: string; memberId: string; roleId: string; assignmentId: string; ordinal: number; admittedAt: number }>;
  teams: Map<string, { closed: boolean; closing?: Promise<void> }>;
  ordinaryTeamId: string;
  ordinal: number;
  assignments: Map<string, TeamAssignment>;
  hasRoster: boolean;
  retiring?: Promise<void>;
}

interface Registry {
  evaluations: Map<string, Evaluation>;
}

function registry(): Registry {
  const host = globalThis as Record<symbol, Registry | undefined>;
  return (host[KEY] ??= { evaluations: new Map() });
}

export interface TeamEvaluation {
  readonly sessionId: string;
  readonly token: symbol;
}

/** Starts a fresh foreground evaluation lease. Children and missing IDs fail closed. */
export function beginTeamEvaluation(sessionId: string | undefined, child: boolean, token = Symbol("pitako.team.evaluation")): TeamEvaluation | undefined {
  if (child || !sessionId || executionForSession(sessionId)) return undefined;
  const state = registry();
  const previous = state.evaluations.get(sessionId);
  if (previous) {
    throw new Error("Team evaluation already exists; await retirement before replacing it");
  }
  const ordinaryTeamId = randomUUID();
  const evaluation: Evaluation = { sessionId, token, members: new Map(), teams: new Map([[ordinaryTeamId, { closed: false }]]),
    ordinaryTeamId, ordinal: 0, assignments: new Map(), hasRoster: false };
  state.evaluations.set(sessionId, evaluation);
  return evaluation;
}

export function retireTeamEvaluation(evaluation: TeamEvaluation | undefined): Promise<void> {
  if (!evaluation) return Promise.resolve();
  const state = registry();
  const current = state.evaluations.get(evaluation.sessionId);
  if (current?.token !== evaluation.token) return Promise.resolve();
  if (current.retiring) return current.retiring;
  // Revoke synchronously; retain each member reservation until physical closure.
  for (const team of current.teams.values()) team.closed = true;
  const retirement = Promise.withResolvers<void>();
  current.retiring = retirement.promise;
  retireArchitectureRooms(evaluation);
  retireReviewRooms(evaluation.token);
  void retireTeamWorkers(evaluation.token).then(() => {
    if (state.evaluations.get(evaluation.sessionId) === current) state.evaluations.delete(evaluation.sessionId);
    retirement.resolve();
  }, retirement.reject);
  return current.retiring;
}

/** Reserve an independent member before accepting work. Roll back on preaccept failure. */
export function reserveTeamMember(
  evaluation: TeamEvaluation | undefined,
  roleId: string,
  assignmentId: string,
  teamId?: string,
): { teamId: string; memberId: string; ordinal: number; admittedAt: number; token: symbol; owns: () => boolean; commit: () => void; rollback: () => void; settled: () => void; noWorkerReleased: () => void } {
  if (!evaluation) throw new Error("Team requires a foreground session identity");
  const state = registry();
  const current = state.evaluations.get(evaluation.sessionId);
  if (!current || current.token !== evaluation.token || current.retiring) throw new Error("stale Team evaluation");
  if (!TEAM_ROLES.has(roleId)) throw new Error(`unsupported Team role ${roleId}`);
  teamId ??= current.ordinaryTeamId;
  if (!current.teams.has(teamId) || current.teams.get(teamId)!.closed) throw new Error("Team admission is closed");
  if (current.assignments.has(assignmentId) || [...current.members.values()].some(member => member.assignmentId === assignmentId)) throw new Error("Team assignment is already reserved");
  const memberId = randomUUID(), ordinal = ++current.ordinal, admittedAt = Date.now();
  current.members.set(memberId, { teamId, memberId, roleId, assignmentId, ordinal, admittedAt });
  let committed = false;
  let finished = false;
  let settledEarly = false;
  const release = () => {
    const live = state.evaluations.get(evaluation.sessionId);
    if (live?.token === evaluation.token && live.members.get(memberId)?.assignmentId === assignmentId) {
      live.members.delete(memberId);
    }
  };
  return {
    teamId, memberId, ordinal, admittedAt, token: evaluation.token,
    owns() {
      const live = state.evaluations.get(evaluation.sessionId);
      return !finished && live?.token === evaluation.token && !live.retiring && !live.teams.get(teamId!)?.closed && live.members.get(memberId)?.assignmentId === assignmentId;
    },
    commit() {
      if (finished) return;
      committed = true;
      const live = state.evaluations.get(evaluation.sessionId);
      if (live?.token === evaluation.token) {
        live.hasRoster = true;
        if (settledEarly) {
          release();
          finished = true;
        }
      } else finished = true;
    },
    rollback() {
      if (committed || finished) return;
      finished = true;
      release();
    },
    noWorkerReleased() {
      if (finished) return;
      finished = true;
      release();
    },
    settled() {
      if (finished) return;
      if (committed) {
        release();
        finished = true;
      } else settledEarly = true;
    },
  };
}

/** Resolve an already-established lease from the trusted live Pi session identity. */
export function teamEvaluationForSession(sessionId: string | undefined, child: boolean): TeamEvaluation | undefined {
  if (child || !sessionId || executionForSession(sessionId)) return undefined;
  const current = registry().evaluations.get(sessionId);
  return current && !current.retiring ? { sessionId, token: current.token } : undefined;
}

export function recordTeamAssignment(evaluation: TeamEvaluation, roleId: string, assignment: Omit<TeamAssignment, "teamId" | "memberId" | "ordinal" | "admittedAt">): void {
  const current = registry().evaluations.get(evaluation.sessionId);
  if (current?.token !== evaluation.token || current.retiring) throw new Error("stale Team evaluation");
  const member = [...current.members.values()].find(member => member.assignmentId === assignment.id && member.roleId === roleId);
  const previous = current.assignments.get(assignment.id);
  if (!member && !previous) throw new Error("Team assignment has no admission");
  const recorded = { ...(previous ?? member!), ...assignment };
  current.assignments.set(assignment.id, recorded);
  observeArchitectureAssignment(evaluation, recorded);
}

export function teamAssignments(evaluation: TeamEvaluation): readonly TeamAssignment[] {
  const current = registry().evaluations.get(evaluation.sessionId);
  if (current?.token !== evaluation.token) throw new Error("stale Team evaluation");
  return [...current.assignments.values()].sort((left, right) => left.ordinal - right.ordinal);
}

/** Validate exact selectors even for an admitted Team with no members yet. */
export function selectTeamAssignments(evaluation: TeamEvaluation, filters: { teamId?: string; memberId?: string; assignmentId?: string }): readonly TeamAssignment[] {
  const catalog = teamAssignments(evaluation);
  const current = registry().evaluations.get(evaluation.sessionId)!;
  for (const value of Object.values(filters)) if (value !== undefined && !value.trim()) throw new Error("empty Team selector");
  if (filters.teamId && !current.teams.has(filters.teamId)) throw new Error("unknown Team");
  const selected = catalog.filter(row => (!filters.assignmentId || row.id === filters.assignmentId) &&
    (!filters.teamId || row.teamId === filters.teamId) && (!filters.memberId || row.memberId === filters.memberId));
  if ((filters.assignmentId || filters.memberId) && !selected.length) throw new Error("unknown Team member or incompatible filters");
  return selected;
}

export function teamExecutionBinding(evaluation: TeamEvaluation | undefined, planId: string): ExecutionBinding | undefined {
  if (!evaluation) return undefined;
  for (const assignment of [...teamAssignments(evaluation)].reverse()) {
    if (assignment.planId === planId && assignment.execution) return assignment.execution;
  }
  return undefined;
}

export function hasTeamRoster(evaluation: TeamEvaluation | undefined): boolean {
  if (!evaluation) return false;
  const current = registry().evaluations.get(evaluation.sessionId);
  return current?.token === evaluation.token && current.hasRoster;
}

export function firstTeamReservation(evaluation: TeamEvaluation | undefined, roleId: string): string | undefined {
  if (!evaluation) return undefined;
  const current = registry().evaluations.get(evaluation.sessionId);
  return current?.token === evaluation.token ? [...current.members.values()].find(member => member.roleId === roleId)?.assignmentId : undefined;
}

/** Host-only container. Ordinary tools use the evaluation's implicit Team. */
export function createTeam(evaluation: TeamEvaluation): { teamId: string; evaluation: TeamEvaluation } {
  const current = registry().evaluations.get(evaluation.sessionId);
  if (!current || current.token !== evaluation.token || current.retiring) throw new Error("stale Team evaluation");
  const teamId = randomUUID();
  current.teams.set(teamId, { closed: false });
  return { teamId, evaluation };
}

/** Host admission is synchronous, including the background preparation/lifetime reservation. */
export function admitTeamMember(team: ReturnType<typeof createTeam>, input: Omit<SpawnInput, "reservation" | "teamOwner" | "foreground" | "head" | "maintained">) {
  if ("head" in input && input.head) throw new Error("Head assignments require the one-shot route");
  const id = randomUUID();
  const admission = reserveTeamMember(team.evaluation, input.roleId, id, team.teamId);
  try {
    const handle = reserveBackground({ roleId: input.roleId, task: input.task, cwd: input.cwd,
      context: input.context ?? captureCallContext(input.cwd), watch: input.watch,
      coordinatorSessionId: team.evaluation.sessionId, owns: admission.owns,
      recipient: input.recipient,
      origin: { ...input.historyOrigin, source: "team_assign", coordinatorSessionId: team.evaluation.sessionId,
        assignmentId: id, teamId: admission.teamId, memberId: admission.memberId },
      teamOwner: { token: admission.token, assignmentId: id, teamId: admission.teamId, memberId: admission.memberId,
        onSettled: admission.settled, noWorkerReleased: admission.noWorkerReleased },
      async prepare(_signal, check, reserved) {
        check();
        return { ...input, maintained: true,
          historyOrigin: { ...input.historyOrigin, source: "team_assign", coordinatorSessionId: team.evaluation.sessionId,
            assignmentId: id, teamId: admission.teamId, memberId: admission.memberId, dispatchId: reserved.dispatchId } };
      },
    });
    recordTeamAssignment(team.evaluation, input.roleId, { id, instanceId: handle.instanceId, roleId: input.roleId,
      task: input.task, dispatchId: handle.dispatchId });
    admission.commit();
    return { ...handle, assignmentId: id, teamId: admission.teamId, memberId: admission.memberId,
      turn(task: string) {
        if (!admission.owns()) return Promise.reject(new Error("stale Team member"));
        return turnTeamWorker(admission.token, handle.instanceId, task);
      },
      finish() { return finishTeamWorker(admission.token, handle.instanceId); },
    };
  } catch (error) { admission.rollback(); throw error; }
}

/** Revocation precedes any await. The join excludes an exterior host orchestrator. */
export function disbandTeam(team: ReturnType<typeof createTeam>): Promise<void> {
  const current = registry().evaluations.get(team.evaluation.sessionId);
  const container = current?.token === team.evaluation.token && current.teams.get(team.teamId);
  if (!container) return Promise.resolve();
  if (container.closing) return container.closing;
  container.closed = true;
  container.closing = retireTeamMembers(team.evaluation.token, team.teamId);
  return container.closing;
}

type TeamWorkStatus = "pending" | "failed" | "cancelled";

/** Record or reconcile exactly one accepted assignment in its bound plan ledger. */
export function recordPlanTeamWork(
  cwd: string,
  planId: string,
  unitId: string,
  assignmentId: string,
  status: TeamWorkStatus | "completed" | undefined,
  binding?: ExecutionBinding,
  receipt?: ReleaseReceipt,
): void {
  const store = new WorkflowState(currentWorkspace(binding?.executionRoot ?? cwd));
  try { reconcileTeamHold(store, { planId, unitId, execution: binding }, assignmentId, status, receipt); }
  finally { store.close(); }
}

/** A resolve must not mistake an unsettled or unsuccessful Team result for success. */
export function hasUnsettledTeamWork(evaluation: TeamEvaluation | undefined, planId: string, cwd?: string, expectedBinding?: ExecutionBinding): boolean {
  const binding = teamExecutionBinding(evaluation, planId) ?? expectedBinding;
  const root = binding?.executionRoot ?? cwd;
  if (root) {
    // A broken projection is still a refusal, not a reason to ignore its captured binding.
    if (readLedgerTeamHolds(root, planId, binding).length) return true;
    const store = new WorkflowState(currentWorkspace(root));
    try {
      if (store.all<TeamHoldRecord>("holds").some(hold => hold.planId === planId && !hold.cleared)) return true;
      if (store.outbox().some(entry => entry.target === `team-holds:${planId}` &&
          !["applied", "not-applicable"].includes(entry.state))) return true;
      for (const attempt of store.all<AttemptRecord>("attempts")) {
        if (attempt.watch?.planId !== planId) continue;
        if (store.get<Reservation>("reservations", attempt.reservationId)?.state !== "released") return true;
      }
    } finally { store.close(); }
  }
  // Older assignments remain authoritative under their captured execution binding.
  for (const assignment of evaluation ? teamAssignments(evaluation) : []) {
    if (assignment.planId === planId && assignment.execution &&
        readLedgerTeamHolds(assignment.execution.executionRoot, planId, assignment.execution).length > 0) return true;
  }
  if (binding) return readLedgerTeamHolds(binding.executionRoot, planId, binding).length > 0;
  if (cwd) return readLedgerTeamHolds(cwd, planId).length > 0;
  if (!evaluation) return false;
  for (const assignment of teamAssignments(evaluation)) {
    if (assignment.planId !== planId) continue;
    try {
      if (!teamWorkerHasOutcome(evaluation.token, assignment.instanceId)) return true;
      if (teamWorkerStatus(evaluation.token, assignment.instanceId)[0]?.status !== "completed") return true;
    } catch {
      return true;
    }
  }
  return false;
}
