import { afterEach, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentExtension from "../extensions/agent/index.ts";
import { bindBackgroundOwner, clearBackgroundOwner, deliverWorkerResults, setBackgroundExecutor, spawnBackground, type ResultMessage } from "../extensions/agent/background.ts";
import { clearObservations, listObservations } from "../extensions/agent/observe.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createAgentController } from "../extensions/agent/controller.ts";
import { createAgentBridge } from "../extensions/agent/bridge/broker.ts";
import { connect, type BridgeClient } from "../extensions/agent/bridge/client.js";
import type { PublicConversationPage, PublicRecord, PublicWorkerDetail, WorkerReadReference } from "../extensions/agent/bridge/protocol.js";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import { PublicConversation } from "../extensions/agent/public-conversation.ts";
import type { AttemptExecutor } from "../extensions/agent/run.ts";
import { beginTeamEvaluation, retireTeamEvaluation } from "../extensions/team.ts";

const fixture = agentFixtureOwnership();
const oldDir = process.env.PI_CODING_AGENT_DIR;
const oldChild = process.env.PITAKO_INSTANCE_ID;
afterEach(() => {
  fixture.requireReleasedFixture();
  setBackgroundExecutor(undefined); clearBackgroundOwner(); clearObservations();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldChild === undefined) delete process.env.PITAKO_INSTANCE_ID; else process.env.PITAKO_INSTANCE_ID = oldChild;
});
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function records(client: BridgeClient, ref: WorkerReadReference, cursor?: string) {
  const output: PublicRecord[] = [];
  const parts = new Map<string, Buffer[]>();
  let first: PublicConversationPage | undefined;
  let next = cursor;
  for (;;) {
    const page = await client.publicActivity(ref, next);
    if (!("changes" in page)) throw Error(JSON.stringify(page));
    first ??= page;
    expect(page.changes.length).toBeLessThanOrEqual(50);
    const envelope = { version: 2, id: "1", clientId: client.lease.clientId, owner: client.owner, ok: true, result: page };
    expect(Buffer.byteLength(JSON.stringify(envelope)) + 1).toBeLessThanOrEqual(48 * 1024);
    for (const record of page.changes) {
      if (!("kind" in record)) { output.push(record.record); continue; }
      const key = `${record.id}:${record.revision}`;
      const chunks = parts.get(key) ?? [];
      expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(record.byteOffset);
      chunks.push(Buffer.from(record.data, "base64")); parts.set(key, chunks);
      if (record.byteOffset + chunks.at(-1)!.length === record.totalBytes) {
        output.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).record); parts.delete(key);
      }
    }
    next = page.next ?? undefined;
    if (!page.more || !next) {
      expect(parts.size).toBe(0);
      return { output, next, first };
    }
  }
}

for (const method of ["agent_spawn", "team_assign"] as const) {
  const toolError = method === "team_assign";
  test(`${method} composes the real SDK producer, bridge and published Node reader through live ${toolError ? "errors" : "upserts"} and independent closure`,
  fixture.ownedCase(`native public conversation ${toolError}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-public-"));
    fixture.directories.push(root);
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PITAKO_INSTANCE_ID;
    mkdirSync(path.join(root, "pitako"));
    const config = path.join(root, "pitako/config.toml");
    writeFileSync(config, '[model_policies.researcher]\nprimary = { model = "public-fixture/local", reasoning = "off" }\n');
    const toolEntered = gate(), toolRelease = gate(), shutdownEntered = gate(), shutdownRelease = gate();
    const providerEntered = gate(), providerRelease = gate();
    const disposalEntered = gate(), disposalRelease = gate();
    const nativeRelease = gate();
    fixture.finishOnCleanup(() => { nativeRelease.release(); toolRelease.release(); providerRelease.release(); shutdownRelease.release(); disposalRelease.release(); });
    const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null,
      modelsStorePath: path.join(root, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    let requests = 0;
    const large = '漢😀"\\\n'.repeat(9000);
    runtime.registerProvider("public-fixture", {
      api: "openai-completions", apiKey: "OFFLINE_MANAGED_CREDENTIAL", baseUrl: "http://offline.invalid",
      models: [{ id: "local", name: "local", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model) {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: ++requests === 1 ? [{ type: "thinking", thinking: "PRIVATE_THINKING", thinkingSignature: "PRIVATE_SIGNATURE" },
            { type: "text", text: "repeat" }, { type: "toolCall", id: "real-tool-id", name: "read", arguments: { path: large } }]
            : [{ type: "text", text: "repeat" }],
          stopReason: requests === 1 ? "toolUse" : "stop", timestamp: 1000 + requests,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (requests === 1) {
          stream.push({ type: "done", reason: "toolUse", message }); stream.end();
        } else {
          fixture.run((async () => {
            providerEntered.release(); await providerRelease.promise;
            stream.push({ type: "done", reason: "stop", message }); stream.end();
          })());
        }
        return stream;
      },
    });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const sessions: AgentSession[] = [];
    const executor = createPiExecutor({ factories: {
      createRuntime: async () => { await nativeRelease.promise; return runtime; },
      getAgentDir: () => root,
      createSettings: () => settings,
      createCodemode: () => () => {},
      createLoader: options => new DefaultResourceLoader({ ...options, additionalExtensionPaths: [],
        noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
        extensionFactories: [...options.extensionFactories ?? [], pi => {
          pi.on("session_shutdown", async () => { shutdownEntered.release(); await shutdownRelease.promise; });
        }] }),
      createSession: async options => {
        const created = await fixture.acquire(createAgentSession({ ...options, tools: ["read"], customTools: [{
          name: "read", label: "read", description: "local deterministic tool", parameters: Type.Object({ path: Type.String() }),
          async execute(_id, _args, _signal, update) {
            update?.({ content: [{ type: "text", text: "visible update" }], details: { private: "PRIVATE_TOOL_DETAILS" } });
            toolEntered.release(); await toolRelease.promise;
            if (toolError) throw Error("visible tool error");
            return { content: [{ type: "text", text: "visible result" }], details: { private: "PRIVATE_TOOL_DETAILS" } };
          },
        }] }));
        const dispose = created.session.dispose.bind(created.session);
        created.session.dispose = async () => { disposalEntered.release(); await disposalRelease.promise; await dispose(); };
        sessions.push(created.session);
        return created;
      },
    } });
    setBackgroundExecutor(executor);
    const owner = { sessionId: "public-owner", token: Symbol() };
    const delivered: ResultMessage[] = [], wakes: string[] = [];
    bindBackgroundOwner({ ...owner, hasUI: false, isIdle: () => true, notify() {},
      appendResult(message) { delivered.push(message); }, getBranch: () => delivered.map(message => ({ ...message, type: "custom_message" })),
      sendMessage(message) { wakes.push(message); } });
    const evaluation = toolError ? beginTeamEvaluation(owner.sessionId, false, owner.token)! : undefined;
    let currentOwner = owner;
    const controller = createAgentController(owner, () => currentOwner);
    const view = controller.openView({ control: false, policy: "bridge-read" });
    mkdirSync(path.join(root, "b"), { mode: 0o700 });
    const bridge = createAgentBridge(controller, path.join(root, "b"), () => true);
    const clients: BridgeClient[] = [];
    fixture.beforeRelease(async () => {
      for (const client of clients) await client.disconnect();
      await view.close(); bridge.revoke(); controller.revoke(); await bridge.settle(); await controller.settle();
      if (evaluation) retireTeamEvaluation(evaluation);
    });
    await bridge.ready;
    const descriptor = path.join(root, "b/descriptor.json");
    const client = await connect(descriptor, { expectedSessionId: owner.sessionId }); clients.push(client);
    const subscription = await client.subscribe(() => {}); // Hints intentionally ignored.
    type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
    const tools = new Map<string, Tool>();
    agentExtension({ registerTool(tool: Tool) { tools.set(tool.name, tool); }, appendEntry() {} } as unknown as ExtensionAPI);
    const ctx = { cwd: root, sessionManager: { getSessionId: () => currentOwner.sessionId,
      getSessionFile: () => path.join(root, "coordinator.jsonl") } };
    const toolCallId = `${method}-composed-native-call`;
    let returned = false, accepted: PublicWorkerDetail | undefined;
    view.subscribe(() => {
      if (accepted) return;
      const row = listObservations(evaluation?.token, owner.sessionId).find(row => row.origin?.toolCallId === toolCallId);
      if (!row) return;
      const detail = view.readPublicDetail(row.id);
      if ("format" in detail) {
        expect(returned).toBe(false); expect(sessions).toHaveLength(0);
        accepted = detail;
      }
    });
    const launch = await tools.get(method)!.execute(toolCallId, { role: "researcher", task: "public brief" },
      new AbortController().signal, undefined, ctx as never);
    returned = true;
    if (launch.isError) throw Error(JSON.stringify(launch));
    const handle = launch.details as { instanceId: string; id?: string };
    expect(accepted).toMatchObject({ worker: { source: method, instanceId: handle.instanceId,
      roleId: "researcher", toolCallId, coordinatorSessionId: owner.sessionId, linkage: "tool",
      ...(method === "team_assign" ? { assignmentId: handle.id } : {}) }, workbrief: { text: "public brief" } });
    expect(accepted!.ref.native).toBeUndefined(); expect(sessions).toHaveLength(0);
    nativeRelease.release();
    await toolEntered.promise;
    expect(sessions[0]!.isStreaming).toBe(true);
    const detail = await client.publicDetail(handle.instanceId);
    if (!("format" in detail)) throw Error(JSON.stringify(detail));
    expect(detail.lifecycle).toMatchObject({ execution: "running", result: "pending", capture: "open" });
    expect(detail.bindings).toHaveLength(1);
    expect(detail.worker).toEqual(accepted!.worker);
    expect(detail.bindings[0]!.attempts[0]!.activated).toMatchObject({ model: "public-fixture/local" });
    expect(detail.ref).not.toHaveProperty("evaluationId");
    expect(detail.ref).not.toHaveProperty("attemptId");
    expect(detail.bindings[0]!.ref).not.toHaveProperty("evaluationId");
    const ref = detail.bindings[0]!.ref;
    const snapshot = await records(client, ref);
    const nativeUser = sessions[0]!.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
    if (method === "team_assign") {
      expect(JSON.stringify(nativeUser)).toContain(
        `Team assignment header: Team ${owner.sessionId}; role researcher; assignment ${handle.id}`);
      expect(JSON.stringify(snapshot.output)).not.toContain("Team assignment header:");
    }
    expect(snapshot.output.find(record => record.kind === "message" && record.payload.role === "user"))
      .toMatchObject({ payload: { blocks: [{ type: "text", text: "public brief" }] } });
    const assistant = snapshot.output.find(record => record.kind === "message" && record.payload.role === "assistant")!;
    if (assistant.kind !== "message") throw Error("missing native assistant");
    expect(sessions[0]!.sessionManager.getEntry(assistant.nativeEntryId!)?.type).toBe("message");
    expect(assistant.payload.blocks.map(block => block.type)).toEqual(["omitted", "text", "toolCall"]);
    const tool = snapshot.output.find(record => record.kind === "tool")!;
    expect(tool).toMatchObject({ toolCallId: "real-tool-id", payload: { status: "updated", args: { path: large },
      result: [{ type: "text", text: "visible update" }] } });
    expect(snapshot.next).toBeString();
    expect(await client.publicActivity(ref)).toEqual(snapshot.first); // Fixed cut and deterministic replay.
    // Native Node consumer, not a Bun-only imitation; waits for its actual exit before root cleanup.
    const node = spawn("node", [new URL("./fixtures/public-conversation-reader.mjs", import.meta.url).pathname,
      descriptor, owner.sessionId, handle.instanceId, String(toolError)],
      { cwd: root, env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "", error = "";
    node.stdout!.on("data", data => { output += data; }); node.stderr!.on("data", data => { error += data; });
    const phases = new Map<string, ReturnType<typeof gate>>(["live", "tool", "terminal"].map(phase => [phase, gate()]));
    node.on("message", (message: { phase?: string }) => {
      output += JSON.stringify(message) + "\n";
      phases.get(message.phase ?? "")?.release();
    });
    const exited = fixture.run(new Promise<number | null>((resolve, reject) => {
      node.on("error", reject); node.on("close", resolve);
    }));
    // An early reader exit must fail the observation, not leave a barrier waiting.
    async function phase(name: string) {
      await Promise.race([phases.get(name)!.promise, exited.then(code => {
        throw Error(`Node reader exited ${code} before ${name}: ${error}`);
      })]);
    }
    fixture.finishOnCleanup(() => { if (node.connected) node.send("exit"); });
    await phase("live");
    expect(JSON.parse(output.trim()).node).toMatch(/^v26/);
    const lease = client.lease;
    await client.disconnect(); // No input/cancel/disconnect side effect.
    const resumed = await connect(descriptor, { expectedSessionId: owner.sessionId, resume: lease }); clients.push(resumed);
    expect(sessions[0]!.isStreaming).toBe(true);
    await subscription.dispose();
    await view.close();
    expect(sessions[0]!.isStreaming).toBe(true);
    await expect(resumed.publicActivity({ ...ref, instanceId: "foreign" }, snapshot.next)).rejects.toMatchObject({ code: "unknown_target" });
    await expect(resumed.publicActivity({ ...ref, native: { ...ref.native!, historyId: "foreign" } })).rejects.toMatchObject({ code: "unknown_target" });
    await expect(resumed.publicResult({ ...ref, native: { ...ref.native!, historyId: "foreign" } })).rejects.toMatchObject({ code: "unknown_target" });
    await expect(resumed.publicDetail(handle.instanceId, { ref, section: "brief", offset: 0 })).rejects.toMatchObject({ code: "invalid_cursor" });
    const invalidCursor = (snapshot.next![0] === "A" ? "B" : "A") + snapshot.next!.slice(1);
    await expect(resumed.publicActivity(ref, invalidCursor)).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(sessions[0]!.isStreaming).toBe(true);
    toolRelease.release();
    await providerEntered.promise;
    expect(sessions[0]!.isStreaming).toBe(true);
    const duringResult = await records(resumed, ref, snapshot.next);
    expect(duringResult.output.filter(record => record.kind === "tool").at(-1)).toMatchObject({
      toolCallId: "real-tool-id", payload: { args: { path: large }, status: toolError ? "error" : "completed", isError: toolError,
        result: [{ type: "text", text: toolError ? "visible tool error" : "visible result" }] } });
    node.send("tool"); await phase("tool");
    providerRelease.release();
    await shutdownEntered.promise;
    const pending = await resumed.publicResult(detail.ref);
    expect(pending.state).toBe("pending");
    const changes = await records(resumed, ref, duringResult.next);
    expect(changes.output.some(record => record.kind === "message" && record.payload.role === "assistant" && record.id !== assistant.id)).toBe(true);
    const native = sessions[0]!;
    const finalAssistantId = native.sessionManager.getEntries().filter(entry => entry.type === "message").at(-1)!.id;
    const privateHead = native.sessionManager.appendCustomEntry("fixture-private", { marker: "PRIVATE_CUSTOM_TREE" });
    await native.navigateTree(finalAssistantId);
    const restored = await records(resumed, ref, changes.next);
    expect(restored.output).toContainEqual(expect.objectContaining({ kind: "branch_changed", payload: {
      headEntryId: finalAssistantId, previousHeadEntryId: privateHead } }));
    await native.navigateTree(assistant.parentEntryId!);
    const branch = await records(resumed, ref, restored.next);
    expect(branch.output).toContainEqual(expect.objectContaining({ kind: "branch_changed", payload: { headEntryId: assistant.parentEntryId,
      previousHeadEntryId: finalAssistantId } }));
    shutdownRelease.release(); await disposalEntered.promise;
    expect(await resumed.publicDetail(handle.instanceId)).toMatchObject({ lifecycle: { capture: "open" } });
    disposalRelease.release(); await fixture.settleRuns();
    const terminal = await resumed.publicDetail(handle.instanceId);
    expect(terminal).toMatchObject({ lifecycle: { result: "available", capture: "closed", execution: "completed" },
      bindings: [{ capture: "closed", state: "historical", headEntryId: native.sessionManager.getLeafId() }] });
    expect(await resumed.publicResult(detail.ref)).toMatchObject({ status: "completed", text: { text: "repeat" } });
    expect(await resumed.publicResult(detail.ref)).toEqual(await resumed.publicResult(detail.ref));
    node.send("terminal"); await phase("terminal");
    expect({ exit: await exited, error }).toEqual({ exit: 0, error: "" });
    console.log("NODE_PUBLIC_COMPOSED", method, output.trim());
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.details).toMatchObject({ instanceId: handle.instanceId, status: "completed",
      ...(method === "team_assign" ? { assignmentId: handle.id } : {}) });
    expect(delivered[0]!.content).toContain("repeat");
    expect(wakes).toHaveLength(1);
    deliverWorkerResults(owner.token); deliverWorkerResults(owner.token);
    expect(delivered).toHaveLength(1); expect(wakes).toHaveLength(1);
    const transcript = JSON.stringify([snapshot.output, duringResult.output, changes.output, restored.output, branch.output, terminal]);
    for (const privateText of ["PRIVATE_THINKING", "PRIVATE_SIGNATURE", "Team assignment header:", "PRIVATE_TOOL_DETAILS",
      "PRIVATE_CUSTOM_TREE", "OFFLINE_MANAGED_CREDENTIAL", "systemPrompt", "sessionFile"])
      expect(transcript).not.toContain(privateText);
    await subscription.dispose();
    // A second genuine worker must not accept the first worker's native IDs or
    // continuation, even though both belong to this coordinator.
    const secondLaunch = await tools.get(method)!.execute(`${method}-second`, { role: "researcher", task: "other public brief" },
      new AbortController().signal, undefined, ctx as never);
    if (secondLaunch.isError) throw Error(JSON.stringify(secondLaunch));
    await fixture.settleRuns();
    const secondId = (secondLaunch.details as { instanceId: string }).instanceId;
    const second = await resumed.publicDetail(secondId);
    if (!("format" in second)) throw Error(JSON.stringify(second));
    const secondRef = second.bindings[0]!.ref;
    expect(secondRef.native).not.toEqual(ref.native);
    const secondRecords = await records(resumed, secondRef);
    expect(secondRecords.output.some(record => record.kind === "message" && record.payload.role === "user" &&
      record.payload.blocks.some(block => block.type === "text" && block.text === "other public brief"))).toBe(true);
    expect(secondRecords.output.some(record => record.kind === "tool")).toBe(false);
    await expect(resumed.publicActivity({ ...secondRef, native: ref.native })).rejects.toMatchObject({ code: "unknown_target" });
    await expect(resumed.publicResult({ ...secondRef, native: ref.native })).rejects.toMatchObject({ code: "unknown_target" });
    await expect(resumed.publicActivity(secondRef, snapshot.next)).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(await resumed.publicResult(ref)).toMatchObject({ text: { text: "repeat" } });
    expect(delivered.map(message => message.details.instanceId)).toEqual([handle.instanceId, secondId]);

    // Rotate only after both owned runs have physically settled. The old broker
    // remains reachable to observe rejection; the new one has a private root.
    if (evaluation) retireTeamEvaluation(evaluation);
    currentOwner = { sessionId: "replacement-owner", token: Symbol() };
    const replacementDelivery: ResultMessage[] = [];
    bindBackgroundOwner({ ...currentOwner, hasUI: false, isIdle: () => true, notify() {}, sendMessage() {},
      appendResult(message) { replacementDelivery.push(message); },
      getBranch: () => replacementDelivery.map(message => ({ ...message, type: "custom_message" })) });
    const replacementEvaluation = method === "team_assign"
      ? beginTeamEvaluation(currentOwner.sessionId, false, currentOwner.token)! : undefined;
    const replacementController = createAgentController(currentOwner, () => currentOwner);
    mkdirSync(path.join(root, "b2"), { mode: 0o700 });
    const replacementBridge = createAgentBridge(replacementController, path.join(root, "b2"), () => true);
    fixture.beforeRelease(async () => {
      replacementBridge.revoke(); replacementController.revoke();
      await replacementBridge.settle(); await replacementController.settle();
      if (replacementEvaluation) retireTeamEvaluation(replacementEvaluation);
    });
    await replacementBridge.ready;
    const replacementClient = await connect(path.join(root, "b2/descriptor.json"), { expectedSessionId: currentOwner.sessionId });
    clients.push(replacementClient);
    await expect(resumed.publicDetail(handle.instanceId)).rejects.toMatchObject({ code: "stale_owner" });
    await expect(replacementClient.publicActivity(ref, snapshot.next)).rejects.toMatchObject({ code: "unknown_target" });
    await expect(replacementClient.publicResult(ref)).rejects.toMatchObject({ code: "unknown_target" });
    await expect(replacementClient.publicDetail(secondId)).rejects.toMatchObject({ code: "unknown_target" });
    const replacementLaunch = await tools.get(method)!.execute(`${method}-replacement`, { role: "researcher", task: "replacement brief" },
      new AbortController().signal, undefined, ctx as never);
    if (replacementLaunch.isError) throw Error(JSON.stringify(replacementLaunch));
    await fixture.settleRuns();
    const replacementId = (replacementLaunch.details as { instanceId: string }).instanceId;
    const replacement = await replacementClient.publicDetail(replacementId);
    if (!("format" in replacement)) throw Error(JSON.stringify(replacement));
    expect(replacement.worker.coordinatorSessionId).toBe(currentOwner.sessionId);
    expect(replacement.bindings[0]!.ref.native).not.toEqual(secondRef.native);
    const histories = await replacementClient.historyList();
    expect(histories.items.map(item => item.instanceId)).toEqual([replacementId]);
    expect(replacementDelivery.map(message => message.details.instanceId)).toEqual([replacementId]);
    expect(delivered).toHaveLength(2);
    expect(await replacementClient.publicResult(replacement.ref)).toMatchObject({ text: { text: "repeat" } });
  }));
}

for (const replacement of [false, true]) test(`real SDK ${replacement ? "replacement-session" : "same-session"} fallback keeps attempts scoped; projection failure cannot change outcome`,
  fixture.ownedCase(`native fallback ${replacement}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-public-fallback-")); fixture.directories.push(root);
    process.env.PI_CODING_AGENT_DIR = root;
    const config = path.join(root, "policy.toml");
    writeFileSync(config, '[model_policies.developer]\nprimary = { model = "fallback-fixture/first", reasoning = "off" }\nfallbacks = [{ model = "fallback-fixture/second", reasoning = "off" }]\n');
    const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null,
      modelsStorePath: path.join(root, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    let firstRequests = 0;
    const tool = replacement ? "read" : "apply_patch", entered = gate(), release = gate();
    fixture.finishOnCleanup(() => release.release());
    runtime.registerProvider("fallback-fixture", {
      api: "openai-completions", apiKey: "offline", baseUrl: "http://offline.invalid",
      models: ["first", "second"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128_000,
        maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      streamSimple(model) {
        const stream = createAssistantMessageEventStream();
        const failure = model.id === "first" && ++firstRequests > 1;
        const message: AssistantMessage = { ...{
          role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        }, content: failure ? [] : model.id === "first"
          ? [{ type: "toolCall", id: "native-fallback-tool", name: tool, arguments: { value: "public" } }]
          : [{ type: "text", text: "authoritative fallback result" }],
        stopReason: failure ? "error" : model.id === "first" ? "toolUse" : "stop",
        ...(failure ? { errorMessage: "429 rate limit" } : {}) };
        stream.push(failure ? { type: "error", reason: "error", error: message }
          : { type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
        stream.end(); return stream;
      },
    });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const sessions: AgentSession[] = [];
    const native = createPiExecutor({ factories: {
      createRuntime: async () => runtime, getAgentDir: () => root, createSettings: () => settings,
      createCodemode: () => () => {},
      createLoader: options => new DefaultResourceLoader({ ...options, additionalExtensionPaths: [],
        noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true }),
      createSession: async options => {
        const result = await fixture.acquire(createAgentSession({ ...options, tools: [tool], customTools: [{
          name: tool, label: tool, description: "offline tool", parameters: Type.Object({ value: Type.String() }),
          async execute() { return { content: [{ type: "text", text: "tool succeeded" }], details: {} }; },
        }] }));
        sessions.push(result.session); return result;
      },
    } });
    // Exercise the runner's declared optional retryBeforePrompt capability, not an alternate runtime.
    const executor: AttemptExecutor = { capturesHistory: true, capturesPublicConversation: true, async start(input) {
      const result = await native.start(input);
      if (replacement && result.session) {
        const source = result.session;
        result.session = { continueWith: source.continueWith.bind(source), dispose: source.dispose.bind(source) };
      }
      return result;
    } };
    const owner = { sessionId: "fallback-owner", token: Symbol() };
    bindBackgroundOwner({ ...owner, hasUI: false, isIdle: () => false, notify() {}, sendMessage() {} });
    const controller = createAgentController(owner, () => owner), view = controller.openView({ control: false, policy: "bridge-read" });
    fixture.beforeRelease(async () => { await view.close(); controller.revoke(); await controller.settle(); });
    const originalEntry = PublicConversation.prototype.entry;
    let switchedFile = false;
    let entryIdBeforeSwitch: string | undefined;
    const projection = spyOn(PublicConversation.prototype, "entry").mockImplementation(function (this: PublicConversation, ...args) {
      const entry = args[1];
      if (entry.type === "message" && entry.message.role === "assistant" &&
          entry.message.content.some(block => block.type === "toolCall")) {
        if (replacement) throw Error("controlled capture failure");
        if (!switchedFile) {
          const session = sessions[0]!, sessionId = session.sessionId, copy = path.join(root, "unregistered.jsonl");
          copyFileSync(session.sessionFile!, copy);
          session.sessionManager.setSessionFile(copy);
          expect(session.sessionId).toBe(sessionId); // Real SDK identity, but an unregistered file.
          entryIdBeforeSwitch = entry.id;
          switchedFile = true;
        }
      }
      return originalEntry.apply(this, args);
    });
    // Barrier on the SDK-observed activated fallback, while run still owns the attempt.
    const baseStream = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = (model, context, options) => {
      if (model.id !== "second") return baseStream(model, context, options);
      const stream = createAssistantMessageEventStream();
      fixture.run((async () => {
        entered.release(); await release.promise;
        for await (const event of baseStream(model, context, options)) stream.push(event);
        stream.end();
      })());
      return stream;
    };
    try {
      const worker = await spawnBackground({ roleId: "developer", task: "original public task", cwd: root, executor,
        load: { userConfigPath: config }, historyOrigin: { source: "agent_spawn", coordinatorSessionId: owner.sessionId,
          workbrief: "original public task" } });
      await entered.promise;
      const detail = view.readPublicDetail(worker.instanceId);
      if (!("format" in detail)) throw Error(JSON.stringify(detail));
      expect(sessions).toHaveLength(replacement ? 2 : 1);
      expect(detail.bindings.map(binding => binding.attempts.length)).toEqual(replacement ? [1, 1] : [2]);
      expect(detail.bindings.at(-1)!.attempts.at(-1)!.activated).toMatchObject({ model: "fallback-fixture/second" });
      const prior = view.readPublicActivity(detail.bindings[0]!.ref);
      expect(() => view.readPublicDetail(worker.instanceId, { ref: detail.bindings[0]!.ref, section: "brief", offset: 0 }))
        .toThrow("invalid_cursor");
      expect("changes" in prior && prior.changes.some(change => "record" in change && change.record.kind === "message" &&
        change.record.payload.stopReason === "error" && change.record.payload.errorMessage === "429 rate limit")).toBe(replacement);
      if (!replacement) {
        expect(switchedFile).toBe(true);
        expect(prior).toMatchObject({ gaps: ["capture_failed"], capture: { state: "incomplete" } });
        const recovered: PublicRecord[] = [];
        let cursor: string | undefined;
        do {
          const page = view.readPublicActivity(detail.bindings[0]!.ref, cursor, true);
          if (!("changes" in page)) throw Error(JSON.stringify(page));
          for (const change of page.changes) if ("record" in change) recovered.push(change.record);
          cursor = page.more ? page.next ?? undefined : undefined;
        } while (cursor);
        expect(recovered.some(record => record.nativeEntryId === entryIdBeforeSwitch)).toBe(true);
        expect(recovered.some(record => record.kind === "message" && record.payload.stopReason === "error")).toBe(false);
      }
      if (replacement) {
        expect(detail.bindings[0]).toMatchObject({ state: "historical", capture: "incomplete", gaps: ["capture_failed"] });
        expect(view.readPublicActivity(detail.bindings[0]!.ref)).toMatchObject({ state: "ready" });
        expect(detail.bindings[0]!.sessionId).not.toBe(detail.bindings[1]!.sessionId);
      }
      release.release(); await fixture.settleRuns();
      expect(view.readPublicDetail(worker.instanceId)).toMatchObject({ lifecycle: {
        capture: "incomplete", captureReason: "capture_failed", result: "available", execution: "completed" } });
      expect(view.readPublicResult(detail.ref)).toMatchObject({ status: "completed", text: { text: "authoritative fallback result" } });
    } finally { release.release(); await fixture.settleRuns(); projection.mockRestore(); }
  }));
