import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { currentWorkspace, registeredWorktrees, repositoryIdentity } from "./board/workspace.ts";
import { PitakoConfigError } from "./errors.ts";

/** Lowercase slug. Rejects traversal, separators, and empty ids. */
const PLAN_ID = /^[a-z0-9][a-z0-9-_]*$/;

export interface PlanMeta {
  id: string;
  revision: number;
  status: string;
  hash: string;
  boardTopicId?: number;
  execution?: "expected" | "none";
}

export interface LedgerBinding {
  planId: string;
  revision: number;
  hash: string;
  executionRoot?: string;
  planSource?: string;
}

export interface ExecutionBinding {
  planId: string;
  revision: number;
  hash: string;
  executionRoot: string;
  planSource: string;
}

export interface ExecutionPlan {
  binding: ExecutionBinding;
  file: string;
  text: string;
  meta: PlanMeta;
  ledger: string;
}

export interface TeamHold {
  assignmentId: string;
  unitId: string;
  status: "pending" | "failed" | "cancelled";
}

export function assertPlanId(id: string): string {
  if (!PLAN_ID.test(id) || id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new PitakoConfigError(`invalid plan id "${id}"`);
  }
  return id;
}

export function workflowWorkspace(cwd = process.cwd()): string {
  return currentWorkspace(cwd);
}

export function pitakoDir(cwd = process.cwd()): string {
  return path.join(workflowWorkspace(cwd), ".pitako");
}

export function planFile(id: string, cwd = process.cwd()): string {
  return inside(path.join(pitakoDir(cwd), "plans"), `${assertPlanId(id)}.md`);
}

export function ledgerFile(id: string, cwd = process.cwd()): string {
  return inside(path.join(pitakoDir(cwd), "runs", assertPlanId(id)), "ledger.md");
}

export function evidenceFile(id: string, relative: string, cwd = process.cwd()): string {
  const root = path.join(pitakoDir(cwd), "runs", assertPlanId(id), "evidence");
  return inside(root, relative);
}

export function planHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parsePlanDocument(text: string): PlanMeta {
  const fields = frontmatter(text, "plan");
  const id = fields.get("id");
  const revision = Number(fields.get("revision"));
  const status = fields.get("status");
  if (!id || !Number.isInteger(revision) || revision < 1 || !status) {
    throw new PitakoConfigError("plan frontmatter needs id, integer revision >= 1, and status");
  }
  const topicValue = fields.get("board_topic_id");
  const boardTopicId = topicValue === undefined ? undefined : Number(topicValue);
  if (boardTopicId !== undefined && (!Number.isSafeInteger(boardTopicId) || boardTopicId < 1)) {
    throw new PitakoConfigError("plan board_topic_id must be a positive safe integer");
  }
  const execution = fields.get("execution");
  if (execution !== undefined && execution !== "expected" && execution !== "none") throw new PitakoConfigError('plan execution must be "expected" or "none"');
  return { id: assertPlanId(id), revision, status, hash: planHash(text), boardTopicId, execution };
}

export function setPlanExecution(id: string, execution: "expected" | "none", cwd = process.cwd()): PlanMeta {
  if (execution !== "expected" && execution !== "none") throw new PitakoConfigError('execution must be "expected" or "none"');
  const { file, text, meta } = readPlan(id, cwd);
  if (meta.status !== "draft") throw new PitakoConfigError("execution intent must be set before the plan is frozen");
  const frontmatter = text.match(/^(---\r?\n[\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!frontmatter) throw new PitakoConfigError("plan is missing frontmatter");
  const fields = frontmatter[1]!;
  const updated = /^execution:/m.test(fields)
    ? fields.replace(/^execution:.*$/m, `execution: ${execution}`)
    : `${fields}\nexecution: ${execution}`;
  writeFileSync(file, text.replace(frontmatter[0], `${updated}${frontmatter[2]}`));
  return readPlan(id, cwd).meta;
}

export function bindPlanTopic(id: string, topicId: number, cwd = process.cwd()): PlanMeta {
  if (!Number.isSafeInteger(topicId) || topicId < 1) throw new PitakoConfigError("board topic ID must be a positive safe integer");
  const { file, text, meta } = readPlan(id, cwd);
  if (meta.boardTopicId === topicId) return meta;
  if (meta.boardTopicId !== undefined) throw new PitakoConfigError(`plan ${id} is already bound to Board topic ${meta.boardTopicId}`);
  if (meta.status !== "draft") throw new PitakoConfigError("a frozen plan must contain its Board topic binding before claim");
  const bound = text.replace(/^(---\r?\n[\s\S]*?)(\r?\n---(?:\r?\n|$))/, `$1\nboard_topic_id: ${topicId}$2`);
  writeFileSync(file, bound);
  return parsePlanDocument(bound);
}

export function readPlan(id: string, cwd = process.cwd()): { file: string; text: string; meta: PlanMeta } {
  const file = planFile(id, cwd);
  if (!existsSync(file)) throw new PitakoConfigError(`plan not found: ${file}`);
  const text = readFileSync(file, "utf8");
  const meta = parsePlanDocument(text);
  if (meta.id !== id) throw new PitakoConfigError(`plan id "${meta.id}" does not match "${id}"`);
  return { file, text, meta };
}

/** Read one frozen plan locally, or resolve it across registered worktrees. */
export function readFrozenPlan(id: string, cwd = process.cwd()): { file: string; text: string; meta: PlanMeta } {
  assertPlanId(id);
  const root = currentWorkspace(cwd);
  const localFile = planFile(id, root);
  const localIdentity = repositoryIdentity(root);
  if (hasPlanEntry(localFile)) return readFrozenCandidate(localFile, id, localIdentity, root);

  if (localIdentity === root) throw planNotFound(id, localFile, false);
  const roots = registeredWorktrees(root, localIdentity);
  if (!roots.includes(root)) {
    throw new PitakoConfigError(`caller worktree is not registered with Git: ${root}`);
  }

  const candidates = [];
  for (const sibling of roots) {
    if (sibling === root) continue;
    const file = path.join(sibling, ".pitako", "plans", `${id}.md`);
    if (!hasPlanEntry(file)) continue;
    candidates.push(readFrozenCandidate(file, id, localIdentity, root));
  }
  if (candidates.length === 0) throw planNotFound(id, localFile);
  if (candidates.length === 1) return candidates[0]!;

  candidates.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const details = candidates.map(({ file, meta }) =>
    `- ${file} (id=${meta.id}, revision=${meta.revision}, hash=${meta.hash}, topic=${meta.boardTopicId ?? "none"})`,
  );
  throw new PitakoConfigError(`PLAN_AMBIGUOUS: frozen plan "${id}" exists in multiple worktrees:\n${details.join("\n")}`);
}

function hasPlanEntry(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new PitakoConfigError(`could not inspect plan at ${file}: ${errorMessage(error)}`);
  }
}

function readFrozenCandidate(
  file: string,
  id: string,
  commonDir: string,
  localRoot: string,
): { file: string; text: string; meta: PlanMeta } {
  let target: string;
  try {
    target = realpathSync(file);
  } catch (error) {
    throw new PitakoConfigError(`could not resolve plan at ${file}: ${errorMessage(error)}`);
  }
  if (commonDir === localRoot) {
    const relative = path.relative(localRoot, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new PitakoConfigError(`plan at ${file} resolves outside local workspace ${localRoot}`);
    }
  } else {
    let targetIdentity: string;
    try {
      targetIdentity = repositoryIdentity(path.dirname(target));
    } catch (error) {
      throw new PitakoConfigError(`could not verify plan repository at ${file}: ${errorMessage(error)}`);
    }
    if (targetIdentity !== commonDir) {
      throw new PitakoConfigError(`plan at ${file} resolves to a different Git repository (expected ${commonDir}, got ${targetIdentity})`);
    }
  }

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new PitakoConfigError(`could not read plan at ${file}: ${errorMessage(error)}`);
  }
  let meta: PlanMeta;
  try {
    meta = parsePlanDocument(text);
  } catch (error) {
    throw new PitakoConfigError(`invalid plan at ${file}: ${errorMessage(error)}`);
  }
  if (meta.id !== id) throw new PitakoConfigError(`plan at ${file} has id "${meta.id}", expected filename id "${id}"`);
  if (meta.status !== "frozen") throw new PitakoConfigError(`plan at ${file} is ${meta.status}, not frozen`);
  return { file, text, meta };
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = error.stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
    if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf8").trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function planNotFound(id: string, file: string, searchedWorktrees = true): PitakoConfigError {
  const scope = searchedWorktrees ? " or in registered worktrees" : "";
  return new PitakoConfigError(`PLAN_NOT_FOUND: frozen plan "${id}" not found at ${file}${scope}`);
}

/** Open the execution-root ledger before resolving its pinned source. */
export function openExecutionPlan(
  id: string,
  cwd = process.cwd(),
  options: { createLedger?: boolean; source?: { file: string; text: string; meta: PlanMeta } } = {},
): ExecutionPlan {
  assertPlanId(id);
  const executionRoot = currentWorkspace(cwd);
  const commonDir = repositoryIdentity(executionRoot);
  const ledger = ledgerFile(id, executionRoot);
  const createLedger = options.createLedger ?? true;

  const open = (): ExecutionPlan => {
    const existing = readLedgerEntry(ledger);
    if (commonDir !== executionRoot) assertNoCompetingLedgers(executionRoot, commonDir, id);
    if (existing !== undefined) {
      const saved = parseLedgerBinding(existing);
      if (saved.planId !== id) throw new PitakoConfigError(`ledger plan id ${saved.planId} does not match ${id}`);
      let plan: { file: string; text: string; meta: PlanMeta };
      let binding: ExecutionBinding;
      if (saved.executionRoot !== undefined || saved.planSource !== undefined) {
        if (!saved.executionRoot || !saved.planSource) throw new PitakoConfigError("ledger execution binding is incomplete");
        if (saved.executionRoot !== executionRoot) {
          throw new PitakoConfigError(`execution worktree changed: ledger is pinned to ${saved.executionRoot}, current worktree is ${executionRoot}`);
        }
        binding = { planId: saved.planId, revision: saved.revision, hash: saved.hash, executionRoot: saved.executionRoot, planSource: saved.planSource };
        plan = readPinnedPlan(binding, commonDir);
      } else {
        plan = readFrozenPlan(id, executionRoot);
        const mismatch = bindingMismatch(plan.meta, saved);
        if (mismatch) throw new PitakoConfigError(mismatch);
        binding = executionBinding(plan, executionRoot);
        plan = readPinnedPlan(binding, commonDir);
      }
      if (saved.executionRoot === undefined) pinLegacyLedger(ledger, id, plan.meta, binding);
      return { ...plan, binding, ledger };
    }

    if (options.source && options.source.meta.id !== id) {
      throw new PitakoConfigError(`frozen plan id ${options.source.meta.id} does not match ${id}`);
    }
    const selected = options.source ?? readFrozenPlan(id, executionRoot);
    const binding = executionBinding(selected, executionRoot);
    const plan = readPinnedPlan(binding, commonDir);
    if (!createLedger) return { ...plan, binding, ledger };

    mkdirSync(path.dirname(ledger), { recursive: true });
    try {
      const fd = openSync(ledger, "wx");
      try { writeFileSync(fd, ledgerTemplate(plan.meta, binding)); fsyncSync(fd); } finally { closeSync(fd); }
      const dir = openSync(path.dirname(ledger), "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return open();
    }
    return { ...plan, binding, ledger };
  };

  return commonDir === executionRoot ? open() : withExecutionLock(commonDir, id, open);
}

function executionBinding(
  plan: { file: string; text: string; meta: PlanMeta },
  executionRoot: string,
): ExecutionBinding {
  let planSource: string;
  try { planSource = realpathSync(plan.file); }
  catch (error) { throw new PitakoConfigError(`could not resolve frozen plan source ${plan.file}: ${errorMessage(error)}`); }
  return { planId: plan.meta.id, revision: plan.meta.revision, hash: plan.meta.hash, executionRoot, planSource };
}

function readPinnedPlan(
  binding: ExecutionBinding,
  commonDir: string,
): { file: string; text: string; meta: PlanMeta } {
  if (!path.isAbsolute(binding.executionRoot) || !path.isAbsolute(binding.planSource)) {
    throw new PitakoConfigError("ledger execution paths must be absolute");
  }
  let root: string;
  let source: string;
  try {
    root = currentWorkspace(binding.executionRoot);
    source = realpathSync(binding.planSource);
  } catch (error) {
    throw new PitakoConfigError(`could not resolve pinned execution paths: ${errorMessage(error)}`);
  }
  if (root !== binding.executionRoot) throw new PitakoConfigError(`pinned execution root is not physical: ${binding.executionRoot}`);
  if (source !== binding.planSource) throw new PitakoConfigError(`pinned plan source changed physical path: ${binding.planSource}`);
  if (commonDir === binding.executionRoot) {
    const relative = path.relative(binding.executionRoot, source);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new PitakoConfigError(`pinned plan source resolves outside local workspace ${binding.executionRoot}`);
    }
  } else {
    let sourceIdentity: string;
    try { sourceIdentity = repositoryIdentity(path.dirname(source)); }
    catch (error) { throw new PitakoConfigError(`could not verify pinned plan repository: ${errorMessage(error)}`); }
    if (sourceIdentity !== commonDir) {
      throw new PitakoConfigError(`pinned plan source belongs to a different repository (expected ${commonDir}, got ${sourceIdentity})`);
    }
  }
  let text: string;
  try { text = readFileSync(source, "utf8"); }
  catch (error) { throw new PitakoConfigError(`could not read pinned plan source ${source}: ${errorMessage(error)}`); }
  const meta = parsePlanDocument(text);
  if (meta.id !== binding.planId) throw new PitakoConfigError(`pinned plan id ${meta.id} does not match ${binding.planId}`);
  if (meta.status !== "frozen") throw new PitakoConfigError(`pinned plan ${meta.id} is ${meta.status}, not frozen`);
  const mismatch = bindingMismatch(meta, binding);
  if (mismatch) throw new PitakoConfigError(mismatch);
  return { file: source, text, meta };
}

export function verifyExecutionBinding(binding: ExecutionBinding): { file: string; text: string; meta: PlanMeta } {
  let commonDir: string;
  try {
    if (currentWorkspace(binding.executionRoot) !== binding.executionRoot) {
      throw new PitakoConfigError(`pinned execution root is not physical: ${binding.executionRoot}`);
    }
    commonDir = repositoryIdentity(binding.executionRoot);
  } catch (error) {
    throw new PitakoConfigError(`could not verify pinned execution root: ${errorMessage(error)}`);
  }
  return readPinnedPlan(binding, commonDir);
}

function readLedgerEntry(file: string): string | undefined {
  try {
    const state = lstatSync(file);
    if (!state.isFile()) throw new PitakoConfigError(`ledger is not a regular file: ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try { return readFileSync(file, "utf8"); }
  catch (error) { throw new PitakoConfigError(`could not read ledger ${file}: ${errorMessage(error)}`); }
}

function assertNoCompetingLedgers(executionRoot: string, commonDir: string, id: string): void {
  const roots = registeredWorktrees(executionRoot, commonDir);
  if (!roots.includes(executionRoot)) throw new PitakoConfigError(`caller worktree is not registered with Git: ${executionRoot}`);
  for (const root of roots) {
    if (root === executionRoot) continue;
    const file = ledgerFile(id, root);
    if (!hasPlanEntry(file)) continue;
    let fingerprint = "fingerprint=unreadable";
    try {
      const text = readFileSync(file, "utf8");
      const binding = parseLedgerBinding(text);
      fingerprint = `id=${binding.planId}, revision=${binding.revision}, hash=${binding.hash}, status=${parseLedgerStatus(text) ?? "unknown"}`;
    } catch (error) {
      fingerprint += ` (${errorMessage(error)})`;
    }
    throw new PitakoConfigError(`competing ledger for plan ${id} at ${file} (${fingerprint})`);
  }
}

function withExecutionLock<T>(commonDir: string, id: string, action: () => T): T {
  const lock = path.join(commonDir, `.pitako-execution-${id}.lock`);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5000;
  while (true) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new PitakoConfigError(`could not acquire execution lock at ${lock}; verify no writer is active before manually removing the stale lock`);
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  try { return action(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

function pinLegacyLedger(file: string, id: string, meta: PlanMeta, binding: ExecutionBinding): void {
  withLedgerTeamHoldLock(binding.executionRoot, id, () => {
    const source = readPinnedPlan(binding, repositoryIdentity(binding.executionRoot));
    const sourceMismatch = bindingMismatch(source.meta, { planId: meta.id, revision: meta.revision, hash: meta.hash });
    if (sourceMismatch) throw new PitakoConfigError(sourceMismatch);
    const text = readFileSync(file, "utf8");
    const saved = parseLedgerBinding(text);
    const mismatch = bindingMismatch(meta, saved);
    if (mismatch) throw new PitakoConfigError(mismatch);
    if (saved.executionRoot !== undefined || saved.planSource !== undefined) {
      if (saved.executionRoot !== binding.executionRoot || saved.planSource !== binding.planSource) {
        throw new PitakoConfigError("ledger execution binding changed while adopting legacy ledger");
      }
      return;
    }
    const frontmatter = text.match(/^(---\r?\n[\s\S]*?)(\r?\n---(?:\r?\n|$))/);
    if (!frontmatter) throw new PitakoConfigError("ledger is missing frontmatter");
    const pinned = `${frontmatter[1]}\nexecution_root_b64: ${encodePath(binding.executionRoot)}\nplan_source_b64: ${encodePath(binding.planSource)}${frontmatter[2]}`;
    const replacement = text.replace(frontmatter[0], pinned);
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const fd = openSync(temp, "wx");
    try { writeFileSync(fd, replacement); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const dir = openSync(path.dirname(file), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  });
}

function encodePath(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodePath(value: string, field: string): string {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  if (!value || encodePath(decoded) !== value || !path.isAbsolute(decoded)) {
    throw new PitakoConfigError(`ledger ${field} must be a canonical base64url absolute path`);
  }
  return decoded;
}

export function requireFrozen(meta: PlanMeta): void {
  if (meta.status !== "frozen") throw new PitakoConfigError(`plan "${meta.id}" is ${meta.status}, not frozen`);
}

export function ledgerTemplate(meta: PlanMeta, binding?: ExecutionBinding): string {
  return [
    "---",
    `plan_id: ${meta.id}`,
    `revision: ${meta.revision}`,
    `hash: ${meta.hash}`,
    ...(binding ? [`execution_root_b64: ${encodePath(binding.executionRoot)}`, `plan_source_b64: ${encodePath(binding.planSource)}`] : []),
    "status: running",
    "---",
    "",
    "# Ledger",
    "",
    "## Status",
    "",
    "running",
    "",
    "## Completed",
    "",
    "## Current",
    "",
    "## Next",
    "",
    "Reconcile the repository, then start the first open unit.",
    "",
    "## Rulings",
    "",
    "## Amendments",
    "",
    "## Blockers",
    "",
    "## Team Holds",
    "",
    "<!-- pitako-team-holds:v1 -->",
    "[]",
    "<!-- /pitako-team-holds -->",
    "",
    "## Evidence",
    "",
  ].join("\n");
}

/** Creates the ledger once. An existing file is left untouched. */
export function initLedger(file: string, meta: PlanMeta): "created" | "exists" {
  assertPlanId(meta.id);
  const target = path.resolve(file);
  const root = currentWorkspace(path.resolve(path.dirname(target), "../../.."));
  if (target !== ledgerFile(meta.id, root)) throw new PitakoConfigError(`ledger path does not match plan ${meta.id}: ${target}`);
  const commonDir = repositoryIdentity(root);
  const create = (): "created" | "exists" => {
    if (existsSync(target)) return "exists";
    if (commonDir !== root) assertNoCompetingLedgers(root, commonDir, meta.id);
    mkdirSync(path.dirname(target), { recursive: true });
    let fd: number;
    try { fd = openSync(target, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw error;
    }
    try { writeFileSync(fd, ledgerTemplate(meta)); fsyncSync(fd); } finally { closeSync(fd); }
    const dir = openSync(path.dirname(target), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return "created";
  };
  return commonDir === root ? create() : withExecutionLock(commonDir, meta.id, create);
}

export function parseLedgerBinding(text: string): LedgerBinding {
  const fields = frontmatter(text, "ledger");
  const planId = fields.get("plan_id");
  const revision = Number(fields.get("revision"));
  const hash = fields.get("hash");
  if (!planId || !Number.isInteger(revision) || !hash) {
    throw new PitakoConfigError("ledger frontmatter needs plan_id, revision, and hash");
  }
  const executionRoot = fields.get("execution_root_b64");
  const planSource = fields.get("plan_source_b64");
  if ((executionRoot === undefined) !== (planSource === undefined)) {
    throw new PitakoConfigError("ledger execution binding needs both execution_root_b64 and plan_source_b64");
  }
  return {
    planId: assertPlanId(planId),
    revision,
    hash,
    ...(executionRoot !== undefined && planSource !== undefined
      ? { executionRoot: decodePath(executionRoot, "execution_root_b64"), planSource: decodePath(planSource, "plan_source_b64") }
      : {}),
  };
}

export function parseLedgerStatus(text: string): string | undefined {
  return frontmatter(text, "ledger").get("status");
}

const HOLD_START = "<!-- pitako-team-holds:v1 -->";
const HOLD_END = "<!-- /pitako-team-holds -->";

export function ledgerTeamHolds(text: string): TeamHold[] {
  const matches = [...text.matchAll(/^<!-- pitako-team-holds:v1 -->\r?\n([\s\S]*?)\r?\n<!-- \/pitako-team-holds -->$/gm)];
  if (matches.length !== 1 || text.split(HOLD_START).length !== 2 || text.split(HOLD_END).length !== 2) {
    throw new PitakoConfigError("ledger Team hold gate is missing or malformed");
  }
  let value: unknown;
  try { value = JSON.parse(matches[0]![1]!); } catch { throw new PitakoConfigError("ledger Team hold gate is malformed"); }
  if (!Array.isArray(value)) throw new PitakoConfigError("ledger Team hold gate must be an array");
  const ids = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Object.keys(row).sort().join(",") !== "assignmentId,status,unitId" ||
      typeof row.assignmentId !== "string" || !row.assignmentId || typeof row.unitId !== "string" || !row.unitId ||
      !["pending", "failed", "cancelled"].includes(row.status) || ids.has(row.assignmentId)) {
      throw new PitakoConfigError("ledger Team hold gate contains an invalid or duplicate hold");
    }
    ids.add(row.assignmentId);
  }
  return value as TeamHold[];
}

export function readLedgerTeamHolds(cwd: string, planId: string, binding?: ExecutionBinding): TeamHold[] {
  if (binding && binding.planId !== planId) throw new PitakoConfigError(`execution binding plan id ${binding.planId} does not match ${planId}`);
  const plan = (binding ? verifyExecutionBinding(binding) : readPlan(planId, cwd)).meta;
  if (plan.boardTopicId === undefined) return [];
  const root = binding?.executionRoot ?? cwd;
  const file = ledgerFile(planId, root);
  if (!existsSync(file)) throw new PitakoConfigError("bound plan ledger is missing; Team hold gate is unknown");
  const text = readFileSync(file, "utf8");
  const ledgerBinding = parseLedgerBinding(text);
  const mismatch = executionLedgerMismatch(plan, ledgerBinding, binding);
  if (mismatch) throw new PitakoConfigError(mismatch);
  return ledgerTeamHolds(text);
}

/** Update one bound plan's gate under an exclusive, fail-closed filesystem lock. */
export function withLedgerTeamHoldLock<T>(cwd: string, planId: string, action: () => T): T {
  const file = ledgerFile(planId, cwd);
  if (!existsSync(file)) throw new PitakoConfigError("bound plan ledger is missing; Team hold gate is unknown");
  const lock = `${file}.lock`;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5000;
  while (true) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new PitakoConfigError(`could not acquire ledger Team hold lock at ${lock}; verify no writer is active before manually removing the stale lock`);
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  try { return action(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

export function updateLedgerTeamHold(cwd: string, planId: string, hold: TeamHold, remove = false, binding?: ExecutionBinding): boolean {
  if (binding && binding.planId !== planId) throw new PitakoConfigError(`execution binding plan id ${binding.planId} does not match ${planId}`);
  const plan = (binding ? verifyExecutionBinding(binding) : readPlan(planId, cwd)).meta;
  if (plan.boardTopicId === undefined) return false;
  const root = binding?.executionRoot ?? cwd;
  const file = ledgerFile(planId, root);
  return withLedgerTeamHoldLock(root, planId, () => {
    const text = readFileSync(file, "utf8");
    const mismatch = executionLedgerMismatch(plan, parseLedgerBinding(text), binding);
    if (mismatch) throw new PitakoConfigError(mismatch);
    const holds = ledgerTeamHolds(text);
    const next = holds.filter((item) => item.assignmentId !== hold.assignmentId);
    if (!remove) next.push(hold);
    const replacement = text.replace(/^<!-- pitako-team-holds:v1 -->\r?\n[\s\S]*?\r?\n<!-- \/pitako-team-holds -->$/m,
      `${HOLD_START}\n${JSON.stringify(next)}\n${HOLD_END}`);
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const fd = openSync(temp, "wx");
    try { writeFileSync(fd, replacement); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const dir = openSync(path.dirname(file), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return true;
  });
}

function executionLedgerMismatch(plan: PlanMeta, ledger: LedgerBinding, binding?: ExecutionBinding): string | undefined {
  const mismatch = bindingMismatch(plan, ledger);
  if (mismatch) return mismatch;
  if (!binding) return undefined;
  if (ledger.executionRoot !== binding.executionRoot) return `ledger execution root does not match captured root ${binding.executionRoot}`;
  if (ledger.planSource !== binding.planSource) return `ledger plan source does not match captured source ${binding.planSource}`;
  return undefined;
}

export function bindingMismatch(plan: PlanMeta, ledger: LedgerBinding): string | undefined {
  if (ledger.planId !== plan.id) return `ledger plan id ${ledger.planId} does not match ${plan.id}`;
  if (ledger.revision !== plan.revision) return `ledger revision ${ledger.revision} does not match plan revision ${plan.revision}`;
  if (ledger.hash !== plan.hash) return "ledger hash does not match plan content";
  return undefined;
}

function frontmatter(text: string, kind: string): Map<string, string> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) throw new PitakoConfigError(`${kind} is missing frontmatter`);
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const sep = line.indexOf(":");
    if (sep < 1) throw new PitakoConfigError(`${kind} frontmatter line is not key: value`);
    fields.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  return fields;
}

function inside(root: string, relative: string): string {
  if (relative.length === 0 || path.isAbsolute(relative)) {
    throw new PitakoConfigError(`path escapes .pitako: "${relative}"`);
  }
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PitakoConfigError(`path escapes .pitako: "${relative}"`);
  }
  return target;
}
