import { resolveLiveBinding, resolveWorkerReadBinding, type WorkerReadScope, type LiveTarget } from "./background.ts";
import { currentInstanceId } from "./scope.ts";
import { executionForSession } from "../execution-identity.ts";
import { teamEvaluationForSession } from "../team.ts";

/** Shared native-tool/UI policy. Team authority is re-read at every admission. */
export function resolveOwnedLive(target: LiveTarget, sessionId: string | undefined) {
  if (currentInstanceId() || process.env.PITAKO_INSTANCE_ID || executionForSession(sessionId))
    throw new Error("live control cannot be called from an AgentInstance");
  const evaluation = target.kind === "team" ? teamEvaluationForSession(sessionId, false) : undefined;
  return resolveLiveBinding(target, sessionId, evaluation?.token);
}

export function resolveOwnedWorkerRead(target: LiveTarget, scope: WorkerReadScope) {
  if (currentInstanceId() || process.env.PITAKO_INSTANCE_ID || executionForSession(scope.coordinatorSessionId))
    throw new Error("worker inspection cannot be called from an AgentInstance");
  const evaluation = target.kind === "team" ? teamEvaluationForSession(scope.coordinatorSessionId, false) : undefined;
  return resolveWorkerReadBinding(target, { ...scope, teamToken: evaluation?.token });
}
