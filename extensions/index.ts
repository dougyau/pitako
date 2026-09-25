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
import { currentInstanceId } from "./agent/scope.ts";
import { inspectPitako } from "./roles/format.ts";
import { registerSupervisedSession, unregisterSupervisedSession } from "./herdr/author.ts";
import { registerAgentSupervise } from "./herdr/supervise.ts";
import { packageRoot, prepareRuntime } from "./stack.ts";
import { planHeading, planInvocation, sessionNameAction } from "./session-name.ts";
import { planFile, readFrozenPlan, readPlan } from "./workflow.ts";
import path from "node:path";

function requestedProfile(pi: ExtensionAPI): ProfileName {
  const flag = pi.getFlag("pitako-profile");
  if (typeof flag === "string") return parseProfile(flag);
  return parseProfile(process.env.PITAKO_PROFILE);
}

function applyProfile(pi: ExtensionAPI, profile: ProfileName): string[] {
  const available = pi.getAllTools().map((tool) => tool.name);
  const active = pi.getActiveTools();
  const next = toolsForProfile({
    available,
    profile,
    includePowerShell: process.platform === "win32" || active.includes("powershell"),
  });
  pi.setActiveTools(next);
  return next;
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

  let profile: ProfileName = "coding";

  let ownerToken = Symbol("pitako.foreground");
  let agentUiBindingToken: symbol | undefined;
  let teamEvaluation: TeamEvaluation | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId();
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

  pi.on("session_shutdown", async () => {
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
    description: "Pitako status, profile, roles, and model policies",
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
      if (command === "profile" && value) {
        profile = parseProfile(value);
        const tools = applyProfile(pi, profile);
        if (ctx.hasUI) {
          ctx.ui.notify(`Pitako profile: ${profile} (${tools.length} tools)`, "info");
        }
        return;
      }
      const lines = [
        `Pitako profile: ${profile}`,
        "coding: read, bash, edit, write, grep, find, ls, LSP, CodeGraph, todo",
        "analysis: read, bash, grep, find, ls, LSP, CodeGraph, todo; no edit, write, or lsp_rename",
        "Switch with /pitako profile analysis",
        "Session TODOs: todo tool and /todos (rpiv-todo). Shared knowledge: board_* tools and /board.",
        "Roles: /pitako roles, /pitako role <id>, /pitako policies, /pitako policy <id>. Definitions only.",
        "Background workers: /pitako agents; Team roster: /pitako team",

        ...skillStatusLines(),
      ];
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("tool_result", async (event, ctx) => {
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
    const { text } = activity === "execute" ? readFrozenPlan(id, cwd) : readPlan(id, cwd);
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

export { PitakoConfigError };
