import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
}

export interface LedgerBinding {
  planId: string;
  revision: number;
  hash: string;
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
  return { id: assertPlanId(id), revision, status, hash: planHash(text) };
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
