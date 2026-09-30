import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("ACP and Codex load once in actual pi -e package and production child", () => {
  const result = spawnSync("node", [path.resolve(import.meta.dir, "fixtures/acp-cli.mjs")], { encoding: "utf8", timeout: 65_000 });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.stdout).toContain("ACP_CLI_OK");
}, 70_000);

for (const mode of ["default", "override", "global-disabled", "proxy", "process-disabled-child"]) {
  test(`ACP real Pi session: ${mode}`, () => {
    const home = mkdtempSync(path.join(tmpdir(), "pitako-acp-home-"));
    const cwd = path.join(home, "workspace");
    const agentDir = path.join(home, ".pi/agent");
    mkdirSync(cwd);
    mkdirSync(agentDir, { recursive: true });
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PITAKO_PROFILE: "coding" };
      delete env.BILLION_CONTEXT_PROXY;
      delete env.BILLION_CONTEXT_NATIVE;
      delete env.ACP_AUTO_UPDATE;
      delete env.PITAKO_INSTANCE_ID;
      delete env.PITAKO_ROLE_ID;
      const result = spawnSync("node", [path.resolve(import.meta.dir, "fixtures/acp-session.mjs"), mode], { cwd, encoding: "utf8", timeout: 90_000, env });
      if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
      expect(result.stdout).toContain(`ACP_SESSION_OK ${mode}`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 95_000);
}
