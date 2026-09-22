import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { PitakoConfigError } from "../extensions/errors.ts";
import { packageRoot } from "../extensions/stack.ts";
import {
  bindingMismatch,
  evidenceFile,
  initLedger,
  ledgerFile,
  parseLedgerBinding,
  parsePlanDocument,
  planFile,
  readPlan,
  requireFrozen,
  workflowWorkspace,
} from "../extensions/workflow.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function gitRepo(): string {
  const dir = tempDir("pitako-plan-repo-");
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function planText(status = "frozen", body = "body"): string {
  return `---\nid: herdr-integration\nrevision: 2\nstatus: ${status}\n---\n\n# Herdr integration\n\n${body}\n`;
}

describe("workflow paths", () => {
  test("uses the git root, and a non-git directory falls back to cwd", () => {
    const repo = gitRepo();
    const nested = path.join(repo, "src");
    mkdirSync(nested);
    const loose = tempDir("pitako-plan-loose-");
    expect(workflowWorkspace(nested)).toBe(workflowWorkspace(repo));
    expect(planFile("herdr-integration", nested)).toBe(path.join(repo, ".pitako", "plans", "herdr-integration.md"));
    expect(workflowWorkspace(loose)).toBe(loose);
    expect(planFile("bounded-fix", loose)).toBe(path.join(loose, ".pitako", "plans", "bounded-fix.md"));
  });

  test("rejects traversal and builds ledger and evidence inside the run", () => {
    const loose = tempDir("pitako-plan-paths-");
    expect(ledgerFile("alpha", loose)).toBe(path.join(loose, ".pitako", "runs", "alpha", "ledger.md"));
    expect(evidenceFile("alpha", "T1/verification.txt", loose)).toBe(
      path.join(loose, ".pitako", "runs", "alpha", "evidence", "T1", "verification.txt"),
    );
    for (const id of ["../x", "..", "/tmp/x", "foo/bar", "foo\\bar", "Foo", "", "a..b"]) {
      expect(() => planFile(id, loose)).toThrow(PitakoConfigError);
    }
    expect(() => evidenceFile("alpha", "../ledger.md", loose)).toThrow(PitakoConfigError);
    expect(() => evidenceFile("alpha", "/etc/passwd", loose)).toThrow(PitakoConfigError);
    expect(() => evidenceFile("alpha", "T1/../../plans/x.md", loose)).toThrow(PitakoConfigError);
  });
});

describe("plan binding", () => {
  test("reads frozen metadata, revision, and hash, and refuses a non-frozen plan", () => {
    const loose = tempDir("pitako-plan-meta-");
    const text = planText();
    const meta = parsePlanDocument(text);
    expect(meta.id).toBe("herdr-integration");
    expect(meta.revision).toBe(2);
    expect(meta.status).toBe("frozen");
    expect(meta.hash).toHaveLength(64);
    const file = planFile("herdr-integration", loose);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    const read = readPlan("herdr-integration", loose);
    expect(read.meta.revision).toBe(2);
    expect(read.meta.hash).toBe(meta.hash);
    expect(() => requireFrozen(parsePlanDocument(planText("draft")))).toThrow(/not frozen/);
    requireFrozen(read.meta);
  });

  test("detects revision and hash mismatch and does not overwrite an existing ledger", () => {
    const loose = tempDir("pitako-plan-ledger-");
    const meta = parsePlanDocument(planText());
    const file = ledgerFile("herdr-integration", loose);
    expect(initLedger(file, meta)).toBe("created");
    const first = readFileSync(file, "utf8");
    writeFileSync(file, `${first}\n## Rulings\n\nKeep the seam.\n`);
    const kept = readFileSync(file, "utf8");
    expect(initLedger(file, meta)).toBe("exists");
    expect(readFileSync(file, "utf8")).toBe(kept);
    const binding = parseLedgerBinding(kept);
    expect(bindingMismatch(meta, binding)).toBeUndefined();
    expect(bindingMismatch({ ...meta, revision: 3 }, binding)).toContain("revision");
    expect(bindingMismatch({ ...meta, hash: "0".repeat(64) }, binding)).toContain("hash");
  });
});

describe("plan and execute contracts", () => {
  const plan = readFileSync(path.join(packageRoot(), "skills/plan/SKILL.md"), "utf8");
  const execute = readFileSync(path.join(packageRoot(), "skills/execute/SKILL.md"), "utf8");
  const deslop = readFileSync(path.join(packageRoot(), "skills/remove-ai-slops/SKILL.md"), "utf8");

  test("plan freezes and does not grant implementation", () => {
    expect(plan).toContain("Never implement");
    expect(plan).toContain("PLAN_FROZEN");
    expect(plan).toContain("Do not invoke $execute");
    expect(plan).toContain("agent_run");
    expect(plan).toContain("design-only");
    expect(plan).not.toMatch(/openai|anthropic|gpt-|claude|grok/i);
  });

  test("execute is explicit, scoped, and does not replan", () => {
    expect(execute).toContain("status: frozen");
    expect(execute).toContain("USER_DECISION_REQUIRED");
    expect(execute).toContain("WorkBrief");
    expect(execute).toContain("Do not send the parent transcript");
    expect(execute).toContain("Do not invoke $plan");
    expect(execute).toContain("Level 1");
    expect(execute).toContain("Level 2");
    expect(execute).toContain("Level 3");
    expect(execute).toContain("same Developer");
    expect(execute).toContain("bindingMismatch");
    expect(execute).not.toMatch(/openai-codex|anthropic\/|gpt-5|claude-/);
  });

  test("economy, resume, and cleanup stay in the skills", () => {
    expect(execute).toContain("Caveman");
    expect(execute).toContain("not for ledger");
    expect(execute).toContain("Unslop");
    expect(execute).toContain("Ponytail");
    expect(execute).toContain("no separate Ponytail agent");
    expect(execute).toContain("remove-ai-slops");
    expect(execute).toContain("not after every edit");
    expect(execute).toContain("files changed by this run");
    expect(execute).toContain("verification is green");
    expect(execute).toContain("verify again");
    expect(execute).toContain("read the plan and the ledger before evidence");
    expect(execute).toContain("stale conversation");
    expect(execute).toContain("Board is not a progress log");
    expect(deslop).toContain("files changed by this execution");
    expect(deslop).toContain("verified");
    expect(deslop).toContain("verify again");
    expect(deslop).not.toContain("250");
  });
});
