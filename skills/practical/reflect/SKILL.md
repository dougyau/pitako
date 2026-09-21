---
name: reflect
description: "After difficult work, identify what was learned, what failed, recurring corrections, and possible improvements to repository structure, skills, or tooling. Use when the user says reflect. Does not create Pitako memory or a board."
---

# Reflect

Mine the current session for durable learnings. Do not invent a memory system or a message board.

This is a single-agent skill. Do not spawn review subagents.

Skip when the conversation is trivial or already covered by a skill that was followed correctly. One-offs are not learnings.

## Process

1. Recap the work from this session. Prefer the actual diff, commands, and test output over memory of the chat.
2. Split findings into:
   - **Learned.** A reusable engineering fact.
   - **Failed.** What did not work and why.
   - **Recurring.** The same correction appeared more than once.
   - **Structural.** A lint, type, test, helper, or skill change would prevent the next occurrence.
3. For recurring items, prefer encoding them in structure (`principle-encode-lessons-in-structure`) over adding more prompt text.
4. Propose edits. Do not apply skill or repo changes unless the user asked.

## Output

Short list, no preamble:

- Learned: one line each
- Failed: one line each
- Recurring corrections: one line each
- Proposed structural encodings: path or mechanism, one line each
- Dropped: one line plus reason
