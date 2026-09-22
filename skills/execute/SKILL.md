---
name: execute
description: Explicit implementation authority for a frozen Pitako plan. Executes autonomously with scoped workers, ledger, evidence and verification, asking the user only when a decision exceeds the frozen plan envelope.
---

# $execute

`$execute <plan-id>` is implementation authority for one frozen plan. Before that invocation, you have no implementation authority.

Once invoked, continue without asking whether to proceed, fix a test, pick an equivalent local approach, retry verification, or start the next unit. Human interruption is the exception.

Do not invoke $plan. Do not synthesize a replacement plan. Do not rewrite the frozen plan to tidy history.

## Load

Read the plan with `readPlan` and `requireFrozen` from `extensions/workflow.ts`. Status must be `status: frozen`.

On first start, call `initLedger(ledgerFile(id), meta)`. It returns `exists` when a ledger is already there and does not overwrite it.

On resume, read the plan and the ledger before evidence. Parse the ledger with `parseLedgerBinding`. If `bindingMismatch` returns a string, stop and report that mismatch. Do not continue.

Then inspect the repository and only the evidence for the current unit. Reconcile plan + ledger + evidence + repository. A stale conversation is not required and is not authoritative.

Paths come from `planFile`, `ledgerFile`, and `evidenceFile`. Do not construct them by string concatenation.

## Decisions

Do not build an authority framework. Apply these three levels.

Level 1, technical and reversible: helper placement, local structure, names, ordinary errors, test layout, equivalent stdlib use. Decide, record a short `RULING` in the ledger when resume or review needs it, and continue.

Level 2, architectural but inside the accepted envelope: the planned internal shape is inadequate, and another internal design still preserves Goal, Non-goals, Scope, Invariants, user-visible intent, the safety boundary, and acceptance criteria. Consult Architect through `agent_run` only when that uncertainty is real. Record an `EXECUTION AMENDMENT` or `RULING`. Continue. The frozen plan stays immutable.

Level 3, user-owned: stop with `USER_DECISION_REQUIRED` only when evidence cannot decide for the user. That includes a Goal change, a Non-goal becoming a goal, material scope expansion, an invariant change, two materially different user-visible outcomes, a change in security or privacy risk appetite, or an unauthorized destructive or external side effect. Include the exact decision, evidence already gathered, options, consequences, and a recommendation when evidence supports one.

Never ask the user to make a Level 1 or Level 2 decision.

## Workers

When `agent_run` is available, you coordinate. You do not re-solve every unit.

Build a WorkBrief for the current unit only:

- plan id and revision
- unit id and objective
- relevant scope and invariants
- acceptance criteria and expected evidence
- relevant rulings
- relevant files or systems

Do not send the parent transcript, unrelated units, old evidence, or every Board topic.

Developer implements. Reviewer judges when the risk justifies it. Architect answers only an architecture question. Researcher fills only a real knowledge gap. If `agent_run` fails, report the error. Do not perform that role yourself.

If `agent_run` is unavailable, implement inline with the same plan, ledger, evidence, and verification rules.

Routine implementation does not require Architect or Reviewer.

Do not hardcode a provider or model. Use the role ModelPolicy.

Communication with Developer and Researcher: Caveman full. Architect and Reviewer: Caveman lite. Caveman is for that ephemeral exchange, not for ledger, evidence, docs, or the final report. Do not compress identifiers, commands, errors, or acceptance criteria.

## Loop

For each unit: load the WorkBrief, implement, verify, then checkpoint.

Developer implementation uses Ponytail full. There is no separate Ponytail agent. Ponytail may simplify how a requirement is implemented. It may not drop an acceptance criterion, invariant, trust-boundary check, security behavior, or necessary error handling. Record a `RULING` when that simplification is architectural.

Verification order: focused tests, then typecheck or lint or build when relevant, then the real surface when it is cheap. A worker saying "done" is not proof. "Compiles" is not enough when the real path is cheap.

If verification fails, reproduce, find the root cause, make the smallest correction, and verify again. First failure stays with the same Developer. Do not ask the user, call Architect, or switch to a stronger model because one check failed.

If the same underlying failure class repeats, ask Reviewer. If that evidence shows the implementation shape is wrong but the plan envelope still holds, ask Architect, record a Level 2 amendment, and continue. If no solution preserves the envelope, return `USER_DECISION_REQUIRED`. Unrelated failures do not count as the same loop.

Do not start the next unit until this unit is verifiable.

## Cleanup

Ponytail is the first defense. Run `remove-ai-slops` only when the change justifies it: multi-file work, a new abstraction, a refactor, repeated patterns, several workers, or a Reviewer note about needless complexity. Skip it for a tiny mechanical edit, not after every edit.

Scope is files changed by this run. Do not clean unrelated history. Run it only after verification is green. Then verify again. If cleanup breaks a check, revert that cleanup and verify again. Do not escalate the model because cleanup failed once.

Write `evidence/<unit>/deslop.md` or `evidence/final/deslop.md` only for a dedicated pass. Keep the ledger to a pointer.

## Review

Skip Reviewer on trivial edits when deterministic checks cover the unit. Use Reviewer for boundaries, concurrency, persistence, security, external integration, lifecycle, or a wide blast radius. Use `blast-radius` only for those triggers, not for every unit.

Before `EXECUTION_COMPLETED`, one final review against Goal, Scope, Invariants, acceptance criteria, rulings, amendments, and evidence. The reviewer gets the scoped artifacts, not the parent transcript.

## Records

`todo` is what you are doing now. Do not mirror every TODO into the ledger.

The Board is not a progress log. Post a FINDING, DECISION, BLOCKER, or HANDOFF when another agent needs it. Do not post heartbeats or test-by-test progress.

The ledger is a checkpoint: plan id, revision, hash, status, completed units, current unit, next action, rulings, amendments, blockers, and evidence paths. No test logs, diffs, or transcripts.

Evidence lives under `evidenceFile`. Proof only: command and result, runtime observation, review conclusion, changed files. A resume does not load every evidence file.

Durable prose uses normal sentences, `technical-writing` where it applies, then Unslop. Do not run that cleanup on a one-line ledger update.

## Report

Stop at `EXECUTION_COMPLETED` or `USER_DECISION_REQUIRED`.

The completion report names the plan id and revision, units completed, behavior changed, important rulings and amendments, verification commands and results, whether Ponytail and de-slop ran, review results, the evidence directory, AgentInstance ids and selected models when `AgentRunResult` has them, and any remaining issue. No transcript dump.
