import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { HeadAttachment } from "../extensions/agent/head/runtime.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { runAgentInstance, type AgentRunResult } from "../extensions/agent/run.ts";
import { providerFixtureOwnership } from "./fixtures/provider-fixture-ownership.ts";
import { controlledModel, controlledPi } from "./fixtures/pi-factories.ts";

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
  const result = local.tools.get("head_result")!, wait = local.tools.get("head_wait")!;
  expect([...local.tools.keys()]).toEqual(["head_result", "head_wait"]);
  expect(await result.execute("read", { childId: "child-one" })).toMatchObject({ details: undefined });
  const event = local.events.get("agent_before_settle")!;
  expect(await event(boundary())).toBeUndefined();
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
  expect(await event(boundary(false))).toBeUndefined();
  const offered = await event(boundary());
  expect(offered).toMatchObject({ continue: true, entries: [{ customType: "pitako.head.result" }] });
  expect(await event(boundary())).toEqual(offered); // callback return alone is not incorporation
  const envelope = JSON.parse(offered.entries[0].content);
  envelope.result.result = "mutated caller copy";
  expect(JSON.parse((await result.execute("read", { childId: "child-one" })).content[0].text).result.result).toBe("controlled result");
  const entry = offered.entries[0];
  host.sessions[0]!.sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  expect(await event(boundary())).toBeUndefined();
  host.sessions[0]!.sessionManager.getBranch = () => { head.revoke(); return []; };
  expect(() => event(boundary())).toThrow("retired"); // retirement during receipt inspection cannot offer late context
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
