import type { MissionDefinition, MissionEvent, ResourceAmounts } from "./model.ts";

export const RESOURCE_FIELDS = {
  "role-launches": "roleLaunches", "provider-requests": "providerRequests", tokens: "tokens",
  "active-time-ms": "activeTimeMs", "artifact-bytes": "artifactBytes",
} as const;
export type Resource = keyof typeof RESOURCE_FIELDS;
export type ResourcePolicy =
  | { kind: "legacy-capped"; limits: ResourceAmounts; estimates: Partial<ResourceAmounts> }
  | { kind: "explicit"; limits: Partial<ResourceAmounts>; estimates: Partial<ResourceAmounts> };

export function resourcePolicy(definition: MissionDefinition): ResourcePolicy {
  return definition.schemaVersion === 3
    ? { kind: "explicit", ...definition.resourcePolicy }
    : { kind: "legacy-capped", limits: definition.budget, estimates: {} };
}

export function resourceLimit(definition: MissionDefinition, resource: Resource): number | undefined {
  return resourcePolicy(definition).limits[RESOURCE_FIELDS[resource]];
}

export function resourceAuthority(definition: MissionDefinition) {
  return definition.schemaVersion === 3 ? { authority: definition.authority, resourcePolicy: definition.resourcePolicy } :
    { authority: definition.authority, budget: definition.budget };
}

// A concrete output/closure guard, not a whole-mission allocation or an estimate.
export const ARTIFACT_OPERATION_BYTES = 32 * 1024 * 1024;

/** Allocation arithmetic uses only caps. Zero means no numeric allocation, never permission. */
export function resourceAllocations(definition: MissionDefinition): ResourceAmounts {
  if (definition.schemaVersion !== 3) return definition.budget;
  const limits = definition.resourcePolicy.limits;
  const launches = definition.units.reduce((sum, unit) => sum + (unit.team ? unit.team.members.length * 3 + 1 : 1), 3);
  return { roleLaunches: limits.roleLaunches ?? launches, providerRequests: limits.providerRequests ?? launches + 1,
    tokens: limits.tokens ?? 0, activeTimeMs: limits.activeTimeMs ?? 0,
    artifactBytes: limits.artifactBytes ?? ARTIFACT_OPERATION_BYTES * launches };
}

export const HARD_TOKEN_CAP_UNSUPPORTED =
  "hard token caps are unsupported by the Pi adapter: dispatch supplies no conservative input bound and does not enforce an output bound; omit the token limit for metered execution";

export function assertSupportedResourcePolicy(definition: MissionDefinition): void {
  if (definition.schemaVersion === 3 && definition.resourcePolicy.limits.tokens !== undefined)
    throw new Error(HARD_TOKEN_CAP_UNSUPPORTED);
}

export interface MeteredTicket {
  kind: "metered";
  ticketId: string;
  operationId: string;
  resource: Resource;
  revision: number;
  ownerEpoch: number;
}
export interface MeteredConsumption extends MeteredTicket {
  knownCharge: number;
  unknown: boolean;
  outstanding: boolean;
}

export function meteredConsumptions(events: MissionEvent[]): MeteredConsumption[] {
  return events.filter(event => event.kind === "resource.metered.admitted").map(event => {
    const ticket = event.payload.ticket as MeteredTicket;
    const settlement = events.filter(row => row.kind === "resource.metered.settled" &&
      row.payload.ticketId === ticket.ticketId).at(-1);
    return { ...ticket, knownCharge: Number(settlement?.payload.knownCharge ?? event.payload.knownCharge ?? 0),
      unknown: settlement?.payload.unknown === true,
      outstanding: (settlement?.payload.outstanding ?? event.payload.outstanding) !== false };
  });
}

export type TimeAdmission =
  | { kind: "metered"; ticketId: string }
  | { kind: "capped"; reservationId: string; remainingMs: number }
  | { kind: "revoked"; reason: string };

export function timeAllows(admission: TimeAdmission, executionMs: number): boolean {
  return executionMs > 0 && admission.kind !== "revoked" &&
    (admission.kind === "metered" || executionMs <= admission.remainingMs);
}
