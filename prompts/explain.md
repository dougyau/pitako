---
description: Explain a symbol using CodeGraph, then LSP if a location is known
argument-hint: "<symbol>"
---

Explain `$1` in this repository.

1. Use CodeGraph (`codegraph_search`, then `codegraph_node` or `codegraph_explore`) to locate the symbol and its callers.
2. If you have a file position, use `lsp_goto_definition` or `lsp_find_references` to confirm it.
3. Read only the files those tools point at.
4. Summarize what it does, who calls it, and what a change would affect. Do not edit files.
