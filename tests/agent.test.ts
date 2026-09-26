import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentInstance from "../extensions/agent/index.ts";
import { currentInstanceId, agentScope } from "../extensions/agent/scope.ts";
import { marksSideEffect, toolEffect } from "../extensions/agent/effects.ts";
import { classifyProviderFailure } from "../extensions/agent/fallback.ts";
import { activateTarget, thinkingLevelFor } from "../extensions/agent/pi.ts";
import { childInstructions, formatAgentResult, runAgentInstance, skillNamesForRole, teamExecutionSummary, usageDelta, type AgentRunResult, type Attempt, type AttemptExecutor } from "../extensions/agent/run.ts";
import { childSessionNote } from "../extensions/profile.ts";
import { registerExecution, resolveBoardAuthor, unregisterExecution } from "../extensions/execution-identity.ts";
import { childActiveTools } from "../extensions/profile.ts";
import boardExtension from "../extensions/board/index.ts";
import { openBoard } from "../extensions/board/store.ts";
import { currentWorkspace, repositoryIdentity } from "../extensions/board/workspace.ts";
import pitako from "../extensions/index.ts";
import { resolveRole } from "../extensions/roles/load.ts";
import { packageRoot } from "../extensions/stack.ts";
import { loadPitako, registeredToolNames } from "../scripts/load-pitako.ts";
import { completeTool, emptyCodeIntelligenceUsage } from "../extensions/code-intelligence/metrics.ts";
import type { DenseCallUsage } from "../extensions/code-intelligence/metrics.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envFor(dir: string): NodeJS.ProcessEnv {
  return { PI_CODING_AGENT_DIR: dir };
}

function tempEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-agent-"));
  tempDirs.push(dir);
  return envFor(dir);
}

function scripted(attempts: Attempt[]): AttemptExecutor & { starts: string[]; notes: string[] } {
  const starts: string[] = [];
  const notes: string[] = [];
  return {
    starts,
    notes,
    async start(input) {
      starts.push(input.target.model);
      expect(input.task).toBe("review the boundary");
      expect(input.task).not.toContain("PARENT-TRANSCRIPT");
      const attempt = attempts.shift() ?? { status: "failed", result: "", error: "exhausted", sideEffects: false };
      return {
        ...attempt,
        session: attempt.session ?? {
          async continueWith(target, note) {
            notes.push(`${target.model}:${note}`);
            return attempts.shift() ?? { status: "failed", result: "", error: "no continue", sideEffects: true };
          },
          async dispose() {},
        },
      };
    },
  };
}

describe("agent instance", () => {
  test("execution summary distinguishes unavailable values from reported zero", () => {
    const result: AgentRunResult = {
      instanceId: "developer-summary", role: "developer", status: "completed", model: { selectedModel: "local/model" }, result: "done",
      watchdog: { elapsedMs: 10, lastActivityKind: "turn", inactivityMs: 0, phase: "working" },
    };
    const unpriced = teamExecutionSummary("unpriced-assignment", { ...result, usage: { input: 5, output: 2, cost: 0 } });
    expect(unpriced).toMatchObject({
      assignmentId: "unpriced-assignment", selectedModel: "local/model", provider: "local", appliedReasoning: "unknown",
      elapsedMs: 10, input: 5, output: 2, cacheRead: null, cacheWrite: null, turns: null, toolCalls: null, tools: null,
      contextTokens: null, estimatedCost: null,
    });
    const zeros = teamExecutionSummary("zero-assignment", { ...result, usage: { input: 0, output: 0, cost: 0, turns: 0, toolCalls: 0, tools: {} } });
    expect(zeros).toMatchObject({ input: 0, output: 0, estimatedCost: 0, turns: 0, toolCalls: 0, tools: {} });
  });

  test("usage adds failed attempts and cancel keeps the last attempted target", async () => {
    const env = tempEnv();
    const configured = { env, userConfigPath: path.join(env.PI_CODING_AGENT_DIR!, "pitako", "config.toml") };
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.dirname(configured.userConfigPath), { recursive: true });
    writeFileSync(configured.userConfigPath, `[model_policies.architect.primary]\nmodel = "example/primary"\nreasoning = "high"\n[[model_policies.architect.fallbacks]]\nmodel = "example/fallback-1"\nreasoning = "xhigh"\n`);
    const failedMetrics = emptyCodeIntelligenceUsage();
    const failedNavigation = { remaining: 0 };
    const failedCall: DenseCallUsage = { tool: "project_report", durationMs: 10, outputBytes: 100, truncated: true, outcome: "partial", sources: { ast: { calls: 2, durationMs: 5 } }, graph: { states: { complete: 1 }, buildDurations: { "41": 8 }, failures: 1 } };
    completeTool(failedMetrics, "project_report", failedCall, failedNavigation);
    completeTool(failedMetrics, "read", undefined, failedNavigation);
    const completedMetrics = emptyCodeIntelligenceUsage();
    const completedNavigation = { remaining: 0 };
    const completedCall: DenseCallUsage = { tool: "read_symbol", durationMs: 20, outputBytes: 200, truncated: false, outcome: "ok", sources: { ast: { calls: 1, durationMs: 7 } }, graph: { states: { complete: 1 }, buildDurations: { "42": 12 }, failures: 0 } };
    completeTool(completedMetrics, "read_symbol", completedCall, completedNavigation);
    completeTool(completedMetrics, "grep", undefined, completedNavigation);
    const executor = scripted([
      { status: "failed", result: "", error: "429 rate limit", sideEffects: false, usage: { input: 10, output: 1, cacheRead: 4, cacheWrite: 2, cost: 0.2, turns: 1, toolCalls: 1, codeIntelligence: failedMetrics } },
      { status: "completed", result: "ok", sideEffects: false, usage: { input: 20, output: 3, cacheRead: 5, cacheWrite: 1, cost: 0.3, turns: 2, toolCalls: 2, codeIntelligence: completedMetrics } },
    ]);
    const summed = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      executor,
      load: configured,
    });
    expect(summed.usage).toMatchObject({ input: 30, output: 4, cacheRead: 9, cacheWrite: 3, cost: 0.5, turns: 3, toolCalls: 3 });
    expect(summed.usage?.codeIntelligence?.dense).toMatchObject({ project_report: { calls: 1, outputBytes: 100 }, read_symbol: { calls: 1, outputBytes: 200 } });
    expect(summed.usage?.codeIntelligence?.sources.ast).toEqual({ calls: 3, durationMs: 12 });
    expect(summed.usage?.codeIntelligence?.graph.buildDurations).toEqual({ "41": 8, "42": 12 });
    expect(summed.usage?.codeIntelligence?.raw).toEqual({ read: 1, grep: 1 });
    expect(formatAgentResult(summed)).toContain("cached read: 9");
    expect(formatAgentResult(summed)).toContain("cost: 0.5");
    expect(teamExecutionSummary("fallback-assignment", summed)).toMatchObject({
      assignmentId: "fallback-assignment", selectedModel: "example/fallback-1", provider: "example",
      input: 30, output: 4, cacheRead: 9, cacheWrite: 3, turns: 3, toolCalls: 3, estimatedCost: 0.5,
    });

    const controller = new AbortController();
    const cancelling = {
      async start() {
        controller.abort();
        return { status: "failed" as const, result: "", error: "429 rate limit", sideEffects: false, usage: { input: 7, output: 1 } };
      },
    };
    const cancelled = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      signal: controller.signal,
      executor: cancelling,
      load: configured,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.model.selectedModel).toBe("example/primary");
    expect(cancelled.model.requestedModel).toBe("example/primary");
    expect(cancelled.model.fallbackOccurred).toBeFalsy();
    expect(cancelled.model.fallbackReason).toBeUndefined();
    expect(cancelled.model.lastFailure).toBe("rate_limit");
    expect(formatAgentResult(cancelled)).not.toContain("fallback:");
    expect(cancelled.model.fallbackIndex).toBeUndefined();
    expect(cancelled.usage?.input).toBe(7);

    const leaked = scripted([
      { status: "failed", result: "", error: "429 rate limit", sideEffects: false, appliedReasoning: "high" },
      { status: "failed", result: "", error: "No API key for example/fallback-1", sideEffects: false },
    ]);
    const cleared = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      executor: leaked,
      load: configured,
    });
    expect(cleared.status).toBe("failed");
    expect(cleared.model.selectedModel).toBe("example/fallback-1");
    expect(cleared.model.requestedReasoning).toBe("xhigh");
    expect(cleared.model.appliedReasoning).toBeUndefined();
  });
  test("aggregates mutation calls and compact patch traces from session events", async () => {
    const env = tempEnv();
    const configured = { env, userConfigPath: path.join(env.PI_CODING_AGENT_DIR!, "pitako", "config.toml") };
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.dirname(configured.userConfigPath), { recursive: true });
    writeFileSync(configured.userConfigPath, `[model_policies.architect.primary]\nmodel = "example/primary"\n`);
    const success = {
      ok: true, phase: "complete", errorCode: null, inputBytes: 90, plannedFiles: 1, plannedHunks: 2,
      filesChanged: 1, hunksChanged: 2, committed: ["src/change.ts"], pending: [], uncertain: [], truncated: false, elapsedMs: 17,
    };
    const stale = {
      ok: false, phase: "preflight", errorCode: "PATCH_STALE", inputBytes: 88, plannedFiles: 0, plannedHunks: 0,
      filesChanged: 0, hunksChanged: 0, committed: [], pending: ["src/change.ts"], uncertain: [], truncated: false, elapsedMs: 9,
    };
    const executor: AttemptExecutor = {
      async start({ onActivity }) {
        const call = (toolName: string, details?: unknown, isError = false) => {
          onActivity?.({ type: "tool_execution_start", toolName, args: { patch: "SENSITIVE-PATCH-BODY" } });
          onActivity?.({ type: "tool_execution_end", toolName, result: details ? { details } : {}, isError });
        };
        call("edit");
        call("write");
        call("apply_patch", stale, true);
        call("apply_patch", success);
        return {
          status: "completed", result: "done", sideEffects: true,
          usage: { input: 12, output: 4, turns: 2, toolCalls: 4, tools: { edit: 1, write: 1, apply_patch: 2 } },
        };
      },
    };
    const result = await runAgentInstance({ roleId: "architect", task: "review the boundary", cwd: packageRoot(), executor, load: configured });
    expect(result.usage?.tools).toEqual({ edit: 1, write: 1, apply_patch: 2 });
    expect(result.usage?.patches).toMatchObject([
      { targets: ["src/change.ts"], pending: ["src/change.ts"], changedFiles: 0, changedHunks: 0, inputBytes: 88, status: "failure", phase: "preflight", errorCode: "PATCH_STALE", elapsedMs: 9, retry: false },
      { targets: ["src/change.ts"], committed: ["src/change.ts"], changedFiles: 1, changedHunks: 2, inputBytes: 90, status: "success", phase: "complete", elapsedMs: 17, retry: true },
    ]);
    expect(JSON.stringify(result.usage?.patches)).not.toContain("SENSITIVE-PATCH-BODY");
    expect(formatAgentResult(result)).toContain("mutations: edit 1, write 1, apply_patch 2");
  });
  test("continueWith usage deltas add once and keep context as a gauge", async () => {
    const env = tempEnv();
    const configured = { env, userConfigPath: path.join(env.PI_CODING_AGENT_DIR!, "pitako", "config.toml") };
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.dirname(configured.userConfigPath), { recursive: true });
    writeFileSync(configured.userConfigPath, `[model_policies.architect.primary]\nmodel = "example/primary"\nreasoning = "high"\n[[model_policies.architect.fallbacks]]\nmodel = "example/fallback-1"\nreasoning = "xhigh"\n`);
    let starts = 0;
    let continued = 0;
    const executor: AttemptExecutor = {
      async start() {
        starts += 1;
        return {
          status: "failed", result: "", error: "429 rate limit", sideEffects: true,
          usage: { input: 10, output: 2, cacheRead: 4, cacheWrite: 1, total: 17, cost: 0.1, turns: 1, toolCalls: 1, tools: { read: 1, grep: 1 }, contextTokens: 128 },
          session: {
            async continueWith() {
              continued += 1;
              return {
                status: "completed", result: "continued", sideEffects: true, appliedReasoning: "xhigh",
                usage: { input: 3, output: 1, cacheRead: 2, cacheWrite: 1, total: 7, cost: 0.05, turns: 2, toolCalls: 2, tools: { grep: 2, bash: 1 }, contextTokens: 256 },
              };
            },
            async dispose() {},
          },
        };
      },
    };
    const result = await runAgentInstance({ roleId: "architect", task: "review the boundary", cwd: packageRoot(), executor, load: configured });
    expect(starts).toBe(1);
    expect(continued).toBe(1);
    expect(result.usage).toMatchObject({
      input: 13, output: 3, cacheRead: 6, cacheWrite: 2, total: 24,
      turns: 3, toolCalls: 3, tools: { read: 1, grep: 3, bash: 1 }, contextTokens: 256, codeIntelligence: undefined,
    });
    expect(result.usage?.cost).toBeCloseTo(0.15);
    const summary = teamExecutionSummary("continue-assignment", result);
    expect(summary).toMatchObject({
      assignmentId: "continue-assignment", selectedModel: "example/fallback-1", provider: "example", appliedReasoning: "xhigh",
      input: 13, output: 3, cacheRead: 6, cacheWrite: 2, turns: 3, toolCalls: 3,
      tools: { read: 1, grep: 3, bash: 1 }, contextTokens: 256,
    });
    expect(summary.estimatedCost).toBeCloseTo(0.15);
  });

  test("resolves architect, isolates context, and does not replay side effects", async () => {
    const env = tempEnv();
    const cwd = packageRoot();
    const role = resolveRole("architect", { env });
    expect(role.modelPolicy.primary).toBeUndefined();
    await expect(runAgentInstance({ roleId: "missing", task: "x", cwd, executor: scripted([]), load: { env } })).rejects.toThrow(/unknown role/);
    await expect(runAgentInstance({ roleId: "architect", task: "x", cwd, executor: scripted([]), load: { env } })).rejects.toThrow(/no primary target/);

    const configured = {
      env,
      userConfigPath: path.join(env.PI_CODING_AGENT_DIR!, "pitako", "config.toml"),
    };
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.dirname(configured.userConfigPath), { recursive: true });
    writeFileSync(
      configured.userConfigPath,
      `[model_policies.architect.primary]
model = "example/primary"
reasoning = "high"
[[model_policies.architect.fallbacks]]
model = "example/fallback-1"
reasoning = "xhigh"
[[model_policies.architect.fallbacks]]
model = "example/fallback-2"
reasoning = "medium"
`,
    );
    const resolved = resolveRole("architect", configured);
    expect(resolved.modelPolicy.primary?.model).toBe("example/primary");
    expect(resolved.modelPolicy.fallbacks.map((target) => target.model)).toEqual(["example/fallback-1", "example/fallback-2"]);
    expect(skillNamesForRole(resolved)).toContain("architect");
    expect(skillNamesForRole(resolved)).toContain("ponytail");
    expect(skillNamesForRole(resolved)).not.toContain("tdd");
    const prompt = childInstructions(resolved, "architect-abc123");
    expect(prompt).toContain("You own system structure");
    expect(prompt).not.toContain("PARENT-TRANSCRIPT");

    const rateLimited = scripted([
      { status: "failed", result: "", error: "429 rate limit", sideEffects: false },
      { status: "completed", result: "sketch", sideEffects: false },
    ]);
    const first = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd,
      executor: rateLimited,
      load: configured,
    });
    expect(first.status).toBe("completed");
    expect(first.model.selectedModel).toBe("example/fallback-1");
    expect(first.model.requestedReasoning).toBe("xhigh");
    expect(first.model.fallbackIndex).toBe(0);
    expect(first.model.fallbackReason).toBe("rate_limit");
    expect(rateLimited.starts).toEqual(["example/primary", "example/fallback-1"]);
    expect(first.instanceId.startsWith("architect-")).toBe(true);
    expect(first.instanceId).not.toBe("architect");
    expect(currentWorkspace(cwd)).toBe(currentWorkspace(first.instanceId ? cwd : cwd));

    const replay = scripted([
      {
        status: "failed",
        result: "",
        error: "503 Service Unavailable",
        sideEffects: true,
        session: {
          async continueWith(target, note) {
            replay.notes.push(note);
            expect(target.model).toBe("example/fallback-1");
            return { status: "completed", result: "continued", sideEffects: true };
          },
          async dispose() {},
        },
      },
    ]);
    const continued = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd,
      executor: replay,
      load: configured,
    });
    expect(continued.result).toBe("continued");
    expect(replay.starts).toEqual(["example/primary"]);
    expect(replay.notes[0]).toContain("Do not repeat completed side effects");

    const taskFailure = scripted([{ status: "failed", result: "", error: "tests failed in the repository", sideEffects: true }]);
    const stayed = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd,
      executor: taskFailure,
      load: configured,
    });
    expect(stayed.status).toBe("failed");
    expect(taskFailure.starts).toEqual(["example/primary"]);

    const controller = new AbortController();
    const cancelled = scripted([
      {
        status: "cancelled",
        result: "cancelled",
        sideEffects: false,
      },
    ]);
    controller.abort();
    const aborted = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd,
      signal: controller.signal,
      executor: cancelled,
      load: configured,
    });
    expect(aborted.status).toBe("cancelled");
    expect(cancelled.starts).toEqual([]);

    const activation = scripted([]);
    activation.start = async (input) => {
      activation.starts.push(input.target.model);
      if (input.target.model === "example/primary") throw new Error("No API key for example/primary");
      if (input.target.model === "example/fallback-1") throw new Error("No API key for example/fallback-1");
      return { status: "completed", result: "third target", sideEffects: false };
    };
    const activated = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd,
      executor: activation,
      load: configured,
    });
    expect(activated.status).toBe("completed");
    expect(activated.result).toBe("third target");
    expect(activation.starts).toEqual(["example/primary", "example/fallback-1", "example/fallback-2"]);

    const unknownActivation = scripted([]);
    unknownActivation.start = async () => {
      throw new Error("disk on fire");
    };
    const stopped = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd,
      executor: unknownActivation,
      load: configured,
    });
    expect(stopped.status).toBe("failed");
    expect(stopped.result).toContain("disk on fire");

    const switched = scripted([
      {
        status: "failed",
        result: "",
        error: "429 rate limit",
        sideEffects: true,
        session: {
          async continueWith(target, note) {
            switched.notes.push(`${target.model}:${note}`);
            if (target.model === "example/fallback-1") throw new Error("No API key for example/fallback-1");
            expect(note).not.toBe("review the boundary");
            return { status: "completed", result: "same session", sideEffects: true };
          },
          async dispose() {},
        },
      },
    ]);
    const afterSwitch = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd,
      executor: switched,
      load: configured,
    });
    expect(afterSwitch.status).toBe("completed");
    expect(afterSwitch.model.selectedModel).toBe("example/fallback-2");
    expect(switched.starts).toEqual(["example/primary"]);
    expect(switched.notes.some((note) => note.startsWith("example/fallback-2:"))).toBe(true);
  });

  test("service-tier rejections do not enter availability fallback without a failure kind", async () => {
    const env = tempEnv();
    const configPath = path.join(env.PI_CODING_AGENT_DIR!, "pitako", "config.toml");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      `[model_policies.developer.primary]\nmodel = "example/primary"\n[[model_policies.developer.fallbacks]]\nmodel = "example/fallback"\n`,
    );
    const request = {
      model: "example/primary",
      fast_requested: true,
      requested_service_tier: "priority" as const,
      returned_service_tier: "unavailable" as const,
      time_to_first_model_output_ms: "unavailable" as const,
      time_to_first_model_output_unavailable_reason: "failed" as const,
    };
    const executor = scripted([
      { status: "failed", result: "", error: "503 service unavailable: unsupported service_tier: priority", requests: [request], sideEffects: false },
      { status: "completed", result: "must not run", sideEffects: false },
    ]);
    const result = await runAgentInstance({
      roleId: "developer",
      task: "review the boundary",
      cwd: packageRoot(),
      executor,
      load: { env, userConfigPath: configPath },
    });
    expect(result.status).toBe("failed");
    expect(result.result).toContain("unsupported service_tier");
    expect(executor.starts).toEqual(["example/primary"]);
    expect(result.requests).toEqual([request]);
    const formatted = formatAgentResult(result);
    expect(formatted).toContain("request: example/primary");
    expect(formatted).toContain("fast_requested: true");
    expect(formatted).toContain("requested_service_tier: priority");
    expect(formatted).toContain("returned_service_tier: unavailable");
    expect(formatted).toContain("time_to_first_model_output_ms: unavailable (failed)");
  });

  test("fallback classification is narrow", () => {
    expect(classifyProviderFailure("429 too many requests")).toBe("rate_limit");
    expect(classifyProviderFailure("insufficient_quota")).toBe("quota");
    expect(classifyProviderFailure("Codex error: The usage limit has been reached")).toBe("quota");
    expect(classifyProviderFailure("invalid api key")).toBe("auth");
    expect(classifyProviderFailure("503 service unavailable")).toBe("unavailable");
    expect(classifyProviderFailure("tests failed")).toBeUndefined();
    expect(classifyProviderFailure("compilation failed")).toBeUndefined();
    expect(classifyProviderFailure(undefined)).toBeUndefined();
    expect(classifyProviderFailure("No API key for cursor/grok-4.7")).toBe("auth");
    expect(classifyProviderFailure("HTTP 500")).toBe("unavailable");
    expect(classifyProviderFailure("500 Internal Server Error")).toBe("unavailable");
    expect(classifyProviderFailure("status code 503")).toBe("unavailable");
    expect(classifyProviderFailure("502 Bad Gateway")).toBe("unavailable");
    expect(classifyProviderFailure("504 Gateway Timeout")).toBe("unavailable");
    expect(classifyProviderFailure("you requested 500 tokens")).toBeUndefined();
    expect(classifyProviderFailure("processed 503 records")).toBeUndefined();
    expect(classifyProviderFailure("fetch failed")).toBe("unavailable");
    expect(classifyProviderFailure("socket hang up")).toBe("unavailable");
    expect(classifyProviderFailure("ECONNRESET")).toBe("unavailable");
    expect(classifyProviderFailure("AbortError: The operation was aborted")).toBeUndefined();
    expect(toolEffect("read")).toBe("read_only");
    expect(toolEffect("apply_patch")).toBe("mutating");
    expect(marksSideEffect("apply_patch")).toBe(true);
    expect(toolEffect("board_post")).toBe("mutating");
    expect(toolEffect("database_migrate")).toBe("potentially_mutating");
    expect(marksSideEffect("codegraph_search")).toBe(false);
    for (const name of ["project_report", "read_symbol", "read_enclosing", "module_report", "inspect_symbol", "review_surface"]) {
      expect(toolEffect(name)).toBe("read_only");
      expect(marksSideEffect(name)).toBe(false);
    }
    expect(marksSideEffect("deploy")).toBe(true);
    expect(thinkingLevelFor(undefined)).toBeUndefined();
    expect(thinkingLevelFor("high")).toBe("high");
    expect(childSessionNote("architect-1")).not.toContain("whatever the user selected");
    const instructions = childInstructions(resolveRole("architect", { env: tempEnv() }), "architect-1");
    expect(instructions).toContain("ModelPolicy");
    expect(instructions).toContain("Your conversation is private");
    expect(instructions).not.toContain("navigation baseline");
  });

  test("500 status code (no body) is unavailable", () => {
    expect(classifyProviderFailure("500 status code (no body)")).toBe("unavailable");
    expect(classifyProviderFailure("502 status code (no body)")).toBe("unavailable");
    expect(classifyProviderFailure("503 status code (no body)")).toBe("unavailable");
    expect(classifyProviderFailure("504 status code (no body)")).toBe("unavailable");
    expect(classifyProviderFailure("520 status code (no body)")).toBe("unavailable");
    expect(classifyProviderFailure("524 status code (no body)")).toBe("unavailable");
  });

  test("prefix (500): ... is unavailable", () => {
    expect(classifyProviderFailure("prefix (500): ...")).toBe("unavailable");
    expect(classifyProviderFailure("prefix (502): ...")).toBe("unavailable");
    expect(classifyProviderFailure("prefix (503): ...")).toBe("unavailable");
    expect(classifyProviderFailure("prefix (504): ...")).toBe("unavailable");
    expect(classifyProviderFailure("prefix (520): ...")).toBe("unavailable");
    expect(classifyProviderFailure("prefix (524): ...")).toBe("unavailable");
  });

  test("500: body is unavailable", () => {
    expect(classifyProviderFailure("500: body")).toBe("unavailable");
    expect(classifyProviderFailure("502: body")).toBe("unavailable");
    expect(classifyProviderFailure("503: body")).toBe("unavailable");
    expect(classifyProviderFailure("504: body")).toBe("unavailable");
    expect(classifyProviderFailure("520: body")).toBe("unavailable");
    expect(classifyProviderFailure("524: body")).toBe("unavailable");
  });

  test("HTTP/1.1 500 is unavailable", () => {
    expect(classifyProviderFailure("HTTP/1.1 500")).toBe("unavailable");
    expect(classifyProviderFailure("HTTP/1.1 502")).toBe("unavailable");
    expect(classifyProviderFailure("HTTP/1.1 503")).toBe("unavailable");
    expect(classifyProviderFailure("HTTP/1.1 504")).toBe("unavailable");
    expect(classifyProviderFailure("HTTP/1.1 520")).toBe("unavailable");
    expect(classifyProviderFailure("HTTP/1.1 524")).toBe("unavailable");
  });

  test("500 tokens does not classify", () => {
    expect(classifyProviderFailure("500 tokens")).toBeUndefined();
    expect(classifyProviderFailure("see 500")).toBeUndefined();
    expect(classifyProviderFailure("500")).toBeUndefined();
  });

  test("Board author follows the instance and todos stay on the session id", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pitako-agent-board-"));
    tempDirs.push(dir);
    const db = path.join(dir, "board.db");
    const board = await openBoard(db);
    const topic = board.createTopic("/repo", { title: "shared" });
    expect(topic.createdBy).toBe("pi");
    registerExecution({ instanceId: "architect-a31f2c", roleId: "architect", sessionId: "child-a" });
    registerExecution({ instanceId: "reviewer-b", roleId: "reviewer", sessionId: "child-b" });
    expect(resolveBoardAuthor("child-a")).toBe("architect-a31f2c");
    expect(resolveBoardAuthor("child-b")).toBe("reviewer-b");
    expect(resolveBoardAuthor(undefined)).toBe("pi");
    board.post("/repo", { topicId: topic.id, type: "FINDING", content: "from the child" }, resolveBoardAuthor("child-a"));
    unregisterExecution("child-a");
    unregisterExecution("child-b");
    expect(resolveBoardAuthor("child-a")).toBe("pi");
    const page = board.readTopic("/repo", topic.id);
    expect(page.posts[0]?.author).toBe("architect-a31f2c");
    board.close();
    const agent = mkdtempSync(path.join(tmpdir(), "pitako-agent-author-"));
    tempDirs.push(agent);
    const repo = mkdtempSync(path.join(tmpdir(), "pitako-agent-repo-"));
    tempDirs.push(repo);
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    try {
      const tools = new Map<string, { execute: Function }>();
      boardExtension({
        registerTool(def: { name: string; execute: Function }) {
          tools.set(def.name, def);
        },
        registerCommand() {},
      } as never);
      registerExecution({ instanceId: "architect-tool", roleId: "architect", sessionId: "sess-tool" });
      const ctx = { cwd: repo, sessionManager: { getSessionId: () => "sess-tool" } };
      const created = await tools.get("board_topic_create")!.execute("c", { title: "identity" }, undefined, undefined, ctx);
      const topicId = created.details.topicId as number;
      const posted = await tools.get("board_post")!.execute(
        "p",
        { topicId, type: "INFO", content: "tool author", author: "someone-else" },
        undefined,
        undefined,
        ctx,
      );
      expect(posted.isError).toBeFalsy();
      expect(String(posted.content?.[0]?.text ?? "")).not.toContain("someone-else");
      const check = await openBoard(path.join(agent, "pitako", "board.db"));
      const workspace = repositoryIdentity(repo);
      expect(check.readTopic(workspace, topicId).topic.createdBy).toBe("architect-tool");
      expect(check.readTopic(workspace, topicId).posts[0]?.author).toBe("architect-tool");
      check.close();
      unregisterExecution("sess-tool");
      expect(resolveBoardAuthor("sess-tool")).toBe("pi");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
    const names = childActiveTools(["read", "grep", "find", "ls", "bash", "agent_run", "agent_supervise", "board_post", "database_migrate"]);
    expect(names).toContain("grep");
    expect(names).toContain("find");
    expect(names).toContain("ls");
    expect(names).toContain("read");
    expect(names).not.toContain("agent_run");
    expect(names).not.toContain("agent_supervise");
    const unix = childActiveTools(["read", "bash", "powershell", "agent_run"], "linux");
    expect(unix).toContain("bash");
    expect(unix).not.toContain("powershell");
    const windows = childActiveTools(["read", "bash", "powershell", "agent_run"], "win32");
    expect(windows).toContain("powershell");
    expect(windows).not.toContain("agent_run");
    const before = { input: 100, output: 10, cacheRead: 5, cacheWrite: 1, total: 116, cost: 0.1, turns: 2, toolCalls: 3, tools: { grep: 2, edit: 1, write: 1, apply_patch: 2 }, contextTokens: 1000 };
    const after = { input: 300, output: 40, cacheRead: 15, cacheWrite: 1, total: 356, cost: 0.4, turns: 5, toolCalls: 6, tools: { grep: 4, read: 1, edit: 2, write: 3, apply_patch: 5 }, contextTokens: 2000 };
    const delta = usageDelta(before, after);
    expect(delta?.input).toBe(200);
    expect(delta?.cacheRead).toBe(10);
    expect(delta?.turns).toBe(3);
    expect(delta?.cost).toBeCloseTo(0.3);
    expect(delta?.contextTokens).toBe(2000);
    expect(delta?.tools).toEqual({ grep: 2, read: 1, edit: 1, write: 2, apply_patch: 3 });

    const parent = SessionManager.inMemory(packageRoot());
    const child = SessionManager.inMemory(packageRoot());
    expect(parent.getSessionId()).not.toBe(child.getSessionId());
    expect(currentWorkspace(packageRoot())).toBe(currentWorkspace(packageRoot()));
  });

  test("onAccepted publishes instance id before executor start", async () => {
    const env = tempEnv();
    const configured = { env, userConfigPath: path.join(env.PI_CODING_AGENT_DIR!, "pitako", "config.toml") };
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.dirname(configured.userConfigPath), { recursive: true });
    writeFileSync(configured.userConfigPath, `[model_policies.architect.primary]\nmodel = "example/primary"\nreasoning = "high"\n`);
    let acceptedId: string | undefined;
    let started = false;
    const controller = new AbortController();
    const executor: AttemptExecutor = {
      async start(input) {
        started = true;
        controller.abort();
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) {
            resolve();
            return;
          }
          input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "cancelled", result: "cancelled", sideEffects: false };
      },
    };
    const pending = runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd: packageRoot(),
      executor,
      load: configured,
      signal: controller.signal,
      onAccepted(instance) {
        expect(started).toBe(false);
        acceptedId = instance.id;
        expect(instance.roleId).toBe("architect");
        expect(instance.status).toBe("created");
      },
    });
    expect(acceptedId).toMatch(/^architect-/);
    expect(started).toBe(false);
    await pending;
  });

  test("throwing onAccepted rejects without starting executor or watchdog", async () => {
    const env = tempEnv();
    const configured = { env, userConfigPath: path.join(env.PI_CODING_AGENT_DIR!, "pitako", "config.toml") };
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.dirname(configured.userConfigPath), { recursive: true });
    writeFileSync(configured.userConfigPath, `[model_policies.architect.primary]\nmodel = "example/primary"\nreasoning = "high"\n`);
    let scheduled = false;
    let started = false;
    const executor: AttemptExecutor = {
      async start() {
        started = true;
        return { status: "completed", result: "never", sideEffects: false };
      },
    };
    await expect(
      runAgentInstance({
        roleId: "architect",
        task: "review the boundary",
        cwd: packageRoot(),
        executor,
        load: configured,
        onAccepted() {
          throw new Error("accept failed");
        },
        schedule: () => {
          scheduled = true;
          return { unref() {} };
        },
      }),
    ).rejects.toThrow("accept failed");
    expect(started).toBe(false);
    expect(scheduled).toBe(false);
  });

  test("agent_run is registered, refused inside an instance, and Pitako still loads", async () => {
    const loaded = await loadPitako(packageRoot());
    expect(registeredToolNames(loaded.extensions)).toEqual(expect.arrayContaining([
      "agent_run", "team_assign", "team_status", "team_result", "team_cancel",
    ]));
    expect(registeredToolNames(loaded.extensions)).toContain("board_post");
    expect(registeredToolNames(loaded.extensions)).toContain("todo");

    const tools = new Map<string, { execute: Function }>();
    const active: string[] = [];
    const pi = {
      registerTool(def: { name: string; execute: Function }) {
        tools.set(def.name, def);
      },
      registerFlag() {},
      getFlag() {
        return undefined;
      },
      on(event: string, handler: (event: unknown, ctx: { hasUI: boolean; ui: { notify(): void; setStatus(): void } }) => Promise<void>) {
        if (event === "session_start") {
          void agentScope.run({ instanceId: "architect-test" }, () =>
            handler({}, { hasUI: false, ui: { notify() {}, setStatus() {} } }),
          );
        }
      },
      registerCommand() {},
      getActiveTools() {
        return ["agent_run", "read"];
      },
      getAllTools() {
        return [{ name: "agent_run" }, { name: "agent_supervise" }, { name: "read" }];
      },
      setActiveTools(names: string[]) {
        active.splice(0, active.length, ...names);
      },
      getSessionName() {
        return "kept";
      },
      setSessionName() {},
    };
    pitako(pi as unknown as ExtensionAPI);
    agentInstance(pi as unknown as ExtensionAPI);
    expect(active.includes("agent_run")).toBe(false);
    expect(active.includes("agent_supervise")).toBe(false);
    expect(currentInstanceId()).toBeUndefined();
    const tool = tools.get("agent_run");
    if (!tool) throw new Error("agent_run missing");
    const nested = await agentScope.run({ instanceId: "architect-test" }, () =>
      tool.execute("id", { role: "architect", task: "no" }, undefined, undefined, { cwd: packageRoot() }),
    );
    expect(nested.isError).toBe(true);
    expect(nested.details.error).toMatch(/cannot be called/);
  });
});
