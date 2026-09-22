---
plan_id: fix-cursor-models
revision: 1
hash: b7fc8aef066c4044b34c3e217470c5e29c1a47131ad51dca07fa8b2d733ca727
status: completed
---

# Ledger

## Status

completed

## Completed

- T1

## Current

## Next

none

## Rulings

RULING: `agent_run` is not available in this session, so T1 was implemented inline. The child still uses a fresh `ModelRuntime`. If the policy model is missing and there is no session yet, open the session without that model so Pi can bind extension providers, then `setModel` before any prompt. A miss after bind, including same-session continue, stays unavailable and is not a side effect.

## Amendments

## Blockers

## Evidence

- `.pitako/runs/fix-cursor-models/evidence/T1/verify.md`
