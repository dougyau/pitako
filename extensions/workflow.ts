import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { currentWorkspace } from "./board/workspace.ts";
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

export function requireFrozen(meta: PlanMeta): void {
  if (meta.status !== "frozen") throw new PitakoConfigError(`plan "${meta.id}" is ${meta.status}, not frozen`);
}

export function ledgerTemplate(meta: PlanMeta): string {
  return [
    "---",
    `plan_id: ${meta.id}`,
    `revision: ${meta.revision}`,
    `hash: ${meta.hash}`,
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
  if (existsSync(file)) return "exists";
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerTemplate(meta));
  return "created";
}

export function parseLedgerBinding(text: string): LedgerBinding {
  const fields = frontmatter(text, "ledger");
  const planId = fields.get("plan_id");
  const revision = Number(fields.get("revision"));
  const hash = fields.get("hash");
  if (!planId || !Number.isInteger(revision) || !hash) {
    throw new PitakoConfigError("ledger frontmatter needs plan_id, revision, and hash");
  }
  return { planId: assertPlanId(planId), revision, hash };
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

export function readLedgerTeamHolds(cwd: string, planId: string): TeamHold[] {
  const plan = readPlan(planId, cwd).meta;
  if (plan.boardTopicId === undefined) return [];
  const file = ledgerFile(planId, cwd);
  if (!existsSync(file)) throw new PitakoConfigError("bound plan ledger is missing; Team hold gate is unknown");
  const text = readFileSync(file, "utf8");
  const mismatch = bindingMismatch(plan, parseLedgerBinding(text));
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

export function updateLedgerTeamHold(cwd: string, planId: string, hold: TeamHold, remove = false): boolean {
  const plan = readPlan(planId, cwd).meta;
  if (plan.boardTopicId === undefined) return false;
  const file = ledgerFile(planId, cwd);
  return withLedgerTeamHoldLock(cwd, planId, () => {
    const text = readFileSync(file, "utf8");
    const mismatch = bindingMismatch(plan, parseLedgerBinding(text));
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
