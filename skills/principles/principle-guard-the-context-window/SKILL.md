---
name: principle-guard-the-context-window
description: "Apply when context is filling up: large outputs, long files, repeated reads, or wide exploration. Prefer targeted CodeGraph/LSP queries and summaries over dumping raw trees."
---

# Guard the Context Window

The context window is finite and non-renewable within a session. Every token should be worth its cost.

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

**Pattern:**
- **Isolate large payloads.** Prefer a targeted CodeGraph or LSP query over reading a whole tree. Keep summaries, not raw dumps.
- **Don't read what you won't use.** Read selectively based on relevance. If a file isn't needed for the current task, skip it.
- **Keep frequently used content inline.** Templates and references used on every invocation belong in the skill file, not in separate files that cost a read each time.
- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.

## Pitako

Load this principle only when its trigger applies. Do not keep it in context for unrelated work.
When the question is structural, use CodeGraph or LSP before reading large files.
