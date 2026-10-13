import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { providerFixtureOwnership } from "./fixtures/provider-fixture-ownership.ts";

const ownership = providerFixtureOwnership();
const gate = () => {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
};

test("real offline SDK exposes post-append IDs, branch/session hooks and settled final reconciliation",
  ownership.ownedCase("public SDK premise", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-public-sdk-"));
    ownership.directories.push(root);
    const entered = gate(), finishTool = gate(), shutdownEntered = gate(), finishShutdown = gate();
    ownership.beforeRelease(() => { finishTool.release(); finishShutdown.release(); });
    const runtime = await ModelRuntime.create({
      authPath: path.join(root, "auth.json"), modelsPath: null,
      modelsStorePath: path.join(root, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false,
    });
    let requests = 0;
    runtime.registerProvider("public-fixture", {
      api: "openai-completions", apiKey: "offline-fixture", baseUrl: "http://offline.invalid",
      models: [{ id: "local", name: "local", reasoning: false, input: ["text"], contextWindow: 128_000,
        maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model) {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: ++requests === 1 ? [{ type: "text", text: "repeat" },
            { type: "toolCall", id: "native-call", name: "barrier", arguments: { value: "public" } }]
            : [{ type: "text", text: "repeat" }],
          stopReason: requests === 1 ? "toolUse" : "stop", timestamp: 1000 + requests,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
        stream.end();
        return stream;
      },
    });
    const starts: Array<{ reason: string; sessionId: string }> = [];
    const branches: Array<{ newLeafId: string | null; oldLeafId: string | null }> = [];
    let shutdownSettled = false;
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.on("session_start", (event, ctx) => { starts.push({ reason: event.reason, sessionId: ctx.sessionManager.getSessionId() }); });
        pi.on("session_tree", event => { branches.push({ newLeafId: event.newLeafId, oldLeafId: event.oldLeafId }); });
        pi.on("session_shutdown", async () => {
          shutdownEntered.release();
          await finishShutdown.promise;
          shutdownSettled = true;
        });
      }],
    });
    await loader.reload();
    const create = (reason: "startup" | "new") => ownership.acquire(createAgentSession({
      cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel("public-fixture", "local"),
      resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.create(root, path.join(root, "sessions")),
      tools: ["barrier"], sessionStartEvent: { type: "session_start", reason },
      customTools: [{
        name: "barrier", label: "barrier", description: "offline barrier", parameters: Type.Object({ value: Type.String() }),
        async execute() {
          entered.release();
          await finishTool.promise;
          return { content: [{ type: "text", text: "tool result" }], details: { private: "not public" } };
        },
      }],
    }));
    const { session } = await create("startup");
    await session.bindExtensions({});
    const beforeAppend: Array<string | null> = [];
    const afterAppend: Array<{ id: string; parentId: string | null }> = [];
    session.subscribe(event => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      beforeAppend.push(session.sessionManager.getLeafId());
      queueMicrotask(() => {
        const entry = session.sessionManager.getEntry(session.sessionManager.getLeafId()!);
        if (entry?.type === "message" && entry.message.role === "assistant") {
          afterAppend.push({ id: entry.id, parentId: entry.parentId });
        }
      });
    });
    const run = ownership.run(session.prompt("repeat", { expandPromptTemplates: false }));
    await entered.promise;
    expect(session.isStreaming).toBe(true);
    expect(afterAppend).toHaveLength(1);
    expect(afterAppend[0]!.id).not.toBe(beforeAppend[0]);
    expect(afterAppend[0]!.parentId).toBe(beforeAppend[0]);
    expect(session.sessionManager.getEntry(afterAppend[0]!.id)?.type).toBe("message");
    finishTool.release();
    await run;
    expect(afterAppend).toHaveLength(2);
    expect(afterAppend[1]!.id).not.toBe(afterAppend[0]!.id);
    const priorHead = session.sessionManager.getLeafId();
    await session.navigateTree(afterAppend[0]!.id);
    expect(branches).toEqual([{ oldLeafId: priorHead, newLeafId: afterAppend[0]!.id }]);
    const closing = session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await shutdownEntered.promise;
    expect(shutdownSettled).toBe(false);
    finishShutdown.release();
    await closing;
    await session.dispose();
    expect(shutdownSettled).toBe(true);
    expect(session.sessionManager.getEntry(afterAppend[1]!.id)?.type).toBe("message");
    expect(session.sessionManager.getLeafId()).toBe(afterAppend[0]!.id);
    const { session: replacement } = await create("new");
    await replacement.bindExtensions({});
    expect(starts).toEqual([{ reason: "startup", sessionId: session.sessionId }, { reason: "new", sessionId: replacement.sessionId }]);
    expect(replacement.sessionId).not.toBe(session.sessionId);
    await replacement.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await replacement.dispose();
    console.log(JSON.stringify({ premise: "offline SDK", beforeAppend, afterAppend, branches, starts, shutdownSettled,
      finalHead: session.sessionManager.getLeafId(), requests }));
  }));
