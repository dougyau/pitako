import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("cold installed Pi RPC bridge works in a separate passive native Node consumer", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = spawnSync("node", ["tests/fixtures/agent-bridge-cli.mjs"], {
    cwd: root, encoding: "utf8", timeout: 180_000,
  });
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("BRIDGE_COLD_OK");
}, 190_000);

for (const guard of ["disabled", "child"]) {
  test(`actual installed Pi RPC ${guard} launch does not create bridge discovery`, () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const result = spawnSync("node", ["tests/fixtures/agent-bridge-cli.mjs", guard], {
      cwd: root, encoding: "utf8", timeout: 180_000,
    });
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BRIDGE_DISABLED_OK");
  }, 190_000);
}
