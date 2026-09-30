import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { PitakoConfigError } from "../extensions/errors.ts";
import { commandOnPath, packageRoot, prepareRuntime, readStack } from "../extensions/stack.ts";

describe("stack configuration", () => {
  test("package manifest entries match config/stack.json and stay relative", () => {
    const root = packageRoot();
    const stack = readStack(root);
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      pi: { extensions: string[]; skills: string[] };
      dependencies: Record<string, string>;
      bundledDependencies: string[];
    };
    const expected = [
      ...stack.required.map((extension) => `./${extension.entry}`),
      `./${stack.pitakoExtension}`,
    ];
    expect(manifest.pi.extensions).toEqual(expected);
    const rooted = (name: string) => `${path.sep}${name}${path.sep}`;
    for (const entry of manifest.pi.extensions) {
      expect(path.isAbsolute(entry)).toBe(false);
      expect(entry.includes(rooted("home"))).toBe(false);
      expect(entry.includes(rooted("Users"))).toBe(false);
    }
    expect(manifest.dependencies["pi-lsp-client"]).toBe(stack.required[0]?.spec);
    expect(manifest.dependencies["@vndv/pi-codegraph"]).toBe("0.1.10");
    expect(manifest.dependencies["@dietrichgebert/ponytail"]).toBe("4.10.0");
    expect(manifest.dependencies["@juicesharp/rpiv-todo"]).toBe("2.11.0");
    expect(manifest.dependencies["pi-hermes-memory"]).toBe("0.9.9");
    expect(manifest.bundledDependencies).toContain("pi-hermes-memory");
    expect(manifest.dependencies["billion-context-pi"]).toBe("0.1.83");
    expect(manifest.bundledDependencies).toContain("billion-context-pi");
    expect(stack.required.find(({ id }) => id === "billion-context-pi")).toEqual({
      id: "billion-context-pi", spec: "billion-context-pi@0.1.83", entry: "extensions/acp.ts",
      tools: ["compress", "search_context", "decompress", "acp_status", "acp_cache"],
    });
    expect(stack.required.findIndex(({ id }) => id === "billion-context-pi")).toBeLessThan(stack.required.findIndex(({ id }) => id === "pi-hermes-memory"));
    expect(stack.required.find(({ id }) => id === "pi-hermes-memory")).toEqual({
      id: "pi-hermes-memory",
      spec: "pi-hermes-memory@0.9.9",
      entry: "node_modules/pi-hermes-memory/src/index.ts",
      tools: ["memory_add", "memory_replace", "memory_remove", "memory_search", "session_search", "skill_manage"],
    });
    expect(manifest.dependencies["pi-web-access"]).toBe("0.31.0");
    expect(manifest.bundledDependencies).toContain("pi-web-access");
    expect(stack.required.find(({ id }) => id === "pi-web-access")).toEqual({
      id: "pi-web-access",
      spec: "pi-web-access@0.31.0",
      entry: "node_modules/pi-web-access/dist/index.js",
      tools: ["web_search", "fetch_content", "source_check", "get_search_content", "web_enable"],
    });
    expect(stack.required.at(-1)).toEqual({
      id: "pi-codex-tools", spec: "pi-codex-tools@0.3.0",
      entry: "node_modules/pi-codex-tools/index.ts", tools: ["apply_patch"],
    });
    expect(manifest.dependencies["pi-codex-tools"]).toBe("0.3.0");
    expect(manifest.bundledDependencies).toContain("pi-codex-tools");
    expect(manifest.pi.skills).toContain("./node_modules/@dietrichgebert/ponytail/skills/ponytail");
    expect(manifest.pi.skills).not.toContain("./skills");
    expect(stack.optional).toEqual([]);
  });

  test("missing extension entry explains how to fix the install", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-missing-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    const stack = readStack(packageRoot());
    writeFileSync(path.join(root, "config", "stack.json"), JSON.stringify(stack));
    expect(() => prepareRuntime(root, { PATH: "" })).toThrow(PitakoConfigError);
    try {
      prepareRuntime(root, { PATH: "" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Required extension "pi-lsp-client"');
      expect(message).toContain("bun install");
      const homePrefix = ["", "home", ""].join("/");
      expect(message.includes(homePrefix)).toBe(false);
    }
  });

  test("missing pi-web-access entry explains how to fix the install", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-missing-web-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    const stack = readStack(packageRoot());
    writeFileSync(path.join(root, "config", "stack.json"), JSON.stringify(stack));
    for (const extension of stack.required.filter(({ id }) => id !== "pi-web-access")) {
      const entry = path.join(root, extension.entry);
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, "export {};\n");
    }
    expect(() => prepareRuntime(root, { PATH: "" })).toThrow(PitakoConfigError);
    try {
      prepareRuntime(root, { PATH: "" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Required extension "pi-web-access"');
      expect(message).toContain("node_modules/pi-web-access/dist/index.js");
      expect(message).toContain("bun install");
    }
  });

  test("codegraph on PATH is accepted without a bundled binary", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-bin-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    const stack = readStack(packageRoot());
    writeFileSync(path.join(root, "config", "stack.json"), JSON.stringify(stack));
    for (const extension of stack.required) {
      const entry = path.join(root, extension.entry);
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, "export {};\n");
    }
    const binDir = mkdtempSync(path.join(tmpdir(), "pitako-path-"));
    writeFileSync(path.join(binDir, "codegraph"), "");
    const env = { PATH: binDir };
    const prepared = prepareRuntime(root, env);
    expect(prepared.codegraph).toBe("path");
    expect(commandOnPath("codegraph", env.PATH)).toBe(true);
    expect(env.PATH).toBe(binDir);
  });
});
