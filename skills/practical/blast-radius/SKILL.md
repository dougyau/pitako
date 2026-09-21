---
name: blast-radius
description: "Find what a change could break somewhere else before it ships. Use before changing shared APIs, functions, types, modules, or data structures, or when reviewing a small diff you do not trust."
---

# Blast radius

Find what a change breaks somewhere else, before it ships. Companion to `how` and `why`. Listing callers is the start, not the job. The job is the breakage grep will miss.

This is a single-agent skill. Do not run an arena or multi-model panel.

## Tools

Before editing shared code:

- `codegraph_impact` and `codegraph_callers` for the symbol
- `lsp_find_references` when you have a file position
- `codegraph_explore` when the type or module boundary is unclear

Then look where those tools stop: wire formats, DB columns, generated names, another language reading the same bytes, feature flags, tests that pin the old contract.

## How sure are you

For each safety fact, get as far down this list as is cheap, and say where it stopped.

1. You said so. Worthless on its own.
2. You pointed at the line. A real `file:line`, or the library's own source.
3. You walked the failure and it cannot reach.
4. You ran it. A script or test that calls the real code and fails loud if you are wrong.

Any safety fact that does not reach step 4 is unproven. Say so.

## Output

- **What it does.** Including the part the diff does not spell out.
- **The one fact it is safe because of.** State it, say which step you reached, show the proof or mark it unproven.
- **Risks.** Real ones only. Each names how it breaks, a `file:line`, likelihood, cost, and how to check.
- **Cleared.** What you checked and why it is fine.
- **Before you merge.** The cheapest test or repro that would catch the real bug.
