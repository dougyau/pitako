import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AgentSession, createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkerHistory, SessionHistory, nativeHistoryStatus } from "../extensions/agent/history.ts";
import { executionForSession } from "../extensions/execution-identity.ts";
import { classifyProviderFailure } from "../extensions/agent/fallback.ts";
import { activateTarget, createPiExecutor, cursorProviderContext, DEFAULT_THINKING_LEVEL, managedSettingsManager, shouldBypassProviderAdmission } from "../extensions/agent/pi.ts";
import { runAgentInstance, teamExecutionSummary } from "../extensions/agent/run.ts";
import { childActiveTools, ORCHESTRATION_TOOLS } from "../extensions/profile.ts";
import { loadPitako } from "../scripts/load-pitako.ts";
import { packageRoot } from "../extensions/stack.ts";
import { providerFixtureOwnership } from "./fixtures/provider-fixture-ownership.ts";
import type { ResolvedRole } from "../extensions/roles/types.ts";

const fixture = providerFixtureOwnership();
const tempDirs = fixture.directories;
afterEach(fixture.requireReleasedFixture);

describe("cursor request", () => {
  test("managed provider retry and automatic compaction are disabled", () => {
    const settings = managedSettingsManager();
    expect(settings.getRetrySettings()).toMatchObject({ enabled: false, maxRetries: 0 });
    expect(settings.getProviderRetrySettings().maxRetries).toBe(0);
    expect(settings.getCompactionSettings().enabled).toBe(false);
  });

  test("managed requests with alternate SDK session ids still require provider admission", () => {
    expect(shouldBypassProviderAdmission(true, "compaction-session", "attempt-session")).toBe(false);
    expect(shouldBypassProviderAdmission(true, "retry-session", "attempt-session")).toBe(false);
    expect(shouldBypassProviderAdmission(false, "other-session", "attempt-session")).toBe(true);
    expect(shouldBypassProviderAdmission(true, undefined, "attempt-session")).toBe(false);
  });

  test("keeps session tools on the provider context", () => {
    const tools = [{ name: "bash", description: "run", parameters: { type: "object" } }];
    const context = cursorProviderContext(
      { provider: "cursor", api: "cursor-native" },
      { systemPrompt: "Pitako", messages: [], tools: tools as never },
    );
    expect(context.tools).toEqual(tools);
    expect(cursorProviderContext({ provider: "xai" }, { messages: [], tools: tools as never }).tools).toEqual(tools);
  });

  test.serial("managed attempts refuse Cursor-native execution before provider invocation", fixture.ownedCase("managed attempts refuse Cursor-native execution before provider invocation", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-managed-cursor-"));
    tempDirs.push(cwd);
    const effects = {} as never;
    const durable = {
      attemptId: "22345678-1234-4234-8234-123456789abc",
      sessionDir: path.join(cwd, "session"),
      sessionId: "managed-attempt",
      readOnly: false,
      effects,
      rolePolicy: { primary: { model: "cursor/native" }, fallbacks: [] },
      onProviderDispatch() { throw new Error("native provider must not dispatch"); },
      onProviderReceipt() { throw new Error("native provider must not return a receipt"); },
    };
    const result = await fixture.acquire(createPiExecutor().start({
      instanceId: "managed-cursor-denied",
      role: lateRole,
      task: "attempt native bypass",
      target: { model: "cursor/native" },
      cwd,
      signal: new AbortController().signal,
      durable: durable as never,
    }));
    expect(result.status).toBe("failed");
    expect(result.result).toContain("bypasses fenced local adapters");
  }));
});

describe("pi adapter boundary", () => {
  test.serial("restores persisted catalogs before primary and fallback child activation offline", fixture.ownedCase("restores persisted catalogs before primary and fallback child activation offline", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-cached-agent-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-cached-cwd-"));
    tempDirs.push(agentDir, cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const cachedModel = (provider: string, id: string) => ({
      provider, id, name: id, api: "openai-responses", baseUrl: "http://127.0.0.1:1",
      reasoning: true, input: ["text"], contextWindow: 10000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const cachePath = path.join(agentDir, "models-store.json");
    writeFileSync(cachePath, JSON.stringify({
      openai: { models: [cachedModel("openai", "pitako-cache-only")], checkedAt: 1, lastModified: Date.now() },
      xai: { models: [cachedModel("xai", "grok-4.7")], checkedAt: 1, lastModified: Date.now() },
    }));
    writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
      openai: { type: "api_key", key: "fixture-only" },
      xai: { type: "api_key", key: "fixture-only" },
    }));
    const cacheBefore = readFileSync(cachePath, "utf8");
    const authBefore = readFileSync(path.join(agentDir, "auth.json"), "utf8");
    let networkCalls = 0;
    Object.defineProperty(globalThis, "fetch", { configurable: true,
      value: async () => { networkCalls++; throw new Error("cache fixture forbids network"); } });
    const staticRuntime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
    expect(staticRuntime.getModel("openai", "pitako-cache-only")).toBeUndefined();
    expect(staticRuntime.getModel("xai", "grok-4.7")).toBeUndefined();
    const activations: Array<{ model: string; reasoning: string }> = [];
    let stop = new AbortController();
    let child: AgentSession;
    let binds = 0, prompts = 0, disposals = 0;
    const bind = AgentSession.prototype.bindExtensions;
    const binding = spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function (this: AgentSession, ...args) {
      await bind.apply(this, args);
      binds++;
      child = this;
      this.prompt = async () => { prompts++; throw new Error("cache fixture must not prompt"); };
      const dispose = this.dispose.bind(this);
      this.dispose = async () => { disposals++; await dispose(); };
    });
    const telemetry = process.env.PI_TELEMETRY;
    // Synthetic cache-only activation must not report installed extensions.
    process.env.PI_TELEMETRY = "0";
    try {
      for (const fallback of [false, true]) {
        stop = new AbortController();
        const target = fallback ? { model: "xai/grok-4.7", reasoning: "high" as const, fast: true }
          : { model: "openai/pitako-cache-only", reasoning: "medium" as const, fast: false };
        const attemptId = fallback ? "32345678-1234-4234-8234-123456789abc" : "22345678-1234-4234-8234-123456789abc";
        const result = await fixture.run(runAgentInstance({
          roleId: "developer", cwd, task: "exact cache-only task", signal: stop.signal,
          executor: {
            capturesHistory: true,
            start(input) {
              return createPiExecutor().start({ ...input, onActivated(reasoning) {
                input.onActivated?.(reasoning);
                activations.push({ model: `${child.model!.provider}/${child.model!.id}`, reasoning });
                stop.abort();
              } });
            },
          },
          durable: {
            attemptId, sessionId: attemptId, sessionDir: path.join(agentDir, attemptId), readOnly: true,
            rolePolicy: { primary: fallback ? { model: "pitako-absent/primary" } : target, fallbacks: fallback ? [target] : [] },
            onProviderDispatch() { throw new Error("cache fixture must not dispatch"); },
            onProviderReceipt() { throw new Error("cache fixture must not receipt"); },
          },
        }));
        console.log("offline cached child", JSON.stringify({ fallback, status: result.status, model: result.model, activations, binds, prompts, disposals, networkCalls }));
        expect(result.status).toBe("cancelled");
        expect(result.model).toMatchObject({ selectedModel: target.model, fallbackOccurred: fallback, requestedReasoning: target.reasoning });
      }
      expect(activations).toEqual([
        { model: "openai/pitako-cache-only", reasoning: "medium" },
        { model: "xai/grok-4.7", reasoning: "high" },
      ]);
      expect({ binds, prompts, disposals, networkCalls }).toEqual({ binds: 2, prompts: 0, disposals: 2, networkCalls: 0 });
      expect(readFileSync(cachePath, "utf8")).toBe(cacheBefore);
      expect(readFileSync(path.join(agentDir, "auth.json"), "utf8")).toBe(authBefore);
    } finally {
      binding.mockRestore();
      if (telemetry === undefined) delete process.env.PI_TELEMETRY;
      else process.env.PI_TELEMETRY = telemetry;
    }
  }), 60_000);

  test.serial("construction enables grep, find, and ls without session_start", fixture.ownedCase("construction enables grep, find, and ls without session_start", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-agent-tools-"));
    tempDirs.push(agentDir);
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-agent-tools-cwd-"));
    tempDirs.push(cwd);
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    const model = runtime.getModels()[0];
    if (!model) throw new Error("Pi static catalog has no model");
    const loaded = await loadPitako(packageRoot(), cwd);
    tempDirs.push(loaded.agentDir);
    const { session } = await fixture.acquire(createAgentSession({
      cwd,
      agentDir,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      modelRuntime: runtime,
      resourceLoader: loaded.loader,
      excludeTools: [...ORCHESTRATION_TOOLS],
    }));
    const available = session.getAllTools().map((tool) => tool.name);
    session.setActiveToolsByName(childActiveTools(available));
    const active = session.getActiveToolNames();
    expect(available).toEqual(expect.arrayContaining(["grep", "find", "ls", "read", "project_report", "read_symbol", "read_enclosing", "module_report", "inspect_symbol", "review_surface", "codegraph_search", "lsp_diagnostics"]));
    expect(active).toEqual(expect.arrayContaining(["read", "grep", "bash", "edit", "find", "ls", "project_report", "read_symbol", "read_enclosing", "module_report", "inspect_symbol", "review_surface", "codegraph_search", "lsp_diagnostics"]));
    for (const tool of ORCHESTRATION_TOOLS) expect(active).not.toContain(tool);
  }), 60_000);
  test.serial("in-memory session starts empty, setModel auth failure is fallback-worthy, and reasoning is not forced", fixture.ownedCase("in-memory session starts empty, setModel auth failure is fallback-worthy, and reasoning is not forced", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-agent-pi-"));
    tempDirs.push(agentDir);
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-agent-cwd-"));
    tempDirs.push(cwd);
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const model = runtime.getModels()[0];
    if (!model) throw new Error("Pi static catalog has no model");
    const parent = SessionManager.inMemory(cwd);
    const child = SessionManager.inMemory(cwd);
    expect(parent.getSessionId()).not.toBe(child.getSessionId());
    const { session } = await fixture.acquire(createAgentSession({
      cwd,
      agentDir,
      model,
      sessionManager: child,
      modelRuntime: runtime,
      excludeTools: [...ORCHESTRATION_TOOLS],
      noTools: "builtin",
    }));
    expect(session.messages).toEqual([]);
    session.setActiveToolsByName(childActiveTools(session.getAllTools().map((tool) => tool.name)));
    const active = session.getActiveToolNames();
    for (const name of ["grep", "find", "ls", "read"]) {
      if (session.getAllTools().some((tool) => tool.name === name)) expect(active).toContain(name);
    }
    for (const tool of ORCHESTRATION_TOOLS) expect(active).not.toContain(tool);
    await expect(session.setModel(model, { persist: false })).rejects.toThrow(/No API key/);
    const thrown = await activateTarget(
      {
        async setModel() {
          throw new Error("No API key for cursor/grok-4.7");
        },
        setThinkingLevel() {
          throw new Error("should not set reasoning when activation fails");
        },
      },
      model,
      { model: "cursor/grok-4.7" },
    );
    expect(thrown).toMatch(/No API key/);
    expect(classifyProviderFailure(thrown)).toBe("auth");
    const levels: string[] = [];
    await activateTarget(
      {
        async setModel() {},
        setThinkingLevel(level: string) {
          levels.push(level);
        },
      },
      model,
      { model: "example/explicit", reasoning: "high" },
    );
    expect(levels).toEqual(["high"]);
    levels.length = 0;
    await activateTarget(
      {
        async setModel() {},
        setThinkingLevel(level: string) {
          levels.push(level);
        },
      },
      model,
      { model: "example/default" },
    );
    expect(levels).toEqual([DEFAULT_THINKING_LEVEL]);
  }), 60_000);

  test.serial("continue without reasoning does not inherit xhigh", fixture.ownedCase("continue without reasoning does not inherit xhigh", async () => {
    let level = "xhigh";
    await activateTarget(
      {
        async setModel() {},
        setThinkingLevel(next: string) {
          level = next;
        },
      },
      { provider: "example", id: "continue" } as never,
      { model: "example/continue" },
    );
    expect(level).not.toBe("xhigh");
    expect(level).toBe(DEFAULT_THINKING_LEVEL);
  }));
});

const lateRole: ResolvedRole = {
  id: "developer",
  name: "Developer",
  description: "test",
  instructionsPath: "roles/developer.md",
  instructions: "Reply exactly.",
  skills: [],
  principles: [],
  modelPolicyId: "developer",
  modelPolicy: { id: "developer", fallbacks: [] },
};

describe("extension provider bind", () => {
  async function installLateProvider() {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-late-agent-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-late-cwd-"));
    tempDirs.push(agentDir, cwd);
    mkdirSync(path.join(agentDir, "extensions"));
    writeFileSync(
      path.join(agentDir, "extensions", "late.js"),
      "export default function (pi) { pi.registerProvider('pitako-late', globalThis.__pitakoLateProvider); }\n",
    );
    const calls: string[] = [];
    const specifier = "@earendil-works/pi-ai/utils/event-stream.js";
    const { createAssistantMessageEventStream } = await import(specifier);
    const provider = {
      baseUrl: "http://127.0.0.1",
      apiKey: "test",
      api: "openai-completions",
      models: [
        {
          id: "late",
          name: "Late",
          reasoning: false,
          input: ["text"],
          cost: { input: 100, output: 200, cacheRead: 50, cacheWrite: 100 },
          contextWindow: 1000,
          maxTokens: 64,
        },
      ],
      streamSimple(model: { id: string }, context: { messages?: unknown[] }, _options?: { onPayload?: (body: unknown, model: unknown) => unknown }) {
        calls.push(`${model.id}:${JSON.stringify(context.messages ?? [])}`);
        const stream = createAssistantMessageEventStream();
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "pong" }],
          api: "openai-completions",
          provider: "pitako-late",
          model: model.id,
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 10,
            output: 3,
            cacheRead: 4,
            cacheWrite: 1,
            totalTokens: 18,
            cost: { input: 0.001, output: 0.0006, cacheRead: 0.0002, cacheWrite: 0.0001, total: 0.0019 },
          },
        };
        queueMicrotask(() => {
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        });
        return stream;
      },
    };
    (globalThis as { __pitakoLateProvider?: unknown }).__pitakoLateProvider = provider;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    return { calls, cwd, provider };
  }

  test.serial("durable pre-prompt fallback retains real native identity without provider requests", fixture.ownedCase("durable pre-prompt fallback retains real native identity without provider requests", async () => {
    const { cwd, provider, calls } = await installLateProvider();
    provider.streamSimple = () => { calls.push("FORBIDDEN"); throw new Error("offline fixture must not stream"); };
    const history = new WorkerHistory();
    const missionId = "12345678-1234-4234-8234-123456789abc";
    const attemptId = "22345678-1234-4234-8234-123456789abc";
    const sessionsDirectory = path.join(history.agentDir, "pitako", "sessions");
    const group = history.createGroup(cwd, { kind: "mission", storeRoot: path.join(history.agentDir, "pitako"), missionId },
      { missionStore: { dbPath: path.join(history.agentDir, "pitako", "mission.db"), objectDir: path.join(history.agentDir, "pitako", "objects"), sessionsDirectory } });
    const sessionDir = path.join(sessionsDirectory, missionId, attemptId);
    const stop = new AbortController();
    const managers: SessionManager[] = [];
    let binds = 0, prompts = 0, shutdowns = 0, disposals = 0, activations = 0, dispatches = 0, receipts = 0;
    const bind = AgentSession.prototype.bindExtensions;
    const binding = spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function (this: AgentSession, ...args) {
      binds++;
      managers.push(this.sessionManager);
      expect(executionForSession(this.sessionId)?.roleId).toBe("developer");
      await bind.apply(this, args);
      this.prompt = async () => { prompts++; throw new Error("offline fixture must not prompt"); };
      const setModel = this.setModel.bind(this);
      this.setModel = async (model, options) => {
        await setModel(model, options);
        if (model.provider === "pitako-late") {
          activations++;
          expect(this.sessionManager).toBe(managers[0]);
          expect(existsSync(this.sessionManager.getSessionFile()!)).toBe(false);
          expect(executionForSession(this.sessionId)?.roleId).toBe("developer");
          stop.abort();
        }
      };
      const emit = this.extensionRunner.emit.bind(this.extensionRunner);
      this.extensionRunner.emit = async (event) => {
        if (event.type === "session_shutdown") shutdowns++;
        return emit(event);
      };
      const dispose = this.dispose.bind(this);
      this.dispose = async () => { disposals++; await dispose(); };
    });
    try {
      const result = await fixture.run(runAgentInstance({
        roleId: "developer", cwd, task: "  exact reserved task\n", signal: stop.signal, executor: createPiExecutor(),
        durable: {
          attemptId, sessionId: attemptId, sessionDir, readOnly: true,
          history: { groupId: group.groupId, admission: { roleId: "developer", attemptId, unitId: "unit" } },
          rolePolicy: { primary: { model: "pitako-absent/primary" }, fallbacks: [{ model: "pitako-late/late", reasoning: "off" }] },
          onProviderDispatch() { dispatches++; throw new Error("offline fixture must not dispatch"); },
          onProviderReceipt() { receipts++; throw new Error("offline fixture must not receipt"); },
        },
      }));
      console.log("offline durable fallback", JSON.stringify({ status: result.status, result: result.result, model: result.model,
        binds, prompts, shutdowns, disposals, activations, dispatches, receipts }));
      expect(result.status).toBe("cancelled");
      expect(result.model).toMatchObject({ selectedModel: "pitako-late/late", fallbackOccurred: true, fallbackReason: "unavailable" });
      expect({ binds, prompts, shutdowns, disposals, activations, dispatches, receipts }).toEqual({
        binds: 1, prompts: 0, shutdowns: 1, disposals: 1, activations: 1, dispatches: 0, receipts: 0,
      });
      expect(calls).toEqual([]);
      const catalog = history.read(group.groupId);
      expect(catalog.members).toHaveLength(1);
      const member = catalog.members[0]!;
      expect(member.native).toMatchObject({ state: "allocated", sessionId: attemptId, path: managers[0]!.getSessionFile(), disposition: { state: "disposed" } });
      expect(path.dirname(managers[0]!.getSessionFile()!)).toBe(sessionDir);
      expect(executionForSession(attemptId)).toBeUndefined();
      expect(nativeHistoryStatus(member)).toEqual({ state: "not-persisted-before-assistant" });
      expect(catalog.closure.state).toBe("unclosed");
      const alias = catalog.aliases;
      const otherId = SessionManager.create(cwd, sessionDir);
      const otherPath = SessionManager.create(cwd, path.join(cwd, "different-path"), { id: attemptId });
      for (const other of [otherId, otherPath]) {
        expect(() => history.associateSession(group.groupId, member.historyId, other)).toThrow("managed attempt changed native session identity");
      }
      expect(history.read(group.groupId).members[0]!.native).toEqual(member.native);
      expect(history.read(group.groupId).aliases).toEqual(alias);
    } finally {
      binding.mockRestore();
    }
  }), 60_000);

  test.serial("selects a model that appears only after session bind", fixture.ownedCase("selects a model that appears only after session bind", async () => {
    const { calls, cwd } = await installLateProvider();
    const attempt = await fixture.acquire(createPiExecutor().start({
      instanceId: "developer-late",
      role: lateRole,
      task: "say-pong-marker",
      target: { model: "pitako-late/late", reasoning: "off" },
      cwd,
      signal: new AbortController().signal,
    }));
    expect(attempt.status).toBe("completed");
    expect(attempt.result).toContain("pong");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("late:");
    expect(calls[0]).toContain("say-pong-marker");
    expect(existsSync(path.join(cwd, ".pitako"))).toBe(false);
  }), 60_000);

  test.serial("durable bound terminal routes retain ownership and retire capability at drive", fixture.ownedCase("durable bound terminal routes retain ownership and retire capability at drive", async () => {
    const { cwd, provider, calls } = await installLateProvider();
    provider.streamSimple = () => { calls.push("FORBIDDEN"); throw new Error("offline fixture must not stream"); };
    const modes = ["missing", "fast", "cancel", "disappeared", "activation", "drive", "retry-drive", "transfer"] as const;
    const bind = AgentSession.prototype.bindExtensions;
    const lookup = ModelRuntime.prototype.getModel;
    for (const mode of modes) {
      const history = new WorkerHistory();
      const group = history.createGroup(cwd);
      const attemptId = crypto.randomUUID();
      const sessionDir = path.join(history.agentDir, "owned-terminal", attemptId);
      const stop = new AbortController();
      let bound = false, binds = 0, prompts = 0, shutdowns = 0, disposals = 0;
      const binding = spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function (this: AgentSession, ...args) {
        binds++;
        await bind.apply(this, args);
        bound = true;
        if (mode === "cancel") stop.abort();
        this.prompt = async (task) => {
          prompts++;
          expect(task).toBe(" \nreserved bytes\n ");
          throw new Error("offline drive rejection");
        };
        if (mode === "activation") this.setModel = async () => { throw new Error("No API key for pitako-late"); };
        const emit = this.extensionRunner.emit.bind(this.extensionRunner);
        this.extensionRunner.emit = async (event) => {
          if (event.type === "session_shutdown") shutdowns++;
          return emit(event);
        };
        const dispose = this.dispose.bind(this);
        this.dispose = async () => { disposals++; await dispose(); };
      });
      const looking = spyOn(ModelRuntime.prototype, "getModel").mockImplementation(function (this: ModelRuntime, ...args) {
        if (mode === "disappeared" && bound && args[0] === "pitako-late") return undefined;
        if (mode === "disappeared" && !bound && args[0] === "pitako-late") {
          this.registerProvider("pitako-late", {
            baseUrl: provider.baseUrl, apiKey: provider.apiKey, api: "openai-completions",
            models: provider.models.map((model) => ({ ...model, input: ["text"] })),
            streamSimple() { throw new Error("must not stream"); },
          });
        }
        return lookup.apply(this, args);
      });
      const recording = mode === "transfer" ? spyOn(SessionHistory.prototype, "result").mockImplementation(() => {
        throw new Error("offline history transfer rejection");
      }) : undefined;
      try {
        const pending = createPiExecutor().start({
          instanceId: "developer-terminal", role: lateRole, task: " \nreserved bytes\n ",
          target: { model: ["missing", "retry-drive", "transfer"].includes(mode) ? "pitako-absent/primary" : "pitako-late/late", fast: mode === "fast" },
          cwd, signal: stop.signal,
          durable: { attemptId, sessionId: attemptId, sessionDir, readOnly: true,
            rolePolicy: { primary: { model: "pitako-late/late" }, fallbacks: [] },
            history: { groupId: group.groupId, admission: { roleId: "developer", attemptId } },
            onProviderDispatch() { throw new Error("must not dispatch"); },
            onProviderReceipt() { throw new Error("must not receipt"); } },
        });
        if (mode === "transfer") {
          await expect(pending).rejects.toThrow("offline history transfer rejection");
          expect({ binds, prompts, shutdowns, disposals }).toEqual({ binds: 1, prompts: 0, shutdowns: 1, disposals: 1 });
          expect(executionForSession(attemptId)).toBeUndefined();
          continue;
        }
        let attempt = await fixture.acquire(pending);
        if (mode === "retry-drive") {
          const retained = attempt.session!;
          attempt = await retained.retryBeforePrompt!({ model: "pitako-late/late", reasoning: "off" }, stop.signal);
          expect(retained.retryBeforePrompt).toBeUndefined();
        }
        expect(attempt.status).toBe(mode === "cancel" ? "cancelled" : "failed");
        expect(Boolean(attempt.session?.retryBeforePrompt)).toBe(mode !== "drive" && mode !== "retry-drive");
        if (mode === "fast") expect(attempt.failureKind).toBe("configuration");
        if (mode === "activation") expect(attempt.error).toContain("No API key");
        if (mode === "disappeared" || mode === "missing") expect(attempt.error).toContain("model unavailable");
        expect(binds).toBe(1);
        expect(prompts).toBe(mode === "drive" || mode === "retry-drive" ? 1 : 0);
        expect(disposals).toBe(0);
        await attempt.session!.dispose();
        await attempt.session!.dispose();
        expect({ shutdowns, disposals }).toEqual({ shutdowns: 1, disposals: 1 });
        expect(executionForSession(attemptId)).toBeUndefined();
        expect(history.read(group.groupId).closure.state).toBe("unclosed");
        expect(nativeHistoryStatus(history.read(group.groupId).members[0]!)).toEqual({ state: "not-persisted-before-assistant" });
      } finally {
        recording?.mockRestore();
        looking.mockRestore();
        binding.mockRestore();
      }
    }
    expect(calls).toEqual([]);
  }), 60_000);

  test.serial("a real Pi fallback continues on the same session", fixture.ownedCase("a real Pi fallback continues on the same session", async () => {
    const { calls, cwd } = await installLateProvider();
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const provider = (globalThis as { __pitakoLateProvider?: any }).__pitakoLateProvider!;
    provider.models.push({ ...provider.models[0], id: "fallback", name: "Fallback" });
    const originalStream = provider.streamSimple;
    const eventStreamModule: string = "@earendil-works/pi-ai/utils/event-stream.js";
    const { createAssistantMessageEventStream } = await import(eventStreamModule);
    provider.streamSimple = (model: { id: string }, context: { messages?: unknown[] }) => {
      if (model.id !== "late") return originalStream(model, context);
      calls.push(`late:${JSON.stringify(context.messages ?? [])}`);
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant", content: [], api: "openai-completions", provider: "pitako-late", model: model.id,
        stopReason: "error", errorMessage: "No API key for pitako-late/late", timestamp: Date.now(),
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => { stream.push({ type: "done", reason: "error", message }); stream.end(message); });
      return stream;
    };
    const userConfigPath = path.join(agentDir, "pitako", "config.toml");
    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    writeFileSync(userConfigPath, [
      "[model_policies.developer.primary]", 'model = "pitako-late/late"', 'reasoning = "off"',
      "[[model_policies.developer.fallbacks]]", 'model = "pitako-late/fallback"', 'reasoning = "high"', "",
    ].join("\n"));
    const result = await fixture.run(runAgentInstance({
      roleId: "developer", task: "say-pong-marker", cwd,
      executor: createPiExecutor(), load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath },
    }));
    expect(result.status).toBe("completed");
    expect(result.result).toBe("pong");
    expect(result.model.fallbackOccurred).toBe(true);
    expect(calls.map((call) => call.split(":")[0])).toEqual(["late", "fallback"]);
    expect(calls[1]).toContain("say-pong-marker");
  }), 60_000);

  test.serial("a real AgentInstance through Pi preserves observed model and usage", fixture.ownedCase("a real AgentInstance through Pi preserves observed model and usage", async () => {
    const { cwd } = await installLateProvider();
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const userConfigPath = path.join(agentDir, "pitako", "config.toml");
    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    writeFileSync(userConfigPath, `[model_policies.developer.primary]\nmodel = "pitako-late/late"\nreasoning = "off"\n`);

    const result = await fixture.run(runAgentInstance({
      roleId: "developer", task: "say-pong-marker", cwd,
      executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath },
    }));
    expect(result.status).toBe("completed");
    expect(result.model.selectedModel).toBe("pitako-late/late");
    expect(result.model.appliedReasoning).toBe("off");
    expect(result.watchdog?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.usage).toMatchObject({ input: 10, output: 3, cacheRead: 4, cacheWrite: 1, cost: 0.0019, turns: 1, toolCalls: 0 });
    expect(result.usage?.contextTokens).toBeGreaterThan(0);
    const summary = teamExecutionSummary("pi-assignment", result);
    expect(summary).toMatchObject({
      assignmentId: "pi-assignment", selectedModel: "pitako-late/late", provider: "pitako-late", appliedReasoning: "off",
      input: 10, output: 3, cacheRead: 4, cacheWrite: 1, turns: 1, toolCalls: 0,
    });
    expect(summary.estimatedCost).toBeCloseTo(0.0019);
  }), 60_000);

  test.serial("concurrent child sessions account dense and raw tool events independently", fixture.ownedCase("concurrent child sessions account dense and raw tool events independently", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-telemetry-agent-"));
    const dirs = [mkdtempSync(path.join(tmpdir(), "pitako-telemetry-one-")), mkdtempSync(path.join(tmpdir(), "pitako-telemetry-two-"))];
    tempDirs.push(agentDir, ...dirs);
    mkdirSync(path.join(agentDir, "extensions"));
    writeFileSync(path.join(agentDir, "extensions", "telemetry.js"), "export default function (pi) { pi.registerProvider('pitako-telemetry', globalThis.__pitakoTelemetryProvider); }\n");
    const streamModule: string = "@earendil-works/pi-ai/utils/event-stream.js";
    const { createAssistantMessageEventStream } = await import(streamModule);
    let sequence = 0;
    (globalThis as { __pitakoTelemetryProvider?: unknown }).__pitakoTelemetryProvider = {
      baseUrl: "http://127.0.0.1",
      apiKey: "test",
      api: "openai-completions",
      models: [{ id: "late", name: "Late", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 64 }],
      streamSimple(model: { id: string }, context: { messages?: any[] }) {
        const messages = context.messages ?? [];
        const hasReport = messages.some((message) => message.role === "assistant" && message.content?.some((part: any) => part.type === "toolCall" && part.name === "project_report"));
        const reads = messages.filter((message) => message.role === "toolResult" && message.toolName === "read").length;
        const content = !hasReport
          ? [{ type: "toolCall", id: `telemetry-${sequence++}`, name: "project_report", arguments: {} }]
          : reads < 5
            ? [{ type: "toolCall", id: `telemetry-${sequence++}`, name: "read", arguments: { path: `src/sample-${reads}.ts` } }]
            : [{ type: "text", text: "telemetry-complete" }];
        const stream = createAssistantMessageEventStream();
        const stopReason = content[0]?.type === "toolCall" ? "toolUse" : "stop";
        const message = { role: "assistant", content, api: "openai-completions", provider: "pitako-telemetry", model: model.id, stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(() => { stream.push({ type: "done", reason: stopReason, message }); stream.end(message); });
        return stream;
      },
    };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    for (const dir of dirs) {
      mkdirSync(path.join(dir, "src"));
      for (let index = 0; index < 5; index++) writeFileSync(path.join(dir, "src", `sample-${index}.ts`), "export const value = 1;\n");
    }
    const executor = createPiExecutor();
    const attempts = await Promise.all(dirs.map((cwd, index) => fixture.acquire(executor.start({
      instanceId: `developer-telemetry-${index}`,
      role: lateRole,
      task: `inspect-child-${index}`,
      target: { model: "pitako-telemetry/late", reasoning: "off" },
      cwd,
      signal: new AbortController().signal,
    }))));
    for (const attempt of attempts) {
      expect(attempt.status, attempt.error).toBe("completed");
      expect(attempt.usage?.codeIntelligence?.dense.project_report?.calls).toBe(1);
      expect(attempt.usage?.codeIntelligence?.raw.read).toBe(5);
      expect(attempt.usage?.codeIntelligence?.navigation).toMatchObject({ completedCalls: 5, read: 5, grep: 0, remaining: 0 });
      expect(attempt.usage?.codeIntelligence?.sources.git?.calls).toBeGreaterThan(0);
      expect(attempt.usage?.tools?.project_report).toBe(1);
    }
    expect(sequence).toBe(12);
  }), 60_000);

  test.serial("failed and cancelled dense child calls retain one attributed outcome", fixture.ownedCase("failed and cancelled dense child calls retain one attributed outcome", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-telemetry-outcomes-agent-"));
    const dirs = [mkdtempSync(path.join(tmpdir(), "pitako-telemetry-failed-")), mkdtempSync(path.join(tmpdir(), "pitako-telemetry-cancelled-"))];
    tempDirs.push(agentDir, ...dirs);
    mkdirSync(path.join(agentDir, "extensions"));
    writeFileSync(path.join(agentDir, "extensions", "telemetry.js"), "export default function (pi) { pi.registerProvider('pitako-telemetry', globalThis.__pitakoTelemetryProvider); }\n");
    const streamModule: string = "@earendil-works/pi-ai/utils/event-stream.js";
    const { createAssistantMessageEventStream } = await import(streamModule);
    let sequence = 0;
    (globalThis as { __pitakoTelemetryProvider?: unknown }).__pitakoTelemetryProvider = {
      baseUrl: "http://127.0.0.1", apiKey: "test", api: "openai-completions",
      models: [{ id: "late", name: "Late", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 64 }],
      streamSimple(model: { id: string }, context: { messages?: any[] }) {
        const messages = context.messages ?? [];
        const complete = messages.some((message) => message.role === "toolResult" && message.toolName === "read_enclosing");
        const content = complete
          ? [{ type: "text", text: "query-finished" }]
          : [{ type: "toolCall", id: `failure-${sequence++}`, name: "read_enclosing", arguments: { file: "missing.ts", line: 1 } }];
        const stream = createAssistantMessageEventStream();
        const stopReason = content[0]?.type === "toolCall" ? "toolUse" : "stop";
        const message = { role: "assistant", content, api: "openai-completions", provider: "pitako-telemetry", model: model.id, stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(() => { stream.push({ type: "done", reason: stopReason, message }); stream.end(message); });
        return stream;
      },
    };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const cancelledController = new AbortController();
    const executor = createPiExecutor();
    const [failed, cancelled] = await Promise.all([
      fixture.acquire(executor.start({ instanceId: "developer-query-failed", role: lateRole, task: "failed query", target: { model: "pitako-telemetry/late", reasoning: "off" }, cwd: dirs[0]!, signal: new AbortController().signal })),
      fixture.acquire(executor.start({ instanceId: "developer-query-cancelled", role: lateRole, task: "cancel query", target: { model: "pitako-telemetry/late", reasoning: "off" }, cwd: dirs[1]!, signal: cancelledController.signal, onActivity(event) { if (event.type === "tool_execution_start" && event.toolName === "read_enclosing") cancelledController.abort(); } })),
    ]);
    expect(failed.status).toBe("completed");
    expect(failed.usage?.codeIntelligence?.dense.read_enclosing).toMatchObject({ calls: 1, outcomes: { unavailable: 1 } });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.usage?.codeIntelligence?.dense.read_enclosing).toMatchObject({ calls: 1, outcomes: { cancelled: 1 } });
    expect(failed.usage?.codeIntelligence?.dense.read_enclosing?.calls).toBe(1);
    expect(cancelled.usage?.codeIntelligence?.dense.read_enclosing?.calls).toBe(1);
  }), 60_000);

  test.serial("a model still missing after bind is unavailable and is not prompted", fixture.ownedCase("a model still missing after bind is unavailable and is not prompted", async () => {
    const { calls, cwd } = await installLateProvider();
    const attempt = await fixture.acquire(createPiExecutor().start({
      instanceId: "developer-missing",
      role: lateRole,
      task: "say-pong-marker",
      target: { model: "pitako-late/missing", reasoning: "off" },
      cwd,
      signal: new AbortController().signal,
    }));
    expect(attempt.status).toBe("failed");
    expect(attempt.error).toBe("model unavailable: pitako-late/missing");
    expect(attempt.sideEffects).toBe(false);
    expect(calls).toEqual([]);
  }), 60_000);

  test.serial("fast request to an unsupported late model fails as configuration before prompt", fixture.ownedCase("fast request to an unsupported late model fails as configuration before prompt", async () => {
    const { calls, cwd } = await installLateProvider();
    const attempt = await fixture.acquire(createPiExecutor().start({
      instanceId: "developer-fast-unsupported",
      role: lateRole,
      task: "do not prompt",
      target: { model: "pitako-late/late", fast: true },
      cwd,
      signal: new AbortController().signal,
    }));
    expect(attempt.status).toBe("failed");
    expect(attempt.failureKind).toBe("configuration");
    expect(attempt.error).toMatch(/fast.*unsupported|unsupported.*fast/i);
    expect(calls).toEqual([]);
  }), 60_000);

  test.serial("records only the first model output per request", fixture.ownedCase("records only the first model output per request", async () => {
    let clock = 100;
    const { calls, cwd, provider } = await installLateProvider();
    const specifier = "@earendil-works/pi-ai/utils/event-stream.js";
    const payloads: Array<Record<string, unknown>> = [];
    Object.assign(provider, { streamSimple: async (model: { id: string }, _context: unknown, options?: { onPayload?: (body: unknown, model: unknown) => unknown }) => {
      calls.push(`${model.id}:observed`);
      const body = { model: model.id };
      const transformed = await options?.onPayload?.(body, model);
      payloads.push((transformed ?? body) as Record<string, unknown>);
      clock = 150;
      const { createAssistantMessageEventStream } = await import(specifier);
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
        api: "openai-completions",
        provider: "pitako-late",
        model: model.id,
        stopReason: "stop",
        timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => {
        const partial = { ...message, content: [{ type: "text", text: "" }] };
        stream.push({ type: "start", partial } as never);
        partial.content[0]!.text = "po";
        stream.push({ type: "text_delta", contentIndex: 0, delta: "po", partial } as never);
        partial.content[0]!.text = "pong";
        stream.push({ type: "text_delta", contentIndex: 0, delta: "ng", partial } as never);
        stream.push({ type: "done", reason: "stop", message } as never);
        stream.end(message as never);
      });
      return stream;
    } });
    const attempt = await fixture.acquire(createPiExecutor({ now: () => clock }).start({
      instanceId: "developer-observe-request",
      role: lateRole,
      task: "say-pong-marker",
      target: { model: "pitako-late/late", reasoning: "high", fast: false },
      cwd,
      signal: new AbortController().signal,
      onActivity: (event) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") clock = 400;
      },
    }));
    expect(attempt.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(payloads).toEqual([{ model: "late" }]);
    expect(attempt.requests).toEqual([
      {
        model: "pitako-late/late",
        reasoning: "off",
        fast_requested: false,
        returned_service_tier: "unavailable",
        time_to_first_model_output_ms: 50,
      },
    ]);
  }), 60_000);

  test.serial("marks request without output unavailable on cancellation", fixture.ownedCase("marks request without output unavailable on cancellation", async () => {
    let clock = 10;
    const { cwd, provider } = await installLateProvider();
    const specifier = "@earendil-works/pi-ai/utils/event-stream.js";
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    Object.assign(provider, { streamSimple: async (model: { id: string }, _context: unknown, options?: { signal?: AbortSignal }) => {
      const { createAssistantMessageEventStream } = await import(specifier);
      const stream = createAssistantMessageEventStream();
      started();
      options?.signal?.addEventListener("abort", () => {
        const message = {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: "pitako-late",
          model: model.id,
          stopReason: "aborted",
          errorMessage: "Request was aborted",
          timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "error", reason: "aborted", error: message } as never);
        stream.end(message as never);
      }, { once: true });
      return stream;
    } });
    const controller = new AbortController();
    const pending = fixture.acquire(createPiExecutor({ now: () => clock }).start({
      instanceId: "developer-cancel-request",
      role: lateRole,
      task: "wait for cancellation",
      target: { model: "pitako-late/late" },
      cwd,
      signal: controller.signal,
    }));
    await requestStarted;
    clock = 40;
    controller.abort();
    const attempt = await pending;
    expect(attempt.status).toBe("cancelled");
    expect(attempt.requests?.[0]).toMatchObject({
      fast_requested: false,
      returned_service_tier: "unavailable",
      time_to_first_model_output_ms: "unavailable",
      time_to_first_model_output_unavailable_reason: "cancelled",
    });
  }), 60_000);

  function installTierFixture(fetchMode: "reject_tier" | "rate_limit" = "reject_tier") {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-tier-agent-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-tier-cwd-"));
    tempDirs.push(agentDir, cwd);
    mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      path.join(agentDir, "extensions", "payload.js"),
      "export default function (pi) { pi.on('before_provider_request', event => { (globalThis.__pitakoPayloadInputs ||= []).push(event.payload); return { ...event.payload, pitako_payload_hook: 'retained' }; }); }\n",
    );
    const payloadInputs = (globalThis as { __pitakoPayloadInputs?: unknown[] }).__pitakoPayloadInputs = [];
    const account = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })).toString("base64url");
    const codexToken = `header.${account}.signature`;
    writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "openai-codex": {
          api: "openai-codex-responses",
          apiKey: codexToken,
          baseUrl: "https://chatgpt.com/backend-api",
          models: [{ id: "gpt-6-luna", name: "Luna", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 64 }],
        },
        xai: {
          api: "openai-responses",
          apiKey: "test-xai",
          baseUrl: "https://api.x.ai/v1",
          models: [{ id: "grok-4.7", name: "Grok", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 64 }],
        },
      },
    }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const websocketBodies: Array<Record<string, unknown>> = [];
    const httpBodies: Array<Record<string, unknown>> = [];
    const globalSocket = globalThis as unknown as { WebSocket?: unknown };
    class OfflineWebSocket extends EventTarget {
      readyState = 0;
      binaryType = "arraybuffer";
      constructor() {
        super();
        queueMicrotask(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
        });
      }
      send(data: string) {
        websocketBodies.push(JSON.parse(data) as Record<string, unknown>);
        setTimeout(() => this.dispatchEvent(new Event("error")), 0);
      }
      close() {
        this.readyState = 3;
      }
    }
    globalSocket.WebSocket = OfflineWebSocket;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body as Uint8Array);
      const encoded = new Headers(init?.headers).get("content-encoding") === "zstd";
      const text = encoded ? Bun.zstdDecompressSync(bytes).toString() : bytes.toString();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      httpBodies.push(parsed);
      const tierRejected = Object.hasOwn(parsed, "service_tier");
      const status = fetchMode === "rate_limit" && tierRejected ? 429 : 400;
      const message = fetchMode === "rate_limit" && tierRejected
        ? "429 rate limit"
        : tierRejected
          ? "Unsupported service_tier: priority"
          : "Offline request intercepted";
      return new Response(JSON.stringify({ error: { message } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    } });
    return { agentDir, cwd, websocketBodies, httpBodies, payloadInputs };
  }

  test.serial("sends exact Codex tiers through WebSocket/SSE", fixture.ownedCase("sends exact Codex tiers through WebSocket/SSE", async () => {
    const { cwd, websocketBodies, httpBodies, payloadInputs } = installTierFixture();
    const codex = await fixture.acquire(createPiExecutor().start({
      instanceId: "developer-codex-fast",
      role: lateRole,
      task: "send codex request",
      target: { model: "openai-codex/gpt-6-luna", reasoning: "max", fast: true },
      cwd,
      signal: new AbortController().signal,
    }));
    expect(codex.status).toBe("failed");
    expect(codex.requests?.[0]).toMatchObject({
      model: "openai-codex/gpt-6-luna",
      fast_requested: true,
      requested_service_tier: "priority",
      returned_service_tier: "unavailable",
      time_to_first_model_output_ms: "unavailable",
      time_to_first_model_output_unavailable_reason: "failed",
    });
    expect(websocketBodies[0]).toMatchObject({ type: "response.create", service_tier: "priority", pitako_payload_hook: "retained" });
    expect(httpBodies[0]).toMatchObject({ service_tier: "priority", pitako_payload_hook: "retained" });
    expect(payloadInputs.every((payload) => !Object.hasOwn(payload as object, "service_tier"))).toBe(true);
  }), 60_000);

  test.serial("sends exact xAI priority through Responses", fixture.ownedCase("sends exact xAI priority through Responses", async () => {
    const { cwd, httpBodies, payloadInputs } = installTierFixture();
    const xai = await fixture.acquire(createPiExecutor().start({
      instanceId: "reviewer-xai-priority",
      role: { ...lateRole, id: "reviewer" },
      task: "send xai request",
      target: { model: "xai/grok-4.7", reasoning: "xhigh", fast: true },
      cwd,
      signal: new AbortController().signal,
    }));
    expect(xai.failureKind).toBe("configuration");
    expect(xai.requests?.[0]).toMatchObject({
      model: "xai/grok-4.7",
      fast_requested: true,
      requested_service_tier: "priority",
      returned_service_tier: "unavailable",
      time_to_first_model_output_ms: "unavailable",
      time_to_first_model_output_unavailable_reason: "failed",
    });
    expect(httpBodies[0]).toMatchObject({ service_tier: "priority", pitako_payload_hook: "retained" });
    expect(payloadInputs.every((payload) => !Object.hasOwn(payload as object, "service_tier"))).toBe(true);
  }), 60_000);

  test.serial("keeps concurrent fast and normal provider tiers independent", fixture.ownedCase("keeps concurrent fast and normal provider tiers independent", async () => {
    const { cwd, httpBodies, payloadInputs } = installTierFixture();
    const concurrentExecutor = createPiExecutor();
    const [concurrentFast, concurrentNormal] = await Promise.all([
      fixture.acquire(concurrentExecutor.start({
        instanceId: "reviewer-concurrent-fast",
        role: { ...lateRole, id: "reviewer" },
        task: "fast request",
        target: { model: "xai/grok-4.7", reasoning: "xhigh", fast: true },
        cwd,
        signal: new AbortController().signal,
      })),
      fixture.acquire(concurrentExecutor.start({
        instanceId: "reviewer-concurrent-normal",
        role: { ...lateRole, id: "reviewer" },
        task: "normal request",
        target: { model: "xai/grok-4.7", reasoning: "xhigh", fast: false },
        cwd,
        signal: new AbortController().signal,
      })),
    ]);
    const concurrentBodies = httpBodies.slice(0);
    expect(concurrentBodies).toHaveLength(2);
    expect(concurrentBodies.filter((body) => body.service_tier === "priority")).toHaveLength(1);
    expect(concurrentBodies.filter((body) => !Object.hasOwn(body, "service_tier"))).toHaveLength(1);
    expect(concurrentFast.requests?.[0]?.requested_service_tier).toBe("priority");
    expect(concurrentNormal.requests?.[0]?.requested_service_tier).toBeUndefined();
    expect(payloadInputs.every((payload) => !Object.hasOwn(payload as object, "service_tier"))).toBe(true);
  }), 60_000);

  function tierPolicy(agentDir: string) {
    const configPath = path.join(agentDir, "pitako", "config.toml");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, `[model_policies.developer.primary]\nmodel = "xai/grok-4.7"\nfast = true\n[[model_policies.developer.fallbacks]]\nmodel = "xai/grok-4.7"\nfast = false\n`);
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    return { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: configPath };
  }

  test.serial("rejects provider tier configuration without fallback", fixture.ownedCase("rejects provider tier configuration without fallback", async () => {
    const { agentDir, cwd, httpBodies, payloadInputs } = installTierFixture();
    const load = tierPolicy(agentDir);
    const rejectionBody = httpBodies.length;
    const rejectedTier = await fixture.run(runAgentInstance({
      roleId: "developer",
      task: "tier rejection",
      cwd,
      executor: createPiExecutor(),
      load,
    }));
    expect(rejectedTier.status).toBe("failed");
    expect(rejectedTier.model.fallbackOccurred).toBeFalsy();
    expect(httpBodies.slice(rejectionBody)).toHaveLength(1);
    expect(rejectedTier.requests?.[0]?.requested_service_tier).toBe("priority");
    expect(payloadInputs.every((payload) => !Object.hasOwn(payload as object, "service_tier"))).toBe(true);
  }), 60_000);

  test.serial("keeps returned tier unavailable when xAI response reports default", fixture.ownedCase("keeps returned tier unavailable when xAI response reports default", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-default-tier-agent-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-default-tier-cwd-"));
    tempDirs.push(agentDir, cwd);
    writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
      providers: {
        xai: {
          api: "openai-responses",
          apiKey: "fake-xai-key",
          baseUrl: "https://api.x.ai/v1",
          models: [{ id: "grok-4.7", name: "Grok", reasoning: true, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 64 }],
        },
      },
    }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const outputMessage = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    };
    const response = {
      id: "resp_test",
      status: "completed",
      output: [outputMessage],
      service_tier: "default",
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      },
    };
    const events = [
      { type: "response.created", response: { id: response.id } },
      { type: "response.output_item.added", output_index: 0, item: { ...outputMessage, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
      { type: "response.output_item.done", output_index: 0, item: outputMessage },
      { type: "response.completed", response },
    ];
    const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    });
    const attempt = await fixture.acquire(createPiExecutor().start({
      instanceId: "developer-default-tier",
      role: lateRole,
      task: "return ok",
      target: { model: "xai/grok-4.7", reasoning: "xhigh", fast: true },
      cwd,
      signal: new AbortController().signal,
    }));
    expect(attempt.status).toBe("completed");
    expect(attempt.result).toBe("ok");
    expect(attempt.requests).toMatchObject([{
      fast_requested: true,
      requested_service_tier: "priority",
      returned_service_tier: "unavailable",
    }]);
  }), 60_000);

  test.serial("cache warmer reuses its immutable active-target tier", fixture.ownedCase("cache warmer reuses its immutable active-target tier", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-warm-agent-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-warm-cwd-"));
    tempDirs.push(agentDir, cwd);
    mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      path.join(agentDir, "extensions", "warm.js"),
      "export default function (pi) { pi.on('cache_warming_decision', () => ({ action: 'warm' })); }\n",
    );
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "idle", retry: { enabled: false } }));
    writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
      providers: {
        xai: {
          api: "openai-responses",
          apiKey: "test-xai",
          baseUrl: "https://api.x.ai/v1",
          models: [{
            id: "grok-4.7",
            name: "Grok",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            promptCache: { short: 60 },
            contextWindow: 1000,
            maxTokens: 64,
          }],
        },
      },
    }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const bodies: Array<Record<string, unknown>> = [];
    const previousSetTimeout = globalThis.setTimeout;
    const warmTimers: Array<() => void> = [];
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
        if (delay === 50_000) {
          warmTimers.push(() => callback(...args));
          return { unref() {} };
        }
        return previousSetTimeout(callback, delay, ...args);
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        const message = Object.hasOwn(body, "service_tier")
          ? "Unsupported value for service_tier"
          : "Offline request intercepted";
        return new Response(JSON.stringify({ error: { message } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const attempt = await fixture.acquire(createPiExecutor().start({
      instanceId: "reviewer-cache-warm",
      role: { ...lateRole, id: "reviewer" },
      task: "start warmable request",
      target: { model: "xai/grok-4.7", reasoning: "xhigh", fast: true },
      cwd,
      signal: new AbortController().signal,
    }));
    expect(attempt.status).toBe("failed");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ service_tier: "priority" });
    expect(warmTimers).toHaveLength(1);
    const continued = await attempt.session!.continueWith(
      { model: "xai/grok-4.7", reasoning: "xhigh", fast: false },
      "continue at normal priority",
      new AbortController().signal,
    );
    expect(continued.status).toBe("failed");
    expect(bodies).toHaveLength(2);
    expect(Object.hasOwn(bodies[1]!, "service_tier")).toBe(false);
    expect(warmTimers).toHaveLength(2);
    warmTimers[0]!();
    await new Promise((resolve) => previousSetTimeout(resolve, 5));
    expect(bodies).toHaveLength(2);
    warmTimers[1]!();
    for (let i = 0; i < 50 && bodies.length < 3; i += 1) {
      await new Promise((resolve) => previousSetTimeout(resolve, 5));
    }
    expect(bodies).toHaveLength(3);
    expect(Object.hasOwn(bodies[2]!, "service_tier")).toBe(false);
  }), 60_000);

  test.serial("same-session continue does not prompt a missing model", fixture.ownedCase("same-session continue does not prompt a missing model", async () => {
    const { calls, cwd } = await installLateProvider();
    const attempt = await fixture.acquire(createPiExecutor().start({
      instanceId: "developer-continue",
      role: lateRole,
      task: "say-pong-marker",
      target: { model: "pitako-late/late", reasoning: "off" },
      cwd,
      signal: new AbortController().signal,
    }));
    expect(attempt.status).toBe("completed");
    const next = await attempt.session!.continueWith(
      { model: "pitako-late/missing" },
      "continue",
      new AbortController().signal,
    );
    expect(next.status).toBe("failed");
    expect(next.error).toBe("model unavailable: pitako-late/missing");
    const unsupported = await attempt.session!.continueWith(
      { model: "pitako-late/late", fast: true },
      "must not prompt",
      new AbortController().signal,
    );
    expect(unsupported.failureKind).toBe("configuration");
    expect(calls).toHaveLength(1);
  }), 60_000);
});
