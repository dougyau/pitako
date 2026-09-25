---
name: execute
description: Explicit implementation authority for a frozen Pitako plan. Executes autonomously with scoped workers, ledger, evidence and verification, asking the user only when a decision exceeds the frozen plan envelope.
---

# $execute

`$execute <plan-id>` is implementation authority for one frozen plan. Before that invocation, you have no implementation authority.

Once invoked, continue without asking whether to proceed, fix a test, pick an equivalent local approach, retry verification, or start the next unit. Human interruption is the exception.

Do not invoke $plan. Do not synthesize a replacement plan. Do not rewrite the frozen plan to tidy history.

## Load

Open the workflow with `openExecutionPlan(id, cwd)` from `extensions/workflow.ts`. It requires `status: frozen`. It reads an existing execution-root ledger first, then validates its pinned frozen source; a cold start resolves with `readFrozenPlan`, captures the physical source and execution roots, and creates the ledger under a Git common-directory lock. Do not call fresh local-shadow discovery before checking an existing pin.

`openExecutionPlan` preserves existing ledgers and evidence. It parses with `parseLedgerBinding` and `bindingMismatch`; it adopts a legacy ledger only in its own execution worktree after matching plan id, revision, and hash. It rejects cwd drift, source changes, and competing worktree ledgers. Keep using `ledgerFile`, `evidenceFile`, and the captured execution root for all artifacts and workers.

On resume, read the plan and the ledger before evidence; `openExecutionPlan` reads the ledger first, then its pinned plan. If the ledger binding or pinned source does not match, stop and report the exact mismatch. Do not continue. `USER_DECISION_REQUIRED` must be written to ledger frontmatter `status` before stopping; never resolve the plan's Board topic in that state. Reload and resume never change Board status.

A bound topic remains open for `execution: expected` at `PLAN_FROZEN`; never resolve it at freeze or reopen it during execute. Once all gates, review, and knowledge absorption are complete, set ledger `status: completed`, then resolve only via `board_workflow_lifecycle`. The lifecycle tool rejects ledger mismatch, `USER_DECISION_REQUIRED`, missing execution intent, and Team work that is pending, failed, or cancelled. Bound-plan Team dispatches are held by exact assignment and unit in the `Team Holds` gate in `.pitako/runs/<plan-id>/ledger.md`; no-topic assignments create no persistence artifact. A successful `team_result` removes only its own hold. Failed, cancelled, and no-outcome holds remain blocking across reload, and a missing/malformed gate fails closed. Explicit recovery requires confirming the worker is quiescent, reconciling repository state, recording concrete recovery evidence in the ledger, then removing only that assignment's hold; never clear a pending no-outcome hold without recovered outcome and evidence. Explicit abandonment of the whole workflow closes its bound topic; worker failure/cancellation or an unresolved user decision alone does not. For `execution: none`, `$plan` resolves after absorption at freeze; execute is not invoked.

Then inspect the repository and only the evidence for the current unit. Reconcile plan + ledger + evidence + repository. A stale conversation is not required and is not authoritative.

Paths come from `planFile`, `ledgerFile`, and `evidenceFile`. Do not construct them by string concatenation.

## Decisions

Do not build an authority framework. Apply these three levels.

Level 1, technical and reversible: helper placement, local structure, names, ordinary errors, test layout, equivalent stdlib use. Decide, record a short `RULING` in the ledger when resume or review needs it, and continue.

Level 2, architectural but inside the accepted envelope: the planned internal shape is inadequate, and another internal design still preserves Goal, Non-goals, Scope, Invariants, user-visible intent, the safety boundary, and acceptance criteria. Consult Architect through `agent_run` only when that uncertainty is real. That answer is required before the next action, so it stays a synchronous call. Record an `EXECUTION AMENDMENT` or `RULING`. Continue. The frozen plan stays immutable.

Level 3, user-owned: stop with `USER_DECISION_REQUIRED` only when evidence cannot decide for the user. That includes a Goal change, a Non-goal becoming a goal, material scope expansion, an invariant change, two materially different user-visible outcomes, a change in security or privacy risk appetite, or an unauthorized destructive or external side effect. Persist `status: USER_DECISION_REQUIRED` in ledger frontmatter before stopping. Include the exact decision, evidence already gathered, options, consequences, and a recommendation when evidence supports one.

Never ask the user to make a Level 1 or Level 2 decision.

## Workers

When specialist tools are available, you coordinate. You do not re-solve every unit.

A sync dependency uses `agent_run`. The wait is the dependency. That includes a Level 2 Architect question and a Reviewer judgment the next action needs. For independent work, prefer `team_assign` when available; it returns immediately and does not replace a needed synchronous dependency.

Long specialist work uses `team_assign` when available, with `plan` and `unit`. Otherwise use `agent_spawn` with `plan` and `unit`. Do not use `agent_run` for independent long work. Do not fetch a result in the assignment turn or poll status. After assignment, write one line under `## Workers` with the worker role and the handle type and ID: Team assignment ID for Team, worker instance ID for low-level `agent_spawn`. End the turn if nothing else in the current unit can proceed without that result. Do not ask the user whether to wait.

On a `pitako.worker` wake, use its handle type: call `team_result` once with the Team assignment ID, or `agent_result` once with the low-level worker instance ID. Replace that worker line, then continue the unit. A failed, cancelled, or lost worker is not foreground implementation. Report it and stop that unit. If the result exists and verification fails, the existing correction order still applies. An unknown handle is a blocker, not evidence that another handle type should be tried.

On resume, look only at `## Workers`. Do not treat frontmatter `status: running` or the `## Status` body as a worker. For a running Team assignment, call `team_status` with its assignment ID; for a low-level worker, call `agent_status` with its instance ID. If it is running, end the turn. If the handle is unknown, record a blocker. Do not poll.

Keep at most one Developer role active, without exception. New user information during a run is recorded and applied after `team_result` or `agent_result`, or the worker is cancelled. There is no steer into a running worker.

Inline implementation is allowed only when neither `agent_run` nor `team_assign` nor `agent_spawn` is registered in the session. A failure, stall, cancellation, or lost worker is not foreground implementation.

Build a WorkBrief for the current unit only:

- plan id and revision
- unit id and objective
- relevant scope and invariants
- acceptance criteria and expected evidence
- relevant rulings
- relevant files or systems

Do not send the parent transcript, unrelated units, old evidence, or every Board topic.

Developer implements. Reviewer is adversarial by definition: challenge passing tests and probe violated invariants, negative paths, lifecycle, concurrency, identity/path assumptions, stale state, mocks, coverage, and frozen criteria. Reviewer reports findings and never fixes. Architect answers only an architecture question. Researcher fills only a real knowledge gap. If any delegation fails, report the error; failure never transfers specialist authority to the Coordinator. Do not perform that role yourself. Keep at most one Developer role active, without exception.

When neither `agent_run` nor `team_assign` nor `agent_spawn` is registered, implement inline with the same plan, ledger, evidence, and verification rules. A failed, stalled, cancelled, or lost delegation does not authorize inline specialist work.

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

Ponytail is the first defense. After all units are verified and material findings are resolved, make one deliberate Ponytail pass over the complete finished diff. This pass comes before `remove-ai-slops` and final gates; it does not replace Ponytail during implementation.

Run affected focused checks after that pass. They must be green before `remove-ai-slops`.

Run `remove-ai-slops` only when the change justifies it: multi-file work, a new abstraction, a refactor, repeated patterns, several workers, or a Reviewer note about needless complexity. Skip it for a tiny mechanical edit, not after every edit.

Scope is files changed by this run. Do not clean unrelated history. Do not escalate the model because cleanup failed once.

Write `evidence/<unit>/deslop.md` or `evidence/final/deslop.md` only for a dedicated pass. Keep the ledger to a pointer.

After cleanup, rerun the same checks; if cleanup breaks a check, revert that cleanup and verify again. Run final gates after all edits: focused tests, then typecheck or lint or build when relevant, then the real surface when it is cheap.

## Review

Skip Reviewer on trivial edits when deterministic checks cover the unit. Use Reviewer for boundaries, concurrency, persistence, security, external integration, lifecycle, or a wide blast radius. Use `blast-radius` only for those triggers, not for every unit.

Classify cleanup and later edits against the complete final diff and evidence:
- **A:** demonstrably nonsemantic subtraction. Identify what was removed and why, with checks or other evidence supporting unchanged behavior and contracts. Deletion alone does not prove A.
- **B:** potentially semantic or uncertain, including changes to logic, state, lifecycle, concurrency, paths, security, privileges, output, or contracts. Treat uncertainty as B.

Before `EXECUTION_COMPLETED`, the single final review must inspect the complete final diff after cleanup and final gates, against Goal, Scope, Invariants, acceptance criteria, rulings, amendments, and evidence. The reviewer gets the scoped artifacts, not the parent transcript. B or uncertain changes need an independent Reviewer on the complete final diff. Any B or uncertain edit after approval invalidates that approval: rerun affected checks and applicable final gates, then obtain an independent Reviewer assessment of the complete updated final diff. Repeat after any further B or uncertain edits. An evidenced A-only cleanup does not require a second review solely for cleanup when adequate independent review already covers it. This exception does not waive `$execute`'s required final review or any review required by risk.

## Records

`todo` is what you are doing now. Do not mirror every TODO into the ledger.

The Board is not a progress log. Use FINDING for a fact or constraint; DECISION for a chosen boundary before its authoritative artifact; QUESTION/ANSWER for cross-context coordination; BLOCKER only when another context cannot correctly continue; HANDOFF only for essential next-context knowledge; INFO sparingly for mission context. Do not post progress, status, test counts, heartbeats, or ordinary worker events (for example, `HANDOFF: T3 done, 44 tests pass`): ledger and evidence own progress. Once absorbed, the plan, code, tests, or docs are authoritative. No execution-local blocker post is needed when the ledger suffices.

The ledger is a checkpoint: plan id, revision, hash, status, completed units, current unit, next action, rulings, amendments, blockers, and evidence paths. No test logs, diffs, or transcripts.

Evidence lives under `evidenceFile`. Proof only: command and result, runtime observation, review conclusion, changed files. A resume does not load every evidence file.

Durable prose uses normal sentences, `technical-writing` where it applies, then Unslop. Do not run that cleanup on a one-line ledger update.

## Report

Stop at `EXECUTION_COMPLETED` or `USER_DECISION_REQUIRED`.

The completion report names the plan id and revision, units completed, behavior changed, important rulings and amendments, verification commands and results, whether Ponytail and de-slop ran, review results, the evidence directory, AgentInstance ids and selected models when `AgentRunResult` has them, and any remaining issue. No transcript dump.
