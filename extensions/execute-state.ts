import path from "node:path";
import { StoreError } from "./pitako-store.ts";

/** Native mission metadata and workflow state are separate files. */
export function executionStatePath(mission: { missionPath: string; missionId: string }): string {
  return path.join(path.dirname(mission.missionPath), mission.missionId, "state.json");
}

/**
 * The single retained execute/checkpoint contract version. The root workflow
 * receives it through resolved config; no older contract is migrated or replayed.
 */
export const EXECUTE_STATE_VERSION = 11;
export const EXECUTE_CONTINUATION_INCOMPATIBLE = "execute-continuation-incompatible";

// The sandbox embeds this factory, so it must not close over module bindings.
function continuationReader(ErrorType: typeof StoreError, version: number, code: typeof EXECUTE_CONTINUATION_INCOMPATIBLE) {
  return function readContinuation<T>(packet: T): T {
    if (packet === undefined || packet === null) return packet;
    if (typeof packet !== "object" || Array.isArray(packet) || !Object.hasOwn(packet, "version") ||
        (packet as { version?: unknown }).version !== version)
      throw new ErrorType(code,
        `${code}: Retained execute continuation has an incompatible packet version. No migration or replay is supported.`);
    return packet;
  };
}

export const readContinuation = continuationReader(StoreError, EXECUTE_STATE_VERSION, EXECUTE_CONTINUATION_INCOMPATIBLE);

export function executeContinuationScript(): string {
  return `const EXECUTE_STATE_VERSION = ${EXECUTE_STATE_VERSION};
const EXECUTE_CONTINUATION_INCOMPATIBLE = ${JSON.stringify(EXECUTE_CONTINUATION_INCOMPATIBLE)};
${StoreError.toString()}
const readContinuation = (${continuationReader.toString()})(StoreError, EXECUTE_STATE_VERSION, EXECUTE_CONTINUATION_INCOMPATIBLE);`;
}
