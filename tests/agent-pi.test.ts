import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { classifyProviderFailure } from "../extensions/agent/fallback.ts";
import { activateTarget, createPiExecutor, cursorProviderContext, DEFAULT_THINKING_LEVEL } from "../extensions/agent/pi.ts";
import { childActiveTools } from "../extensions/profile.ts";
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
      excludeTools: ["agent_run"],
    });
    try {
      const available = session.getAllTools().map((tool) => tool.name);
      session.setActiveToolsByName(childActiveTools(available));
      const active = session.getActiveToolNames();
      expect(available).toEqual(expect.arrayContaining(["grep", "find", "ls", "read"]));
      expect(active).toEqual(expect.arrayContaining(["grep", "find", "ls", "read"]));
      expect(active).not.toContain("agent_run");
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
      excludeTools: ["agent_run"],
      noTools: "builtin",
    });
    try {
      expect(session.messages).toEqual([]);
      session.setActiveToolsByName(childActiveTools(session.getAllTools().map((tool) => tool.name)));
      const active = session.getActiveToolNames();
      for (const name of ["grep", "find", "ls", "read"]) {
        if (session.getAllTools().some((tool) => tool.name === name)) expect(active).toContain(name);
      }
      expect(active).not.toContain("agent_run");
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
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
    } finally {
      await attempt.session?.dispose();
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
