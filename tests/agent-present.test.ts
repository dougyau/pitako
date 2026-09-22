import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentInstance from "../extensions/agent/index.ts";
import { formatAgentLive, formatElapsed, summarizeTask } from "../extensions/agent/present.ts";
import { formatAgentResult, runAgentInstance, type AgentInstance, type AttemptExecutor } from "../extensions/agent/run.ts";
import { activityKind } from "../extensions/agent/watchdog.ts";
import { packageRoot } from "../extensions/stack.ts";

function instance(patch: Partial<Omit<AgentInstance, "model">> & { model?: Partial<AgentInstance["model"]> } = {}): AgentInstance {
  return {
    id: "architect-abc123",
    roleId: "architect",
    workspace: "/tmp",
    cwd: "/tmp",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...patch,
    model: {
      policyId: "architect",
      requestedModel: "example/primary",
      selectedModel: "example/primary",
      requestedReasoning: "high",
      ...patch.model,
    },
  };
}

const watchdog = {
  elapsedMs: 90_000,
  lastActivityKind: "prompt",
  inactivityMs: 1_000,
  phase: "working" as const,
};

describe("agent live view", () => {
  test("identity, bounded task, and coarse elapsed", () => {
    expect(summarizeTask("\n\n  review \t the   boundary  \nSECRET-SECOND-LINE")).toBe("review the boundary");
    const long = `${"A".repeat(120)}\nSECRET-SECOND-LINE`;
    expect(summarizeTask(long)).toBe("A".repeat(100));
    expect(summarizeTask(long)).not.toContain("SECRET-SECOND-LINE");
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59_000)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m");
    expect(formatElapsed(3_600_000)).toBe("1h");

    const text = formatAgentLive({
      instance: instance({ status: "created" }),
      task: long,
      watchdog: { ...watchdog, elapsedMs: 4_000, inactivityMs: 0, lastActivityKind: "created" },
    });
    expect(text.startsWith("architect-abc123 starting\n")).toBe(true);
    expect(text).toContain("role: architect");
    expect(text).toContain(`task: ${"A".repeat(100)}`);
    expect(text).not.toContain("A".repeat(101));
    expect(text).not.toContain("SECRET-SECOND-LINE");
    expect(text).toContain("elapsed: 4s");
    expect(text).not.toContain("blocked");
  });

  test("requested model is immediate; active model waits for activation", () => {
    const pending = formatAgentLive({
      instance: instance({
        model: {
          requestedModel: "example/primary",
          selectedModel: "example/fallback-1",
          requestedReasoning: "xhigh",
          fallbackOccurred: true,
          fallbackReason: "auth",
        },
      }),
      task: "review the boundary",
      watchdog,
    });
    expect(pending).toContain("requested model: example/primary");
    expect(pending).toContain("activation pending");
    expect(pending).toContain("reasoning requested: xhigh");
    expect(pending).toContain("reasoning applied: unknown");
    expect(pending).not.toContain("active model:");
    expect(pending).not.toContain("example/fallback-1");
    expect(pending).toContain("fallback: auth from example/primary");

    const active = formatAgentLive({
      instance: instance({
        model: {
          requestedModel: "example/primary",
          selectedModel: "example/fallback-1",
          requestedReasoning: "xhigh",
          appliedReasoning: "xhigh",
          fallbackOccurred: true,
          fallbackReason: "auth",
        },
      }),
      task: "review the boundary",
      watchdog,
    });
    expect(active).toContain("active model: example/fallback-1");
    expect(active).toContain("reasoning applied: xhigh");
    expect(active).not.toContain("activation pending");
    expect(active).not.toContain("active model: example/primary");
  });

  test("fallback stays hidden until it occurred, including an unused configured target", () => {
    const hidden = formatAgentLive({
      instance: instance({
        model: {
          requestedModel: "example/primary",
          selectedModel: "example/primary",
          requestedReasoning: "high",
          lastFailure: "rate_limit",
        },
      }),
      task: "review the boundary",
      watchdog,
    });
    expect(hidden).not.toContain("fallback:");
    expect(hidden).not.toContain("example/unused");
    expect(hidden).not.toContain("rate_limit");
  });

  test("tool name beats tool_progress; cache warming is not activity", () => {
    expect(activityKind({ type: "cache_warming_decision" })).toBeUndefined();
    const text = formatAgentLive({
      instance: instance(),
      task: "review the boundary",
      watchdog: { ...watchdog, lastActivityKind: "tool_progress", activeTool: "bash", inactivityMs: 45_000 },
    });
    expect(text).toContain("activity: bash");
    expect(text).not.toContain("tool_progress");
    expect(text).not.toContain("cache");
    expect(text).toContain("watchdog: working, inactive 45s, tool bash");
  });

  test("status is derived, not guessed from elapsed time", () => {
    const cases = [
      { status: "created" as const, phase: "working" as const, label: "starting" },
      { status: "running" as const, phase: "working" as const, label: "working" },
      { status: "running" as const, phase: "suspected_stall" as const, label: "suspected_stall" },
      { status: "running" as const, phase: "stalled" as const, label: "stalled" },
      { status: "failed" as const, phase: "stalled" as const, label: "stalled" },
      { status: "completed" as const, phase: "working" as const, label: "completed" },
      { status: "failed" as const, phase: "working" as const, label: "failed" },
      { status: "cancelled" as const, phase: "working" as const, label: "cancelled" },
    ];
    for (const item of cases) {
      const text = formatAgentLive({
        instance: instance({ status: item.status }),
        task: "review the boundary",
        watchdog: { ...watchdog, elapsedMs: 50 * 60_000, phase: item.phase },
        error: item.label === "failed" ? "provider said no" : undefined,
      });
      expect(text.startsWith(`architect-abc123 ${item.label}\n`)).toBe(true);
      expect(text).not.toContain("blocked");
    }
    const failed = formatAgentLive({
      instance: instance({ status: "failed" }),
      task: "review the boundary",
      watchdog,
      error: `sk-${"a".repeat(32)} ${"p".repeat(180)}PAYLOAD-TAIL`,
    });
    expect(failed).toContain("error: [redacted]");
    expect(failed).not.toContain(`sk-${"a".repeat(32)}`);
    expect(failed).not.toContain("PAYLOAD-TAIL");
    expect(failed).not.toContain("turns:");
    const child = "The child concluded the boundary holds.";
    const counted = formatAgentLive({
      instance: instance({ status: "completed", model: { appliedReasoning: "high" } }),
      task: "review the boundary",
      watchdog,
      usage: { input: 3, output: 1, cacheRead: 9, cacheWrite: 2, cost: 0.01, turns: 2, toolCalls: 4 },
    });
    expect(counted).toContain("input:");
    expect(counted).toContain("output:");
    expect(counted).toContain("cached read:");
    expect(counted).toContain("cached write:");
    expect(counted).toContain("cost:");
    expect(counted).toContain("turns: 2");
    expect(counted).toContain("tools: 4");
    expect(counted).toContain("tool calls: 4");
    expect(counted).not.toContain(child);
    const working = formatAgentLive({
      instance: instance(),
      task: "review the boundary",
      watchdog,
      usage: { input: 3, output: 1, turns: 1, toolCalls: 1 },
    });
    expect(working).not.toContain("input:");
    const stalled = formatAgentLive({
      instance: instance({ status: "running" }),
      task: "review the boundary",
      watchdog: { ...watchdog, phase: "stalled" },
      usage: { input: 8, output: 1 },
    });
    expect(stalled).toContain("input:");
    expect(stalled).not.toContain(child);
  });

  test("schema stays role and task, and renderResult keeps the compact view", () => {
    const tools = new Map<string, {
      parameters: { properties: Record<string, unknown>; additionalProperties?: boolean };
      renderCall: Function;
      renderResult: Function;
    }>();
    agentInstance({
      registerTool(def: { name: string }) {
        tools.set(def.name, def as never);
      },
    } as unknown as ExtensionAPI);
    const tool = tools.get("agent_run");
    if (!tool) throw new Error("agent_run missing");
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["role", "task"]);
    expect(tool.parameters.additionalProperties).toBe(false);
    const theme = {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    };
    const call = tool.renderCall({ role: "researcher", task: "FULL-TASK-BODY" }, theme, {}).render(80).join("\n");
    expect(call).toContain("agent_run");
    expect(call).toContain("researcher");
    expect(call).not.toContain("FULL-TASK-BODY");
    const live = ["architect-abc123 working", "role: architect", "task: review", ...Array.from({ length: 12 }, (_, i) => `line ${i}`)].join("\n");
    const collapsed = tool.renderResult(
      { content: [{ type: "text", text: `CHILD-TRANSCRIPT\n${"x".repeat(400)}` }], details: { live } },
      { expanded: false, isPartial: true },
      theme,
      {},
    ).render(80);
    expect(collapsed.join("\n")).toContain("architect-abc123 working");
    expect(collapsed.join("\n")).toContain("line 11");
    expect(collapsed.join("\n")).not.toContain("CHILD-TRANSCRIPT");
  });
});

describe("agent live updates", () => {
  test("presents material states and hides unused fallback, cache warming, and the child result", async () => {
    const envDir = mkdtempSync(path.join(tmpdir(), "pitako-present-"));
    const userConfigPath = path.join(envDir, "config.toml");
    writeFileSync(userConfigPath, `
[roles.architect]
model_policy = "architect"

[model_policies.architect]
primary = { model = "example/primary", reasoning = "high" }
fallbacks = [
  { model = "example/fallback-1", reasoning = "xhigh" },
  { model = "example/unused", reasoning = "low" },
]
`);
    const texts: string[] = [];
    const executor: AttemptExecutor = {
      async start(input) {
        input.onActivity?.({ type: "cache_warming_decision" });
        input.onActivity?.({ type: "tool_execution_start", toolName: "bash" });
        input.onActivity?.({ type: "tool_execution_update", toolName: "bash" });
        if (input.target.model === "example/primary") {
          return { status: "failed", result: "", error: "429 rate limit", sideEffects: false };
        }
        const pending = texts.at(-1) ?? "";
        expect(pending).toContain("activation pending");
        expect(pending).toContain("fallback: rate_limit from example/primary");
        expect(pending).not.toContain("example/fallback-1");
        expect(pending).not.toContain("example/unused");
        input.onActivated?.("xhigh");
        return {
          status: "completed",
          result: `CHILD-TRANSCRIPT ${"z".repeat(200)}`,
          sideEffects: false,
          usage: { input: 3, output: 1, turns: 2, toolCalls: 1 },
          appliedReasoning: "xhigh",
        };
      },
    };
    const result = await runAgentInstance({
      roleId: "architect",
      task: `${"A".repeat(120)}\nSECRET-SECOND-LINE`,
      cwd: packageRoot(),
      executor,
      load: { userConfigPath, packageRoot: packageRoot() },
      onPresent(text) {
        texts.push(text);
      },
    });
    expect(texts[0]).toContain(" starting");
    expect(texts[0]).toContain("requested model: example/primary");
    expect(texts.some((text) => text.includes(" working"))).toBe(true);
    expect(texts.some((text) => text.includes("activity: bash"))).toBe(true);
    expect(texts.some((text) => text.includes("active model: example/fallback-1"))).toBe(true);
    expect(texts.some((text) => text.includes(" completed"))).toBe(true);
    expect(texts.some((text) => text.includes("turns: 2"))).toBe(true);
    expect(texts.join("\n")).not.toContain("cache");
    expect(texts.join("\n")).not.toContain("example/unused");
    expect(texts.join("\n")).not.toContain("SECRET-SECOND-LINE");
    expect(texts.join("\n")).not.toContain("CHILD-TRANSCRIPT");
    expect(texts.join("\n")).not.toContain("A".repeat(120));
    expect(result.result).toContain("CHILD-TRANSCRIPT");
    expect(formatAgentResult(result)).toContain("fallback: rate_limit from example/primary");
    expect(formatAgentResult(result)).toContain(result.result);
  });

  test("watchdog phase changes present, and a throwing callback does not change the stall", async () => {
    let clock = 0;
    let tick = () => {};
    const texts: string[] = [];
    const executor: AttemptExecutor = {
      async start(input) {
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "cancelled", result: "cancelled", sideEffects: false };
      },
    };
    const envDir = mkdtempSync(path.join(tmpdir(), "pitako-present-stall-"));
    const userConfigPath = path.join(envDir, "config.toml");
    writeFileSync(userConfigPath, `
[roles.architect]
model_policy = "architect"

[model_policies.architect]
primary = { model = "example/primary", reasoning = "high" }
`);
    const pending = runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      executor,
      load: { userConfigPath, packageRoot: packageRoot() },
      now: () => clock,
      schedule: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      watchdog: { idleTimeoutMs: 1_000, toolStallTimeoutMs: 5_000, maxRunTimeMs: 0 },
      onPresent(text) {
        texts.push(text);
        if (text.includes("suspected_stall")) throw new Error("ui down");
      },
    });
    clock = 1_000;
    tick();
    clock = 1_000 + 15_000;
    tick();
    const result = await pending;
    expect(texts.some((text) => text.includes(" suspected_stall"))).toBe(true);
    expect(texts.some((text) => text.includes(" stalled"))).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.result).toContain("stalled");
    expect(result.model.fallbackOccurred).toBeFalsy();
  });
});
