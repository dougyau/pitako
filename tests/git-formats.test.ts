import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setGitPort } from "../extensions/git-port.ts";
import { checkoutSnapshot, digest } from "../extensions/spec-plans.ts";
import { registeredWorktrees, workspacePaths } from "../extensions/board/workspace.ts";
import { parsePorcelainV2 } from "../extensions/dev-tools/git/status.ts";
import { parseWorktrees } from "../extensions/dev-tools/git/worktree.ts";
import checkpointCreate from "../extensions/checkpoint-create.ts";
import { EXECUTE_STATE_VERSION, executionStatePath } from "../extensions/execute-state.ts";
import { checkpointDirectory, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { createGitFake } from "./fixtures/git-fake.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pitako-git-formats-")));
  const fake = createGitFake({ table: path.join(dir, "table.json"), calls: path.join(dir, "calls.jsonl"), violations: path.join(dir, "violations.jsonl") });
  cleanups.push(() => {
    try { expect(readFileSync(fake.files.violations, "utf8")).toBe(""); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  cleanups.push(setGitPort(fake.port));
  return { dir, fake };
}

test("checkout consumes fixed NUL paths/stages, preserves quoted v1 status and hashes duplicate gitlink stages", () => {
  const { dir, fake } = fixture();
  const root = path.join(dir, "repo"), a = "a".repeat(40), b = "b".repeat(40);
  const status = ' M "tab\\tname"\nR  old -> "new name"\n?? "line\\nname"\n';
  fake.fakeRepo(root, { paths: ["line\nname", "module", "missing", "line\nname"],
    stage: `100644 ${a} 0\tline\nname\0` + `160000 ${a} 1\tmodule\0` + `160000 ${b} 2\tmodule\0`,
    status: { v1: status } });
  writeFileSync(path.join(root, "line\nname"), "bytes");
  mkdirSync(path.join(root, "module"));
  const snapshot = checkoutSnapshot(root);
  expect(snapshot.evidence).toMatchObject({ head: "1".repeat(40), branch: "main", status });
  expect(Object.keys(snapshot.files).sort()).toEqual(["line\nname", "missing", "module"]);
  expect(snapshot.files["line\nname"]).toMatchObject({ hash: digest("bytes") });
  expect(snapshot.files.missing).toBeNull();
  expect(snapshot.files.module).toEqual({ hash: digest(JSON.stringify([`${a} 1`, `${b} 2`]) + "uninitialized"), mode: statSync(path.join(root, "module")).mode });
  fake.set(root, ["ls-files", "--stage", "-z"], { stdout: `160000 ${a} 1\tmodule\0`, stderr: "", status: 0 });
  expect(checkoutSnapshot(root).evidence.fingerprint).not.toBe(snapshot.evidence.fingerprint);
});

test("porcelain v2 handles unknown headers, unquoted rename origins, conflicts and branch tracking", () => {
  const parsed = parsePorcelainV2([
    "# branch.head feature", "# branch.upstream origin/feature", "# branch.ab +2 -3", "# future.header ignored",
    "1 .M N... 100644 100644 100644 aaa aaa spaced name",
    "2 R. N... 100644 100644 100644 aaa aaa R100 renamed\npath", "original\tpath",
    "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict",
    "? new\nfile", "! ignored", "",
  ].join("\0"));
  expect(parsed).toEqual({ branch: "feature", upstream: "origin/feature", tracked: true, ahead: 2, behind: 3,
    staged: [{ path: "renamed\npath", code: "R.", from: "original\tpath" }],
    unstaged: [{ path: "spaced name", code: ".M" }], untracked: ["new\nfile"], conflicted: [{ path: "conflict", code: "UU" }] });
  expect(parsePorcelainV2("# branch.head (detached)\0# branch.upstream gone\0")).toMatchObject({ branch: null, tracked: false });
});

test("fixed worktree records preserve bare/prunable flags and Board skips only prunable missing roots", () => {
  const { dir, fake } = fixture();
  const { root, commonDir } = fake.fakeRepo(path.join(dir, "main"));
  const linked = fake.fakeRepo(path.join(dir, "linked"), { commonDir });
  const missing = path.join(dir, "missing");
  const output = `worktree ${root}\0HEAD abc\0branch refs/heads/main\0\0worktree ${linked.root}\0HEAD def\0detached\0locked maintenance\0\0worktree ${dir}/bare\0bare\0\0worktree ${missing}\0prunable gitdir file missing\0\0`;
  expect(parseWorktrees(output)).toMatchObject([
    { path: root, main: true, branch: "main" }, { path: linked.root, detached: true, locked: true, lockReason: "maintenance" },
    { bare: true }, { path: missing, prunable: true, prunableReason: "gitdir file missing" },
  ]);
  fake.set(root, ["worktree", "list", "--porcelain", "-z"], { stdout: output, stderr: "", status: 0 });
  expect(registeredWorktrees(root, commonDir)).toEqual([root, linked.root]);
  expect(() => registeredWorktrees(root, commonDir, true)).toThrow("unavailable");
  fake.set(root, ["worktree", "list", "--porcelain", "-z"], { stdout: `worktree ${missing}\0\0`, stderr: "", status: 0 });
  expect(() => registeredWorktrees(root, commonDir)).toThrow("unavailable");
});

test("rev-parse identity preserves newline paths and rejects bare or relative answers", () => {
  const { dir, fake } = fixture();
  const { root, commonDir, inside } = fake.fakeRepo(path.join(dir, "repo\nname"));
  const nested = path.join(root, "nested"); inside(nested);
  expect(workspacePaths(nested)).toEqual({ worktreeRoot: root, commonDir });
  const args = ["rev-parse", "--is-inside-work-tree", "--is-bare-repository", "--path-format=absolute", "--git-common-dir"];
  fake.set(root, args, { stdout: `false\ntrue\n${commonDir}\n`, stderr: "", status: 0 });
  expect(() => workspacePaths(root)).toThrow("bare");
  fake.set(root, args, { stdout: "true\nfalse\nrelative\n", stderr: "", status: 0 });
  expect(() => workspacePaths(root)).toThrow("not absolute");
});

test.each([0, 1, 128])("check-ignore status %i is consumed by the write hook (fatal fails closed)", status => {
  const { dir, fake } = fixture();
  const { root, commonDir } = fake.fakeRepo(path.join(dir, "repo"), { paths: ["file"] });
  fake.set(root, ["check-ignore", "--quiet", "--", "file"], { stdout: "", stderr: status === 128 ? "fatal" : "", status });
  const association = { root, commonDir, missionId: "mission", missionPath: path.join(dir, "mission.json"), invocation: "formats",
    source: path.join(root, "spec.md"), digest: "a".repeat(64), maxCycles: 30, sourceRefs: [] };
  const intent: CheckpointIntent = { version: 2, association, key: "worker", taskId: "task", attempt: 1, loop: 1, cursor: 0,
    phase: "implementation", planRef: { key: "plan" }, progress: { consumedLoops: 1, admitted: {}, previous: null } };
  const state = executionStatePath(association);
  mkdirSync(path.dirname(state), { recursive: true });
  writeFileSync(state, JSON.stringify({ "invoke-formats": { version: EXECUTE_STATE_VERSION, association, consumedLoops: 1, tasks: {},
    loop: { number: 1, cursor: 0, phase: "implementation", plan: { stage: "admitted", ref: intent.planRef }, manifest: ["task"],
      attempt: { key: "worker", bindingKey: "worker", taskId: "task", number: 1, index: 0, stage: "launched", checkpoint: intent } } } }));
  const handlers: Record<string, Function> = {};
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  try {
    process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pitako.checkpoint/1": { association, key: "worker" } });
    checkpointCreate({ on(name: string, fn: Function) { handlers[name] = fn; }, registerTool() {} } as unknown as ExtensionAPI);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous;
  }
  const result = handlers.tool_call!({ toolName: "write", toolCallId: "call", input: { path: "file" } }, { cwd: root });
  if (status === 128) expect(result).toMatchObject({ block: true, reason: "Cannot determine whether write path is gitignored." });
  else {
    expect(result).toBeUndefined();
    expect(existsSync(checkpointDirectory(intent))).toBe(status === 1);
    handlers.tool_result!({ toolCallId: "call" });
    // Ignored paths create no effect; nonignored paths capture the missing preimage.
    const captureCall = fake.calls.filter(call => call.args[0] === "check-ignore");
    expect(captureCall).toHaveLength(1);
  }
});
