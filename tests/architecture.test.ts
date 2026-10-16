import { stubExternalFactories } from "./fixtures/offline.ts";
stubExternalFactories();
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { workerHandoff, teamWorkerStatus } from "../extensions/agent/background.ts";
import { firstTeamReservation } from "../extensions/team.ts";
import { loadPitakoConfig } from "../extensions/roles/load.ts";
import { openBoard } from "../extensions/board/store.ts";
import { ledgerFile, planFile, readLedgerTeamHolds } from "../extensions/workflow.ts";
import { listObservations } from "../extensions/agent/observe.ts";
import { executionForSession } from "../extensions/execution-identity.ts";
import { architectureFixture } from "./fixtures/architecture.ts";
const { fixture, setup, policies, configuration } = architectureFixture();
const deferred = <T = void>() => Promise.withResolvers<T>();
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("registered watched consultation delivers two intermediate turns, preserves owner/history/holds, then one terminal synthesis after disband", fixture.ownedCase("architecture full route", async () => {
  const disposing = deferred(), release = deferred(); fixture.finishOnCleanup(release.resolve);
  const s = await setup({ busy: true, async dispose(session) { if (session.prompts.some((text: string) => JSON.parse(text).stage === "answer")) { disposing.resolve(); await release.promise; } } });
  try {
    const db = await openBoard(); const topic = db.createTopic(s.root, { title: "Architecture" }); db.claimTopic(s.root, topic.id, "architecture-plan"); db.close();
    const file = planFile("architecture-plan", s.root); mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `---\nid: architecture-plan\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\n---\nArchitecture owned work.\n`);
    const parent = new AbortController();
    const started = await s.invoke("architecture_start", { mode: "consultation", goal: "Review security", topic: "security", plan: "architecture-plan", unit: "T2" }, parent.signal);
    expect(started.isError).not.toBe(true); const handle = started.details;
    parent.abort(); // foreground turn ending never owns the room lifetime
    await s.knowledge[0]!.promise; await tick();
    const hold = readLedgerTeamHolds(s.root, "architecture-plan"); expect(hold).toHaveLength(1);
    expect(hold[0]!.assignmentId).toBe(handle.assignmentId);
    expect(workerHandoff(handle.instanceId)).toBeUndefined();
    expect(firstTeamReservation(s.evaluation, "architect")).toBe(handle.assignmentId);
    const page = (await s.invoke("architecture_read", { roomId: handle.roomId })).details;
    expect(page.state).toBe("waiting"); expect(page.delivery[0].delivery).toBe("pending");
    const fragments = [...page.fragments]; let cursor = page.cursor;
    while (cursor) { const next = (await s.invoke("architecture_read", { roomId: handle.roomId, cursor })).details; expect(next.cut).toBe(page.cut); fragments.push(...next.fragments); cursor = next.cursor; }
    expect(fragments.map(fragment => fragment.text).join("")).toContain("🧠");
    const firstSession = s.host.sessions.find(session => session.prompts.some(text => JSON.parse(text).stage === "answer"))!;
    expect(firstSession.events).not.toContain("dispose");
    expect((await s.invoke("agent_input", { target: { kind: "team", assignmentId: handle.assignmentId }, historyId: "bad", sessionId: s.host.sessions[0]!.sessionId, intent: "steer", text: "bypass" })).isError).toBe(true);
    const getBranch = s.ctx.sessionManager.getBranch;
    try {
      s.ctx.sessionManager.getBranch = () => { throw new Error("branch temporarily unavailable"); };
      await s.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
      expect((await s.invoke("architecture_read", { roomId: handle.roomId })).details.delivery[0].diagnostic).toContain("receipt unavailable");
    } finally { s.ctx.sessionManager.getBranch = getBranch; }
    let draft = await s.emit("agent_before_settle", { outcome: "completed", context: { canContinue: true } });
    expect(draft.entries.map((entry: any) => entry.customType)).toEqual(["pitako.architecture.response"]);
    s.branch.push(...draft.entries); await s.emit("turn_start"); await s.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
    expect((await s.invoke("architecture_read", { roomId: handle.roomId })).details.delivery[0].delivery).toBe("incorporated");
    expect(workerHandoff(handle.instanceId)).toBeUndefined(); expect(readLedgerTeamHolds(s.root, "architecture-plan")).toEqual(hold);
    expect(listObservations().find(row => row.id === handle.instanceId)?.resultTaken).not.toBe(true);
    await s.invoke("architecture_control", { roomId: handle.roomId, action: "context", text: "Now assess migration" });
    await s.knowledge[1]!.promise; await tick();
    expect(firstSession.prompts.filter(text => JSON.parse(text).stage === "answer")).toHaveLength(2);
    expect(s.host.sessions).toHaveLength(2);
    draft = await s.emit("agent_before_settle", { outcome: "completed", context: { canContinue: true } });
    expect(draft.entries).toHaveLength(1); s.branch.push(...draft.entries); await s.emit("turn_start"); await s.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
    expect(readLedgerTeamHolds(s.root, "architecture-plan")).toEqual(hold);
    const list = await s.invoke("agent_history", { action: "list" }); expect(JSON.stringify(list.details)).toContain(handle.assignmentId);
    const specialistMessage = (await s.invoke("architecture_read", { roomId: handle.roomId })).details;
    expect(specialistMessage.members.filter((member: any) => member.id !== handle.assignmentId)).toHaveLength(1);
    await s.invoke("architecture_control", { roomId: handle.roomId, action: "finish" }); await disposing.promise;
    expect(workerHandoff(handle.instanceId)).toBeUndefined(); expect(readLedgerTeamHolds(s.root, "architecture-plan")).toEqual(hold);
    s.setIdle(true); release.resolve(); await s.delivered.promise;
    await s.emit("turn_start");
    expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
    expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    expect(workerHandoff(handle.instanceId)).toMatchObject({ bookkeeping: "reconciled", delivery: "incorporated" });
    expect(readLedgerTeamHolds(s.root, "architecture-plan")).toEqual([]);
    expect((await s.invoke("team_result", { assignmentId: handle.assignmentId })).details.status).toBe("completed");
    const dispatch = s.host.sessions[0]!.sessionManager.getEntries().find((entry: any) => entry.customType === "pitako.architecture.dispatch") as any;
    expect(dispatch.data.callerSessionId).toBe(s.host.sessions[0]!.sessionId);
    expect(dispatch.data.parentAssignmentId).toBe(handle.assignmentId);
  } finally { release.resolve(); await s.close(); }
}));

test("optional strict configuration rejects malformed lists and absent config disables only architecture", fixture.ownedCase("architecture config", async () => {
  const s = await setup({ config: "" });
  try {
    expect((await s.invoke("architecture_start", { mode: "consultation", goal: "review" })).isError).toBe(true);
    expect(s.host.sessions).toHaveLength(0);
    const invalid = ["[architecture]\ncandidates = []", "[architecture]\ncandidates = [{model='fixture/a',fast=true}]", "[architecture]\ncandidates = [{model='fixture/a'}, {model='fixture/a'}]",
      "[architecture]\ncandidates = [{model='fixture/a'}]\n[[architecture.topics]]\ntopic=' '\ncandidates=[{model='fixture/b'}]",
      "[architecture]\ncandidates = [{model='fixture/a'}]\n[[architecture.topics]]\ntopic='Topic'\ncandidates=[{model='fixture/b'}]\n[[architecture.topics]]\ntopic=' topic '\ncandidates=[{model='fixture/c'}]",
      "[architecture]\ncandidates = [{model='fixture/a'}]\n[[architecture.topics]]\ntopic='topic'\ncandidates=[]"];
    for (const config of invalid) { writeFileSync(path.join(s.root, "pitako/config.toml"), policies + config); expect(() => loadPitakoConfig({ cwd: s.root })).toThrow(); }
    writeFileSync(path.join(s.root, "pitako/config.toml"), policies + configuration);
    expect(loadPitakoConfig({ cwd: s.root }).architecture!.topics[0]!.candidates).toHaveLength(3);
  } finally { await s.close(); }
}));

test("topic fallback deduplicates models, uses each target's default, and restarts original choice on the retained conversation", fixture.ownedCase("architecture fallback", async () => {
  const attempts: { model: string; level: string; session: string }[] = [];
  const s = await setup({ prompt(session, request) {
    if (request.stage === "answer") {
      attempts.push({ model: session.model.id, level: session.thinkingLevel, session: session.sessionId });
      if (session.model.id !== "general") throw new Error("503 Service Unavailable");
    }
  } });
  try {
    const start = await s.invoke("architecture_start", { mode: "consultation", goal: "fallback" });
    await s.knowledge[0]!.promise; await tick();
    expect(attempts.map(item => [item.model, item.level])).toEqual([["chosen", "high"], ["other", "minimal"], ["general", "minimal"]]);
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "context", text: "second exchange" });
    await s.knowledge[1]!.promise; await tick();
    expect(attempts.slice(3).map(item => [item.model, item.level])).toEqual([["chosen", "high"], ["other", "minimal"], ["general", "minimal"]]);
    expect(new Set(attempts.map(item => item.session)).size).toBe(1);
    expect(s.host.sessions).toHaveLength(2);
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "finish" }); await s.delivered.promise;
    expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("completed");
  } finally { await s.close(); }
}));

for (const invalid of ["snapshot", "model", "reasoning", "bind-reasoning", "missing", "conflict", "wrong-stage", "caller"] as const) {
  test(`registered protocol rejects ${invalid} without provider fallback`, fixture.ownedCase("architecture invalid " + invalid, async () => {
    let answerAttempts = 0;
    const s = await setup({ bind(session) {
      if (invalid === "bind-reasoning" && session.model?.id === "chosen") session.setModel = async (model: any) => { session.model = { ...model, reasoning: false }; };
    }, async prompt(session, request, body) {
      if (request.stage === "composition") {
        if (invalid === "snapshot") return { ...body, snapshotId: "invented" };
        if (invalid === "model") return { ...body, specialists: [{ candidateRef: "fixture/chosen", mandate: "review", reason: "arbitrary model" }] };
        if (invalid === "reasoning") s.host.models.find(model => model.id === "chosen")!.reasoning = false;
      }
      if (request.stage === "answer") {
        answerAttempts++;
        const submit = session.tools.get("architecture_submit").definition;
        if (invalid === "missing") return false;
        if (["conflict", "wrong-stage", "caller"].includes(invalid)) {
          const ctx = { sessionManager: session.sessionManager };
          const value = { submissionId: "one", body };
          if (invalid === "conflict") {
            const receipt = await submit.execute("one", value, undefined, undefined, ctx);
            expect(receipt.isError).not.toBe(true);
            const duplicate = await submit.execute("duplicate", structuredClone(value), undefined, undefined, ctx);
            expect(duplicate.details).toEqual(receipt.details);
            const conflict = await submit.execute("conflict", { ...value, body: { ...body, answer: "different" } }, undefined, undefined, ctx);
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
      const start = await s.invoke("architecture_start", { mode: "consultation", goal: "reject" }); await s.delivered.promise;
      expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("failed");
      expect(answerAttempts).toBe(["snapshot", "model", "reasoning", "bind-reasoning"].includes(invalid) ? 0 : 1);
      expect(s.host.sessions.some(session => session.prompts.some(text => JSON.parse(text).stage === "answer") && session.model?.id !== "chosen")).toBe(false);
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    } finally { await s.close(); }
  }));
}

test("direct and codemode-reachable participant capabilities are leaf, and prior-turn submit grants are stale", fixture.ownedCase("architecture grants", async () => {
  let forbiddenCalls = 0, oldSubmit: any;
  const external = new Map(["agent_spawn", "team_assign", "architecture_start", "architecture_control", "head_plan", "edit", "write", "apply_patch", "lsp_rename"].map(name =>
    [name, { definition: { name, execute(): { isError?: boolean } { forbiddenCalls++; return {}; } } }]));
  const s = await setup({ extensions: [{ resolvedPath: "controlled-capabilities", tools: external }], async prompt(session, request, body) {
    for (const [name, tool] of external) {
      expect((await tool.definition.execute()).isError).toBe(true); // same executable definitions codemode obtains
      const guards = session.hooks.get("tool_call") ?? [];
      expect(guards.some((guard: Function) => guard({ toolName: name })?.block)).toBe(true);
    }
    if (request.stage === "answer") {
      if (oldSubmit) {
        expect((await oldSubmit.execute("stale", { submissionId: "old", body }, undefined, undefined, { sessionManager: session.sessionManager })).isError).toBe(true);
      }
      oldSubmit = session.tools.get("architecture_submit").definition;
      const submitted = structuredClone(body);
      expect((await oldSubmit.execute("immutable", { submissionId: "immutable", body: submitted }, undefined, undefined, { sessionManager: session.sessionManager })).isError).not.toBe(true);
      submitted.answer = "mutated after receipt";
      return false;
    }
  } });
  try {
    const start = await s.invoke("architecture_start", { mode: "consultation", goal: "grants" });
    await s.knowledge[0]!.promise; await tick();
    expect(forbiddenCalls).toBe(0);
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "context", text: "new turn" }); await s.knowledge[1]!.promise; await tick();
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "finish" }); await s.delivered.promise;
    expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("completed");
    expect(s.host.sessions).toHaveLength(2); expect(forbiddenCalls).toBe(0);
    expect(s.sent.filter(item => item.message.customType === "pitako.architecture.response")
      .every(item => JSON.parse(item.message.content).answer.body.answer.endsWith("🧠"))).toBe(true);
  } finally { await s.close(); }
}));

for (const route of ["stop", "team_cancel"] as const) {
  for (const stage of ["answer", "consultation-response"] as const) {
    test(`${route} aborts active ${stage} children before prompt release and joins abort/disposal`, fixture.ownedCase(`architecture ${route} ${stage} closure`, async () => {
      const entered = deferred(), releasePrompt = deferred(), releaseAbort = deferred(), disposing = deferred(), releaseDispose = deferred();
      const children: any[] = [];
      const release = () => { releasePrompt.resolve(); releaseAbort.resolve(); releaseDispose.resolve(); };
      fixture.finishOnCleanup(release);
      const s = await setup({
        async prompt(session, request, body) {
          if (stage === "consultation-response") {
            if (request.stage === "answer") return { ...body, doubts: [0, 1].map(index => ({ question: `Question ${index}`, purpose: "check cancellation" })) };
            if (request.stage === "consultation-plan") return { kind: "consultation-plan", resolutions: [], support: request.context.doubts.map((doubt: any) =>
              ({ role: "scout", brief: "resolve doubt", doubtIds: [doubt.id], prerequisites: [] })) };
          }
          if (request.stage === stage) {
            children.push(session);
            if (children.length === (stage === "answer" ? 1 : 2)) entered.resolve();
            await releasePrompt.promise;
            throw new Error("503 Service Unavailable");
          }
        },
        async abort(session) { if (children.includes(session)) await releaseAbort.promise; },
        async dispose(session) { if (children.includes(session)) { disposing.resolve(); await releaseDispose.promise; } },
      });
      try {
        const db = await openBoard(); const topic = db.createTopic(s.root, { title: "Cancel" }); db.claimTopic(s.root, topic.id, "cancel-plan"); db.close();
        const file = planFile("cancel-plan", s.root); mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `---\nid: cancel-plan\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\n---\nCancellation.\n`);
        const start = await s.invoke("architecture_start", { mode: "consultation", goal: "cancel active children", plan: "cancel-plan", unit: "T2" });
        await entered.promise;
        const hold = readLedgerTeamHolds(s.root, "cancel-plan"); expect(hold).toHaveLength(1);
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
          expect(readLedgerTeamHolds(s.root, "cancel-plan")).toEqual(hold);
          const active = teamWorkerStatus(s.evaluation.token).filter(row => row.teamId === start.details.roomId && row.roleId === (stage === "answer" ? "architect" : "scout"));
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
        expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("cancelled");
        expect(s.host.sessions).toHaveLength(before.length);
        expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
        for (const { session, prompts } of before) expect(session.prompts).toEqual(prompts);
      } finally { release(); await s.close(); }
    }));
  }

  test(`${route} suppresses late 503 fallback notes, continuation history, activation and prompts`, fixture.ownedCase(`architecture ${route} late failure`, async () => {
    const entered = deferred(), release = deferred(); fixture.finishOnCleanup(release.resolve);
    const activations: string[] = [];
    const s = await setup({ bind(session) {
      const setModel = session.setModel.bind(session);
      session.setModel = async (model: any) => { activations.push(model.id); await setModel(model); };
    }, async prompt(_session, request) {
      if (request.stage === "answer") { entered.resolve(); await release.promise; throw new Error("503 Service Unavailable"); }
    } });
    try {
      const start = await s.invoke("architecture_start", { mode: "consultation", goal: "late failure" }); await entered.promise;
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
      expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("cancelled");
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    } finally { release.resolve(); await s.close(); }
  }));
}

for (const retire of ["stop", "session_start", "session_shutdown"] as const) {
  test(`${retire} joins an active consultation without fallback or fictitious success`, fixture.ownedCase("architecture " + retire, async () => {
    const entered = deferred(), release = deferred(); fixture.finishOnCleanup(release.resolve);
    let answers = 0;
    const s = await setup({ async prompt(_session, request) { if (request.stage === "answer") { answers++; entered.resolve(); await release.promise; return false; } } });
    try {
      const start = await s.invoke("architecture_start", { mode: "consultation", goal: "cancel" }); await entered.promise;
      const retirement = retire === "stop" ? s.invoke("architecture_control", { roomId: start.details.roomId, action: "stop" }) : s.emit(retire);
      await tick(); expect(workerHandoff(start.details.instanceId)).toBeUndefined();
      release.resolve(); await retirement;
      if (retire === "stop") { await s.delivered.promise; expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("cancelled"); }
      expect(answers).toBe(1); expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
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
    const start = await s.invoke("architecture_start", { mode: "consultation", goal: "partial", plan: "draft", unit: "T2" }); await s.knowledge[0]!.promise; await tick();
    expect(existsSync(ledgerFile("draft", s.root))).toBe(false);
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "finish" }); await s.delivered.promise;
    expect((await s.invoke("team_result", { assignmentId: start.details.assignmentId })).details.status).toBe("failed");
    expect(existsSync(ledgerFile("draft", s.root))).toBe(false);
  } finally { await s.close(); }
}));

test("Architect-authorized support uses real native parent attribution, finite dependencies and a common knowledge boundary", fixture.ownedCase("architecture support", async () => {
  const both = deferred(), release = deferred(); fixture.finishOnCleanup(release.resolve);
  let active = 0, maxActive = 0, calls = 0;
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "answer") return { ...body, doubts: [0, 1, 2].map(index => ({ question: `Question ${index}`, purpose: "resolve uncertainty" })) };
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
  } });
  try {
    const start = await s.invoke("architecture_start", { mode: "consultation", goal: "support" }); await both.promise;
    expect(maxActive).toBe(2); expect(workerHandoff(start.details.instanceId)).toBeUndefined();
    expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(0);
    release.resolve(); await s.knowledge[0]!.promise; await s.response.promise;
    expect(calls).toBe(2); expect(s.host.sessions.filter(session => session.model!.id === "support").every(session => session.events.includes("dispose"))).toBe(true);
    const history = await s.invoke("agent_history", { action: "list" });
    expect(JSON.stringify(history.details)).toContain(s.host.sessions[0]!.sessionId);
    const dispatches = s.host.sessions[0]!.sessionManager.getEntries().filter((entry: any) => entry.customType === "pitako.architecture.dispatch") as any[];
    expect(dispatches).toHaveLength(3);
    expect(dispatches.every(entry => entry.data.callerSessionId === s.host.sessions[0]!.sessionId && entry.data.parentAssignmentId === start.details.assignmentId)).toBe(true);
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "finish" }); await s.delivered.promise;
    expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
    expect(s.host.sessions).toHaveLength(4);
  } finally { release.resolve(); await s.close(); }
}));
