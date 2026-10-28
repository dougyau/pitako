import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse } from "smol-toml";
import { herdrSetupNotice } from "../extensions/herdr.ts";
import pitako from "../extensions/index.ts";

function checkout(run: (root: string, configure: (source: string) => void) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-herdr-"));
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    execFileSync("git", ["init", "--quiet", root], { env });
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, ".herdr"));
    writeFileSync(path.join(root, "scripts/setup-worktree.sh"), "exit 93\n");
    run(root, source => writeFileSync(path.join(root, ".herdr/worktree.toml"), source));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("suggests strict setup from a subdirectory without writing or executing anything", () => {
  checkout(root => {
    const notice = herdrSetupNotice(path.join(root, "scripts"));
    expect(notice).toContain('setup = "bash scripts/setup-worktree.sh"');
    expect(notice).toContain("human trust approval");
    expect(() => readFileSync(path.join(root, ".herdr/worktree.toml"))).toThrow();
    rmSync(path.join(root, "scripts/setup-worktree.sh"));
    expect(herdrSetupNotice(root)).toBeUndefined();
  });
});

test("reads TOML syntax and preserves custom configuration without claiming it is wrong", () => {
  checkout((root, configure) => {
    for (const source of [
      '[scripts]\nsetup = "bash scripts/setup-worktree.sh" # strict',
      "[scripts]\nsetup = 'bash scripts/setup-worktree.sh'",
      'scripts = { setup = "bash scripts/setup-worktree.sh", cleanup = "echo done" }',
      '[scripts]\nsetup = """\n bash scripts/setup-worktree.sh\n"""',
    ]) {
      configure(source);
      expect(herdrSetupNotice(root)).toBeUndefined();
    }
    for (const source of [
      "",
      '[scripts]\ncleanup = "echo done"',
      '[scripts]\nsetup = "bash scripts/setup.sh"',
      '[scripts]\nsetup = "bash scripts/setup-worktree.sh && echo ready"',
      '[scripts]\nsetup = 42',
    ]) {
      configure(source);
      const notice = herdrSetupNotice(root);
      expect(notice).toContain("Preserve existing settings");
      expect(notice).toContain("Custom setup may already provide this preparation");
      expect(readFileSync(path.join(root, ".herdr/worktree.toml"), "utf8")).toBe(source);
    }
  });
});

test("configuration and discovery failures produce nonblocking review notices", () => {
  checkout((root, configure) => {
    configure("[scripts\n");
    expect(herdrSetupNotice(root)).toContain("Could not parse");
    const config = path.join(root, ".herdr/worktree.toml");
    rmSync(config);
    mkdirSync(config);
    expect(herdrSetupNotice(root)).toContain("Could not read");
    expect(herdrSetupNotice(path.join(root, "missing"))).toContain("Could not locate");
  });
});

test("startup notifies once per foreground UI session only in Herdr", () => {
  checkout(root => {
    const original = { HERDR_ENV: process.env.HERDR_ENV, PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD };
    const events = new Map<string, (event: unknown, ctx: any) => unknown>();
    const notices: string[] = [];
    let sessionId = "first";
    const context = {
      cwd: root, hasUI: true,
      sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
      ui: { setStatus() {}, notify(message: string) { notices.push(message); } },
    };
    try {
      const register = () => pitako({
        registerFlag() {}, getFlag() { return "coding"; },
        on(event: string, handler: (event: unknown, ctx: any) => unknown) { events.set(event, handler); },
        registerCommand() {}, getActiveTools() { return []; }, getAllTools() { return []; },
        setActiveTools() {}, getSessionName() { return "Herdr test"; },
      } as unknown as ExtensionAPI);
      register();
      const start = () => events.get("session_start")!({}, context);
      delete process.env.HERDR_ENV;
      delete process.env.PI_SUBAGENT_CHILD;
      start();
      process.env.HERDR_ENV = "0";
      start();
      process.env.HERDR_ENV = "1";
      context.hasUI = false;
      start();
      context.hasUI = true;
      process.env.PI_SUBAGENT_CHILD = "1";
      start();
      expect(notices).toEqual([]);
      delete process.env.PI_SUBAGENT_CHILD;
      start();
      start();
      expect(notices).toHaveLength(1);
      events.get("session_shutdown")?.({}, context);
      register();
      start();
      expect(notices).toHaveLength(1);
      sessionId = "second";
      start();
      expect(notices).toHaveLength(2);
      sessionId = "first";
      start();
      expect(notices).toHaveLength(2);
    } finally {
      events.get("session_shutdown")?.({}, context);
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test("repository hook runs strict setup in the checkout and preserves failures", () => {
  const config = parse(readFileSync(new URL("../.herdr/worktree.toml", import.meta.url), "utf8"));
  const scripts = config.scripts as { setup: string };
  expect(scripts.setup).toBe("bash scripts/setup-worktree.sh");
  checkout(root => {
    const script = path.join(root, "scripts/setup-worktree.sh");
    for (const exit of [0, 37]) {
      writeFileSync(script, `[[ "$PWD" == "$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")/.." && pwd)" ]] || exit 90\nexit ${exit}\n`);
      const result = spawnSync("sh", ["-e", "-c", scripts.setup], { cwd: root, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(exit);
    }
  });
});
