#!/usr/bin/env bash
# Prepare this checkout, then require a current CodeGraph index.
[ -n "${BASH_VERSION:-}" ] || { echo "worktree setup requires Bash" >&2; exit 1; }
set -euo pipefail
cd -- "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

bash scripts/setup.sh --skip-codegraph

codegraph="$(command -v codegraph || true)"
if [[ -z "$codegraph" && -x "$PWD/node_modules/.bin/codegraph" ]]; then
  codegraph="$PWD/node_modules/.bin/codegraph"
fi
if [[ -z "$codegraph" ]]; then
  echo "worktree setup requires CodeGraph: provide codegraph on PATH or in this checkout's node_modules/.bin (no global install is performed)." >&2
  exit 1
fi

node --input-type=module - "$codegraph" <<'NODE'
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const target = process.cwd();
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const record = git(target, "worktree", "list", "--porcelain", "-z").split("\0\0")[0].split("\0");
if (!record[0].startsWith("worktree ") || record.includes("bare")) {
  throw new Error("Cannot discover an available non-bare principal Git checkout");
}
const principal = realpathSync(record[0].slice("worktree ".length));
const commonDir = cwd => realpathSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir").slice(0, -1));
if (git(principal, "rev-parse", "--is-bare-repository").trim() !== "false" ||
    realpathSync(git(principal, "rev-parse", "--show-toplevel").slice(0, -1)) !== principal ||
    commonDir(principal) !== commonDir(target)) {
  throw new Error("Principal Git checkout is not an available checkout of this repository");
}

// Keep the same single-segment selection as setup, without loading CodeGraph.
const raw = process.env.CODEGRAPH_DIR?.trim();
const graphDir = !raw || raw === "." || raw.includes("..") || raw.includes("/") ||
  raw.includes("\\") || path.isAbsolute(raw) ? ".codegraph" : raw;
const destination = path.join(target, graphDir);
const source = path.join(principal, graphDir);
const database = directory => path.join(directory, "codegraph.db");
function regularDatabase(directory) {
  let directoryStat;
  try { directoryStat = lstatSync(directory); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!directoryStat.isDirectory()) throw new Error(`Not a regular graph directory: ${directory}`);
  const db = database(directory);
  // lstat also rejects dangling links, rather than treating them as a missing DB.
  let stat;
  try { stat = lstatSync(db); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!stat.isFile()) throw new Error(`Not a regular graph database: ${db}`);
  return true;
}
function openDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const result = db.prepare("PRAGMA quick_check").all();
    if (result.length !== 1 || result[0].quick_check !== "ok") throw new Error(`Corrupt graph database: ${file}`);
    return db;
  } catch (error) { db.close(); throw error; }
}
function copyFiles(from, to) {
  mkdirSync(to, { recursive: true });
  if (!lstatSync(to).isDirectory()) throw new Error(`Not a regular graph directory: ${to}`);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    // Reuse graph data, never process state, SQLite sidecars or symlink targets.
    if (entry.name === "codegraph.db" || /-(wal|shm|journal)$/.test(entry.name) ||
        /(?:^|[.-])(pid|sock|socket|lock|log)s?(?:$|[.-])/i.test(entry.name)) continue;
    const input = path.join(from, entry.name);
    const output = path.join(to, entry.name);
    if (entry.isDirectory()) copyFiles(input, output);
    else if (entry.isFile()) {
      if (existsSync(output)) {
        if (!lstatSync(output).isFile()) throw new Error(`Not a regular graph file: ${output}`);
        continue; // Preserve files already owned by the destination, including retries.
      }
      copyFileSync(input, output, constants.COPYFILE_EXCL);
    }
  }
}

let operation = "sync";
if (regularDatabase(destination)) {
  openDatabase(database(destination)).close();
} else if (regularDatabase(source)) {
  const stage = mkdtempSync(path.join(target, ".codegraph-stage-"));
  try {
    const db = openDatabase(database(source));
    try { db.prepare("VACUUM INTO ?").run(database(stage)); }
    finally { db.close(); }
    copyFiles(source, stage);
    copyFiles(stage, destination);
    // Same-filesystem, atomic and no-overwrite publication, after closing SQLite.
    linkSync(database(stage), database(destination));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
} else {
  operation = "init";
}

execFileSync(process.argv[2], [operation, target, ...(operation === "init" ? ["--yes"] : [])], {
  cwd: target, stdio: "inherit",
  env: { ...process.env, CODEGRAPH_NO_WATCH: "0", CODEGRAPH_FORCE_WATCH: "1", CODEGRAPH_NO_DOWNLOAD: "1", DO_NOT_TRACK: "1" },
});
console.log("Worktree setup complete.");
NODE
