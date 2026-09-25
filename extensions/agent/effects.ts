/**
 * Pi ToolDefinition has no mutating/read-only flag (pi-coding-agent 0.87).
 * Unknown names are potentially mutating so a future extension cannot be replayed.
 */
import { CODE_INTELLIGENCE_TOOL_NAMES } from "../code-intelligence/metrics.ts";

export type ToolEffect = "read_only" | "mutating" | "potentially_mutating";

const READ_ONLY = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_symbols",
  "lsp_prepare_rename",
  "codegraph_search",
  "codegraph_callers",
  "codegraph_callees",
  "codegraph_impact",
  "codegraph_explore",
  "codegraph_node",
  "codegraph_status",
  "codegraph_files",
  "board_topic_list",
  "board_topic_read",
  "board_query",
  ...CODE_INTELLIGENCE_TOOL_NAMES,
]);

const MUTATING = new Set([
  "edit",
  "write",
  "apply_patch",
  "bash",
  "powershell",
  "lsp_rename",
  "todo",
  "board_post",
  "board_topic_create",
  "board_topic_update",
]);

export function toolEffect(name: string): ToolEffect {
  if (READ_ONLY.has(name)) return "read_only";
  if (MUTATING.has(name)) return "mutating";
  return "potentially_mutating";
}

export function marksSideEffect(name: string): boolean {
  return toolEffect(name) !== "read_only";
}
