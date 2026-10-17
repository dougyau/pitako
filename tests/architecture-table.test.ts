import { expect, test } from "bun:test";
import { workerHandoff, teamWorkerStatus } from "../extensions/agent/background.ts";
import { firstTeamReservation } from "../extensions/team.ts";
import { executionForSession } from "../extensions/execution-identity.ts";
import { architectureFixture } from "./fixtures/architecture.ts";

const { fixture, setup } = architectureFixture();
const deferred = <T = void>() => Promise.withResolvers<T>();
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const composition = (request: any, count = 5) => ({ kind: "composition", snapshotId: request.snapshot.id,
  specialists: Array.from({ length: count }, (_, index) => ({ candidateRef: "topic:0:0", mandate: `Member ${index}`, reason: "Independent perspective" })) });
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
      if (request.stage === "preparation") { expect(request.context.shared.messages).toEqual([]); return preparation(request, true); }
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
        roundPrompts.push(request); if (roundPrompts.length === 5) roundEntered.resolve(); await releaseRound.promise;
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
      const start = await s.invoke("architecture_start", { mode: "table", goal: "Compare support order", topic: "security" });
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
      expect(roundPrompts[0].context.shared.messages.filter((message: any) => message.stage === "knowledge")).toHaveLength(1);
      expect(roundPrompts[0].context.shared.messages.some((message: any) => message.stage === "consultation-response")).toBe(false);
      expect(s.host.sessions.filter(session => session.model?.id === "chosen")).toHaveLength(5);
      expect(s.host.sessions.filter(session => !session.events.includes("dispose")).every(session => executionForSession(session.sessionId)?.profile === "analysis")).toBe(true);
      for (const session of s.host.sessions) {
        expect(session.active).not.toContain("architecture_start"); expect(session.active).not.toContain("team_assign");
        expect(session.active).not.toContain("agent_spawn"); expect(session.active).not.toContain("edit");
      }
      releaseRound.resolve(); await s.delivered.promise;
      expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("completed");
      expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
      expect(maxActive).toBe(2);
    } finally { release(); await s.close(); }
  }
  expect(packages[0]).toBe(packages[1]);
}));

test("round frontiers freeze objections and controls; replacement waits for all five outgoing owners", fixture.ownedCase("table frontier replacement", async () => {
  const entered = deferred(), releaseRound = deferred(), closing = deferred(), releaseOutgoing = deferred(), synthesis = deferred(), releaseSynthesis = deferred();
  const release = () => { releaseRound.resolve(); releaseOutgoing.resolve(); releaseSynthesis.resolve(); }; fixture.finishOnCleanup(release);
  const prompts: any[] = [], outgoing: any[] = []; let compositionCount = 0, disposalCount = 0;
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "composition") { compositionCount++; return composition(request); }
    if (request.stage === "preparation") { expect(request.context.shared.messages).toEqual([]); return preparation(request); }
    if (request.stage === "contribution") {
      prompts.push(request);
      const prior = request.context.shared.messages.find((message: any) => message.author === "specialist" && message.body.analysis !== request.context.mandate);
      if (request.round === 1) { outgoing.push(session); if (outgoing.length === 5) entered.resolve(); await releaseRound.promise; }
      return contribution(request, prior ? [{ memberId: prior.memberId, messageId: prior.id, argument: "Counterargument, not a doubt" }] : []);
    }
    if (request.stage === "decision") {
      expect(request.controls).toEqual(request.round === 1 ? [] : [{ action: "context", text: "new context" }, { action: "priorities", text: "new priority" }]);
      return decision(request.round === 1 ? "recompose" : "synthesize");
    }
    if (request.stage === "synthesis") { synthesis.resolve(); await releaseSynthesis.promise; }
    return body;
  }, async dispose(session) {
    if (outgoing.includes(session)) { if (++disposalCount === 5) closing.resolve(); await releaseOutgoing.promise; }
  } });
  try {
    const start = await s.invoke("architecture_start", { mode: "table", goal: "Frontier changes" }); await entered.promise;
    const first = JSON.stringify(prompts[0].context.shared);
    expect(prompts.every(request => JSON.stringify(request.context.shared) === first)).toBe(true);
    const before = (await s.invoke("architecture_read", { roomId: start.details.roomId })).details;
    const cursor = before.cursor;
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "context", text: "new context" });
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "priorities", text: "new priority" });
    expect(JSON.stringify(prompts[0].context.shared)).toBe(first);
    releaseRound.resolve(); await closing.promise;
    expect(compositionCount).toBe(2); expect(s.host.sessions.filter(session => session.model?.id === "chosen")).toHaveLength(5);
    expect(teamWorkerStatus(s.evaluation.token).filter(row => row.teamId === start.details.roomId && row.instanceId !== start.details.instanceId && row.closure.state === "pending")).toHaveLength(5);
    expect(workerHandoff(start.details.instanceId)).toBeUndefined(); await observePrivate(s);
    releaseOutgoing.resolve(); await synthesis.promise;
    const second = prompts.filter(request => request.round === 2);
    expect(second).toHaveLength(5); expect(second.every(request => JSON.stringify(request.context.shared) === JSON.stringify(second[0].context.shared))).toBe(true);
    expect(second[0].context.shared.id).not.toBe(prompts[0].context.shared.id);
    expect(second[0].context.shared.controls).toEqual([{ action: "context", text: "new context" }, { action: "priorities", text: "new priority" }]);
    expect(second[0].context.shared.messages.filter((message: any) => message.stage === "contribution")).toHaveLength(5);
    expect(second[0].context.shared.messages.filter((message: any) => message.stage === "contribution").every((message: any) => message.body.objections.length === 1 && message.doubts.length === 0)).toBe(true);
    const readAgain = (await s.invoke("architecture_read", { roomId: start.details.roomId, ...(cursor ? { cursor } : {}) })).details;
    if (cursor) expect(readAgain.cut).toBe(before.cut);
    expect(s.host.sessions.filter(session => session.model?.id === "chosen")).toHaveLength(10);
    expect(outgoing.every(session => session.events.includes("dispose"))).toBe(true); await observePrivate(s);
    releaseSynthesis.resolve(); await s.delivered.promise;
    expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("completed");
  } finally { release(); await s.close(); }
}));

for (const action of ["consult", "continue"] as const) {
  test(`round five ${action} cannot dispatch round six; final clarification is partial`, fixture.ownedCase(`table limit ${action}`, async () => {
    const rounds: number[] = [], phases: string[] = []; let supports = 0;
    const s = await setup({ async prompt(session, request, body) {
      if (request.stage === "composition") return composition(request, 2);
      if (request.stage === "preparation") return preparation(request);
      if (request.stage === "contribution") { rounds.push(request.round); return { ...contribution(request), doubts: request.round === 5 ? [{ question: "Redesign?", purpose: "Final clarification" }] : [] }; }
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
      const start = await s.invoke("architecture_start", { mode: "table", goal: "Bounded rounds" }); await s.delivered.promise;
      expect(rounds).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
      expect(phases).toEqual(action === "consult" ? ["initial", "final-clarification"] : ["initial"]);
      expect(supports).toBe(action === "consult" ? 1 : 0);
      expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("failed");
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
      if (request.stage === "preparation") {
        children.push(session); if (children.length === 2) entered.resolve(); await releasePrompt.promise;
        return action === "finish" ? preparation(request) : false;
      }
      if (request.stage === "synthesis") syntheses++;
      return body;
    }, async dispose(session) { if (children.includes(session)) { disposing.resolve(); await releaseDispose.promise; } } });
    try {
      const start = await s.invoke("architecture_start", { mode: "table", goal: "Control stages" }); await entered.promise;
      const controlled = action === "team_cancel" ? await s.invoke("team_cancel", { assignmentId: start.details.assignmentId })
        : await s.invoke("architecture_control", { roomId: start.details.roomId, action });
      expect(controlled.isError).not.toBe(true); await tick();
      expect(children.every(session => session.events.includes("abort"))).toBe(action !== "finish");
      expect(workerHandoff(start.details.instanceId)).toBeUndefined();
      expect(firstTeamReservation(s.evaluation, "architect")).toBe(start.details.assignmentId);
      releasePrompt.resolve(); await disposing.promise;
      expect(syntheses).toBe(action === "finish" ? 1 : 0); expect(workerHandoff(start.details.instanceId)).toBeUndefined(); await observePrivate(s);
      releaseDispose.resolve(); await s.delivered.promise;
      expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe(action === "finish" ? "completed" : "cancelled");
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
      expect(s.seen.some(item => item.request.stage === "contribution")).toBe(false);
    } finally { release(); await s.close(); }
  }));
}


test("failed support prerequisites are unresolved, while independent support progresses and new doubts do not recurse", fixture.ownedCase("table support failure", async () => {
  const calls: string[] = [];
  const s = await setup({ prompt(_session, request, body) {
    if (request.stage === "composition") return composition(request, 3);
    if (request.stage === "preparation") return preparation(request, true);
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
    const start = await s.invoke("architecture_start", { mode: "table", goal: "Finite consultation failures" }); await s.delivered.promise;
    expect(calls).toEqual(["support 0", "support 1"]);
    expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("failed");
    expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
  } finally { await s.close(); }
}));

test("continued rounds retain original doubts for the next consultation batch", fixture.ownedCase("table deferred doubts", async () => {
  let firstDoubt: string | undefined;
  const s = await setup({ prompt(_session, request, body) {
    if (request.stage === "composition") return composition(request, 1);
    if (request.stage === "preparation") return preparation(request);
    if (request.stage === "contribution") return { ...contribution(request), doubts: [{ question: `Round ${request.round}`, purpose: "Deferred consultation" }] };
    if (request.stage === "decision") {
      if (request.round === 1) firstDoubt = request.context.sources[0].doubts[0].id;
      return decision(request.round === 1 ? "continue" : request.round === 2 ? "consult" : "synthesize");
    }
    if (request.stage === "consultation-plan" && request.context.phase === "between-rounds") {
      expect(request.context.doubts.map((d: any) => d.question)).toEqual(["Round 1", "Round 2"]);
      expect(request.context.doubts[0].id).toBe(firstDoubt);
      return { kind: "consultation-plan", resolutions: request.context.doubts.map((d: any) => ({ doubtId: d.id, status: "answered", answer: "Resolved by Architect" })), support: [] };
    }
    if (request.stage === "knowledge") return { kind: "knowledge", resolutions: request.context.doubts.map((d: any) => ({ doubtId: d.id, status: "answered", answer: "Common knowledge", supportIds: [] })) };
    if (request.stage === "synthesis") {
      expect(request.context.pendingDoubts.map((d: any) => d.question)).toEqual(["Round 3"]);
      return { ...body, status: "partial", pending: ["Round 3"] };
    }
    return body;
  } });
  try {
    const start = await s.invoke("architecture_start", { mode: "table", goal: "Retain deferred questions" }); await s.delivered.promise;
    expect(s.seen.some(item => item.request.stage === "synthesis")).toBe(true);
    expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("failed");
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
        expect(request.context.sources).toHaveLength(1); expect(request.context.failures).toHaveLength(1);
        return decision("synthesize");
      }
      return body;
    } });
    try {
      const start = await s.invoke("architecture_start", { mode: "table", goal: "Protocol failure" }); await entered.promise;
      if (failure === "cancelled") {
        const status = (await s.invoke("team_status", {})).details.members;
        const member = status.find((row: any) => row.instanceId === executionForSession(invalidSession.sessionId)?.instanceId);
        expect(member).toBeDefined();
        expect((await s.invoke("team_cancel", { assignmentId: member.assignmentId })).isError).not.toBe(true);
      }
      release.resolve(); await s.delivered.promise;
      expect(attempts).toBe(2); expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("failed");
      const read = (await s.invoke("architecture_read", { roomId: start.details.roomId })).details;
      expect(read.failures).toHaveLength(1); expect(read.failures[0].stage).toBe("contribution"); expect(read.failures[0].round).toBe(1);
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    } finally { release.resolve(); await s.close(); }
  }));
}
