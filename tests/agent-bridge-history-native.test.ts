import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("installed passive Node client explicitly acknowledges actual owned SDK native histories", () => {
  const result = spawnSync("node", ["tests/fixtures/agent-bridge-cli.mjs", "history"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 180_000,
  });
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("firstSensitiveNativeWitness");
}, 190_000);
