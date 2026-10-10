import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { packageRoot } from "../extensions/stack.ts";

test("genuine credential-free Pi CLI consumes supervised UUID, private directory, profile model and native origin hook", () => {
  const root = packageRoot();
  const child = spawnSync("node", ["--import", path.join(root, "scripts/sdk-node-loader.mjs"),
    "scripts/developer-supervised-cli-node.mjs"], {
    cwd: root, encoding: "utf8", maxBuffer: 4 * 1048576,
    env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  });
  expect(child.status, child.stderr + child.stdout).toBe(0);
  const evidence = JSON.parse(child.stdout);
  expect(evidence.origin.dispatchId).toBe(evidence.routing.dispatchId);
  expect(evidence.activation.reasoning).toBe("high");
}, 90_000);
