import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  completeTool,
  emptyCodeIntelligenceUsage,
  formatCodeIntelligenceUsage,
  mergeCodeIntelligenceUsage,
  type DenseCallUsage,
} from "../extensions/code-intelligence/metrics.ts";
import { codeIntelligenceDelta } from "../extensions/code-intelligence/metrics.ts";
import { mergeUsage, usageDelta, type AgentUsage } from "../extensions/agent/run.ts";
import { clearObservations, publishObservation } from "../extensions/agent/observe.ts";
import type { AgentUiSnapshot } from "../extensions/agent/ui.ts";
import pitako from "../extensions/index.ts";

const denseCall: DenseCallUsage = {
  tool: "project_report",
  durationMs: 7,
  outputBytes: 123,
  truncated: true,
  outcome: "partial",
  sources: { ast: { calls: 2, durationMs: 5 }, git: { calls: 3, durationMs: 9 } },
  graph: { state: "complete", states: { complete: 1 }, buildDurations: { "42": 11 }, failures: 1 },
};
const statsCall: DenseCallUsage = {
  ...denseCall,
  tool: "inspect_symbol",
  durationMs: 40,
  sources: { ast: { calls: 2, durationMs: 5 }, lsp: { calls: 2, durationMs: 2 }, graph: { calls: 1, durationMs: 11 }, rg: { calls: 1, durationMs: 3 }, git: { calls: 3, durationMs: 9 } },
  graph: { state: "unavailable", states: { unavailable: 1 }, buildDurations: { "42": 11 }, failures: 1 },
};

afterEach(() => clearObservations());

test("tool windows and usage merge/delta retain one call's telemetry", () => {
  const before = emptyCodeIntelligenceUsage();
  const after = structuredClone(before);
  const navigation = { remaining: 0 };
  completeTool(after, denseCall.tool, denseCall, navigation);
  for (const name of ["read", "grep", "read", "bash", "read"]) completeTool(after, name, undefined, navigation);

  expect(after.dense.project_report).toMatchObject({ calls: 1, durationMs: 7, outputBytes: 123, truncated: 1, outcomes: { partial: 1 } });
  expect(after.sources).toMatchObject({ ast: { calls: 2, durationMs: 5 }, git: { calls: 3, durationMs: 9 } });
  expect(after.graph).toMatchObject({ state: "complete", states: { complete: 1 }, buildDurations: { "42": 11 }, failures: 1 });
  expect(after.raw).toEqual({ read: 3, grep: 1 });
  expect(after.navigation).toMatchObject({ samples: 1, completedCalls: 5, read: 3, grep: 1, remaining: 0 });

  const delta = codeIntelligenceDelta(before, after)!;
  expect(delta.dense.project_report).toEqual(after.dense.project_report);
  const first: AgentUsage = { input: 1, output: 2, total: 3, codeIntelligence: delta };
  const secondMetrics = emptyCodeIntelligenceUsage();
  completeTool(secondMetrics, "project_report", { ...denseCall, outputBytes: 20, graph: { failures: 0 } }, { remaining: 0 });
  const second: AgentUsage = { input: 4, output: 5, total: 9, codeIntelligence: secondMetrics };
  const merged = mergeUsage(first, second)!;
  expect(merged.codeIntelligence?.dense.project_report).toMatchObject({ calls: 2, durationMs: 14, outputBytes: 143, truncated: 2 });
  expect(merged.codeIntelligence?.graph.buildDurations).toEqual({ "42": 11 });
  expect(usageDelta({ input: 1, output: 1, total: 2 }, { input: 3, output: 2, total: 5, codeIntelligence: after })?.codeIntelligence?.raw).toEqual(after.raw);
});

test("unattributed graph failures count failed query attempts, not distinct causes", () => {
  const left = emptyCodeIntelligenceUsage();
  const right = emptyCodeIntelligenceUsage();
  completeTool(left, denseCall.tool, { ...denseCall, graph: { state: "unavailable", states: { unavailable: 1 }, failures: 1 } }, { remaining: 0 });
  completeTool(right, denseCall.tool, { ...denseCall, graph: { state: "unavailable", states: { unavailable: 1 }, failures: 1 } }, { remaining: 0 });

  const merged = mergeCodeIntelligenceUsage(left, right)!;
  expect(merged.graph.failures).toBe(2);
  expect(merged.graph.buildFailures).toEqual({});
  expect(formatCodeIntelligenceUsage(merged)).toContain("query_failures=2");
});

test("usage merge deduplicates build failures and labels post-dense windows", () => {
  const first = emptyCodeIntelligenceUsage();
  const second = emptyCodeIntelligenceUsage();
  const failure = { ...denseCall, graph: { state: "unavailable", states: { unavailable: 1 }, buildDurations: { "7": 9 }, buildFailures: { "7": 1 }, failures: 1 } };
  const firstWindow = { remaining: 0 };
  completeTool(first, failure.tool, failure, firstWindow);
  for (const name of ["read", "grep", "read", "grep"]) completeTool(first, name, undefined, firstWindow);
  const secondWindow = { remaining: 0 };
  completeTool(second, failure.tool, failure, secondWindow);
  for (const name of ["read", "grep", "read"]) completeTool(second, name, undefined, secondWindow);

  const merged = mergeCodeIntelligenceUsage(first, second)!;
  expect(merged.graph.failures).toBe(1);
  expect(merged.graph.buildDurations).toEqual({ "7": 9 });
  expect(merged.navigation).toMatchObject({ samples: 2, completedCalls: 7, read: 4, grep: 3, remaining: 2, abandoned: 0 });
  expect(formatCodeIntelligenceUsage(merged)).toContain("windows=2, completed=7, read=4, grep=3, pending_latest=2, abandoned=0");
  expect(formatCodeIntelligenceUsage(merged)).not.toContain("completed=7/10");
});

test("a dense reset reports abandoned post-dense slots separately", () => {
  const usage = emptyCodeIntelligenceUsage();
  const navigation = { remaining: 0 };
  completeTool(usage, denseCall.tool, denseCall, navigation);
  completeTool(usage, "module_report", denseCall, navigation);

  expect(usage.navigation).toMatchObject({ samples: 2, completedCalls: 1, remaining: 5, abandoned: 4 });
  expect(formatCodeIntelligenceUsage(usage)).toContain("windows=2, completed=1, read=0, grep=0, pending_latest=5, abandoned=4");
  expect(formatCodeIntelligenceUsage(usage)).not.toContain("completed=1/10");
});

test("missing dense result details remain unknown in foreground stats", async () => {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const notifications: string[] = [];
  const tools = ["read", "grep", "bash", "edit", "write", "find", "ls", "inspect_symbol"];
  const pi = {
    registerFlag() {},
    registerTool() {},
    getFlag() { return undefined; },
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerCommand(name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, definition.handler); },
    getActiveTools() { return tools; },
    getAllTools() { return tools.map((name) => ({ name })); },
    setActiveTools() {},
    getSessionName() { return undefined; },
    setSessionName() {},
    sendMessage() {},
  };
  const sessionId = "t6-missing-details";
  const context = {
    hasUI: true,
    ui: { notify(message: string) { notifications.push(message); }, setStatus() {} },
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
  };
  pitako(pi as unknown as ExtensionAPI);
  await handlers.get("session_start")?.({}, context);
  await handlers.get("tool_call")?.({ toolCallId: "missing", toolName: "inspect_symbol", input: {} }, context);
  await handlers.get("tool_result")?.({ toolCallId: "missing", toolName: "inspect_symbol", input: {}, isError: false, content: [{ type: "text", text: "{}" }] }, context);
  await commands.get("pitako")?.("stats", context);

  expect(notifications.at(-1)).toContain("sources: ast=unknown");
  expect(notifications.at(-1)).toContain("query_failures=unknown");
  expect(notifications.at(-1)).not.toContain("graph=0/0ms");
  await handlers.get("session_shutdown")?.({}, context);
});

test("/pitako stats reads foreground events and reports role and instance usage", async () => {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const notifications: string[] = [];
  const sessionId = "t4-stats-session";
  const entries = [{ type: "message", message: { role: "assistant", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } } } }];
  const pi = {
    registerFlag() {},
    registerTool() {},
    getFlag() { return undefined; },
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerCommand(name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, definition.handler); },
    getActiveTools() { return ["read", "grep", "bash", "edit", "write"]; },
    getAllTools() { return ["read", "grep", "bash", "edit", "write", "find", "ls"].map((name) => ({ name })); },
    setActiveTools() {},
    getSessionName() { return undefined; },
    setSessionName() {},
  };
  const context = {
    hasUI: true,
    ui: { notify(message: string) { notifications.push(message); }, setStatus() {} },
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
  };
  pitako(pi as unknown as ExtensionAPI);
  await handlers.get("session_start")?.({}, context);
  await handlers.get("tool_call")?.({ toolCallId: "dense-1", toolName: "inspect_symbol", input: {} }, context);
  await handlers.get("tool_result")?.({ toolCallId: "dense-1", toolName: "inspect_symbol", input: {}, isError: false, content: [{ type: "text", text: "report" }], details: { codeIntelligence: statsCall } }, context);
  await handlers.get("tool_call")?.({ toolCallId: "read-1", toolName: "read", input: { path: "src.ts" } }, context);
  await handlers.get("tool_result")?.({ toolCallId: "read-1", toolName: "read", input: { path: "src.ts" }, isError: false, content: [{ type: "text", text: "source" }], details: {} }, context);

  const workerUsage: AgentUsage = { input: 3, output: 2, total: 5, codeIntelligence: structuredClone(emptyCodeIntelligenceUsage()) };
  completeTool(workerUsage.codeIntelligence!, denseCall.tool, denseCall, { remaining: 0 });
  const worker = {
    id: "developer-t4-stats",
    roleId: "developer",
    status: "running",
    phase: "working",
    task: "stats fixture",
    acceptedAt: Date.now(),
    selectedModel: "test/model",
    lastActivityKind: "tool_end",
    agentUsage: workerUsage,
  } as AgentUiSnapshot;
  publishObservation(worker);

  await commands.get("pitako")?.("stats", context);
  const sessionStats = notifications.at(-1)!;
  expect(sessionStats).toContain("model usage: input=10, output=4, cached_read=2, cached_write=1, total=17, cost=0.25");
  expect(sessionStats).toContain("inspect_symbol=1 (40ms, 123B, truncated:1, partial:1)");
  expect(sessionStats).toContain("sources: ast=2/5ms");
  expect(sessionStats).toContain("raw navigation: read=1, grep=0");
  expect(sessionStats).toContain("role developer:");
  expect(sessionStats).toContain("instance developer-t4-stats");

  await commands.get("pitako")?.("stats developer-t4-stats", context);
  expect(notifications.at(-1)).toContain("instance: developer-t4-stats");
  expect(notifications.at(-1)).toContain("project_report=1");
  await handlers.get("session_shutdown")?.({}, context);
  clearObservations();
  await commands.get("pitako")?.("stats", { ...context, sessionManager: { getSessionId: () => undefined, getEntries: () => undefined } });
  expect(notifications.at(-1)).toContain("foreground session: unknown");
  expect(notifications.at(-1)).toContain("model usage: unknown");
  expect(notifications.at(-1)).toContain("code intelligence: unknown (session event identity unavailable)");
});
