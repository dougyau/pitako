import { expect, spyOn, test } from "bun:test";
import path from "node:path";
import * as consultation from "../extensions/agent/consultation.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { architectureFixture } from "./fixtures/architecture.ts";
import { controlledPi, controlledModel } from "./fixtures/pi-factories.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { readBackgroundPending, setBackgroundExecutor, reserveBackground, spawnBackground, workerHandoff, workerStatus,
  draftWorkerResults, observeWorkerResults, observeIntermediateResults, intermediateReceipts,
  draftIntermediateResults, finishTeamWorker, cancelWorker, teamWorkerStatus, publishIntermediate } from "../extensions/agent/background.ts";
import { createAgentController } from "../extensions/agent/controller.ts";
import { createAgentBridge } from "../extensions/agent/bridge/broker.ts";
import { connect } from "../extensions/agent/bridge/client.js";
import { reserveTeamMember, firstTeamReservation, teamEvaluationForSession } from "../extensions/team.ts";
import { WorkflowState, type Resource, type Reservation, type ReleaseReceipt } from "../extensions/workflow-state.ts";
import { bindCallContext, currentCallContext, guardDefinition, RootGuard, type AttemptRecord, type TeamHoldRecord } from "../extensions/workflow-engine.ts";
import { AgentClosureError } from "../extensions/agent/closure.ts";
import { planFile, openExecutionPlan, readLedgerTeamHolds } from "../extensions/workflow.ts";
import { openBoard } from "../extensions/board/store.ts";
import { boardWorkspace } from "../extensions/board/workspace.ts";

const suite = architectureFixture();
const scopeFor = (room: Awaited<ReturnType<typeof suite.setup>>) => ({ ownerToken: room.evaluation.token,
  coordinatorSessionId: room.evaluation.sessionId });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("late guarded children close the completed attempt only at the last frontier, without a Team hold", suite.fixture.ownedCase("late-definition", async () => {
  const room = await suite.setup({ busy: true });
  const file = planFile("late-child", room.root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "---\nid: late-child\nrevision: 1\nstatus: draft\n---\n\nPlan.\n");
  const board = await openBoard();
  let topicId: number;
  try {
    const workspace = boardWorkspace(room.root).identity;
    topicId = board.createTopic(workspace, { title: "late child controlled fixture" }).id;
    board.claimTopic(workspace, topicId, "late-child");
  } finally { board.close(); }
  writeFileSync(file, `---\nid: late-child\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topicId}\n---\n\nPlan.\n`);
  const binding = openExecutionPlan("late-child", room.root).binding;
  const closed = [false, false];
  const toolErrors: unknown[] = [];
  const fail = Promise.withResolvers<void>();
  const tool = guardDefinition({
    name: "controlled-late-definition", label: "late", description: "controlled boundary", parameters: Type.Object({ index: Type.Number() }),
    async execute(_id, { index }) {
      await fail.promise;
      throw new AgentClosureError([new Error("controlled physical uncertainty")], "controlled child",
        { observe: () => closed[index] ? "closed" : "unknown" });
    },
  }, "write");
  setBackgroundExecutor({ async start() {
    const context = currentCallContext()!;
    const sessionManager = SessionManager.inMemory(room.root);
    const unbind = bindCallContext(sessionManager, context);
    try {
      const calls = [0, 1].map(index => Promise.resolve(tool.execute(`child-${index}`, { index }, undefined, undefined,
        { ...room.ctx, sessionManager })).catch(error => { toolErrors.push(error); }));
      fail.resolve();
      await Promise.all(calls);
      return { status: "completed", result: "handled tool errors", sideEffects: false };
    } finally { unbind(); }
  } });
  const guard = new RootGuard(room.root);
  const journal = guard.store;
  try {
    const accepted = await room.invoke("team_assign", { role: "researcher", task: "handle guarded tool errors", plan: "late-child", unit: "B" });
    expect(accepted.isError).not.toBe(true);
    await suite.fixture.settleRuns(); await tick();
    const attempt = journal.all<AttemptRecord>("attempts").find(value => value.instanceId === accepted.details.instanceId)!;
    expect(attempt.outcome).toMatchObject({ status: "completed" });
    expect(toolErrors).toHaveLength(2);
    expect(toolErrors.every(error => error instanceof AgentClosureError)).toBe(true);
    const receipt = () => journal.closureReceipt(attempt.resource);
    expect(receipt()).toBeUndefined();
    expect(readLedgerTeamHolds(room.root, "late-child", binding)).toEqual([]);
    expect(() => guard.assertIdle([room.root])).toThrow();
    closed[0] = true;
    expect(() => guard.assertIdle([room.root])).toThrow();
    expect(receipt()).toBeUndefined();
    expect(journal.all("holds")).toEqual([]);
    closed[1] = true;
    guard.assertIdle([room.root]);
    const parent = receipt()!;
    expect(parent).toBeDefined();
    expect(journal.verifyClosureReceipt(parent)).toBe(true);
    const children = journal.all<Resource>("resources").filter(value => value.parentResource?.resourceId === attempt.resource.resourceId);
    expect(children).toHaveLength(2);
    const childReceipts = journal.all<ReleaseReceipt>("receipts").filter(value => children.some(child =>
      child.effectReservation?.reservationId === value.reservationId));
    expect(childReceipts).toHaveLength(2);
    expect(parent.commitSequence).toBe(Math.max(...childReceipts.map(value => value.commitSequence)));
    expect(childReceipts.every(value => value.receiptId !== parent.receiptId)).toBe(true);
    expect(journal.all("holds")).toEqual([]);
    expect(readLedgerTeamHolds(room.root, "late-child", binding)).toEqual([]);
    guard.assertIdle([room.root]);
    expect(receipt()).toEqual(parent);
    const next = guard.reserve({ reservationId: "next-gate", kind: "gates", paths: [room.root] }).register("gate", ["host-operation"]);
    next.enter(); next.observe("host-operation", "closed", true);
  } finally {
    closed.fill(true);
    fail.resolve();
    // Reobserve owned controlled boundaries before fixture cleanup, even on a red assertion.
    try { guard.assertIdle([room.root]); } catch { /* Red preimage retains a journal-only parent, no external work. */ }
    await room.close(); guard.close();
  }
}));

for (const tool of ["team_assign", "agent_spawn"] as const) test(`${tool} native pending crosses the published client without imported launches`, suite.fixture.ownedCase(tool, async () => {
  const room = await suite.setup({ busy: true });
  const scope = scopeFor(room), started = Promise.withResolvers<void>(), prompt = Promise.withResolvers<void>(),
    disposing = Promise.withResolvers<void>(), disposal = Promise.withResolvers<void>(),
    preparing = Promise.withResolvers<void>(), preparation = Promise.withResolvers<void>();
  const prepare = consultation.prepareConsultation;
  const capture = spyOn(consultation, "prepareConsultation").mockImplementation(async (...args) => {
    preparing.resolve(); await preparation.promise; return prepare(...args);
  });
  const sdk = controlledPi(room.root, { models: [controlledModel("fixture", "support")], async prompt(session) {
    started.resolve(); await prompt.promise;
    session.messages.push({ role: "assistant", content: [{ type: "text", text: "controlled answer" }], stopReason: "stop" });
  },
    async dispose() { disposing.resolve(); await disposal.promise; } });
  setBackgroundExecutor(createPiExecutor({ factories: sdk.factories }));
  const owner = { sessionId: room.evaluation.sessionId, token: room.evaluation.token };
  const controller = createAgentController(owner, () => owner);
  mkdirSync(path.join(room.root, "bridge"), { mode: 0o700 });
  const bridge = createAgentBridge(controller, path.join(room.root, "bridge"), () => true);
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await bridge.ready;
    client = await connect(path.join(room.root, "bridge/descriptor.json"), { expectedSessionId: owner.sessionId });
    expect(await client.backgroundPending()).toEqual({ state: "none" });
    expect((await room.invoke(tool, { role: "researcher", task: "" })).isError).toBe(true);
    expect(await client.backgroundPending()).toEqual({ state: "none" });
    const accepted = await room.invoke(tool, { role: "researcher", task: "No Lineage registration" });
    expect(accepted.isError).not.toBe(true);
    const id = accepted.details.instanceId;
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    const status = () => tool === "team_assign" ? teamWorkerStatus(scope.ownerToken, id)[0]! : workerStatus(id)[0]!;
    expect(status().dispatchPhase).toBe("preflight");
    await preparing.promise;
    expect(sdk.sessions).toHaveLength(0);
    expect(await client.backgroundPending()).toEqual({ state: "pending" });
    preparation.resolve(); await started.promise;
    expect(await client.backgroundPending()).toEqual({ state: "pending" });
    const list = await client.list();
    const item = list.items.find(item => item.id === id)!;
    expect(item.source).toBe(tool);
    const detail = await client.publicDetail(id);
    expect(detail).toMatchObject({ worker: { source: tool, instanceId: id } });
    if (tool === "team_assign") {
      expect(item.assignmentId).toBe(accepted.details.assignmentId);
      expect(detail).toMatchObject({ worker: { teamId: item.teamId, memberId: item.memberId, assignmentId: item.assignmentId } });
    }
    prompt.resolve(); await disposing.promise;
    expect(await client.backgroundPending()).toEqual({ state: "pending" });
    disposal.resolve(); await suite.fixture.settleRuns(); await tick();
    expect(status()).toMatchObject({ status: "completed", closure: { state: "released" } });
    const offers = draftWorkerResults(scope.ownerToken, "completed")!;
    expect(offers.entries).toHaveLength(1);
    expect(await client.backgroundPending()).toEqual({ state: "pending" });
    room.branch.push(...offers.entries); observeWorkerResults(scope.ownerToken);
    const before = workerHandoff(id);
    expect(before).toMatchObject({ delivery: "incorporated", continuation: "requested" });
    expect(await client.backgroundPending()).toEqual({ state: "none" });
    expect(await client.backgroundPending()).toEqual({ state: "none" });
    expect(workerHandoff(id)).toEqual(before);
    expect((await client.list()).items).toHaveLength(1); // Historical rows do not pin.
  } finally {
    preparation.resolve(); prompt.resolve(); disposal.resolve();
    await client?.disconnect(); bridge.revoke(); controller.revoke();
    await bridge.settle(); await controller.settle(); await room.close();
    capture.mockRestore();
  }
}));

test("accepted partial preparation and roster rollback stay pending through cleanup and failure delivery", suite.fixture.ownedCase("preparation", async () => {
  const room = await suite.setup({ busy: true }), scope = scopeFor(room);
  const preparing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(),
    cleaning = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>();
  const reservation = reserveTeamMember(room.evaluation, "oracle", "partial");
  let noWorker = 0, prepared = false;
  const handle = reserveBackground({ cwd: room.root, roleId: "oracle", task: "partial", coordinatorSessionId: scope.coordinatorSessionId,
    owns: () => true, teamOwner: { token: scope.ownerToken, assignmentId: "partial", onSettled: reservation.settled,
      noWorkerReleased() { expect(readBackgroundPending(scope)).toEqual({ state: "pending" }); noWorker++; reservation.noWorkerReleased(); } },
    async prepare() { prepared = true; preparing.resolve(); await release.promise; throw new Error("partial preparation failed"); },
    async cleanup() { cleaning.resolve(); await cleanup.promise; } });
  reservation.rollback();
  expect(firstTeamReservation(room.evaluation, "oracle")).toBeUndefined();
  const journal = new WorkflowState(room.root);
  try {
    // A second connection sees durable admission before the scheduled callback
    // can enter preparation; roster rollback cannot erase it.
    expect(prepared).toBe(false);
    const attempt = journal.get<AttemptRecord>("attempts", handle.dispatchId!)!;
    expect(attempt).toMatchObject({ instanceId: handle.instanceId, assignmentId: "partial" });
    expect(attempt.reservationId).toBeUndefined();
    expect(journal.exactResource(attempt.resource).entered).toBe(true);
    expect(journal.closureReceipt(attempt.resource)).toBeUndefined();
    expect(attempt.outcome).toBeUndefined();
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    await preparing.promise;
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    release.resolve(); await cleaning.promise;
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    cleanup.resolve(); await tick();
    expect(teamWorkerStatus(scope.ownerToken, handle.instanceId)[0]).toMatchObject({ workerStarted: false, closure: { state: "released" } });
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    room.branch.push(...draftWorkerResults(scope.ownerToken, "completed")!.entries);
    observeWorkerResults(scope.ownerToken);
    expect(noWorker).toBe(1); expect(firstTeamReservation(room.evaluation, "oracle")).toBeUndefined();
    expect(journal.get<AttemptRecord>("attempts", handle.dispatchId!)?.outcome).toEqual({
      status: "failed", result: "Error: partial preparation failed" });
    const receipt = journal.closureReceipt(attempt.resource);
    expect(receipt).toBeDefined();
    expect(journal.verifyClosureReceipt(receipt!)).toBe(true);
    expect(journal.get("obligations", `result:${handle.dispatchId}`)).toMatchObject({ cleared: false });
    expect(readBackgroundPending(scope)).toEqual({ state: "none" });
    observeWorkerResults(scope.ownerToken); expect(noWorker).toBe(1);
  } finally { release.resolve(); cleanup.resolve(); await room.close(); journal.close(); }
}));

test("disbanded specialists release internally while the exterior director still pins synthesis and close", suite.fixture.ownedCase("director", async () => {
  const synthesizing = Promise.withResolvers<void>(), synthesis = Promise.withResolvers<void>(),
    closing = Promise.withResolvers<void>(), close = Promise.withResolvers<void>();
  const room = await suite.setup({ busy: true,
    async prompt(_session, request, body) {
      if (request.stage === "preparation") return { kind: "preparation", analysis: "independent", doubts: [] };
      if (request.stage === "contribution") return { kind: "contribution", proposal: "bounded", arguments: ["reason"], objections: [], doubts: [] };
      if (request.stage === "decision") return { kind: "decision", action: "synthesize", reason: "ready" };
      if (request.stage === "synthesis") { synthesizing.resolve(); await synthesis.promise; }
      return body;
    },
    async dispose(session) { if (session.model?.id === "director") { closing.resolve(); await close.promise; } },
  });
  const scope = scopeFor(room);
  try {
    const accepted = await room.invoke("architecture_start", { goal: "bounded synthesis" });
    expect(accepted.isError).not.toBe(true);
    const id = accepted.details.instanceId;
    await synthesizing.promise;
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    synthesis.resolve(); await closing.promise;
    const members = teamWorkerStatus(scope.ownerToken);
    expect(members.filter(row => row.instanceId !== id).every(row => row.closure.state === "released")).toBe(true);
    expect(members.filter(row => row.instanceId !== id).length).toBeGreaterThan(0);
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    close.resolve(); await finishTeamWorker(scope.ownerToken, id); await tick();
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    expect(members.filter(row => row.instanceId !== id).every(row => !workerHandoff(row.instanceId))).toBe(true);
    room.branch.push(...draftWorkerResults(scope.ownerToken, "completed")!.entries);
    observeWorkerResults(scope.ownerToken);
    expect(readBackgroundPending(scope)).toEqual({ state: "none" });
  } finally { synthesis.resolve(); close.resolve(); await room.close(); }
}));

test("historical intermediate delivery cannot be hidden by the final receipt", suite.fixture.ownedCase("intermediate", async () => {
  const room = await suite.setup({ busy: true }), scope = scopeFor(room);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  setBackgroundExecutor({ async start() {
    entered.resolve(); await release.promise;
    return { status: "completed", result: "answer", sideEffects: false };
  } });
  try {
    const accepted = await room.invoke("team_assign", { role: "researcher", task: "controlled historical receipt" });
    expect(accepted.isError).not.toBe(true);
    const id = accepted.details.instanceId;
    await entered.promise;
    // Preserve generic envelope ordering without reviving the retired direct-table producer.
    publishIntermediate(scope.ownerToken, id, "historical-room", "historical-turn", "historical answer");
    expect(intermediateReceipts(scope.ownerToken, id)[0]?.delivery).toBe("pending");
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    release.resolve();
    await suite.fixture.settleRuns(); await tick();
    const final = draftWorkerResults(scope.ownerToken, "completed")!;
    room.branch.push(...final.entries); observeWorkerResults(scope.ownerToken);
    expect(workerHandoff(id)?.delivery).toBe("incorporated");
    expect(intermediateReceipts(scope.ownerToken, id)[0]?.delivery).toBe("pending");
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    const offered = draftIntermediateResults(scope.ownerToken, "completed")!;
    expect(offered.entries).toHaveLength(1);
    room.branch.push(...offered.entries); observeIntermediateResults(scope.ownerToken);
    expect(intermediateReceipts(scope.ownerToken, id)[0]).toMatchObject({ delivery: "incorporated", continuation: "requested" });
    expect(readBackgroundPending(scope)).toEqual({ state: "none" });
    expect(workerHandoff(id)?.continuation).not.toBe("observed");
  } finally { release.resolve(); await room.close(); }
}));

test("repeated cancel and Stop withdraw delivery only after held disposal", suite.fixture.ownedCase("cancel", async () => {
  const room = await suite.setup({ busy: true }), scope = scopeFor(room);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const sdk = controlledPi(room.root, { models: [controlledModel("fixture", "support")], async dispose() { entered.resolve(); await release.promise; } });
  setBackgroundExecutor(createPiExecutor({ factories: sdk.factories }));
  try {
    const accepted = await room.invoke("agent_spawn", { role: "researcher", task: "cancel" });
    await entered.promise;
    cancelWorker(accepted.details.instanceId); cancelWorker(accepted.details.instanceId);
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    const { cancelAllWorkers } = await import("../extensions/agent/background.ts");
    const stopping = cancelAllWorkers();
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    release.resolve(); await stopping;
    expect(readBackgroundPending(scope)).toEqual({ state: "none" });
  } finally { release.resolve(); await room.close(); }
}));

test("replacement revokes old scope synchronously and admits a new owner only after draining", suite.fixture.ownedCase("replacement", async () => {
  const room = await suite.setup({ busy: true }), scope = scopeFor(room);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const sdk = controlledPi(room.root, { models: [controlledModel("fixture", "support")],
    async dispose() { entered.resolve(); await release.promise; } });
  setBackgroundExecutor(createPiExecutor({ factories: sdk.factories }));
  let replacement: Promise<unknown> | undefined;
  try {
    const accepted = await room.invoke("agent_spawn", { role: "researcher", task: "old owner" });
    await entered.promise;
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    expect(() => readBackgroundPending({ ...scope, coordinatorSessionId: "another-session" })).toThrow("stale_owner");
    replacement = room.emit("session_start");
    expect(() => readBackgroundPending(scope)).toThrow("stale_owner");
    expect(teamEvaluationForSession(scope.coordinatorSessionId, false)).toBeUndefined();
    release.resolve(); await replacement;
    const next = teamEvaluationForSession(scope.coordinatorSessionId, false)!;
    expect(next.token).not.toBe(scope.ownerToken);
    expect(() => readBackgroundPending(scope)).toThrow("stale_owner");
    expect(readBackgroundPending({ ownerToken: next.token, coordinatorSessionId: next.sessionId })).toEqual({ state: "none" });
    expect(() => workerStatus(accepted.details.instanceId)).toThrow("unknown worker");
  } finally { release.resolve(); await replacement; await room.close(); }
}));

test("protocol recipient remains pending inside its callback, then needs no exterior receipt", suite.fixture.ownedCase("internal callback", async () => {
  const room = await suite.setup({ busy: true }), scope = scopeFor(room), settled = Promise.withResolvers<void>();
  const recipient = { kind: "protocol" as const, settle() {
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" }); settled.resolve();
  } };
  try {
    const handle = await spawnBackground({ roleId: "researcher", task: "internal", cwd: room.root, recipient,
      historyOrigin: { source: "agent_spawn", coordinatorSessionId: scope.coordinatorSessionId },
      executor: { async start() { return { status: "completed", result: "internal answer", sideEffects: false }; } } });
    await settled.promise; await tick();
    expect(workerHandoff(handle.instanceId)).toBeUndefined();
    expect(readBackgroundPending(scope)).toEqual({ state: "none" });
  } finally { await room.close(); }
}));

test("incorporated exterior result still waits for blocked bookkeeping, but explicit withdrawal releases delivery", suite.fixture.ownedCase("bookkeeping", async () => {
  const room = await suite.setup({ busy: true }), scope = scopeFor(room), settled = Promise.withResolvers<void>();
  try {
    const handle = reserveBackground({ cwd: room.root, roleId: "researcher", task: "bookkeeping", coordinatorSessionId: scope.coordinatorSessionId,
      owns: () => true, async prepare() {
        return { roleId: "researcher", task: "bookkeeping", cwd: room.root,
          reconcileBookkeeping() { settled.resolve(); throw new Error("controlled bookkeeping hold"); },
          executor: { async start() { return { status: "completed", result: "answer", sideEffects: false }; } } };
      } });
    await settled.promise; await tick();
    room.branch.push(...draftWorkerResults(scope.ownerToken, "completed")!.entries); observeWorkerResults(scope.ownerToken);
    expect(workerHandoff(handle.instanceId)).toMatchObject({ delivery: "incorporated", bookkeeping: "blocked" });
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    const { cancelAllWorkers } = await import("../extensions/agent/background.ts");
    await cancelAllWorkers(); expect(readBackgroundPending(scope)).toEqual({ state: "none" });
  } finally { await room.close(); }
}));
