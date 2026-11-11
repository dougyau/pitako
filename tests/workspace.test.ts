import { gitFakeFixture } from "./fixtures/git-fake-fixture.ts";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { currentWorkspace, repositoryIdentity } from "../extensions/board/workspace.ts";

const identityArgs = ["rev-parse", "--is-inside-work-tree", "--is-bare-repository", "--path-format=absolute", "--git-common-dir"];
const tempDirs: string[] = [];
let fake: ReturnType<typeof gitFakeFixture>;
beforeEach(() => { fake = gitFakeFixture(); });

afterEach(() => {
  try { fake.dispose(); }
  finally { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  fake.outside(dir);
  return dir;
}

function initRepo(dir: string): void {
  fake.fakeRepo(dir);
}

describe("workspace Git identity", () => {
  test("uses two fresh Git reads per discovery and observes same-cwd identity changes", () => {
    const base = tempDir("pitako-worktree-refresh-");
    const repo = path.join(base, "repo");
    const other = path.join(base, "other");
    initRepo(repo);
    initRepo(other);
    const start = fake.calls.length;
    expect(currentWorkspace(repo)).toBe(repo);
    expect(fake.calls.length - start).toBe(2);
    expect(repositoryIdentity(repo)).toBe(path.join(repo, ".git"));
    expect(fake.calls.length - start).toBe(4);

    renameSync(path.join(repo, ".git"), path.join(base, "saved.git"));
    fake.outside(repo);
    expect(repositoryIdentity(repo)).toBe(repo);
    writeFileSync(path.join(repo, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
    fake.fakeRepo(repo, { commonDir: path.join(other, ".git") });
    expect(repositoryIdentity(repo)).toBe(path.join(other, ".git"));
    expect(currentWorkspace(repo)).toBe(repo);
    writeFileSync(path.join(repo, ".git"), "gitdir: missing-git-directory\n");
    fake.set(repo, identityArgs, { stdout: "", stderr: "fatal: invalid git directory", status: 128 });
    expect(() => repositoryIdentity(repo)).toThrow(/Git|git/i);
  });

  test("keeps worktree paths local and identifies their shared Git repository", () => {
    const base = tempDir("pitako-worktree-");
    const main = path.join(base, "main");
    const linked = path.join(base, "linked");
    const separate = path.join(base, "separate");
    initRepo(main);
    const linkedRepo = fake.fakeRepo(linked, { commonDir: path.join(main, ".git") });
    initRepo(separate);
    const mainNested = path.join(main, "src");
    const linkedNested = path.join(linked, "src");
    mkdirSync(mainNested);
    mkdirSync(linkedNested);

    fake.fakeRepo(main).inside(mainNested);
    linkedRepo.inside(linkedNested);
    const commonDir = linkedRepo.commonDir;
    expect(commonDir).toBe(path.join(main, ".git"));

    expect(currentWorkspace(mainNested)).toBe(main);
    expect(currentWorkspace(linkedNested)).toBe(linked);
    expect(repositoryIdentity(mainNested)).toBe(commonDir);
    expect(repositoryIdentity(linkedNested)).toBe(commonDir);
    expect(repositoryIdentity(separate)).not.toBe(commonDir);

    const link = path.join(base, "linked-alias");
    symlinkSync(linked, link);
    expect(currentWorkspace(link)).toBe(linked);
    expect(repositoryIdentity(link)).toBe(commonDir);

    const spoof = initEnvSpoof(separate, linkedNested);
    try {
      expect(currentWorkspace(linkedNested)).toBe(linked);
      expect(repositoryIdentity(linkedNested)).toBe(commonDir);
      for (const call of fake.calls.slice(-4)) {
        for (const key of Object.keys(call.env)) expect(key.startsWith("GIT_")).toBe(false);
      }
    } finally {
      spoof.restore();
    }
  });

  test("preserves newline and trailing-space Git paths", () => {
    const base = tempDir("pitako-worktree-path-");
    for (const name of ["with\nnewline", "with trailing ", "with trailing\n"]) {
      const repo = path.join(base, name);
      initRepo(repo);
      expect(currentWorkspace(repo)).toBe(repo);
      expect(repositoryIdentity(repo)).toBe(path.join(repo, ".git"));
    }
    const repo = path.join(base, "separate-git-dir");
    const common = path.join(base, "common\n ");
    fake.fakeRepo(repo, { commonDir: common });
    expect(currentWorkspace(repo)).toBe(repo);
    expect(repositoryIdentity(repo)).toBe(common);
  });

  test("keeps canonical non-Git directories and rejects bare or invalid Git states", () => {
    const loose = tempDir("pitako-worktree-loose-");
    const looseAlias = path.join(tempDir("pitako-worktree-alias-"), "loose");
    symlinkSync(loose, looseAlias);
    expect(currentWorkspace(looseAlias)).toBe(loose);
    expect(repositoryIdentity(looseAlias)).toBe(loose);

    const bare = tempDir("pitako-worktree-bare-");
    fake.set(bare, identityArgs, { stdout: `false\ntrue\n${bare}\n`, stderr: "", status: 0 });
    expect(() => currentWorkspace(bare)).toThrow(/bare|work.tree/i);
    expect(() => repositoryIdentity(bare)).toThrow(/bare|work.tree/i);

    const invalid = tempDir("pitako-worktree-invalid-");
    writeFileSync(path.join(invalid, ".git"), "gitdir: missing-git-directory\n");
    fake.set(invalid, identityArgs, { stdout: "", stderr: "fatal: invalid git directory", status: 128 });
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
