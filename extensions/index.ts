import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { skillStatusLines } from "./catalog.ts";
import { PitakoConfigError } from "./errors.ts";
import { isProtectedEditPath } from "./paths.ts";
import { bindBackgroundOwner, formatWorkerViews, shutdownBackground, takeHeldCompletions, workerStatus } from "./agent/background.ts";
import { childSessionNote, ORCHESTRATION_TOOLS, parseProfile, profileNote, toolsForProfile, type ProfileName } from "./profile.ts";
import { currentInstanceId } from "./agent/scope.ts";
import { inspectPitako } from "./roles/format.ts";
import { registerSupervisedSession, unregisterSupervisedSession } from "./herdr/author.ts";
import { registerAgentSupervise } from "./herdr/supervise.ts";
import { packageRoot, prepareRuntime } from "./stack.ts";

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

  const ownerToken = Symbol("pitako.foreground");

  pi.on("session_start", async (_event, ctx) => {
    registerSupervisedSession(ctx.sessionManager?.getSessionId());
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
    if (!pi.getSessionName()) pi.setSessionName(`pitako:${profile}`);
    if (ctx.hasUI) ctx.ui.setStatus("pitako", `pitako:${profile}`);
  });

  pi.on("session_shutdown", async () => {
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

  pi.on("before_agent_start", async (event) => {
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
      if (command === "agents") {
        try {
          notify(ctx, formatWorkerViews(workerStatus(value)));
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "profile" && value) {
        profile = parseProfile(value);
        const tools = applyProfile(pi, profile);
        pi.setSessionName(`pitako:${profile}`);
        if (ctx.hasUI) {
          ctx.ui.setStatus("pitako", `pitako:${profile}`);
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
        "Background workers: /pitako agents",

        ...skillStatusLines(),
      ];
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    },
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
