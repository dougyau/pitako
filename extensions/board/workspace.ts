import { execFileSync } from "node:child_process";
import { canonicalPath } from "./paths.ts";

/** Git repository root, or the canonical cwd when this directory is not a repository. */
export function currentWorkspace(cwd = process.cwd()): string {
  return canonicalPath(gitTopLevel(cwd) ?? cwd);
}

function gitTopLevel(cwd: string): string | undefined {
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}
