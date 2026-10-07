import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pitako from "../extensions/index.ts";
import { agentScope } from "../extensions/agent/scope.ts";
import { packageRoot } from "../extensions/stack.ts";
import { childActiveTools, toolsForProfile } from "../extensions/profile.ts";
import { loadPitako, registeredToolNames } from "../scripts/load-pitako.ts";

async function loadWithWebConfig(packagePath: string, configDir: string) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  try {
    return await loadPitako(packagePath);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function loadInFreshProcess(packagePath: string, configDir: string) {
  const runner = path.join(packagePath, "tests", "fixtures", "load-pitako.ts");
  const child = spawnSync(process.execPath, [runner, packagePath], {
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: configDir },
  });
  if (child.status !== 0) throw new Error(`${child.stderr}\n${child.stdout}`);
  const marker = child.stdout.split(/\r?\n/).reverse().find((line) => line.startsWith("PITAKO_LOAD_RESULT="));
  if (!marker) throw new Error(`Load runner did not return a result:\n${child.stdout}\n${child.stderr}`);
  return JSON.parse(marker.slice("PITAKO_LOAD_RESULT=".length)) as {
    errors: unknown[];
    names: string[];
    paths: string[];
    skills: { name: string; filePath: string; disableModelInvocation: boolean; body: string }[];
    skillPrompt: string;
    skillDiagnostics: { path: string }[];
  };
}

function profileHarness(profileFlag?: string) {
  const active = ["read", "bash", "edit", "write"];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  let profileCommand: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const available = [
    "read", "bash", "edit", "write", "apply_patch", "grep", "find", "ls",
    "lsp_diagnostics", "lsp_rename", "codegraph_search", "project_report", "read_symbol",
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

describe("Pi package loading", () => {
  test.serial("installed advice is discoverable in principal and ordinary codemode and retained outside cwd", () => {
    const root = packageRoot();
    const child = spawnSync("node", ["--experimental-transform-types", "--import",
      path.join(root, "scripts/sdk-node-loader.mjs"), "scripts/jev-advice-sdk-node.mjs"], {
      cwd: root, encoding: "utf8", timeout: 90_000,
      env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    expect(child.status, child.stderr + child.stdout).toBe(0);
    const observed = JSON.parse(child.stdout);
    expect(observed.advertisedDiscovery).toEqual(["principal CLI/Pi-owned builtin", "production ordinary child"]);
    expect(observed.installedLayout).toBe(true);
    expect(observed.unrelatedCwdWithoutCheckoutOrGates).toBe(true);
    expect(observed.branchEvidence.subjects).toEqual(["failure", "test-audit", "consultation"]);
    expect(observed.principalUnavailable).toBe("retained; zero classify calls");
    expect(observed.ordinaryClassifyCalls).toBe(3);
    expect(observed.paidCalls).toBe(0);
    expect(observed.recovery).toEqual({
      existingHistoryReader: true, physicalAndNativeRecords: 2, exactInputsAndResponses: true,
      removedOnlyCwd: true, principalUnavailableRetained: true, failedStagedInvocationNotCommitted: true,
    });
  }, 120_000);

  test("discovers explicit-only gates from the edited package in a fresh loader", () => {
    const root = packageRoot();
    const loaded = loadInFreshProcess(root, mkdtempSync(path.join(tmpdir(), "pitako-gates-config-")));
    expect(loaded.errors).toEqual([]);
    const gates = loaded.skills.filter((skill) => skill.name === "gates");
    expect(gates).toHaveLength(1);
    const file = path.join(root, "skills/practical/gates/SKILL.md");
    expect(gates[0]).toMatchObject({ filePath: file, disableModelInvocation: true });
    expect(gates[0]!.body).toBe(readFileSync(file, "utf8"));
    expect(gates[0]!.body).toContain("Write only `<selected-project-root>/GATES.md`");
    expect(loaded.skillDiagnostics.filter((diagnostic) => diagnostic.path === file)).toEqual([]);
    expect(loaded.skillPrompt).not.toContain("<name>gates</name>");
    expect(loaded.skillPrompt).toContain("<name>verify-behavior</name>");
  });

  test("discovers the required extensions from a relative package path", async () => {
    const root = packageRoot();
    const isolatedConfig = mkdtempSync(path.join(tmpdir(), "pitako-web-config-empty-"));
    const loaded = await loadWithWebConfig(root, isolatedConfig);
    expect(path.isAbsolute(loaded.relativePackagePath)).toBe(false);
    expect(loaded.extensions.errors).toEqual([]);
    const paths = loaded.extensions.extensions.map((extension) => extension.resolvedPath);
    expect(paths.some((file) => file.endsWith("extensions/index.ts"))).toBe(true);
    const webExtensionIndex = paths.findIndex((file) => file.includes(`${path.sep}pi-web-access${path.sep}dist${path.sep}index.js`));
    const pitakoExtensionIndex = paths.findIndex((file) => file.endsWith(`${path.sep}extensions${path.sep}index.ts`));
    expect(webExtensionIndex).toBeLessThan(pitakoExtensionIndex);
    expect(paths.filter((file) => file.includes(`${path.sep}pi-codex-tools${path.sep}`))).toHaveLength(1);
    expect(paths.findIndex((file) => file.includes(`${path.sep}pi-codex-tools${path.sep}`))).toBeLessThan(pitakoExtensionIndex);
    expect(paths.some((file) => file.includes(`${path.sep}pi-lsp-client${path.sep}`))).toBe(true);
    expect(paths.some((file) => file.endsWith(`${path.sep}codegraph-raw.ts`))).toBe(true);
    expect(paths.some((file) => file.includes(`${path.sep}rpiv-todo${path.sep}`))).toBe(true);
    const hermesIndex = paths.findIndex((file) => file.includes(`${path.sep}pi-hermes-memory${path.sep}src${path.sep}index.ts`));
    expect(hermesIndex).toBeGreaterThan(-1);
    const acpIndex = paths.findIndex((file) => file.endsWith(`${path.sep}extensions${path.sep}acp.ts`));
    expect(acpIndex).toBeGreaterThan(-1);
    expect(acpIndex).toBeLessThan(hermesIndex);
    expect(paths.filter((file) => file.endsWith(`${path.sep}extensions${path.sep}acp.ts`))).toHaveLength(1);
    expect(paths.some((file) => file.includes(`${path.sep}billion-context-pi${path.sep}dist${path.sep}index.js`))).toBe(false);
    expect(paths.some((file) => file.endsWith(`${path.sep}extensions${path.sep}board${path.sep}index.ts`))).toBe(true);
    expect(paths.some((file) => file.includes(`${path.sep}pi-web-access${path.sep}dist${path.sep}index.js`))).toBe(true);
    for (const file of paths) expect(file.startsWith(root)).toBe(true);

    const names = registeredToolNames(loaded.extensions);
    expect(names).toContain("apply_patch");
    for (const name of ["lsp_diagnostics", "lsp_goto_definition", "lsp_find_references", "lsp_symbols", "lsp_prepare_rename", "lsp_rename"]) {
      expect(names).toContain(name);
    }
    for (const name of ["codegraph_search", "codegraph_callers", "codegraph_callees", "codegraph_impact", "codegraph_explore"]) {
      expect(names).toContain(name);
    }
    expect(names).toContain("todo");
    const memoryTools = ["memory_add", "memory_replace", "memory_remove", "memory_search", "session_search", "skill_manage"];
    expect(names).toEqual(expect.arrayContaining(memoryTools));
    expect(childActiveTools(names)).toEqual(expect.arrayContaining(memoryTools));
    for (const profile of ["coding", "analysis"] as const) {
      expect(toolsForProfile({ available: names, profile })).toEqual(expect.arrayContaining(memoryTools));
    }
    for (const name of ["web_search", "fetch_content", "source_check", "get_search_content", "web_enable"]) {
      expect(names).toContain(name);
    }
    for (const name of ["board_topic_create", "board_topic_list", "board_topic_read", "board_topic_update", "board_post", "board_query"]) {
      expect(names).toContain(name);
    }
    for (const name of ["todo_write", "todowrite", "todoread", "TodoWrite"]) {
      expect(names).not.toContain(name);
    }

    const skills = loaded.loader.getSkills().skills.map((skill) => skill.name);
    expect(skills).toContain("pitako-coding");
    expect(skills).toContain("ponytail");
    expect(skills).toContain("how");
    expect(skills).toContain("verify-behavior");
    for (const retired of ["tdd", "show-me-your-work", "principle-prove-it-works"]) {
      expect(skills).not.toContain(retired);
    }
    expect(skills).not.toContain("poteto-mode");
    const prompts = loaded.loader.getPrompts().prompts.map((prompt) => prompt.name);
    expect(prompts).toContain("explain");
  });

  test("profile guidance reaches the provider prompt without changing raw and dense tool access", async () => {
    const foreground = profileHarness();
    await foreground.start();
    const prompt = await foreground.composePrompt("base system prompt");
    expect(prompt).toContain("base system prompt");
    expect(prompt).toContain("bounded structural code questions");
    expect(prompt).toContain("literal, exhaustive or exact results");
    expect(prompt).toContain("partial or unavailable");
    for (const name of ["read", "grep", "bash", "lsp_diagnostics", "codegraph_search", "project_report", "read_symbol", "edit", "write", "web_search", "fetch_content", "source_check", "get_search_content", "web_enable"]) {
      expect(foreground.active).toContain(name);
    }
    expect(foreground.active).not.toContain("apply_patch");
    await foreground.shutdown();

    const analysis = profileHarness("analysis");
    await analysis.start();
    const analysisPrompt = await analysis.composePrompt("base system prompt");
    expect(analysisPrompt).toContain("bounded structural code questions");
    expect(analysisPrompt).toContain("edit, write, apply_patch, and lsp_rename are not");
    for (const name of ["read", "grep", "bash", "lsp_diagnostics", "codegraph_search", "project_report", "read_symbol", "web_search", "fetch_content", "source_check", "get_search_content", "web_enable"]) {
      expect(analysis.active).toContain(name);
    }
    expect(analysis.active).not.toContain("edit");
    expect(analysis.active).not.toContain("write");
    await analysis.shutdown();
  });

  test("configuration can disable and rename web tools", () => {
    const root = packageRoot();
    const configDir = mkdtempSync(path.join(tmpdir(), "pitako-web-config-custom-"));
    writeFileSync(path.join(configDir, "web-search.json"), JSON.stringify({
      tools: { webSearch: { enabled: false } },
      toolNames: { fetchContent: "fetch_page" },
    }));
    const loaded = loadInFreshProcess(root, configDir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.names).not.toContain("web_search");
    expect(loaded.names).toContain("fetch_page");
    for (const name of ["source_check", "get_search_content", "web_enable", "lsp_diagnostics", "codegraph_search", "todo", "board_topic_create"]) {
      expect(loaded.names).toContain(name);
    }
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

  test("Git source inventory includes ignored tracked and visible untracked current bytes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-source-inventory-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", root, ...args], {
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
      put("ignored-global", `${visible}\ncredential.ts\n`);
      put("ambient-config", `[core]\nexcludesFile = ${path.join(root, "ignored-global")}\n`);
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
          GIT_CONFIG_GLOBAL: path.join(root, "ambient-config"), GIT_CONFIG_SYSTEM: path.join(root, "ambient-config"),
          GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: path.join(root, "ignored-global") },
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
