import { subscribeChanges } from "../../extensions/agent/observe.ts";
import { workerStatus, workerResult, teamWorkerStatus, teamWorkerResult, deliverWorkerResults } from "../../extensions/agent/background.ts";
import { teamEvaluationForSession, teamAssignments } from "../../extensions/team.ts";

/** Existing post-admission assertions wait on authoritative observations, not elapsed time. */
export function preparedTool<T extends { name: string; execute: Function }>(tool: T): T {
  if (tool.name !== "agent_spawn" && tool.name !== "team_assign") return tool;
  return { ...tool, async execute(...args: any[]) {
    const result = await tool.execute(...args);
    if (result.isError) return result;
    const ctx = args[4];
    const team = tool.name === "team_assign" ? teamEvaluationForSession(ctx.sessionManager?.getSessionId?.(), false) : undefined;
    const id = result.details.instanceId;
    const view = () => team ? teamWorkerStatus(team.token, id)[0]! : workerStatus(id)[0]!;
    await new Promise<void>(resolve => {
      const done = () => { if (view().dispatchPhase !== "preflight") { stop(); resolve(); } };
      const stop = subscribeChanges(row => { if (row.id === id) done(); });
      done();
    });
    if (team) deliverWorkerResults(team.token, true);
    const state = view();
    const assignment = team && teamAssignments(team).find(row => row.instanceId === id);
    if (state.workerStarted === false) {
      // Model the existing terminal result boundary, never a getter acknowledgement.
      if (team) deliverWorkerResults(team.token, true);
      const outcome = team ? teamWorkerResult(team.token, id) : workerResult(id);
      return { ...result, isError: true, content: [{ type: "text", text: outcome.result }], details: { ...result.details, outcome } };
    }
    return { ...result, details: { ...result.details, ...assignment } };
  } };
}
