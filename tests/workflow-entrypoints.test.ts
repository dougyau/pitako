import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { architectureFixture } from "./fixtures/architecture.ts";
import { captureCallContext, checkAuthority, checkCallContext, hasReadDefinitionGuard, withCallContext } from "../extensions/workflow-engine.ts";
import { ledgerFile } from "../extensions/workflow.ts";

const f = architectureFixture();
const repo = path.resolve(import.meta.dir, "..");

for (const id of ["native", "", "   "]) test(`native SDK planning/Architect ports and contextual task (/task ${JSON.stringify(id)})`,
  f.fixture.ownedCase(`native workflow entries ${id}`, async () => {
    const storageRoot = mkdtempSync(path.join(tmpdir(), "pitako-entry-storage-"));
    f.fixture.directories.push(storageRoot);
    const app = await f.setup({ storageRoot, config: "[architecture]\ncandidates = []\n" });
    const runtime = await ModelRuntime.create({ authPath: path.join(storageRoot, "auth.json"), modelsPath: null,
      modelsStorePath: path.join(storageRoot, "cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    let requests = 0, forbidden = 0;
    const delivered: string[] = [];
    const calls: Pick<ToolCall, "name" | "arguments">[] = [
      { name: "planning_write", arguments: { revision: "absent", fileHash: null, body: "# Goal\nRepair the current conversation's bounded behavior.\n" } },
      { name: "bound_plan_read", arguments: {} },
      { name: "task_status", arguments: {} },
      { name: "architecture_start", arguments: { goal: "Repair the current conversation's bounded behavior" } },
      { name: "write", arguments: { path: path.join(app.root, "forbidden.txt"), content: "not allowed" } },
      { name: "todo", arguments: {} },
    ];
    runtime.registerProvider("entry-fixture", {
      api: "openai-completions", apiKey: "offline", baseUrl: "http://offline.invalid",
      models: [{ id: "local", name: "local", reasoning: false, input: ["text"], contextWindow: 128000,
        maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context) {
        delivered.push(JSON.stringify(context.messages));
        const call = calls[requests++ - 1]; // First turn supplies conversation context before /task.
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: call ? [{ type: "toolCall", id: `entry-${requests}`, ...call }] : [{ type: "text", text: "done" }],
          stopReason: call ? "toolUse" : "stop", timestamp: requests,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: call ? "toolUse" : "stop", message }); stream.end(); return stream;
      },
    });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: app.root, agentDir: storageRoot, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      // Load the declared composition from disk; the Node case below additionally proves graph separation.
      additionalExtensionPaths: [path.join(repo, "extensions/index.ts"), path.join(repo, "extensions/agent/index.ts")],
      extensionFactories: [pi => {
        pi.registerTool({ name: "todo", label: "forged bookkeeping", description: "Not an SDK builtin or a host capability",
          parameters: Type.Object({}), async execute() { forbidden++; return { content: [{ type: "text", text: "bypass" }], details: {} }; } });
      }] });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions.filter(entry => entry.path.endsWith("/index.ts"))).toHaveLength(2);
    const { session } = await f.fixture.acquire(createAgentSession({ cwd: app.root, agentDir: storageRoot, modelRuntime: runtime,
      model: runtime.getModel("entry-fixture", "local"), resourceLoader: loader, settingsManager: settings,
      sessionManager: SessionManager.create(app.root, path.join(storageRoot, "sessions")), tools: calls.map(call => call.name) }));
    await session.bindExtensions({});
    session.setActiveToolsByName(calls.map(call => call.name));
    try {
      await f.fixture.run(session.prompt("Repair the frobnicator without changing its public API.", { expandPromptTemplates: false }));
      await f.fixture.run(session.prompt(`/task ${id}`, { expandPromptTemplates: true }));
      await f.fixture.run(session.waitForIdle());
      const results = session.messages.filter(message => message.role === "toolResult");
      for (const name of ["planning_write", "bound_plan_read", "task_status", "architecture_start"]) {
        const result = results.find(message => message.toolName === name);
        expect(result, `${name} must actually execute through native tool_call`).toBeDefined();
        expect(result!.isError, JSON.stringify(result)).not.toBe(true);
        expect(hasReadDefinitionGuard(session.getAllTools().find(tool => tool.name === name)!.parameters)).toBe(true);
      }
      for (const name of ["write", "todo"]) {
        const result = results.find(message => message.toolName === name)!;
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("generic mutations are unavailable");
      }
      expect(forbidden).toBe(0);
      expect(existsSync(path.join(app.root, "forbidden.txt"))).toBe(false);
      expect(delivered[1]).toContain("Repair the frobnicator without changing its public API.");
      expect(delivered[1]).toContain("current conversation");
      const context = captureCallContext(app.root, session.sessionManager);
      expect(context.kind).toBe("managed");
      if (context.kind !== "managed") throw new Error("expected managed context");
      const owner = checkAuthority(context.authority);
      if (id.trim()) expect(owner.run.planId).toBe(id);
      else expect(owner.run.planId).toMatch(/^task-[a-z0-9_-]+$/);
      expect(owner.run.task?.intentId).toBeTruthy();
      expect(existsSync(ledgerFile(owner.run.planId, app.root))).toBe(false);
      const count = requests;
      await f.fixture.run(session.prompt("/task   ", { expandPromptTemplates: true }));
      expect(requests).toBe(count);
      expect(checkAuthority(context.authority).run.task?.intentId).toBe(owner.run.task?.intentId);
      expect(() => checkAuthority(structuredClone(context.authority))).toThrow(/unavailable/);
      const foreign = captureCallContext(app.root, { getSessionId: () => session.sessionId });
      expect(foreign.kind).not.toBe("managed"); // Same serialized ID is not the captured manager.
      const read = loader.getExtensions().extensions.flatMap(entry => [...entry.tools.values()])
        .find(tool => tool.definition.name === "bound_plan_read")!.definition;
      await expect(read.execute("foreign", {}, undefined, undefined,
        { cwd: app.root, sessionManager: { getSessionId: () => session.sessionId } } as never)).rejects.toThrow();
      await session.extensionRunner.emitInput("/stop", undefined, "interactive");
      expect(() => checkCallContext(context)).toThrow(/retired/);
      await f.fixture.run(session.prompt("/task", { expandPromptTemplates: true }));
      expect(requests).toBe(count);
      await expect(Promise.resolve().then(() => withCallContext(context, () => read.execute("stale", {}, undefined, undefined,
        { cwd: app.root, sessionManager: session.sessionManager } as never)))).rejects.toThrow(/retired/);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await session.dispose();
      await app.close();
    }
  }));

test("Node public loader preserves original schema and captured authority across independent entry graphs",
  f.fixture.ownedCase("independent Node entries", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-node-entry-"));
    f.fixture.directories.push(root);
    const engine = JSON.stringify(path.join(repo, "extensions/workflow-engine.ts"));
    const sdk = JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const types = JSON.stringify(import.meta.resolve("typebox"));
    const key = JSON.stringify(`pitako.entry-test:${root}`);
    const producer = path.join(root, "producer.ts"), consumer = path.join(root, "consumer.ts");
    writeFileSync(producer, `
      import * as engine from ${engine};
      export default pi => {
        globalThis[Symbol.for(${key})].producer = engine;
        engine.registerWorkflowCommands(pi);
      };
    `);
    writeFileSync(consumer, `
      import * as engine from ${engine};
      import { principalLeases } from ${JSON.stringify(path.join(repo, "extensions/agent/head/operation-leases.ts"))};
      import { Type } from ${types};
      export default pi => {
        const host = globalThis[Symbol.for(${key})]; host.consumer = engine;
        principalLeases(pi, { async exec() { throw Error("unexpected foreground execution"); } });
        const probe = engine.guardDefinition({
          name: "probe", label: "probe", description: "Read captured planning context", parameters: Type.Object({}),
          async execute(_id, _params, _signal, _update, ctx) {
            const context = engine.captureCallContext(ctx.cwd, ctx.sessionManager);
            if (context.kind !== "managed") throw Error("missing captured context");
            const owner = engine.checkAuthority(context.authority);
            host.context = context;
            return { content: [{type: "text", text: engine.planningSlot(context.authority).read().text ?? "absent"}], details: {planId: owner.run.planId} };
          }
        }, "read");
        pi.registerTool(probe);
        pi.registerTool({ name: "forged", label: "forged", description: "Copied read schema is not a capability",
          parameters: {...probe.parameters},
          async execute() { host.forbidden++; return {content: [], details: {}}; } });
      };
    `);
    // Node, unlike Bun's native TS import cache, exercises Pi's per-entry Jiti graphs.
    const script = path.join(root, "check.mjs");
    writeFileSync(script, `
      import assert from "node:assert/strict";
      import { existsSync } from "node:fs";
      import { DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager } from ${sdk};
      const root = ${JSON.stringify(root)}, host = { forbidden: 0 };
      globalThis[Symbol.for(${key})] = host;
      const calls = [
        ["planning_write", {revision:"absent",fileHash:null,body:"# Goal\\nCaptured planning"}],
        ["bound_plan_read", {}], ["task_status", {}], ["probe", {}],
        ["write", {path:root+"/forbidden",content:"bypass"}], ["forged", {}]
      ];
      const settings = SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
      const loader = new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,
        noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
        additionalExtensionPaths:${JSON.stringify([producer, consumer])}});
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      assert.notEqual(host.producer.currentCallContext, host.consumer.currentCallContext, "must instantiate separate modules");
      // The Bun cases above own native model/conversation delivery. Here the real
      // public loader and serial runner isolate the distinct Node identity boundary.
      const loaded = loader.getExtensions(), manager = SessionManager.inMemory(root);
      const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, manager, {});
      const tools = runner.getAllRegisteredTools().map(tool => ({
        ...tool.definition, sourceInfo: {path: tool.extensionPath}
      }));
      const sent = [];
      runner.bindCore({getAllTools:()=>tools,sendMessage:(message)=>sent.push(message)},
        {getModel:()=>undefined,getScopedModels:()=>[],getSignal:()=>undefined,isIdle:()=>true});
      runner.bindCommandContext({waitForIdle:async()=>{}});
      runner.onError(error => { throw Error(JSON.stringify(error)); });
      try {
        const schema = tools.find(t=>t.name==="planning_write").parameters;
        assert.equal(schema, loader.getExtensions().extensions[0].tools.get("planning_write").definition.parameters);
        assert.equal(host.consumer.hasReadDefinitionGuard(schema), true);
        assert.equal(host.consumer.hasReadDefinitionGuard({...schema}), false);
        await runner.getCommand("task").handler("named",runner.createCommandContext());
        assert.equal(sent.length,1);
        const results = [];
        for (const [name,input] of calls) {
          const id = "call-" + results.length;
          const admission = await runner.emitToolCall({type:"tool_call",toolName:name,toolCallId:id,input});
          if (admission?.block) results.push({toolName:name,isError:true,reason:admission.reason});
          else {
            const result = await runner.getToolDefinition(name).execute(id,input,undefined,undefined,runner.createToolContext(id));
            results.push({toolName:name,isError:false,...result});
            await runner.emitToolResult({type:"tool_result",toolName:name,toolCallId:id,input,...result,isError:false});
          }
        }
        for(const name of ["planning_write","bound_plan_read","task_status","probe"]) {
          const result = results.find(m=>m.toolName===name); assert.ok(result, name); assert.equal(result.isError,false,JSON.stringify(result));
        }
        for(const name of ["write","forged"]) {
          const result = results.find(m=>m.toolName===name); assert.equal(result.isError,true);
          assert.match(JSON.stringify(result),/generic mutations are unavailable/);
        }
        assert.equal(host.forbidden,0); assert.equal(existsSync(root+"/forbidden"),false);
        assert.equal(host.producer.checkAuthority(host.context.authority).run.planId,"named");
        assert.throws(()=>host.consumer.checkAuthority(structuredClone(host.context.authority)),/unavailable/);
        const foreign = {getSessionId:()=>manager.getSessionId()};
        assert.notEqual(host.consumer.captureCallContext(root,foreign).kind,"managed");
        await assert.rejects(()=>runner.getToolDefinition("probe").execute("foreign",{},undefined,undefined,
          {cwd:root,sessionManager:foreign}));
        host.producer.withCallContext(host.context,()=>assert.equal(host.consumer.currentCallContext(),host.context));
        await runner.emitInput("/stop",undefined,"interactive");
        assert.throws(()=>host.consumer.checkCallContext(host.context),/retired/);
        await runner.getCommand("plan").handler("replacement",runner.createCommandContext());
        const fresh = host.consumer.captureCallContext(root,manager);
        assert.equal(host.consumer.checkAuthority(fresh.authority).run.planId,"replacement");
        assert.throws(()=>host.producer.checkCallContext(host.context),/retired/);
        await assert.rejects(async()=>host.producer.withCallContext(host.context,()=>
          runner.getToolDefinition("probe").execute("stale",{},undefined,undefined,runner.createToolContext("stale"))),/retired/);
      } finally {
        await runner.emit({type:"session_shutdown",reason:"quit"});
        runner.invalidate();
      }
      console.log("independent entries: original schema, serial tool_call, authority, rejection, Stop and replacement verified");
    `);
    console.log(execFileSync("node", [script], { cwd: root, encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: root, BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" } }));
  }));
