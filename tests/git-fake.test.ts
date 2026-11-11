import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitPort, setGitPort } from "../extensions/git-port.ts";
import { git } from "../extensions/dev-tools/git/run.ts";
import { createGitFake } from "./fixtures/git-fake.ts";
import { gitFakeBootstrap, guardEnv } from "./fixtures/git-fake-env.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pitako-git-fake-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const fake = createGitFake({ table: path.join(root, "table.json"), calls: path.join(root, "calls.jsonl"), violations: path.join(root, "violations.jsonl") });
  cleanups.push(setGitPort(fake.port));
  return { root, fake };
}

test("fixed answers use physical cwd and complete argv; set changes shared state without queues", async () => {
  const { root, fake } = fixture();
  const alias = path.join(root, "alias");
  symlinkSync(root, alias);
  fake.set(root, ["answer", "a b"], { stdout: "first\n", stderr: "", status: 0 });
  for (let i = 0; i < 2; i++) expect(gitPort().read(["answer", "a b"], { cwd: alias, encoding: "utf8" })).toBe("first\n");
  const peer = createGitFake(fake.files);
  peer.set(root, ["answer", "a b"], { stdout: "second", stderr: "diagnostic", status: 1 });
  expect(() => gitPort().read(["answer", "a b"], { cwd: root, encoding: "utf8" })).toThrow("diagnostic");
  expect(gitPort().status(["answer", "a b"], { cwd: root })).toMatchObject({ status: 1, stdout: Buffer.from("second") });
  expect(await gitPort().run({ cmd: "git", args: ["answer", "a b"], cwd: root, stdin: "commit message\n", env: { LC_ALL: "C" } }))
    .toMatchObject({ exitCode: 1, stdout: "second", stderr: "diagnostic" });
  expect(fake.calls.at(-1)).toEqual({ method: "run", args: ["answer", "a b"], cwd: root, env: { LC_ALL: "C" }, stdin: "commit message\n" });
  expect(readFileSync(fake.files.calls, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual(fake.calls);
});

test("misses in every method throw a distinctive status/stderr error and persist violations", async () => {
  const { root, fake } = fixture();
  for (const invoke of [
    () => gitPort().read(["undeclared"], { cwd: root, encoding: "utf8" }),
    () => gitPort().status(["undeclared"], { cwd: root }),
    () => gitPort().run({ cmd: "git", args: ["undeclared"], cwd: root }),
  ]) {
    try { await invoke(); throw new Error("expected miss"); }
    catch (error) {
      expect(error).toMatchObject({ status: 128, stderr: expect.stringContaining("PITAKO_GIT_FAKE_MISS") });
      expect(String(error)).not.toMatch(/not a git repository/i);
    }
  }
  expect(readFileSync(fake.files.violations, "utf8").trim().split("\n")).toHaveLength(3);
});

test("builder declares future paths, nested cwd, linked metadata and outside discovery only", async () => {
  const { root, fake } = fixture();
  const main = fake.fakeRepo(path.join(root, "main"));
  const linked = fake.fakeRepo(path.join(root, "linked"), {
    commonDir: main.commonDir, paths: ["future", "ignored"], ignored: ["ignored"], nested: ["sub"],
  });
  expect(readFileSync(path.join(linked.root, ".git"), "utf8")).toContain(`gitdir: ${main.commonDir}/worktrees/linked`);
  expect(readFileSync(path.join(main.commonDir, "worktrees/linked/commondir"), "utf8")).toBe("../..\n");
  expect(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: linked.root }))
    .toMatchObject({ stdout: main.commonDir + "\n", exitCode: 0 });
  expect(gitPort().read(["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd: path.join(linked.root, "sub"), encoding: "utf8" })).toBe(linked.root + "\n");
  expect(gitPort().status(["check-ignore", "--quiet", "--", "future"], { cwd: linked.root }).status).toBe(1);
  expect(gitPort().status(["check-ignore", "--quiet", "--", "ignored"], { cwd: linked.root }).status).toBe(0);
  writeFileSync(path.join(linked.root, "later-undeclared"), "not discovered");
  expect(() => gitPort().status(["check-ignore", "--quiet", "--", "later-undeclared"], { cwd: linked.root })).toThrow("PITAKO_GIT_FAKE_MISS");
  const outside = path.join(root, "outside"); fake.outside(outside);
  expect(() => gitPort().read(["rev-parse", "--is-inside-work-tree", "--is-bare-repository", "--path-format=absolute", "--git-common-dir"], { cwd: outside, encoding: "utf8" })).toThrow("fatal: not a git repository");
});

test("guarded Node and explicit Bun bootstraps share fixed answers silently", () => {
  const { root, fake } = fixture();
  fake.fakeRepo(root);
  const prior = { ...process.env };
  Object.assign(process.env, {
    PITAKO_TEST_GIT_TABLE: fake.files.table, PITAKO_TEST_GIT_CALLS: fake.files.calls,
    PITAKO_TEST_GIT_VIOLATIONS: fake.files.violations,
    PITAKO_TEST_GIT_SENTINEL: "/owned/sentinel", PITAKO_TEST_GIT_SENTINEL_LOG: "/owned/sentinel-log",
  });
  try {
    const env = guardEnv({ PATH: "/fixture/bin:/usr/bin:/bin", NODE_OPTIONS: "--no-warnings" });
    expect(env.PATH).toBe("/fixture/bin:/owned/sentinel:/usr/bin:/bin");
    expect(guardEnv(env)).toEqual(env);
    expect(env.PITAKO_TEST_GIT_SENTINEL_LOG).toBe("/owned/sentinel-log");
    const script = `console.log(globalThis[Symbol.for("pitako.git-port")].read(["rev-parse","HEAD"], {cwd:${JSON.stringify(root)},encoding:"utf8"}).trim());`;
    // Child lookup uses the host's runtime PATH, not the ordering-only fixture above.
    for (const [executable, source] of [
      ["node", script],
      [process.execPath, `import ${JSON.stringify(gitFakeBootstrap)}; ${script}`],
    ]) {
      const result = spawnSync(executable!, ["--eval", source!], {
        env: guardEnv({ ...process.env, ...env, PATH: prior.PATH }), encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("1".repeat(40) + "\n");
    }
    expect(readFileSync(fake.files.calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(fake.files.violations, "utf8")).toBe("");
  } finally {
    for (const name of ["PITAKO_TEST_GIT_TABLE", "PITAKO_TEST_GIT_CALLS", "PITAKO_TEST_GIT_VIOLATIONS",
      "PITAKO_TEST_GIT_SENTINEL", "PITAKO_TEST_GIT_SENTINEL_LOG"]) {
      if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
    }
  }
});
