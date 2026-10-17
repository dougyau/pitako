import { executionForSession } from "./execution-identity.ts";
import { PitakoConfigError } from "./errors.ts";
import type { Model } from "@earendil-works/pi-ai";
import { supportsOpenAIGrammarTools } from "pi-codex-tools";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentInstanceId } from "./agent/scope.ts";

export const PROFILES = ["coding", "analysis"] as const;
export type ProfileName = (typeof PROFILES)[number];

/** Built-ins Pi registers but does not enable until a profile or defaultTools asks. */
export const CODING_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const ANALYSIS_BUILTINS = ["read", "bash", "grep", "find", "ls"] as const;

/** Tools that change files. Shell is intentionally not in this set. */
export const MUTATING_TOOLS = new Set(["edit", "write", "apply_patch", "lsp_rename"]);

/** Foreground orchestration. Children do not receive these tools. */
export const ORCHESTRATION_TOOLS = [
  "architecture_start", "architecture_read", "architecture_control",
  "consultation_feedback",
  "agent_run",
  "agent_supervise",
  "agent_spawn",
  "agent_status",
  "agent_result",
  "agent_history",
  "agent_observe",
  "agent_input",
  "agent_cancel",
  "team_assign",
  "team_status",
  "team_result",
  "team_cancel",
] as const;

export const isOrchestrationTool = (name: string): boolean => /^(agent_|team_|head_)/.test(name) || name === "consultation_feedback" || ["architecture_start", "architecture_read", "architecture_control"].includes(name);
// SDK imports and Pi's extension loader can create separate module copies.
const PROFILE_KEY = Symbol.for("pitako.sessionProfiles");
type SessionProfile = { profile: ProfileName; current?: () => boolean };
const host = globalThis as typeof globalThis & { [PROFILE_KEY]?: WeakMap<object, SessionProfile> };
const sessionProfiles = host[PROFILE_KEY] ??= new WeakMap<object, SessionProfile>();

export function setSessionProfile(manager: object, profile: ProfileName, current?: () => boolean): void {
  sessionProfiles.set(manager, { profile, current: current ?? sessionProfiles.get(manager)?.current });
}

export function effectiveProfile(manager?: object & { getSessionId?: () => string }): ProfileName {
  return executionForSession(manager?.getSessionId?.())?.profile ??
    (manager && sessionProfiles.get(manager)?.profile) ?? "coding";
}

/** Late policy has no authority unless the early lifetime still owns this manager. */
export function profileIsCurrent(manager: object): boolean {
  return sessionProfiles.get(manager)?.current?.() === true;
}

export function requestedProfile(pi: ExtensionAPI): ProfileName {
  const flag = pi.getFlag("pitako-profile");
  return parseProfile(typeof flag === "string" ? flag : process.env.PITAKO_PROFILE);
}

export function isChildSession(ctx: ExtensionContext): boolean {
  return Boolean(executionForSession(ctx.sessionManager?.getSessionId()) || currentInstanceId() || process.env.PITAKO_INSTANCE_ID);
}

export function applyProfile(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
  const next = toolsForProfile({
    available: pi.getAllTools().map(tool => tool.name),
    profile: effectiveProfile(ctx.sessionManager),
    model: ctx.model,
    child: isChildSession(ctx),
    managed: executionForSession(ctx.sessionManager?.getSessionId())?.managed,
    includePowerShell: process.platform === "win32" || pi.getActiveTools().includes("powershell"),
  });
  pi.setActiveTools(next);
  return next;
}

/** Reconcile explicitly: same-model setModel does not emit model_select. */
export function reconcileChildTools(session: {
  sessionManager: object & { getSessionId?: () => string };
  model: Model<any> | undefined;
  getAllTools(): Array<{ name: string }>;
  setActiveToolsByName(names: string[]): void;
}): void {
  session.setActiveToolsByName(toolsForProfile({
    available: session.getAllTools().map((tool) => tool.name),
    profile: effectiveProfile(session.sessionManager),
    model: session.model,
    child: true,
    managed: executionForSession(session.sessionManager.getSessionId?.())?.managed,
    includePowerShell: process.platform === "win32",
  }));
}

const NAVIGATION_GUIDANCE = "Inspect the repo first. Keep read/grep/bash/LSP/CodeGraph available. For bounded structural code questions, choose a supported LSP or CodeGraph tool; use raw tools for literal, exhaustive or exact results; follow up with raw tools if a query/backend is partial or unavailable.";
const VERIFICATION_GUIDANCE = "Verify real behavior before claiming done. Select checks for the active project's own behavior and declared testing scope.";
const TODO_GUIDANCE = "For multi-step work on your current assignment, list existing TODOs and create all known stages as pending before starting the first. Reuse tasks on resume; preserve unrelated tasks and never clear the list to rebuild it. Update existing tasks, keep at most one in_progress, and complete only finished work. Add newly discovered stages when known. Skip TODOs for trivial tasks and conversation.";

const BUILTIN_TOOLS = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

export function parseProfile(value: unknown): ProfileName {
  if (value === undefined || value === null || value === "") return "coding";
  if (value === "coding" || value === "analysis") return value;
  throw new PitakoConfigError(
    `Unknown Pitako profile "${String(value)}". Expected "coding" or "analysis" (flag --pitako-profile or PITAKO_PROFILE).`,
  );
}

/** Coding tools for a child session. PowerShell follows the platform, same as a fresh coding profile. */
export function childActiveTools(
  available: readonly string[],
  platform: NodeJS.Platform = process.platform,
  model?: Model<any>,
): string[] {
  return toolsForProfile({
    available,
    profile: "coding",
    model,
    child: true,
    includePowerShell: platform === "win32" && available.includes("powershell"),
  });
}

export function toolsForProfile(options: {
  available: readonly string[];
  profile: ProfileName;
  model?: Model<any>;
  child?: boolean;
  managed?: "head" | "leaf" | "consultation";
  includePowerShell?: boolean;
}): string[] {
  const available = new Set(options.available);
  const builtins = options.profile === "coding" ? CODING_BUILTINS : ANALYSIS_BUILTINS;
  const patch = options.profile === "coding" && available.has("apply_patch") && supportsOpenAIGrammarTools(options.model);
  const names: string[] = builtins.filter((name) => available.has(name) && !(patch && (name === "edit" || name === "write")));
  if (options.includePowerShell && available.has("powershell")) names.push("powershell");
  for (const name of options.available) {
    if (BUILTIN_TOOLS.has(name)) continue;
    if (name === "apply_patch" && !patch) continue;
    if (options.child && (ORCHESTRATION_TOOLS as readonly string[]).includes(name) &&
        !(name === "consultation_feedback" && options.managed === "head")) continue;
    if (options.child && name.startsWith("head_") && options.managed !== "head" &&
        !(options.managed === "leaf" && name === "head_scope_ack")) continue;
    if (options.child && options.profile === "analysis" && isOrchestrationTool(name)) continue;
    if (options.profile === "analysis" && MUTATING_TOOLS.has(name)) continue;
    names.push(name);
  }
  return names;
}

export function profileNote(profile: ProfileName): string {
  const shared = [
    NAVIGATION_GUIDANCE,
    "Keep diffs small. Reuse code; avoid speculation.",
    VERIFICATION_GUIDANCE,
    "Load a specialized skill only when it applies.",
    "Research or design does not authorize implementation.",
    "Pi owns model and provider selection.",
    "Board tools are pull-only; do not paste posts into the turn. rpiv-todo is the session plan.",
    TODO_GUIDANCE,
  ];
  if (profile === "analysis") {
    return [
      "Pitako profile: analysis.",
      "Read-only coding tools are enabled. edit, write, apply_patch, and lsp_rename are not.",
      "Shell is still available; this profile is not a sandbox.",
      ...shared,
    ].join(" ");
  }
  return [
    "Pitako profile: coding.",
    "Use apply_patch when available; otherwise edit for local edits and write for new files.",
    ...shared,
  ].join(" ");
}

/** True for an AgentInstance. Does not claim the user picked the model. */
export function childSessionNote(instanceId: string): string {
  return [
    `Pitako AgentInstance ${instanceId}.`,
    "The model and reasoning come from this role's ModelPolicy, not from the parent session.",
    NAVIGATION_GUIDANCE,
    "Keep diffs small.",
    VERIFICATION_GUIDANCE,
    "Board tools are pull-only. rpiv-todo is private to this session. Do not spawn agents.",
    TODO_GUIDANCE,
  ].join(" ");
}
