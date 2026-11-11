import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitPort } from "../extensions/git-port.ts";
import { createGitFake } from "./fixtures/git-fake.ts";
import { gitFakeBootstrap, guardEnv } from "./fixtures/git-fake-env.ts";
import { gitLaunches } from "./fixtures/git-launch-scan.ts";

test("preload denies undeclared calls, propagates fixed answers, and records sentinel diagnostics", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pitako-guard-self-test-")));
  const fake = createGitFake({ table: path.join(root, "table.json"), calls: path.join(root, "calls.jsonl"), violations: path.join(root, "violations.jsonl") });
  try {
    expect(process.env.PATH!.split(":")[0]).toBe(process.env.PITAKO_TEST_GIT_SENTINEL!);
    // Exercise the actual preload port without leaving an intentional violation in its log.
    const violationFile = process.env.PITAKO_TEST_GIT_VIOLATIONS!;
    const priorViolations = readFileSync(violationFile, "utf8");
    try {
      expect(() => gitPort().read(["guard-self-test-miss"], { cwd: root, encoding: "utf8" })).toThrow("PITAKO_GIT_FAKE_MISS");
      expect(readFileSync(violationFile, "utf8").slice(priorViolations.length)).toContain("guard-self-test-miss");
    } finally {
      writeFileSync(violationFile, priorViolations);
    }
    fake.fakeRepo(root);
    const env = guardEnv({ ...process.env, PITAKO_TEST_GIT_TABLE: fake.files.table,
      PITAKO_TEST_GIT_CALLS: fake.files.calls, PITAKO_TEST_GIT_VIOLATIONS: fake.files.violations });
    const source = `console.log(globalThis[Symbol.for("pitako.git-port")].read(["rev-parse","HEAD"], {cwd:${JSON.stringify(root)},encoding:"utf8"}).trim());`;
    for (const [executable, script] of [
      ["node", source],
      [process.execPath, `import ${JSON.stringify(gitFakeBootstrap)}; ${source}`],
    ]) {
      const result = spawnSync(executable!, ["--eval", script!], { cwd: root, env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("1".repeat(40) + "\n");
      expect(result.stderr).toBe("");
    }
    expect(readFileSync(fake.files.calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(fake.files.violations, "utf8")).toBe("");

    const sentinelLog = process.env.PITAKO_TEST_GIT_SENTINEL_LOG!;
    const priorHits = readFileSync(sentinelLog, "utf8");
    try {
      const sentinel = spawnSync("git", ["guard-sentinel", "space argument"], { cwd: root, encoding: "utf8" });
      expect(sentinel.status).toBe(128);
      expect(sentinel.stderr).toContain("PITAKO_GIT_SENTINEL");
      const hits = readFileSync(sentinelLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(hits.at(-1)).toEqual({ args: ["guard-sentinel", "space argument"], cwd: root, ppid: process.pid });
    } finally {
      writeFileSync(sentinelLog, priorHits);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a swallowed fake miss fails nested parallel discovery through the preload hook", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-guard-nested-"));
  try {
    const preload = new URL("./fixtures/git-guard-preload.ts", import.meta.url).pathname;
    writeFileSync(path.join(root, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(preload)}]\n`);
    writeFileSync(path.join(root, "violation.test.ts"), `
import { test } from "bun:test";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(path.join(root, "guard-root"))}, process.env.PITAKO_TEST_GIT_VIOLATIONS);
test("swallowed caller error", () => {
  try { globalThis[Symbol.for("pitako.git-port")].read(["nested-miss"], {cwd:process.cwd(),encoding:"utf8"}); }
  catch {}
});
`);
    writeFileSync(path.join(root, "clean.test.ts"), `
import { test, expect, afterAll } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
const table = process.env.PITAKO_TEST_GIT_TABLE;
test("independent file", () => expect(true).toBe(true));
afterAll(() => writeFileSync(${JSON.stringify(path.join(root, "cleanup-order"))},
  String(table === process.env.PITAKO_TEST_GIT_TABLE && existsSync(table))));
`);
    const result = spawnSync(process.execPath, ["test", "--parallel"], { cwd: root, env: guardEnv({ ...process.env }), encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PITAKO_GIT_FAKE_MISS");
    expect(result.stderr).toContain("nested-miss");
    expect(result.stderr).toContain("independent file");
    expect(readFileSync(path.join(root, "cleanup-order"), "utf8")).toBe("true");
    const violations = readFileSync(path.join(root, "guard-root"), "utf8");
    expect(violations).not.toBe(process.env.PITAKO_TEST_GIT_VIOLATIONS!);
    expect(JSON.parse(readFileSync(violations, "utf8").trim()).args).toEqual(["nested-miss"]);
  } finally {
    // The intentionally failing preload retains its evidence; this self-test owns it.
    try {
      if (existsSync(path.join(root, "guard-root"))) {
        const violations = readFileSync(path.join(root, "guard-root"), "utf8");
        rmSync(path.dirname(violations), { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("static Git launch scan covers Pitako-owned sources with only the declared sentinel probe allowed", () => {
  // Assemble data samples so they cannot be mistaken for executable launch sites by the textual scan.
  const quotedGit = JSON.stringify("git");
  for (const source of [
    `spawnSync(${quotedGit}, [])`, `execFile(${quotedGit}, [])`, `exec(${JSON.stringify("git status")})`,
    `Bun.spawn([${quotedGit}])`, `Bun.spawn({cwd:root,cmd:[${quotedGit}]})`, `Bun.which(${quotedGit})`,
    ["/usr", "bin", "git"].join("/"),
  ]) expect(gitLaunches(source)).toHaveLength(1);
  expect(gitLaunches(`const command = ${quotedGit};`)).toEqual([]);

  const root = path.resolve(import.meta.dir, "..");
  const offenders: string[] = [];
  function walk(relative: string) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile() || file === "extensions/git-port.ts") continue;
      let source = readFileSync(path.join(root, file), "utf8");
      // This sole executable exception probes the non-delegating sentinel above.
      if (file === "tests/git-port-guard.test.ts")
        source = source.replace(`spawnSync(${quotedGit}, ["guard-sentinel", "space argument"], { cwd: root, encoding: "utf8" })`, "");
      for (const launch of gitLaunches(source)) offenders.push(`${file}: ${launch}`);
    }
  }
  for (const directory of ["tests", "extensions", "skills"]) walk(directory);
  expect(offenders).toEqual([]);
});
