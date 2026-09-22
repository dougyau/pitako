import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import agentInstance from "../extensions/agent/index.ts";
import {
  bindBackgroundOwner,
  cancelAllWorkers,
  cancelWorker,
  clearBackgroundOwner,
  completionText,
  deliveryFor,
  setBackgroundExecutor,
  shutdownBackground,
  spawnBackground,
  takeHeldCompletions,
  workerResult,
  workerStatus,
  type BackgroundOwner,
} from "../extensions/agent/background.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import type { Attempt, AttemptExecutor } from "../extensions/agent/run.ts";
import { agentScope } from "../extensions/agent/scope.ts";
import pitako from "../extensions/index.ts";
import { childActiveTools, ORCHESTRATION_TOOLS } from "../extensions/profile.ts";
import { packageRoot } from "../extensions/stack.ts";
import type { LoadOptions } from "../extensions/roles/load.ts";

const tempDirs: string[] = [];
afterEach(() => {
  cancelAllWorkers();
  clearBackgroundOwner();
  setBackgroundExecutor(undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function load(): LoadOptions {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-bg-"));
  tempDirs.push(dir);
  const userConfigPath = path.join(dir, "pitako", "config.toml");
  mkdirSync(path.dirname(userConfigPath), { recursive: true });
  writeFileSync(userConfigPath, `[model_policies.developer.primary]\nmodel = "example/primary"\nreasoning = "off"\n`);
  return { env: { PI_CODING_AGENT_DIR: dir }, userConfigPath };
}

function hang(): { executor: AttemptExecutor; started: Promise<void>; release: (attempt: Attempt) => void; signal: () => AbortSignal | undefined } {
  let markStarted: () => void = () => {};
  let finish: (attempt: Attempt) => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<Attempt>((resolve) => {
    finish = resolve;
  });
  let seen: AbortSignal | undefined;
  return {
    started,
    release: finish,
    signal: () => seen,
    executor: {
      async start(input) {
        seen = input.signal;
        markStarted();
        return await gate;
      },
    },
  };
}

function owner(idle: boolean): BackgroundOwner & { notes: string[]; wakes: string[] } {
  const notes: string[] = [];
  const wakes: string[] = [];
  return {
    token: Symbol("test-owner"),
    isIdle: () => idle,
    hasUI: true,
    notify: (message) => notes.push(message),
    sendMessage: (content) => wakes.push(content),
    notes,
    wakes,
  };
}

describe("pitako agents command", () => {
  test("empty list, running row, id filter, and unknown id", async () => {
    const cmd = pitakoAgentsCommand();
    const empty = await cmd.run("agents");
    expect(empty.threw).toBe(false);
    expect(empty.notes).toEqual(["no workers"]);

    const hanging = hang();
    const handle = await spawnBackground({
      roleId: "developer",
      task: "SECRET-TASK change the widget",
      cwd: packageRoot(),
      executor: hanging.executor,
      load: load(),
      watch: { planId: "background-responsiveness-dogfood", unitId: "T1" },
    });
    await hanging.started;

    const listed = await cmd.run("agents");
    expect(listed.threw).toBe(false);
    expect(listed.notes).toHaveLength(1);
    const text = listed.notes[0] ?? "";
    expect(text).toContain(`instance_id: ${handle.instanceId}`);
    expect(text).toContain("role: developer");
    expect(text).toContain("status: running");
    expect(text).toContain("watch: yes");
    expect(text).toMatch(/elapsed_ms: \d+/);
    expect(text).not.toContain("SECRET-TASK");
    expect(text).not.toContain("change the widget");

    const filtered = await cmd.run(`agents ${handle.instanceId}`);
    expect(filtered.threw).toBe(false);
    expect(filtered.notes).toEqual([text]);

    const unknown = await cmd.run("agents missing-worker");
    expect(unknown.threw).toBe(false);
    expect(unknown.notes).toEqual([]);
    expect(unknown.errors).toEqual(["unknown worker missing-worker"]);

    cancelWorker(handle.instanceId);
    hanging.release({ status: "cancelled", result: "SECRET-RESULT", sideEffects: false });
    await waitFor(handle.instanceId);
  });
});

describe("cancel before settle", () => {
  test("status is cancelled and result stays unavailable until the executor settles", async () => {
    const hanging = hang();
    const handle = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: hanging.executor,
      load: load(),
    });
    await hanging.started;
    const cancelled = cancelWorker(handle.instanceId);
    expect(cancelled.status).toBe("cancelled");
    expect(workerStatus(handle.instanceId)[0]?.status).toBe("cancelled");
    expect(() => workerResult(handle.instanceId)).toThrow("result is not available");
    hanging.release({ status: "cancelled", result: "cancelled", sideEffects: false });
    await waitFor(handle.instanceId);
    expect(workerResult(handle.instanceId).status).toBe("cancelled");
  });
});

describe("background registry", () => {
  test("spawn returns while the executor is pending", async () => {
    const hanging = hang();
    const handle = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: hanging.executor,
      load: load(),
    });
    expect(handle.status).toBe("running");
    expect(handle.instanceId).toMatch(/^developer-/);
    expect(workerStatus(handle.instanceId)[0]?.status).toBe("running");
    await hanging.started;
    expect(() => workerResult(handle.instanceId)).toThrow("worker is still running");
    hanging.release({ status: "completed", result: "SECRET-RESULT", sideEffects: false });
    await waitFor(handle.instanceId);
    const result = workerResult(handle.instanceId);
    expect(result.result).toBe("SECRET-RESULT");
    expect(workerResult(handle.instanceId).result).toBe("SECRET-RESULT");
  });

  test("pre-abort starts nothing", async () => {
    const hanging = hang();
    const foreground = new AbortController();
    foreground.abort();
    await expect(
      spawnBackground({
        roleId: "developer",
        task: "change the widget",
        cwd: packageRoot(),
        foreground: foreground.signal,
        executor: hanging.executor,
        load: load(),
      }),
    ).rejects.toThrow("agent_spawn cancelled");
    expect(workerStatus()).toEqual([]);
  });

  test("foreground abort after accept does not cancel the worker", async () => {
    const hanging = hang();
    const foreground = new AbortController();
    const handle = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      foreground: foreground.signal,
      executor: hanging.executor,
      load: load(),
    });
    await hanging.started;
    foreground.abort();
    expect(hanging.signal()?.aborted).toBe(false);
    expect(workerStatus(handle.instanceId)[0]?.status).toBe("running");
    cancelWorker(handle.instanceId);
    expect(hanging.signal()?.aborted).toBe(true);
  });

  test("two workers stay independent", async () => {
    const a = hang();
    const b = hang();
    const first = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: a.executor,
      load: load(),
    });
    const second = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: b.executor,
      load: load(),
    });
    expect(workerStatus()).toHaveLength(2);
    cancelWorker(first.instanceId);
    expect(a.signal()?.aborted ?? true).toBe(true);
    expect(workerStatus(second.instanceId)[0]?.status).toBe("running");
    b.release({ status: "completed", result: "B", sideEffects: false });
    a.release({ status: "cancelled", result: "cancelled", sideEffects: false });
    await waitFor(second.instanceId);
    expect(workerResult(second.instanceId).result).toBe("B");
    expect(workerResult(second.instanceId).instanceId).toBe(second.instanceId);
  });

  test("completion is one compact signal and shutdown drops a late settle", async () => {
    const bound = owner(true);
    bindBackgroundOwner(bound);
    const hanging = hang();
    const handle = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: hanging.executor,
      load: load(),
      watch: { planId: "background-agent-delegation", unitId: "T2" },
    });
    hanging.release({ status: "completed", result: "SECRET-RESULT", sideEffects: false });
    await waitFor(handle.instanceId);
    expect(bound.wakes).toEqual([
      completionText({
        instanceId: handle.instanceId,
        roleId: "developer",
        status: "completed",
        interest: { planId: "background-agent-delegation", unitId: "T2" },
        channel: "wake",
      }),
    ]);
    expect(bound.wakes[0]).not.toContain("SECRET-RESULT");
    expect(deliveryFor(false, true)).toBe("notify");
    expect(deliveryFor(true, false)).toBe("hold");
    expect(deliveryFor(true, true)).toBe("wake");

    const late = hang();
    const held = owner(false);
    bindBackgroundOwner(held);
    const running = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: late.executor,
      load: load(),
    });
    shutdownBackground(held.token);
    expect(workerStatus()).toEqual([]);
    late.release({ status: "completed", result: "LATE", sideEffects: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(held.notes).toEqual([]);
    expect(() => workerStatus(running.instanceId)).toThrow(/unknown worker/);
  });

  test("a foreign token does not flush or cancel", async () => {
    const bound = owner(false);
    bindBackgroundOwner(bound);
    const hanging = hang();
    const handle = await spawnBackground({
      roleId: "developer",
      task: "change the widget",
      cwd: packageRoot(),
      executor: hanging.executor,
      load: load(),
      watch: { planId: "background-agent-delegation", unitId: "T3" },
    });
    hanging.release({ status: "failed", result: "SECRET-RESULT", sideEffects: false });
    await waitFor(handle.instanceId);
    expect(takeHeldCompletions(Symbol("other"))).toBeUndefined();
    expect(workerStatus(handle.instanceId)).toHaveLength(1);
    shutdownBackground(Symbol("other"));
    expect(workerStatus(handle.instanceId)[0]?.status).toBe("failed");
    bound.isIdle = () => true;
    const text = takeHeldCompletions(bound.token);
    expect(text).toContain(handle.instanceId);
    expect(text).not.toContain("SECRET-RESULT");
    expect(takeHeldCompletions(bound.token)).toBeUndefined();
  });
});

describe("background tools", () => {
  test("spawn tool returns before the executor finishes and does not steer", async () => {
    const hanging = hang();
    setBackgroundExecutor(hanging.executor);
    const tools = new Map<string, { execute: Function }>();
    const sent: unknown[] = [];
    const handlers = new Map<string, Function>();
    let idle = false;
    const pi = {
      registerTool(def: { name: string; execute: Function }) {
        tools.set(def.name, def);
      },
      sendMessage(message: unknown, options: unknown) {
        sent.push({ message, options });
      },
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
      registerFlag() {},
      registerCommand() {},
      getFlag() {
        return undefined;
      },
      getAllTools() {
        return [{ name: "read" }];
      },
      getActiveTools() {
        return ["read"];
      },
      setActiveTools() {},
      getSessionName() {
        return "pitako:coding";
      },
      setSessionName() {},
    };
    agentInstance(pi as unknown as ExtensionAPI);
    pitako(pi as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({}, { hasUI: true, isIdle: () => idle, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => "parent" } });
    const spawn = tools.get("agent_spawn");
    if (!spawn) throw new Error("agent_spawn missing");
    const result = await spawn.execute("call", { role: "developer", task: "change the widget", plan: "background-agent-delegation", unit: "T3" }, new AbortController().signal, undefined, { cwd: packageRoot() });
    expect(result.content[0].text).toContain("status: running");
    expect(hanging.started).toBeInstanceOf(Promise);
    const status = tools.get("agent_status");
    const listed = await status?.execute("call", {}, undefined, undefined, { cwd: packageRoot() });
    expect(listed.content[0].text).toContain("status: running");
    expect(listed.content[0].text).not.toContain("change the widget");
    const early = await tools.get("agent_result")?.execute("call", { id: result.details.instanceId }, undefined, undefined, { cwd: packageRoot() });
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toContain("worker is still running");
    hanging.release({ status: "completed", result: "SECRET-RESULT", sideEffects: false });
    await waitFor(result.details.instanceId);
    expect(sent).toEqual([]);
    idle = true;
    handlers.get("agent_settled")?.();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain("steer");
    expect(JSON.stringify(sent[0])).toContain("followUp");
    expect(JSON.stringify(sent[0])).not.toContain("SECRET-RESULT");
    const childHandlers = new Map<string, Function>();
    pitako({
      ...pi,
      on(event: string, handler: Function) {
        childHandlers.set(event, handler);
      },
      sendMessage(message: unknown, options: unknown) {
        sent.push({ message, options, child: true });
      },
    } as unknown as ExtensionAPI);
    childHandlers.get("agent_settled")?.();
    expect(sent.filter((item) => (item as { child?: boolean }).child)).toEqual([]);
  });

  test("childActiveTools drops orchestration tools", () => {
    const names = childActiveTools(["read", ...ORCHESTRATION_TOOLS]);
    for (const name of ORCHESTRATION_TOOLS) expect(names).not.toContain(name);
    expect(names).toContain("read");
  });

  test("agent_spawn is refused inside an instance", async () => {
    const tools = new Map<string, { execute: Function }>();
    agentInstance({
      registerTool(def: { name: string; execute: Function }) {
        tools.set(def.name, def);
      },
    } as unknown as ExtensionAPI);
    const result = await agentScope.run({ instanceId: "developer-child" }, () =>
      tools.get("agent_spawn")?.execute("call", { role: "developer", task: "nope" }, undefined, undefined, { cwd: packageRoot() }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cannot be called");
  });
});

describe("parent turn during child prompt", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete (globalThis as { __pitakoHangProvider?: unknown }).__pitakoHangProvider;
  });

  test("a parent prompt completes while the child prompt is pending", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-hang-agent-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-hang-cwd-"));
    tempDirs.push(agentDir, cwd);
    mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      path.join(agentDir, "extensions", "hang.js"),
      "export default function (pi) { pi.registerProvider('pitako-hang', globalThis.__pitakoHangProvider); }\n",
    );
    let started!: () => void;
    const childPromptStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const specifier = "@earendil-works/pi-ai/utils/event-stream.js";
    const { createAssistantMessageEventStream } = await import(specifier);
    (globalThis as { __pitakoHangProvider?: unknown }).__pitakoHangProvider = {
      baseUrl: "http://127.0.0.1",
      apiKey: "test",
      api: "openai-completions",
      models: [
        { id: "hang", name: "Hang", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 64 },
        { id: "fast", name: "Fast", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 64 },
      ],
      streamSimple(model: { id: string }) {
        const stream = createAssistantMessageEventStream();
        if (model.id === "hang") {
          started();
          return stream;
        }
        const message = assistant(model.id, "parent-ok");
        queueMicrotask(() => {
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        });
        return stream;
      },
    };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const userConfigPath = path.join(agentDir, "pitako", "config.toml");
    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    writeFileSync(userConfigPath, `[model_policies.developer.primary]\nmodel = "pitako-hang/hang"\nreasoning = "off"\n`);
    const handle = await spawnBackground({
      roleId: "developer",
      task: "keep working",
      cwd,
      executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath },
    });
    await childPromptStarted;
    expect(workerStatus(handle.instanceId)[0]?.status).toBe("running");
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
      modelRuntime: runtime,
    });
    try {
      const model = runtime.getModel("pitako-hang", "fast");
      if (!model) throw new Error("fast model missing");
      await session.setModel(model, { persist: false });
      await session.prompt("what remains of the plan", { expandPromptTemplates: false });
      expect(JSON.stringify(session.messages)).toContain("parent-ok");
      expect(workerStatus(handle.instanceId)[0]?.status).toBe("running");
    } finally {
      cancelWorker(handle.instanceId);
      await session.dispose();
    }
  }, 60_000);
});

function assistant(model: string, text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "pitako-hang",
    model,
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
}

function pitakoAgentsCommand(): {
  run: (args: string) => Promise<{ notes: string[]; errors: string[]; threw: boolean }>;
} {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    registerFlag() {},
    registerTool() {},
    registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      handler = def.handler;
    },
    on() {},
    getFlag() {
      return undefined;
    },
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
    getSessionName() {
      return undefined;
    },
    setSessionName() {},
    sendMessage() {},
  };
  pitako(pi as unknown as ExtensionAPI);
  return {
    async run(args: string) {
      const notes: string[] = [];
      const errors: string[] = [];
      let threw = false;
      try {
        await handler?.(args, {
          hasUI: true,
          ui: {
            notify(message: string, kind?: string) {
              if (kind === "error") errors.push(message);
              else notes.push(message);
            },
            setStatus() {},
          },
        });
      } catch {
        threw = true;
      }
      return { notes, errors, threw };
    },
  };
}

async function waitFor(instanceId: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    try {
      workerResult(instanceId);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`worker ${instanceId} did not settle`);
}
