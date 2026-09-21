---
name: show-me-your-work
description: "Prefer inspectable evidence over self-report: the actual diff, command output, test result, or artifact. Use when the user asks to see the work, or when a completed change needs a reviewable proof."
---

# Show me your work

Hand back evidence a reviewer can inspect. Complements `principle-prove-it-works`.

This is a single-agent skill. Do not spawn a cross-model reviewer and do not write a decision log unless the run is long enough that a reviewer cannot reconstruct it from the reply.

## Prefer, in this order

1. The actual diff
2. The command you ran and its output
3. The test name and the result
4. A file, screenshot, or other artifact path that still exists

Do not substitute "it compiles", "tests probably pass", or a summary of a delegate.

## Long runs

If the work spans many decisions and a reviewer will return later, keep one local TSV at `decisions.tsv` or `.audit/<task-slug>.tsv`:

`ts`, `phase`, `decision`, `why`, `evidence`, `result`

Evidence is a pointer (commit, `file:line`, artifact path), not a paragraph. Append only. Do not commit the log unless the reviewer needs it.

## Reply

Lead with the proof. Name the command or path. Quote the decisive output. If a check was skipped, say why and what you used instead.
