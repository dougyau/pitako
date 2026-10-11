import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { createAgentController } from "../extensions/agent/controller.ts";
import { createAgentBridge } from "../extensions/agent/bridge/broker.ts";
import { connect } from "../extensions/agent/bridge/client.js";
import { isRequest, isReply, replyBytes, capabilities, type Envelope, type Owner, type Grant } from "../extensions/agent/bridge/protocol.js";
import { publishObservation, clearObservations } from "../extensions/agent/observe.ts";
import type { RoutingRecord } from "../extensions/agent/routing.ts";
import * as historyModule from "../extensions/agent/history-query.ts";
import type { HistoryGroup, HistoryMember } from "../extensions/agent/history.ts";

const nativeBytes = Buffer.concat([
  Buffer.from(JSON.stringify({ type: "message", data: "\u0001\"\\🦀".repeat(20_000) }) + "\n"),
  Buffer.from('{"limited":' + "1".repeat(1000) + "}\n"),
  Buffer.from('{"corrupt":}\n{"unterminated":'),
  Buffer.from([0xff, 0xfe]),
]);
const route: RoutingRecord = {
  version: 1, rubricVersion: 1, dispatchId: "fixture-dispatch", adviceId: "fixture-advice", toolCallId: "fixture-call",
  source: "deterministic-test-not-an-invocation", taskReference: { toolCallId: "fixture-call", field: "task" },
  profile: "developer_mid", reason: "\u0001\"\\🦀".repeat(1500),
  resolvedPolicy: { id: "deterministic-no-model", fallbacks: [] },
};

// Only catalog and physical files are synthetic. These checks exercise the real scoped controller and socket broker.
async function owned(grants: Grant[], body: (value: {
  controller: ReturnType<typeof createAgentController>; descriptor: string; owner: Owner;
  groupId: string; historyId: string; foreignId: string; catalogFile: string;
  client(): ReturnType<typeof connect>;
}) => Promise<void>, maximalOwner = false) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-bridge-history-"));
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const owner = { sessionId: maximalOwner ? "\u0001".repeat(1024) : "owned-coordinator", token: Symbol() };
  const controller = createAgentController(owner, () => owner);
  const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
  let bridge: ReturnType<typeof createAgentBridge> | undefined;
  try {
    const groupId = randomUUID(), historyId = randomUUID(), foreignId = randomUUID();
    const directory = path.join(process.env.PI_CODING_AGENT_DIR!, "pitako", "worker-history");
    mkdirSync(path.join(directory, "sessions"), { recursive: true });
    const seed = (id: string, coordinatorSessionId: string, instanceId: string, native: HistoryMember["native"]): HistoryMember => {
      return { historyId: id, roleId: "researcher", coordinatorSessionId, instanceId,
        admittedAt: new Date(0).toISOString(), native, gaps: [] };
    };
    const nativeFile = path.join(directory, "sessions", "owned.jsonl");
    writeFileSync(nativeFile, nativeBytes);
    const member = seed(historyId, owner.sessionId, "owned", { state: "allocated", path: nativeFile,
      sessionId: "native-session", disposition: { state: "disposed", at: new Date(0).toISOString() } });
    const group: HistoryGroup = { version: 1, groupId, workspace: root, coverage: "complete",
      identity: { kind: "invocation", invocationId: "deterministic" }, closure: { state: "unclosed" },
      members: [member, seed(foreignId, "foreign-coordinator", "foreign", { state: "not-created" })] };
    const catalogFile = path.join(directory, groupId + ".json");
    writeFileSync(catalogFile, JSON.stringify(group));
    for (const [id, parent] of [["owned", owner.sessionId], ["foreign", "foreign-coordinator"]]) {
      publishObservation({ id: id!, roleId: "researcher", task: "deterministic", selectedModel: "deterministic",
        status: "completed", phase: "idle", acceptedAt: 1, lastActivityKind: "start",
        origin: { source: "agent_run", coordinatorSessionId: parent!, routing: route } });
    }
    // Legal maximum protocol identities/correlation, not a native-host identity claim.
    const maximalEpoch: ReturnType<typeof randomUUID> =
      `${"\u0001".repeat(200)}-${"\u0001".repeat(200)}-${"\u0001".repeat(200)}-${"\u0001".repeat(200)}-${"\u0001".repeat(220)}`;
    const brokerController = maximalOwner ? { ...controller, openView() {
      const view = controller.openView();
      return { ...view, list(...args: Parameters<typeof view.list>) {
        return { ...view.list(...args), owner: { processId: "\u0001".repeat(1024), epoch: maximalEpoch,
          coordinatorSessionId: owner.sessionId } };
      } };
    } } : controller;
    const bridgeRoot = path.join(root, "bridge");
    mkdirSync(bridgeRoot, { mode: 0o700 });
    bridge = createAgentBridge(brokerController, bridgeRoot, grants, () => true);
    await bridge.ready;
    const descriptor = path.join(bridgeRoot, "descriptor.json");
    const discovery = JSON.parse(readFileSync(descriptor, "utf8"));
    await body({ controller, descriptor, owner: discovery.owner, groupId, historyId, foreignId,
      catalogFile,
      async client() { const client = await connect(descriptor, { expectedSessionId: owner.sessionId }); clients.push(client); return client; } });
    expect(JSON.parse(readFileSync(catalogFile, "utf8"))).toEqual(group);
    expect(readFileSync(nativeFile)).toEqual(nativeBytes);
  } finally {
    await Promise.all(clients.map(client => client.disconnect()));
    bridge?.revoke(); controller.revoke(); await Promise.all([bridge?.settle(), controller.settle()]);
    clearObservations();
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalDir;
    rmSync(root, { recursive: true, force: true });
  }
}

test("startup ceiling is immutable; explicit sensitive acknowledgements cannot activate control or elevate", () => {
  const ceilings: Grant[] = ["control"];
  return owned(ceilings, async ({ client, historyId }) => {
    ceilings.push("history", "route");
    const view = await client();
    expect((await view.historyList()).items).toHaveLength(1);
    await expect(view.historyRead({ historyId })).rejects.toMatchObject({ code: "forbidden" });
    await expect(view.routeRead("owned")).rejects.toMatchObject({ code: "forbidden" });
    await expect(view.grant("history", true)).rejects.toMatchObject({ code: "forbidden" });
    await expect(view.grant("route", true)).rejects.toMatchObject({ code: "forbidden" });
    await expect(Reflect.apply(view.grant, view, ["control", true])).rejects.toMatchObject({ code: "invalid_request" });
    expect(capabilities).toContain("input");
    expect(capabilities).toContain("request.status");
  });
});

test("acknowledgements are per fresh view and grant; foreign references/scopes/cursors remain rejected", () =>
  owned(["history", "route"], async ({ client, historyId, foreignId, groupId, controller }) => {
    const first = await client(), independent = await client();
    await expect(Reflect.apply(first.grant, first, ["history"])).rejects.toMatchObject({ code: "invalid_request" });
    await expect(Reflect.apply(first.grant, first, ["history", false])).rejects.toMatchObject({ code: "invalid_request" });
    await first.grant("route", true);
    await expect(first.historyRead({ historyId })).rejects.toMatchObject({ code: "forbidden" });
    await first.grant("history", true);
    expect((await first.historyRead({ historyId, limit: 1 })).items).toHaveLength(1);
    await expect(independent.historyRead({ historyId })).rejects.toMatchObject({ code: "forbidden" });
    await expect(independent.routeRead("owned")).rejects.toMatchObject({ code: "forbidden" });
    await expect(first.historyList({ workerId: "foreign" })).rejects.toMatchObject({ code: "unknown_target" });
    await expect(first.routeRead("foreign")).rejects.toMatchObject({ code: "unknown_target" });
    const foreign = await first.historyRead({ historyId: foreignId, groupId });
    expect(foreign).toMatchObject({ items: [], cursor: null, diagnostics: [{ code: "history_outside_scope" }] });
    const source = await first.historyRead({ historyId, limit: 1 });
    const differentScope = await first.historyRead({ historyId, workerId: "owned", cursor: source.cursor! });
    expect(differentScope).toMatchObject({ items: [], diagnostics: [{ code: "invalid_cursor" }] });
    for (const params of [{ scope: "all" }, { coordinatorSessionId: "foreign" }, { source: "coordinator" },
      { directory: "/tmp" }, { historyId: "/tmp/private" }, { limit: 201 }, { cursor: "x".repeat(2049) }]) {
      await expect(Reflect.apply(first.historyList, first, [params])).rejects.toMatchObject({ code: "invalid_request" });
    }
    await first.disconnect();
    const reconnected = await client();
    await expect(reconnected.historyRead({ historyId, cursor: source.cursor! })).rejects.toMatchObject({ code: "forbidden" });
    await expect(reconnected.routeRead("owned")).rejects.toMatchObject({ code: "forbidden" });
    await reconnected.grant("history", true);
    expect((await reconnected.historyRead({ historyId, cursor: source.cursor! })).items.length).toBeGreaterThan(0);
    controller.revoke();
    await expect(reconnected.historyRead({ historyId })).rejects.toMatchObject({ code: "stale_owner" });
  }));

test("raw route pages preserve captured data without claiming a native routing invocation", () =>
  owned(["route"], async ({ client }) => {
    const view = await client();
    await view.grant("route", true);
    let offset: number | undefined, text = "";
    do {
      const result = await view.routeRead("owned", offset);
      expect(result.state).toBe("captured");
      expect(result.page.text.length).toBeLessThanOrEqual(1024);
      text += result.page.text; offset = result.page.nextOffset ?? undefined;
    } while (offset !== undefined);
    expect(text).toBe(JSON.stringify(route));
    await expect(view.routeRead("owned", text.length + 1)).rejects.toMatchObject({ code: "invalid_cursor" });
  }));

test("broker does not queue around controller busy; independent views progress and disconnect joins accepted history", () =>
  owned(["history"], async ({ client, historyId }) => {
    const first = await client(), independent = await client();
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const start = new Promise<void>(resolve => { entered = resolve; });
    const original = historyModule.queryHistory;
    let held = false;
    const producers: Array<ReturnType<typeof original>> = [];
    const query = spyOn(historyModule, "queryHistory").mockImplementation((...args) => {
      const producer = (async () => {
        if (!held) { held = true; entered(); await hold; }
        return original(...args);
      })();
      producers.push(producer); return producer;
    });
    const pending = first.historyList();
    void pending.catch(() => {});
    try {
      await start;
      await expect(first.historyList()).rejects.toMatchObject({ code: "busy" });
      expect((await independent.historyList()).items).toHaveLength(1);
      await independent.grant("history", true);
      expect((await independent.historyRead({ historyId, limit: 1 })).items).toHaveLength(1);
      await first.disconnect();
      await expect(pending).rejects.toThrow("disconnected");
    } finally {
      release(); await pending.catch(() => {});
      // The client close is not producer settlement.
      await Promise.allSettled(producers);
      query.mockRestore();
    }
  }));

test("missing/pruned and unknown histories have diagnostics; no fabricated empty success", () =>
  owned(["history"], async ({ client, historyId, catalogFile }) => {
    const view = await client();
    await view.grant("history", true);
    const unknown = await view.historyRead({ historyId: randomUUID() });
    expect(unknown).toMatchObject({ items: [], cursor: null, diagnostics: [{ code: "history_not_found" }] });
    const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
    for (const native of [{ state: "pruned" }, { state: "not-created" },
      { state: "allocated", sessionId: "missing", path: path.join(path.dirname(catalogFile), "missing.jsonl"),
        disposition: { state: "pending" } }]) {
      writeFileSync(catalogFile, JSON.stringify({ ...catalog, members: [{ ...catalog.members[0], native }, catalog.members[1]] }));
      const page = await view.historyRead({ historyId });
      expect(page.items).toHaveLength(0); expect(page.cursor).toBeNull();
      expect(page.diagnostics.some(item => item.code === (native.state === "allocated" ? "native_missing" :
        native.state === "pruned" ? "history_pruned" : "native_not_created"))).toBe(true);
    }
    writeFileSync(catalogFile, JSON.stringify(catalog));
  }));

// A raw peer can deliberately reuse client/correlation identity and measure the exact complete UTF-8 frame.
async function peer(descriptor: string) {
  const discovery = JSON.parse(readFileSync(descriptor, "utf8"));
  const socket = net.createConnection(discovery.socket);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  let carry = Buffer.alloc(0), respond: ((record: { value: any; bytes: number }) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  socket.on("error", error => reject?.(error));
  socket.on("close", () => { reject?.(new Error("raw peer closed before reply")); reject = undefined; });
  socket.on("data", chunk => {
    carry = Buffer.concat([carry, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
    const newline = carry.indexOf(10);
    if (newline >= 0) {
      const frame = carry.subarray(0, newline);
      carry = carry.subarray(newline + 1);
      const done = respond; respond = undefined; reject = undefined;
      done?.({ value: JSON.parse(frame.toString("utf8")), bytes: frame.length + 1 });
    }
  });
  return {
    request(method: string, params: Record<string, unknown>, owner = discovery.owner) {
      return new Promise<{ value: any; bytes: number }>((resolve, failure) => {
        respond = resolve; reject = failure;
        socket.write(JSON.stringify({ version: 1, id: "\u0001".repeat(128), clientId: "\u0001".repeat(128), owner, method, params }) + "\n");
      });
    },
    async close() {
      if (socket.closed) return;
      const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
      socket.destroy(); await closed;
    },
  };
}

test("maximum encoded raw replies include envelope/LF; exact bytes/cursors/diagnostics survive subdivision and reused identity", () =>
  owned(["history", "route"], async ({ descriptor, historyId, owner, catalogFile }) => {
    let wire = await peer(descriptor);
    const catalogText = readFileSync(catalogFile, "utf8");
    try {
      const authenticated = await wire.request("connect", { token: JSON.parse(readFileSync(descriptor, "utf8")).token,
        expectedSessionId: owner.coordinatorSessionId });
      expect(authenticated.value.ok).toBe(true);
      expect((await wire.request("input", {})).value).toMatchObject({ ok: false, error: { code: "invalid_request" } });
      await wire.request("view.grant", { grant: "history", acknowledged: true });
      await wire.request("view.grant", { grant: "route", acknowledged: true });
      let cursor: string | undefined, offset = 0, pages = 0, maximum = 0;
      const fragments: Buffer[] = [];
      const validation = new Set<string>(), diagnostics = new Set<string>();
      do {
        const record = await wire.request("history.read", { historyId, cursor, limit: 200 });
        expect(record.value.ok).toBe(true);
        expect(isReply(record.value, "history.read")).toBe(true);
        expect(record.bytes).toBeLessThanOrEqual(replyBytes); maximum = Math.max(maximum, record.bytes);
        const page = record.value.result;
        expect(page.items.length).toBeGreaterThan(0);
        for (const item of page.items) {
          expect(item.byteOffset).toBe(offset);
          const fragment = Buffer.from(item.data, "base64"); offset += fragment.length; fragments.push(fragment);
          validation.add(item.validation);
        }
        for (const diagnostic of page.diagnostics) diagnostics.add(diagnostic.code);
        cursor = page.cursor ?? undefined; pages++;
      } while (cursor);
      expect(pages).toBeGreaterThan(2); expect(maximum).toBeGreaterThan(40 * 1024);
      expect(Buffer.concat(fragments)).toEqual(nativeBytes);
      expect(validation.has("validation_limit")).toBe(true); expect(validation.has("corrupt")).toBe(true);
      expect(diagnostics.has("native_physical_order")).toBe(true);
      expect(diagnostics.has("json_validation_limit")).toBe(true);
      expect(diagnostics.has("partial_tail")).toBe(true);
      const catalog: HistoryGroup = JSON.parse(catalogText);
      const additional = Array.from({ length: 25 }, () => ({ ...catalog.members[0]!, historyId: randomUUID(),
        native: { state: "not-created" as const }, gaps: ["\u0001".repeat(500)],
        coordinatorSessionFile: "/private/not-client-authority" }));
      writeFileSync(catalogFile, JSON.stringify({ ...catalog, members: [...catalog.members, ...additional] }));
      const listed: string[] = []; cursor = undefined; let metadataPages = 0, maximumMetadata = 0;
      do {
        const record = await wire.request("history.list", { cursor, limit: 200 });
        expect(record.value.ok).toBe(true);
        expect(isReply(record.value, "history.list")).toBe(true);
        expect(record.bytes).toBeLessThanOrEqual(replyBytes);
        maximumMetadata = Math.max(maximumMetadata, record.bytes);
        for (const item of record.value.result.items) {
          listed.push(item.historyId); expect(item.coordinatorSessionFile).toBeUndefined();
          expect(item.native.path).toBeUndefined();
        }
        cursor = record.value.result.cursor ?? undefined; metadataPages++;
      } while (cursor);
      expect(listed).toEqual([historyId, ...additional.map(item => item.historyId)]);
      expect(metadataPages).toBeGreaterThan(1);
      writeFileSync(catalogFile, catalogText);
      let routeOffset: number | undefined, routeText = "", maximumRoute = 0;
      do {
        const record = await wire.request("route.read", { id: "owned", offset: routeOffset });
        expect(record.value.ok).toBe(true); expect(isReply(record.value, "route.read")).toBe(true);
        expect(record.bytes).toBeLessThanOrEqual(replyBytes);
        maximumRoute = Math.max(maximumRoute, record.bytes);
        routeText += record.value.result.page.text; routeOffset = record.value.result.page.nextOffset ?? undefined;
      } while (routeOffset !== undefined);
      expect(routeText).toBe(JSON.stringify(route));
      console.log(JSON.stringify({ completePageBudgetWitness: { rawPages: pages, rawBytes: offset,
        maximumRawReplyBytes: maximum, metadataPages, maximumMetadataReplyBytes: maximumMetadata,
        maximumRouteReplyBytes: maximumRoute, replyBudget: replyBytes, includesEnvelopeAndLF: true } }));
      const wrongOwner = await wire.request("history.read", { historyId }, { ...owner, epoch: "wrong" });
      expect(wrongOwner.value).toMatchObject({ ok: false, error: { code: "stale_owner" } });
      // Fresh transport reuses the exact same identity; authentication does not recover acknowledgements.
      await wire.close(); wire = await peer(descriptor);
      expect((await wire.request("connect", { token: JSON.parse(readFileSync(descriptor, "utf8")).token,
        expectedSessionId: owner.coordinatorSessionId, resumeToken: authenticated.value.result.lease.resumeToken })).value.ok).toBe(true);
      expect((await wire.request("history.read", { historyId })).value).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect((await wire.request("route.read", { id: "owned" })).value).toMatchObject({ ok: false, error: { code: "forbidden" } });
      await wire.request("view.grant", { grant: "history", acknowledged: true });
      expect((await wire.request("history.read", { historyId, limit: 1 })).value.ok).toBe(true);
    } finally { await wire.close(); writeFileSync(catalogFile, catalogText); }
  }, true));

test("public protocol rejects invented authority, unconstrained requests and malformed raw replies", () => {
  const owner = { processId: "process", coordinatorSessionId: "coordinator", epoch: "epoch" };
  const request: Envelope = { version: 1, id: "id", clientId: "client", owner, method: "history.read", params: { historyId: randomUUID() } };
  expect(isRequest(request)).toBe(true);
  for (const extra of [{ scope: "all" }, { path: "/tmp/native" }, { source: "coordinator" }, { groupId: "not-uuid" }])
    expect(isRequest({ ...request, params: { ...request.params, ...extra } })).toBe(false);
  const fragment = { historyId: randomUUID(), source: "worker", entryOffset: 0, byteOffset: 0,
    encoding: "base64", endsEntry: true, data: "AA==", validation: "corrupt" };
  const reply = { version: 1, id: "id", clientId: "client", owner, ok: true, result: {
    items: [fragment], diagnostics: [{ code: "native_physical_order" }], cursor: null } };
  expect(isReply(reply, "history.read")).toBe(true);
  const groupId = randomUUID();
  const member = { kind: "member", groupId, historyId: fragment.historyId, roleId: "developer",
    coordinatorSessionId: owner.coordinatorSessionId, admittedAt: "now", gaps: [],
    native: { state: "not-created" }, group: { groupId } };
  expect(isReply({ ...reply, result: { ...reply.result, items: [member] } }, "history.list")).toBe(true);
  expect(isReply({ ...reply, result: { ...reply.result, items: [{ ...member, coordinatorSessionId: "foreign" }] } }, "history.list")).toBe(false);
  for (const wrong of [{ data: "not base64" }, { data: "AAAA".repeat(3000) }, { byteOffset: -1 }, { source: "coordinator" }])
    expect(isReply({ ...reply, result: { ...reply.result, items: [{ ...fragment, ...wrong }] } }, "history.read")).toBe(false);
});
