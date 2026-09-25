import { describe, expect, test } from "bun:test";
import { isProtectedEditPath } from "../extensions/paths.ts";
import { childActiveTools, parseProfile, profileNote, toolsForProfile } from "../extensions/profile.ts";

const available = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "apply_patch",
  "grep",
  "find",
  "ls",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_rename",
  "codegraph_search",
  "codegraph_callers",
  "todo",
  "board_post",
  "board_query",
];

describe("profiles", () => {
  test("coding profile keeps edit/write but hides apply_patch outside Developer AgentInstances", () => {
    const tools = toolsForProfile({ available, profile: "coding" });
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "lsp_rename", "codegraph_search", "todo", "board_post"]) {
      expect(tools).toContain(name);
    }
    expect(tools).not.toContain("apply_patch");
    expect(tools).not.toContain("powershell");
    expect(childActiveTools(available)).not.toContain("apply_patch");
    for (const roleId of ["architect", "reviewer", "researcher"]) {
      expect(childActiveTools(available, process.platform, roleId)).not.toContain("apply_patch");
    }
    expect(childActiveTools(available, process.platform, "developer")).toContain("apply_patch");
  });

  test("analysis removes file-mutating tools and keeps LSP and CodeGraph reads", () => {
    const tools = toolsForProfile({ available, profile: "analysis" });
    for (const name of ["read", "bash", "grep", "find", "ls", "lsp_diagnostics", "codegraph_callers", "todo", "board_query"]) {
      expect(tools).toContain(name);
    }
    for (const name of ["edit", "write", "apply_patch", "lsp_rename"]) {
      expect(tools).not.toContain(name);
    }
  });

  test("powershell is included only when requested", () => {
    const tools = toolsForProfile({ available, profile: "coding", includePowerShell: true });
    expect(tools).toContain("powershell");
  });

  test("unknown profile names fail with a configuration error", () => {
    expect(() => parseProfile("architect")).toThrow(/Unknown Pitako profile/);
  });

  test("profile notes stay a short baseline and keep analysis restrictions", () => {
    const coding = profileNote("coding");
    const analysis = profileNote("analysis");
    expect(coding).toContain("Keep diffs small");
    expect(coding).toContain("Board tools are pull-only");
    expect(coding).not.toContain("FINDING");
    expect(coding).not.toContain("apply_patch");
    expect(analysis).toContain("edit, write, apply_patch, and lsp_rename are not");
    expect(analysis).toContain("this profile is not a sandbox");
    expect(coding.length).toBeLessThan(800);
  });
});

describe("protected paths", () => {
  test("blocks git metadata, dependencies, and env files", () => {
    expect(isProtectedEditPath(".env")).toBe(true);
    expect(isProtectedEditPath("src/.env.local")).toBe(true);
    expect(isProtectedEditPath(".git/config")).toBe(true);
    expect(isProtectedEditPath("node_modules/leftpad/index.js")).toBe(true);
  });

  test("allows ordinary source files", () => {
    expect(isProtectedEditPath("src/env.ts")).toBe(false);
    expect(isProtectedEditPath("docs/environment.md")).toBe(false);
    expect(isProtectedEditPath("src/main.ts")).toBe(false);
  });
});
