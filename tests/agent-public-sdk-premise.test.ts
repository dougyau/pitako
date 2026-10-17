import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mutationGeneration, principalLeases, reserveOperation } from "../extensions/agent/head/operation-leases.ts";
import { AgentClosureError } from "../extensions/agent/closure.ts";
import { foregroundBash } from "../extensions/agent/head/managed-tools.ts";
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


async function principalLeaseCase(unknownClosure = false) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-principal-leases-")); ownership.directories.push(root);
  const other = mkdtempSync(path.join(tmpdir(), "pitako-principal-disjoint-")); ownership.directories.push(other);
  const entered = gate(), release = gate(), nestedEntered = gate(), nestedRelease = gate();
  ownership.beforeRelease(() => { release.release(); nestedRelease.release(); });
  const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null,
    modelsStorePath: path.join(root, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
  const writeParams = Type.Object({ path: Type.String() });
  let calls = 0, writes = 0; const nested: unknown[] = [];
  runtime.registerProvider("lease-fixture", { api: "openai-completions", apiKey: "offline-fixture", baseUrl: "http://offline.invalid",
    models: [{ id: "local", name: "local", reasoning: false, input: ["text"], contextWindow: 128000,
      maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream(); calls++;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: calls === 1 ? [{ type: "toolCall", id: "principal-held", name: "write", arguments: { path: "held.md" } }]
          : calls === 3 ? [{ type: "toolCall", id: "codemode-admitted", name: "codemode", arguments: { code: "return await tools.write({ path: 'codemode.md' });" } }]
          : calls === 5 ? [{ type: "toolCall", id: "codemode-blocked", name: "codemode", arguments: { code: "return await tools.write({ path: 'bypass.md' });" } },
            { type: "toolCall", id: "nested-parent", name: "read", arguments: {} },
            { type: "toolCall", id: "principal-blocked", name: "write", arguments: { path: "blocked.md" } }]
          : calls === 7 ? [
            { type: "toolCall", id: "unknown-write", name: "write", arguments: { path: "unknown.md" } },
            { type: "toolCall", id: "unknown-edit", name: "edit", arguments: { path: "codemode.md", oldText: "product", newText: "bypass" } },
            { type: "toolCall", id: "unknown-bash", name: "bash", arguments: { command: "printf bypass > unknown-bash" } },
            { type: "toolCall", id: "unknown-codemode", name: "codemode", arguments: { code: "return await tools.write({ path: 'unknown-codemode.md' });" } },
            { type: "toolCall", id: "unknown-nested", name: "read", arguments: {} },
          ]
          : [{ type: "text", text: "done" }],
        stopReason: [1, 3, 5, 7].includes(calls) ? "toolUse" : "stop", timestamp: calls,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }); stream.end(); return stream;
    } });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let foregroundCalls = 0;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createCodemodeExtension({ models: false }), pi => principalLeases(pi, {
      async exec(command, cwd, options) {
        foregroundCalls++;
        if (command === "controlled-unknown") throw new AgentClosureError([new Error("controlled group observation failure")], "principal fixture");
        return foregroundBash.exec(command, cwd, options);
      },
    })] });
  await loader.reload();
  const { session } = await ownership.acquire(createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
    model: runtime.getModel("lease-fixture", "local"), resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.create(root, path.join(root, "sessions")), tools: ["write", "edit", "read", "bash", "codemode"],
    customTools: [{ name: "write", label: "write", description: "controlled writer", parameters: writeParams,
      async execute(_id, params) {
        const target = (params as Static<typeof writeParams>).path;
        writes++; entered.release(); await release.promise;
        if (target === "codemode.md") { nestedEntered.release(); await nestedRelease.promise; }
        writeFileSync(path.join(root, target), "product"); return { content: [], details: {} };
      } },
    { name: "read", label: "read", description: "controlled nested boundary", parameters: Type.Object({}),
      async execute(_id, _params, _signal, _update, ctx) {
        nested.push(await ctx.executeTool("write", { path: "nested.md" }));
        return { content: [], details: {} };
      } }] }));
  await session.bindExtensions({});
  const first = ownership.run(session.prompt("write", { expandPromptTemplates: false })); await entered.promise;
  expect(() => reserveOperation(root, "gates")).toThrow("active");
  release.release(); await first;
  const composition = ownership.run(session.prompt("nested codemode write", { expandPromptTemplates: false }));
  await Promise.race([nestedEntered.promise, composition.then(() => { throw new Error("codemode settled without nested writer: " + JSON.stringify(session.messages)); })]);
  expect(() => reserveOperation(root, "gates")).toThrow("active");
  nestedRelease.release(); await composition;
  expect(existsSync(path.join(root, "codemode.md"))).toBe(true);
  const lease = reserveOperation(root, "gates");
  try {
    await ownership.run(session.prompt("nested and direct", { expandPromptTemplates: false }));
    expect(writes).toBe(2); expect(nested).toHaveLength(1);
    expect(existsSync(path.join(root, "bypass.md"))).toBe(false);
    expect(JSON.stringify(nested)).toContain("lease"); expect(existsSync(path.join(root, "nested.md"))).toBe(false);
    for (const excludeFromContext of [false, true]) {
      const hook = await session.extensionRunner.emitUserBash({ type: "user_bash", cwd: root, command: "printf bypass > blocked", excludeFromContext });
      expect(hook).toHaveProperty("operations");
      await expect(session.executeBash("printf bypass > blocked", undefined, { excludeFromContext, operations: hook!.operations })).rejects.toThrow("lease");
    }
    // A returned operations object stays owned until its executor settles, not until the hook returns.
    const hook = await session.extensionRunner.emitUserBash({ type: "user_bash", cwd: root, command: "unused", excludeFromContext: false });
    const independent = reserveOperation(other, "writer"); independent.release();
    expect(existsSync(path.join(root, "blocked"))).toBe(false);
    expect(hook).toHaveProperty("operations");
  } finally { lease.release(); }
  const hook = await session.extensionRunner.emitUserBash({ type: "user_bash", cwd: root, command: "printf ordinary", excludeFromContext: true });
  expect((await session.executeBash("printf ordinary", undefined, { excludeFromContext: true, operations: hook!.operations })).output).toBe("ordinary");
  if (unknownClosure) {
    const before = mutationGeneration(root);
    await expect(session.executeBash("controlled-unknown", undefined, { operations: hook!.operations })).rejects.toThrow("closure");
    expect(mutationGeneration(root)).toBeGreaterThan(before);
    const afterFailure = mutationGeneration(root), executed = foregroundCalls;
    for (const excludeFromContext of [false, true]) {
      await expect(session.executeBash("printf forbidden", undefined, { excludeFromContext, operations: hook!.operations })).rejects.toThrow("unknown");
    }
    await ownership.run(session.prompt("writers after unknown closure", { expandPromptTemplates: false }));
    expect(writes).toBe(2);
    expect(foregroundCalls).toBe(executed);
    expect(mutationGeneration(root)).toBe(afterFailure);
    expect(readFileSync(path.join(root, "codemode.md"), "utf8")).toBe("product");
    for (const name of ["unknown.md", "unknown-bash", "unknown-codemode.md", "nested.md"]) expect(existsSync(path.join(root, name))).toBe(false);
    expect(nested).toHaveLength(2);
    expect(JSON.stringify(nested[1])).toContain("unknown");
    expect(() => reserveOperation(undefined, "writer")).toThrow("unknown");
    expect(() => reserveOperation(root, "checkpoint")).toThrow("unknown");
    expect(() => reserveOperation(root, "gates")).toThrow("unknown");
    const independent = reserveOperation(other, "writer"); independent.release();
    expect((await hook!.operations!.exec("printf disjoint", other, { onData() {} })).exitCode).toBe(0);
    // The injected observation error owns no process. The retained host lease is
    // not cleared; child-host exit, not fabricated release, isolates it.
  }
  await session.dispose();
}

test("principal real SDK tool_call, nested ctx.executeTool, and user_bash operations share gate leases",
  ownership.ownedCase("principal leases", () => principalLeaseCase()));

const unknownWriterCase = "retained unknown principal executor fences real SDK writers and unscoped compositions";
test(unknownWriterCase, ownership.ownedCase("unknown principal lease", async () => {
  if (process.env.PITAKO_UNKNOWN_PRINCIPAL_HOST === "1") return principalLeaseCase(true);
  console.log(execFileSync(process.execPath, ["test", import.meta.path, "--test-name-pattern", `^${unknownWriterCase}$`], {
    env: { ...process.env, PITAKO_UNKNOWN_PRINCIPAL_HOST: "1", BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" }, encoding: "utf8",
  }));
}));
