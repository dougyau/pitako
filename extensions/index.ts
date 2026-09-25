import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { skillStatusLines } from "./catalog.ts";
import { PitakoConfigError } from "./errors.ts";
import { isProtectedEditPath } from "./paths.ts";
import { canonicalPath } from "./board/paths.ts";
import { bindBackgroundOwner, shutdownBackground, takeHeldCompletions } from "./agent/background.ts";
import { beginTeamEvaluation, retireTeamEvaluation, teamEvaluationForSession, teamAssignments, type TeamEvaluation } from "./team.ts";
import { teamWorkerStatus } from "./agent/background.ts";
import { bindAgentUi, listObservations, unbindAgentUi } from "./agent/observe.ts";
import { formatAgentsDetail } from "./agent/ui.ts";
import { childSessionNote, ORCHESTRATION_TOOLS, parseProfile, profileNote, toolsForProfile, type ProfileName } from "./profile.ts";
import { currentInstanceId, currentRoleId } from "./agent/scope.ts";
import { executionForSession } from "./execution-identity.ts";
import { formatUsage, mergeUsage, type AgentUsage } from "./agent/run.ts";
import { completeTool, emptyCodeIntelligenceUsage, formatCodeIntelligenceUsage, isDenseToolName, type CodeIntelligenceUsage, type DenseCallUsage, type ToolOutcome } from "./code-intelligence/metrics.ts";
import { inspectPitako } from "./roles/format.ts";
import { registerSupervisedSession, unregisterSupervisedSession } from "./herdr/author.ts";
import { registerAgentSupervise } from "./herdr/supervise.ts";
import { packageRoot, prepareRuntime } from "./stack.ts";
import { planHeading, planInvocation, sessionNameAction } from "./session-name.ts";
import { createApplyPatchToolDefinition } from "./apply-patch.ts";
import { parsePlanDocument, planFile } from "./workflow.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

const foregroundCodeUsage = new Map<string, CodeIntelligenceUsage>();
const foregroundToolStarts = new Map<string, Map<string, { name: string; startedAt: number }>>();
const foregroundNavigation = new Map<string, { remaining: number }>();

function requestedProfile(pi: ExtensionAPI): ProfileName {
  const flag = pi.getFlag("pitako-profile");
  if (typeof flag === "string") return parseProfile(flag);
  return parseProfile(process.env.PITAKO_PROFILE);
}

function sessionRoleId(): string | undefined {
  return currentRoleId() ?? (process.env.PITAKO_INSTANCE_ID ? process.env.PITAKO_ROLE_ID : undefined);
}

function applyProfile(pi: ExtensionAPI, profile: ProfileName, roleId?: string): string[] {
  const available = pi.getAllTools().map((tool) => tool.name);
  const active = pi.getActiveTools();
  const next = toolsForProfile({
    available,
    profile,
    roleId,
    includePowerShell: process.platform === "win32" || active.includes("powershell"),
  });
  pi.setActiveTools(next);
  return next;
}

function foregroundSession(sessionId: string | undefined): sessionId is string {
  return Boolean(sessionId && !executionForSession(sessionId) && !currentInstanceId() && !process.env.PITAKO_INSTANCE_ID);
}

function foregroundDenseCall(name: string, event: any, startedAt: number | undefined, aborted: boolean): DenseCallUsage | undefined {
  if (!isDenseToolName(name)) return undefined;
  const measured = event.details?.codeIntelligence;
  if (measured?.tool === name && typeof measured.durationMs === "number" && typeof measured.outputBytes === "number") return measured as DenseCallUsage;
  const text = (event.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
  const status = event.details?.status;
  const outcome: ToolOutcome = aborted ? "cancelled" : status === "partial" ? "partial" : status === "unavailable" ? "unavailable" : event.isError ? "error" : "ok";
  return {
    tool: name,
    durationMs: Math.max(0, Math.round(performance.now() - (startedAt ?? performance.now()))),
    outputBytes: Buffer.byteLength(text),
    truncated: event.details?.truncated === true,
    outcome,
    telemetryAvailable: false,
    sources: {},
  };
}

function recordForegroundStart(event: { toolCallId: string; toolName: string }, sessionId: string | undefined): void {
  if (!foregroundSession(sessionId) || !isDenseToolName(event.toolName)) return;
  const calls = foregroundToolStarts.get(sessionId) ?? new Map();
  calls.set(event.toolCallId, { name: event.toolName, startedAt: performance.now() });
  foregroundToolStarts.set(sessionId, calls);
  foregroundCodeUsage.set(sessionId, foregroundCodeUsage.get(sessionId) ?? emptyCodeIntelligenceUsage());
}

function recordForegroundResult(event: any, sessionId: string | undefined, aborted: boolean): void {
  if (!foregroundSession(sessionId)) return;
  const calls = foregroundToolStarts.get(sessionId);
  const started = calls?.get(event.toolCallId);
  calls?.delete(event.toolCallId);
  const usage = foregroundCodeUsage.get(sessionId) ?? emptyCodeIntelligenceUsage();
  const navigation = foregroundNavigation.get(sessionId) ?? { remaining: 0 };
  usage.navigation.remaining = navigation.remaining;
  completeTool(usage, event.toolName, foregroundDenseCall(event.toolName, event, started?.startedAt, aborted), navigation);
  foregroundCodeUsage.set(sessionId, usage);
  foregroundNavigation.set(sessionId, navigation);
}

function foregroundModelUsage(entries: readonly unknown[] | undefined): string {
  if (!entries) return "model usage: unknown (session entries unavailable)";
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let found = false;
  const add = (usage: any) => {
    if (!usage || typeof usage !== "object" || (!["input", "output", "cacheRead", "cacheWrite"].some((key) => typeof usage[key] === "number") && typeof usage.cost?.total !== "number")) return;
    found = true;
    totals.input += Number(usage.input) || 0;
    totals.output += Number(usage.output) || 0;
    totals.cacheRead += Number(usage.cacheRead) || 0;
    totals.cacheWrite += Number(usage.cacheWrite) || 0;
    totals.cost += Number(usage.cost?.total) || 0;
  };
  for (const entry of entries as any[]) {
    if (entry?.type === "usage") add(entry.usage);
    else if ((entry?.type === "branch_summary" || entry?.type === "compaction") && entry.usage) add(entry.usage);
    else if (entry?.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) add(entry.message.usage);
  }
  if (!found) return "model usage: unknown (no usage reported)";
  const total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return `model usage: input=${totals.input}, output=${totals.output}, cached_read=${totals.cacheRead}, cached_write=${totals.cacheWrite}, total=${total}, cost=${totals.cost}`;
}

export default function pitako(pi: ExtensionAPI) {
  const root = packageRoot();
  // Fail during extension load so Pi surfaces a configuration error at startup.
  prepareRuntime(root);
  parseProfile(process.env.PITAKO_PROFILE);

  pi.registerFlag("pitako-profile", {
    description: 'Pitako profile: "coding" (default) or "analysis"',
    type: "string",
  });

  registerAgentSupervise(pi);
  pi.registerTool(createApplyPatchToolDefinition(process.cwd()));

  let profile: ProfileName = "coding";

  let ownerToken = Symbol("pitako.foreground");
  let agentUiBindingToken: symbol | undefined;
  let teamEvaluation: TeamEvaluation | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId();
    if (foregroundSession(sessionId)) {
      for (const previous of foregroundCodeUsage.keys()) {
        if (previous !== sessionId) {
          foregroundCodeUsage.delete(previous);
          foregroundToolStarts.delete(previous);
          foregroundNavigation.delete(previous);
        }
      }
      foregroundCodeUsage.set(sessionId, emptyCodeIntelligenceUsage());
      foregroundToolStarts.set(sessionId, new Map());
      foregroundNavigation.set(sessionId, { remaining: 0 });
    }
    if (teamEvaluation && teamEvaluation.sessionId !== sessionId) retireTeamEvaluation(teamEvaluation);
    ownerToken = Symbol("pitako.foreground");
    teamEvaluation = beginTeamEvaluation(
      sessionId,
      Boolean(currentInstanceId() || process.env.PITAKO_INSTANCE_ID),
      ownerToken,
    );
    registerSupervisedSession(sessionId);
    if (!currentInstanceId() && !process.env.PITAKO_INSTANCE_ID && typeof ctx.isIdle === "function") {
      bindBackgroundOwner({
        token: ownerToken,
        isIdle: () => ctx.isIdle(),
        hasUI: ctx.hasUI,
        notify: (message) => {
          if (ctx.hasUI) ctx.ui.notify(message, "info");
        },
        sendMessage: (content) => {
          pi.sendMessage(
            {
              customType: "pitako.worker",
              content,
              display: true,
              details: { source: "pitako.worker" },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        },
      });
    }
    try {
      profile = requestedProfile(pi);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      throw error;
    }
    const instanceId = currentInstanceId();
    if (instanceId || process.env.PITAKO_INSTANCE_ID) {
      const available = pi.getAllTools().map((tool) => tool.name);
      const coding = toolsForProfile({
        available,
        profile: "coding",
        roleId: sessionRoleId(),
        includePowerShell: process.platform === "win32" || pi.getActiveTools().includes("powershell"),
      }).filter((name) => !ORCHESTRATION_TOOLS.includes(name as (typeof ORCHESTRATION_TOOLS)[number]));
      pi.setActiveTools(coding);
    } else {
      applyProfile(pi, profile);
    }
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const existingUserText = firstUserText(entries);
    const invocation = latestPlanInvocation(entries);
    const workflow = invocation && readWorkflowTitle(invocation.activity, invocation.id, ctx.cwd);
    const action = sessionNameAction({ current: pi.getSessionName(), existingUserText, workflow });
    if (action.set !== undefined) pi.setSessionName(action.set);
    if (ctx.hasUI) {
      ctx.ui.setStatus("pitako", pi.getSessionName() || undefined);
      agentUiBindingToken = bindAgentUi({
        ownerToken,
        setStatus: (key, text) => ctx.ui.setStatus(key, text),
        modelLookup: (provider, id) => ctx.modelRegistry?.find(provider, id),
      });
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId();
    if (foregroundSession(sessionId)) {
      foregroundCodeUsage.delete(sessionId);
      foregroundToolStarts.delete(sessionId);
      foregroundNavigation.delete(sessionId);
    }
    if (agentUiBindingToken) unbindAgentUi(agentUiBindingToken);
    agentUiBindingToken = undefined;
    retireTeamEvaluation(teamEvaluation);
    shutdownBackground(ownerToken);
    unregisterSupervisedSession();
  });

  const flush = () => {
    const content = takeHeldCompletions(ownerToken);
    if (!content) return;
    pi.sendMessage(
      {
        customType: "pitako.worker",
        content,
        display: true,
        details: { source: "pitako.worker" },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };
  pi.on("agent_settled", flush);
  pi.on("session_compact", flush);
  pi.on("session_compact_failed", flush);
  pi.on("session_tree", flush);

  pi.on("before_agent_start", async (event, ctx) => {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const existingUserText = firstUserText(entries);
    const pendingPrompt = existingUserText ? undefined : event.prompt;
    const invocation = planInvocation(event.prompt);
    const workflow = invocation && readWorkflowTitle(invocation.activity, invocation.id, ctx.cwd);
    const action = sessionNameAction({
      current: pi.getSessionName(),
      existingUserText,
      pendingPrompt,
      workflow,
    });
    if (action.set !== undefined) pi.setSessionName(action.set);
    if (ctx.hasUI) ctx.ui.setStatus("pitako", pi.getSessionName() || undefined);

    const instanceId = currentInstanceId();
    const note = instanceId ? childSessionNote(instanceId) : profileNote(profile);
    const current = event.systemPrompt ?? "";
    if (current.includes(note)) return undefined;
    return { systemPrompt: current.length > 0 ? `${current}\n\n${note}` : note };
  });

  pi.registerCommand("pitako", {
    description: "Pitako status, telemetry, profile, roles, and model policies",
    handler: async (args, ctx) => {
      const [command, value] = args.trim().split(/\s+/, 2);
      if (command === "roles" || command === "role" || command === "policies" || command === "policy") {
        try {
          notify(ctx, inspectPitako(args));
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "team") {
        const evaluation = teamEvaluationForSession(
          ctx.sessionManager?.getSessionId?.(),
          Boolean(currentInstanceId() || process.env.PITAKO_INSTANCE_ID),
        );
        if (!evaluation) {
          notify(ctx, "Team unavailable for this session", "error");
          return;
        }
        const roles = ["architect", "developer", "reviewer", "researcher"];
        const rows = teamAssignments(evaluation).map((slot, index) => {
          const assignment = slot.current ?? slot.last;
          if (!assignment) return { role: roles[index], status: "idle" };
          const view = teamWorkerStatus(evaluation.token, assignment.instanceId)[0];
          return {
            role: roles[index],
            assignmentId: assignment.id,
            instanceId: assignment.instanceId,
            status: view?.status ?? "settled",
            elapsedMs: view?.elapsedMs,
          };
        });
        notify(ctx, JSON.stringify(rows));
        return;
      }
      if (command === "agents") {
        try {
          let rows = listObservations();
          if (value) {
            const one = rows.find((row) => row.id === value);
            if (!one) throw new Error(`unknown worker ${value}`);
            rows = [one];
          }
          const detail = formatAgentsDetail(rows, Date.now());
          notify(ctx, detail.length === 0 ? "no workers" : detail);
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "stats") {
        try {
          const rows = listObservations(teamEvaluation?.token);
          if (value) {
            const row = rows.find((item) => item.id === value);
            if (!row) throw new Error(`unknown instance ${value}`);
            const usage = row.agentUsage;
            notify(ctx, [`instance: ${row.id}`, `role: ${row.roleId}`, `status: ${row.status}`, usage ? formatUsage(usage) : "model usage: unknown (attempt has not reported usage)", usage?.codeIntelligence ? undefined : "code intelligence: unknown"].filter(Boolean).join("\n"));
            return;
          }
          const sessionId = ctx.sessionManager?.getSessionId?.();
          const codeUsage = sessionId ? foregroundCodeUsage.get(sessionId) : undefined;
          const lines = [
            `foreground session: ${sessionId ?? "unknown"}`,
            foregroundModelUsage(ctx.sessionManager?.getEntries?.()),
            codeUsage ? formatCodeIntelligenceUsage(codeUsage) : "code intelligence: unknown (session event identity unavailable)",
          ];
          if (rows.length) {
            lines.push("AgentInstances:");
            const roles = new Map<string, AgentUsage | undefined>();
            for (const row of rows) {
              if (row.agentUsage) roles.set(row.roleId, mergeUsage(roles.get(row.roleId), row.agentUsage));
              else if (!roles.has(row.roleId)) roles.set(row.roleId, undefined);
            }
            for (const [role, usage] of roles) {
              const incomplete = rows.some((row) => row.roleId === role && !row.agentUsage);
              lines.push(usage ? `role ${role}${incomplete ? " (some instance usage unknown)" : ""}:\n${formatUsage(usage)}` : `role ${role}: usage unknown`);
            }
            for (const row of rows) lines.push(`instance ${row.id} (${row.roleId}, ${row.status}): ${row.agentUsage ? formatUsage(row.agentUsage).replaceAll("\n", " · ") : "usage unknown"}`);
          } else {
            lines.push("AgentInstances: none");
          }
          notify(ctx, lines.join("\n"));
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "profile" && value) {
        profile = parseProfile(value);
        const tools = applyProfile(pi, profile, sessionRoleId());
        if (ctx.hasUI) {
          ctx.ui.notify(`Pitako profile: ${profile} (${tools.length} tools)`, "info");
        }
        return;
      }
      const lines = [
        `Pitako profile: ${profile}`,
        "coding: read, bash, edit, write, grep, find, ls, LSP, CodeGraph, todo; apply_patch is Developer AgentInstance-only with task-scoped batch guidance.",
        "analysis: read, bash, grep, find, ls, LSP, CodeGraph, todo; no edit, write, apply_patch, or lsp_rename",
        "Code intelligence: project_report, read_symbol, read_enclosing, module_report, inspect_symbol, review_surface; raw navigation remains available.",
        "Switch with /pitako profile analysis",
        "Session TODOs: todo tool and /todos (rpiv-todo). Shared knowledge: board_* tools and /board.",
        "Roles: /pitako roles, /pitako role <id>, /pitako policies, /pitako policy <id>. Definitions only.",
        "Background workers: /pitako agents; telemetry: /pitako stats [instance-id]; Team roster: /pitako team",

        ...skillStatusLines(),
      ];
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    recordForegroundResult(event, ctx.sessionManager?.getSessionId(), Boolean(ctx.signal?.aborted));
    if (event.toolName === "apply_patch" && isApplyPatchFailure(event.details)) return { isError: true };
    if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return undefined;
    const target = event.input.path;
    if (typeof target !== "string") return undefined;
    const filename = path.basename(path.resolve(ctx.cwd, target));
    if (!filename.endsWith(".md")) return undefined;
    const id = filename.slice(0, -3);
    let file: string;
    try {
      file = planFile(id, ctx.cwd);
    } catch {
      return undefined;
    }
    if (canonicalPath(target, ctx.cwd) !== file) return undefined;
    const workflow = readWorkflowTitle("plan", id, ctx.cwd);
    if (!workflow) return undefined;
    const action = sessionNameAction({
      current: pi.getSessionName(),
      existingUserText: firstUserText(ctx.sessionManager?.getEntries?.() ?? []),
      workflow: { ...workflow, fromPlanWrite: true },
    });
    if (action.set !== undefined) pi.setSessionName(action.set);
    if (ctx.hasUI) ctx.ui.setStatus("pitako", pi.getSessionName() || undefined);
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    recordForegroundStart(event, ctx.sessionManager?.getSessionId());
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const input = event.input as { path?: unknown };
    const target = typeof input.path === "string" ? input.path : "";
    if (!target || !isProtectedEditPath(target)) return undefined;
    const reason = `Pitako blocked ${event.toolName} to protected path "${target}".`;
    if (ctx.hasUI) ctx.ui.notify(reason, "warning");
    return { block: true, reason };
  });
}

function latestPlanInvocation(entries: readonly unknown[]): { activity: "plan" | "execute"; id: string } | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") continue;
    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") continue;
    const text = userMessageText(message);
    const invocation = planInvocation(text);
    if (invocation) return invocation;
  }
  return undefined;
}

function readWorkflowTitle(activity: "plan" | "execute", id: string, cwd: string): { activity: "plan" | "execute"; title: string } | undefined {
  try {
    const text = readFileSync(planFile(id, cwd), "utf8");
    if (parsePlanDocument(text).id !== id) return undefined;
    return { activity, title: planHeading(text) ?? id };
  } catch {
    return undefined;
  }
}

function userMessageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((part): part is { type: string; text: string } =>
          !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
        .map((part) => part.text).join("")
      : "";
}

function firstUserText(entries: readonly unknown[]): string | undefined {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") continue;
    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") continue;
    const text = userMessageText(message);
    if (text.trim()) return text;
  }
  return undefined;
}

function notify(
  ctx: { hasUI: boolean; ui: { notify(message: string, kind?: "info" | "error"): void } },
  message: string,
  kind: "info" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, kind);
    return;
  }
  if (kind === "error") throw new Error(message);
}

function isApplyPatchFailure(details: unknown): boolean {
  return Boolean(details && typeof details === "object" && "ok" in details && details.ok === false);
}

export { PitakoConfigError };
