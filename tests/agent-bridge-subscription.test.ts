import { expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as net from "node:net";
import { createAgentController } from "../extensions/agent/controller.ts";
import { createAgentBridge } from "../extensions/agent/bridge/broker.ts";
import { connect, type ChangeHint } from "../extensions/agent/bridge/client.js";
import { isNotification, isReply, isRequest, replyBytes } from "../extensions/agent/bridge/protocol.js";
import { clearObservations, noteHandoff, noteResultTaken, observationEpoch, publishObservation, removeObservation,
  touchObservation } from "../extensions/agent/observe.ts";
import { beginTeamEvaluation, retireTeamEvaluation } from "../extensions/team.ts";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function row(id: string, session = "owner", ownerToken?: symbol, teamOwnerToken?: symbol) {
  publishObservation({ id, roleId: "researcher", task: "ordinary", selectedModel: "fixture/local",
    status: "running", phase: "working", lastActivityKind: "model", acceptedAt: 1, ownerToken, teamOwnerToken,
    origin: { source: teamOwnerToken ? "team_assign" : "agent_spawn", coordinatorSessionId: session,
      ...(teamOwnerToken ? { assignmentId: "assignment" } : {}) } });
}
async function owned(run: (fixture: { controller: ReturnType<typeof createAgentController>;
  client: Awaited<ReturnType<typeof connect>>; file: string; token: symbol }) => Promise<void>, session = "owner") {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-bridge-subscription-"));
  chmodSync(root, 0o700);
  const owner = { sessionId: session, token: Symbol() };
  const controller = createAgentController(owner, () => owner);
  const bridge = createAgentBridge(controller, root, [], () => true);
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await bridge.ready;
    const file = path.join(root, "descriptor.json");
    client = await connect(file, { expectedSessionId: session });
    await run({ controller, client, file, token: owner.token });
  } finally {
    await client?.disconnect();
    bridge.revoke(); controller.revoke();
    await bridge.settle(); await controller.settle();
    clearObservations();
    rmSync(root, { recursive: true });
  }
}

test("atomic initial projection catches a boundary change; snapshots cannot mutate registry and stale pages require refresh", () =>
  owned(async ({ controller }) => {
    const view = controller.openView(), hints: number[] = [];
    for (let i = 0; i < 51; i++) row(`worker-${String(i).padStart(2, "0")}`);
    const list = view.list;
    const boundary = spyOn(view, "list").mockImplementation(() => {
      const snapshot = list();
      row("worker-after-snapshot");
      return snapshot;
    });
    const subscription = view.subscribe(revision => hints.push(revision));
    boundary.mockRestore();
    try {
      expect(subscription.snapshot.items).toHaveLength(50);
      expect(hints).toEqual([subscription.snapshot.revision + 1]);
      expect(() => view.list(subscription.snapshot.cursor!, subscription.snapshot.revision)).toThrow("stale_cursor");
      const fresh = view.list();
      fresh.items[0]!.task = "host mutation";
      expect(view.list().items[0]!.task).toBe("ordinary");
      const tail = view.list(fresh.cursor!, fresh.revision);
      expect(tail.items.map(item => item.id)).toContain("worker-after-snapshot");
      expect(tail.cursor).toBeNull();
    } finally { subscription.dispose(); await view.close(); }
  }));

test("only current owner/Team rows drive revisions; retained removal and consumption are visible, old epoch callbacks cannot revive", () =>
  owned(async ({ client, token }) => {
    const hints: ChangeHint[] = [];
    const subscription = await client.subscribe(hint => hints.push(hint));
    const evaluation = beginTeamEvaluation("owner", false)!;
    try {
      row("foreign", "other", token);
      row("wrong-token", "owner", Symbol());
      row("wrong-team", "owner", token, Symbol());
      publishObservation({ id: "legacy", roleId: "researcher", task: "legacy", selectedModel: "fixture/local",
        status: "running", phase: "working", lastActivityKind: "start", acceptedAt: 1 });
      await turn(); await client.list();
      expect(hints).toEqual([]);
      row("owned", "owner", token); row("team", "owner", token, evaluation.token);
      const first = await subscription.refresh();
      expect(first.items.map(item => item.id)).toEqual(["owned", "team"]);
      expect(first.revision).toBe(2);
      noteHandoff("owned", { collection: "collected", bookkeeping: "blocked", delivery: "incorporated",
        continuation: "requested", bookkeepingDiagnostic: "private diagnostic" });
      const retained = await subscription.refresh();
      expect(retained.items[0]?.handoff).toEqual({
        collection: "collected", bookkeeping: "blocked", delivery: "incorporated", continuation: "requested",
      });
      expect(retained.items[0]?.resultTaken).not.toBe(true);
      expect(retained.items[0]?.handoff).not.toHaveProperty("bookkeepingDiagnostic");
      noteResultTaken("owned"); removeObservation("owned");
      const second = await subscription.refresh();
      expect(second.items.map(item => item.id)).toEqual(["team"]);
      expect(second.revision).toBe(5);
      retireTeamEvaluation(evaluation);
      expect((await subscription.refresh()).items).toEqual([]);
      const captured = observationEpoch();
      clearObservations(); row("new", "owner", token);
      const current = await subscription.refresh();
      touchObservation("new", captured);
      expect((await subscription.refresh()).revision).toBe(current.revision);
    } finally { retireTeamEvaluation(evaluation); await subscription.dispose(); }
  }));

test("coalesced reply plus hint installs the native client listener synchronously; gaps are hints requiring refresh", async () => {
  const original = net.Socket.prototype.write;
  let prefix = "", notified!: () => void;
  const notification = new Promise<void>(resolve => { notified = resolve; });
  const capture = spyOn(net.Socket.prototype, "write").mockImplementation(function(this: net.Socket, ...args) {
    const data = args[0].toString();
    let record;
    try { record = JSON.parse(data); } catch {}
    if (record?.ok === true && record.result?.subscriptionId && record.result?.snapshot) {
      prefix = data;
      row("first"); row("second"); row("third");
      return true;
    }
    if (record?.method === "changed" && prefix) {
      args[0] = prefix + data; prefix = "";
    }
    return Reflect.apply(original, this, args);
  });
  try {
    await owned(async ({ client }) => {
      const hints: ChangeHint[] = [];
      const subscription = await client.subscribe(hint => { hints.push(hint); notified(); });
      await notification;
      expect(subscription.snapshot.items).toEqual([]);
      expect(subscription.snapshot.revision).toBe(0);
      expect(hints).toHaveLength(1);
      await expect(client.subscribe(() => {})).rejects.toMatchObject({ code: "busy" });
      expect(hints[0]).toMatchObject({ revision: 3, gap: true, refreshRequired: true });
      expect(Object.keys(hints[0]!).sort()).toEqual(
        ["clientId", "gap", "method", "owner", "refreshRequired", "revision", "subscriptionId", "version"]);
      expect((await subscription.refresh()).items).toHaveLength(3);
      await subscription.dispose(); await subscription.dispose();
      expect(subscription.active).toBe(false);
    });
  } finally { capture.mockRestore(); }
});

test("maximally escaped owner and cursor fit complete initial subscription pages; continuation is revision-bound", () => {
  const session = "\x01".repeat(1024);
  return owned(async ({ client, token }) => {
    for (let i = 0; i < 5; i++) {
      publishObservation({ id: "\x01".repeat(1023) + i, roleId: "researcher", task: "ordinary",
        selectedModel: "\x01".repeat(1800), status: "running", phase: "working",
        lastActivityKind: "model", acceptedAt: 1, ownerToken: token,
        origin: { source: "agent_spawn", coordinatorSessionId: session } });
    }
    const subscription = await client.subscribe(() => {});
    try {
      let snapshot = subscription.snapshot;
      expect(snapshot.cursor).not.toBeNull();
      const envelope = { version: 1, id: "\x01".repeat(128), clientId: "\x01".repeat(128), owner: client.owner,
        ok: true, result: { subscriptionId: subscription.subscriptionId, snapshot } };
      expect(Buffer.byteLength(JSON.stringify(envelope) + "\n")).toBeLessThanOrEqual(replyBytes);
      console.log("escaped initial subscription complete envelope bytes", Buffer.byteLength(JSON.stringify(envelope) + "\n"));
      const ids = snapshot.items.map(item => item.id);
      while (snapshot.cursor) {
        snapshot = await client.list(snapshot.cursor, snapshot.revision);
        expect(snapshot.items.length).toBeGreaterThan(0);
        ids.push(...snapshot.items.map(item => item.id));
      }
      expect(new Set(ids).size).toBe(5);
    } finally { await subscription.dispose(); }
  }, session);
});

test("malformed notification disconnects instead of exposing its foreign payload to a host listener", async () => {
  const original = net.Socket.prototype.write;
  const capture = spyOn(net.Socket.prototype, "write").mockImplementation(function(this: net.Socket, ...args) {
    let record;
    try { record = JSON.parse(args[0].toString()); } catch {}
    if (record?.method === "changed") args[0] = JSON.stringify({ ...record, transcript: "not-visible" }) + "\n";
    return Reflect.apply(original, this, args);
  });
  try {
    await owned(async ({ client }) => {
      let callbacks = 0;
      const subscription = await client.subscribe(() => { callbacks++; });
      row("worker");
      await turn(); await turn();
      const failure = await client.list().catch(error => error);
      expect(["invalid_reply", "disconnected"]).toContain(failure.code);
      expect(callbacks).toBe(0);
      expect(subscription.active).toBe(false);
      await subscription.dispose();
    });
  } finally { capture.mockRestore(); }
});

test("unsubscribe admission failure joins disconnect and settles every owned pending request", async () => {
  const original = net.Socket.prototype.write;
  let hold = false;
  const capture = spyOn(net.Socket.prototype, "write").mockImplementation(function(this: net.Socket, ...args) {
    let record;
    try { record = JSON.parse(args[0].toString()); } catch {}
    if (hold && record?.ok === true && record.result?.items) return true;
    return Reflect.apply(original, this, args);
  });
  try {
    await owned(async ({ client, file }) => {
      row("survivor");
      const subscription = await client.subscribe(() => {});
      hold = true;
      const pending = Array.from({ length: 8 }, () => client.list());
      const settlement = Promise.allSettled(pending);
      await expect(subscription.dispose()).rejects.toMatchObject({ code: "busy" });
      expect((await settlement).every(result => result.status === "rejected")).toBe(true);
      expect(subscription.active).toBe(false);
      hold = false;
      const fresh = await connect(file, { expectedSessionId: "owner" });
      try {
        const next = await fresh.subscribe(() => {});
        expect(next.snapshot.items.map(item => item.id)).toEqual(["survivor"]);
        await next.dispose();
      } finally { await fresh.disconnect(); }
    });
  } finally { capture.mockRestore(); }
});

test("slow subscribed stream disconnects at the same bounded queue without unbounded hint jobs", async () => {
  const original = net.Socket.prototype.write;
  let server: net.Socket | undefined, bytes = 0, writes = 0;
  const capture = spyOn(net.Socket.prototype, "write").mockImplementation(function(this: net.Socket, ...args) {
    let record;
    try { record = JSON.parse(args[0].toString()); } catch {}
    if (record?.ok === true && record.result?.capabilities) server = this;
    if (record?.method === "changed") {
      writes++; bytes = Math.max(bytes, this.writableLength + Buffer.byteLength(args[0].toString()));
      expect(Buffer.byteLength(args[0].toString())).toBeLessThanOrEqual(replyBytes);
    }
    return Reflect.apply(original, this, args);
  });
  const session = "\x01".repeat(1024);
  try {
    await owned(async ({ client, token }) => {
      const subscription = await client.subscribe(() => {});
      server!.cork();
      for (let i = 0; i < 60 && !server!.destroyed; i++) {
        row(String(i), session, token); await turn();
      }
      expect(server!.destroyed).toBe(true);
      expect(writes).toBeGreaterThan(1);
      expect(bytes).toBeLessThanOrEqual(256 * 1024);
      console.log("slow subscription bounded queue bytes and complete hint writes", bytes, writes);
      await client.disconnect(); await subscription.dispose();
    }, session);
  } finally { capture.mockRestore(); }
});

test("bounded subscriptions, repeated disposal, disconnect/reconnect and owner revoke release listeners without deleting workers", () =>
  owned(async ({ client, controller, file }) => {
    const views = Array.from({ length: 8 }, () => controller.openView());
    const listener = () => {};
    const subscriptions = views.map(view => view.subscribe(listener));
    try {
      await expect(client.subscribe(() => {})).rejects.toMatchObject({ code: "busy" });
      subscriptions[0]!.dispose();
      const replacement = views[0]!.subscribe(() => {});
      subscriptions[0]!.dispose(); // must not detach the replacement lease
      expect(() => views[0]!.subscribe(() => {})).toThrow("busy");
      replacement.dispose();
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
      await Promise.all(views.map(view => view.close()));
    }
    row("survivor");
    let callbacks = 0;
    const first = await client.subscribe(() => { callbacks++; });
    await client.disconnect();
    expect(first.active).toBe(false);
    touchObservation("survivor"); await turn();
    const reconnected = await connect(file, { expectedSessionId: "owner" });
    try {
      const second = await reconnected.subscribe(() => { callbacks++; });
      expect(second.subscriptionId).not.toBe(first.subscriptionId);
      expect(second.snapshot.items.map(item => item.id)).toEqual(["survivor"]);
      expect(callbacks).toBe(0); // no replay from the disconnected interval
      await second.dispose();
      const third = await reconnected.subscribe(() => { callbacks++; });
      row("queued-before-retirement");
      controller.revoke(); touchObservation("survivor");
      await first.dispose(); await third.dispose();
      expect(callbacks).toBe(0);
    } finally { await reconnected.disconnect(); }
  }));

test("v1 subscription shapes bound complete envelopes, reject malformed revisions and foreign fields", () => {
  const owner = { processId: '"'.repeat(1024), coordinatorSessionId: '"'.repeat(1024), epoch: '"'.repeat(1024) };
  const hint = { version: 1, method: "changed", owner, clientId: '"'.repeat(128),
    subscriptionId: '"'.repeat(128), revision: Number.MAX_SAFE_INTEGER, refreshRequired: true };
  expect(isNotification(hint)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(hint) + "\n")).toBeLessThan(replyBytes);
  for (const changed of [{ revision: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { transcript: "secret" },
    { subscriptionId: "x".repeat(129) }, { refreshRequired: false }])
    expect(isNotification({ ...hint, ...changed })).toBe(false);
  const request = { version: 1, id: '"'.repeat(128), clientId: '"'.repeat(128), owner, method: "subscribe", params: {} };
  expect(isRequest(request)).toBe(true);
  expect(isRequest({ ...request, params: { replay: true } })).toBe(false);
  const reply = { version: 1, id: request.id, clientId: request.clientId, owner, ok: true,
    result: { subscriptionId: hint.subscriptionId, snapshot: { revision: 0, owner, items: [], cursor: null } } };
  expect(isReply(reply, "subscribe")).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(reply) + "\n")).toBeLessThan(replyBytes);
  const item = { id: "worker", roleId: "developer", status: "failed", task: "ordinary",
    selectedModel: "fixture/local", sdkRequest: null, acceptedAt: 1, activity: "end", phase: "idle",
    resultTaken: false, handoff: {
      collection: "collected", bookkeeping: "blocked", delivery: "incorporated", continuation: "blocked-unconfirmed",
    } };
  const withItem = (value: unknown) => ({ ...reply,
    result: { ...reply.result, snapshot: { ...reply.result.snapshot, items: [value] } } });
  expect(isReply(withItem(item), "subscribe")).toBe(true);
  for (const changed of [{ collection: "uncollected" }, { bookkeeping: "accepted" }, { delivery: "preview" },
    { continuation: "processed" }, { result: "private text" }])
    expect(isReply(withItem({ ...item, handoff: { ...item.handoff, ...changed } }), "subscribe")).toBe(false);
  expect(isReply(withItem({ ...item, resultTaken: "yes" }), "subscribe")).toBe(false);
});
