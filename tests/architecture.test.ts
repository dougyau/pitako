import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AsyncResource } from "node:async_hooks";
import { workerHandoff, teamWorkerStatus } from "../extensions/agent/background.ts";
import { firstTeamReservation, teamAssignments } from "../extensions/team.ts";
import { loadPitakoConfig } from "../extensions/roles/load.ts";
import { openBoard } from "../extensions/board/store.ts";
import { ledgerFile, planFile } from "../extensions/workflow.ts";
import { listObservations } from "../extensions/agent/observe.ts";
import { executionForSession } from "../extensions/execution-identity.ts";
import { WorkflowState, type Resource } from "../extensions/workflow-state.ts";
import type { AttemptRecord } from "../extensions/workflow-engine.ts";
import { architectureFixture, tablePrompt } from "./fixtures/architecture.ts";
const { fixture, setup, policies, configuration } = architectureFixture();
const deferred = <T = void>() => Promise.withResolvers<T>();
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const protocol of ["architecture", "review"] as const) {
  const empty = architectureFixture(protocol);
  test(`${protocol} registered empty-pool start runs a useful director-only table`, empty.fixture.ownedCase(`${protocol} empty pool`, async () => {
    const s = await empty.setup({ config: "", prompt(_session, request, body) {
      if (request.stage === "composition") return { ...body, reason: "No specialists needed for this bounded object", specialists: [] };
    } });
    try {
      const start = await s.invoke(`${protocol}_start`, protocol === "architecture" ? { goal: "Choose the bounded design" }
        : { goal: "Review the bounded design", object: { kind: "brief", text: "Bounded proposal" }, criteria: ["Preserve ownership", "Remain bounded"] });
      expect(start.isError).not.toBe(true);
      await s.delivered.promise;
      expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host).toMatchObject({ status: "completed" });
      expect(s.host.sessions).toHaveLength(1);
      expect(s.host.sessions[0]!.model!.id).toBe("director");
      expect(s.seen.map(item => item.request.stage)).toEqual(["composition", "preparation", "consultation-plan", "contribution", "decision", "synthesis"]);
      const page = await s.read(`${protocol}_read`, { roomId: start.details.roomId });
      expect(page.state).toBe("finished"); expect(page.round).toBe(1); expect(page.members).toHaveLength(1);
      expect(page.snapshot.general).toEqual([]); expect(page.snapshot.topics).toEqual([]);
      expect(JSON.stringify(page.messages)).toContain(protocol === "architecture" ? "Use the bounded design" : "Reviewed complete object");
      expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("completed");
      expect(s.host.sessions[0]!.events).toContain("dispose");
      if (protocol === "review") {
        for (const { request } of s.seen.filter(item => ["preparation", "contribution"].includes(item.request.stage))) {
          expect(request.object.selector).toEqual({ kind: "brief", text: "Bounded proposal" }); expect(request.criteria).toEqual(["Preserve ownership", "Remain bounded"]);
        }
      }
    } finally { await s.close(); }
  }));
  test(`${protocol} rejects missing director primary before reserving work`, empty.fixture.ownedCase(`${protocol} missing primary`, async () => {
    const s = await empty.setup({ policies: "", config: "" });
    try {
      const start = await s.invoke(`${protocol}_start`, protocol === "architecture" ? { goal: "No director target" }
        : { goal: "No director target", object: { kind: "brief", text: "Bounded proposal" }, criteria: ["Ownership"] });
      expect(start.isError).toBe(true);
      expect(JSON.parse(start.content[0].text).message).toContain(`model policy "${protocol === "architecture" ? "architect" : "reviewer"}" has no primary target.`);
      expect(s.host.sessions).toEqual([]); expect(teamAssignments(s.evaluation)).toEqual([]);
      expect(teamWorkerStatus(s.evaluation.token)).toEqual([]);
      expect(s.sent).toEqual([]);
    } finally { await s.close(); }
  }));
  test(`${protocol} total compositions zero, two, retain/add, zero preserve four global rounds`, empty.fixture.ownedCase(`${protocol} four rounds`, async () => {
    let compositions = 0, retainedId = "", retiredId = "";
    const frontiers = new Map<number, string>(), sessions = new Map<string, any>();
    const s = await empty.setup({ async prompt(session, request, body) {
      if (request.stage === "composition") {
        compositions++;
        const add = (mandate: string) => ({ kind: "add", candidateRef: "general:0", mandate, reason: "Useful independent focus" });
        if (compositions === 3) {
          [retainedId, retiredId] = request.authorization.retainableMemberIds;
          const before = teamAssignments(s.evaluation), sessionsBefore = [...s.host.sessions];
          const invalid = { ...body, reason: "Invalid duplicate retention", specialists: Array(2).fill({
            kind: "retain", memberId: retainedId, mandate: "No side effects", reason: "Duplicate identity",
          }) };
          const rejected = await session.boundTools.get(`${protocol}_submit`).execute("invalid-retain",
            { body: invalid }, undefined, undefined, { sessionManager: session.sessionManager });
          expect(rejected.isError).toBe(true); expect(rejected.details.correctionsLeft).toBe(1);
          expect(teamAssignments(s.evaluation)).toEqual(before); expect(s.host.sessions).toEqual(sessionsBefore);
          expect(sessionsBefore.every(peer => !peer.events.includes("dispose"))).toBe(true);
        }
        return { ...body, reason: "Select the full useful roster", specialists: compositions === 2 ? [add("First"), add("Second")]
          : compositions === 3 ? [{ kind: "retain", memberId: retainedId, mandate: "Updated focus", reason: "Keep conversation" }, add("Fresh focus")] : [] };
      }
      if (request.stage === "preparation") {
        expect(request).not.toHaveProperty("journal"); expect(request).not.toHaveProperty("review");
        expect(request).not.toHaveProperty("controls"); expect(request).not.toHaveProperty("snapshot");
        expect(Object.keys(request.context)).toEqual(["mandate"]);
        sessions.set(request.context.mandate, session);
        if (protocol === "review" && request.context.mandate === "Second") return { ...body, findings: [{
          key: "retired-dissent", materiality: "nonblocking", contract: "Keep original dissent", reference: "brief",
          consequence: "Losing evidence", basis: { kind: "failure", path: "Retirement hides original evidence", evidence: ["brief"] },
        }] };
      }
      if (request.stage === "contribution") {
        const shared = JSON.stringify(request.context.shared);
        if (frontiers.has(request.round)) expect(frontiers.get(request.round)).toBe(shared);
        else frontiers.set(request.round, shared);
        if (request.context.mandate === "Updated focus") expect(session).toBe(sessions.get("First"));
        if (request.round === 3) {
          expect(request.context.shared.messages.some((m: any) => m.memberId === retiredId && m.stage === "preparation")).toBe(true);
          if (protocol === "architecture")
            expect(request.authorization.objections.some((ref: any) => ref.memberId === retiredId)).toBe(true);
        }
      }
      if (request.stage === "decision") return { ...body, action: request.round < 4 ? "recompose" : "synthesize" };
      return body;
    } });
    try {
      const start = await s.invoke(`${protocol}_start`, { goal: "Keep useful conversations and original evidence",
        ...(protocol === "review" ? { object: { kind: "brief", text: "Complete object" }, criteria: ["Keep evidence"] } : {}) });
      await s.delivered.promise;
      const result = await s.read("team_result", { assignmentId: start.details.assignmentId });
      expect(result.host.status).toBe("completed");
      expect(compositions).toBe(4); expect([...frontiers.keys()]).toEqual([1, 2, 3, 4]);
      expect(s.seen.filter(item => item.request.stage === "preparation")).toHaveLength(4);
      expect(s.seen.filter(item => item.request.stage === "consultation-plan")).toHaveLength(3);
      expect(s.seen.filter(item => item.request.stage === "contribution").map(item => item.request.round).sort())
        .toEqual([1, 2, 2, 2, 3, 3, 3, 4]);
      expect(teamAssignments(s.evaluation).find(member => member.memberId === retainedId)!.task).toBe("First");
      expect(sessions.get("First").prompts.filter((text: string) => tablePrompt(text).stage === "preparation")).toHaveLength(1);
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
      if (protocol === "review") {
        const report = result;
        expect(report.findings[0].memberId).toBe(retiredId); expect(report.findings[0].key).toBe("retired-dissent");
        expect(report.judgment.dispositions).toHaveLength(1); expect(report.judgment.dispositions[0].findingId).toBe(report.findings[0].id);
      }
    } finally { await s.close(); }
  }));
  test(`${protocol} director failure does not transfer authority and preserves settled peer evidence`, empty.fixture.ownedCase(`${protocol} director failure`, async () => {
    const s = await empty.setup({ prompt(session, request, body) {
      if (session.model.id === "director" && request.stage === "preparation") return false;
      if (request.stage === "synthesis") {
        expect(request.context.partialReasons.length).toBeGreaterThan(0);
        return protocol === "architecture" ? { ...body, status: "partial" }
          : { ...body, completion: "partial", verdict: "inconclusive" };
      }
    } });
    try {
      const start = await s.invoke(`${protocol}_start`, { goal: "Never replace director authority",
        ...(protocol === "review" ? { object: { kind: "brief", text: "Complete object" }, criteria: ["Authority"] } : {}) });
      await s.delivered.promise;
      expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("failed");
      const page = await s.read(`${protocol}_read`, { roomId: start.details.roomId });
      expect(JSON.stringify(page.messages)).toContain('"stage":"preparation"');
      expect(s.seen.filter(item => item.request.stage === "preparation")).toHaveLength(1);
      expect(s.seen.find(item => item.request.stage === "preparation")!.session.model.id).toBe("chosen");
      const root = s.seen.find(item => item.request.stage === "composition")!.session;
      expect(s.seen.filter(item => item.request.stage === "synthesis").map(item => item.session)).toEqual([root]);
      expect(s.seen.filter(item => item.request.stage === "contribution")).toHaveLength(2);
      expect(s.host.sessions).toHaveLength(2);
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    } finally { await s.close(); }
  }));
}

test("registered start publishes Markdown guidance and preserves the original brief in prompts and active root observation", fixture.ownedCase("architecture original Markdown", async () => {
  const goal = ["\n# Revisión 🧠", "", "## Objective", 'Preserve café, cafe\u0301 and "quoted text".  ',
    "", "## Expected result", "Keep the submitted source unchanged.\r\n", "## Context", "```json",
    String.raw`{"path":"C:\\work\\draft","quote":"\"literal\""}`, "```", "",
    "- Context with Unicode 日本語 and a [reference](https://example.test/draft).\n".repeat(30), " \n"].join("\n");
  const compositionEntered = deferred(), releaseComposition = deferred(), decisions = [deferred(), deferred()], releases = [deferred(), deferred()];
  const release = () => { releaseComposition.resolve(); for (const gate of releases) gate.resolve(); };
  fixture.finishOnCleanup(release);
  const s = await setup({ async prompt(_session, request, body) {
    if (request.stage === "composition") { compositionEntered.resolve(); await releaseComposition.promise; }
    if (request.stage === "decision") {
      decisions[request.round - 1]!.resolve(); await releases[request.round - 1]!.promise;
      return { ...body, action: request.round === 1 ? "continue" : "synthesize" };
    }
  } });
  try {
    const definition = s.tools.get("architecture_start"), schema = definition.parameters.properties;
    expect(schema.goal.type).toBe("string"); expect(schema.goal.minLength).toBe(1);
    for (const guidance of [definition.description, schema.goal.description]) {
      for (const phrase of ["Markdown", "original language", "short title", "objective", "expected result", "context", "questions", "restrictions", "references", "short paragraphs and lists", "not validation", "plain text remains valid", "without conversion or normalization"])
        expect(guidance).toContain(phrase);
    }
    for (const name of ["topic", "plan", "unit", "boardTopicId"]) expect(schema[name].description).toBeUndefined();
    expect(schema).not.toHaveProperty("mode");
    const start = await s.invoke("architecture_start", { goal });
    expect(start.isError).not.toBe(true);
    await compositionEntered.promise;
    const rootSession = s.host.sessions.find(session => session.prompts.some(text => tablePrompt(text).stage === "composition"))!;
    const readOriginal = async () => {
      let briefOffset: number | null = 0, original = "", pages = 0;
      while (briefOffset !== null) {
        const observed = await s.invoke("agent_observe", { target: { kind: "team", assignmentId: start.details.assignmentId }, briefOffset });
        expect(observed.isError).not.toBe(true);
        const page = observed.details;
        expect(page.active).toBe(true); expect(page.sessionId).toBe(rootSession.sessionId);
        expect(page.workbrief.source).toBe("original WorkBrief");
        expect(page.workbrief.offset).toBe(briefOffset);
        original += page.workbrief.text; pages++;
        if (page.workbrief.nextOffset !== null) expect(page.workbrief.nextOffset).toBeGreaterThan(briefOffset);
        briefOffset = page.workbrief.nextOffset;
      }
      expect(pages).toBeGreaterThan(1);
      expect(original).toBe(goal);
    };
    await readOriginal();
    releaseComposition.resolve(); await decisions[0]!.promise;
    const contribution = s.seen.find(item => item.request.stage === "contribution" && item.model === "chosen")!;
    expect(contribution.session).not.toBe(rootSession);
    expect(contribution.request.context.mandate).toBe("Review security");
    expect(contribution.request.context.mandate).not.toBe(goal);
    const control = "Different priorities: do not replace the original brief.";
    expect((await s.invoke("architecture_control", { roomId: start.details.roomId, action: "context", text: control })).isError).not.toBe(true);
    expect((await s.invoke("architecture_control", { roomId: start.details.roomId, action: "priorities", text: "Preserve ownership first" })).isError).not.toBe(true);
    releases[0]!.resolve(); await decisions[1]!.promise;
    await readOriginal();
    expect(s.seen.filter(item => item.request.stage === "contribution").at(-1)!.request.context.shared.controls).toContainEqual({ action: "context", text: control });
    expect(s.seen.filter(item => item.request.stage === "contribution").at(-1)!.request.context.shared.controls).toContainEqual({ action: "priorities", text: "Preserve ownership first" });
    releases[1]!.resolve(); await s.delivered.promise;
    for (const { request } of s.seen) expect(request.goal).toBe(goal);
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("completed");
    expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
  } finally { release(); await s.close(); }
}));

test("registered watched table preserves owner/history/cursors/closure and delivers one terminal synthesis after disband", fixture.ownedCase("architecture full route", async () => {
  const deciding = deferred(), continueDecision = deferred(), disposing = deferred(), release = deferred();
  const finish = () => { continueDecision.resolve(); release.resolve(); }; fixture.finishOnCleanup(finish);
  const s = await setup({ busy: true, async prompt(session, request, body) {
    if (request.stage === "contribution" && session.model.id === "chosen") return { ...body, proposal: "A".repeat(20000) + "🧠" };
    if (request.stage === "decision") { deciding.resolve(); await continueDecision.promise; }
  }, async dispose(session) { if (session.model?.id === "chosen") { disposing.resolve(); await release.promise; } } });
  const store = new WorkflowState(s.root);
  try {
    const db = await openBoard(); const topic = db.createTopic(s.root, { title: "Architecture" }); db.claimTopic(s.root, topic.id, "architecture-plan"); db.close();
    const file = planFile("architecture-plan", s.root); mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `---\nid: architecture-plan\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\n---\nArchitecture owned work.\n`);
    const parent = new AbortController();
    const started = await s.invoke("architecture_start", { goal: "Review security", topic: "security", plan: "architecture-plan", unit: "T2" }, parent.signal);
    expect(started.isError).not.toBe(true); const handle = started.details;
    parent.abort(); // foreground turn ending never owns the room lifetime
    await deciding.promise;
    const attempt = store.get<AttemptRecord>("attempts", handle.dispatchId)!;
    expect(attempt).toMatchObject({ assignmentId: handle.assignmentId, instanceId: handle.instanceId });
    expect(attempt.outcome).toBeUndefined();
    const resource = store.get<Resource>("resources", attempt.resource.resourceId);
    expect(resource).toMatchObject(attempt.resource);
    expect(resource!.effectReservation).toBeUndefined();
    expect(store.closureReceipt(attempt.resource)).toBeUndefined();
    expect(teamWorkerStatus(s.evaluation.token, handle.instanceId)[0]).toMatchObject({ status: "running", closure: { state: "pending" } });
    expect(workerHandoff(handle.instanceId)).toBeUndefined();
    expect(firstTeamReservation(s.evaluation, "architect")).toBe(handle.assignmentId);
    const page = JSON.parse((await s.invoke("architecture_read", { roomId: handle.roomId })).content[0].text);
    expect(page.header.cursor).not.toBeNull();
    let text = page.fragment, cursor = page.header.cursor;
    while (cursor) { const next = JSON.parse((await s.invoke("architecture_read", { roomId: handle.roomId, cursor })).content[0].text);
      expect(next.header.id).toBe(page.header.id); text += next.fragment; cursor = next.header.cursor; }
    const diagnostic = JSON.parse(text);
    expect(diagnostic.state).toBe("running"); expect(diagnostic.delivery).toEqual([]);
    expect(text).toContain("🧠");
    expect((await s.invoke("architecture_read", { roomId: handle.roomId, cursor: "invalid" })).isError).toBe(true);
    const encodeCursor = (values: unknown[]) => Buffer.from(JSON.stringify(values)).toString("base64url");
    for (const values of [[diagnostic.snapshot.id, page.header.id + 1, 0, 0, 1], [diagnostic.snapshot.id, page.header.id, 0, -1, 1],
      ["foreign", page.header.id, 0, 0, 1], [diagnostic.snapshot.id, page.header.id, 0, 999999, 1]])
      expect((await s.invoke("architecture_read", { roomId: handle.roomId, cursor: encodeCursor(values) })).isError).toBe(true);
    const firstSession = s.host.sessions.find(session => session.model?.id === "chosen")!;
    expect(firstSession.events).not.toContain("dispose");
    expect((await s.invoke("agent_input", { target: { kind: "team", assignmentId: handle.assignmentId }, historyId: "bad", sessionId: s.host.sessions[0]!.sessionId, intent: "steer", text: "bypass" })).isError).toBe(true);
    const draft = await s.emit("agent_before_settle", { outcome: "completed", context: { canContinue: true } });
    expect(draft?.entries ?? []).toEqual([]);
    expect(workerHandoff(handle.instanceId)).toBeUndefined(); expect(store.closureReceipt(attempt.resource)).toBeUndefined();
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    expect(s.host.sessions).toHaveLength(2);
    expect(store.closureReceipt(attempt.resource)).toBeUndefined();
    const list = await s.invoke("agent_history", { action: "list" }); expect(JSON.stringify(list.details)).toContain(handle.assignmentId);
    const specialistMessage = await s.read("architecture_read", { roomId: handle.roomId });
    expect(specialistMessage.members.filter((member: any) => member.id !== handle.assignmentId)).toHaveLength(1);
    continueDecision.resolve(); await disposing.promise;
    expect(workerHandoff(handle.instanceId)).toBeUndefined(); expect(store.closureReceipt(attempt.resource)).toBeUndefined();
    s.setIdle(true); release.resolve(); await s.delivered.promise;
    await s.emit("turn_start");
    expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
    expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    // Delivery cannot join auxiliary disk I/O. Its captured completion publishes
    // the bookkeeping fact after the archive's actual resource receipt exists.
    await s.bookkeeping(handle.instanceId);
    expect(workerHandoff(handle.instanceId)).toMatchObject({ bookkeeping: "reconciled", delivery: "incorporated" });
    expect(store.get<AttemptRecord>("attempts", handle.dispatchId)?.outcome?.status).toBe("completed");
    expect(store.verifyClosureReceipt(store.closureReceipt(attempt.resource)!)).toBe(true);
    const archive = await s.read("architecture_read", { roomId: handle.roomId, section: "archive" });
    expect(archive.state).toBe("written");
    expect(JSON.parse(readFileSync(archive.path, "utf8")).host.status).toBe("completed");
    expect((await s.read("team_result", { assignmentId: handle.assignmentId })).host.status).toBe("completed");
    const dispatch = s.host.sessions[0]!.sessionManager.getEntries().find((entry: any) => entry.customType === "pitako.architecture.dispatch") as any;
    expect(dispatch.data.callerSessionId).toBe(s.host.sessions[0]!.sessionId);
    expect(dispatch.data.parentAssignmentId).toBe(handle.assignmentId);
  } finally { store.close(); finish(); await s.close(); }
}));

test("finish drains active contributions and preserves truncation as partial rather than success", fixture.ownedCase("architecture finish", async () => {
  const entered = deferred(), release = deferred(); fixture.finishOnCleanup(release.resolve);
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "contribution" && session.model.id === "chosen") { entered.resolve(); await release.promise; }
    if (request.stage === "synthesis") {
      expect(request.context.partialReasons).toContain("Finish truncated scheduled architecture work");
      return { ...body, status: "partial", pending: [...request.context.partialReasons] };
    }
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Drain before finishing" });
    await entered.promise;
    expect((await s.invoke("architecture_control", { roomId: start.details.roomId, action: "finish" })).isError).not.toBe(true);
    expect(workerHandoff(start.details.instanceId)).toBeUndefined();
    expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toEqual([]);
    release.resolve(); await s.delivered.promise;
    expect(s.seen.filter(item => item.request.stage === "contribution")).toHaveLength(2);
    expect(s.seen.some(item => item.request.stage === "decision")).toBe(false);
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("failed");
    expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
  } finally { release.resolve(); await s.close(); }
}));

test("bind-captured submit supports the first and subsequent authorized native turns", fixture.ownedCase("architecture captured submit", async () => {
  const deciding = deferred(), release = deferred(); fixture.finishOnCleanup(release.resolve);
  const s = await setup({ async prompt(_session, request, body) {
    if (request.stage === "decision" && request.round === 1) {
      deciding.resolve(); await release.promise; return { ...body, action: "continue" };
    }
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "captured submit" });
    await deciding.promise;
    expect(s.seen.map(item => item.request.stage)).toContain("composition");
    const specialist = s.seen.find(item => item.request.stage === "contribution" && item.model === "chosen")!.session;
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "context", text: "second native turn" });
    release.resolve(); await s.delivered.promise;
    expect(s.seen.filter(item => item.request.stage === "contribution" && item.model === "chosen").map(item => item.session)).toEqual([specialist, specialist]);
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("completed");
    expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
  } finally { release.resolve(); await s.close(); }
}));

test("optional strict configuration permits empty pools and retains malformed-list diagnostics", fixture.ownedCase("architecture config", async () => {
  const s = await setup({ config: "", prompt(_session, request, body) {
    if (request.stage === "composition") return { ...body, reason: "Director can decide alone", specialists: [] };
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "review" });
    expect(start.isError).not.toBe(true); await s.delivered.promise;
    expect(s.host.sessions).toHaveLength(1);
    const invalid = ["[architecture]\ncandidates = false", "[architecture]\ncandidates = [{model='fixture/a',fast=true}]", "[architecture]\ncandidates = [{model='fixture/a'}, {model='fixture/a'}]",
      "[architecture]\ncandidates = [{model='fixture/a'}]\n[[architecture.topics]]\ntopic=' '\ncandidates=[{model='fixture/b'}]",
      "[architecture]\ncandidates = [{model='fixture/a'}]\n[[architecture.topics]]\ntopic='Topic'\ncandidates=[{model='fixture/b'}]\n[[architecture.topics]]\ntopic=' topic '\ncandidates=[{model='fixture/c'}]",
      "[architecture]\ncandidates = [{model='fixture/a'}]\n[[architecture.topics]]\ntopic='topic'\ncandidates=false"];
    for (const config of invalid) { writeFileSync(path.join(s.root, "pitako/config.toml"), policies + config); expect(() => loadPitakoConfig({ cwd: s.root })).toThrow(); }
    writeFileSync(path.join(s.root, "pitako/config.toml"), policies + configuration);
    expect(loadPitakoConfig({ cwd: s.root }).architecture!.topics[0]!.candidates).toHaveLength(3);
  } finally { await s.close(); }
}));

test("topic fallback deduplicates models, uses each target's default, and restarts original choice on the retained conversation", fixture.ownedCase("architecture fallback", async () => {
  const attempts: { model: string; level: string; session: string }[] = [];
  const deciding = deferred(), release = deferred(); fixture.finishOnCleanup(release.resolve);
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "decision" && request.round === 1) {
      deciding.resolve(); await release.promise; return { ...body, action: "continue" };
    }
    if (request.stage === "contribution" && session.model.id !== "director") {
      attempts.push({ model: session.model.id, level: session.thinkingLevel, session: session.sessionId });
      if (session.model.id !== "general") throw new Error("503 Service Unavailable");
    }
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "fallback" });
    await deciding.promise;
    expect(attempts.map(item => [item.model, item.level])).toEqual([["chosen", "high"], ["other", "minimal"], ["general", "minimal"]]);
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "context", text: "second exchange" });
    release.resolve(); await s.delivered.promise;
    expect(attempts.slice(3).map(item => [item.model, item.level])).toEqual([["chosen", "high"], ["other", "minimal"], ["general", "minimal"]]);
    expect(new Set(attempts.map(item => item.session)).size).toBe(1);
    expect(s.host.sessions).toHaveLength(2);
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("completed");
  } finally { release.resolve(); await s.close(); }
}));

for (const invalid of ["snapshot", "model", "reasoning", "bind-reasoning", "missing", "conflict", "wrong-stage", "caller"] as const) {
  test(`registered protocol rejects ${invalid} without provider fallback`, fixture.ownedCase("architecture invalid " + invalid, async () => {
    let contributionAttempts = 0;
    const s = await setup({ bind(session) {
      if (invalid === "bind-reasoning" && session.model?.id === "chosen") session.setModel = async (model: any) => { session.model = { ...model, reasoning: false }; };
    }, async prompt(session, request, body) {
      if (request.stage === "composition") {
        if (invalid === "snapshot") return { ...body, snapshotId: "invented" };
        if (invalid === "model") return { ...body, specialists: [{ kind: "add", candidateRef: "fixture/chosen", mandate: "review", reason: "arbitrary model" }] };
        if (invalid === "reasoning") s.host.models.find(model => model.id === "chosen")!.reasoning = false;
      }
      if (request.stage === "contribution" && session.model.id !== "director") {
        contributionAttempts++;
        const submit = session.boundTools.get("architecture_submit");
        if (invalid === "missing") return false;
        if (["conflict", "wrong-stage", "caller"].includes(invalid)) {
          const ctx = { sessionManager: session.sessionManager };
          const value = { body };
          if (invalid === "conflict") {
            const receipt = await submit.execute("one", value, undefined, undefined, ctx);
            expect(receipt.isError).not.toBe(true);
            const duplicate = await submit.execute("duplicate", structuredClone(value), undefined, undefined, ctx);
            expect(duplicate.details).toEqual(receipt.details);
            const conflict = await submit.execute("conflict", { ...value, body: { ...body, proposal: "different" } }, undefined, undefined, ctx);
            expect(conflict.isError).toBe(true);
            throw new Error("503 Service Unavailable"); // invalid submit must not become a provider retry
          }
          const rejected = await submit.execute("bad", invalid === "wrong-stage" ? { ...value, body: { kind: "knowledge", resolutions: [] } } : value,
            undefined, undefined, invalid === "caller" ? { sessionManager: s.ctx.sessionManager } : ctx);
          expect(rejected.isError).toBe(true); return false;
        }
      }
    } });
    try {
      const start = await s.invoke("architecture_start", { goal: "reject" }); await s.delivered.promise;
      expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("failed");
      expect(contributionAttempts).toBe(["snapshot", "model", "reasoning", "bind-reasoning"].includes(invalid) ? 0 : 1);
      expect(s.host.sessions.some(session => session.prompts.some(text => tablePrompt(text).stage === "contribution") && !["director", "chosen"].includes(session.model?.id ?? ""))).toBe(false);
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    } finally { await s.close(); }
  }));
}

test("a contextual rejection permits one corrected contribution with an idempotent provisional receipt", fixture.ownedCase("architecture contextual correction", async () => {
  let corrections = 0;
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage !== "contribution" || session.model.id !== "chosen") return;
    const submit = session.boundTools.get("architecture_submit"), ctx = { sessionManager: session.sessionManager };
    const invalid = { ...body, objections: [{ memberId: "foreign", messageId: "invented", argument: "Not in this frontier" }] };
    const rejected = await submit.execute("invalid", { body: invalid }, undefined, undefined, ctx);
    expect(rejected.isError).toBe(true);
    const value = { body }, accepted = await submit.execute("corrected", value, undefined, undefined, ctx);
    expect(accepted.isError).not.toBe(true);
    expect((await submit.execute("identical", structuredClone(value), undefined, undefined, ctx)).details).toEqual(accepted.details);
    corrections++;
    return false;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Correct a contextual reference" }); await s.delivered.promise;
    expect(corrections).toBe(1);
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("completed");
    expect(s.host.sessions).toHaveLength(2);
    expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
  } finally { await s.close(); }
}));

test("direct and codemode-reachable participant capabilities are leaf, and prior-turn submit grants are stale", fixture.ownedCase("architecture grants", async () => {
  let forbiddenCalls = 0, oldSubmit: (() => Promise<any>) | undefined;
  const deciding = deferred(), release = deferred(); fixture.finishOnCleanup(release.resolve);
  const external = new Map(["agent_spawn", "team_assign", "architecture_start", "architecture_control", "head_plan", "edit", "write", "apply_patch", "lsp_rename"].map(name =>
    [name, { definition: { name, execute(): { isError?: boolean } { forbiddenCalls++; return {}; } } }]));
  const s = await setup({ extensions: [{ resolvedPath: "controlled-capabilities", tools: external }], async prompt(session, request, body) {
    for (const [name, tool] of external) {
      expect((await tool.definition.execute()).isError).toBe(true); // same executable definitions codemode obtains
      const guards = session.hooks.get("tool_call") ?? [];
      expect(guards.some((guard: Function) => guard({ toolName: name })?.block)).toBe(true);
    }
    if (request.stage === "decision" && request.round === 1) {
      deciding.resolve(); await release.promise; return { ...body, action: "continue" };
    }
    if (request.stage === "contribution" && session.model.id === "chosen") {
      if (oldSubmit) {
        expect((await oldSubmit()).isError).toBe(true);
      }
      const submit = session.boundTools.get("architecture_submit");
      expect(submit).toBe(session.tools.get("architecture_submit").definition);
      // Retain the originating native async context, as a delayed tool callback would.
      oldSubmit = AsyncResource.bind(() => submit.execute("stale", { body }, undefined, undefined, { sessionManager: session.sessionManager }));
      const aborted = new AbortController(); aborted.abort();
      expect((await submit.execute("aborted", { body }, aborted.signal, undefined, { sessionManager: session.sessionManager })).isError).toBe(true);
      const submitted = structuredClone(body);
      expect((await submit.execute("immutable", { body: submitted }, undefined, undefined, { sessionManager: session.sessionManager })).isError).not.toBe(true);
      submitted.proposal = "mutated after receipt";
      return false;
    }
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "grants" });
    await deciding.promise;
    expect(forbiddenCalls).toBe(0);
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "context", text: "new turn" });
    release.resolve(); await s.delivered.promise;
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("completed");
    expect(s.host.sessions).toHaveLength(2); expect(forbiddenCalls).toBe(0);
    expect((await oldSubmit!()).isError).toBe(true); // retired origin after disposal
    const specialist = s.host.sessions.find(session => session.model?.id === "chosen")!;
    expect((await specialist.boundTools.get("architecture_submit").execute("outside", {}, undefined, undefined, { sessionManager: specialist.sessionManager })).isError).toBe(true);
    const page = await s.read("architecture_read", { roomId: start.details.roomId });
    expect(JSON.stringify(page.messages)).toContain("Use a bounded design");
    expect(JSON.stringify(page.messages)).not.toContain("mutated after receipt");
  } finally { release.resolve(); await s.close(); }
}));

for (const route of ["stop", "team_cancel"] as const) {
  for (const stage of ["contribution", "consultation-response"] as const) {
    test(`${route} aborts active ${stage} children before prompt release and joins abort/disposal`, fixture.ownedCase(`architecture ${route} ${stage} closure`, async () => {
      const entered = deferred(), releasePrompt = deferred(), releaseAbort = deferred(), disposing = deferred(), releaseDispose = deferred();
      const children: any[] = [];
      const release = () => { releasePrompt.resolve(); releaseAbort.resolve(); releaseDispose.resolve(); };
      fixture.finishOnCleanup(release);
      const s = await setup({
        async prompt(session, request, body) {
          if (stage === "consultation-response") {
            if (request.stage === "preparation" && session.model.id === "chosen") return { ...body, doubts: [0, 1].map(index => ({ question: `Question ${index}`, purpose: "check cancellation" })) };
            if (request.stage === "consultation-plan") return { kind: "consultation-plan", resolutions: [], support: request.context.doubts.map((doubt: any) =>
              ({ role: "scout", brief: "resolve doubt", doubtIds: [doubt.id], prerequisites: [] })) };
          }
          if (request.stage === stage && (stage !== "contribution" || session.model.id === "chosen")) {
            children.push(session);
            if (children.length === (stage === "contribution" ? 1 : 2)) entered.resolve();
            await releasePrompt.promise;
            const rejected = await session.boundTools.get("architecture_submit").execute("after-abort", { body }, undefined, undefined, { sessionManager: session.sessionManager });
            expect(rejected.isError).toBe(true);
            throw new Error("503 Service Unavailable");
          }
        },
        async abort(session) { if (children.includes(session)) await releaseAbort.promise; },
        async dispose(session) { if (children.includes(session)) { disposing.resolve(); await releaseDispose.promise; } },
      });
      const store = new WorkflowState(s.root);
      try {
        const db = await openBoard(); const topic = db.createTopic(s.root, { title: "Cancel" }); db.claimTopic(s.root, topic.id, "cancel-plan"); db.close();
        const file = planFile("cancel-plan", s.root); mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `---\nid: cancel-plan\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\n---\nCancellation.\n`);
        const start = await s.invoke("architecture_start", { goal: "cancel active children", plan: "cancel-plan", unit: "T2" });
        await entered.promise;
        const attempt = store.get<AttemptRecord>("attempts", start.details.dispatchId)!;
        expect(attempt).toMatchObject({ assignmentId: start.details.assignmentId, instanceId: start.details.instanceId });
        const before = s.host.sessions.map(session => ({ session, prompts: [...session.prompts] }));
        const cancelled = route === "stop"
          ? await s.invoke("architecture_control", { roomId: start.details.roomId, action: "stop" })
          : await s.invoke("team_cancel", { assignmentId: start.details.assignmentId });
        expect(cancelled.isError).not.toBe(true);
        await tick();
        // Neither the provider prompt nor its abort callback has been released.
        expect(children.every(session => session.events.includes("abort"))).toBe(true);
        const held = () => {
          expect(workerHandoff(start.details.instanceId)).toBeUndefined();
          expect(firstTeamReservation(s.evaluation, "architect")).toBe(start.details.assignmentId);
          expect(store.get<AttemptRecord>("attempts", start.details.dispatchId)?.outcome).toBeUndefined();
          const resource = store.get<Resource>("resources", attempt.resource.resourceId);
          expect(resource).toMatchObject(attempt.resource);
          expect(resource!.effectReservation).toBeUndefined();
          expect(store.closureReceipt(attempt.resource)).toBeUndefined();
          const active = teamWorkerStatus(s.evaluation.token).filter(row => row.teamId === start.details.roomId && row.roleId === (stage === "contribution" ? "architect" : "scout"));
          expect(active).toHaveLength(2);
          expect(active.every(row => row.closure.state === "pending")).toBe(true);
          expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(0);
        };
        held();
        releasePrompt.resolve(); await tick();
        expect(children.every(session => !session.events.includes("dispose"))).toBe(true);
        held();
        releaseAbort.resolve(); await disposing.promise; held();
        releaseDispose.resolve(); await s.delivered.promise;
        expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("cancelled");
        await s.bookkeeping(start.details.instanceId);
        const settled = store.get<AttemptRecord>("attempts", start.details.dispatchId)!;
        expect(settled.outcome?.status).toBe("cancelled");
        expect(store.verifyClosureReceipt(store.closureReceipt(attempt.resource)!)).toBe(true);
        expect(firstTeamReservation(s.evaluation, "architect")).toBeUndefined();
        expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("cancelled");
        expect(store.get<AttemptRecord>("attempts", start.details.dispatchId)?.outcome).toEqual(settled.outcome);
        expect(s.host.sessions).toHaveLength(before.length);
        expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
        for (const { session, prompts } of before) expect(session.prompts).toEqual(prompts);
      } finally { store.close(); release(); await s.close(); }
    }));
  }

  test(`${route} suppresses late 503 fallback notes, continuation history, activation and prompts`, fixture.ownedCase(`architecture ${route} late failure`, async () => {
    const entered = deferred(), release = deferred(); fixture.finishOnCleanup(release.resolve);
    const activations: string[] = [];
    const s = await setup({ bind(session) {
      const setModel = session.setModel.bind(session);
      session.setModel = async (model: any) => { activations.push(model.id); await setModel(model); };
    }, async prompt(session, request) {
      if (request.stage === "contribution" && session.model.id === "chosen") { entered.resolve(); await release.promise; throw new Error("503 Service Unavailable"); }
    } });
    try {
      const start = await s.invoke("architecture_start", { goal: "late failure" }); await entered.promise;
      const before = { activations: [...activations], prompts: s.host.sessions.map(session => [...session.prompts]) };
      if (route === "stop") await s.invoke("architecture_control", { roomId: start.details.roomId, action: "stop" });
      else await s.invoke("team_cancel", { assignmentId: start.details.assignmentId });
      release.resolve(); await s.delivered.promise;
      const continuations = s.host.sessions.flatMap(session => session.sessionManager.getEntries())
        .filter((entry: any) => entry.customType === "pitako.worker-history" && entry.data.event === "continuation");
      expect(continuations).toEqual([]); // includes the fallback note, even if the retired grant prevents prompting
      expect(activations).toEqual(before.activations);
      expect(s.host.sessions.map(session => session.prompts)).toEqual(before.prompts);
      expect(listObservations().some(row => row.fallbackOccurred)).toBe(false);
      expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("cancelled");
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    } finally { release.resolve(); await s.close(); }
  }));
}

for (const retire of ["stop", "session_start", "session_shutdown"] as const) {
  test(`${retire} joins an active table without fallback or fictitious success`, fixture.ownedCase("architecture " + retire, async () => {
    const entered = deferred(), release = deferred(); fixture.finishOnCleanup(release.resolve);
    let contributions = 0;
    const s = await setup({ async prompt(session, request) { if (request.stage === "contribution" && session.model.id === "chosen") { contributions++; entered.resolve(); await release.promise; return false; } } });
    try {
      const start = await s.invoke("architecture_start", { goal: "cancel" }); await entered.promise;
      const retirement = retire === "stop" ? s.invoke("architecture_control", { roomId: start.details.roomId, action: "stop" }) : s.emit(retire);
      await tick(); expect(workerHandoff(start.details.instanceId)).toBeUndefined();
      release.resolve(); await retirement;
      if (retire === "stop") { await s.delivered.promise; expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("cancelled"); }
      expect(contributions).toBe(1); expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
      expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(retire === "stop" ? 1 : 0);
    } finally { release.resolve(); await s.close(); }
  }));
}

test("partial synthesis is failed and a bound draft without a ledger never invents one", fixture.ownedCase("architecture partial", async () => {
  const s = await setup({ prompt(_session, request, body) { if (request.stage === "synthesis") return { ...body, status: "partial", pending: ["needs decision"] }; } });
  try {
    const db = await openBoard(); const topic = db.createTopic(s.root, { title: "Draft" }); db.claimTopic(s.root, topic.id, "draft"); db.close();
    const file = planFile("draft", s.root); mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `---\nid: draft\nrevision: 1\nstatus: draft\nboard_topic_id: ${topic.id}\n---\nDraft.\n`);
    const start = await s.invoke("architecture_start", { goal: "partial", plan: "draft", unit: "T2" }); await s.delivered.promise;
    expect(existsSync(ledgerFile("draft", s.root))).toBe(false);
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("failed");
    expect(existsSync(ledgerFile("draft", s.root))).toBe(false);
  } finally { await s.close(); }
}));

test("Architect-authorized support uses real native parent attribution, finite dependencies and a common knowledge boundary", fixture.ownedCase("architecture support", async () => {
  const both = deferred(), release = deferred(); fixture.finishOnCleanup(release.resolve);
  let active = 0, maxActive = 0, calls = 0;
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "preparation" && session.model.id === "chosen") return { ...body, doubts: [0, 1, 2].map(index => ({ question: `Question ${index}`, purpose: "resolve uncertainty" })) };
    if (request.stage === "consultation-plan") return { kind: "consultation-plan", resolutions: [], support: request.context.doubts.map((doubt: any, index: number) =>
      ({ role: "scout", brief: `support ${index}`, doubtIds: [doubt.id], prerequisites: index === 2 ? [0] : [] })) };
    if (request.stage === "consultation-response") {
      calls++; active++; maxActive = Math.max(maxActive, active); if (active === 2) both.resolve();
      try { await release.promise; if (request.context.request.brief === "support 0") throw new Error("503 Service Unavailable"); }
      finally { active--; }
      return { kind: "consultation-response", doubtIds: request.context.request.doubtIds, answer: "Observed", evidence: ["source"], limits: [], doubts: [] };
    }
    if (request.stage === "knowledge") {
      expect(request.context.responses.map((response: any) => response.status)).toEqual(["failed", "completed", "failed"]);
      expect(request.context.responses[2].error).toBe("prerequisite failed");
      return { kind: "knowledge", resolutions: request.context.doubts.map((doubt: any, index: number) => ({ doubtId: doubt.id,
        status: index === 1 ? "answered" : "failed", answer: "Support outcome", supportIds: [request.context.responses[index].id] })) };
    }
    if (request.stage === "synthesis") return { ...body, status: "partial", pending: ["Two consultations failed"] };
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "support" }); await both.promise;
    expect(maxActive).toBe(2); expect(workerHandoff(start.details.instanceId)).toBeUndefined();
    expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(0);
    release.resolve(); await s.delivered.promise;
    expect(calls).toBe(2); expect(s.host.sessions.filter(session => session.model!.id === "support").every(session => session.events.includes("dispose"))).toBe(true);
    const history = await s.invoke("agent_history", { action: "list" });
    expect(JSON.stringify(history.details)).toContain(s.host.sessions[0]!.sessionId);
    const dispatches = s.host.sessions[0]!.sessionManager.getEntries().filter((entry: any) => entry.customType === "pitako.architecture.dispatch") as any[];
    expect(dispatches).toHaveLength(3);
    expect(dispatches.every(entry => entry.data.callerSessionId === s.host.sessions[0]!.sessionId && entry.data.parentAssignmentId === start.details.assignmentId)).toBe(true);
    expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
    expect(s.host.sessions).toHaveLength(4);
  } finally { release.resolve(); await s.close(); }
}));
