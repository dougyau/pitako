import type { PitakoConfig, ResolvedModelPolicy, ResolvedRole } from "./types.ts";
import { loadPitakoConfig, resolveRole, resolveModelPolicy, type LoadOptions } from "./load.ts";

export function formatRoleList(config: PitakoConfig): string {
  const lines = ["Roles"];
  for (const role of Object.values(config.roles)) {
    const policy = config.policies[role.modelPolicy];
    const target = policy?.primary ? policy.primary.model : "no primary target";
    lines.push(`${role.id}: ${role.name}. policy ${role.modelPolicy}. ${target}`);
  }
  return lines.join("\n");
}

export function formatRole(role: ResolvedRole): string {
  return [
    role.name,
    role.description,
    `instructions: ${role.instructionsPath}`,
    "",
    formatPolicy(role.modelPolicy),
    "",
    "skills:",
    ...bullet(role.skills),
    "",
    "principles:",
    ...bullet(role.principles),
    "",
    role.instructions,
  ].join("\n");
}

export function formatPolicyList(config: PitakoConfig): string {
  const lines = ["Model policies"];
  for (const policy of Object.values(config.policies)) {
    lines.push(`${policy.id}: ${policy.primary ? policy.primary.model : "not configured"}`);
  }
  return lines.join("\n");
}

export function formatPolicy(policy: ResolvedModelPolicy): string {
  const lines = [`model policy: ${policy.id}`];
  if (policy.primary) {
    lines.push(
      "primary:",
      `  ${policy.primary.model}`,
      `  reasoning: ${policy.primary.reasoning ?? "unset"}`,
      `  fast: ${policy.primary.fast ?? false}`,
    );
  } else {
    lines.push("primary:", "  not configured");
  }
  if (policy.fallbacks.length === 0) {
    lines.push("fallbacks:", "  none");
  } else {
    policy.fallbacks.forEach((target, index) => {
      lines.push(
        `fallback ${index + 1}:`,
        `  ${target.model}`,
        `  reasoning: ${target.reasoning ?? "unset"}`,
        `  fast: ${target.fast ?? false}`,
      );
    });
  }
  if (policy.diagnostic) lines.push(policy.diagnostic);
  lines.push("Configured fallbacks are availability targets. This listing is the policy, not a run.");
  lines.push("Fast is requested configuration, not a provider grant.");
  lines.push("agent_run reports the selected target and fallback reason separately.");
  return lines.join("\n");
}

export function inspectPitako(args: string, options?: LoadOptions): string {
  const [command, value] = args.trim().split(/\s+/, 2);
  if (command === "roles") return formatRoleList(loadPitakoConfig(options));
  if (command === "policies") return formatPolicyList(loadPitakoConfig(options));
  if (command === "role") {
    if (!value) throw new Error("Usage: /pitako role <id>");
    return formatRole(resolveRole(value, options));
  }
  if (command === "policy") {
    if (!value) throw new Error("Usage: /pitako policy <id>");
    return formatPolicy(resolveModelPolicy(value, options));
  }
  throw new Error(`Unknown Pitako command "${command}". Expected profile, roles, role, policies, or policy.`);
}

function bullet(names: readonly string[]): string[] {
  return names.length > 0 ? names.map((name) => `  ${name}`) : ["  none"];
}
