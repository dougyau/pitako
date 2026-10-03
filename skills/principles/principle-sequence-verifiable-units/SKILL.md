---
name: principle-sequence-verifiable-units
description: "Apply to multi-step work (sweeps, migrations, runs of similar edits) and authorized commit or PR sequences. Choose coherent units by uncertainty, prerequisites, contract cohesion, and meaningful feedback. Verify each outcome before dependent work."
---

# Sequence work into verifiable units

Order work by material uncertainty, prerequisites, contract cohesion, and early meaningful feedback. Each meaningful unit ends in an observable outcome with proportional evidence. Smallness is not the goal.

Resolve uncertain compatibility before dependent work. Keep coupled readers and writers together when they establish one contract. Do not split a stable cohesive change when subdivision adds no independently meaningful feedback.

**Execution.** Group related edits into units with observable acceptance and affected guarantees. Use [Verify behavior](../../practical/verify-behavior/SKILL.md) to choose sufficient evidence before dependent work advances. A unit may contain several edits. Do not require a check after each edit or defer all verification to a final batch. Independent work need not wait for an unrelated check.

**Delivery.** When commits or PRs are already authorized, order them to expose useful evidence before dependent changes. A failing test before the fix can help when TDD fits. It is not the universal sequence. This principle grants no Git authority, including rebase, commit, or publication.

**Pattern:**
- Pick a meaningful unit with a checkable outcome, not a test for every edit.
- Do not split by file counts, time caps, commit counts, or worker count. Do not impose a unit quota.
- Verify before advancing using the common evidence policy. Do not defer all verification to a final batch.
- Order the units so the sequence builds confidence on its own, for you while executing and for a reviewer reading the stack.

The sequencing complement to [Verify behavior](../../practical/verify-behavior/SKILL.md), which selects evidence, and the **build-the-lever** principle skill, which makes useful automation reusable.

## Pitako

Load this principle only when its trigger applies. Do not keep it in context for unrelated work.
When the question is structural, use CodeGraph or LSP before reading large files.
