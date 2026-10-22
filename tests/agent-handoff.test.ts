import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Api, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import { cancelAllWorkers, cancelTeamWorker, clearBackgroundOwner, setBackgroundExecutor, workerStatus, teamWorkerStatus } from "../extensions/agent/background.ts";
import { subscribeChanges } from "../extensions/agent/observe.ts";
import { teamEvaluationForSession } from "../extensions/team.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { captureCallContext, checkCallContext, currentCallContext, reserveEffect, withCallContext, type CallContext } from "../extensions/workflow-engine.ts";
import { currentInstanceId } from "../extensions/agent/scope.ts";
import type { Reservation } from "../extensions/workflow-state.ts";

const fixture = agentFixtureOwnership();
const repo = path.resolve(import.meta.dir, "..");
const settings = () => SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });

for (const scenario of [
  { dispatch: "agent_spawn", outcome: "completed", busy: false },
  { dispatch: "team_assign", outcome: "completed", busy: true },
  { dispatch: "agent_spawn", outcome: "failed", busy: false },
  { dispatch: "team_assign", outcome: "cancelled", busy: true },
] as const) test(`ordinary SDK ${scenario.dispatch} ${scenario.outcome} restores ${scenario.busy ? "busy" : "idle"} principal Bash after release`,
  fixture.ownedCase("ordinary native receiver", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-handoff-"));
    fixture.directories.push(root);
    const agentDir = path.join(root, "storage");
    mkdirSync(path.join(agentDir, "pitako"), { recursive: true });
    writeFileSync(path.join(agentDir, "pitako/config.toml"), '[model_policies.developer.primary]\nmodel = "handoff/local"\n');
    process.env.PI_CODING_AGENT_DIR = agentDir;
    globalThis.fetch = Object.assign(async () => { throw new Error("unexpected network"); },
      { preconnect() { throw new Error("unexpected preconnect"); } });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), continued = Promise.withResolvers<void>();
    const busy = Promise.withResolvers<void>(), releaseParent = Promise.withResolvers<void>();
    fixture.finishOnCleanup(() => release.resolve());
    fixture.finishOnCleanup(() => releaseParent.resolve());
    let parentRequests = 0, childContext: CallContext | undefined, receiver: CallContext | undefined;
    let receiverInstance: string | undefined;
    let releasedAtWake = false;
    const children: Array<Awaited<ReturnType<typeof createAgentSession>>["session"]> = [];
    function response(model: Model<Api>, call?: Pick<ToolCall, "name" | "arguments">, failed = false) {
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: call ? [{ type: "toolCall", id: `handoff-${parentRequests}`, ...call }] : [{ type: "text", text: "done" }],
        stopReason: failed ? "error" : call ? "toolUse" : "stop", ...(failed ? { errorMessage: "controlled child failure" } : {}), timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      if (failed) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      stream.end(); return stream;
    }
    async function runtime(child: boolean) {
      const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, child ? "child-auth" : "parent-auth"),
        modelsPath: null, modelsStorePath: path.join(agentDir, child ? "child-models" : "parent-models"),
        refreshOnCreate: false, allowModelNetwork: false });
      runtime.registerProvider("handoff", { api: "openai-completions", apiKey: "offline", baseUrl: "http://offline.invalid",
        models: [{ id: "local", name: "local", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(model, _context, options) {
          if (child) {
            childContext = currentCallContext();
            entered.resolve();
            const stream = createAssistantMessageEventStream();
            const aborted = Promise.withResolvers<void>();
            const abort = () => aborted.resolve();
            options?.signal?.addEventListener("abort", abort, { once: true });
            void Promise.race([release.promise, aborted.promise]).then(async () => {
              options?.signal?.removeEventListener("abort", abort);
              for await (const event of response(model, undefined, scenario.outcome === "failed")) stream.push(event);
              stream.end();
            });
            return stream;
          }
          const n = parentRequests++;
          if (scenario.busy && n === 1) {
            busy.resolve();
            const stream = createAssistantMessageEventStream();
            void releaseParent.promise.then(async () => {
              for await (const event of response(model)) stream.push(event);
              stream.end();
            });
            return stream;
          }
          if (n === 2) {
            receiver = currentCallContext() ?? captureCallContext(root, session.sessionManager);
            receiverInstance = currentInstanceId();
            const workers = views();
            releasedAtWake = workers.length === 1 && workers[0]!.closure?.state === "released";
          }
          return response(model, n === 0 ? { name: scenario.dispatch, arguments: { role: "developer", task: "Return one offline result." } }
            : n === 2 ? { name: "bash", arguments: { command: "pwd", timeout: 5 } } : undefined);
        },
      });
      return runtime;
    }
    setBackgroundExecutor(createPiExecutor({ factories: {
      createRuntime: () => runtime(true), getAgentDir: () => agentDir, createSettings: settings, createCodemode: () => () => {},
      createLoader(options) {
        return new DefaultResourceLoader({ ...options, noExtensions: true, noSkills: true, noPromptTemplates: true,
          noThemes: true, noContextFiles: true, additionalExtensionPaths: [path.join(repo, "extensions/index.ts")] });
      },
      async createSession(options) {
        const result = await fixture.acquire(createAgentSession(options)); children.push(result.session); return result;
      },
    } }));
    const modelRuntime = await runtime(false), parentSettings = settings();
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: parentSettings, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [path.join(repo, "extensions/index.ts"), path.join(repo, "extensions/agent/index.ts")],
      extensionFactories: [pi => { pi.on("agent_settled", () => { if (parentRequests >= 4) continued.resolve(); }); }] });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await fixture.acquire(createAgentSession({ cwd: root, agentDir, modelRuntime,
      model: modelRuntime.getModel("handoff", "local"), settingsManager: parentSettings, resourceLoader: loader,
      sessionManager: SessionManager.create(root, path.join(agentDir, "sessions")) }));
    const teamToken = () => teamEvaluationForSession(session.sessionManager.getSessionId(), false)!.token;
    function views() { return scenario.dispatch === "team_assign" ? teamWorkerStatus(teamToken()) : workerStatus(); }
    try {
      await session.bindExtensions({});
      const principal = captureCallContext(root, session.sessionManager);
      session.setActiveToolsByName([scenario.dispatch, "bash"]);
      const prompting = fixture.run(session.prompt("Run the offline worker."));
      await entered.promise;
      if (scenario.busy) await busy.promise;
      else await prompting;
      expect(session.isStreaming).toBe(scenario.busy);
      const settled = Promise.withResolvers<void>();
      const stop = subscribeChanges(row => { if (row.status !== "running") settled.resolve(); });
      try {
        if (scenario.outcome === "cancelled") cancelTeamWorker(teamToken(), views().at(-1)!.instanceId);
        else release.resolve();
        await settled.promise;
      } finally { stop(); }
      releaseParent.resolve();
      await prompting;
      await continued.promise;
      await fixture.run(session.waitForIdle());
      await fixture.settleRuns();
      const bash = session.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "bash");
      expect(bash, "principal must actually execute Bash after worker completion").toBeDefined();
      expect(bash!.isError, JSON.stringify(bash)).not.toBe(true);
      expect(JSON.stringify(bash)).toContain(root);
      expect(receiver).toBe(principal);
      expect(receiver).not.toBe(childContext);
      expect(receiverInstance).toBeUndefined();
      expect(releasedAtWake).toBe(true);
      expect(children).toHaveLength(1);
      expect(views().at(-1)).toMatchObject({ status: scenario.outcome, closure: { state: "released" } });
      // The fix must not rehabilitate the original, physically released parent.
      expect(() => withCallContext(childContext!, () =>
        reserveEffect(currentCallContext()!, { reservationId: "late-child", kind: "writer", paths: [root] })))
        .toThrow(/ancestor is unavailable or retired/);
      expect(checkCallContext(principal).store.all<Reservation>("reservations").every(row => row.state === "released")).toBe(true);
    } finally {
      release.resolve();
      releaseParent.resolve();
      await cancelAllWorkers();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await session.dispose();
      clearBackgroundOwner(); setBackgroundExecutor(undefined);
    }
  }));
