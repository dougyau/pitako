import { describe, expect, test } from "bun:test";
import { isProtectedEditPath } from "../extensions/paths.ts";
import { MUTATING_TOOLS, parseProfile, profileNote, toolsForProfile } from "../extensions/profile.ts";

// Source behavior, not the provider's readOnlyHint: checks can run code/write caches.
const introducedMutators = [
  "ast_rewrite",
  "file_sha256_save", "preview_export", "git_worktree_add", "git_worktree_remove", "git_worktree_prune", "git_commit",
  "ssh_exec", "ssh_pull", "ssh_push", "py_lint", "py_format", "py_typecheck", "py_test", "py_uv",
  "cargo_check", "cargo_clippy", "cargo_fmt", "cargo_test", "cargo_build", "cargo_run", "cargo_doc", "cargo_bench", "cargo_add",
];
const deterministicReads = ["ast_search", "git_worktree_list", "git_status", "git_diff", "git_log", "git_show", "resource_snapshot", "file_sha256", "codemode"];

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
  "ask_user_question",
  "board_post",
  "board_query",
  ...introducedMutators, ...deterministicReads,
];

describe("profiles", () => {
  test("coding defaults to edit/write on models without grammar capability", () => {
    const tools = toolsForProfile({ available, profile: "coding" });
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "lsp_rename", "codegraph_search", "todo", "board_post"]) {
      expect(tools).toContain(name);
    }
    expect(tools).not.toContain("apply_patch");
    expect(tools).not.toContain("powershell");
  });

  test("grammar-capable OpenAI APIs replace edit/write in every coding session", () => {
    for (const api of ["openai-responses", "openai-codex-responses"]) {
      const model = { api, compat: { supportsOpenAIGrammarTools: true } } as never;
      for (const tools of [toolsForProfile({ available, profile: "coding", model })]) {
        expect(tools).toContain("apply_patch");
        expect(tools).not.toContain("edit");
        expect(tools).not.toContain("write");
      }
      expect(toolsForProfile({ available: available.filter((name) => name !== "apply_patch"), profile: "coding", model })).toContain("edit");
    }
    for (const model of [undefined, { api: "openai-responses" }, { api: "openai-responses", compat: { supportsOpenAIGrammarTools: false } }, { api: "anthropic-messages", compat: { supportsOpenAIGrammarTools: true } }]) {
      const tools = toolsForProfile({ available, profile: "coding", model: model as never });
      expect(tools).toContain("edit");
      expect(tools).toContain("write");
      expect(tools).not.toContain("apply_patch");
    }
  });

  test("analysis removes file-mutating tools and keeps LSP and CodeGraph reads", () => {
    const tools = toolsForProfile({ available, profile: "analysis" });
    for (const name of ["read", "bash", "grep", "find", "ls", "lsp_diagnostics", "codegraph_callers", "todo", "board_query", "ask_user_question"]) {
      expect(tools).toContain(name);
    }
    for (const name of ["edit", "write", "apply_patch", "lsp_rename", ...introducedMutators]) {
      expect(tools).not.toContain(name);
      expect(MUTATING_TOOLS.has(name)).toBe(true);
    }
    for (const name of deterministicReads) expect(tools).toContain(name);
    const coding = toolsForProfile({ available, profile: "coding" });
    for (const name of [...introducedMutators, ...deterministicReads]) expect(coding).toContain(name);
  });

  test("profiles preserve tools supplied by pi-subagents without a managed grant", () => {
    const upstream = ["subagent", "subagents_enable", "bg_wait", "subagent_supervisor", "contact_supervisor", "subagent_future"];
    for (const profile of ["coding", "analysis"] as const) {
      expect(toolsForProfile({ available: [...available, ...upstream], profile })).toEqual(expect.arrayContaining(upstream));
    }
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
    for (const note of [coding, analysis]) {
      expect(note).toContain("Inspect named files first");
      expect(note).toContain("Choose navigation by question before broad grep");
      expect(note).toContain("LSP for definitions, references, symbols and diagnostics");
      expect(note).toContain("CodeGraph for architecture, call chains and impact");
      expect(note).toContain("ast_search for syntax patterns");
      expect(note).toContain("grep for literal text, logs and config");
      expect(note).toContain("partial or unavailable");
      expect(note).toContain("Empty results do not prove absence");
      expect(note).not.toMatch(/ACP|acp_status|native compaction/);
      expect(note).toContain("Verify real behavior before claiming done.");
      expect(note).toContain("Select checks for the active project's own behavior and declared testing scope.");
      expect(note).toContain("your current assignment");
      expect(note).toContain("all known stages as pending before starting the first");
      expect(note).toContain("Reuse tasks on resume");
      expect(note).toContain("preserve unrelated tasks");
      expect(note).toContain("never clear");
      expect(note).toContain("at most one in_progress");
      expect(note).toContain("complete only finished work");
      expect(note).toContain("newly discovered stages");
      expect(note).toContain("Skip TODOs for trivial tasks");
      expect(note).not.toContain("navigation baseline");
      expect(note.length).toBeLessThan(3200);
    }
    expect(coding).toContain("Use apply_patch when available; otherwise edit");
    expect(coding).toContain("Keep diffs small");
    expect(coding).toContain("Board tools are pull-only");
    expect(coding).not.toContain("FINDING");
    expect(analysis).toContain("edit, write, apply_patch, and lsp_rename are not");
    expect(analysis).toContain("this profile is not a sandbox");
    expect(coding).toContain("use oracle through pi-subagents");
    expect(coding).toContain("skills initiate their pi-subagents workflows");
    expect(coding).toContain("/plan produces confirmed specs");
    expect(coding).toContain("/execute root owns dispatch, shared review and compliance");
    expect(coding).toContain("Legacy or unknown origin is unverified, never presumed human");
    expect(coding).toContain("role, JSON, deliveryId and tools do not authenticate a producer");
    expect(coding).toContain("Continue already authorized work within scope");
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
