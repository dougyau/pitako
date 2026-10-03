import { PitakoConfigError } from "./errors.ts";
import type { Model } from "@earendil-works/pi-ai";
import { supportsOpenAIGrammarTools } from "pi-codex-tools";

export const PROFILES = ["coding", "analysis"] as const;
export type ProfileName = (typeof PROFILES)[number];

/** Built-ins Pi registers but does not enable until a profile or defaultTools asks. */
export const CODING_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const ANALYSIS_BUILTINS = ["read", "bash", "grep", "find", "ls"] as const;

/** Tools that change files. Shell is intentionally not in this set. */
export const MUTATING_TOOLS = new Set(["edit", "write", "apply_patch", "lsp_rename"]);

/** Foreground orchestration. Children do not receive these tools. */
export const ORCHESTRATION_TOOLS = [
  "agent_run",
  "agent_supervise",
  "agent_spawn",
  "agent_status",
  "agent_result",
  "agent_history",
  "agent_cancel",
  "team_assign",
  "team_status",
  "team_result",
  "team_cancel",
] as const;

const ORCHESTRATION = new Set<string>(ORCHESTRATION_TOOLS);
// SDK imports and Pi's extension loader can create separate module copies.
const PROFILE_KEY = Symbol.for("pitako.sessionProfiles");
const host = globalThis as typeof globalThis & { [PROFILE_KEY]?: WeakMap<object, ProfileName> };
const sessionProfiles = host[PROFILE_KEY] ??= new WeakMap<object, ProfileName>();

export function setSessionProfile(manager: object, profile: ProfileName): void {
  sessionProfiles.set(manager, profile);
}

/** Reconcile explicitly: same-model setModel does not emit model_select. */
export function reconcileChildTools(session: {
  sessionManager: object;
  model: Model<any> | undefined;
  getAllTools(): Array<{ name: string }>;
  setActiveToolsByName(names: string[]): void;
}): void {
  session.setActiveToolsByName(toolsForProfile({
    available: session.getAllTools().map((tool) => tool.name),
    profile: sessionProfiles.get(session.sessionManager) ?? "coding",
    model: session.model,
    child: true,
    includePowerShell: process.platform === "win32",
  }));
}

const NAVIGATION_GUIDANCE = "Inspect the repo first. Keep raw read/grep/bash/LSP/CodeGraph available. For bounded structural code questions, choose an appropriate supported dense query; use raw tools for literal, exhaustive or exact results; follow up with raw tools if a query/backend is partial or unavailable.";

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
    if (options.child && ORCHESTRATION.has(name)) continue;
    if (options.profile === "analysis" && MUTATING_TOOLS.has(name)) continue;
    names.push(name);
  }
  return names;
}

export function profileNote(profile: ProfileName): string {
  const shared = [
    NAVIGATION_GUIDANCE,
    "Keep diffs small. Reuse existing code. Do not add speculative machinery.",
    "Verify real behavior before claiming done. Load a specialized skill only when it applies.",
    "Research or design does not authorize implementation.",
    "The model and provider are whatever the user selected in Pi.",
    "Board tools are pull-only shared knowledge. rpiv-todo is the session plan. Do not paste Board posts into the turn.",
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
    "Keep diffs small. Verify real behavior before claiming done.",
    "Board tools are pull-only. rpiv-todo is private to this session. Do not spawn agents.",
  ].join(" ");
}
