import { createGitFakePort } from "./git-fake-port.mjs";

const { PITAKO_TEST_GIT_TABLE: table, PITAKO_TEST_GIT_CALLS: calls, PITAKO_TEST_GIT_VIOLATIONS: violations } = process.env;
if (table && calls && violations)
  globalThis[Symbol.for("pitako.git-port")] = createGitFakePort({ table, calls, violations });
