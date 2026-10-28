import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { skillStatusLines } from "./catalog.ts";
import { herdrSetupNotice } from "./herdr.ts";
import planExecute from "./plan-execute.ts";
import { isProtectedEditPath } from "./paths.ts";
import { applyProfile, MUTATING_TOOLS, effectiveProfile, parseProfile, profileNote, requestedProfile, setSessionProfile } from "./profile.ts";
import { sessionNameAction } from "./session-name.ts";
import { packageRoot, prepareRuntime } from "./stack.ts";

// Keep advisory deduplication across Pi reloads and separate extension module copies.
const HERDR_NOTICES_KEY = Symbol.for("pitako.herdrNotices");
const host = globalThis as typeof globalThis & { [HERDR_NOTICES_KEY]?: WeakMap<object, Set<string>> };
const herdrNotices = host[HERDR_NOTICES_KEY] ??= new WeakMap<object, Set<string>>();

export default function pitako(pi: ExtensionAPI): void {
  prepareRuntime(packageRoot());
  planExecute(pi);
  pi.registerFlag("pitako-profile", {
    description: 'Pitako profile: "coding" (default) or "analysis"',
    type: "string",
  });

  let manager: ExtensionContext["sessionManager"] | undefined;
  pi.on("session_start", (_event, ctx) => {
    manager = ctx.sessionManager;
    const captured = manager;
    const sessionId = captured.getSessionId();
    setSessionProfile(captured, requestedProfile(pi),
      () => manager === captured && captured.getSessionId() === sessionId);
    applyProfile(pi, ctx);
    const action = sessionNameAction({
      current: pi.getSessionName(),
      existingUserText: firstUserText(ctx.sessionManager.getEntries()),
    });
    if (action.set !== undefined) pi.setSessionName(action.set);
    if (ctx.hasUI) ctx.ui.setStatus("pitako", pi.getSessionName() || undefined);
    if (ctx.hasUI && process.env.HERDR_ENV === "1" && process.env.PI_SUBAGENT_CHILD !== "1"
      && !herdrNotices.get(captured)?.has(sessionId)) {
      const notices = herdrNotices.get(captured) ?? new Set<string>();
      notices.add(sessionId);
      herdrNotices.set(captured, notices);
      const notice = herdrSetupNotice(ctx.cwd);
      if (notice) ctx.ui.notify(notice, "info");
    }
  });
  pi.on("session_shutdown", () => { manager = undefined; });

  pi.on("before_agent_start", (event, ctx) => {
    const action = sessionNameAction({
      current: pi.getSessionName(),
      existingUserText: firstUserText(ctx.sessionManager.getEntries()),
      pendingPrompt: event.messageType === "user" ? event.prompt : undefined,
    });
    if (action.set !== undefined) pi.setSessionName(action.set);
    if (ctx.hasUI) ctx.ui.setStatus("pitako", pi.getSessionName() || undefined);
    const note = profileNote(effectiveProfile(ctx.sessionManager));
    if (event.systemPrompt.includes(note)) return;
    return { systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${note}` : note };
  });

  pi.registerCommand("pitako", {
    description: "Pitako profile and skill status",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts[0] === "profile" && parts.length === 2) {
        setSessionProfile(ctx.sessionManager, parseProfile(parts[1]));
        const tools = applyProfile(pi, ctx);
        if (ctx.hasUI) ctx.ui.notify(`Pitako profile: ${effectiveProfile(ctx.sessionManager)} (${tools.length} tools)`, "info");
        return;
      }
      if (args.trim()) {
        const message = "Usage: /pitako or /pitako profile coding|analysis";
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else throw new Error(message);
        return;
      }
      const lines = [
        `Pitako profile: ${effectiveProfile(ctx.sessionManager)}`,
        "coding: navigation and editing; apply_patch for grammar-capable OpenAI models, otherwise edit/write.",
        "analysis: navigation and hashing; editing, saving and introduced mutators blocked, including nested calls. Shell is not sandboxed.",
        "Switch with /pitako profile analysis",
        "Session TODOs: todo and /todos. Shared knowledge: board_* and /board.",
        "Delegation: pi-subagents. Architecture, review, plan and execute skills start their workflows.",
        ...skillStatusLines(),
      ];
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("tool_call", (event, ctx) => {
    // Inactive codemode/deferred registrations remain callable in Pi. Enforce at
    // the shared tool-call pipeline as well as the advertised profile loadout.
    if (effectiveProfile(ctx.sessionManager) === "analysis" && MUTATING_TOOLS.has(event.toolName)) {
      return { block: true, reason: `Pitako analysis forbids ${event.toolName}.` };
    }
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const target = (event.input as { path?: unknown }).path;
    if (typeof target !== "string" || !isProtectedEditPath(target)) return;
    const reason = `Pitako blocked ${event.toolName} to protected path "${target}".`;
    if (ctx.hasUI) ctx.ui.notify(reason, "warning");
    return { block: true, reason };
  });
}

function firstUserText(entries: readonly unknown[]): string | undefined {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "message" || !("message" in entry)) continue;
    const message = entry.message;
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user" || !("content" in message)) continue;
    const content = message.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("")
      : "";
    if (text.trim()) return text;
  }
  return undefined;
}
