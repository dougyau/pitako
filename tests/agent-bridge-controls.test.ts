import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentController } from "../extensions/agent/controller.ts";
import { createAgentBridge } from "../extensions/agent/bridge/broker.ts";
import { connect, type BridgeClient } from "../extensions/agent/bridge/client.js";
import { bindBackgroundOwner, clearBackgroundOwner, spawnBackground, setBackgroundExecutor, readWorkerResult } from "../extensions/agent/background.ts";
import { createLiveHandle } from "../extensions/agent/live.ts";
import { clearObservations } from "../extensions/agent/observe.ts";
import { beginTeamEvaluation, reserveTeamRole, recordTeamAssignment, retireTeamEvaluation } from "../extensions/team.ts";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import type { Attempt } from "../extensions/agent/run.ts";

const fixture = agentFixtureOwnership();
const oldDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  fixture.requireReleasedFixture();
  clearBackgroundOwner(); clearObservations(); setBackgroundExecutor(undefined);
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  for (const root of fixture.directories.splice(0)) rmSync(root, { recursive: true });
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(value => { resolve = value; });
  return { promise, resolve };
};
const completed: Attempt = { status: "completed", result: "fixture done", sideEffects: false };
const input = { intent: "query" as const, text: "literal /not-command", decisionId: "explicit-client-decision" };

test("evicting a pending receipt never resurrects its callback or makes its sequence reusable", fixture.ownedCase("pending receipt eviction", async () => {
  await controls(async state => {
    const client = await state.peer(), selection = (await client.detail(state.workers[0].instanceId)).controls.selection!;
    await client.grant("control", true, selection);
    state.hold();
    const accepted = client.input(selection, input, 1);
    await state.entered.promise;
    for (let sequence = 2; sequence <= 33; sequence++) {
      expect(await client.input(selection, input, sequence)).toMatchObject({ receipt: { kind: "error", code: "busy" } });
    }
    expect(await client.requestStatus(1)).toEqual({ state: "outcome_unknown", sequence: 1 });
    state.gate.resolve();
    expect(await accepted).toMatchObject({ receipt: { kind: "input", native: { status: "handled" } } });
    expect(await client.requestStatus(1)).toEqual({ state: "outcome_unknown", sequence: 1 });
    expect(await client.input(selection, { ...input, text: "changed evicted request" }, 1))
      .toEqual({ state: "outcome_unknown", sequence: 1 });
    expect(state.effects()).toBe(1);
    expect((await client.input(selection, input, 34)).state).toBe("recorded");
    expect(state.effects()).toBe(2);
  });
}));

test("logical leases, active connections and complete native input envelopes are bounded independently", fixture.ownedCase("control bounds", async () => {
  await controls(async state => {
    const client = await state.peer(), selection = (await client.detail(state.workers[0].instanceId)).controls.selection!;
    await client.grant("control", true, selection);
    for (const bad of [
      { intent: "follow-up", text: "not supported" },
      { intent: "query", text: "😀".repeat(4097) },
      { intent: "query", text: "valid", decisionId: "😀".repeat(257) },
    ]) await expect(client.input(selection, bad as never, 1)).rejects.toMatchObject({ code: "invalid_request" });
    // Native text fits 16 KiB, but its COMPLETE JSON request exceeds the 64 KiB frame.
    await expect(client.input(selection, { intent: "query", text: "\0".repeat(16 * 1024) }, 1)).rejects.toThrow();
    expect(await client.requestStatus(1)).toEqual({ state: "not_admitted", sequence: 1 });
    expect(state.effects()).toBe(0);
    expect((await client.input(selection, { intent: "query", text: "😀".repeat(4096), decisionId: "😀".repeat(256) }, 1))
      .state).toBe("recorded");
    expect(state.effects()).toBe(1);
    const active = [client, await state.peer(), await state.peer(), await state.peer()];
    await expect(state.peer()).rejects.toThrow();
    for (const peer of active) await peer.disconnect();
    await state.disconnected(4);
    for (let index = 4; index < 16; index++) {
      const next = await state.peer(); await next.disconnect(); await state.disconnected(index + 1);
    }
    await expect(state.peer()).rejects.toMatchObject({ code: "busy" });
    const resumed = await state.peer(client.lease);
    expect((await resumed.requestStatus(1)).state).toBe("recorded");
    expect(state.effects()).toBe(1);
  });
}));

async function controls(run: (state: {
  file: string; controller: ReturnType<typeof createAgentController>; bridge: ReturnType<typeof createAgentBridge>;
  owner: { sessionId: string; token: symbol }; team: NonNullable<ReturnType<typeof beginTeamEvaluation>>;
  workers: Array<{ instanceId: string; native: { sessionId: string }; historyId: string }>;
  peer(resume?: BridgeClient["lease"]): Promise<BridgeClient>;
  gate: ReturnType<typeof deferred>; entered: ReturnType<typeof deferred>; effects(): number; hold(): void;
  disconnected(count: number): Promise<void>;
  retireBeforeAdmission(): void;
}) => Promise<void>, grants: ("control" | "history" | "route")[] = ["control", "history", "route"]) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-bridge-controls-"));
  fixture.directories.push(root);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const config = path.join(root, "config.toml");
  writeFileSync(config, '[model_policies.researcher.primary]\nmodel = "fixture/local"\nreasoning = "off"\n');
  const owner = { sessionId: "controls-owner", token: Symbol() };
  bindBackgroundOwner({ token: owner.token, hasUI: false, isIdle: () => false, notify() {}, sendMessage() {} });
  const controller = createAgentController(owner, () => owner);
  const bridgeRoot = path.join(root, "bridge"); mkdirSync(bridgeRoot, { mode: 0o700 });
  const bridge = createAgentBridge(controller, bridgeRoot, grants, () => true);
  const team = beginTeamEvaluation(owner.sessionId, false, owner.token)!;
  const workers: Array<{ instanceId: string; native: { sessionId: string }; historyId: string }> = [];
  const clients: BridgeClient[] = [], finishers: Array<() => void> = [];
  const gate = deferred(), entered = deferred();
  let effects = 0, held = false, retireInput = false;
  let disconnected = 0;
  const openView = controller.openView;
  const views = spyOn(controller, "openView").mockImplementation(options => {
    const view = openView(options);
    return { ...view, close() { if (options?.control === false) disconnected++; return view.close(); },
      input(...args: Parameters<typeof view.input>) {
        const accepted = view.input(...args);
        if (retireInput) controller.revoke();
        return accepted;
      } };
  });
  fixture.finishOnCleanup(gate.resolve);
  try {
    await bridge.ready;
    for (const kind of ["background", "team"]) {
      const started = deferred();
      const attempt = fixture.pendingAttempt(finish => { finishers.push(() => finish(completed)); });
      const assignmentId = "controls-assignment";
      const reservation = kind === "team" ? reserveTeamRole(team, "researcher", assignmentId) : undefined;
      const worker = await spawnBackground({ roleId: "researcher", task: "original", cwd: root,
        load: { userConfigPath: config, env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } },
        ...(reservation ? { teamOwner: { token: reservation.token, assignmentId, onSettled: () => reservation.settled() } } : {}),
        historyOrigin: { source: kind === "team" ? "team_assign" : "agent_spawn", coordinatorSessionId: owner.sessionId,
          ...(reservation ? { assignmentId } : {}), workbrief: "original" },
        executor: { capturesHistory: true, async start(request) {
          const history = request.history!.admit(request.instanceId, request.role.id, request.target), manager = history.create();
          const native = { sessionId: manager.getSessionId(), sessionManager: manager, sessionFile: manager.getSessionFile(),
            async steer() { effects++; if (held) { held = false; entered.resolve(); await gate.promise; } return "handled" as const; } };
          const live = createLiveHandle(native, history); live.open();
          const unbind = request.bindLive?.(live.handle);
          workers.push({ instanceId: request.instanceId, native, historyId: history.historyId }); started.resolve();
          const outcome = await attempt;
          await live.settle(); await live.handle.close(); unbind?.(); history.result(outcome); history.disposition();
          return outcome;
        } } });
      reservation?.commit();
      if (reservation) recordTeamAssignment(team, "researcher", { id: assignmentId, instanceId: worker.instanceId, roleId: "researcher", task: "original" });
      await started.promise;
    }
    const file = path.join(bridgeRoot, "descriptor.json");
    await run({ file, controller, bridge, owner, team, workers, gate, entered, effects: () => effects, hold() { held = true; },
      retireBeforeAdmission() { retireInput = true; },
      async disconnected(count) {
        while (disconnected < count) await new Promise<void>(resolve => setImmediate(resolve));
      },
      async peer(resume) {
        const client = await connect(file, { expectedSessionId: owner.sessionId, ...(resume ? { resume } : {}) });
        clients.push(client); return client;
      } });
  } finally {
    gate.resolve(); for (const finish of finishers) finish();
    await Promise.all(clients.map(client => client.disconnect()));
    bridge.revoke(); controller.revoke(); await bridge.settle(); await controller.settle();
    views.mockRestore();
    retireTeamEvaluation(team);
  }
}

test("admitted native evidence survives response loss; resume only restores lookup; sequences never repeat effects", fixture.ownedCase("control recovery", () =>
  controls(async state => {
    let client = await state.peer();
    const selection = (await client.detail(state.workers[0]!.instanceId)).controls.selection!;
    await expect(client.input(selection, input, 1)).rejects.toMatchObject({ code: "forbidden" });
    expect(await client.requestStatus(1)).toEqual({ state: "not_admitted", sequence: 1 });
    await client.grant("control", true, selection); await client.grant("history", true); await client.grant("route", true);
    state.hold();
    const lost = client.input(selection, input, 1).catch(error => error);
    await state.entered.promise;
    expect(await client.requestStatus(1)).toEqual({ state: "pending", sequence: 1 });
    expect((await client.input(selection, input, 1)).state).toBe("pending");
    await expect(client.input(selection, { ...input, text: "changed" }, 1)).rejects.toMatchObject({ code: "sequence_conflict" });
    // Busy is a consumed transport decision, not queued worker input or a cancellation bypass.
    const busy = await client.cancel(selection, 2);
    expect(busy).toMatchObject({ state: "recorded", receipt: { kind: "error", code: "busy" } });
    const independent = await state.peer();
    const other = (await independent.detail(state.workers[1]!.instanceId)).controls.selection!;
    await independent.grant("control", true, other);
    expect((await independent.input(other, input, 1)).state).toBe("recorded");
    await independent.disconnect();
    const resume = client.lease;
    await client.disconnect(); expect((await lost).code).toBe("disconnected");
    client = await state.peer(resume);
    expect(client.lease.highWater).toBe(2);
    expect((await client.requestStatus(1)).state).toBe("pending");
    await expect(client.input(selection, input, 3)).rejects.toMatchObject({ code: "forbidden" });
    await client.grant("control", true, selection);
    expect(await client.input(selection, input, 3)).toMatchObject({ receipt: { kind: "error", code: "busy" } });
    expect(state.effects()).toBe(2); // Reconnection does not bypass the logical client's pending admission.
    await expect(client.routeRead(selection.instanceId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(client.historyRead({ historyId: selection.historyId })).rejects.toMatchObject({ code: "forbidden" });
    state.gate.resolve();
    let recovered = await client.requestStatus(1);
    while (recovered.state === "pending") {
      await new Promise<void>(resolve => setImmediate(resolve)); recovered = await client.requestStatus(1);
    }
    expect(recovered).toMatchObject({ state: "recorded", sequence: 1, receipt: { kind: "input", native: { status: "handled", sessionId: selection.sessionId } } });
    expect(await client.input({ ...selection, target: { ...selection.target } }, input, 1)).toEqual(recovered);
    expect(state.effects()).toBe(2);
    await client.grant("control", true, selection);
    for (let sequence = 4; sequence <= 35; sequence++) {
      expect((await client.input(selection, { ...input, intent: "steer" }, sequence)).state).toBe("recorded");
    }
    expect(state.effects()).toBe(34);
    expect(await client.requestStatus(1)).toEqual({ state: "outcome_unknown", sequence: 1 });
    expect(await client.input(selection, input, 1)).toEqual({ state: "outcome_unknown", sequence: 1 });
    expect(state.effects()).toBe(34);
    expect((await client.requestStatus(4)).state).toBe("recorded");
    expect((await client.requestStatus(36)).state).toBe("not_admitted");
    const requested = await client.cancel(selection, 36);
    expect(requested).toMatchObject({ state: "recorded", receipt: { kind: "cancel", native: { status: "requested" } } });
    expect(readWorkerResult({ kind: "background", instanceId: selection.instanceId }, {
      coordinatorSessionId: state.owner.sessionId, ownerToken: state.owner.token })).toMatchObject({ state: "unavailable", reason: "outcome_missing" });
    expect(await client.cancel(selection, 36)).toEqual(requested);
  })));

test("complete selection is re-resolved for activation/input/cancel and immediately before native admission", fixture.ownedCase("control identities", () =>
  controls(async state => {
    const client = await state.peer(), selection = (await client.detail(state.workers[0]!.instanceId)).controls.selection!;
    for (const bad of [
      { ...selection, processId: "other" }, { ...selection, epoch: "old" }, { ...selection, coordinatorSessionId: "foreign" },
      { ...selection, instanceId: "foreign", target: { kind: "background" as const, instanceId: "foreign" } },
      { ...selection, target: { kind: "team" as const, assignmentId: "controls-assignment" } },
      { ...selection, generation: selection.generation + 1 }, { ...selection, historyId: "other" }, { ...selection, sessionId: "other" },
    ]) {
      await expect(client.grant("control", true, bad)).rejects.toThrow();
    }
    await client.grant("control", true, selection);
    let sequence = 0;
    for (const bad of [{ ...selection, generation: selection.generation + 1 }, { ...selection, historyId: "other" },
      { ...selection, sessionId: "other" }, { ...selection, epoch: "old" }]) {
      expect(await client.input(bad, input, ++sequence)).toMatchObject({ receipt: { kind: "error", code: "stale_selection" } });
      expect(await client.cancel(bad, ++sequence)).toMatchObject({ receipt: { kind: "error", code: "stale_selection" } });
    }
    state.workers[0]!.native.sessionId = "native-replaced";
    expect(await client.input(selection, input, ++sequence)).toMatchObject({ receipt: { kind: "error", code: "stale_selection" } });
    state.workers[0]!.native.sessionId = selection.sessionId;
    const teamSelection = (await client.detail(state.workers[1]!.instanceId)).controls.selection!;
    retireTeamEvaluation(state.team);
    expect(await client.cancel(teamSelection, ++sequence)).toMatchObject({ receipt: { kind: "error" } });
    expect(state.effects()).toBe(0);
    // Hold the own() preparation microtask: retirement after the call but before its native admission must reject.
    state.retireBeforeAdmission();
    expect(await client.input(selection, input, ++sequence)).toMatchObject({ receipt: { kind: "error", code: "stale_owner" } });
    expect(state.effects()).toBe(0);
  })));

test("default startup ceiling cannot be elevated even with a valid current selection", fixture.ownedCase("control ceiling", () =>
  controls(async state => {
    const client = await state.peer(), selection = (await client.detail(state.workers[0]!.instanceId)).controls.selection!;
    await expect(client.grant("control", true, selection)).rejects.toMatchObject({ code: "forbidden" });
    await expect(client.input(selection, input, 1)).rejects.toMatchObject({ code: "forbidden" });
    await expect(client.cancel(selection, 1)).rejects.toMatchObject({ code: "forbidden" });
    expect(state.effects()).toBe(0);
  }, [])));

test("disconnected pending operations protect leases from idle expiry, but settled idle leases cannot authorize replay", fixture.ownedCase("control expiry", () =>
  controls(async state => {
    let client = await state.peer();
    const selection = (await client.detail(state.workers[0]!.instanceId)).controls.selection!;
    await client.grant("control", true, selection);
    state.hold();
    const lost = client.input(selection, input, 1).catch(error => error);
    await state.entered.promise;
    const resume = client.lease; await client.disconnect(); await lost; await state.disconnected(1);
    const now = Date.now();
    setSystemTime(now + 6 * 60_000);
    try {
      client = await state.peer(resume); expect((await client.requestStatus(1)).state).toBe("pending");
      state.gate.resolve();
      while ((await client.requestStatus(1)).state === "pending") await new Promise<void>(resolve => setImmediate(resolve));
      await client.disconnect(); await state.disconnected(2);
      setSystemTime(now + 12 * 60_000);
      await expect(state.peer(resume)).rejects.toMatchObject({ code: "lease_expired" });
      expect(state.effects()).toBe(1);
    } finally { setSystemTime(); }
  })));
