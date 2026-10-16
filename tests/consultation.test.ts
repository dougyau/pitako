import { stubExternalFactories } from "./fixtures/offline.ts";
stubExternalFactories();
import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import pitako from "../extensions/index.ts";
import { registerAgentSupervise } from "../extensions/herdr/supervise.ts";
import agentInstance from "../extensions/agent/index.ts";
import { bindBackgroundOwner, clearBackgroundOwner, setBackgroundExecutor, observeWorkerResults, cancelAllWorkers,
  workerStatus, workerHandoff, shutdownBackground } from "../extensions/agent/background.ts";
import { beginTeamEvaluation, retireTeamEvaluation, firstTeamReservation } from "../extensions/team.ts";
import { consultationSnapshot } from "../extensions/agent/consultation.ts";
import { consultationStats, queryHistory } from "../extensions/agent/history-query.ts";
import { WorkerHistory } from "../extensions/agent/history.ts";
import { pruneWorkerHistory } from "../extensions/agent/history-retention.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { runAgentInstance } from "../extensions/agent/run.ts";
import { executionForSession } from "../extensions/execution-identity.ts";
import { reconcileChildTools } from "../extensions/profile.ts";
import { loadPitakoConfig, resolveRoleFromConfig } from "../extensions/roles/load.ts";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { controlledPi, controlledModel } from "./fixtures/pi-factories.ts";

const fixture = agentFixtureOwnership();
function deferred<T = void>() { return Promise.withResolvers<T>(); }
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-consultation-"));
  fixture.directories.push(root);
  process.env.PI_CODING_AGENT_DIR = root;
  mkdirSync(path.join(root, "pitako"));
  writeFileSync(path.join(root, "pitako/config.toml"), `[model_policies.scout]
primary = { model = "fixture/selected", reasoning = "low" }
fallbacks = [{ model = "fixture/fallback", reasoning = "minimal" }]
[model_policies.oracle]
primary = { model = "fixture/selected" }
[model_policies.researcher]
primary = { model = "fixture/selected", reasoning = "medium" }
`);
  const sessionId = "caller-" + path.basename(root);
  const file = path.join(root, "caller.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root }) + "\n");
  const tools = new Map<string, any>();
  const branch: any[] = [], messages: any[] = [];
  const delivered = deferred();
  let persist = true;
  const pi = { registerTool(tool: any) { tools.set(tool.name, tool); }, on() {}, appendEntry(customType: string, data: unknown) {
    if (!persist) throw new Error("controlled append gap");
    appendFileSync(file, JSON.stringify({ type: "custom", id: "event-" + messages.length, customType, data }) + "\n");
  } } as unknown as ExtensionAPI;
  const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file, getBranch: () => branch },
    modelRegistry: { getAvailableOfType() { throw new Error("consultation must not discover a classifier"); } } } as unknown as ExtensionContext;
  agentInstance(pi); registerAgentSupervise(pi);
  const evaluation = beginTeamEvaluation(sessionId, false)!;
  bindBackgroundOwner({ token: evaluation.token, sessionId, isIdle: () => true, hasUI: false,
    notify() {}, sendMessage() {}, getBranch: () => branch,
    appendResult(message) { messages.push({ type: "custom_message", ...message }); delivered.resolve(); } });
  const invoke = (name: string, params: any, signal?: AbortSignal) => tools.get(name).execute(name + "-call", params, signal, undefined, ctx);
  return { root, sessionId, file, tools, pi, ctx, evaluation, branch, messages, delivered, invoke,
    stopPersistence() { persist = false; }, commit() { branch.push(...messages); observeWorkerResults(evaluation.token); } };
}
async function cleanup(s: ReturnType<typeof setup>) {
  await retireTeamEvaluation(s.evaluation); await cancelAllWorkers();
  clearBackgroundOwner(); setBackgroundExecutor(undefined);
}

test("independent consultative policies and no premature synchronous/future exposure", fixture.ownedCase("roles", async () => {
  const s = setup();
  try {
    const config = loadPitakoConfig({ cwd: s.root });
    expect(resolveRoleFromConfig(config, "scout").modelPolicy.primary?.reasoning).toBe("low");
    expect(resolveRoleFromConfig(config, "researcher").modelPolicy.primary?.reasoning).toBe("medium");
    expect(resolveRoleFromConfig(config, "oracle").modelPolicy.primary?.reasoning).toBeUndefined();
    const defaults = loadPitakoConfig({ cwd: s.root, userConfigPath: path.join(s.root, "absent") });
    for (const role of ["scout", "researcher", "oracle"]) {
      expect(resolveRoleFromConfig(defaults, role).modelPolicy.primary).toBeUndefined();
      for (const tool of ["agent_run", "agent_supervise"]) {
        expect((await s.invoke(tool, { role, task: "consult" })).isError).toBe(true);
      }
    }
    expect(s.tools.has("head_consult")).toBe(false);
    expect(s.tools.has("consultation_feedback")).toBe(true);
    expect(() => consultationSnapshot("developer", { mode: "classify" }, s.root)).toThrow("only available");
    const status = await s.invoke("team_status", {});
    expect(status.details.members).toEqual([]);
  } finally { await cleanup(s); }
}));

test("registered Team no-worker cancellation persists caller evidence and releases only after incorporation", fixture.ownedCase("no worker receipt", async () => {
  const s = setup();
  let starts = 0;
  setBackgroundExecutor({ async start() { starts++; throw new Error("must not start"); } });
  try {
    const toolSignal = new AbortController();
    const handle = await s.invoke("team_assign", { role: "scout", task: "inspect" }, toolSignal.signal);
    expect(handle.details.dispatchPhase).toBe("preflight");
    expect(starts).toBe(0);
    const status = await s.invoke("team_status", { assignmentId: handle.details.id });
    expect(status.details.members[0].status).toBe("running"); // independent action, same foreground turn
    toolSignal.abort();
    await s.invoke("team_cancel", { assignmentId: handle.details.id });
    await s.delivered.promise;
    expect(starts).toBe(0);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].details).toMatchObject({ workerStarted: false, status: "cancelled" });
    expect(workerHandoff(handle.details.instanceId)?.delivery).toBe("offered");
    expect(firstTeamReservation(s.evaluation, "scout")).toBe(handle.details.id); // Pending receipt retains this member, not a role slot.
    const groups = new WorkerHistory().list();
    expect(groups.flatMap(group => group.members)).toEqual([]);
    expect(groups.flatMap(group => group.consultations ?? [])).toHaveLength(1);
    s.commit();
    expect(firstTeamReservation(s.evaluation, "scout")).toBeUndefined();
    const recovered = await consultationStats(s.sessionId, handle.details.dispatchId, s.root);
    expect(recovered.rows[0]).toMatchObject({ evidence: "physically-persisted", truncated: false });
    expect((recovered.rows[0] as any).events.map((event: any) => event.event)).toEqual(["decision", "preparation", "outcome", "closure", "delivery"]);
    const denied = await queryHistory({ action: "read", dispatchId: handle.details.dispatchId, source: "caller" }, "other", s.root);
    expect(denied.items).toEqual([]);
    const next = await s.invoke("team_assign", { role: "scout", task: "second" });
    expect(next.isError).not.toBe(true);
    await s.invoke("team_cancel", { assignmentId: next.details.id });
    await shutdownBackground(s.evaluation.token);
    const retention = await pruneWorkerHistory(new WorkerHistory(s.root), 1, { now: Date.now() + 3 * 86400000 });
    expect(retention.groups).toHaveLength(2);
    expect(retention.groups.every(group => group.state === "pruned")).toBe(true);
    expect(existsSync(s.file)).toBe(true); // caller locator is never deletion ownership
    expect(readFileSync(s.file, "utf8")).toContain("pitako.consultation");
    appendFileSync(s.file, JSON.stringify({ type: "custom", data: "x".repeat(1100000) }) + "\n");
    const limited = await consultationStats(s.sessionId, handle.details.dispatchId, s.root);
    expect(limited.rows[0]).toMatchObject({ truncated: true });
    expect(limited.diagnostics.map(item => item.code)).toContain("caller_catalog_pruned_caller_retained");
    const page = await queryHistory({ action: "read", dispatchId: handle.details.dispatchId, limit: 1 }, s.sessionId, s.root);
    expect(page.items).toHaveLength(1); expect(page.cursor).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
    unlinkSync(s.file);
    const missing = await queryHistory({ action: "read", dispatchId: handle.details.dispatchId }, s.sessionId, s.root);
    expect(missing.diagnostics.map(item => item.code)).toContain("caller_native_missing_or_not_persisted_before_assistant");
  } finally { await cleanup(s); }
}));

test("registered no-worker configuration failure automatically delivers without a session or getter", fixture.ownedCase("no worker failure", async () => {
  const s = setup(); let starts = 0;
  setBackgroundExecutor({ async start() { starts++; throw new Error("must not start"); } });
  try {
    writeFileSync(path.join(s.root, "pitako/config.toml"), "");
    const handle = await s.invoke("agent_spawn", { role: "oracle", task: "unconfigured" });
    expect(handle.details.dispatchPhase).toBe("preflight");
    await s.delivered.promise;
    expect(starts).toBe(0);
    expect(s.messages[0].details).toMatchObject({ workerStarted: false, status: "failed", dispatchId: handle.details.dispatchId });
    expect(new WorkerHistory(s.root).list().flatMap(group => group.members)).toEqual([]);
    const stats = await consultationStats(s.sessionId, handle.details.dispatchId, s.root);
    expect((stats.rows[0] as any).events.find((event: any) => event.event === "outcome").data).toMatchObject({ workerStarted: false, status: "failed" });
  } finally { await cleanup(s); }
}));

for (const tool of ["agent_spawn", "team_assign"] as const) {
  test(`${tool} retirement joins resources and persists dropped on the original caller, never its replacement`, fixture.ownedCase(tool + " retirement", async () => {
    const s = setup();
    const entered = deferred(), release = deferred(), disposing = deferred(), disposed = deferred();
    const host = controlledPi(s.root, {
      async bind() { entered.resolve(); await release.promise; },
      async dispose() { disposing.resolve(); await disposed.promise; },
    });
    setBackgroundExecutor(createPiExecutor({ factories: host.factories }));
    const nativeEvents = () => readFileSync(s.file, "utf8").trim().split("\n").map(line => JSON.parse(line))
      .filter(entry => entry.customType === "pitako.consultation").map(entry => entry.data);
    let retirement: Promise<void> | undefined;
    try {
      const toolSignal = new AbortController();
      const handle = await s.invoke(tool, { role: "scout", task: "inspect" }, toolSignal.signal);
      expect(host.runtimeInputs).toEqual([]);
      if (tool === "agent_spawn") expect((await s.invoke("agent_status", { id: handle.details.instanceId })).isError).not.toBe(true);
      toolSignal.abort();
      await entered.promise;
      if (tool === "agent_spawn") expect(workerStatus(handle.details.instanceId)[0]?.status).toBe("running");
      let closed = false;
      retirement = (tool === "agent_spawn" ? shutdownBackground(s.evaluation.token) : retireTeamEvaluation(s.evaluation))
        .then(() => { closed = true; });
      expect(closed).toBe(false);
      const replacementEvents: unknown[] = [];
      bindBackgroundOwner({ token: Symbol("replacement"), isIdle: () => true, hasUI: false,
        notify() {}, sendMessage(message) { replacementEvents.push(message); },
        appendResult(message) { replacementEvents.push(message); } });
      release.resolve();
      await disposing.promise;
      expect(closed).toBe(false);
      expect(nativeEvents().filter(event => event.event === "delivery")).toEqual([]);
      if (tool === "team_assign") expect(firstTeamReservation(s.evaluation, "scout")).toBe(handle.details.id);
      disposed.resolve(); await retirement;
      expect(host.sessions[0]!.prompts).toEqual([]);
      expect(host.sessions[0]!.events).toContain("dispose");
      expect(s.messages).toEqual([]);
      expect(replacementEvents).toEqual([]);
      const dropped = { version: 1, event: "delivery", dispatchId: handle.details.dispatchId, role: "scout", data: { state: "dropped" } };
      expect(nativeEvents().filter(event => event.event === "delivery")).toEqual([expect.objectContaining(dropped)]);
      const recovered = await consultationStats(s.sessionId, handle.details.dispatchId, s.root);
      expect(recovered.rows[0]).toMatchObject({ dispatchId: handle.details.dispatchId, evidence: "physically-persisted" });
      expect((recovered.rows[0] as any).events.filter((event: any) => event.event === "delivery")).toEqual([expect.objectContaining(dropped)]);
      if (tool === "agent_spawn") expect(() => workerStatus(handle.details.instanceId)).toThrow("unknown worker");
      else expect(firstTeamReservation(s.evaluation, "scout")).toBeUndefined();
      await shutdownBackground(s.evaluation.token); await retireTeamEvaluation(s.evaluation);
      expect(nativeEvents().filter(event => event.event === "delivery")).toHaveLength(1);
    } finally {
      release.resolve(); disposed.resolve(); await retirement; await cleanup(s);
    }
  }));
}

test("registered Team retirement before preparation records the original caller drop without admitting a worker", fixture.ownedCase("preparation retirement", async () => {
  const s = setup(); let starts = 0;
  setBackgroundExecutor({ async start() { starts++; throw new Error("must not start"); } });
  try {
    const handle = await s.invoke("team_assign", { role: "scout", task: "inspect" });
    const retirement = retireTeamEvaluation(s.evaluation);
    bindBackgroundOwner({ token: Symbol("replacement"), isIdle: () => true, hasUI: false,
      notify() {}, sendMessage() { throw new Error("retargeted"); }, appendResult() { throw new Error("retargeted"); } });
    expect(firstTeamReservation(s.evaluation, "scout")).toBe(handle.details.id);
    await retirement;
    expect(starts).toBe(0);
    expect(s.messages).toEqual([]);
    expect(firstTeamReservation(s.evaluation, "scout")).toBeUndefined();
    const groups = new WorkerHistory(s.root).list();
    expect(groups.flatMap(group => group.members)).toEqual([]);
    const recovered = await consultationStats(s.sessionId, handle.details.dispatchId, s.root);
    expect(recovered.rows[0]).toMatchObject({ evidence: "physically-persisted" });
    expect((recovered.rows[0] as any).events.filter((event: any) => event.event === "delivery"))
      .toEqual([expect.objectContaining({ event: "delivery", dispatchId: handle.details.dispatchId, role: "scout", data: { state: "dropped" } })]);
    await retireTeamEvaluation(s.evaluation);
    expect(firstTeamReservation(s.evaluation, "scout")).toBeUndefined();
  } finally { await cleanup(s); }
}));

for (const unavailable of ["id", "file", "manager", "append"] as const) {
  test(`retirement retains an explicit gap when the original caller ${unavailable} is unavailable`, fixture.ownedCase("retirement gap " + unavailable, async () => {
    const s = setup(), entered = deferred(), release = deferred();
    const host = controlledPi(s.root, { async bind() { entered.resolve(); await release.promise; } });
    setBackgroundExecutor(createPiExecutor({ factories: host.factories }));
    let retirement: Promise<void> | undefined;
    try {
      const handle = await s.invoke("agent_spawn", { role: "scout", task: "inspect" });
      await entered.promise;
      const replacementFile = path.join(s.root, "replacement.jsonl");
      writeFileSync(replacementFile, JSON.stringify({ type: "session", version: 3, id: "replacement", cwd: s.root }) + "\n");
      if (unavailable === "append") s.stopPersistence();
      else {
        s.pi.appendEntry = (customType, data) => {
          appendFileSync(replacementFile, JSON.stringify({ type: "custom", customType, data }) + "\n");
        };
        if (unavailable === "id") Object.assign(s.ctx.sessionManager, { getSessionId: () => "replacement" });
        if (unavailable === "file") Object.assign(s.ctx.sessionManager, { getSessionFile: () => replacementFile });
        if (unavailable === "manager") Object.assign(s.ctx, { sessionManager: { ...s.ctx.sessionManager } });
      }
      retirement = shutdownBackground(s.evaluation.token);
      release.resolve(); await retirement;
      expect(host.sessions[0]!.events).toContain("dispose");
      expect(s.messages).toEqual([]);
      const recovered = await consultationStats(s.sessionId, handle.details.dispatchId, s.root);
      expect(recovered.rows[0]).toMatchObject({ evidence: "physically-persisted",
        gaps: expect.arrayContaining([expect.stringContaining(unavailable === "append" ? "controlled append gap" : "caller binding retired")]) });
      expect((recovered.rows[0] as any).events.filter((event: any) => event.event === "delivery")).toEqual([]);
      expect(readFileSync(replacementFile, "utf8")).not.toContain("pitako.consultation");
      expect(() => workerStatus(handle.details.instanceId)).toThrow("unknown worker");
    } finally { release.resolve(); await retirement; await cleanup(s); }
  }));
}

test("activated direct validation, defaults, fallback reasoning and append gaps preserve primary choice", fixture.ownedCase("reasoning", async () => {
  const s = setup();
  try {
    for (const selection of [undefined, { mode: "default" } as const, { mode: "direct", level: "high" } as const]) {
      const host = controlledPi(s.root);
      const snapshot = consultationSnapshot("scout", selection, s.root)!;
      const result = await fixture.run(runAgentInstance({ roleId: "scout", cwd: s.root, task: "reasoning", consultation: snapshot,
        executor: createPiExecutor({ factories: host.factories }) }));
      expect(result.status).toBe("completed");
      expect(host.sessions[0]!.thinkingLevel).toBe(selection?.mode === "direct" ? "high" : "low");
      expect(snapshot.role.modelPolicy.fallbacks[0]?.reasoning).toBe("minimal");
    }
    const noReasoning = { ...controlledModel(), reasoning: false };
    const unsupported = controlledPi(s.root, { models: [], bind() { unsupported.models.push(noReasoning); } });
    const rejected = await fixture.run(runAgentInstance({ roleId: "scout", cwd: s.root, task: "reject", consultation: consultationSnapshot("scout", { mode: "direct", level: "high" }, s.root),
      executor: createPiExecutor({ factories: unsupported.factories }) }));
    expect(rejected.status).toBe("failed");
    expect(rejected.model.fallbackOccurred).toBeFalsy();
    expect(unsupported.sessions).toHaveLength(1);
    expect(unsupported.sessions[0]!.prompts).toEqual([]);
    expect(unsupported.sessions[0]!.events).toContain("dispose");
    const levels: string[] = [];
    const fallback = controlledPi(s.root, { models: [controlledModel(), controlledModel("fixture", "fallback")], prompt(session) {
      levels.push(session.thinkingLevel);
      if (session.model!.id === "selected") throw new Error("503 Service Unavailable");
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "fallback" }], stopReason: "stop" });
    } });
    const recovered = await fixture.run(runAgentInstance({ roleId: "scout", cwd: s.root, task: "fallback", consultation: consultationSnapshot("scout", { mode: "direct", level: "high" }, s.root),
      executor: createPiExecutor({ factories: fallback.factories }) }));
    expect(recovered.status).toBe("completed");
    expect(levels).toEqual(["high", "minimal"]);
    s.stopPersistence();
    const host = controlledPi(s.root);
    setBackgroundExecutor(createPiExecutor({ factories: host.factories }));
    const handle = await s.invoke("agent_spawn", { role: "scout", task: "keep high", reasoning: { mode: "direct", level: "high" } });
    await s.delivered.promise;
    expect(host.sessions[0]!.thinkingLevel).toBe("high");
    expect(s.messages[0].details.status).toBe("completed");
    const stats = await consultationStats(s.sessionId, handle.details.dispatchId, s.root);
    expect(stats.rows[0]).toMatchObject({ evidence: "absent-or-not-persisted-before-first-assistant", gaps: expect.arrayContaining([expect.stringContaining("append gap")]) });
  } finally { await cleanup(s); }
}));

test("post-bind analysis survives late tools and same-model reconciliation; nested definitions cannot orchestrate", fixture.ownedCase("analysis", async () => {
  const s = setup(); let calls = 0;
  const tools = new Map<string, { definition: any }>();
  const names = ["read", "bash", "grep", "find", "ls", "edit", "write", "apply_patch", "lsp_rename", "codegraph_search", "agent_future", "team_assign", "head_plan", "consultation_feedback"];
  let hooks = new Map<string, Function>();
  const profileHooks = new Map<string, Function>();
  let childContext: any;
  const host = controlledPi(s.root, { extensions: [{ resolvedPath: "controlled", tools }], async bind(session) {
    expect(executionForSession(session.sessionId)?.profile).toBe("analysis");
    for (const name of names) tools.set(name, { definition: { execute() { calls++; } } });
    session.getAllTools = () => names.map(name => ({ name }));
    pitako({ registerTool() {}, registerFlag() {}, registerCommand() {}, getFlag: () => "coding",
      on(name: string, fn: Function) { profileHooks.set(name, fn); },
      getAllTools: () => session.getAllTools(), getActiveTools: () => session.active,
      setActiveTools: (active: string[]) => { session.active = active; },
      getSessionName: () => "pitako:coding", setSessionName() {},
    } as unknown as ExtensionAPI);
    childContext = { cwd: s.root, sessionManager: session.sessionManager, model: session.model, hasUI: false };
    await profileHooks.get("session_start")!({}, childContext);
    expect(session.active).toContain("bash");
    expect(session.active).not.toContain("edit");
    hooks = new Map();
    host.loaderInputs[0].extensionFactories[1]({ on(name: string, fn: Function) { hooks.set(name, fn); } });
  }, async prompt(session) {
    for (const name of ["read", "bash", "grep", "find", "ls", "codegraph_search"]) expect(session.active).toContain(name);
    for (const name of names.slice(5).filter(name => name !== "codegraph_search")) expect(session.active).not.toContain(name);
    for (const name of ["agent_future", "team_assign", "head_plan", "consultation_feedback"]) {
      expect(await tools.get(name)!.definition.execute()).toMatchObject({ isError: true }); // codemode's direct-definition path
      expect(hooks.get("tool_call")!({ toolName: name }).block).toBe(true);
    }
    tools.set("team_late", { definition: { execute() { calls++; } } });
    hooks.get("turn_start")!();
    expect(await tools.get("team_late")!.definition.execute()).toMatchObject({ isError: true });
    await session.setModel(session.model!);
    profileHooks.get("model_select")!({ model: session.model }, { ...childContext, model: session.model });
    expect(session.active).not.toContain("edit");
    reconcileChildTools({ ...session, model: session.model });
    expect(session.active).not.toContain("write");
    session.messages.push({ role: "assistant", content: [{ type: "text", text: "leaf done" }], stopReason: "stop" });
  } });
  try {
    const result = await fixture.run(runAgentInstance({ roleId: "scout", cwd: s.root, task: "analysis", consultation: consultationSnapshot("scout", undefined, s.root),
      executor: createPiExecutor({ factories: host.factories }) }));
    expect(result.status).toBe("completed"); expect(calls).toBe(0);
  } finally { await cleanup(s); }
}));


test("registered stats command uses the authorized caller and automatic success handoff without a getter", fixture.ownedCase("stats command", async () => {
  const s = setup(), appended = deferred();
  const hooks = new Map<string, Function>();
  const notes: string[] = [];
  let command!: Function;
  const pi = { registerTool() {}, registerFlag() {}, getFlag() {},
    on(name: string, fn: Function) { hooks.set(name, fn); },
    registerCommand(_name: string, definition: any) { command = definition.handler; },
    getAllTools: () => [{ name: "read" }], getActiveTools: () => ["read"], setActiveTools() {},
    getSessionName: () => "pitako:coding", setSessionName() {},
    sendMessage(message: any, options: any) { if (!options.triggerTurn) { s.branch.push({ type: "custom_message", ...message }); appended.resolve(); } },
  } as unknown as ExtensionAPI;
  pitako(pi);
  const ctx = { ...s.ctx, hasUI: true, isIdle: () => true, ui: { notify(text: string) { notes.push(text); }, setStatus() {} } };
  const host = controlledPi(s.root);
  setBackgroundExecutor(createPiExecutor({ factories: host.factories }));
  try {
    await hooks.get("session_start")!({}, ctx);
    const handle = await s.invoke("agent_spawn", { role: "oracle", task: "consult" });
    await appended.promise;
    await command("stats consultations " + handle.details.dispatchId, ctx);
    expect(JSON.parse(notes.at(-1)!).rows[0]).toMatchObject({ dispatchId: handle.details.dispatchId, evidence: "physically-persisted" });
    await command("stats consultations " + handle.details.dispatchId, { ...ctx, sessionManager: { getSessionId: () => "foreign" } });
    expect(notes.at(-1)).toContain("authorized foreground caller");
    expect(s.branch[0].details.status).toBe("completed");
  } finally { await hooks.get("session_shutdown")!({}, ctx); await cleanup(s); }
}));

function reasoningClassifier(s: ReturnType<typeof setup>, options: {
  model?: ReturnType<typeof controlledModel>;
  discover?: () => Promise<void>;
  classify?: (request: any) => Promise<any>;
} = {}) {
  const model = options.model ?? controlledModel();
  const identity = { provider: "shared-fixture", id: "configured-classifier/v2", type: "classifier", contextWindow: 200000 };
  appendFileSync(path.join(s.root, "pitako/config.toml"), '\n[developer_routing]\nclassifier_provider = "shared-fixture"\nclassifier_model = "configured-classifier/v2"\n');
  const requests: any[] = [], discoveries: unknown[] = [];
  Object.assign(s.ctx.modelRegistry, {
    find(provider: string, id: string) { return provider === model.provider && id === model.id ? model : undefined; },
    async getAvailableOfType(type: string, provider: string, options: any) {
      discoveries.push({ type, provider, signal: options.signal }); await options?.signal?.throwIfAborted();
      await optionsForDiscovery(); return [{ ...identity, provider: "wrong" }, identity];
    },
    async classify(selected: any, request: any, options: any) {
      expect(selected).toBe(identity); expect(options.maxRetries).toBe(0); requests.push(request);
      if (optionsForClassify) return optionsForClassify(request);
      return reasoningAnswer(request, "high");
    },
  });
  const optionsForDiscovery = options.discover ?? (async () => {}), optionsForClassify = options.classify;
  return { model, identity, requests, discoveries };
}
function reasoningAnswer(request: any, choice: string, extra: Record<string, number> = {}) {
  return { api: "fixture", provider: "shared-fixture", model: "configured-classifier/v2", timestamp: 1, stopReason: "stop",
    answers: { reasoning: { type: "choice", choice, confidence: 0.8,
      probabilities: { ...Object.fromEntries(Object.keys(request.questions.reasoning.criteria).map(key => [key, key === choice ? 0.8 : 0.01])), ...extra } } },
    usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0 } } };
}

test("registered classify returns early, freezes shared identity, offers SDK max and retains native usage/feedback after reload", fixture.ownedCase("classify usage feedback", async () => {
  const s = setup(), entered = deferred(), release = deferred();
  const model = { ...controlledModel(), thinkingLevelMap: { max: "max" } };
  const classifier = reasoningClassifier(s, { model, async classify(request) { entered.resolve(); await release.promise; return reasoningAnswer(request, "max"); } });
  const originalConfig = readFileSync(path.join(s.root, "pitako/config.toml"), "utf8");
  const host = controlledPi(s.root, { models: [model], prompt(session) {
    Object.assign(session.stats, { tokens: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, total: 6 }, cost: 0, assistantMessages: 1 });
    const message = { role: "assistant", content: [{ type: "text", text: "retained advice" }], stopReason: "stop" };
    session.messages.push(message); session.sessionManager.appendMessage(message as never); session.emit({ type: "message_end", message });
  } });
  setBackgroundExecutor(createPiExecutor({ factories: host.factories }));
  try {
    const handle = await s.invoke("agent_spawn", { role: "researcher", task: "frozen brief", reasoning: { mode: "classify" } });
    expect(classifier.discoveries).toEqual([]); expect(host.sessions).toEqual([]);
    expect((await s.invoke("agent_status", { id: handle.details.instanceId })).isError).not.toBe(true);
    await entered.promise;
    writeFileSync(path.join(s.root, "pitako/config.toml"), '[model_policies.researcher]\nprimary = { model = "changed/no", reasoning = "off" }');
    expect(classifier.requests[0].questions).not.toHaveProperty("capacity");
    expect(Object.keys(classifier.requests[0].questions.reasoning.criteria)).toEqual([...getSupportedThinkingLevels(model), "indeterminate"]);
    expect(classifier.requests[0].state).toEqual({ role: "researcher", workbrief: "frozen brief" });
    release.resolve(); await s.delivered.promise;
    expect(host.sessions[0]!.thinkingLevel).toBe("max");
    const feedback = { dispatchId: handle.details.dispatchId, usefulness: "used" };
    expect((await s.invoke("consultation_feedback", feedback)).isError).toBe(true); // offered is not receipt
    s.commit();
    expect((await s.invoke("consultation_feedback", feedback)).isError).not.toBe(true);
    expect((await s.invoke("consultation_feedback", { ...feedback, usefulness: "partial", note: "correction" })).isError).not.toBe(true);
    const branch = s.branch.splice(0);
    expect((await s.invoke("consultation_feedback", feedback)).isError).toBe(true);
    s.branch.push(...branch);
    for (const followupInstances of [[handle.details.instanceId], ["fabricated"], ["same", "same"]])
      expect((await s.invoke("consultation_feedback", { ...feedback, followupInstances })).isError).toBe(true);
    const stats = await consultationStats(s.sessionId, handle.details.dispatchId, s.root);
    const row = stats.rows[0] as any;
    expect(row.classifier).toMatchObject({ identity: { classifierProvider: "shared-fixture", classifierModel: "configured-classifier/v2" }, usage: { input: 8, cost: { total: 0 } } });
    expect(row.attempts).toHaveLength(1); expect(row.attempts[0].usage).toMatchObject({ input: 4, output: 2, cost: 0 });
    expect(row.events.filter((e: any) => e.event === "feedback")).toHaveLength(2);
    expect(row.latestFeedback.data).toMatchObject({ usefulness: "partial", note: "correction", author: { callerSessionId: s.sessionId } });
    expect(row.combinedTotal).toBeNull(); expect(row.accounting).toContain("not a billing receipt");
    writeFileSync(path.join(s.root, "pitako/config.toml"), originalConfig);
    const execute = (coordinatorSessionId: string) => runAgentInstance({ roleId: "researcher", task: "observed followup", cwd: s.root,
      signal: new AbortController().signal, executor: createPiExecutor({ factories: host.factories }),
      historyOrigin: { source: "agent_spawn", coordinatorSessionId, callerSessionId: coordinatorSessionId, callerSessionFile: s.file } });
    const own = await execute(s.sessionId), foreign = await execute("foreign-caller");
    expect((await s.invoke("consultation_feedback", { ...feedback, followupInstances: [foreign.instanceId] })).isError).toBe(true);
    expect((await s.invoke("consultation_feedback", { ...feedback, followupInstances: [own.instanceId] })).isError).not.toBe(true);
    const consumption = (await consultationStats(s.sessionId, handle.details.dispatchId, s.root)).rows[0] as any;
    expect(consumption.followups).toHaveLength(1);
    expect(consumption.followups[0]).toMatchObject({ instanceId: own.instanceId, usage: { input: 4, output: 2, cost: 0 } });
    const store = new WorkerHistory(), linked = store.list().find(group => group.consultations?.some(locator => locator.dispatchId === handle.details.dispatchId))!;
    // Put all real callers/targets beyond a full catalog page, without creating provider work.
    const filler = store.createGroup(s.root);
    for (let i = 0; i < 201; i++) {
      const groupId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      writeFileSync(path.join(store.catalogDir, `${groupId}.json`), JSON.stringify({ ...filler, groupId }));
    }
    expect(store.list().findIndex(group => group.members.some(member => member.instanceId === own.instanceId))).toBeGreaterThan(200);
    for (const followupInstances of [[foreign.instanceId], ["fabricated"], [handle.details.instanceId], [own.instanceId, own.instanceId]])
      expect((await s.invoke("consultation_feedback", { ...feedback, followupInstances })).isError).toBe(true);
    expect((await s.invoke("consultation_feedback", { ...feedback, note: "large catalog", followupInstances: [own.instanceId] })).isError).not.toBe(true);
    const persisted = await queryHistory({ action: "read", dispatchId: handle.details.dispatchId, groupId: linked.groupId, source: "caller", limit: 200 }, s.sessionId, s.root);
    expect(persisted.cursor).toBeNull();
    const entries = Buffer.concat(persisted.items.map((item: any) => Buffer.from(item.data, "base64"))).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.data?.event === "feedback").at(-1).data.data).toMatchObject({
      note: "large catalog", followupInstances: [own.instanceId], author: { callerSessionId: s.sessionId },
    });
    store.mutate(linked.groupId, group => { group.consultations!.push({ ...group.consultations![0]!, dispatchId: "ffffffff-ffff-4fff-8fff-ffffffffffff", followupInstances: [own.instanceId] }); });
    expect((await s.invoke("consultation_feedback", { ...feedback, followupInstances: [own.instanceId] })).isError).toBe(true);
  } finally { release.resolve(); await cleanup(s); }
}));

for (const failure of ["tie", "extra", "invalid", "indeterminate", "unavailable", "registry", "append", "oversize", "drift", "pending"] as const) {
  test(`classification ${failure} preserves frozen primary or explicitly applies valid advice`, fixture.ownedCase("classify " + failure, async () => {
    const s = setup();
    reasoningClassifier(s, { async discover() { if (failure === "registry") throw new Error("controlled registry failure"); }, async classify(request) {
      const response = reasoningAnswer(request, failure === "indeterminate" ? "indeterminate" : "high");
      if (failure === "tie") response.answers.reasoning.probabilities.medium = 0.8;
      if (failure === "extra") response.answers.reasoning.probabilities.extra = 1;
      if (failure === "invalid") response.answers.reasoning.probabilities.low = NaN;
      if (failure === "oversize") (response as any).diagnostic = "x".repeat(262144);
      return response;
    } });
    if (failure === "unavailable") s.ctx.modelRegistry.getAvailableOfType = async () => [];
    if (failure === "append") s.stopPersistence();
    if (failure === "pending") s.pi.appendEntry = () => {}; // native host accepted, disk not yet flushed
    const bound = failure === "drift" ? { ...controlledModel(), thinkingLevelMap: { high: null } } : controlledModel();
    const host = controlledPi(s.root, { models: [bound] });
    setBackgroundExecutor(createPiExecutor({ factories: host.factories }));
    try {
      const handle = await s.invoke("agent_spawn", { role: "researcher", task: "medium fallback", reasoning: { mode: "classify" } });
      await s.delivered.promise;
      expect(host.sessions[0]!.thinkingLevel).toBe(failure === "pending" ? "high" : "medium");
      expect(s.messages[0].details.status).toBe("completed");
      const stats = await consultationStats(s.sessionId, handle.details.dispatchId, s.root);
      if (failure === "pending") expect(stats.rows[0]).toMatchObject({ evidence: "absent-or-not-persisted-before-first-assistant", gaps: [] });
      else if (failure !== "append") {
        const row = stats.rows[0] as any, decision = [...row.events].reverse().find((e: any) => e.event === "decision");
        expect(decision.data.reason).toContain(({ tie: "tie", extra: "unsupported", invalid: "malformed", indeterminate: "indeterminate", unavailable: "unavailable", registry: "controlled registry", oversize: "exceeds", drift: "unique" } as any)[failure]);
      }
    } finally { await cleanup(s); }
  }));
}

for (const stage of ["discovery", "classify"] as const) for (const action of ["cancel", "retire", "rebind", "response-aborted"] as const) {
  test(`held ${stage} ${action} fences worker admission`, fixture.ownedCase(stage + action, async () => {
    const s = setup(), entered = deferred(), release = deferred(); let starts = 0, retirement: Promise<void> | undefined;
    reasoningClassifier(s, { async discover() { if (stage === "discovery") { entered.resolve(); await release.promise; } }, async classify(request) {
      if (stage === "classify") { entered.resolve(); await release.promise; }
      return action === "response-aborted" ? { ...reasoningAnswer(request, "high"), stopReason: "aborted" } : reasoningAnswer(request, "high");
    } });
    setBackgroundExecutor({ async start() { starts++; throw new Error("must not admit"); } });
    try {
      const handle = await s.invoke("agent_spawn", { role: "researcher", task: "held", reasoning: { mode: "classify" } });
      expect(starts).toBe(0); await entered.promise;
      if (action === "cancel") await s.invoke("agent_cancel", { id: handle.details.instanceId });
      if (action === "retire") retirement = shutdownBackground(s.evaluation.token);
      if (action === "rebind") Object.assign(s.ctx.sessionManager, { getSessionId: () => "replacement" });
      release.resolve();
      if (retirement) await retirement; else await s.delivered.promise;
      expect(starts).toBe(0);
    } finally { release.resolve(); await retirement; await cleanup(s); }
  }));
}


for (const reason of ["missing-primary", "missing-capabilities", "single-choice", "request-budget", "registry-error", "omitted-drift"] as const) {
  test(`classify ${reason} keeps frozen/default semantics without unwanted discovery`, fixture.ownedCase(reason, async () => {
    const s = setup(), registryModel = reason === "single-choice" ? { ...controlledModel(), reasoning: false } : controlledModel();
    const advice = reasoningClassifier(s, { model: registryModel, async discover() { if (reason === "registry-error") throw new Error("registry unavailable"); } });
    if (reason === "missing-primary") writeFileSync(path.join(s.root, "pitako/config.toml"), "");
    if (reason === "missing-capabilities") s.ctx.modelRegistry.find = () => undefined;
    const bound = reason === "omitted-drift" ? { ...controlledModel(), thinkingLevelMap: { high: null } } : registryModel;
    const host = controlledPi(s.root, { models: [bound], bind(session) {
      Object.assign(session.settingsManager, { getModelThinkingLevel: () => "low" });
    }, prompt(session) {
      const message = { role: "assistant", content: [{ type: "text", text: "observed answer" }], stopReason: "stop" };
      session.messages.push(message); session.sessionManager.appendMessage(message as never); session.emit({ type: "message_end", message });
    } });
    setBackgroundExecutor(createPiExecutor({ factories: host.factories }));
    try {
      const handle = await s.invoke("agent_spawn", { role: "oracle", task: reason === "request-budget" ? "x".repeat(140000) : "omitted reasoning", reasoning: { mode: "classify" } });
      await s.delivered.promise;
      if (["missing-primary", "missing-capabilities", "single-choice", "request-budget"].includes(reason)) expect(advice.discoveries).toEqual([]);
      if (reason === "missing-primary") { expect(host.sessions).toHaveLength(0); expect(s.messages[0].details.status).toBe("failed"); }
      else expect(host.sessions[0]!.thinkingLevel).toBe("low");
      if (reason === "omitted-drift") {
        const row = (await consultationStats(s.sessionId, handle.details.dispatchId, s.root)).rows[0] as any;
        expect(row.attempts[0].provenance).toMatchObject({ configured: {}, selected: { reasoning: "high" }, activatedModel: "fixture/selected", appliedReasoning: "low", adjustment: expect.stringContaining("restored frozen") });
        expect(row.attempts[0].provenance).not.toHaveProperty("requestedReasoning");
        expect(advice.requests).toHaveLength(1);
      }
    } finally { await cleanup(s); }
  }));
}
