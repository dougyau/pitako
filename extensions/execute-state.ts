import path from "node:path";

/** Native mission metadata and workflow state are separate files. */
export function executionStatePath(mission: { missionPath: string; missionId: string }): string {
  return path.join(path.dirname(mission.missionPath), mission.missionId, "state.json");
}

/**
 * The single retained execute/checkpoint contract version. The root workflow
 * receives it through resolved config; no older contract is migrated or replayed.
 */
export const EXECUTE_STATE_VERSION = 10;
