import { expect, test } from "bun:test";
import { createArchitectureSnapshots } from "../extensions/architecture/rooms.ts";
import { capabilities, isDescriptor, isReply, isRequest, isPublicArchitectureBody, isArchitectureRecord, replyBytes, success } from "../extensions/agent/bridge/protocol.js";
import type { Request } from "../extensions/agent/bridge/protocol.js";

const owner = { processId: "process", coordinatorSessionId: "owner", epoch: "epoch" };
const ref = { ...owner, kind: "architecture" as const, roomId: "room" };
const capture = { state: "open", finalCut: null, gaps: [] };
const envelope = <M extends Request["method"], P>(method: M, params: P) => ({ version: 2 as const, id: "request", clientId: "client", owner, method, params });
const source = (records: unknown[]) => () => ({ header: { ref, capture }, records });
const record = (text: string) => ({ kind: "failure", id: "failure", phase: "turn", error: text });

test("architecture capability group is complete, canonical, optional on both descriptor and connect", () => {
  const descriptor = { version: 2, transport: "unix", socket: "/tmp/bridge", token: "a".repeat(64), owner, capabilities };
  const connect = (group: readonly string[]) => success(envelope("connect", { token: "a".repeat(64), expectedSessionId: "owner" }), { capabilities: group, lease: { clientId: "client", resumeToken: "b".repeat(64) } });
  for (const group of [capabilities, capabilities.slice(0, 13), capabilities.slice(0, 16)]) {
    expect(isDescriptor({ ...descriptor, capabilities: group })).toBe(true);
    expect(isReply(connect(group), "connect")).toBe(true);
  }
  for (const group of [capabilities.slice(0, 14), capabilities.slice(0, 15), [...capabilities].reverse(), [...capabilities, "architecture.list"], [...capabilities.slice(0, 13), "architecture.public-v2"]]) {
    expect(isDescriptor({ ...descriptor, capabilities: group })).toBe(false);
    expect(isReply(connect(group), "connect")).toBe(false);
  }
  expect(isRequest(envelope("architecture.read", { ref }))).toBe(true);
  for (const bad of [{ ...ref, kind: "read" }, { ...ref, extra: true }, { ...ref, epoch: "" }, { ...ref, roomId: 1 }])
    expect(isRequest(envelope("architecture.read", { ref: bad }))).toBe(false);
  expect(isRequest(envelope("architecture.list", { cursor: 4 }))).toBe(false);
});

test("typed body validators retain all protocol variants and reject UI/provisional/persistence substitutions", () => {
  const bodies = [
    { kind: "composition", snapshotId: "snapshot", reason: "Director alone", specialists: [] },
    { kind: "composition", snapshotId: "snapshot", reason: "Selective change", specialists: [
      { kind: "retain", memberId: "existing", mandate: "Updated focus", reason: "Continuity" },
      { kind: "add", candidateRef: "general:0", mandate: "New focus", reason: "Missing expertise" },
    ] },
    // Historical decoder forms are not live submit schemas.
    { kind: "composition", snapshotId: "snapshot", specialists: [{ candidateRef: "general:0", mandate: "task", reason: "reason" }] },
    { kind: "preparation", analysis: "analysis", doubts: [] },
    { kind: "contribution", proposal: "proposal", arguments: [], objections: [{ memberId: "other", messageId: "publication", argument: "why" }], doubts: [] },
    { kind: "decision", action: "recompose", reason: "reason" },
    { kind: "answer", answer: "answer", evidence: [], limits: [], doubts: [] },
    { kind: "consultation-plan", resolutions: [], support: [{ role: "oracle", brief: "task", doubtIds: ["doubt"], prerequisites: [] }] },
    { kind: "consultation-response", doubtIds: ["doubt"], answer: "answer", evidence: [], limits: [], doubts: [] },
    { kind: "knowledge", resolutions: [{ doubtId: "doubt", status: "partial", answer: "answer", supportIds: ["support"] }] },
    { kind: "synthesis", status: "complete", recommendation: "recommendation", alternatives: [], evidence: [], assumptions: [], disagreements: [], pending: [] },
  ];
  for (const body of bodies) {
    expect(isPublicArchitectureBody(body)).toBe(true);
    expect(isPublicArchitectureBody({ ...body, ui: "renamed" })).toBe(false);
    const message = { id: "publication", ordinal: 1, roomId: "room", assignmentId: "assignment", memberId: "member", author: "architect", stage: body.kind,
      snapshotId: "snapshot", turnId: "turn", attemptId: "attempt", body, native: { sessionId: "session", toolCallId: "submit", persistence: "unconfirmed" }, doubts: [] };
    expect(isArchitectureRecord({ kind: "publication", id: message.id, message })).toBe(true);
    expect(isArchitectureRecord({ kind: "publication", id: message.id, message: { ...message, native: { ...message.native, persistence: "confirmed" } } })).toBe(false);
  }
  for (const bad of [{ kind: "provisional" }, { kind: "synthesis", recommendation: "only prose" }, { kind: "contribution", arguments: [42] }]) expect(isPublicArchitectureBody(bad)).toBe(false);
  const choice = { kind: "retain", memberId: "existing", mandate: "Focus", reason: "Continuity" };
  for (const body of [
    { kind: "composition", snapshotId: "snapshot", specialists: [] },
    { kind: "composition", snapshotId: "snapshot", reason: "", specialists: [] },
    { kind: "composition", snapshotId: "snapshot", reason: "Too many", specialists: Array(6).fill(choice) },
    { kind: "composition", snapshotId: "snapshot", reason: "Mixed union", specialists: [{ ...choice, candidateRef: "general:0" }] },
    { kind: "composition", snapshotId: "snapshot", reason: "Missing tag", specialists: [{ candidateRef: "general:0", mandate: "Focus", reason: "New" }] },
  ]) expect(isPublicArchitectureBody(body)).toBe(false);
  expect(isArchitectureRecord({ kind: "outcome", id: "final", source: "background-settlement", status: "completed", content: { kind: "text", text: "settled" } })).toBe(true);
});

test("current roster provenance and historical room/catalog/waiting records decode through isReply", () => {
  const lifecycle = { stage: "waiting", round: 1, protocolState: "waiting", outcome: "pending",
    closure: { state: "pending", members: "pending", director: "pending" } };
  const director = { memberId: "director", assignmentId: "assignment", instanceId: "instance" };
  const room = { kind: "room", id: "room", origin: { coordinatorSessionId: "owner", tool: "architecture_start", toolCallId: "start", ...director },
    goalSource: { kind: "worker-workbrief", instanceId: "instance" }, lifecycle, pendingDoubtIds: [] };
  for (const mode of [undefined, "table", "consultation"]) {
    const legacy = mode === undefined ? {} : { mode };
    const catalog = { format: "architecture-public-v1", state: "ready", owner, snapshotId: "snapshot", cut: 1,
      items: [{ ref, director, lifecycle, ...legacy }], next: null };
    expect(isReply(success(envelope("architecture.list", {}), catalog), "architecture.list")).toBe(true);
    expect(isReply(success(envelope("architecture.read", { ref }), {
      format: "architecture-public-v1", state: "ready", ref, snapshotId: "snapshot", cut: 1, capture, records: [{ ...room, ...legacy }], next: null,
    }), "architecture.read")).toBe(true);
  }
  const member = { kind: "member", id: "member", assignmentId: "assignment", instanceId: "instance", roleId: "architect", function: "specialist",
    ordinal: 1, admittedAt: 1, mandate: { source: "composition", text: "Current task" }, execution: "running", conversationRefs: [],
    compositionMessageId: "admitted", compositionChoiceIndex: 0, selection: { compositionMessageId: "retained", choiceIndex: 1 } };
  for (const state of ["preparing", "active", "closing", "closed", "closure-unknown"]) expect(isArchitectureRecord({ ...member, state })).toBe(true);
  for (const invalid of [{ compositionChoiceIndex: -1 }, { selection: { compositionMessageId: "retained", choiceIndex: -1 } }, { state: "released" }])
    expect(isArchitectureRecord({ ...member, ...invalid })).toBe(false);
  expect(isArchitectureRecord({ ...member, selection: { ...member.selection, ui: true } })).toBe(false);
});

test("frozen Unicode byte pages replay exact cuts, bind view/room and authenticate cursors", () => {
  const store = createArchitectureSnapshots(owner), view = store.view(), other = store.view();
  const original = record('漢字🧠\r\n"\\'.repeat(7000)), records = [original];
  const first: any = view.read("room", undefined, 11, source(records));
  expect(first.next).toBeString(); expect(first.cut).toBe(11);
  records[0] = record("execution advanced"); capture.gaps.push("capture_failed" as never);
  const replay: any = view.read("room", first.next, 900, () => { throw Error("continuation read live authority"); });
  expect(replay.cut).toBe(11); expect(replay.capture.gaps).toEqual([]);
  expect(view.read("room", first.next, 999, source(records))).toEqual(replay);
  expect(() => other.read("room", first.next, 12, source(records))).toThrow("invalid_cursor");
  expect(() => view.read("other", first.next, 12, source(records))).toThrow("invalid_cursor");
  expect(() => view.read("room", first.next.slice(0, -1) + "!", 12, source(records))).toThrow("invalid_cursor");
  const chunks: Buffer[] = []; let page = first, lastCursor: string | undefined;
  for (;;) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(40 * 1024);
    expect(isReply(success(envelope("architecture.read", { ref }), page), "architecture.read")).toBe(true);
    for (const fragment of page.records) {
      expect(fragment.byteOffset).toBe(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      const chunk = Buffer.from(fragment.data, "base64"); expect(chunk.length).toBeLessThanOrEqual(12 * 1024); chunks.push(chunk);
    }
    if (!page.next) break;
    lastCursor = page.next; page = view.read("room", lastCursor, 100, source(records));
  }
  expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual(original);
  expect(view.read("room", lastCursor, 999, source(records))).toEqual(page); // final page did not consume storage
  view.read("different", undefined, 12, source([]));
  expect(() => view.read("room", first.next, 12, source(records))).toThrow("stale_cursor");
  capture.gaps.length = 0; view.close(); other.close(); store.clear();
});

test("snapshot retention bounds use lazy creation age, replace only own class, and never evict another consumer", () => {
  let now = 0;
  const store = createArchitectureSnapshots(owner, { snapshotBytes: 1900, ownerBytes: 3800, ttl: 300_000 }, () => now);
  const first = store.view(), second = store.view();
  const data = source([record("x".repeat(1500))]);
  const a: any = first.read("room", undefined, 1, data, 1100);
  const b: any = second.read("room", undefined, 1, data, 1100);
  expect(a.state).toBe("ready"); expect(b.state).toBe("ready");
  expect(first.read(null, undefined, 2, () => ({ header: { owner }, records: [record("c".repeat(1500))] }), 1100)).toEqual({ state: "unavailable", reason: "snapshot_oversized" });
  expect(first.read("room", a.next, 2, data, 1100)).toHaveProperty("snapshotId", a.snapshotId);
  expect(second.read("room", b.next, 2, data, 1100)).toHaveProperty("snapshotId", b.snapshotId);
  expect(first.read("room", undefined, 2, source([record("x".repeat(1901))]))).toEqual({ state: "unavailable", reason: "snapshot_oversized" });
  second.close();
  const catalog: any = first.read(null, undefined, 2, () => ({ header: { owner }, records: [] }));
  expect(catalog.items).toEqual([]); // empty captured catalog, not not_captured
  expect(first.read("room", a.next, 2, data, 1100)).toHaveProperty("snapshotId", a.snapshotId); // catalog never replaced room snapshot
  now = 299_999;
  expect(first.read("room", a.next, 2, data, 1100)).toHaveProperty("snapshotId", a.snapshotId);
  now = 300_000;
  expect(() => first.read("room", a.next, 2, data, 1100)).toThrow("stale_cursor");
  const fresh: any = first.read("room", undefined, 3, data, 1100); first.close();
  expect(() => first.read("room", fresh.next, 4, data, 1100)).toThrow("stale_cursor");
  expect(first.read("absent", undefined, 4, () => undefined)).toEqual({ state: "unavailable", reason: "unknown_room" });
  expect(() => first.read(null, undefined, 4, () => ({ header: { owner }, records: [] }), 1)).toThrow("envelope");
  expect(first.read(null, undefined, 4, () => undefined)).toEqual({ state: "unavailable", reason: "not_captured" });
  store.clear();
});

test("exact escaped bridge envelope leaves room for fragments below both caps", () => {
  const escapedOwner = { ...owner, coordinatorSessionId: '"'.repeat(1024) };
  const request = { ...envelope("architecture.read", { ref: { ...ref, ...escapedOwner } }), owner: escapedOwner, id: '"'.repeat(128), clientId: '"'.repeat(128) };
  const budget = Math.min(40 * 1024, replyBytes - Buffer.byteLength(JSON.stringify(success(request, null))) + 3);
  const view = createArchitectureSnapshots(escapedOwner).view();
  const page: any = view.read("room", undefined, 1, () => ({ header: { ref: { ...ref, ...escapedOwner }, capture }, records: [record("🧠".repeat(20_000))] }), budget);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(40 * 1024);
  expect(Buffer.byteLength(JSON.stringify(success(request, page)) + "\n")).toBeLessThanOrEqual(replyBytes);
  expect(page.records.length).toBeGreaterThan(0);
});
