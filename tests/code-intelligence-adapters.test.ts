import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { kind, Lang, parse, parseFiles } from "@ast-grep/napi";
import { createGrepTool } from "@earendil-works/pi-coding-agent";
import { lsp_goto_definition } from "pi-lsp-client/src/lsp/tools/goto-definition.js";
import { disposeDefaultLspManager } from "pi-lsp-client/src/lsp/manager.js";
import { workspacePath, resolveLanguage, QUERY_BUDGETS } from "../extensions/code-intelligence/contracts.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-code-intel-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("pinned ast-grep NAPI parses, finds nodes, reports ranges, and parses multiple files", async () => {
  const tree = parse(Lang.TypeScript, "const alpha = 1;\nfunction beta() { return alpha; }\n");
  const root = tree.root();
  const first = root.find(kind(Lang.TypeScript, "function_declaration"));
  const all = root.findAll(kind(Lang.TypeScript, "identifier"));
  expect(first?.text()).toContain("function beta");
  expect(all.map((node) => node.text())).toContain("alpha");
  expect(first?.range()).toMatchObject({ start: { line: 1, column: 0 }, end: { line: 1 } });

  const dir = tempDir();
  const files = ["a.ts", "b.ts"].map((name) => path.join(dir, name));
  files.forEach((file, index) => writeFileSync(file, `const value${index} = ${index};`));
  const parsed: string[] = [];
  const count = await parseFiles(files, (error, result) => {
    if (error) throw error;
    parsed.push(result.filename());
  });
  expect(count).toBe(2);
  expect(parsed).toHaveLength(2);
});

test("language, physical workspace path, and response budgets fail closed", () => {
  expect(resolveLanguage("src/a.ts")).toEqual({ status: "resolved", language: "TypeScript" });
  expect(resolveLanguage("src/a.js")).toEqual({ status: "resolved", language: "JavaScript" });
  expect(resolveLanguage("README.md")).toEqual({ status: "unsupported", requested: "md" });
  expect(resolveLanguage("src/a.py")).toEqual({ status: "unsupported", requested: "py" });
  expect(resolveLanguage("README")).toMatchObject({ status: "ambiguous" });
  expect(resolveLanguage(undefined)).toMatchObject({ status: "ambiguous" });
  expect(resolveLanguage("a.ts", "Ruby")).toEqual({ status: "unsupported", requested: "Ruby" });
  const workspace = tempDir();
  const outside = tempDir();
  expect(workspacePath(workspace, "src/file.ts")).toBe(path.join(workspace, "src/file.ts"));
  expect(() => workspacePath(workspace, path.join(outside, "secret.ts"))).toThrow(/escapes workspace/);
  if (process.platform !== "win32") {
    const link = path.join(workspace, "escape");
    try {
      symlinkSync(outside, link);
      expect(() => workspacePath(workspace, path.join(link, "secret.ts"))).toThrow(/escapes workspace/);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("EACCES")) throw error;
    }
  }
  expect(QUERY_BUDGETS).toEqual({ responseBytes: 12288, candidates: 8, relations: 8, sourceLines: 120 });
});

test("Pi grep and installed LSP tool definitions are directly callable contracts", async () => {
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "sample.ts"), "const needle = 42;\nconsole.log(needle);\n");
  const grep = createGrepTool(dir);
  expect(grep.name).toBe("grep");
  const result = await grep.execute("test", { pattern: "needle", literal: true }, new AbortController().signal);
  expect(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).toContain("needle");

  expect(lsp_goto_definition.name).toBe("lsp_goto_definition");
  expect(typeof lsp_goto_definition.execute).toBe("function");
  try {
    const lspResult = await lsp_goto_definition.execute(
      "test",
      { filePath: path.join(dir, "sample.ts"), line: 2, character: 13 },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    expect(lspResult).toHaveProperty("content");
    expect((lspResult.details as { locations: unknown[] }).locations).toHaveLength(1);
  } finally {
    await disposeDefaultLspManager();
  }
});
