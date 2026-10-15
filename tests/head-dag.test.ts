import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { HeadAttachment, type HeadDagOptions } from "../extensions/agent/head/runtime.ts";
import { HeadGraph } from "../extensions/agent/head/graph.ts";
import { developerCapacityPreflight } from "../extensions/agent/routing.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { runAgentInstance } from "../extensions/agent/run.ts";
import { loadPitakoConfig } from "../extensions/roles/load.ts";
import { providerFixtureOwnership } from "./fixtures/provider-fixture-ownership.ts";
import { controlledPi } from "./fixtures/pi-factories.ts";

const fixture = providerFixtureOwnership();
const deferred = () => Promise.withResolvers<void>();
const node = (id: string, writes = [id], deps: string[] = [], brief = `Implement ${id}`) =>
  ({ id, writes, deps, brief, capacity: { route: "direct" as const, profile: "developer_mid" as const } });
type Tool = { execute: Function };
async function bind(factories: ExtensionFactory[], appendEntry: ExtensionAPI["appendEntry"]) {
  const tools = new Map<string, Tool>(), events = new Map<string, Function[]>();
  const api = {
    appendEntry,
    registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
    on(name: string, callback: Function) {
      events.set(name, [...(events.get(name) ?? []), callback]);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  for (const factory of factories) await factory(api);
  return { tools, events };
}
type Local = Awaited<ReturnType<typeof bind>>;
type Leaf = {
  entered: ReturnType<typeof deferred>; finish: ReturnType<typeof deferred>;
  disposing: ReturnType<typeof deferred>; releaseDispose: ReturnType<typeof deferred>;
  local?: Local; session?: any; task?: string;
};
async function harness(options: { maxParallel?: number; preflight?: HeadDagOptions["preflight"]; rootAlias?: boolean;
  gitRepository?: boolean;
  leafFallback?: boolean; workerPrompt?: NonNullable<Parameters<typeof controlledPi>[1]>["prompt"];
  prepareWorkers?: (workers: ReturnType<typeof controlledPi>) => void } = {}) {
  const ownedRoot = mkdtempSync(path.join(tmpdir(), "pitako-head-dag-"));
  fixture.directories.push(ownedRoot);
  if (options.gitRepository) {
    execFileSync("git", ["init", "--quiet", ownedRoot]);
    execFileSync("git", ["-C", ownedRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "--allow-empty", "-m", "admission"]);
  }
  const root = options.rootAlias ? path.join(ownedRoot, "checkout") : ownedRoot;
  if (options.rootAlias) symlinkSync(ownedRoot, root);
  const agentDir = options.gitRepository ? mkdtempSync(path.join(tmpdir(), "pitako-managed-home-")) : root;
  if (options.gitRepository) fixture.directories.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const userConfigPath = path.join(agentDir, "pitako", "config.toml");
  mkdirSync(path.dirname(userConfigPath), { recursive: true });
  writeFileSync(userConfigPath, `[model_policies.developer.primary]
model = "fixture/selected"
reasoning = "off"
[model_policies.developer_head.primary]
model = "fixture/selected"
reasoning = "off"
[model_policies.developer_mid.primary]
model = "fixture/selected"
reasoning = "off"
${options.leafFallback ? '[[model_policies.developer_mid.fallbacks]]\nmodel = "fixture/selected"\nreasoning = "high"' : ""}
[head_developer]
max_parallel = ${options.maxParallel ?? 3}
`);
  const load = { userConfigPath, env: { PI_CODING_AGENT_DIR: agentDir } };
  const config = loadPitakoConfig(load);
  const leaves = new Map<string, Leaf>();
  const get = (id: string): Leaf => {
    if (!leaves.has(id)) leaves.set(id, { entered: deferred(), finish: deferred(), disposing: deferred(), releaseDispose: deferred() });
    return leaves.get(id)!;
  };
  const starts: string[] = [];
  const leafLocals = new Map<object, Local>();
  const workers = controlledPi(agentDir, {
    bind: async session => {
      const index = workers.sessionInputs.findIndex(input => input.sessionManager === session.sessionManager);
      const local = await bind(workers.loaderInputs[index].extensionFactories,
        (type, data) => { session.sessionManager.appendCustomEntry(type, data); });
      for (const tool of workers.sessionInputs[index].customTools ?? []) local.tools.set(tool.name, tool);
      leafLocals.set(session, local);
      (session as any).steer = async () => "queued";
      session.getAllTools = () => ["read", "bash", "agent_run", "team_assign", ...local.tools.keys()].map(name => ({ name }));
    },
    prompt: async (session, task) => {
      if (options.workerPrompt) return options.workerPrompt(session, task);
      const parsed = JSON.parse(task);
      const id = parsed.brief.match(/Implement (\w+)/)?.[1] ?? parsed.brief;
      const leaf = get(id);
      leaf.session = session; leaf.task = task; leaf.local = leafLocals.get(session)!;
      starts.push(id);
      for (const event of leaf.local.events.get("turn_start") ?? []) await event({});
      leaf.entered.resolve();
      await leaf.finish.promise;
      session.messages.push({ role: "assistant", content: [{ type: "text", text: `Result ${id}` }], stopReason: "stop" });
    },
    abort: session => {
      const leaf = [...leaves.values()].find(leaf => leaf.session === session);
      leaf?.finish.resolve();
    },
    dispose: async session => {
      const leaf = [...leaves.values()].find(leaf => leaf.session === session);
      if (leaf) { leaf.disposing.resolve(); await leaf.releaseDispose.promise; }
    },
  });
  options.prepareWorkers?.(workers);
  const head = new HeadAttachment("owned-assignment", ownedRoot, { writes: ["."], config,
    executor: createPiExecutor({ factories: workers.factories }), preflight: options.preflight });
  let local!: Local, ctx!: ExtensionContext;
  const headEntered = deferred(), headFinish = deferred();
  const host = controlledPi(agentDir, {
    bind: async session => {
      local = await bind(host.loaderInputs[0].extensionFactories,
        (type, data) => { session.sessionManager.appendCustomEntry(type, data); });
      for (const tool of host.sessionInputs[0].customTools ?? []) local.tools.set(tool.name, tool);
      ctx = { cwd: root, sessionManager: session.sessionManager, modelRegistry: {
        getAvailableOfType: async () => [{ id: config.developerRouting.classifierModel,
          provider: config.developerRouting.classifierProvider, contextWindow: 100000 }],
        classify: async () => ({ stopReason: "stop", answers: { capacity: { type: "choice", choice: "developer_mid",
          probabilities: { developer_senior: 0.1, developer_mid: 0.8, developer_junior: 0.1, indeterminate: 0 } } } }),
      } } as unknown as ExtensionContext;
    },
    prompt: async session => {
      headEntered.resolve(); await headFinish.promise;
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "diagnostic Head" }], stopReason: "stop" });
    },
    abort: () => { headFinish.resolve(); },
  });
  const run = fixture.run(runAgentInstance({ roleId: "developer", task: "PARENT SECRET AND WHOLE TRANSCRIPT",
    cwd: root, load, head, executor: createPiExecutor({ factories: host.factories }) }));
  fixture.beforeRelease(() => {
    head.revoke(); headFinish.resolve();
    for (const leaf of leaves.values()) { leaf.finish.resolve(); leaf.releaseDispose.resolve(); }
  });
  await headEntered.promise;
  const call = async (name: string, params: unknown, signal?: AbortSignal) => {
    const result = await local.tools.get(name)!.execute(`${name}-call`, params, signal, undefined, ctx);
    return result.details;
  };
  const read = () => call("head_plan", { action: "read" });
  const edit = async (nodes: ReturnType<typeof node>[], supersede: string[] = [], expectedRevision?: number) =>
    call("head_plan", { action: "edit", expectedRevision: expectedRevision ?? (await read()).revision, nodes, supersede });
  const start = async (nodeIds: string[], signal?: AbortSignal) =>
    call("head_start", { expectedRevision: (await read()).revision, nodeIds }, signal);
  const result = (runId: string) => call("head_result", { childId: runId });
  const identity = async (runId: string) => {
    const run = await result(runId);
    return { runId, effectiveRevision: run.effectiveRevision, ...run.native };
  };
  const review = async (runId: string, effectiveRevision: number, judgment = "satisfied") =>
    call("head_review", { runId, effectiveRevision, judgment, evidence: ["controlled diff and test evidence"], reason: "Head inspected the bounded result" });
  const closed = async (runId: string) => {
    let cursor = 0;
    for (;;) {
      const current = await result(runId);
      if (current.phase === "closed" || current.phase === "unknown") return current;
      const events = await call("head_wait", { after: cursor });
      cursor = events.cursor;
    }
  };
  const finish = async () => {
    for (const leaf of leaves.values()) { leaf.finish.resolve(); leaf.releaseDispose.resolve(); }
    headFinish.resolve();
    await run;
  };
  return { root, head, host, workers, get, starts, call, edit, start, result, identity, review, closed, finish, read, run };
}

test("registered dispatch admits disjoint leaves simultaneously; delivery and termination do not satisfy dependencies", fixture.ownedCase("DAG parallel dispatch", async () => {
  const h = await harness({ rootAlias: true });
  await h.edit([node("a"), node("b", ["b"], [], "Implement b SIBLING SECRET"), node("c", ["c"], ["a"])]);
  const [a, b] = await h.start(["a", "b"]);
  await Promise.all([h.get("a").entered.promise, h.get("b").entered.promise]);
  expect(h.starts).toEqual(["a", "b"]);
  expect(h.get("a").session.events).not.toContain("dispose");
  const brief = JSON.parse(h.get("a").task!);
  expect(brief).toMatchObject({ brief: "Implement a", writes: ["a"], dependencies: [] });
  expect(h.get("a").task).not.toContain("SECRET");
  expect(h.get("a").session.active).toContain("head_scope_ack");
  expect(h.get("a").session.active).not.toContain("agent_run");
  expect(h.get("a").local!.tools.has("head_scope_ack")).toBe(true);
  expect(h.get("a").local!.tools.has("head_checkpoint")).toBe(false);
  expect(h.get("a").local!.tools.has("write")).toBe(true);
  h.get("a").finish.resolve();
  await h.get("a").disposing.promise;
  expect((await h.result(a.runId)).envelope).toBeUndefined();
  await expect(h.review(a.runId, a.effectiveRevision)).rejects.toThrow("physical closure");
  await expect(h.start(["c"])).rejects.toThrow("not ready");
  expect(h.starts).not.toContain("c");
  h.get("a").releaseDispose.resolve();
  const outcome = await h.closed(a.runId);
  expect(outcome.envelope.result.result).toBe("Result a");
  // Reading a closed native outcome is not judgment.
  const delivered = await h.call("head_wait", { after: 0 });
  expect(delivered.outcomes.map((outcome: { runId: string }) => outcome.runId)).toEqual([a.runId]);
  await expect(h.start(["c"])).rejects.toThrow("not ready");
  await h.review(a.runId, a.effectiveRevision);
  expect((await h.call("head_wait", { after: delivered.cursor })).outcomes).toEqual([]);
  const [c] = await h.start(["c"]);
  await h.get("c").entered.promise;
  expect(JSON.parse(h.get("c").task!).dependencies[0]).toMatchObject({ id: "a", contract: "Implement a" });
  expect(h.starts).toEqual(["a", "b", "c"]);
  h.get("b").finish.resolve(); h.get("b").releaseDispose.resolve();
  h.get("c").finish.resolve(); h.get("c").releaseDispose.resolve();
  await Promise.all([h.closed(b.runId), h.closed(c.runId)]);
  await h.review(b.runId, 1, "rejected");
  await h.edit([node("b", ["b"], [], "Implement b correction")]);
  expect((await h.read()).history).toContainEqual(expect.objectContaining({ id: "b", judgment: "rejected" }));
  expect((await h.result(b.runId)).envelope.result.result).toBe("Result b");
  await expect(h.review(b.runId, 1)).rejects.toThrow("stale");
  console.info("T3 parallel observation", JSON.stringify({ root: h.root, executionRoot: h.head.executionRoot, starts: h.starts,
    runs: [a.runId, b.runId, c.runId], nativePaths: h.workers.sessions.map(session => session.sessionManager.getSessionFile()),
    dependentStartedOnlyAfterClosedAndSatisfied: true }));
  await h.finish();
}));

test("granted leaves keep independent managed reservations and closed native source identities", fixture.ownedCase("managed leaf producers", async () => {
  const h = await harness({ gitRepository: true, rootAlias: true });
  await h.edit([node("a"), node("b")]);
  const [a, b] = await h.start(["a", "b"]);
  await Promise.all([h.get("a").entered.promise, h.get("b").entered.promise]);
  const invoke = (id: string) => {
    const leaf = h.get(id), session = leaf.session;
    expect(session.active).toContain("write");
    for (const tool of ["head_plan", "head_finish", "head_start"]) expect(session.active).not.toContain(tool);
    return leaf.local!.tools.get("write")!.execute(`write-${id}`, { path: id, content: `owned ${id}\n` }, undefined, undefined,
      { cwd: h.root, sessionManager: session.sessionManager }).then((result: any) => {
        session.sessionManager.appendMessage({ role: "toolResult", toolName: "write", toolCallId: `write-${id}`,
          content: result.content, isError: false, timestamp: Date.now() });
      });
  };
  const first = invoke("a"), second = invoke("b");
  expect(h.head.managed!.snapshot().active).toBe(2);
  await Promise.all([first, second]);
  expect(() => h.get("a").local!.tools.get("write")!.execute("escape", { path: "b", content: "no" }, undefined, undefined,
    { cwd: h.root })).toThrow("write reservation");
  const original = h.head.managed!.snapshot().inventory.admission;
  expect(original!.root).toBe(realpathSync(h.root));
  for (const id of ["a", "b"]) { h.get(id).finish.resolve(); h.get(id).releaseDispose.resolve(); }
  await Promise.all([h.closed(a.runId), h.closed(b.runId)]);
  const snapshot = h.head.managed!.snapshot();
  expect(snapshot.inventory.admission).toEqual(original);
  for (const run of [a, b]) {
    expect(snapshot.native).toContainEqual(expect.objectContaining({
      source: expect.objectContaining({ kind: "leaf", runId: run.runId, observedRevision: run.effectiveRevision }),
      closure: "released", entries: [expect.objectContaining({ toolName: "write", isError: false })],
    }));
    await h.review(run.runId, run.effectiveRevision);
  }
  await h.call("head_plan", { action: "beginIntegration", expectedRevision: 1 });
  expect(h.head.managed!.snapshot().inventory.admission).toEqual(original);
  expect(h.head.managed!.snapshot().inventory.gaps).toEqual([]);
  expect(readFileSync(path.join(h.root, "a"), "utf8")).toBe("owned a\n");
  expect(readFileSync(path.join(h.root, "b"), "utf8")).toBe("owned b\n");
  await h.finish();
}));

test("invalid transactions and mixed start batches have zero partial admissions; native identities are scoped", fixture.ownedCase("DAG atomic rejection", async () => {
  const h = await harness();
  await expect(h.edit([node("x", ["x"], ["y"]), node("y", ["y"], ["x"])])).rejects.toThrow("cycle");
  expect((await h.read()).nodes).toEqual([]);
  await expect(h.edit([node("escape", ["../escape"])])).rejects.toThrow("envelope");
  symlinkSync(tmpdir(), path.join(h.root, "alias"));
  await expect(h.edit([node("alias", ["alias/escape"])])).rejects.toThrow("envelope");
  symlinkSync(path.join(tmpdir(), `missing-head-${path.basename(h.root)}`), path.join(h.root, "dangling"));
  await expect(h.edit([node("dangling", ["dangling/escape"])])).rejects.toThrow("symlink");
  expect((await h.read()).revision).toBe(0);
  await h.edit([node("a", ["src"]), node("b", ["src/file"]), node("ok", [])]);
  await expect(h.edit([node("stale")], [], 0)).rejects.toThrow("stale");
  await expect(h.start(["a", "b"])).rejects.toThrow("conflict");
  await expect(h.start(["ok", "foreign"])).rejects.toThrow("unknown");
  expect((await h.read()).runs).toEqual([]);
  expect(h.starts).toEqual([]);
  const [run] = await h.start(["ok"]);
  await h.get("ok").entered.promise;
  const own = await h.identity(run.runId);
  await expect(h.call("head_observe", { ...own, runId: "foreign" })).rejects.toThrow("foreign");
  await expect(h.call("head_input", { ...own, sessionId: "foreign", intent: "steer", text: "not yours" })).rejects.toThrow("native");
  await expect(h.review("foreign", own.effectiveRevision)).rejects.toThrow("foreign");
  const observed = await h.call("head_observe", own);
  expect(observed.activity.native).toMatchObject({ sessionId: own.sessionId, historyId: own.historyId });
  h.get("ok").session.sessionId = "replaced-native-session";
  await expect(h.call("head_observe", own)).rejects.toThrow("native");
  await expect(h.call("head_input", { ...own, intent: "query", text: "old identity" })).rejects.toThrow("native");
  expect(() => h.get("ok").local!.tools.get("head_scope_ack")!.execute("current", { action: "current" })).toThrow("retired");
  await h.finish();
}));

test("failed preflight releases only its own settled reservation; a cancelling leaf occupies capacity through disposal", fixture.ownedCase("DAG reservation settlement", async () => {
  const preflightEntered = deferred(), releasePreflight = deferred();
  fixture.beforeRelease(() => { releasePreflight.resolve(); });
  const h = await harness({ maxParallel: 2, preflight: async input => {
    if (JSON.parse(input.task).brief === "Implement fail") {
      preflightEntered.resolve(); await releasePreflight.promise; throw new Error("controlled preflight failure");
    }
    return developerCapacityPreflight(input);
  } });
  await h.edit([node("live"), node("fail"), node("next"), node("last")]);
  const [live, fail] = await h.start(["live", "fail"]);
  await Promise.all([h.get("live").entered.promise, preflightEntered.promise]);
  await expect(h.start(["next"])).rejects.toThrow("limit");
  expect((await h.result(fail.runId)).closure.state).toBe("pending");
  releasePreflight.resolve();
  expect((await h.closed(fail.runId)).diagnostic).toContain("controlled preflight failure");
  const [next] = await h.start(["next"]);
  await h.get("next").entered.promise;
  await h.call("head_plan", { action: "cancel", runIds: [live.runId] });
  await h.get("live").disposing.promise;
  expect((await h.result(live.runId)).closure.state).toBe("pending");
  await expect(h.start(["last"])).rejects.toThrow("limit");
  expect(h.starts).toEqual(["live", "next"]);
  h.get("live").releaseDispose.resolve();
  expect((await h.closed(live.runId)).closure.state).toBe("released");
  await h.start(["last"]);
  await h.get("last").entered.promise;
  h.get("next").finish.resolve(); h.get("next").releaseDispose.resolve();
  await h.closed(next.runId);
  await h.finish();
}));

test("successful classify snapshot is fenced before actual start when grant, signal, or revision changes", fixture.ownedCase("DAG post-snapshot fence", async () => {
  for (const mutation of ["grant", "signal", "revision"]) {
    const snapshotReady = deferred(), allowReturn = deferred();
    fixture.beforeRelease(() => { allowReturn.resolve(); });
    let successfulSnapshot: unknown;
    const h = await harness({ preflight: async input => {
      successfulSnapshot = await developerCapacityPreflight(input);
      snapshotReady.resolve(); await allowReturn.promise;
      return successfulSnapshot as Awaited<ReturnType<typeof developerCapacityPreflight>>;
    } });
    const selected = { ...node("classified"), capacity: { route: "classify" as const } };
    await h.call("head_plan", { action: "edit", expectedRevision: 0, nodes: [selected], supersede: [] });
    const abort = new AbortController();
    const [run] = await h.start(["classified"], abort.signal);
    await snapshotReady.promise;
    expect(successfulSnapshot).toMatchObject({ routing: { route: "classify", reason: "unique classifier choice",
      response: { stopReason: "stop" } } });
    expect(h.starts).toEqual([]);
    if (mutation === "grant") h.head.revoke();
    if (mutation === "signal") abort.abort();
    if (mutation === "revision") await h.edit([node("independent")]);
    allowReturn.resolve();
    if (mutation !== "grant") {
      const closed = await h.closed(run.runId);
      expect(closed).toMatchObject({ instanceId: undefined, phase: "closed", closure: { state: "released" } });
      expect(closed.dispatch.routing.reason).toBe("unique classifier choice");
    }
    await h.finish();
    expect(h.starts).toEqual([]);
    expect(h.workers.sessions).toEqual([]);
    expect(h.head.closure.state).toBe("released"); // No stranded unstarted reservations.
    console.info("T3 snapshot fence", JSON.stringify({ mutation, root: h.root, runId: run.runId,
      snapshotReason: (successfulSnapshot as any).routing.reason, starts: h.starts, closure: h.head.closure }));
  }
}));

for (const { stage, mutation } of [
  { stage: "setModel", mutation: "revision" },
  { stage: "bind", mutation: "revision" },
  { stage: "setModel", mutation: "grant" },
  { stage: "setModel", mutation: "signal" },
]) {
  test(`first prompt fences ${mutation} during SDK ${stage}; disposal retains reservations`,
    fixture.ownedCase(`DAG SDK startup ${stage}/${mutation}`, async () => {
      const entered = deferred(), release = deferred(), disposing = deferred(), releaseDispose = deferred();
      fixture.beforeRelease(() => { release.resolve(); releaseDispose.resolve(); });
      const h = await harness({ maxParallel: 1, prepareWorkers: workers => {
        const createSession = workers.factories.createSession!;
        workers.factories.createSession = async input => {
          const created = await createSession(input);
          // Only the stale startup is held; a later independent start must progress normally.
          if (workers.sessions.length === 1) {
            const session = created.session;
            const hold = async () => { entered.resolve(); await release.promise; };
            const setModel = session.setModel.bind(session), bindExtensions = session.bindExtensions.bind(session);
            if (stage === "setModel") session.setModel = async (...args) => { await hold(); await setModel(...args); };
            else session.bindExtensions = async (...args) => { await bindExtensions(...args); await hold(); };
            const dispose = session.dispose.bind(session);
            session.dispose = async () => { disposing.resolve(); await releaseDispose.promise; await dispose(); };
          }
          return created;
        };
      } });
      await h.edit([node("classified", ["shared"]), node("successor", ["shared/part"]),
        node("dependent", ["dependent"], ["classified"])]);
      const abort = new AbortController();
      const [run] = await h.start(["classified"], abort.signal);
      await entered.promise;
      const allocated = h.workers.sessions[0]!;
      expect(allocated.events).toContain("bind");
      expect((await h.result(run.runId)).instanceId).toBeDefined();
      expect(h.starts).toEqual([]);
      if (mutation === "revision") await h.edit([node("independent")]);
      if (mutation === "grant") h.head.revoke();
      if (mutation === "signal") abort.abort();
      // Let the wrong implementation finish too, so failure cannot strand its prompt.
      h.get("classified").finish.resolve(); h.get("classified").releaseDispose.resolve();
      release.resolve();
      await disposing.promise;
      const prompts = [...allocated.prompts];
      console.info("T3 SDK startup fence", JSON.stringify({ stage, mutation, root: h.root, runId: run.runId,
        allocatedSessions: h.workers.sessions.length, prompts: prompts.length, disposalPending: true }));
      if (mutation !== "grant") {
        const pending = await h.result(run.runId);
        expect(pending.closure.state).toBe("pending");
        expect(pending.envelope).toBeUndefined();
        expect(pending.originalWrites).toEqual([path.join(h.root, "shared")]);
        await expect(h.start(["successor"])).rejects.toThrow("limit");
        await expect(h.review(run.runId, run.effectiveRevision)).rejects.toThrow("physical closure");
      } else {
        await expect(h.start(["successor"])).rejects.toThrow("retired");
      }
      releaseDispose.resolve();
      if (mutation !== "grant") {
        const closed = await h.closed(run.runId);
        expect(closed.closure.state).toBe("released");
        expect(closed.envelope.result.status).not.toBe("completed");
        await expect(h.review(run.runId, run.effectiveRevision)).rejects.toThrow("only a completed");
        await expect(h.start(["dependent"])).rejects.toThrow("not ready");
        const [successor] = await h.start(["successor"]);
        await h.get("successor").entered.promise;
        h.get("successor").finish.resolve(); h.get("successor").releaseDispose.resolve();
        expect((await h.closed(successor.runId)).envelope.result.status).toBe("completed");
      }
      await h.finish();
      expect(h.head.closure.state).toBe("released");
      expect(prompts).toEqual([]);
      expect(allocated.events.filter(event => event === "dispose")).toHaveLength(1);
      if (mutation === "grant") expect(h.starts).toEqual([]);
    }));
}

test("same-session continuation tolerates independent graph edits but rejects retired grant or native identity",
  fixture.ownedCase("DAG continuation authority", async () => {
    for (const mutation of ["revision", "grant", "native"]) {
      const first = deferred(), releaseFirst = deferred(), activating = deferred(), releaseActivation = deferred();
      fixture.beforeRelease(() => { releaseFirst.resolve(); releaseActivation.resolve(); });
      const h = await harness({ leafFallback: true, prepareWorkers: workers => {
        const createSession = workers.factories.createSession!;
        workers.factories.createSession = async input => {
          const created = await createSession(input), session = created.session;
          const setModel = session.setModel.bind(session);
          let activations = 0;
          session.setModel = async (...args) => {
            if (++activations === 2) { activating.resolve(); await releaseActivation.promise; }
            await setModel(...args);
          };
          return created;
        };
      }, workerPrompt: async session => {
        if (session.prompts.length === 1) {
          session.emit({ type: "tool_execution_start", toolName: "write", toolCallId: "owned-mutation", args: {} });
          first.resolve(); await releaseFirst.promise;
          session.messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "network connection reset" });
        } else {
          session.messages.push({ role: "assistant", content: [{ type: "text", text: "continued bounded result" }], stopReason: "stop" });
        }
      } });
      await h.edit([node("retry")]);
      const [run] = await h.start(["retry"]);
      await first.promise;
      expect((await h.result(run.runId)).phase).toBe("running");
      releaseFirst.resolve();
      await activating.promise;
      const session = h.workers.sessions[0]!;
      if (mutation === "revision") await h.edit([node("independent")]);
      if (mutation === "grant") h.head.revoke();
      if (mutation === "native") session.sessionId = "retired-native-session";
      releaseActivation.resolve();
      if (mutation !== "grant") {
        const closed = await h.closed(run.runId);
        expect(closed.envelope.result.status).toBe(mutation === "revision" ? "completed" : "failed");
        if (mutation === "revision") expect(closed.envelope.result.result).toBe("continued bounded result");
      }
      await h.finish();
      expect(h.workers.sessions).toHaveLength(1);
      expect(session.prompts).toHaveLength(mutation === "revision" ? 2 : 1);
      if (mutation === "revision") expect(session.prompts[1]).not.toContain("Implement retry");
      expect(h.head.closure.state).toBe("released");
      console.info("T3 continuation fence", JSON.stringify({ mutation, root: h.root, runId: run.runId,
        sessions: h.workers.sessions.length, prompts: session.prompts.length, closure: h.head.closure }));
    }
  }));

test("active split negotiates receipt, leaf ack, and confirmation; original writes remain reserved until donor closure", fixture.ownedCase("DAG negotiated split", async () => {
  const h = await harness();
  await h.edit([node("donor", ["shared"])]);
  const [donor] = await h.start(["donor"]);
  await h.get("donor").entered.promise;
  const identity = await h.identity(donor.runId);
  const query = await h.call("head_input", { ...identity, intent: "query", text: "What remains in the bounded contract?" });
  expect(query.status).toBe("queued");
  expect((await h.read()).revision).toBe(1);
  const observation = await h.call("head_observe", identity);
  const progressEntry = h.get("donor").session.sessionManager.appendCustomEntry("leaf.progress", { done: "observed bounded progress" });
  const leafCall = async (params: unknown) =>
    (await h.get("donor").local!.tools.get("head_scope_ack")!.execute("ack", params)).details;
  const next = node("donor", ["shared/remaining"]);
  const additions = [node("disjoint"), node("transfer", ["shared/transferred"])];
  // An explanation never expands the outer grant; the narrower fixture checks actual outside paths too.
  await expect(h.call("head_plan", { action: "propose", ...identity, expectedRevision: 1,
    next: { ...next, writes: ["../more"], brief: "necessary local work" }, additions, progress: [observation.observationId] })).rejects.toThrow("envelope");
  const declined = await h.call("head_plan", { action: "propose", ...identity, expectedRevision: 1,
    next, additions, progress: [observation.observationId] });
  await leafCall({ action: "ack", proposalId: declined.proposalId, effectiveRevision: 1, accept: false, progress: [progressEntry] });
  await expect(h.call("head_plan", { action: "confirm", ...identity, proposalId: declined.proposalId })).rejects.toThrow("not acknowledged");
  const proposal = await h.call("head_plan", { action: "propose", ...identity, expectedRevision: 1,
    next, additions, progress: [observation.observationId] });
  expect(proposal.receipt.status).toBe("queued");
  expect(proposal.acknowledgment).toBeUndefined();
  await expect(h.call("head_plan", { action: "confirm", ...identity, proposalId: proposal.proposalId })).rejects.toThrow("not acknowledged");
  await expect(leafCall({ action: "ack", proposalId: "foreign", effectiveRevision: 1, accept: true, progress: [progressEntry] })).rejects.toThrow("foreign");
  await expect(leafCall({ action: "ack", proposalId: proposal.proposalId, effectiveRevision: 1,
    accept: true, progress: ["invented progress"] })).rejects.toThrow("native branch");
  const ack = await leafCall({ action: "ack", proposalId: proposal.proposalId, effectiveRevision: 1,
    accept: true, progress: [progressEntry] });
  expect(ack).toMatchObject({ acknowledgment: { accept: true }, confirmed: false });
  const pendingScope = await leafCall({ action: "current" });
  expect(pendingScope.effectiveRevision).toBe(1);
  expect(JSON.stringify(pendingScope)).not.toContain("disjoint");
  expect(JSON.stringify(pendingScope)).not.toContain("transferred");
  const confirmed = await h.call("head_plan", { action: "confirm", ...identity, proposalId: proposal.proposalId });
  expect(confirmed.effectiveRevision).toBe(2);
  expect((await leafCall({ action: "current" })).contract.writes).toEqual(["shared/remaining"]);
  expect(h.get("donor").session.events).not.toContain("abort");
  const [disjoint] = await h.start(["disjoint"]);
  await h.get("disjoint").entered.promise;
  await expect(h.start(["transfer"])).rejects.toThrow("conflict");
  await expect(h.call("head_observe", identity)).rejects.toThrow("stale");
  await expect(h.review(donor.runId, 1)).rejects.toThrow("stale");
  h.get("donor").finish.resolve();
  await h.get("donor").disposing.promise;
  await expect(h.start(["transfer"])).rejects.toThrow("conflict");
  h.get("donor").releaseDispose.resolve();
  expect((await h.closed(donor.runId)).envelope).toMatchObject({ admittedRevision: 1, effectiveRevision: 2 });
  await expect(h.review(donor.runId, 1)).rejects.toThrow("stale");
  await h.start(["transfer"]);
  await h.get("transfer").entered.promise;
  await h.review(donor.runId, 2);
  h.get("disjoint").finish.resolve(); h.get("disjoint").releaseDispose.resolve();
  await h.closed(disjoint.runId);
  console.info("T3 negotiated split", JSON.stringify({ root: h.root, runId: donor.runId, proposalId: proposal.proposalId,
    steeringReceipt: proposal.receipt.status, acknowledgment: ack.acknowledgment, confirmedRevision: confirmed.effectiveRevision,
    originalWrites: (await h.result(donor.runId)).originalWrites, starts: h.starts }));
  await h.finish();
}));

test("active dependents preserve satisfied prerequisites; cancellation invalidates proposals and joins steering callbacks", fixture.ownedCase("DAG scoped cancellation", async () => {
  const h = await harness();
  await h.edit([node("prerequisite"), node("dependent", ["dependent"], ["prerequisite"])]);
  const [prerequisite] = await h.start(["prerequisite"]);
  await h.get("prerequisite").entered.promise;
  h.get("prerequisite").finish.resolve(); h.get("prerequisite").releaseDispose.resolve();
  await h.closed(prerequisite.runId);
  await h.review(prerequisite.runId, 1);
  const [dependent] = await h.start(["dependent"]);
  await h.get("dependent").entered.promise;
  await expect(h.edit([node("replacement")], ["prerequisite"])).rejects.toThrow("active dependents");
  expect((await h.read()).revision).toBe(1);
  const identity = await h.identity(dependent.runId);
  const observed = await h.call("head_observe", identity);
  const steeringEntered = deferred(), releaseSteering = deferred();
  fixture.beforeRelease(() => { releaseSteering.resolve(); });
  h.get("dependent").session.steer = async () => { steeringEntered.resolve(); await releaseSteering.promise; return "queued"; };
  const steering = h.call("head_plan", { action: "propose", ...identity, expectedRevision: 1,
    next: node("dependent", [], ["prerequisite"]), additions: [], progress: [observed.observationId] });
  void steering.catch(() => {});
  await steeringEntered.promise;
  const leafTool = h.get("dependent").local!.tools.get("head_scope_ack")!;
  const progressEntry = h.get("dependent").session.sessionManager.appendCustomEntry("leaf.progress", {});
  const proposalId = (await h.result(dependent.runId)).proposals[0].proposalId;
  h.head.revoke();
  expect(() => leafTool.execute("ack", { action: "ack", proposalId, effectiveRevision: 1,
    accept: true, progress: [progressEntry] })).toThrow("retired");
  h.get("dependent").finish.resolve();
  let settled = false;
  void h.run.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  releaseSteering.resolve();
  await expect(steering).rejects.toThrow("retired");
  await h.get("dependent").disposing.promise;
  h.get("dependent").releaseDispose.resolve();
  await h.finish();
  expect(h.head.closure.state).toBe("released");
}));

test("canonical aliases conflict and a declared sub-envelope cannot be enlarged by local justification", fixture.ownedCase("DAG canonical envelope", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-head-graph-"));
  fixture.directories.push(root);
  mkdirSync(path.join(root, "allowed"));
  symlinkSync(path.join(root, "allowed"), path.join(root, "alias"));
  const graph = new HeadGraph(root, ["allowed"]);
  graph.transact({ expectedRevision: 0, nodes: [node("a", ["alias/new"])], supersede: [] }, new Set());
  expect(graph.get("a").writes).toEqual([path.join(root, "allowed/new")]);
  expect(() => graph.transact({ expectedRevision: 1, nodes: [node("more", ["elsewhere"], [], "Justified work inside same checkout")],
    supersede: [] }, new Set())).toThrow("envelope");
  expect(graph.snapshot().nodes.map(node => node.id)).toEqual(["a"]);
}));
