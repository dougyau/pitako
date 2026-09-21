---
name: tdd
description: "Use only when the user explicitly asks for TDD, a failing test, or a regression test, OR when the bug has an obvious cheap local test target. Skip when the test path is unclear, expensive, or not requested. TDD is not globally mandatory."
---

# TDD

When fixing a bug with a clear, cheap test path, make the broken behavior executable before changing production code.

Do not force TDD on every task. If the available test would require broad harness setup, brittle mocks, slow end-to-end infrastructure, or large unrelated fixture churn, skip adding a new test and use the closest useful verification instead.

## Workflow

1. **Understand the bug.** Intended behavior, current behavior, affected path, smallest observable reproduction.
2. **Choose the narrowest executable check.** Prefer a test this repo already uses for that path.
3. **Write the failing test first.** Encode intended behavior, not the current implementation.
4. **Run it before fixing.** Confirm it fails for the intended reason.
5. **Fix the bug.** Smallest production change that preserves nearby contracts.
6. **Rerun the regression test.** Confirm it now passes.
7. **Run nearby validation** when the change has broader risk.

## If a failing test is impractical

Say why, then use the closest executable check: a targeted script, a reproduction command, or a focused integration check. Prefer no new test over a bad test.

## Guardrails

- Do not change tests merely to match a wrong implementation.
- Do not weaken existing assertions unless the expected behavior changed.
- Keep the regression test focused on the bug.
- Report the failing-before evidence and the passing-after run. If failing-before could not be shown, say why.
