import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pitako from "../extensions/index.ts";
import { packageRoot } from "../extensions/stack.ts";
import { loadPitako, registeredToolNames } from "../scripts/load-pitako.ts";

describe("Pi package loading", () => {
  test("discovers Pitako, LSP, and CodeGraph from a relative package path", async () => {
    const root = packageRoot();
    const loaded = await loadPitako(root);
    expect(path.isAbsolute(loaded.relativePackagePath)).toBe(false);
    expect(loaded.extensions.errors).toEqual([]);
    const paths = loaded.extensions.extensions.map((extension) => extension.resolvedPath);
    expect(paths.some((file) => file.endsWith("extensions/index.ts"))).toBe(true);
    expect(paths.some((file) => file.includes(`${path.sep}pi-lsp-client${path.sep}`))).toBe(true);
    expect(paths.some((file) => file.includes(`${path.sep}pi-codegraph${path.sep}`))).toBe(true);
    expect(paths.some((file) => file.includes(`${path.sep}rpiv-todo${path.sep}`))).toBe(true);
    expect(paths.some((file) => file.endsWith(`${path.sep}extensions${path.sep}board${path.sep}index.ts`))).toBe(true);
    for (const file of paths) expect(file.startsWith(root)).toBe(true);

    const names = registeredToolNames(loaded.extensions);
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

  test("analysis profile wiring excludes edit and write", async () => {
    const previous = process.env.PITAKO_PROFILE;
    process.env.PITAKO_PROFILE = "analysis";
    try {
      const active = ["read", "bash", "edit", "write"];
      const available = [
        "read", "bash", "edit", "write", "grep", "find", "ls",
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
    const skip = new Set(["node_modules", ".git", ".codegraph", "bun.lock"]);
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        if (skip.has(name)) continue;
        const file = path.join(directory, name);
        const stat = statSync(file);
        if (stat.isDirectory()) {
          walk(file);
          continue;
        }
        if (stat.size > 1_000_000) continue;
        const text = readFileSync(file, "utf8");
        const rooted = (name: string) => `${path.sep}${name}${path.sep}`;
        if (text.includes(rooted("home")) || text.includes(rooted("Users")) || /sk-[A-Za-z0-9]{20,}/.test(text)) {
          offenders.push(path.relative(root, file));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
