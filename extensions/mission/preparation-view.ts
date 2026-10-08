import type { MissionDefinition } from "./model.ts";
import type { PreparationIssue, preparationContext } from "./preparation.ts";
import type { SetupAllocation } from "./setup.ts";

/** Presentation only. Callers retain and recheck the complete canonical consent bytes. */
export function preparationView(input: {
  action: string;
  context: ReturnType<typeof preparationContext>;
  definition: MissionDefinition;
  setup?: SetupAllocation;
  setupDestination?: string;
  issues?: PreparationIssue[];
  interpretations?: Array<{ sourceId: string; disposition: "context" | "criterion" }>;
}): string {
  const { action, context, definition, setup } = input;
  const { binding } = context, { authority, budget } = definition;
  return [
    `Action: ${action}`,
    `Plan: ${binding.planId} @${binding.revision}`,
    `Source: ${binding.planSource}`,
    `Execution root: ${binding.executionRoot}`,
    setup?.effectProfile === "execution-root-local-copy-v1"
      ? "Runs now after native consent: the real scripts/setup.sh in an owned copied capsule; no provider or worker runs."
      : "Runs now: host validation and preparation admission only; no setup, command, provider or worker runs.",
    `Write scope on start: ${authority.allowedPaths.join(", ") || "(none)"}`,
    `Operations on start: ${authority.operations.join(", ") || "(none)"}`,
    `External effects: ${authority.externalEffects.join(", ") || "(none)"}`,
    `Budgets (exact): roleLaunches=${budget.roleLaunches}; providerRequests=${budget.providerRequests}; tokens=${budget.tokens}; activeTimeMs=${budget.activeTimeMs}; artifactBytes=${budget.artifactBytes}`,
    setup ? `Setup allocation (inside root budgets): ${setup.effectProfile}; writes=${setup.writableDirectories.join(", ")}; activeTimeMs=${setup.activeTimeMs}; artifactBytes=${setup.artifactBytes}. ${setup.copy ? "Prepare executes setup on private byte copies; host inputs remain read-only and networking is denied." : "Execution still requires separate start consent; no current setup proof."}`
      : "Setup allocation: none proposed.",
    ...(setup?.copy ? [`Output bounds (exact): paths=${setup.copy.bounds.paths}; largestFileBytes=${setup.copy.bounds.largestFileBytes}; totalBytes=${setup.copy.bounds.totalBytes}`,
      `Private setup destination: ${input.setupDestination ?? "bound in the host canonical setup identity; not a host source write"}`,
      ...setup.copy.seeds.map((seed) => `Local seed: ${seed.source} → ${seed.destination}; paths=${seed.bounds.paths}; largestFileBytes=${seed.bounds.largestFileBytes}; totalBytes=${seed.bounds.totalBytes}. Seed is not setup proof.`)] : []),
    ...Object.entries(authority.rolePolicies).map(([role, policy]) =>
      `Role ${role}: primary=${JSON.stringify(policy.primaryTarget)}; fallbacks=${JSON.stringify(policy.fallbackTargets)}; policy=${policy.hash}`),
    `Verification authority: ${authority.verificationProfiles?.includes("sealed-nested-verification-v1")
      ? "sealed-nested-verification-v1 granted; used only by commands explicitly selecting that profile, not by ordinary commands or workers."
      : "ordinary contained commands only; nested verification not granted."}`,
    `Verification capability: ${definition.units.flatMap(({ acceptance }) => acceptance.map((predicate) =>
      `${predicate.id}: ${predicate.kind}${predicate.kind === "command_exit" ? ` (${predicate.command}) — ${predicate.profile === "sealed-nested-verification-v1"
        ? "sealed-nested-verification-v1 selected: nested namespaces and private IPC; no host writes, host credentials or external connectivity; extra kernel capability relative to workers" +
          (authority.verificationProfiles?.includes("sealed-nested-verification-v1") ? "" : "; authority not granted, execution inadmissible")
        : "ordinary contained command only; nested verification not selected"}` : ""}`)).join("; ")}`,
    `Resume after close: ${authority.resumeAfterClose}; technical amendments: ${authority.allowTechnicalAmendments}`,
    ...(input.interpretations ?? []).map(({ sourceId, disposition }) => {
      const region = context.inventory.unresolved.find(({ id }) => id === sourceId);
      return `preparation-interpretation: ${sourceId} → ${disposition}\nExact source excerpt: ${region?.text}`;
    }),
    ...(input.issues ?? []).map(({ code, owner, message, nextAction }) => `${code} [${owner}]: ${message}\nNext action: ${nextAction}`),
    `Still requires /mission start ${binding.planId}: separate execution consent, ${setup?.copy ? "rechecking and reusing settled copied setup proof" : "any required setup execution/settlement"}, and worker dispatch. Preparation is not verification evidence.`,
  ].join("\n");
}
