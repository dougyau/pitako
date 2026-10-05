#!/usr/bin/env bash
# Prepare this checkout only; verification gates are separate.
[ -n "${BASH_VERSION:-}" ] || { echo "setup requires Bash" >&2; exit 1; }
set -euo pipefail
cd -- "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

for runtime in git node bun; do
  command -v "$runtime" >/dev/null || { echo "setup requires $runtime on PATH" >&2; exit 1; }
done
printf 'Bash %s (%s)\n' "$BASH_VERSION" "$BASH"
git --version
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const { engines } = JSON.parse(readFileSync("package.json", "utf8"));
const floor = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(engines.node);
if (!floor) throw new Error(`Unsupported Node declaration: ${engines.node}`);
const actual = process.versions.node.split(".").map(Number);
const minimum = floor.slice(1).map(Number);
const difference = actual.map((n, i) => n - minimum[i]).find(n => n !== 0) ?? 0;
if (difference < 0) throw new Error(`Node ${process.versions.node} does not satisfy ${engines.node}`);
console.log(`Node ${process.versions.node} (${process.execPath}), requires ${engines.node}`);
NODE
declared_bun="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager')"
actual_bun="$(bun --version)"
[[ "$declared_bun" == "bun@$actual_bun" ]] || {
  echo "setup requires $declared_bun; found bun@$actual_bun" >&2
  exit 1
}
printf 'Bun %s (%s)\n' "$actual_bun" "$(command -v bun)"
bun install --frozen-lockfile

node --input-type=module <<'NODE'
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(resolve("package.json"));
const hermes = require.resolve("pi-hermes-memory");
const hermesRequire = createRequire(hermes);
const native = hermesRequire.resolve("better-sqlite3");
console.log(`pi-hermes-memory: ${hermes}`);
console.log(`better-sqlite3 (from Hermes): ${native}`);
const BetterSqlite3 = hermesRequire("better-sqlite3");
for (const [name, Database] of [
  ["better-sqlite3", BetterSqlite3],
  ["node:sqlite", DatabaseSync],
]) {
  const db = new Database(":memory:");
  try {
    const row = db.prepare("SELECT 42 AS value").get();
    if (row.value !== 42) throw new Error(`${name}: unexpected SQL result`);
    console.log(`${name}: SELECT 42 = ${row.value}`);
  } finally {
    db.close();
  }
  console.log(`${name}: closed`);
}
NODE
