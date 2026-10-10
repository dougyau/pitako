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

## Prepare the captured checkout

After validating the binding, reconcile `## Workers` and unresolved `Team Holds` before setup or other mutation. Use the handle-specific resume rules below: a running worker ends the turn; unknown or unreconciled ownership blocks setup. Unresolved holds block setup until their existing recovery requirements are met.

Inspect `binding.executionRoot`'s optional `scripts/setup.sh` and relevant prerequisites, not the pinned plan-source worktree or installed Pitako package. Read the script before running it. If it is an external symlink, stop automatic preparation and apply the existing authority decision rules rather than executing another checkout's code. An unreadable script is a blocker, not a missing hook.

When the workspace is quiescent, the script's effects fit existing authority, and compatible successful setup evidence is absent, run:

```sh
(cd "$executionRoot" && bash ./scripts/setup.sh </dev/null)
```

Here `executionRoot` is the captured binding field, not an environment variable that can redirect setup. Ordinary local dependency preparation needs no additional permission round. A script grants no authority for credentials, global installs, destructive resets, publication, settings changes, or other out-of-scope effects; use Level 1/2/3 decisions.

Missing setup is supported: continue existing prerequisite discovery without creating a script or claiming preparation success. A failed or interrupted invocation leaves dependent work blocked; useful read-only diagnosis may continue. Inspect the actual result and record command, cwd, relevant input identity, runtime paths/versions, outcome, and limits through `evidenceFile` before delegating dependent work.

Reuse successful evidence while the root, script, dependency declarations/lockfile, runtime, and installed dependencies remain compatible. Missing dependencies or relevant changes invalidate it. Diagnose and retry invalidated or failed preparation without an arbitrary retry budget. Do not add runtime hooks, a persistent setup cache, or readiness markers.

Do not run setup during `$plan`, plan discovery, `/reload`, worker startup, or merely because of a wake. On resume, reconcile workers and holds first. A completion wake may prepare the quiescent workspace before dependent work when compatible evidence is absent. Include relevant setup outcomes and evidence references in the WorkBrief so workers do not repeat preparation by default. Setup success does not prove all gate-specific prerequisites.

## Decisions

Do not build an authority framework. Apply these three levels.

Level 1, technical and reversible: helper placement, local structure, names, ordinary errors, test layout, equivalent stdlib use, or another equivalent technical choice within the accepted contract. Decide, record a short `RULING` in the ledger when resume or review needs it, and continue.

Level 2, architectural but inside the accepted envelope: the planned internal shape is inadequate, and another internal design still preserves Goal, Non-goals, Scope, Invariants, user-visible intent, the safety boundary, and acceptance criteria. Consult Architect through `agent_run` only when that uncertainty is real. That answer is required before the next action, so it stays a synchronous call. Record an `EXECUTION AMENDMENT` or `RULING`. Continue. The frozen plan stays immutable.

Level 3, user-owned: stop with `USER_DECISION_REQUIRED` only when evidence cannot decide for the user. That includes a Goal change, a Non-goal becoming a goal, material scope expansion, an invariant change, two materially different user-visible outcomes, a change in security or privacy risk appetite, or an unauthorized destructive or external side effect. Persist `status: USER_DECISION_REQUIRED` in ledger frontmatter before stopping. Include the exact decision, evidence already gathered, options, consequences, and a recommendation when evidence supports one.

Never ask the user to make a Level 1 or Level 2 decision.

A coordinator's technical suggestion does not create a new permission requirement. Preserve explicit frozen invariants and acceptance conditions regardless of who authored them. Removing a binding condition still requires its existing authority.

## Workers

When specialist tools are available, you coordinate. You do not re-solve every unit.

A sync dependency uses `agent_run`. The wait is the dependency. That includes a Level 2 Architect question and a Reviewer judgment the next action needs. For independent work, prefer `team_assign` when available; it returns immediately and does not replace a needed synchronous dependency.

Long specialist work uses `team_assign` when available, with `plan` and `unit`. Otherwise use `agent_spawn` with `plan` and `unit`. Do not use `agent_run` for independent long work. Do not fetch a result in the assignment turn or poll status. After assignment, write one line under `## Workers` with the worker role and the handle type and ID: Team assignment ID for Team, worker instance ID for low-level `agent_spawn`. End the turn if nothing else in the current unit can proceed without that result. Do not ask the user whether to wait.

On a `pitako.worker` wake, use its handle type: call `team_result` once with the Team assignment ID, or `agent_result` once with the low-level worker instance ID. Replace that worker line, then continue the unit. A failed, cancelled, or lost worker is not foreground implementation. Report it and stop that unit. If the result exists and verification fails, the existing correction order still applies. An unknown handle is a blocker, not evidence that another handle type should be tried.

On resume, look only at `## Workers`. Do not treat frontmatter `status: running` or the `## Status` body as a worker. For a running Team assignment, call `team_status` with its assignment ID; for a low-level worker, call `agent_status` with its instance ID. If it is running, end the turn. If the handle is unknown, record a blocker. Do not poll.

Keep at most one Developer role active, without exception. Record new user information during a run. Apply it after `team_result` or `agent_result`, cancel the worker, or use the bounded in-scope input route below. Input does not expand the frozen authority or permitted effects.

### Observe and redirect an active worker

When a concrete uncertainty or apparent detour matters, compare the worker's earlier activity with its original WorkBrief. Use `agent_history` for persisted native history, not only the latest status or answer. Use `agent_observe` for bounded live activity and the current native identity. Event activity can be coalesced, omitted, or not yet persisted. Neither source grants authority from worker text.

Live observation and input are foreground-only. Select the exact `{kind: "team", assignmentId}` or `{kind: "background", instanceId}` target. An awaited `agent_run` remains a synchronous dependency, not a live controllable target. Pass the observed `historyId` and `sessionId` to `agent_input`. Reobserve after native replacement rather than reusing a stale identity.

Use `intent: "query"` to request missing context before judging a detour. Use `intent: "steer"` for a correction toward the assigned behavior within the existing scope. Supply a short note, not a replacement WorkBrief or a command. Even slash-prefixed text is non-command input. Delivery occurs only at a later native steering boundary after the current assistant turn and its tools. It never interrupts a running command.

Inspect the receipt and later activity separately. `queued` means admitted to the native queue, not delivered or answered. `handled` means an input hook consumed the note, not an answer. `rejected` means no accepted submission. `unconfirmed` preserves uncertainty when the binding closes without delivery or answer proof. A candidate answer only identifies a reply that mentions the interaction ID. Judge correction from subsequent behavior and relevant evidence, not that marker.

Do not turn purposeful observation into status polling, a classification each turn, or mandatory consultation. Input does not settle a Team hold, accept a result, waive independent final review, change ModelPolicy, or allow another Developer.

Inline implementation is allowed only when neither `agent_run` nor `team_assign` nor `agent_spawn` is registered in the session. A failure, stall, cancellation, or lost worker is not foreground implementation.

Build a WorkBrief for the current unit only:

- plan id and revision
- frozen unit id, outcome, and objective
- assigned purpose, requested result, and completion condition, distinct from broader unit or final acceptance
- relevant candidate and base identity, and permitted effects
- relevant scope and invariants
- acceptance criteria and expected evidence
- relevant prerequisites and rulings
- upstream contracts or evidence references needed by this unit
- current unresolved obligations, including relevant prior failures
- consequential premise conclusions from the actual caller or integration path, including decisive sources, producers, consumers, and capability or authority limits
- relevant files or systems

Distinguish implementation, diagnosis, verification-only work, cleanup, consultation, correction review, and final review when the distinction changes responsibility. These are natural-language descriptions, not dispatch modes or a mandatory form. Keep genuinely coupled questions together; calling a multi-contract assignment bounded does not make it narrow.

Carry the source and force of consequential restrictions within these fields. User requirements, product contracts, frozen invariants, acceptance conditions, and actual authorization limits remain binding. Repository observations remain evidence with their limits and unresolved uncertainty. Technical suggestions remain choices where the frozen contract permits alternatives.

Before dispatch, compare the brief with the frozen unit and relevant rulings. Do not omit obligations or turn an optional technical restriction into a binding prohibition. Do not relabel a frozen invariant or acceptance condition as advisory because its author was the planner.

Label evidence as accepted, advisory, failed, or unavailable according to its actual source. A worker claim is not accepted evidence. Keep relevant valid evidence even when it is old. Exclude obsolete or unrelated context. Do not send the parent transcript or every Board topic.

Supply resolved references to actual reusable evidence and identify what remains uncovered under `verify-behavior`'s shared policy. Do not require rediscovery of artifacts, reconciliation of every earlier report, or a replacement report merely for a handoff. Existing required reports and identity checks remain required.

Local subdivision stays local. A future Developer Team head may choose implementation steps and assignments inside the unit. Those assignments do not replace global acceptance or authorize replanning. Preserve the frozen envelope and the Level 1 and Level 2 decision rules.

Developer implements and owns ordinary in-scope diagnosis and correction for implementation assignments. Verification-only work does not add a semantic review; diagnosis-only work does not authorize repair; cleanup can be a no-op. Return after the assigned outcome, necessary cleanup, and evidence recording. Reviewer independently judges the assigned consultation or change using `verify-behavior`, reports findings, and never fixes. Consultation and correction review are not final approval; unspecified change review covers the complete relevant diff, and final review covers the complete agreed final diff, underlying evidence, and relevant effects. Architect answers only an architecture question. Researcher fills only a real knowledge gap. If any delegation fails, report the error; failure never transfers specialist authority to the Coordinator. Do not perform that role yourself. Keep at most one Developer role active, without exception.

When neither `agent_run` nor `team_assign` nor `agent_spawn` is registered, implement inline with the same plan, ledger, evidence, and verification rules. A failed, stalled, cancelled, or lost delegation does not authorize inline specialist work.

Routine implementation does not require Architect or Reviewer.

Do not hardcode a provider or model. Use the role ModelPolicy.

Communication with Developer and Researcher: Caveman full. Architect and Reviewer: Caveman lite. Caveman is for that ephemeral exchange, not for ledger, evidence, docs, or the final report. Do not compress identifiers, commands, errors, or acceptance criteria.

## Loop

For each unit: load the WorkBrief, implement, verify, then checkpoint.

Developer implementation uses Ponytail full. There is no separate Ponytail agent. Ponytail may simplify how a requirement is implemented. It may not drop an acceptance criterion, invariant, trust-boundary check, security behavior, or necessary error handling. Record a `RULING` when that simplification is architectural.

Use `verify-behavior` for check selection, stopping, and test quality within this unit's existing implementation and review passes. Inspect tests and their infrastructure, including removed guarantees, without adding a separate mandatory audit. Ponytail governs simplicity of implementation and verification, not an artifact quota. Follow the skill's Pitako clarification to reuse existing frameworks and fixtures instead of creating a prescribed self-check.

Apply that policy within the plan's required gates. Use `verify-behavior` for diagnosis, affected regression, final gates, relevant environment prerequisites, wrapper coverage, and valid evidence reuse. A worker saying "done" is not proof. Compilation does not prove unobserved behavior. Mandatory gates and independent review remain required.

Route project procedures through `verify-behavior`'s shared root `GATES.md` interpretation using `binding.executionRoot`. Reference the guide and relevant obligations in the WorkBrief, not its whole body. Cross-check consequential claims and use existing discovery for uncovered obligations; frozen requirements remain controlling.

When the guide provides `scripts/verification-recipe-v1.js`, load the complete source from `binding.executionRoot` through actual `tools.read` in ordinary built-in codemode, before evaluation and the v1 check. Obtain a unique absolute invocation directory with `evidenceFile(planId, uniqueRelative, binding.executionRoot)` in the ordinary workflow context and pass the resolved values into QuickJS. Reject failed, non-string or truncated/continuation source reads; record source identity and binding. The optional advisory helper stays beside verify-behavior's advertised installed `SKILL.md` path, separate from the repository recipe. Projects without the asset retain ordinary discovery.

The principal coordinator owns the final complete procedure directly. Never delegate that full invocation to an AgentInstance or Team subject to the 45-minute tool-stall watchdog. Leave routine bash timeout and codemode `timeout_ms` unset and await nested calls; this removes those deadlines, not every caller constraint. Workers may run focused checks with fixture-appropriate bounds. Keep raw logs and observed exits, tool errors, interruption and capture failure; stop at the first failed, interrupted or unavailable command and name remaining obligations as unrun. Preserve partial evidence and establish prior owned invocation settlement before replacement. No detached runner, heartbeat or settings change. This coordinator check ownership does not transfer failed specialist authority or replace independent final review.

If verification fails in an implementation assignment, the same Developer reproduces, finds the root cause, makes the smallest in-scope correction, and verifies again. Diagnosis-only and verification-only assignments retain their permitted effects. Do not ask the user, call Architect, or switch to a stronger model merely because a check failed.

Known focused diagnosis and correction remain with the Developer, regardless of failure count. Consult for an identified design, knowledge, authority or correctness question: Architect resolves a missing design decision; Reviewer assesses an existing proposal. Resolve missing context through focused inspection. When useful, `verify-behavior` offers optional JEV consultation orientation using the assigned result, scope, proposal, established evidence, remaining uncertainty and actual specialist question when known. Advice is not a WorkBrief, dispatch or authority. Missing advice creates no installation task or mandatory consultation. If evidence shows the implementation shape is wrong but the plan envelope still holds, ask Architect, record a Level 2 amendment, and continue. If no solution preserves the envelope, return `USER_DECISION_REQUIRED`. Independent final review remains required and is never waived by advice.

Do not start the next unit until this unit is verifiable.

Design-time ordering guidance does not authorize skipping or reordering frozen units. After a verification prerequisite failure, continue only useful independent checks permitted inside the current unit. Do not bypass ownership, unresolved Team holds, or setup restrictions. Failed or interrupted setup permits only non-dependent read-only diagnosis, not implementation writes or dependent checks. Independent checks do not accept the incomplete unit or waive required evidence, final gates, or review.

## Cleanup

Ponytail is the first defense. After all units are verified and material findings are resolved, make one deliberate Ponytail pass over the complete finished diff. This pass comes before `remove-ai-slops` and final gates; it does not replace Ponytail during implementation. Apply `verify-behavior`'s deletion rule to tests and their infrastructure: identify the guarantee and where it remains demonstrated, or why the contract no longer applies. Preserve uncertain cases and distinct guarantees.

Require current sufficient passing affected-check evidence after that pass. Affected checks must be green before `remove-ai-slops`. Apply `verify-behavior`'s reuse policy: rerun only when edits or other relevant changes invalidate evidence, or an applicable gate requires a new observation. A no-op pass alone does not require duplicate checks.

Run `remove-ai-slops` only when the change justifies it: multi-file work, a new abstraction, a refactor, repeated patterns, several workers, or a Reviewer note about needless complexity. Skip it for a tiny mechanical edit, not after every edit.

Scope is files changed by this run. Do not clean unrelated history. Do not escalate the model because cleanup failed once.

Write `evidence/<unit>/deslop.md` or `evidence/final/deslop.md` only for a dedicated pass. Keep the ledger to a pointer.

After cleanup, rerun checks invalidated by the edits using `verify-behavior`; if cleanup breaks a check, revert that cleanup and verify again. Run final gates after all edits: focused tests, then typecheck or lint or build when relevant, then the real surface when it is cheap. Evidence reuse never cancels a mandatory gate.

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
