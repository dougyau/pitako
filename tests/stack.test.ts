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
    expect(manifest.pi.skills).toContain("./node_modules/@dietrichgebert/ponytail/skills/ponytail");
    expect(manifest.pi.skills).not.toContain("./skills");
    expect(stack.optional[0]?.status).toBe("not-bundled");
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

  test("codegraph on PATH is accepted without a bundled binary", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-bin-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "pi-lsp-client", "src"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "@vndv", "pi-codegraph", "extensions"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "@juicesharp", "rpiv-todo"), { recursive: true });
    const stack = readStack(packageRoot());
    writeFileSync(path.join(root, "config", "stack.json"), JSON.stringify(stack));
    writeFileSync(path.join(root, "node_modules", "pi-lsp-client", "src", "index.ts"), "export {};\n");
    writeFileSync(path.join(root, "node_modules", "@vndv", "pi-codegraph", "extensions", "codegraph.ts"), "export {};\n");
    writeFileSync(path.join(root, "node_modules", "@juicesharp", "rpiv-todo", "index.ts"), "export {};\n");
    const binDir = mkdtempSync(path.join(tmpdir(), "pitako-path-"));
    writeFileSync(path.join(binDir, "codegraph"), "");
    const env = { PATH: binDir };
    const prepared = prepareRuntime(root, env);
    expect(prepared.codegraph).toBe("path");
    expect(commandOnPath("codegraph", env.PATH)).toBe(true);
    expect(env.PATH).toBe(binDir);
  });
});
