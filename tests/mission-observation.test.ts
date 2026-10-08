import { afterEach, expect, test as nativeTest } from "bun:test";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { observationAdapters, observationFiles, observationFixture } from "./mission-observation-fixture.ts";
import { readMissionObservation } from "../extensions/mission/observation.ts";
import { registerExecution, unregisterExecution } from "../extensions/execution-identity.ts";
import { childActiveTools } from "../extensions/profile.ts";
import { registerMissionExtension } from "../extensions/mission/index.ts";
import { agentScope } from "../extensions/agent/scope.ts";

const original = process.env.PI_CODING_AGENT_DIR;
const fixtures: Awaited<ReturnType<typeof observationFixture>>[] = [];
// Native timeout does not settle an async callback or transfer fixture ownership.
const callbacks = new Set<Promise<void>>();
function test(name: string, body: () => Promise<void>, timeout?: number) {
  nativeTest(name, async () => {
    const callback = body();
    callbacks.add(callback);
    try { await callback; }
    finally { callbacks.delete(callback); }
  }, timeout);
}
afterEach(async () => {
  await Promise.allSettled([...callbacks]);
  for (const sample of fixtures.splice(0)) {
    sample.store.close(); rmSync(sample.fixture.base, { recursive: true, force: true });
  }
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = original;
}, 15000);
async function sample() {
  const value = await observationFixture(); fixtures.push(value); return value;
}
async function collect(api: ReturnType<typeof observationAdapters>, query: any) {
  const items: any[] = [], pages: any[] = [];
  let cursor: string | undefined = query.cursor;
  do {
    const page = await api.toolPage({ ...query, cursor });
    expect(await api.command({ ...query, cursor })).toEqual(page);
    expect(page.authority).toBe("read-only");
    pages.push(page); items.push(...page.items);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return { items, pages };
}
async function bytes(api: ReturnType<typeof observationAdapters>, query: any, cursor: string) {
  const result = await collect(api, { ...query, cursor });
  const chunks = result.items.map((row) => Buffer.from(row.data, "base64"));
  expect(result.items.every((row, index) => row.byteOffset === chunks.slice(0, index).reduce((n, chunk) => n + chunk.length, 0))).toBe(true);
  return Buffer.concat(chunks);
}

test("assignment observation preserves principal-only worker-history disclosure", async () => {
  const f = await sample(), api = observationAdapters(f.executionRoot);
  let command: Function;
  registerMissionExtension({
    on() {}, registerTool() {},
    registerCommand: (_name: string, value: { handler: Function }) => { command = value.handler; },
  } as any);
  const context = {
    get cwd(): string { throw new Error("mission lookup reached before principal guard"); },
    hasUI: false, sessionManager: { getSessionId: () => "reloaded-principal" },
  };
  const query = { missionId: f.mission.id, unitId: f.unit.id, attemptId: f.earlierAttempt };
  const listing = await collect(api, query);
  const member = listing.items.find((row) => row.kind === "native-history");
  const rejectCommand = async () => {
    // A plan selector requires lookup; a bound native cursor would disclose history.
    for (const args of [`inspect ${f.mission.planId}`,
      `inspect ${f.mission.id} --unit ${f.unit.id} --attempt ${f.earlierAttempt} --cursor ${member.readCursor}`]) {
      await expect(command!(args, context)).rejects.toThrow("inspect requires a principal session");
    }
  };
  expect(childActiveTools(["read", "agent_history", "mission_observe"])).toEqual(["read"]);
  registerExecution({ instanceId: "worker", roleId: "developer", sessionId: "reloaded-principal" });
  const before = observationFiles(f.fixture.base);
  try {
    await expect(api.toolPage({ missionId: f.mission.id })).rejects.toThrow("requires a principal session");
    await rejectCommand();
    expect(observationFiles(f.fixture.base)).toEqual(before);
  } finally { unregisterExecution("reloaded-principal"); }
  const instanceId = process.env.PITAKO_INSTANCE_ID;
  try {
    process.env.PITAKO_INSTANCE_ID = "herdr-child";
    await rejectCommand();
  } finally {
    if (instanceId === undefined) delete process.env.PITAKO_INSTANCE_ID;
    else process.env.PITAKO_INSTANCE_ID = instanceId;
  }
  await agentScope.run({ instanceId: "sdk-child" }, rejectCommand);
  expect(observationFiles(f.fixture.base)).toEqual(before);
  expect((await api.toolPage({ missionId: f.mission.id })).authority).toBe("read-only");
  let principalText = "";
  // SDK principals need no native operator UI eligibility to read.
  await command!(`inspect ${f.mission.id} --unit ${f.unit.id} --attempt ${f.earlierAttempt} --cursor ${member.readCursor}`, {
    cwd: f.executionRoot, hasUI: true, sessionManager: context.sessionManager,
    ui: { notify(text: string) { principalText = text; } },
  });
  expect(JSON.parse(principalText)).toEqual(await api.toolPage({ ...query, cursor: member.readCursor }));
  expect(await bytes(api, query, member.readCursor)).toEqual(f.nativeBytes);
  expect(observationFiles(f.fixture.base)).toEqual(before);
});

// Lossless tool/command pagination of the 72811-byte brief exceeds the 5s default.
test("principal tool/inspect retain earlier assignment, revision, full brief, raw actions/results and host evidence across reload without writes", async () => {
  const f = await sample(), api = observationAdapters(f.executionRoot);
  const before = observationFiles(f.fixture.base), ownerEpoch = f.store.ownerEpoch;
  const query = { missionId: f.mission.id, unitId: f.unit.id };
  const all = await collect(api, query);
  expect(all.items.filter((item) => item.kind === "revision").map((item) => item.revision)).toEqual([1, 2]);
  expect(all.items.filter((item) => item.kind === "attempt").map((item) => item.assignmentId)).toEqual([f.earlierAttempt, f.currentAttempt]);
  expect(all.items.find((item) => item.assignmentId === f.currentAttempt).retryOf).toBe(f.earlierAttempt);
  const selected = { ...query, attemptId: f.earlierAttempt };
  const earlier = await collect(api, selected);
  expect(earlier.items.filter((item) => item.kind === "attempt").map((item) => item.assignmentId)).toEqual([f.earlierAttempt]);
  expect(earlier.items.some((item) => item.historyId === f.earlier.historyId)).toBe(true);
  expect(earlier.items.some((item) => item.attemptId === f.currentAttempt)).toBe(false);
  const assignment = earlier.items.find((item) => item.kind === "assignment");
  const source = earlier.items.find((item) => item.kind === "original-source");
  expect((await bytes(api, selected, source.source.readCursor)).toString()).toContain("### T1 — Setup and GATES");
  expect((await bytes(api, selected, assignment.originalIntent.objective.readCursor)).toString())
    .toBe(f.unit.originalIntent!.objective);
  const brief = await bytes(api, selected, assignment.originalIntent.workBrief.readCursor);
  expect(brief.toString()).toBe(f.unit.originalIntent!.workBrief);
  expect(brief.length).toBeGreaterThan(32768);
  const reserved = earlier.items.find((item) => item.kind === "attempt");
  expect(await bytes(api, selected, reserved.reservedBrief.readCursor)).toEqual(brief);
  const member = earlier.items.find((item) => item.kind === "native-history");
  expect(await bytes(api, selected, member.readCursor)).toEqual(f.nativeBytes);
  const receipt = earlier.items.find((item) => item.action === "attempt.receipt");
  expect(await bytes(api, selected, receipt.evidence[0].readCursor)).toEqual(f.hostReport);
  const fullReceipt = JSON.parse((await bytes(api, selected, receipt.detailsRef.readCursor)).toString());
  expect(fullReceipt.details.status).toBe("failed");
  const reload = observationAdapters(f.executionRoot);
  const continuation = await api.toolPage({ ...selected, cursor: assignment.originalIntent.workBrief.readCursor });
  expect(continuation.cursor).not.toBeNull();
  expect(await reload.command({ ...selected, cursor: continuation.cursor })).toEqual(
    await api.toolPage({ ...selected, cursor: continuation.cursor }));
  expect(await bytes(reload, selected, member.readCursor)).toEqual(f.nativeBytes);
  expect(f.store.ownerEpoch).toBe(ownerEpoch);
  expect(observationFiles(f.fixture.base)).toEqual(before);
  expect(JSON.stringify(earlier)).not.toContain("writable-handle-not-returned");
}, 15000);

test("observation diagnoses missing/pruned/not-created/incomplete separately and preserves private native text", async () => {
  const f = await sample(), api = observationAdapters(f.executionRoot);
  const query = { missionId: f.mission.id, unitId: f.unit.id, attemptId: f.earlierAttempt };
  const listing = await collect(api, query), member = listing.items.find((row) => row.kind === "native-history");
  renameSync(f.native, `${f.native}.saved`);
  expect((await api.toolPage({ ...query, cursor: member.readCursor })).diagnostics.map((row: any) => row.code)).toContain("native_missing");
  renameSync(`${f.native}.saved`, f.native);
  writeFileSync(f.native, readFileSync(f.native).subarray(0, f.nativeBytes.length - 5));
  const partial = await collect(api, { ...query, cursor: member.readCursor });
  expect(partial.pages.flatMap((page) => page.diagnostics.map((row: any) => row.code))).toContain("partial_tail");
  f.history.mutate(f.group.groupId, (group) => { group.members[0]!.native = { state: "pruned" }; });
  expect((await api.toolPage({ ...query, cursor: member.readCursor })).diagnostics.map((row: any) => row.code)).toContain("history_pruned");
  f.history.mutate(f.group.groupId, (group) => { group.members[0]!.native = { state: "not-created" }; });
  expect((await api.toolPage({ ...query, cursor: member.readCursor })).diagnostics.map((row: any) => row.code)).toContain("native_not_created");
  rmSync(path.join(f.fixture.objectDir, f.reportHash.slice(0, 2), f.reportHash));
  const receipt = listing.items.find((row) => row.action === "attempt.receipt");
  expect((await api.toolPage({ ...query, cursor: receipt.evidence[0].readCursor })).diagnostics.map((row: any) => row.code)).toContain("evidence_unavailable");
});

test("selectors and read cursors reject cross-repository/mission/unit/attempt, forged evidence and arbitrary history IDs", async () => {
  const f = await sample(), api = observationAdapters(f.executionRoot);
  // An unrelated catalog with unavailable authority must not contaminate this
  // selected mission's results or diagnostics.
  const foreign = f.history.missionGroup(f.executionRoot, randomUUID(), {
    dbPath: f.fixture.dbPath,
    objectDir: f.fixture.objectDir,
    sessionsDirectory: path.dirname(f.native),
  }, false);
  const query = { missionId: f.mission.id, unitId: f.unit.id };
  const listing = await collect(api, query), member = listing.items.find((row) => row.kind === "native-history");
  expect(listing.items.some((row) => row.groupId === foreign.groupId)).toBe(false);
  expect((await readMissionObservation(query, f.fixture.root)).diagnostics[0]!.code).toBe("ok");
  expect((await readMissionObservation({ ...query, cursor: member.readCursor }, f.fixture.root))
    .diagnostics[0]!.code).toBe("invalid_cursor");
  expect((await readMissionObservation(query, f.fixture.base)).diagnostics[0]!.code).toContain("not a git repository");
  expect((await api.toolPage({ ...query, missionId: randomUUID() })).diagnostics[0].code).toContain("mission not found");
  expect((await api.toolPage({ ...query, unitId: "unknown" })).diagnostics[0].code).toBe("unit_not_found");
  expect((await api.toolPage({ ...query, attemptId: randomUUID() })).diagnostics[0].code).toBe("attempt_not_found");
  expect((await api.toolPage({ ...query, attemptId: f.currentAttempt, cursor: member.readCursor })).diagnostics[0].code).toBe("invalid_cursor");
  const tamper = (cursor: string, change: any) => Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(cursor, "base64url").toString()), ...change })).toString("base64url");
  expect((await api.toolPage({ ...query, cursor: tamper(member.readCursor, { historyId: randomUUID() }) })).diagnostics[0].code).toBe("history_membership_unavailable");
  expect((await api.toolPage({ ...query, cursor: tamper(member.readCursor, { groupId: randomUUID() }) })).diagnostics[0].code).toBe("history_membership_unavailable");
  const assignment = listing.items.find((row) => row.kind === "assignment");
  expect((await api.toolPage({ ...query, cursor: tamper(assignment.originalIntent.workBrief.readCursor,
    { reference: { hash: "a".repeat(64) } }) })).diagnostics[0].code).toBe("unbound_evidence_reference");
  expect((await api.toolPage({ ...query, cursor: "garbage" })).diagnostics[0].code).toBe("invalid_cursor");
});
