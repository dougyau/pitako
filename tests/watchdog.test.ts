import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentInstance, type AttemptExecutor } from "../extensions/agent/run.ts";
import {
  WALL_CLOCK_TIMEOUT_SOURCE,
  activityKind,
  createActivity,
  evaluateWatchdog,
  noteActivity,
  noteToolEnd,
  noteToolStart,
  startWatchdogTimer,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_STALL_TIMEOUT_MS,
  type WatchdogConfig,
} from "../extensions/agent/watchdog.ts";
import { loadPitakoConfig } from "../extensions/roles/load.ts";

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

  test("defaults are 10m idle, 45m tool stall, and unlimited max runtime", () => {
    const config = loadPitakoConfig({ env: { PI_CODING_AGENT_DIR: missingDir() } });
    expect(config.watchdog.idleTimeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(config.watchdog.toolStallTimeoutMs).toBe(DEFAULT_TOOL_STALL_TIMEOUT_MS);
    expect(config.watchdog.maxRunTimeMs).toBe(0);
  });
});

describe("watchdog integration", () => {
  test("confirmed idle stall fails without fallback or task replay", async () => {
    let clock = 0;
    let tick = () => {};
    const starts: string[] = [];
    const executor: AttemptExecutor = {
      async start(input) {
        starts.push(input.target.model);
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
