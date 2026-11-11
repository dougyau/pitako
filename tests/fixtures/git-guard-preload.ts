import { afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setGitPort } from "../../extensions/git-port.ts";
import { createGitFake } from "./git-fake.ts";
import { guardEnv } from "./git-fake-env.ts";

const root = mkdtempSync(path.join(tmpdir(), "pitako-git-guard-"));
const fake = createGitFake({
  table: path.join(root, "table.json"),
  calls: path.join(root, "calls.jsonl"),
  violations: path.join(root, "violations.jsonl"),
});
const bin = path.join(root, "bin");
const sentinelLog = path.join(root, "sentinel.jsonl");
mkdirSync(bin);
writeFileSync(sentinelLog, "");
writeFileSync(path.join(bin, "git"), `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(sentinelLog)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), ppid: process.ppid
}) + "\\n");
process.stderr.write("PITAKO_GIT_SENTINEL: real Git is disabled in tests\\n");
process.exitCode = 128;
`);
chmodSync(path.join(bin, "git"), 0o755);
const prior = { ...process.env };
const restore = setGitPort(fake.port);
Object.assign(process.env, guardEnv({
  ...process.env,
  PITAKO_TEST_GIT_TABLE: fake.files.table,
  PITAKO_TEST_GIT_CALLS: fake.files.calls,
  PITAKO_TEST_GIT_VIOLATIONS: fake.files.violations,
  PITAKO_TEST_GIT_SENTINEL: bin,
  PITAKO_TEST_GIT_SENTINEL_LOG: sentinelLog,
}));
process.env.PATH = `${bin}:${process.env.PATH!.split(":").filter(part => part !== bin).join(":")}`;

afterAll(() => {
  let retain = false;
  try {
    const violations = readFileSync(fake.files.violations, "utf8");
    // Retain diagnostic bytes for review, without failing on vendor sentinel hits.
    retain = Boolean(violations.trim() || readFileSync(sentinelLog, "utf8").trim());
    if (violations.trim()) throw new Error(`Git guard violations in ${root}:\n${violations}`);
  } finally {
    restore();
    for (const name of ["PATH", "NODE_OPTIONS", "PITAKO_TEST_GIT_TABLE", "PITAKO_TEST_GIT_CALLS",
      "PITAKO_TEST_GIT_VIOLATIONS", "PITAKO_TEST_GIT_SENTINEL", "PITAKO_TEST_GIT_SENTINEL_LOG"]) {
      if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
    }
    if (!retain) rmSync(root, { recursive: true, force: true });
  }
});
