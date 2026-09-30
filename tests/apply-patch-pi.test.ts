import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("official Codex entry composes with real Pi model/profile/session behavior", () => {
  const home = mkdtempSync(path.join(tmpdir(), "pitako-codex-home-"));
  const agentDir = path.join(home, "agent");
  mkdirSync(agentDir);
  try {
    const result = spawnSync("node", ["tests/fixtures/codex-session.mjs"], {
      cwd: path.resolve(import.meta.dir, ".."), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PITAKO_PROFILE: "coding" },
    });
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
    expect(result.stdout).toContain("CODEX_SESSION_OK");
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 65_000);
