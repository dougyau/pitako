import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pitako from "../extensions/index.ts";
import { agentScope } from "../extensions/agent/scope.ts";
import { packageRoot } from "../extensions/stack.ts";
import { loadPitako, registeredToolNames } from "../scripts/load-pitako.ts";

function profileHarness(profileFlag?: string) {
  const active = ["read", "bash", "edit", "write"];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  let profileCommand: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const available = [
    "read", "bash", "edit", "write", "apply_patch", "grep", "find", "ls",
    "lsp_diagnostics", "lsp_rename", "codegraph_search", "project_report", "read_symbol",
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
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) { handlers.set(event, handler); },
    registerCommand(_name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      profileCommand = command.handler;
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
  test("discovers Pitako, LSP, and CodeGraph from a relative package path", async () => {
    const root = packageRoot();
    const loaded = await loadPitako(root);
    expect(path.isAbsolute(loaded.relativePackagePath)).toBe(false);
    expect(loaded.extensions.errors).toEqual([]);
    const paths = loaded.extensions.extensions.map((extension) => extension.resolvedPath);
    expect(paths.some((file) => file.endsWith("extensions/index.ts"))).toBe(true);
    expect(paths.some((file) => file.includes(`${path.sep}pi-codex-tools${path.sep}`))).toBe(false);
    expect(paths.some((file) => file.includes(`${path.sep}pi-lsp-client${path.sep}`))).toBe(true);
    expect(paths.some((file) => file.endsWith(`${path.sep}codegraph-raw.ts`))).toBe(true);
    expect(paths.some((file) => file.includes(`${path.sep}rpiv-todo${path.sep}`))).toBe(true);
    expect(paths.some((file) => file.endsWith(`${path.sep}extensions${path.sep}board${path.sep}index.ts`))).toBe(true);
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
    expect(skills).toContain("principle-prove-it-works");
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
    for (const name of ["read", "grep", "bash", "lsp_diagnostics", "codegraph_search", "project_report", "read_symbol", "edit", "write"]) {
      expect(foreground.active).toContain(name);
    }
    expect(foreground.active).not.toContain("apply_patch");
    await foreground.shutdown();

    const analysis = profileHarness("analysis");
    await analysis.start();
    const analysisPrompt = await analysis.composePrompt("base system prompt");
    expect(analysisPrompt).toContain("bounded structural code questions");
    expect(analysisPrompt).toContain("edit, write, apply_patch, and lsp_rename are not");
    for (const name of ["read", "grep", "bash", "lsp_diagnostics", "codegraph_search", "project_report", "read_symbol"]) {
      expect(analysis.active).toContain(name);
    }
    expect(analysis.active).not.toContain("edit");
    expect(analysis.active).not.toContain("write");
    await analysis.shutdown();
  });

  test("profile reloads and profile command never expose patch outside Developer AgentInstances", async () => {
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
      expect(developer.active).toContain("apply_patch");
      await developer.selectProfile("analysis");
      expect(developer.active).not.toContain("apply_patch");
      await developer.selectProfile("coding");
      expect(developer.active).toContain("apply_patch");
      await developer.start();
      expect(developer.active).toContain("apply_patch");
    });
    await developer.shutdown();
  });

  test("supervised Herdr role controls patch across profile switches", async () => {
    const previousId = process.env.PITAKO_INSTANCE_ID;
    const previousRole = process.env.PITAKO_ROLE_ID;
    try {
      process.env.PITAKO_INSTANCE_ID = "herdr-child";
      process.env.PITAKO_ROLE_ID = "developer";
      const developer = profileHarness();
      await developer.start();
      expect(developer.active).toContain("apply_patch");
      expect(developer.active).toContain("edit");
      expect(developer.active).toContain("write");
      await developer.selectProfile("analysis");
      expect(developer.active).not.toContain("apply_patch");
      await developer.selectProfile("coding");
      expect(developer.active).toContain("apply_patch");
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
          handlers.set(event, handler);
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

describe("repository hygiene", () => {
  test("source does not embed absolute developer paths or credentials", () => {
    const root = packageRoot();
    const skip = new Set(["node_modules", ".git", ".codegraph", ".pitako", "bun.lock"]);
    const offenders: string[] = [];
    const rooted = (name: string) => `${path.sep}${name}${path.sep}`;
    const isForbidden = (text: string) => text.includes(rooted("home")) || text.includes(rooted("Users")) || /sk-[A-Za-z0-9]{20,}/.test(text);
    expect(isForbidden(`${path.sep}home${path.sep}developer${path.sep}source.ts`)).toBe(true);
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const file = path.join(directory, name);
        if (skip.has(name) || path.relative(root, file) === path.join(".pitako", "runs")) continue;
        const stat = statSync(file);
        if (stat.isDirectory()) {
          walk(file);
          continue;
        }
        if (stat.size > 1_000_000) continue;
        const text = readFileSync(file, "utf8");
        if (isForbidden(text)) {
          offenders.push(path.relative(root, file));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
