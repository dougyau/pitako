import { missionDefinition } from "./mission-fixtures.ts";
import type { preparationContext } from "../extensions/mission/preparation.ts";

// Offline wiring only: no product/result/assessor is supplied and no mission is started.
export const authoringSource = `---
id: durable-fixture
revision: 1
status: frozen
execution: expected
---
# Ordinary source change
## Goal
Reject empty input without changing valid input.
## Ordered work units
### T1 — Fix input
Objective: reject empty input.
Scope: src/a
Acceptance:
- Valid input still works.
- Empty input is rejected.
Expected evidence: discriminating Node checks.
## Final verification and success
- Complete production checks and independent review.
`;

export function authoringProposal(context: ReturnType<typeof preparationContext>) {
  const definition = missionDefinition();
  definition.schemaVersion = 2;
  definition.authority = { allowedPaths: ["src/a"], operations: ["read", "write", "bash"], externalEffects: [],
    rolePolicies: {}, allowTechnicalAmendments: false, resumeAfterClose: false };
  for (const id of ["developer", "reviewer"]) {
    const policy = context.roles[id]!, primary = policy.primary!, split = primary.model.indexOf("/");
    definition.authority.rolePolicies[id] = { hash: policy.hash, provider: primary.model.slice(0, split),
      model: primary.model.slice(split + 1), fallbacks: policy.fallbacks.map(({ model }) => model),
      primaryTarget: primary, fallbackTargets: policy.fallbacks };
  }
  // Disposable host-dialog fixture grant, NOT user authority for a configured-model demonstration.
  definition.budget = { roleLaunches: 6, providerRequests: 10, tokens: 100000,
    activeTimeMs: 600000, artifactBytes: 67108864 };
  const mappings = context.inventory.criteria.map(({ id }, n) => ({
    sourceId: id, predicateIds: [`proof-${n}`], explanation: "Run discriminating Node check; wiring fixture does not establish proof adequacy.",
  }));
  definition.units = context.inventory.units.map((unit) => ({
    id: unit.engineId, kind: "implementation", role: "developer", dependencies: [], inputs: ["src/a"], outputs: ["src/a"],
    risk: "low", retryLimit: 0,
    originalIntent: { sourceId: unit.id, objective: context.inventory.context.filter(({ owner, role }) =>
      owner === unit.engineId && role === "objective").map(({ text }) => text).join(""), workBrief: unit.text,
      criteria: context.inventory.criteria.filter(({ owner }) => owner === unit.engineId).map(({ id, text }) => ({
        sourceId: id, text, predicateIds: mappings.find(({ sourceId }) => sourceId === id)!.predicateIds,
      })) },
    acceptance: mappings.map(({ predicateIds }) => ({ id: predicateIds[0]!, kind: "command_exit",
      target: "discriminating Node check", command: "node --check src/a", timeoutMs: 1000 })),
  }));
  const final = mappings.flatMap(({ predicateIds }) => predicateIds);
  definition.finalization = { contractVersion: 1, independentReview: true, requiredPredicates: final,
    selections: { ordinary: final.slice(0, -1), integrated: [final[0]!], affected: [final[1]!], final } };
  return { definition, mappings };
}
