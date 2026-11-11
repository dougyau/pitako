import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createGitFakePort } from "./git-fake-port.mjs";

export type GitResponse = { stdout: string; stderr: string; status: number };
export type GitCall = { method: "read" | "status" | "run"; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string | null };
export type GitFakeFiles = { table: string; calls: string; violations: string };
export type FakeRepoOptions = {
  head?: string;
  branch?: string;
  commonDir?: string;
  paths?: readonly string[];
  stage?: string;
  cachedDiff?: string;
  status?: { v1?: string; v2?: string };
  worktrees?: string;
  ignored?: readonly string[];
  nested?: readonly string[];
};
const exclusions = [".", ":(top,exclude).pi", ":(top,exclude).pitako"];
const response = (stdout = "", status = 0, stderr = ""): GitResponse => ({ stdout, stderr, status });
const key = (cwd: string, args: readonly string[]) => JSON.stringify([realpathSync(cwd), args]);

/** All answers are explicit table entries; real files are used only for identity and caller hashing. */
export function createGitFake(files: GitFakeFiles) {
  for (const file of Object.values(files)) {
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, file === files.table ? "{}" : "");
  }
  const calls: GitCall[] = [];
  const table = (): Record<string, GitResponse> => JSON.parse(readFileSync(files.table, "utf8"));
  function set(cwd: string, args: readonly string[], answer: GitResponse) {
    const entries = table();
    entries[key(cwd, args)] = answer;
    writeFileSync(files.table, JSON.stringify(entries));
  }
  const port = createGitFakePort(files, calls);
  function fakeRepo(root: string, options: FakeRepoOptions = {}) {
    mkdirSync(root, { recursive: true });
    root = realpathSync(root);
    const head = options.head ?? "1".repeat(40), branch = options.branch ?? "main";
    const commonDir = path.resolve(options.commonDir ?? path.join(root, ".git"));
    mkdirSync(commonDir, { recursive: true });
    if (commonDir !== path.join(root, ".git")) {
      const admin = path.join(commonDir, "worktrees", path.basename(root));
      mkdirSync(admin, { recursive: true });
      writeFileSync(path.join(root, ".git"), `gitdir: ${admin}\n`);
      writeFileSync(path.join(admin, "commondir"), "../..\n");
      writeFileSync(path.join(admin, "gitdir"), path.join(root, ".git") + "\n");
      writeFileSync(path.join(admin, "HEAD"), branch === "HEAD" ? head + "\n" : `ref: refs/heads/${branch}\n`);
    }
    const put = (args: string[], stdout: string) => set(root, args, response(stdout));
    put(["rev-parse", "--is-inside-work-tree", "--is-bare-repository", "--path-format=absolute", "--git-common-dir"], `true\nfalse\n${commonDir}\n`);
    put(["rev-parse", "--path-format=absolute", "--show-toplevel"], root + "\n");
    put(["--no-pager", "--literal-pathspecs", "rev-parse", "--path-format=absolute", "--git-common-dir"], commonDir + "\n");
    put(["rev-parse", "--is-inside-work-tree"], "true\n");
    put(["rev-parse", "HEAD"], head + "\n");
    put(["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], `${head}\n${branch}\n`);
    put(["diff", "--cached", "--binary", "--", ...exclusions], options.cachedDiff ?? "");
    put(["diff", "--cached", "--binary"], options.cachedDiff ?? "");
    put(["ls-files", "--stage", "-z"], options.stage ?? "");
    put(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...exclusions], (options.paths ?? []).map(p => p + "\0").join(""));
    put(["status", "--porcelain=v1", "--untracked-files=normal"], options.status?.v1 ?? "");
    put(["--no-pager", "--literal-pathspecs", "status", "--porcelain=v2", "-b", "-z", "--untracked-files=all"],
      options.status?.v2 ?? `# branch.head ${branch === "HEAD" ? "(detached)" : branch}\0`);
    const worktrees = options.worktrees ?? `worktree ${root}\0HEAD ${head}\0${branch === "HEAD" ? "detached" : `branch refs/heads/${branch}`}\0\0`;
    put(["worktree", "list", "--porcelain", "-z"], worktrees);
    put(["--no-pager", "--literal-pathspecs", "worktree", "list", "--porcelain", "-z"], worktrees);
    for (const p of new Set([...(options.paths ?? []), ...(options.ignored ?? [])]))
      set(root, ["check-ignore", "--quiet", "--", p], response("", options.ignored?.includes(p) ? 0 : 1));
    function inside(dir: string) {
      // Copy declarations once; later set() calls address their exact cwd, including nested cwds.
      mkdirSync(dir, { recursive: true });
      const entries = table();
      for (const [encoded, answer] of Object.entries(entries)) {
        const [cwd, args] = JSON.parse(encoded) as [string, string[]];
        if (cwd === root) set(dir, args, answer);
      }
    }
    for (const dir of options.nested ?? []) inside(path.resolve(root, dir));
    return { root, commonDir, inside };
  }
  function outside(dir: string) {
    mkdirSync(dir, { recursive: true });
    set(dir, ["rev-parse", "--is-inside-work-tree", "--is-bare-repository", "--path-format=absolute", "--git-common-dir"],
      response("", 128, "fatal: not a git repository"));
    set(dir, ["rev-parse", "--is-inside-work-tree"], response("", 128, "fatal: not a git repository"));
  }
  return { port, files, calls, set, fakeRepo, outside };
}
