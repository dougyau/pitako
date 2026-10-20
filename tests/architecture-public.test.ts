import { afterEach, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AgentClosureError } from "../extensions/agent/closure.ts";
import { setBackgroundExecutor, clearBackgroundOwner, teamWorkerStatus } from "../extensions/agent/background.ts";
import { architectureFixture } from "./fixtures/architecture.ts";
import * as board from "../extensions/board/store.ts";
import { planFile } from "../extensions/workflow.ts";
import { createAgentController } from "../extensions/agent/controller.ts";
import { createAgentBridge } from "../extensions/agent/bridge/broker.ts";
import { capabilities } from "../extensions/agent/bridge/protocol.js";
import { frame, frames } from "../extensions/agent/framing.js";
import { teamAssignments, firstTeamReservation, retireTeamEvaluation, beginTeamEvaluation } from "../extensions/team.ts";
import { architectureRooms, subscribeArchitectureChanges, architecturePublication, architectureMembersClosed,
  registerArchitectureRoom, observeArchitectureAssignment, architectureMember } from "../extensions/architecture/rooms.ts";
import { clearObservations } from "../extensions/agent/observe.ts";
import { executionForSession } from "../extensions/execution-identity.ts";

const { fixture, setup } = architectureFixture();
async function setupAtFrontier(extra: Parameters<typeof setup>[0] = {}) {
  const frontier = gate(), release = gate();
  fixture.finishOnCleanup(release.resolve);
  const s = await setup({ ...extra, async prompt(session, request, body) {
    if (request.stage === "decision") { frontier.resolve(); await release.promise; }
    const submission = request.stage === "synthesis" && request.context.partialReasons.length ?
      { ...body, status: "partial", pending: request.context.partialReasons } : body;
    return await extra.prompt?.(session, request, submission) ?? submission;
  } });
  return { ...s, frontier, advance() { release.resolve(); }, async invoke(...args: Parameters<typeof s.invoke>) {
    const result = await s.invoke(...args);
    if (args[0] === "architecture_control" && ["finish", "stop"].includes(args[1].action)) release.resolve();
    return result;
  }, async close() { release.resolve(); await s.close(); } };
}
const oldDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => { fixture.requireReleasedFixture(); clearObservations();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; });
const gate = <T = void>() => Promise.withResolvers<T>();
async function reader(descriptor: string, sessionId: string) {
  const child = spawn("node", [path.resolve("tests/fixtures/public-architecture-reader.mjs"), descriptor, sessionId], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  const started = gate<any>(), exited = gate<void>(); let sequence = 0;
  const pending = new Map<number, ReturnType<typeof gate<any>>>();
  child.on("error", started.reject);
  child.on("exit", code => { if (code !== 0) { started.reject(Error(stderr)); for (const item of pending.values()) item.reject(Error(stderr)); } exited.resolve(); });
  child.on("message", (message: any) => { if (message.ready) started.resolve(message); else { const entry = pending.get(message.id); pending.delete(message.id);
    if (message.error) entry?.reject(Object.assign(Error(message.error.message), message.error)); else entry?.resolve(message.result); } });
  const ready = await started.promise;
  const call = (method: string, ...args: any[]) => { while (args.length && args.at(-1) === undefined) args.pop(); const id = ++sequence, entry = gate<any>(); pending.set(id, entry); child.send({ id, method, args }); return entry.promise; };
  return { ready, call, async close() { if (child.exitCode === null && child.connected) await call("disconnect"); await exited.promise; } };
}
async function bridgeFor(s: Awaited<ReturnType<typeof setup>>) {
  const owner = { sessionId: s.evaluation.sessionId, token: s.evaluation.token }, controller = createAgentController(owner, () => owner);
  const root = path.join(s.root, "reader"); mkdirSync(root, { mode: 0o700 });
  const bridge = createAgentBridge(controller, root, () => true); await bridge.ready;
  const node = await reader(path.join(root, "descriptor.json"), owner.sessionId);
  return { node, controller, async close() { await node.close(); bridge.revoke(); controller.revoke(); await bridge.settle(); await controller.settle(); } };
}
async function readAll(node: Awaited<ReturnType<typeof reader>>, ref: any) {
  const records: any[] = [], parts = new Map<string, Buffer[]>(); let cursor: string | undefined, first: any;
  do { const page = await node.call("readArchitecture", ref, cursor); expect(page.state).toBe("ready"); first ??= page;
    for (const record of page.records) { if (record.kind !== "fragment") { records.push(record); continue; }
      const chunks = parts.get(record.recordId) ?? []; expect(chunks.reduce((n, b) => n + b.length, 0)).toBe(record.byteOffset);
      const chunk = Buffer.from(record.data, "base64"); chunks.push(chunk); parts.set(record.recordId, chunks);
      if (record.byteOffset + chunk.length === record.totalBytes) { records.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); parts.delete(record.recordId); } }
    cursor = page.next ?? undefined;
  } while (cursor); expect(parts.size).toBe(0); return { ...first, records };
}

for (const protocol of ["architecture", "review"] as const) {
  const empty = architectureFixture(protocol);
  test(`Node broker/client reads registered ${protocol} director-only work`, empty.fixture.ownedCase(`${protocol} empty public start`, async () => {
    const s = await empty.setup({ config: "", prompt(_session, request, body) {
      return request.stage === "composition" ? { ...body, specialists: [], reason: "Director can cover this bounded object" } : body;
    } });
    let bridge: Awaited<ReturnType<typeof bridgeFor>> | undefined;
    try {
      const start = await s.invoke(`${protocol}_start`, { goal: "Bounded director-only object",
        ...(protocol === "review" ? { object: { kind: "brief", text: "Complete bounded object" }, criteria: ["Ownership"] } : {}) });
      expect(start.isError).not.toBe(true); await s.delivered.promise;
      expect(s.seen.map(item => item.request.stage)).toEqual(["composition", "preparation", "consultation-plan", "contribution", "decision", "synthesis"]);
      expect(s.host.sessions).toHaveLength(1);
      bridge = await bridgeFor(s);
      const detail = await bridge.node.call("publicDetail", start.details.instanceId);
      expect(detail.lifecycle.execution).toBe("completed");
      expect(detail.workbrief.text).toBe("Bounded director-only object");
      const result = await bridge.node.call("publicResult", detail.ref);
      expect(result.state).toBe("ready");
      if (protocol === "architecture") {
        const list = await bridge.node.call("listArchitectures"); expect(list.items).toHaveLength(1);
        expect(list.items[0]).not.toHaveProperty("mode");
        const page = await readAll(bridge.node, list.items[0].ref);
        expect(page.records.filter((record: any) => record.kind === "member")).toHaveLength(1);
        expect(page.records.filter((record: any) => record.kind === "publication").map((record: any) => record.message.stage))
          .toEqual(["composition", "preparation", "consultation-plan", "contribution", "decision", "synthesis"]);
      }
    } finally { await bridge?.close(); await s.close(); }
  }));
}

test("Node broker/client reads no-mode rooms and retained selection without rewriting admission or task", fixture.ownedCase("retained observer provenance", async () => {
  const s = await setup();
  const room = registerArchitectureRoom({ evaluation: s.evaluation, roomId: "observer-room", toolCallId: "start",
    director: { assignmentId: "director-assignment", memberId: "director", instanceId: "director-instance" } });
  const assignment = { id: "specialist-assignment", teamId: room.roomId, memberId: "specialist", instanceId: "specialist-instance",
    roleId: "architect", ordinal: 1, admittedAt: 123, task: "Original admission task" };
  observeArchitectureAssignment(s.evaluation, assignment);
  architectureMember(room, assignment.memberId, "specialist", "initial-composition", undefined, {
    compositionChoiceIndex: 0, selection: { compositionMessageId: "initial-composition", choiceIndex: 0 }, mandate: assignment.task, state: "preparing" });
  let bridge: Awaited<ReturnType<typeof bridgeFor>> | undefined;
  try {
    bridge = await bridgeFor(s);
    const list = await bridge.node.call("listArchitectures");
    expect(list.items[0]).not.toHaveProperty("mode");
    const ref = list.items[0].ref, before = await readAll(bridge.node, ref);
    expect(before.records.find((r: any) => r.kind === "room")).not.toHaveProperty("mode");
    expect(before.records.find((r: any) => r.kind === "member")).toMatchObject({ state: "preparing",
      compositionMessageId: "initial-composition", compositionChoiceIndex: 0 });
    architecturePublication(room, { id: "retained-composition", ordinal: 1, roomId: room.roomId, assignmentId: room.assignmentId,
      memberId: "director", author: "architect", stage: "composition", snapshotId: "candidates", turnId: "turn", attemptId: "attempt",
      body: { kind: "composition", snapshotId: "candidates", reason: "Keep useful conversation",
        specialists: [{ kind: "retain", memberId: assignment.memberId, mandate: "Current mandate", reason: "Continuity" }] },
      native: { sessionId: "director-session", toolCallId: "submit", persistence: "unconfirmed" }, doubts: [] });
    architectureMember(room, assignment.memberId, "specialist", "retained-composition", undefined, {
      compositionChoiceIndex: 1, selection: { compositionMessageId: "retained-composition", choiceIndex: 0 }, mandate: "Current mandate", state: "active" });
    // Re-observing the immutable assignment must not reset the current mandate.
    observeArchitectureAssignment(s.evaluation, assignment);
    const after = await readAll(bridge.node, ref);
    expect(after.records.find((r: any) => r.kind === "member")).toMatchObject({
      id: assignment.memberId, assignmentId: assignment.id, instanceId: assignment.instanceId,
      compositionMessageId: "initial-composition", compositionChoiceIndex: 0, state: "active",
      selection: { compositionMessageId: "retained-composition", choiceIndex: 0 }, mandate: { source: "composition", text: "Current mandate" } });
    expect(assignment.task).toBe("Original admission task");
    expect(after.records.find((r: any) => r.kind === "member")).not.toHaveProperty("supersededByCompositionId");
    expect(after.records.find((r: any) => r.kind === "publication").message.body.specialists[0].kind).toBe("retain");
  } finally { await bridge?.close(); await s.close(); }
}));

test("independent room modules share catalog, notifications and token-scoped retirement with the public controller", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-room-modules-"));
  let first: ReturnType<typeof beginTeamEvaluation>, second: ReturnType<typeof beginTeamEvaluation>;
  let controller: ReturnType<typeof createAgentController> | undefined;
  let view: ReturnType<NonNullable<typeof controller>["openView"]> | undefined;
  const subscriptions: (() => void)[] = [];
  try {
    const sourcePath = fileURLToPath(new URL("../extensions/architecture/rooms.ts", import.meta.url));
    // Evaluate the real module twice, resolving its dependencies back to production.
    const source = readFileSync(sourcePath, "utf8").replace(/(from\s+["'])(\.[^"']+)(["'])/g,
      (_, before, specifier, after) => before + path.resolve(path.dirname(sourcePath), specifier) + after);
    for (const name of ["writer", "reader"]) writeFileSync(path.join(root, `${name}.ts`), source);
    const writer: typeof import("../extensions/architecture/rooms.ts") = await import(path.join(root, "writer.ts"));
    const reader: typeof writer = await import(path.join(root, "reader.ts"));
    expect(writer.registerArchitectureRoom).not.toBe(reader.registerArchitectureRoom);
    first = beginTeamEvaluation(`${path.basename(root)}-first`, false)!;
    second = beginTeamEvaluation(`${path.basename(root)}-second`, false)!;
    const owner = { sessionId: first.sessionId, token: first.token };
    controller = createAgentController(owner, () => owner);
    view = controller.openView({ policy: "bridge-read" });
    const hints: number[] = [], changes: symbol[] = [], survivingChanges: symbol[] = [];
    const publicSubscription = view.subscribe(revision => hints.push(revision));
    subscriptions.push(() => publicSubscription.dispose());
    const unsubscribe = reader.subscribeArchitectureChanges(evaluation => changes.push(evaluation.token));
    subscriptions.push(unsubscribe, reader.subscribeArchitectureChanges(evaluation => survivingChanges.push(evaluation.token)),
      reader.subscribeArchitectureChanges(() => { throw Error("passive observer failure"); }));
    const input = { roomId: "shared-room", toolCallId: "start",
      director: { assignmentId: "director-assignment", memberId: "director-member", instanceId: "director-instance" } };
    const room = writer.registerArchitectureRoom({ ...input, evaluation: first });
    expect(reader.architectureRoom(first, room.roomId)).toBe(room);
    expect(reader.architectureRooms(first)).toEqual([room]);
    expect(reader.architectureRooms({ ...first, token: Symbol("unrelated") })).toEqual([]);
    expect(changes).toEqual([first.token]);
    expect(survivingChanges).toEqual([first.token]);
    expect(hints).toHaveLength(1);
    const list = view.listArchitectures();
    expect(list).toMatchObject({ state: "ready", items: [{ ref: { roomId: room.roomId } }] });
    if (!("items" in list) || !Array.isArray(list.items)) throw Error("missing architecture catalog");
    const ref = list.items[0].ref;
    expect(list.items[0]).not.toHaveProperty("mode");
    expect(view.readArchitecture(ref)).toMatchObject({ state: "ready", capture: { state: "open" },
      records: [{ kind: "room", id: room.roomId, lifecycle: { closure: { state: "pending" } } }] });
    writer.architectureControl(room, "context", "Cross-copy content", "control");
    expect(changes).toEqual([first.token, first.token]);
    expect(view.readArchitecture(ref)).toMatchObject({ records: [
      { kind: "room" }, { kind: "control", text: "Cross-copy content" },
    ] });
    expect(hints).toHaveLength(2);
    unsubscribe();
    const other = writer.registerArchitectureRoom({ ...input, evaluation: second });
    expect(reader.architectureRooms(second)).toEqual([other]);
    expect(reader.architectureRoom(first, room.roomId)).toBe(room);
    expect(changes).toEqual([first.token, first.token]);
    expect(survivingChanges).toEqual([first.token, first.token, second.token]);
    reader.retireArchitectureRooms(first);
    expect(writer.architectureRooms(first)).toEqual([]);
    expect(reader.architectureRooms(first)).toEqual([]);
    expect(writer.architectureRoom(second, other.roomId)).toBe(other);
    expect(reader.architectureRoom(second, other.roomId)).toBe(other);
    writer.architectureProgress(other, "contribution", 2, "running");
    expect(survivingChanges).toEqual([first.token, first.token, second.token, second.token]);
    expect(changes).toEqual([first.token, first.token]);
    expect(reader.architectureRoom(second, other.roomId)?.lifecycle.round).toBe(2);
  } finally {
    for (const unsubscribe of subscriptions) unsubscribe();
    await view?.close(); controller?.revoke(); await controller?.settle();
    await retireTeamEvaluation(first); await retireTeamEvaluation(second);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node ESM detects original v2 without sending unsupported architecture methods", fixture.ownedCase("old bridge", async () => {
  const s = await setup(); const root = path.join(s.root, "old"); mkdirSync(root, { mode: 0o700 });
  const owner = { processId: "old-process", coordinatorSessionId: s.evaluation.sessionId, epoch: "old-epoch" };
  const socket = path.join(root, "bridge.sock"), methods: string[] = [];
  const server = createServer(connection => { const receive = frames((request: any) => { methods.push(request.method);
    connection.write(frame({ version: 2, id: request.id, clientId: request.clientId, owner, ok: true,
      result: { capabilities: capabilities.slice(0, 13), lease: { clientId: request.clientId, resumeToken: "a".repeat(64) } } }, "test")); }); connection.on("data", receive); });
  await new Promise<void>(resolve => server.listen(socket, resolve)); chmodSync(socket, 0o600);
  writeFileSync(path.join(root, "descriptor.json"), JSON.stringify({ version: 2, transport: "unix", owner, socket, token: "b".repeat(64), capabilities: capabilities.slice(0, 13) }), { mode: 0o600 });
  let node: Awaited<ReturnType<typeof reader>> | undefined;
  try { node = await reader(path.join(root, "descriptor.json"), owner.coordinatorSessionId); expect(node.ready.node).toBe("node");
    expect(node.ready.capabilities).not.toContain("architecture.list"); await expect(node.call("listArchitectures")).rejects.toMatchObject({ code: "unsupported_method" });
    expect(methods).toEqual(["connect"]);
  } finally { await node?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await s.close(); }
}));

for (const preparation of ["continues", "fails", "stops"] as const) test(`Node discovers admitted room before runtime; preparation ${preparation}`, fixture.ownedCase(`held preparation ${preparation}`, async () => {
  const fail = preparation === "fails", stop = preparation === "stops";
  const entered = gate(), release = gate(); fixture.finishOnCleanup(release.resolve);
  const s = await setupAtFrontier(); const db = await board.openBoard(); const topic = db.createTopic(s.root, { title: "Private observation" }); db.claimTopic(s.root, topic.id, "observe"); db.close();
  const file = planFile("observe", s.root); mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\nid: observe\nrevision: 1\nstatus: draft\nboard_topic_id: ${topic.id}\n---\nObserve only.\n`);
  const original = board.openBoard;
  const spy = spyOn(board, "openBoard").mockImplementation(async (...args) => { entered.resolve(); await release.promise; if (fail) throw Error("opening failed"); return original(...args); });
  let bridge: Awaited<ReturnType<typeof bridgeFor>> | undefined;
  try {
    const start = await s.invoke("architecture_start", { goal: "# Original 🧠\r\n\nMandate", plan: "observe", unit: "T2" });
    expect(start.isError).not.toBe(true); await entered.promise; expect(s.host.sessions).toHaveLength(0);
    bridge = await bridgeFor(s); expect(bridge.node.ready.capabilities.slice(13, 16)).toEqual(["architecture.list", "architecture.read", "architecture.public-v1"]);
    const list = await bridge.node.call("listArchitectures"); expect(list.items).toHaveLength(1); const ref = list.items[0].ref;
    const before = await readAll(bridge.node, ref); expect(before.capture.state).toBe("open");
    expect(before.records.filter((r: any) => r.kind === "member").map((r: any) => r.assignmentId)).toEqual(teamAssignments(s.evaluation).map(a => a.id));
    expect(before.records.find((r: any) => r.kind === "room").origin.toolCallId).toBe("architecture_start-call");
    expect(s.host.sessions).toHaveLength(0);
    const captured = gate();
    const unwatch = subscribeArchitectureChanges(evaluation => { if (evaluation.token === s.evaluation.token && architectureRooms(evaluation)[0]?.capture.state === "closed") captured.resolve(); });
    fixture.finishOnCleanup(unwatch);
    if (stop) {
      expect((await s.invoke("architecture_control", { roomId: start.details.roomId, action: "stop" })).isError).not.toBe(true);
      const stopped = await readAll(bridge.node, ref);
      expect(stopped.records.find((r: any) => r.kind === "control")).toMatchObject({ order: 1, action: "stop",
        author: { coordinatorSessionId: s.evaluation.sessionId, toolCallId: "architecture_control-call" }, application: { state: "applied", stage: null, round: 0 } });
      expect(s.host.sessions).toHaveLength(0);
    }
    release.resolve();
    if (!fail && !stop) { await s.frontier.promise; await s.invoke("architecture_control", { roomId: start.details.roomId, action: "finish" }); }
    await s.delivered.promise; await captured.promise; unwatch();
    const after = await readAll(bridge.node, ref); expect(after.capture.state).toBe("closed");
    const room = after.records.find((r: any) => r.kind === "room"); expect(room.lifecycle.closure).toEqual({ state: "released", members: fail || stop ? "not-created" : "released", director: fail || stop ? "not-created" : "released" });
    expect(after.records.find((r: any) => r.kind === "outcome").status).toBe(stop ? "cancelled" : "failed");
    if (fail || stop) {
      expect(s.host.sessions).toHaveLength(0);
      expect(teamWorkerStatus(s.evaluation.token, start.details.instanceId)[0]!.workerStarted).toBe(false);
      expect(architectureRooms(s.evaluation)[0]).toMatchObject({ runtimeCreated: false, preparationSettled: true });
    }
  } finally { release.resolve(); await bridge?.close(); try { await s.close(); } finally { spy.mockRestore(); } }
}));

function closedCapture(s: Awaited<ReturnType<typeof setup>>) {
  const ready = gate();
  const unwatch = subscribeArchitectureChanges(evaluation => { if (evaluation.token === s.evaluation.token && architectureRooms(evaluation)[0]?.capture.state !== "open") ready.resolve(); });
  fixture.finishOnCleanup(unwatch);
  return ready.promise.finally(unwatch);
}
test("Node sees settled synthesis, never provisional receipt; director disposal gates final outcome", fixture.ownedCase("publication closure", async () => {
  const provisional = gate(), submit = gate(), disposing = gate(), dispose = gate();
  fixture.finishOnCleanup(() => { submit.resolve(); dispose.resolve(); });
  const s = await setupAtFrontier({
    async afterSubmit(_session, request, receipt) { if (request.stage === "synthesis") { expect(receipt.details.state).toBe("provisional"); provisional.resolve(); await submit.promise; } },
    async dispose(session) { if (session.prompts.some((text: string) => JSON.parse(text).stage === "synthesis")) { disposing.resolve(); await dispose.promise; } },
  });
  let bridge: Awaited<ReturnType<typeof bridgeFor>> | undefined;
  try {
    const start = await s.invoke("architecture_start", { goal: "Check publication", topic: "security" });
    await s.frontier.promise; bridge = await bridgeFor(s);
    const list = await bridge.node.call("listArchitectures"), ref = list.items[0].ref;
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "finish" }); await provisional.promise;
    const count = s.seen.length, before = await readAll(bridge.node, ref);
    expect(before.records.some((r: any) => r.message?.stage === "synthesis")).toBe(false);
    expect(before.records.some((r: any) => r.kind === "outcome")).toBe(false); expect(s.seen.length).toBe(count);
    submit.resolve(); await disposing.promise;
    const held = await readAll(bridge.node, ref), room = held.records.find((r: any) => r.kind === "room");
    expect(held.records.find((r: any) => r.message?.stage === "synthesis").message.body.status).toBe("partial");
    expect(room.lifecycle.closure).toMatchObject({ state: "pending", members: "released", director: "pending" });
    expect(room.lifecycle.outcome).toBe("pending"); expect(held.records.some((r: any) => r.kind === "outcome")).toBe(false);
    const captured = closedCapture(s); dispose.resolve(); await s.delivered.promise; await captured;
    const final = await readAll(bridge.node, ref), outcome = final.records.find((r: any) => r.kind === "outcome");
    expect(outcome).toMatchObject({ status: "failed", content: { kind: "synthesis", body: { status: "partial" } } });
    expect(final.records.find((r: any) => r.kind === "room").lifecycle.closure.state).toBe("released");
    expect(final.records.find((r: any) => r.message?.stage === "synthesis").message.body.status).toBe("partial");
    expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
  } finally { submit.resolve(); dispose.resolve(); await bridge?.close(); await s.close(); }
}));


test("Node roster preserves failed specialists, supports, boundaries and recomposition; partial synthesis is authored", fixture.ownedCase("public roster and synthesis", async () => {
  const frontier = gate(), advance = gate(), disposing = gate(), dispose = gate();
  fixture.finishOnCleanup(() => { advance.resolve(); dispose.resolve(); });
  let compositions = 0;
  const goal = "# Original 🧠\r\n\n" + "- Literal \"quote\" \\ path\n".repeat(100);
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "composition") return { kind: "composition", snapshotId: request.snapshot.id, reason: "Known composition",
      specialists: (++compositions === 1 ? ["failed", "healthy"] : ["replacement"]).map(mandate => ({ kind: "add", candidateRef: "topic:0:0", mandate, reason: "Known composition" })) };
    if (request.stage === "preparation") {
      const mandate = teamAssignments(s.evaluation).find(a => a.instanceId === executionForSession(session.sessionId)?.instanceId)!.task;
      return mandate === "failed" ? false : { kind: "preparation", analysis: mandate,
        doubts: compositions === 1 ? [{ question: "Why?", purpose: "Evidence" }] : [] };
    }
    if (request.stage === "consultation-plan") return { kind: "consultation-plan", resolutions: [], support: request.context.doubts.length ? [
      { role: "scout", brief: "Actual support mandate", doubtIds: request.context.doubts.map((d: any) => d.id), prerequisites: [] }] : [] };
    if (request.stage === "consultation-response") return { kind: "consultation-response", doubtIds: request.context.request.doubtIds, answer: "Known answer", evidence: [], limits: [], doubts: [] };
    if (request.stage === "knowledge") return { kind: "knowledge", resolutions: request.context.doubts.map((d: any) => ({ doubtId: d.id, status: "answered", answer: "Supported", supportIds: [request.context.responses[0].id] })) };
    if (request.stage === "contribution") { if (request.round === 1) { frontier.resolve(); await advance.promise; }
      return { kind: "contribution", proposal: request.context.mandate, arguments: ["Evidence"], objections: [], doubts: [] }; }
    if (request.stage === "decision") return { kind: "decision", action: request.round === 1 ? "recompose" : "synthesize", reason: "Known change" };
    if (request.stage === "synthesis") return { ...body, status: "partial", pending: ["One or more member turns failed"] };
    return body;
  }, async dispose(session) { if (session.prompts.some((p: string) => JSON.parse(p).stage === "synthesis")) { disposing.resolve(); await dispose.promise; } } });
  let bridge: Awaited<ReturnType<typeof bridgeFor>> | undefined;
  try {
    const start = await s.invoke("architecture_start", { goal }); await frontier.promise;
    bridge = await bridgeFor(s); const ref = (await bridge.node.call("listArchitectures")).items[0].ref;
    let cursor: any, restored = "", offset = 0;
    do { const detail = await bridge.node.call("publicDetail", start.details.instanceId, cursor);
      expect(detail.workbrief.source).toBe("original WorkBrief"); expect(detail.workbrief.offset).toBe(offset);
      restored += detail.workbrief.text; offset += detail.workbrief.text.length; cursor = detail.nextBrief;
    } while (cursor); expect(restored).toBe(goal);
    for (const [action, text] of [["context", "New context"], ["priorities", "New priority"]])
      expect((await s.invoke("architecture_control", { roomId: start.details.roomId, action, text })).isError).not.toBe(true);
    const before = await readAll(bridge.node, ref);
    expect(before.records.filter((r: any) => r.kind === "control").every((r: any) => r.application.state === "pending")).toBe(true);
    const prompts = s.host.sessions.map(session => session.prompts.length);
    await readAll(bridge.node, ref); expect(s.host.sessions.map(session => session.prompts.length)).toEqual(prompts);
    advance.resolve(); await disposing.promise;
    const held = await readAll(bridge.node, ref), members = held.records.filter((r: any) => r.kind === "member");
    const assignments = teamAssignments(s.evaluation);
    expect(members.map((r: any) => [r.assignmentId, r.id, r.ordinal, r.admittedAt])).toEqual(assignments.map(a => [a.id, a.memberId, a.ordinal, a.admittedAt]));
    for (const member of members) { const actual = assignments.find(a => a.id === member.assignmentId)!;
      expect(member.mandate).toEqual(member.function === "director" ? { source: "root-workbrief", instanceId: actual.instanceId } :
        { source: member.function === "specialist" ? "composition" : "TeamAssignment.task", text: actual.task });
      expect(member.workerRef.instanceId).toBe(member.instanceId); }
    expect(members.find((m: any) => m.mandate.text === "failed").execution).toBe("failed");
    expect(members.find((m: any) => m.function === "support").mandate.text).toBe("Actual support mandate");
    const compositionsPublished = held.records.filter((r: any) => r.message?.stage === "composition");
    expect(members.find((m: any) => m.mandate.text === "failed")).toMatchObject({ state: "closed" });
    expect(members.find((m: any) => m.mandate.text === "failed")).not.toHaveProperty("supersededByCompositionId");
    expect(members.filter((m: any) => m.supersededByCompositionId).map((m: any) => [m.mandate.text, m.supersededByCompositionId]))
      .toEqual([["healthy", compositionsPublished[1].id]]);
    expect(members.find((m: any) => m.mandate.text === "replacement").compositionMessageId).toBe(compositionsPublished[1].id);
    expect(held.records.filter((r: any) => r.kind === "control").map((r: any) => [r.order, r.author.toolCallId, r.application.state])).toEqual([[1, "architecture_control-call", "applied"], [2, "architecture_control-call", "applied"]]);
    expect(held.records.some((r: any) => r.kind === "failure" && r.phase === "turn")).toBe(true);
    const publications = held.records.filter((r: any) => r.kind === "publication");
    const registered = (await s.read("architecture_read", { roomId: start.details.roomId })).messages;
    expect(held.records.filter((r: any) => ["publication", "knowledge-boundary"].includes(r.kind)).map((r: any) => r.message ?? r)).toEqual(registered);
    expect(held.records.filter((r: any) => r.kind === "knowledge-boundary")).toHaveLength(2);
    expect(publications.every((r: any) => r.message.native.persistence === "unconfirmed")).toBe(true);
    expect(publications.find((r: any) => r.message.stage === "synthesis").message.body.status).toBe("partial");
    const captured = closedCapture(s); dispose.resolve(); await s.delivered.promise; await captured;
    const final = await readAll(bridge.node, ref);
    expect(final.records.find((r: any) => r.kind === "outcome")).toMatchObject({ status: "failed", content: { kind: "synthesis", body: { status: "partial", pending: ["One or more member turns failed"] } } });
    expect(final.records.find((r: any) => r.message?.stage === "synthesis").message.body.status).toBe("partial");
    expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
  } finally { advance.resolve(); dispose.resolve(); await bridge?.close(); await s.close(); }
}));


for (const cancel of [false, true]) test(`finalization exports definitive text when driver ${cancel ? "is cancelled after synthesis" : "fails synthesis"}`, fixture.ownedCase(`driver replacement ${cancel}`, async () => {
  const disposing = gate(), dispose = gate(); fixture.finishOnCleanup(dispose.resolve);
  const s = await setupAtFrontier({ async prompt(_session, request) { if (!cancel && request.stage === "synthesis") throw Error("synthesis rejected"); },
    async dispose(session) { if (cancel && session.prompts.some((text: string) => JSON.parse(text).stage === "synthesis")) { disposing.resolve(); await dispose.promise; } } });
  let bridge: Awaited<ReturnType<typeof bridgeFor>> | undefined;
  try {
    const start = await s.invoke("architecture_start", { goal: "Replacement" }); await s.frontier.promise;
    bridge = await bridgeFor(s); const ref = (await bridge.node.call("listArchitectures")).items[0].ref;
    const captured = closedCapture(s); await s.invoke("architecture_control", { roomId: start.details.roomId, action: "finish" });
    if (cancel) { await disposing.promise; const held = await readAll(bridge.node, ref);
      expect(held.records.some((r: any) => r.message?.stage === "synthesis")).toBe(true);
      expect((await s.invoke("team_cancel", { assignmentId: start.details.assignmentId })).isError).not.toBe(true); dispose.resolve(); }
    await s.delivered.promise; await captured;
    const final = await readAll(bridge.node, ref), outcome = final.records.find((r: any) => r.kind === "outcome");
    expect(outcome.status).toBe(cancel ? "cancelled" : "failed"); expect(outcome.content.kind).toBe("text");
    expect(outcome.content.text).toContain(cancel ? "cancelled" : "no valid settled submit");
    expect(final.records.find((r: any) => r.kind === "room").lifecycle.closure.state).toBe("released");
  } finally { dispose.resolve(); await bridge?.close(); await s.close(); }
}));

test("observer failure is explicit and never changes accepted control or normal delivery", fixture.ownedCase("capture fault", async () => {
  const s = await setupAtFrontier(); let bridge: Awaited<ReturnType<typeof bridgeFor>> | undefined;
  let spy: ReturnType<typeof spyOn> | undefined;
  try {
    const start = await s.invoke("architecture_start", { goal: "Observe fault" }); await s.frontier.promise;
    bridge = await bridgeFor(s); const ref = (await bridge.node.call("listArchitectures")).items[0].ref;
    const room = architectureRooms(s.evaluation)[0]!;
    spy = spyOn(room.records, "set").mockImplementationOnce(() => { throw Error("controlled observer fault"); });
    expect((await s.invoke("architecture_control", { roomId: start.details.roomId, action: "finish" })).isError).not.toBe(true);
    spy.mockRestore(); await s.delivered.promise;
    const final = await readAll(bridge.node, ref);
    expect(final.capture).toMatchObject({ state: "incomplete", gaps: ["capture_failed"] });
    expect(final.records.find((r: any) => r.kind === "outcome")).toMatchObject({ status: "failed", content: { kind: "synthesis" } });
    expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
  } finally { spy?.mockRestore(); await bridge?.close(); await s.close(); }
}));


// Intentional physical uncertainty is retained, never cleared or relabeled as release.
const retained: unknown[] = [];
for (const scenario of ["preparation cleanup", "director disposal", "replacement disposal", "fatal sibling"] as const)
test(`Node observes unknown ${scenario} without inventing release`, async () => {
  const preparation = scenario === "preparation cleanup", specialist = scenario === "replacement disposal" || scenario === "fatal sibling";
  const root = mkdtempSync(path.join(tmpdir(), "pitako-public-unknown-"));
  const keys = ["pitako.backgroundWorkers", "pitako.teamRegistry", "pitako.agentObservations", "pitako.agentUi", "pitako.executionIdentity"].map(Symbol.for);
  const host = globalThis as Record<symbol, unknown>, previous = keys.map(key => Object.getOwnPropertyDescriptor(host, key));
  for (const key of keys) Reflect.deleteProperty(host, key);
  const s = await setupAtFrontier({ root, prompt(session, request, body) {
    if (!specialist) return body;
    if (request.stage === "composition") return { ...body, specialists: [0, 1].map(index =>
      ({ kind: "add", candidateRef: index ? "general:0" : "topic:0:0", mandate: `Focus ${index}`, reason: "Independent evidence" })) };
    if (request.stage === "contribution" && scenario === "fatal sibling" && session.model.id === "chosen") return false;
    if (request.stage === "decision") return { ...body, action: "recompose" };
    return body;
  }, async dispose(session) {
    if (specialist ? session.model.id === "chosen" : !preparation && session.prompts.some((p: string) => JSON.parse(p).stage === "synthesis"))
      throw Error(`${scenario} rejected`);
  } });
  if (specialist) s.advance();
  let bridge: Awaited<ReturnType<typeof bridgeFor>> | undefined, spy: ReturnType<typeof spyOn> | undefined;
  try {
    const params: any = { goal: "Unknown closure" };
    if (preparation) {
      const db = await board.openBoard(); const topic = db.createTopic(root, { title: "Unknown preparation" }); db.claimTopic(root, topic.id, "unknown"); db.close();
      const file = planFile("unknown", root); mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `---\nid: unknown\nrevision: 1\nstatus: draft\nboard_topic_id: ${topic.id}\n---\nUnknown preparation.\n`);
      params.plan = "unknown"; params.unit = "T2";
      spy = spyOn(board, "openBoard").mockImplementation(async () => { throw new AgentClosureError([Error("cleanup uncertain")], "preparation"); });
    }
    const start = await s.invoke("architecture_start", params); bridge = await bridgeFor(s);
    const ref = (await bridge.node.call("listArchitectures")).items[0].ref;
    const captured = architectureRooms(s.evaluation)[0]!.captureComplete ? Promise.resolve() : closedCapture(s);
    if (!preparation && !specialist) { await s.frontier.promise; await s.invoke("architecture_control", { roomId: start.details.roomId, action: "finish" }); }
    await captured;
    const final = await readAll(bridge.node, ref), room = final.records.find((r: any) => r.kind === "room");
    expect(final.capture.state).toBe("closed"); expect(room.lifecycle).toMatchObject({ protocolState: "closure-unknown", outcome: "available", closure: { state: "unknown", director: "unknown" } });
    expect(room.lifecycle.closure.members).toBe(preparation || specialist ? "unknown" : "released");
    expect(final.records.find((r: any) => r.kind === "outcome")).toMatchObject({ status: "failed", content: { kind: "text" } });
    expect(teamWorkerStatus(s.evaluation.token, start.details.instanceId)[0]!.closure.state).toBe("unknown");
    if (preparation) { expect(s.host.sessions).toHaveLength(0); expect(architectureRooms(s.evaluation)[0]!.runtimeCreated).toBe(false); }
    else if (!specialist) expect(final.records.find((r: any) => r.message?.stage === "synthesis").message.body.status).toBe("partial");
    else {
      expect(s.host.sessions).toHaveLength(3); // No replacement admission after uncertain outgoing closure.
      expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(0);
      expect(firstTeamReservation(s.evaluation, "architect")).toBe(start.details.assignmentId);
      const members = final.records.filter((r: any) => r.kind === "member" && r.function === "specialist");
      expect(members.some((member: any) => member.state === "closure-unknown")).toBe(true);
      const contributions = final.records.filter((r: any) => r.message?.stage === "contribution");
      expect(contributions).toHaveLength(scenario === "fatal sibling" ? 2 : 3);
      expect(contributions.at(-1).message.author).toBe("architect");
      expect(final.records.some((r: any) => r.message?.stage === "synthesis")).toBe(false);
    }
    retained.push({ s, observation: architectureRooms(s.evaluation)[0] });
  } finally {
    await bridge?.close();
    await Promise.allSettled([s.close(), retireTeamEvaluation(s.evaluation)]); spy?.mockRestore();
    clearBackgroundOwner(); setBackgroundExecutor(undefined);
    retained.push({ root, registries: keys.map(key => host[key]) });
    keys.forEach((key, index) => { if (previous[index]) Object.defineProperty(host, key, previous[index]!); else Reflect.deleteProperty(host, key); });
    console.log("ARCHITECTURE_UNKNOWN_RETAINED", root);
  }
});


test("contextually rejected bodies never enter publication or protocol history", fixture.ownedCase("invalid submitted publication", async () => {
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "preparation") return { kind: "preparation", analysis: "Ready", doubts: [] };
    if (request.stage === "contribution") {
      const invalid = { kind: "contribution", proposal: "Invalid reference", arguments: [],
        objections: [{ memberId: "unknown", messageId: "unknown", argument: "Invalid reference" }], doubts: [] };
      const rejected = await session.boundTools.get("architecture_submit").execute("bad-reference", { submissionId: "bad", body: invalid }, undefined, undefined, { sessionManager: session.sessionManager });
      expect(rejected.isError).toBe(true); expect(rejected.details).toMatchObject({ code: "reference", badIds: ["unknown", "unknown"], correctionsLeft: 1 });
      return false;
    }
    if (request.stage === "decision") return { kind: "decision", action: "synthesize", reason: "Member failed" };
    if (request.stage === "synthesis") return { ...body, status: "partial", pending: ["Member turn failed"] };
    return body;
  } });
  let bridge: Awaited<ReturnType<typeof bridgeFor>> | undefined;
  try {
    const start = await s.invoke("architecture_start", { goal: "Capture rejected submission" });
    await s.delivered.promise; bridge = await bridgeFor(s);
    const ref = (await bridge.node.call("listArchitectures")).items[0].ref;
    const final = await readAll(bridge.node, ref);
    expect(final.records.some((r: any) => r.message?.stage === "contribution")).toBe(false);
    expect(final.records.some((r: any) => r.kind === "failure" && r.phase === "turn")).toBe(true);
    expect(final.records.find((r: any) => r.kind === "outcome")).toMatchObject({ status: "failed", content: { kind: "synthesis", body: { status: "partial" } } });
  } finally { await bridge?.close(); await s.close(); }
}));

test("table-only controls increment shared cut and hints; snapshots and worker refresh never do", fixture.ownedCase("table change hints", async () => {
  const entered = gate(), release = gate(); fixture.finishOnCleanup(release.resolve);
  const s = await setupAtFrontier({ async afterSubmit(_session, request) { if (request.stage === "synthesis") { entered.resolve(); await release.promise; } } }); let bridge: Awaited<ReturnType<typeof bridgeFor>> | undefined;
  try {
    const start = await s.invoke("architecture_start", { goal: "Hints" }); await s.frontier.promise;
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "finish" }); await entered.promise;
    bridge = await bridgeFor(s); const ref = (await bridge.node.call("listArchitectures")).items[0].ref;
    const view = bridge.controller.openView({ policy: "bridge-read" }), hint = gate<number>(); let hints = 0;
    const subscription = view.subscribe(revision => { hints++; hint.resolve(revision); });
    try {
      const before = await readAll(bridge.node, ref), count = s.seen.length;
      expect((await s.invoke("architecture_control", { roomId: start.details.roomId, action: "priorities", text: "New priority" })).isError).not.toBe(true);
      const revision = await hint.promise;
      const after = await readAll(bridge.node, ref);
      expect(after.cut).toBeGreaterThan(before.cut); expect(after.cut).toBe(revision);
      const settledHints = hints;
      await readAll(bridge.node, ref); await bridge.node.call("listArchitectures");
      expect(hints).toBe(settledHints); expect(s.seen.length).toBe(count);
      expect(view.list().items.every(item => "roleId" in item)).toBe(true);
      expect(view.list().items.some(item => "roomId" in item)).toBe(false);
    } finally { subscription.dispose(); await view.close(); }
    release.resolve(); await s.delivered.promise;
  } finally { release.resolve(); await bridge?.close(); await s.close(); }
}));

test("publication and closure producers advance cuts without worker events; retired callbacks cannot reach a new owner", fixture.ownedCase("architecture producer ownership", async () => {
  const s = await setupAtFrontier(); let bridge: Awaited<ReturnType<typeof bridgeFor>> | undefined;
  let replacement: ReturnType<typeof beginTeamEvaluation>, nextController: ReturnType<typeof createAgentController> | undefined;
  try {
    const start = await s.invoke("architecture_start", { goal: "Owner-bound observation" });
    await s.frontier.promise;
    const captured = closedCapture(s);
    await s.invoke("architecture_control", { roomId: start.details.roomId, action: "finish" });
    await s.delivered.promise; await captured;
    bridge = await bridgeFor(s);
    const view = bridge.controller.openView({ policy: "bridge-read" });
    const room = architectureRooms(s.evaluation)[0]!;
    const publication = [...room.records.values()].find(record => record.kind === "publication" && record.message.body.kind === "preparation")!;
    if (publication.kind !== "publication" || publication.message.body.kind !== "preparation") throw Error("missing settled preparation");
    const message = { ...publication.message, stage: "preparation" as const, body: publication.message.body };
    try {
      const hints: number[] = [], subscription = view.subscribe(revision => hints.push(revision));
      try {
        const before = view.list().revision, prompts = s.seen.length;
        // Replay settled producer facts after worker finalization: no worker event accompanies either call.
        architecturePublication(room, message);
        const published = view.list().revision; expect(published).toBeGreaterThan(before);
        architectureMembersClosed(room);
        const closed = view.list().revision; expect(closed).toBeGreaterThan(published);
        expect(hints).toEqual([published, closed]); expect(s.seen.length).toBe(prompts);
        const ref = (await bridge.node.call("listArchitectures")).items[0].ref;
        await retireTeamEvaluation(s.evaluation);
        await expect(bridge.node.call("readArchitecture", ref)).rejects.toMatchObject({ code: "stale_owner" });
        replacement = beginTeamEvaluation(s.evaluation.sessionId, false)!;
        const owner = { sessionId: replacement.sessionId, token: replacement.token };
        nextController = createAgentController(owner, () => owner);
        const next = nextController.openView({ policy: "bridge-read" });
        try {
          const before = next.list().revision;
          const oldRecords = [...room.records];
          architecturePublication(room, { ...message, id: "late-old-callback" });
          architectureMembersClosed(room, Error("late closure"));
          expect([...room.records]).toEqual(oldRecords);
          expect(next.listArchitectures()).toMatchObject({ state: "ready", items: [], cut: before });
          await expect(bridge.node.call("listArchitectures")).rejects.toMatchObject({ code: "stale_owner" });
        } finally { await next.close(); }
      } finally { subscription.dispose(); }
    } finally { await view.close(); }
  } finally {
    nextController?.revoke(); await nextController?.settle();
    await retireTeamEvaluation(replacement); await bridge?.close(); await s.close();
  }
}));


test("published Node reader and local immutable cuts retain ten ordered resolutions from nine direct and one authored knowledge", fixture.ownedCase("public mixed knowledge", async () => {
  const entered = gate(), release = gate(); fixture.finishOnCleanup(release.resolve);
  let original: any[] = [], authored: any;
  const s = await setup({ async prompt(session, request, body) {
    if (request.stage === "preparation") {
      const mandate = teamAssignments(s.evaluation).find(a => a.instanceId === executionForSession(session.sessionId)?.instanceId)!.task;
      return mandate === "Review security" ? { kind: "preparation", analysis: "Ten doubts",
        doubts: Array.from({ length: 10 }, (_, i) => ({ question: `Doubt ${i}`, purpose: "Complete boundary" })) } : body;
    }
    if (request.stage === "consultation-plan") {
      original = request.context.doubts;
      return { kind: "consultation-plan", resolutions: original.slice(0, 9).map(d => ({ doubtId: d.id, status: "answered", answer: "Direct 🧠".repeat(3000) })),
        support: [{ role: "oracle", brief: "Tenth only", doubtIds: [original[9].id], prerequisites: [] }] };
    }
    if (request.stage === "consultation-response") return { kind: "consultation-response", doubtIds: request.context.request.doubtIds, answer: "Tenth evidence", evidence: [], limits: [], doubts: [] };
    if (request.stage === "knowledge") {
      expect(request.context.delegatedDoubtIds).toEqual([original[9].id]);
      authored = { kind: "knowledge", resolutions: [{ doubtId: original[9].id, status: "answered", answer: "Delegated", supportIds: [request.context.responses[0].id] }] };
      return authored;
    }
    if (request.stage === "contribution") {
      expect(request.context.shared.knowledgeBoundaries[0].resolutions.map((r: any) => r.doubtId)).toEqual(original.map(d => d.id));
      entered.resolve(); await release.promise; return { kind: "contribution", proposal: "Now shared", arguments: [], objections: [], doubts: [] };
    }
    if (request.stage === "decision") return { kind: "decision", action: "synthesize", reason: "Complete" };
    if (request.stage === "synthesis") expect(request.context.knowledgeBoundaries[0].resolutions).toHaveLength(10);
    return body;
  } });
  let bridge: Awaited<ReturnType<typeof bridgeFor>> | undefined;
  try {
    const start = await s.invoke("architecture_start", { goal: "Nine direct plus one delegated" }); await entered.promise;
    bridge = await bridgeFor(s); const ref = (await bridge.node.call("listArchitectures")).items[0].ref;
    const first = await bridge.node.call("readArchitecture", ref); expect(first.next).toBeString();
    const localFirst = await s.invoke("architecture_read", { roomId: start.details.roomId });
    expect(JSON.parse(localFirst.content[0].text).header.cursor).toBeString();
    release.resolve(); await s.delivered.promise;
    const frozen: any[] = [], chunks = new Map<string, Buffer[]>(); let page = first;
    for (;;) {
      expect(page.cut).toBe(first.cut);
      for (const record of page.records) {
        if (record.kind !== "fragment") { frozen.push(record); continue; }
        const parts = chunks.get(record.recordId) ?? []; expect(record.byteOffset).toBe(parts.reduce((n, b) => n + b.length, 0));
        parts.push(Buffer.from(record.data, "base64")); chunks.set(record.recordId, parts);
        if (record.byteOffset + parts.at(-1)!.length === record.totalBytes) { frozen.push(JSON.parse(Buffer.concat(parts).toString())); chunks.delete(record.recordId); }
      }
      if (!page.next) break;
      page = await bridge.node.call("readArchitecture", ref, page.next);
    }
    expect(chunks.size).toBe(0); expect(frozen.some(r => r.message?.stage === "synthesis")).toBe(false);
    const boundaries = frozen.filter(r => r.kind === "knowledge-boundary"); expect(boundaries).toHaveLength(1);
    const boundary = boundaries[0]; expect(boundary.resolutions.map((r: any) => r.doubtId)).toEqual(original.map(d => d.id));
    expect(boundary.resolutions.slice(0, 9).every((r: any) => r.supportIds.length === 0 && r.provenance.kind === "direct" && r.provenance.planMessageId === boundary.planMessageId)).toBe(true);
    const knowledge = frozen.find(r => r.message?.stage === "knowledge").message, support = frozen.find(r => r.message?.stage === "consultation-response").message;
    expect(knowledge.body).toEqual(authored); expect(knowledge.body.resolutions).toHaveLength(1); expect(knowledge.native.toolCallId).toBe("native-submit");
    expect(boundary.knowledgeMessageId).toBe(knowledge.id);
    expect(boundary.resolutions[9].provenance).toEqual({ kind: "delegated", knowledgeMessageId: knowledge.id, consultationId: authored.resolutions[0].supportIds[0],
      responses: [{ consultationId: authored.resolutions[0].supportIds[0], assignmentId: support.assignmentId, messageId: support.id, status: "completed" }] });
    const records = (await s.read("architecture_read", { roomId: start.details.roomId }, localFirst)).messages;
    expect(records.find((r: any) => r.kind === "knowledge-boundary")).toEqual(boundary);
    expect(records.some((r: any) => r.stage === "synthesis")).toBe(false);
    const final = await readAll(bridge.node, ref); expect(final.records.find((r: any) => r.message?.stage === "synthesis").message.body.status).toBe("complete");
  } finally { release.resolve(); await bridge?.close(); await s.close(); }
}));
