import { expect, test as bunTest } from "bun:test";
import { architectureFixture } from "./fixtures/architecture.ts";
import { teamWorkerResult, teamWorkerStatus } from "../extensions/agent/background.ts";
import { firstTeamReservation, teamAssignments } from "../extensions/team.ts";
import { isOrchestrationTool, toolsForProfile } from "../extensions/profile.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const { fixture, setup } = architectureFixture("review");
const test = (name: string, body: () => Promise<void>) => bunTest(name, fixture.ownedCase(name, body));
const deferred = <T = void>() => Promise.withResolvers<T>();
const start = { goal: "Review the whole object", object: { kind: "brief", text: "Controlled complete brief" }, criteria: ["Preserve authority"] };
const finding = { key: "authority", materiality: "blocking", contract: "Only the author can withdraw", reference: "source:12",
  consequence: "Another participant can erase a blocker", basis: { kind: "failure", path: "A reaches B without checking author", evidence: ["source:12-18"] } };
const reportFor = (f: Awaited<ReturnType<typeof setup>>, handle: any) => teamWorkerResult(f.evaluation.token, handle.instanceId)!;

test("registered review uses the real adapter, independent Reviewer preparation and separate subordinate/root disposal before one exterior report", async () => {
  const subordinate = deferred(), root = deferred(), subordinateEntered = deferred(), rootEntered = deferred();
  const f = await setup({ async dispose(session) {
    if (session.model.id === "director") { rootEntered.resolve(); await root.promise; }
    else { subordinateEntered.resolve(); await subordinate.promise; }
  }, prompt(session, request, body) {
    if (request.stage === "preparation") {
      expect(request.review).toBeUndefined();
      expect(request.context.shared).toBeUndefined();
      expect(request.snapshot).toBeUndefined();
      expect(request.controls).toBeUndefined();
      expect(request.journal).toBeUndefined();
      expect(request.object.selector).toEqual(start.object);
      expect(request.criteria).toEqual(start.criteria);
    }
    expect(session.boundTools.has("review_submit")).toBe(true);
    expect(session.boundTools.has("architecture_submit")).toBe(false);
    return body;
  } });
  try {
    const answer = await f.invoke("review_start", start); expect(answer.isError).not.toBe(true);
    const handle = answer.details;
    await subordinateEntered.promise;
    expect(f.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(0);
    expect(teamWorkerStatus(f.evaluation.token, handle.instanceId)[0]!.closure.state).toBe("pending");
    subordinate.resolve(); await rootEntered.promise;
    expect(f.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(0);
    root.resolve(); await f.delivered.promise;
    const result = reportFor(f, handle), report = JSON.parse(result.result);
    expect(result.status).toBe("completed"); expect(result.role).toBe("reviewer");
    expect(result.model.selectedModel).toBe("fixture/director");
    expect(report.completion).toBe("complete"); expect(report.verdict).toBe("no-blockers");
    expect(report.criteria).toEqual(start.criteria);
    expect(report.observations.final).toBe(report.object.identity);
    expect(f.seen.filter(item => item.request.stage === "preparation")).toHaveLength(2);
    expect(teamAssignments(f.evaluation).every(item => item.roleId === "reviewer")).toBe(true);
    expect(f.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
  } finally { subordinate.resolve(); root.resolve(); await f.close(); }
});

for (const action of ["stop", "team_cancel"] as const) test(`${action} preserves a published finding through terminal abort override and both disposals`, async () => {
  const later = deferred(), releasePrompt = deferred(), subordinate = deferred(), root = deferred(), subordinateEntered = deferred(), rootEntered = deferred();
  const f = await setup({
    async prompt(session, request, body) {
      if (request.stage === "preparation" && session.model.id !== "director") return { ...body, findings: [finding] };
      if (request.stage === "contribution" && session.model.id !== "director") { later.resolve(); await releasePrompt.promise; return false; }
      return body;
    },
    async dispose(session) {
      if (session.model.id === "director") { rootEntered.resolve(); await root.promise; }
      else { subordinateEntered.resolve(); await subordinate.promise; }
    },
  });
  try {
    const { details: handle } = await f.invoke("review_start", start);
    await later.promise;
    const cut = (await f.invoke("review_read", { roomId: handle.roomId })).details;
    expect(cut.fragments.some((fragment: any) => fragment.text.includes("authority"))).toBe(true);
    const cancelled = action === "stop" ? f.invoke("review_control", { roomId: handle.roomId, action }) : f.invoke("team_cancel", { assignmentId: handle.assignmentId });
    releasePrompt.resolve(); await cancelled; await subordinateEntered.promise;
    expect(f.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(0);
    subordinate.resolve(); await rootEntered.promise;
    expect(f.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(0);
    root.resolve(); await f.delivered.promise;
    const result = reportFor(f, handle), report = JSON.parse(result.result);
    expect(result.status).toBe("cancelled"); expect(report.findings).toHaveLength(1);
    expect(report.findings[0].key).toBe("authority");
    expect(report.missingValidSynthesis).toBe(true); expect(report.dispositions).toBeNull();
    expect(report.verdict).toBe("inconclusive");
    expect(f.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
  } finally { releasePrompt.resolve(); subordinate.resolve(); root.resolve(); await f.close(); }
});

for (const [action, window, verdict] of [
  ["stop", "subordinate", "no-blockers"],
  ["team_cancel", "root", "changes-required"],
] as const) test(`${action} after valid ${verdict} synthesis during ${window} disposal invalidates only the terminal judgment`, async () => {
  const subordinate = deferred(), root = deferred(), subordinateEntered = deferred(), rootEntered = deferred();
  const published = { ...finding, materiality: verdict === "no-blockers" ? "nonblocking" : "blocking" };
  const f = await setup({
    prompt(session, request, body) {
      if (request.stage === "preparation" && session.model.id !== "director") return { ...body, findings: [published] };
      if (request.stage === "contribution" && session.model.id !== "director") return { ...body, responses: [{
        findingId: request.review.findings[0].id, action: "corroborate", reason: "Independent reachable evidence", evidence: ["source:20"],
      }] };
      if (request.stage === "synthesis") return { ...body, verdict };
      return body;
    },
    async dispose(session) {
      if (session.model.id === "director") { rootEntered.resolve(); await root.promise; }
      else { subordinateEntered.resolve(); await subordinate.promise; }
    },
  });
  try {
    const { details: handle } = await f.invoke("review_start", start);
    const held = () => {
      expect(f.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(0);
      expect(() => teamWorkerResult(f.evaluation.token, handle.instanceId)).toThrow();
      expect(teamWorkerStatus(f.evaluation.token, handle.instanceId)[0]!.closure.state).toBe("pending");
      expect(firstTeamReservation(f.evaluation, "reviewer")).toBe(handle.assignmentId);
    };
    await subordinateEntered.promise;
    const synthesis = f.seen.find(item => item.request.stage === "synthesis")!;
    expect(synthesis.receipt.isError).not.toBe(true);
    expect((await f.invoke("review_read", { roomId: handle.roomId })).details.stage).toBe("closing");
    held();
    if (window === "root") { subordinate.resolve(); await rootEntered.promise; held(); }
    const cancelled = await (action === "stop"
      ? f.invoke("review_control", { roomId: handle.roomId, action })
      : f.invoke("team_cancel", { assignmentId: handle.assignmentId }));
    expect(cancelled.isError).not.toBe(true);
    held();
    subordinate.resolve(); await rootEntered.promise; held();
    root.resolve(); await f.delivered.promise;
    const result = reportFor(f, handle), report = JSON.parse(result.result);
    expect(result.status).toBe("cancelled");
    expect(report.completion).toBe("failed"); expect(report.verdict).toBe("inconclusive");
    expect(report.missingValidSynthesis).toBe(false);
    expect(report.findings).toEqual(synthesis.request.review.findings);
    expect(report.findings[0]).toMatchObject({ ...published, objectIdentity: report.object.identity });
    expect(report.responses).toEqual(synthesis.request.review.responses);
    expect(report.responses).toHaveLength(1);
    expect(report.dispositions).toEqual(report.synthesis.dispositions);
    expect(report.dispositions).toHaveLength(1);
    expect(report.synthesis).toMatchObject({ completion: "complete", verdict });
    expect(report.messages.slice(0, -1)).toEqual(synthesis.request.context.messages);
    expect(report.messages.at(-1).body).toEqual(report.synthesis);
    expect(report.observations).toEqual({ launch: report.object.identity, final: report.object.identity, error: null });
    const delivered = f.sent.filter(item => item.message.customType === "pitako.worker.result");
    expect(delivered).toHaveLength(1);
    expect(delivered[0].message.details.status).toBe("cancelled");
    expect(JSON.parse(delivered[0].message.content)).toEqual(report);
    expect(teamWorkerStatus(f.evaluation.token, handle.instanceId)[0]!.closure.state).toBe("released");
    expect(firstTeamReservation(f.evaluation, "reviewer")).toBeUndefined();
  } finally { subordinate.resolve(); root.resolve(); await f.close(); }
});

test("absent candidate pools still run director-only review; public names guard orchestration but not local submit", async () => {
  const f = await setup({ config: "", prompt(_session, request, body) {
    if (request.stage === "composition") return { ...body, specialists: [] };
    return body;
  } });
  try {
    const answer = await f.invoke("review_start", start);
    expect(answer.isError).not.toBe(true); await f.delivered.promise;
    expect(reportFor(f, answer.details).status).toBe("completed");
    expect(teamAssignments(f.evaluation)).toHaveLength(1); expect(f.host.sessions).toHaveLength(1);
    expect(f.seen.filter(item => item.request.stage === "preparation")).toHaveLength(1);
    expect(f.seen.filter(item => item.request.stage === "contribution")).toHaveLength(1);
    const names = ["review_start", "review_read", "review_control", "review_submit"];
    expect(names.map(isOrchestrationTool)).toEqual([true, true, true, false]);
    for (const profile of ["coding", "analysis"] as const)
      expect(toolsForProfile({ available: names, profile, child: true })).toEqual(["review_submit"]);
  } finally { await f.close(); }
});

for (const verdict of ["changes-required", "inconclusive"] as const) test(`complete ${verdict} is completed work, never product acceptance`, async () => {
  const f = await setup({ prompt(session, request, body) {
    if (request.stage === "preparation" && session.model.id !== "director") return { ...body, findings: [finding] };
    if (request.stage === "synthesis") return { ...body, verdict, newFindings: [{ finding: { ...finding, key: "director-blocker" },
      status: "unresolved", reason: "Independent director finding", references: [] }] };
    return body;
  } });
  try {
    const { details: handle } = await f.invoke("review_start", start); await f.delivered.promise;
    const result = reportFor(f, handle), report = JSON.parse(result.result);
    expect(result.status).toBe("completed"); expect(report.verdict).toBe(verdict); expect(report.findings).toHaveLength(2);
    expect(report.dispositions).toHaveLength(2);
    expect(new Set(report.dispositions.map((item: any) => item.findingId))).toEqual(new Set(report.findings.map((item: any) => item.id)));
    expect(report.findings.find((item: any) => item.key === "director-blocker").author).toBe("reviewer");
  } finally { await f.close(); }
});

test("topic fallback resets each logical turn, deduplicates models and never inherits director reasoning", async () => {
  const attempts: [string, string, string][] = [];
  const f = await setup({ prompt(session, request) {
    if (request.stage === "preparation" || request.stage === "contribution") {
      if (session.model.id === "director") { expect(session.thinkingLevel).toBe("low"); return; }
      attempts.push([request.stage, session.model.id, session.thinkingLevel]);
      if (session.model.id !== "general") throw new Error("503 Service Unavailable");
    }
  } });
  try {
    const { details: handle } = await f.invoke("review_start", start); await f.delivered.promise;
    expect(attempts).toEqual(["preparation", "contribution"].flatMap(stage =>
      [[stage, "chosen", "high"], [stage, "other", "minimal"], [stage, "general", "minimal"]]));
    expect(reportFor(f, handle).status).toBe("completed");
    expect(f.host.sessions).toHaveLength(2);
    const dispatch = f.host.sessions[0]!.sessionManager.getEntries().find((entry: any) => entry.customType === "pitako.review.dispatch") as any;
    expect(dispatch.data.callerSessionId).toBe(f.host.sessions[0]!.sessionId);
    expect(dispatch.data.toolCallId).toBe("native-submit");
    expect(dispatch.data.parentAssignmentId).toBe(handle.assignmentId);
  } finally { await f.close(); }
});

for (const failure of ["invalid-synthesis", "drift", "observation-failure"] as const) test(`${failure} cannot approve and preserves canonical published evidence`, async () => {
  let f: Awaited<ReturnType<typeof setup>>;
  f = await setup({ prompt(session, request, body) {
    if (request.stage === "preparation" && session.model.id !== "director") return { ...body, findings: [finding] };
    if (request.stage === "synthesis") {
      if (failure === "invalid-synthesis") return false; // Final prose is insufficient.
      writeFileSync(path.join(f.root, ".pitako/plans/object.md"), failure === "drift"
        ? "---\nid: object\nrevision: 1\nstatus: draft\n---\nChanged substantive object\n" : "invalid metadata");
      return { ...body, verdict: "changes-required" };
    }
  } });
  try {
    mkdirSync(path.join(f.root, ".pitako/plans"), { recursive: true });
    writeFileSync(path.join(f.root, ".pitako/plans/object.md"), "---\nid: object\nrevision: 1\nstatus: draft\n---\nOriginal substantive object\n");
    const { details: handle } = await f.invoke("review_start", { ...start, object: { kind: "plan", planId: "object" } }); await f.delivered.promise;
    const result = reportFor(f, handle), report = JSON.parse(result.result);
    expect(result.status).toBe("failed"); expect(report.verdict).toBe("inconclusive"); expect(report.findings).toHaveLength(1);
    expect(report.findings[0].objectIdentity).toBe(report.object.identity);
    expect(report.missingValidSynthesis).toBe(failure === "invalid-synthesis");
    if (failure === "invalid-synthesis") expect(report.dispositions).toBeNull();
    else if (failure === "drift") expect(report.observations.final).not.toBe(report.object.identity);
    else expect(report.observations.error).toContain("plan is missing frontmatter");
  } finally { await f.close(); }
});

test("round publication is atomic in composition order; finish drains current work and forbids complete truncation", async () => {
  const first = deferred(), release = deferred(), second = deferred();
  let preparers = 0;
  const f = await setup({ async prompt(session, request, body) {
    if (request.stage === "composition") return { ...body, specialists: ["first", "second"].map(mandate =>
      ({ kind: "add", candidateRef: "general:0", mandate, reason: "Independent review" })) };
    if (request.stage === "preparation" && session.model.id !== "director") {
      const key = ++preparers === 1 ? "first" : "second";
      if (key === "first") { first.resolve(); await release.promise; }
      else second.resolve();
      return { ...body, findings: [{ ...finding, key }] };
    }
    if (request.stage === "synthesis") return { ...body, completion: "partial", verdict: "changes-required" };
  } });
  try {
    const { details: handle } = await f.invoke("review_start", start); await first.promise; await second.promise;
    const read = (await f.invoke("review_read", { roomId: handle.roomId })).details;
    expect(read.fragments.map((item: any) => item.text).join("")).not.toContain('"kind":"preparation"');
    await f.invoke("review_control", { roomId: handle.roomId, action: "priorities", text: "Focus retained evidence" });
    await f.invoke("review_control", { roomId: handle.roomId, action: "finish" });
    expect(f.sent).toHaveLength(0); release.resolve(); await f.delivered.promise;
    const report = JSON.parse(reportFor(f, handle).result);
    expect(report.completion).toBe("partial"); expect(report.verdict).toBe("inconclusive");
    expect(report.findings.map((item: any) => item.key)).toEqual(["first", "second"]);
    expect(report.messages.filter((item: any) => item.stage === "preparation")).toHaveLength(3);
    expect(report.failures).toContain("Finish truncated scheduled review work");
    expect(f.seen.filter(item => item.request.stage === "synthesis")[0]!.request.context.controls)
      .toContainEqual({ action: "priorities", text: "Focus retained evidence" });
  } finally { release.resolve(); await f.close(); }
});

test("failed director preparation does not erase valid peers or become complete through synthesis", async () => {
  const f = await setup({ prompt(session, request, body) {
    if (request.stage === "preparation") return session.model.id === "director" ? false : { ...body, findings: [finding] };
    if (request.stage === "synthesis") return { ...body, completion: "partial", verdict: "changes-required" };
  } });
  try {
    const { details: handle } = await f.invoke("review_start", start); await f.delivered.promise;
    const report = JSON.parse(reportFor(f, handle).result);
    expect(reportFor(f, handle).status).toBe("failed"); expect(report.completion).toBe("partial");
    expect(report.findings).toHaveLength(1); expect(report.dispositions).toHaveLength(1);
    expect(report.failures.some((error: string) => error.includes("no valid settled submit"))).toBe(true);
    expect(f.host.sessions).toHaveLength(2);
  } finally { await f.close(); }
});

test("recomposition joins outgoing specialists and independently prepares newcomers without discarding findings", async () => {
  let compositions = 0;
  const outgoing = deferred(), release = deferred();
  const f = await setup({ async dispose(session) {
    if (session.model.id === "chosen") { outgoing.resolve(); await release.promise; }
  }, prompt(session, request, body) {
    if (request.stage === "composition" && ++compositions === 2) return { ...body, specialists: [{ kind: "add", candidateRef: "general:0", mandate: "Fresh review", reason: "Independent challenge" }] };
    if (request.stage === "preparation") {
      expect(request.review).toBeUndefined();
      expect(request.authorization).toEqual({ kind: "preparation" });
      expect(request.journal).toBeUndefined();
      if (session.model.id === "chosen") return { ...body, findings: [finding] };
    }
    if (request.stage === "decision") return { ...body, action: request.round === 1 ? "recompose" : "synthesize" };
    if (request.stage === "synthesis") return { ...body, verdict: "changes-required" };
  } });
  try {
    const { details: handle } = await f.invoke("review_start", start); await outgoing.promise;
    expect(f.host.sessions).toHaveLength(2); expect(f.sent).toHaveLength(0);
    release.resolve(); await f.delivered.promise;
    expect(f.host.sessions).toHaveLength(3);
    expect(f.host.sessions.find(session => session.model?.id === "general")!.prompts.map((text: string) => JSON.parse(text).stage)).toContain("preparation");
    const report = JSON.parse(reportFor(f, handle).result);
    expect(report.completion).toBe("complete"); expect(report.findings).toHaveLength(1); expect(report.dispositions).toHaveLength(1);
  } finally { release.resolve(); await f.close(); }
});

test("prohibited sixth round is not disguised as complete work", async () => {
  const f = await setup({ prompt(_session, request, body) {
    if (request.stage === "decision") return { ...body, action: "continue" };
  } });
  try {
    const { details: handle } = await f.invoke("review_start", start); await f.delivered.promise;
    expect(f.seen.filter(item => item.request.stage === "contribution")).toHaveLength(10);
    expect(f.seen.every(item => (item.request.round ?? 0) <= 5)).toBe(true);
    const report = JSON.parse(reportFor(f, handle).result);
    expect(reportFor(f, handle).status).toBe("failed"); expect(report.completion).toBe("failed");
    expect(report.missingValidSynthesis).toBe(true);
  } finally { await f.close(); }
});

test("support capacity includes retained disposal and dependencies consume only closed evidence", async () => {
  const both = deferred(), disposing = deferred(), releasePrompt = deferred(), releaseDispose = deferred();
  let calls = 0, active = 0, maxActive = 0, disposalCalls = 0;
  const f = await setup({ async dispose(session) {
    if (session.model.id !== "support") return;
    if (++disposalCalls === 2) disposing.resolve();
    await releaseDispose.promise; active--;
  }, async prompt(session, request, body) {
    if (request.stage === "preparation" && session.model.id !== "director")
      return { ...body, doubts: [0, 1, 2].map(index => ({ question: `Question ${index}`, purpose: "Required observation" })) };
    if (request.stage === "consultation-plan") return { kind: "consultation-plan", resolutions: [], support: request.context.doubts.map((doubt: any, index: number) =>
      ({ role: "scout", brief: `support ${index}`, doubtIds: [doubt.id], prerequisites: index === 2 ? [0] : [] })) };
    if (request.stage === "consultation-response") {
      calls++; active++; maxActive = Math.max(maxActive, active); if (calls === 2) both.resolve();
      if (calls === 3) expect(disposalCalls).toBe(2);
      await releasePrompt.promise;
      return { kind: "consultation-response", doubtIds: request.context.request.doubtIds, answer: "Controlled observation", evidence: ["source:42"], limits: [], doubts: [] };
    }
    if (request.stage === "knowledge") return { kind: "knowledge", resolutions: request.context.doubts.map((doubt: any, index: number) =>
      ({ doubtId: doubt.id, status: "answered", answer: "Observed", supportIds: [request.context.responses[index].id] })) };
  } });
  try {
    const { details: handle } = await f.invoke("review_start", start); await both.promise;
    expect(calls).toBe(2); expect(maxActive).toBe(2);
    releasePrompt.resolve(); await disposing.promise;
    expect(calls).toBe(2); expect(active).toBe(2); expect(f.sent).toHaveLength(0);
    releaseDispose.resolve(); await f.delivered.promise;
    expect(calls).toBe(3); expect(active).toBe(0); expect(maxActive).toBe(2);
    expect(reportFor(f, handle).status).toBe("completed");
    expect(JSON.parse(reportFor(f, handle).result).findings).toEqual([]);
  } finally { releasePrompt.resolve(); releaseDispose.resolve(); await f.close(); }
});
