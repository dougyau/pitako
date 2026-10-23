import { afterEach, beforeEach, describe, expect, spyOn, test as bunTest } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
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
      return { kind: "composition", specialists: [], reason: "Bounded independent design" };
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
function controlTaskFixtureDiscovery(root: string, git: boolean, marker: "TASK_WAIT_DISCOVERY" | "TASK_ERROR_DISCOVERY" | "TASK_FULL_DISCOVERY" | "TASK_STRATEGY_DISCOVERY", label = "") {
  expect(realpathSync(root)).toBe(root);
  if (git) {
    expect(realpathSync(path.join(root, ".git"))).toBe(path.join(root, ".git"));
    expect(statSync(path.join(root, ".git")).isDirectory()).toBe(true);
  } else expect(existsSync(path.join(root, ".git"))).toBe(false);
  const original = childProcess.execFileSync;
  const discoveryCalls = { state: { real: 0, replayed: 0 }, top: { real: 0, replayed: 0 } };
  const observed = new Map<"state" | "top", { ok: true; value: string } | { ok: false; error: unknown }>();
  const stateArgv = JSON.stringify(["rev-parse", "--is-inside-work-tree", "--is-bare-repository", "--path-format=absolute", "--git-common-dir"]);
  const topArgv = JSON.stringify(["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  const capture = spyOn(childProcess, "execFileSync").mockImplementation(new Proxy(original, {
    apply(target, thisArg, args) {
      const options = args[2];
      if (args[0] !== "git" || options?.cwd !== root || options.encoding !== "utf8" ||
          JSON.stringify(options.stdio) !== JSON.stringify(["ignore", "pipe", "pipe"]) ||
          options.env?.LC_ALL !== "C" || Object.keys(options.env).some(key => key.startsWith("GIT_")))
        return Reflect.apply(target, thisArg, args);
      const argv = JSON.stringify(args[1]);
      const kind = argv === stateArgv ? "state" : argv === topArgv ? "top" : undefined;
      if (!kind) return Reflect.apply(target, thisArg, args);
      const prior = observed.get(kind);
      if (prior) {
        discoveryCalls[kind].replayed++;
        if (prior.ok) return prior.value;
        throw prior.error;
      }
      discoveryCalls[kind].real++;
      try {
        const value = Reflect.apply(target, thisArg, args);
        if (typeof value !== "string") throw new Error("controlled Git discovery expected the real UTF-8 response");
        observed.set(kind, { ok: true, value });
        return value;
      } catch (error) {
        observed.set(kind, { ok: false, error });
        throw error;
      }
    },
  }));
  f.fixture.releaseDirectoriesAfterDisposal(() => {
    console.error(`${marker} ${label}${git ? "Git" : "no-Git"} ${JSON.stringify(discoveryCalls)}`);
    capture.mockRestore();
  }, []);
  return { discoveryCalls, observed };
}
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

async function prepareTask(app: App, git: boolean, input = "example", onFixtureReady?: () => void) {
    if (git) execFileSync("git", ["init", "-q"], { cwd: app.root });
    onFixtureReady?.();
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

for (const git of [false, true]) test(git ? "registered task Git-root Freeze preserves automatic /task handoff"
  : "registered task wait preserves automatic Freeze handoff (no Git)", async () => {
  const started = performance.now();
  const stage = (name: string) => console.error(`TASK_WAIT_STAGE ${git ? "Git" : "no-Git"} ${name} ${Math.round(performance.now() - started)}ms`);
  stage("begin");
  const storageRoot = mkdtempSync(path.join(tmpdir(), "pitako-task-wait-storage-"));
  f.fixture.directories.push(storageRoot);
  const app = await f.setup({ storageRoot, config: "[review]\ncandidates = []\n[architecture]\ncandidates = []\n",
    prompt: (_session, request) => request.stage === "composition"
      ? { kind: "composition", specialists: [], reason: "Bounded independent design" } : undefined,
  });
  stage("setup-complete");
  app.pi.getAllTools = () => [...app.tools.values()].map(tool => ({ ...tool, sourceInfo: { path: "controlled:pitako" } }));
  const native = SessionManager.inMemory(app.root);
  app.ctx.sessionManager.getBranch = () => native.getBranch();
  app.ctx.sessionManager.getEntries = () => native.getEntries();
  app.pi.sendMessage = (message: any, options: any) => {
    app.sent.push({ message, options });
    native.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  };
  let independent: ReturnType<typeof registerBackgroundAttempt> | undefined;
  try {
    if (git) execFileSync("git", ["init", "-q"], { cwd: app.root });
    stage("git-init-complete");
    const { discoveryCalls, observed } = controlTaskFixtureDiscovery(app.root, git, "TASK_WAIT_DISCOVERY");
    await app.commands.get("task").handler("example", app.ctx);
    stage("task-start-complete");
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing task");
    const owner = checkAuthority(context.authority), original = payload(await app.invoke("task_status", {}));
    const draft = payload(await app.invoke("planning_write", { revision: "absent", fileHash: null,
      body: "# Goal\nBounded local behavior, no publication.\n", execution: "expected" })).snapshot;
    stage("planning-write-complete");
    const design = handle(await app.invoke("architecture_start", { goal: "Review complete current bounded design" }));
    stage("architecture-start-complete");
    await app.bookkeeping(design.instanceId);
    stage("architecture-bookkeeping-complete");
    const slot = owner.slotProducer!;
    expect(slot.live).toBe(true);
    expect(slot.snapshot()).toMatchObject({ adapter: "planning-slot", entered: true, sealed: false });
    let selfReady = false;
    let settled = original;
    if (!git) {
      const offer = await app.emit("agent_before_settle", { outcome: "completed" });
      for (const entry of offer?.entries ?? [])
        native.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
      await app.emit("turn_start");
      stage("turn-start-complete");
      independent = registerBackgroundAttempt(context, { cwd: app.root, instanceId: "independent-attempt",
        dispatchId: randomUUID(), roleId: "developer" });
      independent.admit();
      stage("independent-admitted");
      const inspection = payload(await app.invoke("execution_disposition", { op: "inspect" }));
      const obligation = inspection.obligations.find((item: any) => item.dispatchId === design.dispatchId);
      expect(obligation.state).toBe("disposition-required");
      expect(obligation.boundary).toBe("turn_start");
      expect(native.getBranch().some(entry => entry.id === obligation.receipt.entryId)).toBe(true);
      expect(inspection.waitProducers.some((item: any) => item.adapter === "planning-slot")).toBe(false);
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
      const producer = inspection.waitProducers.find((item: any) =>
        item.producerRef.resourceId === independent!.producer.ref.resourceId);
      expect(producer).toBeDefined();
      const claim = { op: "record", obligationId: obligation.obligationId, expectedVersion: obligation.version,
        reason: "Wait for the independent live attempt",
        choice: { kind: "wait", producerRef: producer.producerRef, afterSequence: producer.afterSequence } };
      const admission = await app.emit("tool_call", { toolName: "execution_disposition", toolCallId: "task-wait", input: claim });
      expect(admission?.block).not.toBe(true);
      await app.invoke("execution_disposition", claim);
      stage("wait-recorded");
      const waiting = payload(await app.invoke("task_status", {}));
      expect(waiting.state).toBe("waiting");
      expect(waiting.version).toBe(original.version + 1);
      await expect(app.invoke("execution_disposition", claim)).rejects.toThrow("exact effective receipt/boundary and version");
      independent.producer.observe("preparation", "closed");
      independent.producer.observe("host-operation", "closed");
      expect(independent.producer.observe("callback", "closed", true)).toBeDefined();
      stage("independent-closed");
      settled = payload(await app.invoke("task_status", {}));
      expect(settled.state).toBe("active");
      expect(settled.version).toBe(waiting.version + 1);
    }
    const candidate = payload(await app.invoke("planning_candidate", { revision: draft.revision, fileHash: draft.fileHash }));
    stage("candidate-complete");
    const review = handle(await app.invoke("planning_review", { candidateId: candidate.candidateId,
      goal: "Review the complete current candidate", criteria: ["Local boundary"] }));
    stage("review-start-complete");
    await app.bookkeeping(review.instanceId);
    stage("review-bookkeeping-complete");
    const receipt = payload(await app.invoke("planning_freeze", { candidateId: candidate.candidateId,
      designAssignmentId: design.assignmentId, reviewAssignmentId: review.assignmentId, dispositions: [],
      designAdoption: "Adopt complete unchanged design", acceptance: "Accept complete reviewed bounded plan",
      absorption: git ? "The complete design and Review were absorbed" : "The complete design, closed independent attempt, and Review were absorbed" }));
    stage("freeze-complete");
    const execution = payload(await app.invoke("task_status", {}));
    expect(execution).toMatchObject({ runId: original.runId, ownerId: original.ownerId, epoch: original.epoch,
      phase: "execution", phaseEpoch: original.phaseEpoch + 1, version: settled.version + 1, state: "active",
      task: { intentId: original.task.intentId, freezeReceiptRef: receipt.receiptId } });
    expect(execution.waitRef).toBeUndefined();
    expect(slot.live).toBe(false);
    expect(slot.snapshot()).toMatchObject({ sealed: true, facts: { "host-operation": "closed" } });
    expect(owner.store.closureReceipt(slot.ref)).toBeDefined();
    expect(slot.snapshot().effectReservation).toBeUndefined();
    if (!git) expect(selfReady).toBe(false);
    expect(owner.run).toEqual(execution);
    expect(owner.store.all<any>("dispositions").find(item => item.kind === "planning-acceptance").receipt).toEqual(receipt);
    expect(readFileSync(planFile("example", app.root), "utf8")).toBe(receipt.snapshot.text);
    expect(existsSync(ledgerFile("example", app.root))).toBe(true);
    expect(() => checkAuthority(context.authority)).toThrow("stale");
    await app.commands.get("task").handler("example", app.ctx);
    stage("task-handoff-complete");
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
    expect(discoveryCalls.state.real).toBe(1);
    expect(discoveryCalls.state.replayed).toBeGreaterThan(1);
    if (git) {
      expect(discoveryCalls.top.real).toBe(1);
      expect(discoveryCalls.top.replayed).toBeGreaterThan(1);
      expect(observed.get("state")).toEqual({ ok: true, value: `true\nfalse\n${path.join(app.root, ".git")}\n` });
      expect(observed.get("top")).toEqual({ ok: true, value: `${app.root}\n` });
    } else {
      expect(discoveryCalls.top).toEqual({ real: 0, replayed: 0 });
      const state = observed.get("state");
      expect(state?.ok).toBe(false);
      if (state?.ok === false) expect(String((state.error as { stderr?: unknown }).stderr)).toContain("not a git repository");
    }
  } finally {
    stage("cleanup-begin");
    if (independent?.producer.live) {
      independent.producer.observe("preparation", "closed");
      independent.producer.observe("host-operation", "closed");
      independent.producer.observe("callback", "closed", true);
    }
    await app.close();
    stage("cleanup-complete");
  }
});

for (const command of ["task", "execute"] as const)
for (const outcome of ["error", "aborted"] as const)
test(`observed ${outcome} fences /${command} execution capabilities before agent_end`, async () => {
    const app = await setup(true);
    const started = performance.now();
    const stage = (name: string) => console.error(`TASK_ERROR_STAGE ${command}/${outcome} ${name} ${Math.round(performance.now() - started)}ms`);
    stage("setup-complete");
    const discovery = controlTaskFixtureDiscovery(app.root, false, "TASK_ERROR_DISCOVERY", `${command}/${outcome} `);
    const release = Promise.withResolvers<void>();
    try {
      const prepared = await prepareTask(app, false);
      stage("prepare-complete");
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
      stage("error-observed");
      const denied = expect(invoke("execution_gates", {
        commands: [{ command: "touch forbidden-effect", timeoutSeconds: 5 }], coverage: "Must not start",
      })).rejects.toThrow("retired");
      expect(() => checkAuthority(context.authority)).toThrow("retired");
      await observed;
      stage("observation-settled");
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
      stage("retirement-joined");
      expect(joined).toBe(true);
      if (command === "task") {
        app.ctx.hasUI = true;
        const turns = app.sent.length;
        await app.commands.get("task").handler("", app.ctx);
        expect(app.sent).toHaveLength(turns);
        expect(() => checkAuthority(context.authority)).toThrow("retired");
      }
    } finally { release.resolve(); await app.close(); stage("cleanup-complete"); }
    expect(discovery.discoveryCalls.state.real).toBe(1);
    expect(discovery.discoveryCalls.state.replayed).toBeGreaterThan(1);
    expect(discovery.discoveryCalls.top).toEqual({ real: 0, replayed: 0 });
    const state = discovery.observed.get("state");
    expect(state?.ok).toBe(false);
    if (state?.ok === false) expect(String((state.error as { stderr?: unknown }).stderr)).toContain("not a git repository");
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
  let discovery: ReturnType<typeof controlTaskFixtureDiscovery> | undefined;
  let ready: ReturnType<typeof Promise.withResolvers<void>>, finish: ReturnType<typeof Promise.withResolvers<void>>;
  let started: number;
  const stage = (name: string) => console.error(`TASK_FULL_STAGE ${git ? "Git" : "no-Git"} ${name} ${Math.round(performance.now() - started)}ms`);
  beforeEach(async () => {
    started = performance.now(); stage("begin");
    ready = Promise.withResolvers<void>(); finish = Promise.withResolvers<void>(); completion = undefined; discovery = undefined;
    owned = f.fixture.ownedCase(`${git ? "Git" : "no Git"} task fixture and completion`, async () => {
      app = await setup(!git);
      stage("setup-complete");
      try {
        prepared = await prepareTask(app, git, git ? "example" : "", () => {
          stage("git-initialized");
          discovery = controlTaskFixtureDiscovery(app.root, git, "TASK_FULL_DISCOVERY");
        });
        stage("prepare-complete");
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
    finally { finish.resolve(); await owned; stage("owned-settled"); }
    if (discovery) {
      expect(discovery.discoveryCalls.state.real).toBe(1);
      expect(discovery.discoveryCalls.state.replayed).toBeGreaterThan(1);
      if (git) {
        expect(discovery.discoveryCalls.top.real).toBe(1);
        expect(discovery.discoveryCalls.top.replayed).toBeGreaterThan(1);
        expect(discovery.observed.get("state")).toEqual({ ok: true, value: `true\nfalse\n${path.join(app.root, ".git")}\n` });
        expect(discovery.observed.get("top")).toEqual({ ok: true, value: `${app.root}\n` });
      } else {
        expect(discovery.discoveryCalls.top).toEqual({ real: 0, replayed: 0 });
        const state = discovery.observed.get("state");
        expect(state?.ok).toBe(false);
        if (state?.ok === false) expect(String((state.error as { stderr?: unknown }).stderr)).toContain("not a git repository");
      }
    }
  });
  describe("managed Review admitted", () => {
    let review: Awaited<ReturnType<typeof startTaskReview>>;
    beforeEach(async () => {
      stage("review-start");
      completion = startTaskReview(app, prepared).then(result => { review = result; });
      await completion;
      stage("review-admitted");
    });
    bunTest("delivered policy and registered Review producer complete handler/FreezeReceipt/gates/acceptance/finish without publication", async () => {
      completion = (async () => {
        stage("completion-start");
        await completeTask(app, prepared, review, git);
        stage("finish-complete");
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
        stage("new-intent-complete");
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
      const original = state.all<any>("obligations").find(item => item.kind === "phase-turn");
      expect(original?.cleared).toBe(false);
      expect(original?.state).toBe("invocation-started");
      expect(state.all<any>("reservations").every(item => item.state === "released")).toBe(true);
      const query = payload(await app.invoke("workflow_status", { runId: original.runId }));
      expect(query.delivery).toEqual([{ key: original.key, state: "invocation-started" }]);
      expect(query.limits).toHaveLength(1);
      await app.commands.get("task").handler("independent", app.ctx);
      expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(1);
      app.branch.push({ type: "custom_message", id: "exact-late-receipt", ...original.message });
      await app.commands.get("task").handler("uncertain", app.ctx);
      expect(attempts).toBe(1);
      expect(state.get<any>("obligations", original.key)).toMatchObject({ state: "observed", cleared: true });
      expect(state.outbox().some(item => (item.body as any).key === original.key)).toBe(true);
      expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")
        .filter(item => item.message.details.deliveryId === original.key)).toHaveLength(0);
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

for (const status of ["failed", "cancelled"] as const) test(`${status} closed strategy remains visible while a later result completes /task`, async () => {
  const started = performance.now();
  const stage = (name: string) => console.error(`TASK_STRATEGY_STAGE ${status} ${name} ${Math.round(performance.now() - started)}ms`);
  stage("begin");
  const app = await setup();
  stage("setup-complete");
  // This fresh no-Git root never changes Git metadata; only implementation files change.
  // Preserve one real external discovery and the normal producer/Review/acceptance path.
  const discovery = controlTaskFixtureDiscovery(app.root, false, "TASK_STRATEGY_DISCOVERY", `${status} `);
  f.fixture.releaseDirectoriesAfterDisposal(() => {
    expect(existsSync(path.join(app.root, ".git"))).toBe(false);
    expect(discovery.discoveryCalls.state.real).toBe(1);
    expect(discovery.discoveryCalls.state.replayed).toBeGreaterThan(1);
    expect(discovery.discoveryCalls.top).toEqual({ real: 0, replayed: 0 });
    const state = discovery.observed.get("state");
    expect(state?.ok).toBe(false);
    if (state?.ok === false) expect(String((state.error as { stderr?: unknown }).stderr)).toContain("not a git repository");
  }, []);
  try {
    await app.commands.get("task").handler(`strategy-${status}`, app.ctx);
    stage("task-start-complete");
    const receipt = await freeze(app);
    stage("freeze-complete");
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing execution owner");
    const owner = checkAuthority(context.authority);
    writeFileSync(app.root + "/implementation.ts", "export const bounded = true;\n");
    const record = async (dispatchId: string, outcome: "failed" | "cancelled" | "completed") => {
      const attempt = registerBackgroundAttempt(context, { cwd: app.root, instanceId: dispatchId,
        dispatchId, roleId: "developer" });
      attempt.admit();
      attempt.result({ status: outcome, result: `${outcome} strategy outcome` });
      const message = { customType: "pitako.worker.result", content: dispatchId, details: { deliveryId: dispatchId } };
      const source = captureResultSource(attempt, dispatchId, message, { owns: () => true, getBranch: () => app.branch });
      app.branch.push({ type: "custom_message", id: dispatchId, ...message });
      source.observe("turn_start");
      attempt.producer.observe("preparation", "closed");
      attempt.producer.observe("host-operation", "closed");
      expect(attempt.producer.observe("callback", "closed", true)).toBeDefined();
      const obligation = payload(await app.invoke("execution_disposition", { op: "inspect" })).obligations
        .find((item: any) => item.dispatchId === dispatchId);
      expect(obligation.state).toBe("disposition-required");
      return obligation;
    };
    const historical = await record(`historical-${status}`, status);
    stage("historical-closed");
    const claim = (obligation: any) => ({ op: "record", obligationId: obligation.obligationId,
      expectedVersion: obligation.version, reason: "Assess this exact closed result",
      choice: { kind: "accept", resultRefs: [obligation.obligationId], evidenceRefs: [obligation.obligationId],
        reviewClaim: "Current result has independent proof" } });
    await expect(app.invoke("execution_disposition", claim(historical))).rejects.toThrow("completed outcomes");
    await app.invoke("execution_disposition", { ...claim(historical), choice: { kind: "continue", admissionId: owner.run.runId } });
    stage("historical-continued");
    const current = await record(`current-${status}`, "completed");
    await app.invoke("execution_disposition", claim(current));
    stage("current-accepted");
    const gates = payload(await app.invoke("execution_gates", { commands: [{ command: "printf current-proof", timeoutSeconds: 5 }],
      coverage: "Current bounded result" }));
    stage("gates-complete");
    const review = handle(await app.invoke("execution_review", { goal: "Review current bounded execution", criteria: ["Current result and history"] }));
    await app.bookkeeping(review.instanceId);
    stage("review-closed");
    const input = { expectedVersion: owner.run.version, reviewAssignmentId: review.assignmentId,
      evidenceRefs: [gates.evidenceId], acceptance: "Accept the current released reviewed result",
      absorption: `Retain ${status} history after physical closure; absorb current successful work`, dispositions: [] };
    await expect(app.invoke("execution_acceptance", { ...input, expectedVersion: input.expectedVersion - 1 })).rejects.toThrow("stale");
    await expect(app.invoke("execution_acceptance", { ...input, evidenceRefs: ["foreign"] })).rejects.toThrow("evidence");
    const accepted = payload(await app.invoke("execution_acceptance", input));
    stage("acceptance-complete");
    const before = payload(await app.invoke("workflow_status", { runId: owner.run.runId }));
    expect(before.attempts.find((item: any) => item.dispatchId === `historical-${status}`))
      .toMatchObject({ outcome: { status }, closure: "closed" });
    expect(before.attempts.find((item: any) => item.dispatchId === `current-${status}`))
      .toMatchObject({ outcome: { status: "completed" }, closure: "closed" });
    expect(before.lastResult.closure).toBe("closed");
    expect(before.cold).toBe(true);
    let finalAcceptance = accepted;
    if (status === "failed") {
      const later = registerBackgroundAttempt(context, { cwd: app.root, instanceId: "later-contributor",
        dispatchId: "later-contributor", roleId: "developer" });
      later.admit(); later.result({ status: "completed", result: "Later contributor" });
      later.producer.observe("preparation", "closed"); later.producer.observe("host-operation", "closed");
      later.producer.observe("callback", "closed", true);
      stage("later-contributor-closed");
      await expect(app.invoke("task_finish", { expectedVersion: owner.run.version, freezeReceiptRef: receipt.receiptId,
        executionAcceptanceRef: accepted.acceptanceId })).rejects.toThrow("frontier");
      const refreshedGates = payload(await app.invoke("execution_gates", { commands: [{ command: "printf refreshed", timeoutSeconds: 5 }],
        coverage: "Later contributor" }));
      stage("refreshed-gates-complete");
      const refreshedReview = handle(await app.invoke("execution_review", { goal: "Review after later contributor", criteria: ["Current result"] }));
      await app.bookkeeping(refreshedReview.instanceId);
      stage("refreshed-review-closed");
      finalAcceptance = payload(await app.invoke("execution_acceptance", { ...input, expectedVersion: owner.run.version,
        reviewAssignmentId: refreshedReview.assignmentId, evidenceRefs: [refreshedGates.evidenceId] }));
      stage("refreshed-acceptance-complete");
    }
    await app.invoke("task_finish", { expectedVersion: owner.run.version, freezeReceiptRef: receipt.receiptId,
      executionAcceptanceRef: finalAcceptance.acceptanceId });
    stage("finish-complete");
    const final = payload(await app.invoke("workflow_status", { runId: owner.run.runId }));
    expect(final.state).toBe("completed");
    expect(final.attempts.find((item: any) => item.dispatchId === `historical-${status}`).outcome.status).toBe(status);
    expect(final.restrictions).toEqual([]);
  } finally { stage("cleanup-begin"); await app.close(); stage("cleanup-complete"); }
});

test("a closed failed implementation needs current gates and Review, not an invented successful worker", async () => {
  const app = await setup();
  try {
    await app.commands.get("task").handler("partial-source", app.ctx);
    const freezeReceipt = await freeze(app);
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing execution owner");
    const owner = checkAuthority(context.authority);
    writeFileSync(path.join(app.root, "implementation.ts"), "export const bounded = true;\n");
    const attempt = registerBackgroundAttempt(context, { cwd: app.root, instanceId: "closed-partial",
      dispatchId: "closed-partial", roleId: "developer" });
    attempt.admit(); attempt.result({ status: "failed", result: "partial source retained for independent validation" });
    const message = { customType: "pitako.worker.result", content: "closed-partial", details: { deliveryId: "closed-partial" } };
    const source = captureResultSource(attempt, "closed-partial", message, { owns: () => true, getBranch: () => app.branch });
    app.branch.push({ type: "custom_message", id: "partial-receipt", ...message }); source.observe("turn_start");
    attempt.producer.observe("preparation", "closed"); attempt.producer.observe("host-operation", "closed");
    attempt.producer.observe("callback", "closed", true);
    const obligation = payload(await app.invoke("execution_disposition", { op: "inspect" })).obligations
      .find((item: any) => item.dispatchId === "closed-partial");
    await app.invoke("execution_disposition", { op: "record", obligationId: obligation.obligationId,
      expectedVersion: obligation.version, reason: "Retain the failed strategy and independently validate current source",
      choice: { kind: "continue", admissionId: owner.run.runId } });
    const input = { expectedVersion: owner.run.version, reviewAssignmentId: "missing", evidenceRefs: ["missing"],
      acceptance: "Current source is independently checked", absorption: "Retain the failed attempt and closed contributor", dispositions: [] };
    await expect(app.invoke("execution_acceptance", input)).rejects.toThrow();
    const gates = payload(await app.invoke("execution_gates", { commands: [{ command: "printf validated", timeoutSeconds: 5 }],
      coverage: "Current bounded source" }));
    const review = handle(await app.invoke("execution_review", { goal: "Review independently checked partial source",
      criteria: ["Current candidate and historical failed attempt"] }));
    await app.bookkeeping(review.instanceId);
    await expect(app.invoke("execution_acceptance", { ...input, expectedVersion: owner.run.version,
      reviewAssignmentId: review.assignmentId, evidenceRefs: ["foreign"] })).rejects.toThrow("evidence");
    const accepted = payload(await app.invoke("execution_acceptance", { ...input, expectedVersion: owner.run.version,
      reviewAssignmentId: review.assignmentId, evidenceRefs: [gates.evidenceId] }));
    await app.invoke("task_finish", { expectedVersion: owner.run.version, freezeReceiptRef: freezeReceipt.receiptId,
      executionAcceptanceRef: accepted.acceptanceId });
    const status = payload(await app.invoke("workflow_status", { runId: owner.run.runId }));
    expect(status.state).toBe("completed");
    expect(status.attempts.filter((item: any) => item.roleId === "developer"))
      .toMatchObject([{ dispatchId: "closed-partial", outcome: { status: "failed" }, closure: "closed" }]);
    expect(status.restrictions).toEqual([]);
  } finally { await app.close(); }
});

test("accepted execution retires its blocked user-decision projection without rewriting the ledger", async () => {
  const app = await setup();
  try {
    await app.commands.get("task").handler("accepted-decision", app.ctx);
    await freeze(app);
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    if (context.kind !== "managed") throw new Error("missing execution owner");
    const owner = checkAuthority(context.authority);
    writeFileSync(path.join(app.root, "implementation.ts"), "export const bounded = true;\n");
    const attempt = registerBackgroundAttempt(context, { cwd: app.root, instanceId: "decision-worker",
      dispatchId: "decision-worker", roleId: "developer" });
    attempt.admit(); attempt.result({ status: "failed", result: "Decision needed beyond bounded work" });
    const message = { customType: "pitako.worker.result", content: "decision-worker", details: { deliveryId: "decision-worker" } };
    const source = captureResultSource(attempt, "decision-worker", message, { owns: () => true, getBranch: () => app.branch });
    app.branch.push({ type: "custom_message", id: "decision-receipt", ...message }); source.observe("turn_start");
    attempt.producer.observe("preparation", "closed"); attempt.producer.observe("host-operation", "closed");
    attempt.producer.observe("callback", "closed", true);
    const obligation = payload(await app.invoke("execution_disposition", { op: "inspect" })).obligations
      .find((item: any) => item.dispatchId === "decision-worker");
    const ledger = ledgerFile("accepted-decision", app.root), before = readFileSync(ledger, "utf8");
    const lock = `${ledger}.lock`;
    mkdirSync(lock);
    const decision = payload(await app.invoke("execution_disposition", { op: "record", obligationId: obligation.obligationId,
      expectedVersion: obligation.version, reason: "A choice outside this result's admitted scope",
      choice: { kind: "user-decision", question: "Expand scope?", options: ["Keep", "Expand"],
        boundary: "External scope", evidenceRefs: [obligation.obligationId] } }));
    expect(decision.userDecisionProjections).toEqual([expect.objectContaining({ state: "blocked" })]);
    const current = payload(await app.invoke("execution_disposition", { op: "inspect" })).obligations
      .find((item: any) => item.dispatchId === "decision-worker");
    await app.invoke("execution_disposition", { op: "record", obligationId: current.obligationId,
      expectedVersion: current.version, reason: "Continue within the independently checked bounded source",
      choice: { kind: "continue", admissionId: owner.run.runId } });
    const gates = payload(await app.invoke("execution_gates", { commands: [{ command: "printf checked", timeoutSeconds: 5 }],
      coverage: "Current bounded source" }));
    const review = handle(await app.invoke("execution_review", { goal: "Review current candidate and decision history",
      criteria: ["Current evidence and closed contributor"] }));
    await app.bookkeeping(review.instanceId);
    await app.invoke("execution_acceptance", { expectedVersion: owner.run.version, reviewAssignmentId: review.assignmentId,
      evidenceRefs: [gates.evidenceId], acceptance: "Accept current independently checked source",
      absorption: "Retain the obsolete historical decision", dispositions: [] });
    rmSync(lock, { recursive: true });
    const status = payload(await app.invoke("workflow_status", { runId: owner.run.runId }));
    expect(status.projections).toEqual([expect.objectContaining({ state: "not-applicable" })]);
    expect(readFileSync(ledger, "utf8")).toBe(before);
    const guard = new RootGuard(app.root);
    try {
      const probe = guard.reserve({ reservationId: randomUUID(), kind: "gates", paths: [path.join(app.root, "independent")] })
        .register("independent", ["host-operation"]);
      probe.enter(); probe.observe("host-operation", "closed", true);
    } finally { guard.close(); }
    expect(readFileSync(ledger, "utf8")).toBe(before);
  } finally {
    const lock = `${ledgerFile("accepted-decision", app.root)}.lock`;
    if (existsSync(lock)) rmSync(lock, { recursive: true });
    await app.close();
  }
});

test("planning admission owns no paths; a conflicting physical effect blocks only the plan write and late closure permits it", async () => {
  const app = await setup(), guard = new RootGuard(app.root);
  const held = guard.reserve({ reservationId: randomUUID(), kind: "assignment-writer", paths: [app.root] }).register("independent-admission", ["host-operation"]);
  try {
    held.enter();
    app.ctx.hasUI = true;
    await app.commands.get("task").handler("capacity", app.ctx);
    expect(app.sent.filter(item => item.message.customType === "pitako.workflow.task")).toHaveLength(1);
    const slot = payload(await app.invoke("bound_plan_read", {}));
    await expect(app.invoke("planning_write", { revision: slot.revision, fileHash: slot.fileHash, body: "Blocked body" }))
      .rejects.toThrow(/operation lease/);
    expect(held.live).toBe(true);
    held.observe("host-operation", "closed", true);
    const later = guard.reserve({ reservationId: randomUUID(), kind: "assignment-writer", paths: [app.root] }).register("independent-later-admission", ["host-operation"]);
    later.enter();
    try {
      await expect(app.invoke("planning_write", { revision: slot.revision, fileHash: slot.fileHash, body: "Still blocked" }))
        .rejects.toThrow(/operation lease/);
      expect(later.live).toBe(true);
    } finally { later.observe("host-operation", "closed", true); }
    expect(payload(await app.invoke("planning_write", { revision: slot.revision, fileHash: slot.fileHash, body: "Independent progress" })).snapshot.revision)
      .toBe(1);
  } finally {
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
