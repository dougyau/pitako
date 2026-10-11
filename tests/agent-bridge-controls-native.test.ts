import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("installed passive Node controls reach native SDK receipts without coordinator model calls", async () => {
  const { stdout, stderr } = await promisify(execFile)("node",
    ["tests/fixtures/agent-bridge-cli.mjs", "controls"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), maxBuffer: 8 * 1024 * 1024 });
  console.log(stdout);
  expect(stderr).toBe("");
  expect(stdout).toContain("BRIDGE_WORKERS_OK");
  expect(stdout).toContain("firstNativeBridgeControl");
}, 120_000);
