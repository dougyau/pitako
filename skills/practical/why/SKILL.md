---
name: why
description: "Use for 'why does X work this way', design rationale, regressions, or postmortems. Prefer evidence from code structure, git history, comments, and docs. Use how for runtime behavior."
---

# Why

Investigate why the system is shaped this way. Companion to `how`. `how` answers what the code does. `why` answers what forces produced that shape.

This is a single-agent skill. Do not spawn parallel investigators or require MCP coverage of every evidence category.

## Posture

Be a careful investigator. Separate observed fact from inference. If the target is vague, state the interpretation and continue.

## Anchor in code

Before history, locate the code:

- File paths and the key symbols
- Nearby comments, tests, and docs
- CodeGraph / LSP for the current shape and callers

Then pull history when it is useful:

```bash
git blame -L <start>,<end> <file>
git log --follow -p -- <file>
git log --oneline -20 -- <file>
```

Use `gh pr view` only when a merge commit names a PR and `gh` is available.

## Sources, in this order

1. The current code and its tests
2. Comments and in-repo docs
3. Git history and PR text, when present
4. Other available trackers or logs, only if they are already in this session

Document a missing source as a gap. Do not pretend a search happened.

## Output

- **The question**
- **The code in question** (paths, symbols)
- **What we found** (cited)
- **What we can reasonably infer**
- **Competing hypotheses**, if more than one fits
- **What we don't know**
- **Sources consulted**, including empty ones

If the user is about to change this code, end with Preserve / Change / Avoid / Risk. Do not implement unless they asked.
