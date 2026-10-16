import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentExtension from "../extensions/agent/index.ts";
import { bindBackgroundOwner, clearBackgroundOwner, deliverWorkerResults, setBackgroundExecutor, spawnBackground, type ResultMessage } from "../extensions/agent/background.ts";
import { clearObservations, listObservations } from "../extensions/agent/observe.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createAgentController } from "../extensions/agent/controller.ts";
import { createAgentBridge } from "../extensions/agent/bridge/broker.ts";
import { connect, type BridgeClient } from "../extensions/agent/bridge/client.js";
import type { PublicConversationPage, PublicRecord, PublicWorkerDetail, WorkerReadReference } from "../extensions/agent/bridge/protocol.js";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import { createPublicProducer, PublicConversation } from "../extensions/agent/public-conversation.ts";
import { SessionHistory, type InvocationHistory } from "../extensions/agent/history.ts";
import type { AttemptExecutor } from "../extensions/agent/run.ts";
import { beginTeamEvaluation, retireTeamEvaluation } from "../extensions/team.ts";
import todoExtension from "@juicesharp/rpiv-todo";

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
async function records(client: BridgeClient, ref: WorkerReadReference, cursor?: string, recovery = false) {
  const output: PublicRecord[] = [];
  const parts = new Map<string, Buffer[]>();
  let first: PublicConversationPage | undefined;
  const pages: PublicConversationPage[] = [];
  let next = cursor;
  for (;;) {
    const page = await client.publicActivity(ref, next, recovery);
    if (!("changes" in page)) throw Error(JSON.stringify(page));
    first ??= page;
    pages.push(page);
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
      return { output, next, first, pages };
    }
  }
}

function recovered(capture: PublicConversation, ref: WorkerReadReference, recovery = true) {
  const output: PublicRecord[] = [], pages: PublicConversationPage[] = [], parts = new Map<string, Buffer[]>();
  let cursor: string | undefined;
  do {
    const page = capture.read(ref, cursor, recovery);
    pages.push(page);
    for (const change of page.changes) {
      if (!("kind" in change)) { output.push(change.record); continue; }
      const chunks = parts.get(change.id) ?? [];
      expect(chunks.reduce((size, chunk) => size + chunk.length, 0)).toBe(change.byteOffset);
      chunks.push(Buffer.from(change.data, "base64")); parts.set(change.id, chunks);
      if (change.byteOffset + chunks.at(-1)!.length === change.totalBytes) {
        output.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).record); parts.delete(change.id);
      }
    }
    cursor = page.more ? page.next ?? undefined : undefined;
  } while (cursor);
  expect(parts.size).toBe(0);
  return { output, pages };
}

for (const method of ["agent_spawn", "team_assign"] as const) test(`${method} real rpiv-todo create and filtered list native smoke`,
  fixture.ownedCase(`real todo ${method}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-public-todo-"));
    fixture.directories.push(root); process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PITAKO_INSTANCE_ID;
    mkdirSync(path.join(root, "pitako"));
    writeFileSync(path.join(root, "pitako/config.toml"),
      '[model_policies.researcher]\nprimary = { model = "todo-fixture/local", reasoning = "off" }\n');
    const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null,
      modelsStorePath: path.join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    let requests = 0;
    const providerEntered = gate(), providerRelease = gate(), shutdownEntered = gate(), shutdownRelease = gate();
    fixture.finishOnCleanup(() => { providerRelease.release(); shutdownRelease.release(); });
    const secondSubject = `second ${"漢😀".repeat(4000)}`;
    const actions: ToolCall["arguments"][] = [{ action: "create", subject: "first" }, { action: "create", subject: secondSubject },
      { action: "list", status: "completed" }, { action: "delete", id: 1 }, { action: "clear" },
      { action: "create", subject: "reused" }];
    runtime.registerProvider("todo-fixture", {
      api: "openai-completions", apiKey: "OFFLINE_DUMMY", baseUrl: "http://offline.invalid",
      models: [{ id: "local", name: "local", reasoning: false, input: ["text"], contextWindow: 128000,
        maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model) {
        const stream = createAssistantMessageEventStream(), args = actions[requests++];
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider,
          model: model.id, timestamp: requests, content: args
            ? [{ type: "toolCall", id: `todo-${requests}`, name: "todo", arguments: args }]
            : [{ type: "text", text: "done" }], stopReason: args ? "toolUse" : "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const finish = () => { stream.push({ type: "done", reason: args ? "toolUse" : "stop", message }); stream.end(); };
        if (requests === 4) fixture.run((async () => { providerEntered.release(); await providerRelease.promise; finish(); })());
        else finish();
        return stream;
      },
    });
    const sessions: AgentSession[] = [];
    let sessionOptions: Parameters<typeof createAgentSession>[0];
    let invocation: InvocationHistory | undefined;
    let appendNative!: () => void;
    const timing: unknown[] = [];
    const executor = createPiExecutor({ factories: {
      createRuntime: async () => runtime, getAgentDir: () => root,
      createSettings: () => SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } }),
      createCodemode: () => () => {},
      createLoader: options => new DefaultResourceLoader({ ...options, additionalExtensionPaths: [],
        noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
        extensionFactories: [...options.extensionFactories ?? [], todoExtension, pi => {
          appendNative = () => pi.appendEntry("nonmessage-ancestor", {});
          pi.on("session_shutdown", async () => { shutdownEntered.release(); await shutdownRelease.promise; });
        }] }),
      createSession: async options => {
        sessionOptions = options;
        const created = await fixture.acquire(createAgentSession({ ...options, tools: ["todo"] }));
        created.session.subscribe(event => {
          if (event.type !== "message_end" || event.message.role !== "toolResult") return;
          const call = event.message.toolCallId;
          const before = created.session.sessionManager.getLeafId();
          const beforeTodos = created.session.sessionManager.getEntries().filter(entry =>
            entry.type === "message" && entry.message.role === "toolResult");
          expect(beforeTodos.some(entry => entry.type === "message" && entry.message.role === "toolResult" &&
            entry.message.toolCallId === call)).toBe(false);
          fixture.run(new Promise<void>((resolve, reject) => queueMicrotask(() => {
            try {
              const after = created.session.sessionManager.getLeafId();
              expect(after).not.toBe(before);
              timing.push({ call, before, after }); resolve();
            } catch (error) { reject(error); }
          })));
        });
        sessions.push(created.session); return created;
      },
    } });
    setBackgroundExecutor({ ...executor, start(input) { invocation = input.history; return executor.start(input); } });
    const owner = { sessionId: "todo-owner", token: Symbol() };
    bindBackgroundOwner({ ...owner, hasUI: false, isIdle: () => true, notify() {}, appendResult() {}, sendMessage() {} });
    const evaluation = method === "team_assign" ? beginTeamEvaluation(owner.sessionId, false, owner.token)! : undefined;
    const controller = createAgentController(owner, () => owner);
    mkdirSync(path.join(root, "bridge"), { mode: 0o700 });
    const bridge = createAgentBridge(controller, path.join(root, "bridge"), () => true);
    let client: BridgeClient | undefined;
    fixture.beforeRelease(async () => {
      await client?.disconnect(); bridge.revoke(); controller.revoke();
      await bridge.settle(); await controller.settle();
      if (evaluation) await retireTeamEvaluation(evaluation);
    });
    await bridge.ready;
    type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
    const tools = new Map<string, Tool>();
    agentExtension({ registerTool(tool: Tool) { tools.set(tool.name, tool); }, appendEntry() {} } as unknown as ExtensionAPI);
    const launch = await tools.get(method)!.execute("todo-launch", { role: "researcher", task: "todo smoke" },
      new AbortController().signal, undefined, { cwd: root, sessionManager: {
        getSessionId: () => owner.sessionId, getSessionFile: () => path.join(root, "coordinator.jsonl") } } as never);
    if (launch.isError) throw Error(JSON.stringify(launch));
    await providerEntered.promise;
    const id = (launch.details as { instanceId: string }).instanceId;
    const descriptor = path.join(root, "bridge/descriptor.json");
    client = await connect(descriptor, { expectedSessionId: owner.sessionId });
    const detail = await client.publicDetail(id);
    if (!("format" in detail)) throw Error(JSON.stringify(detail));
    const native = readFileSync(sessions[0]!.sessionFile!, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const nativeTodos = native.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo");
    expect(nativeTodos).toHaveLength(3);
    expect(nativeTodos[2].message.details.tasks).toHaveLength(2);
    const captured = await records(client, detail.bindings[0]!.ref);
    const selected = captured.output.filter(record => record.kind === "tool" && record.toolCallId === "todo-3").at(-1)!;
    expect(selected).toMatchObject({ nativeEntryId: nativeTodos[2].id, payload: { todoSnapshot: {
      format: "rpiv-todo-v1", tasks: [
        { id: 1, subject: "first", status: "pending", identityEntryId: nativeTodos[0].id },
        { id: 2, subject: secondSubject, status: "pending", identityEntryId: nativeTodos[1].id }] } } });
    expect(detail.bindings[0]!.todoHead).toEqual({ state: "ready", sourceEntryId: nativeTodos[2].id });
    expect(selected.kind === "tool" && selected.payload.result).not.toEqual(null);
    const recovery = await records(client, detail.bindings[0]!.ref, undefined, true);
    expect(recovery.pages.flatMap(page => page.changes).filter(change => "kind" in change)).not.toBeEmpty();
    expect(recovery.output.find(record => record.toolCallId === "todo-3")).toMatchObject({
      nativeEntryId: selected.nativeEntryId, payload: selected.payload });
    expect(recovery.pages.every(page => JSON.stringify(page.binding) === JSON.stringify(recovery.first!.binding) &&
      JSON.stringify(page.capture) === JSON.stringify(recovery.first!.capture))).toBe(true);
    expect(new Set(recovery.output.map(record => record.order)).size).toBe(recovery.output.length);
    console.log("NATIVE_TODO_RECOVERY", method, JSON.stringify({ ids: recovery.output.map(record => record.nativeEntryId),
      binding: recovery.first!.binding, pages: recovery.pages.length,
      fragments: recovery.pages.flatMap(page => page.changes).filter(change => "kind" in change).length,
      selectedTasks: selected.kind === "tool" ? selected.payload.todoSnapshot!.tasks.map(task => [task.id, task.identityEntryId,
        Buffer.byteLength(task.subject), task.status]) : [] }));
    const node = spawn("node", [new URL("./fixtures/public-conversation-reader.mjs", import.meta.url).pathname,
      descriptor, owner.sessionId, id, "todo"], { cwd: root, env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "", error = "";
    node.stdout!.on("data", data => { output += data; }); node.stderr!.on("data", data => { error += data; });
    const exited = fixture.run(new Promise<number | null>((resolve, reject) => {
      node.on("error", reject); node.on("close", resolve);
    }));
    fixture.finishOnCleanup(() => { if (node.connected) node.send("exit"); });
    expect({ exit: await exited, error }).toEqual({ exit: 0, error: "" });
    const observed = JSON.parse(output);
    expect(observed.selected.nativeEntryId).toBe(nativeTodos[2].id);
    console.log("NATIVE_TODO_SMOKE", method, JSON.stringify({ fixtureRoot: root, nativeFile: sessions[0]!.sessionFile,
      nativeIds: nativeTodos.map(entry => entry.id),
      nativeHead: sessions[0]!.sessionManager.getLeafId(), exportedHead: detail.bindings[0],
      node: { ...observed, selected: { id: observed.selected.id, nativeEntryId: observed.selected.nativeEntryId,
        tasks: observed.selected.payload.todoSnapshot.tasks.map((task: { id: number; identityEntryId: string; subject: string; status: string }) =>
          [task.id, task.identityEntryId, Buffer.byteLength(task.subject), task.status]) } } }));
    const frozen = await client.publicActivity(detail.bindings[0]!.ref);
    providerRelease.release(); await shutdownEntered.promise;
    const nativeSession = sessions[0]!;
    const allTodos = nativeSession.sessionManager.getEntries().filter(entry =>
      entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo");
    expect(allTodos).toHaveLength(6);
    const expanded = await records(client, detail.bindings[0]!.ref);
    const latest = (call: string) => expanded.output.filter(record => record.kind === "tool" && record.toolCallId === call).at(-1);
    expect(latest("todo-4")).toMatchObject({ payload: { todoSnapshot: { tasks: [
      { id: 1, status: "deleted", identityEntryId: allTodos[0]!.id }, { id: 2, status: "pending" }] } } });
    expect(latest("todo-5")).toMatchObject({ payload: { todoSnapshot: { tasks: [] } } });
    expect(latest("todo-6")).toMatchObject({ payload: { todoSnapshot: { tasks: [
      { id: 1, subject: "reused", identityEntryId: allTodos[5]!.id }] } } });
    // The ordinary initial page cut stays frozen despite the additional native results.
    if (!("changes" in frozen)) throw Error(JSON.stringify(frozen));
    expect(frozen.binding!.todoHead).toEqual({ state: "ready", sourceEntryId: allTodos[2]!.id });
    const completedHead = nativeSession.sessionManager.getLeafId()!;
    await nativeSession.compact("offline summary");
    const compactedHead = nativeSession.sessionManager.getLeafId()!;
    expect(nativeSession.sessionManager.getEntry(compactedHead)?.type).toBe("compaction");
    expect(await client.publicDetail(id)).toMatchObject({ bindings: [{ headEntryId: compactedHead,
      todoHead: { state: "ready", sourceEntryId: allTodos[5]!.id } }] });
    await nativeSession.navigateTree(allTodos[0]!.id);
    appendNative();
    const custom = nativeSession.sessionManager.getLeafId()!;
    await Promise.resolve(); // Settle the producer's post-entry_appended microtask.
    expect(await client.publicDetail(id)).toMatchObject({ bindings: [{ headEntryId: custom,
      todoHead: { state: "ready", sourceEntryId: allTodos[0]!.id } }] });
    const rootEntry = nativeSession.sessionManager.getEntries().find(entry => entry.parentId === null)!;
    await nativeSession.navigateTree(rootEntry.id);
    expect(await client.publicDetail(id)).toMatchObject({ bindings: [{ todoHead: { state: "ready", sourceEntryId: null } }] });
    await nativeSession.navigateTree(completedHead);
    const publishedInvalid = nativeSession.sessionManager.appendMessage({ role: "toolResult",
      toolCallId: "published-invalid", toolName: "todo", timestamp: Date.now(), content: [], isError: false,
      details: { tasks: [{ id: 1, subject: 4, status: "pending" }], nextId: 2 } });
    appendNative();
    await Promise.resolve();
    expect(await client.publicDetail(id)).toMatchObject({ bindings: [{ todoHead: { state: "unavailable" } }] });
    const invalidPublished = (await records(client, detail.bindings[0]!.ref)).output.find(record =>
      record.nativeEntryId === publishedInvalid);
    expect(invalidPublished?.kind).toBe("tool");
    expect(invalidPublished?.kind === "tool" && invalidPublished.payload.todoSnapshot).toBeUndefined();
    // Persist a valid branch leaf so reopen does not accidentally test the rejected branch.
    await nativeSession.navigateTree(completedHead);
    appendNative();
    await Promise.resolve();
    expect(await client.publicDetail(id)).toMatchObject({ bindings: [{ todoHead: {
      state: "ready", sourceEntryId: allTodos[5]!.id } }] });
    shutdownRelease.release(); await fixture.settleRuns();
    // Open the registered native file through the same factory, with no second prompt driver.
    const reopened = await fixture.acquire(createAgentSession({ ...sessionOptions!, tools: ["todo"],
      sessionManager: SessionManager.open(nativeSession.sessionFile!) }));
    const reopenedCapture = new PublicConversation();
    const registeredHistory = new SessionHistory(invocation!, detail.bindings[0]!.historyId, { model: "todo-fixture/local", reasoning: "off" });
    const producer = createPublicProducer(reopened.session, registeredHistory);
    fixture.beforeRelease(async () => { await producer.close(); reopenedCapture.retire(); });
    const reentrant: Array<{ head: unknown; snapshots: string[] }> = [];
    reopenedCapture.onChange = () => {
      const binding = reopenedCapture.metadata(detail.ref).bindings[0];
      if (!binding) return;
      const captured = recovered(reopenedCapture, detail.bindings[0]!.ref, false);
      reentrant.push({ head: binding.todoHead, snapshots: captured.output.flatMap(record =>
        record.kind === "tool" && record.payload.todoSnapshot ? [record.nativeEntryId!] : []) });
    };
    producer.attach(reopenedCapture);
    const ref = detail.bindings[0]!.ref;
    const reopenedInitialHead = reopened.session.sessionManager.getLeafId();
    expect(reopened.session.sessionManager.getLeafId()).not.toBe(custom);
    expect(reopened.session.sessionManager.getBranch().filter(entry => entry.type === "message" &&
      entry.message.role === "toolResult" && entry.message.toolName === "todo").at(-1)!.id).toBe(allTodos[5]!.id);
    expect(reopenedCapture.metadata(detail.ref).bindings[0]!.todoHead).toEqual({ state: "ready", sourceEntryId: allTodos[5]!.id });
    const reopenPage = recovered(reopenedCapture, ref, false);
    expect(reopenPage.output.find(record => record.nativeEntryId === allTodos[5]!.id))
      .toMatchObject({ nativeEntryId: allTodos[5]!.id, payload: { todoSnapshot: { tasks: [
        { id: 1, identityEntryId: allTodos[5]!.id }] } } });
    expect(reentrant).toHaveLength(1);
    expect(reentrant[0]!.head).toEqual({ state: "ready", sourceEntryId: allTodos[5]!.id });
    // Real persisted reopen: freeze B, recover earlier A without selecting the physical tail,
    // then change the SAME live tool while its final merged upsert is fragmented.
    const recoveryHead = reopenedCapture.read(ref, undefined, true);
    const chunks = new Map<string, Buffer[]>(), recoveredRecords: PublicRecord[] = [];
    let recoveryCursor = recoveryHead.next!, changedDuringFragment = false, fragmentCount = 0;
    let sameCallNativeEntry: string | undefined;
    for (;;) {
      const issuedCursor = recoveryCursor;
      const page = reopenedCapture.read(ref, issuedCursor, true, 26000);
      expect(page.binding).toEqual(recoveryHead.binding);
      expect(page.capture).toEqual(recoveryHead.capture);
      expect(page.state).toBe("ready");
      if (page.next) {
        const cursorMetadata = JSON.parse(Buffer.from(page.next.split(".")[0]!, "base64url").toString("utf8"));
        expect(cursorMetadata).not.toHaveProperty("bindingMetadata");
        expect(cursorMetadata).not.toHaveProperty("capture");
        expect(JSON.stringify(cursorMetadata)).not.toContain("todoSnapshot");
      }
      for (const change of page.changes) {
        if (!("kind" in change)) { recoveredRecords.push(change.record); continue; }
        fragmentCount++;
        if (change.id.endsWith(":tool:todo-2") && !changedDuringFragment) {
          changedDuringFragment = true;
          producer.event({ type: "tool_execution_update", toolCallId: "todo-2", toolName: "todo", args: {},
            partialResult: { content: [{ type: "text", text: "SAME_CALL_LIVE_CHANGE" }], details: {} } });
          // A later persisted upsert of the same native tool changes retained, not this cut's bytes.
          sameCallNativeEntry = reopened.session.sessionManager.appendMessage({
            role: "toolResult", toolCallId: "todo-2", toolName: "todo", timestamp: Date.now(), isError: false,
            content: [{ type: "text", text: "SAME_CALL_NATIVE_CHANGE" }],
            details: { tasks: [{ id: 1, subject: "native changed", status: "pending" }], nextId: 2 },
          });
          producer.reconcile();
          expect(recovered(reopenedCapture, ref, false).output.find(record => record.toolCallId === "todo-2"))
            .toMatchObject({ nativeEntryId: sameCallNativeEntry,
              payload: { todoSnapshot: { tasks: [{ id: 1, subject: "native changed" }] } } });
          await reopened.session.navigateTree(allTodos[0]!.id);
          producer.reconcile();
          expect(reopenedCapture.metadata(detail.ref).bindings[0]!.todoHead)
            .toEqual({ state: "ready", sourceEntryId: allTodos[0]!.id });
          const nativeLines = readFileSync(nativeSession.sessionFile!, "utf8").split("\n");
          const sourceOffset = nativeLines.slice(0, nativeLines.findIndex(line => line && JSON.parse(line).id === allTodos[1]!.id))
            .reduce((size, line) => size + Buffer.byteLength(line) + 1, 0);
          const readSync = fs.readSync, offsets: Array<fs.ReadPosition | null> = [];
          const observeRead: typeof fs.readSync = (fd, buffer, offset?: number | fs.ReadOptions, length?: number,
            position?: fs.ReadPosition | null) => {
            if (typeof offset !== "number") return readSync(fd, buffer, offset);
            offsets.push(position ?? null);
            return readSync(fd, buffer, offset, length!, position ?? null);
          };
          const reads = spyOn(fs, "readSync").mockImplementation(observeRead);
          try {
            expect(reopenedCapture.read(ref, issuedCursor, true, 26000)).toEqual(page);
            expect(offsets.length).toBeGreaterThan(0); // Header/cut validation still occurs.
            expect(offsets).not.toContain(sourceOffset); // The materialized native upsert is never reread/remerged.
          } finally { reads.mockRestore(); }
        }
        const parts = chunks.get(change.id) ?? [];
        expect(parts.reduce((size, part) => size + part.length, 0)).toBe(change.byteOffset);
        parts.push(Buffer.from(change.data, "base64")); chunks.set(change.id, parts);
        if (change.byteOffset + parts.at(-1)!.length === change.totalBytes) {
          recoveredRecords.push(JSON.parse(Buffer.concat(parts).toString("utf8")).record);
          chunks.delete(change.id);
        }
      }
      if (!page.next) break;
      recoveryCursor = page.next;
    }
    expect(chunks.size).toBe(0);
    expect(changedDuringFragment).toBe(true);
    expect(fragmentCount).toBeGreaterThan(1);
    expect(new Set(recoveredRecords.map(record => record.order)).size).toBe(recoveredRecords.length);
    expect(recoveryHead.binding).toMatchObject({ headEntryId: reopenedInitialHead,
      todoHead: { state: "ready", sourceEntryId: allTodos[5]!.id } });
    expect(recoveredRecords.find(record => record.nativeEntryId === allTodos[2]!.id)!.revision)
      .toBeGreaterThan(reopenPage.output.find(record => record.nativeEntryId === allTodos[2]!.id)!.revision);
    expect(recoveredRecords.find(record => record.nativeEntryId === allTodos[2]!.id))
      .toMatchObject({ payload: { todoSnapshot: selected.kind === "tool" ? selected.payload.todoSnapshot : undefined } });
    expect(JSON.stringify(recoveredRecords)).not.toContain("SAME_CALL_LIVE_CHANGE");
    expect(JSON.stringify(recoveredRecords)).not.toContain("SAME_CALL_NATIVE_CHANGE");
    expect(recoveredRecords.some(record => record.nativeEntryId === sameCallNativeEntry)).toBe(false);
    console.log("NATIVE_TODO_REOPEN_RECOVERY", method, JSON.stringify({ initialHead: reopenedInitialHead,
      frozenBinding: recoveryHead.binding, fragments: fragmentCount, sameCallNativeEntry,
      ids: recoveredRecords.map(record => [record.id, record.nativeEntryId, record.order, record.revision]) }));
    await reopened.session.navigateTree(reopenedInitialHead!);
    producer.reconcile();
    const result = { content: [{ type: "text" as const, text: "controlled native result" }],
      details: { tasks: [{ id: 1, subject: "continued", status: "pending" }], nextId: 2 } };
    producer.event({ type: "tool_execution_end", toolCallId: "postappend", toolName: "todo",
      result, isError: false });
    const preappend = recovered(reopenedCapture, ref, false).pages.flatMap(page => page.changes).filter(change => "record" in change &&
      change.record.toolCallId === "postappend").at(-1);
    expect(preappend).toMatchObject({ record: { nativeEntryId: null } });
    expect(preappend && "record" in preappend && preappend.record.kind === "tool"
      && preappend.record.payload.todoSnapshot).toBeUndefined();
    const message = { role: "toolResult" as const, toolCallId: "postappend", toolName: "todo",
      timestamp: Date.now(), content: result.content, details: result.details, isError: false };
    reentrant.length = 0;
    producer.event({ type: "message_end", message });
    const appended = reopened.session.sessionManager.appendMessage(message);
    await Promise.resolve();
    expect(reentrant).toHaveLength(1);
    expect(reentrant[0]!.head).toEqual({ state: "ready", sourceEntryId: appended });
    expect(reentrant[0]!.snapshots).toContain(appended);
    const invalid = reopened.session.sessionManager.appendMessage({ ...message, toolCallId: "invalid",
      details: { tasks: [{ id: 1, subject: 4, status: "pending" }], nextId: 2 } });
    producer.reconcile();
    expect(reopenedCapture.metadata(detail.ref).bindings[0]!.todoHead).toEqual({ state: "unavailable" });
    const invalidRecord = recovered(reopenedCapture, ref, false).pages.flatMap(page => page.changes).find(change =>
      "record" in change && change.record.nativeEntryId === invalid);
    expect(invalidRecord && "record" in invalidRecord && invalidRecord.record.kind === "tool"
      && invalidRecord.record.payload.todoSnapshot).toBeUndefined();
    const invalidRecovered = recovered(reopenedCapture, ref);
    expect(invalidRecovered.pages[0]!.binding!.todoHead).toEqual({ state: "unavailable" });
    const invalidRecoveredRecord = invalidRecovered.output.find(record => record.nativeEntryId === invalid);
    expect(invalidRecoveredRecord?.kind).toBe("tool");
    expect(invalidRecoveredRecord?.kind === "tool" && invalidRecoveredRecord.payload.todoSnapshot).toBeUndefined();
    await producer.close(); await reopened.session.dispose();
    reopenedCapture.retire();
    // Cut-only recovery must never promote snapshots into follow. Keep one independently
    // proven live result so rejection also witnesses that it does not erase unrelated capture.
    const cutOnly = new PublicConversation();
    fixture.beforeRelease(() => { cutOnly.retire(); });
    cutOnly.bind(Symbol());
    const cutGeneration = cutOnly.binding(detail.bindings[0]!.historyId, reopened.session.sessionManager.getSessionId(),
      nativeSession.sessionFile);
    cutOnly.head(cutGeneration, reopenedInitialHead, reopened.session.sessionManager.getEntries());
    const independent = captured.output.find(record => record.nativeEntryId === allTodos[0]!.id)!;
    if (independent.kind !== "tool") throw Error("missing independent native todo");
    cutOnly.entry(cutGeneration, allTodos[0]!, false, undefined, 0, independent.payload.todoSnapshot);
    const followBeforeRecovery = cutOnly.read(ref).next!;
    const cutHeader = cutOnly.read(ref, undefined, true);
    const bytes = readFileSync(nativeSession.sessionFile!);
    let cutCursor = cutHeader.next!, issuedCutFragment = false;
    while (cutCursor) {
      const page = cutOnly.read(ref, cutCursor, true, 26000);
      if (page.changes.some(change => "kind" in change && change.id.endsWith(":tool:todo-2"))) {
        issuedCutFragment = true; cutCursor = page.next!; break;
      }
      cutCursor = page.next!;
    }
    expect(issuedCutFragment).toBe(true);
    const rejectedNotifications: unknown[] = [];
    cutOnly.onChange = () => rejectedNotifications.push({
      head: cutOnly.metadata(detail.ref).bindings[0]!.todoHead,
      records: cutOnly.read(ref).changes.flatMap(change => "record" in change ? [change.record.nativeEntryId] : []) });
    try {
      truncateSync(nativeSession.sessionFile!, bytes.length - 1);
      expect(cutOnly.read(ref, cutCursor, true)).toMatchObject({ state: "resync_required", changes: [] });
      expect(cutOnly.read(ref, cutHeader.next!, true)).toMatchObject({ state: "resync_required", changes: [] });
      expect(rejectedNotifications).toEqual([{ head: { state: "unavailable" }, records: [allTodos[0]!.id] }]);
      cutOnly.onChange = undefined;
      const followed = cutOnly.read(ref, followBeforeRecovery);
      expect(followed.binding!.todoHead).toEqual({ state: "unavailable" });
      expect(followed.changes).toEqual([]);
      expect(cutOnly.read(ref).changes).toMatchObject([{ record: {
        nativeEntryId: allTodos[0]!.id, payload: { todoSnapshot: { tasks: [{ identityEntryId: allTodos[0]!.id }] } } } }]);
      // Before any bytes are issued, a head outside the frozen file cut must omit *all* snapshots.
      writeFileSync(nativeSession.sessionFile!, bytes.subarray(0, bytes.lastIndexOf(10, bytes.length - 2) + 1));
      cutOnly.head(cutGeneration, invalid, reopened.session.sessionManager.getEntries());
      const outside = recovered(cutOnly, ref);
      expect(outside.pages[0]!.binding!.todoHead).toEqual({ state: "unavailable" });
      expect(outside.output.some(record => record.kind === "tool" && record.payload.todoSnapshot)).toBe(false);
      // A selected leaf with missing ancestry is unavailable, not an older valid fallback.
      const lines = bytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
      lines.find(entry => entry.id === allTodos[5]!.id).parentId = "missing-native-parent";
      writeFileSync(nativeSession.sessionFile!, lines.map(entry => JSON.stringify(entry)).join("\n") + "\n");
      cutOnly.head(cutGeneration, reopenedInitialHead, reopened.session.sessionManager.getEntries());
      const unprovable = recovered(cutOnly, ref);
      expect(unprovable.pages[0]!.binding!.todoHead).toEqual({ state: "unavailable" });
      const unprovableRecord = unprovable.output.find(record => record.nativeEntryId === allTodos[5]!.id);
      expect(unprovableRecord?.kind).toBe("tool");
      expect(unprovableRecord?.kind === "tool" && unprovableRecord.payload.todoSnapshot).toBeUndefined();
      // Structurally corrupt native messages must still announce unavailable, not lose capability metadata.
      lines.find(entry => entry.id === allTodos[5]!.id).message = null;
      writeFileSync(nativeSession.sessionFile!, lines.map(entry => JSON.stringify(entry)).join("\n") + "\n");
      const corrupt = cutOnly.read(ref, undefined, true);
      expect(corrupt.binding!.todoHead).toEqual({ state: "unavailable" });
      expect(corrupt.gaps).toContain("capture_failed");
      writeFileSync(nativeSession.sessionFile!, bytes);
      cutOnly.head(cutGeneration, rootEntry.id, reopened.session.sessionManager.getEntries());
      expect(cutOnly.read(ref, undefined, true).binding!.todoHead).toEqual({ state: "ready", sourceEntryId: null });
      console.log("NATIVE_TODO_CUT_REJECTION", method, JSON.stringify({ cut: cutHeader.cut,
        frozenHead: cutHeader.binding, issuedCutFragment, outsideHead: invalid,
        unprovableHead: reopenedInitialHead, notifications: rejectedNotifications,
        independentLive: allTodos[0]!.id, rejectedOnly: allTodos[1]!.id }));
    } finally {
      cutOnly.onChange = undefined;
      writeFileSync(nativeSession.sessionFile!, bytes);
      cutOnly.retire();
    }
    const budgeted = new PublicConversation({ worker: 4096, owner: 8192 });
    fixture.beforeRelease(() => { budgeted.retire(); });
    budgeted.bind(Symbol());
    const budgetGeneration = budgeted.binding(detail.bindings[0]!.historyId, reopened.session.sessionManager.getSessionId(),
      nativeSession.sessionFile);
    budgeted.head(budgetGeneration, reopenedInitialHead, reopened.session.sessionManager.getEntries());
    const bounded = budgeted.read(ref, undefined, true);
    expect(bounded).toMatchObject({ state: "ready", binding: { todoHead: { state: "unavailable" } },
      changes: [], gaps: ["not_captured", "unsupported_content"] });
    budgeted.retire();
    const replayBudget = new PublicConversation({ worker: 60000, owner: 120000 });
    fixture.beforeRelease(() => { replayBudget.retire(); });
    replayBudget.bind(Symbol());
    const replayGeneration = replayBudget.binding(detail.bindings[0]!.historyId,
      reopened.session.sessionManager.getSessionId(), nativeSession.sessionFile);
    replayBudget.head(replayGeneration, reopenedInitialHead, reopened.session.sessionManager.getEntries());
    // Each native line fits; the cumulative replay/snapshot cannot. Declare the budget gap too.
    expect(replayBudget.read(ref, undefined, true)).toMatchObject({ state: "ready",
      binding: { todoHead: { state: "unavailable" } }, changes: [], gaps: ["not_captured", "unsupported_content"] });
    replayBudget.retire();
    console.log("NATIVE_TODO_EDGES", method, JSON.stringify({ timing, deleted: allTodos[3]!.id, clear: allTodos[4]!.id,
      reuse: allTodos[5]!.id, compactedHead, custom, root: rootEntry.id, reopenedInitialHead,
      publishedInvalid, appended, invalid, reopenedHead: reopened.session.sessionManager.getLeafId() }));
    const copiedFile = path.join(root, "foreign-copy.jsonl");
    copyFileSync(nativeSession.sessionFile!, copiedFile);
    for (const manager of [SessionManager.open(copiedFile), SessionManager.inMemory(root)]) {
      const foreign = await fixture.acquire(createAgentSession({ ...sessionOptions!, tools: ["todo"], sessionManager: manager }));
      const rejected = new PublicConversation();
      const rejectedProducer = createPublicProducer(foreign.session, registeredHistory);
      rejectedProducer.attach(rejected);
      expect(rejected.metadata(detail.ref)).toMatchObject({ capture: "incomplete", captureReason: "capture_failed", bindings: [] });
      await rejectedProducer.close(); await foreign.session.dispose(); rejected.retire();
    }
    requests = 0;
    const secondLaunch = await tools.get(method)!.execute("second-todo-launch", { role: "researcher", task: "second todo worker" },
      new AbortController().signal, undefined, { cwd: root, sessionManager: {
        getSessionId: () => owner.sessionId, getSessionFile: () => path.join(root, "coordinator.jsonl") } } as never);
    if (secondLaunch.isError) throw Error(JSON.stringify(secondLaunch));
    await fixture.settleRuns();
    const secondId = (secondLaunch.details as { instanceId: string }).instanceId;
    const second = await client.publicDetail(secondId);
    if (!("format" in second)) throw Error(JSON.stringify(second));
    const secondRef = second.bindings[0]!.ref;
    const secondRecords = await records(client, secondRef);
    const secondSnapshot = secondRecords.output.filter(record => record.kind === "tool" && record.toolCallId === "todo-6").at(-1)!;
    expect(secondSnapshot).toMatchObject({ payload: { todoSnapshot: { tasks: [{ id: 1, subject: "reused" }] } } });
    expect(secondSnapshot.nativeEntryId).not.toBe(allTodos[5]!.id);
    expect(secondRef.native).not.toEqual(ref.native);
    await expect(client.publicActivity({ ...secondRef, native: ref.native })).rejects.toMatchObject({ code: "unknown_target" });
    await expect(client.publicActivity(secondRef, frozen.next!)).rejects.toMatchObject({ code: "invalid_cursor" });
  }));

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
      if (evaluation) await retireTeamEvaluation(evaluation);
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
    const handle = launch.details as { instanceId: string; id?: string; teamId?: string; memberId?: string };
    expect(accepted).toMatchObject({ worker: { source: method, instanceId: handle.instanceId,
      roleId: "researcher", toolCallId, coordinatorSessionId: owner.sessionId, linkage: "tool",
      ...(method === "team_assign" ? { assignmentId: handle.id, teamId: handle.teamId, memberId: handle.memberId } : {}) }, workbrief: { text: "public brief" } });
    expect(accepted!.ref.native).toBeUndefined(); expect(sessions).toHaveLength(0);
    nativeRelease.release();
    await toolEntered.promise;
    expect(sessions[0]!.isStreaming).toBe(true);
    const detail = await client.publicDetail(handle.instanceId);
    if (!("format" in detail)) throw Error(JSON.stringify(detail));
    expect(detail.lifecycle).toMatchObject({ execution: "running", result: "pending", capture: "open" });
    expect(detail.bindings).toHaveLength(1);
    expect(detail.worker).toEqual({ ...accepted!.worker, turnId: `${handle.instanceId}:turn:1` });
    expect(detail.bindings[0]!.attempts[0]!.activated).toMatchObject({ model: "public-fixture/local" });
    expect(detail.ref).not.toHaveProperty("evaluationId");
    expect(detail.ref).not.toHaveProperty("attemptId");
    expect(detail.bindings[0]!.ref).not.toHaveProperty("evaluationId");
    const ref = detail.bindings[0]!.ref;
    const snapshot = await records(client, ref);
    const nativeUser = sessions[0]!.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
    if (method === "team_assign") {
      expect(JSON.stringify(nativeUser)).toContain(
        `Team assignment header: Team ${handle.teamId}; member ${handle.memberId}; role researcher; assignment ${handle.id}`);
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
    if (evaluation) await retireTeamEvaluation(evaluation);
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
      if (replacementEvaluation) await retireTeamEvaluation(replacementEvaluation);
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
