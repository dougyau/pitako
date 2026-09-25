import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { classifyProviderFailure } from "../extensions/agent/fallback.ts";
import { activateTarget, CHILD_CODE_TOOLS, createPiExecutor, cursorProviderContext, DEFAULT_THINKING_LEVEL } from "../extensions/agent/pi.ts";
import { runAgentInstance, teamExecutionSummary } from "../extensions/agent/run.ts";
import { childActiveTools, ORCHESTRATION_TOOLS } from "../extensions/profile.ts";
import { t6ReplaySpec } from "../extensions/agent/replay.ts";
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

  async function installLateProvider(): Promise<{ calls: string[]; cwd: string }> {
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
    (globalThis as { __pitakoLateProvider?: unknown }).__pitakoLateProvider = {
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
      streamSimple(model: { id: string }, context: { messages?: unknown[] }) {
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
    process.env.PI_CODING_AGENT_DIR = agentDir;
    return { calls, cwd };
  }

  async function installReplayTool(failOnce = false) {
    const { calls, cwd } = await installLateProvider();
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    writeFileSync(path.join(agentDir, "extensions", "replay.js"), `
      import { Type } from "typebox";
      export default function (pi) {
        pi.on("before_agent_start", () => ({ systemPrompt: "forced-safe π\\r\\nexact" }));
        pi.registerTool({
          name: "replay_probe", label: "Replay probe", description: "Returns a fixed test result",
          parameters: Type.Object({ query: Type.String() }),
          async execute(_id, params) { return { content: [{ type: "text", text: \`result=\${params.query}\\r\\nline=π\` }], details: { hidden: "PITAKO-REPLAY-CANARY-details" } }; },
        });
      }
    `);
    const provider = (globalThis as { __pitakoLateProvider?: any }).__pitakoLateProvider!;
    if (failOnce) provider.models.push({ ...provider.models[0], id: "fallback", name: "Fallback" });
    const streamModule: string = "@earendil-works/pi-ai/utils/event-stream.js";
    const { createAssistantMessageEventStream } = await import(streamModule);

    provider.streamSimple = (model: { id: string }, context: { messages?: any[] }) => {
      const messages = context.messages ?? [];
      const hasResult = messages.some((message) => message.role === "toolResult" && message.toolName === "replay_probe");
      let content: any[];
      let stopReason: string;
      let errorMessage: string | undefined;
      if (!hasResult) {
        content = [{ type: "toolCall", id: "replay-call-1", name: "replay_probe", arguments: { query: "café\r\nquery" } }];
        stopReason = "toolUse";
      } else if (failOnce && model.id === "late") {
        content = [];
        stopReason = "error";
        errorMessage = "socket hang up";
      } else {
        content = [{ type: "text", text: "Replay captured." }];
        stopReason = "stop";
      }
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant", content, api: "openai-completions", provider: "pitako-late", model: model.id,
        stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
        usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => { stream.push({ type: "done", reason: stopReason, message }); stream.end(message); });
      calls.push(`${model.id}:${stopReason}`);
      return stream;
    };
    return { calls, cwd, agentDir };
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

  test("reserved Reviewer capture preserves the forced prompt and exact finalized tool result", async () => {
    const { calls, cwd } = await installReplayTool();
    const replay = {
      ...t6ReplaySpec("reviewer", "code-intelligence", "T6-replay-baseline", "33333333-3333-4333-8333-333333333333")!,
      approvedStrings: new Set(["forced-safe π\r\nexact", JSON.stringify({ query: "café\r\nquery" }), "result=café\r\nquery\r\nline=π"]),
    };
    const role = { ...lateRole, id: "reviewer", modelPolicyId: "reviewer" };
    const attempt = await createPiExecutor({ replay }).start({
      instanceId: "reviewer-replay-fixture", role, task: "capture a synthetic tool result",
      target: { model: "pitako-late/late", reasoning: "off" }, cwd, signal: new AbortController().signal,
    });
    expect(attempt.status).toBe("completed");
    expect(attempt.result).toBe("Replay captured.");
    expect(calls).toHaveLength(2);
    await attempt.session?.dispose();

    const replayDir = path.join(cwd, ".pitako", "runs", "code-intelligence", "evidence", "T6", "session-replay", replay.assignmentId);
    const files = readdirSync(replayDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^session-[0-9a-f-]+\.json$/);
    const serialized = readFileSync(path.join(replayDir, files[0]!), "utf8");
    const artifact = JSON.parse(serialized);
    expect(artifact.checkpoints[0].systemPrompt).toBe(`forced-safe π\r\nexact`);
    const messages = artifact.entries.filter((entry: any) => entry.type === "message").map((entry: any) => entry.message);
    const toolCall = messages.flatMap((message: any) => message.role === "assistant" ? message.content : []).find((part: any) => part.type === "toolCall");
    expect(toolCall.arguments.query).toBe(`café\r\nquery`);
    const result = messages.find((message: any) => message.role === "toolResult" && message.toolName === "replay_probe");
    expect(result.content[0].text).toBe(`result=café\r\nquery\r\nline=π`);
    expect(serialized).not.toContain("PITAKO-REPLAY-CANARY-details");
  }, 60_000);

  test("continuation exports one history; denied export does not change the child result", async () => {
    const { calls, cwd, agentDir } = await installReplayTool(true);
    const replay = t6ReplaySpec("reviewer", "code-intelligence", "T6-replay-dense", "44444444-4444-4444-8444-444444444444")!;
    const userConfigPath = path.join(agentDir, "pitako", "config.toml");
    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    writeFileSync(userConfigPath, [
      "[model_policies.reviewer.primary]", 'model = "pitako-late/late"', 'reasoning = "off"',
      "[[model_policies.reviewer.fallbacks]]", 'model = "pitako-late/fallback"', 'reasoning = "high"', "",
    ].join("\n"));
    const result = await runAgentInstance({
      roleId: "reviewer", task: "continue from one synthetic tool result", cwd,
      executor: createPiExecutor({ replay }), load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath },
    });
    expect(result.status).toBe("completed");
    expect(result.model.fallbackOccurred).toBe(true);
    expect(calls[0]).toBe("late:toolUse");
    expect(calls.some((call) => call === "late:error")).toBe(true);
    expect(calls.at(-1)).toBe("fallback:stop");
    const replayDir = path.join(cwd, ".pitako", "runs", "code-intelligence", "evidence", "T6", "session-replay", replay.assignmentId);
    const files = readdirSync(replayDir);
    expect(files).toHaveLength(1);
    const artifact = JSON.parse(readFileSync(path.join(replayDir, files[0]!), "utf8"));
    expect(artifact.status).toBe("redacted");
    expect(artifact.checkpoints[0]?.systemPrompt?.type === "redacted" && artifact.checkpoints[0]?.systemPrompt?.reason === "privacy").toBe(true);
    const messages = artifact.entries.filter((entry: any) => entry.type === "message").map((entry: any) => entry.message);
    expect(messages.filter((message: any) => message.role === "toolResult" && message.toolName === "replay_probe")).toHaveLength(1);
    expect(messages.flatMap((message: any) => message.role === "assistant" ? message.content : []).filter((part: any) => part.type === "toolCall" && part.name === "replay_probe")).toHaveLength(1);
    expect(artifact.events.filter((event: any) => event.type === "prompt_start").map((event: any) => event.continuation)).toEqual([false, true]);

    const denied = await installReplayTool();
    const deniedSpec = t6ReplaySpec("reviewer", "code-intelligence", "T6-replay-baseline", "55555555-5555-4555-8555-555555555555")!;
    const outside = path.join(denied.cwd, "outside");
    mkdirSync(outside);
    const parent = path.join(denied.cwd, ".pitako", "runs", "code-intelligence", "evidence", "T6", "session-replay");
    mkdirSync(parent, { recursive: true });
    symlinkSync(outside, path.join(parent, deniedSpec.assignmentId), "dir");
    const deniedResult = await createPiExecutor({ replay: deniedSpec }).start({
      instanceId: "reviewer-denied-fixture", role: { ...lateRole, id: "reviewer", modelPolicyId: "reviewer" },
      task: "finish without a diagnostic export", target: { model: "pitako-late/late", reasoning: "off" },
      cwd: denied.cwd, signal: new AbortController().signal,
    });
    expect(deniedResult.status).toBe("completed");
    expect(deniedResult.result).toBe("Replay captured.");
    await deniedResult.session?.dispose();
    expect(readdirSync(outside)).toEqual([]);
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
      expect(calls).toHaveLength(1);
    } finally {
      await attempt.session?.dispose();
    }
  }, 60_000);
});
