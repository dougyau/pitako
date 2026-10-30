import path from "node:path";

/** Native mission metadata and workflow state are separate files. */
export function executionStatePath(mission: { missionPath: string; missionId: string }): string {
  return path.join(path.dirname(mission.missionPath), mission.missionId, "state.json");
}
