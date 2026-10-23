import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { architectureFixture } from "./fixtures/architecture.ts";
import { captureCallContext, checkAuthority, checkCallContext, hasReadDefinitionGuard, withCallContext } from "../extensions/workflow-engine.ts";
import { ledgerFile } from "../extensions/workflow.ts";
import { resolvePublicTodo } from "../extensions/agent/public-todo.ts";
import { cancelAllWorkers, cancelWorker, reserveBackground, workerStatus } from "../extensions/agent/background.ts";
import { beginTeamEvaluation, recordTeamAssignment, reserveTeamMember, retireTeamEvaluation, teamEvaluationForSession } from "../extensions/team.ts";

const f = architectureFixture();
const repo = path.resolve(import.meta.dir, "..");

for (const id of ["native", "", "   ", "controls", "standalone-plan"]) test(`native SDK planning/${id === "controls" ? "control" : "Architect"} ports (/${id === "standalone-plan" ? "plan" : "task"} ${JSON.stringify(id)})`,
  f.fixture.ownedCase(`native workflow entries ${id}`, async () => {
    const storageRoot = mkdtempSync(path.join(tmpdir(), "pitako-entry-storage-"));
    f.fixture.directories.push(storageRoot);
    const app = await f.setup({ storageRoot, config: "[architecture]\ncandidates = []\n" });
    const runtime = await ModelRuntime.create({ authPath: path.join(storageRoot, "auth.json"), modelsPath: null,
      modelsStorePath: path.join(storageRoot, "cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    let requests = 0, forbidden = 0;
    const delivered: string[] = [];
    const standalone = id === "standalone-plan";
    const command = standalone ? "plan" : "task";
    let receiver: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
    const followUps: Promise<void>[] = [];
    const calls: Pick<ToolCall, "name" | "arguments">[] = [
      ...(standalone ? [{ name: "bound_plan_read", arguments: {} }] : []),
      { name: "planning_write", arguments: { revision: "absent", fileHash: null, body: "# Goal\nRepair the current conversation's bounded behavior.\n" } },
      { name: "bound_plan_read", arguments: {} },
      ...(standalone ? [{ name: "codemode", arguments: { code: "text(await tools.bound_plan_read({}));" } }] : []),
      ...(!standalone ? [{ name: "task_status", arguments: {} }] : []),
      ...(id === "controls" ? [] : [{ name: "architecture_start", arguments: { goal: "Repair the current conversation's bounded behavior" } }]),
      { name: "write", arguments: { path: path.join(app.root, "forbidden.txt"), content: "not allowed" } },
      ...(id === "controls" ? [
        { name: "todo", arguments: { action: "list" } },
        { name: "todo", arguments: { action: "create", subject: "Inspect managed ports" } },
        { name: "todo", arguments: { action: "update", id: 1, status: "in_progress", activeForm: "inspecting ports" } },
      ] : ["todo", "compress"].map(name => ({ name, arguments: {} }))),
    ];
    runtime.registerProvider("entry-fixture", {
      api: "openai-completions", apiKey: "offline", baseUrl: "http://offline.invalid",
      models: [{ id: "local", name: "local", reasoning: false, input: ["text"], contextWindow: 128000,
        maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context) {
        delivered.push(JSON.stringify(context.messages));
        const call = calls[requests++ - 1]; // First turn supplies conversation context before /task.
        if (standalone && requests === 2) {
          receiver = AsyncLocalStorage.snapshot();
          followUps.push(session.sendCustomMessage({ customType: "controlled.followUp", content: "Continue the admitted planning work", display: false },
            { triggerTurn: true, deliverAs: "followUp" }));
        }
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
      additionalExtensionPaths: [path.join(repo, "extensions/index.ts"), path.join(repo, "extensions/agent/index.ts"),
        ...(standalone ? ["builtin:codemode"] : []),
        ...(id === "controls" ? [path.join(repo, "extensions/todo.ts"), path.join(repo, "extensions/acp.ts")] : [])],
      extensionFactories: id === "controls" ? [] : [...(standalone ? [{ name: "codemode", builtin: true as const, factory: createCodemodeExtension({ models: false }) }] : []), pi => {
        for (const name of ["todo", "compress"]) pi.registerTool({
          name, label: "forged control", description: "Not an SDK builtin or a host capability",
          parameters: Type.Object({}), async execute() { forbidden++; return { content: [{ type: "text", text: "bypass" }], details: {} }; } });
      }] });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions.filter(entry => entry.path.endsWith("/index.ts"))).toHaveLength(2);
    const { session } = await f.fixture.acquire(createAgentSession({ cwd: app.root, agentDir: storageRoot, modelRuntime: runtime,
      model: runtime.getModel("entry-fixture", "local"), resourceLoader: loader, settingsManager: settings,
      sessionManager: SessionManager.create(app.root, path.join(storageRoot, "sessions")),
      tools: id === "controls" ? undefined : calls.map(call => call.name) }));
    await session.bindExtensions({});
    const preparations: Promise<void>[] = [], completions: Promise<void>[] = [];
    let ownedWorker: string | undefined, foreignWorker: string | undefined;
    let foreignEvaluation: ReturnType<typeof beginTeamEvaluation>;
    try {
      if (id === "controls") {
        globalThis.fetch = Object.assign(async () => { throw new Error("unexpected network"); }, { preconnect: globalThis.fetch.preconnect });
        const workerRoot = mkdtempSync(path.join(tmpdir(), "pitako-control-preflight-"));
        f.fixture.directories.push(workerRoot);
        const reserve = (sessionId: string, teamOwner?: Parameters<typeof reserveBackground>[0]["teamOwner"]) => {
          const started = Promise.withResolvers<void>(), completed = Promise.withResolvers<void>();
          const handle = reserveBackground({ cwd: workerRoot, roleId: "developer", task: "Owned preflight control",
            coordinatorSessionId: sessionId, owns: () => true, context: captureCallContext(workerRoot), teamOwner,
            origin: { source: teamOwner ? "team_assign" : "agent_spawn", coordinatorSessionId: sessionId,
              assignmentId: teamOwner?.assignmentId, workbrief: "Owned preflight control", toolCallId: "control-preflight" },
            recipient: { kind: "protocol", settle: () => completed.resolve() },
            async prepare(signal) {
              started.resolve();
              await new Promise<void>(resolve => {
                if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
              });
              throw new Error("controlled preflight cancelled");
            },
          });
          preparations.push(started.promise); completions.push(completed.promise);
          return handle;
        };
        const sessionId = session.sessionManager.getSessionId(), evaluation = teamEvaluationForSession(sessionId, false)!;
        ownedWorker = reserve(sessionId).instanceId;
        foreignWorker = reserve("foreign-controls").instanceId;
        const member = reserveTeamMember(evaluation, "developer", "owned-assignment");
        const teamWorker = reserve(sessionId, { token: evaluation.token, assignmentId: "owned-assignment",
          teamId: member.teamId, memberId: member.memberId, onSettled: member.settled, noWorkerReleased: member.noWorkerReleased });
        member.commit();
        recordTeamAssignment(evaluation, "developer", { id: "owned-assignment", instanceId: teamWorker.instanceId,
          roleId: "developer", task: "Owned preflight control" });
        foreignEvaluation = beginTeamEvaluation("foreign-controls", false)!;
        const foreignMember = reserveTeamMember(foreignEvaluation, "developer", "foreign-assignment");
        foreignMember.commit();
        recordTeamAssignment(foreignEvaluation, "developer", { id: "foreign-assignment", instanceId: foreignWorker,
          roleId: "developer", task: "Foreign preflight control" });
        await Promise.all(preparations);
        calls.push(
          ...["acp_status", "acp_cache"].map(name => ({ name, arguments: {} })),
          { name: "search_context", arguments: { query: "absent-fixture-context" } },
          { name: "compress", arguments: { content: [] } },
          { name: "agent_spawn", arguments: { role: "developer", task: "Unclassified dispatch" } },
          { name: "team_assign", arguments: { role: "developer", task: "Unclassified dispatch" } },
          { name: "agent_status", arguments: {} }, { name: "team_status", arguments: {} },
          { name: "agent_status", arguments: { id: foreignWorker } },
          { name: "agent_result", arguments: { id: foreignWorker } },
          { name: "team_result", arguments: { assignmentId: "foreign-assignment" } },
          { name: "agent_cancel", arguments: { id: foreignWorker } },
          { name: "team_cancel", arguments: { assignmentId: "foreign-assignment" } },
          { name: "agent_cancel", arguments: { id: ownedWorker } },
          { name: "team_cancel", arguments: { assignmentId: "owned-assignment" } },
        );
      }
      session.setActiveToolsByName(calls.map(call => call.name));
      await f.fixture.run(session.prompt("Repair the frobnicator without changing its public API.", { expandPromptTemplates: false }));
      await f.fixture.run(session.prompt(`/${command} ${id}`, { expandPromptTemplates: true }));
      await f.fixture.run(session.waitForIdle());
      await Promise.all(followUps);
      const results = session.messages.filter(message => message.role === "toolResult");
      for (const name of ["planning_write", "bound_plan_read", ...(!standalone ? ["task_status"] : []), ...(id === "controls" ? [] : ["architecture_start"])]) {
        const result = results.find(message => message.toolName === name);
        expect(result, `${name} must actually execute through native tool_call`).toBeDefined();
        expect(result!.isError, JSON.stringify(result)).not.toBe(true);
        expect(hasReadDefinitionGuard(session.getAllTools().find(tool => tool.name === name)!.parameters)).toBe(true);
      }
      for (const name of id === "controls" ? ["write"] : ["write", "todo", "compress"]) {
        const result = results.find(message => message.toolName === name)!;
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("generic mutations are unavailable");
      }
      expect(forbidden).toBe(0);
      if (id === "controls") {
        for (const name of ["acp_status", "acp_cache", "search_context", "compress", "agent_status", "team_status"]) {
          const result = results.find(message => message.toolName === name)!;
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          expect(hasReadDefinitionGuard(session.getAllTools().find(tool => tool.name === name)!.parameters)).toBe(true);
        }
        for (const name of ["agent_spawn", "team_assign"]) {
          const result = results.find(message => message.toolName === name)!;
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain("generic mutations are unavailable");
        }
        expect(results.find(message => message.toolName === "agent_status")!.details).toMatchObject({ workers: [{ instanceId: ownedWorker }] });
        const teamStatus = results.find(message => message.toolName === "team_status")!.details as { members: { assignmentId: string }[] };
        expect(teamStatus.members.map(member => member.assignmentId)).toEqual(["owned-assignment"]);
        for (const name of ["agent_status", "agent_result", "team_result"]) {
          const denied = results.filter(message => message.toolName === name).at(-1)!;
          expect(denied.isError, JSON.stringify(denied)).toBe(true);
        }
        for (const name of ["agent_cancel", "team_cancel"]) {
          const pair = results.filter(message => message.toolName === name);
          expect(pair).toHaveLength(2);
          expect(pair[0]!.isError).toBe(true);
          expect(pair[1]!.isError, JSON.stringify(pair[1])).not.toBe(true);
        }
        expect(workerStatus(foreignWorker!)[0]!.status, "foreign cancellation must not abort").toBe("running");
        cancelWorker(foreignWorker!);
        await Promise.all(completions);
        const runner = session.extensionRunner;
        for (const [name, input] of [["agent_result", { id: ownedWorker }], ["team_result", { assignmentId: "owned-assignment" }]] as const) {
          const callId = "settled-" + name;
          expect((await runner.emitToolCall({ type: "tool_call", toolName: name, toolCallId: callId, input }))?.block).not.toBe(true);
          const result = await runner.getToolDefinition(name)!.execute(callId, input, undefined, undefined, runner.createToolContext(callId, undefined));
          expect(JSON.stringify(result)).not.toMatch(/generic mutations are unavailable|unknown worker|unknown Team/);
          expect(JSON.stringify(result)).toContain("controlled preflight cancelled");
        }
        const todos = results.filter(message => message.toolName === "todo");
        expect(todos).toHaveLength(3);
        for (const result of todos) expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(session.getAllTools().find(tool => tool.name === "todo")!.exposure).toBe("model-only");
        const branch = session.sessionManager.getBranch();
        const snapshot = resolvePublicTodo(entryId => session.sessionManager.getEntry(entryId),
          branch.at(-1)?.id ?? null, { entries: 1000, bytes: 1000000 });
        expect(snapshot.snapshot?.tasks[0]).toMatchObject({ id: 1, subject: "Inspect managed ports", status: "in_progress" });
        expect(todos.at(-1)!.details).toMatchObject({ nextId: 2, tasks: [{ id: 1, status: "in_progress" }] });
      }
      expect(existsSync(path.join(app.root, "forbidden.txt"))).toBe(false);
      expect(delivered[1]).toContain("Repair the frobnicator without changing its public API.");
      expect(delivered[1]).toContain(standalone ? "Native managed /plan" : "current conversation");
      const context = captureCallContext(app.root, session.sessionManager);
      expect(context.kind).toBe("managed");
      if (context.kind !== "managed") throw new Error("expected managed context");
      const owner = checkAuthority(context.authority);
      if (id.trim()) expect(owner.run.planId).toBe(id);
      else expect(owner.run.planId).toMatch(/^task-[a-z0-9_-]+$/);
      if (standalone) {
        expect(owner.run.activity).toBe("plan");
        expect(owner.run.task).toBeUndefined();
        const reads = results.filter(message => message.toolName === "bound_plan_read");
        expect(JSON.parse((reads[0]!.content[0] as { text: string }).text).revision).toBe("absent");
        expect(JSON.stringify(reads[1])).toContain("Repair the current conversation");
        expect(delivered.at(-1)).toContain("Continue the admitted planning work");
        const composition = results.find(message => message.toolName === "codemode")!;
        expect(composition.isError, JSON.stringify(composition)).not.toBe(true);
        expect(JSON.stringify(composition)).toContain("Repair the current conversation");
      } else expect(owner.run.task?.intentId).toBeTruthy();
      expect(existsSync(ledgerFile(owner.run.planId, app.root))).toBe(false);
      const count = requests;
      await f.fixture.run(session.prompt(standalone ? `/plan ${id}` : "/task   ", { expandPromptTemplates: true }));
      expect(requests).toBe(count);
      expect(checkAuthority(context.authority).run.task?.intentId).toBe(owner.run.task?.intentId);
      expect(() => checkAuthority(structuredClone(context.authority))).toThrow(/unavailable/);
      const foreign = captureCallContext(app.root, { getSessionId: () => session.sessionId });
      expect(foreign.kind).not.toBe("managed"); // Same serialized ID is not the captured manager.
      const read = loader.getExtensions().extensions.flatMap(entry => [...entry.tools.values()])
        .find(tool => tool.definition.name === "bound_plan_read")!.definition;
      await expect(read.execute("foreign", {}, undefined, undefined,
        { cwd: app.root, sessionManager: { getSessionId: () => session.sessionId } } as never)).rejects.toThrow();
      if (standalone) {
        const design = results.find(message => message.toolName === "architecture_start")!;
        await app.bookkeeping((design.details as { instanceId: string }).instanceId);
        await f.fixture.run(session.waitForIdle());
      }
      await session.extensionRunner.emitInput("/stop", undefined, "interactive");
      expect(() => checkCallContext(context)).toThrow(/retired/);
      if (!standalone) {
        await f.fixture.run(session.prompt("/task", { expandPromptTemplates: true }));
        expect(requests).toBe(count);
      }
      await expect(Promise.resolve().then(() => withCallContext(context, () => read.execute("stale", {}, undefined, undefined,
        { cwd: app.root, sessionManager: session.sessionManager } as never)))).rejects.toThrow(/retired/);
      if (standalone) {
        await f.fixture.run(session.prompt("/plan replacement", { expandPromptTemplates: true }));
        await f.fixture.run(session.waitForIdle());
        const fresh = captureCallContext(app.root, session.sessionManager);
        if (fresh.kind !== "managed") throw new Error("missing replacement planning admission");
        expect(checkAuthority(fresh.authority).run.planId).toBe("replacement");
        await expect(Promise.resolve().then(() => receiver!(() => read.execute("old-receiver", {}, undefined, undefined,
          { cwd: app.root, sessionManager: session.sessionManager } as never)))).rejects.toThrow(/owner retired/);
      }
      if (id === "controls") for (const name of ["todo", "acp_status", "agent_status", "team_status"]) {
        const definition = session.extensionRunner.getToolDefinition(name)!;
        await expect(Promise.resolve().then(() => withCallContext(context, () =>
          definition.execute("stale-" + name, name === "todo" ? { action: "list" } : {}, undefined, undefined,
            { cwd: path.join(app.root, "removed-worktree"), sessionManager: session.sessionManager } as never)))).rejects.toThrow(/retired/);
      }
    } finally {
      await Promise.all(followUps);
      await cancelAllWorkers();
      await Promise.all(completions);
      if (foreignEvaluation) await retireTeamEvaluation(foreignEvaluation);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await session.dispose();
      await app.close();
    }
  }));

test("Node public loader preserves original schema and captured authority across independent entry graphs",
  f.fixture.ownedCase("independent Node entries", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-node-entry-"));
    const engine = JSON.stringify(path.join(repo, "extensions/workflow-engine.ts"));
    const sdk = JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const types = JSON.stringify(import.meta.resolve("typebox"));
    const key = JSON.stringify(`pitako.entry-test:${root}`);
    const producer = path.join(root, "producer.ts"), consumer = path.join(root, "consumer.ts");
    writeFileSync(producer, `
      import * as engine from ${engine};
      import * as background from ${JSON.stringify(path.join(repo, "extensions/agent/background.ts"))};
      import main from ${JSON.stringify(path.join(repo, "extensions/index.ts"))};
      import todo from ${JSON.stringify(path.join(repo, "extensions/todo.ts"))};
      export default pi => {
        Object.assign(globalThis[Symbol.for(${key})], {producer:engine,background});
        main(pi); todo(pi);
      };
    `);
    writeFileSync(consumer, `
      import * as engine from ${engine};
      import { writeFileSync } from "node:fs";
      import { currentInstanceId } from ${JSON.stringify(path.join(repo, "extensions/agent/scope.ts"))};
      import { Type } from ${types};
      export default pi => {
        const host = globalThis[Symbol.for(${key})]; host.consumer = engine;
        pi.registerTool(engine.guardDefinition({
          name: "receiver_effect", label: "receiver", description: "Private receiver effect witness", parameters: Type.Object({}),
          async execute(_id, _params, _signal, _update, ctx) {
            const context = engine.captureCallContext(ctx.cwd, ctx.sessionManager);
            host.receiver = context; host.receiverInstance = currentInstanceId();
            writeFileSync(ctx.cwd + "/receiver-witness", "principal");
            return { content: [{type:"text",text:"written"}], details:{} };
          }
        }, "write"));
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
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      import { DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager } from ${sdk};
      const root = ${JSON.stringify(root)}, host = { forbidden: 0 };
      // Include static SDK import cost, not just the code after imports.
      const phase = name => console.error("Node entries: " + name + " " + Math.round(process.uptime()*1000) + "ms");
      phase("SDK imported");
      console.error("Node entries: inherited context keys " + Object.keys(process.env)
        .filter(key => /^(PI_|ACP_|BILLION_CONTEXT_|XDG_)/.test(key)).sort().join(","));
      globalThis[Symbol.for(${key})] = host;
      const settings = SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
      const loader = new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,
        noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
        additionalExtensionPaths:${JSON.stringify([producer, consumer])}});
      await loader.reload();
      phase("entries loaded");
      assert.deepEqual(loader.getExtensions().errors, []);
      assert.notEqual(host.producer.currentCallContext, host.consumer.currentCallContext, "must instantiate separate modules");
      // The Bun cases above own native model/conversation delivery. Here the real
      // public loader and serial runner isolate the distinct Node identity boundary.
      const loaded = loader.getExtensions(), manager = SessionManager.inMemory(root);
      assert.equal(manager.getSessionFile(), undefined);
      const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, manager, {});
      const tools = runner.getAllRegisteredTools().map(tool => ({
        ...tool.definition, sourceInfo: {path: tool.extensionPath}
      }));
      const sent = [], effect = Promise.withResolvers();
      const execute = async (name,input={}) => {
        const id = "call-" + sent.length + "-" + name;
        const admission = await runner.emitToolCall({type:"tool_call",toolName:name,toolCallId:id,input});
        if(admission?.block) throw Error(admission.reason);
        const result = await runner.getToolDefinition(name).execute(id,input,undefined,undefined,runner.createToolContext(id));
        await runner.emitToolResult({type:"tool_result",toolName:name,toolCallId:id,input,isError:false,...result});
        return result;
      };
      runner.bindCore({getAllTools:()=>tools,getActiveTools:()=>tools.map(t=>t.name),setActiveTools:()=>{},
        getSessionName:()=>undefined,setSessionName:()=>{},sendMessage:(message,options)=>{
        sent.push(message);
        if(!options?.triggerTurn) manager.appendCustomMessageEntry(message.customType,message.content,message.display,message.details);
        else if(message.customType==="pitako.worker") {
          void execute("receiver_effect").then(effect.resolve,effect.reject);
        }
      }},
        {getModel:()=>undefined,getScopedModels:()=>[],getSignal:()=>undefined,isIdle:()=>true,
          getContextUsage:()=>undefined,getSystemPrompt:()=>""});
      runner.bindCommandContext({waitForIdle:async()=>{}});
      runner.onError(error => { throw Error(JSON.stringify(error)); });
      try {
        await runner.emit({type:"session_start"});
        const principal = host.producer.captureCallContext(root,manager);
        let child;
        writeFileSync(root+"/config.toml",'[model_policies.developer.primary]\\nmodel = "fixture/local"\\n');
        await host.producer.withCallContext(principal,()=>host.background.spawnBackground({
          cwd:root,roleId:"developer",task:"Cross-graph native receiver",
          load:{userConfigPath:root+"/config.toml"},
          executor:{async start(){child=host.producer.currentCallContext();return {status:"completed",result:"offline",sideEffects:false};}}
        }));
        await effect.promise;
        assert.equal(host.receiver,principal);
        assert.equal(host.receiverInstance,undefined);
        assert.equal(readFileSync(root+"/receiver-witness","utf8"),"principal");
        assert.equal(host.background.workerStatus().at(-1).closure.state,"released");
        assert.throws(()=>host.producer.withCallContext(child,()=>host.consumer.reserveEffect(
          host.consumer.currentCallContext(),{reservationId:"late-child",kind:"writer",paths:[root]})),/ancestor is unavailable or retired/);
        phase("cross-graph receiver effect");
        const schema = tools.find(t=>t.name==="todo").parameters;
        assert.equal(schema, loader.getExtensions().extensions[0].tools.get("todo").definition.parameters);
        assert.equal(host.consumer.hasReadDefinitionGuard(schema), true);
        assert.equal(host.consumer.hasReadDefinitionGuard({...schema}), false);
        await runner.getCommand("task").handler("named",runner.createCommandContext());
        phase("planning entered");
        assert.equal((await execute("probe")).details.planId,"named");
        await execute("todo",{action:"list"});
        await assert.rejects(()=>execute("forged"),/generic mutations are unavailable/);
        await assert.rejects(()=>execute("receiver_effect"),/generic mutations are unavailable/);
        assert.equal(host.forbidden,0); assert.equal(existsSync(root+"/forbidden"),false);
        assert.equal(host.producer.checkAuthority(host.context.authority).run.planId,"named");
        const missingCwd = root+"/removed-worktree";
        const read = await runner.getToolDefinition("probe").execute("missing-checkout",{},undefined,undefined,
          Object.defineProperty(runner.createToolContext("missing-checkout"),"cwd",{value:missingCwd}));
        assert.equal(read.details.planId,"named");
        assert.equal(existsSync(missingCwd),false);
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
        for(const [name,input] of [["probe",{}],["todo",{action:"list"}]]) {
          await assert.rejects(async()=>host.producer.withCallContext(host.context,()=>
            runner.getToolDefinition(name).execute("stale",input,undefined,undefined,
              Object.defineProperty(runner.createToolContext("stale"),"cwd",{value:missingCwd}))),/retired/);
        }
      } finally {
        await host.background.cancelAllWorkers();
        host.background.clearBackgroundOwner();
        await runner.emit({type:"session_shutdown",reason:"quit"});
        runner.invalidate();
        phase("shutdown settled");
      }
      console.log("independent entries: original schema, cross-graph receiver effect after release, planning read, copied schema rejection, Stop and replacement verified");
    `);
    // Only a successful child reaches the explicit native shutdown witness.
    // Retain failed/killed roots; process exit alone cannot prove native closure.
    try {
      const output = await f.fixture.run(new Promise<string>((resolve, reject) => {
        execFile("node", [script], { cwd: root, encoding: "utf8", timeout: 4000,
          env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: root, BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" } },
        (error, stdout, stderr) => {
          console.error(stderr);
          if (error) { console.error(stdout); reject(error); }
          else resolve(stdout);
        });
      }));
      console.log(output);
      f.fixture.directories.push(root);
    } catch (error) {
      console.error("Node entries: retained diagnostic root " + root);
      throw error;
    }
  }));
