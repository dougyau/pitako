import { expect, test as bunTest } from "bun:test";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { architectureFixture } from "./fixtures/architecture.ts";
import { PlanSlot, snapshotPlan } from "../extensions/workflow-planning.ts";
import { acquireWorkflowOwner, WorkflowState } from "../extensions/workflow-state.ts";
import { captureCallContext, checkAuthority, checkCallContext, withCallContext, registerWorkflowCommands, planningSlot, reserveEffect, openPlanActivity } from "../extensions/workflow-engine.ts";
import { ledgerFile, planFile, planHash } from "../extensions/workflow.ts";
import { registerBoard } from "../extensions/board/tools.ts";
import { PublicConversation } from "../extensions/agent/public-conversation.ts";
import { executeCodemode } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/execute.js";

const f = architectureFixture("review");
const test = (name: string, body: () => Promise<void>) => bunTest(name, f.fixture.ownedCase(name, body));
const payload = (value: any) => JSON.parse(value.content[0].text);
const handle = (value: any) => {
  const data = payload(value);
  if (!data.metadata) throw new Error(JSON.stringify(value));
  return data.metadata;
};

for (const composition of ["standalone", "packaged"] as const)
for (const boundary of ["message_end", "agent_before_settle"] as const)
for (const outcome of ["error", "aborted"] as const)
test(`${composition} observed ${boundary} ${outcome} fences captured planning before agent_end and joins later`, async () => {
  const app = await f.setup();
  const release = Promise.withResolvers<void>();
  const commands = new Map<string, any>(), tools = new Map<string, any>(), hooks = new Map<string, Function[]>();
  const ctx = { ...app.ctx, signal: new AbortController().signal };
  if (composition === "standalone") registerWorkflowCommands({
    registerCommand(name: string, definition: any) { commands.set(name, definition); },
    registerTool(definition: any) { tools.set(definition.name, definition); },
    on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
    sendMessage() {},
  } as any);
  const command = (name: string) => (composition === "packaged" ? app.commands : commands).get(name);
  const emit = async (name: string, event: any) => {
    if (composition === "packaged") return app.emit(name, event);
    for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
  };
  try {
    await command("plan").handler("observed", ctx);
    const captured = captureCallContext(app.root, ctx.sessionManager);
    if (captured.kind !== "managed") throw new Error("missing original admission");
    const owner = checkAuthority(captured.authority);
    let joined = false;
    owner.retire.add(async () => { await release.promise; joined = true; });
    const message = { role: "assistant", stopReason: outcome };
    // before-settle alone is controlled trigger coverage, not a claim about native event order.
    const observed = emit(boundary, boundary === "message_end" ? { message } : { outcome });
    expect(ctx.signal.aborted).toBe(false);
    // This registered callback crosses the observed frontier BEFORE any agent_end.
    const write = async () => withCallContext(captured, () =>
      (composition === "packaged" ? app.tools : tools).get("planning_write").execute("late-write",
        { revision: "absent", fileHash: null, body: "# Goal\nLate write\n" }, undefined, undefined, ctx));
    const denied = expect(write()).rejects.toThrow("retired workflow authority");
    expect(() => checkCallContext(captured)).toThrow();
    await observed;
    await denied;
    expect(existsSync(planFile("observed", app.root))).toBe(false);
    expect(joined).toBe(false);
    expect(owner.run.state).not.toBe("interrupted");
    await emit("before_agent_start", { prompt: "continue", systemPrompt: "" });
    expect(() => checkCallContext(captured)).toThrow();
    await emit("agent_end", { messages: [message] });
    expect(joined).toBe(false);
    release.resolve();
    await emit("session_before_switch", {});
    expect(joined).toBe(true);
  } finally {
    release.resolve();
    if (composition === "standalone") await emit("session_shutdown", {});
    await app.close();
  }
});

test("observed retirement ignores success, Worker data and foreign or stale session callbacks; fresh admission is explicit", async () => {
  const app = await f.setup();
  const manager = app.ctx.sessionManager, originalSession = manager.getSessionId();
  try {
    await app.commands.get("plan").handler("owned", app.ctx);
    const captured = captureCallContext(app.root, manager);
    const write = async (revision: number | "absent", fileHash: string | null, body: string) =>
      payload(await withCallContext(captured, () => app.invoke("planning_write", { revision, fileHash, body }))).snapshot;
    await app.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
    await app.emit("message_end", { message: { role: "custom", customType: "pitako.worker.result", content: "error aborted /stop" } });
    await app.emit("message_end", { message: { role: "user", content: "error aborted" } });
    await app.emit("agent_before_settle", { outcome: "completed" });
    // Actual registered callbacks, but a different host object cannot nominate this owner.
    const foreign = { ...manager };
    app.ctx.sessionManager = foreign;
    await app.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
    await app.emit("agent_before_settle", { outcome: "aborted" });
    await app.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
    app.ctx.sessionManager = manager;
    manager.getSessionId = () => "stale-reused-manager";
    await app.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
    await app.emit("agent_before_settle", { outcome: "error" });
    manager.getSessionId = () => originalSession;
    const draft = await write("absent", null, "# Goal\nStill owned\n");
    expect(draft.revision).toBe(1);
    await app.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
    await expect(write(draft.revision, draft.fileHash, "Forbidden\n")).rejects.toThrow("retired");
    await app.emit("before_agent_start", { prompt: "continue", systemPrompt: "" });
    expect(() => checkCallContext(captured)).toThrow("retired");
    await app.commands.get("plan").handler("owned", app.ctx);
    const fresh = captureCallContext(app.root, manager);
    expect(fresh).not.toBe(captured);
    expect(() => checkCallContext(fresh)).not.toThrow();
    const updated = payload(await app.invoke("planning_write", { revision: draft.revision, fileHash: draft.fileHash, body: "# Goal\nFresh admission\n" })).snapshot;
    expect(updated.revision).toBe(2);
    expect(() => checkCallContext(captured)).toThrow("retired");
  } finally {
    app.ctx.sessionManager = manager; manager.getSessionId = () => originalSession;
    await app.close();
  }
});

for (const command of ["plan", "task", "execute"] as const)
for (const boundary of ["message_end", "agent_before_settle"] as const)
test(`observed ${boundary} revokes pending /${command} before admission`, async () => {
  const app = await f.setup();
  const idle = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let started: Promise<void> | undefined;
  try {
    if (command === "execute") {
      await app.commands.get("plan").handler("pending", app.ctx);
      const captured = captureCallContext(app.root, app.ctx.sessionManager);
      if (captured.kind !== "managed") throw new Error("missing source owner");
      const slot = planningSlot(captured.authority);
      const draft = slot.writeDraft(slot.read(), "# Goal\nExecution source\n", { execution: "expected" }).snapshot;
      slot.freeze(slot.candidate(draft));
      await app.emit("session_before_switch");
    }
    app.ctx.waitForIdle = async () => { entered.resolve(); await idle.promise; };
    started = app.commands.get(command).handler("pending", app.ctx);
    await entered.promise;
    const before = app.sent.length;
    await app.emit(boundary, boundary === "message_end" ?
      { message: { role: "assistant", stopReason: "error" } } : { outcome: "aborted" });
    idle.resolve();
    await started;
    expect(app.sent.length).toBe(before);
    expect(captureCallContext(app.root, app.ctx.sessionManager).kind).not.toBe("managed");
    app.ctx.waitForIdle = async () => {};
    await app.commands.get(command).handler("pending", app.ctx);
    const fresh = captureCallContext(app.root, app.ctx.sessionManager);
    expect(fresh.kind).toBe("managed");
    expect(() => checkCallContext(fresh)).not.toThrow();
  } finally { idle.resolve(); await started; await app.close(); }
});

test("registered review handles survive content-only conversation and Codemode unwrap through read/control/status", async () => {
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  f.fixture.finishOnCleanup(release.resolve);
  const app = await f.setup({ prompt: async (_session, request) => {
    if (request.stage === "decision") { entered.resolve(); await release.promise; }
  } });
  const capture = new PublicConversation();
  capture.bind(Symbol());
  const generation = capture.binding("controlled-history", "controlled-session");
  try {
    const ctx = { ...app.ctx, tools: [...app.tools.values()], executeTool: async (name: string, args: any) => {
      const result = await app.invoke(name, args);
      // Only the actual registered result crosses the SDK boundary; no details-to-content adapter.
      capture.tool(generation, { type: "tool_execution_end", toolCallId: name, toolName: name, result, isError: !!result.isError });
      return { toolCall: { id: name, name, arguments: args }, result, isError: !!result.isError };
    } };
    const unwrapped = await executeCodemode("start", { code: `text(JSON.parse(await tools.review_start({
      goal: "Review bounded public object", object: { kind: "brief", text: "A bounded public object" }, criteria: ["Boundary"]
    })));` }, undefined, undefined, ctx);
    expect(unwrapped.isError).not.toBe(true);
    await entered.promise;
    const page = capture.read({ kind: "read", instanceId: "controlled", source: "agent_run",
      processId: "controlled", coordinatorSessionId: "owner", epoch: "owner",
      native: { generation, historyId: "controlled-history", sessionId: "controlled-session" } });
    const record = page.changes.find((change: any) => change.record?.payload?.name === "review_start");
    if (!record || !("record" in record) || record.record.kind !== "tool") throw new Error("missing public start");
    const projected = record.record.payload.result;
    expect(JSON.stringify(projected)).not.toContain("details");
    const metadata = JSON.parse(projected![0]!.type === "text" ? projected![0]!.text : "").metadata;
    expect(metadata.assignmentId).toBeString();
    expect(JSON.stringify(unwrapped.content)).toContain(metadata.assignmentId);
    const status = await app.invoke("team_status", {});
    expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(status.content)).toContain(metadata.assignmentId);
    const read = await app.invoke("review_read", { roomId: metadata.roomId });
    expect(read.isError).not.toBe(true);
    const control = await app.invoke("review_control", { roomId: metadata.roomId, action: "context", text: "Keep the entire object boundary" });
    expect(control.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(control))).toBeLessThanOrEqual(4096);
    release.resolve();
    await app.bookkeeping(metadata.instanceId);
  } finally { release.resolve(); await app.close(); capture.retire(); }
});

test("registered multiroot status preserves a paginated immutable cut within the final envelope budget", async () => {
  const release = Promise.withResolvers<void>();
  f.fixture.finishOnCleanup(release.resolve);
  const app = await f.setup({ prompt: async (_session, request) => {
    if (request.stage === "decision") await release.promise;
  } });
  try {
    const handles = [];
    for (let n = 0; n < 16; ++n) handles.push(handle(await app.invoke("review_start", {
      goal: `Bounded independent public object ${n}`, object: { kind: "brief", text: `Object ${n}` }, criteria: ["Boundary"],
    })));
    const first = await app.invoke("team_status", {});
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(4096);
    const initial = payload(first);
    expect(initial.header.complete).toBe(false);
    expect(initial.header.cursor).toBeString();
    const later = handle(await app.invoke("review_start", {
      goal: "After captured cut", object: { kind: "brief", text: "Later object" }, criteria: ["Boundary"],
    }));
    let text = initial.fragment, cursor = initial.header.cursor;
    do {
      const page = await app.invoke("team_status", { cursor });
      if (page.isError) throw new Error(JSON.stringify(page.content));
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
      const next = payload(page);
      text += next.fragment; cursor = next.header.cursor;
    } while (cursor);
    const cut = JSON.parse(text);
    expect(cut.members.map((member: any) => member.assignmentId)).toEqual(handles.map(item => item.assignmentId));
    expect(text).not.toContain(later.assignmentId);
    expect(payload(await app.invoke("team_status", { cursor: initial.header.cursor, assignmentId: handles[0]!.assignmentId })).error).toBeDefined();
    release.resolve();
    await Promise.all([...handles, later].map(item => app.bookkeeping(item.instanceId)));
  } finally { release.resolve(); await app.close(); }
});

test("registered /plan: real independent design and candidate critique produce exact frozen bytes without execution", async () => {
  const app = await f.setup({ config: f.configuration + '\n[architecture]\ncandidates = []\n',
    prompt: (_session, request, body) => {
      if (request.protocol !== "Pitako review" && request.stage === "composition")
        return { kind: "composition", snapshotId: request.snapshot.id, specialists: [], reason: "Director analysis suffices for this bounded design" };
      if (request.protocol === "Pitako review" && request.stage === "synthesis")
        return { ...body, verdict: "changes-required", newFindings: [{ finding: {
          key: "boundary", materiality: "blocking", contract: "The plan identifies its permitted boundary",
          reference: "# Goal", consequence: "A consumer may overreach the intended bounded behavior",
          basis: { kind: "failure", path: "The consumer interprets bounded behavior without a named boundary", evidence: ["# Goal"] },
        }, status: "upheld", reason: "Name the boundary", references: [] }] };
    } });
  try {
    registerBoard(app.pi);
    await app.commands.get("plan").handler("example", app.ctx);
    expect(app.sent.find(item => item.message.customType === "pitako.workflow.plan")?.message.content).toContain("# $plan");
    const absent = payload(await app.invoke("bound_plan_read", {}));
    expect(absent.revision).toBe("absent");
    const topic = await app.invoke("board_topic_create", { title: "Example design" });
    const topicId = topic.details.topicId;
    await app.invoke("planning_write", { revision: "absent", fileHash: null, body: "# Goal\nBounded behavior\n", execution: "none" });
    expect((await app.invoke("board_workflow_claim", { planId: "example", topicId })).isError).not.toBe(true);
    const current = payload(await app.invoke("bound_plan_read", {}));
    const design = handle(await app.invoke("architecture_start", { goal: "Check this entire captured design; no product edits." }));
    expect(design.assignmentId).toBeString();
    await app.bookkeeping(design.instanceId);
    const candidate = payload(await app.invoke("planning_candidate", { revision: current.revision, fileHash: current.fileHash }));
    const review = handle(await app.invoke("planning_review", { candidateId: candidate.candidateId, goal: "Challenge this entire candidate", criteria: ["realizable scope and invariants"] }));
    expect(review.assignmentId).toBeString();
    const acceptance = {
      candidateId: candidate.candidateId, reviewAssignmentId: review.assignmentId, designAssignmentId: design.assignmentId,
      acceptance: "Accept the complete candidate after independent judgments", designAdoption: "Draft design applies; only declared host transformation",
      absorption: "All pertinent released results incorporated; internal cancelled preparation is not a product judgment", dispositions: [],
    };
    await expect(app.invoke("planning_freeze", acceptance)).rejects.toThrow();
    await app.bookkeeping(review.instanceId);
    const critique = await app.read("team_result", { assignmentId: review.assignmentId });
    expect(critique.judgment.completion).toBe("complete");
    expect(app.seen.filter(item => item.request.protocol === "Pitako review").every(item => item.request.object.text === candidate.text)).toBe(true);
    expect(critique.judgment.verdict).toBe("changes-required");
    await expect(app.invoke("planning_freeze", acceptance)).rejects.toThrow("disposition");
    const accepted = { ...acceptance,
      dispositions: critique.findings.map((finding: any) => ({ id: finding.id, decision: "rejected",
        reason: "The bounded controlled example explicitly excludes execution; retain the dissent without changing its verdict" })) };
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    const auxiliary = reserveEffect(context, { reservationId: randomUUID(), kind: "writer", paths: [app.root] })
      .register("controlled-auxiliary", ["host-operation"]);
    auxiliary.enter();
    auxiliary.observe("host-operation", "unknown", true);
    await expect(app.invoke("planning_freeze", accepted)).rejects.toThrow("resources remain");
    expect(auxiliary.observe("host-operation", "closed", true)).toBeDefined();
    if (context.kind !== "managed") throw new Error("missing planning owner");
    const owner = checkAuthority(context.authority);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let observationsJoined = false;
    owner.retire.add(async () => { entered.resolve(); await release.promise; observationsJoined = true; });
    const freezing = app.invoke("planning_freeze", accepted);
    try {
      await entered.promise;
      expect(observationsJoined).toBe(false);
      expect(owner.store.get<any>("reservations", owner.slotReservation!.reservation.reservationId).state).toBe("active");
      expect(() => acquireWorkflowOwner(app.root, "example")).toThrow(/no takeover/);
    } finally { release.resolve(); }
    const receipt = payload(await freezing);
    expect(receipt.newHash).toBe(candidate.fileHash);
    expect(readFileSync(planFile("example", app.root), "utf8")).toBe(candidate.text);
    expect(existsSync(ledgerFile("example", app.root))).toBe(false);
    expect(app.sent.some(item => item.message.customType === "pitako.workflow.execute")).toBe(false);
    // Observe completion before Board lifecycle, reopen, Stop or shutdown can clean it up.
    const reader = new WorkflowState(app.root);
    try {
      expect(reader.get<any>("runs", context.authority.fence.runId).state).toBe("completed");
      const reservations = reader.all<any>("reservations").filter(item => item.runId === owner.run.runId);
      expect(reservations.every(item => item.state === "released")).toBe(true);
      const slot = reservations.find(item => item.reservationId === owner.slotReservation?.reservation.reservationId);
      expect(slot).toBeDefined();
      expect(reader.all<any>("receipts").some(item => item.reservationId === slot.reservationId && reader.verifyReceipt(item))).toBe(true);
      expect(observationsJoined).toBe(true);
      acquireWorkflowOwner(app.root, "example")();
      expect(() => reserveEffect(context, { reservationId: "late", kind: "writer", paths: [app.root] })).toThrow(/completed/);
    } finally { reader.close(); }
    const dispositions = owner.store.all("dispositions");
    await expect(app.invoke("planning_freeze", accepted)).rejects.toThrow(/completed/);
    expect(owner.store.all("dispositions")).toEqual(dispositions);
    expect(payload(await app.invoke("bound_plan_read", {})).fileHash).toBe(receipt.newHash);
    const lifecycle = await app.invoke("board_workflow_lifecycle", { planId: "example", status: "resolved" });
    if (lifecycle.isError) throw new Error(JSON.stringify(lifecycle));
    expect(lifecycle.isError).not.toBe(true);
    expect(existsSync(ledgerFile("example", app.root))).toBe(false);
    await app.commands.get("plan").handler("example --reopen", app.ctx);
    expect(payload(await app.invoke("bound_plan_read", {})).meta.status).toBe("draft");
  } finally { await app.close(); }
});

test("one host slot rejects model frontmatter, stale CAS and material external changes", async () => {
  const app = await f.setup();
  try {
    await app.commands.get("plan").handler("cas", app.ctx);
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing planning admission");
    const owner = checkAuthority(context.authority), slot = planningSlot(context.authority), absent = slot.read();
    expect(() => slot.writeDraft(absent, "---\nid: forged\n---\n")).toThrow("frontmatter");
    let draft = slot.writeDraft(absent, "Original\n").snapshot;
    expect(() => slot.writeDraft(absent, "Stale\n")).toThrow("stale");
    expect(() => openPlanActivity("cas", app.root, draft, {}, "competitor")).toThrow();
    expect(() => app.invoke("write", { path: draft.file, content: "forged" })).toThrow("generic mutations");
    expect(() => new PlanSlot("cas", owner.store, absent, () => {})).toThrow("materially changed");
    for (const edit of [{ body: "Original\n\n" }, { body: "Original\n\n", execution: "none" as const },
      { body: "Original\n\n", execution: "none" as const, boardTopicId: 7 }]) {
      const next = payload(await app.invoke("planning_write", { revision: draft.revision, fileHash: draft.fileHash, ...edit })).snapshot;
      if (draft.revision === "absent") throw new Error("missing original draft");
      expect(next.revision).toBe(draft.revision + 1);
      expect(next.objectHash).not.toBe(draft.objectHash);
      draft = next;
    }
    writeFileSync(draft.file, draft.text!.replace("Original", "Third state"));
    expect(() => slot.read()).toThrow("materially changed");
    expect(readFileSync(draft.file, "utf8")).toContain("Third state");
  } finally { await app.close(); }
});

for (const checkpoint of ["design", "review"] as const)
test(`registered /plan freezes the exact candidate after a host ${checkpoint} checkpoint`, async () => {
  const app = await f.setup({ config: "[review]\ncandidates = []\n[architecture]\ncandidates = []\n",
    prompt: (_session, request) => {
      if (request.stage === "composition")
        return { kind: "composition", snapshotId: request.snapshot.id, specialists: [], reason: "Bounded independent design" };
    } });
  try {
    await app.commands.get("plan").handler("checkpoint", app.ctx);
    const body = "# Goal\nBounded behavior\n";
    let draft = payload(await app.invoke("planning_write", { revision: "absent", fileHash: null, body, execution: "none" })).snapshot;
    const original = draft;
    const design = handle(await app.invoke("architecture_start", { goal: "Examine the entire bounded design" }));
    await app.bookkeeping(design.instanceId);
    const checkpointBody = (worker: typeof design) => body +
      `## Planning workers\n\n| Assignment | Instance | State |\n| --- | --- | --- |\n| ${worker.assignmentId} | ${worker.instanceId} | completed/released |\n`;
    if (checkpoint === "design")
      draft = payload(await app.invoke("planning_write", { revision: draft.revision, fileHash: draft.fileHash,
        body: checkpointBody(design) })).snapshot;
    const candidate = payload(await app.invoke("planning_candidate", { revision: draft.revision, fileHash: draft.fileHash }));
    const review = handle(await app.invoke("planning_review", { candidateId: candidate.candidateId,
      goal: "Review the entire immutable candidate", criteria: ["Boundary"] }));
    await app.bookkeeping(review.instanceId);
    if (checkpoint === "review")
      draft = payload(await app.invoke("planning_write", { revision: draft.revision, fileHash: draft.fileHash,
        body: checkpointBody(review) })).snapshot;
    const report = await app.read("team_result", { assignmentId: review.assignmentId });
    const architecture = await app.read("team_result", { assignmentId: design.assignmentId });
    for (const result of [report, architecture]) {
      expect(result.host.status).toBe("completed");
      expect(result.host.closure.state).toBe("released");
    }
    expect(report.judgment.completion).toBe("complete");
    expect(architecture.judgment.status).toBe("complete");
    const acceptance = { candidateId: candidate.candidateId,
      reviewAssignmentId: review.assignmentId, designAssignmentId: design.assignmentId, dispositions: [],
      acceptance: "Accept this exact reviewed candidate", designAdoption: "Adopt the unchanged complete design",
      absorption: "Both complete released independent judgments incorporated" };
    await expect(app.invoke("planning_freeze", { ...acceptance, candidateId: "forged" })).rejects.toThrow("unknown candidate");
    const foreign = payload(await app.invoke("planning_candidate", { revision: draft.revision, fileHash: draft.fileHash }));
    await expect(app.invoke("planning_freeze", { ...acceptance, candidateId: foreign.candidateId })).rejects.toThrow("does not belong");
    await expect(app.invoke("planning_freeze", { ...acceptance, designAdoption: "" })).rejects.toThrow("explicit design adoption");
    const receipt = payload(await app.invoke("planning_freeze", acceptance));
    expect(draft.revision).toBe(original.revision);
    expect(draft.objectHash).toBe(original.objectHash);
    expect(draft.fileHash).not.toBe(original.fileHash);
    expect(draft.text).toContain(checkpoint === "design" ? design.assignmentId : review.assignmentId);
    expect(receipt.oldHash).toBe(draft.fileHash);
    expect(receipt.candidateId).toBe(candidate.candidateId);
    expect(receipt.newHash).toBe(candidate.fileHash);
    expect(readFileSync(planFile("checkpoint", app.root), "utf8")).toBe(candidate.text);
    expect(candidate.text).not.toContain("## Planning workers");
    expect(existsSync(ledgerFile("checkpoint", app.root))).toBe(false);
  } finally { await app.close(); }
});

test("registered /plan captures the physical worktree root from a nested cwd", async () => {
  const app = await f.setup();
  try {
    execFileSync("git", ["init", "-q"], { cwd: app.root });
    const nested = app.root + "/nested";
    mkdirSync(nested);
    app.ctx.cwd = nested;
    await app.commands.get("plan").handler("nested", app.ctx);
    expect(app.sent.some(item => item.message.customType === "pitako.workflow.plan")).toBe(true);
    const snapshot = payload(await app.invoke("bound_plan_read", {}));
    expect(snapshot.file).toBe(planFile("nested", app.root));
    const written = payload(await app.invoke("planning_write", { revision: "absent", fileHash: null, body: "Nested invocation\n" }));
    expect(written.snapshot.file).toBe(planFile("nested", app.root));
  } finally { await app.close(); }
});

test("retirement during Board acquisition cannot apply a stale planning callback", async () => {
  const app = await f.setup();
  try {
    registerBoard(app.pi);
    await app.commands.get("plan").handler("before", app.ctx);
    const pending = app.invoke("board_topic_create", { title: "Stale callback" });
    const replacement = app.commands.get("plan").handler("after", app.ctx);
    const [result] = await Promise.all([pending, replacement]);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("retired");
    const topics = await app.invoke("board_topic_list", {});
    expect(topics.details.total).toBe(0);
    expect(payload(await app.invoke("bound_plan_read", {})).revision).toBe("absent");
  } finally { await app.close(); }
});

for (const rejection of ["partial", "inconclusive", "null", "stale", "stale-design"] as const)
test(`managed freeze rejects a real selected ${rejection} judgment without touching draft bytes`, async () => {
  const app = await f.setup({ config: f.configuration + '\n[architecture]\ncandidates = []\n',
    prompt: (_session, request, body) => {
      if (request.protocol !== "Pitako review" && request.stage === "composition")
        return { kind: "composition", snapshotId: request.snapshot.id, specialists: [], reason: "Bounded design" };
      if (request.protocol === "Pitako review" && request.stage === "synthesis") {
        if (rejection === "null") return false;
        if (rejection === "partial") return { ...body, completion: "partial", verdict: "inconclusive" };
        if (rejection === "inconclusive") return { ...body, verdict: "inconclusive" };
      }
    } });
  try {
    await app.commands.get("plan").handler("rejected", app.ctx);
    const draft = payload(await app.invoke("planning_write", { revision: "absent", fileHash: null, body: "# Goal\nBounded behavior\n" })).snapshot;
    const design = handle(await app.invoke("architecture_start", { goal: "Examine the complete bounded design" }));
    await app.bookkeeping(design.instanceId);
    let candidate = payload(await app.invoke("planning_candidate", { revision: draft.revision, fileHash: draft.fileHash }));
    let review = handle(await app.invoke("planning_review", { candidateId: candidate.candidateId,
      goal: "Independent complete candidate critique", criteria: ["Boundary"] }));
    await app.bookkeeping(review.instanceId);
    const report = await app.read("team_result", { assignmentId: review.assignmentId });
    if (rejection === "null") expect(report.judgment).toBeNull();
    if (rejection === "partial") expect(report.judgment.completion).toBe("partial");
    if (rejection === "inconclusive") expect(report.judgment.verdict).toBe("inconclusive");
    if (rejection === "stale" || rejection === "stale-design") {
      const next = payload(await app.invoke("planning_write", { revision: draft.revision, fileHash: draft.fileHash,
        body: "# Goal\nMaterially different behavior\n" })).snapshot;
      expect(next.revision).toBe(draft.revision + 1);
      expect(next.objectHash).not.toBe(draft.objectHash);
      if (rejection === "stale-design") {
        candidate = payload(await app.invoke("planning_candidate", { revision: next.revision, fileHash: next.fileHash }));
        review = handle(await app.invoke("planning_review", { candidateId: candidate.candidateId,
          goal: "Review the materially different candidate", criteria: ["Changed behavior"] }));
        await app.bookkeeping(review.instanceId);
      }
    }
    const before = readFileSync(draft.file, "utf8");
    await expect(app.invoke("planning_freeze", { candidateId: candidate.candidateId,
      reviewAssignmentId: review.assignmentId, designAssignmentId: design.assignmentId, dispositions: [],
      acceptance: "No authority to waive the missing judgment", designAdoption: "Bounded design", absorption: "No pending coordinator questions",
    })).rejects.toThrow(rejection === "stale" ? "stale" : rejection === "stale-design" ? "architecture judgment required" : "incomplete");
    expect(readFileSync(draft.file, "utf8")).toBe(before);
    expect(existsSync(ledgerFile("rejected", app.root))).toBe(false);
  } finally { await app.close(); }
});

test("physical replacement alone invalidates CAS; operational bookkeeping can refresh only file CAS", async () => {
  const app = await f.setup();
  try {
    await app.commands.get("plan").handler("physical", app.ctx);
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing planning admission");
    const slot = planningSlot(context.authority);
    const draft = slot.writeDraft(slot.read(), "Original\n").snapshot;
    const candidate = slot.candidate(draft);
    const receipt = payload(await app.invoke("planning_write", { revision: draft.revision, fileHash: draft.fileHash,
      body: "Original\n## Planning workers\n\n| Worker | State |\n| --- | --- |\n| auxiliary | completed |\n" }));
    const refreshed = slot.read();
    expect(receipt.snapshot).toEqual(refreshed);
    expect(refreshed.objectHash).toBe(draft.objectHash);
    expect(refreshed.fileHash).not.toBe(draft.fileHash);
    expect(candidate.text).not.toContain("auxiliary");
    expect(() => slot.writeDraft(draft, "stale")).toThrow("stale");
    expect(slot.freeze(candidate).newHash).toBe(candidate.fileHash);
    const current = slot.read(), replacement = current.file + ".replacement";
    writeFileSync(replacement, current.text!);
    renameSync(replacement, current.file);
    expect(() => slot.read()).toThrow("materially changed");
  } finally { await app.close(); }
});

for (const state of ["old", "new", "third"] as const) test(`write recovery observes exact ${state} state without overwriting`, async () => {
  const app = await f.setup();
  try {
    await app.commands.get("plan").handler("recovery", app.ctx);
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing planning admission");
    const owner = checkAuthority(context.authority), slot = planningSlot(context.authority);
    const old = slot.writeDraft(slot.read(), "Original\n").snapshot;
    const intentId = randomUUID(), text = old.text!.replace("Original", "Replacement"), temporary = old.file + ".owned.tmp";
    writeFileSync(temporary, text);
    owner.store.put("dispositions", intentId, { kind: "plan-write", intentId, file: old.file, old, text,
      newHash: planHash(text), temporary, candidateId: "controlled-candidate" });
    if (state !== "old") writeFileSync(old.file, state === "new" ? text : old.text!.replace("Original", "Third state"));
    const observed = snapshotPlan("recovery", app.root);
    if (state === "third") {
      expect(() => new PlanSlot("recovery", owner.store, observed, () => {})).toThrow("third state");
      expect(existsSync(temporary)).toBe(true); // Deliberate diagnostic; outer fixture owns cleanup after settlement.
    } else {
      const recovered = new PlanSlot("recovery", owner.store, observed, () => {});
      expect(recovered.read().text).toBe(state === "old" ? old.text : text);
      expect(existsSync(temporary)).toBe(false);
      expect(owner.store.get<any>("dispositions", intentId).receipt).toBeDefined();
      if (state === "new") expect(owner.store.get<any>("dispositions", intentId).receipt.candidateId).toBe("controlled-candidate");
    }
    expect(readFileSync(old.file, "utf8")).toBe(observed.text!);
  } finally { await app.close(); }
});

test("pinned frozen source cannot reopen and explicit expected planning cannot resolve Board", async () => {
  const app = await f.setup();
  try {
    registerBoard(app.pi);
    await app.commands.get("plan").handler("pinned", app.ctx);
    const topicId = (await app.invoke("board_topic_create", { title: "Pinned design" })).details.topicId;
    await app.invoke("planning_write", { revision: "absent", fileHash: null, body: "Bounded\n", execution: "expected" });
    await app.invoke("board_workflow_claim", { planId: "pinned", topicId });
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing planning admission");
    const slot = planningSlot(context.authority), candidate = slot.candidate(slot.read());
    slot.freeze(candidate);
    expect((await app.invoke("board_workflow_lifecycle", { planId: "pinned", status: "resolved" })).isError).toBe(true);
    expect(existsSync(ledgerFile("pinned", app.root))).toBe(false);
    writeFileSync(ledgerFile("pinned", app.root), "Pinned ledger fixture\n");
    expect(() => slot.reopen(slot.read())).toThrow("pinned");
    expect(readFileSync(ledgerFile("pinned", app.root), "utf8")).toBe("Pinned ledger fixture\n");
  } finally { await app.close(); }
});
