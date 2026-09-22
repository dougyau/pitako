import { PitakoConfigError } from "./errors.ts";

export const PROFILES = ["coding", "analysis"] as const;
export type ProfileName = (typeof PROFILES)[number];

/** Built-ins Pi registers but does not enable until a profile or defaultTools asks. */
export const CODING_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const ANALYSIS_BUILTINS = ["read", "bash", "grep", "find", "ls"] as const;

/** Tools that change files. Shell is intentionally not in this set. */
export const MUTATING_TOOLS = new Set(["edit", "write", "lsp_rename"]);

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
export function childActiveTools(available: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return toolsForProfile({
    available,
    profile: "coding",
    includePowerShell: platform === "win32" && available.includes("powershell"),
  }).filter((name) => name !== "agent_run" && name !== "agent_supervise");
}

export function toolsForProfile(options: {
  available: readonly string[];
  profile: ProfileName;
  includePowerShell?: boolean;
}): string[] {
  const available = new Set(options.available);
  const builtins = options.profile === "coding" ? CODING_BUILTINS : ANALYSIS_BUILTINS;
  const names: string[] = builtins.filter((name) => available.has(name));
  if (options.includePowerShell && available.has("powershell")) names.push("powershell");
  for (const name of options.available) {
    if (BUILTIN_TOOLS.has(name)) continue;
    if (options.profile === "analysis" && MUTATING_TOOLS.has(name)) continue;
    names.push(name);
  }
  return names;
}

export function profileNote(profile: ProfileName): string {
  const shared = [
    "Inspect the repository before editing. Prefer CodeGraph and LSP over broad grep.",
    "Keep diffs small. Reuse existing code. Do not add speculative machinery.",
    "Verify real behavior before claiming done. Load a specialized skill only when it applies.",
    "Research or design does not authorize implementation.",
    "The model and provider are whatever the user selected in Pi.",
    "Board tools are pull-only shared knowledge. rpiv-todo is the session plan. Do not paste Board posts into the turn.",
  ];
  if (profile === "analysis") {
    return [
      "Pitako profile: analysis.",
      "Read-only coding tools are enabled. edit, write, and lsp_rename are not.",
      "Shell is still available; this profile is not a sandbox.",
      ...shared,
    ].join(" ");
  }
  return ["Pitako profile: coding.", ...shared].join(" ");
}

/** True for an AgentInstance. Does not claim the user picked the model. */
export function childSessionNote(instanceId: string): string {
  return [
    `Pitako AgentInstance ${instanceId}.`,
    "The model and reasoning come from this role's ModelPolicy, not from the parent session.",
    "Inspect the repository before editing. Prefer CodeGraph and LSP over broad grep.",
    "Keep diffs small. Verify real behavior before claiming done.",
    "Board tools are pull-only. rpiv-todo is private to this session. Do not spawn agents.",
  ].join(" ");
}
