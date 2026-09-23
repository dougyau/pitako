import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentInstance from "../extensions/agent/index.ts";
import {
  cancelAllWorkers,
  clearBackgroundOwner,
  formatWorkerViews,
  setBackgroundExecutor,
  spawnBackground,
  workerResult,
  workerStatus,
} from "../extensions/agent/background.ts";
import { clearObservations, listObservations } from "../extensions/agent/observe.ts";
import { formatAgentResult, runAgentInstance, type AttemptExecutor } from "../extensions/agent/run.ts";
import { formatFooter } from "../extensions/agent/ui.ts";
import { packageRoot } from "../extensions/stack.ts";
import type { LoadOptions } from "../extensions/roles/load.ts";

const tempDirs: string[] = [];
afterEach(() => {
  cancelAllWorkers();
  clearBackgroundOwner();
  setBackgroundExecutor(undefined);
  clearObservations();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function load(extra = ""): LoadOptions {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-obs-"));
  tempDirs.push(dir);
  const userConfigPath = path.join(dir, "pitako", "config.toml");
  mkdirSync(path.dirname(userConfigPath), { recursive: true });
  writeFileSync(
    userConfigPath,
    `[model_policies.developer.primary]\nmodel = "example/primary"\nreasoning = "medium"\n${extra}`,
  );
  return { env: { PI_CODING_AGENT_DIR: dir }, userConfigPath };
}

async function waitSettled(instanceId: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const view = workerStatus(instanceId)[0];
    if (view && view.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`worker ${instanceId} did not settle`);
}

describe("T2 observations", () => {
  test("accepted background worker observation has role, task, running", async () => {
    let release!: (attempt: { status: "completed"; result: string; sideEffects: false }) => void;
    const gate = new Promise<{ status: "completed"; result: string; sideEffects: false }>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handle = await spawnBackground({
      roleId: "developer",
      task: "Fix lifecycle\nSECRET-SECOND",
      cwd: packageRoot(),
      load: load(),
      watch: { planId: "obs-plan", unitId: "T2" },
      executor: {
        async start() {
          started();
          return await gate;
        },
      },
    });
    await startedP;
    const row = listObservations().find((item) => item.id === handle.instanceId);
    expect(row).toBeDefined();
    expect(row?.roleId).toBe("developer");
    expect(row?.task).toContain("Fix lifecycle");
    expect(row?.status).toBe("running");
    expect(row?.planId).toBe("obs-plan");
    expect(row?.unitId).toBe("T2");
    expect(typeof row?.acceptedAt).toBe("number");
    release({ status: "completed", result: "ok", sideEffects: false });
    await waitSettled(handle.instanceId);
  });

  test("message_update usage.output updates tokens without changing watchdog phase", async () => {
    let clock = 0;
    const phases: string[] = [];
    const tokens: Array<number | undefined> = [];
    const executor: AttemptExecutor = {
      async start(input) {
        input.onActivity?.({
          type: "message_update",
          assistantMessageEvent: {
            type: "done",
            partial: { usage: { output: 42 } },
          },
        } as Parameters<NonNullable<typeof input.onActivity>>[0]);
        return { status: "completed", result: "done", sideEffects: false, appliedReasoning: "medium" };
      },
    };
    const result = await runAgentInstance({
      roleId: "developer",
      task: "sample tokens",
      cwd: packageRoot(),
      executor,
      load: load(),
      now: () => clock,
      onObserve(snap) {
        phases.push(snap.phase);
        tokens.push(snap.outputTokens);
      },
    });
    expect(result.status).toBe("completed");
    expect(tokens.some((value) => value === 42)).toBe(true);
    expect(phases.every((phase) => phase === "working")).toBe(true);
    expect(result.watchdog?.phase).toBe("working");
  });

  test("fallbackOccurred observation keeps selected model gated on appliedReasoning", async () => {
    const snaps: Array<{ selectedModel: string; appliedReasoning?: string; fallbackOccurred?: boolean }> = [];
    const executor: AttemptExecutor = {
      async start(input) {
        if (input.target.model === "example/primary") {
          return { status: "failed", result: "", error: "429 rate limit", sideEffects: false };
        }
        // Fallback target chosen; activation not applied yet until onActivated.
        expect(input.target.model).toBe("example/fallback-1");
        input.onActivated?.("high");
        return {
          status: "completed",
          result: "ok",
          sideEffects: false,
          appliedReasoning: "high",
        };
      },
    };
    await runAgentInstance({
      roleId: "developer",
      task: "fallback path",
      cwd: packageRoot(),
      executor,
      load: load(`[[model_policies.developer.fallbacks]]\nmodel = "example/fallback-1"\nreasoning = "high"\n`),
      onObserve(snap) {
        snaps.push({
          selectedModel: snap.selectedModel,
          appliedReasoning: snap.appliedReasoning,
          fallbackOccurred: snap.fallbackOccurred,
        });
      },
    });
    const pendingFallback = snaps.find(
      (s) => s.fallbackOccurred && s.selectedModel === "example/fallback-1" && s.appliedReasoning === undefined,
    );
    expect(pendingFallback).toBeDefined();
    // Formatter rule: without appliedReasoning, footer does not advertise selected fallback id as active model.
    const footerPending = formatFooter(
      [
        {
          id: "x",
          roleId: "developer",
          status: "running",
          phase: "working",
          task: "fallback path",
          acceptedAt: 0,
          selectedModel: pendingFallback!.selectedModel,
          requestedModel: "example/primary",
          fallbackOccurred: true,
          lastActivityKind: "prompt",
        },
      ],
      1000,
      120,
    );
    expect(footerPending).toContain("primary");
    expect(footerPending).not.toContain("fallback-1");

    const applied = snaps.find((s) => s.fallbackOccurred && s.appliedReasoning === "high");
    expect(applied?.selectedModel).toBe("example/fallback-1");
    const footerApplied = formatFooter(
      [
        {
          id: "y",
          roleId: "developer",
          status: "running",
          phase: "working",
          task: "fallback path",
          acceptedAt: 0,
          selectedModel: applied!.selectedModel,
          requestedModel: "example/primary",
          appliedReasoning: "high",
          fallbackOccurred: true,
          lastActivityKind: "model_stream",
        },
      ],
      1000,
      120,
    );
    expect(footerApplied).toContain("fallback-1");
  });

  test("agent_result text unchanged and observation becomes taken", async () => {
    let release!: (attempt: { status: "completed"; result: string; sideEffects: false }) => void;
    const gate = new Promise<{ status: "completed"; result: string; sideEffects: false }>((resolve) => {
      release = resolve;
    });
    const handle = await spawnBackground({
      roleId: "developer",
      task: "take result",
      cwd: packageRoot(),
      load: load(),
      executor: {
        async start() {
          return await gate;
        },
      },
    });
    release({ status: "completed", result: "SECRET-BODY", sideEffects: false });
    await waitSettled(handle.instanceId);
    const before = listObservations().find((item) => item.id === handle.instanceId);
    expect(before?.status).toBe("completed");
    expect(before?.resultTaken).toBeFalsy();

    const outcome = workerResult(handle.instanceId);
    const text = formatAgentResult(outcome);
    expect(text).toContain("SECRET-BODY");
    expect(text).toContain(handle.instanceId);
    expect(outcome.result).toBe("SECRET-BODY");

    const after = listObservations().find((item) => item.id === handle.instanceId);
    expect(after?.resultTaken).toBe(true);
    // Second read still same result object fields.
    expect(workerResult(handle.instanceId).result).toBe("SECRET-BODY");
    expect(formatAgentResult(workerResult(handle.instanceId))).toBe(text);
  });

  test("agent_status text still comes from formatWorkerViews only", async () => {
    let release!: (attempt: { status: "completed"; result: string; sideEffects: false }) => void;
    const gate = new Promise<{ status: "completed"; result: string; sideEffects: false }>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    setBackgroundExecutor({
      async start() {
        started();
        return await gate;
      },
    });
    const tools = new Map<string, { execute: Function }>();
    agentInstance({
      registerTool(def: { name: string; execute: Function }) {
        tools.set(def.name, def);
      },
    } as unknown as ExtensionAPI);

    // Synchronous agent_run observation must not appear in agent_status.
    const runTool = tools.get("agent_run");
    // Use hang-style spawn via tool for background row.
    const spawn = tools.get("agent_spawn");
    const spawnResult = await spawn?.execute(
      "call",
      { role: "developer", task: "status path" },
      new AbortController().signal,
      undefined,
      { cwd: packageRoot() },
    );
    await startedP;
    const status = await tools.get("agent_status")?.execute("call", {}, undefined, undefined, { cwd: packageRoot() });
    const views = workerStatus();
    expect(status.content[0].text).toBe(formatWorkerViews(views));
    expect(status.content[0].text).toContain("instance_id:");
    expect(status.content[0].text).not.toContain("Fix lifecycle");
    // agent_run rows live only in observations; status is bag-only.
    expect(runTool).toBeDefined();
    expect(listObservations().some((row) => row.id === spawnResult.details.instanceId)).toBe(true);

    release({ status: "completed", result: "ok", sideEffects: false });
    await waitSettled(spawnResult.details.instanceId);
  });

  test("model_stream samples accumulate streamMs and tool freezes the clock", async () => {
    let clock = 0;
    let lastStreamMs: number | undefined;
    const executor: AttemptExecutor = {
      async start(input) {
        clock = 100;
        input.onActivity?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", partial: { usage: { output: 10 } } },
        } as Parameters<NonNullable<typeof input.onActivity>>[0]);
        clock = 600;
        input.onActivity?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", partial: { usage: { output: 20 } } },
        } as Parameters<NonNullable<typeof input.onActivity>>[0]);
        clock = 700;
        input.onActivity?.({ type: "tool_execution_start", toolName: "bash" });
        clock = 1700;
        input.onActivity?.({ type: "tool_execution_end", toolName: "bash" });
        clock = 1800;
        input.onActivity?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", partial: { usage: { output: 30 } } },
        } as Parameters<NonNullable<typeof input.onActivity>>[0]);
        clock = 2300;
        input.onActivity?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", partial: { usage: { output: 40 } } },
        } as Parameters<NonNullable<typeof input.onActivity>>[0]);
        return { status: "completed", result: "ok", sideEffects: false, appliedReasoning: "medium" };
      },
    };
    await runAgentInstance({
      roleId: "developer",
      task: "stream clock",
      cwd: packageRoot(),
      executor,
      load: load(),
      now: () => clock,
      onObserve(snap) {
        if (snap.streamMs !== undefined) lastStreamMs = snap.streamMs;
        if (snap.outputTokens === 40) {
          // 100→600 (500) + freeze at 700 (+100 more = 600 total before tool) + 1800→2300 (500) = 1100
          expect(snap.streamMs).toBe(1100);
          expect(snap.outputTokens).toBe(40);
        }
      },
    });
    expect(lastStreamMs).toBe(1100);
  });

  test("cursor-native hold freezes stream clock and publishes activeTool", async () => {
    let clock = 0;
    let tick = () => {};
    let holding = false;
    const held: Array<{ activeTool?: string; streamMs?: number; lastKind: string }> = [];
    let finalStreamMs: number | undefined;
    const executor: AttemptExecutor = {
      async start(input) {
        clock = 100;
        input.onActivity?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", partial: { usage: { output: 10 } } },
        } as Parameters<NonNullable<typeof input.onActivity>>[0]);
        clock = 1100;
        input.onActivity?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", partial: { usage: { output: 50 } } },
        } as Parameters<NonNullable<typeof input.onActivity>>[0]);
        // Open stream for 1000ms so far. Hold appears via probe, not tool_start.
        holding = true;
        input.bindActivityProbe?.(() => (holding ? { name: "cursor-native" } : undefined));
        clock = 1200;
        tick();
        clock = 3200; // 2s held — must not join streamMs
        tick();
        holding = false;
        clock = 3300;
        tick();
        input.bindActivityProbe?.(undefined);
        clock = 3400;
        input.onActivity?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", partial: { usage: { output: 60 } } },
        } as Parameters<NonNullable<typeof input.onActivity>>[0]);
        clock = 3900;
        input.onActivity?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", partial: { usage: { output: 80 } } },
        } as Parameters<NonNullable<typeof input.onActivity>>[0]);
        return { status: "completed", result: "ok", sideEffects: false, appliedReasoning: "medium" };
      },
    };
    await runAgentInstance({
      roleId: "developer",
      task: "hold clock",
      cwd: packageRoot(),
      executor,
      load: load(),
      now: () => clock,
      schedule: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      onObserve(snap) {
        if (snap.activeTool?.name === "cursor-native") {
          held.push({
            activeTool: snap.activeTool.name,
            streamMs: snap.streamMs,
            lastKind: snap.lastActivityKind,
          });
        }
        if (snap.outputTokens === 80) finalStreamMs = snap.streamMs;
      },
    });
    expect(held.length).toBeGreaterThan(0);
    expect(held[0]?.activeTool).toBe("cursor-native");
    // Hold must not call noteActivity — last kind stays model_stream, not tool_start.
    expect(held.every((h) => h.lastKind === "model_stream")).toBe(true);
    // 100→1200 freeze at hold (1100) + 3400→3900 (500) = 1600; held 1200→3300 excluded.
    expect(finalStreamMs).toBe(1600);
  });
});
