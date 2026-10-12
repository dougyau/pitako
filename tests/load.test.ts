import { stubExternalFactories } from "./fixtures/offline.ts";
stubExternalFactories();
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pitako from "../extensions/index.ts";
import { agentScope } from "../extensions/agent/scope.ts";
import { packageRoot } from "../extensions/stack.ts";
import { childActiveTools, toolsForProfile } from "../extensions/profile.ts";

const configDirs: string[] = [];
function configDirectory(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  configDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of configDirs) rmSync(dir, { recursive: true, force: true });
  configDirs.length = 0;
});

function profileHarness(profileFlag?: string) {
  const active = ["read", "bash", "edit", "write"];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  let profileCommand: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const available = [
    "read", "bash", "edit", "write", "apply_patch", "grep", "find", "ls",
    "lsp_diagnostics", "lsp_rename", "codegraph_search", "lsp_symbols",
    "web_search", "fetch_content", "source_check", "get_search_content", "web_enable",
  ];
  const context = {
    cwd: packageRoot(),
    hasUI: false,
    ui: { notify() {}, setStatus() {} },
    sessionManager: { getSessionId: () => `test-${profileFlag ?? "coding"}`, getEntries: () => [] },
  };
  const pi = {
    registerFlag() {},
    registerTool() {},
    getFlag() { return profileFlag; },
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      const previous = handlers.get(event);
      handlers.set(event, async (event, ctx) => { await previous?.(event, ctx); return handler(event, ctx); });
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      if (name === "pitako") profileCommand = command.handler;
    },
    getActiveTools() { return [...active]; },
    getAllTools() { return available.map((name) => ({ name })); },
    setActiveTools(names: string[]) { active.splice(0, active.length, ...names); },
    getSessionName() { return undefined; },
    setSessionName() {},
  };
  pitako(pi as unknown as ExtensionAPI);
  return {
    active,
    context,
    async start() {
      const handler = handlers.get("session_start");
      if (!handler) throw new Error("session_start was not registered");
      await handler({}, context);
    },
    async selectProfile(value: string) {
      if (!profileCommand) throw new Error("pitako command was not registered");
      await profileCommand(`profile ${value}`, context);
    },
    async composePrompt(systemPrompt = "") {
      const handler = handlers.get("before_agent_start");
      if (!handler) throw new Error("before_agent_start was not registered");
      const result = await handler({ systemPrompt }, context) as { systemPrompt?: string } | undefined;
      return result?.systemPrompt ?? systemPrompt;
    },
    async shutdown() {
      await handlers.get("session_shutdown")?.({}, context);
    },
  };
}

describe("Pitako resources and policy", () => {
  test("declares Pitako resources and explicit-only gates without a Pi loader", () => {
    const root = packageRoot(), manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.pi.extensions[0]).toBe("./extensions/index.ts");
    expect(manifest.pi.extensions).toEqual(expect.arrayContaining([
      "./extensions/board/index.ts", "./extensions/agent/index.ts", "./extensions/acp.ts",
      "./node_modules/@vndv/pi-codegraph/extensions/codegraph.ts", "./node_modules/pi-lsp-client/src/index.ts",
    ]));
    expect(manifest.pi.skills).toContain("./skills/practical");
    for (const directory of ["pitako-coding", "plan", "execute", "pre-pr", "remove-ai-slops"]) {
      expect(manifest.pi.skills).toContain(`./skills/${directory}`);
      expect(readFileSync(path.join(root, "skills", directory, "SKILL.md"), "utf8")).toContain("declared testing scope");
    }
    expect(readFileSync(path.join(root, "skills/practical/verify-behavior/SKILL.md"), "utf8"))
      .toContain("declared testing scope");
    const gates = readFileSync(path.join(root, "skills/practical/gates/SKILL.md"), "utf8");
    expect(gates).toContain("disable-model-invocation: true");
    expect(gates).toContain("Write only `<selected-project-root>/GATES.md`");
    expect(manifest.pi.prompts).toContain("./prompts");
  });

  test("profile guidance reaches the provider prompt without changing direct tool access", async () => {
    const foreground = profileHarness();
    await foreground.start();
    const prompt = await foreground.composePrompt("base system prompt");
    expect(prompt).toContain("base system prompt");
    expect(prompt).toContain("bounded structural code questions");
    expect(prompt).toContain("literal, exhaustive or exact results");
    expect(prompt).toContain("partial or unavailable");
    expect(prompt).toContain("Select checks for the active project's own behavior and declared testing scope.");
    for (const name of ["read", "grep", "bash", "lsp_diagnostics", "codegraph_search", "lsp_symbols", "edit", "write", "web_search", "fetch_content", "source_check", "get_search_content", "web_enable"]) {
      expect(foreground.active).toContain(name);
    }
    expect(foreground.active).not.toContain("apply_patch");
    await foreground.shutdown();

    const analysis = profileHarness("analysis");
    await analysis.start();
    const analysisPrompt = await analysis.composePrompt("base system prompt");
    expect(analysisPrompt).toContain("bounded structural code questions");
    expect(analysisPrompt).toContain("edit, write, apply_patch, and lsp_rename are not");
    expect(analysisPrompt).toContain("Select checks for the active project's own behavior and declared testing scope.");
    for (const name of ["read", "grep", "bash", "lsp_diagnostics", "codegraph_search", "lsp_symbols", "web_search", "fetch_content", "source_check", "get_search_content", "web_enable"]) {
      expect(analysis.active).toContain(name);
    }
    expect(analysis.active).not.toContain("edit");
    expect(analysis.active).not.toContain("write");
    await analysis.shutdown();
  });

  test("profile reloads keep edit/write for unsupported models in all roles", async () => {
    const foreground = profileHarness();
    await foreground.start();
    expect(foreground.active).toContain("edit");
    expect(foreground.active).toContain("write");
    expect(foreground.active).not.toContain("apply_patch");
    await foreground.selectProfile("coding");
    expect(foreground.active).not.toContain("apply_patch");
    await foreground.start();
    expect(foreground.active).not.toContain("apply_patch");
    await foreground.shutdown();

    const analysis = profileHarness("analysis");
    await analysis.start();
    expect(analysis.active).not.toContain("apply_patch");
    await analysis.selectProfile("coding");
    expect(analysis.active).not.toContain("apply_patch");
    await analysis.shutdown();

    for (const roleId of ["architect", "reviewer", "researcher"]) {
      const child = profileHarness();
      await agentScope.run({ instanceId: "developer-looking-instance-id", roleId }, async () => {
        await child.start();
        expect(child.active).not.toContain("apply_patch");
        await child.selectProfile("coding");
        expect(child.active).not.toContain("apply_patch");
        await child.start();
        expect(child.active).not.toContain("apply_patch");
      });
      await child.shutdown();
    }

    const developer = profileHarness();
    await agentScope.run({ instanceId: "not-role-derived-from-this-id", roleId: "developer" }, async () => {
      await developer.start();
      expect(developer.active).not.toContain("apply_patch");
      await developer.selectProfile("analysis");
      expect(developer.active).not.toContain("apply_patch");
      await developer.selectProfile("coding");
      expect(developer.active).not.toContain("apply_patch");
      await developer.start();
      expect(developer.active).not.toContain("apply_patch");
    });
    await developer.shutdown();
  });

  test("supervised Herdr roles keep edit/write on unsupported models", async () => {
    const previousId = process.env.PITAKO_INSTANCE_ID;
    const previousRole = process.env.PITAKO_ROLE_ID;
    try {
      process.env.PITAKO_INSTANCE_ID = "herdr-child";
      process.env.PITAKO_ROLE_ID = "developer";
      const developer = profileHarness();
      await developer.start();
      expect(developer.active).not.toContain("apply_patch");
      expect(developer.active).toContain("edit");
      expect(developer.active).toContain("write");
      await developer.selectProfile("analysis");
      expect(developer.active).not.toContain("apply_patch");
      await developer.selectProfile("coding");
      expect(developer.active).not.toContain("apply_patch");
      await developer.shutdown();

      process.env.PITAKO_ROLE_ID = "reviewer";
      const reviewer = profileHarness();
      await reviewer.start();
      expect(reviewer.active).not.toContain("apply_patch");
      await reviewer.selectProfile("coding");
      expect(reviewer.active).not.toContain("apply_patch");
      await reviewer.shutdown();

      delete process.env.PITAKO_INSTANCE_ID;
      process.env.PITAKO_ROLE_ID = "developer";
      const foreground = profileHarness();
      await foreground.start();
      expect(foreground.active).not.toContain("apply_patch");
      await foreground.selectProfile("coding");
      expect(foreground.active).not.toContain("apply_patch");
      await foreground.shutdown();
    } finally {
      if (previousId === undefined) delete process.env.PITAKO_INSTANCE_ID;
      else process.env.PITAKO_INSTANCE_ID = previousId;
      if (previousRole === undefined) delete process.env.PITAKO_ROLE_ID;
      else process.env.PITAKO_ROLE_ID = previousRole;
    }
  });

  test("analysis profile wiring excludes edit and write", async () => {
    const previous = process.env.PITAKO_PROFILE;
    process.env.PITAKO_PROFILE = "analysis";
    try {
      const active = ["read", "bash", "edit", "write"];
      const available = [
        "read", "bash", "edit", "write", "apply_patch", "grep", "find", "ls",
        "lsp_diagnostics", "lsp_rename", "codegraph_search",
      ];
      const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
      const pi = {
        registerFlag() {},
        registerTool() {},
        getFlag() {
          return undefined;
        },
        on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
          const previous = handlers.get(event);
          handlers.set(event, async (event, ctx) => { await previous?.(event, ctx); return handler(event, ctx); });
        },
        registerCommand() {},
        getActiveTools() {
          return [...active];
        },
        getAllTools() {
          return available.map((name) => ({ name }));
        },
        setActiveTools(names: string[]) {
          active.splice(0, active.length, ...names);
        },
        getSessionName() {
          return undefined;
        },
        setSessionName() {},
      };
      pitako(pi as unknown as ExtensionAPI);
      const start = handlers.get("session_start");
      if (!start) throw new Error("session_start was not registered");
      await start({}, { hasUI: false, ui: { notify() {}, setStatus() {} } });
      expect(active).toContain("read");
      expect(active).toContain("grep");
      expect(active).toContain("lsp_diagnostics");
      expect(active).toContain("codegraph_search");
      expect(active).not.toContain("edit");
      expect(active).not.toContain("write");
      expect(active).not.toContain("apply_patch");
      expect(active).not.toContain("lsp_rename");
    } finally {
      if (previous === undefined) delete process.env.PITAKO_PROFILE;
      else process.env.PITAKO_PROFILE = previous;
    }
  });
});

function sourceHygieneOffenders(root: string): string[] {
  root = realpathSync(root);
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", root, "-c", "core.excludesFile=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error(`Source inventory Git failure: ${result.error ?? result.signal ?? result.status}; ${result.stderr}`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  };
  if (git(["rev-parse", "--show-toplevel"]) !== `${root}\n`) throw new Error("Source inventory Git root mismatch");
  const inventory = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (inventory && !inventory.endsWith("\0")) throw new Error("Malformed source inventory");
  const skip = new Set(["node_modules", ".git", ".codegraph", ".pitako", "bun.lock"]);
  const rooted = (name: string) => `${path.sep}${name}${path.sep}`;
  const isForbidden = (text: string) => text.includes(rooted("home")) || text.includes(rooted("Users")) || /sk-[A-Za-z0-9]{20,}/.test(text);
  const offenders: string[] = [];
  for (const name of new Set(inventory ? inventory.slice(0, -1).split("\0") : [])) {
    const components = name.split("/");
    if (path.isAbsolute(name) || components.some((part) => !part || part === "." || part === "..")) {
      throw new Error("Malformed source inventory path");
    }
    if (components.some((part) => skip.has(part))) continue;
    let file = root;
    let current;
    for (const component of components) {
      file = path.join(file, component);
      current = lstatSync(file, { throwIfNoEntry: false });
      if (!current) break; // A deleted worktree path has no current bytes.
      if (current.isSymbolicLink()) current = statSync(file); // Broken links must fail, not disappear.
    }
    if (!current || current.size > 1_000_000) continue;
    if (isForbidden(readFileSync(file, "utf8"))) offenders.push(name);
  }
  return offenders;
}

describe("repository hygiene", () => {
  test("source does not embed absolute developer paths or credentials", () => {
    expect(sourceHygieneOffenders(packageRoot())).toEqual([]);
  });

  test.each([tmpdir(), homedir()])("Git source inventory includes ignored tracked and visible untracked current bytes at %s", (parent) => {
    const root = mkdtempSync(path.join(parent, "pitako-source-inventory-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", root, ...args], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
    };
    const put = (name: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), text);
    };
    const forbidden = [
      ["", "home", "developer", "source.ts"].join(path.sep),
      ["", "Users", "developer", "source.ts"].join(path.sep),
      ["sk", "A".repeat(20)].join("-"),
    ];
    const tracked = "ignored-tracked.ts";
    const visible = "not-published/visible\nwith\ttab.ts";
    try {
      git("init", "--quiet");
      put(".gitignore", "ignored-*.ts\n");
      put("package.json", JSON.stringify({ files: ["published"] }));
      put(tracked, "safe indexed bytes");
      put("deleted.ts", forbidden[0]!);
      git("add", "-f", "--", tracked, "deleted.ts");
      put(tracked, forbidden[0]!); // Scan the worktree, not the indexed blob.
      rmSync(path.join(root, "deleted.ts"));
      put(visible, forbidden[1]!);
      put("credential.ts", forbidden[2]!);
      put("ignored-generated.ts", forbidden.join("\n"));
      for (const name of ["node_modules/source.ts", ".codegraph/source.ts", ".pitako/runs/source.ts", "nested/bun.lock", "nested/.git/source.ts"]) {
        put(name, forbidden.join("\n"));
      }
      git("add", "-f", "--", "node_modules/source.ts", ".codegraph/source.ts", ".pitako/runs/source.ts", "nested/bun.lock");
      put("oversized.ts", forbidden[0]! + " ".repeat(1_000_001));
      const expected = [tracked, visible, "credential.ts"].sort();
      expect(sourceHygieneOffenders(root).sort()).toEqual(expected);

      // Exercise inherited redirection in a child, never mutate the parallel runner's environment.
      // Ambient configuration is fixture metadata, not source inventory.
      const ignoredGlobal = path.join(root, ".git", "ignored-global");
      const ambientConfig = path.join(root, ".git", "ambient-config");
      put(".git/ignored-global", `${visible}\ncredential.ts\n`);
      put(".git/ambient-config", `[core]\nexcludesFile = ${ignoredGlobal}\n`);
      const redirected = spawnSync(process.execPath, ["--eval", `
        import { spawnSync } from "node:child_process";
        import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
        import path from "node:path";
        const scan = ${sourceHygieneOffenders.toString()};
        console.log(JSON.stringify(scan(process.env.HYGIENE_ROOT).sort()));
      `], {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, HYGIENE_ROOT: root, GIT_DIR: "/nonexistent", GIT_WORK_TREE: "/nonexistent", GIT_INDEX_FILE: "/nonexistent",
          GIT_CONFIG_GLOBAL: ambientConfig, GIT_CONFIG_SYSTEM: ambientConfig,
          GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: ignoredGlobal },
      });
      expect(redirected.error).toBeUndefined();
      expect(redirected.signal).toBeNull();
      expect(redirected.status).toBe(0);
      expect(JSON.parse(redirected.stdout)).toEqual(expected);

      symlinkSync("missing-target", path.join(root, "broken.ts"));
      expect(() => sourceHygieneOffenders(root)).toThrow();
      rmSync(path.join(root, "broken.ts"));
      put("unreadable.ts/child", "safe");
      git("add", "--", "unreadable.ts/child");
      rmSync(path.join(root, "unreadable.ts"), { recursive: true });
      put("unreadable.ts", "not a directory");
      expect(() => sourceHygieneOffenders(root)).toThrow();
      expect(() => sourceHygieneOffenders(tmpdir())).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
