import { recoveryClock } from "./fixtures/recovery-clock.ts";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyPatch, APPLY_PATCH_GRAMMAR, createFreeformInputSchema, createOpenAILarkSampling } from "pi-codex-tools";
import { Type } from "typebox";
import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager, type AgentBeforeSettleEvent, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { AgentClosureError } from "../extensions/agent/closure.ts";
import { loadPitakoConfig } from "../extensions/roles/load.ts";
import { headExtension } from "../extensions/agent/head/tools.ts";
import { reserveOperation, mutationGeneration } from "../extensions/agent/head/operation-leases.ts";
import { acquireCheckpointLease } from "../extensions/agent/head/checkpoint-lease.ts";
import { HeadAttachment } from "../extensions/agent/head/runtime.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { runAgentInstance, type AgentRunResult } from "../extensions/agent/run.ts";
import { providerFixtureOwnership } from "./fixtures/provider-fixture-ownership.ts";
import { controlledModel, controlledPi, controlledRole } from "./fixtures/pi-factories.ts";

const fixture = providerFixtureOwnership();
function deferred() { return Promise.withResolvers<void>(); }
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-head-runtime-"));
  fixture.directories.push(root);
  process.env.PI_CODING_AGENT_DIR = root;
  const userConfigPath = path.join(root, "pitako", "config.toml");
  mkdirSync(path.dirname(userConfigPath), { recursive: true });
  writeFileSync(userConfigPath, `[model_policies.developer.primary]
model = "fixture/selected"
reasoning = "off"
[[model_policies.developer.fallbacks]]
model = "fixture/fallback"
reasoning = "off"
`);
  return { root, load: { userConfigPath, env: { PI_CODING_AGENT_DIR: root } } };
}

// Run the real local factories at the SDK boundary; the test owns event dispatch/receipt.
async function bind(factories: ExtensionFactory[]) {
  const tools = new Map<string, { execute: Function }>(), events = new Map<string, Function>();
  const api = {
    registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
    on(name: string, callback: Function) { events.set(name, callback); return () => events.delete(name); },
  } as unknown as ExtensionAPI;
  for (const factory of factories) await factory(api);
  return { tools, events };
}
const boundary = (canContinue = true): AgentBeforeSettleEvent => ({
  type: "agent_before_settle", entries: [], continue: false, outcome: "completed",
  context: { canContinue, contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [] },
});

test("only the granted native Head receives closed child envelopes; offers are not receipts", fixture.ownedCase("Head native result seam", async () => {
  const { root, load } = setup();
  const prompt = deferred(), entered = deferred(), disposing = deferred(), releaseDispose = deferred();
  fixture.beforeRelease(() => { prompt.resolve(); releaseDispose.resolve(); });
  const child = controlledPi(root, { dispose: async () => { disposing.resolve(); await releaseDispose.promise; } });
  const head = new HeadAttachment("assignment-one", root);
  let local!: Awaited<ReturnType<typeof bind>>, childRun!: Promise<AgentRunResult>;
  const host = controlledPi(root, {
    bind: async () => { local = await bind(host.loaderInputs[0].extensionFactories); },
    prompt: async session => {
      childRun = fixture.run(head.startChild("child-one", signal => runAgentInstance({
        roleId: "developer", task: "child brief", cwd: root, load, signal, executor: createPiExecutor({ factories: child.factories }),
      })));
      entered.resolve();
      await prompt.promise;
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "head result" }], stopReason: "stop" });
    },
  });
  const run = fixture.run(runAgentInstance({ roleId: "developer", task: "head brief", cwd: root, load, head,
    executor: createPiExecutor({ factories: host.factories }) }));
  await Promise.all([entered.promise, disposing.promise]);
  expect(() => head.startChild("child-one", async () => { throw new Error("duplicate must not start"); })).toThrow("already started");
  const result = local.tools.get("head_result")!, wait = local.tools.get("head_wait")!;
  expect([...local.tools.keys()]).toEqual(["head_result", "head_wait"]);
  expect(await result.execute("read", { childId: "child-one" })).toMatchObject({ details: undefined });
  const event = local.events.get("agent_before_settle")!;
  const settlingBoundary = event(boundary());
  let delivered = false;
  const waiting = wait.execute("wait", {}, undefined).then((value: unknown) => { delivered = true; return value; });
  void waiting.catch(() => {});
  await Promise.resolve();
  expect(delivered).toBe(false);

  // Another granted Head and an ordinary leaf get independently loaded factories.
  const otherHead = new HeadAttachment("assignment-two", root);
  let otherLocal!: Awaited<ReturnType<typeof bind>>, leafLocal!: Awaited<ReturnType<typeof bind>>;
  const other = controlledPi(root, { bind: async () => { otherLocal = await bind(other.loaderInputs[0].extensionFactories); },
    prompt: async session => {
      await expect(otherLocal.tools.get("head_result")!.execute("read", { childId: "child-one" })).rejects.toThrow("unknown Head child");
      expect(await otherLocal.events.get("agent_before_settle")!(boundary())).toBeUndefined();
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "other" }], stopReason: "stop" });
    } });
  await fixture.run(runAgentInstance({ roleId: "developer", task: "other brief", cwd: root, load, head: otherHead,
    executor: createPiExecutor({ factories: other.factories }) }));
  const leaf = controlledPi(root, { bind: async () => { leafLocal = await bind(leaf.loaderInputs[0].extensionFactories); } });
  await fixture.run(runAgentInstance({ roleId: "developer", task: "leaf brief", cwd: root, load,
    executor: createPiExecutor({ factories: leaf.factories }) }));
  expect(leafLocal.tools.size).toBe(0);
  expect(await leafLocal.events.get("agent_before_settle")!(boundary())).toBeUndefined();

  releaseDispose.resolve();
  const childOutcome = await childRun;
  expect(await waiting).toMatchObject({ details: [{ assignmentId: "assignment-one", childId: "child-one",
    result: { instanceId: childOutcome.instanceId } }] });
  const offered = await settlingBoundary;
  expect(await event(boundary(false))).toBeUndefined();
  expect(offered).toMatchObject({ continue: true, entries: [{ customType: "pitako.head.result" }] });
  expect(await event(boundary())).toBeUndefined(); // an open offer is neither receipt nor permission to duplicate
  const envelope = JSON.parse(offered.entries[0].content);
  envelope.result.result = "mutated caller copy";
  expect(JSON.parse((await result.execute("read", { childId: "child-one" })).content[0].text).result.result).toBe("controlled result");
  const entry = offered.entries[0];
  host.sessions[0]!.sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  expect(await event(boundary())).toBeUndefined();
  host.sessions[0]!.sessionManager.getBranch = () => { head.revoke(); return []; };
  await expect(event(boundary())).rejects.toThrow("retired"); // retirement during receipt inspection cannot offer late context
  prompt.resolve();
  await run;
  expect(() => result.execute("late", { childId: "child-one" })).toThrow("retired");
}));

test("admitted child effects fence retries into the same Head session, never replaying its initial brief", fixture.ownedCase("Head retry fence", async () => {
  const { root, load } = setup(), head = new HeadAttachment("retry-assignment", root);
  const child = controlledPi(root);
  let childRun!: Promise<AgentRunResult>;
  const host = controlledPi(root, {
    models: [controlledModel(), controlledModel("fixture", "fallback")],
    bind: async () => { await bind(host.loaderInputs[0].extensionFactories); },
    prompt: async session => {
      if (session.prompts.length === 1) {
        childRun = fixture.run(head.startChild("admitted-child", signal => runAgentInstance({
          roleId: "developer", task: "child", cwd: root, load, signal, executor: createPiExecutor({ factories: child.factories }),
        })));
        throw new Error("No API key for fixture/selected");
      }
      await childRun;
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "continued" }], stopReason: "stop" });
    },
  });
  const outcome = await fixture.run(runAgentInstance({ roleId: "developer", task: "initial Head brief", cwd: root, load, head,
    executor: createPiExecutor({ factories: host.factories }) }));
  expect(outcome.result).toBe("continued");
  expect(host.sessions).toHaveLength(1);
  expect(host.sessions[0]!.prompts).toHaveLength(2);
  expect(host.sessions[0]!.prompts.filter(text => text.includes("initial Head brief"))).toHaveLength(1);
  expect(head.sideEffects).toBe(true);
}));

test("startup cancellation joins a late-created session and forbids native result/input admissions", fixture.ownedCase("Head startup cancel", async () => {
  const { root, load } = setup(), head = new HeadAttachment("cancel-assignment", root), controller = new AbortController();
  const creating = deferred(), releaseCreate = deferred(), aborting = deferred(), releaseAbort = deferred(),
    disposing = deferred(), releaseDispose = deferred();
  fixture.beforeRelease(() => { releaseCreate.resolve(); releaseAbort.resolve(); releaseDispose.resolve(); });
  const host = controlledPi(root, {
    abort: async () => { aborting.resolve(); await releaseAbort.promise; },
    dispose: async () => { disposing.resolve(); await releaseDispose.promise; },
  });
  const create = host.factories.createSession!;
  host.factories.createSession = async input => { creating.resolve(); await releaseCreate.promise; return create(input); };
  let finished = false, liveAdmissions = 0;
  const executor = createPiExecutor({ factories: host.factories });
  const run = fixture.run(runAgentInstance({ roleId: "developer", task: "cancel startup", cwd: root, load, head,
    signal: controller.signal, executor: { ...executor, start(input) {
      return executor.start({ ...input, bindLive() { liveAdmissions++; return () => {}; } });
    } } })).then(result => { finished = true; return result; });
  await creating.promise;
  controller.abort();
  expect(head.signal.aborted).toBe(true);
  expect(() => head.startChild("late", async () => { throw new Error("must not run"); })).toThrow("retired");
  releaseCreate.resolve();
  await aborting.promise;
  expect(host.sessions[0]!.events).not.toContain("dispose");
  expect(finished).toBe(false);
  releaseAbort.resolve();
  await disposing.promise;
  expect(finished).toBe(false);
  expect(host.sessions[0]!.prompts).toEqual([]);
  expect(liveAdmissions).toBe(0);
  releaseDispose.resolve();
  expect((await run).status).toBe("cancelled");
}));

test("cancel during Head delivery wakes owned callbacks and waits prompts and child disposal", fixture.ownedCase("Head delivery cancel", async () => {
  const { root, load } = setup(), head = new HeadAttachment("delivery-assignment", root), controller = new AbortController();
  const entered = deferred(), releasePrompt = deferred(), disposing = deferred(), releaseChild = deferred();
  fixture.beforeRelease(() => { releasePrompt.resolve(); releaseChild.resolve(); });
  const child = controlledPi(root, { dispose: async () => { disposing.resolve(); await releaseChild.promise; } });
  let local!: Awaited<ReturnType<typeof bind>>, childRun!: Promise<AgentRunResult>, waiting!: Promise<unknown>;
  const host = controlledPi(root, {
    bind: async () => { local = await bind(host.loaderInputs[0].extensionFactories); },
    prompt: async () => {
      childRun = fixture.run(head.startChild("child", signal => runAgentInstance({ roleId: "developer", task: "child", cwd: root,
        load, signal, executor: createPiExecutor({ factories: child.factories }) })));
      waiting = local.tools.get("head_wait")!.execute("wait", {}, undefined);
      void waiting.catch(() => {});
      entered.resolve();
      await releasePrompt.promise;
    },
  });
  let finished = false;
  const run = fixture.run(runAgentInstance({ roleId: "developer", task: "cancel delivery", cwd: root, load, head,
    signal: controller.signal, executor: createPiExecutor({ factories: host.factories }) })).then(result => { finished = true; return result; });
  await Promise.all([entered.promise, disposing.promise]);
  controller.abort();
  await expect(waiting).rejects.toThrow("retired");
  expect(await local.events.get("agent_before_settle")!(boundary())).toBeUndefined();
  expect(() => head.startChild("late", async () => { throw new Error("must not run"); })).toThrow("retired");
  expect(finished).toBe(false);
  releasePrompt.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);
  releaseChild.resolve();
  await childRun;
  expect((await run).status).toBe("cancelled");
}));

test("unknown consultation retains the shared lease and yields bounded settlement diagnostics", fixture.ownedCase("consultation unknown", async () => {
  const { root, load } = setup();
  appendFileSync(load.userConfigPath, '[model_policies.researcher.primary]\nmodel = "fixture/selected"\n');
  const head = new HeadAttachment("unknown-assignment", root, { writes: [], config: loadPitakoConfig(load),
    // Synthetic uncertainty: no provider, process or native session is actually started.
    executor: { async start() { throw new AgentClosureError([new Error("controlled unknown")], "consultation"); } } });
  head.claim("head-instance", root);
  const binding = head.bind("head-instance"), manager = SessionManager.inMemory(root);
  const local = await bind([headExtension(head, binding, () => manager)]);
  const ctx = { cwd: root, sessionManager: manager } as unknown as ExtensionContext;
  const handle = (await local.tools.get("head_consult")!.execute("consult", { role: "researcher", task: "unknown" }, undefined, undefined, ctx)).details;
  let after = 0;
  while (head.consultationResult(binding, handle.childId)?.phase !== "unknown") {
    after = (await local.tools.get("head_wait")!.execute("wait", { after })).details.cursor;
  }
  expect(head.workSnapshot().retained).toBe(1);
  expect(() => head.managed!.assertIdle()).toThrow(AgentClosureError);
  expect(() => head.dag!.beginIntegration(binding, 0, [])).toThrow();
  expect(() => head.dag!.assertCheckpointReady(binding, 0)).toThrow();
  expect(() => head.dag!.codingAllowed(binding)).toThrow(AgentClosureError);
  await expect(head.dag!.finish(binding, { status: "completed", epoch: "fake", summary: "no", verification: ["fake"], limits: [] }, [])).rejects.toThrow();
  const offer = await head.boundary(binding, boundary(), manager);
  for (const entry of offer!.entries!) if (entry.type === "custom_message") manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  const correction = await head.boundary(binding, boundary(), manager);
  expect(JSON.stringify(correction)).toContain("unknown closure");
  expect(head.workSnapshot().retained).toBe(1); // receipt cannot establish physical release
  await head.boundary(binding, boundary(), manager);
  expect(await head.boundary(binding, boundary(), manager)).toBeUndefined();
  await expect(head.close()).rejects.toBeInstanceOf(AgentClosureError);
}));

const gateGrant = { durationMs: 15000, captureBytes: 65536, invocations: 8, artifactRoots: [], scratchRoots: ["scratch"] };
async function gatedHead(overrides = {}, clock = recoveryClock()) {
  const { root, load } = setup();
  writeFileSync(path.join(root, "GATES.md"), "# Gates\nSelect the local component check. Manual review remains.\n");
  mkdirSync(path.join(root, "component")); mkdirSync(path.join(root, "scratch"));
  const head = new HeadAttachment("gated-assignment", root, { writes: ["product.md"], config: loadPitakoConfig(load),
    executor: { async start() { throw new Error("not a leaf test"); } }, recoveryScheduler: clock.scheduler, verification: { ...gateGrant, ...overrides } });
  head.claim("head-instance", root);
  const binding = head.bind("head-instance");
  const manager = SessionManager.create(root, path.join(root, ".pitako", "sessions"));
  const local = await bind([headExtension(head, binding, () => manager)]);
  const epoch = head.dag!.beginIntegration(binding, 0, manager.getBranch()).epoch;
  const request = (shell: string, more = {}) => head.gates!.request(binding, { epoch, expectedRevision: 0,
    coverage: "Selected component shell; manual review unrun", commands: [{ id: "local", shell, cwd: "component", env: {}, timeoutMs: 3000, ...more }] });
  const completed = async () => {
    const offered = await head.boundary(binding, boundary(false), manager);
    for (const e of offered?.entries ?? []) if (e.type === "custom_message") manager.appendCustomMessageEntry(e.customType, e.content, e.display, e.details);
    // Join the actual preparation/process/capture operation, not just the offered result.
    await Promise.resolve();
    return head.gates!.outcomes(binding).at(-1)!;
  };
  fixture.beforeRelease(() => head.close());
  return { root, head, binding, manager, local, epoch, request, completed };
}

test("gate handle precedes filesystem/spawn; pre-macrotask cancel and retire launch zero commands", fixture.ownedCase("no late gate effects", async () => {
  for (const retire of [false, true]) {
    const h = await gatedHead();
    const handle = h.request("printf started > ../scratch/started");
    expect(h.head.gates!.status(h.binding, handle.runId).phase).toBe("preparing");
    expect(existsSync(path.join(h.root, ".pitako/gates"))).toBe(false);
    if (retire) h.head.revoke(); else h.head.gates!.cancel(h.binding, handle.runId);
    await h.head.close();
    expect(existsSync(path.join(h.root, "scratch/started"))).toBe(false);
    expect(existsSync(path.join(h.root, ".pitako/gates"))).toBe(false);
  }
}));

test("shared leases exclude an actually admitted writer and overlapping Heads/checkpoints, not disjoint reads", fixture.ownedCase("gate shared leases", async () => {
  const h = await gatedHead();
  const release = deferred(), entered = deferred();
  // The same managed wrapper used by admitted Head tools surrounds real asynchronous effects.
  const { ManagedProducer } = await import("../extensions/agent/head/managed-tools.ts");
  const producer = new ManagedProducer(h.head.managed!, { writes: [path.join(h.root, "product.md")], check: () => 0, effects() {},
    source: () => ({ kind: "head", instanceId: "head-instance", groupId: "group", historyId: "history", sessionId: "session" }) }, h.head.signal);
  const native = producer.wrap({ name: "write", label: "write", description: "controlled writer", parameters: Type.Object({ path: Type.String() }),
    async execute() { entered.resolve(); await release.promise; writeFileSync(path.join(h.root, "product.md"), "writer\n"); return { content: [], details: {} }; } });
  const writing = native.execute("writer", { path: "product.md" }, undefined, undefined, { cwd: h.root } as never);
  await entered.promise;
  expect(() => h.request("printf blocked")).toThrow("active");
  release.resolve(); await writing; await producer.settle();
  const handle = h.request("printf component");
  expect(() => reserveOperation(path.join(h.root, "component"), "writer")).toThrow("lease");
  expect(() => acquireCheckpointLease(h.root)).toThrow("active");
  expect(() => h.head.dag!.reopen(h.binding, h.epoch)).toThrow("lease");
  expect(() => new HeadAttachment("other", h.root)).toThrow("lease");
  await expect(h.head.dag!.finish(h.binding, { status: "completed", epoch: h.epoch, summary: "not done", verification: [handle.runId], limits: [] }, [])).rejects.toThrow("lease");
  const disjoint = mkdtempSync(path.join(tmpdir(), "pitako-disjoint-")); fixture.directories.push(disjoint);
  const independent = reserveOperation(disjoint, "writer"); independent.release();
  expect(readFileSync(path.join(h.root, "GATES.md"), "utf8")).toContain("Manual");
  expect((await h.completed()).outcome).toBe("passed");
  await h.head.close();
}));

test("gate selection supports Markdown/component cwd, strips startup env, and exact receipt goes stale on new dirty inputs", fixture.ownedCase("gate evidence identity", async () => {
  const h = await gatedHead();
  const handle = h.request("test \"$PWD\" = \"$EXPECTED\" && test -z \"$BASH_ENV$ENV\" && printf 'markdown only\\n'", {
    env: { EXPECTED: path.join(h.root, "component"), BASH_ENV: "/ungranted", ENV: "/ungranted" } });
  expect(h.head.dag!.verificationEntries(h.binding, h.manager.getBranch())).toEqual([]);
  const result = await h.completed();
  expect(result).toMatchObject({ outcome: "passed", closure: "released", stale: false });
  const entries = h.manager.getBranch();
  const proof = h.head.dag!.verificationEntries(h.binding, entries).find(e => e.kind === "owned-gates")!;
  expect(proof.entryId).toBeTruthy();
  const receipt = entries.find(e => e.id === proof.entryId)!;
  expect(h.head.dag!.verificationEntries(h.binding, [{ ...receipt, id: "copied" }] as never)).toEqual([]);
  expect(() => h.head.gates!.status({}, handle.runId)).toThrow("retired");
  writeFileSync(path.join(h.root, "new-product.md"), "new dirty input outside writes\n");
  expect(h.head.dag!.verificationEntries(h.binding, entries)).toEqual([]);
  await expect(h.head.dag!.finish(h.binding, { status: "completed", epoch: h.epoch, summary: "stale", verification: [proof.entryId], limits: [] }, entries)).rejects.toThrow("verification");
  await h.head.close();
}));

test("a gate writing product becomes incomplete, and capture cap cannot silently pass", fixture.ownedCase("gate no silent correction", async () => {
  const h = await gatedHead({ captureBytes: 16 });
  h.request("printf corrected > ../new-product.md");
  expect(await h.completed()).toMatchObject({ outcome: "incomplete", stale: true, complete: false });
  h.request("printf 123456789012345678901234567890");
  const capped = await h.completed();
  expect(capped.outcome).toBe("incomplete"); expect(capped.complete).toBe(false);
  expect(capped.bytes).toBe(16); expect(capped.diagnostic).toContain("cap");
  expect(h.head.dag!.verificationEntries(h.binding, h.manager.getBranch())).toEqual([]);
  await h.head.close();
}));

test("supported failed writers advance mutation generation before effects", fixture.ownedCase("gate generation", async () => {
  const h = await gatedHead(); const before = mutationGeneration(h.root);
  const lease = reserveOperation(h.root, "writer");
  expect(mutationGeneration(h.root)).toBeGreaterThan(before);
  lease.release();
  h.request("printf pass"); expect((await h.completed()).candidate!.generation).toBeGreaterThan(before);
  await h.head.close();
}));


test("head_wait is a typed deadline hold, steering/revoke interrupt it, and deadline/cancel join processes", fixture.ownedCase("gate wait lifecycle", async () => {
  const h = await gatedHead();
  const handle = h.request("exec sleep 30", { timeoutMs: 50 });
  const cursor = (await h.head.dag!.wait(h.binding, 0)).cursor;
  const waiting = h.local.tools.get("head_wait")!.execute("wait", { after: cursor });
  expect(h.head.waitHold).toMatchObject({ kind: "owned-gates-wait", runId: handle.runId });
  h.head.interruptWait(); await waiting;
  expect(h.head.waitHold).toBeUndefined();
  // Steering belongs to the next boundary; consuming it does not consume finish corrections.
  await h.head.boundary(h.binding, boundary(false), h.manager);
  expect((await h.completed()).outcome).toBe("timed-out");
  const next = h.request("exec sleep 30");
  const nextCursor = (await h.head.dag!.wait(h.binding, 0)).cursor;
  const cancelledWait = h.local.tools.get("head_wait")!.execute("wait", { after: nextCursor });
  h.head.gates!.cancel(h.binding, next.runId);
  await cancelledWait; expect((await h.completed()).outcome).toBe("cancelled");
  const finalCursor = (await h.head.dag!.wait(h.binding, 0)).cursor;
  const revokedWait = h.local.tools.get("head_wait")!.execute("wait", { after: finalCursor });
  const rejected = revokedWait.then(() => { throw new Error("revoked wait resolved"); }, (error: Error) => { expect(error.message).toContain("retired"); });
  h.head.revoke(); await rejected; await h.head.close();
}));


test("internal capture exclusions do not authorize changing other project inputs", fixture.ownedCase("gate internal effects", async () => {
  const h = await gatedHead();
  h.request("printf changed > ../.pitako/project-input");
  const result = await h.completed();
  expect(result).toMatchObject({ outcome: "incomplete", stale: true, complete: false });
  expect(result.candidate!.exclusions).not.toContain(".pitako");
  expect(h.head.dag!.verificationEntries(h.binding, h.manager.getBranch())).toEqual([]);
  await h.head.close();
}));


test("serial gates stop at the first real failure with remaining commands unrun and no retry", fixture.ownedCase("gate serial failure", async () => {
  const h = await gatedHead();
  const handle = h.head.gates!.request(h.binding, { epoch: h.epoch, expectedRevision: 0, coverage: "ordered Markdown checks; manual review remains",
    commands: [
      { id: "first", shell: "printf one", cwd: ".", env: {}, timeoutMs: 1000 },
      { id: "failed", shell: "printf failure >&2; exit 9", cwd: "component", env: {}, timeoutMs: 1000 },
      { id: "unrun", shell: "printf forbidden > scratch/unrun", cwd: ".", env: {}, timeoutMs: 1000 },
    ] });
  const outcome = await h.completed();
  expect(outcome).toMatchObject({ outcome: "failed", closure: "released", complete: false,
    commands: [{ state: "passed", exitCode: 0 }, { state: "failed", exitCode: 9 }, { state: "unrun", artifacts: [] }] });
  expect(h.head.gates!.read(h.binding, handle.runId, "0-stdout").text).toBe("one");
  expect(h.head.gates!.read(h.binding, handle.runId, "1-stderr").text).toBe("failure");
  expect(existsSync(path.join(h.root, "scratch/unrun"))).toBe(false);
  expect(h.head.dag!.verificationEntries(h.binding, h.manager.getBranch())).toEqual([]);
  await h.head.close();
}));


test("owned scheduler releases a parked Head boundary after the stored gate outcome misses its fast wake", fixture.ownedCase("Head gates recovery producer", async () => {
  const clock = recoveryClock({ suppressReady: true }), h = await gatedHead({}, clock);
  expect(clock.pending).toBe(0);
  const { manager, local } = h;
  const anchor = manager.appendCustomMessageEntry("fixture.anchor", "prior", false);
  const ready = deferred();
  let notifications = 0;
  clock.scheduler.notifyReady = () => { if (++notifications === 2) ready.resolve(); };
  let responseSettled = false;
  h.request("printf recovered");
  const pending = local.events.get("agent_before_settle")!(boundary(false)).then((value: unknown) => { responseSettled = true; return value; });
  // Gate outcome storage then actual owned-operation settlement both notify the same host.
  await ready.promise;
  expect(responseSettled).toBe(false);
  expect(clock.pending).toBe(1);
  clock.fire();
  const offered = await pending as { entries: Array<{ customType: string; content: string; display: boolean; details: unknown }>; continue: boolean };
  expect(offered.continue).toBe(true);
  expect(offered.entries).toHaveLength(1);
  const entry = offered.entries[0]!;
  expect(entry.customType).toBe("pitako.head.gates");
  expect(JSON.parse(entry.content)).toMatchObject({ outcome: "passed", closure: "released" });
  expect(h.head.dag!.verificationEntries(h.binding, manager.getBranch())).toEqual([]);
  // No event/timer duplicate while native commitment is outstanding.
  clock.fire();
  expect(await local.events.get("agent_before_settle")!(boundary(false))).toBeUndefined();
  manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  await local.events.get("context")!({});
  expect(h.head.dag!.verificationEntries(h.binding, manager.getBranch()).some(e => e.kind === "owned-gates")).toBe(true);
  await local.events.get("turn_start")!({});
  expect(clock.pending).toBe(0);
  // A changed tree can invalidate evidence, but cannot rearm consumed liveness.
  manager.branch(anchor);
  expect(await local.events.get("agent_before_settle")!(boundary(false))).toBeUndefined();
  expect(h.head.dag!.verificationEntries(h.binding, manager.getBranch())).toEqual([]);
  expect(clock.pending).toBe(0);
  await h.head.close();
}));


test("Head events and timer never duplicate an open gate offer, and closed boundaries share two total offers", fixture.ownedCase("Head recovery offer exhaustion", async () => {
  const clock = recoveryClock(), h = await gatedHead({}, clock);
  h.request("printf retained");
  const event = h.local.events.get("agent_before_settle")!;
  const first = await event(boundary(false));
  clock.fire(); clock.fire();
  expect(await event(boundary(false))).toBeUndefined();
  await h.local.events.get("agent_settled")!({});
  // A later safe boundary can retry the closed, uncommitted envelope, with exactly the same ID/body.
  const second = await event(boundary(false));
  expect(second.entries).toEqual(first.entries);
  clock.fire();
  expect(await event(boundary(false))).toBeUndefined();
  await h.local.events.get("agent_settled")!({});
  expect(clock.pending).toBe(0);
  expect(await event(boundary(false))).toBeUndefined();
  expect(h.head.workSnapshot().deliveries).toEqual([expect.objectContaining({ deliveryAttempts: 2,
    deliveryDiagnostic: expect.stringContaining("exhausted") })]);
  await h.head.close();
}));

test("Head receipt without an observed continuation stays blocked at final settlement and cannot create an idle prompt", fixture.ownedCase("Head unobserved continuation", async () => {
  const clock = recoveryClock(), h = await gatedHead({}, clock);
  h.request("printf ready");
  const offered = await h.local.events.get("agent_before_settle")!(boundary(false));
  const entry = offered.entries[0];
  h.manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  await h.local.events.get("context")!({});
  clock.fire();
  expect(await h.local.events.get("agent_before_settle")!(boundary(false))).toBeUndefined();
  await h.local.events.get("agent_settled")!({});
  expect(clock.pending).toBe(0);
  expect(h.head.workSnapshot().deliveries).toEqual([expect.objectContaining({ delivery: "incorporated", continuation: "blocked-unconfirmed" })]);
  expect(await h.local.events.get("agent_before_settle")!(boundary(false))).toBeUndefined();
  await h.head.close();
}));

test("the same host backstop recovers a retained consultation locally, not through foreground state", fixture.ownedCase("Head consultation recovery", async () => {
  const { root, load } = setup();
  appendFileSync(load.userConfigPath, '[model_policies.researcher.primary]\nmodel = "fixture/selected"\n');
  const clock = recoveryClock({ suppressReady: true }), entered = deferred(), ready = deferred();
  const outcome = Promise.withResolvers<import("../extensions/agent/run.ts").Attempt>();
  let notifications = 0;
  clock.scheduler.notifyReady = () => { if (++notifications === 2) ready.resolve(); };
  const head = new HeadAttachment("consultation-recovery", root, { writes: [], config: loadPitakoConfig(load),
    recoveryScheduler: clock.scheduler, executor: { async start() { entered.resolve(); return outcome.promise; } } });
  fixture.beforeRelease(() => { outcome.resolve({ status: "completed", result: "controlled advice", sideEffects: false }); return head.close(); });
  head.claim("head-instance", root);
  const binding = head.bind("head-instance"), manager = SessionManager.inMemory(root);
  const local = await bind([headExtension(head, binding, () => manager)]);
  const ctx = { cwd: root, sessionManager: manager } as unknown as ExtensionContext;
  await local.tools.get("head_consult")!.execute("consult", { role: "researcher", task: "advice" }, undefined, undefined, ctx);
  await entered.promise;
  let settled = false;
  const pending = local.events.get("agent_before_settle")!(boundary()).then((value: unknown) => { settled = true; return value; });
  outcome.resolve({ status: "completed", result: "controlled advice", sideEffects: false });
  await ready.promise;
  expect(settled).toBe(false);
  clock.fire();
  const offered = await pending as { entries: Array<{ customType: string; content: string; display: boolean; details: unknown }> };
  expect(offered.entries).toHaveLength(1);
  const entry = offered.entries[0]!;
  expect(entry.customType).toBe("pitako.head.result");
  expect(JSON.parse(entry.content)).toMatchObject({ purpose: "consultation", role: "researcher", outcome: "completed", result: { result: "controlled advice" } });
  manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  await local.events.get("turn_start")!({});
  expect(clock.pending).toBe(0);
  expect(await local.events.get("agent_before_settle")!(boundary(false))).toBeUndefined();
  await head.close();
}));

test("queued Head ticks cannot revive a retired attachment or a changed native owner during a parked await/callback", fixture.ownedCase("Head recovery lifecycle fences", async () => {
  for (const change of ["retire", "during-await", "branch-callback", "error"] as const) {
    const clock = recoveryClock(), h = await gatedHead({}, clock);
    let current = h.manager;
    const local = await bind([headExtension(h.head, h.binding, () => current)]);
    const started = deferred(), release = deferred();
    fixture.beforeRelease(() => release.resolve());
    const operation = h.head.own(h.binding, async () => { started.resolve(); await release.promise; });
    await started.promise;
    const pending = local.events.get("agent_before_settle")!(boundary(false));
    void pending.catch(() => {});
    const queued = clock.take();
    try {
      if (change === "retire") h.head.revoke();
      if (change === "during-await") current = SessionManager.inMemory(h.root);
      if (change === "error") await local.events.get("message_end")!({ message: { role: "assistant", stopReason: "error" } });
      if (change === "branch-callback") {
        const original = h.manager.getBranch.bind(h.manager);
        h.manager.getBranch = () => { current = SessionManager.inMemory(h.root); return original(); };
      }
      queued();
      release.resolve(); await operation;
      if (change === "error") expect(await pending).toBeUndefined();
      else await expect(pending).rejects.toThrow("retired");
      expect(clock.pending).toBe(0);
    } finally { release.resolve(); await operation; }
    await h.head.close();
  }
}));


test("public patch registration reaches managed createSession before bind and keeps the parser inside the envelope",
  fixture.ownedCase("official producer boundary", async () => {
    const { root, load } = setup();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--allow-empty", "--quiet", "-m", "initial"], { cwd: root });
    const publicPath = realpathSync(fileURLToPath(new URL("../index.ts", import.meta.resolve("pi-codex-tools"))));
    const patch = {
      name: "apply_patch", label: "controlled public registration", description: "native parser boundary",
      parameters: createFreeformInputSchema("patch", "raw patch"),
      constrainedSampling: createOpenAILarkSampling(APPLY_PATCH_GRAMMAR),
      renderCall: () => ({ render: () => [], invalidate() {} }),
      renderResult: () => ({ render: () => [], invalidate() {} }),
      async execute(_id: string, params: { patch: string }, signal: AbortSignal | undefined, _update: unknown, ctx: { cwd: string }) {
        const details = await applyPatch(params.patch, { cwd: ctx.cwd, signal });
        return { content: [{ type: "text" as const, text: "unchanged native result" }], details };
      },
    };
    const model = { ...controlledModel(), api: "openai-responses", compat: { supportsOpenAIGrammarTools: true } } as ReturnType<typeof controlledModel>;
    for (const included of [true, false]) {
      let delivered: any[] = [], created = false, bound = false;
      let local!: Awaited<ReturnType<typeof bind>>;
      const host = controlledPi(root, { models: [model],
        extensions: included ? [{ resolvedPath: publicPath, tools: new Map([["apply_patch", { definition: patch }]]) }] : [],
        async bind() { expect(created).toBe(true); bound = true; local = await bind(host.loaderInputs[0].extensionFactories); },
        async prompt(session) {
          expect(bound).toBe(true);
          const integration = await local.tools.get("head_plan")!.execute("integration", { action: "beginIntegration", expectedRevision: 0 },
            undefined, undefined, { sessionManager: session.sessionManager });
          expect(integration.isError).not.toBe(true);
          expect(host.loaderInputs[0].additionalExtensionPaths).toEqual([path.resolve(import.meta.dirname, "..")]);
          if (included) {
            const wrapped = delivered.find(tool => tool.name === "apply_patch")!;
            expect(session.active).toContain("apply_patch");
            for (const name of ["parameters", "constrainedSampling", "renderCall", "renderResult"] as const) expect(wrapped[name]).toBe(patch[name]);
            const result = await wrapped.execute("allowed", { patch: "*** Begin Patch\n*** Add File: product.md\n+owned\n*** End Patch\n" },
              undefined, undefined, { cwd: root, model });
            expect(result).toEqual({ content: [{ type: "text", text: "unchanged native result" }], details: { changes: [{ kind: "added", path: "product.md" }] } });
            expect(readFileSync(path.join(root, "product.md"), "utf8")).toBe("owned\n");
            expect(() => wrapped.execute("outside", { patch: "*** Begin Patch\n*** Add File: other.md\n+no\n*** End Patch\n" },
              undefined, undefined, { cwd: root, model })).toThrow("write reservation");
            expect(existsSync(path.join(root, "other.md"))).toBe(false);
          } else {
            expect(delivered.map(tool => tool.name)).not.toContain("apply_patch");
            expect(session.active).toEqual(expect.arrayContaining(["edit", "write"]));
          }
          session.messages.push({ role: "assistant", content: [{ type: "text", text: "checked" }], stopReason: "stop" });
        },
      });
      const create = host.factories.createSession;
      host.factories.createSession = async input => {
        expect(host.sessions).toHaveLength(0); expect(bound).toBe(false);
        delivered = input!.customTools!; created = true;
        expect(delivered.map(tool => tool.name).includes("apply_patch")).toBe(included);
        return create(input);
      };
      const executor = createPiExecutor({ factories: host.factories });
      const head = new HeadAttachment(`public-patch-${included}`, root, {
        writes: ["product.md"], config: loadPitakoConfig(load), executor,
      });
      head.claim("patch-instance", root);
      const outcome = await fixture.acquire(executor.start({ instanceId: "patch-instance",
        role: controlledRole, cwd: root, task: "controlled registration", head, target: { model: "fixture/selected" }, signal: new AbortController().signal }));
      expect(outcome).toMatchObject({ status: "completed", result: "checked" });
      await outcome.session!.dispose();
      await head.close();
      expect(created).toBe(true); expect(bound).toBe(true);
      expect(host.sessions[0]!.events).toEqual(["bind", "session_shutdown", "dispose"]);
    }
  }));
