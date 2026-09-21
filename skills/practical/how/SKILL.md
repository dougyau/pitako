---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions. Explains subsystem architecture and runtime flow from the actual repository. Use why for motivation."
---

# How

Answer "how does this currently work?" from the repository. Produce an architectural explanation at the level of a senior engineer onboarding onto a subsystem. Enough for a working mental model, not annotated source.

This is a single-agent skill. Do not spawn subagents, explorers, or an arena.

## Explore

If the scope is ambiguous, state your interpretation and continue. The user can redirect. When in doubt, take the narrow path.

1. Name the symbols, files, or flows in the question.
2. Use CodeGraph first: `codegraph_search`, then `codegraph_explore` or `codegraph_node`, then `codegraph_callers` / `codegraph_callees` when the path matters.
3. Confirm a known location with LSP (`lsp_goto_definition`, `lsp_find_references`, `lsp_symbols`).
4. Read only the files those tools point at.

Do not walk the whole tree. Do not invent callers.

## Output

Drop sections that do not apply:

- **Overview.** What this is and what it is not.
- **Key concepts.** Types, ownership, invariants.
- **How it works.** Runtime flow, with real `file:line` or symbol names.
- **Where things live.** Modules and boundaries.
- **Gotchas.** Non-obvious constraints the next edit must respect.

Cite evidence. Separate observed fact from inference. Do not edit files unless the user asked for a change.
