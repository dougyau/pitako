import { createHash } from "node:crypto";

export const MISSION_SCHEMA_VERSION = 1;
const ID = /^[a-z0-9][a-z0-9_-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export type UnitKind = "implementation" | "check" | "consultation" | "team";
export type AcceptancePredicate = {
  id: string;
  kind: "command_exit" | "artifact_hash" | "manual";
  target: string;
  expected?: string;
  command?: string;
  timeoutMs?: number;
};

export interface MissionUnit {
  id: string;
  team?: {
    version: 1;
    phase: "planning" | "execution" | "review";
    members: Array<{ id: string; role: string; perspective: string }>;
    synthesisRole: string;
  };
  parentId?: string;
  dependencies: string[];
  kind: UnitKind;
  role: string;
  inputs: string[];
  outputs: string[];
  acceptance: AcceptancePredicate[];
  risk: "low" | "medium" | "high" | "critical";
  retryLimit: number;
}

export interface MissionDefinition {
  schemaVersion: 1;
  goal: string;
  scope: string[];
  nonGoals: string[];
  invariants: string[];
  authority: {
    allowedPaths: string[];
    operations: string[];
    externalEffects: string[];
    rolePolicies: Record<string, { hash: string; provider: string; model: string; fallbacks: string[] }>;
    allowTechnicalAmendments: boolean;
    resumeAfterClose: boolean;
  };
  budget: {
    roleLaunches: number;
    providerRequests: number;
    tokens: number;
    activeTimeMs: number;
    artifactBytes: number;
  };
  finalization: { requiredPredicates: string[]; independentReview: boolean; contractVersion?: 1 };
  units: MissionUnit[];
}

export interface PlanSnapshot {
  schemaVersion: 1;
  planId: string;
  revision: number;
  sourcePath: string;
  planHash: string;
  definitionHash: string;
  parentRevision: number | null;
  admissionProvenance: { kind: "operator" | "model"; receiptId: string };
  units: Array<{ id: string; parentId?: string }>;
}

export interface MissionRecord {
  id: string;
  repositoryId: string;
  planId: string;
  revision: number;
  state: "prepared" | "running" | "blocked" | "completing" | "completed" | "paused" | "cancelled";
  version: number;
  latestSeq: number;
  snapshot: PlanSnapshot;
  definition: MissionDefinition;
}

export interface MissionMeasurement {
  schemaVersion: 1;
  id: string;
  missionId: string;
  revision: number;
  causalId: string;
  metric: string;
  value: number | null;
  unit: string;
  source: string;
  occurredAt: string;
  runtimeId: string;
  durationMs: number | null;
  unknownReason?: string;
  unitId?: string;
  attemptId?: string;
  effectId?: string;
  teamRoundId?: string;
  provider?: string;
  model?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  usageUnknownReason?: string;
}

export interface EvaluationObservation {
  schemaVersion: 1;
  id: string;
  missionId: string;
  revision: number;
  resultManifestHash: string;
  criterionVersion: string;
  evaluatorIdentity: string;
  method: string;
  observedAt: string;
  windowStart: string | null;
  windowEnd: string | null;
  evidenceRefs: string[];
  verdict: "pass" | "fail" | "inconclusive" | "unassessed";
  classification: "outcome" | "confirmed_defect" | "operator_intervention";
  supersedesId: string | null;
}

export interface MissionEvent {
  eventId: string;
  schemaVersion: 1;
  missionId: string;
  revision: number;
  seq: number;
  kind: string;
  causalId: string;
  occurredAt: string;
  runtimeId: string;
  monotonicDurationMs: number | null;
  unitId: string | null;
  attemptId: string | null;
  effectId: string | null;
  teamRoundId: string | null;
  reason: string | null;
  provenance: Record<string, unknown> | null;
  payload: Record<string, unknown>;
}

export class MissionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionValidationError";
  }
}

export function validateMissionDefinitionBytes(bytes: Uint8Array): { definition: MissionDefinition; hash: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new MissionValidationError(`mission definition is not valid UTF-8 JSON: ${messageOf(error)}`);
  }
  const definition = validateMissionDefinition(parsed);
  return { definition, hash: sha256(bytes) };
}

export function validateMissionDefinition(value: unknown): MissionDefinition {
  const root = object(value, "mission definition");
  exactKeys(root, ["schemaVersion", "goal", "scope", "nonGoals", "invariants", "authority", "budget", "finalization", "units"], "mission definition");
  if (root.schemaVersion !== MISSION_SCHEMA_VERSION) throw new MissionValidationError(`mission definition schema ${String(root.schemaVersion)} is not supported`);
  const goal = text(root.goal, "goal");
  const scope = textList(root.scope, "scope");
  const nonGoals = textList(root.nonGoals, "nonGoals");
  const invariants = textList(root.invariants, "invariants");
  const authorityValue = object(root.authority, "authority");
  exactKeys(authorityValue, ["allowedPaths", "operations", "externalEffects", "rolePolicies", "allowTechnicalAmendments", "resumeAfterClose"], "authority");
  const rolePolicyRows = object(authorityValue.rolePolicies, "authority.rolePolicies");
  const rolePolicies: MissionDefinition["authority"]["rolePolicies"] = {};
  for (const [roleKey, entry] of Object.entries(rolePolicyRows)) {
    const role = identifier(roleKey, "role policy id");
    const policy = object(entry, `role policy ${role}`);
    exactKeys(policy, ["hash", "provider", "model", "fallbacks"], `role policy ${role}`);
    const hash = text(policy.hash, `${role}.hash`);
    if (!SHA256.test(hash)) throw new MissionValidationError(`${role}.hash must be a lowercase SHA-256 digest`);
    rolePolicies[role] = {
      hash,
      provider: text(policy.provider, `${role}.provider`),
      model: text(policy.model, `${role}.model`),
      fallbacks: textList(policy.fallbacks, `${role}.fallbacks`),
    };
  }
  const authority = {
    allowedPaths: textList(authorityValue.allowedPaths, "authority.allowedPaths"),
    operations: textList(authorityValue.operations, "authority.operations"),
    externalEffects: textList(authorityValue.externalEffects, "authority.externalEffects"),
    rolePolicies,
    allowTechnicalAmendments: boolean(authorityValue.allowTechnicalAmendments, "authority.allowTechnicalAmendments"),
    resumeAfterClose: boolean(authorityValue.resumeAfterClose, "authority.resumeAfterClose"),
  };

  const budgetValue = object(root.budget, "budget");
  exactKeys(budgetValue, ["roleLaunches", "providerRequests", "tokens", "activeTimeMs", "artifactBytes"], "budget");
  const budget = {
    roleLaunches: positiveInteger(budgetValue.roleLaunches, "budget.roleLaunches"),
    providerRequests: positiveInteger(budgetValue.providerRequests, "budget.providerRequests"),
    tokens: positiveInteger(budgetValue.tokens, "budget.tokens"),
    activeTimeMs: positiveInteger(budgetValue.activeTimeMs, "budget.activeTimeMs"),
    artifactBytes: positiveInteger(budgetValue.artifactBytes, "budget.artifactBytes"),
  };

  const finalizationValue = object(root.finalization, "finalization");
  exactKeys(finalizationValue, ["requiredPredicates", "independentReview"], "finalization", ["contractVersion"]);
  if (finalizationValue.contractVersion !== undefined && finalizationValue.contractVersion !== 1)
    throw new MissionValidationError("unsupported finalization contract version");
  const finalization = {
    requiredPredicates: textList(finalizationValue.requiredPredicates, "finalization.requiredPredicates"),
    independentReview: boolean(finalizationValue.independentReview, "finalization.independentReview"),
    ...(finalizationValue.contractVersion === 1 ? { contractVersion: 1 as const } : {}),
  };
  if (finalization.contractVersion === 1 && !finalization.independentReview)
    throw new MissionValidationError("completion contract version 1 requires whole-result independent review");
  if (finalization.requiredPredicates.length === 0) throw new MissionValidationError("finalization.requiredPredicates must not be empty");

  if (!Array.isArray(root.units) || root.units.length === 0) throw new MissionValidationError("units must be a non-empty array");
  const units = root.units.map((entry, index) => validateUnit(entry, index));
  validateUnitGraph(units);
  for (const unit of units) {
    if (!rolePolicies[unit.role]) throw new MissionValidationError(`${unit.id} references missing role policy ${unit.role}`);
    if (unit.team) for (const role of [...unit.team.members.map(({ role }) => role), unit.team.synthesisRole])
      if (!rolePolicies[role]) throw new MissionValidationError(`${unit.id} references missing team role policy ${role}`);
  }
  const predicateIds = new Set(units.flatMap((unit) => unit.acceptance.map(({ id }) => id)));
  for (const id of finalization.requiredPredicates) {
    if (!predicateIds.has(id)) throw new MissionValidationError(`finalization references unknown predicate ${id}`);
  }
  return { schemaVersion: 1, goal, scope, nonGoals, invariants, authority, budget, finalization, units };
}

export function validateEvaluationObservation(value: unknown, missionId: string): EvaluationObservation {
  const row = object(value, "evaluation observation");
  exactKeys(row, ["schemaVersion", "id", "missionId", "revision", "resultManifestHash", "criterionVersion", "evaluatorIdentity", "method", "observedAt", "windowStart", "windowEnd", "evidenceRefs", "verdict", "classification", "supersedesId"], "evaluation observation");
  if (row.schemaVersion !== 1) throw new MissionValidationError(`evaluation observation schema ${String(row.schemaVersion)} is not supported`);
  const id = uuid(row.id, "observation id");
  const rowMissionId = uuid(row.missionId, "observation missionId");
  if (rowMissionId !== missionId) throw new MissionValidationError("observation missionId does not match target mission");
  const resultManifestHash = text(row.resultManifestHash, "resultManifestHash");
  if (!SHA256.test(resultManifestHash)) throw new MissionValidationError("resultManifestHash must be a lowercase SHA-256 digest");
  const verdict = oneOf(row.verdict, ["pass", "fail", "inconclusive", "unassessed"], "verdict");
  const classification = oneOf(row.classification, ["outcome", "confirmed_defect", "operator_intervention"], "classification");
  const windowStart = nullableTimestamp(row.windowStart, "windowStart");
  const windowEnd = nullableTimestamp(row.windowEnd, "windowEnd");
  if (windowStart && windowEnd && Date.parse(windowEnd) < Date.parse(windowStart)) throw new MissionValidationError("observation windowEnd precedes windowStart");
  if (row.supersedesId === id) throw new MissionValidationError("observation cannot supersede itself");
  return {
    schemaVersion: 1,
    id,
    missionId: rowMissionId,
    revision: positiveInteger(row.revision, "observation revision"),
    resultManifestHash,
    criterionVersion: text(row.criterionVersion, "criterionVersion"),
    evaluatorIdentity: text(row.evaluatorIdentity, "evaluatorIdentity"),
    method: text(row.method, "method"),
    observedAt: timestamp(row.observedAt, "observedAt"),
    windowStart,
    windowEnd,
    evidenceRefs: textList(row.evidenceRefs, "evidenceRefs"),
    verdict,
    classification,
    supersedesId: row.supersedesId === null ? null : uuid(row.supersedesId, "supersedesId"),
  };
}

export function validateMeasurement(value: unknown, missionId: string): MissionMeasurement {
  const row = object(value, "measurement");
  exactKeys(row, ["schemaVersion", "id", "missionId", "revision", "causalId", "metric", "value", "unit", "source", "occurredAt", "runtimeId", "durationMs", "inputTokens", "outputTokens"], "measurement", ["unknownReason", "unitId", "attemptId", "effectId", "teamRoundId", "provider", "model", "usageUnknownReason"]);
  if (row.schemaVersion !== 1) throw new MissionValidationError(`measurement schema ${String(row.schemaVersion)} is not supported`);
  const rowMissionId = uuid(row.missionId, "measurement missionId");
  if (rowMissionId !== missionId) throw new MissionValidationError("measurement missionId does not match target mission");
  const valueNumber = row.value === null ? null : finiteNumber(row.value, "measurement value");
  const inputTokens = nullableNonnegativeInteger(row.inputTokens, "inputTokens");
  const outputTokens = nullableNonnegativeInteger(row.outputTokens, "outputTokens");
  const usageUnknownReason = optionalText(row.usageUnknownReason, "usageUnknownReason");
  if ((inputTokens === null || outputTokens === null) && !usageUnknownReason) throw new MissionValidationError("unknown token usage requires usageUnknownReason");
  const unknownReason = optionalText(row.unknownReason, "unknownReason");
  if (valueNumber === null && !unknownReason) throw new MissionValidationError("unknown measurement value requires unknownReason");
  if (valueNumber !== null && unknownReason) throw new MissionValidationError("known measurement value cannot have unknownReason");
  const optionalId = (key: string) => row[key] === undefined ? undefined : idText(row[key], key);
  return {
    schemaVersion: 1,
    id: uuid(row.id, "measurement id"),
    missionId: rowMissionId,
    revision: positiveInteger(row.revision, "measurement revision"),
    causalId: uuid(row.causalId, "measurement causalId"),
    metric: text(row.metric, "metric"),
    value: valueNumber,
    unit: text(row.unit, "unit"),
    source: text(row.source, "source"),
    occurredAt: timestamp(row.occurredAt, "occurredAt"),
    runtimeId: uuid(row.runtimeId, "runtimeId"),
    durationMs: row.durationMs === null ? null : nonnegativeNumber(row.durationMs, "durationMs"),
    ...(unknownReason ? { unknownReason } : {}),
    ...(optionalId("unitId") ? { unitId: optionalId("unitId") } : {}),
    ...(optionalId("attemptId") ? { attemptId: optionalId("attemptId") } : {}),
    ...(optionalId("effectId") ? { effectId: optionalId("effectId") } : {}),
    ...(optionalId("teamRoundId") ? { teamRoundId: optionalId("teamRoundId") } : {}),
    ...(row.provider === undefined ? {} : { provider: text(row.provider, "provider") }),
    ...(row.model === undefined ? {} : { model: text(row.model, "model") }),
    inputTokens,
    outputTokens,
    ...(usageUnknownReason ? { usageUnknownReason } : {}),
  };
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function validateUnit(value: unknown, index: number): MissionUnit {
  const row = object(value, `units[${index}]`);
  exactKeys(row, ["id", "dependencies", "kind", "role", "inputs", "outputs", "acceptance", "risk", "retryLimit"], `units[${index}]`, ["parentId", "team"]);
  const id = identifier(row.id, `units[${index}].id`);
  if (row.kind !== "team" && row.team !== undefined) throw new MissionValidationError(`${id} team contract requires kind team`);
  let team: MissionUnit["team"];
  if (row.team !== undefined) {
    const contract = object(row.team, `${id}.team`);
    exactKeys(contract, ["version", "phase", "members", "synthesisRole"], `${id}.team`);
    if (contract.version !== 1) throw new MissionValidationError(`${id} unsupported team version`);
    if (!Array.isArray(contract.members) || contract.members.length < 3 || contract.members.length > 5)
      throw new MissionValidationError(`${id} team requires 3–5 members`);
    const members = contract.members.map((value: unknown, memberIndex: number) => {
      const member = object(value, `${id}.team.members[${memberIndex}]`);
      exactKeys(member, ["id", "role", "perspective"], `${id}.team member`);
      return { id: identifier(member.id, `${id}.team member id`), role: identifier(member.role, `${id}.team role`), perspective: text(member.perspective, `${id}.team perspective`) };
    });
    if (new Set(members.map(({ id }) => id)).size !== members.length) throw new MissionValidationError(`${id} duplicate team member`);
    team = { version: 1, phase: oneOf(contract.phase, ["planning", "execution", "review"], `${id}.team phase`),
      members, synthesisRole: identifier(contract.synthesisRole, `${id}.team synthesisRole`) };
  }
  if (!Array.isArray(row.acceptance)) throw new MissionValidationError(`${id}.acceptance must be an array`);
  const acceptance = row.acceptance.map((entry, predicateIndex): AcceptancePredicate => {
    const predicate = object(entry, `${id}.acceptance[${predicateIndex}]`);
    exactKeys(predicate, ["id", "kind", "target"], `${id} predicate`, ["expected", "command", "timeoutMs"]);
    const kind = oneOf(predicate.kind, ["command_exit", "artifact_hash", "manual"], `${id}.predicate.kind`);
    return {
      id: identifier(predicate.id, `${id}.predicate.id`),
      kind,
      target: text(predicate.target, `${id}.predicate.target`),
      ...(predicate.expected === undefined ? {} : { expected: text(predicate.expected, `${id}.predicate.expected`) }),
      ...(predicate.command === undefined ? {} : { command: text(predicate.command, `${id}.predicate.command`) }),
      ...(predicate.timeoutMs === undefined ? {} : { timeoutMs: positiveInteger(predicate.timeoutMs, `${id}.predicate.timeoutMs`) }),
    };
  });
  if (acceptance.length === 0) throw new MissionValidationError(`${id}.acceptance must not be empty`);
  const retryLimit = nonnegativeInteger(row.retryLimit, `${id}.retryLimit`);
  if (retryLimit > 2) throw new MissionValidationError(`${id}.retryLimit must be at most 2`);
  return {
    id,
    ...(team ? { team } : {}),
    ...(row.parentId === undefined ? {} : { parentId: identifier(row.parentId, `${id}.parentId`) }),
    dependencies: identifierList(row.dependencies, `${id}.dependencies`),
    kind: oneOf(row.kind, ["implementation", "check", "consultation", "team"], `${id}.kind`),
    role: identifier(row.role, `${id}.role`),
    inputs: textList(row.inputs, `${id}.inputs`),
    outputs: textList(row.outputs, `${id}.outputs`),
    acceptance,
    risk: oneOf(row.risk, ["low", "medium", "high", "critical"], `${id}.risk`),
    retryLimit,
  };
}

function validateUnitGraph(units: MissionUnit[]): void {
  const byId = new Map<string, MissionUnit>();
  const predicates = new Set<string>();
  for (const unit of units) {
    if (byId.has(unit.id)) throw new MissionValidationError(`duplicate unit id ${unit.id}`);
    byId.set(unit.id, unit);
    for (const predicate of unit.acceptance) {
      if (predicates.has(predicate.id)) throw new MissionValidationError(`duplicate acceptance predicate ${predicate.id}`);
      predicates.add(predicate.id);
    }
  }
  for (const unit of units) {
    for (const id of [...unit.dependencies, ...(unit.parentId ? [unit.parentId] : [])]) {
      if (!byId.has(id)) throw new MissionValidationError(`${unit.id} references unknown unit ${id}`);
    }
    if (unit.dependencies.includes(unit.id) || unit.parentId === unit.id) throw new MissionValidationError(`${unit.id} cannot depend on or parent itself`);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) throw new MissionValidationError(`unit dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    active.delete(id);
    visited.add(id);
  };
  for (const unit of units) visit(unit.id);

  const visitedParents = new Set<string>();
  const activeParents = new Set<string>();
  const visitParent = (id: string): void => {
    if (activeParents.has(id)) throw new MissionValidationError(`presentation parent cycle includes ${id}`);
    if (visitedParents.has(id)) return;
    activeParents.add(id);
    const parentId = byId.get(id)!.parentId;
    if (parentId) visitParent(parentId);
    activeParents.delete(id);
    visitedParents.add(id);
  };
  for (const unit of units) visitParent(unit.id);
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new MissionValidationError(`${label} must be an object`);
  }
  return value as Record<string, any>;
}

function exactKeys(value: Record<string, unknown>, required: string[], label: string, optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length || missing.length) {
    throw new MissionValidationError(`${label} keys invalid${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new MissionValidationError(`${label} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function textList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new MissionValidationError(`${label} must be an array`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new MissionValidationError(`${label} contains duplicates`);
  return result;
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label);
  if (!ID.test(result)) throw new MissionValidationError(`${label} must be a lowercase stable identifier`);
  return result;
}

function identifierList(value: unknown, label: string): string[] {
  return textList(value, label).map((entry, index) => identifier(entry, `${label}[${index}]`));
}

function idText(value: unknown, label: string): string {
  const result = text(value, label);
  if (!ID.test(result)) throw new MissionValidationError(`${label} must be a stable identifier`);
  return result;
}

function uuid(value: unknown, label: string): string {
  if (!isUuid(value)) throw new MissionValidationError(`${label} must be a UUID`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new MissionValidationError(`${label} must be a boolean`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonnegativeInteger(value, label);
  if (result < 1) throw new MissionValidationError(`${label} must be a positive integer`);
  return result;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new MissionValidationError(`${label} must be a nonnegative safe integer`);
  return value;
}

function nullableNonnegativeInteger(value: unknown, label: string): number | null {
  return value === null ? null : nonnegativeInteger(value, label);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new MissionValidationError(`${label} must be finite`);
  return value;
}

function nonnegativeNumber(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result < 0) throw new MissionValidationError(`${label} must be nonnegative`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new MissionValidationError(`${label} must be an ISO UTC timestamp`);
  }
  return result;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function oneOf<const T extends readonly string[]>(value: unknown, options: T, label: string): T[number] {
  if (typeof value !== "string" || !options.includes(value)) throw new MissionValidationError(`${label} must be one of ${options.join(", ")}`);
  return value as T[number];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
