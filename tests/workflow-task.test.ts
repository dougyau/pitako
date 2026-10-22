import { afterEach, beforeEach, describe, expect, test as bunTest } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { architectureFixture } from "./fixtures/architecture.ts";
import { captureCallContext, captureResultSource, currentCallContext, checkAuthority, checkTaskAuthority, registerBackgroundAttempt, withCallContext, reserveEffect, RootGuard, waitForProducer } from "../extensions/workflow-engine.ts";
import { WorkflowState } from "../extensions/workflow-state.ts";
import { ledgerFile, planFile } from "../extensions/workflow.ts";
import { finishTask } from "../extensions/workflow-task.ts";

const f = architectureFixture("review");
const test = (name: string, body: () => Promise<void>) => bunTest(name, f.fixture.ownedCase(name, body));
const payload = (value: any) => JSON.parse(value.content[0].text);
const handle = (value: any) => {
  const value_ = payload(value);
  if (!value_.metadata) throw new Error(JSON.stringify(value));
  return value_.metadata;
};
const setup = (critique = false) => {
  const storageRoot = mkdtempSync(path.join(tmpdir(), "pitako-task-storage-"));
  f.fixture.directories.push(storageRoot);
  return f.setup({ storageRoot,
  config: "[review]\ncandidates = []\n[architecture]\ncandidates = []\n",
  prompt: (_session, request, body) => {
    if (request.stage === "composition")
      return { kind: "composition", snapshotId: request.snapshot.id, specialists: [], reason: "Bounded independent design" };
    if (critique && request.protocol === "Pitako review" && request.stage === "synthesis") {
      critique = false;
      return { ...body, verdict: "changes-required", newFindings: [{ finding: {
        key: "boundary", materiality: "blocking", contract: "The plan names its permitted boundary",
        reference: "# Goal", consequence: "A consumer may expand the bounded behavior",
        basis: { kind: "failure", path: "The consumer lacks a named boundary", evidence: ["# Goal"] },
      }, status: "upheld", reason: "Name the local-only boundary", references: [] }] };
    }
  },
  });
};
type App = Awaited<ReturnType<typeof setup>>;
async function freeze(app: App, correct = false) {
  let body = "# Goal\nImplement the bounded local behavior without publication.\n";
  let draft = payload(await app.invoke("planning_write", {
    revision: "absent", fileHash: null, body, execution: "expected",
  })).snapshot;
  let design = handle(await app.invoke("architecture_start", { goal: "Check the complete bounded design." }));
  await app.bookkeeping(design.instanceId);
  const checkpoint = async (workers: typeof design[]) => {
    const previous = draft;
    draft = payload(await app.invoke("planning_write", { revision: draft.revision, fileHash: draft.fileHash,
      body: body + "## Planning workers\n\n| Assignment | State |\n| --- | --- |\n" +
        workers.map(worker => `| ${worker.assignmentId} | completed/released |\n`).join("") })).snapshot;
    expect(draft.objectHash).toBe(previous.objectHash);
    expect(draft.revision).toBe(previous.revision);
    expect(draft.fileHash).not.toBe(previous.fileHash);
    await expect(app.invoke("planning_write", { revision: previous.revision, fileHash: previous.fileHash, body }))
      .rejects.toThrow("stale planning snapshot");
  };
  await checkpoint([design]);
  let candidate = payload(await app.invoke("planning_candidate", { revision: draft.revision, fileHash: draft.fileHash }));
  let review = handle(await app.invoke("planning_review", { candidateId: candidate.candidateId, goal: "Review the complete candidate", criteria: ["Boundary"] }));
  await app.bookkeeping(review.instanceId);
  if (correct) {
    const critique = await app.read("team_result", { assignmentId: review.assignmentId });
    expect(critique.findings).toHaveLength(1);
    await expect(app.invoke("planning_freeze", { candidateId: candidate.candidateId, designAssignmentId: design.assignmentId,
      reviewAssignmentId: review.assignmentId, dispositions: [], acceptance: "Not enough without dispositions",
      designAdoption: "Original design", absorption: "Uncorrected finding" })).rejects.toThrow("disposition");
    body = `# Goal\nImplement bounded behavior.\n# Boundary\nLocal files only; no publication. Corrects ${critique.findings[0].id}.\n`;
    draft = payload(await app.invoke("planning_write", { revision: draft.revision, fileHash: draft.fileHash, execution: "expected", body })).snapshot;
    design = handle(await app.invoke("architecture_start", { goal: "Check the complete corrected local-only design" }));
    await app.bookkeeping(design.instanceId);
    await checkpoint([design]);
    candidate = payload(await app.invoke("planning_candidate", { revision: draft.revision, fileHash: draft.fileHash }));
    review = handle(await app.invoke("planning_review", { candidateId: candidate.candidateId, goal: "Review the entire corrected candidate", criteria: ["Explicit local-only boundary"] }));
    await app.bookkeeping(review.instanceId);
  }
  await checkpoint([design, review]);
  return payload(await app.invoke("planning_freeze", { candidateId: candidate.candidateId, designAssignmentId: design.assignmentId,
    reviewAssignmentId: review.assignmentId, dispositions: [], designAdoption: "Complete unchanged design, exact status transformation",
    acceptance: "Accept the complete reviewed plan", absorption: "All pertinent released planning work absorbed" }));
}

test("native streaming /task Freeze keeps its original loop on the real derived execution receiver", async () => {
  const app = await setup();
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await ModelRuntime.create({ authPath: path.join(app.root, "principal-auth"), modelsPath: null,
    modelsStorePath: path.join(app.root, "principal-models"), allowModelNetwork: false, refreshOnCreate: false });
  const finished = Promise.withResolvers<void>();
  let requests = 0, failure: unknown, frozenWhileStreaming = false;
  runtime.registerProvider("receiver", { api: "openai-completions", apiKey: "offline", baseUrl: "http://offline.invalid",
    models: [{ id: "principal", name: "principal", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const n = requests++, stream = createAssistantMessageEventStream();
      const base: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        const context = currentCallContext();
        expect(context?.kind).toBe("managed");
        if (context?.kind !== "managed") throw new Error("missing native task receiver");
        if (n === 0) {
          expect(checkAuthority(context.authority).run.phase).toBe("planning");
          const prior = registerBackgroundAttempt(context, { cwd: app.root, instanceId: "prior-phase",
            dispatchId: "prior-phase", roleId: "developer" });
          prior.admit();
          const source = captureResultSource(prior, "prior-phase-result",
            { customType: "result", content: "prior phase", details: { deliveryId: "prior-phase" } },
            { owns: () => true, getBranch: () => [] });
          prior.result({ status: "completed", result: "original phase custody" });
          prior.producer.observe("preparation", "closed");
          prior.producer.observe("host-operation", "closed");
          expect(prior.producer.observe("callback", "closed", true)).toBeDefined();
          await freeze(app);
          frozenWhileStreaming = session.isStreaming;
          const next = currentCallContext();
          if (next?.kind !== "managed") throw new Error("missing derived receiver");
          expect(checkAuthority(next.authority).run.phase).toBe("execution");
          expect(() => source.receiverContext(session.sessionManager)).toThrow(/retired or replaced|stale/);
          expect(prior.receipt()).toBeDefined();
          expect(prior.store.get("attempts", "prior-phase")).toMatchObject({ outcome: { result: "original phase custody" } });
          for (const manager of [undefined, session.sessionManager])
            expect(() => withCallContext(context, () => {
              const stale = currentCallContext(manager)!;
              checkAuthority(stale.kind === "managed" ? stale.authority : context.authority);
            })).toThrow(/stale|retired/);
        } else expect(checkAuthority(context.authority).run.phase).toBe("execution");
        const call = n === 1;
        const message: AssistantMessage = { ...base,
          content: call ? [{ type: "toolCall", id: "derived-gate", name: "execution_gates",
            arguments: { commands: [{ command: "printf receiver-effect", timeoutSeconds: 5 }], coverage: "Native current execution receiver" } }]
            : [{ type: "text", text: "phase observed" }], stopReason: call ? "toolUse" : "stop" };
        stream.push({ type: "done", reason: call ? "toolUse" : "stop", message }); stream.end();
      })().catch(error => {
        failure = error;
        stream.push({ type: "error", reason: "error", error: { ...base, stopReason: "error", errorMessage: String(error) } });
        stream.end(); finished.resolve();
      });
      return stream;
    },
  });
  // Reuse the full controlled table fixture. Only the principal loop and tool
  // consumer are native SDK here; no test-only authority or acceptance producer.
  const native: ExtensionFactory = pi => {
    for (const definition of app.tools.values()) pi.registerTool(definition);
    for (const [name, definition] of app.commands) pi.registerCommand(name, definition);
    app.pi.getAllTools = () => pi.getAllTools();
    app.pi.sendMessage = (message: any, options: any) => { app.sent.push({ message, options }); pi.sendMessage(message, options); };
    const forward = (name: string) => async (event: unknown, ctx: ExtensionContext) => {
      if (name === "session_start") {
        app.ctx.sessionManager = ctx.sessionManager;
        app.ctx.isIdle = () => ctx.isIdle();
      }
      const value = await app.emit(name, event);
      if (name === "agent_settled" && requests >= 3) finished.resolve();
      return value;
    };
    pi.on("session_start", forward("session_start"));
    pi.on("session_shutdown", forward("session_shutdown"));
    pi.on("input", forward("input"));
    pi.on("tool_call", forward("tool_call"));
    pi.on("tool_result", forward("tool_result"));
    pi.on("turn_start", forward("turn_start"));
    pi.on("context", forward("context"));
    pi.on("message_end", forward("message_end"));
    pi.on("agent_before_settle", forward("agent_before_settle"));
    pi.on("agent_settled", forward("agent_settled"));
    pi.on("agent_end", forward("agent_end"));
  };
  const loader = new DefaultResourceLoader({ cwd: app.root, agentDir: app.root, settingsManager: settings, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [native] });
  await loader.reload();
  const { session } = await f.fixture.acquire(createAgentSession({ cwd: app.root, agentDir: app.root, modelRuntime: runtime,
    model: runtime.getModel("receiver", "principal"), settingsManager: settings, resourceLoader: loader,
    sessionManager: SessionManager.create(app.root, path.join(app.root, "principal-sessions")) }));
  try {
    await session.bindExtensions({});
    await f.fixture.run(session.prompt("/task streaming"));
    await finished.promise;
    await f.fixture.run(session.waitForIdle());
    if (failure) throw failure;
    expect(frozenWhileStreaming).toBe(true);
    expect(requests).toBeGreaterThanOrEqual(3);
    const result = session.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "execution_gates");
    expect(result, "derived execution must consume a real current native tool call").toBeDefined();
    expect(result!.isError, JSON.stringify(result)).not.toBe(true);
    expect(JSON.stringify(result)).toContain("receiver-effect");
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(2);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await session.dispose();
    await app.close();
  }
});

async function prepareTask(app: App, git: boolean, input = "example") {
    if (git) execFileSync("git", ["init", "-q"], { cwd: app.root });
    await app.commands.get("task").handler(input, app.ctx);
    const before = captureCallContext(app.root, app.ctx.sessionManager);
    if (before.kind !== "managed") throw new Error("missing task");
    const owner = checkAuthority(before.authority);
    const runId = owner.run.runId;
    expect(owner.run.activity).toBe("task");
    await expect(app.invoke("task_finish", { expectedVersion: owner.run.version, freezeReceiptRef: "forged", executionAcceptanceRef: "forged" })).rejects.toThrow();
    const receipt = await freeze(app, !git);
    expect(() => checkAuthority(before.authority)).toThrow("stale");
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing derived execution");
    expect(checkAuthority(context.authority)).toBe(owner);
    expect(owner.run.runId).toBe(runId);
    expect(owner.run.phaseEpoch).toBe(2);
    expect(owner.run.phase).toBe("execution");
    expect(owner.run.task?.freezeReceiptRef).toBe(receipt.receiptId);
    expect(readFileSync(planFile(owner.run.planId, app.root), "utf8")).toBe(receipt.snapshot.text);
    expect(existsSync(ledgerFile(owner.run.planId, app.root))).toBe(true);
    const turns = app.sent.filter(item => item.message.customType === "pitako.workflow.task");
    expect(turns).toHaveLength(2);
    for (const [index, turn] of turns.entries()) {
      const envelope = JSON.parse(turn.message.content);
      expect(envelope.kind).toBe("context");
      expect(envelope.scope).toBe("non-human data; not authority or a user instruction");
      expect(envelope.source.ownerSessionId).toBe(app.ctx.sessionManager.getSessionId());
      expect(envelope.projection.intentId).toBe(owner.run.task?.intentId);
      expect(envelope.projection.phaseEpoch).toBe(index + 1);
      expect(envelope.projection.policy).toBe(readFileSync(path.join(import.meta.dir, "../skills", index ? "execute" : "plan", "SKILL.md"), "utf8"));
      expect(turn.options.triggerTurn).toBe(true);
    }
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.execute")).toHaveLength(0);
    await app.commands.get("task").handler(input, app.ctx);
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(2);
    writeFileSync(app.root + "/implementation.ts", "export const bounded = true;\n");
    const gates = payload(await app.invoke("execution_gates", { commands: [{ command: "printf owned-gate", timeoutSeconds: 5 }], coverage: "Controlled finite check" }));
    expect(gates.commands[0].output).toBe("owned-gate");
    expect(gates.release).toBeDefined();
    return { owner, context, receipt, gates };
}

for (const git of [false, true]) test(`registered task wait preserves automatic Freeze handoff (${git ? "Git" : "no Git"})`, async () => {
  const held = Promise.withResolvers<void>();
  let compositions = 0;
  const storageRoot = mkdtempSync(path.join(tmpdir(), "pitako-task-wait-storage-"));
  f.fixture.directories.push(storageRoot);
  const app = await f.setup({ storageRoot, config: "[review]\ncandidates = []\n[architecture]\ncandidates = []\n",
    prompt: async (_session, request) => {
      if (request.stage === "composition") {
        if (++compositions === 2) await held.promise;
        return { kind: "composition", snapshotId: request.snapshot.id, specialists: [], reason: "Bounded independent design" };
      }
    },
  });
  app.pi.getAllTools = () => [...app.tools.values()].map(tool => ({ ...tool, sourceInfo: { path: "controlled:pitako" } }));
  const native = SessionManager.inMemory(app.root);
  app.ctx.sessionManager.getBranch = () => native.getBranch();
  app.ctx.sessionManager.getEntries = () => native.getEntries();
  app.pi.sendMessage = (message: any, options: any) => {
    app.sent.push({ message, options });
    if (!options.triggerTurn) native.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  };
  let second: ReturnType<typeof handle> | undefined;
  try {
    if (git) execFileSync("git", ["init", "-q"], { cwd: app.root });
    await app.commands.get("task").handler("example", app.ctx);
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing task");
    const owner = checkAuthority(context.authority), original = payload(await app.invoke("task_status", {}));
    const draft = payload(await app.invoke("planning_write", { revision: "absent", fileHash: null,
      body: "# Goal\nBounded local behavior, no publication.\n", execution: "expected" })).snapshot;
    const design = handle(await app.invoke("architecture_start", { goal: "Review complete current bounded design" }));
    await app.bookkeeping(design.instanceId);
    const offer = await app.emit("agent_before_settle", { outcome: "completed" });
    for (const entry of offer?.entries ?? [])
      native.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    await app.emit("turn_start");
    second = handle(await app.invoke("architecture_start", { goal: "Independent second design on the same object" }));
    const inspection = payload(await app.invoke("execution_disposition", { op: "inspect" }));
    const obligation = inspection.obligations.find((item: any) => item.dispatchId === design.dispatchId);
    expect(obligation.state).toBe("disposition-required");
    expect(obligation.boundary).toBe("turn_start");
    expect(native.getBranch().some(entry => entry.id === obligation.receipt.entryId)).toBe(true);
    const slot = owner.slotProducer!;
    expect(slot.live).toBe(true);
    expect(slot.snapshot()).toMatchObject({ adapter: "planning-slot", entered: true, sealed: false });
    expect(inspection.waitProducers.some((item: any) => item.adapter === "planning-slot")).toBe(false);
    let selfReady = false;
    expect(waitForProducer(context.authority, slot.ref, slot.cursor, () => { selfReady = true; }))
      .toEqual({ kind: "deferred", reason: "host-return-dependent" });
    const selfClaim = { op: "record", obligationId: obligation.obligationId, expectedVersion: obligation.version,
      reason: "The captured planning slot cannot complete independently of this workflow",
      choice: { kind: "wait", producerRef: slot.ref, afterSequence: slot.cursor } };
    const selfAdmission = await app.emit("tool_call", {
      toolName: "execution_disposition", toolCallId: "task-self-wait", input: selfClaim,
    });
    expect(selfAdmission?.block).not.toBe(true); // The read tool admits the claim; producer accreditation rejects it.
    await expect(app.invoke("execution_disposition", selfClaim)).rejects.toThrow("host-return-dependent");
    const rejected = payload(await app.invoke("execution_disposition", { op: "inspect" }));
    expect(rejected.obligations).toEqual(inspection.obligations);
    expect(rejected.dispositions).toEqual(inspection.dispositions);
    expect(payload(await app.invoke("task_status", {}))).toEqual(original);
    const producer = inspection.waitProducers.find((item: any) => item.adapter === "background-attempt");
    expect(producer).toBeDefined();
    const claim = { op: "record", obligationId: obligation.obligationId, expectedVersion: obligation.version,
      reason: "Wait for the independent second live design",
      choice: { kind: "wait", producerRef: producer.producerRef, afterSequence: producer.afterSequence } };
    const admission = await app.emit("tool_call", { toolName: "execution_disposition", toolCallId: "task-wait", input: claim });
    expect(admission?.block).not.toBe(true);
    await app.invoke("execution_disposition", claim);
    const waiting = payload(await app.invoke("task_status", {}));
    expect(waiting.state).toBe("waiting");
    expect(waiting.version).toBe(original.version + 1);
    await expect(app.invoke("execution_disposition", claim)).rejects.toThrow("exact effective receipt/boundary and version");
    held.resolve();
    await app.bookkeeping(second.instanceId);
    const settled = payload(await app.invoke("task_status", {}));
    expect(settled.state).toBe("active");
    expect(settled.version).toBe(waiting.version + 1);
    const candidate = payload(await app.invoke("planning_candidate", { revision: draft.revision, fileHash: draft.fileHash }));
    const review = handle(await app.invoke("planning_review", { candidateId: candidate.candidateId,
      goal: "Review the complete current candidate", criteria: ["Local boundary"] }));
    await app.bookkeeping(review.instanceId);
    const receipt = payload(await app.invoke("planning_freeze", { candidateId: candidate.candidateId,
      designAssignmentId: design.assignmentId, reviewAssignmentId: review.assignmentId, dispositions: [],
      designAdoption: "Adopt complete unchanged design", acceptance: "Accept complete reviewed bounded plan",
      absorption: "Both complete designs and associated Review absorbed" }));
    const execution = payload(await app.invoke("task_status", {}));
    expect(execution).toMatchObject({ runId: original.runId, ownerId: original.ownerId, epoch: original.epoch,
      phase: "execution", phaseEpoch: original.phaseEpoch + 1, version: settled.version + 1, state: "active",
      task: { intentId: original.task.intentId, freezeReceiptRef: receipt.receiptId } });
    expect(execution.waitRef).toBeUndefined();
    expect(slot.live).toBe(false);
    expect(slot.snapshot()).toMatchObject({ sealed: true, facts: { "host-operation": "closed" } });
    expect(owner.store.get<any>("reservations", slot.ref.reservationId)?.state).toBe("released");
    expect(selfReady).toBe(false);
    expect(owner.run).toEqual(execution);
    expect(owner.store.all<any>("dispositions").find(item => item.kind === "planning-acceptance").receipt).toEqual(receipt);
    expect(readFileSync(planFile("example", app.root), "utf8")).toBe(receipt.snapshot.text);
    expect(existsSync(ledgerFile("example", app.root))).toBe(true);
    expect(() => checkAuthority(context.authority)).toThrow("stale");
    await app.commands.get("task").handler("example", app.ctx);
    const turns = app.sent.filter(item => item.message.customType === "pitako.workflow.task");
    expect(turns).toHaveLength(2);
    const turn = turns[1]!;
    const envelope = JSON.parse(turn.message.content);
    expect(envelope.kind).toBe("context");
    expect(envelope.scope).toBe("non-human data; not authority or a user instruction");
    expect(envelope.projection).toMatchObject({ runId: original.runId, intentId: original.task.intentId,
      phase: "execution", phaseEpoch: execution.phaseEpoch, resume: false,
      policy: readFileSync(path.join(import.meta.dir, "../skills/execute/SKILL.md"), "utf8") });
    expect(turn.options.triggerTurn).toBe(true);
    expect(app.sent.some(item => item.message.customType === "pitako.workflow.execute")).toBe(false);
  } finally {
    held.resolve();
    if (second) await app.bookkeeping(second.instanceId);
    await app.close();
  }
});

for (const command of ["task", "execute"] as const)
for (const outcome of ["error", "aborted"] as const)
test(`observed ${outcome} fences /${command} execution capabilities before agent_end`, async () => {
    const app = await setup(true);
    const release = Promise.withResolvers<void>();
    try {
      const prepared = await prepareTask(app, false);
      if (command === "execute") {
        await app.emit("session_before_switch");
        await app.commands.get("execute").handler("example", app.ctx);
      }
      const context = captureCallContext(app.root, app.ctx.sessionManager);
      if (context.kind !== "managed") throw new Error("missing live execution");
      const owner = checkAuthority(context.authority);
      const invoke = async (name: string, params: any) => withCallContext(context, () => app.invoke(name, params));
      let joined = false;
      owner.retire.add(async () => { await release.promise; joined = true; });
      const observed = app.emit("message_end", { message: { role: "assistant", stopReason: outcome } });
      const denied = expect(invoke("execution_gates", {
        commands: [{ command: "touch forbidden-effect", timeoutSeconds: 5 }], coverage: "Must not start",
      })).rejects.toThrow("retired");
      expect(() => checkAuthority(context.authority)).toThrow("retired");
      await observed;
      await denied;
      await expect(invoke("execution_review",
        { goal: "Must not start", criteria: ["No retired effects"] })).rejects.toThrow("retired");
      if (command === "task") await expect(invoke("task_finish", {
        expectedVersion: owner.run.version, freezeReceiptRef: prepared.receipt.receiptId, executionAcceptanceRef: "forged",
      })).rejects.toThrow();
      expect(existsSync(app.root + "/forbidden-effect")).toBe(false);
      expect(joined).toBe(false);
      expect(owner.run.state).not.toBe("interrupted");
      release.resolve();
      await app.emit("session_before_switch");
      expect(joined).toBe(true);
      if (command === "task") {
        app.ctx.hasUI = true;
        const turns = app.sent.length;
        await app.commands.get("task").handler("", app.ctx);
        expect(app.sent).toHaveLength(turns);
        expect(() => checkAuthority(context.authority)).toThrow("retired");
      }
    } finally { release.resolve(); await app.close(); }
});

async function startTaskReview(app: App, { owner, gates }: Awaited<ReturnType<typeof prepareTask>>) {
    // Test-only policy routing at the controlled model boundary, not a Markdown executor or authority source.
    // Follow the delivered final-review instruction rather than choosing the known-good port independently.
    const turn = app.sent.filter(item => item.message.customType === "pitako.workflow.task").at(-1)!;
    const policy = JSON.parse(turn.message.content).projection.policy as string;
    const start = policy.match(/Use `(execution_review|review_start)` for the existing independent Reviewer pass/)?.[1];
    expect(start).toBeDefined();
    const params = { goal: "Review the entire execution against its frozen plan", criteria: ["No publication, bounded implementation"] };
    const review = handle(await app.invoke(start!, start === "review_start"
      ? { ...params, object: { kind: "diff", base: "HEAD" }, plan: owner.run.planId, unit: "final-review" }
      : params));
    const acceptance = {
      expectedVersion: owner.run.version, reviewAssignmentId: review.assignmentId, evidenceRefs: [gates.evidenceId],
      dispositions: [], acceptance: "Accept complete pertinent independent review with actual passing gates",
      absorption: "All successful released execution results incorporated",
    };
    await expect(app.invoke("execution_acceptance", acceptance)).rejects.toThrow();
    return { acceptance, review };
}
async function completeTask(app: App, { owner, context, receipt }: Awaited<ReturnType<typeof prepareTask>>,
    { acceptance, review }: Awaited<ReturnType<typeof startTaskReview>>, git = false) {
    await app.bookkeeping(review.instanceId);
    const report = await app.read("team_result", { assignmentId: review.assignmentId });
    expect(report.judgment.completion).toBe("complete");
    expect(report.host.closure.state).toBe("released");
    writeFileSync(app.root + "/implementation.ts", "export const changedAfterReview = true;\n");
    await expect(app.invoke("execution_acceptance", acceptance)).rejects.toThrow("execution Review is foreign or stale");
    writeFileSync(app.root + "/implementation.ts", "export const bounded = true;\n");
    const accepted = payload(await app.invoke("execution_acceptance", acceptance));
    const finish = { expectedVersion: owner.run.version, freezeReceiptRef: receipt.receiptId, executionAcceptanceRef: accepted.acceptanceId };
      await expect(app.invoke("task_finish", { ...finish, expectedVersion: finish.expectedVersion - 1 })).rejects.toThrow("stale");
      writeFileSync(app.root + "/implementation.ts", "export const changedAfterAcceptance = true;\n");
      await expect(app.invoke("task_finish", finish)).rejects.toThrow("applicable");
      writeFileSync(app.root + "/implementation.ts", "export const bounded = true;\n");
      const held = reserveEffect(context, { reservationId: randomUUID(), kind: "writer", paths: [app.root] }).register("controlled-held-work", ["host-operation"]);
      held.enter(); held.observe("host-operation", "unknown", true);
      await expect(app.invoke("task_finish", finish)).rejects.toThrow("barriers");
      expect(held.observe("host-operation", "closed", true)).toBeDefined();
    const finished = payload(await app.invoke("task_finish", finish));
    expect(finished.kind).toBe("task-completion");
    expect(owner.run.state).toBe("completed");
    expect(owner.active).toBe(false);
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(2);
    expect(app.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    if (git) expect(readdirSync(app.root + "/.git/refs/heads")).toEqual([]);
}

for (const git of [false, true]) describe(`/task full contract (${git ? "Git" : "no Git with plan correction"})`, () => {
  let app: App, prepared: Awaited<ReturnType<typeof prepareTask>>, owned: Promise<void>, completion: Promise<void> | undefined;
  let ready: ReturnType<typeof Promise.withResolvers<void>>, finish: ReturnType<typeof Promise.withResolvers<void>>;
  beforeEach(async () => {
    ready = Promise.withResolvers<void>(); finish = Promise.withResolvers<void>(); completion = undefined;
    owned = f.fixture.ownedCase(`${git ? "Git" : "no Git"} task fixture and completion`, async () => {
      app = await setup(!git);
      try {
        prepared = await prepareTask(app, git, git ? "example" : "");
        ready.resolve();
        await finish.promise;
      } finally { await app.close(); }
    })();
    void owned.catch(ready.reject);
    await ready.promise;
  });
  afterEach(async () => {
    // Keep fixture ownership through the real callback, even if the runner requests teardown.
    try { await completion; }
    finally { finish.resolve(); await owned; }
  });
  describe("managed Review admitted", () => {
    let review: Awaited<ReturnType<typeof startTaskReview>>;
    beforeEach(async () => {
      completion = startTaskReview(app, prepared).then(result => { review = result; });
      await completion;
    });
    bunTest("delivered policy and registered Review producer complete handler/FreezeReceipt/gates/acceptance/finish without publication", async () => {
      completion = (async () => {
        await completeTask(app, prepared, review, git);
        const previous = prepared.owner.run;
        app.ctx.hasUI = true;
        await app.commands.get("task").handler(previous.planId, app.ctx);
        expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(2);
        const conversation = SessionManager.inMemory(app.root);
        conversation.appendMessage({ role: "user", content: "Now repair the next bounded behavior.", timestamp: Date.now() });
        app.ctx.sessionManager.getBranch = () => conversation.getBranch();
        await app.commands.get("task").handler(" \t ", app.ctx);
        const fresh = captureCallContext(app.root, app.ctx.sessionManager);
        if (fresh.kind !== "managed") throw new Error("missing fresh contextual task after completion");
        const next = checkAuthority(fresh.authority).run;
        expect(next.planId).toMatch(/^task-[a-z0-9_-]+$/);
        expect(next.planId).not.toBe(previous.planId);
        expect(next.runId).not.toBe(previous.runId);
        expect(next.task!.intentId).not.toBe(previous.task!.intentId);
        expect(next.phase).toBe("planning");
        expect(next.task!.freezeReceiptRef).toBeUndefined();
        expect(existsSync(planFile(next.planId, app.root))).toBe(false);
        expect(existsSync(ledgerFile(next.planId, app.root))).toBe(false);
        expect(prepared.owner.run.state).toBe("completed");
        expect(() => checkAuthority(prepared.context.authority)).toThrow("retired");
        const turns = app.sent.filter(item => item.message.customType === "pitako.workflow.task");
        expect(turns).toHaveLength(3);
        const delivered = JSON.parse(turns[2]!.message.content).projection;
        expect(delivered).toMatchObject({ runId: next.runId, intentId: next.task!.intentId, phase: "planning", resume: false });
        expect(delivered.instruction).toContain("current conversation");
      })();
      await completion;
    });
  });
  bunTest("a completed released public Review cannot replace the managed execution association", async () => {
    completion = (async () => {
      const review = handle(await app.invoke("review_start", {
        goal: "Bounded consultation", criteria: ["Local-only implementation"],
        object: { kind: "brief", text: "Consultation on the implementation, not managed final Review" },
        plan: prepared.owner.run.planId, unit: "consultation",
      }));
      await app.bookkeeping(review.instanceId);
      const report = await app.read("team_result", { assignmentId: review.assignmentId });
      expect(report.judgment.completion).toBe("complete");
      expect(report.host.closure.state).toBe("released");
      await expect(app.invoke("execution_acceptance", {
        expectedVersion: prepared.owner.run.version, reviewAssignmentId: review.assignmentId,
        evidenceRefs: [prepared.gates.evidenceId], dispositions: [],
        acceptance: "A complete table alone is insufficient", absorption: "Released consultation",
      })).rejects.toThrow("execution Review is foreign or stale");
    })();
    await completion;
  });
});

test("task captures pending intent before idle, duplicate is idempotent, invalid input preserves it and Stop revokes before await", async () => {
  const app = await setup(), idle = Promise.withResolvers<void>();
  try {
    app.ctx.hasUI = true;
    app.ctx.waitForIdle = () => idle.promise;
    const first = app.commands.get("task").handler("pending", app.ctx);
    await app.commands.get("task").handler("pending", app.ctx);
    await app.commands.get("task").handler("../invalid", app.ctx);
    await app.emit("input", { text: "/stop" });
    idle.resolve(); await first;
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(0);
    app.ctx.waitForIdle = async () => {};
    await app.commands.get("task").handler("pending", app.ctx);
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    expect(context.kind).toBe("managed");
    await app.commands.get("task").handler("../invalid", app.ctx);
    if (context.kind !== "managed") throw new Error("missing task");
    expect(checkAuthority(context.authority).run.phase).toBe("planning");
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(1);
  } finally { idle.resolve(); await app.close(); }
});

test("contextual task preserves pending/active intent and requires explicit resume after Stop", async () => {
  const app = await setup(), idle = Promise.withResolvers<void>();
  try {
    app.ctx.hasUI = true; app.ctx.waitForIdle = () => idle.promise;
    const starting = app.commands.get("task").handler("", app.ctx);
    await app.commands.get("task").handler(" \t ", app.ctx);
    await app.commands.get("task").handler("bad args", app.ctx);
    idle.resolve(); await starting;
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing contextual task");
    const owner = checkAuthority(context.authority), intent = owner.run.task!.intentId;
    expect(owner.run.planId).toMatch(/^task-[a-z0-9_-]+$/);
    const sent = app.sent.filter(item => item.message.customType === "pitako.workflow.task");
    expect(sent).toHaveLength(1);
    await app.commands.get("task").handler("", app.ctx);
    expect(owner.run.task!.intentId).toBe(intent);
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(1);
    await app.emit("input", { text: "/stop" });
    app.ctx.waitForIdle = async () => {};
    await app.commands.get("task").handler("", app.ctx);
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(1);
    expect(() => checkAuthority(context.authority)).toThrow(/retired/);
    await app.commands.get("task").handler(owner.run.planId, app.ctx);
    const resumed = captureCallContext(app.root, app.ctx.sessionManager);
    if (resumed.kind !== "managed") throw new Error("missing explicit resume");
    expect(checkAuthority(resumed.authority).run.task!.intentId).toBe(intent);
  } finally { idle.resolve(); await app.close(); }
});

test("contextual task cannot retire a different active plan", async () => {
  const app = await setup();
  try {
    app.ctx.hasUI = true;
    await app.commands.get("plan").handler("independent", app.ctx);
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing plan");
    await app.commands.get("task").handler(" \t ", app.ctx);
    expect(checkAuthority(context.authority).run.activity).toBe("plan");
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(0);
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.plan")).toHaveLength(1);
  } finally { await app.close(); }
});

test("Abort observed while waiting revokes pending task synchronously; identity changes cannot acquire owner", async () => {
  const app = await setup(), idle = Promise.withResolvers<void>(), controller = new AbortController();
  try {
    app.ctx.hasUI = true; app.ctx.signal = controller.signal;
    app.ctx.waitForIdle = () => idle.promise;
    const pending = app.commands.get("task").handler("aborted", app.ctx);
    controller.abort();
    idle.resolve(); await pending;
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(0);
    app.ctx.signal = undefined;
    const later = Promise.withResolvers<void>();
    app.ctx.waitForIdle = () => later.promise;
    const changed = app.commands.get("task").handler("changed", app.ctx);
    await Promise.resolve();
    const manager = app.ctx.sessionManager;
    app.ctx.sessionManager = { ...manager };
    later.resolve(); await changed;
    app.ctx.sessionManager = manager;
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(0);
  } finally { idle.resolve(); await app.close(); }
});

test("task resumes registered execution phase without replanning/unpinning; Stop rejects old authority and receipt-only finish", async () => {
  const app = await setup();
  try {
    await app.commands.get("task").handler("resume", app.ctx);
    await freeze(app);
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing task");
    const previous = checkAuthority(context.authority).run, frozen = readFileSync(planFile("resume", app.root), "utf8");
    await app.emit("input", { text: "/stop" });
    expect(() => checkAuthority(context.authority)).toThrow("retired");
    await app.commands.get("task").handler("resume", app.ctx);
    const current = captureCallContext(app.root, app.ctx.sessionManager);
    if (current.kind !== "managed") throw new Error("missing resumed task");
    const resumed = checkAuthority(current.authority).run;
    expect(resumed.runId).toBe(previous.runId);
    expect(resumed.task?.intentId).toBe(previous.task?.intentId);
    expect(resumed.phaseEpoch).toBe(previous.phaseEpoch);
    expect(resumed.epoch).toBe(previous.epoch + 1);
    expect(resumed.phase).toBe("execution");
    const resumedPolicy = JSON.parse(app.sent.filter(item => item.message.customType === "pitako.workflow.task").at(-1)!.message.content).projection.policy;
    expect(resumedPolicy).toContain("Use `execution_review` for the existing independent Reviewer pass");
    expect(resumedPolicy).toContain("For standalone `$execute` and bounded consultations, use the public route");
    expect(readFileSync(planFile("resume", app.root), "utf8")).toBe(frozen);
    expect(() => finishTask({ intentId: resumed.task!.intentId, epoch: resumed.epoch }, {
      expectedVersion: resumed.version, freezeReceiptRef: resumed.task!.freezeReceiptRef!, executionAcceptanceRef: "forged",
    })).toThrow("stale");
    expect(() => checkTaskAuthority({ intentId: resumed.task!.intentId, epoch: resumed.epoch })).toThrow();
    const state = new WorkflowState(app.root);
    try {
      expect(state.all<any>("dispositions").filter(r => r.kind === "planning-acceptance")).toHaveLength(1);
      expect(state.all<any>("dispositions").some(r => r.kind === "task-completion")).toBe(false);
    } finally { state.close(); }
  } finally { await app.close(); }
});

test("frozen status without a registered task receipt cannot retire a live draft activity", async () => {
  const app = await setup();
  try {
    app.ctx.hasUI = true;
    await app.commands.get("plan").handler("draft", app.ctx);
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing draft");
    await app.invoke("planning_write", { revision: "absent", fileHash: null, body: "# Goal\nStandalone draft\n" });
    const file = planFile("draft", app.root);
    writeFileSync(planFile("unowned", app.root), readFileSync(file, "utf8").replace("id: draft", "id: unowned").replace("status: draft", "status: frozen"));
    await app.commands.get("task").handler("unowned", app.ctx);
    expect(checkAuthority(context.authority).run.planId).toBe("draft");
    expect(existsSync(ledgerFile("unowned", app.root))).toBe(false);
  } finally { await app.close(); }
});

test("uncertain initial task outbox cannot acquire a replacement owner or send another initial turn", async () => {
  const app = await setup(), send = app.pi.sendMessage;
  try {
    app.ctx.hasUI = true;
    let attempts = 0;
    app.pi.sendMessage = ((message: any, options: any) => {
      if (message.customType === "pitako.workflow.task") { attempts++; throw new Error("controlled commitment cut"); }
      return send(message, options);
    }) as typeof send;
    await app.commands.get("task").handler("uncertain", app.ctx);
    await app.commands.get("task").handler("uncertain", app.ctx);
    const first = captureCallContext(app.root, app.ctx.sessionManager);
    if (first.kind !== "managed") throw new Error("missing captured task");
    await app.emit("input", { text: "/stop" });
    app.pi.sendMessage = send;
    const turns = app.sent.length;
    await app.commands.get("task").handler("", app.ctx);
    expect(app.sent).toHaveLength(turns);
    await app.commands.get("task").handler("uncertain", app.ctx);
    expect(attempts).toBe(1);
    expect(captureCallContext(app.root, app.ctx.sessionManager).kind).toBe("managed-unavailable");
    const state = new WorkflowState(app.root);
    try {
      expect(state.all<any>("runs")).toHaveLength(1);
      expect(state.all<any>("obligations").find(item => item.kind === "phase-turn")?.cleared).toBe(false);
      expect(state.all<any>("reservations").every(item => item.state === "released")).toBe(true);
    } finally { state.close(); }
  } finally { app.pi.sendMessage = send; await app.close(); }
});

test("derived phase commits before its turn; uncertain delivery remains diagnostic across Stop without replay", async () => {
  const app = await setup(), send = app.pi.sendMessage;
  try {
    await app.commands.get("task").handler("example", app.ctx);
    const original = captureCallContext(app.root, app.ctx.sessionManager);
    if (original.kind !== "managed") throw new Error("missing task");
    app.pi.sendMessage = ((message: any, options: any) => {
      if (message.customType === "pitako.workflow.task") throw new Error("controlled derived turn cut");
      return send(message, options);
    }) as typeof send;
    await expect(freeze(app)).rejects.toThrow("controlled derived turn cut");
    expect(() => checkAuthority(original.authority)).toThrow("stale");
    const derived = captureCallContext(app.root, app.ctx.sessionManager);
    if (derived.kind !== "managed") throw new Error("missing committed derived phase");
    expect(checkAuthority(derived.authority).run.phaseEpoch).toBe(2);
    expect(checkAuthority(derived.authority).run.task?.freezeReceiptRef).toBeDefined();
    await app.emit("input", { text: "/stop" });
    app.pi.sendMessage = send; app.ctx.hasUI = true;
    await app.commands.get("task").handler("example", app.ctx);
    expect(captureCallContext(app.root, app.ctx.sessionManager).kind).toBe("managed-unavailable");
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(1);
    expect(existsSync(ledgerFile("example", app.root))).toBe(true);
  } finally { app.pi.sendMessage = send; await app.close(); }
});

test("failed finite gates release their producer but produce no acceptance credit; later valid gates still progress", async () => {
  const app = await setup();
  try {
    await app.commands.get("task").handler("example", app.ctx);
    await freeze(app);
    await expect(app.invoke("execution_gates", { commands: [{ command: "exit 7", timeoutSeconds: 5 }], coverage: "Controlled failure" })).rejects.toThrow("failed");
    const gates = payload(await app.invoke("execution_gates", { commands: [{ command: "printf next", timeoutSeconds: 5 }], coverage: "Independent valid selection" }));
    expect(gates.commands[0].output).toBe("next");
    const state = new WorkflowState(app.root);
    try {
      expect(state.all<any>("dispositions").filter(item => item.kind === "execution-evidence")).toHaveLength(1);
      expect(state.all<any>("dispositions").filter(item => item.kind === "execution-gates-diagnostic")[0]?.commands[0].exitCode).toBe(7);
      expect(state.all<any>("dispositions").some(item => item.kind === "execution-acceptance")).toBe(false);
      expect(state.all<any>("reservations").filter(item => item.kind === "gates").every(item => item.state === "released")).toBe(true);
    } finally { state.close(); }
  } finally { await app.close(); }
});

test("capacity acquired during idle rejects pending task without retiring independent work, then permits a fresh valid intent", async () => {
  const app = await setup(), idle = Promise.withResolvers<void>(), guard = new RootGuard(app.root);
  const held = guard.reserve({ reservationId: randomUUID(), kind: "assignment-writer", paths: [app.root] }).register("independent-admission", ["host-operation"]);
  try {
    held.enter();
    // Initial rejection is harmless; a second dispatch captures an actual pending wait.
    app.ctx.hasUI = true;
    await app.commands.get("task").handler("capacity", app.ctx);
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(0);
    held.observe("host-operation", "closed", true);
    app.ctx.waitForIdle = () => idle.promise;
    const pending = app.commands.get("task").handler("capacity", app.ctx);
    const later = guard.reserve({ reservationId: randomUUID(), kind: "assignment-writer", paths: [app.root] }).register("independent-later-admission", ["host-operation"]);
    later.enter();
    try {
      idle.resolve(); await pending;
      expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(0);
      expect(later.live).toBe(true);
    } finally { later.observe("host-operation", "closed", true); }
    app.ctx.waitForIdle = async () => {};
    await app.commands.get("task").handler("capacity", app.ctx);
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(1);
  } finally {
    idle.resolve();
    if (held.live) held.observe("host-operation", "closed", true);
    guard.close(); await app.close();
  }
});

for (const cut of ["receipt", "phase"] as const) test(`Abort at ${cut} commitment permits no ledger or turn until explicit resume`, async () => {
  const app = await setup(), controller = new AbortController();
  const state = new WorkflowState(app.root);
  let stopped = false;
  const unsubscribe = state.subscribe(() => {
    const committed = cut === "receipt"
      ? state.all<any>("dispositions").some(item => item.kind === "planning-acceptance" && item.receipt)
      : state.all<any>("runs").some(item => item.phase === "execution");
    if (!stopped && committed) {
      stopped = true; controller.abort();
    }
  });
  try {
    app.ctx.signal = controller.signal;
    await app.commands.get("task").handler("example", app.ctx);
    await expect(freeze(app)).rejects.toThrow();
    expect(stopped).toBe(true);
    expect(state.all<any>("runs")[0].phase).toBe(cut === "receipt" ? "planning" : "execution");
    expect(existsSync(ledgerFile("example", app.root))).toBe(false);
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(1);
    expect(captureCallContext(app.root, app.ctx.sessionManager).kind).toBe("managed-unavailable");
    app.ctx.signal = new AbortController().signal;
    await app.commands.get("task").handler("example", app.ctx);
    const resumed = captureCallContext(app.root, app.ctx.sessionManager);
    if (resumed.kind !== "managed") throw new Error("missing resumed committed receipt");
    expect(checkAuthority(resumed.authority).run.phase).toBe("execution");
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(2);
  } finally { unsubscribe(); state.close(); await app.close(); }
});
