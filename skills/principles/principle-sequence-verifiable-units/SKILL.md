---
name: principle-sequence-verifiable-units
description: "Apply to multi-step work (sweeps, migrations, runs of similar edits) and to how you stack commits and PRs. Break work into small units that each end in a verifiable state, check each before the next, and order delivery so the sequence proves itself to a reviewer."
---

# Sequence work into verifiable units

Order work as a sequence of small units, each ending in a state you can check, and don't advance until the current one is green.

**Why:** A break caught at the unit that caused it is cheap to localize. A break caught after a batch is buried, and you have already built further on a broken base. Sequencing those same units into a delivery a reviewer can replay turns "trust me" into "watch it go red, then green."

**Execution.** In a sweep, migration, or any run of similar edits, group related edits into meaningful units with observable outcomes. Use [Verify behavior](../../practical/verify-behavior/SKILL.md) to choose sufficient evidence before advancing. A unit may contain several edits; do not require a check after each edit. Rebase onto clean trunk first so every check measures against the real baseline.

**Delivery.** Stack commits and PRs in the order that proves the work. A failing test before the fix can help when TDD fits; it is not the universal sequence. Other story orders are a subtraction before the reshape, a baseline capture before the treatment, the scaffold before the feature. Each commit lands on its own and the sequence reads as an argument.

**Pattern:**
- Pick a meaningful unit with a checkable outcome, not a test for every edit.
- Verify before advancing using the common evidence policy. Do not defer all verification to a final batch.
- Order the units so the sequence builds confidence on its own, for you while executing and for a reviewer reading the stack.

The sequencing complement to [Verify behavior](../../practical/verify-behavior/SKILL.md), which selects evidence, and the **build-the-lever** principle skill, which makes useful automation reusable.

## Pitako

Load this principle only when its trigger applies. Do not keep it in context for unrelated work.
When the question is structural, use CodeGraph or LSP before reading large files.
