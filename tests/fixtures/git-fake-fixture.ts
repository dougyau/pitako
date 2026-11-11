import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setGitPort } from "../../extensions/git-port.ts";
import { createGitFake } from "./git-fake.ts";
import { guardEnv } from "./git-fake-env.ts";

/** Own the port and its table until all work in the test has settled. */
export function gitFakeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-git-fake-"));
  const fake = createGitFake({
    table: path.join(dir, "table.json"),
    calls: path.join(dir, "calls.jsonl"),
    violations: path.join(dir, "violations.jsonl"),
  });
  const restore = setGitPort(fake.port);
  const priorEnv = { ...process.env };
  Object.assign(process.env, guardEnv({
    ...process.env, PITAKO_TEST_GIT_TABLE: fake.files.table,
    PITAKO_TEST_GIT_CALLS: fake.files.calls, PITAKO_TEST_GIT_VIOLATIONS: fake.files.violations,
  }));
  return {
    ...fake,
    dispose() {
      try {
        const violations = readFileSync(fake.files.violations, "utf8");
        if (violations) throw new Error(violations.trim().split("\n").map(line => JSON.parse(line).message).join("\n"));
      } finally {
        restore();
        for (const name of ["PITAKO_TEST_GIT_TABLE", "PITAKO_TEST_GIT_CALLS", "PITAKO_TEST_GIT_VIOLATIONS", "NODE_OPTIONS", "PATH"]) {
          if (priorEnv[name] === undefined) delete process.env[name]; else process.env[name] = priorEnv[name];
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
