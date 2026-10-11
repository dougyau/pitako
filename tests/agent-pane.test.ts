import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentController } from "../extensions/agent/controller.ts";
import { createAgentBroker } from "../extensions/herdr/agents-ui/broker.ts";
import { connectAgentPane } from "../extensions/herdr/agents-ui/client.ts";
import { readDescriptor } from "../extensions/herdr/agents-ui/descriptor.ts";
import { frame, frameBytes, frames, isOperation } from "../extensions/herdr/agents-ui/protocol.ts";
import { bindBackgroundOwner, clearBackgroundOwner, spawnBackground } from "../extensions/agent/background.ts";
import { createLiveHandle } from "../extensions/agent/live.ts";
import { clearObservations, publishObservation } from "../extensions/agent/observe.ts";
import { queryHistory } from "../extensions/agent/history-query.ts";
import { runAgentInstance, type Attempt } from "../extensions/agent/run.ts";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";

const fixture = agentFixtureOwnership();
const originalDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  fixture.requireReleasedFixture();
  clearBackgroundOwner(); clearObservations();
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalDir;
  for (const root of fixture.directories.splice(0)) rmSync(root, { recursive: true, force: true });
});
const completed: Attempt = { status: "completed", result: "done", sideEffects: false };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-pane-test-"));
  fixture.directories.push(root);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const config = path.join(root, "config.toml");
  writeFileSync(config, '[model_policies.researcher.primary]\nmodel = "fixture/selected"\nreasoning = "off"\n');
  const owner = { sessionId: "pane-owner", token: Symbol() };
  bindBackgroundOwner({ token: owner.token, isIdle: () => false, hasUI: false, notify() {}, sendMessage() {} });
  return { root, owner, controller: createAgentController(owner, () => owner),
    load: { userConfigPath: config, env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } } };
}

test("private IPC grants, per-view consent, scoped history and final native fences preserve independent progress", fixture.ownedCase("pane grants", async () => {
  const { root, owner, controller, load } = setup();
  const started = deferred<void>(), admitted = deferred<void>(), release = deferred<void>();
  fixture.finishOnCleanup(() => release.resolve());
  let finish!: (result: Attempt) => void, native!: { sessionId: string };
  const attempt = fixture.pendingAttempt(resolve => { finish = resolve; });
  let inputs = 0;
  const worker = await spawnBackground({ roleId: "researcher", task: "exact original", cwd: root, load,
    historyOrigin: { source: "agent_spawn", coordinatorSessionId: owner.sessionId, workbrief: "exact original" },
    executor: { capturesHistory: true, async start(input) {
      const history = input.history!.admit(input.instanceId, input.role.id, input.target), manager = history.create();
      const session = { sessionId: manager.getSessionId(), sessionManager: manager, sessionFile: manager.getSessionFile(),
        async steer() { inputs++; admitted.resolve(); await release.promise; return "queued" as const; } };
      native = session;
      const live = createLiveHandle(session, history); live.open();
      const unbind = input.bindLive!(live.handle); started.resolve();
      const result = await attempt; await live.settle(); await live.handle.close(); unbind();
      history.result(result); history.disposition(); return result;
    } } });
  await started.promise;
  const local = controller.openView(), selection = local.detail(worker.instanceId).controls.selection!;
  // Foreign native histories are real catalogued entries, not invented IDs.
  await runAgentInstance({ roleId: "researcher", task: "foreign", cwd: root, load,
    historyOrigin: { source: "agent_run", coordinatorSessionId: "foreign" },
    executor: { capturesHistory: true, async start(input) {
      const history = input.history!.admit(input.instanceId, input.role.id, input.target); history.create();
      history.result(completed); history.disposition(); return completed;
    } } });
  const foreign = (await queryHistory({ action: "list" }, "foreign")).items[0] as { historyId: string };
  const readOnly = await createAgentBroker(controller, { control: false, rawHistory: false }, root);
  const controlled = await createAgentBroker(controller, { control: true, rawHistory: true }, root);
  const a = await connectAgentPane(readOnly.descriptorPath), b = await connectAgentPane(controlled.descriptorPath),
    c = await connectAgentPane(controlled.descriptorPath);
  try {
    expect((await a.detail(worker.instanceId)).controls.available).toBe(false);
    await expect(a.input(selection, { intent: "query", text: "no grant" })).rejects.toThrow("read-only");
    await expect(a.cancel(selection)).rejects.toThrow("read-only");
    await expect(a.acknowledge("history")).rejects.toThrow("no raw-history");
    await expect(a.route(worker.instanceId)).rejects.toThrow("no raw-history");
    await expect(a.history({ action: "read", historyId: selection.historyId })).rejects.toThrow("no raw-history");
    await expect(b.route(worker.instanceId)).rejects.toThrow("acknowledgement");
    await b.acknowledge("route"); expect((await b.route(worker.instanceId)).text).toBe("null");
    await expect(c.route(worker.instanceId)).rejects.toThrow("acknowledgement");
    await b.acknowledge("history");
    expect((await b.history({ action: "read", historyId: foreign.historyId })).diagnostics.some(d => d.code === "history_outside_scope")).toBe(true);
    expect((await b.history({ action: "read", historyId: selection.historyId, cursor: "forged" })).diagnostics.some(d => d.code === "invalid_cursor")).toBe(true);
    await expect(b.input({ ...selection, generation: selection.generation + 1 }, { intent: "steer", text: "stale" })).rejects.toThrow("binding changed");
    expect(isOperation({ op: "input", selection, input: { intent: ["query"], text: "malformed" } })).toBe(false);
    native.sessionId = "replacement";
    await expect(b.input(selection, { intent: "query", text: "wrong native" })).rejects.toThrow("closed or stale");
    native.sessionId = selection.sessionId;
    expect(inputs).toBe(0);
    const input = b.input(selection, { intent: "query", text: "admitted" });
    const uncertain = input.catch(error => String(error));
    await admitted.promise;
    expect((await c.detail(worker.instanceId)).id).toBe(worker.instanceId); // independent read progresses
    await b.disconnect(); expect(await uncertain).toContain("Unknown mutation outcome");
    let closed = false;
    const closing = controlled.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); expect(existsSync(controlled.descriptorPath)).toBe(true);
    release.resolve(); await closing;
    expect(inputs).toBe(1); // close did not replay/cancel the admitted worker
    expect(() => local.detail(worker.instanceId)).not.toThrow(); // broker close does not revoke owner
    await expect(b.reconnect!()).rejects.toThrow();
  } finally {
    release.resolve(); finish(completed);
    await Promise.all([a.close(), b.close(), c.close(), local.close()]);
    await readOnly.close(); await controlled.close();
    controller.revoke(); await controller.settle();
  }
}));

test("cross-binding, forged authority and bounded frames are rejected before effects; descriptors fail closed", fixture.ownedCase("pane framing", async () => {
  const { root, controller, owner } = setup();
  publishObservation({ id: "owned", roleId: "researcher", task: "scoped", status: "completed", phase: "idle", acceptedAt: 1,
    lastActivityKind: "start", selectedModel: "fixture/selected", origin: { source: "agent_run", coordinatorSessionId: owner.sessionId } });
  const foreignOwner = { sessionId: "another", token: Symbol() }, foreign = createAgentController(foreignOwner, () => foreignOwner);
  const one = await createAgentBroker(controller, { control: false, rawHistory: false }, root);
  const two = await createAgentBroker(foreign, { control: false, rawHistory: false }, root);
  const descriptor = await readDescriptor(one.descriptorPath), other = await readDescriptor(two.descriptorPath);
  const invalid = async (value: unknown, raw = false) => {
    const socket = createConnection(descriptor.socket);
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const chunks: Buffer[] = [];
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const done = new Promise<void>(resolve => socket.once("close", resolve));
    socket.write(raw ? String(value) : frame(value));
    await done; expect(chunks).toHaveLength(0);
  };
  const request = { version: 1, id: 1, capability: descriptor.capability, owner: descriptor.owner, operation: { op: "list" } };
  try {
    for (const bad of [{ ...request, version: 2 }, { ...request, capability: other.capability }, { ...request, owner: other.owner },
      { ...request, operation: { op: "list", control: true } }, { ...request, operation: { op: "acknowledge", kind: ["history"] } },
      { ...request, operation: { op: "history", query: { action: "read", historyId: "x", source: "coordinator" } } }])
      await invalid(bad);
    await invalid("x".repeat(frameBytes + 1), true);
    await invalid("{broken}\n", true);
    expect(isOperation({ op: "input", selection: {}, input: { intent: "query", text: "x".repeat(16 * 1024 + 1) } })).toBe(false);
    const parser = frames(() => {}); expect(() => parser(Buffer.alloc(frameBytes + 1))).toThrow("64KiB");
    const a = await connectAgentPane(one.descriptorPath), b = await connectAgentPane(two.descriptorPath);
    expect((await a.list()).items.map(row => row.id)).toEqual(["owned"]);
    expect((await b.list()).items).toEqual([]);
    await expect(b.detail("owned")).rejects.toThrow("unknown scoped worker");
    await a.close(); await b.close();
    chmodSync(one.descriptorPath, 0o644); await expect(readDescriptor(one.descriptorPath)).rejects.toThrow("private");
    chmodSync(one.descriptorPath, 0o600);
    writeFileSync(one.descriptorPath, JSON.stringify({ ...descriptor, socket: other.socket }));
    await expect(readDescriptor(one.descriptorPath)).rejects.toThrow("Unsupported");
    controller.revoke(); one.revoke();
    writeFileSync(one.descriptorPath, JSON.stringify(descriptor));
    await expect(connectAgentPane(one.descriptorPath)).rejects.toThrow();
  } finally {
    controller.revoke(); foreign.revoke(); await controller.settle(); await foreign.settle();
    await one.close(); await two.close();
  }
}));
