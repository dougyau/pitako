import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentController } from "../extensions/agent/controller.ts";
import { clearObservations, publishObservation } from "../extensions/agent/observe.ts";
import { createAgentBridge } from "../extensions/agent/bridge/broker.ts";
import { connect } from "../extensions/agent/bridge/client.js";
import { frame, frames, frameBytes } from "../extensions/agent/framing.js";
import { frame as paneFrame, frames as paneFrames } from "../extensions/herdr/agents-ui/protocol.ts";
import { capabilities, failure, isDescriptor, isRequest, isReply, replyBytes, type Descriptor, type Envelope } from "../extensions/agent/bridge/protocol.js";

async function ownedBridge(run: (fixture: {
  root: string; descriptor: Descriptor; file: string; controller: ReturnType<typeof createAgentController>;
  bridge: ReturnType<typeof createAgentBridge>; wire: () => ReturnType<typeof rawClient>;
  client: () => ReturnType<typeof connect>;
}) => Promise<void>, sessionId = "owner") {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-bridge-transport-"));
  chmodSync(root, 0o700);
  const owner = { sessionId, token: Symbol() };
  const controller = createAgentController(owner, () => owner);
  const bridge = createAgentBridge(controller, root, () => true);
  const wires: ReturnType<typeof rawClient>[] = [], clients: Awaited<ReturnType<typeof connect>>[] = [];
  try {
    await bridge.ready;
    const file = path.join(root, "descriptor.json");
    const descriptor: Descriptor = JSON.parse(readFileSync(file, "utf8"));
    await run({ root, file, descriptor, controller, bridge, wire() {
      const peer = rawClient(descriptor); wires.push(peer); return peer;
    }, async client() {
      const peer = await connect(file, { expectedSessionId: sessionId }); clients.push(peer); return peer;
    } });
  } finally {
    await Promise.all(clients.map(client => client.disconnect()));
    await Promise.all(wires.map(peer => peer.close()));
    bridge.revoke(); controller.revoke();
    await bridge.settle(); await controller.settle();
    clearObservations();
    // Do not release any root if owned closure/settlement above failed.
    rmSync(root, { recursive: true });
  }
}
function rawClient(descriptor: Descriptor) {
  const socket = net.connect(descriptor.socket);
  socket.on("error", () => {});
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  const replies: unknown[] = [];
  let receive: ((reply: unknown) => void) | undefined;
  socket.on("data", frames(reply => { if (receive) { const call = receive; receive = undefined; call(reply); } else replies.push(reply); },
    { label: "Agent bridge", fatalUtf8: true }));
  let sequence = 0;
  const envelope = (method: string, params: Record<string, unknown> = {}): Envelope =>
    ({ version: 2, id: String(++sequence), clientId: "raw", owner: descriptor.owner, method, params });
  const next = () => replies.length ? Promise.resolve(replies.shift()) :
    new Promise<unknown>(resolve => { receive = resolve; });
  return { socket, closed, envelope, next,
    async request(value: Envelope) { const reply = next(); socket.write(frame(value)); return reply; },
    async authenticate() { return this.request(envelope("connect", { token: descriptor.token,
      expectedSessionId: descriptor.owner.coordinatorSessionId })); },
    async close() { socket.destroy(); await closed; } };
}
function row(id: string, session = "owner", selectedModel = "fixture/local") {
  publishObservation({ id, roleId: "researcher", task: 'metadata "漢字\u2028\u2029"'.repeat(10), selectedModel,
    status: "completed", phase: "working", lastActivityKind: "model", acceptedAt: 1, terminalAt: 2,
    origin: { source: "agent_run", coordinatorSessionId: session, workbrief: "not ordinary read metadata" } });
}

test("shared and re-exported pane framing preserve LF-only records, byte bounds and synchronous callbacks", () => {
  for (const [encode, parse] of [[frame, frames], [paneFrame, paneFrames]] as const) {
    const values: unknown[] = [], receive = parse(value => values.push(value));
    const first = { text: '漢字\u2028\u2029\n😀"\\' };
    expect(encode(first)).toBe(JSON.stringify(first) + "\n");
    const bytes = Buffer.from(encode(first) + encode({ text: "other" }));
    const split = bytes.indexOf(Buffer.from("漢")) + 1;
    receive(bytes.subarray(0, split)); receive(bytes.subarray(split, split + 1));
    expect(values).toEqual([]);
    receive(bytes.subarray(split + 1));
    expect(values).toEqual([first, { text: "other" }]);
    const exact = encode("x".repeat(frameBytes - 3));
    expect(Buffer.byteLength(exact)).toBe(65536);
    receive(Buffer.from(exact).subarray(0, -1)); receive(Buffer.from("\n"));
    expect(values.at(-1)).toBe("x".repeat(frameBytes - 3));
    expect(() => encode("x".repeat(frameBytes - 2))).toThrow("Agent pane frame exceeds 64KiB");
    const pending = parse(() => {});
    pending(Buffer.alloc(frameBytes, 32));
    expect(() => pending(Buffer.from("\n"))).toThrow("Agent pane frame exceeds 64KiB");
    expect(() => parse(() => {})(Buffer.alloc(frameBytes + 1, 32))).toThrow("Agent pane frame exceeds 64KiB");
    for (const invalid of ["{broken}\n", "\n", " \n"])
      expect(() => parse(() => {})(Buffer.from(invalid))).toThrow(SyntaxError);
    const ordered: unknown[] = [];
    const reentrant = parse(value => {
      ordered.push(value);
      if (value === 1) reentrant(Buffer.from("2\n"));
    });
    reentrant(Buffer.from("1\n3\n"));
    expect(ordered).toEqual([1, 2, 3]);
    const callbackError = Error("callback error");
    const throwing = parse(() => { throw callbackError; });
    expect(() => throwing(Buffer.from("1\n"))).toThrow(callbackError);
    expect(() => throwing(Buffer.from("2\n"))).toThrow(callbackError);
  }
});

test("pane replacement decoding and BOM rejection differ deliberately from fatal bridge decoding", () => {
  const invalidUtf8 = Buffer.from([34, 0xff, 34, 10]), bom = Buffer.from('\ufeff"valid"\n');
  for (const parse of [frames, paneFrames]) {
    const values: unknown[] = [];
    parse(value => values.push(value))(invalidUtf8);
    expect(values).toEqual(["\ufffd"]);
    expect(() => parse(() => {})(bom)).toThrow(SyntaxError);
  }
  const strict = (receive: (value: unknown) => void) => frames(receive, { label: "Agent bridge", fatalUtf8: true });
  expect(() => strict(() => {})(invalidUtf8)).toThrow();
  const values: unknown[] = [];
  strict(value => values.push(value))(bom);
  expect(values).toEqual(["valid"]); // Preserve the provisional bridge TextDecoder's BOM behavior.
  expect(() => strict(() => {})(Buffer.alloc(frameBytes + 1))).toThrow("Agent bridge frame exceeds 64KiB");
  expect(() => frame("x".repeat(frameBytes - 2), "Agent bridge")).toThrow("Agent bridge frame exceeds 64KiB");
});

test("private ready descriptor and explicit connect have truthful default capabilities; auth/owner/method/selection never expose data", () =>
  ownedBridge(async ({ root, file, descriptor, client, wire }) => {
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(descriptor.socket).mode & 0o777).toBe(0o600);
    expect(isDescriptor(descriptor)).toBe(true);
    expect(descriptor.capabilities).toEqual(capabilities);
    expect(descriptor).not.toHaveProperty("grants");
    const peer = wire();
    const denied = await peer.request(peer.envelope("workers.list"));
    expect(denied).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    const wrongToken = await peer.request(peer.envelope("connect", { token: "0".repeat(64), expectedSessionId: "owner" }));
    expect(wrongToken).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    const forged = peer.envelope("connect", { token: descriptor.token, expectedSessionId: "owner" });
    forged.owner = { ...forged.owner, epoch: "old" };
    expect(await peer.request(forged)).toMatchObject({ ok: false, error: { code: "stale_owner" } });
    expect(await peer.authenticate()).toMatchObject({ ok: true, result: { capabilities } });
    for (const method of ["history.list", "history.read", "route.read", "view.grant", "control.cancel", "worker.detail", "workers.subscribe"]) {
      const reply = await peer.request(peer.envelope(method, { payload: "payload-not-to-echo", token: descriptor.token }));
      const code = ["history.list", "history.read", "route.read"].includes(method) ? "invalid_request" : "unsupported_method";
      expect(reply).toMatchObject({ ok: false, error: { code } });
      expect(JSON.stringify(reply)).not.toContain("payload-not-to-echo"); expect(JSON.stringify(reply)).not.toContain(descriptor.token);
    }
    expect(await peer.request(peer.envelope("workers.list", { selection: { epoch: "forged" } })))
      .toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await peer.request({ ...peer.envelope("workers.list"), clientId: "forged" }))
      .toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(await peer.request(peer.envelope("workers.list", { after: "unknown", revision: 0 })))
      .toMatchObject({ ok: false, error: { code: "invalid_cursor" } });
    await expect(connect(file, { expectedSessionId: "wrong-owner" })).rejects.toThrow("expected owner");
    await expect(connect(file, {} as never)).rejects.toThrow("explicit expected");
    const normal = await client();
    expect((await normal.list()).items).toEqual([]);
  }));

test("scoped retained terminal rows paginate truthfully under the smaller cap and complete escaped envelope cap; independent owners progress", () =>
  ownedBridge(async ({ descriptor, client }) => {
    for (let index = 0; index < 130; index++) row(`owned-${String(index).padStart(3, "0")}`);
    row("foreign", "other-owner");
    publishObservation({ id: "legacy", roleId: "researcher", task: "legacy", selectedModel: "fixture/local",
      status: "running", phase: "working", lastActivityKind: "start", acceptedAt: 1 });
    const peer = await client(), ids: string[] = [];
    let cursor: string | null = null, pages = 0, revision: number | undefined;
    do {
      const page = await peer.list(cursor ?? undefined, revision);
      revision = page.revision;
      expect(page.items.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThanOrEqual(30 * 1024);
      expect(Buffer.byteLength(JSON.stringify({ version: 2, id: '"'.repeat(128), clientId: '"'.repeat(128),
        owner: descriptor.owner, ok: true, result: page }) + "\n")).toBeLessThanOrEqual(replyBytes);
      for (const item of page.items) {
        expect(item.terminalAt).toBe(2); // retained long after footer linger, never a filter
        expect(item.source).toBe("agent_run"); expect(item.sdkRequest).toBeNull();
        ids.push(String(item.id));
      }
      pages++; cursor = page.cursor;
    } while (cursor);
    expect(pages).toBe(3); expect(ids).toHaveLength(130); expect(new Set(ids).size).toBe(130);
    await ownedBridge(async ({ client: secondClient }) => {
      const other = await secondClient();
      expect((await other.list()).items.map(item => String(item.id))).toEqual(["foreign"]);
      await peer.disconnect(); // view disconnect must not cancel/delete workers of either owner
      expect((await other.list()).items).toHaveLength(1);
    }, "other-owner");
  }));

test("malformed/oversized/wrong-version envelopes and more than eight simultaneous requests disconnect before leaking a reply", () =>
  ownedBridge(async ({ wire, descriptor }) => {
    for (const data of [Buffer.from("{invalid\n"), Buffer.alloc(frameBytes + 1, 32),
      Buffer.from([34, 0xff, 34, 10])]) {
      const peer = wire(); peer.socket.write(data); await peer.closed;
    }
    const invalidUtf8 = wire();
    const envelope = { ...invalidUtf8.envelope("connect", {
      token: descriptor.token, expectedSessionId: "owner",
    }), id: "\ufffd" };
    const encoded = Buffer.from(frame(envelope)), offset = encoded.indexOf(Buffer.from("\ufffd"));
    const malformed = Buffer.concat([encoded.subarray(0, offset), Buffer.from([0xff]), encoded.subarray(offset + 3)]);
    expect(isRequest(JSON.parse(malformed.toString("utf8")))).toBe(true); // Schema alone would admit replacement decoding.
    invalidUtf8.socket.write(malformed); await invalidUtf8.closed;
    const wrongVersion = wire();
    wrongVersion.socket.write(frame({ ...wrongVersion.envelope("workers.list"), version: 1 }));
    await wrongVersion.closed;
    const longId = wire();
    longId.socket.write(frame({ ...longId.envelope("workers.list"), id: "x".repeat(129) })); await longId.closed;
    const burst = wire(); await burst.authenticate();
    burst.socket.write(Array.from({ length: 9 }, () => frame(burst.envelope("workers.list"))).join(""));
    await burst.closed;
  }));

test("native client rejects invalid UTF-8 in otherwise schema-valid list metadata", async () => {
  const original = net.Socket.prototype.write;
  let mutated = 0;
  const capture = spyOn(net.Socket.prototype, "write").mockImplementation(function(this: net.Socket, ...args) {
    const data = args[0];
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    const marker = Buffer.from('"decoder-probe"'), offset = bytes.indexOf(marker);
    if (offset >= 0 && bytes.includes(Buffer.from('"ok":true'))) {
      const malformed = Buffer.concat([bytes.subarray(0, offset), Buffer.from([34, 0xff, 34]),
        bytes.subarray(offset + marker.length)]);
      expect(isReply(JSON.parse(malformed.toString("utf8")), "workers.list")).toBe(true);
      mutated++;
      return Reflect.apply(original, this, [malformed, ...args.slice(1)]);
    }
    return Reflect.apply(original, this, args);
  });
  try {
    await ownedBridge(async ({ client }) => {
      row("decoder-row", "owner", "decoder-probe");
      const peer = await client();
      await expect(peer.list()).rejects.toMatchObject({ code: "invalid_reply" });
      expect(mutated).toBe(1);
    });
  } finally { capture.mockRestore(); }
});

test("schema rejects unsupported requests and foreign/extra/malformed reply payloads", () => {
  const request: Envelope = { version: 2, id: "1", clientId: "client", owner: {
    processId: "process", coordinatorSessionId: "owner", epoch: "epoch" }, method: "workers.list", params: {} };
  expect(isRequest(request)).toBe(true);
  expect(isRequest({ ...request, params: { selection: {} } })).toBe(false);
  expect(isRequest({ ...request, method: "subscribe" })).toBe(true);
  expect(isRequest({ ...request, clientId: "x".repeat(129) })).toBe(false);
  for (const key of ["processId", "coordinatorSessionId", "epoch"])
    expect(isRequest({ ...request, owner: { ...request.owner, [key]: "x".repeat(1025) } })).toBe(false);
  expect(isReply(failure(request, "unauthorized"), "workers.list")).toBe(true);
  expect(isReply({ ...failure(request, "unauthorized"), error: { code: "unauthorized", message: "secret" } }, "workers.list")).toBe(false);
  expect(isReply({ version: 2, id: "1", clientId: "client", owner: request.owner, ok: true,
    result: { owner: { ...request.owner, epoch: "foreign" }, items: [], cursor: null } }, "workers.list")).toBe(false);
});

test("non-owned host directory is rejected before creating any socket or descriptor", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-bridge-owner-"));
  chmodSync(root, 0o700);
  const owner = { sessionId: "owner", token: Symbol() }, controller = createAgentController(owner, () => owner);
  const uid = process.getuid!();
  const identity = spyOn(process, "getuid").mockReturnValue(uid + 1);
  const bridge = createAgentBridge(controller, root, () => true);
  try {
    await expect(bridge.ready).rejects.toThrow("same-user");
    bridge.revoke(); await bridge.settle();
    expect(readdirSync(root)).toEqual([]);
  } finally {
    bridge.revoke(); await bridge.settle();
    identity.mockRestore(); controller.revoke(); await controller.settle();
    rmSync(root, { recursive: true });
  }
});

test("invalid/nonprivate/symlink/conflicting/too-long directories fail without repairing or deleting contents", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "pitako-bridge-roots-"));
  const owner = { sessionId: "owner", token: Symbol() }, controller = createAgentController(owner, () => owner);
  const roots = ["relative", path.join(parent, "missing"), path.join(parent, "public"), path.join(parent, "link"),
    path.join(parent, "conflict"), path.join(parent, "x".repeat(85))];
  mkdirSync(roots[2]!); chmodSync(roots[2]!, 0o755);
  mkdirSync(roots[4]!, { mode: 0o700 }); mkdirSync(roots[5]!, { mode: 0o700 });
  writeFileSync(path.join(roots[4]!, "unrelated"), "untouched");
  symlinkSync(roots[4]!, roots[3]!);
  try {
    for (const root of roots) {
      const bridge = createAgentBridge(controller, root, () => true);
      await expect(bridge.ready).rejects.toThrow();
      bridge.revoke(); await bridge.settle();
    }
    expect(readFileSync(path.join(roots[4]!, "unrelated"), "utf8")).toBe("untouched");
    expect(readdirSync(roots[4]!)).toEqual(["unrelated"]);
    expect(lstatSync(roots[2]!).mode & 0o777).toBe(0o755);
    expect(lstatSync(roots[3]!).isSymbolicLink()).toBe(true);
  } finally { controller.revoke(); await controller.settle(); rmSync(parent, { recursive: true }); }
});

test("a slow real stream is disconnected at the 256KiB queue ceiling, without truncating a legal page", async () => {
  let serverSocket: net.Socket | undefined, writes = 0, barrier: (() => void) | undefined;
  const original = net.Socket.prototype.write;
  const capture = spyOn(net.Socket.prototype, "write").mockImplementation(function(this: net.Socket, ...args) {
    try {
      const record = JSON.parse(args[0].toString());
      if (record.ok === true) {
        serverSocket = this;
        if (record.result?.items) { writes++; if (writes === 8) barrier?.(); }
      }
    } catch {}
    return Reflect.apply(original, this, args);
  });
  try {
    await ownedBridge(async ({ wire }) => {
      row("large-ordinary-metadata", "owner", "m".repeat(28_000));
      const peer = wire(); await peer.authenticate();
      expect(serverSocket).toBeDefined();
      serverSocket!.cork(); // owned, controllable stream backpressure; no timing sleeps
      const eightWrites = new Promise<void>(resolve => { barrier = resolve; });
      peer.socket.write(Array.from({ length: 8 }, () => frame(peer.envelope("workers.list"))).join(""));
      await eightWrites;
      expect(serverSocket!.writableLength).toBeLessThanOrEqual(256 * 1024);
      expect(serverSocket!.writableLength).toBeGreaterThan(200 * 1024);
      await new Promise<void>(resolve => setImmediate(resolve)); // settle the eight admitted requests
      peer.socket.write(Array.from({ length: 2 }, () => frame(peer.envelope("workers.list"))).join(""));
      await peer.closed;
      expect(serverSocket!.destroyed).toBe(true);
      expect(writes).toBe(9); // tenth would exceed queue; no partial JSON write
    });
  } finally { capture.mockRestore(); }
});

test("oversized single-row metadata returns an explicit failure, never a nonadvancing undefined cursor", () =>
  ownedBridge(async ({ client }) => {
    row("oversized-metadata", "owner", "m".repeat(31 * 1024));
    const peer = await client();
    await expect(peer.list()).rejects.toMatchObject({ code: "oversized" });
  }));

test("pending readiness is owned and revoke-before-await forbids a late descriptor", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-bridge-pending-"));
  chmodSync(root, 0o700);
  const owner = { sessionId: "owner", token: Symbol() }, controller = createAgentController(owner, () => owner);
  const open = controller.openView;
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  const capture = spyOn(controller, "openView").mockImplementation(() => {
    const view = open();
    return { ...view, async close() { started(); await held; await view.close(); } };
  });
  const bridge = createAgentBridge(controller, root, () => true);
  try {
    await entered; bridge.revoke(); controller.revoke();
    const settlement = bridge.settle();
    expect(readdirSync(root)).toEqual([]);
    release(); await settlement; await bridge.ready;
    expect(readdirSync(root)).toEqual([]);
  } finally {
    release(); bridge.revoke(); await bridge.settle(); controller.revoke(); await controller.settle();
    capture.mockRestore(); rmSync(root, { recursive: true });
  }
});

test("publication conflict after listen closes owned transport and preserves the unrelated descriptor", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-bridge-publish-"));
  chmodSync(root, 0o700);
  const file = path.join(root, "descriptor.json");
  const owner = { sessionId: "owner", token: Symbol() }, controller = createAgentController(owner, () => owner);
  const link = fs.linkSync;
  const conflict = spyOn(fs, "linkSync").mockImplementation((source, target) => {
    if (target === file) writeFileSync(file, "unrelated publication", { flag: "wx", mode: 0o600 });
    return link(source, target);
  });
  const bridge = createAgentBridge(controller, root, () => true);
  try {
    await expect(bridge.ready).rejects.toThrow("EEXIST");
    await bridge.settle();
    expect(readdirSync(root)).toEqual(["descriptor.json"]);
    expect(readFileSync(file, "utf8")).toBe("unrelated publication");
  } finally {
    bridge.revoke(); await bridge.settle(); controller.revoke(); await controller.settle();
    conflict.mockRestore();
    rmSync(root, { recursive: true });
  }
});

test("cleanup preserves replaced descriptor and refuses native close of a replaced socket; explicit restored-ownership settlement closes", () =>
  ownedBridge(async ({ file, descriptor, bridge, root }) => {
    const descriptorBackup = path.join(root, "host-descriptor");
    renameSync(file, descriptorBackup); writeFileSync(file, "unrelated descriptor", { mode: 0o600 });
    const socketBackup = path.join(root, "host-socket");
    linkSync(descriptor.socket, socketBackup);
    unlinkSync(descriptor.socket); writeFileSync(descriptor.socket, "unrelated socket");
    bridge.revoke();
    await expect(bridge.settle()).rejects.toThrow("ownership changed");
    expect(readFileSync(file, "utf8")).toBe("unrelated descriptor");
    expect(readFileSync(descriptor.socket, "utf8")).toBe("unrelated socket");
    // These replacements are owned by this fixture, not the production disposer.
    unlinkSync(descriptor.socket); linkSync(socketBackup, descriptor.socket); unlinkSync(socketBackup);
    await bridge.settle();
    expect(existsSync(descriptor.socket)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("unrelated descriptor");
    unlinkSync(file); unlinkSync(descriptorBackup);
  }));

test("pending wire is exact, owner-scoped, non-paginated and authenticates before reads", () =>
  ownedBridge(async ({ descriptor, wire, client, controller }) => {
    const peer = wire(), request = peer.envelope("background.pending");
    expect(isRequest(request)).toBe(true);
    for (const params of [{ count: true }, { ref: {} }, { cursor: "x" }, { subscribe: true }])
      expect(isRequest({ ...request, params })).toBe(false);
    for (const result of [{ state: "none" }, { state: "pending" },
      ...["unsupported", "stale_owner", "source_unavailable"].map(reason => ({ state: "unavailable", reason }))]) {
      const { method: _method, params: _params, ...envelope } = request;
      expect(isReply({ ...envelope, ok: true, result }, "background.pending")).toBe(true);
      expect(isReply({ ...envelope, ok: true, result: { ...result, count: 0 } }, "background.pending")).toBe(false);
    }
    expect(await peer.request(request)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    await peer.authenticate();
    expect(await peer.request({ ...peer.envelope("background.pending"), owner: { ...descriptor.owner, epoch: "old" } }))
      .toMatchObject({ ok: false, error: { code: "stale_owner" } });
    const normal = await client();
    controller.revoke();
    expect(await normal.backgroundPending()).toEqual({ state: "unavailable", reason: "stale_owner" });
    await expect(normal.list()).rejects.toMatchObject({ code: "stale_owner" });
  }));

test("exact known v2 capability snapshots agree at descriptor and connect; older producers receive no pending request", async () => {
  const original = net.Socket.prototype.write;
  for (const size of [13, 16]) {
    let pendingRequests = 0;
    const capture = spyOn(net.Socket.prototype, "write").mockImplementation(function(this: net.Socket, ...args) {
      const bytes = Buffer.from(args[0] as string).toString();
      let value: any;
      try { value = JSON.parse(bytes); } catch { return Reflect.apply(original, this, args); }
      if (value.owner?.coordinatorSessionId === "legacy-pending") {
        if (value.method === "background.pending") pendingRequests++;
        if (value.ok && value.result?.capabilities) return Reflect.apply(original, this,
          [frame({ ...value, result: { ...value.result, capabilities: capabilities.slice(0, size) } }), ...args.slice(1)]);
      }
      return Reflect.apply(original, this, args);
    });
    try {
      await ownedBridge(async ({ descriptor, file, client }) => {
        const older = { ...descriptor, capabilities: capabilities.slice(0, size) };
        writeFileSync(file, JSON.stringify(older));
        expect(isDescriptor(older)).toBe(true);
        const peer = await client();
        expect(peer.capabilities).toEqual(older.capabilities);
        expect(await peer.backgroundPending()).toEqual({ state: "unavailable", reason: "unsupported" });
        expect(await peer.backgroundPending()).toEqual({ state: "unavailable", reason: "unsupported" });
        expect(pendingRequests).toBe(0);
        expect((await peer.list()).items).toEqual([]);
      }, "legacy-pending");
    } finally { capture.mockRestore(); }
  }
  await ownedBridge(async ({ descriptor, file }) => {
    for (const list of [capabilities.slice(0, 14), capabilities.slice(0, 15), [...capabilities, "extension"],
      [...capabilities].reverse(), [...capabilities.slice(0, 16), "wrong.pending"]]) {
      expect(isDescriptor({ ...descriptor, capabilities: list })).toBe(false);
    }
    writeFileSync(file, JSON.stringify({ ...descriptor, capabilities: capabilities.slice(0, 16) }));
    await expect(connect(file, { expectedSessionId: "owner" })).rejects.toMatchObject({ code: "invalid_reply" });
  });
});

test("only backgroundPending maps auth, source, corrupt reply and transport failure to unavailable, never none", async () => {
  const original = net.Socket.prototype.write;
  for (const mode of ["unauthorized", "invalid_cursor", "corrupt", "unavailable"] as const) {
    let changed = 0;
    const capture = spyOn(net.Socket.prototype, "write").mockImplementation(function(this: net.Socket, ...args) {
      let value: any;
      try { value = JSON.parse(Buffer.from(args[0] as string).toString()); } catch { return Reflect.apply(original, this, args); }
      if (value.owner?.coordinatorSessionId === "pending-errors" && "ok" in value && !value.result?.capabilities) {
        changed++;
        const replacement = mode === "corrupt" ? { ...value, ok: true, error: undefined, result: { state: "none", count: 0 } }
          : mode === "unavailable" ? { ...value, ok: true, error: undefined, result: { state: "unavailable", reason: "source_unavailable" } }
          : failure(value, mode);
        return Reflect.apply(original, this, [frame(replacement), ...args.slice(1)]);
      }
      return Reflect.apply(original, this, args);
    });
    try {
      await ownedBridge(async ({ client }) => {
        const peer = await client();
        expect(await peer.backgroundPending()).toEqual({ state: "unavailable", reason: "source_unavailable" });
        expect(changed).toBe(1);
        if (mode === "unauthorized" || mode === "invalid_cursor") await expect(peer.list()).rejects.toMatchObject({ code: mode });
      }, "pending-errors");
    } finally { capture.mockRestore(); }
  }
  await ownedBridge(async ({ client }) => {
    const peer = await client(); await peer.disconnect();
    expect(await peer.backgroundPending()).toEqual({ state: "unavailable", reason: "source_unavailable" });
    await expect(peer.list()).rejects.toMatchObject({ code: "disconnected" });
  });
});
