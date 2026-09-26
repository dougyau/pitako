import { retireTeamWorkers, teamWorkerHasOutcome, teamWorkerStatus } from "./agent/background.ts";
import { executionForSession } from "./execution-identity.ts";
import { readLedgerTeamHolds, updateLedgerTeamHold, type ExecutionBinding } from "./workflow.ts";

const KEY = Symbol.for("pitako.teamRegistry");
export const TEAM_ROLES = ["architect", "developer", "reviewer", "researcher", "scout"] as const;
const TEAM_ROLE_SET = new Set<string>(TEAM_ROLES);

export interface TeamAssignment {
  id: string;
  instanceId: string;
  roleId: string;
  task: string;
  planId?: string;
  unitId?: string;
  boardTopicId?: number;
  execution?: ExecutionBinding;
}

interface Evaluation {
  sessionId: string;
  token: symbol;
  roles: Map<string, string>;
  assignments: Map<string, { current?: TeamAssignment; last?: TeamAssignment }>;
  hasRoster: boolean;
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
    retireTeamWorkers(previous.token);
    state.evaluations.delete(sessionId);
  }
  const evaluation = { sessionId, token, roles: new Map(), assignments: new Map(), hasRoster: false };
  state.evaluations.set(sessionId, evaluation);
  return evaluation;
}

export function retireTeamEvaluation(evaluation: TeamEvaluation | undefined): void {
  if (!evaluation) return;
  const state = registry();
  const current = state.evaluations.get(evaluation.sessionId);
  if (current?.token !== evaluation.token) return;
  retireTeamWorkers(evaluation.token);
  state.evaluations.delete(evaluation.sessionId);
}

/** Reserve one role before accepting work. Roll back on preaccept failure. */
export function reserveTeamRole(
  evaluation: TeamEvaluation | undefined,
  roleId: string,
  assignmentId: string,
): { token: symbol; commit: () => void; rollback: () => void; settled: () => void } {
  if (!evaluation) throw new Error("Team requires a foreground session identity");
  const state = registry();
  const current = state.evaluations.get(evaluation.sessionId);
  if (!current || current.token !== evaluation.token) throw new Error("stale Team evaluation");
  if (!TEAM_ROLE_SET.has(roleId)) throw new Error(`unsupported Team role ${roleId}`);
  if (current.roles.has(roleId)) throw new Error(`Team role ${roleId} is already reserved`);
  current.roles.set(roleId, assignmentId);
  let committed = false;
  let finished = false;
  let settledEarly = false;
  const release = () => {
    const live = state.evaluations.get(evaluation.sessionId);
    if (live?.token === evaluation.token && live.roles.get(roleId) === assignmentId) {
      live.roles.delete(roleId);
    }
  };
  return {
    token: evaluation.token,
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
  return current ? { sessionId, token: current.token } : undefined;
}

export function recordTeamAssignment(evaluation: TeamEvaluation, roleId: string, assignment: TeamAssignment): void {
  const current = registry().evaluations.get(evaluation.sessionId);
  if (current?.token !== evaluation.token) throw new Error("stale Team evaluation");
  const slot = current.assignments.get(roleId) ?? {};
  slot.last = slot.current;
  slot.current = assignment;
  current.assignments.set(roleId, slot);
}

export function teamAssignments(evaluation: TeamEvaluation): readonly { current?: TeamAssignment; last?: TeamAssignment }[] {
  const current = registry().evaluations.get(evaluation.sessionId);
  if (current?.token !== evaluation.token) throw new Error("stale Team evaluation");
  return TEAM_ROLES.map((role) => current.assignments.get(role) ?? {});
}

export function teamExecutionBinding(evaluation: TeamEvaluation | undefined, planId: string): ExecutionBinding | undefined {
  if (!evaluation) return undefined;
  for (const slot of teamAssignments(evaluation)) {
    const assignment = slot.current?.planId === planId ? slot.current : slot.last?.planId === planId ? slot.last : undefined;
    if (assignment?.execution) return assignment.execution;
  }
  return undefined;
}

export function hasTeamRoster(evaluation: TeamEvaluation | undefined): boolean {
  if (!evaluation) return false;
  const current = registry().evaluations.get(evaluation.sessionId);
  return current?.token === evaluation.token && current.hasRoster;
}

export function teamRoleReservation(evaluation: TeamEvaluation | undefined, roleId: string): string | undefined {
  if (!evaluation) return undefined;
  const current = registry().evaluations.get(evaluation.sessionId);
  return current?.token === evaluation.token ? current.roles.get(roleId) : undefined;
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
): void {
  updateLedgerTeamHold(binding?.executionRoot ?? cwd, planId,
    { assignmentId, unitId, status: status === "completed" || status === undefined ? "pending" : status },
    status === "completed" || status === undefined, binding);
}

/** A resolve must not mistake an unsettled or unsuccessful Team result for success. */
export function hasUnsettledTeamWork(evaluation: TeamEvaluation | undefined, planId: string, cwd?: string, expectedBinding?: ExecutionBinding): boolean {
  const binding = teamExecutionBinding(evaluation, planId) ?? expectedBinding;
  if (binding) return readLedgerTeamHolds(binding.executionRoot, planId, binding).length > 0;
  if (cwd) return readLedgerTeamHolds(cwd, planId).length > 0;
  if (!evaluation) return false;
  for (const slot of teamAssignments(evaluation)) {
    const assignment = slot.current?.planId === planId ? slot.current : slot.last?.planId === planId ? slot.last : undefined;
    if (!assignment) continue;
    try {
      if (!teamWorkerHasOutcome(evaluation.token, assignment.instanceId)) return true;
      if (teamWorkerStatus(evaluation.token, assignment.instanceId)[0]?.status !== "completed") return true;
    } catch {
      return true;
    }
  }
  return false;
}
