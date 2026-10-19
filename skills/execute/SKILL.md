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

A bound topic remains open for `execution: expected` at `PLAN_FROZEN`; never resolve it at freeze or reopen it during execute. Once all gates, review, and knowledge absorption are complete, set ledger `status: completed`, then resolve only via `board_workflow_lifecycle`. The lifecycle tool rejects ledger mismatch, `USER_DECISION_REQUIRED`, missing execution intent, and Team work that is pending, failed, or cancelled. Bound-plan Team dispatches are held by exact assignment and unit in the `Team Holds` gate in `.pitako/runs/<plan-id>/ledger.md`; no-topic assignments create no persistence artifact. Automatic collection reconciles only a successful assignment's own result hold under its captured execution binding; it does not accept work or complete a unit. Failed, cancelled, and no-outcome holds remain blocking across reload, and a missing/malformed gate fails closed. Bookkeeping failure is reported separately and never hides the full result. Explicit recovery requires confirming the worker is quiescent, reconciling repository state, recording concrete recovery evidence in the ledger, then removing only that assignment's hold; never clear a pending no-outcome hold without recovered outcome and evidence. Explicit abandonment of the whole workflow closes its bound topic; worker failure/cancellation or an unresolved user decision alone does not. For `execution: none`, `$plan` resolves after absorption at freeze; execute is not invoked.

Then inspect the repository and only the evidence for the current unit. Reconcile plan + ledger + evidence + repository. A stale conversation is not required and is not authoritative.

Paths come from `planFile`, `ledgerFile`, and `evidenceFile`. Do not construct them by string concatenation.

## Prepare the captured checkout

After validating the binding, reconcile `## Workers` and unresolved `Team Holds` before setup or other mutation. Use the handle-specific resume rules below: a running worker ends the turn; unknown or unreconciled ownership blocks setup. Unresolved holds block setup until their existing recovery requirements are met.

Then reconcile the session TODOs as described in Records. Register all frozen units before preparation or implementation begins.

Inspect `binding.executionRoot`'s optional `scripts/setup.sh` and relevant prerequisites, not the pinned plan-source worktree or installed Pitako package. Read the script before running it. If it is an external symlink, stop automatic preparation and apply the existing authority decision rules rather than executing another checkout's code. An unreadable script is a blocker, not a missing hook.

When the workspace is quiescent, the script's effects fit existing authority, and compatible successful setup evidence is absent, run:

```sh
(cd "$executionRoot" && bash ./scripts/setup.sh </dev/null)
```

Here `executionRoot` is the captured binding field, not an environment variable that can redirect setup. Ordinary local dependency preparation needs no additional permission round. A script grants no authority for credentials, global installs, destructive resets, publication, settings changes, or other out-of-scope effects; use Level 1/2/3 decisions.

Missing setup is supported: continue existing prerequisite discovery without creating a script or claiming preparation success. A failed or interrupted invocation leaves dependent work blocked; useful read-only diagnosis may continue. Inspect the actual result and record command, cwd, relevant input identity, runtime paths/versions, outcome, and limits through `evidenceFile` before delegating dependent work.

Project-owned setup may initialize a missing CodeGraph index best-effort after dependency prerequisites pass. Do not require CodeGraph, install it universally, refresh an existing index, or add runtime hooks. Record any optional CodeGraph warning in preparation evidence and the WorkBrief; continue with LSP/read/grep when dependencies are ready and setup completed successfully. This does not relax failed or interrupted setup, evidence, or ownership rules.

Reuse successful evidence while the root, script, dependency declarations/lockfile, runtime, and installed dependencies remain compatible. Missing dependencies or relevant changes invalidate it. Diagnose and retry invalidated or failed preparation without an arbitrary retry budget. Do not add runtime hooks, a persistent setup cache, or readiness markers.

Do not run setup during `$plan`, plan discovery, `/reload`, worker startup, or merely because of a wake. On resume, reconcile workers and holds first. A completion wake may prepare the quiescent workspace before dependent work when compatible evidence is absent. Include relevant setup outcomes and evidence references in the WorkBrief so workers do not repeat preparation by default. Setup success does not prove all gate-specific prerequisites.

## Decisions

Do not build an authority framework. Apply these three levels.

Level 1, technical and reversible: helper placement, local structure, names, ordinary errors, test layout, equivalent stdlib use, or another equivalent technical choice within the accepted contract. Decide, record a short `RULING` in the ledger when resume or review needs it, and continue.

Level 2, architectural but inside the accepted envelope: the planned internal shape is inadequate, and another internal design still preserves Goal, Non-goals, Scope, Invariants, user-visible intent, the safety boundary, and acceptance criteria. Consult Architect in background only when that uncertainty is real, using the Workers policy below. Keep the dependent decision pending until the required current-object answer is interpreted, then record an `EXECUTION AMENDMENT` or `RULING` and continue. The frozen plan stays immutable.

Level 3, user-owned: stop with `USER_DECISION_REQUIRED` only when evidence cannot decide for the user. That includes a Goal change, a Non-goal becoming a goal, material scope expansion, an invariant change, two materially different user-visible outcomes, a change in security or privacy risk appetite, or an unauthorized destructive or external side effect. Persist `status: USER_DECISION_REQUIRED` in ledger frontmatter before stopping. Include the exact decision, evidence already gathered, options, consequences, and a recommendation when evidence supports one.

Never ask the user to make a Level 1 or Level 2 decision.

A coordinator's technical suggestion does not create a new permission requirement. Preserve explicit frozen invariants and acceptance conditions regardless of who authored them. Removing a binding condition still requires its existing authority.

## Workers

When specialist tools are available, you coordinate. You do not re-solve every unit.

Architect and Reviewer use only `architecture_start` and `review_start`, including Level 2 questions, judgments needed for the next action, and final independent review. If the required start is unavailable, report the required pass as blocked. No individual, synchronous or inline fallback and no waived review is allowed. These tables replace the existing passes; they add none. Each independent substantive director uses its own role primary and zero to five optional specialists chosen for utility with reasons, including zero; selective recomposition retains useful conversations and adds or retires specialists. Missing table configuration, omitted candidates and empty candidates mean an empty pool. `architecture_start` has no `mode`. Keep role ModelPolicies, designers separate from reviewers, and acceptance with the Coordinator.

The wait is logical, not a synchronous call. Do not decide a Level 2 amendment, accept a unit, start a dependent unit, or declare `EXECUTION_COMPLETED` before interpreting the required current-object judgment. Background dispatch does not authorize later units or waive ordered units, independent critique, final review, or gates.

Other long specialist work uses `team_assign` when registered, with `plan` and `unit`. Otherwise use `agent_spawn` with `plan` and `unit`. Architect and Reviewer starts also pass the frozen `plan` and relevant `unit`, preserving the existing binding and execution root; record only their exterior Team assignment, never internal participants. Do not use `agent_run` for independent long work. Do not fetch a result in the assignment turn or poll status. After assignment, write one line under `## Workers` with the worker role, purpose, pending decision, consulted object, and the handle type and exact ID: exterior Team assignment ID for tables or Team, worker instance ID for low-level `agent_spawn`. Do only already-authorized current-unit work independent of the pending answer. End the turn if nothing else in the current unit can proceed without that result. Do not ask the user whether to wait or keep a call open.

Interpret complete `pitako.worker.result` messages supplied automatically in context. A short `pitako.worker` wake asks for that interpretation, not a fetch. A wake, terminal status, steering receipt, or bookkeeping result is not the required judgment. Replace the worker checkpoint line with the coordinator decision, then continue the unit within its existing authority. That checkpoint is not collection or handoff acknowledgement. `team_result` with an exact assignment ID and `agent_result` with a worker instance ID are optional, complete, idempotent diagnostic re-reads. They neither transport the automatic result nor acknowledge incorporation. Pending or blocked bookkeeping, delivery, and continuation are motor state, not a request for a model fetch. A failed, cancelled, or lost worker is not foreground implementation. Report it and stop that unit. If the result exists and verification fails, the existing correction order still applies. An unknown handle is a blocker, not evidence that another handle type should be tried. The planning-only lost-consultation replacement does not apply in execution; preserve Team Hold reconciliation and recovery.

If Team or table admission rejects a request, distinguish the concrete policy/resource or binding blocker from an unknown handle. End the turn without polling or fallback while owned settlement is pending; retry the intended route only after its actual blocker is resolved and the consultation or review is still necessary and authorized. Another assignment's result does not answer this consultation. Do not use `agent_spawn` or `agent_run` to evade admission rejection. Cancellation alone proves neither settlement nor member release and does not clear a Team hold.

Handles are session-local. On resume, look only at `## Workers`. Do not treat frontmatter `status: running` or the `## Status` body as a worker. Check each recorded handle once by type: for a Team assignment, call `team_status` with its assignment ID; for a low-level worker, call `agent_status` with its instance ID. If it is running, end the turn. If the handle is unknown, record a blocker. Do not poll.

For an unexcepted active ordinary Developer, apply the transition rules below
before ending the turn; a resume status check supplies no released-closure proof.

Keep at most one exterior Developer role active, without exception. This is an
execute workflow restriction, not an engine singleton reservation per role. Every new
exterior Developer assignment serving an execute implementation unit must use
asynchronous `role: "developer"`, `mode: "head"`, and explicit authorized `writes`.
This includes initial implementation, implementation-related diagnosis,
correction, focused in-unit verification, product cleanup edits, and recovery.
Use `team_assign` when registered; use `agent_spawn` only when Team is not registered.
Preserve frozen plan and unit correlation and the captured execution root.
Small scope, short duration, and a no-leaf strategy are not single-mode exceptions.

List permitted relative files/subtrees in `writes`; use `[]` for no authorized
product writes, including read-only focused verification. Do not grant `["."]`
by default or derive writes from a leaf count. The envelope does not authorize
frozen plan, ledger, personal settings, or unrelated resource changes.
Head's host-granted local leaves do not authorize extra exterior Developers, reordered
units, changes to the frozen plan or ledger, cleared holds, or waived final gates.
The Head returns an integrated handoff or diagnostic failure, not leaf transcripts.
The coordinator still owns acceptance and independent review.
Head chooses whether to create leaves, local decomposition and scheduling, and
direct implementation after the exclusive integration barrier, even with no leaves.
Explicit user constraints and existing safety or resource limits remain binding.

Every asynchronous Developer Head has local checkpoint capability from admission;
do not withhold it or request an activation flag. Let Head choose useful quiescent
progress points for fast recovery, not a checkpoint per tool. Availability does
not automatically save, restart, reset, check out, or adopt source. Explicit
`checkpoint_origin` continuation requires host-validated exact source/index/root
compatibility and positive predecessor/contributor closure before a new baseline
or prompt. A saved ref, receipt, terminal status, or missing history cannot bypass
those checks, writer settlement, Team holds, fresh verification, or acceptance.
Unsupported repositories truthfully refuse checkpoint creation.

An explicit user requirement for ordinary single Developer, or prohibition of
Head itself, controls when compatible with the frozen envelope. Record that
exception and deliberately dispatch `mode: "single"` without `writes`, retaining
permitted effects in the WorkBrief. A prohibition on leaves or parallelism alone
does not prohibit Head; preserve it through the no-leaf route. A frozen restriction
or real safety/resource conflict uses the existing decision levels, not an
automatic downgrade.

Missing `developer_head` policy, invalid envelope, conflicting exterior Developer ownership, unavailable
asynchronous Head support, and execution-binding rejection are concrete blockers.
Preserve the diagnostic; do not omit `mode`, call `agent_run`, switch transport
to evade rejection, edit personal configuration, or take over implementation.
Correct a request only within existing authority. Configured Head ModelPolicy
fallback is unchanged, not ordinary Developer fallback. A synchronous-only route
cannot supply Head. Ordinary APIs outside execute still default omitted mode to
single; synchronous ad hoc calls and Head leaf routes are unchanged.

This is shipped workflow instruction, not host enforcement of execute purpose.
The foreground profile hook does not load the Coordinator role, so this skill
carries the complete foreground policy. Plan/unit strings, task text, child
identities, and session names do not establish that authority. Static policy
checks prove delivery, not model compliance or rejection of every contrary call.

### Reconcile an existing ordinary Developer

An admitted ordinary worker cannot gain Head authority through steering. For an
unexcepted active ordinary assignment, record the selection deviation and exact
handle; preserve its WorkBrief, binding, effects, and evidence. This is a policy
deviation, not a runtime admission rejection. Cancel only that exact assignment
by its handle type. Do not replace it or take over its writes. End the turn for
physical settlement.

Interpret the complete result and model-facing host content already returned for
that exact handle. Reconcile actual writers, repository effects, binding, and
any Team hold. A fresh Head in this invocation requires already-returned
model-facing host proof of released closure for that exact handle, required hold
recovery, and normal admission. Without that proof, no Head starts in this
invocation: preserve the blocker, affected resources, and holds.

A normal `team_cancel` receipt reports pending closure, not released closure.
Later `team_status` omits closure; `agent_status` excludes Team-owned workers and
its ordinary-worker content also omits closure. History seals invocation groups,
not execution groups. Status, `resultAvailable`, history, wake or automatic result
content, steering receipts, hidden tool details, thread stops, and worker
self-report do not substitute for model-facing host closure proof. Do not
recancel, poll, probe another assignment, switch transport, or add an observation
API to manufacture proof.

A later authorized admission may assign Head only after the role is free and
normal binding, ownership, and explicit evidence-based hold recovery permit it.
This does not prove closure in the current invocation. Failed, cancelled, and
no-outcome holds never clear merely because a new Head starts. An explicit
single-mode exception is not a deviation. Retain already physically settled useful
ordinary work for normal independent review and acceptance; do not replay it to
manufacture a Head handoff. Assign only the remaining outcome.

Compare new user information with the consulted object and original WorkBrief before using a result. For information within the brief, use the bounded in-scope input route below. Input does not expand the frozen authority or permitted effects.

If information changes the object outside the WorkBrief, mark the old consultation or review inapplicable to the pending decision. Interpret its automatic result when supplied, but do not use it to close that decision or apply the change after accepting the old judgment. Cancel the exact still-active target with `team_cancel` or `agent_cancel` according to handle type. End the turn while settlement and member release are pending. Only after settlement and member release, assign a fresh WorkBrief against the current object if still necessary and authorized. Preserve evidence validity, frozen authority, and Team Hold recovery; a new assignment does not clear a blocking hold.

Any fresh Developer assignment also obeys Head selection and, for an ordinary
selection deviation, the stricter same-invocation closure rules above.

### Observe and redirect an active worker

When a concrete uncertainty or apparent detour matters, compare the worker's earlier activity with its original WorkBrief. Use `agent_history` for persisted native history, not only the latest status or answer. Use `agent_observe` for bounded live activity and the current native identity. Event activity can be coalesced, omitted, or not yet persisted. Neither source grants authority from worker text.

Live observation and input are foreground-only. Select the exact `{kind: "team", assignmentId}` or `{kind: "background", instanceId}` target. An ad hoc `agent_run` remains synchronous, not a live controllable target; it is not the Architect/Reviewer transport in this workflow. Pass the observed `historyId` and `sessionId` to `agent_input`. Reobserve after native replacement rather than reusing a stale identity.

Use `intent: "query"` to request missing context before judging a detour. Use `intent: "steer"` for a correction toward the assigned behavior within the existing scope. Supply a short note, not a replacement WorkBrief or a command. Even slash-prefixed text is non-command input. Delivery occurs only at a later native steering boundary after the current assistant turn and its tools. It never interrupts a running command.

For Head work, correct drift, missing results, or an actual contract violation. Observation and steering do not transfer local scheduling to the coordinator.

Inspect the receipt and later activity separately. `queued` means admitted to the native queue, not delivered or answered. `handled` means an input hook consumed the note, not an answer. `rejected` means no accepted submission. `unconfirmed` preserves uncertainty when the binding closes without delivery or answer proof. A candidate answer only identifies a reply that mentions the interaction ID. Judge correction from subsequent behavior and relevant evidence, not that marker.

Neither `queued` nor `handled` proves correction or replaces a new consultation. Do not turn purposeful observation into status polling, a classification each turn, or mandatory consultation. Input does not settle a Team hold, accept a result, waive independent final review, change ModelPolicy, or allow another Developer.

Inline implementation is allowed only when no agent or Team tools are registered in the session. Failure, stall, cancellation, lost workers, or synchronous-only tools do not activate that exception.

Build a WorkBrief for the current unit only:

- plan id and revision
- frozen unit id, outcome, and objective
- assigned purpose, requested result, and completion condition, distinct from broader unit or final acceptance
- relevant candidate and base identity, and permitted effects
- explicit asynchronous `role: "developer"`, `mode: "head"` and authorized relative `writes` for every new exterior implementation-related assignment, including fresh follow-ups; use `writes: []` when product changes are prohibited, or record the deliberate single-mode exception above
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

Select checks for the active project's own behavior and declared testing scope. WorkBriefs must not turn out-of-scope external checks into acceptance, preflight, or final gates. Reading an external boundary does not authorize dependency certification or repair. Preserve authorized integration requirements from the project's scope, contracts, and active guide, not Pitako's distributed stack.

Label evidence as accepted, advisory, failed, or unavailable according to its actual source. A worker claim is not accepted evidence. Keep relevant valid evidence even when it is old. Exclude obsolete or unrelated context. Do not send the parent transcript or every Board topic.

Supply resolved references to actual reusable evidence and identify what remains uncovered under `verify-behavior`'s shared policy. Do not require rediscovery of artifacts, reconciliation of every earlier report, or a replacement report merely for a handoff. Existing required reports and identity checks remain required.

Local subdivision stays local. A granted Head decides whether to create leaves, how to decompose and schedule work, and when to implement directly after the exclusive integration barrier. This includes corrections, cleanup, and recovery. Supply the outcome, purpose, permitted effects, write envelope, relevant facts, invariants, and acceptance criteria, not a leaf count, node allocation, no-delegation rule, or sole-writer strategy. Require reconciliation of uncertain work, preservation of evidence, applicable checks, and compliance with actual ownership restrictions by stating the obligations and their basis. Do not prescribe a local strategy to meet them. Local assignments do not replace global acceptance or authorize replanning. Preserve the frozen envelope, unit order, and the Level 1 and Level 2 decision rules.

Developer implements and owns ordinary in-scope diagnosis and correction for implementation assignments. Verification-only work does not add a semantic review; diagnosis-only work does not authorize repair; cleanup can be a no-op. Return after the assigned outcome, necessary cleanup, and evidence recording. Reviewer independently judges the assigned consultation or change using `verify-behavior`, reports findings, and never fixes. Consultation and correction review are not final approval; unspecified change review covers the complete relevant diff, and final review covers the complete agreed final diff, underlying evidence, and relevant effects. Architect answers only an architecture question. Researcher fills only a real knowledge gap. If any delegation fails, report the error; failure never transfers specialist authority to the Coordinator. Do not perform that role yourself. Keep at most one Developer role active, without exception.

When no agent or Team tools are registered, implement inline with the same plan, ledger, evidence, and verification rules. A failed, stalled, cancelled, or lost delegation does not authorize inline specialist work.

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

Without an explicit exterior verification grant, the principal coordinator owns the final complete procedure directly. Never delegate that full invocation to an ordinary AgentInstance or Team tool subject to the 45-minute tool-stall watchdog. The granted Head route below is the only exception. Leave routine bash timeout and codemode `timeout_ms` unset and await nested calls; this removes those deadlines, not every caller constraint. Workers may run focused checks with fixture-appropriate bounds. Keep raw logs and observed exits, tool errors, interruption and capture failure; stop at the first failed, interrupted or unavailable command and name remaining obligations as unrun. Preserve partial evidence and establish prior owned invocation settlement before replacement. No detached runner, heartbeat or settings change. This coordinator check ownership does not transfer failed specialist authority or replace independent final review.

For the granted route, exterior `agent_spawn` or `team_assign` admission must explicitly supply `verification` on asynchronous Developer `mode: "head"`: positive finite `durationMs`, `captureBytes`, `invocations` and explicit relative `artifactRoots`/`scratchRoots`. Omission keeps ordinary check ownership. The host resolves the physical execution root and unique evidence destination from the captured binding and `evidenceFile`; Head cannot nominate storage, native authority, or a new grant. A `writes: []` Head may check but cannot edit. Never grant setup, installs, product/configuration mutation, spend, or external effects through verification.

Head reads the root `GATES.md`, selects exact ordered commands/cwd/child environment and coverage, and invokes `head_gates` after its integration barrier. Pitako still requires exactly `bun run typecheck` followed by `bun run test`, normal discovery and child `BUN_OPTIONS='' NO_COLOR=1 FORCE_COLOR=0`. The engine does not evaluate the recipe or parse Markdown. Manual/prerequisite obligations remain explicit. Host-owned finite execution and typed waiting replace the ordinary blocking tool watchdog route without extending owner max-runtime. Steering remains admitted; the same one-shot Head receives native receipts and may correct within its writes only after released closure. Active/unknown overlapping leases bar writers, checkpoint, reopen and successful finish. Unknown retains diagnostics, no replacement or cleanup. Only exact active-branch released/passed/current owned evidence may satisfy finish; handles/status/read, copied or stale evidence cannot. Coordinator retains independent review and acceptance; no new session or engine retry manufactures a pass.

If verification fails in an implementation assignment, the same Developer reproduces, finds the root cause, makes the smallest in-scope correction, and verifies again. Diagnosis-only and verification-only assignments retain their permitted effects. Do not ask the user, call Architect, or switch to a stronger model merely because a check failed.

Keep ordinary in-scope correction with the responsible active Developer, using
bounded input when appropriate, not a second exterior Developer. If failure or
cancellation requires a fresh assignment, first satisfy settlement, binding,
ownership, and hold recovery; select Head again for the remaining outcome under
Workers. An active ordinary selection deviation follows the stricter transition
rules above. A failed worker never authorizes inline takeover.

Known focused diagnosis and correction remain with the Developer, regardless of failure count. Consult for an identified design, knowledge, authority or correctness question: Architect resolves a missing design decision; Reviewer assesses an existing proposal. Resolve missing context through focused inspection. When useful, `verify-behavior` offers optional JEV consultation orientation using the assigned result, scope, proposal, established evidence, remaining uncertainty and actual specialist question when known. Advice is not a WorkBrief, dispatch or authority. Missing advice creates no installation task or mandatory consultation. If evidence shows the implementation shape is wrong but the plan envelope still holds, ask Architect, record a Level 2 amendment, and continue. If no solution preserves the envelope, return `USER_DECISION_REQUIRED`. Independent final review remains required and is never waived by advice.

Do not start the next unit until this unit is verifiable.

Design-time ordering guidance does not authorize skipping or reordering frozen units. After a verification prerequisite failure, continue only useful independent checks permitted inside the current unit. Do not bypass ownership, unresolved Team holds, or setup restrictions. Failed or interrupted setup permits only non-dependent read-only diagnosis, not implementation writes or dependent checks. Independent checks do not accept the incomplete unit or waive required evidence, final gates, or review.

## Cleanup

Product cleanup edits require a fresh asynchronous Developer Head assignment
after the prior Developer has physically settled and normal ownership and
admission requirements are satisfied. Supply the authorized relative envelope;
leave local organization to Head. A no-op cleanup creates no Developer.
Setup, ledger and Board bookkeeping, the principal final typecheck-then-test
procedure, independent review, and acceptance are non-Developer responsibilities.
Never delegate the principal final complete procedure as cleanup or focused verification. Only the explicitly granted Head route above may select it for host-owned execution. Head finish and focused checks do not establish coordinator acceptance.

Ponytail is the first defense. After all units are verified and material findings are resolved, make one deliberate Ponytail pass over the complete finished diff. This pass comes before `remove-ai-slops` and final gates; it does not replace Ponytail during implementation. Apply `verify-behavior`'s deletion rule to tests and their infrastructure: identify the guarantee and where it remains demonstrated, or why the contract no longer applies. Preserve uncertain cases and distinct guarantees.

Require current sufficient passing affected-check evidence after that pass. Affected checks must be green before `remove-ai-slops`. Apply `verify-behavior`'s reuse policy: rerun only when edits or other relevant changes invalidate evidence, or an applicable gate requires a new observation. A no-op pass alone does not require duplicate checks.

Run `remove-ai-slops` only when the change justifies it: multi-file work, a new abstraction, a refactor, repeated patterns, several workers, or a Reviewer note about needless complexity. Skip it for a tiny mechanical edit, not after every edit.

Scope is files changed by this run. Do not clean unrelated history. Do not escalate the model because cleanup failed once.

Write `evidence/<unit>/deslop.md` or `evidence/final/deslop.md` only for a dedicated pass. Keep the ledger to a pointer.

After cleanup, rerun checks invalidated by the edits using `verify-behavior`; if cleanup breaks a check, revert that cleanup and verify again. Run applicable final gates after all edits, using the active project's complete procedure and order within the authorized testing scope. Cheap access to an external runtime does not make it a gate. Evidence reuse never cancels a mandatory gate.

## Review

Skip Reviewer on trivial edits when deterministic checks cover the unit. Use Reviewer for boundaries, concurrency, persistence, security, external integration, lifecycle, or a wide blast radius. Use `blast-radius` only for those triggers, not for every unit.

Use `review_start` for the existing independent Reviewer pass, with no individual fallback or extra pass. Its new independent substantive director/root and zero to five optional specialists selected for utility with reasons remain separate from implementers, designers and the accepting coordinator. Selective recomposition preserves useful conversations. Optional Scout, Researcher and Oracle supports supply knowledge, not judge findings. Corrections remain outside the table with Developer under the existing correction order.

For final review, use `object: {kind: "diff", base: "<agreed-local-ref>"}` for the complete final diff, including staged, unstaged and applicable non-ignored untracked files. Pin an explicit local base and provide scope, criteria, evidence and current identities. Do not impose a new clean-tree or commits-only prerequisite for review. A `brief` object is only a bounded consultation; neither that nor correction review substitutes for final whole-diff review. See [Reviewer tables](../../docs/review.md).

Pass the frozen `plan` and relevant `unit` to `review_start` under the existing execution binding. Record only its actual returned exterior Team assignment under `## Workers`, with purpose, pending decision and consulted object. Preserve root watches, ledger and Board rules; incompatible binding or a real Team hold blocks, and the table is not an escape from admission rejection. Internal participant results never deliver foreground judgments.

Interpret the complete automatic exterior JSON `ReviewReport` after physical closure and comparison with the current object. No `review_read` or result fetch is required for transport or acknowledgement. Use the actual exterior status and top-level `completion` and `verdict`, not nested synthesis, dispositions or diagnostic room state. Completed work can report `changes-required` or `inconclusive`; `no-blockers` is not coordinator acceptance. Failed, cancelled, partial or drifted work, or missing indispensable evidence, cannot approve. A final inconclusive judgment blocks approval. Successful work-hold reconciliation is bookkeeping only. The table cannot implement, accept units, freeze plans or waive gates.

Fingerprints identify observed endpoints, not transactional snapshots, ABA-proof history or post-delivery freshness. Material object edits invalidate affected judgment under the review policy below.

Classify cleanup and later edits against the complete final diff and evidence:
- **A:** demonstrably nonsemantic subtraction. Identify what was removed and why, with checks or other evidence supporting unchanged behavior and contracts. Deletion alone does not prove A.
- **B:** potentially semantic or uncertain, including changes to logic, state, lifecycle, concurrency, paths, security, privileges, output, or contracts. Treat uncertainty as B.

Before `EXECUTION_COMPLETED`, the single final review must inspect the complete final diff after cleanup and final gates, against Goal, Scope, Invariants, acceptance criteria, rulings, amendments, and evidence. The reviewer gets the scoped artifacts, not the parent transcript. B or uncertain changes need an independent Reviewer on the complete final diff. Any B or uncertain edit after approval invalidates that approval: rerun affected checks and applicable final gates, then obtain an independent Reviewer assessment of the complete updated final diff. Repeat after any further B or uncertain edits. An evidenced A-only cleanup does not require a second review solely for cleanup when adequate independent review already covers it. This exception does not waive `$execute`'s required final review or any review required by risk.

## Records

`todo` shows all global units of the frozen plan, not just the current activity. List existing tasks first. Before starting T1, register T1, T2, T3, and T4 if those are the plan's units. Keep unit IDs and titles recognizable. Create future units as `pending`; keep at most one task `in_progress`. After accepting T1 and starting T2, T1 is `completed`, T2 is `in_progress`, and T3 and T4 remain `pending`. Delegation or a worker result alone does not complete a unit. Workers track only their own assignment.

On resume, reconcile TODOs with the plan, ledger, and relevant evidence. Reuse existing tasks, preserve unrelated tasks, and never `clear` the list to rebuild it. If tasks are missing, reconstruct their states from those records. Keep accepted units completed; do not duplicate or execute them again. Subtasks may supplement global units, not replace them. TODOs are a session checklist, not acceptance authority. Do not mirror every TODO into the ledger.

The Board is not a progress log. Use FINDING for a fact or constraint; DECISION for a chosen boundary before its authoritative artifact; QUESTION/ANSWER for cross-context coordination; BLOCKER only when another context cannot correctly continue; HANDOFF only for essential next-context knowledge; INFO sparingly for mission context. Do not post progress, status, test counts, heartbeats, or ordinary worker events (for example, `HANDOFF: T3 done, 44 tests pass`): ledger and evidence own progress. Once absorbed, the plan, code, tests, or docs are authoritative. No execution-local blocker post is needed when the ledger suffices.

The ledger is a checkpoint: plan id, revision, hash, status, completed units, current unit, next action, rulings, amendments, blockers, and evidence paths. No test logs, diffs, or transcripts.

Evidence lives under `evidenceFile`. Proof only: command and result, runtime observation, review conclusion, changed files. A resume does not load every evidence file.

Durable prose uses normal sentences, `technical-writing` where it applies, then Unslop. Do not run that cleanup on a one-line ledger update.

## Report

Stop at `EXECUTION_COMPLETED` or `USER_DECISION_REQUIRED`.

The completion report names the plan id and revision, units completed, behavior changed, important rulings and amendments, verification commands and results, whether Ponytail and de-slop ran, review results, the evidence directory, AgentInstance ids and selected models when `AgentRunResult` has them, and any remaining issue. No transcript dump.
