import { canonicalPath } from "../board/paths.ts";

type ChangeSet = { added: string[]; modified: string[]; removed: string[] };
type Lifecycle = {
  action: "built" | "reindexed" | "synced" | "reused" | "observed";
  durationMs: number;
  indexAll?: { success: boolean; filesIndexed: number; filesSkipped: number; filesErrored: number };
  sync?: { filesAdded: number; filesModified: number; filesRemoved: number };
  buildId?: number;
};
type Freshness = { indexState: string | null; engineStale: boolean; changedFiles: ChangeSet; lifecycle: Lifecycle };
type GraphValue<T> = { value?: T & { freshness: Freshness }; unavailable?: string };
type GraphEntry = { graph?: any; flight?: Flight; waiters: number; active: number };
type Flight = { controller: AbortController; waiters: number; settled: boolean; promise: Promise<{ graph: any; freshness: Freshness }> };
type GraphRegistry = Map<string, GraphEntry>;

const REGISTRY = Symbol.for("pitako.code-intelligence.graph-registry");
const BUILD_SEQUENCE = Symbol.for("pitako.code-intelligence.graph-build-sequence");
const BUILD_FAILURES = new WeakMap<object, { id: number; durationMs: number }>();
let sdkPromise: Promise<any> | undefined;

export function graphBuildFailure(value: unknown): { id: number; durationMs: number } | undefined {
  return value && typeof value === "object" ? BUILD_FAILURES.get(value) : undefined;
}

function nextBuildId(): number {
  const host = globalThis as typeof globalThis & { [key: symbol]: number | undefined };
  const id = (host[BUILD_SEQUENCE] ?? 0) + 1;
  host[BUILD_SEQUENCE] = id;
  return id;
}

function registry(): GraphRegistry {
  const global = globalThis as typeof globalThis & { [key: symbol]: GraphRegistry | undefined };
  return (global[REGISTRY] ??= new Map());
}

function isCodeGraphSdk(value: any): boolean {
  return typeof value?.CodeGraph?.init === "function" && typeof value.CodeGraph.isInitialized === "function" && typeof value.getCodeGraphDir === "function";
}

async function graphSdk(): Promise<any> {
  sdkPromise ??= import("@colbymchenry/codegraph").then((module: any) =>
    isCodeGraphSdk(module) ? module : isCodeGraphSdk(module.default) ? module.default : module.default ?? module,
  );
  const sdk = await sdkPromise;
  if (!isCodeGraphSdk(sdk)) throw new Error("CodeGraph SDK exports are unavailable");
  return sdk;
}

function dataKey(sdk: any, root: string): string {
  const dir = canonicalPath(sdk.getCodeGraphDir(root), root);
  return `${root}\0${dir}`;
}

function changedFiles(graph: any): ChangeSet {
  const changed = graph.getChangedFiles();
  return { added: [...changed.added], modified: [...changed.modified], removed: [...changed.removed] };
}

function changedCount(changed: ChangeSet): number {
  return changed.added.length + changed.modified.length + changed.removed.length;
}

function inspect(graph: any, lifecycle: Lifecycle): Freshness {
  const measured = { ...lifecycle };
  if (lifecycle.buildId !== undefined) Object.defineProperty(measured, "buildId", { value: lifecycle.buildId });
  return {
    indexState: graph.getIndexState(),
    engineStale: graph.isIndexStale(),
    changedFiles: changedFiles(graph),
    lifecycle: measured,
  };
}

function indexFailure(result: any): Error {
  const messages = (result.errors ?? []).map((error: any) => error.message).filter(Boolean);
  const contention = messages.some((message: string) => /lock|another process/i.test(message));
  const reason = messages.length ? `: ${messages.join("; ")}` : "";
  return new Error(`CodeGraph indexAll ${contention ? "contention" : "failed"} (success=${result.success})${reason}`);
}

function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}
function unsupportedRuntime(): string | undefined {
  return process.versions.bun
    ? "graph unavailable (runtime: CodeGraph requires Node's node:sqlite; run graph queries under Node 22.5+)"
    : undefined;
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function closeIfUnused(key: string, entry: GraphEntry): void {
  if (entry.flight || entry.waiters > 0 || entry.active > 0) return;
  if (entry.graph) {
    entry.graph.close();
    entry.graph = undefined;
  }
  registry().delete(key);
}

async function prepareGraph(sdk: any, root: string, entry: GraphEntry, signal: AbortSignal) {
  const started = performance.now();
  let action: Lifecycle["action"] = "reused";
  let graph = entry.graph;
  if (!graph) {
    if (sdk.CodeGraph.isInitialized(root)) {
      graph = await sdk.CodeGraph.open(root, { sync: false });
    } else {
      try {
        graph = await sdk.CodeGraph.init(root, { index: false });
        action = "built";
      } catch (error) {
        if (!sdk.CodeGraph.isInitialized(root)) throw error;
        graph = await sdk.CodeGraph.open(root, { sync: false });
      }
    }
    entry.graph = graph;
  }
  throwIfAborted(signal);

  let state = graph.getIndexState();
  let stale = graph.isIndexStale();
  let changed = changedFiles(graph);
  let indexAll: Lifecycle["indexAll"];
  let sync: Lifecycle["sync"];
  let buildId: number | undefined;

  if (state !== "complete" || stale) {
    if (action !== "built") action = "reindexed";
    buildId = nextBuildId();
    const buildStarted = performance.now();
    let result: any;
    try {
      result = await graph.indexAll({ signal });
      throwIfAborted(signal);
      if (!result.success) throw indexFailure(result);
    } catch (error) {
      if (error && typeof error === "object") BUILD_FAILURES.set(error, { id: buildId, durationMs: Math.round(performance.now() - buildStarted) });
      throw error;
    }
    indexAll = {
      success: result.success,
      filesIndexed: result.filesIndexed,
      filesSkipped: result.filesSkipped,
      filesErrored: result.filesErrored,
    };
  } else if (changedCount(changed) > 0) {
    const result = await graph.sync({ signal });
    throwIfAborted(signal);
    sync = { filesAdded: result.filesAdded, filesModified: result.filesModified, filesRemoved: result.filesRemoved };
    changed = changedFiles(graph);
    if (changedCount(changed) > 0) {
      throw new Error(`CodeGraph sync incomplete or lock contention (${changedCount(changed)} changed files remain; result ${JSON.stringify(sync)})`);
    }
    action = "synced";
  }

  state = graph.getIndexState();
  stale = graph.isIndexStale();
  changed = changedFiles(graph);
  if (state !== "complete" || stale || changedCount(changed) > 0) {
    throw new Error(`CodeGraph index verification failed (state=${state ?? "null"}, engineStale=${stale}, changedFiles=${changedCount(changed)})`);
  }

  return {
    graph,
    freshness: inspect(graph, {
      action,
      durationMs: Math.round(performance.now() - started),
      ...(indexAll ? { indexAll } : {}),
      ...(sync ? { sync } : {}),
      ...(buildId !== undefined ? { buildId } : {}),
    }),
  };
}

async function acquireGraph(root: string, signal: AbortSignal) {
  throwIfAborted(signal);
  root = canonicalPath(root);
  const sdk = await graphSdk();
  throwIfAborted(signal);
  const key = dataKey(sdk, root);
  const entries = registry();
  let drainedFlights = 0;

  while (true) {
    throwIfAborted(signal);
    let entry = entries.get(key);
    if (!entry) {
      entry = { waiters: 0, active: 0 };
      entries.set(key, entry);
    }

    let flight = entry.flight;
    if (flight?.settled) {
      entry.flight = undefined;
      flight = undefined;
    }
    // Let an already-aborted SDK write drain before a new caller retries it.
    if (flight && (flight.controller.signal.aborted || flight.waiters === 0)) {
      if (drainedFlights >= 2) throw new Error("CodeGraph flight was repeatedly aborted before acquisition");
      drainedFlights += 1;
      entry.waiters += 1;
      try {
        await waitFor(flight.promise.then(() => undefined, () => undefined), signal);
      } catch (error) {
        entry.waiters -= 1;
        closeIfUnused(key, entry);
        throw error;
      }
      entry.waiters -= 1;
      if (signal.aborted) {
        closeIfUnused(key, entry);
        throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      }
      continue;
    }

    if (!flight) {
      const controller = new AbortController();
      const currentEntry = entry;
      flight = {
        controller,
        waiters: 0,
        settled: false,
        promise: Promise.resolve(undefined as never),
      };
      entry.flight = flight;
      flight.promise = Promise.resolve()
        .then(() => prepareGraph(sdk, root, currentEntry, controller.signal))
        .finally(() => {
          flight!.settled = true;
          if (currentEntry.flight === flight) currentEntry.flight = undefined;
          closeIfUnused(key, currentEntry);
        });
    }

    entry.waiters += 1;
    flight.waiters += 1;
    try {
      const ready = await waitFor(flight.promise, signal);
      entry.active += 1;
      return {
        ...ready,
        release: () => {
          entry!.active -= 1;
          closeIfUnused(key, entry!);
        },
      };
    } finally {
      entry.waiters -= 1;
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) flight.controller.abort(new DOMException("No graph waiters remain", "AbortError"));
      closeIfUnused(key, entry);
    }
  }
}

export async function withCodeGraph<T extends Record<string, unknown>>(
  root: string,
  signal: AbortSignal,
  query: (graph: any) => T,
): Promise<GraphValue<T>> {
  throwIfAborted(signal);
  const runtime = unsupportedRuntime();
  if (runtime) return { unavailable: runtime };
  let lease: Awaited<ReturnType<typeof acquireGraph>> | undefined;
  try {
    lease = await acquireGraph(root, signal);
    throwIfAborted(signal);
    return { value: Object.assign({}, query(lease.graph), { freshness: lease.freshness }) };
  } catch (error) {
    if (signal.aborted) throw error;
    const result: GraphValue<T> = { unavailable: `graph unavailable (${error instanceof Error ? error.message : String(error)})` };
    const failedBuild = graphBuildFailure(error);
    if (failedBuild) BUILD_FAILURES.set(result, failedBuild);
    return result;
  } finally {
    lease?.release();
  }
}

/** Passive graph availability for project_report; this never initializes or updates an index. */
export async function withExistingCodeGraph<T extends Record<string, unknown>>(
  root: string,
  signal: AbortSignal,
  query: (graph: any) => T,
): Promise<GraphValue<T>> {
  throwIfAborted(signal);
  const runtime = unsupportedRuntime();
  if (runtime) return { unavailable: runtime };
  let graph: any;
  try {
    root = canonicalPath(root);
    const sdk = await graphSdk();
    throwIfAborted(signal);
    if (!sdk.CodeGraph.isInitialized(root)) return { unavailable: "index absent" };
    graph = await sdk.CodeGraph.open(root, { sync: false });
    throwIfAborted(signal);
    return { value: Object.assign({}, query(graph), { freshness: inspect(graph, { action: "observed", durationMs: 0 }) }) };
  } catch (error) {
    if (signal.aborted) throw error;
    return { unavailable: `graph unavailable (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    graph?.close();
  }
}
