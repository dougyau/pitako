import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { PitakoConfigError } from "../extensions/errors.ts";
import { packageRoot } from "../extensions/stack.ts";
import {
  bindingMismatch,
  bindPlanTopic,
  evidenceFile,
  initLedger,
  ledgerFile,
  parseLedgerBinding,
  parsePlanDocument,
  setPlanExecution,
  planFile,
  readPlan,
  requireFrozen,
  workflowWorkspace,
  updateLedgerTeamHold,
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

  test("persists an optional validated topic binding only on a draft", () => {
    const loose = tempDir("pitako-plan-topic-");
    const file = planFile("herdr-integration", loose);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, planText("draft"));
    expect(parsePlanDocument(planText("draft")).boardTopicId).toBeUndefined();
    expect(parsePlanDocument(planText("draft")).execution).toBeUndefined();
    expect(setPlanExecution("herdr-integration", "expected", loose).execution).toBe("expected");
    const body = "# execution: body must stay unchanged\n\nbody execution: old value\n";
    writeFileSync(file, planText("draft", body));
    setPlanExecution("herdr-integration", "none", loose);
    expect(readFileSync(file, "utf8")).toContain(body);
    const bound = bindPlanTopic("herdr-integration", 27, loose);
    expect(bound.boardTopicId).toBe(27);
    expect(readFileSync(file, "utf8")).toContain("board_topic_id: 27");
    expect(() => bindPlanTopic("herdr-integration", 28, loose)).toThrow(/already bound/);
    expect(() => parsePlanDocument(planText().replace("status: frozen", "status: frozen\nboard_topic_id: 1.5"))).toThrow(/positive safe integer/);
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

describe("ledger Team hold locking", () => {
  test("preserves concurrent updates across processes", async () => {
    const cwd = tempDir("pitako-hold-contention-");
    const file = planFile("hold-plan", cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "---\nid: hold-plan\nrevision: 1\nstatus: frozen\nboard_topic_id: 1\n---\n\nPlan.\n");
    const meta = readPlan("hold-plan", cwd).meta;
    initLedger(ledgerFile("hold-plan", cwd), meta);
    const moduleUrl = new URL("../extensions/workflow.ts", import.meta.url).href;
    const source = `import { updateLedgerTeamHold } from ${JSON.stringify(moduleUrl)}; for (let i = 0; i < 100; i++) updateLedgerTeamHold(${JSON.stringify(cwd)}, "hold-plan", { assignmentId: process.pid + "-" + i, unitId: "unit", status: "pending" });`;
    const workers = Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", source], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`hold worker exited ${code}`)));
    }));
    await Promise.all(workers);
    const ledger = readFileSync(ledgerFile("hold-plan", cwd), "utf8");
    expect(ledger).toContain('"assignmentId"');
    expect(ledger.match(/"status":"pending"/g)).toHaveLength(400);
  });

  test("fails closed on a planted lock without deleting it", () => {
    const cwd = tempDir("pitako-hold-stale-");
    const file = planFile("stale-plan", cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "---\nid: stale-plan\nrevision: 1\nstatus: frozen\nboard_topic_id: 1\n---\n\nPlan.\n");
    const meta = readPlan("stale-plan", cwd).meta;
    const ledger = ledgerFile("stale-plan", cwd);
    initLedger(ledger, meta);
    const lock = `${ledger}.lock`;
    mkdirSync(lock);
    try {
      expect(() => updateLedgerTeamHold(cwd, "stale-plan", { assignmentId: "a", unitId: "unit", status: "pending" })).toThrow(/verify no writer is active before manually removing the stale lock/);
      expect(existsSync(lock)).toBe(true);
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }, 10000);
});

describe("plan and execute contracts", () => {
  const plan = readFileSync(path.join(packageRoot(), "skills/plan/SKILL.md"), "utf8");
  const execute = readFileSync(path.join(packageRoot(), "skills/execute/SKILL.md"), "utf8");
  const deslop = readFileSync(path.join(packageRoot(), "skills/remove-ai-slops/SKILL.md"), "utf8");
  const prePr = readFileSync(path.join(packageRoot(), "skills/pre-pr/SKILL.md"), "utf8");
  const router = readFileSync(path.join(packageRoot(), "skills/pitako-coding/SKILL.md"), "utf8");

  test("plan freezes and does not grant implementation", () => {
    expect(plan).toContain("Never implement");
    expect(plan).toContain("PLAN_FROZEN");
    expect(plan).toContain("Do not invoke $execute");
    expect(plan).toContain("Watched Team assignments inherit the exact binding automatically");
    expect(plan).toContain("execution: expected");
    expect(plan).toContain("initLedger(ledgerFile(id, cwd), meta)");
    expect(plan).not.toContain("execution: expected #");
    const sample = plan.match(/```markdown\n([\s\S]*?)\n```/)?.[1];
    expect(sample).toBeDefined();
    expect(parsePlanDocument(sample!).execution).toBe("expected");
    expect(plan).toContain("board_workflow_claim");
    expect(plan).toMatch(/After freezing[\s\S]*?initLedger\(ledgerFile\(id, cwd\), meta\)[\s\S]*?before resolving/);
    expect(plan).toContain("agent_run");
    expect(plan).toContain("design-only");
    expect(plan).not.toMatch(/openai|anthropic|gpt-|claude|grok/i);
  });

  test("execute is explicit, scoped, and does not replan", () => {
    expect(execute).toContain("status: frozen");
    expect(execute).toContain("openExecutionPlan");
    expect(execute).toContain("existing execution-root ledger first");
    expect(execute).toContain("USER_DECISION_REQUIRED");
    expect(execute).toContain("Persist `status: USER_DECISION_REQUIRED` in ledger frontmatter");
    expect(execute).toContain("execution: expected");
    expect(execute).toContain("Explicit abandonment of the whole workflow");
    expect(execute).toContain("Failed, cancelled, and no-outcome holds remain blocking across reload");
    expect(execute).toContain("WorkBrief");
    expect(execute).toContain("Do not send the parent transcript");
    expect(execute).toContain("Do not invoke $plan");
    expect(execute).toContain("Level 1");
    expect(execute).toContain("Level 2");
    expect(execute).toContain("Level 3");
    expect(execute).toContain("same Developer");
    expect(execute).toContain("prefer `team_assign` when available");
    expect(execute).toContain("Team assignment ID for Team");
    expect(execute).toContain("call `team_result` once with the Team assignment ID");
    expect(execute).toContain("call `team_status` with its assignment ID");
    expect(execute).toContain("`agent_result` once with the low-level worker instance ID");
    expect(execute).toContain("call `agent_status` with its instance ID");
    expect(execute).toContain("Keep at most one Developer role active, without exception.");
    expect(execute).not.toContain("unless the frozen plan already assigns non-overlapping work");
    expect(execute).toContain("agent_spawn");
    expect(execute).toContain("agent_run");
    expect(execute).toContain("## Workers");
    expect(execute).toContain("not foreground implementation");
    expect(execute).toContain("neither `agent_run` nor `team_assign` nor `agent_spawn` is registered");
    expect(execute).not.toContain("`agent_run` unavailable still means implement inline");
    expect(execute).not.toContain("If `agent_run` is unavailable, implement inline");
    expect(execute).toContain("Consult Architect through `agent_run`");
    expect(execute).not.toContain("When `agent_run` is available, you coordinate");
    expect(execute).toContain("bindingMismatch");
    expect(execute).not.toMatch(/openai-codex|anthropic\/|gpt-5|claude-/);
  });

  test("execute and pre-pr order cleanup before final gates and review", () => {
    const finalPonytail = execute.indexOf("one deliberate Ponytail pass over the complete finished diff");
    const preCleanupChecks = execute.indexOf("Run affected focused checks after that pass", finalPonytail);
    const deslopPass = execute.indexOf("Run `remove-ai-slops` only", preCleanupChecks);
    const postCleanupChecks = execute.indexOf("After cleanup, rerun the same checks", deslopPass);
    const finalGates = execute.indexOf("Run final gates after all edits", postCleanupChecks);
    const finalReview = execute.indexOf("the single final review", finalGates);
    expect(finalPonytail).toBeGreaterThanOrEqual(0);
    expect(preCleanupChecks).toBeGreaterThan(finalPonytail);
    expect(deslopPass).toBeGreaterThan(preCleanupChecks);
    expect(postCleanupChecks).toBeGreaterThan(deslopPass);
    expect(finalGates).toBeGreaterThan(postCleanupChecks);
    expect(finalReview).toBeGreaterThan(finalGates);
    expect(execute).toContain("must be green before `remove-ai-slops`");
    expect(execute).toContain("complete final diff");
    expect(execute).toContain("An evidenced A-only cleanup does not require a second review solely for cleanup when adequate independent review already covers it");
    expect(execute).toContain("B or uncertain changes need an independent Reviewer on the complete final diff");
    expect(execute).toContain("Any B or uncertain edit after approval invalidates that approval");
    expect(execute).toContain("rerun affected checks and applicable final gates");

    const prePrPonytail = prePr.indexOf("make one final Ponytail pass over the whole scoped diff");
    const prePrChecks = prePr.indexOf("Run affected focused checks.", prePrPonytail);
    const prePrDeslop = prePr.indexOf("apply `remove-ai-slops` selectively to durable prose", prePrChecks);
    const prePrAfterChecks = prePr.indexOf("Rerun affected checks after prose edits", prePrDeslop);
    const prePrGates = prePr.indexOf("Run applicable final gates", prePrAfterChecks);
    expect(prePrPonytail).toBeGreaterThanOrEqual(0);
    expect(prePrChecks).toBeGreaterThan(prePrPonytail);
    expect(prePr.indexOf("Once they are green", prePrChecks)).toBeLessThan(prePrDeslop);
    expect(prePrDeslop).toBeGreaterThan(prePrChecks);
    expect(prePrAfterChecks).toBeGreaterThan(prePrDeslop);
    expect(prePrGates).toBeGreaterThan(prePrAfterChecks);
    expect(prePr).toContain("B requires an independent Reviewer to assess the whole final diff");
    expect(prePr).toContain("An evidenced A does not require a second review solely for cleanup when adequate independent review already covers it");
    expect(prePr).toContain("Any B or uncertain edit after approval invalidates that approval");
    expect(prePr).toContain("rerun affected checks and applicable final gates");
    expect(prePr).toContain("does not self-review or edit the scoped diff");
    expect(prePr).toContain("If an independent Reviewer is unavailable, report `BLOCKED`");
    expect(prePr).toContain("The Reviewer does not fix findings; the Developer resolves material findings.");
    expect(prePr).toContain("This exception does not waive `$execute`'s required final review");
    expect(deslop).toContain("Standalone `$pre-pr` invokes this skill only for durable prose touched by its diff");
    expect(deslop).toContain("This prose-only restriction overrides the code cleanup ideas below");
    expect(deslop).toContain("does not change `$execute` behavior");
    expect(deslop).toContain("does not require an `$execute` ledger or `deslop.md`");
    expect(router).toContain("Prepare a local diff for publication without `$execute`");
  });

  test("final review contract covers the full diff and execute cleanup classes", () => {
    expect(execute).toContain("demonstrably nonsemantic subtraction");
    expect(execute).toContain("checks or other evidence supporting unchanged behavior and contracts");
    expect(execute).toContain("potentially semantic or uncertain");
    expect(execute).toContain("logic, state, lifecycle, concurrency, paths, security, privileges, output, or contracts");

    const prePrGates = prePr.indexOf("Run applicable final gates");
    const prePrReview = prePr.indexOf("Before reporting readiness", prePrGates);
    expect(prePrGates).toBeGreaterThanOrEqual(0);
    expect(prePrReview).toBeGreaterThan(prePrGates);
    expect(prePr).toContain("If no independent review covers the complete final diff, including when review is absent or inadequate, obtain one.");
    expect(prePr).toContain("must not create a plan, ledger, or Board topic");
  });

  test("pre-pr comparison covers missing, empty, and uncommitted changes", () => {
    expect(prePr).toContain("If the base is missing, ambiguous, unavailable locally, conflicts with other evidence, or has no merge-base with `HEAD`, ask for a base and report `BLOCKED`.");
    expect(prePr).toContain("staged and unstaged edits, and relevant non-ignored untracked files");
    expect(prePr).toContain("If the scoped diff is empty, report `BLOCKED`");
    expect(prePr).toContain("A provisional base caps status at `READY_WITH_CAVEAT`");
    expect(prePr).toContain("the base is unambiguous and non-provisional");
    expect(prePr).toContain("git rev-list --left-right --count <base>...HEAD");
    expect(prePr).toContain("report when `HEAD` is behind the base");
    expect(prePr).toContain("Inspect staged and unstaged scoped changes and relevant untracked files during cleanup; do not omit them from review.");
    expect(prePr).toContain("Any staged, unstaged, or relevant non-ignored untracked scoped changes, secrets, or generated residue block readiness.");

    const readyStart = prePr.indexOf("- `READY_TO_PUSH`:");
    const caveatStart = prePr.indexOf("- `READY_WITH_CAVEAT`:", readyStart);
    const readyToPush = prePr.slice(readyStart, caveatStart);
    expect(readyToPush).toContain("scoped Git status is clean");
    expect(readyToPush).toContain("committed push payload (`git diff <base>...HEAD`) exactly matches the reviewed final diff");
  });

  test("pre-pr stays local, standalone, and blocks unmet gates", () => {
    expect(prePr).toContain("requires no `$plan`, frozen plan, `$execute`, ledger, or Board topic");
    expect(prePr).toContain("Work only in the top level of the current process cwd's worktree.");
    expect(prePr).toContain("Do not inspect, create, add, or switch to another worktree or branch.");
    expect(prePr).toContain("Keep changes within the current diff.");
    expect(prePr).toContain("This is guidance, not enforcement.");
    expect(prePr).toContain("Never commit, push, force-push, merge, fetch, use `gh`, read or write a remote PR, create or update a PR, or perform any other remote action.");
    expect(prePr).toContain("Do not claim the skill technically prevents these actions.");
    expect(prePr).toContain("- `BLOCKED`:");
    expect(prePr).toContain("a required gate fails or is unavailable");
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
    expect(execute).toContain("must be green before `remove-ai-slops`");
    expect(execute).toContain("verify again");
    expect(execute).toContain("read the plan and the ledger before evidence");
    expect(execute).toContain("stale conversation");
    expect(execute).toContain("Board is not a progress log");
    expect(deslop).toContain("Default scope is files changed by this execution.");
    expect(deslop).toContain("Standalone `$pre-pr` invokes this skill only for durable prose touched by its diff");
    expect(deslop).toContain("verified");
    expect(deslop).toContain("verify again");
    expect(deslop).not.toContain("250");
  });
});
