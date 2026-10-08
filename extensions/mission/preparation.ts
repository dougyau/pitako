import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { repositoryIdentity } from "../board/workspace.ts";
import { loadPitakoConfig, resolveRoleFromConfig, type LoadOptions } from "../roles/load.ts";
import { resolveFrozenPlanBinding, verifyExecutionBinding, type ExecutionBinding } from "../workflow.ts";
import { consumeOperatorInput, type OperatorReceipt } from "./admission.ts";
import { compileFinalizationGrants } from "./finalization.ts";
import { assertCommandTime } from "./command-time.ts";
import { sha256, validateMissionDefinition, type MissionDefinition } from "./model.ts";
import { inventoryFrozenSource, type SourceInventory } from "./source-inventory.ts";
import { assertSetupInputs, captureSetupIdentity, setupRequiredBy, type PreparedSetup, type SetupAllocation } from "./setup.ts";

export interface PreparationIssue {
  code: "invalid-proposal" | "missing-mapping" | "source-meaning" | "authority-choice" | "setup-choice" |
    "unsupported-observer" | "missing-local-input" | "insufficient-grant" | "stale-binding" | "unresolved-setup";
  owner: "author" | "runtime" | "principal";
  nextAction: string;
  kind: "source" | "authority" | "evidence" | "prerequisite" | "budget";
  message: string;
  sourceId?: string;
  excerpt?: string;
}
export interface EvidenceMapping {
  sourceId: string;
  predicateIds: string[];
  explanation: string;
}
export interface PreparedMission {
  format: "prepared-mission-v1";
  binding: ExecutionBinding;
  repositoryFamily: string;
  originalSource: string;
  inventory: SourceInventory;
  configIdentity: string;
  gates: { path: string; bytes: string | null };
  answers: Array<{ sourceId: string; disposition: "context" | "criterion"; receiptId: string; text: string }>;
  authorityDecision: { receiptId: string; text: string };
  mappings: EvidenceMapping[];
  definition: MissionDefinition;
  setup?: PreparedSetup;
}
export interface PreparationRequest { readonly id: string }
export interface PreparationInput { request: PreparationRequest; proposal: unknown; setup?: SetupAllocation }
export type PreparationResult =
  // state preserves the v1 admission contract; status describes actual start readiness.
  | { state: "needs-input"; status: "needs-real-user-decision" | "technical-unresolved"; nextAction: string; binding: ExecutionBinding; issues: PreparationIssue[] }
  | { state: "ready"; status: "ready" | "technical-unresolved"; nextAction: string; issues: PreparationIssue[]; prepared: PreparedMission; digest: string };

const repairs = {
  "invalid-proposal": ["author", "Correct the proposal through mission_prepare; do not request additional permission."],
  "missing-mapping": ["author", "Supply an independent source-to-predicate mapping through mission_prepare."],
  "source-meaning": ["principal", "Choose whether the exact source excerpt is context or a required criterion."],
  "authority-choice": ["principal", "Review the proposed permissions and five finite budgets in native confirmation."],
  "setup-choice": ["principal", "Review the separate bounded setup effects in native confirmation."],
  "unsupported-observer": ["author", "Select a supported discriminating observer; a producer identity is not proof."],
  "missing-local-input": ["runtime", "Inspect the named local prerequisite; no broader permission or automatic retry is authorized."],
  "insufficient-grant": ["author", "Propose a feasible finite allocation preserving the mandatory path and finalization."],
  "stale-binding": ["runtime", "Repeat /mission prepare to bind current source, configuration and physical root."],
  "unresolved-setup": ["runtime", "Setup has not executed or settled. The legacy route requires separate /mission start consent; preparation is not ready-to-start proof."],
} as const;
export function preparationIssue(code: PreparationIssue["code"], kind: PreparationIssue["kind"], message: string,
  row?: { id: string; text: string }): PreparationIssue {
  return { code, kind, message, owner: repairs[code][0], nextAction: repairs[code][1],
    ...(row ? { sourceId: row.id, excerpt: row.text } : {}) };
}
function unresolved(binding: ExecutionBinding, issues: PreparationIssue[]): PreparationResult {
  const technical = issues.some(({ owner }) => owner !== "principal");
  return { state: "needs-input", status: technical ? "technical-unresolved" : "needs-real-user-decision", binding, issues,
    nextAction: issues.find(({ owner }) => technical ? owner !== "principal" : owner === "principal")!.nextAction };
}
export class PreparationBindingError extends Error {
  readonly issue: PreparationIssue;
  constructor(message: string) {
    super(message);
    this.issue = preparationIssue("stale-binding", "prerequisite", message);
  }
}
interface HostRequest {
  request: PreparationRequest;
  sessionId: string;
  source: ReturnType<typeof resolveFrozenPlanBinding>;
  config: ReturnType<typeof captureConfig>;
  load: LoadOptions;
  gates: PreparedMission["gates"];
  inventory: SourceInventory;
  physical: ReturnType<typeof physicalIdentity>;
  authority?: { values: Pick<MissionDefinition, "authority" | "budget">; receiptId: string; text: string };
  answers: PreparedMission["answers"];
  setup?: Omit<PreparedSetup, "requiredBy">;
}
const requests = new WeakMap<PreparationRequest, HostRequest>();
const preparedObjects = new WeakMap<PreparedMission, { request: PreparationRequest; digest: string }>();
const digest = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function captureConfig(load: LoadOptions) {
  const config = loadPitakoConfig(load);
  const roles = Object.fromEntries(Object.keys(config.roles).map((id) => {
    const role = resolveRoleFromConfig(config, id);
    const primary = role.modelPolicy.primary;
    return [id, { hash: digest(role), primary, fallbacks: [...role.modelPolicy.fallbacks], resolved: role }];
  }));
  return { roles, identity: digest({ config, roles }) };
}
function readGates(root: string) {
  const file = path.join(root, "GATES.md");
  return { path: file, bytes: existsSync(file) ? readFileSync(file, "utf8") : null };
}
function physicalIdentity(binding: ExecutionBinding) {
  const inode = (file: string) => { const row = statSync(file); return `${row.dev}:${row.ino}`; };
  const git = path.join(binding.executionRoot, ".git");
  return { root: inode(binding.executionRoot), git: inode(git), source: inode(binding.planSource),
    gitBytes: statSync(git).isFile() ? sha256(readFileSync(git)) : null };
}

/** Host adapter entry: independently reads pinned source, configuration and GATES. No setup or writer. */
export function openPreparationRequest(id: string, cwd: string, sessionId: string, load: LoadOptions = {}): PreparationRequest {
  if (!sessionId) throw new Error("preparation requires a principal-session identity");
  const source = resolveFrozenPlanBinding(id, cwd);
  const request = Object.freeze({ id: randomUUID() });
  requests.set(request, { request, sessionId, source, load: { ...load, cwd: source.binding.executionRoot },
    config: captureConfig({ ...load, cwd: source.binding.executionRoot }), gates: readGates(source.binding.executionRoot),
    inventory: inventoryFrozenSource(source.text), physical: physicalIdentity(source.binding), answers: [] });
  return request;
}
function hostRequest(request: PreparationRequest): HostRequest {
  const host = requests.get(request);
  if (!host) throw new PreparationBindingError("current host-owned preparation request required");
  try {
    const current = verifyExecutionBinding(host.source.binding);
    if (current.text !== host.source.text || captureConfig(host.load).identity !== host.config.identity ||
      digest(readGates(host.source.binding.executionRoot)) !== digest(host.gates) ||
      digest(physicalIdentity(host.source.binding)) !== digest(host.physical))
      throw new Error("preparation source/configuration/procedure changed");
  } catch (error) { throw new PreparationBindingError(String(error)); }
  return host;
}
export function preparationContext(request: PreparationRequest) {
  const host = hostRequest(request);
  return structuredClone({ requestId: request.id, binding: host.source.binding, source: host.source.text,
    inventory: host.inventory, roles: host.config.roles, gates: host.gates,
    producers: [
      { id: "mission-setup-input-v1", route: "MissionSetup / scripts/setup.sh",
        requirements: ["execution-root-local-v1 native allocation", "bounded physical local inputs", "contained hook success and process settlement"],
        proof: "descriptor only; no setup receipt or supported-route observation" },
      { id: "mission-setup-input-v2", route: "prepare-scoped MissionSetup / copied scripts/setup.sh",
        requirements: ["execution-root-local-copy-v1 native allocation", "disclosed local installed-dependency/cache seeds",
          "finite explicit output bounds", "owned byte-copy capsule", "contained actual hook and settled byte-copy publication"],
        proof: "descriptor only; no setup receipt, readiness or supported-route observation" },
      { id: "command_exit", route: "host production checker",
        requirements: ["bound command bytes", "explicit bash authority", "finite allocation", "supported contained runtime"],
        proof: "descriptor only; no command observation or source-meaning certification" },
      { id: "artifact_hash", route: "host production checker",
        requirements: ["exact expected SHA-256", "bound artifact input"], proof: "descriptor only; no artifact observation" },
      ...(existsSync(path.join(host.source.binding.executionRoot, "scripts/verify-mission.ts")) ? [{
        id: "verify:mission", route: "scripts/verify-mission.ts",
        requirements: ["explicit stage and distinct --evidence-dir", "stage-specific local inputs and runtime capabilities",
          "independent source mapping", "contained command authority"],
        proof: "descriptor only; stage script is not imported or executed; nested verification capability is not established",
      }] : []),
    ] });
}
export function invalidatePreparationRequest(request: PreparationRequest): void {
  requests.delete(request);
}

/** Separate host setup-effect choice; author proposals cannot supply this approval. */
export function preparationSetupText(request: PreparationRequest, values: SetupAllocation): string {
  const host = hostRequest(request);
  return JSON.stringify({ action: "preparation-setup-effects", requestId: request.id, sessionId: host.sessionId,
    configIdentity: host.config.identity, identity: captureSetupIdentity(host.source.binding, values), values });
}
export function bindPreparationSetup(request: PreparationRequest, values: SetupAllocation, receipt: OperatorReceipt): void {
  const host = hostRequest(request);
  const text = preparationSetupText(request, values);
  if (receipt.source !== "native-confirmation") throw new Error("setup effects require separate native confirmation");
  consumeOperatorInput(receipt, host.sessionId, text);
  host.setup = { identity: captureSetupIdentity(host.source.binding, values),
    decision: { values: structuredClone(values), receiptId: receipt.id, source: receipt.source, text } };
}

/** Exact host receipt, not a proposal's approval flag. T3 supplies its UI adapter. */
export function bindPreparationAuthority(request: PreparationRequest,
  values: Pick<MissionDefinition, "authority" | "budget">, receipt: OperatorReceipt): void {
  const host = hostRequest(request);
  const text = preparationAuthorityText(request, values);
  if (values.authority.verificationProfiles && receipt.source !== "native-confirmation")
    throw new Error("nested verification authority requires explicit native confirmation");
  consumeOperatorInput(receipt, host.sessionId, text);
  host.authority = { values: structuredClone(values), receiptId: receipt.id, text };
}
export function preparationAuthorityText(request: PreparationRequest, values: Pick<MissionDefinition, "authority" | "budget">): string {
  const host = hostRequest(request);
  return JSON.stringify({ action: "preparation-authority", requestId: request.id,
    binding: host.source.binding, configIdentity: host.config.identity, values });
}
export function bindPreparationAnswer(request: PreparationRequest, sourceId: string, disposition: "context" | "criterion",
  receipt: OperatorReceipt): void {
  const host = hostRequest(request);
  const text = preparationAnswerText(request, sourceId, disposition);
  consumeOperatorInput(receipt, host.sessionId, text);
  host.answers = [...host.answers.filter((row) => row.sourceId !== sourceId), { sourceId, disposition, receiptId: receipt.id, text }];
}
export function preparationAnswerText(request: PreparationRequest, sourceId: string, disposition: "context" | "criterion"): string {
  const host = hostRequest(request);
  const region = host.inventory.unresolved.find(({ id }) => id === sourceId);
  if (!region || !["context", "criterion"].includes(disposition)) throw new Error("answer requires an exact unresolved source region");
  return JSON.stringify({ action: "preparation-interpretation", requestId: request.id,
    binding: host.source.binding, region, disposition });
}

/** Validate proposal relationships against independently owned source, never its inventory. */
export function validatePreparation(input: PreparationInput): PreparationResult {
  const host = hostRequest(input.request);
  const binding = host.source.binding;
  const issues: PreparationIssue[] = [];
  const issue = (kind: PreparationIssue["kind"], message: string, row?: { id: string; text: string },
    code: PreparationIssue["code"] = "invalid-proposal") =>
    issues.push(preparationIssue(code, kind, message, row));
  const proposal = input.proposal;
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal) ||
    Object.keys(proposal).sort().join() !== "definition,mappings")
    return unresolved(binding, [preparationIssue("invalid-proposal", "source", "proposal requires definition and mappings only; inventory is host-owned")]);
  const row = proposal as { definition: unknown; mappings: unknown };
  for (const criterion of host.inventory.criteria) {
    const matches = Array.isArray(row.mappings) ? row.mappings.filter((value) =>
      value && typeof value === "object" && value.sourceId === criterion.id) : [];
    if (matches.length !== 1) issue("source", "original criterion needs exactly one mapping", criterion, "missing-mapping");
  }
  let definition: MissionDefinition;
  try { definition = validateMissionDefinition(row.definition); }
  catch (error) { return unresolved(binding, [...issues, preparationIssue("invalid-proposal", "evidence", String(error))]); }
  if (definition.schemaVersion !== 2) issue("source", "generated preparation requires executable schema 2");
  const inventory = inventoryFrozenSource(host.source.text);
  for (const region of inventory.unresolved) {
    if (!host.answers.some(({ sourceId }) => sourceId === region.id)) issue("source", region.issue, region, "source-meaning");
  }
  const criteria = [...inventory.criteria, ...inventory.unresolved.filter((region) =>
    host.answers.some((answer) => answer.sourceId === region.id && answer.disposition === "criterion"))];
  const mappings: EvidenceMapping[] = [];
  if (!Array.isArray(row.mappings)) issue("source", "mappings must be an array");
  else for (const value of row.mappings) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== "explanation,predicateIds,sourceId" ||
      typeof value.sourceId !== "string" || !Array.isArray(value.predicateIds) || !value.predicateIds.length ||
      !value.predicateIds.every((id: unknown) => typeof id === "string") || typeof value.explanation !== "string" || !value.explanation.trim())
      issue("source", "mapping requires exact sourceId, nonempty predicateIds and explanation");
    else mappings.push(structuredClone(value));
  }
  const predicates = new Map(definition.units.flatMap((unit) => unit.acceptance.map((predicate) => [predicate.id, predicate] as const)));
  const phases = definition.finalization.selections;
  for (const criterion of criteria) {
    const matches = mappings.filter(({ sourceId }) => sourceId === criterion.id);
    if (matches.length !== 1) { issue("source", "original criterion needs exactly one mapping", criterion, "missing-mapping"); continue; }
    for (const id of matches[0]!.predicateIds) {
      if (!predicates.has(id)) issue("evidence", `criterion references missing predicate ${id}`, criterion);
      if (!(criterion.owner === "mission" ? phases?.final : phases?.ordinary)?.includes(id))
        issue("evidence", `criterion lacks its required ${criterion.owner === "mission" ? "final" : "ordinary"} phase`, criterion);
    }
  }
  for (const mapping of mappings) if (!criteria.some(({ id }) => id === mapping.sourceId))
    issue("source", `mapping references unknown criterion ${mapping.sourceId}`);
  for (const unit of inventory.units) {
    const executable = definition.units.find(({ id }) => id === unit.engineId);
    if (!executable) { issue("source", "original unit missing from executable definition", unit); continue; }
    if (executable.kind !== "implementation" && executable.kind !== "check") issue("prerequisite", "initial generated profile supports ordinary implementation/check units", unit);
    const objective = inventory.context.filter((row) => row.owner === unit.engineId && row.role === "objective").map(({ text }) => text).join("");
    const originalCriteria = criteria.filter(({ owner }) => owner === unit.engineId).map((criterion) => ({
      sourceId: criterion.id, text: criterion.text, predicateIds: mappings.find(({ sourceId }) => sourceId === criterion.id)?.predicateIds ?? [],
    }));
    if (digest(executable.originalIntent) !== digest({ sourceId: unit.id, objective, workBrief: unit.text, criteria: originalCriteria }))
      issue("source", "original objective/WorkBrief/criterion bytes must match host source", unit);
  }
  for (const unit of definition.units) if (!inventory.units.some(({ engineId }) => engineId === unit.id))
    issue("source", `executable unit ${unit.id} has no original unit`);
  for (const edge of inventory.dependencies) if (!definition.units.find(({ id }) => id === edge.unitId)?.dependencies.includes(edge.requires))
    issue("source", `required ${edge.basis} dependency missing: ${edge.unitId} -> ${edge.requires}`);
  if (!host.authority) issue("authority", "explicit host-bound permission and five-budget decision required", undefined, "authority-choice");
  else if (digest(host.authority.values) !== digest({ authority: definition.authority, budget: definition.budget }))
    issue("authority", "proposal does not preserve exact approved authority/budgets", undefined, "authority-choice");
  const setupPath = path.join(binding.executionRoot, "scripts/setup.sh");
  // lstat observation must not turn a dangling hook into optional absence.
  let hookPresent = false;
  try { hookPresent = Boolean(lstatSync(setupPath)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") issue("prerequisite", String(error), undefined, "missing-local-input"); }
  if (hookPresent && !host.setup) issue("authority", "execution-root setup hook requires separate host setup-effect decision", undefined, "setup-choice");
  if (input.setup) {
    const values = input.setup;
    if (!["execution-root-local-v1", "execution-root-local-copy-v1"].includes(values.effectProfile) || !Number.isSafeInteger(values.activeTimeMs) ||
      values.activeTimeMs < 1 || !Number.isSafeInteger(values.artifactBytes) || values.artifactBytes < 16_384 ||
      !Array.isArray(values.writableDirectories) || values.writableDirectories.length !== 1 || values.writableDirectories[0] !== "node_modules")
      issue("prerequisite", "proposed setup requires the supported profile, node_modules output and finite positive allocation (artifactBytes >= 16384)",
        undefined, "invalid-proposal");
    else {
      if (!host.setup || digest(values) !== digest(host.setup.decision.values)) {
        try { captureSetupIdentity(binding, values); }
        catch (error) { issue("prerequisite", String(error), undefined, "missing-local-input"); }
        issue("authority", "proposed setup allocation requires exact native setup-effect decision", undefined, "setup-choice");
      }
    }
  }
  if (host.setup) {
    try { assertSetupInputs(host.setup); } catch (error) { issue("prerequisite", String(error), undefined, "missing-local-input"); }
  }
  for (const [role, policy] of Object.entries(definition.authority.rolePolicies)) {
    const frozen = host.config.roles[role];
    if (!frozen?.primary || policy.hash !== frozen.hash || digest(policy.primaryTarget) !== digest(frozen.primary) ||
      digest(policy.fallbackTargets) !== digest(frozen.fallbacks))
      issue("authority", `role ${role} must preserve complete host-resolved policy`);
  }
  for (const predicate of predicates.values()) {
    if (predicate.kind === "manual") issue("evidence", `unsupported observer ${predicate.id}: manual has no positive production assessor`, undefined, "unsupported-observer");
    if (predicate.kind === "command_exit" && (!predicate.command || !definition.authority.operations.includes("bash")))
      issue("prerequisite", `contained command ${predicate.id} requires command bytes and explicit bash permission`, undefined,
        predicate.command ? "insufficient-grant" : "invalid-proposal");
    if (predicate.kind === "command_exit") {
      if (predicate.profile && !definition.authority.verificationProfiles?.includes(predicate.profile))
        issue("authority", `${predicate.id}: checker-only profile requires explicit native authority`, undefined, "authority-choice");
      try { assertCommandTime(predicate.timeoutMs); }
      catch (error) { issue("budget", `${predicate.id}: ${String(error)}`, undefined, "insufficient-grant"); }
    }
    if (predicate.kind === "artifact_hash" && !/^[0-9a-f]{64}$/.test(predicate.expected ?? ""))
      issue("evidence", `${predicate.id} requires exact bound artifact bytes, not a false-PASS explanation`);
  }
  try {
    const grants = compileFinalizationGrants(definition);
    const setupAllocation = input.setup ?? host.setup?.decision.values;
    if (setupAllocation) {
      const ordinary = definition.units.reduce((sum, unit) => sum + (unit.team ? unit.team.members.length * 3 + 1 : 1), 0);
      if (ordinary * grants.active + grants.protectedAmounts["active-time-ms"] + setupAllocation.activeTimeMs > definition.budget.activeTimeMs ||
        ordinary * grants.artifacts + grants.protectedAmounts["artifact-bytes"] + setupAllocation.artifactBytes > definition.budget.artifactBytes)
        issue("budget", "setup allocation must preserve mandatory path and protected finalization capacity", undefined, "insufficient-grant");
    }
  } catch (error) { issue("budget", String(error), undefined, "insufficient-grant"); }
  if (issues.length) return unresolved(binding, issues);
  const prepared = freeze<PreparedMission>({ format: "prepared-mission-v1", binding: structuredClone(binding),
    repositoryFamily: repositoryIdentity(binding.executionRoot), originalSource: host.source.text, inventory,
    configIdentity: host.config.identity, gates: host.gates, answers: structuredClone(host.answers),
    authorityDecision: { receiptId: host.authority!.receiptId, text: host.authority!.text }, mappings, definition,
    ...(host.setup ? { setup: { ...structuredClone(host.setup), requiredBy: setupRequiredBy(host.setup.identity, definition) } } : {}) });
  const hash = digest(prepared);
  preparedObjects.set(prepared, { request: input.request, digest: hash });
  const pendingSetup = host.setup ? [{ ...preparationIssue("unresolved-setup", "prerequisite",
    "The admitted setup contract has no current successful settled native setup receipt."),
    ...(host.setup.identity.copy ? { nextAction:
      "Copied setup must execute and settle during prepare after exact native consent; start cannot bootstrap or replay it." } : {}) }] : [];
  return { state: "ready", status: pendingSetup.length ? "technical-unresolved" : "ready",
    nextAction: pendingSetup[0]?.nextAction ?? `Use /mission start ${binding.planId} for separate execution consent.`,
    issues: pendingSetup, prepared, digest: hash };
}

/** Runtime admission choke point: serialized or caller-branded objects have no authority. */
export function assertPreparedAdmission(prepared: PreparedMission): string {
  const issued = preparedObjects.get(prepared);
  if (!issued || issued.digest !== digest(prepared)) throw new Error("host-validated prepared object required");
  hostRequest(issued.request);
  if (prepared.setup) assertSetupInputs(prepared.setup);
  return issued.digest;
}

/** Final native confirmation is distinct from approving preparation's authority values. */
export function preparedAdmissionText(prepared: PreparedMission): string {
  const hash = assertPreparedAdmission(prepared);
  return JSON.stringify({ action: "admit-prepared-mission", requestId: preparedObjects.get(prepared)!.request.id,
    preparedHash: hash, binding: prepared.binding });
}

export function consumePreparedAdmission(prepared: PreparedMission, receipt: OperatorReceipt): void {
  const text = preparedAdmissionText(prepared);
  const host = hostRequest(preparedObjects.get(prepared)!.request);
  consumeOperatorInput(receipt, host.sessionId, text);
}
