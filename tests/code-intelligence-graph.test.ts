import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { graphBuildFailure, withCodeGraph, withExistingCodeGraph } from "../extensions/code-intelligence/graph.ts";
import { module_report, project_report } from "../extensions/code-intelligence/tools.ts";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(path.join(tmpdir(), "pitako-graph-policy-"));
  roots.push(value);
  return value;
};
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const complete = { success: true, filesIndexed: 1, filesSkipped: 0, filesErrored: 0 };
function fixture(options: { initialized?: boolean; state?: string; stale?: boolean; directory?: string } = {}) {
  let initialized = options.initialized ?? false, state = options.state ?? "absent", stale = options.stale ?? false;
  let changed = { added: [] as string[], modified: [] as string[], removed: [] as string[] };
  const calls = { init: 0, open: 0, index: 0, sync: 0, close: 0 };
  const graph = {
    getIndexState: () => state,
    isIndexStale: () => stale,
    getChangedFiles: () => changed,
    async indexAll(_options: { signal: AbortSignal }) { calls.index++; state = "complete"; stale = false; return complete; },
    async sync(_options: { signal: AbortSignal }) { calls.sync++; changed = { added: [], modified: [], removed: [] }; return { filesAdded: 0, filesModified: 1, filesRemoved: 0 }; },
    close() { calls.close++; },
    getFiles: () => ["sample.ts"],
    getNodesInFile: (_file: string) => [{ kind: "file" }],
    getFileDependents: (_file: string) => ["consumer.ts", "consumer.ts", "other.ts"],
  };
  const sdk = {
    getCodeGraphDir: (cwd: string) => options.directory ?? path.join(cwd, ".controlled"),
    CodeGraph: {
      isInitialized: (_cwd: string) => initialized,
      async init(_cwd: string, opts: { index: boolean }) { expect(opts.index).toBe(false); calls.init++; initialized = true; return graph; },
      async open(_cwd: string, opts: { sync: boolean }) { expect(opts.sync).toBe(false); calls.open++; return graph; },
    },
  };
  return { graph, calls, deps: { sdk: async () => sdk, unsupportedRuntime: () => undefined },
    modify() { changed.modified.push("sample.ts"); } };
}
const signal = () => new AbortController().signal;

test("build, reuse, stale reindex, sync and verification close every lease", async () => {
  const cwd = root(), f = fixture();
  const first = await withCodeGraph(cwd, signal(), () => ({ found: true }), f.deps);
  expect(first.value?.freshness.lifecycle).toMatchObject({ action: "built", indexAll: complete });
  expect(f.calls).toEqual({ init: 1, open: 0, index: 1, sync: 0, close: 1 });
  expect((await withCodeGraph(cwd, signal(), () => ({}), f.deps)).value?.freshness.lifecycle.action).toBe("reused");
  f.modify();
  expect((await withCodeGraph(cwd, signal(), () => ({}), f.deps)).value?.freshness.lifecycle.action).toBe("synced");
  const stale = fixture({ initialized: true, state: "complete", stale: true });
  expect((await withCodeGraph(cwd, signal(), () => ({}), stale.deps)).value?.freshness.lifecycle.action).toBe("reindexed");
  expect(stale.calls.index).toBe(1);
  expect(stale.calls.close).toBe(1);
  const failed = fixture();
  failed.graph.indexAll = async () => ({ ...complete, success: false, errors: [{ message: "another process lock" }] });
  const unavailable = await withCodeGraph(cwd, signal(), () => ({}), failed.deps);
  expect(unavailable.unavailable).toContain("indexAll contention");
  expect(graphBuildFailure(unavailable)?.id).toBeNumber();
  expect(failed.calls.close).toBe(1);
  const incomplete = fixture({ initialized: true, state: "complete" });
  incomplete.modify();
  incomplete.graph.sync = async () => ({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
  expect((await withCodeGraph(cwd, signal(), () => ({}), incomplete.deps)).unavailable).toContain("sync incomplete");
  expect(incomplete.calls.close).toBe(1);
});

test("passive graph and project report never initialize or refresh an index", async () => {
  const cwd = root(), absent = fixture();
  expect(await withExistingCodeGraph(cwd, signal(), () => ({}), absent.deps)).toEqual({ unavailable: "index absent" });
  const report = await project_report.execute("passive", {}, signal(), undefined, { cwd, graphDependencies: absent.deps });
  expect(report.details.codeIntelligence).toMatchObject({ graph: { state: "absent" } });
  expect(absent.calls).toEqual({ init: 0, open: 0, index: 0, sync: 0, close: 0 });
  const stale = fixture({ initialized: true, state: "incomplete", stale: true });
  const observed = await withExistingCodeGraph(cwd, signal(), g => ({ count: g.getFiles().length }), stale.deps);
  expect(observed.value).toMatchObject({ count: 1, freshness: { indexState: "incomplete", engineStale: true, lifecycle: { action: "observed" } } });
  expect(stale.calls).toEqual({ init: 0, open: 1, index: 0, sync: 0, close: 1 });
});

test("module consumers deduplicate, retain distinct total and truncate their bounded view", async () => {
  const cwd = root(), f = fixture({ initialized: true, state: "complete" });
  writeFileSync(path.join(cwd, "sample.ts"), "export const sample = 1;\n");
  const invoke = async () => JSON.parse((await module_report.execute("consumers", { file: "sample.ts" }, signal(), undefined,
    { cwd, graphDependencies: f.deps })).content[0].text);
  expect((await invoke()).graph).toMatchObject({ consumers: [{ file: "consumer.ts" }, { file: "other.ts" }], total: 2, truncated: false });
  const files = Array.from({ length: 10 }, (_, index) => `consumer-${index}.ts`);
  f.graph.getFileDependents = () => [...files, ...files];
  const report = await invoke();
  expect(report.graph).toMatchObject({ status: "partial", total: 10, truncated: true });
  expect(report.graph.consumers.map((entry: { file: string }) => entry.file)).toEqual(files.slice(0, 8));
  expect(f.calls.close).toBe(2);
});

test("joined waiters share a build; cancelling one does not abort independent progress", async () => {
  const cwd = root(), f = fixture(), started = deferred<AbortSignal>(), finish = deferred<typeof complete>();
  let done = false;
  f.graph.indexAll = async ({ signal }) => { f.calls.index++; started.resolve(signal); const result = await finish.promise; done = true; return result; };
  f.graph.getIndexState = () => done ? "complete" : "absent";
  const cancelled = new AbortController();
  const one = withCodeGraph(cwd, cancelled.signal, () => ({ id: 1 }), f.deps);
  const two = withCodeGraph(cwd, signal(), () => ({ id: 2 }), f.deps);
  try {
    const buildSignal = await started.promise;
    cancelled.abort();
    await expect(one).rejects.toThrow();
    expect(buildSignal.aborted).toBe(false);
    finish.resolve(complete);
    expect((await two).value?.id).toBe(2);
    expect(f.calls.index).toBe(1);
    expect(f.calls.close).toBe(1);
  } finally { finish.resolve(complete); await Promise.allSettled([one, two]); }
});

test("registry separates both project roots and physical graph directories", async () => {
  const a = root(), b = root(), physical = path.join(a, ".shared");
  const fixtures = [fixture({ directory: physical }), fixture({ directory: physical }), fixture({ directory: path.join(a, ".other") })];
  const starts = fixtures.map(() => deferred<void>()), finishes = fixtures.map(() => deferred<typeof complete>());
  for (const [index, f] of fixtures.entries()) {
    let done = false;
    f.graph.getIndexState = () => done ? "complete" : "absent";
    f.graph.indexAll = async () => { f.calls.index++; starts[index]!.resolve(); const result = await finishes[index]!.promise; done = true; return result; };
  }
  const attempts = fixtures.map((f, index) => withCodeGraph(index === 1 ? b : a, signal(), () => ({ index }), f.deps));
  try {
    await Promise.all(starts.map(start => start.promise));
    for (const finish of finishes) finish.resolve(complete);
    expect((await Promise.all(attempts)).map(value => value.value?.index)).toEqual([0, 1, 2]);
    for (const f of fixtures) expect(f.calls).toMatchObject({ init: 1, index: 1, close: 1 });
  } finally { for (const finish of finishes) finish.resolve(complete); await Promise.allSettled(attempts); }
});

test("last waiter abort drains an owned build before a new acquisition and cleanup", async () => {
  const cwd = root(), f = fixture(), started = deferred<AbortSignal>(), finish = deferred<typeof complete>();
  let done = false;
  f.graph.indexAll = async ({ signal }) => { f.calls.index++; started.resolve(signal); const result = await finish.promise; done = true; return result; };
  f.graph.getIndexState = () => done ? "complete" : "absent";
  const stop = new AbortController();
  const abandoned = withCodeGraph(cwd, stop.signal, () => ({}), f.deps);
  let replacement: ReturnType<typeof withCodeGraph> | undefined;
  try {
    const buildSignal = await started.promise;
    stop.abort();
    await expect(abandoned).rejects.toThrow();
    expect(buildSignal.aborted).toBe(true);
    expect(f.calls.close).toBe(0);
    replacement = withCodeGraph(cwd, signal(), () => ({ settled: true }), f.deps);
    finish.resolve(complete);
    expect((await replacement).value?.settled).toBe(true);
    expect(f.calls.index).toBe(1);
    expect(f.calls.close).toBe(1);
  } finally { finish.resolve(complete); await Promise.allSettled([abandoned, replacement]); }
});

test("pre-aborted callers and Bun rejection never acquire the SDK; query failure releases its graph", async () => {
  const cwd = root(), stop = new AbortController();
  let calls = 0;
  const deps = { sdk: async () => { calls++; throw new Error("SDK must not load"); } };
  stop.abort();
  await expect(withCodeGraph(cwd, stop.signal, () => ({}), deps)).rejects.toThrow();
  await expect(withExistingCodeGraph(cwd, stop.signal, () => ({}), deps)).rejects.toThrow();
  expect((await withCodeGraph(cwd, signal(), () => ({}), deps)).unavailable).toContain("CodeGraph requires Node");
  expect((await withExistingCodeGraph(cwd, signal(), () => ({}), deps)).unavailable).toContain("CodeGraph requires Node");
  expect(calls).toBe(0);
  const f = fixture();
  expect((await withCodeGraph(cwd, signal(), () => { throw new Error("controlled query failure"); }, f.deps)).unavailable).toBe("graph unavailable (controlled query failure)");
  expect(f.calls.close).toBe(1);
  expect((await withCodeGraph(cwd, signal(), () => ({ independent: true }), f.deps)).value?.independent).toBe(true);
  expect(f.calls.close).toBe(2);
});

test("a rejected abandoned build drains before its waiting replacement retries", async () => {
  const cwd = root(), f = fixture(), entered = deferred<void>(), release = deferred<void>();
  let done = false;
  f.graph.getIndexState = () => done ? "complete" : "absent";
  f.graph.indexAll = async () => {
    f.calls.index++;
    if (f.calls.index === 1) { entered.resolve(); await release.promise; throw new DOMException("build aborted", "AbortError"); }
    done = true;
    return complete;
  };
  const stop = new AbortController();
  const abandoned = withCodeGraph(cwd, stop.signal, () => ({}), f.deps);
  let replacement: ReturnType<typeof withCodeGraph> | undefined;
  try {
    await entered.promise;
    stop.abort();
    await expect(abandoned).rejects.toThrow();
    replacement = withCodeGraph(cwd, signal(), () => ({ retried: true }), f.deps);
    release.resolve();
    expect((await replacement).value?.retried).toBe(true);
    expect(f.calls.index).toBe(2);
    expect(f.calls.close).toBe(1);
  } finally { release.resolve(); await Promise.allSettled([abandoned, replacement]); }
});

test("an acquisition stops after draining two repeatedly abandoned flights", async () => {
  const cwd = root(), f = fixture();
  const registryKey = Symbol.for("pitako.code-intelligence.graph-registry");
  const global = globalThis as typeof globalThis & { [key: symbol]: Map<string, any> | undefined };
  const entries = global[registryKey] ??= new Map();
  const key = `${cwd}\0${path.join(cwd, ".controlled")}`;
  let drains = 0;
  const entry = { waiters: 0, active: 0, flight: undefined as any };
  // Control only this root's existing-flight responses; SDK selection remains operation-local.
  const abandoned = (): any => {
    const controller = new AbortController(); controller.abort();
    return { controller, waiters: 0, settled: false,
      get promise() {
        drains++;
        return Promise.resolve().then(() => { entry.flight = abandoned(); });
      } };
  };
  entry.flight = abandoned(); entries.set(key, entry);
  try {
    const result = await withCodeGraph(cwd, signal(), () => ({}), f.deps);
    expect(result.unavailable).toContain("flight was repeatedly aborted before acquisition");
    expect(drains).toBe(2);
    expect(entry.waiters).toBe(0);
    expect(f.calls.init).toBe(0);
  } finally { entries.delete(key); }
  expect((await withCodeGraph(cwd, signal(), () => ({ independent: true }), f.deps)).value?.independent).toBe(true);
  expect(f.calls.close).toBe(1);
});
