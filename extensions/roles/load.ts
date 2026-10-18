import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { parse } from "smol-toml";
import { CONFIG_KEYS } from "./config-keys.ts";
import { getPitakoConfigPath } from "../board/paths.ts";
import { DEFAULT_SKILL_NAMES, OPTIONAL_LANGUAGE_SKILLS } from "../catalog.ts";
import { PitakoConfigError } from "../errors.ts";
import { DEFAULT_WATCHDOG, mergeWatchdog, parseWatchdogConfig } from "../agent/watchdog.ts";
import { packageRoot } from "../stack.ts";
import {
  ROLE_IDS,
  DEVELOPER_PROFILES,
  type DeveloperProfile,
  isReasoningLevel,
  type ModelCapability,
  type ModelPolicy,
  type ModelTarget,
  type PitakoConfig,
  type ReasoningLevel,
  type ResolvedModelPolicy,
  type ResolvedRole,
  type RoleDefinition,
} from "./types.ts";

export interface LoadOptions {
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  userConfigPath?: string;
  /** When set, model ids must match Pi's provider/id form and reasoning must be supported. */
  availableModels?: readonly ModelCapability[];
}

const { root: ROOT_KEYS, role: ROLE_KEYS, policy: POLICY_KEYS, target: TARGET_KEYS } = CONFIG_KEYS;
const KNOWN_SKILLS = new Set<string>([...DEFAULT_SKILL_NAMES, ...OPTIONAL_LANGUAGE_SKILLS]);

export function loadPitakoConfig(options: LoadOptions = {}): PitakoConfig {
  const userConfigPath = options.userConfigPath ?? getPitakoConfigPath(options.env, options.cwd);
  return parsePitakoConfig(existsSync(userConfigPath) ? readFileSync(userConfigPath, "utf8") : undefined, options);
}

/** Parse a snapshot at its real user path, without writing or rereading that file. */
export function parsePitakoConfig(source: string | undefined, options: LoadOptions = {}): PitakoConfig {
  const root = options.packageRoot ?? packageRoot();
  const defaultsPath = path.join(root, "config", "defaults.toml");
  const userConfigPath = options.userConfigPath ?? getPitakoConfigPath(options.env, options.cwd);
  const builtin = parseBuiltin(defaultsPath, root);
  const user = parseUserConfig(source, userConfigPath);
  return mergeConfig(builtin, user, userConfigPath, options.availableModels);
}

export function getRole(id: string, options?: LoadOptions): RoleDefinition {
  return requireRole(loadPitakoConfig(options), id);
}

export function getModelPolicy(id: string, options?: LoadOptions): ModelPolicy {
  return requirePolicy(loadPitakoConfig(options), id);
}

export function resolveRole(id: string, options?: LoadOptions): ResolvedRole {
  return resolveRoleFromConfig(loadPitakoConfig(options), id);
}

export function resolveModelPolicy(id: string, options?: LoadOptions): ResolvedModelPolicy {
  const config = loadPitakoConfig(options);
  return resolvePolicy(requirePolicy(config, id), config.userConfigPath);
}

export function resolveRoleFromConfig(config: PitakoConfig, id: string, profile: DeveloperProfile = "developer_mid"): ResolvedRole {
  const role = requireRole(config, id);
  const policyId = id === "developer" ? profile : role.modelPolicy;
  const modelPolicy = resolvePolicy(requirePolicy(config, policyId), config.userConfigPath);
  return freeze({
    id: role.id,
    name: role.name,
    description: role.description,
    instructionsPath: role.instructionsPath,
    instructions: role.instructions,
    skills: Object.freeze([...role.skills]),
    principles: Object.freeze([...role.principles]),
    modelPolicyId: policyId,
    modelPolicy,
  });
}

/** Host-only Head resolution. Public role lookup deliberately does not expose it. */
export function resolveDeveloperHeadFromConfig(config: PitakoConfig): ResolvedRole {
  const role = config.developerHead;
  return freeze({
    id: role.id,
    name: role.name,
    description: role.description,
    instructionsPath: role.instructionsPath,
    instructions: role.instructions,
    skills: Object.freeze([...role.skills]),
    principles: Object.freeze([...role.principles]),
    modelPolicyId: role.modelPolicy,
    modelPolicy: resolvePolicy(requirePolicy(config, role.modelPolicy), config.userConfigPath),
  });
}

function developerHead(role: RoleDefinition, instructionsPath: string): RoleDefinition {
  return {
    ...role, id: "developer_head", name: "Head Developer",
    description: "Coordinates bounded Developer work and integrates its verified outcome.",
    modelPolicy: "developer_head", instructionsPath,
    instructions: `${role.instructions}\n\n${readInstructions(instructionsPath, instructionsPath)}`,
  };
}

function parseBuiltin(defaultsPath: string, root: string): PitakoConfig {
  const raw = readToml(defaultsPath);
  const roles = parseRoles(raw.roles, defaultsPath, root, root);
  const policies = concretePolicies(parsePolicyTables(raw.policies, defaultsPath), defaultsPath);
  for (const id of ROLE_IDS) {
    if (!roles[id]) throw new PitakoConfigError(`${defaultsPath}: missing built-in role "${id}"`);
  }
  for (const id of Object.keys(roles)) {
    if (!(ROLE_IDS as readonly string[]).includes(id)) {
      throw new PitakoConfigError(`${defaultsPath}: unknown role "${id}"`);
    }
  }
  return { defaultsPath, userConfigPath: "", userConfigPresent: false, roles, policies, watchdog: parseWatchdogConfig(raw.watchdog, defaultsPath),
    developerHead: developerHead(roles.developer!, resolveInstructions(defaultsPath, "roles/developer-head.md", root, root)),
    developerRouting: parseDeveloperRouting(raw.developerRouting, defaultsPath),
    headDeveloper: parseHeadDeveloper(raw.headDeveloper, defaultsPath),
    workerHistory: parseWorkerHistory(raw.workerHistory, defaultsPath) };
}

interface UserConfig {
  architecture?: unknown;
  review?: unknown;
  present: boolean;
  roles: Record<string, RawRole>;
  policies: Record<string, RawPolicy>;
  watchdog?: unknown;
  workerHistory?: unknown;
  developerRouting?: unknown;
  headDeveloper?: unknown;
}

function parseUserConfig(source: string | undefined, userConfigPath: string): UserConfig {
  if (source === undefined) return { present: false, roles: {}, policies: {} };
  const raw = parseToml(source, userConfigPath);
  return {
    present: true,
    architecture: raw.architecture,
    review: raw.review,
    roles: parseRoleOverrides(raw.roles, userConfigPath),
    policies: parsePolicyTables(raw.policies, userConfigPath) ?? {},
    watchdog: raw.watchdog,
    workerHistory: raw.workerHistory,
    developerRouting: raw.developerRouting,
    headDeveloper: raw.headDeveloper,
  };
}

function mergeConfig(
  builtin: PitakoConfig,
  user: UserConfig,
  userConfigPath: string,
  availableModels: readonly ModelCapability[] | undefined,
): PitakoConfig {
  const roles: Record<string, RoleDefinition> = {};
  for (const id of Object.keys(user.roles)) {
    if (!builtin.roles[id]) throw new PitakoConfigError(`${userConfigPath}: roles.${id}: unknown role "${id}"`);
  }
  for (const [id, role] of Object.entries(builtin.roles)) {
    roles[id] = mergeRole(role, user.roles[id], userConfigPath);
  }
  for (const id of Object.keys(user.policies)) {
    if (!builtin.policies[id]) {
      throw new PitakoConfigError(`${userConfigPath}: model_policies.${id}: unknown model policy "${id}"`);
    }
  }
  const policies: Record<string, ModelPolicy> = {};
  for (const [id, policy] of Object.entries(builtin.policies)) {
    policies[id] = (DEVELOPER_PROFILES as readonly string[]).includes(id) ? policy : mergePolicy(policy, user.policies[id], userConfigPath);
  }
  for (const role of Object.values(roles)) {
    if (!policies[role.modelPolicy]) {
      const file = user.roles[role.id]?.modelPolicy !== undefined ? userConfigPath : builtin.defaultsPath;
      throw new PitakoConfigError(`${file}: roles.${role.id}.model_policy: unknown model policy "${role.modelPolicy}"`);
    }
  }
  const legacyId = roles.developer!.modelPolicy;
  const legacy = user.policies[legacyId];
  for (const id of DEVELOPER_PROFILES) {
    const base = mergePolicy(builtin.policies[id]!, legacy, userConfigPath);
    const explicit = user.policies[id];
    policies[id] = {
      ...mergePolicy(base, explicit, userConfigPath),
      provenance: {
        legacyPolicy: legacyId, configPath: userConfigPath,
        primary: explicit?.primary !== undefined ? id : legacy?.primary !== undefined ? legacyId : "bundled-empty",
        fallbacks: explicit?.fallbacks !== undefined ? id : legacy?.fallbacks !== undefined ? legacyId : "bundled-empty",
      },
    };
  }
  const config: PitakoConfig = {
    architecture: parseCandidates(user.architecture, userConfigPath, "architecture"),
    review: parseCandidates(user.review, userConfigPath, "review"),
    defaultsPath: builtin.defaultsPath,
    userConfigPath,
    userConfigPresent: user.present,
    roles,
    policies,
    developerHead: developerHead(roles.developer!, builtin.developerHead.instructionsPath),
    developerRouting: parseDeveloperRouting(user.developerRouting, userConfigPath, builtin.developerRouting),
    headDeveloper: parseHeadDeveloper(user.headDeveloper, userConfigPath, builtin.headDeveloper),
    watchdog: mergeWatchdog(builtin.watchdog ?? DEFAULT_WATCHDOG, user.watchdog, userConfigPath),
    workerHistory: parseWorkerHistory(user.workerHistory, userConfigPath, builtin.workerHistory),
  };
  if (availableModels) validateAgainstModels(config, availableModels);
  return config;
}

function mergeRole(base: RoleDefinition, override: RawRole | undefined, userConfigPath: string): RoleDefinition {
  if (!override) return base;
  const instructionsPath = override.instructions
    ? resolveInstructions(userConfigPath, override.instructions, path.dirname(userConfigPath))
    : base.instructionsPath;
  return {
    id: base.id,
    name: override.name ?? base.name,
    description: override.description ?? base.description,
    instructionsPath,
    instructions: override.instructions ? readInstructions(instructionsPath, userConfigPath) : base.instructions,
    skills: override.skills ?? base.skills,
    principles: override.principles ?? base.principles,
    modelPolicy: override.modelPolicy ?? base.modelPolicy,
  };
}

function mergePolicy(base: ModelPolicy, override: RawPolicy | undefined, userConfigPath: string): ModelPolicy {
  if (!override) return base;
  const primary = override.primary === undefined ? base.primary : override.primary;
  const fallbacks = override.fallbacks === undefined ? base.fallbacks : override.fallbacks;
  if (!primary && fallbacks.length > 0) {
    throw new PitakoConfigError(`${userConfigPath}: model_policies.${base.id}: primary target missing`);
  }
  assertUniqueTargets(base.id, primary, fallbacks, userConfigPath);
  return { id: base.id, primary, fallbacks };
}

function assertUniqueTargets(id: string, primary: ModelTarget | undefined, fallbacks: readonly ModelTarget[], file: string): void {
  const seen = new Set<string>();
  if (primary) seen.add(targetKey(primary));
  fallbacks.forEach((target, index) => {
    const key = targetKey(target);
    if (seen.has(key)) {
      throw new PitakoConfigError(
        `${file}: model_policies.${id}.fallbacks[${index}]: duplicate target ${target.model}${target.reasoning ? ` / ${target.reasoning}` : ""}`,
      );
    }
    seen.add(key);
  });
}

function targetKey(target: ModelTarget): string {
  return `${target.model}\0${target.reasoning ?? ""}\0${target.fast ?? false}`;
}

function validateAgainstModels(config: PitakoConfig, models: readonly ModelCapability[]): void {
  for (const policy of Object.values(config.policies)) {
    const targets = [policy.primary, ...policy.fallbacks].filter((target): target is ModelTarget => target !== undefined);
    for (const target of targets) {
      const match = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === target.model.toLowerCase());
      const field = `model_policies.${policy.id}`;
      if (match.length !== 1) {
        throw new PitakoConfigError(
          `${config.userConfigPath}: ${field}: unknown model "${target.model}". Expected an exact provider/model id.`,
        );
      }
      if (!target.reasoning) continue;
      const supported = getSupportedThinkingLevels(match[0] as Model<never>);
      if (!supported.includes(target.reasoning)) {
        throw new PitakoConfigError(
          `${config.userConfigPath}: ${field}: reasoning "${target.reasoning}" is not supported by ${target.model}. Supported: ${supported.join(", ")}.`,
        );
      }
    }
  }
}

function resolvePolicy(policy: ModelPolicy, userConfigPath: string): ResolvedModelPolicy {
  const resolved: ResolvedModelPolicy = {
    id: policy.id,
    primary: policy.primary,
    fallbacks: Object.freeze([...policy.fallbacks]),
    requested: policy.primary,
    selected: policy.primary,
    provenance: policy.provenance,
  };
  if (!policy.primary) {
    resolved.diagnostic = `model policy "${policy.id}" has no primary target. Set [model_policies.${policy.id}.primary] in ${userConfigPath}.`;
  }
  return Object.freeze(resolved);
}

function requireRole(config: PitakoConfig, id: string): RoleDefinition {
  const role = config.roles[id];
  if (!role) throw new PitakoConfigError(`unknown role "${id}"`);
  return role;
}

function requirePolicy(config: PitakoConfig, id: string): ModelPolicy {
  const policy = config.policies[id];
  if (!policy) throw new PitakoConfigError(`unknown model policy "${id}"`);
  return policy;
}

interface RawDocument {
  architecture: unknown;
  review: unknown;
  roles: unknown;
  policies: unknown;
  watchdog: unknown;
  workerHistory: unknown;
  developerRouting: unknown;
  headDeveloper: unknown;
}

function parseDeveloperRouting(
  value: unknown, file: string,
  base: PitakoConfig["developerRouting"] = { classifierProvider: "opencode", classifierModel: "jev-1.13-free" },
): PitakoConfig["developerRouting"] {
  if (value === undefined) return base;
  const table = expectRecord(value, file, "developer_routing");
  rejectUnknown(table, CONFIG_KEYS.developer_routing, file, "developer_routing");
  const classifierProvider = optionalString(table.classifier_provider, file, "developer_routing.classifier_provider") ?? base.classifierProvider;
  const classifierModel = optionalString(table.classifier_model, file, "developer_routing.classifier_model") ?? base.classifierModel;
  if (/[/\s]/.test(classifierProvider)) {
    throw new PitakoConfigError(`${file}: developer_routing.classifier_provider: expected a provider id`);
  }
  if (/\s/.test(classifierModel)) {
    throw new PitakoConfigError(`${file}: developer_routing.classifier_model: expected a model id`);
  }
  return { classifierProvider, classifierModel };
}

function parseHeadDeveloper(
  value: unknown, file: string, base: PitakoConfig["headDeveloper"] = { maxParallel: 3 },
): PitakoConfig["headDeveloper"] {
  if (value === undefined) return base;
  const table = expectRecord(value, file, "head_developer");
  rejectUnknown(table, CONFIG_KEYS.head_developer, file, "head_developer");
  const maxParallel = table.max_parallel === undefined ? base.maxParallel : table.max_parallel;
  if (typeof maxParallel !== "number" || !Number.isSafeInteger(maxParallel) || maxParallel <= 0) {
    throw new PitakoConfigError(`${file}: head_developer.max_parallel: expected a positive safe integer`);
  }
  return { maxParallel };
}

function parseWorkerHistory(value: unknown, file: string, base: PitakoConfig["workerHistory"] = { ttlDays: 180 }): PitakoConfig["workerHistory"] {
  if (value === undefined) return base;
  const table = expectRecord(value, file, "worker_history");
  rejectUnknown(table, CONFIG_KEYS.worker_history, file, "worker_history");
  const ttlDays = table.ttl_days ?? base.ttlDays;
  if (ttlDays !== false && (typeof ttlDays !== "number" || !Number.isSafeInteger(ttlDays) || ttlDays <= 0))
    throw new PitakoConfigError(`${file}: worker_history.ttl_days: expected a positive integer or false`);
  return { ttlDays };
}

interface RawRole {
  name?: string;
  description?: string;
  instructions?: string;
  modelPolicy?: string;
  skills?: string[];
  principles?: string[];
}

interface RawPolicy {
  primary?: ModelTarget;
  fallbacks?: ModelTarget[];
}

function readToml(file: string): RawDocument {
  if (!existsSync(file)) throw new PitakoConfigError(`${file}: file is missing`);
  return parseToml(readFileSync(file, "utf8"), file);
}

function parseToml(source: string, file: string): RawDocument {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    throw new PitakoConfigError(`${file}: invalid TOML (${error instanceof Error ? error.message : String(error)})`);
  }
  const record = expectRecord(parsed, file, "");
  rejectUnknown(record, ROOT_KEYS, file, "");
  return { architecture: record.architecture, review: record.review, roles: record.roles, policies: record.model_policies, watchdog: record.agent_runtime, workerHistory: record.worker_history,
    developerRouting: record.developer_routing, headDeveloper: record.head_developer };
}

function parseRoles(value: unknown, file: string, packageRootDir: string, stayInside: string): Record<string, RoleDefinition> {
  if (value === undefined) throw new PitakoConfigError(`${file}: missing roles table`);
  const record = expectRecord(value, file, "roles");
  const roles: Record<string, RoleDefinition> = {};
  for (const [id, raw] of Object.entries(record)) {
    roles[id] = parseRole(id, raw, file, packageRootDir, stayInside, true);
  }
  return roles;
}

function parseRoleOverrides(value: unknown, file: string): Record<string, RawRole> {
  if (value === undefined) return {};
  const record = expectRecord(value, file, "roles");
  const roles: Record<string, RawRole> = {};
  for (const [id, raw] of Object.entries(record)) {
    const table = expectRecord(raw, file, `roles.${id}`);
    rejectUnknown(table, ROLE_KEYS, file, `roles.${id}`);
    roles[id] = {
      name: optionalString(table.name, file, `roles.${id}.name`),
      description: optionalString(table.description, file, `roles.${id}.description`),
      instructions: optionalString(table.instructions, file, `roles.${id}.instructions`),
      modelPolicy: optionalString(table.model_policy, file, `roles.${id}.model_policy`),
      skills: table.skills === undefined ? undefined : stringList(table.skills, file, `roles.${id}.skills`),
      principles: table.principles === undefined ? undefined : stringList(table.principles, file, `roles.${id}.principles`),
    };
    if (roles[id]?.skills) assertKnownNames(roles[id].skills ?? [], file, `roles.${id}.skills`);
    if (roles[id]?.principles) assertKnownNames(roles[id].principles ?? [], file, `roles.${id}.principles`);
  }
  return roles;
}

function parseRole(
  id: string,
  value: unknown,
  file: string,
  baseDir: string,
  stayInside: string,
  required: boolean,
): RoleDefinition {
  const table = expectRecord(value, file, `roles.${id}`);
  rejectUnknown(table, ROLE_KEYS, file, `roles.${id}`);
  const name = requiredString(table.name, file, `roles.${id}.name`);
  const description = requiredString(table.description, file, `roles.${id}.description`);
  const instructions = requiredString(table.instructions, file, `roles.${id}.instructions`);
  const modelPolicy = requiredString(table.model_policy, file, `roles.${id}.model_policy`);
  const skills = stringList(table.skills, file, `roles.${id}.skills`);
  const principles = stringList(table.principles, file, `roles.${id}.principles`);
  assertKnownNames(skills, file, `roles.${id}.skills`);
  assertKnownNames(principles, file, `roles.${id}.principles`);
  const instructionsPath = resolveInstructions(file, instructions, baseDir, stayInside);
  if (!required) throw new PitakoConfigError(`${file}: roles.${id}: incomplete role`);
  return {
    id,
    name,
    description,
    instructionsPath,
    instructions: readInstructions(instructionsPath, file),
    skills,
    principles,
    modelPolicy,
  };
}

function parsePolicyTables(value: unknown, file: string): Record<string, RawPolicy> | undefined {
  if (value === undefined) return undefined;
  const record = expectRecord(value, file, "model_policies");
  const policies: Record<string, RawPolicy> = {};
  for (const [id, raw] of Object.entries(record)) {
    const table = expectRecord(raw, file, `model_policies.${id}`);
    rejectUnknown(table, POLICY_KEYS, file, `model_policies.${id}`);
    policies[id] = {
      primary: table.primary === undefined ? undefined : parseTarget(table.primary, file, `model_policies.${id}.primary`),
      fallbacks: table.fallbacks === undefined ? undefined : parseFallbacks(table.fallbacks, file, `model_policies.${id}.fallbacks`),
    };
  }
  return policies;
}

function concretePolicies(value: Record<string, RawPolicy> | undefined, file: string): Record<string, ModelPolicy> {
  if (!value) throw new PitakoConfigError(`${file}: missing model_policies table`);
  const policies: Record<string, ModelPolicy> = {};
  for (const [id, policy] of Object.entries(value)) {
    policies[id] = { id, primary: policy.primary, fallbacks: policy.fallbacks ?? [] };
  }
  return policies;
}

function parseFallbacks(value: unknown, file: string, field: string): ModelTarget[] {
  if (!Array.isArray(value)) throw new PitakoConfigError(`${file}: ${field}: expected an array`);
  return value.map((item, index) => parseTarget(item, file, `${field}[${index}]`));
}

function parseTarget(value: unknown, file: string, field: string): ModelTarget {
  const table = expectRecord(value, file, field);
  rejectUnknown(table, TARGET_KEYS, file, field);
  if (table.model === undefined) throw new PitakoConfigError(`${file}: ${field}: empty fallback target`);
  const model = parseModelId(requiredString(table.model, file, `${field}.model`), file, `${field}.model`);
  const reasoning = table.reasoning === undefined ? undefined : parseReasoning(table.reasoning, file, `${field}.reasoning`);
  const fast = table.fast === undefined ? undefined : parseFast(table.fast, file, `${field}.fast`);
  const target: ModelTarget = { model };
  if (reasoning !== undefined) target.reasoning = reasoning;
  if (fast !== undefined) target.fast = fast;
  return target;
}

export function parseModelId(value: string, file = "", field = "model"): string {
  const model = value.trim();
  const slash = model.indexOf("/");
  const prefix = file ? `${file}: ${field}: ` : "";
  if (slash <= 0 || slash === model.length - 1 || /\s/.test(model)) {
    throw new PitakoConfigError(`${prefix}invalid model id "${value}". Expected provider/model.`);
  }
  return model;
}

function parseFast(value: unknown, file: string, field: string): boolean {
  if (typeof value !== "boolean") throw new PitakoConfigError(`${file}: ${field}: expected boolean`);
  return value;
}

function parseReasoning(value: unknown, file: string, field: string): ReasoningLevel | undefined {
  if (value === "default") return undefined;
  if (typeof value !== "string" || !isReasoningLevel(value)) {
    throw new PitakoConfigError(
      `${file}: ${field}: invalid reasoning level "${String(value)}". Expected ${REASONING_LIST}, or default.`,
    );
  }
  return value;
}

const REASONING_LIST = "off, minimal, low, medium, high, xhigh, max";

function assertKnownNames(names: readonly string[], file: string, field: string): void {
  const seen = new Set<string>();
  names.forEach((name, index) => {
    if (seen.has(name)) throw new PitakoConfigError(`${file}: ${field}: duplicate "${name}"`);
    seen.add(name);
    if (!KNOWN_SKILLS.has(name)) {
      throw new PitakoConfigError(`${file}: ${field}[${index}]: unknown skill "${name}"`);
    }
  });
}

function resolveInstructions(file: string, instructions: string, baseDir: string, stayInside?: string): string {
  const absolute = path.isAbsolute(instructions) ? instructions : path.resolve(baseDir, instructions);
  const resolved = path.resolve(absolute);
  if (stayInside) {
    const root = path.resolve(stayInside);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new PitakoConfigError(`${file}: instructions path escapes ${root}`);
    }
  }
  if (!existsSync(resolved)) {
    throw new PitakoConfigError(`${file}: missing role instruction file ${instructions}`);
  }
  return resolved;
}

function readInstructions(file: string, source: string): string {
  const text = readFileSync(file, "utf8").trim();
  if (text.length === 0) throw new PitakoConfigError(`${source}: role instruction file is empty (${file})`);
  return text;
}

function expectRecord(value: unknown, file: string, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PitakoConfigError(`${file}: ${field || "document"}: expected a table`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, allowed: Set<string>, file: string, field: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      const where = field.length > 0 ? `${field}.` : "";
      throw new PitakoConfigError(`${file}: unknown key ${where}${key}`);
    }
  }
}

function requiredString(value: unknown, file: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PitakoConfigError(`${file}: ${field}: expected text`);
  }
  return value.trim();
}

function optionalString(value: unknown, file: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, file, field);
}

function stringList(value: unknown, file: string, field: string): string[] {
  if (!Array.isArray(value)) throw new PitakoConfigError(`${file}: ${field}: expected an array`);
  return value.map((item, index) => requiredString(item, file, `${field}[${index}]`));
}

function freeze<T extends object>(value: T): T {
  return Object.freeze(value);
}

function parseCandidates(value: unknown, file: string, name: "architecture" | "review"): PitakoConfig["architecture"] {
  if (value === undefined) return undefined;
  const table = expectRecord(value, file, name);
  rejectUnknown(table, CONFIG_KEYS.candidates, file, name);
  const candidates = (value: unknown, field: string) => {
    if (!Array.isArray(value) || !value.length) throw new PitakoConfigError(`${file}: ${field}: expected nonempty candidates`);
    const seen = new Set<string>();
    return value.map((item, index) => {
      const key = `${field}[${index}]`;
      rejectUnknown(expectRecord(item, file, key), CONFIG_KEYS.candidate, file, key);
      const target = parseTarget(item, file, key), identity = targetKey(target);
      if (seen.has(identity)) throw new PitakoConfigError(`${file}: ${key}: duplicate candidate`);
      seen.add(identity);
      return target;
    });
  };
  if (table.topics !== undefined && !Array.isArray(table.topics)) throw new PitakoConfigError(`${file}: ${name}.topics: expected array`);
  const seen = new Set<string>();
  return { candidates: candidates(table.candidates, `${name}.candidates`),
    topics: ((table.topics ?? []) as unknown[]).map((item, index) => {
      const field = `${name}.topics[${index}]`, entry = expectRecord(item, file, field);
      rejectUnknown(entry, CONFIG_KEYS.topic, file, field);
      const topic = requiredString(entry.topic, file, `${field}.topic`).replace(/\s+/g, " ").toLowerCase();
      if (seen.has(topic)) throw new PitakoConfigError(`${file}: ${field}: duplicate topic`);
      seen.add(topic);
      return { topic, candidates: candidates(entry.candidates, `${field}.candidates`) };
    }) };
}
