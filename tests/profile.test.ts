import { describe, expect, test } from "bun:test";
import { isProtectedEditPath } from "../extensions/paths.ts";
import { childActiveTools, childSessionNote, ORCHESTRATION_TOOLS, parseProfile, profileNote, toolsForProfile, WEB_TOOLS } from "../extensions/profile.ts";

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
  ...WEB_TOOLS,
  ...ORCHESTRATION_TOOLS,
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

  test("Scout keeps analysis tools across coding selection and child profiles exclude orchestration", () => {
    const scout = childActiveTools(available, process.platform, "scout");
    for (const name of ["read", "bash", "grep", "find", "ls", "lsp_diagnostics", "codegraph_callers"]) {
      expect(scout).toContain(name);
    }
    for (const name of ["edit", "write", "apply_patch", "lsp_rename", ...ORCHESTRATION_TOOLS]) {
      expect(scout).not.toContain(name);
    }
    const codingRequest = toolsForProfile({ available, profile: "coding", roleId: "scout" });
    for (const name of ["read", "bash", "grep", "find", "ls", "lsp_diagnostics", "codegraph_callers"]) {
      expect(codingRequest).toContain(name);
    }
    for (const name of ["edit", "write", "apply_patch", "lsp_rename"]) expect(codingRequest).not.toContain(name);
    for (const name of WEB_TOOLS) {
      expect(scout).not.toContain(name);
      expect(codingRequest).not.toContain(name);
      expect(childActiveTools(available, process.platform, "researcher")).toContain(name);
      expect(toolsForProfile({ available, profile: "analysis" })).toContain(name);
    }
    expect(childActiveTools(available, process.platform, "developer")).toContain("apply_patch");
  });

  test("powershell is included only when requested", () => {
    const tools = toolsForProfile({ available, profile: "coding", includePowerShell: true });
    expect(tools).toContain("powershell");
  });

  test("unknown profile names fail with a configuration error", () => {
    expect(() => parseProfile("architect")).toThrow(/Unknown Pitako profile/);
  });

  test("profile notes guide bounded navigation and keep profile restrictions", () => {
    const coding = profileNote("coding");
    const analysis = profileNote("analysis");
    const child = childSessionNote("developer-1");
    for (const note of [coding, analysis, child]) {
      expect(note).toContain("bounded structural code questions");
      expect(note).toContain("choose an appropriate supported dense query");
      expect(note).toContain("literal, exhaustive or exact results");
      expect(note).toContain("partial or unavailable");
      expect(note).toContain("raw tools");
      expect(note).not.toContain("navigation baseline");
    }
    expect(coding).toContain("Keep edit/write active");
    expect(coding).toContain("use edit for authorized local edits; write for new files or full rewrites.");
    expect(coding).toContain("Keep diffs small");
    expect(coding).toContain("Board tools are pull-only");
    expect(coding).not.toContain("FINDING");
    expect(coding).not.toContain("apply_patch");
    expect(analysis).toContain("edit, write, apply_patch, and lsp_rename are not");
    expect(analysis).toContain("this profile is not a sandbox");
    expect(coding.length).toBeLessThan(800);
    const scout = childSessionNote("scout-instance", "scout");
    expect(scout).toContain("Pitako profile: analysis.");
    expect(scout).toContain("edit, write, apply_patch, and lsp_rename are not enabled");
    expect(scout).toContain("Shell remains available; this profile is not a sandbox.");
    expect(scout).toContain("Foreground orchestration tools are not enabled.");
    expect(scout).not.toContain("Keep edit and write active");
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
