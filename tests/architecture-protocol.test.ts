import { expect, test } from "bun:test";
import { architectureFixture } from "./fixtures/architecture.ts";
import { participant } from "../extensions/architecture/types.ts";
import { planComposition, type Composition, type CompositionBasis } from "../extensions/table/composition.ts";
import { validateSubmission } from "../extensions/architecture/protocol.ts";
import { validateReview } from "../extensions/review/policy.ts";

const { fixture, setup } = architectureFixture();
const submit = (session: any, id: string, body: any) => session.boundTools.get("architecture_submit").execute(id, { submissionId: id, body }, undefined, undefined, { sessionManager: session.sessionManager });
const doubt = (index: number) => ({ question: `Question ${index}`, purpose: "Original coverage" });
const response = (request: any) => ({ kind: "consultation-response", doubtIds: request.context.request.doubtIds, answer: "Evidence", evidence: [], limits: [], doubts: [] });
const contribution = { kind: "contribution", proposal: "Bounded design", arguments: [], objections: [], doubts: [] };
type LocalRecord = { id: string; stage?: string; kind?: string; author?: string;
  body?: { resolutions?: { doubtId: string }[] } };
test("shared composition validates the frozen total set for architecture and review", () => {
  const basis: CompositionBasis = { snapshotId: "frozen", candidateRefs: ["candidate"], retainableMemberIds: ["one", "two"] };
  const body: Composition = { kind: "composition", snapshotId: "frozen", reason: "Choose total roster", specialists: [
    { kind: "retain", memberId: "two", mandate: "Updated", reason: "Continuity" },
    { kind: "add", candidateRef: "candidate", mandate: "Fresh", reason: "Independence" },
    { kind: "add", candidateRef: "candidate", mandate: "Another", reason: "Independent same policy" },
  ] };
  expect(planComposition(body, basis)).toEqual({ retained: [{ memberId: "two", choiceIndex: 0 }],
    added: [{ candidateRef: "candidate", choiceIndex: 1 }, { candidateRef: "candidate", choiceIndex: 2 }], retiringMemberIds: ["one"] });
  expect(planComposition({ ...body, specialists: [] }, basis).retiringMemberIds).toEqual(["one", "two"]);
  const grant = { roomId: "room", assignmentId: "assignment", memberId: "director", snapshotId: "frontier", round: 1,
    rules: { kind: "composition" as const, ...basis } };
  const reviewGrant = { ...grant, findings: [], responses: [], references: [], partialReasons: [] };
  for (const bad of [
    { ...body, snapshotId: "stale" },
    { ...body, specialists: [body.specialists[0], body.specialists[0]] },
    { ...body, specialists: [{ kind: "retain", memberId: "closed", mandate: "M", reason: "R" }] },
    { ...body, specialists: [{ kind: "add", candidateRef: "missing", mandate: "M", reason: "R" }] },
    { ...body, specialists: Array(6).fill(body.specialists[1]) },
    { ...body, specialists: [{ kind: "add", candidateRef: "candidate", mandate: "M", reason: "R", memberId: "one" }] },
    { ...body, reason: " \t" },
    { ...body, specialists: [{ kind: "add", candidateRef: "candidate", mandate: " ", reason: "R" }] },
    { ...body, specialists: [{ kind: "retain", memberId: "director", mandate: "M", reason: "R" }] },
    { ...body, specialists: [{ kind: "retain", memberId: "support", mandate: "M", reason: "R" }] },
  ]) {
    expect(() => planComposition(bad as Composition, basis)).toThrow();
    expect(() => validateSubmission(grant, { submissionId: "bad", body: bad })).toThrow();
    expect(() => validateReview(reviewGrant, { submissionId: "bad", body: bad })).toThrow();
  }
});
async function localRecords(s: Awaited<ReturnType<typeof setup>>, roomId: string, first?: any) {
  return (await s.read("architecture_read", { roomId }, first)).messages;
}

test("eleven original doubts reject an oracle twelfth before receipt, then settle eleven in the same grant", fixture.ownedCase("protocol eleven plus one", async () => {
  let original: any[] = [], deferredId: string | undefined, rejected = 0, supportCalls = 0;
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "preparation") return { kind: "preparation", analysis: "Eleven originals", doubts: session.model.id === "director" ? [] : Array.from({ length: 11 }, (_, i) => doubt(i)) };
    if (request.stage === "consultation-plan") {
      original = request.context.doubts; expect(original).toHaveLength(11);
      return { kind: "consultation-plan", resolutions: [], support: [{ role: "oracle", brief: "Resolve originals", doubtIds: original.map(d => d.id), prerequisites: [] }] };
    }
    if (request.stage === "consultation-response") { supportCalls++; return { ...response(request), doubts: [{ question: "Twelfth", purpose: "Later cycle only" }] }; }
    if (request.stage === "knowledge") {
      expect(request.context.delegatedDoubtIds).toEqual(original.map(d => d.id)); expect(request.context.deferredDoubtIds).toHaveLength(1);
      deferredId = request.context.deferredDoubtIds[0];
      expect(request.context.doubts.map((d: any) => d.id)).toEqual(original.map(d => d.id));
      expect(request.context.responses[0].message.body.doubts[0]).toMatchObject({ id: deferredId, question: "Twelfth", purpose: "Later cycle only" });
      const resolutions = original.map(d => ({ doubtId: d.id, status: "answered", answer: "Resolved", supportIds: [request.context.responses[0].id] }));
      const invalid = { kind: "knowledge", resolutions: [...resolutions, { ...resolutions[0], doubtId: deferredId }] };
      const first = await submit(session, "twelve", invalid), repeated = await submit(session, "twelve", structuredClone(invalid));
      expect(first.isError).toBe(true); expect(first.details).toMatchObject({ code: "reference", stage: "knowledge", badIds: [deferredId], correctionsLeft: 1 });
      expect(repeated).toEqual(first); rejected++;
      return { kind: "knowledge", resolutions };
    }
    if (request.stage === "contribution") {
      const boundary = request.context.shared.knowledgeBoundaries[0]; expect(boundary.resolutions.map((r: any) => r.doubtId)).toEqual(original.map(d => d.id));
      return contribution;
    }
    if (request.stage === "decision") return { kind: "decision", action: "synthesize", reason: "No recursion" };
    if (request.stage === "synthesis") {
      expect(request.context.pendingDoubts.map((d: any) => d.id)).toEqual([deferredId]);
      expect(request.context.knowledgeBoundaries[0].resolutions).toHaveLength(11);
      return { ...body, status: "partial", pending: ["Twelfth deferred"] };
    }
    return body;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Eleven original doubts" }); await s.delivered.promise;
    expect(rejected).toBe(1); expect(supportCalls).toBe(1);
    const records = await localRecords(s, start.details.roomId), knowledge = records.filter((r: LocalRecord) => r.stage === "knowledge"), boundaries = records.filter((r: LocalRecord) => r.kind === "knowledge-boundary");
    expect(knowledge).toHaveLength(1); expect(knowledge[0].body.resolutions).toHaveLength(11); expect(knowledge[0].native.toolCallId).toBe("native-submit");
    expect(boundaries).toHaveLength(1); expect(boundaries[0].knowledgeMessageId).toBe(knowledge[0].id);
    expect(records.some((r: LocalRecord) => r.body?.resolutions?.some((item: any) => item.doubtId === deferredId))).toBe(false);
  } finally { await s.close(); }
}));

for (const directOnly of [false, true]) test(`${directOnly ? "all-direct" : "delegated"} boundary reaches following contribution, synthesis and frozen local cursor`, fixture.ownedCase(`table boundary ${directOnly}`, async () => {
  let firstBoundary: any, frozen: any;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  fixture.finishOnCleanup(release.resolve);
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "preparation") return { ...body, doubts: session.model.id === "director" ? [] : [doubt(0), doubt(1)] };
    if (request.stage === "consultation-plan" && !request.context.doubts.length) return { kind: "consultation-plan", resolutions: [], support: [] };
    if (request.stage === "consultation-plan") return { kind: "consultation-plan",
      resolutions: request.context.doubts.slice(0, directOnly ? 2 : 1).map((d: any) => ({ doubtId: d.id, status: "answered", answer: "Direct" })),
      support: directOnly ? [] : [{ role: "scout", brief: "One delegated", doubtIds: [request.context.doubts[1].id], prerequisites: [] }] };
    if (request.stage === "consultation-response") return response(request);
    if (request.stage === "knowledge") return { kind: "knowledge", resolutions: request.context.delegatedDoubtIds.map((id: string) => ({ doubtId: id, status: "answered", answer: "Delegated", supportIds: [request.context.responses[0].id] })) };
    if (request.stage === "contribution") {
      firstBoundary ??= request.context.shared.knowledgeBoundaries[0];
      expect(request.context.shared.knowledgeBoundaries[0]).toEqual(firstBoundary);
      entered.resolve(); await release.promise;
    }
    if (request.stage === "decision") return { ...body, action: request.round === 1 ? "consult" : "synthesize" };
    if (request.stage === "synthesis") {
      expect(request.context.knowledgeBoundaries).toHaveLength(2); expect(request.context.knowledgeBoundaries[0]).toEqual(firstBoundary);
    }
    return body;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Whole knowledge boundary" }); await entered.promise;
    expect(firstBoundary.id).toBeTruthy(); expect(firstBoundary.resolutions).toHaveLength(2);
    expect(firstBoundary.resolutions[0]).toMatchObject({ supportIds: [], provenance: { kind: "direct" } });
    expect(firstBoundary.resolutions[1].provenance.kind).toBe(directOnly ? "direct" : "delegated");
    frozen = await s.invoke("architecture_read", { roomId: start.details.roomId });
    release.resolve(); await s.delivered.promise;
    const old = await localRecords(s, start.details.roomId, frozen), boundaries = old.filter((r: LocalRecord) => r.kind === "knowledge-boundary");
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({ id: firstBoundary.id, cycleId: firstBoundary.cycleId,
      planMessageId: firstBoundary.planMessageId, knowledgeMessageId: firstBoundary.knowledgeMessageId,
      resolutions: firstBoundary.resolutions });
    expect(firstBoundary.responses).toHaveLength(directOnly ? 0 : 1);
    for (const response of firstBoundary.responses) expect(old.find((r: LocalRecord) => r.id === response.id)).toMatchObject(response);
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("completed");
    expect(s.seen.filter(item => item.request.stage === "knowledge")).toHaveLength(directOnly ? 0 : 1);
    expect(s.sent.some(item => item.message.customType === "pitako.architecture.response")).toBe(false);
  } finally { release.resolve(); await s.close(); }
}));

for (const invalid of ["plan-duplicate", "plan-extra", "cycle", "response", "duplicate-support", "unrelated-support", "missing-own", "failed-prerequisite"] as const) {
  test(`registered contextual ${invalid} rejects before provisional, then a new ID corrects the same turn`, fixture.ownedCase(`contextual ${invalid}`, async () => {
    let rejected = 0; const calls: string[] = [];
    const s = await setup({ async prompt(session, request, body) {
      if (request.stage === "preparation") return { kind: "preparation", analysis: "Ready", doubts: session.model.id === "director" ? [] : [doubt(0), doubt(1), doubt(2)] };
      if (request.stage === "consultation-plan") {
        const plan = { kind: "consultation-plan", resolutions: [], support: request.context.doubts.map((d: any, i: number) => ({ role: "oracle", brief: `request-${i}`, doubtIds: [d.id], prerequisites: i === 2 ? [0] : [] })) };
        if (invalid.startsWith("plan") || invalid === "cycle") {
          const bad = structuredClone(plan);
          if (invalid === "plan-duplicate") bad.support[1].doubtIds.push(bad.support[0].doubtIds[0]);
          if (invalid === "plan-extra") bad.support[1].doubtIds.push("invented");
          if (invalid === "cycle") bad.support[0].prerequisites = [2];
          const error = await submit(session, "bad-plan", bad); expect(error.isError).toBe(true); expect(error.details.correctionsLeft).toBe(1); rejected++;
        }
        return plan;
      }
      if (request.stage === "consultation-response") {
        calls.push(request.context.request.brief);
        if (invalid === "failed-prerequisite" && request.context.request.brief === "request-0") return false;
        if (invalid === "response" && request.context.request.brief === "request-0") {
          const error = await submit(session, "bad-response", { ...response(request), doubtIds: ["invented"] });
          expect(error.isError).toBe(true); expect(error.details).toMatchObject({ code: "reference", badIds: ["invented"], missingIds: request.context.request.doubtIds }); rejected++;
        }
        return response(request);
      }
      if (request.stage === "knowledge") {
        const ids = request.context.responses.map((r: any) => r.id);
        const resolutions = request.context.delegatedDoubtIds.map((id: string, i: number) => ({ doubtId: id, status: invalid === "failed-prerequisite" && i !== 1 ? "failed" : "answered", answer: "Observed", supportIds: [ids[i]] }));
        if (["duplicate-support", "unrelated-support", "missing-own", "failed-prerequisite"].includes(invalid)) {
          const bad = structuredClone(resolutions);
          if (invalid === "duplicate-support") bad[0].supportIds.push(ids[0]);
          if (invalid === "unrelated-support") bad[0].supportIds.push(ids[1]);
          if (invalid === "missing-own") bad[2].supportIds = [ids[0]];
          if (invalid === "failed-prerequisite") bad[2].status = "answered";
          const error = await submit(session, "bad-knowledge", { kind: "knowledge", resolutions: bad });
          expect(error.isError).toBe(true); expect(error.details.code).toBe(["duplicate-support", "unrelated-support"].includes(invalid) ? "reference" : "prerequisite"); rejected++;
        }
        return { kind: "knowledge", resolutions };
      }
      if (request.stage === "contribution") return contribution;
      if (request.stage === "decision") return { kind: "decision", action: "synthesize", reason: "Ready" };
      if (request.stage === "synthesis" && invalid === "failed-prerequisite") return { ...body, status: "partial", pending: ["Support failed"] };
      return body;
    } });
    try {
      const start = await s.invoke("architecture_start", { goal: "Correct contextual rejection" }); await s.delivered.promise;
      expect(rejected).toBe(1); expect(calls).toEqual(invalid === "failed-prerequisite" ? ["request-0", "request-1"] : ["request-0", "request-1", "request-2"]);
      expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe(invalid === "failed-prerequisite" ? "failed" : "completed");
      const records = await localRecords(s, start.details.roomId); expect(records.filter((r: LocalRecord) => r.stage === "knowledge")).toHaveLength(1);
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    } finally { await s.close(); }
  }));
}

for (const candidate of ["rejected", "valid", "aborted"] as const) test(`provider failure after ${candidate} submit cannot reopen/fallback`, fixture.ownedCase(`submitted fallback ${candidate}`, async () => {
  let calls = 0;
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "preparation" && session.model.id !== "director") {
      calls++;
      const abort = new AbortController(); abort.abort();
      const receipt = candidate === "aborted" ? await session.boundTools.get("architecture_submit").execute("aborted", { submissionId: "aborted", body }, abort.signal, undefined, { sessionManager: session.sessionManager }) :
        await submit(session, "first", candidate === "valid" ? body : { ...body, extra: "invalid structure" });
      expect(receipt.isError === true).toBe(candidate !== "valid"); throw Error("503 Service Unavailable");
    }
    return body;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "No post-submit provider fallback" }); await s.delivered.promise;
    expect(calls).toBe(1); expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("failed");
    expect((await localRecords(s, start.details.roomId)).some((r: LocalRecord) => r.stage === "preparation" && r.author === "specialist")).toBe(false);
  } finally { await s.close(); }
}));

test("begin cannot reset a consumed correction budget; only open initializes a new stage", () => {
  const published: any[] = [], attached = participant({ current: () => true, publish: message => { const result = { ...message, id: "published", ordinal: 1, roomId: "room", assignmentId: "assignment", memberId: "member", author: "architect", snapshotId: "snapshot" }; published.push(result); return result; } });
  const identity = { instanceId: "instance", turnId: "turn", attemptId: "attempt", sessionId: "session" };
  const ctx = { sessionManager: { getSessionId: () => "session", getSessionFile: () => "/fixture" } };
  const grant = { roomId: "room", memberId: "member", assignmentId: "assignment", snapshotId: "snapshot", round: 0, rules: { kind: "preparation" as const } };
  attached.open(grant); attached.begin(identity); attached.bind({ appendEntry() {} } as never, ctx as never);
  const bad = { submissionId: "bad", body: { kind: "preparation" } };
  expect(() => attached.submit("bad", bad, ctx as never, identity)).toThrow("correctionsLeft");
  expect(attached.attempted).toBe(true); expect(() => attached.begin({ ...identity, attemptId: "reopen" })).toThrow("already attempted");
  expect(() => attached.submit("repeat", bad, ctx as never, identity)).toThrow('"correctionsLeft":1');
  expect(() => attached.submit("second", { ...bad, submissionId: "second" }, ctx as never, identity)).toThrow('"correctionsLeft":0');
  expect(() => attached.submit("third", { ...bad, submissionId: "third" }, ctx as never, identity)).toThrow("budget exhausted");
  expect(() => attached.settle(true)).toThrow("budget exhausted"); expect(published).toEqual([]);
  attached.open(grant); attached.begin(identity);
  const value = { submissionId: "new", body: { kind: "preparation", analysis: "Valid", doubts: [] } };
  const receipt = attached.submit("new", value, ctx as never, identity); expect(attached.submit("retry", structuredClone(value), ctx as never, identity)).toEqual(receipt);
  attached.settle(true); expect(published).toHaveLength(1);
});


for (const mode of ["exhausted", "locked"] as const) test(`registered ${mode} grant cannot publish or fall back`, fixture.ownedCase(`grant ${mode}`, async () => {
  let calls = 0;
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage !== "preparation" || session.model.id === "director") return body;
    calls++;
    if (mode === "exhausted") {
      const bad = { ...body, extra: "invalid" };
      const first = await submit(session, "bad-one", bad);
      expect(first.details).toMatchObject({ code: "structure", stage: "preparation", correctionsLeft: 1 });
      expect(await submit(session, "bad-one", structuredClone(bad))).toEqual(first);
      expect((await submit(session, "bad-two", bad)).details.correctionsLeft).toBe(0);
      expect((await submit(session, "third-valid", body)).isError).toBe(true);
    } else {
      const valid = await submit(session, "valid", body); expect(valid.isError).not.toBe(true);
      expect((await submit(session, "replacement", body)).isError).toBe(true);
    }
    return false;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "No replacement or exhausted correction" }); await s.delivered.promise;
    expect(calls).toBe(1);
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("failed");
    expect((await localRecords(s, start.details.roomId)).some((r: LocalRecord) => r.stage === "preparation" && r.author === "specialist")).toBe(false);
  } finally { await s.close(); }
}));


test("transitive prerequisites authorize citations and preserve stable request order even when later indices execute first", fixture.ownedCase("transitive support identity", async () => {
  const order: string[] = []; let cycleId: string;
  const s = await setup({ prompt(session, request, body) {
    if (request.stage === "preparation") return { kind: "preparation", analysis: "Three doubts", doubts: session.model.id === "director" ? [] : [doubt(0), doubt(1), doubt(2)] };
    if (request.stage === "consultation-plan") {
      cycleId = request.context.cycleId;
      return { kind: "consultation-plan", resolutions: [], support: request.context.doubts.map((d: any, i: number) => ({
        role: "oracle", brief: `request-${i}`, doubtIds: [d.id], prerequisites: i === 0 ? [2] : i === 2 ? [1] : [],
      })) };
    }
    if (request.stage === "consultation-response") {
      expect(request.context.cycleId).toBe(cycleId); order.push(request.context.request.brief);
      expect(request.context.prerequisites.every((r: any) => r.status === "completed" && r.id && r.message.id && r.message.body.answer === "Evidence")).toBe(true);
      expect(request.context.prerequisites.every((r: any) => !("assignmentId" in r))).toBe(true);
      return response(request);
    }
    if (request.stage === "knowledge") {
      expect(request.context.cycleId).toBe(cycleId);
      const responses = request.context.responses;
      expect(new Set(responses.map((r: any) => r.id)).size).toBe(3);
      expect(responses.map((r: any) => r.message.body.answer)).toEqual(["Evidence", "Evidence", "Evidence"]);
      expect(responses.map((r: any) => r.message.body.doubtIds[0])).toEqual(request.context.delegatedDoubtIds);
      expect(responses.map((r: any) => r.prerequisites)).toEqual([[responses[2].id], [], [responses[1].id]]);
      return { kind: "knowledge", resolutions: request.context.delegatedDoubtIds.map((id: string, i: number) => ({ doubtId: id, status: "answered", answer: "Transitive evidence",
        supportIds: (i === 0 ? [0, 2, 1] : i === 2 ? [2, 1] : [1]).map(index => responses[index].id) })) };
    }
    if (request.stage === "contribution") return contribution;
    if (request.stage === "decision") return { kind: "decision", action: "synthesize", reason: "Complete" };
    return body;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Transitive stable identities" }); await s.delivered.promise;
    expect(order).toEqual(["request-1", "request-2", "request-0"]);
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("completed");
    const records = await localRecords(s, start.details.roomId), boundary = records.find((r: LocalRecord) => r.kind === "knowledge-boundary");
    expect(boundary.cycleId).toBe(cycleId!); expect(boundary.resolutions[0].provenance.responses).toHaveLength(3);
    expect(boundary.resolutions[0].provenance.responses.every((r: any) => r.status === "completed" && r.assignmentId && r.messageId)).toBe(true);
  } finally { await s.close(); }
}));
