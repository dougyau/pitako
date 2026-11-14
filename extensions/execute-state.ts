import path from "node:path";

/** Native mission metadata and workflow state are separate files. */
export function executionStatePath(mission: { missionPath: string; missionId: string }): string {
  return path.join(path.dirname(mission.missionPath), mission.missionId, "state.json");
}

/**
 * The single retained execute/checkpoint contract version. The root workflow
 * receives it through resolved config; no older contract is migrated or replayed.
 */
export const EXECUTE_STATE_VERSION = 9;
export function incompatibleExecuteState(version: unknown): string {
  return `Retained execution created by an incompatible Pitako contract v${String(version)}; start a new mission. No migration or replay is supported; retained unchanged.`;
}

/** Lossless storage-only sharing; native and published record bytes stay expanded. */
export function compactWorkerReferences(value: any): any {
  const routes: any[] = [], seen = new Map<string, number>();
  const results: any[] = [], resultIndexes = new Map<string, number>(), counts = new Map<string, number>();
  const intents: any[] = [], intentIndexes = new Map<string, number>();
  const isResult = (node: any) => typeof node.taskId === "string" && Number.isSafeInteger(node.attempt) &&
    typeof node.status === "string" && typeof node.workDone === "string" && typeof node.ref?.key === "string";
  const isCheckpointIntent = (node: any) => node?.version === 2 && typeof node.key === "string" &&
    typeof node.taskId === "string" && Number.isSafeInteger(node.attempt) && Number.isSafeInteger(node.loop) &&
    Number.isSafeInteger(node.cursor) && node.phase === "implementation" &&
    !!node.association && !!node.planRef && !!node.progress;
  function count(node: any): void {
    if (!node || typeof node !== "object") return;
    if (isResult(node) || isCheckpointIntent(node)) {
      const identity = JSON.stringify(node);
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    Object.values(node).forEach(count);
  }
  count(value);
  const fields = ["asyncDir", "outputReference", "outputArtifactPath", "outputPathMapping", "artifactPaths"];
  function visit(node: any): any {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(visit);
    if (isCheckpointIntent(node)) {
      const identity = JSON.stringify(node);
      if (counts.get(identity)! > 1) {
        let index = intentIndexes.get(identity);
        if (index === undefined) {
          index = intents.length;
          intentIndexes.set(identity, index);
          intents.push(null);
          intents[index] = Object.fromEntries(Object.entries(node).map(([field, child]) => [field, visit(child)]));
        }
        return { checkpointIntentReference: index };
      }
    }
    if (isResult(node)) {
      const identity = JSON.stringify(node);
      if (counts.get(identity)! > 1) {
        let index = resultIndexes.get(identity);
        if (index === undefined) {
          index = results.length;
          resultIndexes.set(identity, index);
          results.push(null);
          results[index] = Object.fromEntries(Object.entries(node).map(([field, child]) => [field, visit(child)]));
        }
        return { admittedResultReference: index };
      }
    }
    if ((node.agent === undefined || node.agent === "pitako.worker") && typeof node.key === "string" &&
        (node.runId === undefined || typeof node.runId === "string") && !node.structuredOutput) {
      if (fields.some(field => node[field] !== undefined) || Array.isArray(node.results) && node.results.some((entry: any) =>
        entry?.structuredOutputPath !== undefined || entry?.savedOutputPath !== undefined)) {
        // Share only byte-identical witnesses, including property order and controls.
        const identity = JSON.stringify(node);
        let index = seen.get(identity);
        if (index === undefined) { index = routes.length; seen.set(identity, index); routes.push(JSON.parse(identity)); }
        return { workerReference: index };
      }
    }
    return Object.fromEntries(Object.entries(node).map(([field, child]) => [field, visit(child)]));
  }
  const compact = visit(value);
  return !routes.length && !results.length && !intents.length ? compact : {
    ...compact, ...(routes.length ? { workerReferences: routes } : {}),
    ...(results.length ? { admittedResults: results } : {}),
    ...(intents.length ? { checkpointIntents: intents } : {}) };
}

export function expandWorkerReferences(value: any): any {
  if (!value?.workerReferences && !value?.admittedResults && !value?.checkpointIntents) return value;
  const routes = value.workerReferences ?? [], results = value.admittedResults ?? [], intents = value.checkpointIntents ?? [];
  if (!Array.isArray(routes) || !Array.isArray(results) || !Array.isArray(intents))
    throw new Error("Invalid retained worker reference table.");
  const expandingIntents = new Set<number>();
  function visit(node: any): any {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(visit);
    if (Object.hasOwn(node, "checkpointIntentReference")) {
      const index = node.checkpointIntentReference, intent = intents[index];
      if (!Number.isSafeInteger(index) || Object.keys(node).length !== 1 ||
          intent?.version !== 2 || typeof intent.key !== "string" || typeof intent.taskId !== "string" ||
          !Number.isSafeInteger(intent.attempt) || !Number.isSafeInteger(intent.loop) ||
          !Number.isSafeInteger(intent.cursor) || intent.phase !== "implementation" ||
          !intent.association || !intent.planRef || !intent.progress || expandingIntents.has(index))
        throw new Error("Invalid retained checkpoint intent reference.");
      expandingIntents.add(index);
      const expanded = visit(intent);
      expandingIntents.delete(index);
      return expanded;
    }
    if (Object.hasOwn(node, "admittedResultReference")) {
      const result = results[node.admittedResultReference];
      if (!Number.isSafeInteger(node.admittedResultReference) || Object.keys(node).length !== 1 ||
          !result || typeof result.taskId !== "string" || !Number.isSafeInteger(result.attempt) ||
          typeof result.status !== "string" || typeof result.workDone !== "string" ||
          (typeof result.ref?.key !== "string" && !Object.hasOwn(result.ref ?? {}, "workerReference")))
        throw new Error("Invalid retained admitted result reference.");
      return visit(result);
    }
    if (Object.hasOwn(node, "workerReference")) {
      const route = routes[node.workerReference];
      if (!Number.isSafeInteger(node.workerReference) || !route || typeof route !== "object" || Array.isArray(route) ||
          Object.keys(node).length !== 1 || typeof route.key !== "string" ||
          (route.agent !== undefined && route.agent !== "pitako.worker") ||
          (route.runId !== undefined && typeof route.runId !== "string") || route.structuredOutput)
        throw new Error("Invalid retained worker reference.");
      // Independent expanded objects keep one consumer's controls from mutating another.
      return JSON.parse(JSON.stringify(route));
    }
    return Object.fromEntries(Object.entries(node).map(([field, child]) => [field, visit(child)]));
  }
  const { workerReferences, admittedResults, checkpointIntents, ...rest } = value;
  return visit(rest);
}
