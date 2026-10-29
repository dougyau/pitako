---
description: Explain a symbol using LSP for identity and CodeGraph for callers and impact
argument-hint: "<symbol>"
---

Explain `$1` in this repository.

1. At a known file position, use `lsp_goto_definition` or `lsp_find_references`. Otherwise locate the symbol with `lsp_symbols` or `codegraph_search`.
2. Use `codegraph_node`, `codegraph_callers`, or `codegraph_explore` to inspect its callers and surrounding design.
3. Read the relevant source. If navigation is partial or unavailable, report the limit and use targeted read/grep. Empty results do not prove absence.
4. Summarize what it does, who calls it, and what a change would affect. Do not edit files.
