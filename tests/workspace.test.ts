import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { evidenceFile, ledgerFile, planFile } from "../extensions/workflow.ts";
import { currentWorkspace, repositoryIdentity } from "../extensions/board/workspace.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init", "-q"], { cwd: dir, stdio: "ignore" });
}

describe("workspace Git identity", () => {
  test("keeps worktree paths local and identifies their shared Git repository", () => {
    const base = tempDir("pitako-worktree-");
    const main = path.join(base, "main");
    const linked = path.join(base, "linked");
    const separate = path.join(base, "separate");
    initRepo(main);
    git(main, ["worktree", "add", "-b", "linked", linked]);
    initRepo(separate);
    const mainNested = path.join(main, "src");
    const linkedNested = path.join(linked, "src");
    mkdirSync(mainNested);
    mkdirSync(linkedNested);

    const commonDir = git(linked, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const worktrees = git(main, ["worktree", "list", "--porcelain", "-z"]).split("\0");
    expect(worktrees).toContain(`worktree ${main}`);
    expect(worktrees).toContain(`worktree ${linked}`);
    expect(commonDir).toBe(path.join(main, ".git"));

    expect(currentWorkspace(mainNested)).toBe(main);
    expect(currentWorkspace(linkedNested)).toBe(linked);
    expect(repositoryIdentity(mainNested)).toBe(commonDir);
    expect(repositoryIdentity(linkedNested)).toBe(commonDir);
    expect(repositoryIdentity(separate)).not.toBe(commonDir);
    expect(planFile("worktree-plan", linkedNested)).toBe(path.join(linked, ".pitako", "plans", "worktree-plan.md"));
    expect(ledgerFile("worktree-plan", linkedNested)).toBe(path.join(linked, ".pitako", "runs", "worktree-plan", "ledger.md"));
    expect(evidenceFile("worktree-plan", "T1/check.txt", linkedNested)).toBe(
      path.join(linked, ".pitako", "runs", "worktree-plan", "evidence", "T1", "check.txt"),
    );

    const link = path.join(base, "linked-alias");
    symlinkSync(linked, link);
    expect(currentWorkspace(link)).toBe(linked);
    expect(repositoryIdentity(link)).toBe(commonDir);

    const spoof = initEnvSpoof(separate, linkedNested);
    try {
      expect(currentWorkspace(linkedNested)).toBe(linked);
      expect(repositoryIdentity(linkedNested)).toBe(commonDir);
    } finally {
      spoof.restore();
    }
  });

  test("preserves newline and trailing-space Git paths", () => {
    const base = tempDir("pitako-worktree-path-");
    for (const name of ["with\nnewline", "with trailing "]) {
      const repo = path.join(base, name);
      initRepo(repo);
      expect(currentWorkspace(repo)).toBe(repo);
      expect(repositoryIdentity(repo)).toBe(path.join(repo, ".git"));
    }
  });

  test("keeps canonical non-Git directories and rejects bare or invalid Git states", () => {
    const loose = tempDir("pitako-worktree-loose-");
    const looseAlias = path.join(tempDir("pitako-worktree-alias-"), "loose");
    symlinkSync(loose, looseAlias);
    expect(currentWorkspace(looseAlias)).toBe(loose);
    expect(repositoryIdentity(looseAlias)).toBe(loose);

    const bare = tempDir("pitako-worktree-bare-");
    execFileSync("git", ["init", "--bare", "-q"], { cwd: bare, stdio: "ignore" });
    expect(() => currentWorkspace(bare)).toThrow(/bare|work.tree/i);
    expect(() => repositoryIdentity(bare)).toThrow(/bare|work.tree/i);

    const invalid = tempDir("pitako-worktree-invalid-");
    writeFileSync(path.join(invalid, ".git"), "gitdir: missing-git-directory\n");
    expect(() => currentWorkspace(invalid)).toThrow(/Git|git/i);
    expect(() => repositoryIdentity(invalid)).toThrow(/Git|git/i);
  });
});

function initEnvSpoof(otherRepo: string, ceiling: string): { restore: () => void } {
  const values = {
    GIT_DIR: path.join(otherRepo, ".git"),
    GIT_WORK_TREE: otherRepo,
    GIT_COMMON_DIR: path.join(otherRepo, ".git"),
    GIT_CEILING_DIRECTORIES: ceiling,
    GIT_INDEX_FILE: path.join(otherRepo, ".git", "index"),
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return {
    restore() {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
