import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { planHash, readFrozenPlan } from "../extensions/workflow.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pitako-frozen-plan-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(root: string, branch = "main", separateGitDir?: string): void {
  mkdirSync(root, { recursive: true });
  const args = ["init", "-q", "-b", branch];
  if (separateGitDir) args.push("--separate-git-dir", separateGitDir);
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init", "-q"]);
}

function addWorktree(repo: string, root: string, branch: string): void {
  mkdirSync(path.dirname(root), { recursive: true });
  git(repo, ["worktree", "add", "-q", "-b", branch, root]);
}

function planPath(root: string, id = "frozen-plan"): string {
  return path.join(root, ".pitako", "plans", `${id}.md`);
}

function writePlan(root: string, options: { id?: string; status?: string; revision?: number; topic?: number; body?: string } = {}): string {
  const id = options.id ?? "frozen-plan";
  const file = planPath(root, id);
  mkdirSync(path.dirname(file), { recursive: true });
  const topic = options.topic === undefined ? "" : `board_topic_id: ${options.topic}\n`;
  writeFileSync(file, `---\nid: ${id}\nrevision: ${options.revision ?? 1}\nstatus: ${options.status ?? "frozen"}\n${topic}---\n\n# ${options.body ?? "Plan"}\n`);
  return file;
}

function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected action to throw");
}

describe("readFrozenPlan", () => {
  test("finds main-to-feature plan from nested and symlinked caller paths with unusual worktree names", () => {
    const base = tempDir();
    const main = path.join(base, "main");
    const feature = path.join(base, "feature with spaces\nand newline ");
    initRepo(main);
    addWorktree(main, feature, "feature");
    const file = writePlan(feature);
    const nested = path.join(main, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const alias = path.join(base, "main-alias");
    symlinkSync(nested, alias);

    expect(readFrozenPlan("frozen-plan", nested).file).toBe(file);
    expect(readFrozenPlan("frozen-plan", alias).text).toContain("# Plan");
  });

  test("rejects every present non-frozen sibling instead of skipping it", () => {
    const base = tempDir();
    const main = path.join(base, "main");
    const feature = path.join(base, "feature");
    const other = path.join(base, "other");
    initRepo(main);
    addWorktree(main, feature, "feature");
    const draft = writePlan(feature, { status: "draft" });

    const onlyDraft = thrownMessage(() => readFrozenPlan("frozen-plan", main));
    expect(onlyDraft).toContain(draft);
    expect(onlyDraft).toMatch(/draft, not frozen/);
    expect(onlyDraft).not.toContain("PLAN_NOT_FOUND");

    addWorktree(main, other, "other");
    writePlan(other);
    const withFrozen = thrownMessage(() => readFrozenPlan("frozen-plan", main));
    expect(withFrozen).toContain(draft);
    expect(withFrozen).toMatch(/draft, not frozen/);
    expect(withFrozen).not.toContain("PLAN_AMBIGUOUS");
  });

  test("does not assume main branch or worktree order and reports every ambiguous sibling", () => {
    const base = tempDir();
    const branchA = path.join(base, "branch-a");
    const branchB = path.join(base, "branch-b");
    const branchC = path.join(base, "branch-c");
    initRepo(branchA, "A");
    addWorktree(branchA, branchB, "B");
    addWorktree(branchA, branchC, "C");
    const first = writePlan(branchA);
    expect(readFrozenPlan("frozen-plan", branchB).file).toBe(first);
    const second = writePlan(branchC);

    const identical = thrownMessage(() => readFrozenPlan("frozen-plan", branchB));
    expect(identical).toContain("PLAN_AMBIGUOUS");
    expect(identical).toContain(first);
    expect(identical).toContain(second);
    expect(identical.indexOf(first)).toBeLessThan(identical.indexOf(second));
    expect(identical).toContain(`hash=${planHash(readFileSync(first, "utf8"))}`);

    writePlan(branchC, { revision: 2, topic: 27, body: "Divergent plan" });
    const divergent = thrownMessage(() => readFrozenPlan("frozen-plan", branchB));
    expect(divergent).toContain("PLAN_AMBIGUOUS");
    expect(divergent).toContain("revision=1");
    expect(divergent).toContain("revision=2");
    expect(divergent).toContain("topic=27");
  });

  test("local presence shadows siblings, even when invalid; broken links fail explicitly", () => {
    const base = tempDir();
    const main = path.join(base, "main");
    const feature = path.join(base, "feature");
    initRepo(main);
    addWorktree(main, feature, "feature");
    writePlan(feature);
    const local = writePlan(main, { status: "draft", body: "Local shadow" });

    const draftShadow = thrownMessage(() => readFrozenPlan("frozen-plan", main));
    expect(draftShadow).toContain(local);
    expect(draftShadow).toMatch(/not frozen/);

    writeFileSync(local, "not a valid plan");
    const invalid = thrownMessage(() => readFrozenPlan("frozen-plan", main));
    expect(invalid).toContain(local);
    expect(invalid).toMatch(/frontmatter/);

    rmSync(local);
    symlinkSync(path.join(base, "missing-plan.md"), local);
    expect(() => lstatSync(local)).not.toThrow();
    expect(thrownMessage(() => readFrozenPlan("frozen-plan", main))).toMatch(/resolve|realpath|ENOENT/i);
  });

  test("does not scan siblings for a valid local plan and rejects bad sibling candidates", () => {
    const base = tempDir();
    const main = path.join(base, "main");
    const feature = path.join(base, "feature");
    initRepo(main);
    addWorktree(main, feature, "feature");
    writePlan(main, { body: "Local" });
    mkdirSync(path.dirname(planPath(feature)), { recursive: true });
    writeFileSync(planPath(feature), "broken sibling");

    expect(readFrozenPlan("frozen-plan", main).text).toContain("# Local");

    rmSync(planPath(main));
    expect(thrownMessage(() => readFrozenPlan("frozen-plan", main))).toMatch(/frontmatter/);
  });

  test("resolves a main-worktree plan for feature execution and rejects copied unregistered Git metadata", () => {
    const base = tempDir();
    const main = path.join(base, "main");
    const feature = path.join(base, "feature");
    const copied = path.join(base, "copied-worktree");
    initRepo(main);
    addWorktree(main, feature, "feature");
    const file = writePlan(main);

    expect(readFrozenPlan("frozen-plan", feature).file).toBe(file);

    mkdirSync(copied);
    writeFileSync(path.join(copied, ".git"), readFileSync(path.join(feature, ".git"), "utf8"));
    expect(thrownMessage(() => readFrozenPlan("frozen-plan", copied))).toMatch(/caller worktree is not registered with Git/);
  });

  test("keeps frozen plans local outside Git and never selects an unrelated repository", () => {
    const loose = tempDir();
    writePlan(loose);
    expect(readFrozenPlan("frozen-plan", loose).file).toBe(planPath(loose));

    const base = tempDir();
    const repo = path.join(base, "repo");
    const unrelated = path.join(base, "unrelated");
    initRepo(repo);
    initRepo(unrelated);
    writePlan(unrelated);
    expect(thrownMessage(() => readFrozenPlan("frozen-plan", repo))).toContain("PLAN_NOT_FOUND");
  });

  test("ignores inherited Git directory overrides and validates symlink targets against repository identity", () => {
    const base = tempDir();
    const main = path.join(base, "main");
    const feature = path.join(base, "feature");
    const unrelated = path.join(base, "unrelated");
    initRepo(main);
    addWorktree(main, feature, "feature");
    initRepo(unrelated);
    const actual = path.join(main, ".pitako", "stored-plan.md");
    mkdirSync(path.dirname(actual), { recursive: true });
    writeFileSync(actual, `---\nid: frozen-plan\nrevision: 1\nstatus: frozen\n---\n\n# Same repository\n`);
    mkdirSync(path.dirname(planPath(feature)), { recursive: true });
    symlinkSync(actual, planPath(feature));

    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries({
      GIT_COMMON_DIR: path.join(unrelated, ".git"),
      GIT_CEILING_DIRECTORIES: main,
    })) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      expect(readFrozenPlan("frozen-plan", main).file).toBe(planPath(feature));
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    rmSync(planPath(feature));
    const outside = writePlan(unrelated);
    symlinkSync(outside, planPath(feature));
    expect(thrownMessage(() => readFrozenPlan("frozen-plan", main))).toMatch(/different Git repository|repository identity/i);
  });

  test("fails closed on Git metadata spoofing and a separate-git-dir list anomaly", () => {
    const spoof = tempDir();
    writeFileSync(path.join(spoof, ".git"), "gitdir: missing-git-directory\n");
    expect(thrownMessage(() => readFrozenPlan("frozen-plan", spoof))).toMatch(/Git discovery failed/i);

    const base = tempDir();
    const main = path.join(base, "main worktree");
    const separateGitDir = path.join(base, "git metadata");
    const feature = path.join(base, "feature worktree");
    initRepo(main, "main", separateGitDir);
    addWorktree(main, feature, "feature");
    writePlan(feature);
    expect(thrownMessage(() => readFrozenPlan("frozen-plan", main))).toMatch(/registered worktree .*cannot be verified/i);
  });

  test("skips missing worktrees only when Git marks them prunable", () => {
    const base = tempDir();
    const main = path.join(base, "main");
    const removed = path.join(base, "removed");
    initRepo(main);
    addWorktree(main, removed, "removed");
    rmSync(removed, { recursive: true, force: true });
    expect(git(main, ["worktree", "list", "--porcelain", "-z"])).toContain("prunable");
    expect(thrownMessage(() => readFrozenPlan("frozen-plan", main))).toContain("PLAN_NOT_FOUND");
  });
});
