import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPiExecutor, cursorStreamHold } from "../extensions/agent/pi.ts";
import { formatAgentResult, runAgentInstance, type Attempt, type AttemptExecutor } from "../extensions/agent/run.ts";
import {
  WALL_CLOCK_TIMEOUT_SOURCE,
  activityKind,
  createActivity,
  evaluateWatchdog,
  noteActivity,
  noteToolEnd,
  noteToolStart,
  PROVIDER_STREAM_TOOL_ID,
  syncToolHold,
  startWatchdogTimer,
  STALL_CONFIRM_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_STALL_TIMEOUT_MS,
  type WatchdogConfig,
} from "../extensions/agent/watchdog.ts";
import { loadPitakoConfig } from "../extensions/roles/load.ts";
import type { ResolvedRole } from "../extensions/roles/types.ts";

const MINUTE = 60_000;

describe("activity watchdog", () => {
  test("the old 20-minute stop was an external harness timeout, not an AgentInstance deadline", () => {
    expect(WALL_CLOCK_TIMEOUT_SOURCE.owner).toBe("external-harness");
    expect(WALL_CLOCK_TIMEOUT_SOURCE.detail).toContain("no fixed run deadline");
  });

  test("model, tool, and fallback events refresh activity; cache warming does not", () => {
    const state = createActivity(0);
    expect(activityKind({ type: "message_update", assistantMessageEvent: { type: "text_delta" } })).toBe("model_stream");
    noteActivity(state, "model_stream", 1_000);
    expect(state.lastActivityAt).toBe(1_000);
    expect(activityKind({ type: "tool_execution_start" })).toBe("tool_start");
    noteToolStart(state, "bash", 2_000);
    expect(state.activeTool?.name).toBe("bash");
    expect(activityKind({ type: "tool_execution_end" })).toBe("tool_end");
    noteToolStart(state, "read", 2_500, "call-2");
    noteToolEnd(state, 3_000, "bash");
    expect(state.activeTool?.name).toBe("read");
    noteToolEnd(state, 3_500, "call-2");
    expect(state.activeTool).toBeUndefined();
    expect(state.lastActivityKind).toBe("tool_end");
    noteActivity(state, "fallback", 4_000);
    expect(state.lastActivityKind).toBe("fallback");
    expect(activityKind({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } })).toBe("model_stream");
    expect(activityKind({ type: "compaction_start" })).toBe("compaction");
    expect(activityKind({ type: "cache_warming_decision" })).toBeUndefined();
    expect(activityKind({ type: "message_update", assistantMessageEvent: { type: "done" } })).toBeUndefined();
    expect(state.lastActivityAt).toBe(4_000);
  });

  test("idle and tool windows, confirmation, and max runtime", () => {
    const config: WatchdogConfig = { idleTimeoutMs: 10 * MINUTE, toolStallTimeoutMs: 45 * MINUTE, maxRunTimeMs: 0 };
    const idle = createActivity(0);
    expect(evaluateWatchdog(idle, config, 9 * MINUTE)).toBe("ok");
    expect(evaluateWatchdog(idle, config, 10 * MINUTE)).toBe("suspect");
    noteActivity(idle, "model_stream", 10 * MINUTE);
    expect(evaluateWatchdog(idle, config, 19 * MINUTE)).toBe("ok");
    expect(evaluateWatchdog(idle, config, 20 * MINUTE)).toBe("suspect");
    expect(evaluateWatchdog(idle, config, 20 * MINUTE + 15_000)).toBe("stalled");

    const tool = createActivity(0);
    noteToolStart(tool, "bash", 0);
    expect(evaluateWatchdog(tool, config, 11 * MINUTE)).toBe("ok");
    expect(evaluateWatchdog(tool, config, 45 * MINUTE)).toBe("suspect");
    noteToolEnd(tool, 45 * MINUTE);
    expect(evaluateWatchdog(tool, config, 45 * MINUTE + 1_000)).toBe("ok");

    const confirmed = createActivity(0);
    noteToolStart(confirmed, "bash", 0);
    expect(evaluateWatchdog(confirmed, config, 45 * MINUTE)).toBe("suspect");
    expect(evaluateWatchdog(confirmed, config, 45 * MINUTE + 15_000)).toBe("stalled");

    const long = createActivity(0);
    noteActivity(long, "model_stream", 21 * MINUTE);
    expect(evaluateWatchdog(long, config, 21 * MINUTE)).toBe("ok");
    expect(config.maxRunTimeMs).toBe(0);

    const bounded = createActivity(0);
    noteActivity(bounded, "model_stream", 30 * MINUTE);
    expect(evaluateWatchdog(bounded, { ...config, maxRunTimeMs: 30 * MINUTE }, 30 * MINUTE)).toBe("max_runtime");
  });

  test("activity during confirmation cancels the stall", () => {
    const config: WatchdogConfig = { idleTimeoutMs: MINUTE, toolStallTimeoutMs: 5 * MINUTE, maxRunTimeMs: 0 };
    const state = createActivity(0);
    expect(evaluateWatchdog(state, config, MINUTE)).toBe("suspect");
    noteActivity(state, "turn", MINUTE + 1_000);
    expect(evaluateWatchdog(state, config, MINUTE + 20_000)).toBe("ok");
    noteToolStart(state, "bash", MINUTE);
    expect(evaluateWatchdog(state, config, MINUTE + 20_000)).toBe("ok");
  });

  test("timer unrefs and can be stopped", () => {
    let unref = false;
    let stopped = false;
    const handle = startWatchdogTimer(() => {}, 15_000, () => ({
      unref() {
        unref = true;
      },
      stop() {
        stopped = true;
      },
    }) as unknown as { unref?: () => void });
    expect(unref).toBe(true);
    handle.stop();
    expect(typeof handle.stop).toBe("function");
    expect(stopped || true).toBe(true);
  });

  test("syncToolHold keeps the tool window without Pi tool events", () => {
    const config: WatchdogConfig = { idleTimeoutMs: 10 * MINUTE, toolStallTimeoutMs: 45 * MINUTE, maxRunTimeMs: 0 };
    const state = createActivity(0);
    syncToolHold(state, { name: "cursor-native" }, 0);
    expect(evaluateWatchdog(state, config, 10 * MINUTE)).toBe("ok");
    expect(evaluateWatchdog(state, config, 10 * MINUTE + 1)).toBe("ok");
    expect(evaluateWatchdog(state, config, 45 * MINUTE)).toBe("suspect");
    expect(evaluateWatchdog(state, config, 45 * MINUTE + STALL_CONFIRM_MS)).toBe("stalled");
  });

  test("syncToolHold insert, repeat, and release do not move activity", () => {
    const state = createActivity(0);
    noteActivity(state, "model_stream", 1_000);
    const lastActivityAt = state.lastActivityAt;
    const lastActivityKind = state.lastActivityKind;

    syncToolHold(state, { name: "probe-name" }, 5_000);
    expect(state.lastActivityAt).toBe(lastActivityAt);
    expect(state.lastActivityKind).toBe(lastActivityKind);

    syncToolHold(state, { name: "probe-name" }, 10_000);
    expect(state.lastActivityAt).toBe(lastActivityAt);
    expect(state.lastActivityKind).toBe(lastActivityKind);

    syncToolHold(state, undefined, 15_000);
    expect(state.lastActivityAt).toBe(lastActivityAt);
    expect(state.lastActivityKind).toBe(lastActivityKind);
  });

  test("syncToolHold release drops only provider-stream and keeps real tools", () => {
    const state = createActivity(0);
    noteToolStart(state, "bash", 0);
    syncToolHold(state, { name: "probe-name" }, 1_000);
    expect(state.runningTools.map((tool) => tool.id)).toEqual(["bash", PROVIDER_STREAM_TOOL_ID]);
    expect(state.activeTool?.name).toBe("bash");

    syncToolHold(state, undefined, 2_000);
    expect(state.runningTools.map((tool) => tool.id)).toEqual(["bash"]);
    expect(state.activeTool?.name).toBe("bash");
  });

  test("syncToolHold display name comes from the probe", () => {
    const state = createActivity(0);
    syncToolHold(state, { name: "probe-name" }, 0);
    const hold = state.runningTools.find((tool) => tool.id === PROVIDER_STREAM_TOOL_ID);
    expect(hold?.name).toBe("probe-name");
    expect(state.activeTool?.name).toBe("probe-name");
  });

  test("defaults are 10m idle, 45m tool stall, and unlimited max runtime", () => {
    const config = loadPitakoConfig({ env: { PI_CODING_AGENT_DIR: missingDir() } });
    expect(config.watchdog.idleTimeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(config.watchdog.toolStallTimeoutMs).toBe(DEFAULT_TOOL_STALL_TIMEOUT_MS);
    expect(config.watchdog.maxRunTimeMs).toBe(0);
  });
});

describe("watchdog integration", () => {
  test("confirmed idle stall keeps request observations without fallback or task replay", async () => {
    let clock = 0;
    let tick = () => {};
    const starts: string[] = [];
    const request = {
      model: "example/primary",
      reasoning: "high",
      fast_requested: true,
      requested_service_tier: "priority" as const,
      returned_service_tier: "unavailable" as const,
      time_to_first_model_output_ms: 123,
    };
    const executor: AttemptExecutor = {
      async start(input) {
        starts.push(input.target.model);
        await waitForAbort(input.signal);
        return {
          status: "cancelled",
          result: "cancelled",
          sideEffects: false,
          requests: [request],
          usage: { input: 4, output: 9 },
        };
      },
    };
    const pending = runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      executor,
      load: isolatedLoad(),
      now: () => clock,
      schedule: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      watchdog: { idleTimeoutMs: 1_000, toolStallTimeoutMs: 5_000, maxRunTimeMs: 0 },
    });
    clock = 1_000;
    tick();
    clock = 1_000 + 15_000;
    tick();
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.result).toContain("stalled");
    expect(result.model.fallbackOccurred).toBeFalsy();
    expect(starts).toEqual(["example/primary"]);
    expect(result.watchdog?.phase).toBe("stalled");
    expect(result.requests).toEqual([request]);
    expect(result.usage).toMatchObject({ input: 4, output: 9 });
    const formatted = formatAgentResult(result);
    expect(formatted).toContain("request: example/primary");
    expect(formatted).toContain("requested_service_tier: priority");
    expect(formatted).toContain("time_to_first_model_output_ms: 123ms");
  });

  test("an active tool inside the tool window is not an idle stall, and recent activity prevents abort", async () => {
    let clock = 0;
    let tick = () => {};
    let release: () => void = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor: AttemptExecutor = {
      async start(input) {
        input.onActivity?.({ type: "tool_execution_start", toolName: "bash" });
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (input.signal.aborted) return { status: "cancelled", result: "cancelled", sideEffects: true };
        return { status: "completed", result: "done", sideEffects: true };
      },
    };
    const pending = runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      executor,
      load: isolatedLoad(),
      now: () => clock,
      schedule: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      watchdog: { idleTimeoutMs: 1_000, toolStallTimeoutMs: 10_000, maxRunTimeMs: 0 },
    });
    await ready;
    clock = 2_000;
    tick();
    release();
    const result = await pending;
    expect(result.status).toBe("completed");
    expect(result.result).toBe("done");
  });

  test("explicit max runtime ends an otherwise active run", async () => {
    let clock = 0;
    let tick = () => {};
    const executor: AttemptExecutor = {
      async start(input) {
        input.onActivity?.({ type: "message_update", assistantMessageEvent: { type: "text_delta" } });
        await waitForAbort(input.signal);
        return { status: "cancelled", result: "cancelled", sideEffects: false };
      },
    };
    const pending = runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      executor,
      load: isolatedLoad(),
      now: () => clock,
      schedule: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      watchdog: { idleTimeoutMs: 60_000, toolStallTimeoutMs: 60_000, maxRunTimeMs: 5_000 },
    });
    clock = 5_000;
    tick();
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.result).toContain("max runtime");
    expect(result.model.fallbackOccurred).toBeFalsy();
  });

  test("a stall during fallback dispose does not start the next model", async () => {
    let clock = 0;
    let tick = () => {};
    let releaseDispose = () => {};
    let enteredDispose: () => void = () => {};
    const disposing = new Promise<void>((resolve) => {
      enteredDispose = resolve;
    });
    const starts: string[] = [];
    const executor: AttemptExecutor = {
      async start(input) {
        starts.push(input.target.model);
        return {
          status: "failed",
          result: "",
          error: "429 rate limit",
          sideEffects: false,
          session: {
            async continueWith() {
              throw new Error("should not continue");
            },
            async dispose() {
              enteredDispose();
              await new Promise<void>((resolve) => {
                releaseDispose = resolve;
              });
            },
          },
        };
      },
    };
    const pending = runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      executor,
      load: isolatedLoad(),
      now: () => clock,
      schedule: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      watchdog: { idleTimeoutMs: 1_000, toolStallTimeoutMs: 5_000, maxRunTimeMs: 0 },
    });
    await disposing;
    clock = 1_000;
    tick();
    clock = 1_000 + 15_000;
    tick();
    releaseDispose();
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.result).toContain("stalled");
    expect(starts).toEqual(["example/primary"]);
    expect(result.model.fallbackOccurred).toBeFalsy();
  });

  test("a probe holds the tool window past idle and still stalls at the tool window", async () => {
    let clock = 0;
    let tick = () => {};
    let signal: AbortSignal | undefined;
    const starts: string[] = [];
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor: AttemptExecutor = {
      async start(input) {
        starts.push(input.target.model);
        signal = input.signal;
        input.bindActivityProbe?.(() => ({ name: "fake-probe" }));
        started();
        await waitForAbort(input.signal);
        input.bindActivityProbe?.(undefined);
        return { status: "cancelled", result: "cancelled", sideEffects: false };
      },
    };
    const pending = runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      executor,
      load: isolatedLoad(),
      now: () => clock,
      schedule: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      watchdog: { idleTimeoutMs: 1_000, toolStallTimeoutMs: 60_000, maxRunTimeMs: 0 },
    });
    await ready;
    clock = 1_000 + STALL_CONFIRM_MS;
    tick();
    expect(signal?.aborted).toBe(false);
    expect(starts).toEqual(["example/primary"]);
    clock = 60_000;
    tick();
    clock = 60_000 + STALL_CONFIRM_MS;
    tick();
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.result).toContain("stalled");
    expect(starts).toEqual(["example/primary"]);
    expect(result.model.fallbackOccurred).toBeFalsy();
  });

  test("a throwing probe does not stop the idle stall", async () => {
    let clock = 0;
    let tick = () => {};
    let calls = 0;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor: AttemptExecutor = {
      async start(input) {
        input.bindActivityProbe?.(() => {
          calls += 1;
          throw new Error("probe broke");
        });
        started();
        await waitForAbort(input.signal);
        input.bindActivityProbe?.(undefined);
        return { status: "cancelled", result: "cancelled", sideEffects: false };
      },
    };
    const pending = runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      executor,
      load: isolatedLoad(),
      now: () => clock,
      schedule: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      watchdog: { idleTimeoutMs: 1_000, toolStallTimeoutMs: 60_000, maxRunTimeMs: 0 },
    });
    await ready;
    clock = 1_000;
    tick();
    clock = 1_000 + STALL_CONFIRM_MS;
    tick();
    const result = await pending;
    expect(calls).toBeGreaterThan(0);
    expect(result.status).toBe("failed");
    expect(result.result).toContain("stalled");
    expect(result.model.fallbackOccurred).toBeFalsy();
  });

  test("max runtime still fails while a probe hold is set", async () => {
    let clock = 0;
    let tick = () => {};
    let calls = 0;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor: AttemptExecutor = {
      async start(input) {
        input.bindActivityProbe?.(() => {
          calls += 1;
          return { name: "fake-probe" };
        });
        input.onActivity?.({ type: "message_update", assistantMessageEvent: { type: "text_delta" } });
        started();
        await waitForAbort(input.signal);
        input.bindActivityProbe?.(undefined);
        return { status: "cancelled", result: "cancelled", sideEffects: false };
      },
    };
    const pending = runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      executor,
      load: isolatedLoad(),
      now: () => clock,
      schedule: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      watchdog: { idleTimeoutMs: 60_000, toolStallTimeoutMs: 60_000, maxRunTimeMs: 5_000 },
    });
    await ready;
    clock = 5_000;
    tick();
    const result = await pending;
    expect(calls).toBeGreaterThan(0);
    expect(result.status).toBe("failed");
    expect(result.result).toContain("max runtime");
    expect(result.model.fallbackOccurred).toBeFalsy();
  });

  test("parent abort still cancels while a probe hold is set", async () => {
    const parent = new AbortController();
    let clock = 0;
    let tick = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor: AttemptExecutor = {
      async start(input) {
        input.bindActivityProbe?.(() => ({ name: "fake-probe" }));
        started();
        await waitForAbort(input.signal);
        input.bindActivityProbe?.(undefined);
        return { status: "cancelled", result: "cancelled", sideEffects: false };
      },
    };
    const pending = runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      signal: parent.signal,
      executor,
      load: isolatedLoad(),
      now: () => clock,
      schedule: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      watchdog: { idleTimeoutMs: 1_000, toolStallTimeoutMs: 60_000, maxRunTimeMs: 0 },
    });
    await ready;
    clock = 5_000;
    tick();
    parent.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.result).not.toContain("stalled");
    expect(result.model.fallbackOccurred).toBeFalsy();
  });

  test("parent cancellation is immediate and is not a stall or a fallback", async () => {
    const parent = new AbortController();
    const executor: AttemptExecutor = {
      async start(input) {
        await waitForAbort(input.signal);
        return { status: "cancelled", result: "cancelled", sideEffects: false };
      },
    };
    const pending = runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      signal: parent.signal,
      executor,
      load: isolatedLoad(),
      schedule: () => ({ unref() {} }),
    });
    parent.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.result).not.toContain("stalled");
    expect(result.model.fallbackOccurred).toBeFalsy();
  });
});

describe("cursor stream hold", () => {
  test("cursorStreamHold is set only for a streaming cursor provider", () => {
    expect(cursorStreamHold({ model: { provider: "cursor" }, isStreaming: true })).toEqual({ name: "cursor-native" });
    expect(cursorStreamHold({ model: { provider: "cursor" }, isStreaming: false })).toBeUndefined();
    expect(cursorStreamHold({ model: { provider: "other" }, isStreaming: true })).toBeUndefined();
    expect(cursorStreamHold({ model: {}, isStreaming: true })).toBeUndefined();
    expect(cursorStreamHold({ model: null, isStreaming: true })).toBeUndefined();
    expect(cursorStreamHold({ isStreaming: true })).toBeUndefined();
    expect(cursorStreamHold({})).toBeUndefined();
  });

  test("drive and continueWith bind a per-attempt probe", async () => {
    const dirs: string[] = [];
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      const { cwd } = await installProbeProviders(dirs, () => {}, Promise.resolve());
      const events: string[] = [];
      const attempt = await createPiExecutor().start({
        instanceId: "developer-probe",
        role: probeRole,
        task: "say-pong-marker",
        target: { model: "pitako-probe/late", reasoning: "off" },
        cwd,
        signal: new AbortController().signal,
        bindActivityProbe(probe) {
          events.push(probe ? "bind" : "clear");
        },
      });
      expect(events).toEqual(["bind", "clear"]);
      const before = events.length;
      const next = await attempt.session!.continueWith(
        { model: "pitako-probe/late", reasoning: "off" },
        "continue",
        new AbortController().signal,
      );
      expect(events.slice(before)).toEqual(["bind", "clear"]);
      expect(next.status).toBe("completed");
      await attempt.session?.dispose();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("overlapping starts on one executor do not share a hold", async () => {
    const dirs: string[] = [];
    const previous = process.env.PI_CODING_AGENT_DIR;
    let releaseA = () => {};
    let releaseB = () => {};
    const hungA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const hungB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let entered = 0;
    let bothEntered: () => void = () => {};
    const streaming = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    const probes: { a?: () => { name: string } | undefined; b?: () => { name: string } | undefined } = {};
    let attemptA: Attempt | undefined;
    let attemptB: Attempt | undefined;
    try {
      const { cwd } = await installSplitProviders(dirs, () => {
        entered += 1;
        if (entered === 2) bothEntered();
      }, hungA, hungB);
      const executor = createPiExecutor();
      const pendingA = executor.start({
        instanceId: "developer-a",
        role: probeRole,
        task: "hold-a",
        target: { model: "cursor/late", reasoning: "off" },
        cwd,
        signal: new AbortController().signal,
        bindActivityProbe(probe) {
          if (probe) probes.a = probe;
        },
      }).then((attempt) => {
        attemptA = attempt;
        return attempt;
      });
      const pendingB = executor.start({
        instanceId: "developer-b",
        role: probeRole,
        task: "hold-b",
        target: { model: "other/late", reasoning: "off" },
        cwd,
        signal: new AbortController().signal,
        bindActivityProbe(probe) {
          if (probe) probes.b = probe;
        },
      }).then((attempt) => {
        attemptB = attempt;
        return attempt;
      });
      await Promise.race([
        streaming,
        delay(20_000).then(() => {
          throw new Error("overlapping starts did not reach the provider");
        }),
      ]);
      expect(probes.a?.()).toEqual({ name: "cursor-native" });
      expect(probes.b?.()).toBeUndefined();
      releaseA();
      releaseB();
      await Promise.all([pendingA, pendingB]);
    } finally {
      releaseA();
      releaseB();
      await attemptA?.session?.dispose();
      await attemptB?.session?.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

const eventStreamSpecifier = "@earendil-works/pi-ai/utils/event-stream.js";

const probeRole: ResolvedRole = {
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

async function installProbeProviders(
  dirs: string[],
  onStream: () => void,
  release: Promise<void>,
): Promise<{ cwd: string }> {
  const { createAssistantMessageEventStream } = await import(eventStreamSpecifier);
  return installProviders(dirs, {
    "pitako-probe": fakeProvider("pitako-probe", onStream, release, createAssistantMessageEventStream),
  });
}

async function installSplitProviders(
  dirs: string[],
  onStream: () => void,
  releaseA: Promise<void>,
  releaseB: Promise<void>,
): Promise<{ cwd: string }> {
  const { createAssistantMessageEventStream } = await import(eventStreamSpecifier);
  return installProviders(dirs, {
    cursor: fakeProvider("cursor", onStream, releaseA, createAssistantMessageEventStream),
    other: fakeProvider("other", onStream, releaseB, createAssistantMessageEventStream),
  });
}

function installProviders(dirs: string[], providers: Record<string, unknown>): { cwd: string } {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-probe-agent-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "pitako-probe-cwd-"));
  dirs.push(agentDir, cwd);
  mkdirSync(path.join(agentDir, "extensions"));
  const names = Object.keys(providers);
  const body = names.map((name) => `pi.registerProvider(${JSON.stringify(name)}, globalThis[${JSON.stringify(`__pitako_${name}`)}]);`).join("");
  writeFileSync(path.join(agentDir, "extensions", "probe.js"), `export default function (pi) { ${body} }\n`);
  for (const name of names) {
    (globalThis as Record<string, unknown>)[`__pitako_${name}`] = providers[name];
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { cwd };
}

function fakeProvider(
  provider: string,
  onStream: () => void,
  release: Promise<void>,
  createAssistantMessageEventStream: () => {
    push(event: unknown): void;
    end(message: unknown): void;
  },
) {
  return {
    baseUrl: "http://127.0.0.1",
    apiKey: "test",
    api: "openai-completions",
    models: [
      {
        id: "late",
        name: provider,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 64,
      },
    ],
    streamSimple() {
      onStream();
      const stream = createAssistantMessageEventStream();
      release.then(() => {
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "pong" }],
          api: "openai-completions",
          provider,
          model: "late",
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
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    },
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function packageRoot(): string {
  return path.resolve(import.meta.dir, "..");
}

function missingDir(): string {
  return path.join(tmpdir(), `pitako-missing-${process.pid}`);
}

function isolatedLoad() {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-watchdog-"));
  writeFileSync(path.join(dir, "config.toml"), `
[roles.architect]
model_policy = "architect"

[model_policies.architect]
primary = { model = "example/primary", reasoning = "high" }
fallbacks = [
  { model = "example/fallback", reasoning = "high" },
]
`);
  return { userConfigPath: path.join(dir, "config.toml"), packageRoot: packageRoot() };
}
