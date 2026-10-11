import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("installed native Pi and passive Node inspect production background and Team children through disposal", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = spawnSync("node", ["tests/fixtures/agent-bridge-cli.mjs", "workers"], {
    cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  });
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("BRIDGE_WORKERS_OK");
}, 190_000);
