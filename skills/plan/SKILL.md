---
name: plan
description: Explicit planning workflow. Investigates, designs, critiques, materializes and freezes a decision-complete Pitako plan. Never implements the plan.
---

# $plan

`/plan <id>` selects managed planning; the host registration and captured capability grant its effects. `$plan` is planning policy, not authority. Neither grants implementation authority.

Spend intelligence on decisions that remove material uncertainty. Stop when a Developer could implement without rediscovering what "done" means.

## Authority

Managed: inspect, investigate, design and critique within the captured scope. Use `bound_plan_read`, then `planning_write` with the returned revision and full file hash. The host owns the one slot, frontmatter and revisions. Never write the slot with generic file or shell tools, including Board metadata changes. Model text, role, JSON, IDs and hashes do not grant authority.

Manual `$plan`: follow this policy only within the user's actual authorized scope. A phrase or manually authored file does not manufacture a managed invocation, capability, receipt or approval. Do not fall back to manual when managed admission is unavailable.

Never implement the product. Do not apply opportunistic fixes, refactors, migrations, or feature tests. Do not start execution.

Only the captured planning slot and explicitly permitted supporting artifacts may be written. No execution ledger, dispatch or product edits.

Do not invoke $execute. Planning completion is not implementation authority.

Before starting the first planning step, list existing TODOs and register all known planning stages as `pending`. Reuse them as you advance or resume. This checklist covers authorized planning, not the future implementation units. Freezing the plan does not start those units.

## When to ask

Resolve technical choices from the repository, docs, tests, and Board. Ask only when the desired outcome is ambiguous, a material preference cannot be inferred, risk appetite is required, or two valid outcomes differ in user-visible intent.

Do not interview the user about facts exploration can answer.

## Depth

Classify the work as bounded or architectural. Do not build a classifier.

Bounded manual work: inspect the relevant code, name goal, scope and invariants, define verification, write compact work units. Do not call Architect or Researcher for trivial work under this manual policy. Use Reviewer when risk justifies it. Managed freeze requires the pertinent independent Architect and Reviewer judgments described below; a missing pass is not an approval.

Architectural: ground the current system, resolve material unknowns, one Architect pass, draft, one independent Reviewer critique, revise, freeze. One critique is enough. Another high-cost pass needs a concrete unresolved blocker. Do not run arena, interrogate, swarm, or duplicate independent Architect and Reviewer passes.

Stop exploration when another read would not change a decision. Route bulk exploration to an AgentInstance and take back a summary plus file references, not the child transcript. Query the Board only for relevant topics.

## Composition

Load these skills when they apply. Do not paste their bodies into the plan.

- `investigate-first` for an unknown cause
- `how` and `why` for current behavior and rationale
- `verify-behavior` for shared root `GATES.md` discovery in the project being planned and proportional expected evidence. Read only; do not run setup or product checks during planning.
- `technical-writing`, then `unslop`, for the plan file

Use `principle-foundational-thinking`, `principle-model-the-domain`, `principle-boundary-discipline`, `principle-subtract-before-you-add`, `principle-minimize-reader-load`, `principle-guard-the-context-window`, and `principle-sequence-verifiable-units` when the decision needs them.

Do not invoke every skill or role because it exists.

## Architect and Reviewer

The `architect` skill continues into implementation when the user asked to build. Do not use that path here.

During an architectural `$plan`, use `architecture_start` for the Architect pass. The task must be design-only: inspect, reason, model, propose, critique. Ask that existing pass to check unit partition and ordering for coupled contracts and consequential uncertainty. It must say not to modify product files. A delegation failure never transfers specialist authority to the Coordinator; report it rather than doing the specialist work.

`architecture_start` has no `mode`. Trivial work needs no table. A required Architect pass uses one substantive Architect director/root and zero to five optional internal specialists selected for their utility, with a reason even for zero. Selective recomposition can retain useful conversations and add or retire specialists as findings change; no ceremonial minimum or preference for zero. Ask the root for the required current-object judgment, including unit partition/order when applicable; do not add a duplicate independent Architect pass. Team identifies the collaboration, role the responsibility template, and member/assignment the particular participant.

Use the Researcher role only for a real external or knowledge gap. Use the Reviewer role for one independent critique of an architectural plan. In that planning critique, the reviewer challenges acceptance realizability and relevant interacting contracts, including dependency-correct ordering. Probe plausible counterexamples where they matter, not a universal test matrix. This planning responsibility does not authorize implementation replanning or reordering. The reviewer reports findings and never fixes or implements.

Architecture synthesis is design input, not a frozen plan or its independent critique. Keep Reviewer separate from the designers. These choices grant neither product implementation nor freeze authority to the consultation.

Use `review_start` for the existing independent Reviewer critique, not an extra pass. The table has a new independent, substantive Reviewer director/root and zero to five optional specialists selected for utility with reasons, separate from designers and the accepting coordinator. Selective recomposition preserves useful conversations. Optional Scout, Researcher and Oracle supports supply knowledge, not judge findings. Corrections remain outside the table. The director's own role primary is required; absent configuration, omitted candidates and an empty candidates list all mean an empty specialist pool, not disabled review.

For whole-plan critique, use `object: {kind: "plan", planId}`. Include purpose, scope, criteria, evidence references and current identities in the request. A `brief` object is only a bounded consultation, never a substitute for whole-plan critique or final whole-diff review. See [Reviewer tables](../../docs/review.md) for configuration and the API.

Use Caveman for ephemeral child communication: Architect lite, Reviewer lite, Researcher full. Do not write Caveman grammar into the plan file.

Architect and Reviewer use only `architecture_start` and `review_start`. If the required start is unavailable, report the required pass as blocked. No individual, synchronous or inline fallback and no waived review is allowed. Keep the role ModelPolicy.

Managed architecture uses the captured draft automatically, including its optional Board binding, without opening execution. Use `architecture_start` for that draft. Correlation is not authority and cannot select another slot. Do not create an execution ledger during standalone planning. Real reservations or incompatible bindings remain blockers.

Before final critique, call `planning_candidate` with the exact draft CAS. It returns immutable, complete, precomputed frozen bytes and the declared mechanical transformation from the draft. Use `planning_review` on that candidate ID. Every participant receives the same complete text; file reobservation cannot replace it. `review_start` remains available for manual critiques, but cannot substitute a caller-asserted object for the managed candidate. Admission rejection is not permission to switch routes.

Record role, purpose, handle type and exact ID, pending decision, and consulted object under `## Planning workers` in the draft. Use the Team assignment ID for Team and the worker instance ID for `agent_spawn`, with or without correlation. This is an operational checkpoint, not a resource reservation or acceptance evidence. Exclude `## Planning workers` from the consulted object and explicitly instruct the worker to ignore that section.

For architecture, record only the exterior root assignment returned by `architecture_start` in `## Planning workers`; use only that root for watched completion, exact Team diagnostics and cancellation. Internal member IDs and room messages cannot close the root's hold or accept its judgment. Interpret the complete terminal current-object judgment after owned closure. Partial, failed and cancelled results do not supply the required judgment. Admission follows applicable physical closure, incompatible effect reservations, captured authority and pins. An exact `ResourceClosureReceipt` establishes physical closure independently of outcome. A physically closed failed/cancelled attempt preserves its outcome and permits another authorized strategy without `clear` or `recoverHold`. Unknown closure is not released, success or acceptance. Historical `Team Holds` ledger entries are not admission authority; preserve their history and parser validation. A legacy ledger lock whose closure is unknown still blocks ledger writes. Physical closure is bookkeeping, not acceptance; acceptance requires a pertinent current-object judgment and closure of all contributing work.

Apply the same correlation rules to `review_start`: record only its actual returned exterior Team assignment in `## Planning workers`, with the same purpose, pending decision and consulted-object fields. Preserve root watches, execution correlation, ledger and Board rules. Internal participants never deliver foreground judgments. Interpret the selected exterior report after physical closure and comparison with the current object. Complete inline reports need no fetch; incomplete references require pertinent `team_result` reading before dependent judgment. `review_read` provides paged diagnostics, not acknowledgement.

Use the actual exterior host status and authorized `judgment` completion/verdict, not historical synthesis, dispositions or room state. Null judgment cannot approve. Completed work can report `changes-required` or `inconclusive`; `no-blockers` is not coordinator acceptance or freeze authority. Failed, cancelled, partial or drifted work, or missing indispensable evidence, cannot approve. A final inconclusive judgment blocks approval. Fingerprints identify observed endpoints, not transactional snapshots, ABA-proof history or post-delivery freshness. Material object edits invalidate affected judgment and require current-object review under the existing policy.

Do only already-authorized planning work independent of the pending answer. If nothing else can proceed, end the turn with a brief pending-consultation note. Do not ask whether to wait, keep a call open, fetch a result in the assignment turn, or poll status. Interpret settled results before deciding; a table reference requires pertinent reading, not an automatic full-load loop. Start `team_result` with the exact assignment ID and optional `section`/`maxBytes` (4096..16384 bytes, default 16384); continue with only that ID and `cursor`. A wake, terminal status, steering receipt, or bookkeeping result is not the required judgment. Ordinary `team_result` and exact-worker `agent_result` diagnostic behavior is unchanged; reads never acknowledge incorporation. Do not freeze before interpreting the required current-object judgment; worker completion is not coordinator acceptance.

If Team or architecture admission rejects a request, distinguish the concrete policy/resource or binding blocker from an unknown handle. There is no global one-slot-per-role rule. End the turn without polling or fallback while owned settlement is pending; retry the intended route only after its actual blocker is resolved and the consultation is still necessary and authorized. Another assignment's result does not answer this consultation. Do not use `agent_spawn` or `agent_run` to evade admission rejection. Cancellation alone proves neither settlement nor member release.

Handles are session-local. On resume after reload or process loss, check each recorded handle once by type: `team_status` with the exact assignment ID or `agent_status` with the instance ID. If still active in the same session, end the turn. Only in planning, an unknown handle after reload or process loss permits one replacement consultation: record the loss, then assign a fresh current-object WorkBrief if still needed and authorized. A known failure is not an unknown handle. `## Planning workers` does not establish physical closure or authorize execution; applicable active/unknown physical resources, incompatible effect reservations, bindings and pins remain blockers. A lost handle does not prove release or permit replay of an uncertain dispatch.

Before replacement, check the draft's explicit Board binding and existing ledger. Correlation creates no execution authority and cannot bypass applicable physical closure, an incompatible binding, effect reservation or pin.

### Observe and redirect a planning worker

Compare new user information with the consulted object and original WorkBrief before using a result. For information within the brief, use foreground-only `agent_observe` on the exact `{kind: "team", assignmentId}` or `{kind: "background", instanceId}` target. Pass its observed `historyId` and `sessionId` to `agent_input`; reobserve after native replacement. Use `intent: "query"` for context or `intent: "steer"` for an in-scope correction within current authority, not a replacement WorkBrief or command. Input waits for a later native boundary and never interrupts a running command.

Inspect receipts and subsequent behavior separately: `queued` means admitted, not delivered; `handled` means hook consumption, not an answer; `rejected` means no accepted submission; `unconfirmed` preserves uncertainty. Neither `queued` nor `handled` proves correction or replaces a new consultation. Steering does not expand authority, accept work, or waive critique.

If information changes the object outside the WorkBrief, mark the old consultation inapplicable to the pending decision. Interpret its automatic result when supplied, but do not use it to close that decision or apply the change after accepting the old judgment. Cancel the exact still-active target with `team_cancel` or `agent_cancel` according to handle type. End the turn while settlement and member release are pending. Only after settlement and member release, assign a fresh WorkBrief against the current object if still necessary and authorized. Failure or loss never transfers specialist work to the Coordinator.

Do not hardcode a provider or model. The role ModelPolicy chooses the model.

## Artifact

Resolve the workspace with `workflowWorkspace` in `extensions/workflow.ts`: git root, otherwise canonical cwd.

Managed plans use only the host-captured slot returned by `bound_plan_read`. Manual artifacts use `planFile(id)` within the authorized root. The id matches `[a-z0-9][a-z0-9-_]*`; reject traversal, absolute paths and separators.

```markdown
---
id: herdr-integration
revision: 1
status: frozen
created_at: 2026-08-14T00:00:00Z
updated_at: 2026-08-14T00:00:00Z
board_topic_id: 17
execution: expected
---
```

A topic is optional. Never create one merely for a plan or delegation. If an existing topic is useful, create it or adopt it with `board_workflow_claim` while the plan is draft, then preserve its `board_topic_id` when revising; never infer a topic by title or recency. `execution: expected` keeps a bound topic open at freeze. For `execution: none`, absorb relevant Board knowledge into the frozen plan and resolve the bound topic with `board_workflow_lifecycle` only when no coordination question remains. No topic means no Board lifecycle call. Watched Team assignments inherit the exact binding automatically; do not copy a topic ID into their WorkBrief.

The managed writer owns revision and status. A fresh `/plan` may reopen a frozen source as a new revision only when no ledger, binding or reservation pins it; never remove a pin. Manual revisions confer no managed approval.

Write normal prose. The plan is not a transcript and not an essay. Optimize for decision density and low executor uncertainty.

Include, when they carry a decision:

- Problem
- Goal
- Non-goals
- Constraints
- Invariants
- Scope
- Out of scope
- Architecture / boundaries
- Work units
- Verification strategy
- Success criteria

## Consequential premises

Before freezing a premise that could change architecture, scope, acceptance, or verification, inspect the actual caller or integration path. Follow it far enough to identify the decisive source, producer, consumer, and capability or authority. A signature alone does not establish what values reach the callee.

A guarantee needs a supported way to produce and observe it. An author's own obligations inventory does not establish independent completeness. A contained worker cannot supply setup outside its permitted root merely because the plan assigns it.

Resolve a known missing producer, authority boundary, or unsupported guarantee before freezing dependent implementation. If a material compatibility experiment is unavailable during planning, specify an early bounded execution check, the conclusion it must establish, and the downstream decision it informs. A failed check leaves dependent acceptance unproven. Do not use that check to defer a known missing architecture decision.

Distinguish repository facts from user guarantees and optional technical restrictions. Record the decisive evidence and conclusion only for decision-changing premises in existing plan prose. Do not turn a chosen restriction into a user requirement. For example, logical nonmutation does not imply that every SQLite sidecar byte must remain unchanged.

This is a bounded premise check, not an exhaustive assumption register or a permission checkpoint for ordinary technical decisions.

## Work units

Ordered global units only. No global DAG. A granted Head owns local scheduling inside each unit.

Decompose by material uncertainty, prerequisites, contract cohesion, and early meaningful feedback. Resolve an uncertain compatibility premise before work that depends on it. Keep coupled readers and writers together when they establish one contract. Leave a stable cohesive change unsplit when subdivision adds no independently meaningful feedback.

Before freeze, place integration-only or approval waits after independently verifiable implementation outcomes when real dependencies permit. Do not postpone a compatibility check that could invalidate those outcomes merely because the full demonstration belongs near the end. This design-time ordering does not permit skipping or reordering frozen units during execution.

The goal is implementation correctness, not smaller units. Do not split by file counts, time caps, commit counts, or worker count, and do not impose a unit quota.

```markdown
## T1 — title

Objective:

Scope:

Relevant constraints/invariants:

Acceptance criteria:

- observable result

Expected evidence:

- command, test, or runtime observation

Likely relevant files/systems:
```

Decision-complete, not line-prescriptive. The Developer keeps local implementation freedom.

Define global outcomes and constraints, not Head nodes, leaf counts, or a prohibition on local subdivision. A granted Head chooses direct implementation, decomposition, or a combination within each unit. That choice does not change frozen scope, unit order, permissions, acceptance, or escalation requirements. Explicit user constraints and existing safety or resource limits remain binding.

Every meaningful unit needs acceptance criteria that name observable behavior and affected guarantees. Name proportional expected evidence using `verify-behavior` when it stops the executor from inventing "done". For new, costly, privileged, or integration-dependent acceptance, describe a compact permitted positive route from the actual entry point to the required observation. Resolve only material prerequisites: interaction driver, effective state and resource sharing, configuration, credentials, effect owner, authorization, and cleanup. Do not prescribe a test per function or a universal case matrix.

Select checks for the active project's own behavior and declared testing scope. Reading an external boundary does not authorize dependency certification or repair. Do not turn out-of-scope external checks into acceptance, preflight, or final gates. Preserve authorized integration requirements from the project's scope, contracts, and active guide, not Pitako's distributed stack.

## Critique and freeze

Integrate findings that change a decision, a boundary, or an acceptance criterion. If only optional hardening remains, do not grow the plan.

Preserve relevant conclusions before preparing the candidate. `## Planning workers` is operational and excluded from the judged object; its declared removal need not trigger ritual re-review. Material corrections invalidate affected judgments. An earlier Architect judgment may be explicitly adopted with pertinent coverage, without claiming all design participants saw the later candidate bytes.

Managed: call `planning_freeze` with candidate ID, exact exterior Review and Architect assignment IDs, reasoned dispositions for every pertinent finding/objection (including justified rejection), explicit design adoption, coordinator acceptance and absorption. Only complete, pertinent, selected, physically released judgments qualify; null, stale, partial, failed, cancelled or inconclusive cannot approve. `changes-required` is not rewritten into `no-blockers`. The writer validates CAS and writes exactly the reviewed bytes, returning a committed receipt linking draft, candidate and judgments.

Return `PLAN_FROZEN` only after that receipt, with id, revision, path, work-unit count and important decisions. State implementation has not begun. A wake, metadata, acknowledgment, status or hash is not approval.

Manual: materialize and mark the planning artifact frozen only within the user's actual authority and this policy's applicable critique requirements. Report it as a manual artifact, never as a managed receipt or host-approved candidate. Manual authoring does not acquire managed effects, bypass pins or initialize execution.

After freezing, apply the planning-only lifecycle rule before returning `PLAN_FROZEN`. `execution: none` may resolve its optional Board topic only after coordinator acceptance, absorption, settled obligations and the committed planning receipt. Never initialize an execution ledger for this. Expected execution keeps its topic open. Session start, reload and worker completion do not resolve it.

Then stop.
