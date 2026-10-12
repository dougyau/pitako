import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

const node = Bun.which("node");
if (!node) throw new Error("worktree setup tests require Node");
const nodePath: string = node;
const gitEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(gitEnv)) if (key.startsWith("GIT_")) delete gitEnv[key];
Object.assign(gitEnv, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" });

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, env: gitEnv, encoding: "utf8", timeout: 10000,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return result.stdout;
}

function repository(root: string) {
  const principal = path.join(root, "z principal with spaces");
  const target = path.join(root, "a linked with spaces");
  mkdirSync(principal);
  git(principal, "init", "-b", "main");
  git(principal, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  git(principal, "worktree", "add", "-b", "linked", target);
  return { principal, target };
}

function runNode(source: string, env: Record<string, string> = {}) {
  const result = spawnSync(nodePath, ["--input-type=module", "-"], {
    input: source, env: { ...gitEnv, ...env }, encoding: "utf8", timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).not.toContain("AssertionError");
  expect(result.status, result.stderr).toBe(0);
  return result;
}

test("premise: Git's first NUL-delimited record identifies the principal, not path sort order", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-worktree-git-"));
  try {
    const { principal, target } = repository(root);
    const records = git(target, "worktree", "list", "--porcelain", "-z").split("\0\0");
    expect(records[0]?.split("\0")[0]).toBe(`worktree ${principal}`);
    expect(records[1]?.split("\0")[0]).toBe(`worktree ${target}`);
    expect(git(target, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(
      git(principal, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The writer stays open until after the snapshot and source observations.
const walFixture = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const source = process.env.SOURCE_DB;
const writer = new DatabaseSync(source);
try {
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('committed in WAL')");
  const mainBefore = readFileSync(source);
  const walBefore = readFileSync(source + "-wal");
  assert.ok(walBefore.length > 0);
  const rows = writer.prepare("SELECT * FROM entries").all();
  SNAPSHOT
  assert.deepEqual(writer.prepare("SELECT * FROM entries").all(), rows);
  assert.deepEqual(readFileSync(source), mainBefore);
  assert.deepEqual(readFileSync(source + "-wal"), walBefore);
  const copied = new DatabaseSync(process.env.COPY_DB, { readOnly: true });
  try { assert.deepEqual(copied.prepare("SELECT * FROM entries").all(), rows); }
  finally { copied.close(); }
} finally { writer.close(); }
console.log("Committed WAL rows included; source rows, main DB and WAL bytes unchanged.");
`;

test("premise: Node readonly VACUUM INTO snapshots committed WAL without checkpointing source", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-worktree-sqlite-"));
  try {
    const result = runNode(walFixture.replace("SNAPSHOT", `
      const reader = new DatabaseSync(source, { readOnly: true });
      try {
        assert.throws(() => reader.exec("INSERT INTO entries VALUES ('forbidden')"), /readonly/);
        reader.prepare("VACUUM INTO ?").run(process.env.COPY_DB);
      } finally { reader.close(); }
    `), { SOURCE_DB: path.join(root, "source.db"), COPY_DB: path.join(root, "snapshot.db") });
    expect(result.stdout).toContain("source rows, main DB and WAL bytes unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-worktree-setup-"));
  try {
    const { principal, target } = repository(root);
    const bin = path.join(root, "bin");
    const log = path.join(root, "calls.jsonl");
    mkdirSync(bin);
    for (const checkout of [principal, target]) {
      mkdirSync(path.join(checkout, "scripts"));
      copyFileSync(new URL("../scripts/setup-worktree.sh", import.meta.url), path.join(checkout, "scripts/setup-worktree.sh"));
      writeFileSync(path.join(checkout, "scripts/setup.sh"), `#!/bin/bash
set -e
"$REAL_NODE" -e 'require("node:fs").appendFileSync(process.env.CALL_LOG, JSON.stringify({command:"setup", cwd:process.cwd(), args:process.argv.slice(1)})+"\\n")' -- "$@"
exit "\${SETUP_EXIT:-0}"
`);
    }
    function cli(file: string, name: string) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `#!${nodePath}
const fs = require("node:fs");
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({
  command:${JSON.stringify(name)}, cwd:process.cwd(), args:process.argv.slice(2),
  env: ["CODEGRAPH_NO_WATCH","CODEGRAPH_FORCE_WATCH","CODEGRAPH_NO_DOWNLOAD","DO_NOT_TRACK"].map(key => process.env[key]),
  dbExists: fs.existsSync(require("node:path").join(process.cwd(), process.env.EXPECTED_GRAPH_DIR, "codegraph.db")),
})+"\\n");
process.exit(Number(process.env.CODEGRAPH_EXIT || 0));
`);
      chmodSync(file, 0o755);
    }
    const onPath = path.join(bin, "codegraph");
    cli(onPath, "codegraph");
    // Only the CLI is doubled. Git and Node exercise native discovery and SQLite.
    symlinkSync(nodePath, path.join(bin, "node"));
    const env = {
      ...gitEnv, PATH: `${bin}:/usr/bin:/bin`, CALL_LOG: log, REAL_NODE: nodePath,
      CODEGRAPH_DIR: "", EXPECTED_GRAPH_DIR: ".codegraph", T3CODE_PROJECT_ROOT: path.join(root, "not-the-principal"),
      CODEGRAPH_NO_WATCH: "1", CODEGRAPH_FORCE_WATCH: "0", CODEGRAPH_NO_DOWNLOAD: "0", DO_NOT_TRACK: "0",
    };
    const wrapper = (checkout = target) => path.join(checkout, "scripts/setup-worktree.sh");
    function run(overrides: Record<string, string> = {}, checkout = target) {
      writeFileSync(log, "");
      const result = spawnSync("/bin/bash", [wrapper(checkout)], {
        cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      return { ...result, calls: calls() };
    }
    function calls(): Array<{ command: string; cwd: string; args: string[]; env?: string[]; dbExists?: boolean }> {
      return readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    }
    return { root, principal, target, bin, log, cli, onPath, env, wrapper, run, calls };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function database(checkout: string, value: string, graphDir = ".codegraph") {
  const directory = path.join(checkout, graphDir);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "codegraph.db");
  runNode(`
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.env.DB);
    try {
      db.exec("CREATE TABLE entries(value TEXT)");
      db.prepare("INSERT INTO entries VALUES (?)").run(process.env.VALUE);
    } finally { db.close(); }
  `, { DB: file, VALUE: value });
  return file;
}

function expectInvocation(result: ReturnType<ReturnType<typeof fixture>["run"]>, target: string, operation: "init" | "sync", cli = "codegraph") {
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Worktree setup complete.");
  expect(result.calls).toEqual([
    { command: "setup", cwd: target, args: ["--skip-codegraph"] },
    { command: cli, cwd: target, args: [operation, target, ...(operation === "init" ? ["--yes"] : [])],
      env: ["0", "1", "1", "1"], dbExists: operation === "sync" },
  ]);
}

test("T3 declares one synchronous worktree hook and its command prepares the target", () => {
  const declaration = JSON.parse(readFileSync(new URL("../t3.json", import.meta.url), "utf8"));
  expect(declaration).toEqual({
    $schema: "https://t3.codes/schema/t3.json",
    scripts: [{
      name: "Setup worktree", command: "bash scripts/setup-worktree.sh", icon: "configure",
      runOnWorktreeCreate: true, async: false,
    }],
  });
  expect(existsSync(new URL("../scripts/setup-worktree.sh", import.meta.url))).toBe(true);
  const f = fixture();
  try {
    const source = database(f.principal, "principal snapshot");
    const sourceBefore = readFileSync(source);
    writeFileSync(f.log, "");
    const result = spawnSync("/bin/bash", ["-c", declaration.scripts[0].command], {
      cwd: f.target, env: f.env, encoding: "utf8", timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expectInvocation({ ...result, calls: f.calls() }, f.target, "sync");
    const destination = path.join(f.target, ".codegraph/codegraph.db");
    runNode(`
      import assert from "node:assert/strict";
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.env.DB, { readOnly: true });
      try { assert.equal(db.prepare("SELECT value FROM entries").get().value, "principal snapshot"); }
      finally { db.close(); }
    `, { DB: destination });
    expect(readFileSync(source)).toEqual(sourceBefore);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("worktree setup initializes empty folders, selects CLI PATH before target fallback and overrides child env", () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.target, ".codegraph"));
    mkdirSync(path.join(f.principal, ".codegraph"));
    const bundled = path.join(f.target, "node_modules/.bin/codegraph");
    f.cli(bundled, "bundled-codegraph");
    expectInvocation(f.run(), f.target, "init");
    expectInvocation(f.run({}, f.principal), f.principal, "init");
    rmSync(f.onPath);
    expectInvocation(f.run(), f.target, "init", "bundled-codegraph");
    rmSync(bundled);
    const missing = f.run();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("worktree setup requires CodeGraph");
    expect(missing.calls).toEqual([{ command: "setup", cwd: f.target, args: ["--skip-codegraph"] }]);
    expect(f.env.CODEGRAPH_NO_WATCH).toBe("1");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("worktree setup preserves destination DB on retries and principal runs, never merging source", () => {
  const f = fixture();
  try {
    const source = database(f.principal, "principal");
    const destination = database(f.target, "destination");
    const sourceBefore = readFileSync(source);
    const destinationBefore = readFileSync(destination);
    expectInvocation(f.run(), f.target, "sync");
    expectInvocation(f.run(), f.target, "sync");
    expect(readFileSync(destination)).toEqual(destinationBefore);
    expectInvocation(f.run({}, f.principal), f.principal, "sync");
    expect(readFileSync(source)).toEqual(sourceBefore);
    expect(readdirSync(f.principal).filter(name => name.startsWith(".codegraph-stage-"))).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("worktree setup snapshots live WAL, reusable regular files only, then syncs", async () => {
  const f = fixture();
  const socket = createServer();
  try {
    const sourceDir = path.join(f.principal, ".codegraph");
    const destinationDir = path.join(f.target, ".codegraph");
    mkdirSync(path.join(sourceDir, "data"), { recursive: true });
    writeFileSync(path.join(sourceDir, "config.json"), '{"fixture":true}');
    const sourceHook = path.join(f.principal, ".git/hooks/worktree-fixture");
    writeFileSync(sourceHook, "unchanged hook");
    writeFileSync(path.join(sourceDir, "data/graph.json"), "reusable");
    for (const name of ["daemon.pid", "writer.pid", "daemon.lock", "daemon.log", "codegraph.db-journal"]) {
      writeFileSync(path.join(sourceDir, name), "process state");
    }
    const external = path.join(f.root, "external");
    mkdirSync(external);
    writeFileSync(path.join(external, "secret"), "must not copy");
    symlinkSync(external, path.join(sourceDir, "external"));
    symlinkSync(path.join(external, "secret"), path.join(sourceDir, "linked-file"));
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(path.join(sourceDir, "daemon.sock"), resolve);
    });
    writeFileSync(f.log, "");
    const result = runNode(walFixture.replace("SNAPSHOT", `
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync("/bin/bash", [process.env.WRAPPER], {cwd:process.env.RUN_CWD, env:process.env, encoding:"utf8", timeout:10000});
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Worktree setup complete/);
    `), { ...f.env, SOURCE_DB: path.join(sourceDir, "codegraph.db"), COPY_DB: path.join(destinationDir, "codegraph.db"),
      WRAPPER: f.wrapper(), RUN_CWD: f.root });
    expect(result.stdout).toContain("Committed WAL rows included");
    expect(f.calls()).toEqual([
      { command: "setup", cwd: f.target, args: ["--skip-codegraph"] },
      { command: "codegraph", cwd: f.target, args: ["sync", f.target], env: ["0", "1", "1", "1"], dbExists: true },
    ]);
    expect(readdirSync(destinationDir).sort()).toEqual(["codegraph.db", "config.json", "data"]);
    expect(readFileSync(path.join(destinationDir, "config.json"), "utf8")).toBe('{"fixture":true}');
    expect(readFileSync(path.join(destinationDir, "data/graph.json"), "utf8")).toBe("reusable");
    expect(readFileSync(path.join(sourceDir, "config.json"), "utf8")).toBe('{"fixture":true}');
    expect(readFileSync(sourceHook, "utf8")).toBe("unchanged hook");
    expect(readdirSync(f.target).filter(name => name.startsWith(".codegraph-stage-"))).toEqual([]);
  } finally {
    if (socket.listening) await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("worktree setup respects setup's single-segment graph directory selection", () => {
  const f = fixture();
  try {
    database(f.principal, "custom", ".codegraph-custom");
    expectInvocation(f.run({ CODEGRAPH_DIR: "  .codegraph-custom  ", EXPECTED_GRAPH_DIR: ".codegraph-custom" }), f.target, "sync");
    database(f.target, "default");
    for (const invalid of [".", "..", "../outside", "nested/index", "nested\\index", "/absolute", "a..b", "   "]) {
      expectInvocation(f.run({ CODEGRAPH_DIR: invalid }), f.target, "sync");
    }
    expect(existsSync(path.join(f.target, "nested"))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("worktree setup propagates setup, init, sync and corrupt database failures", () => {
  const f = fixture();
  try {
    database(f.principal, "must not copy after failed setup");
    const setup = f.run({ SETUP_EXIT: "31" });
    expect(setup.status).toBe(31);
    expect(setup.calls).toHaveLength(1);
    expect(setup.stdout).not.toContain("Worktree setup complete");
    expect(existsSync(path.join(f.target, ".codegraph"))).toBe(false);
    rmSync(path.join(f.principal, ".codegraph"), { recursive: true });
    const init = f.run({ CODEGRAPH_EXIT: "32" });
    expect(init.status).not.toBe(0);
    expect(init.calls[1]?.args).toEqual(["init", f.target, "--yes"]);
    expect(init.stdout).not.toContain("Worktree setup complete");
    const source = database(f.principal, "source");
    const sync = f.run({ CODEGRAPH_EXIT: "33" });
    expect(sync.status).not.toBe(0);
    expect(sync.calls[1]?.args).toEqual(["sync", f.target]);
    expect(sync.stdout).not.toContain("Worktree setup complete");
    const destination = path.join(f.target, ".codegraph/codegraph.db");
    expect(existsSync(destination)).toBe(true);
    // A failed sync leaves a complete snapshot, so retry preserves it.
    const snapshot = readFileSync(destination);
    expectInvocation(f.run(), f.target, "sync");
    expect(readFileSync(destination)).toEqual(snapshot);
    writeFileSync(destination, "corrupt destination");
    const corruptDestination = f.run();
    expect(corruptDestination.status).not.toBe(0);
    expect(corruptDestination.calls).toHaveLength(1);
    expect(readFileSync(destination, "utf8")).toBe("corrupt destination");
    rmSync(destination);
    writeFileSync(source, "corrupt source");
    const corruptSource = f.run();
    expect(corruptSource.status).not.toBe(0);
    expect(corruptSource.calls).toHaveLength(1);
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(f.target).filter(name => name.startsWith(".codegraph-stage-"))).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("worktree setup rejects failed discovery and unavailable or bare principals before init", () => {
  const f = fixture();
  try {
    const bare = path.join(f.root, "bare repository");
    git(f.root, "clone", "--bare", f.principal, bare);
    const bareLinked = path.join(f.root, "bare linked");
    git(bare, "worktree", "add", "-b", "bare-linked", bareLinked);
    mkdirSync(path.join(bareLinked, "scripts"));
    for (const script of ["setup.sh", "setup-worktree.sh"]) {
      copyFileSync(path.join(f.target, "scripts", script), path.join(bareLinked, "scripts", script));
    }
    const bareResult = f.run({}, bareLinked);
    expect(bareResult.status).not.toBe(0);
    expect(bareResult.stderr).toContain("non-bare principal Git checkout");
    expect(bareResult.calls).toHaveLength(1);
    // Move the principal without repairing its registered common directory.
    renameSync(f.principal, path.join(f.root, "moved-principal"));
    const failed = f.run();
    expect(failed.status).not.toBe(0);
    expect(failed.calls).toHaveLength(1);
    expect(failed.stdout).not.toContain("Worktree setup complete");
    rmSync(path.join(f.target, ".git"));
    expect(f.run().status).not.toBe(0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("worktree setup never publishes a snapshot when reusable-file copy fails", () => {
  const f = fixture();
  try {
    const source = database(f.principal, "source");
    const before = readFileSync(source);
    writeFileSync(path.join(f.principal, ".codegraph/config.json"), "reusable");
    mkdirSync(path.join(f.target, ".codegraph"));
    const external = path.join(f.root, "external-config");
    writeFileSync(external, "unchanged");
    symlinkSync(external, path.join(f.target, ".codegraph/config.json"));
    const failed = f.run();
    expect(failed.status).not.toBe(0);
    expect(failed.calls).toHaveLength(1);
    expect(existsSync(path.join(f.target, ".codegraph/codegraph.db"))).toBe(false);
    expect(readFileSync(external, "utf8")).toBe("unchanged");
    expect(readFileSync(source)).toEqual(before);
    expect(readdirSync(f.target).filter(name => name.startsWith(".codegraph-stage-"))).toEqual([]);
    rmSync(path.join(f.target, ".codegraph/config.json"));
    expectInvocation(f.run(), f.target, "sync");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("worktree setup validates the discovered principal belongs to the same repository", () => {
  const f = fixture();
  try {
    const foreignRoot = path.join(f.root, "foreign");
    mkdirSync(foreignRoot);
    const foreign = repository(foreignRoot).principal;
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("worktree setup tests require Git");
    const gitDouble = path.join(f.bin, "git");
    writeFileSync(gitDouble, `#!${nodePath}
const args = process.argv.slice(2);
if (args.slice(2).join(" ") === "worktree list --porcelain -z") {
  process.stdout.write("worktree " + ${JSON.stringify(foreign)} + "\\0HEAD fixture\\0\\0");
} else {
  const result = require("node:child_process").spawnSync(${JSON.stringify(realGit)}, args, {stdio:"inherit"});
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
`);
    chmodSync(gitDouble, 0o755);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not an available checkout of this repository");
    expect(result.calls).toHaveLength(1);
    expect(existsSync(path.join(f.target, ".codegraph"))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
