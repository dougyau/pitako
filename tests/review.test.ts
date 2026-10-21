import { expect, test as bunTest } from "bun:test";
import { architectureFixture, reviewResults, tablePrompt } from "./fixtures/architecture.ts";
import { readTableResult, teamWorkerResult, teamWorkerStatus } from "../extensions/agent/background.ts";
import { firstTeamReservation, teamAssignments } from "../extensions/team.ts";
import { isOrchestrationTool, toolsForProfile } from "../extensions/profile.ts";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { captureObject, consultedPlan, describeObject } from "../extensions/review/object.ts";

const { fixture, setup } = architectureFixture("review");
const test = (name: string, body: () => Promise<void>) => bunTest(name, fixture.ownedCase(name, body));
const deferred = <T = void>() => Promise.withResolvers<T>();
const start = { goal: "Review the whole object", object: { kind: "brief", text: "Controlled complete brief" }, criteria: ["Preserve authority"] };
const finding = { key: "authority", materiality: "blocking", contract: "Only the author can withdraw", reference: "source:12",
  consequence: "Another participant can erase a blocker", basis: { kind: "failure", path: "A reaches B without checking author", evidence: ["source:12-18"] } };
const reportFor = (f: Awaited<ReturnType<typeof setup>>, handle: any) => {
  const saved = teamWorkerResult(f.evaluation.token, handle.instanceId)!;
  const delivered = f.sent.filter(item => item.message.customType === "pitako.worker.result");
  expect(delivered).toHaveLength(1);
  const automatic = JSON.parse(delivered[0].message.content).projection;
  expect(automatic.header).toMatchObject({ section: "report", acceptance: false });
  let page = JSON.parse(readTableResult(f.evaluation.token, handle.instanceId, {}).content[0]!.text);
  let canonical = page.fragment;
  while (page.header.cursor) {
    page = JSON.parse(readTableResult(f.evaluation.token, handle.instanceId, { cursor: page.header.cursor }).content[0]!.text);
    canonical += page.fragment;
  }
  const report = JSON.parse(canonical);
  expect(report).not.toHaveProperty("messages");
  expect(report.object).not.toHaveProperty("scope");
  expect(report.goal).toBe(start.goal);
  expect(report.criteria).toEqual(start.criteria);
  expect(report.modelObservations.length).toBeGreaterThan(0);
  return { ...saved, report };
};
async function journalFor(f: Awaited<ReturnType<typeof setup>>, handle: any) {
  return f.read("review_read", { roomId: handle.roomId, section: "messages" });
}
async function diagnosticFor(f: Awaited<ReturnType<typeof setup>>, handle: any) {
  const saved = reportFor(f, handle), diagnostic = await f.read("team_result", { assignmentId: handle.assignmentId });
  expect(diagnostic.host.status).toBe(saved.status);
  expect(diagnostic).toEqual(saved.report);
}

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
    const result = reportFor(f, handle), report = result.report;
    expect(result.status).toBe("completed"); expect(result.role).toBe("reviewer");
    expect(result.model.selectedModel).toBe("fixture/director");
    expect(report.judgment.completion).toBe("complete"); expect(report.judgment.verdict).toBe("no-blockers");
    expect(report.criteria).toEqual(start.criteria);
    expect(report.observations.final).toBe(report.object.identity);
    expect(f.seen.filter(item => item.request.stage === "preparation")).toHaveLength(2);
    expect(teamAssignments(f.evaluation).every(item => item.roleId === "reviewer")).toBe(true);
    expect(f.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
    await diagnosticFor(f, handle);
  } finally { subordinate.resolve(); root.resolve(); await f.close(); }
});

for (const action of ["stop", "team_cancel"] as const) for (const window of ["contribution", "consultation-plan"] as const)
test(`${action} during ${window} preserves published evidence through terminal abort override and both disposals`, async () => {
  const later = deferred(), releasePrompt = deferred(), subordinate = deferred(), root = deferred(), subordinateEntered = deferred(), rootEntered = deferred();
  const f = await setup({
    async prompt(session, request, body) {
      if (request.stage === "preparation" && session.model.id !== "director") return { ...body, findings: [finding],
        ...(window === "consultation-plan" ? { doubts: [{ question: "Cancellation observation still needed", purpose: "Preserve pending evidence" }] } : {}) };
      if (request.stage === window && (window === "consultation-plan" || session.model.id !== "director")) {
        later.resolve(); await releasePrompt.promise; return false;
      }
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
    const cut = await journalFor(f, handle);
    expect(cut.some((message: any) => message.body?.findings?.some((item: any) => item.key === "authority"))).toBe(true);
    const cancelled = action === "stop" ? f.invoke("review_control", { roomId: handle.roomId, action }) : f.invoke("team_cancel", { assignmentId: handle.assignmentId });
    releasePrompt.resolve(); await cancelled; await subordinateEntered.promise;
    expect(f.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(0);
    subordinate.resolve(); await rootEntered.promise;
    expect(f.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(0);
    root.resolve(); await f.delivered.promise;
    const result = reportFor(f, handle), report = result.report;
    expect(result.status).toBe("cancelled"); expect(report.findings).toHaveLength(1);
    expect(report.findings[0].key).toBe("authority");
    expect(report.findings[0]).toMatchObject(finding);
    expect(report.missingValidSynthesis).toBe(true); expect(report.judgment).toBeNull();
    expect(report.pending).toEqual(window === "consultation-plan"
      ? [{ id: expect.any(String), question: "Cancellation observation still needed", purpose: "Preserve pending evidence" }] : []);
    expect(f.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
    await diagnosticFor(f, handle);
    const journal = await journalFor(f, handle);
    expect(journal.find((message: { body: { findings?: unknown[] } }) => message.body.findings?.length).body.findings).toEqual([finding]);
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
        findingId: reviewResults(request).findings[0].id, action: "corroborate", reason: "Independent reachable evidence", evidence: ["source:20"],
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
      expect((await f.read("review_read", { roomId: handle.roomId })).stage).toBe("closing");
    held();
    if (window === "root") { subordinate.resolve(); await rootEntered.promise; held(); }
    const cancelled = await (action === "stop"
      ? f.invoke("review_control", { roomId: handle.roomId, action })
      : f.invoke("team_cancel", { assignmentId: handle.assignmentId }));
    expect(cancelled.isError).not.toBe(true);
    held();
    subordinate.resolve(); await rootEntered.promise; held();
    root.resolve(); await f.delivered.promise;
    const result = reportFor(f, handle), report = result.report;
    expect(result.status).toBe("cancelled");
    expect(report.judgment).toBeNull();
    expect(report.missingValidSynthesis).toBe(false);
    expect(report.findings).toEqual(reviewResults(synthesis.request).findings);
    expect(report.findings[0]).toMatchObject({ ...published, objectIdentity: report.object.identity });
    expect(report.responses).toEqual(reviewResults(synthesis.request).responses);
    expect(report.responses).toHaveLength(1);
    const discarded = report.history.discardedJudgment;
    expect(discarded.dispositions).toEqual(discarded.synthesis.dispositions);
    expect(discarded.dispositions).toHaveLength(1);
    expect(discarded.synthesis).toMatchObject({ completion: "complete", verdict });
    const journal = await journalFor(f, handle);
    expect(journal.filter((message: any) => ["preparation", "contribution"].includes(message.stage)).map((message: any) => message.id))
      .toEqual(synthesis.request.context.messages.map((message: any) => message.id));
    expect(journal.at(-1).body).toEqual(discarded.synthesis);
    expect(journal.filter((message: { body?: unknown }) => message.body).every((message: {
      native: { sessionId: string }; turnId: string; attemptId: string;
    }) => !!(message.native.sessionId && message.turnId && message.attemptId))).toBe(true);
    expect(report.grounds).toContainEqual(expect.objectContaining({
      reference: report.findings[0].messageId, content: { analysis: "Independent whole-object review" },
    }));
    expect(report.observations).toEqual({ launch: report.object.identity, final: report.object.identity, error: null });
    const delivered = f.sent.filter(item => item.message.customType === "pitako.worker.result");
    expect(delivered).toHaveLength(1);
    expect(delivered[0].message.details.status).toBe("cancelled");
    const automatic = JSON.parse(delivered[0].message.content).projection;
    if (automatic.header.complete) expect(automatic.report.judgment).toBeNull();
    else expect(automatic.notice).toContain("team_result");
    expect(teamWorkerStatus(f.evaluation.token, handle.instanceId)[0]!.closure.state).toBe("released");
    expect(firstTeamReservation(f.evaluation, "reviewer")).toBeUndefined();
    await diagnosticFor(f, handle);
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
    const result = reportFor(f, handle), report = result.report;
    expect(result.status).toBe("completed"); expect(report.judgment.verdict).toBe(verdict); expect(report.findings).toHaveLength(2);
    expect(report.judgment.dispositions).toHaveLength(2);
    expect(new Set(report.judgment.dispositions.map((item: any) => item.findingId))).toEqual(new Set(report.findings.map((item: any) => item.id)));
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
    const result = reportFor(f, handle), report = result.report;
    expect(result.status).toBe("failed"); expect(report.judgment?.verdict ?? "inconclusive").toBe("inconclusive"); expect(report.findings).toHaveLength(1);
    expect(report.findings[0].objectIdentity).toBe(report.object.identity);
    expect(report.findings[0]).toMatchObject(finding);
    expect(report.missingValidSynthesis).toBe(failure === "invalid-synthesis");
    if (failure === "invalid-synthesis") expect(report.judgment).toBeNull();
    else if (failure === "drift") expect(report.observations.final).not.toBe(report.object.identity);
    else expect(report.observations.error).toContain("plan is missing frontmatter");
    expect(result.result).not.toContain("Original substantive object");
    await diagnosticFor(f, handle);
    expect((await journalFor(f, handle)).some((message: { body: { findings?: { key: string }[] } }) => message.body.findings?.[0]?.key === finding.key)).toBe(true);
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
    const read = await journalFor(f, handle);
    expect(read.some((item: any) => item.stage === "preparation")).toBe(false);
    await f.invoke("review_control", { roomId: handle.roomId, action: "priorities", text: "Focus retained evidence" });
    await f.invoke("review_control", { roomId: handle.roomId, action: "finish" });
    expect(f.sent).toHaveLength(0); release.resolve(); await f.delivered.promise;
    const report = reportFor(f, handle).report;
    expect(report.judgment.completion).toBe("partial"); expect(report.judgment.verdict).toBe("inconclusive");
    expect(report.findings.map((item: any) => item.key)).toEqual(["first", "second"]);
    expect((await journalFor(f, handle)).filter((item: any) => item.stage === "preparation")).toHaveLength(3);
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
    const report = reportFor(f, handle).report;
    expect(reportFor(f, handle).status).toBe("failed"); expect(report.judgment.completion).toBe("partial");
    expect(report.findings).toHaveLength(1); expect(report.judgment.dispositions).toHaveLength(1);
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
    expect(f.host.sessions.find(session => session.model?.id === "general")!.prompts.map((text: string) => tablePrompt(text).stage)).toContain("preparation");
    const report = reportFor(f, handle).report;
    expect(report.judgment.completion).toBe("complete"); expect(report.findings).toHaveLength(1); expect(report.judgment.dispositions).toHaveLength(1);
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
    const report = reportFor(f, handle).report;
    expect(reportFor(f, handle).status).toBe("failed"); expect(report.judgment).toBeNull();
    expect(report.missingValidSynthesis).toBe(true);
  } finally { await f.close(); }
});

test("dependent support can interpret prerequisite answers without unrelated deliberation", async () => {
  const authored = [
    { question: "Does the alternate auth path reject expired credentials?", purpose: "Decide whether expiry bypass is real" },
    { question: "Is the proposed disposition supported by the prerequisite?", purpose: "Interpret the expiry observation" },
    { question: "UNRELATED-QUESTION", purpose: "UNRELATED-PURPOSE" },
  ];
  let disposed = 0, disposedAtDependent = -1;
  const f = await setup({
    async dispose(session) { if (session.model.id === "support") disposed++; },
    prompt(session, request, body) {
      if (request.stage === "preparation" && session.model.id !== "director")
        return { ...body, analysis: "UNRELATED-DELIBERATION", doubts: authored };
      if (request.stage === "consultation-plan") return { kind: "consultation-plan",
        resolutions: [{ doubtId: request.context.doubts[2].id, status: "answered", answer: "Unrelated resolved directly" }],
        support: request.context.doubts.slice(0, 2).map((doubt: { id: string }, index: number) => ({
          role: "scout", brief: index ? "Interpret prerequisite" : "Observe expiry",
          doubtIds: [doubt.id], prerequisites: index ? [0] : [],
        })) };
      if (request.stage === "consultation-response") {
        if (request.context.request.prerequisites.length) disposedAtDependent = disposed;
        return { kind: "consultation-response", doubtIds: request.authorization.doubtIds,
          answer: request.context.request.prerequisites.length ? "Expiry evidence supports rejection" : "Yes",
          evidence: ["auth.ts:42"], limits: [], doubts: [] };
      }
      if (request.stage === "knowledge") return { kind: "knowledge",
        resolutions: request.context.delegatedDoubtIds.map((doubtId: string, index: number) => ({
          doubtId, status: "answered", answer: "Confirmed",
          supportIds: [...request.context.responses[index].prerequisites, request.context.responses[index].id],
        })) };
      return body;
    },
  });
  try {
    const { details: handle } = await f.invoke("review_start", start);
    await f.delivered.promise;
    expect(reportFor(f, handle).status).toBe("completed");
    const dependent = f.seen.filter(item => item.request.stage === "consultation-response")[1]!.request;
    const journal = await journalFor(f, handle);
    const preparation = journal.find((message: { body?: { doubts?: unknown[] } }) => message.body?.doubts?.length === 3);
    const [expiry, interpretation] = preparation.doubts;
    expect(dependent.authorization.doubtIds).toEqual([interpretation.id]);
    expect(dependent.context.request.doubtIds).toEqual([interpretation.id]);
    expect(dependent.context.doubts).toEqual([expiry, interpretation]);
    expect(dependent.context.prerequisites).toHaveLength(1);
    const prerequisite = dependent.context.prerequisites[0];
    const response = journal.find((message: { body?: { kind: string; answer?: string } }) => message.body?.kind === "consultation-response" && message.body.answer === "Yes");
    const boundary = journal.find((message: { kind?: string }) => message.kind === "knowledge-boundary");
    expect(prerequisite).toMatchObject({ status: "completed", message: {
      id: response.id, author: response.author, memberId: response.memberId, body: response.body,
    } });
    expect(new Set([prerequisite.id, response.id, expiry.id]).size).toBe(3);
    expect(prerequisite.message.body.doubtIds).toEqual([expiry.id]);
    expect(boundary.resolutions[0].provenance).toMatchObject({
      consultationId: prerequisite.id, responses: [expect.objectContaining({ consultationId: prerequisite.id, messageId: response.id })],
    });
    const serialized = JSON.stringify(dependent);
    for (const doubt of authored.slice(0, 2)) for (const text of [doubt.question, doubt.purpose])
      expect(serialized.split(text)).toHaveLength(2);
    for (const marker of ["UNRELATED-QUESTION", "UNRELATED-PURPOSE", "UNRELATED-DELIBERATION", '"journal"', '"snapshot"', '"native"'])
      expect(serialized).not.toContain(marker);
    expect(disposedAtDependent).toBe(1); expect(disposed).toBe(2);
    expect(teamWorkerStatus(f.evaluation.token, handle.instanceId)[0]!.closure.state).toBe("released");
    expect(f.seen.every(item => !item.receipt.isError)).toBe(true);
  } finally { await f.close(); }
});

test("delivered grounds follow A to B to C with own-only support citations, excluding independent D", async () => {
  const labels = ["A", "B", "C", "D"];
  const questions = labels.map(label => ({ question: `Chain question ${label}?`, purpose: `Chain purpose ${label}` }));
  let doubtIds: string[] = [];
  const f = await setup({ prompt(session, request, body) {
    if (request.stage === "preparation" && session.model.id !== "director")
      return { ...body, analysis: "PRIVATE-CHAIN-ANALYSIS", findings: [finding], doubts: questions };
    if (request.stage === "consultation-plan") {
      doubtIds = request.context.doubts.map((doubt: any) => doubt.id);
      return { kind: "consultation-plan", resolutions: [], support: labels.map((label, index) => ({
        role: "scout", brief: label, doubtIds: [doubtIds[index]], prerequisites: index < 2 ? [index + 1] : [],
      })) };
    }
    if (request.stage === "consultation-response") return { kind: "consultation-response",
      doubtIds: request.authorization.doubtIds, answer: `Chain answer ${request.context.mandate}`,
      evidence: ["source:chain", ...request.context.prerequisites.map((result: any) => result.id)], limits: [], doubts: [] };
    if (request.stage === "knowledge") return { kind: "knowledge", resolutions: doubtIds.map((doubtId, index) => ({
      doubtId, status: "answered", answer: `Chain confirmed ${labels[index]}`, supportIds: [request.context.responses[index].id],
    })) };
    if (request.stage === "synthesis") return { ...body,
      dispositions: reviewResults(request).findings.map((published: any) => ({
        findingId: published.id, status: "rejected", reason: "A relies on B and C", references: [doubtIds[0], doubtIds[0]],
      })) };
    return body;
  } });
  try {
    const { details: handle } = await f.invoke("review_start", start); await f.delivered.promise;
    const saved = reportFor(f, handle), report = saved.report;
    expect(saved.status).toBe("completed");
    expect(report.judgment).toMatchObject({ completion: "complete", verdict: "no-blockers" });
    expect(report.missingValidSynthesis).toBe(false);
    const journal = await journalFor(f, handle);
    const knowledge = journal.find((item: { stage?: string }) => item.stage === "knowledge");
    expect(knowledge.body.resolutions.map((item: any) => item.supportIds.length)).toEqual([1, 1, 1, 1]);
    const boundary = journal.find((item: { kind?: string }) => item.kind === "knowledge-boundary");
    expect(boundary.resolutions.map((item: any) => item.provenance.responses.length)).toEqual([1, 1, 1, 1]);
    const preparation = journal.find((item: { body?: { analysis?: string } }) => item.body?.analysis === "PRIVATE-CHAIN-ANALYSIS");
    for (const index of [0, 1, 2]) {
      const response = journal.find((item: { body?: { answer?: string } }) => item.body?.answer === `Chain answer ${labels[index]}`);
      const consultationId = boundary.resolutions[index].provenance.consultationId;
      expect(report.grounds).toContainEqual({
        reference: doubtIds[index], messageId: preparation.id, memberId: preparation.memberId,
        author: preparation.author, stage: preparation.stage, content: questions[index],
      });
      expect(report.grounds).toContainEqual({
        reference: response.id, messageId: response.id, memberId: response.memberId, author: response.author,
        stage: response.stage, consultationId, content: { doubtIds: response.body.doubtIds,
          answer: response.body.answer, evidence: response.body.evidence, limits: response.body.limits },
      });
    }
    expect(report.grounds).toHaveLength(7);
    expect(new Set(report.grounds.map((item: any) => item.reference)).size).toBe(7);
    const serialized = JSON.stringify(report);
    for (const marker of ["Chain question D?", "Chain purpose D", "Chain answer D", "Chain confirmed D",
      "PRIVATE-CHAIN-ANALYSIS", '"messages"', '"native"', '"attemptId"', '"turnId"', '"snapshotId"'])
      expect(serialized).not.toContain(marker);
    expect(journal.some((item: { body?: { answer?: string } }) => item.body?.answer === "Chain answer D")).toBe(true);
    expect(f.seen.every(item => !item.receipt.isError)).toBe(true);
    expect(f.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    await diagnosticFor(f, handle);
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
      expect(Object.keys(request.context).sort()).toEqual(["consultationId", "cycleId", "doubts", "mandate", "prerequisites", "request"]);
      expect(request.context.doubts.map((doubt: any) => doubt.id)).toEqual(request.context.request.brief === "support 2"
        ? [f.seen.find(item => item.request.stage === "consultation-response" && item.request.context.request.brief === "support 0")!.request.context.doubts[0].id,
          ...request.context.request.doubtIds] : request.context.request.doubtIds);
      expect(request.context.doubts[0].question).toStartWith("Question ");
      if (request.context.request.brief === "support 2") {
        expect(request.context.prerequisites).toHaveLength(1);
        expect(request.context.prerequisites[0]).toMatchObject({ status: "completed",
          message: { stage: "consultation-response", body: { answer: "Controlled observation" } } });
      }
      calls++; active++; maxActive = Math.max(maxActive, active); if (calls === 2) both.resolve();
      if (calls === 3) expect(disposalCalls).toBe(2);
      await releasePrompt.promise;
      return { kind: "consultation-response", doubtIds: request.context.request.doubtIds, answer: "Controlled observation", evidence: ["source:42"], limits: [], doubts: [] };
    }
    if (request.stage === "knowledge") {
      expect(request.authorization).toEqual({ kind: "knowledge" });
      expect(request.context.responses[2].prerequisites).toEqual([request.context.responses[0].id]);
      for (const response of request.context.responses) {
        expect(response.id).not.toBe(response.message.id);
        expect(response.status).toBe("completed");
        expect(response.message.body.evidence).toEqual(["source:42"]);
      }
      return { kind: "knowledge", resolutions: request.context.doubts.map((doubt: any, index: number) =>
        ({ doubtId: doubt.id, status: "answered", answer: "Observed",
          supportIds: [...request.context.responses[index].prerequisites, request.context.responses[index].id] })) };
    }
    if (request.stage === "synthesis") {
      const doubt = request.context.messages.flatMap((message: any) => message.body.doubts ?? [])[2];
      return { ...body, newFindings: [{ finding: { ...finding, materiality: "nonblocking" }, status: "unresolved",
        reason: "Bounded concern supported by prerequisite observations", references: [doubt.id] }] };
    }
  } });
  try {
    const { details: handle } = await f.invoke("review_start", start); await both.promise;
    expect(calls).toBe(2); expect(maxActive).toBe(2);
    releasePrompt.resolve(); await disposing.promise;
    expect(calls).toBe(2); expect(active).toBe(2); expect(f.sent).toHaveLength(0);
    releaseDispose.resolve(); await f.delivered.promise;
    expect(calls).toBe(3); expect(active).toBe(0); expect(maxActive).toBe(2);
    expect(reportFor(f, handle).status).toBe("completed");
    const report = reportFor(f, handle).report;
    expect(report.findings).toHaveLength(1);
    expect(report.grounds.filter((item: any) => item.stage === "consultation-response")).toHaveLength(2);
    expect(report.grounds.filter((item: any) => item.stage === "consultation-response").every((item: any) =>
      item.content.answer === "Controlled observation" && item.content.evidence[0] === "source:42")).toBe(true);
    const knowledge = report.grounds.find((item: any) => item.stage === "knowledge");
    const judgedDoubt = report.grounds.find((item: any) => item.content.question === "Question 2").reference;
    const resolution = knowledge.content.resolutions.find((item: any) => item.doubtId === judgedDoubt);
    expect(resolution.answer).toBe("Observed");
    expect(knowledge.content.resolutions).toHaveLength(2);
    expect(report.grounds.filter((item: any) => item.stage === "consultation-response").map((item: any) => item.consultationId).sort())
      .toEqual(resolution.supportIds.toSorted());
    expect(report.grounds.filter((item: any) => item.content.question).map((item: any) => item.content.question).sort())
      .toEqual(["Question 0", "Question 2"]);
    await diagnosticFor(f, handle);
  } finally { releasePrompt.resolve(); releaseDispose.resolve(); await f.close(); }
});

test("plan prompts identify private capture for local exploration, retaining the brief and capture limits", async () => {
  const marker = "PRIVATE-PLAN-CONTENT-42";
  const header = "---\nid: object\nrevision: 7\nstatus: draft\n---\n";
  const text = header + `# Scope\n${marker}\n\`\`\`md\n## Planning workers\nfenced substance\n\`\`\`\n` +
    "## Planning workers <!-- operational -->\nprivate worker log\nAcceptance\n---\nrequired behavior\n";
  const f = await setup({ explore(object) {
    expect(object.selector).toEqual({ kind: "plan", planId: "object" });
    if (!("file" in object)) throw Error("missing plan exploration coordinates");
    return consultedPlan(readFileSync(path.resolve(object.root, object.file), "utf8"));
  } });
  try {
    const file = path.join(f.root, ".pitako/plans/object.md");
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text);
    const captured = captureObject({ kind: "plan", planId: "object" }, f.root);
    const { details: handle } = await f.invoke("review_start", { ...start, object: captured.selector }); await f.delivered.promise;
    expect(reportFor(f, handle).status).toBe("completed");
    for (const { request, exploration } of f.seen) {
      expect(request.goal).toBe(start.goal); expect(request.criteria).toEqual(start.criteria);
      expect(request.root).toBe(f.root); expect(request.object).toEqual(describeObject(captured));
      expect(JSON.stringify(request)).not.toContain(marker);
      expect(JSON.stringify(request)).not.toContain("private worker log");
      expect(exploration).toBe((captured.scope as { text: string }).text);
      expect(exploration).toContain(marker); expect(exploration).toContain("fenced substance");
      expect(exploration).not.toContain("private worker log");
      expect(request.object.limits.join(" ")).toContain("not transactional");
    }
    const report = reportFor(f, handle).report;
    expect(report.observations).toEqual({ launch: captured.identity, final: captured.identity, error: null });
    expect(report.object).toEqual(describeObject(captured));
    expect(reportFor(f, handle).result).not.toContain(marker);
    expect(reportFor(f, handle).result).not.toContain("private worker log");
    await diagnosticFor(f, handle);
  } finally { await f.close(); }
});

test("diff prompts carry captured endpoints while participants explore commits, index and current bytes locally", async () => {
  const markers = ["PRIVATE-COMMITTED-43", "PRIVATE-STAGED-44", "PRIVATE-DIRTY-45", "PRIVATE-UNTRACKED-46"];
  const f = await setup({ explore(object) {
    if (!("mergeBase" in object)) throw Error("missing diff exploration endpoints");
    const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", "--no-replace-objects", ...args],
      { cwd: object.root, env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" } }).toString();
    return {
      committed: git("diff", "--no-ext-diff", "--no-textconv", `${object.mergeBase}..${object.head}`, "--"),
      staged: git("diff", "--no-ext-diff", "--no-textconv", "--cached", object.head, "--"),
      dirty: readFileSync(path.join(object.root, "dirty"), "utf8"),
      untracked: readFileSync(path.join(object.root, git("ls-files", "--others", "--exclude-standard").trim()), "utf8"),
      deleted: git("ls-files", "--deleted").trim(),
    };
  } });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: f.root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
  try {
    git("init", "-q"); git("config", "user.name", "Review fixture"); git("config", "user.email", "review@test.invalid");
    writeFileSync(path.join(f.root, ".gitignore"), "pitako/\n*.jsonl\n.pitako/\n");
    for (const name of ["committed", "staged", "dirty", "deleted"]) writeFileSync(path.join(f.root, name), "base\n");
    git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(f.root, "committed"), markers[0]!); git("add", "committed"); git("commit", "-qm", "committed");
    writeFileSync(path.join(f.root, "staged"), markers[1]!); git("add", "staged");
    writeFileSync(path.join(f.root, "dirty"), markers[2]!); writeFileSync(path.join(f.root, "untracked"), markers[3]!);
    rmSync(path.join(f.root, "deleted"));
    const captured = captureObject({ kind: "diff", base }, f.root);
    const { details: handle } = await f.invoke("review_start", { ...start, object: captured.selector }); await f.delivered.promise;
    expect(reportFor(f, handle).status).toBe("completed");
    for (const { request, exploration } of f.seen) {
      expect(request.object).toEqual(describeObject(captured));
      expect(request.object.exploration).toContain("not git diff HEAD alone");
      expect(request.object.exploration).toContain("without fetch");
      for (const marker of markers) expect(JSON.stringify(request)).not.toContain(marker);
      const found = exploration as { committed: string; staged: string; dirty: string; untracked: string; deleted: string };
      expect(found.committed).toContain(markers[0]!); expect(found.staged).toContain(markers[1]!);
      expect(found.dirty).toBe(markers[2]!); expect(found.untracked).toBe(markers[3]!); expect(found.deleted).toBe("deleted");
    }
    expect(reportFor(f, handle).report.observations.final).toBe(captured.identity);
    expect(reportFor(f, handle).report.object).toEqual(describeObject(captured));
    for (const marker of markers) {
      expect(reportFor(f, handle).result).not.toContain(marker);
      expect(reportFor(f, handle).result).not.toContain(Buffer.from(marker).toString("base64"));
    }
    await diagnosticFor(f, handle);
  } finally { await f.close(); }
});

test("review responses use published finding IDs with author content and synthesis retains every author action", async () => {
  let publishedId = "";
  const f = await setup({ prompt(session, request, body) {
    if (request.stage === "preparation" && session.model.id !== "director") return { ...body,
      findings: [finding, { ...finding, key: "duplicate" }, { ...finding, key: "nonblocker", materiality: "nonblocking" }],
      doubts: [{ question: "Does the alternate path enforce authorship?", purpose: "Grounds for rejecting the nonblocker" }] };
    if (request.stage === "consultation-plan") return { ...body, resolutions: request.context.doubts.map((doubt: any) =>
      ({ doubtId: doubt.id, status: "answered", answer: "The alternate path enforces authorship at source:42" })) };
    if (request.stage === "contribution") {
      const published = reviewResults(request).findings[0];
      expect(published).toMatchObject(finding);
      expect(published.id).not.toBe(published.messageId);
      expect(published.memberId).toBe(request.context.shared.messages.find((message: any) => message.id === published.messageId).memberId);
      if (publishedId) expect(published.id).toBe(publishedId);
      publishedId = published.id;
      return { ...body, responses: [{ findingId: published.id, action: session.model.id === "director" ? "object"
        : request.round === 1 ? "modify" : "withdraw", reason: `author-action-${session.model.id}-${request.round}`,
        evidence: ["source:42"], ...(session.model.id !== "director" && request.round === 1
          ? { replacement: { ...finding, consequence: "Bounded revised consequence" } } : {}) }] };
    }
    if (request.stage === "decision") return { ...body, action: request.round === 1 ? "continue" : "synthesize" };
    if (request.stage === "synthesis") {
      const results = reviewResults(request);
      expect(results.findings.map((item: any) => item.key)).toEqual(["authority", "duplicate", "nonblocker"]);
      expect(results.findings[0].id).toBe(publishedId);
      expect(results.responses).toHaveLength(4);
      expect(results.responses.filter((item: any) => item.memberId === results.findings[0].memberId).map((item: any) => item.action))
        .toEqual(["modify", "withdraw"]);
      const doubt = request.context.messages.flatMap((message: any) => message.body.doubts ?? [])[0];
      const director = request.context.messages.find((message: any) => message.stage === "contribution" && message.author === "reviewer");
      return { ...body, verdict: "inconclusive", dispositions: [
        { findingId: publishedId, status: "withdrawn", reason: "Author withdrawal retained after objection", references: [results.responses.at(-1).messageId] },
        { findingId: results.findings[1].id, status: "duplicate", duplicateOf: publishedId, reason: "Same reachable path", references: [publishedId] },
        { findingId: results.findings[2].id, status: "rejected", reason: "Alternate path checks authority", references: [doubt.id] },
      ], newFindings: [{ finding: { ...finding, key: "synthesis-dissent", materiality: "nonblocking" }, status: "unresolved",
        reason: "Director retains a bounded concern despite withdrawal", references: [director.id] }],
      evidence: ["source:42"], limits: ["Bounded controlled observation"], pending: ["Optional follow-up on nonblocking dissent"] };
    }
  } });
  try {
    const { details: handle } = await f.invoke("review_start", start); await f.delivered.promise;
    expect(reportFor(f, handle).status).toBe("completed");
    const report = reportFor(f, handle).report;
    expect(report.findings.map((item: any) => item.key)).toEqual(["authority", "duplicate", "nonblocker", "synthesis-dissent"]);
    expect(report.findings[0].id).toBe(publishedId);
    expect(report.responses).toHaveLength(4); expect(report.judgment.dispositions[0].status).toBe("withdrawn");
    expect(report.responses.filter((item: any) => item.action === "object")).toHaveLength(2);
    expect(report.responses.every((item: any) => item.reason && item.evidence[0] === "source:42")).toBe(true);
    expect(report.judgment.dispositions.map((item: any) => item.status)).toEqual(["withdrawn", "duplicate", "rejected", "unresolved"]);
    expect(report.judgment.dispositions.map((item: any) => item.findingId)).toEqual(report.findings.map((item: any) => item.id));
    expect(report.judgment.synthesis).toMatchObject({ evidence: ["source:42"], limits: ["Bounded controlled observation"],
      pending: ["Optional follow-up on nonblocking dissent"] });
    const source = f.seen.find(item => item.request.stage === "synthesis")!.request.context.messages;
    const director = source.find((message: any) => message.stage === "contribution" && message.author === "reviewer");
    const doubt = source.flatMap((message: any) => message.body.doubts ?? [])[0];
    expect(report.grounds).toContainEqual(expect.objectContaining({ reference: director.id, content: { analysis: "Review incoming evidence" } }));
    expect(report.grounds).toContainEqual(expect.objectContaining({ reference: doubt.id, content: {
      question: "Does the alternate path enforce authorship?", purpose: "Grounds for rejecting the nonblocker",
    } }));
    expect(report.grounds).toContainEqual(expect.objectContaining({ stage: "consultation-plan", content: expect.objectContaining({
      resolutions: [expect.objectContaining({ doubtId: doubt.id, answer: "The alternate path enforces authorship at source:42" })],
    }) }));
    expect(report.grounds.some((ground: any) => ground.reference === publishedId)).toBe(false); // Already a canonical finding.
    expect(report.grounds.every((ground: any) => !("body" in ground) && !("native" in ground))).toBe(true);
    await diagnosticFor(f, handle);
  } finally { await f.close(); }
});
