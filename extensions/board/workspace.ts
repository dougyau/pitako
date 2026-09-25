import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalPath } from "./paths.ts";
import { PitakoConfigError } from "../errors.ts";

/** Physical Git worktree root, or the canonical cwd when this directory is not a repository. */
export function currentWorkspace(cwd = process.cwd()): string {
  return workspacePaths(cwd).worktreeRoot;
}

/** Canonical Git common directory, or the canonical cwd when this directory is not a repository. */
export function repositoryIdentity(cwd = process.cwd()): string {
  return workspacePaths(cwd).commonDir;
}

export interface BoardWorkspace {
  identity: string;
  physicalRoot: string;
  legacyRoots: string[];
}

/** Board family key plus verified physical roots that may contain legacy rows. */
export function boardWorkspace(cwd = process.cwd()): BoardWorkspace {
  const { worktreeRoot: physicalRoot, commonDir: identity } = workspacePaths(cwd);
  const legacyRoots = identity === physicalRoot ? [physicalRoot] : registeredWorktrees(physicalRoot, identity, true);
  if (!legacyRoots.includes(physicalRoot)) {
    throw new PitakoConfigError(`caller worktree is not registered with Git: ${physicalRoot}`);
  }
  return { identity, physicalRoot, legacyRoots };
}

function workspacePaths(cwd: string): { worktreeRoot: string; commonDir: string } {
  const physicalCwd = canonicalPath(cwd);
  const git = gitPaths(physicalCwd);
  return git ?? { worktreeRoot: physicalCwd, commonDir: physicalCwd };
}

function gitPaths(cwd: string): { worktreeRoot: string; commonDir: string } | undefined {
  let state: string;
  try {
    state = revParse(cwd, ["--is-inside-work-tree", "--is-bare-repository"]);
  } catch (error) {
    const message = gitErrorMessage(error);
    if (/not a git repository/i.test(message) && !hasGitMetadata(cwd)) return undefined;
    throw new Error(`Git discovery failed in ${cwd}: ${message}`);
  }

  const [inside, bare, ...extra] = state.split("\n");
  if (bare === "true") throw new Error(`Git repository is bare; no worktree exists for ${cwd}`);
  if (inside !== "true" || extra.length > 0) throw new Error(`Git repository state is invalid for ${cwd}`);

  const commonDir = revParse(cwd, ["--path-format=absolute", "--git-common-dir"]);
  const topLevel = revParse(cwd, ["--path-format=absolute", "--show-toplevel"]);
  return {
    worktreeRoot: canonicalGitDirectory(topLevel, "worktree root"),
    commonDir: canonicalGitDirectory(commonDir, "common directory"),
  };
}

function revParse(cwd: string, args: string[]): string {
  const output = execFileSync("git", ["rev-parse", ...args], {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.endsWith("\n") ? output.slice(0, -1) : output;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}

function gitErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = error.stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
    if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf8").trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function hasGitMetadata(cwd: string): boolean {
  let current = cwd;
  while (true) {
    try {
      lstatSync(path.join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    if (["HEAD", "objects", "refs"].every((name) => existsAt(path.join(current, name)))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function existsAt(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function canonicalGitDirectory(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`Git ${label} is not absolute: ${value}`);
  const canonical = realpathSync(value);
  if (!statSync(canonical).isDirectory()) throw new Error(`Git ${label} is not a directory: ${value}`);
  return canonical;
}

interface WorktreeEntry {
  path: string;
  prunable: boolean;
}

/** Verify Git's registered worktrees before inspecting any worktree-local artifacts. */
export function registeredWorktrees(root: string, commonDir: string, strict = false): string[] {
  let output: string;
  try {
    output = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: root,
      encoding: "utf8",
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new PitakoConfigError(`Git worktree listing failed in ${root}: ${gitErrorMessage(error)}`);
  }

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const entry of parseWorktreeList(output)) {
    let state: ReturnType<typeof lstatSync>;
    try {
      state = lstatSync(entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && entry.prunable && !strict) continue;
      throw new PitakoConfigError(`registered worktree ${entry.path} is unavailable: ${gitErrorMessage(error)}`);
    }
    let physical: string;
    try {
      physical = realpathSync(entry.path);
      if (!statSync(physical).isDirectory()) throw new Error("worktree root is not a directory");
      const identity = repositoryIdentity(physical);
      if (identity !== commonDir) throw new Error(`Git common directory ${identity} does not match caller ${commonDir}`);
    } catch (error) {
      throw new PitakoConfigError(`registered worktree ${entry.path} cannot be verified: ${gitErrorMessage(error)}`);
    }
    if (!state.isDirectory() && !state.isSymbolicLink()) {
      throw new PitakoConfigError(`registered worktree ${entry.path} is not a directory`);
    }
    if (seen.has(physical)) throw new PitakoConfigError(`Git worktree list contains duplicate root ${physical}`);
    seen.add(physical);
    roots.push(physical);
  }
  return roots;
}

function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  const finish = () => {
    if (current) entries.push(current);
    current = undefined;
  };
  for (const field of output.split("\0")) {
    if (field.length === 0) finish();
    else if (field.startsWith("worktree ")) {
      finish();
      const worktreePath = field.slice("worktree ".length);
      if (!worktreePath || !path.isAbsolute(worktreePath)) {
        throw new PitakoConfigError(`Git worktree list contains invalid path "${worktreePath}"`);
      }
      current = { path: worktreePath, prunable: false };
    } else if (!current) {
      throw new PitakoConfigError(`Git worktree list contains unexpected field "${field}"`);
    } else if (/^prunable(?: |$)/.test(field)) current.prunable = true;
  }
  finish();
  if (entries.length === 0) throw new PitakoConfigError("Git worktree list contains no registered roots");
  return entries;
}
