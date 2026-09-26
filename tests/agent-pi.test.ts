import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { classifyProviderFailure } from "../extensions/agent/fallback.ts";
import { activateTarget, CHILD_CODE_TOOLS, createPiExecutor, cursorProviderContext, DEFAULT_THINKING_LEVEL } from "../extensions/agent/pi.ts";
import { runAgentInstance, teamExecutionSummary, type Attempt } from "../extensions/agent/run.ts";
import { childActiveTools, ORCHESTRATION_TOOLS } from "../extensions/profile.ts";
import type { ResolvedRole } from "../extensions/roles/types.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cursor request", () => {
  test("keeps session tools on the provider context", () => {
    const tools = [{ name: "bash", description: "run", parameters: { type: "object" } }];
    const context = cursorProviderContext(
      { provider: "cursor", api: "cursor-native" },
      { systemPrompt: "Pitako", messages: [], tools: tools as never },
    );
    expect(context.tools).toEqual(tools);
    expect(cursorProviderContext({ provider: "xai" }, { messages: [], tools: tools as never }).tools).toEqual(tools);
  });
});

describe("pi adapter boundary", () => {
  test("construction enables grep, find, and ls without session_start", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-agent-tools-"));
    tempDirs.push(agentDir);
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-agent-tools-cwd-"));
    tempDirs.push(cwd);
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    const model = runtime.getModels()[0];
    if (!model) throw new Error("Pi static catalog has no model");
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      modelRuntime: runtime,
      customTools: [...CHILD_CODE_TOOLS],
      excludeTools: [...ORCHESTRATION_TOOLS],
    });
    try {
      const available = session.getAllTools().map((tool) => tool.name);
      session.setActiveToolsByName(childActiveTools(available));
      const active = session.getActiveToolNames();
      expect(available).toEqual(expect.arrayContaining(["grep", "find", "ls", "read", "project_report", "read_symbol", "read_enclosing", "module_report", "inspect_symbol", "review_surface", "codegraph_search", "lsp_diagnostics"]));
      expect(active).toEqual(expect.arrayContaining(["read", "grep", "bash", "edit", "find", "ls", "project_report", "read_symbol", "read_enclosing", "module_report", "inspect_symbol", "review_surface", "codegraph_search", "lsp_diagnostics"]));
      for (const tool of ORCHESTRATION_TOOLS) expect(active).not.toContain(tool);

      session.setActiveToolsByName(childActiveTools(available, process.platform, "scout"));
      const scout = session.getActiveToolNames();
      expect(scout).toEqual(expect.arrayContaining(["read", "bash", "grep", "find", "ls"]));
      for (const name of ["edit", "write", "apply_patch", "lsp_rename"]) expect(scout).not.toContain(name);
      for (const tool of ORCHESTRATION_TOOLS) expect(scout).not.toContain(tool);
    } finally {
      session.dispose();
    }
  }, 60_000);
  test("in-memory session starts empty, setModel auth failure is fallback-worthy, and reasoning is not forced", async () => {
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
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      sessionManager: child,
      modelRuntime: runtime,
      excludeTools: [...ORCHESTRATION_TOOLS],
      noTools: "builtin",
    });
    try {
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
    } finally {
      session.dispose();
    }
  }, 60_000);

  test("continue without reasoning does not inherit xhigh", async () => {
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
  });
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
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    delete (globalThis as { __pitakoLateProvider?: unknown }).__pitakoLateProvider;
    delete (globalThis as { __pitakoTelemetryProvider?: unknown }).__pitakoTelemetryProvider;
  });

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

  test("selects a model that appears only after session bind", async () => {
    const { calls, cwd } = await installLateProvider();
    const attempt = await createPiExecutor().start({
      instanceId: "developer-late",
      role: lateRole,
      task: "say-pong-marker",
      target: { model: "pitako-late/late", reasoning: "off" },
      cwd,
      signal: new AbortController().signal,
    });
    try {
      expect(attempt.status).toBe("completed");
      expect(attempt.result).toContain("pong");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("late:");
      expect(calls[0]).toContain("say-pong-marker");
      expect(existsSync(path.join(cwd, ".pitako"))).toBe(false);
    } finally {
      await attempt.session?.dispose();
    }
  }, 60_000);

  test("a real Pi fallback continues on the same session", async () => {
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
    const result = await runAgentInstance({
      roleId: "developer", task: "say-pong-marker", cwd,
      executor: createPiExecutor(), load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath },
    });
    expect(result.status).toBe("completed");
    expect(result.result).toBe("pong");
    expect(result.model.fallbackOccurred).toBe(true);
    expect(calls.map((call) => call.split(":")[0])).toEqual(["late", "fallback"]);
    expect(calls[1]).toContain("say-pong-marker");
  }, 60_000);

  test("a real AgentInstance through Pi preserves observed model and usage", async () => {
    const { cwd } = await installLateProvider();
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const userConfigPath = path.join(agentDir, "pitako", "config.toml");
    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    writeFileSync(userConfigPath, `[model_policies.developer.primary]\nmodel = "pitako-late/late"\nreasoning = "off"\n`);

    const result = await runAgentInstance({
      roleId: "developer", task: "say-pong-marker", cwd,
      executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath },
    });
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
  }, 60_000);

  test("concurrent child sessions account dense and raw tool events independently", async () => {
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
            ? [{ type: "toolCall", id: `telemetry-${sequence++}`, name: "read", arguments: { path: "src/sample.ts" } }]
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
      writeFileSync(path.join(dir, "src", "sample.ts"), "export const value = 1;\n");
    }
    const executor = createPiExecutor();
    const attempts = await Promise.all(dirs.map((cwd, index) => executor.start({
      instanceId: `developer-telemetry-${index}`,
      role: lateRole,
      task: `inspect-child-${index}`,
      target: { model: "pitako-telemetry/late", reasoning: "off" },
      cwd,
      signal: new AbortController().signal,
    })));
    try {
      for (const attempt of attempts) {
        expect(attempt.status).toBe("completed");
        expect(attempt.usage?.codeIntelligence?.dense.project_report?.calls).toBe(1);
        expect(attempt.usage?.codeIntelligence?.raw.read).toBe(5);
        expect(attempt.usage?.codeIntelligence?.navigation).toMatchObject({ completedCalls: 5, read: 5, grep: 0, remaining: 0 });
        expect(attempt.usage?.codeIntelligence?.sources.git?.calls).toBeGreaterThan(0);
        expect(attempt.usage?.tools?.project_report).toBe(1);
      }
      expect(sequence).toBe(12);
    } finally {
      await Promise.all(attempts.map((attempt) => attempt.session?.dispose()));
    }
  }, 60_000);

  test("failed and cancelled dense child calls retain one attributed outcome", async () => {
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
      executor.start({ instanceId: "developer-query-failed", role: lateRole, task: "failed query", target: { model: "pitako-telemetry/late", reasoning: "off" }, cwd: dirs[0]!, signal: new AbortController().signal }),
      executor.start({ instanceId: "developer-query-cancelled", role: lateRole, task: "cancel query", target: { model: "pitako-telemetry/late", reasoning: "off" }, cwd: dirs[1]!, signal: cancelledController.signal, onActivity(event) { if (event.type === "tool_execution_start" && event.toolName === "read_enclosing") cancelledController.abort(); } }),
    ]);
    try {
      expect(failed.status).toBe("completed");
      expect(failed.usage?.codeIntelligence?.dense.read_enclosing).toMatchObject({ calls: 1, outcomes: { unavailable: 1 } });
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.usage?.codeIntelligence?.dense.read_enclosing).toMatchObject({ calls: 1, outcomes: { cancelled: 1 } });
      expect(failed.usage?.codeIntelligence?.dense.read_enclosing?.calls).toBe(1);
      expect(cancelled.usage?.codeIntelligence?.dense.read_enclosing?.calls).toBe(1);
    } finally {
      await Promise.all([failed.session?.dispose(), cancelled.session?.dispose()]);
    }
  }, 60_000);

  test("a model still missing after bind is unavailable and is not prompted", async () => {
    const { calls, cwd } = await installLateProvider();
    const attempt = await createPiExecutor().start({
      instanceId: "developer-missing",
      role: lateRole,
      task: "say-pong-marker",
      target: { model: "pitako-late/missing", reasoning: "off" },
      cwd,
      signal: new AbortController().signal,
    });
    expect(attempt.status).toBe("failed");
    expect(attempt.error).toBe("model unavailable: pitako-late/missing");
    expect(attempt.sideEffects).toBe(false);
    expect(calls).toEqual([]);
  }, 60_000);

  test("fast request to an unsupported late model fails as configuration before prompt", async () => {
    const { calls, cwd } = await installLateProvider();
    const attempt = await createPiExecutor().start({
      instanceId: "developer-fast-unsupported",
      role: lateRole,
      task: "do not prompt",
      target: { model: "pitako-late/late", fast: true },
      cwd,
      signal: new AbortController().signal,
    });
    expect(attempt.status).toBe("failed");
    expect(attempt.failureKind).toBe("configuration");
    expect(attempt.error).toMatch(/fast.*unsupported|unsupported.*fast/i);
    expect(calls).toEqual([]);
  }, 60_000);

  test("records only the first model output per request", async () => {
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
    const attempt = await createPiExecutor({ now: () => clock }).start({
      instanceId: "developer-observe-request",
      role: lateRole,
      task: "say-pong-marker",
      target: { model: "pitako-late/late", reasoning: "high", fast: false },
      cwd,
      signal: new AbortController().signal,
      onActivity: (event) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") clock = 400;
      },
    });
    try {
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
    } finally {
      await attempt.session?.dispose();
    }
  }, 60_000);

  test("marks request without output unavailable on cancellation", async () => {
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
    const pending = createPiExecutor({ now: () => clock }).start({
      instanceId: "developer-cancel-request",
      role: lateRole,
      task: "wait for cancellation",
      target: { model: "pitako-late/late" },
      cwd,
      signal: controller.signal,
    });
    await requestStarted;
    clock = 40;
    controller.abort();
    const attempt = await pending;
    try {
      expect(attempt.status).toBe("cancelled");
      expect(attempt.requests?.[0]).toMatchObject({
        fast_requested: false,
        returned_service_tier: "unavailable",
        time_to_first_model_output_ms: "unavailable",
        time_to_first_model_output_unavailable_reason: "cancelled",
      });
    } finally {
      await attempt.session?.dispose();
    }
  }, 60_000);

  test("sends exact provider tiers through Codex WebSocket/SSE and xAI Responses", async () => {
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
    let fetchMode: "reject_tier" | "rate_limit" = "reject_tier";
    const previousFetch = globalThis.fetch;
    const globalSocket = globalThis as unknown as { WebSocket?: unknown };
    const previousWebSocket = globalSocket.WebSocket;
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
    try {
      const codex = await createPiExecutor().start({
        instanceId: "developer-codex-fast",
        role: lateRole,
        task: "send codex request",
        target: { model: "openai-codex/gpt-6-luna", reasoning: "max", fast: true },
        cwd,
        signal: new AbortController().signal,
      });
      try {
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
      } finally {
        await codex.session?.dispose();
      }

      const xai = await createPiExecutor().start({
        instanceId: "reviewer-xai-priority",
        role: { ...lateRole, id: "reviewer" },
        task: "send xai request",
        target: { model: "xai/grok-4.7", reasoning: "xhigh", fast: true },
        cwd,
        signal: new AbortController().signal,
      });
      try {
        expect(xai.failureKind).toBe("configuration");
        expect(xai.requests?.[0]).toMatchObject({
          model: "xai/grok-4.7",
          fast_requested: true,
          requested_service_tier: "priority",
          returned_service_tier: "unavailable",
          time_to_first_model_output_ms: "unavailable",
          time_to_first_model_output_unavailable_reason: "failed",
        });
        expect(httpBodies[1]).toMatchObject({ service_tier: "priority", pitako_payload_hook: "retained" });
      } finally {
        await xai.session?.dispose();
      }

      const concurrentExecutor = createPiExecutor();
      const [concurrentFast, concurrentNormal] = await Promise.all([
        concurrentExecutor.start({
          instanceId: "reviewer-concurrent-fast",
          role: { ...lateRole, id: "reviewer" },
          task: "fast request",
          target: { model: "xai/grok-4.7", reasoning: "xhigh", fast: true },
          cwd,
          signal: new AbortController().signal,
        }),
        concurrentExecutor.start({
          instanceId: "reviewer-concurrent-normal",
          role: { ...lateRole, id: "reviewer" },
          task: "normal request",
          target: { model: "xai/grok-4.7", reasoning: "xhigh", fast: false },
          cwd,
          signal: new AbortController().signal,
        }),
      ]);
      try {
        const concurrentBodies = httpBodies.slice(2);
        expect(concurrentBodies).toHaveLength(2);
        expect(concurrentBodies.filter((body) => body.service_tier === "priority")).toHaveLength(1);
        expect(concurrentBodies.filter((body) => !Object.hasOwn(body, "service_tier"))).toHaveLength(1);
        expect(concurrentFast.requests?.[0]?.requested_service_tier).toBe("priority");
        expect(concurrentNormal.requests?.[0]?.requested_service_tier).toBeUndefined();
      } finally {
        await concurrentFast.session?.dispose();
        await concurrentNormal.session?.dispose();
      }

      const configPath = path.join(agentDir, "pitako", "config.toml");
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(configPath, `[model_policies.developer.primary]\nmodel = "xai/grok-4.7"\nfast = true\n[[model_policies.developer.fallbacks]]\nmodel = "xai/grok-4.7"\nfast = false\n`);
      writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
      const load = { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: configPath };
      const rejectionBody = httpBodies.length;
      const rejectedTier = await runAgentInstance({
        roleId: "developer",
        task: "tier rejection",
        cwd,
        executor: createPiExecutor(),
        load,
      });
      expect(rejectedTier.status).toBe("failed");
      expect(rejectedTier.model.fallbackOccurred).toBeFalsy();
      expect(httpBodies.slice(rejectionBody)).toHaveLength(1);
      expect(rejectedTier.requests?.[0]?.requested_service_tier).toBe("priority");

      fetchMode = "rate_limit";
      const firstFallbackBody = httpBodies.length;
      const fallback = await runAgentInstance({
        roleId: "developer",
        task: "rate limit fallback",
        cwd,
        executor: createPiExecutor(),
        load,
      });
      expect(fallback.model.fallbackOccurred).toBe(true);
      expect(fallback.model.fallbackReason).toBe("rate_limit");
      expect(httpBodies.slice(firstFallbackBody)).toHaveLength(2);
      expect(httpBodies[firstFallbackBody]?.service_tier).toBe("priority");
      expect(Object.hasOwn(httpBodies[firstFallbackBody + 1]!, "service_tier")).toBe(false);
      expect(fallback.requests?.map((request) => request.requested_service_tier)).toEqual(["priority", undefined]);
      expect(payloadInputs.every((payload) => !Object.hasOwn(payload as object, "service_tier"))).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
      if (previousWebSocket === undefined) delete globalSocket.WebSocket;
      else globalSocket.WebSocket = previousWebSocket;
      delete (globalThis as { __pitakoPayloadInputs?: unknown[] }).__pitakoPayloadInputs;
    }
  }, 60_000);

  test("keeps returned tier unavailable when xAI response reports default", async () => {
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
    const previousFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    });
    let attempt: Attempt | undefined;
    try {
      attempt = await createPiExecutor().start({
        instanceId: "developer-default-tier",
        role: lateRole,
        task: "return ok",
        target: { model: "xai/grok-4.7", reasoning: "xhigh", fast: true },
        cwd,
        signal: new AbortController().signal,
      });
      expect(attempt.status).toBe("completed");
      expect(attempt.result).toBe("ok");
      expect(attempt.requests).toMatchObject([{
        fast_requested: true,
        requested_service_tier: "priority",
        returned_service_tier: "unavailable",
      }]);
    } finally {
      await attempt?.session?.dispose();
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    }
  }, 60_000);

  test("cache warmer reuses its immutable active-target tier", async () => {
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
    const previousFetch = globalThis.fetch;
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
    let attempt: Attempt | undefined;
    try {
      attempt = await createPiExecutor().start({
        instanceId: "reviewer-cache-warm",
        role: { ...lateRole, id: "reviewer" },
        task: "start warmable request",
        target: { model: "xai/grok-4.7", reasoning: "xhigh", fast: true },
        cwd,
        signal: new AbortController().signal,
      });
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
    } finally {
      await attempt?.session?.dispose();
      Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: previousSetTimeout });
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    }
  }, 60_000);

  test("same-session continue does not prompt a missing model", async () => {
    const { calls, cwd } = await installLateProvider();
    const attempt = await createPiExecutor().start({
      instanceId: "developer-continue",
      role: lateRole,
      task: "say-pong-marker",
      target: { model: "pitako-late/late", reasoning: "off" },
      cwd,
      signal: new AbortController().signal,
    });
    try {
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
    } finally {
      await attempt.session?.dispose();
    }
  }, 60_000);
});
