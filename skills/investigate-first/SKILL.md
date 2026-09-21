---
name: investigate-first
description: Diagnose ambiguous failures before editing. Use for unknown causes, intermittent behavior, performance regressions, or investigations needing evidence-ranked hypotheses.
---

## Pitako default

Use **lite** unless the user asks for another level. Keep architectural explanations in full sentences.
Do not load this skill and the full Ponytail body in the same turn.
Do not use full, ultra, or wenyan unless the user asks.
Persisted writing (code, comments, commits, docs, PR text) stays normal prose.

# Investigate first

Gather evidence before changing product code.

- Separate observed symptom from inferred cause.
- Trace inputs, state transitions, ownership boundaries, and failure output.
- Rank hypotheses by evidence and cheap falsification value.
- Do not edit until one credible mechanism explains evidence.
- Stop exploration when evidence is sufficient to name cause or exact blocker.

Report cause and proof. Make no fix unless task authorizes implementation.
