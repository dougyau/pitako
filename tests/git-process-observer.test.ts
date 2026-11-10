import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { observeGitProcesses } from "../extensions/git-process-observer.ts";
import { gitRead, withIndexReads } from "../extensions/spec-plans.ts";
import { workspacePaths, registeredWorktrees } from "../extensions/board/workspace.ts";

test("Git process observations belong to the most specific owned root and dispose independently", () => {
  const base = mkdtempSync(path.join(tmpdir(), "pitako-git-processes-"));
  const root = path.join(base, "owned"), sibling = path.join(base, "owned-sibling");
  const nested = path.join(root, "nested");
  const disposers: (() => void)[] = [];
  try {
    mkdirSync(root); mkdirSync(sibling); mkdirSync(nested);
    for (const cwd of [root, sibling]) execFileSync("git", ["init", "-q"], { cwd });
    let parentCalls = 0, nestedCalls = 0, siblingCalls = 0;
    disposers.push(observeGitProcesses(root, () => { parentCalls++; }));
    const disposeNested = observeGitProcesses(nested, () => { nestedCalls++; });
    disposers.push(disposeNested, observeGitProcesses(sibling, () => { siblingCalls++; }));
    expect(() => observeGitProcesses(root, () => {})).toThrow("already registered");
    gitRead(sibling, "rev-parse", "--git-dir");
    workspacePaths(nested); // Both workspace rev-parse execFileSync calls.
    registeredWorktrees(root, path.join(root, ".git")); // list + identity's two rev-parses.
    expect([parentCalls, nestedCalls, siblingCalls]).toEqual([3, 2, 1]);
    const alias = path.join(base, "alias");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => observeGitProcesses(alias, () => {})).toThrow("already registered");
    gitRead(alias, "rev-parse", "--git-dir");
    expect(parentCalls).toBe(4);
    disposeNested();
    gitRead(nested, "rev-parse", "--git-dir");
    expect([parentCalls, nestedCalls, siblingCalls]).toEqual([5, 2, 1]);
    withIndexReads(() => {
      // An unborn HEAD fails and is counted too; no cache entry is fabricated.
      expect(() => gitRead(root, "rev-parse", "HEAD")).toThrow();
    });
    expect(parentCalls).toBe(6);
    for (const dispose of disposers) dispose();
    gitRead(root, "rev-parse", "--git-dir");
    expect(parentCalls).toBe(6);
  } finally {
    for (const dispose of disposers) dispose();
    rmSync(base, { recursive: true, force: true });
  }
});
