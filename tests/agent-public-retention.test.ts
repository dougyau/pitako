import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { PublicConversation } from "../extensions/agent/public-conversation.ts";
import type { PublicConversationPage, PublicRecord, WorkerReadReference } from "../extensions/agent/bridge/protocol.js";

const ref: WorkerReadReference = { kind: "read", processId: "process", coordinatorSessionId: "owner", epoch: "controller",
  instanceId: "worker", source: "agent_spawn" };
function assistant(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "fixture", model: "local",
    stopReason: "stop", timestamp: 1000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function collect(read: (cursor?: string) => PublicConversationPage, cursor?: string) {
  const output: PublicRecord[] = [], fragments = new Map<string, Buffer[]>();
  let next = cursor, first: PublicConversationPage | undefined, last!: PublicConversationPage;
  do {
    last = read(next); first ??= last;
    expect(Buffer.byteLength(JSON.stringify(last)) + 4096).toBeLessThanOrEqual(48 * 1024);
    expect(last.changes.length).toBeLessThanOrEqual(50);
    for (const record of last.changes) {
      if (!("kind" in record)) { output.push(record.record); continue; }
      const key = `${record.id}:${record.revision}`, parts = fragments.get(key) ?? [];
      expect(parts.reduce((sum, part) => sum + part.length, 0)).toBe(record.byteOffset);
      parts.push(Buffer.from(record.data, "base64")); fragments.set(key, parts);
      if (record.byteOffset + parts.at(-1)!.length === record.totalBytes) {
        output.push(JSON.parse(Buffer.concat(parts).toString("utf8")).record); fragments.delete(key);
      }
    }
    next = last.next ?? undefined;
  } while (next && last.more);
  expect(fragments.size).toBe(0);
  return { output, first: first!, last };
}
function upsert(imported: Map<string, PublicRecord>, records: PublicRecord[]) {
  for (const record of records) {
    const key = `${record.binding}:${record.id}`, previous = imported.get(key);
    if (!previous || record.revision > previous.revision) imported.set(key, record);
  }
}
function owned(body: (root: string, captures: PublicConversation[]) => void) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pitako-public-retention-"));
  const captures: PublicConversation[] = [];
  try { body(root, captures); } finally {
    for (const capture of captures) capture.retire();
    fs.rmSync(root, { recursive: true });
  }
}

test("fixed snapshot cut, concurrent continuation, immutable fragments, historical refs and independent capture epochs", () => owned((root, captures) => {
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  const capture = new PublicConversation(); captures.push(capture);
  const owner = Symbol(); capture.bind(owner);
  const generation = capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  capture.attempt("attempt-1", { model: "fixture/first", reasoning: "off" });
  const bindingRef = { ...ref, native: { generation, historyId: "history", sessionId: manager.getSessionId() } };
  const text = "漢字😀\n".repeat(10000);
  const id = manager.appendMessage(assistant(text));
  capture.entry(generation, manager.getEntry(id)!);
  capture.head(generation, id, manager.getEntries());
  const first = capture.read(bindingRef);
  expect(first.changes[0]).toMatchObject({ kind: "fragment" });
  const id2 = manager.appendMessage(assistant(text));
  capture.entry(generation, manager.getEntry(id2)!);
  capture.head(generation, id2, manager.getEntries());
  const oldCut = collect(cursor => cursor ? capture.read(bindingRef, cursor) : first);
  expect(oldCut.output.map(record => record.nativeEntryId)).toEqual([id]);
  expect(oldCut.last.binding?.headEntryId).toBe(id); // Metadata is at the same cut, not today's head.
  const concurrent = collect(cursor => capture.read(bindingRef, cursor), oldCut.last.next!);
  expect(concurrent.output.map(record => record.nativeEntryId)).toEqual([id2]);
  expect(concurrent.output[0]).toMatchObject({ payload: { blocks: [{ type: "text", text }] } });
  const replay = capture.read(bindingRef, first.next!);
  expect(replay).toEqual(capture.read(bindingRef, first.next!));
  capture.attempt("attempt-2", { model: "fixture/fallback", reasoning: "high" });
  expect(capture.metadata(ref).bindings[0]!.attempts.map(attempt => attempt.attemptId)).toEqual(["attempt-1", "attempt-2"]);
  capture.closeBinding(generation);
  const replacement = SessionManager.create(root, path.join(root, "sessions"));
  const newGeneration = capture.binding("new-history", replacement.getSessionId(), replacement.getSessionFile());
  capture.attempt("attempt-3", { model: "fixture/new-session", reasoning: "off" });
  expect(capture.metadata(ref).bindings.map(binding => binding.attempts.length)).toEqual([2, 1]);
  expect(capture.metadata(ref).bindings[0]).toMatchObject({ state: "historical" });
  expect(collect(cursor => capture.read(bindingRef, cursor)).output.map(record => record.nativeEntryId)).toEqual([id, id2]);
  const newRef = { ...ref, native: { generation: newGeneration, historyId: "new-history", sessionId: replacement.getSessionId() } };
  expect(capture.read(newRef).changes).toEqual([]);
  expect(() => capture.read(newRef, first.next!)).toThrow("invalid_cursor");
  expect(() => capture.read({ ...bindingRef, instanceId: "foreign" }, first.next!)).toThrow("invalid_cursor");
  const differentEpoch = new PublicConversation(); captures.push(differentEpoch);
  differentEpoch.binding("history", manager.getSessionId(), manager.getSessionFile());
  expect(() => differentEpoch.read(bindingRef, first.next!)).toThrow("invalid_cursor");
}));

test("worker/owner byte eviction offers bounded resync and positional recovery of registered persisted messages, with truthful gaps", () => owned((root, captures) => {
  const owner = Symbol(), manager = SessionManager.create(root, path.join(root, "sessions"));
  const capture = new PublicConversation({ worker: 80000, owner: 120000 }); captures.push(capture); capture.bind(owner);
  const generation = capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  const bindingRef = { ...ref, native: { generation, historyId: "history", sessionId: manager.getSessionId() } };
  const before = capture.read(bindingRef).next!;
  for (let index = 0; index < 8; index++) {
    const id = manager.appendMessage(assistant("x".repeat(30000)));
    capture.entry(generation, manager.getEntry(id)!);
  }
  capture.binding("history", manager.getSessionId(), manager.getSessionFile()); // Registers actual persistence.
  expect(capture.read(bindingRef, before)).toMatchObject({ state: "resync_required", gaps: ["evicted", "resync_required"] });
  const available = collect(cursor => capture.read(bindingRef, cursor));
  expect(available.first.gaps).toContain("evicted");
  expect(available.output.length).toBeLessThan(8);
  expect(available.output.length).toBeGreaterThan(0);
  const actualRead = fs.readSync;
  const reads: Array<{ length: number; position: fs.ReadPosition | null }> = [];
  const observeRead: typeof fs.readSync = (fd, buffer, offset?: number | fs.ReadOptions, length?: number, position?: fs.ReadPosition | null) => {
    if (typeof offset !== "number") return actualRead(fd, buffer, offset);
    reads.push({ length: length!, position: position ?? null });
    return actualRead(fd, buffer, offset, length!, position ?? null);
  };
  const spy = spyOn(fs, "readSync").mockImplementation(observeRead);
  try {
    const firstRecovery = capture.read(bindingRef, undefined, true);
    expect(firstRecovery.changes).toEqual([]); // Header only: does not consume/reimport the whole file.
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(read => read.position !== null && read.length <= 4096)).toBe(true);
    expect(reads.reduce((sum, read) => sum + read.length, 0)).toBeLessThan(fs.statSync(manager.getSessionFile()!).size / 2);
    const recovered = collect(cursor => capture.read(bindingRef, cursor, true), firstRecovery.next!);
    expect(recovered.output.map(record => record.nativeEntryId)).toEqual(manager.getEntries().filter(entry => entry.type === "message").map(entry => entry.id));
    expect(recovered.output.every(record => record.recovered && record.nativeTime !== null)).toBe(true);
    expect(recovered.last.gaps).toContain("not_persisted"); // Unpersisted transient updates are not invented.
  } finally { spy.mockRestore(); }
  const sibling = new PublicConversation({ worker: 80000, owner: 120000 }); captures.push(sibling); sibling.bind(owner);
  const siblingManager = SessionManager.inMemory(root);
  const siblingGen = sibling.binding("sibling-history", siblingManager.getSessionId());
  for (let index = 0; index < 3; index++) {
    const id = siblingManager.appendMessage(assistant("y".repeat(30000)));
    sibling.entry(siblingGen, siblingManager.getEntry(id)!);
  }
  const siblingRef = { ...ref, instanceId: "sibling", native: { generation: siblingGen, historyId: "sibling-history", sessionId: siblingManager.getSessionId() } };
  expect(sibling.read(siblingRef, undefined, true).gaps).toEqual(["not_persisted"]);
  // Owner pressure evicts earlier worker data without consuming outcomes or touching native files.
  expect(collect(cursor => capture.read(bindingRef, cursor)).output.length).toBeLessThanOrEqual(1);
  fs.unlinkSync(manager.getSessionFile()!);
  expect(capture.read(bindingRef, undefined, true).gaps).toEqual(["pruned"]);
}));

test("available beginning survives an oversized revision; nested tools preserve parents and private content is omitted", () => owned((root, captures) => {
  const manager = SessionManager.inMemory(root), capture = new PublicConversation({ worker: 5000, owner: 10000 });
  captures.push(capture); capture.bind(Symbol());
  const generation = capture.binding("history", manager.getSessionId());
  const bindingRef = { ...ref, native: { generation, historyId: "history", sessionId: manager.getSessionId() } };
  const kept = manager.appendMessage(assistant("available beginning"));
  capture.entry(generation, manager.getEntry(kept)!);
  const oversized = manager.appendMessage(assistant("x".repeat(6000)));
  capture.entry(generation, manager.getEntry(oversized)!);
  const available = collect(cursor => capture.read(bindingRef, cursor));
  expect(available.output.map(record => record.nativeEntryId)).toEqual([kept]);
  expect(available.first.binding?.gaps).toContain("unsupported_content");
  expect(capture.metadata(ref).gaps).toContain("evicted");
  const privateEntry = manager.appendCustomEntry("fixture-private", { instruction: "PRIVATE_CUSTOM" });
  capture.entry(generation, manager.getEntry(privateEntry)!);
  const image = manager.appendMessage({ role: "user", timestamp: 2000,
    content: [{ type: "image", data: "PRIVATE_BINARY", mimeType: "image/png" }, { type: "text", text: "public text" }] });
  capture.entry(generation, manager.getEntry(image)!);
  capture.tool(generation, { type: "tool_execution_start", toolCallId: "child", parentToolCallId: "parent",
    toolName: "read", args: { public: "arguments" } });
  capture.tool(generation, { type: "tool_execution_end", toolCallId: "child", toolName: "read", isError: true,
    result: { content: [{ type: "text", text: "public failure" }], details: { instruction: "PRIVATE_DETAILS" } } });
  const later = collect(cursor => capture.read(bindingRef, cursor), available.last.next!);
  expect(later.output.filter(record => record.kind === "tool")).toEqual([
    expect.objectContaining({ parentToolCallId: "parent", payload: expect.objectContaining({ status: "started" }) }),
    expect.objectContaining({ parentToolCallId: "parent", payload: expect.objectContaining({ status: "error",
      args: { public: "arguments" }, isError: true }) }),
  ]);
  expect(later.output.find(record => record.nativeEntryId === image)).toMatchObject({ payload: {
    blocks: [{ type: "omitted", reason: "unsupported_content" }, { type: "text", text: "public text" }] } });
  const serialized = JSON.stringify(later.output);
  for (const forbidden of ["PRIVATE_CUSTOM", "PRIVATE_BINARY", "PRIVATE_DETAILS"]) expect(serialized).not.toContain(forbidden);
  capture.retire();
  expect(() => capture.read(bindingRef, available.last.next!)).toThrow("stale_owner");
}));

test("positional recovery includes persisted tool results and rejects malformed registered messages as capture gaps", () => owned((root, captures) => {
  const manager = SessionManager.create(root, path.join(root, "sessions")), capture = new PublicConversation();
  captures.push(capture); capture.bind(Symbol());
  const generation = capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  const bindingRef = { ...ref, native: { generation, historyId: "history", sessionId: manager.getSessionId() } };
  const assistantId = manager.appendMessage(assistant("before tool"));
  const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "persisted-tool", toolName: "read",
    content: [{ type: "text", text: "persisted result" }], isError: false, timestamp: 3000 });
  capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  const recovered = collect(cursor => capture.read(bindingRef, cursor, true));
  expect(recovered.output.map(record => record.nativeEntryId)).toEqual([assistantId, resultId]);
  expect(recovered.output.at(-1)).toMatchObject({ kind: "tool", toolCallId: "persisted-tool", recovered: true,
    payload: { status: "completed", argsState: "not_captured", result: [{ type: "text", text: "persisted result" }], isError: false } });
  fs.appendFileSync(manager.getSessionFile()!, '{"type":"message","id":42,"message":{"role":"assistant"}}\n');
  let next: string | undefined, malformed!: PublicConversationPage;
  do { malformed = capture.read(bindingRef, next, true); next = malformed.next ?? undefined; } while (next);
  expect(malformed.gaps).toEqual(["capture_failed"]);
}));

for (const evicted of [false, true]) for (const transients of [1, 2, 7])
test(`recovery upsert orders rich tools with ${transients} transients${evicted ? " after unrelated eviction/resync" : ""}`, () => owned((root, captures) => {
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  const capture = new PublicConversation({ worker: 80000, owner: 120000 });
  captures.push(capture); capture.bind(Symbol());
  const generation = capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  const bindingRef = { ...ref, native: { generation, historyId: "history", sessionId: manager.getSessionId() } };
  const before = capture.read(bindingRef).next!;
  const persisted = manager.appendMessage(assistant("before tool"));
  capture.entry(generation, manager.getEntry(persisted)!, false, undefined, 0);
  if (evicted) for (let index = 0; index < 4; index++) {
    const id = manager.appendMessage(assistant("x".repeat(30000)));
    capture.entry(generation, manager.getEntry(id)!, false, undefined, index);
  }
  for (let index = 0; index < transients; index++)
    capture.tool(generation, { type: "tool_execution_start", toolCallId: `transient-${index}`, toolName: "read", args: {} });
  const args = { value: "public-args" };
  capture.tool(generation, { type: "tool_execution_start", toolCallId: "tool", parentToolCallId: "parent",
    toolName: "read", args });
  capture.tool(generation, { type: "tool_execution_update", toolCallId: "tool", toolName: "read", args,
    partialResult: { content: [{ type: "text", text: "live-update" }], details: { private: "PRIVATE_DETAILS" } } });
  capture.tool(generation, { type: "tool_execution_end", toolCallId: "tool", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: "live-result" }], details: {} } });
  const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "tool", toolName: "read",
    content: [{ type: "text", text: "persisted-result" }], isError: false, timestamp: 3000 });
  capture.entry(generation, manager.getEntry(resultId)!, false, undefined, evicted ? 4 : 0);
  capture.tool(generation, { type: "tool_execution_update", toolCallId: "tool", toolName: "read", args,
    partialResult: { content: [{ type: "text", text: "newer-live-update" }], details: {} } });
  const followingIds = Array.from({ length: 3 }, (_, index) => manager.appendMessage(assistant(`after tool ${index}`)));
  capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  if (evicted) expect(capture.read(bindingRef, before).state).toBe("resync_required");
  const available = collect(cursor => capture.read(bindingRef, cursor));
  const rich = available.output.find(record => record.toolCallId === "tool")!;
  const imported = new Map<string, PublicRecord>();
  upsert(imported, available.output);
  const recovered = collect(cursor => capture.read(bindingRef, cursor, true));
  expect(recovered.output.at(-1)).toMatchObject({ nativeEntryId: followingIds.at(-1),
    payload: { blocks: [{ type: "text", text: "after tool 2" }] } });
  expect(recovered.output.find(record => record.id === rich.id)!.revision).toBeGreaterThan(rich.revision);
  upsert(imported, recovered.output);
  const reconciled = imported.get(`${rich.binding}:${rich.id}`)!;
  expect(reconciled).toMatchObject({ id: rich.id, order: rich.order, nativeOrder: rich.nativeOrder,
    nativeEntryId: resultId, parentEntryId: rich.parentEntryId, parentToolCallId: "parent",
    payload: rich.payload });
  expect(reconciled.payload).toMatchObject({ argsState: "available", args: { value: "public-args" },
    result: [{ type: "text", text: "newer-live-update" }] });
  expect(JSON.stringify(recovered.output)).not.toContain("PRIVATE_DETAILS");
  expect(recovered.last.gaps).toContain("not_persisted");
  const assertOrder = (records: PublicRecord[]) => {
    const sorted = [...records].sort((a, b) => a.order - b.order);
    expect(new Set(sorted.map(record => record.order)).size).toBe(sorted.length);
    expect(sorted.filter(record => record.nativeEntryId).map(record => record.nativeEntryId))
      .toEqual(manager.getEntries().filter(entry => entry.type === "message").map(entry => entry.id));
  };
  assertOrder(recovered.output);
  assertOrder([...imported.values()]);
  const repeated = collect(cursor => capture.read(bindingRef, cursor, true));
  upsert(imported, repeated.output);
  assertOrder([...imported.values()]);
  for (const id of followingIds) {
    capture.entry(generation, manager.getEntry(id)!);
    upsert(imported, collect(cursor => capture.read(bindingRef, cursor), available.last.next!).output);
    assertOrder([...imported.values()]);
  }
  capture.tool(generation, { type: "tool_execution_update", toolCallId: "tool", toolName: "read", args,
    partialResult: { content: [{ type: "text", text: "later-live-update" }], details: {} } });
  upsert(imported, collect(cursor => capture.read(bindingRef, cursor), available.last.next!).output);
  assertOrder([...imported.values()]);
  expect(imported.get(`${rich.binding}:${rich.id}`)).toMatchObject({ payload: { argsState: "available", args,
    result: [{ type: "text", text: "later-live-update" }] } });
}));

test("recovery fragments require resync after their rich source is evicted; fresh recovery does not invent lost args", () => owned((root, captures) => {
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  const capture = new PublicConversation({ worker: 120000, owner: 240000 });
  captures.push(capture); capture.bind(Symbol());
  const generation = capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  const bindingRef = { ...ref, native: { generation, historyId: "history", sessionId: manager.getSessionId() } };
  const id = manager.appendMessage(assistant("before tool"));
  capture.entry(generation, manager.getEntry(id)!);
  capture.tool(generation, { type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: { value: "x".repeat(35000) } });
  capture.tool(generation, { type: "tool_execution_end", toolCallId: "tool", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: "result" }], details: {} } });
  manager.appendMessage({ role: "toolResult", toolCallId: "tool", toolName: "read",
    content: [{ type: "text", text: "result" }], isError: false, timestamp: 3000 });
  // An oversized skipped revision moves lostThrough beyond the still-retained tool.
  const oversized = manager.appendMessage(assistant("z".repeat(130000)));
  capture.entry(generation, manager.getEntry(oversized)!);
  capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  const header = capture.read(bindingRef, undefined, true);
  const message = capture.read(bindingRef, header.next!, true);
  const fragment = capture.read(bindingRef, message.next!, true, 26000);
  expect(fragment.changes[0]).toMatchObject({ kind: "fragment" });
  const replacement = manager.appendMessage(assistant("y".repeat(110000)));
  capture.entry(generation, manager.getEntry(replacement)!);
  expect(capture.read(bindingRef, fragment.next!, true)).toMatchObject({
    state: "resync_required", changes: [], gaps: ["evicted", "resync_required"] });
  expect(collect(cursor => capture.read(bindingRef, cursor)).output.every(record => record.kind !== "tool")).toBe(true);
  const fresh = collect(cursor => capture.read(bindingRef, cursor, true));
  expect(fresh.output.find(record => record.kind === "tool")).toMatchObject({ recovered: true,
    payload: { argsState: "not_captured", result: [{ type: "text", text: "result" }] } });
  expect(fresh.last.gaps).toContain("not_persisted");
}));

test("recovery revisions replay immutably and cannot eclipse later live reconciliation", () => owned((root, captures) => {
  const manager = SessionManager.create(root, path.join(root, "sessions")), capture = new PublicConversation();
  captures.push(capture); capture.bind(Symbol());
  const generation = capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  const bindingRef = { ...ref, native: { generation, historyId: "history", sessionId: manager.getSessionId() } };
  const assistantId = manager.appendMessage(assistant("before tool"));
  capture.entry(generation, manager.getEntry(assistantId)!);
  const args = { value: "public".repeat(8000) };
  capture.tool(generation, { type: "tool_execution_start", toolCallId: "tool", parentToolCallId: "parent", toolName: "read", args });
  capture.tool(generation, { type: "tool_execution_end", toolCallId: "tool", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: "result" }], details: {} } });
  const snapshot = collect(cursor => capture.read(bindingRef, cursor)), follow = snapshot.last.next!;
  // Persistence is available while reconciliation of its native ID is pending.
  const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "tool", toolName: "read",
    content: [{ type: "text", text: "result" }], isError: false, timestamp: 3000 });
  capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  try {
    const first = capture.read(bindingRef, undefined, true);
    capture.tool(generation, { type: "tool_execution_update", toolCallId: "tool", toolName: "read", args,
      partialResult: { content: [{ type: "text", text: "update before reservation" }], details: {} } });
    const beforeReservation = collect(cursor => capture.read(bindingRef, cursor), follow);
    const message = capture.read(bindingRef, first.next!, true);
    const fragment = capture.read(bindingRef, message.next!, true, 26000);
    expect(fragment.changes[0]).toMatchObject({ kind: "fragment" });
    capture.tool(generation, { type: "tool_execution_update", toolCallId: "tool", toolName: "read", args,
      partialResult: { content: [{ type: "text", text: "concurrent update" }], details: {} } });
    const recovered = [...message.changes.map(change => {
      if ("kind" in change) throw Error("unexpected message fragment");
      return change.record;
    }), ...collect(cursor => cursor ? capture.read(bindingRef, cursor, true, 26000) : fragment).output];
    expect(capture.read(bindingRef, message.next!, true, 26000)).toEqual(fragment);
    expect(collect(cursor => capture.read(bindingRef, cursor, true), first.next!).output).toEqual(recovered);
    expect(beforeReservation.output.at(-1)!.revision).toBeGreaterThan(recovered.at(-1)!.revision);
    const earlyImported = new Map<string, PublicRecord>();
    upsert(earlyImported, beforeReservation.output); upsert(earlyImported, recovered);
    expect(earlyImported.get(`${generation}:${recovered.at(-1)!.id}`)).toMatchObject({
      payload: { result: [{ type: "text", text: "update before reservation" }] } });
    const imported = new Map<string, PublicRecord>();
    upsert(imported, snapshot.output); upsert(imported, recovered);
    expect(imported.get(`${generation}:${recovered.at(-1)!.id}`)).toMatchObject({
      nativeEntryId: resultId, parentToolCallId: "parent", payload: { argsState: "available", args,
        result: [{ type: "text", text: "result" }] } });
    const concurrent = collect(cursor => capture.read(bindingRef, cursor), follow);
    upsert(imported, concurrent.output);
    expect(imported.get(`${generation}:${recovered.at(-1)!.id}`)).toMatchObject({
      payload: { argsState: "available", args, result: [{ type: "text", text: "concurrent update" }] } });
    expect(concurrent.output.at(-1)!.revision).toBeGreaterThan(recovered.at(-1)!.revision);
    const repeated = collect(cursor => capture.read(bindingRef, cursor, true)).output;
    expect(repeated.at(-1)!.revision).toBeGreaterThan(recovered.at(-1)!.revision);
    capture.entry(generation, manager.getEntry(resultId)!);
    const live = collect(cursor => capture.read(bindingRef, cursor), follow).output.at(-1)!;
    expect(live.id).toBe(recovered.at(-1)!.id);
    expect(live.revision).toBeGreaterThan(repeated.at(-1)!.revision);
    expect(live).toMatchObject({ nativeEntryId: resultId, payload: { argsState: "available", args } });
  } finally { clock.mockRestore(); }
}));

test("old imported pages survive resync as consultation copies outside the closed available sort domain", () => owned((root, captures) => {
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  const capture = new PublicConversation({ worker: 80000, owner: 160000 });
  captures.push(capture); capture.bind(Symbol());
  const generation = capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  const bindingRef = { ...ref, native: { generation, historyId: "history", sessionId: manager.getSessionId() } };
  const firstId = manager.appendMessage(assistant("old persisted message"));
  capture.entry(generation, manager.getEntry(firstId)!);
  capture.tool(generation, { type: "tool_execution_start", toolCallId: "old-transient", toolName: "read",
    args: { value: "keep this imported copy" } });
  const old = collect(cursor => capture.read(bindingRef, cursor));
  const imported = new Map<string, PublicRecord>();
  upsert(imported, old.output);
  const oldTransient = old.output.find(record => record.toolCallId === "old-transient")!;
  for (let index = 0; index < 5; index++) {
    const id = manager.appendMessage(assistant(`persisted ${index} ${"x".repeat(30000)}`));
    capture.entry(generation, manager.getEntry(id)!);
  }
  capture.tool(generation, { type: "tool_execution_start", toolCallId: "present-transient", toolName: "read", args: {} });
  expect(capture.read(bindingRef, old.last.next!)).toMatchObject({ state: "resync_required", changes: [] });
  // The existing wire closes a fresh snapshot with more:false and a follow cursor.
  // Only after that boundary do absent imported IDs leave SORT, never storage.
  const fresh = collect(cursor => capture.read(bindingRef, cursor));
  expect(fresh.first.more).toBe(true);
  expect(fresh.last.cut).toBe(fresh.first.cut);
  expect(fresh.last).toMatchObject({ state: "ready", more: false, capture: { state: "open" } });
  expect(fresh.last.next).toBeString();
  expect(fresh.output.some(record => record.id === oldTransient.id)).toBe(false);
  upsert(imported, fresh.output);
  const sortable = new Set(fresh.output.map(record => `${record.binding}:${record.id}`));
  const recovery = collect(cursor => capture.read(bindingRef, cursor, true));
  expect(recovery.last).toMatchObject({ state: "ready", more: false, next: null });
  expect(recovery.last.gaps).toContain("not_persisted");
  upsert(imported, recovery.output);
  for (const record of recovery.output) sortable.add(`${record.binding}:${record.id}`);
  const oldKey = `${generation}:${oldTransient.id}`;
  expect(imported.get(oldKey)).toEqual(oldTransient);
  expect(sortable.has(oldKey)).toBe(false);
  const current = [...sortable].map(key => imported.get(key)!);
  expect(current.find(record => record.toolCallId === "present-transient")).toMatchObject({ payload: { argsState: "available" } });
  expect(new Set(current.map(record => record.order)).size).toBe(current.length);
  expect(current.sort((a, b) => a.order - b.order).filter(record => record.nativeEntryId).map(record => record.nativeEntryId))
    .toEqual(manager.getEntries().filter(entry => entry.type === "message").map(entry => entry.id));
  expect(current.some(record => record.nativeEntryId === firstId)).toBe(true); // Placeable native copies rejoin SORT.
  expect(imported.size).toBe(current.length + 1);
  // This consumer is a Pitako contract witness, not a Lineage implementation.
}));

test("recovery rebases inverted retained anchors with new revisions without mutating an issued snapshot", () => owned((root, captures) => {
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  const capture = new PublicConversation();
  captures.push(capture); capture.bind(Symbol());
  const generation = capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  const bindingRef = { ...ref, native: { generation, historyId: "history", sessionId: manager.getSessionId() } };
  const args = { value: "large public args ".repeat(2000) };
  capture.tool(generation, { type: "tool_execution_start", toolCallId: "tool", toolName: "read", args });
  const before = manager.appendMessage(assistant("native message before result"));
  capture.entry(generation, manager.getEntry(before)!);
  capture.tool(generation, { type: "tool_execution_end", toolCallId: "tool", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: "rich live result" }], details: {} } });
  const result = manager.appendMessage({ role: "toolResult", toolCallId: "tool", toolName: "read",
    content: [{ type: "text", text: "persisted result" }], isError: false, timestamp: 3000 });
  capture.entry(generation, manager.getEntry(result)!);
  const first = capture.read(bindingRef, undefined, false, 26000);
  expect(first.changes.some(change => "kind" in change && change.kind === "fragment")).toBe(true);
  const snapshot = collect(cursor => cursor ? capture.read(bindingRef, cursor, false, 26000) : first);
  const replayBefore = capture.read(bindingRef, first.next!, false, 26000);
  const recovered = collect(cursor => capture.read(bindingRef, cursor, true));
  expect(recovered.output.map(record => record.nativeEntryId)).toEqual([before, result]);
  expect(recovered.output[0]!.order).toBeLessThan(recovered.output[1]!.order);
  const oldTool = snapshot.output.find(record => record.kind === "tool")!;
  expect(recovered.output[1]).toMatchObject({ payload: oldTool.payload });
  expect(recovered.output[1]!.order).not.toBe(oldTool.order);
  expect(recovered.output[1]!.revision).toBeGreaterThan(oldTool.revision);
  expect(capture.read(bindingRef, first.next!, false, 26000)).toEqual(replayBefore);
  expect(collect(cursor => cursor ? capture.read(bindingRef, cursor, false, 26000) : first).output).toEqual(snapshot.output);
  const rebased = collect(cursor => capture.read(bindingRef, cursor), snapshot.last.next!);
  const imported = new Map<string, PublicRecord>();
  upsert(imported, snapshot.output); upsert(imported, rebased.output); upsert(imported, recovered.output);
  expect([...imported.values()].sort((a, b) => a.order - b.order).map(record => record.nativeEntryId)).toEqual([before, result]);
  capture.tool(generation, { type: "tool_execution_update", toolCallId: "tool", toolName: "read", args,
    partialResult: { content: [{ type: "text", text: "later live update" }], details: {} } });
  const live = collect(cursor => capture.read(bindingRef, cursor), rebased.last.next!);
  expect(live.output[0]).toMatchObject({ order: recovered.output[1]!.order, nativeEntryId: result,
    payload: { args, result: [{ type: "text", text: "later live update" }] } });
  expect(live.output[0]!.revision).toBeGreaterThan(recovered.output[1]!.revision);
}));

test("recovery recipes and recovery-only placements are bounded and report loss without journal eviction", () => owned((root, captures) => {
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  for (let index = 0; index < 100; index++) manager.appendMessage(assistant(`persisted ${index}`));
  const capture = new PublicConversation({ worker: 5000, owner: 10000 });
  captures.push(capture); capture.bind(Symbol());
  const generation = capture.binding("history", manager.getSessionId(), manager.getSessionFile());
  const bindingRef = { ...ref, native: { generation, historyId: "history", sessionId: manager.getSessionId() } };
  const follow = capture.read(bindingRef).next!;
  const headers = Array.from({ length: 400 }, () => capture.read(bindingRef, undefined, true));
  expect(headers.every(page => page.state === "ready" && page.changes.length === 0)).toBe(true);
  expect(capture.read(bindingRef, headers[0]!.next!, true)).toMatchObject({
    state: "resync_required", changes: [], gaps: ["evicted", "resync_required"] });
  const recovery = collect(cursor => capture.read(bindingRef, cursor, true), headers.at(-1)!.next!);
  expect(recovery.output.length).toBeGreaterThan(0);
  expect(recovery.output.length).toBeLessThan(100);
  expect(recovery.last).toMatchObject({ state: "resync_required", changes: [], gaps: ["evicted", "resync_required"] });
  expect(capture.metadata(ref).sequence).toBe(0); // No capture journal record existed to trigger lostThrough.
  expect(capture.read(bindingRef, follow)).toMatchObject({ state: "resync_required", changes: [] });
  expect(capture.read(bindingRef)).toMatchObject({ state: "ready", changes: [], gaps: ["evicted"] });
}));
