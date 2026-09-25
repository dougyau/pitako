---
name: remove-ai-slops
description: Behavior-preserving cleanup of the bounded code changed by current work. Used selectively after a verified implementation, not as a repo-wide refactor.
---

# Remove AI slop

Clean code this execution just produced. Do not restyle the repository.

Ideas come from oh-my-openagent `remove-ai-slops`. This skill does not copy that workflow, its scripts, or its file-size quota.

## When

Run only after the change is verified and verification is green, and only when the diff is large enough to hide waste: several files, a new abstraction, generated-looking code, a refactor, or a review note about needless complexity.

Skip a tiny or mechanical edit. Ponytail already covered that pass.

## Scope

Default scope is files changed by this execution. Do not follow ugliness into untouched files. Note an out-of-scope issue and leave it.

Standalone `$pre-pr` invokes this skill only for durable prose touched by its diff. This prose-only restriction overrides the code cleanup ideas below: do not review or delete code during the `$pre-pr` pass. It does not require an `$execute` ledger or `deslop.md`, and does not change `$execute` behavior or its broader changed-file scope and evidence rules.

## What to remove

- comments that restate the next line
- duplicated checks inside a boundary that already validates
- one-caller wrappers, unused helpers, and dead branches
- a second copy of a helper that already exists
- speculative factories, config, and interfaces with one implementation
- stdlib or platform code rewritten by hand

## What to keep

- validation at a trust boundary
- real error handling
- security and compatibility behavior the plan requires
- a comment that says why
- a pattern this repository already uses on purpose

Do not impose a line-count limit. Do not split a file because it is long.

## After

Verify again with the same checks that were green. If a cleanup change fails, revert that change and verify again. Do not widen the cleanup to make the failure go away.

For a dedicated `$execute` pass, write a short `deslop.md` in unit evidence or in `evidence/final/`: scope, simplifications that matter, risky candidates you kept, and the verification result. Standalone `$pre-pr` uses its report instead. Do not list every deleted comment.
