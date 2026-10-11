import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
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
