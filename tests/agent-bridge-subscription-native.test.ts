import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("installed native idle coordinator delivers subscribed worker settlement without a model request", () => {
  const result = spawnSync("node", ["tests/fixtures/agent-bridge-cli.mjs", "subscriptions"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 180_000,
  });
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("BRIDGE_WORKERS_OK");
}, 190_000);

test("installed native streaming coordinator delivers subscribed worker settlement independently of the held foreground", () => {
  const result = spawnSync("node", ["tests/fixtures/agent-bridge-cli.mjs", "streaming"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 180_000,
  });
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("intentionalForegroundStreamingAfterTerminalReads");
}, 190_000);
