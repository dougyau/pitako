---
name: pre-pr
description: "Prepare the current worktree's branch diff for first or later publication without `$execute` or a frozen plan."
---

# Pre-PR preparation

Run `/skill:pre-pr` or `/skill:pre-pr base=<local-ref>` before a first push, PR creation, or a later push. This on-demand pass requires no `$plan`, frozen plan, `$execute`, ledger, or Board topic. This standalone pass must not create a plan, ledger, or Board topic.

The Coordinator owns scope, order, evidence, and readiness, but does not self-review or edit the scoped diff. The Developer resolves findings, edits the scoped diff, and runs checks. An independent Reviewer, separate from the Coordinator and Developer, judges the final diff and never edits. Stop if another actor is changing this worktree.

## Boundaries

- Work only in the top level of the current process cwd's worktree. Do not inspect, create, add, or switch to another worktree or branch.
- This is guidance, not enforcement. Never commit, push, force-push, merge, fetch, use `gh`, read or write a remote PR, create or update a PR, or perform any other remote action. Do not claim the skill technically prevents these actions.
- Use only local refs and files. A PR description is in scope only if its copy is already in this worktree; otherwise report it unavailable.
- Keep changes within the current diff. Do not add features, redesign, or clean unrelated files.

## Procedure

1. Pin the scope before editing. Record `git rev-parse --show-toplevel`, the current branch, `HEAD`, and `git status --short`. Use the cwd's worktree only.
2. Choose a local comparison base in this order:
   - An explicit `base=<local-ref>` supplied by the user.
   - A target documented for this branch in local project guidance.
   - An unambiguous locally cached remote default, identified from local metadata such as `refs/remotes/<remote>/HEAD`, only if nothing indicates a different PR target. This is a provisional inference, not proof of the PR base.

   Never assume `main` or treat the feature branch's upstream as its PR base. Do not fetch to find a ref. If the base is missing, ambiguous, unavailable locally, conflicts with other evidence, or has no merge-base with `HEAD`, ask for a base and report `BLOCKED`. Record whether the selected base is provisional.
3. Record the merge-base and inspect the complete scoped change: commits since that merge-base, staged and unstaged edits, and relevant non-ignored untracked files. Read the full diff and those untracked files; do not rely on a summary or PR prose. Include meaningful documentation and skill changes. Record base-only and `HEAD`-only commit counts with `git rev-list --left-right --count <base>...HEAD` (replace `<base>` with the selected ref); report when `HEAD` is behind the base. If the scoped diff is empty, report `BLOCKED`; do not call it ready or present unrelated green checks as validation.
4. Resolve material findings before cleanup. Then make one final Ponytail pass over the whole scoped diff. Remove only demonstrably dead, duplicate, temporary, experimental, or unnecessary code and prose. Preserve behavior, tests that prove distinct guarantees, observability, validation, error handling, security, public contracts, and licensing. Do not set a line-count target or add features.
5. Run affected focused checks. Once they are green, apply `remove-ai-slops` selectively to durable prose touched by this diff, or record why it is unnecessary. This prose pass does not reopen code cleanup. Preserve permissions, limits, warnings, provenance, and accepted invariants. Treat any uncertain wording change as potentially semantic. Rerun affected checks after prose edits.
6. Run applicable final gates after all edits: focused tests, the full test suite, typecheck, `git diff --check`, and package/load or smoke checks where the change warrants them. Report unavailable checks as unavailable, never passed. A failed required gate blocks readiness.
7. Classify cleanup changes using the final diff and evidence:
   - **A:** demonstrably nonsemantic subtraction; behavior and contracts are unchanged. Record the reason and evidence. Deletion alone does not prove A.
   - **B:** potentially semantic or uncertain, including changes to logic, state, lifecycle, concurrency, paths, security, permissions, public output, or workflow guidance that changes permissions. Treat uncertainty as B.

   Before reporting readiness, confirm evidence includes an adequate independent review of the complete final diff. If no independent review covers the complete final diff, including when review is absent or inadequate, obtain one. If an independent Reviewer is unavailable, report `BLOCKED`. B requires an independent Reviewer to assess the whole final diff, not only the last patch. The Reviewer does not fix findings; the Developer resolves material findings. Any B or uncertain edit after approval invalidates that approval: rerun affected checks and applicable final gates, then obtain an independent Reviewer assessment of the complete updated final diff. Repeat after any further B or uncertain edits. An evidenced A does not require a second review solely for cleanup when adequate independent review already covers it. This exception does not waive `$execute`'s required final review or any review required by risk. Do not claim prior review without evidence of its scope.
8. Reinspect the complete diff and scoped Git status, including staged, unstaged, and relevant untracked files. Inspect staged and unstaged scoped changes and relevant untracked files during cleanup; do not omit them from review. Check for generated residue, secrets, and unrelated edits. Check any PR copy already present in the worktree; do not retrieve one remotely.

## Report

Give the status, selected base and whether it is provisional, merge-base and commit range, scoped diff, Ponytail and prose-cleanup result, review coverage, exact checks and results, and remaining risks or unavailable checks.

- Any staged, unstaged, or relevant non-ignored untracked scoped changes, secrets, or generated residue block readiness. Inspect these edits during cleanup; they are review material, not committed push payload.
- `READY_TO_PUSH`: the scoped diff is nonempty, the base is unambiguous and non-provisional, applicable gates pass, material findings are resolved, required review is complete, scoped Git status is clean (no staged or unstaged scoped edits and no relevant non-ignored untracked files remain), and the committed push payload (`git diff <base>...HEAD`) exactly matches the reviewed final diff.
- `READY_WITH_CAVEAT`: no known blocker remains, but a limitation such as a provisional base or unavailable optional check must be stated. A provisional base caps status at `READY_WITH_CAVEAT`; it can never be `READY_TO_PUSH`.
- `BLOCKED`: base or merge-base is missing or ambiguous, the scoped diff is empty, scoped uncommitted changes or secrets/generated residue remain, a required gate fails or is unavailable, a material finding remains, or required review is unavailable.

Readiness is an assessment, not authorization for a remote action. Nothing in this skill commits or publishes changes.
