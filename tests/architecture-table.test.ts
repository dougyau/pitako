import { expect, spyOn, test } from "bun:test";
import * as team from "../extensions/team.ts";
import { cancelTeamWorker, workerHandoff, teamWorkerResult, teamWorkerStatus } from "../extensions/agent/background.ts";
import { firstTeamReservation, teamAssignments } from "../extensions/team.ts";
import { executionForSession } from "../extensions/execution-identity.ts";
import { architectureFixture } from "./fixtures/architecture.ts";

const { fixture, setup } = architectureFixture();
const deferred = <T = void>() => Promise.withResolvers<T>();
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const composition = (request: any, count = 5) => ({ kind: "composition", snapshotId: request.snapshot.id, reason: "Useful independent perspectives",
  specialists: Array.from({ length: count }, (_, index) => ({ kind: "add", candidateRef: "topic:0:0", mandate: `Member ${index}`, reason: "Independent perspective" })) });
const preparation = (request: any, doubts = false) => ({ kind: "preparation", analysis: request.context.mandate,
  doubts: doubts ? [{ question: "Equivalent question", purpose: request.context.mandate }] : [] });
const contribution = (request: any, objections: any[] = []) => ({ kind: "contribution", proposal: request.context.mandate,
  arguments: ["Reasoned proposal"], objections, doubts: [] });
const decision = (action: string) => ({ kind: "decision", action, reason: "Controlled stage decision" });
const support = (request: any) => ({ kind: "consultation-response", doubtIds: request.context.request.doubtIds,
  answer: request.context.request.brief, evidence: ["controlled source"], limits: [], doubts: [] });
const observePrivate = async (s: Awaited<ReturnType<typeof setup>>) => {
  const draft = await s.emit("agent_before_settle", { outcome: "completed", context: { canContinue: true } });
  expect(draft?.entries ?? []).toEqual([]);
  await s.emit("turn_start");
  await s.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
  expect(s.branch.filter(entry => ["pitako.worker.result", "pitako.architecture.response"].includes(entry.customType))).toEqual([]);
  expect(s.sent).toEqual([]);
};

// Normalize only opaque identities; compare actual bodies, dependency material and publication order.
const canonical = (value: unknown) => {
  const identities = new Map<string, string>();
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry !== "string") return entry;
    return entry.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b(?:architect|oracle|scout|researcher)-[0-9a-f]{6}\b/g,
      id => { if (!identities.has(id)) identities.set(id, `id:${identities.size}`); return identities.get(id)!; });
  });
};

test("stage inputs carry unabridged results once, with identified doubts and no same-round publications", fixture.ownedCase("table projected inputs", async () => {
  const analyses = ["chosen", "director"].map(model => `${model}-independent-` + "x".repeat(20000));
  const s = await setup({ prompt(session, request, body) {
    const serialized = JSON.stringify(request);
    if (request.stage === "composition") return composition(request, 1);
    if (request.stage === "preparation") {
      expect(Object.keys(request.context)).toEqual(["mandate"]);
      return { ...preparation(request), analysis: analyses[session.model.id === "chosen" ? 0 : 1],
        doubts: [{ question: `question-${session.model.id}`, purpose: "Needed knowledge" }] };
    }
    if (request.stage === "consultation-plan") {
      expect(request.authorization.doubtIds).toEqual(request.context.doubts.map((doubt: any) => doubt.id));
      expect(request.context.sources).toHaveLength(2);
      for (const source of request.context.sources) {
        expect(serialized.split(source.body.analysis)).toHaveLength(2);
        expect(serialized.split(source.body.doubts[0].question)).toHaveLength(2);
        expect(source.body.doubts[0].id).toBe(request.context.doubts.find((doubt: any) => doubt.id === source.body.doubts[0].id).id);
        for (const key of ["id", "author", "memberId", "stage"]) expect(source[key]).toBeTruthy();
      }
      return { kind: "consultation-plan", resolutions: request.context.doubts.map((doubt: any) =>
        ({ doubtId: doubt.id, status: "answered", answer: `confirmed-${doubt.id}` })), support: [] };
    }
    if (request.stage === "contribution" || request.stage === "synthesis") {
      const results = request.context.shared?.messages ?? request.context.messages;
      for (const analysis of analyses) {
        expect(results.some((result: any) => result.body.analysis === analysis)).toBe(true);
        expect(serialized.split(analysis)).toHaveLength(2);
      }
      expect(new Set(results.map((result: any) => result.id)).size).toBe(results.length);
      for (const result of results) {
        expect(serialized.split(`"id":"${result.id}"`)).toHaveLength(2);
        if (result.stage === "contribution") {
          expect(serialized.split(result.body.proposal)).toHaveLength(2);
          if (request.stage === "contribution") expect(result.round).toBeLessThan(request.round);
        }
      }
      if (request.stage === "contribution") {
        expect(results.filter((result: any) => result.stage === "contribution")).toHaveLength(request.round === 1 ? 0 : 2);
        return { ...contribution(request), proposal: `proposal-${session.model.id}-round-${request.round}` };
      }
      expect(results.filter((result: any) => result.stage === "contribution")).toHaveLength(4);
    }
    if (request.stage === "decision") {
      for (const analysis of analyses) expect(serialized).not.toContain(analysis);
      expect(request.context.sources).toHaveLength(2);
      for (const source of request.context.sources) {
        expect(source.round).toBe(request.round);
        expect(serialized.split(source.body.proposal)).toHaveLength(2);
      }
      return decision(request.round === 1 ? "continue" : "synthesize");
    }
    return body;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Preserve all rounds and every substantive byte" }); await s.delivered.promise;
    expect(teamWorkerResult(s.evaluation.token, start.details.instanceId)!.status).toBe("completed");
    expect(s.seen.filter(item => item.request.stage === "contribution")).toHaveLength(4);
    expect(s.seen.some(item => item.request.stage === "synthesis")).toBe(true);
  } finally { await s.close(); }
}));

for (const failed of [false, true]) test(`${failed ? "all failed specialists" : "empty pool"} still prepares and contributes with the director`, fixture.ownedCase(`director ${failed}`, async () => {
  const s = await setup({ ...(failed ? {} : { config: "" }), prompt(session, request, body) {
    if (request.stage === "composition") return failed ? composition(request, 2) : { ...composition(request, 0) };
    if (request.stage === "preparation" && session.model.id !== "director") return false;
    if (request.stage === "synthesis" && failed) return { ...body, status: "partial" };
    return body;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Independent director with no surviving peer" }); await s.delivered.promise;
    const report = teamWorkerResult(s.evaluation.token, start.details.instanceId)!;
    expect(report.status).toBe(failed ? "failed" : "completed");
    expect(JSON.parse(report.result).status).toBe(failed ? "partial" : "complete");
    expect(s.seen.filter(item => item.session.model.id === "director" && item.request.stage === "preparation")).toHaveLength(1);
    expect(s.seen.filter(item => item.request.stage === "contribution")).toHaveLength(1);
    expect(s.seen.find(item => item.request.stage === "synthesis")!.request.context.failures).toHaveLength(failed ? 2 : 0);
  } finally { await s.close(); }
}));

test("retention keeps owners and immutable tasks; additions prepare independently and zero keeps the same director", fixture.ownedCase("retain mix zero", async () => {
  let compositions = 0, retainedId = "", retiredId = "";
  const shared: any[] = [];
  const s = await setup({ prompt(session, request, body) {
    if (request.stage === "composition") {
      if (++compositions === 1) return composition(request, 2);
      if (compositions === 2) {
        [retainedId, retiredId] = request.authorization.retainableMemberIds;
        return { ...composition(request, 0), specialists: [
          { kind: "add", candidateRef: "general:0", mandate: "New focus", reason: "Fresh perspective" },
          { kind: "retain", memberId: retainedId, mandate: "Updated focus", reason: "Continuity" },
        ] };
      }
      return composition(request, 0);
    }
    if (request.stage === "preparation") {
      expect(request).not.toHaveProperty("journal");
      expect(request).not.toHaveProperty("snapshot");
      expect(request).not.toHaveProperty("controls");
      expect(request.authorization).toEqual({ kind: "preparation" });
      expect(Object.keys(request.context)).toEqual(["mandate"]);
      if (session.model.id === "director") expect(request.context.mandate).toBe("Independently analyze the complete architectural goal");
      else if (session.model.id === "general") expect(request.context.mandate).toBe("New focus");
      else expect(["Member 0", "Member 1"]).toContain(request.context.mandate);
      return preparation(request);
    }
    if (request.stage === "contribution") {
      shared.push(request.context.shared);
      if (request.round === 2) {
        expect(request.authorization.objections.some((reference: any) => reference.memberId === retiredId)).toBe(true);
        if (session.model.id === "chosen") expect(request.context.mandate).toBe("Updated focus");
      }
      return contribution(request);
    }
    if (request.stage === "decision") return decision(request.round < 3 ? "recompose" : "synthesize");
    return body;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Keep full historical evidence" }); await s.delivered.promise;
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("completed");
    const retained = teamAssignments(s.evaluation).find(member => member.memberId === retainedId)!;
    expect(retained.task).toBe("Member 0");
    const retainedSession = s.seen.find(item => item.request.stage === "contribution" && item.request.round === 2 && item.session.model.id === "chosen")!.session;
    expect(retainedSession.prompts.map((text: string) => JSON.parse(text).stage).filter((stage: string) => stage === "preparation")).toHaveLength(1);
    expect(s.seen.filter(item => item.request.stage === "preparation")).toHaveLength(4);
    expect(s.seen.filter(item => item.request.stage === "contribution" && item.request.round === 3)).toHaveLength(1);
    const second = shared.find(view => view.round === 2);
    expect(second.messages.some((message: any) => message.memberId === retiredId && message.stage === "preparation")).toBe(true);
    const final = s.seen.find(item => item.request.stage === "synthesis")!.request.context.messages;
    expect(final.filter((message: any) => message.stage === "contribution" && message.round === 2).map((message: any) => message.body.proposal))
      .toEqual(["New focus", "Updated focus", "Independently analyze the complete architectural goal"]);
  } finally { await s.close(); }
}));

test("revoked specialist authority invalidates a frozen retain before any replacement admission", fixture.ownedCase("revoked retained owner", async () => {
  const compositionEntered = deferred(), releaseComposition = deferred(), disposing = deferred(), releaseDispose = deferred();
  fixture.finishOnCleanup(() => { releaseComposition.resolve(); releaseDispose.resolve(); });
  let compositions = 0, retainedId = "";
  const s = await setup({ async dispose(session) {
    if (session.model.id === "chosen") { disposing.resolve(); await releaseDispose.promise; }
  }, async prompt(_session, request, body) {
    if (request.stage === "composition") {
      if (++compositions === 1) return composition(request, 1);
      retainedId = request.authorization.retainableMemberIds[0]; compositionEntered.resolve(); await releaseComposition.promise;
      return { ...composition(request, 0), specialists: [
        { kind: "retain", memberId: retainedId, mandate: "Retain cancelled", reason: "Frozen selection" },
        { kind: "add", candidateRef: "general:0", mandate: "Replacement must not enter", reason: "New focus" },
      ] };
    }
    if (request.stage === "decision") return decision("recompose");
    return body;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Preserve authority across composition" }); await compositionEntered.promise;
    const member = teamAssignments(s.evaluation).find(item => item.memberId === retainedId)!;
    expect(cancelTeamWorker(s.evaluation.token, member.instanceId)).toMatchObject({ closure: { state: "pending" } });
    await disposing.promise;
    releaseComposition.resolve(); await tick();
    releaseDispose.resolve(); await s.delivered.promise;
    expect(teamWorkerResult(s.evaluation.token, start.details.instanceId)!.result).toContain("composition realization lost member authority");
    expect(s.seen.some(item => item.session.model.id === "general")).toBe(false);
    expect(s.seen.some(item => item.request.stage === "contribution" && item.request.round === 2)).toBe(false);
  } finally { releaseComposition.resolve(); releaseDispose.resolve(); await s.close(); }
}));

test("partial replacement admission preserves intention and closes created owners without rollback", fixture.ownedCase("partial admission", async () => {
  const admit = team.admitTeamMember;
  let calls = 0, compositions = 0;
  const s = await setup({ prompt(_session, request, body) {
    if (request.stage === "composition") { compositions++; return composition(request, compositions === 1 ? 1 : 2); }
    if (request.stage === "decision") return decision("recompose");
    return body;
  } });
  const spy = spyOn(team, "admitTeamMember").mockImplementation((...args) => {
    if (++calls === 3) throw Error("controlled replacement admission failure");
    return admit(...args);
  });
  try {
    const start = await s.invoke("architecture_start", { goal: "Keep partial realization diagnostic" }); await s.delivered.promise;
    const result = teamWorkerResult(s.evaluation.token, start.details.instanceId)!;
    expect(result.status).toBe("failed"); expect(result.result).toContain("controlled replacement admission failure");
    expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    expect(teamAssignments(s.evaluation)).toHaveLength(3);
    expect(teamWorkerStatus(s.evaluation.token).every(row => row.closure.state === "released")).toBe(true);
    const room = await s.read("architecture_read", { roomId: start.details.roomId });
    expect(JSON.stringify(room.messages)).toContain('"specialists":[{"kind":"add"');
    expect(s.seen.filter(item => item.request.stage === "contribution").every(item => item.request.round === 1)).toBe(true);
  } finally { spy.mockRestore(); await s.close(); }
}));

test("registered five-member table shares ordered support only at the knowledge boundary, independent of arrival", fixture.ownedCase("table support order", async () => {
  const packages: string[] = [];
  for (const order of [[0, 1], [1, 0]]) {
    const entered = deferred(), knowledgeEntered = deferred(), releaseKnowledge = deferred(), roundEntered = deferred(), releaseRound = deferred();
    const releases = [deferred(), deferred()], completed = [deferred(), deferred()], disposals = [deferred(), deferred()];
    const release = () => { releases.forEach(gate => { gate.resolve(); }); releaseKnowledge.resolve(); releaseRound.resolve(); disposals.forEach(gate => { gate.resolve(); }); };
    fixture.finishOnCleanup(release);
    let active = 0, maxActive = 0, calls = 0;
    const roundPrompts: any[] = [];
    let supportBatch: unknown;
    const s = await setup({ async prompt(session, request, body) {
      if (request.stage === "composition") return composition(request);
      if (request.stage === "preparation") { expect(request.context.shared).toBeUndefined(); return preparation(request, session.model.id !== "director"); }
      if (request.stage === "consultation-plan") {
        expect(request.context.doubts).toHaveLength(5);
        return { kind: "consultation-plan", resolutions: [], support: [
          { role: "scout", brief: "grouped original references", doubtIds: request.context.doubts.slice(0, 3).map((d: any) => d.id), prerequisites: [] },
          { role: "researcher", brief: "independent", doubtIds: [request.context.doubts[3].id], prerequisites: [] },
          { role: "oracle", brief: "dependent", doubtIds: [request.context.doubts[4].id], prerequisites: [0, 1] },
        ] };
      }
      if (request.stage === "consultation-response") {
        const index = ["grouped original references", "independent", "dependent"].indexOf(request.context.request.brief);
        calls++; active++; maxActive = Math.max(maxActive, active);
        if (calls === 2) entered.resolve();
        if (index < 2) await releases[index]!.promise;
        else expect(request.context.prerequisites.map((item: any) => item.status)).toEqual(["completed", "completed"]);
        return support(request);
      }
      if (request.stage === "knowledge") {
        expect(calls).toBe(3);
        supportBatch = request.context.responses;
        knowledgeEntered.resolve(); await releaseKnowledge.promise;
        return { kind: "knowledge", resolutions: request.context.doubts.map((doubt: any, index: number) => ({ doubtId: doubt.id,
          status: "answered", answer: index < 3 ? "Grouped answer" : `Answer ${index}`, supportIds: [request.context.responses[index < 3 ? 0 : index - 2].id] })) };
      }
      if (request.stage === "contribution") {
        roundPrompts.push(request); if (roundPrompts.length === 6) roundEntered.resolve(); await releaseRound.promise;
        return contribution(request);
      }
      if (request.stage === "decision") return decision("synthesize");
      return body;
    }, async dispose(session) {
      const request = session.prompts.map((text: string) => JSON.parse(text)).find((r: any) => r.stage === "consultation-response");
      if (request) {
        active--;
        const index = ["grouped original references", "independent", "dependent"].indexOf(request.context.request.brief);
        if (index < 2) { completed[index]!.resolve(); await disposals[index]!.promise; }
      }
    } });
    try {
      const start = await s.invoke("architecture_start", { goal: "Compare support order", topic: "security" });
      expect(start.isError).not.toBe(true); await entered.promise;
      expect(maxActive).toBe(2); expect(roundPrompts).toEqual([]);
      releases[order[0]!]!.resolve(); await completed[order[0]!]!.promise; await tick();
      expect(calls).toBe(2); expect(roundPrompts).toEqual([]); await observePrivate(s);
      releases[order[1]!]!.resolve(); await completed[order[1]!]!.promise;
      expect(calls).toBe(2); // Both support disposals still own their seats.
      disposals[order[0]!]!.resolve(); await tick(); expect(calls).toBe(2);
      disposals[order[1]!]!.resolve(); await knowledgeEntered.promise;
      expect(roundPrompts).toEqual([]); await observePrivate(s);
      releaseKnowledge.resolve(); await roundEntered.promise;
      packages.push(canonical({ supportBatch, shared: roundPrompts[0].context.shared }));
      expect(roundPrompts.every(request => JSON.stringify(request.context.shared) === JSON.stringify(roundPrompts[0].context.shared))).toBe(true);
      expect(roundPrompts[0].context.shared.knowledgeBoundaries).toHaveLength(1);
      expect(roundPrompts[0].context.shared.knowledgeBoundaries[0].responses).toHaveLength(3);
      expect(s.host.sessions.filter(session => session.model?.id === "chosen")).toHaveLength(5);
      expect(s.host.sessions.filter(session => !session.events.includes("dispose")).every(session => executionForSession(session.sessionId)?.profile === "analysis")).toBe(true);
      for (const session of s.host.sessions) {
        expect(session.active).not.toContain("architecture_start"); expect(session.active).not.toContain("team_assign");
        expect(session.active).not.toContain("agent_spawn"); expect(session.active).not.toContain("edit");
      }
      releaseRound.resolve(); await s.delivered.promise;
      expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("completed");
      expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
      expect(maxActive).toBe(2);
    } finally { release(); await s.close(); }
  }
  expect(packages[0]).toBe(packages[1]);
}));

test("consultation A receives the full B to C prerequisite chain without independent D or broader submit authority", fixture.ownedCase("transitive consultation context", async () => {
  const labels = ["A", "B", "C", "D"];
  const answers = labels.map(label => `Answer ${label}: ` + label.repeat(20000));
  let doubtIds: string[] = [], responseIds: string[] = [];
  const disposed: string[] = [];
  let closedBeforeA: string[] = [];
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "composition") return composition(request, 4);
    if (request.stage === "preparation") return { ...preparation(request),
      analysis: "PRIVATE-INDEPENDENT-DELIBERATION",
      doubts: session.model.id === "director" ? [] : [{
        question: `Question ${labels[Number(request.context.mandate.slice(-1))]}?`,
        purpose: `Purpose ${labels[Number(request.context.mandate.slice(-1))]}`,
      }] };
    if (request.stage === "consultation-plan") {
      doubtIds = request.context.doubts.map((doubt: any) => doubt.id);
      return { kind: "consultation-plan", resolutions: [], support: labels.map((label, index) => ({
        role: "scout", brief: label, doubtIds: [doubtIds[index]], prerequisites: index < 2 ? [index + 1] : [],
      })) };
    }
    if (request.stage === "consultation-response") {
      const index = labels.indexOf(request.context.mandate);
      if (index === 0) {
        closedBeforeA = [...disposed];
        const rejected = await session.boundTools.get("architecture_submit").execute("broader-authority", {
          submissionId: "broader-authority", body: { ...support(request), doubtIds: [doubtIds[0], doubtIds[2]] },
        }, undefined, undefined, { sessionManager: session.sessionManager });
        expect(rejected.isError).toBe(true);
        expect(rejected.details).toMatchObject({ code: "reference", field: "body.doubtIds" });
      }
      return { ...support(request), answer: answers[index],
        evidence: request.context.prerequisites.map((result: any) => result.id) };
    }
    if (request.stage === "knowledge") {
      responseIds = request.context.responses.map((response: any) => response.id);
      return { kind: "knowledge", resolutions: doubtIds.map((doubtId, index) => ({
        doubtId, status: "answered", answer: `Confirmed ${labels[index]}`, supportIds: [responseIds[index]],
      })) };
    }
    return body;
  }, async dispose(session) {
    const request = session.prompts.map((text: string) => JSON.parse(text)).find((item: any) => item.stage === "consultation-response");
    if (request) disposed.push(request.context.mandate);
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Resolve A using B and C, not D" });
    await s.delivered.promise;
    expect(teamWorkerResult(s.evaluation.token, start.details.instanceId)!.status).toBe("completed");
    const a = s.seen.find(item => item.request.stage === "consultation-response" && item.request.context.mandate === "A")!;
    expect(a.receipt.isError).not.toBe(true);
    expect(a.request.authorization).toEqual({ kind: "consultation-response", doubtIds: [doubtIds[0]] });
    expect(a.request.context.request.doubtIds).toEqual([doubtIds[0]]);
    expect(a.request.context.prerequisites.map((result: any) => result.id).sort()).toEqual(responseIds.slice(1, 3).sort());
    expect(a.request.context.doubts).toEqual(labels.slice(0, 3).map((label, index) => ({
      id: doubtIds[index], question: `Question ${label}?`, purpose: `Purpose ${label}`,
    })));
    const serialized = JSON.stringify(a.request);
    for (const index of [1, 2]) {
      const result = a.request.context.prerequisites.find((item: any) => item.id === responseIds[index]);
      expect(result).toMatchObject({ status: "completed", message: { stage: "consultation-response",
        body: { answer: answers[index], doubtIds: [doubtIds[index]] } } });
      expect(result.id).not.toBe(result.message.id);
      for (const key of ["id", "author", "memberId", "stage"]) expect(result.message[key]).toBeTruthy();
      expect(serialized.split(answers[index]!)).toHaveLength(2);
    }
    for (const label of labels.slice(0, 3)) for (const text of [`Question ${label}?`, `Purpose ${label}`])
      expect(serialized.split(text)).toHaveLength(2);
    for (const text of [answers[3]!, "Question D?", "Purpose D", "PRIVATE-INDEPENDENT-DELIBERATION", '"snapshot"', '"journal"', '"native"'])
      expect(serialized).not.toContain(text);
    expect(closedBeforeA).toEqual(expect.arrayContaining(["B", "C"]));
    expect(disposed).toHaveLength(4);
    expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
  } finally { await s.close(); }
}));

test("round frontiers freeze objections and controls; replacement waits for all five outgoing owners", fixture.ownedCase("table frontier replacement", async () => {
  const entered = deferred(), releaseRound = deferred(), closing = deferred(), releaseOutgoing = deferred(), synthesis = deferred(), releaseSynthesis = deferred();
  const release = () => { releaseRound.resolve(); releaseOutgoing.resolve(); releaseSynthesis.resolve(); }; fixture.finishOnCleanup(release);
  const prompts: any[] = [], outgoing: any[] = []; let compositionCount = 0, disposalCount = 0;
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "composition") { compositionCount++; return composition(request); }
    if (request.stage === "preparation") { expect(request.context.shared).toBeUndefined(); return preparation(request); }
    if (request.stage === "contribution") {
      prompts.push(request);
      const reference = request.authorization.objections[0];
      const prior = request.context.shared.messages.find((message: any) => message.id === reference?.messageId);
      if (request.round === 1) { if (session.model.id !== "director") outgoing.push(session); if (prompts.length === 6) entered.resolve(); await releaseRound.promise; }
      return contribution(request, prior ? [{ memberId: prior.memberId, messageId: prior.id, argument: "Counterargument, not a doubt" }] : []);
    }
    if (request.stage === "decision") {
      expect(request.context.controls).toEqual(request.round === 1 ? [] : [{ action: "context", text: "new context" }, { action: "priorities", text: "new priority" }]);
      return decision(request.round === 1 ? "recompose" : "synthesize");
    }
    if (request.stage === "synthesis") { synthesis.resolve(); await releaseSynthesis.promise; }
    return body;
  }, async dispose(session) {
    if (outgoing.includes(session)) { if (++disposalCount === 5) closing.resolve(); await releaseOutgoing.promise; }
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Frontier changes" }); await entered.promise;
    const first = JSON.stringify(prompts[0].context.shared);
    expect(prompts.every(request => JSON.stringify(request.context.shared) === first)).toBe(true);
    const before = JSON.parse((await s.invoke("architecture_read", { roomId: start.details.roomId, maxBytes: 4096 })).content[0].text);
    const cursor = before.header.cursor;
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "context", text: "new context" });
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "priorities", text: "new priority" });
    expect(JSON.stringify(prompts[0].context.shared)).toBe(first);
    releaseRound.resolve(); await closing.promise;
    expect(compositionCount).toBe(2); expect(s.host.sessions.filter(session => session.model?.id === "chosen")).toHaveLength(5);
    expect(teamWorkerStatus(s.evaluation.token).filter(row => row.teamId === start.details.roomId && row.instanceId !== start.details.instanceId && row.closure.state === "pending")).toHaveLength(5);
    expect(workerHandoff(start.details.instanceId)).toBeUndefined(); await observePrivate(s);
    releaseOutgoing.resolve(); await synthesis.promise;
    const second = prompts.filter(request => request.round === 2);
    expect(second).toHaveLength(6); expect(second.every(request => JSON.stringify(request.context.shared) === JSON.stringify(second[0].context.shared))).toBe(true);
    expect(second[0].context.shared.id).not.toBe(prompts[0].context.shared.id);
    expect(second[0].context.shared.controls).toEqual([{ action: "context", text: "new context" }, { action: "priorities", text: "new priority" }]);
    expect(second[0].context.shared.messages.filter((message: any) => message.stage === "contribution")).toHaveLength(6);
    expect(second[0].context.shared.messages.filter((message: any) => message.stage === "contribution").every((message: any) => message.body.objections.length === 1 && message.body.doubts.length === 0)).toBe(true);
    const readAgain = JSON.parse((await s.invoke("architecture_read", { roomId: start.details.roomId, ...(cursor ? { cursor } : {}) })).content[0].text);
    if (cursor) expect(readAgain.header.id).toBe(before.header.id);
    expect(s.host.sessions.filter(session => session.model?.id === "chosen")).toHaveLength(10);
    expect(outgoing.every(session => session.events.includes("dispose"))).toBe(true); await observePrivate(s);
    releaseSynthesis.resolve(); await s.delivered.promise;
    expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("completed");
  } finally { release(); await s.close(); }
}));

for (const action of ["consult", "continue"] as const) {
  test(`round five ${action} cannot dispatch round six; final clarification is partial`, fixture.ownedCase(`table limit ${action}`, async () => {
    const rounds: number[] = [], phases: string[] = []; let supports = 0;
    const s = await setup({ async prompt(session, request, body) {
      if (request.stage === "composition") return composition(request, 2);
      if (request.stage === "preparation") return preparation(request);
      if (request.stage === "contribution") { rounds.push(request.round); return { ...contribution(request), doubts: request.round === 5 && session.model.id !== "director" ? [{ question: "Redesign?", purpose: "Final clarification" }] : [] }; }
      if (request.stage === "decision") {
        if (request.round === 5 && action === "continue") {
          const rejected = await session.boundTools.get("architecture_submit").execute("over-limit", { submissionId: "over-limit", body: decision("continue") }, undefined, undefined, { sessionManager: session.sessionManager });
          expect(rejected.isError).toBe(true); expect(rejected.details.code).toBe("action");
        }
        return decision(request.round === 5 ? action === "continue" ? "synthesize" : action : "continue");
      }
      if (request.stage === "consultation-plan") {
        phases.push(request.context.phase);
        return { kind: "consultation-plan", resolutions: [], support: request.context.doubts.length ? [
          { role: "oracle", brief: "clarification only", doubtIds: request.context.doubts.map((d: any) => d.id), prerequisites: [] }] : [] };
      }
      if (request.stage === "consultation-response") { supports++; return { ...support(request), doubts: [{ question: "Later investigation", purpose: "Not recursive" }] }; }
      if (request.stage === "knowledge") return { kind: "knowledge", resolutions: request.context.doubts.map((d: any) => ({ doubtId: d.id, status: "partial", answer: "Requires redesign", supportIds: [request.context.responses[0].id] })) };
      if (request.stage === "synthesis") {
        expect(request.context.pendingDoubts).toHaveLength(action === "consult" ? 1 : 2);
        const rejected = await session.boundTools.get("architecture_submit").execute("false-complete", { submissionId: "false-complete", body }, undefined, undefined, { sessionManager: session.sessionManager });
        expect(rejected.isError).toBe(true); expect(rejected.details).toMatchObject({ code: "coverage", field: "body.status", correctionsLeft: 1 });
        return { ...body, status: "partial", pending: ["Requires redesign"] };
      }
      return body;
    } });
    try {
      const start = await s.invoke("architecture_start", { goal: "Bounded rounds" }); await s.delivered.promise;
      expect(rounds).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5]);
      expect(phases).toEqual(action === "consult" ? ["initial", "final-clarification"] : ["initial"]);
      expect(supports).toBe(action === "consult" ? 1 : 0);
      expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("failed");
      const result = await s.invoke("team_result", { assignmentId: start.details.assignmentId });
      expect(result.content[0].text).toContain("partial"); expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    } finally { await s.close(); }
  }));
}

for (const action of ["finish", "stop", "team_cancel"] as const) {
  test(`table ${action} has distinct current-stage and whole-owner closure`, fixture.ownedCase(`table control ${action}`, async () => {
    const entered = deferred(), releasePrompt = deferred(), disposing = deferred(), releaseDispose = deferred();
    const release = () => { releasePrompt.resolve(); releaseDispose.resolve(); }; fixture.finishOnCleanup(release);
    const children: any[] = []; let syntheses = 0;
    const s = await setup({ async prompt(session, request, body) {
      if (request.stage === "composition") return composition(request, 2);
      if (request.stage === "preparation" && session.model.id !== "director") {
        children.push(session); if (children.length === 2) entered.resolve(); await releasePrompt.promise;
        return action === "finish" ? preparation(request) : false;
      }
      if (request.stage === "preparation") return preparation(request);
      if (request.stage === "synthesis") { syntheses++; return action === "finish" ? { ...body, status: "partial" } : body; }
      return body;
    }, async dispose(session) { if (children.includes(session)) { disposing.resolve(); await releaseDispose.promise; } } });
    try {
      const start = await s.invoke("architecture_start", { goal: "Control stages" }); await entered.promise;
      const controlled = action === "team_cancel" ? await s.invoke("team_cancel", { assignmentId: start.details.assignmentId })
        : await s.invoke("architecture_control", { roomId: start.details.roomId, action });
      expect(controlled.isError).not.toBe(true); await tick();
      expect(children.every(session => session.events.includes("abort"))).toBe(action !== "finish");
      expect(workerHandoff(start.details.instanceId)).toBeUndefined();
      expect(firstTeamReservation(s.evaluation, "architect")).toBe(start.details.assignmentId);
      releasePrompt.resolve(); await disposing.promise;
      expect(syntheses).toBe(action === "finish" ? 1 : 0); expect(workerHandoff(start.details.instanceId)).toBeUndefined(); await observePrivate(s);
      releaseDispose.resolve(); await s.delivered.promise;
      expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe(action === "finish" ? "failed" : "cancelled");
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
      expect(s.seen.some(item => item.request.stage === "contribution")).toBe(false);
    } finally { release(); await s.close(); }
  }));
}


test("failed support prerequisites are unresolved, while independent support progresses and new doubts do not recurse", fixture.ownedCase("table support failure", async () => {
  const calls: string[] = [];
  const s = await setup({ prompt(session, request, body) {
    if (request.stage === "composition") return composition(request, 3);
    if (request.stage === "preparation") return preparation(request, session.model.id !== "director");
    if (request.stage === "consultation-plan") return { kind: "consultation-plan", resolutions: [], support: request.context.doubts.map((d: any, index: number) =>
      ({ role: "oracle", brief: `support ${index}`, doubtIds: [d.id], prerequisites: index === 2 ? [0] : [] })) };
    if (request.stage === "consultation-response") {
      calls.push(request.context.request.brief);
      if (request.context.request.brief === "support 0") throw new Error("503 Service Unavailable");
      return { ...support(request), doubts: [{ question: "New question", purpose: "Later stage" }] };
    }
    if (request.stage === "knowledge") {
      expect(request.context.responses.map((response: any) => response.status)).toEqual(["failed", "completed", "failed"]);
      expect(request.context.responses[2].error).toBe("prerequisite failed");
      return { kind: "knowledge", resolutions: request.context.doubts.map((d: any, index: number) => ({ doubtId: d.id,
        status: index === 1 ? "answered" : "failed", answer: "Observed outcome", supportIds: [request.context.responses[index].id] })) };
    }
    if (request.stage === "contribution") return contribution(request);
    if (request.stage === "decision") return decision("synthesize");
    if (request.stage === "synthesis") { expect(request.context.pendingDoubts).toHaveLength(1); return { ...body, status: "partial", pending: ["Failed support"] }; }
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Finite consultation failures" }); await s.delivered.promise;
    expect(calls).toEqual(["support 0", "support 1"]);
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("failed");
    expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
  } finally { await s.close(); }
}));

test("continued rounds retain original doubts for the next consultation batch", fixture.ownedCase("table deferred doubts", async () => {
  let firstDoubt: string | undefined;
  const s = await setup({ prompt(session, request, body) {
    if (request.stage === "composition") return composition(request, 1);
    if (request.stage === "preparation") return preparation(request);
    if (request.stage === "contribution") return { ...contribution(request), doubts: session.model.id !== "director" ? [{ question: `Round ${request.round}`, purpose: "Deferred consultation" }] : [] };
    if (request.stage === "decision") {
      if (request.round === 1) firstDoubt = request.context.sources[0].body.doubts[0].id;
      return decision(request.round === 1 ? "continue" : request.round === 2 ? "consult" : "synthesize");
    }
    if (request.stage === "consultation-plan" && request.context.phase === "between-rounds") {
      expect(request.context.doubts.map((d: any) => request.context.sources.flatMap((source: any) => source.body.doubts ?? []).find((source: any) => source.id === d.id).question))
        .toEqual(["Round 1", "Round 2"]);
      expect(request.context.doubts[0].id).toBe(firstDoubt);
      return { kind: "consultation-plan", resolutions: request.context.doubts.map((d: any) => ({ doubtId: d.id, status: "answered", answer: "Resolved by Architect" })), support: [] };
    }
    if (request.stage === "knowledge") return { kind: "knowledge", resolutions: request.context.doubts.map((d: any) => ({ doubtId: d.id, status: "answered", answer: "Common knowledge", supportIds: [] })) };
    if (request.stage === "synthesis") {
      expect(request.context.pendingDoubts.map((d: any) => request.context.messages.flatMap((message: any) => message.body.doubts ?? []).find((source: any) => source.id === d.id).question))
        .toEqual(["Round 3"]);
      return { ...body, status: "partial", pending: ["Round 3"] };
    }
    return body;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Retain deferred questions" }); await s.delivered.promise;
    expect(s.seen.some(item => item.request.stage === "synthesis")).toBe(true);
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("failed");
  } finally { await s.close(); }
}));

for (const failure of ["missing", "cancelled", "objection"] as const) {
  test(`a ${failure} contribution is an explicit failure, not a valid proposal or empty doubt list`, fixture.ownedCase(`table turn ${failure}`, async () => {
    const entered = deferred(), release = deferred(); fixture.finishOnCleanup(release.resolve);
    let attempts = 0, invalidSession: any;
    const s = await setup({ async prompt(session, request, body) {
      if (request.stage === "composition") return composition(request, 2);
      if (request.stage === "preparation") return preparation(request);
      if (request.stage === "contribution") {
        attempts++;
        if (request.context.mandate === "Member 0") {
          invalidSession = session; entered.resolve(); await release.promise;
          if (failure === "objection") return contribution(request, [{ memberId: "invented", messageId: "invented", argument: "Unbound objection" }]);
          return false;
        }
        return contribution(request);
      }
      if (request.stage === "decision") {
        expect(request.context.sources).toHaveLength(2); expect(request.context.failures).toHaveLength(1);
        return decision("synthesize");
      }
      if (request.stage === "synthesis") return { ...body, status: "partial" };
      return body;
    } });
    try {
      const start = await s.invoke("architecture_start", { goal: "Protocol failure" }); await entered.promise;
      if (failure === "cancelled") {
        const status = (await s.invoke("team_status", {})).details.members;
        const member = status.find((row: any) => row.instanceId === executionForSession(invalidSession.sessionId)?.instanceId);
        expect(member).toBeDefined();
        expect((await s.invoke("team_cancel", { assignmentId: member.assignmentId })).isError).not.toBe(true);
      }
      release.resolve(); await s.delivered.promise;
      expect(attempts).toBe(3); expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("failed");
      const read = await s.read("architecture_read", { roomId: start.details.roomId });
      expect(read.failures).toHaveLength(1); expect(read.failures[0].stage).toBe("contribution"); expect(read.failures[0].round).toBe(1);
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    } finally { release.resolve(); await s.close(); }
  }));
}
