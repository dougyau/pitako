import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createLiveHandle, readActivitySnapshot, type ActivityPage, type TerminalActivitySnapshot } from "../extensions/agent/live.ts";
import {
  clearObservations, observationEpoch, publishObservation, publishActivityBinding, retainTerminalActivity,
  noteTerminalActivityUnavailable, terminalActivityKey, readTerminalActivity, removeObservation,
  removeTeamObservations, removeUntaggedObservations, removeOwnerTerminalActivity, type TerminalActivityKey,
} from "../extensions/agent/observe.ts";
import type { AgentUiSnapshot } from "../extensions/agent/ui.ts";
import { providerFixtureOwnership } from "./fixtures/provider-fixture-ownership.ts";

// File-private Bun worker state; no global environment changes, roots, native starts or providers.
afterEach(() => clearObservations());
const adapterOwnership = providerFixtureOwnership();
afterEach(adapterOwnership.requireReleasedFixture);
const ownerToken = Symbol("terminal-owner");
function key(instanceId = "worker", overrides: Partial<TerminalActivityKey> = {}): TerminalActivityKey {
  return { ownerToken, coordinatorSessionId: "coordinator", instanceId, generation: 1, attemptId: `${instanceId}:1`,
    historyId: `history-${instanceId}`, sessionId: `session-${instanceId}`, ...overrides };
}
function row(k: TerminalActivityKey, brief: string | undefined = "original", task = "invocation"): AgentUiSnapshot {
  return { id: k.instanceId, roleId: "developer", status: "running", phase: "working", task,
    acceptedAt: 0, selectedModel: "fixture/model", lastActivityKind: "created", attemptId: k.attemptId,
    teamOwnerToken: k.teamOwnerToken, origin: { source: k.teamOwnerToken ? "team_assign" : "agent_spawn",
      coordinatorSessionId: k.coordinatorSessionId, assignmentId: k.assignmentId, workbrief: brief } };
}
function snapshot(k: TerminalActivityKey, count = 0, text = "event"): TerminalActivitySnapshot {
  return { historyId: k.historyId, sessionId: k.sessionId,
    native: { sessionId: k.sessionId, historyId: k.historyId, leafId: null, persisted: false },
    sequence: count, dropped: 0, interactionsDropped: 0,
    activity: Array.from({ length: count }, (_, i) => ({ sequence: i + 1, kind: "user", text,
      source: "event-only", nativeLeafId: null })), interactions: [], gaps: ["event-only; no persistence guarantee"] };
}
function bind(k: TerminalActivityKey, brief?: string): void {
  publishObservation(row(k, brief));
  publishActivityBinding(k);
}
function ready(k: TerminalActivityKey, options?: Parameters<typeof readTerminalActivity>[1]): ActivityPage {
  const result = readTerminalActivity(k, options);
  expect(result.state).toBe("ready");
  if (result.state !== "ready") throw new Error(`Expected retained page: ${result.state}`);
  return result.page;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function liveFixture(steer: () => Promise<"queued" | "handled"> = async () => "queued", brief = "original") {
  const manager = SessionManager.inMemory(process.cwd());
  const markers: unknown[] = [];
  const session = { sessionId: manager.getSessionId(), sessionManager: manager, sessionFile: undefined as string | undefined, steer };
  const live = createLiveHandle(session, { historyId: "history", invocation: {
    task: brief, origin: { source: "agent_spawn", workbrief: brief },
  }, append(event, data) {
    markers.push(JSON.parse(JSON.stringify({ event, data })));
    manager.appendCustomEntry("fixture", data);
  } });
  const identity = { historyId: live.handle.historyId, sessionId: live.handle.sessionId };
  return { live, session, markers, identity };
}

test("terminal leaf: capture waits for successful close and pending hooks; receipts remain bounded evidence", async () => {
  const gate = deferred<"queued">();
  const { live, identity, markers } = liveFixture(() => gate.promise);
  live.open();
  const submitted = live.handle.input({ ...identity, intent: "query", text: "/not-a-command" });
  let settled = false;
  let joined: Promise<void> | undefined;
  try {
    expect(() => live.capture()).toThrow("successful settled close");
    const closing = live.handle.close();
    expect(live.handle.close()).toBe(closing);
    expect(() => live.capture()).toThrow("successful settled close");
    joined = closing.then(() => { settled = true; });
    expect(await live.handle.input({ ...identity, intent: "steer", text: "late" })).toMatchObject({ status: "rejected" });
    expect(settled).toBe(false);
  } finally {
    gate.resolve("queued");
    await Promise.all([submitted, live.handle.close(), joined]);
  }
  const captured = live.capture();
  expect(captured.interactions[0]).toMatchObject({ status: "unconfirmed" });
  expect(captured.interactions[1]).toMatchObject({ status: "rejected" });
  expect(captured.native.leafId).not.toBeNull();
  expect(captured.gaps.join("\n")).toContain("No first assistant");
  // Close revokes delivery before the queued hook returns; only final evidence is persisted.
  expect(markers).toMatchObject([
    { event: "interaction", data: { status: "pending" } },
    { event: "interaction", data: { status: "rejected" } },
    { event: "interaction", data: { status: "unconfirmed" } },
  ]);
  captured.interactions[0]!.status = "mutated";
  captured.native.leafId = "mutated";
  expect(live.capture().interactions[0]!.status).toBe("unconfirmed");
  expect(live.capture().native.leafId).not.toBe("mutated");
  expect(JSON.stringify(captured)).not.toContain("sessionManager");
});

test("terminal leaf: final queued receipt becomes unconfirmed, while hook handling makes no answer claim", async () => {
  const { live, identity, markers } = liveFixture();
  live.open();
  expect(await live.handle.input({ ...identity, intent: "steer", text: "queued" })).toMatchObject({ status: "queued" });
  await live.handle.close();
  expect(live.capture().interactions[0]).toMatchObject({ status: "unconfirmed", delivery: "session closed; no answer or delivery guarantee" });
  expect(markers).toHaveLength(3);
  const consumed = liveFixture(async () => "handled");
  consumed.live.open();
  await consumed.live.handle.input({ ...consumed.identity, intent: "query", text: "hook" });
  await consumed.live.handle.close();
  expect(consumed.live.capture().interactions[0]).toMatchObject({ status: "handled", delivery: "input hook consumed; not an answer" });
});

test("terminal leaf: failed close cannot yield a successful snapshot, and changed native identity is not rebased", async () => {
  const manager = SessionManager.inMemory(process.cwd());
  const closeError = new Error("unconfirmed marker failed");
  const failed = createLiveHandle({ sessionId: manager.getSessionId(), sessionManager: manager,
    sessionFile: undefined, async steer() { return "queued"; } }, {
    historyId: "history", invocation: { task: "original", origin: undefined },
    append(_event, data) {
      if (data && typeof data === "object" && "status" in data && data.status === "unconfirmed") throw closeError;
    },
  });
  failed.open();
  await failed.handle.input({ historyId: "history", sessionId: failed.handle.sessionId, intent: "query", text: "queued" });
  const closing = failed.handle.close();
  expect(failed.handle.close()).toBe(closing);
  await expect(closing).rejects.toBe(closeError);
  expect(() => failed.capture()).toThrow("successful settled close");

  const { live, session } = liveFixture();
  live.open();
  live.event({ type: "message_end", message: { role: "user", content: "before native change", timestamp: 0 } });
  session.sessionId = "changed-native";
  // This existing file is only a presence probe, never represented as a transcript.
  session.sessionFile = import.meta.filename;
  await live.handle.close();
  const capture = live.capture();
  expect(capture.sessionId).not.toBe(session.sessionId);
  expect(capture.native.sessionId).toBe("changed-native");
  expect(capture.native.persisted).toBe(true);
  expect(capture.gaps.join("\n")).toContain("binding is stale");
  expect(capture.gaps.join("\n")).toContain("No first assistant");
  const k = key("changed", { sessionId: live.handle.sessionId, historyId: live.handle.historyId });
  bind(k);
  retainTerminalActivity(k, capture);
  expect(readTerminalActivity(k)).toEqual({ state: "stale_reference" });
});

test("terminal leaf: capture copies the full rings, preserves coalescing and continues a live cursor", async () => {
  const { live } = liveFixture();
  live.open();
  for (let i = 0; i < 205; i++) live.event({ type: "message_end",
    message: { role: "user", content: `${i} 😀` + "\0".repeat(1000), timestamp: i } });
  const first = live.handle.observe({ after: 0, limit: 200 }) as unknown as ActivityPage;
  expect(first.active).toBe(true);
  expect(first.activity.length).toBeLessThan(50);
  expect(first.more).toBe(true);
  await live.handle.close();
  const captured = live.capture();
  expect(captured.activity).toHaveLength(200);
  expect(captured.dropped).toBe(5);
  expect(captured.activity.every(event => Buffer.byteLength(event.text.replace(/\n\[clipped\]$/, "")) <= 768)).toBe(true);
  const k = key("worker", { historyId: captured.historyId, sessionId: captured.sessionId });
  bind(k);
  retainTerminalActivity(k, captured);
  let cursor = first.cursor;
  const next = ready(k, { after: cursor, limit: 200 });
  expect(next.activity[0]!.sequence).toBeGreaterThan(cursor);
  expect(next.active).toBe(false);
  // Independently walk all surviving events, not receipts or native transcript entries.
  cursor = 0;
  const sequences: number[] = [];
  for (;;) {
    const page = ready(k, { after: cursor, limit: 200 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(31 * 1024);
    sequences.push(...page.activity.map(event => event.sequence));
    cursor = page.cursor;
    if (!page.more) break;
  }
  expect(sequences.at(-1)).toBe(205);
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(ready(k, { after: 205 }).activity).toEqual([]);
  expect(readTerminalActivity(k, { after: 206 })).toEqual({ state: "invalid_cursor" });
  expect(ready(k).gaps.join("\n")).toContain("clipped");
  captured.activity.at(-1)!.text = "altered";
  const returned = ready(k);
  returned.native.leafId = "altered";
  returned.activity.at(-1)!.text = "altered";
  expect(ready(k).activity.at(-1)!.text).not.toBe("altered");
  expect(ready(k).native.leafId).not.toBe("altered");
});

test("terminal leaf: an unchanged-attempt live cursor continues exactly across close; streamed updates coalesce", async () => {
  const { live } = liveFixture();
  live.open();
  const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "final" }],
    api: "openai-completions" as const, provider: "fixture", model: "fixture", stopReason: "stop" as const,
    timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  for (let i = 0; i < 80; i++) {
    live.event({ type: "message_update", message: assistant,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "delta", partial: assistant } });
    live.event({ type: "message_end", message: { role: "user", content: `event-${i}`, timestamp: i } });
  }
  live.event({ type: "message_end", message: assistant });
  const before = live.handle.observe({ after: 0 }) as unknown as ActivityPage;
  expect(before.cursor).toBe(50);
  await live.handle.close();
  const captured = live.capture();
  expect(captured.sequence).toBe(81); // No streamed update gets its own retained event.
  expect(captured.activity).toHaveLength(81);
  const k = key("continuation", { historyId: captured.historyId, sessionId: captured.sessionId });
  bind(k); retainTerminalActivity(k, captured);
  const after = ready(k, { after: before.cursor });
  expect(after.activity.map(event => event.sequence)).toEqual(Array.from({ length: 31 }, (_, i) => i + 51));
  expect(after.cursor).toBe(81);
  expect(after.more).toBe(false);
  expect(after.gaps.join("\n")).not.toContain("No first assistant");
  const tail = ready(k);
  expect(tail.activity.map(event => event.sequence)).toEqual(Array.from({ length: 50 }, (_, i) => i + 32));
});

test("terminal leaf: empty created capture differs from absent, failure, unsupported and stale-native evidence", async () => {
  const { live } = liveFixture();
  await live.handle.close();
  const captured = live.capture();
  const k = key("empty", { historyId: captured.historyId, sessionId: captured.sessionId });
  bind(k);
  expect(readTerminalActivity(k)).toEqual({ state: "unavailable", reason: "not_captured" });
  retainTerminalActivity(k, captured);
  expect(ready(k)).toMatchObject({ active: false, activity: [], cursor: 0, more: false, native: { persisted: false } });
  expect(ready(k).gaps.join("\n")).toContain("No first assistant");
  for (const reason of ["close_failed", "capture_failed", "snapshot_oversized"] as const) {
    noteTerminalActivityUnavailable(k, reason);
    expect(readTerminalActivity(k)).toEqual({ state: "unavailable", reason });
  }
  retainTerminalActivity(k, { ...captured, native: { ...captured.native, sessionId: "changed" } });
  expect(readTerminalActivity(k)).toEqual({ state: "stale_reference" });
  const synchronous = key("synchronous");
  publishObservation({ ...row(synchronous), origin: { ...row(synchronous).origin!, source: "agent_run" } });
  publishActivityBinding(synchronous);
  retainTerminalActivity(synchronous, snapshot(synchronous));
  expect(readTerminalActivity(synchronous)).toEqual({ state: "unavailable", reason: "unsupported_kind" });
});

test("terminal leaf: scoped binding rejects wrong owner, coordinator, Team, epoch and late captures", () => {
  const teamOwnerToken = Symbol("team");
  const k = key("team-worker", { teamOwnerToken, assignmentId: "assignment" });
  bind(k);
  retainTerminalActivity(k, snapshot(k, 1));
  for (const change of [{ ownerToken: Symbol("other") }, { coordinatorSessionId: "other" },
    { teamOwnerToken: Symbol("other-team") }, { assignmentId: "other" }]) {
    const bad = { ...k, ...change };
    expect(readTerminalActivity(bad)).toEqual({ state: "stale_reference" });
    publishActivityBinding(bad);
    retainTerminalActivity(bad, snapshot(bad, 2));
    noteTerminalActivityUnavailable(bad, "capture_failed");
  }
  expect(readTerminalActivity({ ...k, generation: 2 })).toEqual({ state: "stale_reference" });
  retainTerminalActivity({ ...k, generation: 2 }, snapshot(k, 2));
  expect(ready(k).cursor).toBe(1);
  expect(terminalActivityKey(k.instanceId, ownerToken, "other", teamOwnerToken)).toBeUndefined();
  expect(terminalActivityKey(k.instanceId, ownerToken, "coordinator")).toBeUndefined();
  const copied = terminalActivityKey(k.instanceId, ownerToken, "coordinator", teamOwnerToken)!;
  copied.sessionId = "changed";
  expect(terminalActivityKey(k.instanceId, ownerToken, "coordinator", teamOwnerToken)!.sessionId).toBe(k.sessionId);
  const epoch = observationEpoch();
  clearObservations();
  publishObservation(row(k), epoch);
  publishActivityBinding(k, epoch);
  retainTerminalActivity(k, snapshot(k), epoch);
  expect(terminalActivityKey(k.instanceId, ownerToken, "coordinator", teamOwnerToken)).toBeUndefined();
  bind(k);
  retainTerminalActivity(k, snapshot(k, 2), epoch);
  expect(readTerminalActivity(k)).toEqual({ state: "unavailable", reason: "not_captured" });
  removeTeamObservations(teamOwnerToken);
  publishActivityBinding(k);
  retainTerminalActivity(k, snapshot(k));
  expect(readTerminalActivity(k)).toEqual({ state: "stale_reference" });
});

test("terminal leaf: logical attempt and native generation invalidate references; identical publication is idempotent", () => {
  const k = key();
  bind(k);
  retainTerminalActivity(k, snapshot(k, 1));
  publishActivityBinding({ ...k });
  expect(ready(k).cursor).toBe(1);
  const attempt = { ...k, attemptId: "worker:2" };
  publishObservation(row(attempt));
  publishActivityBinding(attempt);
  expect(readTerminalActivity(k)).toEqual({ state: "stale_reference" });
  expect(readTerminalActivity(attempt)).toEqual({ state: "unavailable", reason: "not_captured" });
  retainTerminalActivity(k, snapshot(k, 2));
  retainTerminalActivity(attempt, snapshot(attempt, 2));
  const rebound = { ...attempt, generation: 2, historyId: "new-history", sessionId: "new-session" };
  publishActivityBinding(rebound);
  publishActivityBinding(attempt); // Old generation cannot rewind current binding.
  retainTerminalActivity(attempt, snapshot(attempt, 3));
  expect(readTerminalActivity(attempt)).toEqual({ state: "stale_reference" });
  expect(readTerminalActivity(rebound)).toEqual({ state: "unavailable", reason: "not_captured" });
  retainTerminalActivity(rebound, snapshot(rebound, 3));
  expect(ready(rebound).cursor).toBe(3);
});

test("terminal leaf: exact escaped/Unicode brief pages and invocation provenance survive payload omission", () => {
  const brief = '😀\u0000"\\\ud800'.repeat(12000);
  const k = key();
  bind(k, brief);
  const data = snapshot(k, 200, "\u0000".repeat(768));
  data.interactions = Array.from({ length: 200 }, (_, index) => ({ index, status: "unconfirmed", reason: "\u0000😀".repeat(500) }));
  data.teamWrapper = "\u0000".repeat(20000);
  data.gaps.push("\u0000".repeat(20000));
  retainTerminalActivity(k, data);
  expect(ready(k).gaps.join("\n")).toContain("Terminal storage omitted");
  expect(ready(k).gaps.join("\n")).toContain("clipped");
  let offset: number | null = 0, reassembled = "";
  while (offset !== null) {
    const page = ready(k, { after: 200, briefOffset: offset, limit: 200 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(31 * 1024);
    expect(page.workbrief.offset).toBe(offset);
    reassembled += page.workbrief.text;
    const next = page.workbrief.nextOffset;
    if (next !== null) expect(next).toBe(offset + page.workbrief.text.length);
    offset = next;
  }
  expect(reassembled).toBe(brief);
  expect(ready(k, { briefOffset: brief.length }).workbrief).toEqual({ text: "", offset: brief.length, nextOffset: null, source: "original WorkBrief" });
  expect(readTerminalActivity(k, { briefOffset: brief.length + 1 })).toEqual({ state: "invalid_cursor" });
  publishObservation({ ...row(k, undefined, "fallback invocation"), origin: { ...row(k).origin!, workbrief: undefined } });
  expect(ready(k).workbrief).toMatchObject({ source: "invocation task", text: "fallback invocation" });
  expect(ready(k).gaps.join("\n")).toContain("Original WorkBrief provenance unavailable");
});

test("terminal leaf: all 200 receipts captured, page omission is a bounded tail not exhaustive pagination", async () => {
  const { live, identity } = liveFixture();
  for (let i = 0; i < 205; i++) await live.handle.input({ ...identity, intent: "query", text: "closed" });
  await live.handle.close();
  const captured = live.capture();
  expect(captured.interactions).toHaveLength(200);
  expect(captured.interactionsDropped).toBe(5);
  const page = readActivitySnapshot(captured, "original", { limit: 10 });
  expect(page.interactions).toEqual(captured.interactions.slice(-10));
  expect(page.gaps.join("\n")).toContain("190 retained interaction receipts omitted");
  expect(page.gaps.join("\n")).toContain("ring dropped 5 receipts");
  expect(page.more).toBe(false);
});

test("terminal leaf: retention is FIFO, read-independent, byte/count bounded, deterministic and replaceable", () => {
  const keys = Array.from({ length: 130 }, (_, i) => key(`fifo-${i}`));
  const large = "\u0000".repeat(768);
  for (const [index, k] of keys.entries()) {
    bind(k);
    retainTerminalActivity(k, snapshot(k, 200, large));
    if (index === 127) ready(keys[0]!); // Reading the oldest does not extend its lifetime.
  }
  expect(readTerminalActivity(keys[0]!)).toEqual({ state: "evicted" });
  expect(readTerminalActivity(keys[1]!)).toEqual({ state: "evicted" });
  for (const k of keys.slice(2)) {
    const page = ready(k, { after: 0, limit: 200 });
    expect(page.gaps.join("\n")).toContain("Terminal storage omitted");
    // Serialized escaped records alone must fit the payload cap, even though one
    // returned page cannot hold all of them. Key/native/diagnostic bytes consume more.
    const retainedTail = snapshot(k, 200, large).activity.slice(page.activity[0]!.sequence - 1);
    expect(Buffer.byteLength(JSON.stringify(retainedTail))).toBeLessThan(65536);
    const tail = ready(k, { after: 199, limit: 200 });
    expect(tail.activity.at(-1)!.sequence).toBe(200);
  }
  const before = ready(keys[2]!, { after: 0, limit: 200 });
  // Multiple replacements reveal leaked byte accounting, not merely leaked count.
  for (let i = 0; i < 12; i++) retainTerminalActivity(keys[2]!, snapshot(keys[2]!, 200, large));
  expect(ready(keys[2]!, { after: 0, limit: 200 })).toEqual(before);
  const newer = key("newer");
  bind(newer); retainTerminalActivity(newer, snapshot(newer, 200, large));
  expect(readTerminalActivity(keys[3]!)).toEqual({ state: "evicted" });
  expect(readTerminalActivity(keys[2]!).state).toBe("ready");
  removeObservation(keys[4]!.instanceId);
  const last = key("last");
  bind(last); retainTerminalActivity(last, snapshot(last, 200, large));
  expect(readTerminalActivity(keys[5]!).state).toBe("ready");
  // Full serializable mandatory identity, not just event text, controls admission.
  const oversized = key("huge", { historyId: "\0".repeat(4000) });
  bind(oversized); retainTerminalActivity(oversized, snapshot(oversized));
  expect(readTerminalActivity(oversized)).toEqual({ state: "unavailable", reason: "snapshot_oversized" });
});

test("terminal leaf: row removals and owner retirement release capacity and fence late callbacks", () => {
  const first = key("first"), independent = key("independent", { ownerToken: Symbol("independent-owner") });
  bind(first); bind(independent);
  retainTerminalActivity(first, snapshot(first, 1)); retainTerminalActivity(independent, snapshot(independent, 1));
  removeOwnerTerminalActivity(ownerToken);
  publishObservation(row({ ...first, attemptId: "first:2" }));
  publishActivityBinding({ ...first, attemptId: "first:2" });
  retainTerminalActivity(first, snapshot(first, 2));
  expect(terminalActivityKey(first.instanceId, ownerToken, "coordinator")).toBeUndefined();
  expect(readTerminalActivity(first)).toEqual({ state: "stale_reference" });
  expect(ready(independent).cursor).toBe(1);
  removeObservation(first.instanceId);
  publishActivityBinding(first);
  expect(readTerminalActivity(first)).toEqual({ state: "stale_reference" });
  removeUntaggedObservations();
  expect(readTerminalActivity(independent)).toEqual({ state: "stale_reference" });
});

// These cases intentionally import the assembled adapter/package, ONLY inside their
// callbacks. They must run after the two-worker settled barrier; prefix-filtered leaf
// checks above do not import pi.ts or load the package/background extensions.
for (const mode of ["success", "close_failed", "capture_failed", "callback_throws", "failure_callback_throws"] as const) {
  test(`terminal adapter (serial barrier): capture/unbind/disposal ordering and ${mode}`,
    adapterOwnership.ownedCase(`terminal adapter ${mode}`, async () => {
      const { AgentSession } = await import("@earendil-works/pi-coding-agent");
      const { InvocationHistory } = await import("../extensions/agent/history.ts");
      const { createPiExecutor } = await import("../extensions/agent/pi.ts");
      const { executionForSession } = await import("../extensions/execution-identity.ts");
      const root = mkdtempSync(path.join(tmpdir(), "pitako-terminal-adapter-"));
      adapterOwnership.directories.push(root);
      const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-terminal-agent-"));
      adapterOwnership.directories.push(agentDir);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const offline = process.env.PI_OFFLINE, telemetry = process.env.PI_TELEMETRY;
      process.env.PI_OFFLINE = "1"; process.env.PI_TELEMETRY = "0";
      const closeGate = deferred<void>(), closeStarted = deferred<void>();
      const disposeGate = deferred<void>(), disposeStarted = deferred<void>();
      const timeline: string[] = [];
      const closeError = new Error("terminal fixture native close rejected");
      let native: InstanceType<typeof AgentSession> | undefined;
      let nativeDisposed = false;
      let currentKey: TerminalActivityKey | undefined;
      let restoreLeaf: (() => void) | undefined;
      let callbacks = 0, failures = 0;
      const originalBind = AgentSession.prototype.bindExtensions;
      const binding = spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function (this: InstanceType<typeof AgentSession>, ...args) {
        native = this;
        const dispose = this.dispose.bind(this);
        this.dispose = async () => {
          timeline.push("native-dispose");
          disposeStarted.resolve();
          await disposeGate.promise;
          await dispose();
          nativeDisposed = true;
          timeline.push("native-disposed");
        };
        await originalBind.apply(this, args);
        this.prompt = async () => { throw new Error("terminal adapter fixture must never prompt a provider"); };
        const emit = this.extensionRunner.emit.bind(this.extensionRunner);
        this.extensionRunner.emit = async event => {
          if (event.type === "session_shutdown") timeline.push("shutdown");
          return emit(event);
        };
      });
      let attemptForCleanup: Promise<unknown> | undefined;
      // Register before history/start: setup failure owns roots, globals and the spy too.
      adapterOwnership.beforeRelease(async () => {
        closeGate.resolve(); disposeGate.resolve();
        await attemptForCleanup;
        if (native && !nativeDisposed) throw new Error(`Native terminal adapter release uncertain; retain ${root} and ${agentDir}`);
        restoreLeaf?.();
        binding.mockRestore();
        if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline;
        if (telemetry === undefined) delete process.env.PI_TELEMETRY; else process.env.PI_TELEMETRY = telemetry;
      });
      const invocation = new InvocationHistory(root, { source: "agent_spawn", coordinatorSessionId: "coordinator",
        workbrief: "exact original" }, "invocation task");
      const attempt = createPiExecutor().start({
        instanceId: "adapter", role: { id: "developer", name: "Developer", description: "terminal adapter",
          instructionsPath: "roles/developer.md", instructions: "No provider call.", skills: [], principles: [],
          modelPolicyId: "developer", modelPolicy: { id: "developer", fallbacks: [] } },
        task: "invocation task", cwd: root, target: { model: "__terminal_unregistered_fixture__/absent" },
        signal: new AbortController().signal, history: invocation,
        bindLive(handle) {
          const k = key("adapter", { historyId: handle.historyId, sessionId: handle.sessionId });
          currentKey = k;
          bind(k, "exact original");
          const close = handle.close.bind(handle);
          let closing: Promise<void> | undefined;
          handle.close = () => closing ??= (async () => {
            timeline.push("close");
            closeStarted.resolve();
            await closeGate.promise;
            await close();
            if (mode === "close_failed" || mode === "failure_callback_throws") throw closeError;
            if (mode === "capture_failed") {
              const manager = native!.sessionManager, getLeafId = manager.getLeafId.bind(manager);
              restoreLeaf = () => { manager.getLeafId = getLeafId; };
              manager.getLeafId = () => { throw new Error("terminal fixture capture failed"); };
            }
          })();
          handle.onTerminalCapture = captured => {
            callbacks++;
            timeline.push("capture");
            retainTerminalActivity(k, captured);
            if (mode === "callback_throws") throw new Error("terminal fixture callback failed");
          };
          handle.onTerminalCaptureFailed = reason => {
            failures++;
            timeline.push(`failure:${reason}`);
            restoreLeaf?.();
            noteTerminalActivityUnavailable(k, reason);
            if (mode === "failure_callback_throws") throw new Error("terminal fixture failure callback failed");
          };
          return () => { timeline.push("unbind"); };
        },
      }).then(async result => { await result.session?.dispose(); return { result, error: undefined, session: result.session }; }).then(outcome => outcome,
        error => ({ result: undefined, error, session: undefined }));
      attemptForCleanup = attempt;
      // Gates and restoration are owned even when an assertion fails. Join the actual
      // executor/native disposal before restoring a prototype/env or releasing roots.
      const tracked = adapterOwnership.acquire(attempt);
      await Promise.race([closeStarted.promise, attempt.then(outcome => { throw new Error(`terminal executor ended before live close: ${JSON.stringify(outcome.result)} ${String(outcome.error)}`); })]);
      expect(callbacks).toBe(0);
      expect(failures).toBe(0);
      expect(timeline).toEqual(["close"]);
      const k = currentKey!;
      expect(readTerminalActivity(k)).toEqual({ state: "unavailable", reason: "not_captured" });
      closeGate.resolve();
      await Promise.race([disposeStarted.promise, attempt.then(() => { throw new Error("terminal executor ended before native disposal"); })]);
      expect(executionForSession(k.sessionId)).toBeDefined();
      expect(timeline.at(-1)).toBe("native-dispose");
      if (mode === "success") {
        expect(callbacks).toBe(1); expect(failures).toBe(0);
        expect(ready(k)).toMatchObject({ active: false, activity: [], cursor: 0, more: false });
        expect(timeline).toEqual(["close", "capture", "unbind", "shutdown", "native-dispose"]);
      } else {
        const reason = mode === "close_failed" || mode === "failure_callback_throws" ? "close_failed" : "capture_failed";
        expect(callbacks).toBe(mode === "callback_throws" ? 1 : 0); expect(failures).toBe(1);
        expect(readTerminalActivity(k)).toEqual({ state: "unavailable", reason });
        expect(timeline.indexOf(`failure:${reason}`)).toBeLessThan(timeline.indexOf("unbind"));
        expect(timeline.indexOf("unbind")).toBeLessThan(timeline.indexOf("shutdown"));
      }
      disposeGate.resolve();
      const outcome = await tracked;
      expect(timeline.at(-1)).toBe("native-disposed");
      expect(executionForSession(k.sessionId)).toBeUndefined();
      if (mode === "close_failed" || mode === "failure_callback_throws") expect(outcome.error).toBe(closeError);
      else expect(outcome.result).toMatchObject({ status: "failed", error: "model unavailable: __terminal_unregistered_fixture__/absent" });
      const member = invocation.store.read(invocation.group.groupId).members[0]!;
      if (member.native.state !== "allocated") throw new Error("native adapter history not allocated");
      expect(member.native.disposition.state).toBe(
        mode === "close_failed" || mode === "failure_callback_throws" ? "unknown" : "disposed");
      invocation.settled();
    }));
}
