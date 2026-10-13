import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { createAgentController } from "../extensions/agent/controller.ts";
import { createAgentBridge } from "../extensions/agent/bridge/broker.ts";
import { connect, type BridgeClient } from "../extensions/agent/bridge/client.js";
import { bindBackgroundOwner, clearBackgroundOwner, spawnBackground, workerResult } from "../extensions/agent/background.ts";
import { createLiveHandle } from "../extensions/agent/live.ts";
import { clearObservations } from "../extensions/agent/observe.ts";
import { frame, frames } from "../extensions/agent/framing.js";
import { version, type Descriptor, type Reply } from "../extensions/agent/bridge/protocol.js";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import type { Attempt } from "../extensions/agent/run.ts";

const fixture = agentFixtureOwnership();
afterEach(() => { fixture.requireReleasedFixture(); clearBackgroundOwner(); clearObservations(); setSystemTime(); });
const completed: Attempt = { status: "completed", result: "fixture done", sideEffects: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
async function owned(body: (state: {
  worker: string; controller: ReturnType<typeof createAgentController>; effects(): number; signal(): AbortSignal;
  peer(resume?: BridgeClient["lease"]): Promise<BridgeClient>; wire(method: string, params?: Record<string, unknown>): Promise<Reply>;
  finish(): Promise<void>; disconnects(): Promise<void>;
}) => Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-bridge-ro-"));
  fixture.directories.push(root);
  const config = path.join(root, "config.toml");
  writeFileSync(config, '[model_policies.researcher.primary]\nmodel = "fixture/local"\nreasoning = "off"\n');
  const owner = { sessionId: "read-only-owner", token: Symbol() }, settled = deferred<void>();
  bindBackgroundOwner({ token: owner.token, hasUI: false, isIdle() { settled.resolve(); return true; }, notify() {}, sendMessage() {} });
  const controller = createAgentController(owner, () => owner);
  const bridgeRoot = path.join(root, "b"); mkdirSync(bridgeRoot, { mode: 0o700 });
  const bridge = createAgentBridge(controller, bridgeRoot, () => true), clients: BridgeClient[] = [];
  const finish = deferred<Attempt>(), started = deferred<void>();
  fixture.finishOnCleanup(() => finish.resolve(completed));
  let effects = 0, signal!: AbortSignal;
  const worker = await spawnBackground({ roleId: "researcher", task: "original", cwd: root,
    load: { userConfigPath: config, env: { PI_CODING_AGENT_DIR: root } },
    historyOrigin: { source: "agent_spawn", coordinatorSessionId: owner.sessionId, workbrief: "original" },
    executor: { capturesHistory: true, async start(input) {
      signal = input.signal;
      const history = input.history!.admit(input.instanceId, input.role.id, input.target), manager = history.create();
      const live = createLiveHandle({ sessionId: manager.getSessionId(), sessionManager: manager,
        sessionFile: manager.getSessionFile(), async steer() { effects++; return "handled"; } }, history);
      live.open(); const unbind = input.bindLive!(live.handle); started.resolve();
      const outcome = await fixture.acquire(finish.promise);
      return { ...outcome, session: { async continueWith() { throw Error("unexpected continuation"); },
        async dispose() { await live.settle(); await live.handle.close(); unbind(); history.result(outcome); history.disposition(); } } };
    } } });
  await started.promise; await bridge.ready;
  const descriptor: Descriptor = JSON.parse(readFileSync(path.join(bridgeRoot, "descriptor.json"), "utf8"));
  const socket = net.connect(descriptor.socket), closed = new Promise<void>(resolve => socket.once("close", resolve));
  socket.on("error", () => {});
  let reply: ((value: Reply) => void) | undefined, sequence = 0;
  socket.on("data", frames(value => { const accept = reply; reply = undefined; accept?.(value as Reply); }));
  const wire = (method: string, params: Record<string, unknown> = {}) => new Promise<Reply>(resolve => {
    reply = resolve;
    socket.write(frame({ version, id: String(++sequence), clientId: "raw", owner: descriptor.owner, method, params }));
  });
  try {
    expect(await wire("connect", { token: descriptor.token, expectedSessionId: owner.sessionId })).toMatchObject({ ok: true });
    await body({ worker: worker.instanceId, controller, effects: () => effects, signal: () => signal, wire,
      async peer(resume) { const client = await connect(path.join(bridgeRoot, "descriptor.json"), { expectedSessionId: owner.sessionId, resume });
        clients.push(client); return client; },
      async finish() { finish.resolve(completed); await settled.promise; },
      async disconnects() {
        await Promise.all(clients.map(client => client.disconnect()));
        // A server reply on a remaining socket orders this after its prior close callbacks.
        await wire("workers.list");
      },
    });
  } finally {
    finish.resolve(completed); socket.destroy(); await closed;
    await Promise.all(clients.map(client => client.disconnect()));
    bridge.revoke(); controller.revoke(); await bridge.settle(); await controller.settle();
  }
}

test("removed wire methods cannot steer, cancel or alter worker results; ordinary control remains guarded and functional",
  fixture.ownedCase("read-only boundary", () => owned(async state => {
    const client = await state.peer();
    for (const method of ["grant", "input", "cancel", "requestStatus"]) expect(client).not.toHaveProperty(method);
    const detail = await client.detail(state.worker);
    expect(detail).not.toHaveProperty("controls");
    const screen = state.controller.openView(), readOnly = state.controller.openView({ control: false, policy: "bridge-read" });
    try {
      const selection = screen.detail(state.worker).controls.selection!;
      for (const method of ["input", "cancel", "request.status", "view.grant"]) {
        expect(await state.wire(method, { sequence: 1, selection, input: { intent: "steer", text: "do not execute" } }))
          .toMatchObject({ ok: false, error: { code: "unsupported_method" } });
      }
      await expect(readOnly.input(selection, { intent: "query", text: "denied" })).rejects.toThrow("forbidden");
      expect(() => readOnly.cancel(selection)).toThrow("forbidden");
      await readOnly.close(); await client.disconnect();
      expect(state.effects()).toBe(0); expect(state.signal().aborted).toBe(false);
      for (const bad of [{ ...selection, epoch: "old" }, { ...selection, generation: selection.generation + 1 },
        { ...selection, sessionId: "foreign" }, { ...selection, historyId: "foreign" }]) {
        await expect(screen.input(bad, { intent: "query", text: "denied" })).rejects.toThrow();
        expect(() => screen.cancel(bad)).toThrow();
      }
      expect(state.effects()).toBe(0);
      await screen.input(selection, { intent: "steer", text: "ordinary coordinator input" });
      expect(state.effects()).toBe(1); expect(state.signal().aborted).toBe(false);
      await state.finish();
      const resumed = await state.peer(client.lease);
      expect((await resumed.result((await resumed.detail(state.worker)).ref)).state).toBe("ready");
      expect(workerResult(state.worker).result).toBe("fixture done");
    } finally { await screen.close(); await readOnly.close(); }
  })));

test("read-only connections retain bounded authenticated resume leases and reject expired tokens",
  fixture.ownedCase("read leases", () => owned(async state => {
    let client = await state.peer();
    const resume = client.lease;
    await client.disconnect(); await state.disconnects();
    client = await state.peer(resume);
    expect((await client.list()).items.map(item => item.id)).toContain(state.worker);
    expect(client.lease).not.toHaveProperty("highWater");
    await expect(state.peer({ ...resume, resumeToken: "0".repeat(64) })).rejects.toMatchObject({ code: "lease_expired" });
    await state.disconnects();
    setSystemTime(Date.now() + 6 * 60_000);
    await expect(state.peer(resume)).rejects.toMatchObject({ code: "lease_expired" });
    expect(state.effects()).toBe(0); expect(state.signal().aborted).toBe(false);
    setSystemTime();
  })));
