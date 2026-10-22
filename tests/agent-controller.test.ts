import { afterEach, expect, spyOn, test } from "bun:test";
import * as completionModule from "../extensions/roles/complete.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentController } from "../extensions/agent/controller.ts";
import { bindBackgroundOwner, clearBackgroundOwner, spawnBackground, setBackgroundExecutor, workerStatus } from "../extensions/agent/background.ts";
import { createLiveHandle } from "../extensions/agent/live.ts";
import { clearObservations, publishObservation } from "../extensions/agent/observe.ts";
import { runAgentInstance, type Attempt } from "../extensions/agent/run.ts";
import { beginTeamEvaluation, retireTeamEvaluation, teamEvaluationForSession } from "../extensions/team.ts";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import { queryHistory } from "../extensions/agent/history-query.ts";
import { ownedDispatch } from "../extensions/agent/dispatch.ts";
import pitako from "../extensions/index.ts";
import agentInstance from "../extensions/agent/index.ts";
import * as controllerModule from "../extensions/agent/controller.ts";
import profilePolicy from "../extensions/profile-policy.ts";
import * as bridgeModule from "../extensions/agent/bridge/broker.ts";
import * as routing from "../extensions/agent/routing.ts";
import { connect } from "../extensions/agent/bridge/client.js";
import { captureCallContext, checkCallContext } from "../extensions/workflow-engine.ts";

const fixture = agentFixtureOwnership();
const originalDir = process.env.PI_CODING_AGENT_DIR;
const originalOffline = process.env.PI_OFFLINE;
afterEach(() => {
  fixture.requireReleasedFixture();
  clearBackgroundOwner();
  clearObservations();
  setBackgroundExecutor(undefined);
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
  if (originalOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = originalOffline;
  for (const root of fixture.directories.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(sessionId = "coordinator") {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-controller-"));
  fixture.directories.push(root);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const config = path.join(root, "config.toml");
  writeFileSync(config, '[model_policies.researcher.primary]\nmodel = "fixture/selected"\nreasoning = "off"\n');
  const token = Symbol(sessionId);
  const owner = { sessionId, token };
  bindBackgroundOwner({ token, isIdle: () => false, hasUI: false, notify() {}, sendMessage() {} });
  const controller = createAgentController(owner, () => owner);
  return { root, owner, controller, load: { userConfigPath: config, env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } } };
}

for (const mode of ["replacement", "shutdown", "codex-failure"] as const) {
test(`packaged ${mode} fences bridge reads and joins ordinary native control throughout held retirement`, fixture.ownedCase(`bridge ${mode}`, async () => {
  const { root, load } = setup();
  process.env.PI_OFFLINE = "1";
  const bridgeRoot = path.join(root, "bridge");
  mkdirSync(bridgeRoot, { mode: 0o700 });
  const descriptor = path.join(bridgeRoot, "descriptor.json");
  const extensions: Array<{ handlers: Map<string, Function[]> }> = [];
  let failNext = false, activeTools = ["read", "edit", "write"];
  const pi = { registerFlag() {}, registerCommand() {}, registerTool() {},
    on(name: string, handler: Function) {
      const handlers = extensions.at(-1)!.handlers;
      handlers.set(name, [...handlers.get(name) ?? [], handler]);
    },
    getFlag(name: string) { return name === "pitako-agent-bridge" ? bridgeRoot : undefined; },
    getAllTools() { return ["read", "edit", "write", "apply_patch"].map(name => ({ name })); },
    getActiveTools() { return activeTools; },
    setActiveTools(tools: string[]) { activeTools = tools; }, getSessionName() { return "pitako:coding"; },
    setSessionName() {}, sendMessage() {} };
  const ctx = { cwd: root, hasUI: false, mode: "rpc", isIdle: () => true,
    model: { api: "openai-responses", compat: { supportsOpenAIGrammarTools: true } },
    sessionManager: { getSessionId: () => "coordinator", getEntries: () => [] },
    ui: { notify() {}, setStatus() {} } };
  const controllers: ReturnType<typeof createAgentController>[] = [];
  const originalController = controllerModule.createAgentController, originalBridge = bridgeModule.createAgentBridge;
  const controllerCapture = spyOn(controllerModule, "createAgentController").mockImplementation((...args) => {
    const controller = originalController(...args); controllers.push(controller); return controller;
  });
  let bridgeStarts = 0;
  const bridgeCapture = spyOn(bridgeModule, "createAgentBridge").mockImplementation((...args) => {
    bridgeStarts++; return originalBridge(...args);
  });
  const factories = new Map<string, Function>([
    ["./extensions/index.ts", pitako], ["./extensions/agent/index.ts", agentInstance],
    ["./node_modules/pi-codex-tools/index.ts", (api: any) => {
      api.on("session_start", () => { if (failNext) { failNext = false; throw Error("fixture external startup failed"); } });
    }],
    ["./extensions/profile-policy.ts", profilePolicy],
  ]);
  for (const entry of JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).pi.extensions) {
    const factory = factories.get(entry);
    if (factory) { extensions.push({ handlers: new Map() }); factory(pi as never); }
  }
  const errors: unknown[] = [];
  const emit = async (type: string) => {
    for (const extension of extensions) for (const handler of extension.handlers.get(type) ?? []) {
      try { await handler({ type }, ctx); }
      catch (error) { errors.push({ event: type, error: (error as Error).message }); }
    }
  };
  const start = () => emit("session_start");
  let release!: () => void, transition: Promise<unknown> | undefined, dispatch: Promise<unknown> | undefined;
  let observing = false, observer: Promise<void> | undefined;
  let client: Awaited<ReturnType<typeof connect>> | undefined, view: ReturnType<ReturnType<typeof originalController>["openView"]>;
  let attempts = 0, admissions = 0, effects = 0, finishWorker!: (value: Attempt) => void, releaseInput!: () => void;
  let inputStarted!: () => void, acceptedInput: Promise<unknown> | undefined;
  const inputStart = new Promise<void>(resolve => { inputStarted = resolve; });
  const inputHold = new Promise<void>(resolve => { releaseInput = resolve; });
  try {
    await start();
    expect(bridgeStarts).toBe(1);
    view = controllers.at(-1)!.openView();
    client = await connect(descriptor, { expectedSessionId: "coordinator" });
    let started!: () => void;
    const startedWorker = new Promise<void>(resolve => { started = resolve; });
    const attempt = fixture.pendingAttempt(resolve => { finishWorker = resolve; });
    const worker = await spawnBackground({ roleId: "researcher", task: "packaged admitted bridge input", cwd: root, load,
      historyOrigin: { source: "agent_spawn", coordinatorSessionId: "coordinator" },
      executor: { capturesHistory: true, async start(input) {
        const history = input.history!.admit(input.instanceId, input.role.id, input.target), manager = history.create();
        const live = createLiveHandle({ sessionManager: manager, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(),
          async steer() { effects++; inputStarted(); await inputHold; return "handled"; } }, history);
        live.open(); const unbind = input.bindLive!(live.handle); started();
        const outcome = await attempt;
        await live.settle(); await live.handle.close(); unbind(); history.result(outcome); history.disposition(); return outcome;
      } } });
    await startedWorker;
    const selection = view.detail(worker.instanceId).controls.selection!;
    const lease = client.lease;
    acceptedInput = view.input(selection, { intent: "query", text: "one admitted coordinator mutation" }).catch(error => error);
    await inputStart;
    expect(effects).toBe(1);
    const hold = new Promise<void>(resolve => { release = resolve; });
    dispatch = ownedDispatch(ctx as never, undefined, () => true, async () => hold);
    await Promise.resolve();
    observing = true;
    observer = (async () => {
      while (observing) {
        if (existsSync(descriptor)) {
          attempts++;
          try {
            const candidate = await connect(descriptor, { expectedSessionId: "coordinator" });
            admissions++; await candidate.disconnect();
          } catch {}
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    })();
    failNext = mode === "codex-failure";
    let finished = false;
    transition = (mode === "shutdown" ? emit("session_shutdown") : start())
      .then(() => { finished = true; });
    expect(() => view.list()).toThrow("retired");
    await expect(client.list()).rejects.toThrow();
    expect(() => view.input(selection, { intent: "query", text: "obsolete mutation" })).toThrow();
    expect(() => view.cancel(selection)).toThrow();
    // The external entry has not run while Pitako still owns retirement.
    expect(failNext).toBe(mode === "codex-failure");
    expect(finished).toBe(false);
    expect(bridgeStarts).toBe(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(attempts).toBeGreaterThan(0);
    expect(admissions).toBe(0);
    release(); await dispatch;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(finished).toBe(false); // closure must also join the admitted native operation
    expect(bridgeStarts).toBe(1); expect(admissions).toBe(0);
    releaseInput();
    expect((await acceptedInput as Error).message).toContain("retired");
    expect(finished).toBe(false); // the admitted worker attempt is still owned
    finishWorker(completed);
    await transition;
    // Keep the observer active through all remaining foreground reconciliation.
    await new Promise<void>(resolve => setImmediate(resolve));
    observing = false; await observer;
    expect(bridgeStarts).toBe(mode === "shutdown" ? 1 : 2);
    expect(effects).toBe(1);
    if (mode !== "shutdown") {
      const fresh = await connect(descriptor, { expectedSessionId: "coordinator" });
      try {
        await expect(connect(descriptor, { expectedSessionId: "coordinator", resume: lease })).rejects.toMatchObject({ code: "lease_expired" });
        expect(fresh).not.toHaveProperty("grant");
        expect(fresh).not.toHaveProperty("requestStatus");
      } finally { await fresh.disconnect(); }
    } else {
      expect(admissions).toBe(0);
      expect(existsSync(descriptor)).toBe(false);
    }
    expect(activeTools).toContain("apply_patch");
    expect(activeTools).not.toContain("edit"); expect(activeTools).not.toContain("write");
    if (mode === "codex-failure") expect(errors).toMatchObject([{ event: "session_start", error: "fixture external startup failed" }]);
    else expect(errors).toEqual([]);
    console.log("BRIDGE_PACKAGED_MUTATION_FENCE", JSON.stringify({ mode, effects, bridgeStarts, attempts, admissions,
      profile: activeTools, error: errors, heldDispatchAndMutationJoined: true, observedThroughRemainder: true }));
  } finally {
    release?.(); releaseInput(); finishWorker?.(completed); await dispatch; await transition; await acceptedInput;
    observing = false; await observer;
    await client?.disconnect();
    await emit("session_shutdown");
    controllerCapture.mockRestore(); bridgeCapture.mockRestore();
    expect(readdirSync(bridgeRoot)).toEqual([]);
  }
}));
}
const completed: Attempt = { status: "completed", result: "done", sideEffects: false };

test("scoped list/detail excludes legacy and foreign rows; sync preserves the original brief", fixture.ownedCase("scoped sync", async () => {
  const { root, controller, load } = setup();
  const brief = " \n unmodified original WorkBrief \n ";
  await runAgentInstance({ roleId: "researcher", task: brief, cwd: root, load,
    historyOrigin: { source: "agent_run", coordinatorSessionId: "coordinator", workbrief: brief },
    onObserve: row => publishObservation(row),
    executor: { async start() { return completed; } } });
  for (const [id, parent] of [["legacy", undefined], ["foreign", "other"]]) {
    publishObservation({ id: id!, roleId: "researcher", task: "hidden", selectedModel: "fixture/selected", lastActivityKind: "start", status: "running", phase: "working", acceptedAt: 1,
      ...(parent ? { origin: { source: "agent_spawn", coordinatorSessionId: parent } } : {}) });
  }
  publishObservation({ id: "missing-Team-lease", roleId: "researcher", task: "hidden",
    selectedModel: "fixture/selected", lastActivityKind: "start", status: "running", phase: "working", acceptedAt: 1,
    origin: { source: "team_assign", coordinatorSessionId: "coordinator", assignmentId: "assignment" } });
  const view = controller.openView();
  expect(view.list().items).toHaveLength(1);
  const detail = view.detail(String(view.list().items[0]!.id));
  expect(detail.workbrief.text).toBe(brief);
  expect(detail.identity.source).toBe("agent_run");
  expect(detail.controls).toMatchObject({ available: false, reason: expect.stringContaining("synchronous") });
  expect(detail.sdkRequest).toBeNull();
  expect(detail.route.state).toBe("not-routed");
  expect(() => view.detail("legacy")).toThrow("unknown scoped worker");
  expect(() => view.detail("foreign")).toThrow("unknown scoped worker");
  expect(() => view.list("foreign")).toThrow("invalid list cursor");
  const second = controller.openView();
  view.acknowledge("route");
  expect(view.route(detail.id).text).toBe("null");
  expect(() => second.route(detail.id)).toThrow("acknowledgement");
  await view.close();
  expect(() => view.detail(detail.id)).toThrow("disconnected");
  expect(second.list().items).toHaveLength(1);
  await second.close();
  controller.revoke(); await controller.settle();
}));

test("controller fences parent, epoch, generation, Team retirement and native replacement, and joins accepted hooks", fixture.ownedCase("control fences", async () => {
  const { root, owner, controller, load } = setup();
  let finish!: (attempt: Attempt) => void, release!: () => void, started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const attempt = fixture.pendingAttempt(resolve => { finish = resolve; });
  const hook = new Promise<void>(resolve => { release = resolve; });
  fixture.finishOnCleanup(release);
  let live!: ReturnType<typeof createLiveHandle>;
  let nativeSession!: { sessionId: string };
  let inputs = 0;
  const worker = await spawnBackground({ roleId: "researcher", task: "original", cwd: root, load,
    historyOrigin: { source: "agent_spawn", coordinatorSessionId: owner.sessionId, workbrief: "original" },
    executor: { capturesHistory: true, async start(input) {
      const history = input.history!.admit(input.instanceId, input.role.id, input.target);
      const manager = history.create();
      const session = { sessionManager: manager, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(),
        async steer() { inputs++; await hook; return "queued" as const; } };
      nativeSession = session;
      live = createLiveHandle(session, history); live.open(); const unbind = input.bindLive?.(live.handle); started();
      const result = await attempt;
      await live.settle(); await live.handle.close(); unbind?.(); history.result(result); history.disposition(); return result;
    } } });
  await start;
  const view = controller.openView();
  const selection = view.detail(worker.instanceId).controls.selection!;
  for (const bad of [{ ...selection, coordinatorSessionId: "other" }, { ...selection, epoch: "old" },
    { ...selection, generation: selection.generation + 1 }, { ...selection, sessionId: "replaced" }]) {
    await expect(view.input(bad, { intent: "query", text: "forbidden" })).rejects.toThrow();
    expect(() => view.cancel(bad)).toThrow();
  }
  expect(inputs).toBe(0);
  const accepted = view.input(selection, { intent: "query", text: "literal /not-command" });
  await Promise.resolve(); await Promise.resolve();
  expect(inputs).toBe(1);
  controller.revoke();
  let joined = false;
  const settlement = controller.settle().then(() => { joined = true; });
  expect(() => view.cancel(selection)).toThrow("retired");
  expect(joined).toBe(false);
  release();
  await expect(accepted).rejects.toThrow("retired"); // receipt cannot be delivered into a disconnected view
  await settlement;
  const entries = live.handle.observe();
  expect(entries.active).toBe(true); // revocation does not cancel the worker
  const next = createAgentController(owner, () => owner), nextView = next.openView();
  expect(() => nextView.cancel(selection)).toThrow("stale controller selection");
  const currentSelection = nextView.detail(worker.instanceId).controls.selection!;
  const originalSessionId = nativeSession.sessionId;
  nativeSession.sessionId = "native-replacement";
  await expect(nextView.input(currentSelection, { intent: "query", text: "wrong native session" })).rejects.toThrow("closed or stale");
  expect(() => nextView.cancel(currentSelection)).toThrow("closed or stale");
  nativeSession.sessionId = originalSessionId;
  expect(nextView.cancel(currentSelection)).toMatchObject({ status: "requested" });
  expect(live.handle.observe().active).toBe(true); // request is not settlement
  await nextView.close(); next.revoke(); await next.settle();
  finish(completed);
  await view.close();

  // A new Team evaluation cannot inherit a captured Team row or binding.
  const team = beginTeamEvaluation(owner.sessionId, false)!;
  publishObservation({ id: "team", roleId: "researcher", task: "wrapped", selectedModel: "fixture/selected", lastActivityKind: "start", status: "running", phase: "working", acceptedAt: 1,
    teamOwnerToken: team.token, origin: { source: "team_assign", coordinatorSessionId: owner.sessionId, assignmentId: "assignment", workbrief: "original" } });
  const teamController = createAgentController(owner, () => owner), teamView = teamController.openView();
  expect(teamView.list().items.some(row => row.id === "team")).toBe(true);
  await retireTeamEvaluation(team);
  expect(() => teamView.detail("team")).toThrow("unknown scoped worker");
  await teamView.close(); teamController.revoke(); await teamController.settle();
}));

test("UI history authorizes refs and cursors, bounded raw acknowledgement remains per view", fixture.ownedCase("history scope", async () => {
  const { root, controller, load } = setup();
  for (const parent of ["coordinator", "coordinator", "foreign", "foreign"]) {
    await runAgentInstance({ roleId: "researcher", task: parent, cwd: root, load,
      historyOrigin: { source: "agent_run", coordinatorSessionId: parent, workbrief: parent },
      executor: { capturesHistory: true, async start(input) {
        const history = input.history!.admit(input.instanceId, input.role.id, input.target), manager = history.create();
        manager.appendMessage({ role: "user", content: parent, timestamp: Date.now() });
        manager.appendCustomEntry("fixture", { parent }); history.result(completed); history.disposition(); return completed; } } });
  }
  const view = controller.openView();
  const listing = await view.history({ action: "list", limit: 1 });
  expect(listing.items).toHaveLength(1);
  expect(listing.cursor).not.toBeNull();
  const more = await view.history({ action: "list", cursor: listing.cursor! });
  expect(more.items).toHaveLength(1);
  const id = (listing.items[0] as { historyId: string }).historyId;
  await expect(view.history({ action: "read", historyId: id })).rejects.toThrow("acknowledgement");
  view.acknowledge("history");
  const first = await view.history({ action: "read", historyId: id, limit: 1 });
  expect(first.items).toHaveLength(1);
  expect(first.cursor).not.toBeNull();
  const next = await view.history({ action: "read", historyId: id, cursor: first.cursor! });
  expect(next.items.length).toBeGreaterThan(0);
  const denied = await view.history({ action: "list", scope: "all" });
  expect(denied.diagnostics.some(row => row.code === "history_outside_scope")).toBe(true);
  const invalid = await view.history({ action: "read", historyId: "foreign" });
  expect(invalid.items).toHaveLength(0);
  const foreignList = await queryHistory({ action: "list", coordinatorSessionId: "foreign", limit: 1 }, "foreign");
  const foreignMember = foreignList.items[0] as { historyId: string; groupId: string };
  const foreignRead = await view.history({ action: "read", historyId: foreignMember.historyId, groupId: foreignMember.groupId });
  expect(foreignRead.diagnostics.some(row => row.code === "history_outside_scope")).toBe(true);
  const forged = JSON.parse(Buffer.from(foreignList.cursor!, "base64url").toString());
  forged.identity = JSON.parse(Buffer.from(listing.cursor!, "base64url").toString()).identity;
  const foreignCursor = await view.history({ action: "list", cursor: Buffer.from(JSON.stringify(forged)).toString("base64url") });
  expect(foreignCursor.items).toHaveLength(0);
  expect(foreignCursor.diagnostics.some(row => row.code === "history_outside_scope")).toBe(true);
  const other = controller.openView();
  await expect(other.history({ action: "read", historyId: id })).rejects.toThrow("acknowledgement");
  const acceptedRead = other.history({ action: "list" });
  await Promise.resolve();
  let closed = false;
  const close = other.close().then(() => { closed = true; });
  expect(closed).toBe(false);
  expect(() => other.list()).toThrow("disconnected");
  await expect(acceptedRead).rejects.toThrow("disconnected");
  await close;
  expect(closed).toBe(true);
  expect(view.list().items).toEqual([]); // closing a read lease does not revoke another view
  await view.close(); controller.revoke(); await controller.settle();
}));

test("selected, activated and observed requests stay distinct across attempt changes", fixture.ownedCase("request provenance", async () => {
  const { root, controller, load } = setup();
  writeFileSync(load.userConfigPath, '[model_policies.researcher.primary]\nmodel = "fixture/selected"\nreasoning = "high"\n[[model_policies.researcher.fallbacks]]\nmodel = "fixture/fallback"\nreasoning = "medium"\n');
  const view = controller.openView();
  let calls = 0;
  const result = await runAgentInstance({ roleId: "researcher", task: "original", cwd: root, load,
    historyOrigin: { source: "agent_run", coordinatorSessionId: "coordinator" }, onObserve: publishObservation,
    executor: { async start(input) {
      calls++;
      const before = view.detail(input.instanceId);
      expect(before.activated).toBeNull();
      expect(before.sdkRequest).toBeNull(); // prior attempt request is not this attempt's actual setting
      input.onActivated?.("off");
      expect(view.detail(input.instanceId).activated?.reasoning).toBe("off");
      expect(view.detail(input.instanceId).sdkRequest).toBeNull();
      input.onRequest?.({ model: "fixture/observed", reasoning: "off", sdkOptions: { reasoning: "off", temperature: 0.25 },
        fast_requested: false, returned_service_tier: "unavailable", time_to_first_model_output_ms: "unavailable" });
      const observed = view.detail(input.instanceId);
      expect(observed.selected.model).toBe(input.target.model);
      expect(observed.sdkRequest).toMatchObject({ model: "fixture/observed", attemptId: observed.selected.attemptId,
        sdkOptions: { temperature: 0.25 } });
      return calls === 1 ? { status: "failed", result: "", error: "503 service unavailable", sideEffects: false } : completed;
    } } });
  expect(calls).toBe(2);
  expect(view.detail(result.instanceId).selected.requestedModel).toBe("fixture/selected");
  expect(view.detail(result.instanceId).workbrief.text).toBe("original");
  await view.close(); controller.revoke(); await controller.settle();
}));

test("current Team lease permits native input/cancel; retirement leaves independent reads available", fixture.ownedCase("Team controls", async () => {
  const { root, owner, controller, load } = setup();
  const evaluation = beginTeamEvaluation(owner.sessionId, false, owner.token)!;
  let finish!: (attempt: Attempt) => void, started!: () => void;
  const attempt = fixture.pendingAttempt(resolve => { finish = resolve; });
  const start = new Promise<void>(resolve => { started = resolve; });
  const wrapper = "Team fixture\nWorkBrief:\n unmodified original ";
  const worker = await spawnBackground({ roleId: "researcher", task: wrapper, cwd: root, load,
    historyOrigin: { source: "team_assign", coordinatorSessionId: owner.sessionId, assignmentId: "assignment", workbrief: " unmodified original " },
    teamOwner: { token: evaluation.token, assignmentId: "assignment", onSettled() {} },
    executor: { capturesHistory: true, async start(input) {
      const history = input.history!.admit(input.instanceId, input.role.id, input.target), manager = history.create();
      const live = createLiveHandle({ sessionManager: manager, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(),
        async steer() { return "queued"; } }, history);
      live.open(); const unbind = input.bindLive!(live.handle); started();
      const result = await attempt;
      await live.settle(); await live.handle.close(); unbind(); history.result(result); history.disposition(); return result;
    } } });
  await start;
  const view = controller.openView(), detail = view.detail(worker.instanceId), selection = detail.controls.selection!;
  expect(detail.workbrief.text).toBe(" unmodified original ");
  expect(detail.teamWrapper).toBe("Team fixture");
  expect(await view.input(selection, { intent: "steer", text: "literal correction" })).toMatchObject({ status: "queued" });
  expect(view.cancel(selection)).toMatchObject({ status: "requested" });
  const retirement = retireTeamEvaluation(evaluation);
  await expect(view.input(selection, { intent: "query", text: "retired Team" })).rejects.toThrow("unknown scoped worker");
  publishObservation({ id: "independent-sync", roleId: "researcher", status: "completed", phase: "idle", task: "independent",
    selectedModel: "fixture/selected", acceptedAt: 1, lastActivityKind: "start",
    origin: { source: "agent_run", coordinatorSessionId: owner.sessionId, workbrief: "independent" } });
  expect(view.detail("independent-sync").workbrief.text).toBe("independent");
  finish(completed);
  await retirement;
  await view.close(); controller.revoke(); await controller.settle();
}));

for (const role of ["researcher", "developer"]) {
test(`same-session startup fences ${role} agent_spawn while controlled external startup is held`, fixture.ownedCase("startup admission " + role, async () => {
  const { root, load } = setup();
  process.env.PI_OFFLINE = "1";
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  mkdirSync(path.join(agentDir, "pitako"), { recursive: true });
  writeFileSync(path.join(agentDir, "pitako/config.toml"), readFileSync(load.userConfigPath, "utf8") +
    '\n[model_policies.developer_mid.primary]\nmodel = "fixture/selected"\nreasoning = "off"\n');
  let releaseCodex!: () => void, releaseDispatch!: () => void;
  const codexHold = new Promise<void>(resolve => { releaseCodex = resolve; });
  const dispatchHold = new Promise<void>(resolve => { releaseDispatch = resolve; });
  let holdNextStartup = false;
  let codexStarted!: () => void;
  const codexStart = new Promise<void>(resolve => { codexStarted = resolve; });
  const controlledCodex = (api: any) => api.on("session_start", async () => {
    if (holdNextStartup) { holdNextStartup = false; codexStarted(); await codexHold; }
  });
  const controllers: ReturnType<typeof createAgentController>[] = [];
  const create = controllerModule.createAgentController;
  const captureController = spyOn(controllerModule, "createAgentController").mockImplementation((...args) => {
    const controller = create(...args); controllers.push(controller); return controller;
  });
  let starts = 0, started!: () => void;
  const workerStarted = new Promise<void>(resolve => { started = resolve; });
  const finishes: Array<() => void> = [];
  setBackgroundExecutor({ async start() {
    starts++; started();
    return fixture.pendingAttempt(resolve => { finishes.push(() => resolve(completed)); });
  } });

  let rebind: Promise<void> | undefined, newerRebind: Promise<void> | undefined, dispatch: Promise<void> | undefined;
  let stale: Promise<unknown> | undefined;
  let view: ReturnType<ReturnType<typeof createAgentController>["openView"]> | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  const preflight = spyOn(routing, "developerPreflight").mockImplementation(input =>
    routing.developerCapacityPreflight({ ...input, capacity: { route: "default" } }));
  try {
    const handlers = new Map<string, Function[]>(), tools = new Map<string, { execute: Function }>();
    const pi = { registerFlag() {}, registerCommand() {},
      registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
      on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
      getFlag() {}, getAllTools: () => [{ name: "read" }], getActiveTools: () => ["read"],
      setActiveTools() {}, getSessionName: () => "pitako:coding", setSessionName() {}, sendMessage() {} };
    const ctx = { cwd: root, hasUI: false, isIdle: () => true,
      sessionManager: { getSessionId: () => "same-session", getSessionFile: () => path.join(root, "coordinator.jsonl"), getEntries: () => [] } };
    const factories = new Map<string, Function>([["./extensions/index.ts", pitako],
      ["./node_modules/pi-codex-tools/index.ts", controlledCodex],
      ["./extensions/profile-policy.ts", profilePolicy], ["./extensions/agent/index.ts", agentInstance]]);
    for (const entry of JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).pi.extensions)
      factories.get(entry)?.(pi);

    const emit = async (type: string) => {
      for (const handler of handlers.get(type) ?? []) await handler({ type }, ctx);
    };
    cleanup = () => emit("session_shutdown");
    await emit("session_start");
    const spawn = (task: string) => tools.get("agent_spawn")!.execute(task, { role, task }, undefined, undefined, ctx);
    const status = async () => (await tools.get("agent_status")!.execute("status", {}, undefined, undefined, ctx)).details;
    view = controllers.at(-1)!.openView();
    let dispatchSignal: AbortSignal | undefined;
    dispatch = ownedDispatch(ctx as never, undefined, () => true, async signal => {
      dispatchSignal = signal; await dispatchHold;
    });
    await Promise.resolve();
    // Async launch reserves immediately; retirement must join its no-worker preparation.
    stale = spawn("stale queued spawn");
    holdNextStartup = true;
    let joined = false;
    rebind = emit("session_start").then(() => { joined = true; });
    expect(dispatchSignal?.aborted).toBe(true);
    expect(() => view!.list()).toThrow("retired");
    const staleResult = await stale;
    const during = await spawn("spawn during startup");
    // Direct definitions expose the guard throw; Pi turns it into a tool error.
    await expect(status()).rejects.toThrow("captured native context retired");
    expect(staleResult).toMatchObject({ isError: false, details: { dispatchPhase: "preflight" } });
    expect(during).toMatchObject({ isError: true, details: { error: "Dispatch cancelled before admission" } });
    expect(workerStatus((staleResult as { details: { instanceId: string } }).details.instanceId)).toEqual([expect.objectContaining({
      instanceId: (staleResult as { details: { instanceId: string } }).details.instanceId,
      status: "cancelled", workerStarted: false,
    })]);
    expect(starts).toBe(0);
    expect(preflight).not.toHaveBeenCalled();
    expect(joined).toBe(false);
    expect(await ownedDispatch({ ...ctx, sessionManager: { getSessionId: () => "independent" } } as never,
      undefined, () => true, async (_signal, check) => { check(); return "independent"; })).toBe("independent");
    // A newer transition may settle first, but cannot release the older lease.
    let newerJoined = false;
    newerRebind = emit("session_start").then(() => { newerJoined = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(newerJoined).toBe(false); // abort request alone does not settle the held callback
    releaseDispatch(); await dispatch; await codexStart; await newerRebind;
    expect(await status()).toEqual({ workers: [] });
    expect(starts).toBe(0);
    expect(joined).toBe(false);
    const newestController = controllers.at(-1)!;
    // Only Codex is held: both own phases have settled and admission is open.
    const whileCodex = await spawn("external startup still held");
    expect(whileCodex).toMatchObject({ isError: false, details: { status: "running" } });
    await workerStarted;
    releaseCodex(); await rebind;
    expect(controllers.at(-1)).toBe(newestController);
    const freshStarted = new Promise<void>(resolve => { started = resolve; });
    const fresh = await spawn("fresh authorized spawn");
    expect(fresh).toMatchObject({ details: { status: "running", dispatchPhase: "preflight" }, isError: false });
    await freshStarted;
    const freshView = controllers.at(-1)!.openView();
    expect(freshView.list().items.map(row => row.id)).toContain((fresh.details as { instanceId: string }).instanceId);
    expect(starts).toBe(2);
    expect(preflight).toHaveBeenCalledTimes(role === "developer" ? 2 : 0);
    await freshView.close();
    for (const finish of finishes) finish();
    await emit("session_shutdown");
    await expect(status()).rejects.toThrow("captured native context retired");
    expect(workerStatus()).toEqual([]);
  } finally {
    releaseCodex(); releaseDispatch();
    for (const finish of finishes) finish();
    await Promise.allSettled([stale, dispatch, rebind, newerRebind]);
    await cleanup?.();
    await view?.close();
    preflight.mockRestore();
    captureController.mockRestore();
  }
}));
}

for (const { event, failUpstream } of [
  { event: "session_start", failUpstream: false },
  { event: "session_shutdown", failUpstream: false },
  { event: "session_start", failUpstream: true },
] as const) {
  const name = `composed ${event}${failUpstream ? " with upstream failure" : ""}`;
  test(`${name} revokes native and controller admissions before its first await`, fixture.ownedCase(name, async () => {
    const { root, load } = setup();
    process.env.PI_OFFLINE = "1";
    const extensions: Array<{ handlers: Map<string, Function[]> }> = [];
    const statuses = new Map<string, string>();
    const tools = new Map<string, { execute: Function }>();
    let failNextUpstream = false;
    const pi = { registerFlag() {}, registerCommand() {}, registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
      on(name: string, handler: Function) {
        const handlers = extensions.at(-1)!.handlers;
        handlers.set(name, [...handlers.get(name) ?? [], handler]);
      },
      getFlag() {}, getAllTools() { return [{ name: "read" }]; }, getActiveTools() { return ["read"]; },
      setActiveTools() {}, getSessionName() { return "pitako:coding"; }, setSessionName() {}, sendMessage() {} };
    const ctx = { cwd: root, hasUI: true, isIdle: () => true,
      sessionManager: { getSessionId: () => "coordinator", getEntries: () => [] },
      ui: { notify() {}, setStatus(key: string, text?: string) { if (text) statuses.set(key, text); else statuses.delete(key); } } };
    const controllers: ReturnType<typeof createAgentController>[] = [];
    const originalCreate = controllerModule.createAgentController;
    const capture = spyOn(controllerModule, "createAgentController").mockImplementation((...args) => {
      const controller = originalCreate(...args);
      controllers.push(controller);
      return controller;
    });
    const factories = new Map<string, Function>([
      ["./extensions/index.ts", pitako],
      ["./node_modules/pi-codex-tools/index.ts", (api: any) => api.on("session_start", () => {
        if (failNextUpstream) { failNextUpstream = false; throw new Error("fixture upstream startup failed"); }
      })],
      ["./extensions/profile-policy.ts", profilePolicy],
      ["./extensions/agent/index.ts", agentInstance],
    ]);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const entry of manifest.pi.extensions) {
      const factory = factories.get(entry);
      if (!factory) continue;
      extensions.push({ handlers: new Map() });
      factory(pi as never);
    }
    const errors: unknown[] = [];
    const emit = async (type: string) => {
      for (const extension of extensions) for (const handler of extension.handlers.get(type) ?? []) {
        try { await handler({ type }, ctx); }
        catch (error) { errors.push({ event: type, error: (error as Error).message }); }
      }
    };
    let dispatch: Promise<void> | undefined, transition: Promise<unknown> | undefined, acceptedInput: Promise<unknown> | undefined;
    let view: ReturnType<ReturnType<typeof createAgentController>["openView"]> | undefined;
    const cleanup: Array<() => void> = [];
    try {
      await emit("session_start");
      view = controllers.at(-1)!.openView();
      let release!: () => void, releaseInput!: () => void, inputStarted!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      const inputHold = new Promise<void>(resolve => { releaseInput = resolve; });
      const inputStart = new Promise<void>(resolve => { inputStarted = resolve; });
      cleanup.push(release, releaseInput);
      const startWorker = async () => {
        let finish!: (attempt: Attempt) => void, started!: () => void;
        const attempt = fixture.pendingAttempt(resolve => { finish = resolve; });
        cleanup.push(() => finish(completed));
        const start = new Promise<void>(resolve => { started = resolve; });
        const worker = await spawnBackground({ roleId: "researcher", task: "held", cwd: root, load,
          historyOrigin: { source: "agent_spawn", coordinatorSessionId: "coordinator", workbrief: "held" },
          executor: { capturesHistory: true, async start(input) {
            const history = input.history!.admit(input.instanceId, input.role.id, input.target), manager = history.create();
            const live = createLiveHandle({ sessionManager: manager, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(),
              async steer(text) {
                if (text.includes("accepted held input")) { inputStarted(); await inputHold; }
                return "queued";
              } }, history);
            live.open(); const unbind = input.bindLive!(live.handle); started();
            const result = await attempt;
            await live.settle(); await live.handle.close(); unbind(); history.result(result); history.disposition(); return result;
          } } });
        await start;
        return { ...worker, finish };
      };
      const worker = await startWorker();
      const { resolveOwnedLive } = await import("../extensions/agent/owner.ts");
      const target = { kind: "background" as const, instanceId: worker.instanceId };
      expect(resolveOwnedLive(target, "coordinator").handle.observe().active).toBe(true);
      const selection = view.detail(worker.instanceId).controls.selection!;
      expect(await view.input(selection, { intent: "query", text: "before retirement" })).toMatchObject({ status: "queued" });
      acceptedInput = view.input(selection, { intent: "query", text: "accepted held input" });
      // The native hook has admitted work, but its result must not paint a retired view.
      void acceptedInput.catch(() => {});
      await inputStart;
      dispatch = ownedDispatch(ctx as never, undefined, () => true, async () => hold);
      await Promise.resolve();
      let settled = false;
      failNextUpstream = failUpstream;
      transition = emit(event).then(() => { settled = true; });
      expect(teamEvaluationForSession("coordinator", false)).toBeUndefined();
      expect(() => resolveOwnedLive(target, "coordinator")).toThrow("foreground owner");
      expect(() => view!.list()).toThrow("retired");
      expect(() => view!.detail(worker.instanceId)).toThrow("retired");
      expect(() => view!.acknowledge("history")).toThrow("retired");
      expect(() => view!.cancel(selection)).toThrow("retired");
      expect(() => view!.input(selection, { intent: "steer", text: "during retirement" })).toThrow("retired");
      expect(() => tools.get("agent_input")!.execute("during", {
        target, historyId: selection.historyId, sessionId: selection.sessionId, intent: "query", text: "during retirement",
      }, undefined, undefined, ctx)).toThrow("captured native context retired");
      expect(statuses.has("pitako.agents")).toBe(false);
      expect(settled).toBe(false);
      release(); await dispatch;
      await Promise.resolve();
      expect(settled).toBe(false); // accepted controller work is still held
      releaseInput(); await expect(acceptedInput).rejects.toThrow("retired");
      worker.finish(completed);
      await transition;
      if (event === "session_shutdown") await emit("session_start");
      const freshView = controllers.at(-1)!.openView();
      expect(freshView.list().items).toEqual([]);
      expect(() => view!.list()).toThrow("retired");
      const freshWorker = await startWorker();
      const freshSelection = freshView.detail(freshWorker.instanceId).controls.selection!;
      expect(freshView.list().items.map(row => row.id)).toContain(freshWorker.instanceId);
      expect(await freshView.input(freshSelection, { intent: "steer", text: "fresh owner" })).toMatchObject({ status: "queued" });
      expect(await tools.get("agent_input")!.execute("fresh", {
        target: freshSelection.target, historyId: freshSelection.historyId, sessionId: freshSelection.sessionId, intent: "query", text: "fresh native owner",
      }, undefined, undefined, ctx)).toMatchObject({ details: { status: "queued" } });
      expect(freshView.cancel(freshSelection)).toMatchObject({ status: "requested" });
      freshWorker.finish(completed);
      await freshView.close();
    } finally {
      // Settlement is owned even when the synchronous regression assertion fails.
      for (const finish of cleanup) finish();
      await dispatch;
      await transition;
      await Promise.allSettled([acceptedInput]);
      await view?.close();
      await emit("session_shutdown");
      capture.mockRestore();
      if (failUpstream) expect(errors).toMatchObject([{ event: "session_start", error: "fixture upstream startup failed" }]);
      else expect(errors).toEqual([]);
    }
  }));
}


test("packaged shutdown fences workflow authority while foreground retirement remains held",
  fixture.ownedCase("composed workflow retirement", async () => {
    const { root } = setup();
    const handlers = new Map<string, Function[]>(), commands = new Map<string, { handler: Function }>();
    const controllers: ReturnType<typeof createAgentController>[] = [];
    const pi = { registerFlag() {}, registerTool() {},
      registerCommand(name: string, command: { handler: Function }) { commands.set(name, command); },
      on(type: string, handler: Function) { handlers.set(type, [...handlers.get(type) ?? [], handler]); },
      getFlag() {}, getAllTools: () => [{ name: "read" }], getActiveTools: () => ["read"], setActiveTools() {},
      getSessionName: () => "pitako:coding", setSessionName() {}, sendMessage() {} };
    const ctx = { cwd: root, hasUI: false, isIdle: () => true, async waitForIdle() {},
      sessionManager: { getSessionId: () => `workflow-${path.basename(root)}`, getEntries: () => [], getBranch: () => [] } };
    const create = controllerModule.createAgentController;
    const capture = spyOn(controllerModule, "createAgentController").mockImplementation((...args) => {
      const controller = create(...args); controllers.push(controller); return controller;
    });
    const hold = Promise.withResolvers<void>();
    let dispatch: Promise<unknown> | undefined, shutdown: Promise<void> | undefined;
    const emit = async (type: string) => { for (const handler of handlers.get(type) ?? []) await handler({ type }, ctx); };
    try {
      pitako(pi as never);
      await emit("session_start");
      await commands.get("plan")!.handler("shutdown-owner", ctx);
      const authority = captureCallContext(root, ctx.sessionManager);
      expect(authority.kind).toBe("managed");
      checkCallContext(authority);
      const view = controllers[0]!.openView();
      dispatch = ownedDispatch(ctx as never, undefined, () => true, async () => hold.promise);
      await Promise.resolve();
      let closed = false;
      shutdown = emit("session_shutdown").then(() => { closed = true; });
      expect(() => view.list()).toThrow("retired");
      expect(() => checkCallContext(authority)).toThrow("retired");
      expect(() => checkCallContext(captureCallContext(root, ctx.sessionManager))).toThrow("retired");
      expect(teamEvaluationForSession(ctx.sessionManager.getSessionId(), false)).toBeUndefined();
      await Promise.resolve();
      expect(closed).toBe(false);
      hold.resolve(); await dispatch; await shutdown;
      await emit("session_start");
      expect(() => checkCallContext(authority)).toThrow("retired");
      expect(() => checkCallContext(captureCallContext(root, ctx.sessionManager))).toThrow("retired");
      await view.close();
    } finally {
      hold.resolve(); await dispatch; await shutdown;
      await emit("session_shutdown"); capture.mockRestore();
    }
  }));

for (const successor of ["session_start", "session_shutdown", "uncertain-close"] as const) {
  test(`retained own retirement fences overlapping ${successor} after live handles are cleared`, fixture.ownedCase(successor, async () => {
    const { root } = setup();
    const sessionId = `retained-${successor}-${path.basename(root)}`;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>(), bridgeClosing = Promise.withResolvers<void>(), bridgeRelease = Promise.withResolvers<void>();
    const handlers = new Map<string, Function[]>(), controllers: ReturnType<typeof createAgentController>[] = [];
    const pi = { registerFlag() {}, registerCommand() {}, registerTool() {},
      getFlag: (name: string) => successor === "uncertain-close" && name === "pitako-agent-bridge" ? path.join(root, "bridge") : undefined,
      on(type: string, handler: Function) { handlers.set(type, [...handlers.get(type) ?? [], handler]); },
      getAllTools: () => [{ name: "read" }], getActiveTools: () => ["read"], setActiveTools() {},
      getSessionName: () => "pitako:coding", setSessionName() {}, sendMessage() {} };
    const ctx = { cwd: root, mode: "rpc", hasUI: false, isIdle: () => true,
      sessionManager: { getSessionId: () => sessionId, getEntries: () => [] } };
    const create = controllerModule.createAgentController;
    const capture = spyOn(controllerModule, "createAgentController").mockImplementation((...args) => {
      const controller = create(...args); controllers.push(controller);
      if (controllers.length === 1) {
        const settle = controller.settle;
        controller.settle = async () => {
          await settle(); entered.resolve(); await release.promise;
          // Only a synthetic observation failure: the real resources above have settled.
          if (successor === "uncertain-close") { failed.resolve(); throw new Error("controlled uncertain own close"); }
        };
      }
      return controller;
    });
    const bridge = spyOn(bridgeModule, "createAgentBridge").mockImplementation(() => ({
      ready: Promise.resolve(), revoke() {},
      async settle() { bridgeClosing.resolve(); await bridgeRelease.promise; },
    }) as never);
    pitako(pi as never); profilePolicy(pi as never);
    const emit = async (type: string) => { for (const handler of handlers.get(type) ?? []) await handler({ type }, ctx); };
    const pending: Promise<unknown>[] = [];
    const completion = spyOn(completionModule, "completePitakoConfig");
    try {
      await emit("session_start");
      expect(completion).toHaveBeenCalledTimes(1);
      const oldView = controllers[0]!.openView();
      let firstDone = false, nextDone = false;
      const first = emit("session_start").finally(() => { firstDone = true; }); pending.push(first); void first.catch(() => {});
      expect(() => oldView.list()).toThrow("retired");
      await entered.promise;
      const next = emit(successor === "session_shutdown" ? successor : "session_start").finally(() => { nextDone = true; });
      pending.push(next); void next.catch(() => {});
      await Promise.resolve(); await Promise.resolve();
      expect(firstDone).toBe(false); expect(nextDone).toBe(false); expect(controllers).toHaveLength(1);
      expect(completion).toHaveBeenCalledTimes(1);
      const blocked = ownedDispatch(ctx as never, undefined, () => true, async (_signal, check) => { check(); return "bad"; });
      await expect(blocked).rejects.toThrow("cancelled");
      expect(await ownedDispatch({ ...ctx, sessionManager: { getSessionId: () => `independent-${sessionId}` } } as never,
        undefined, () => true, async (_signal, check) => { check(); return "independent"; })).toBe("independent");
      release.resolve();
      if (successor === "uncertain-close") {
        await failed.promise; await bridgeClosing.promise;
        // One rejected close cannot conclude either event while another started close is held.
        await Promise.resolve(); await Promise.resolve();
        expect(firstDone).toBe(false); expect(nextDone).toBe(false);
      }
      bridgeRelease.resolve();
      const results = await Promise.allSettled([first, next]);
      expect(completion).toHaveBeenCalledTimes(successor === "session_start" ? 2 : 1);
      if (successor === "uncertain-close") {
        expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
        await expect(emit("session_start")).rejects.toThrow("Foreground retirement");
        await expect(emit("session_shutdown")).rejects.toThrow("Foreground retirement");
        expect(controllers).toHaveLength(1);
        await expect(ownedDispatch(ctx as never, undefined, () => true, async (_signal, check) => { check(); })).rejects.toThrow("cancelled");
      } else {
        expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
        expect(controllers).toHaveLength(successor === "session_start" ? 2 : 1);
        expect(await ownedDispatch(ctx as never, undefined, () => true, async (_signal, check) => { check(); return "open"; })).toBe("open");
      }
      await oldView.close();
    } finally {
      release.resolve(); bridgeRelease.resolve(); await Promise.allSettled(pending);
      await emit("session_shutdown").catch(error => { if (successor !== "uncertain-close") throw error; });
      capture.mockRestore(); bridge.mockRestore(); completion.mockRestore();
    }
  }));
}

test("partial own publication retires all new authority before releasing its lease; native errors remain separate",
  fixture.ownedCase("partial publication cleanup", async () => {
    const { root } = setup();
    const ready = Promise.withResolvers<void>(), closing = Promise.withResolvers<void>(), closeEntered = Promise.withResolvers<void>();
    const controllers: ReturnType<typeof createAgentController>[] = [];
    const entries: Array<{ entry: string; hooks: Map<string, Function[]> }> = [];
    const errors: Array<{ entry: string; error: unknown }> = [], statuses = new Map<string, string>();
    const bridgeEntered = Promise.withResolvers<void>();
    let active = ["read"], bridgeStarts = 0, revokes = 0, closes = 0, finalWrites = 0;
    const create = controllerModule.createAgentController;
    const capture = spyOn(controllerModule, "createAgentController").mockImplementation((...args) => {
      const controller = create(...args); controllers.push(controller); return controller;
    });
    const bridge = spyOn(bridgeModule, "createAgentBridge").mockImplementation(() => {
      const first = ++bridgeStarts === 1; bridgeEntered.resolve();
      return { ready: first ? ready.promise : Promise.resolve(), revoke() { revokes++; },
        async settle() { closes++; if (first) { closeEntered.resolve(); await closing.promise; } } } as never;
    });
    const pi = { registerFlag() {}, registerCommand() {}, registerTool() {},
      getFlag: (name: string) => name === "pitako-agent-bridge" ? path.join(root, "bridge") : undefined,
      on(type: string, handler: Function) { const hooks = entries.at(-1)!.hooks; hooks.set(type, [...hooks.get(type) ?? [], handler]); },
      getAllTools: () => ["read", "edit", "write"].map(name => ({ name })), getActiveTools: () => active,
      setActiveTools(names: string[]) { active = names; }, getSessionName: () => "pitako:coding", setSessionName() {}, sendMessage() {} };
    const ctx = { cwd: root, mode: "rpc", hasUI: true, isIdle: () => true,
      sessionManager: { getSessionId: () => `partial-${path.basename(root)}`, getEntries: () => [] },
      ui: { notify() {}, setStatus(key: string, text?: string) { if (text) statuses.set(key, text); else statuses.delete(key); } } };
    const external = new Error("controlled external failure"), publication = new Error("controlled bridge readiness failure");
    const factories = new Map<string, Function>([["./extensions/index.ts", pitako],
      ["./node_modules/pi-codex-tools/index.ts", (api: any) => api.on("session_start", () => { throw external; })],
      ["./extensions/profile-policy.ts", (api: any) => profilePolicy({ ...api, setActiveTools(names: string[]) { finalWrites++; pi.setActiveTools(names); } })]]);
    for (const entry of JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).pi.extensions) {
      const factory = factories.get(entry); if (!factory) continue;
      entries.push({ entry, hooks: new Map() }); factory(pi);
    }
    const emit = async (type: string) => {
      for (const item of entries) for (const handler of item.hooks.get(type) ?? []) {
        try { await handler({ type }, ctx); } catch (error) { errors.push({ entry: item.entry, error }); }
      }
    };
    let transition: Promise<void> | undefined;
    try {
      transition = emit("session_start");
      // Publication has reached the owned bridge, but its readiness is not yet settled.
      await bridgeEntered.promise;
      const partial = controllers[0]!.openView();
      ready.reject(publication); await closeEntered.promise;
      expect(() => partial.list()).toThrow("retired");
      expect(statuses.has("pitako.agents")).toBe(false);
      expect(revokes).toBe(1); expect(closes).toBe(1); expect(finalWrites).toBe(0);
      await expect(ownedDispatch(ctx as never, undefined, () => true, async (_signal, check) => { check(); })).rejects.toThrow("cancelled");
      closing.resolve(); await transition;
      expect(errors).toEqual([{ entry: "./extensions/index.ts", error: publication },
        { entry: "./node_modules/pi-codex-tools/index.ts", error: external }]);
      expect(finalWrites).toBe(0);
      await emit("session_start");
      expect(controllers).toHaveLength(2); expect(bridgeStarts).toBe(2); expect(finalWrites).toBe(1);
      const fresh = controllers[1]!.openView(); expect(fresh.list().items).toEqual([]); await fresh.close(); await partial.close();
    } finally {
      ready.resolve(); closing.resolve(); await transition; await emit("session_shutdown");
      capture.mockRestore(); bridge.mockRestore();
    }
  }));
