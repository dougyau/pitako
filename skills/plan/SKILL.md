---
name: plan
description: Explicit planning workflow. Investigates, designs, critiques, materializes and freezes a decision-complete Pitako plan. Never implements the plan.
---

# $plan

`$plan` is planning authority. It is not implementation authority.

Spend intelligence on decisions that remove material uncertainty. Stop when a Developer could implement without rediscovering what "done" means.

## Authority

You may inspect the repository, investigate, research, design, decide technical questions needed to make the plan executable, critique the plan, and write planning artifacts under `.pitako/`.

Never implement the product. Do not apply opportunistic fixes, refactors, migrations, or feature tests. Do not start execution.

The only intentional writes are `.pitako/` artifacts, unless the user asked you to build the `$plan` / `$execute` feature itself.

Do not invoke $execute. Planning completion is not implementation authority.

## When to ask

Resolve technical choices from the repository, docs, tests, and Board. Ask only when the desired outcome is ambiguous, a material preference cannot be inferred, risk appetite is required, or two valid outcomes differ in user-visible intent.

Do not interview the user about facts exploration can answer.

## Depth

Classify the work as bounded or architectural. Do not build a classifier.

Bounded: inspect the relevant code, name goal, scope, and invariants, define verification, write compact work units, freeze. Use Reviewer only when the risk justifies it. Do not call Architect or Researcher for trivial work.

Architectural: ground the current system, resolve material unknowns, one Architect pass, draft, one independent Reviewer critique, revise, freeze. One critique is enough. Another high-cost pass needs a concrete unresolved blocker. Do not run arena, interrogate, swarm, or extra Architects and Reviewers.

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

During an architectural `$plan`, assign the Architect role in background. The task must be design-only: inspect, reason, model, propose, critique. Ask that existing pass to check unit partition and ordering for coupled contracts and consequential uncertainty. It must say not to modify product files. A delegation failure never transfers specialist authority to the Coordinator; report it rather than doing the specialist work.

Use the Researcher role only for a real external or knowledge gap. Use the Reviewer role for one independent critique of an architectural plan. In that planning critique, the reviewer challenges acceptance realizability and relevant interacting contracts, including dependency-correct ordering. Probe plausible counterexamples where they matter, not a universal test matrix. This planning responsibility does not authorize implementation replanning or reordering. The reviewer reports findings and never fixes or implements.

Use Caveman for ephemeral child communication: Architect lite, Reviewer lite, Researcher full. Do not write Caveman grammar into the plan file.

Architect and Reviewer consultations, including a critique needed before freeze, use background dispatch: prefer `team_assign` when registered; use `agent_spawn` only when Team is not registered. This workflow policy supersedes generic tool prompts recommending `agent_run` for Architect or reserving Team for "independent work": a complete WorkBrief can run autonomously even when a coordinator decision depends on its answer. Do not change those prompts. If only `agent_run` exists, report the required consultation or review as blocked. No synchronous fallback, inline specialist work, or waived review is allowed. Keep the role ModelPolicy.

Before planning correlation, check the draft's explicit Board binding and existing ledger. For a bound draft without a ledger, call `team_assign` without `plan` or `unit`; do not pass an explicit topic to bypass this rule. For an unbound draft or a compatible existing ledger, pass the prospective, validated `plan` ID and a distinct, scoped `unit` ID per consultation. Do not reuse an unrelated execution unit. An incompatible ledger or real Team hold remains a blocker; omitting correlation must not bypass it. Do not create an execution ledger during planning to enable dispatch or record workers.

Record role, purpose, handle type and exact ID, pending decision, and consulted object under `## Planning workers` in the draft. Use the Team assignment ID for Team and the worker instance ID for `agent_spawn`, with or without correlation. This is an operational checkpoint, not a Team Hold or acceptance evidence. Exclude `## Planning workers` from the consulted object and explicitly instruct the worker to ignore that section.

Do only already-authorized planning work independent of the pending answer. If nothing else can proceed, end the turn with a brief pending-consultation note. Do not ask whether to wait, keep a call open, fetch a result in the assignment turn, or poll status. Interpret the complete settled results automatically supplied in context before deciding. A wake, terminal status, steering receipt, or bookkeeping result is not the required judgment. `team_result` is an optional exact-assignment diagnostic re-read; `agent_result` uses the exact worker instance ID. Neither is result transport or acknowledgement. Do not freeze before interpreting the required current-object judgment; worker completion is not coordinator acceptance.

If Team rejects a reserved role, distinguish occupancy from an unknown handle. End the turn without polling or fallback. After that reservation settles and releases the role, retry `team_assign` if the consultation is still necessary and authorized. Another assignment's result does not answer this consultation. Do not use `agent_spawn` or `agent_run` to evade occupancy or admission rejection. Cancellation alone proves neither settlement nor role release.

Handles are session-local. On resume after reload or process loss, check each recorded handle once by type: `team_status` with the exact assignment ID or `agent_status` with the instance ID. If still active in the same session, end the turn. Only in planning, an unknown handle after reload or process loss permits one replacement consultation: record the loss, then assign a fresh current-object WorkBrief if still needed and authorized. A known failure is not an unknown handle. `## Planning workers` does not recover Team Holds or authorize execution; real holds and incompatible ledgers retain their existing recovery requirements.

### Observe and redirect a planning worker

Compare new user information with the consulted object and original WorkBrief before using a result. For information within the brief, use foreground-only `agent_observe` on the exact `{kind: "team", assignmentId}` or `{kind: "background", instanceId}` target. Pass its observed `historyId` and `sessionId` to `agent_input`; reobserve after native replacement. Use `intent: "query"` for context or `intent: "steer"` for an in-scope correction within current authority, not a replacement WorkBrief or command. Input waits for a later native boundary and never interrupts a running command.

Inspect receipts and subsequent behavior separately: `queued` means admitted, not delivered; `handled` means hook consumption, not an answer; `rejected` means no accepted submission; `unconfirmed` preserves uncertainty. Neither `queued` nor `handled` proves correction or replaces a new consultation. Steering does not expand authority, accept work, or waive critique.

If information changes the object outside the WorkBrief, mark the old consultation inapplicable to the pending decision. Interpret its automatic result when supplied, but do not use it to close that decision or apply the change after accepting the old judgment. Cancel the exact still-active target with `team_cancel` or `agent_cancel` according to handle type. End the turn while settlement and role release are pending. Only after settlement and role release, assign a fresh WorkBrief against the current object if still necessary and authorized. Failure or loss never transfers specialist work to the Coordinator.

Do not hardcode a provider or model. The role ModelPolicy chooses the model.

## Artifact

Resolve the workspace with `workflowWorkspace` in `extensions/workflow.ts`: git root, otherwise canonical cwd.

Store the plan at `planFile(id)`. The id matches `[a-z0-9][a-z0-9-_]*`. Do not hand-join ids into paths. Reject `..`, absolute paths, and separators. The helper already does.

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

Keep revision as an integer. For a new plan, revision is 1. If the user invokes `$plan` on an existing frozen plan, keep the id, increment revision, and replace the file. Do not store revision history.

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

Ordered units only. No DAG.

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

Define global outcomes and constraints, not a future Developer Team head's local task allocation.

Every meaningful unit needs acceptance criteria that name observable behavior and affected guarantees. Name proportional expected evidence using `verify-behavior` when it stops the executor from inventing "done". For new, costly, privileged, or integration-dependent acceptance, describe a compact permitted positive route from the actual entry point to the required observation. Resolve only material prerequisites: interaction driver, effective state and resource sharing, configuration, credentials, effect owner, authorization, and cleanup. Do not prescribe a test per function or a universal case matrix.

Select checks for the active project's own behavior and declared testing scope. Reading an external boundary does not authorize dependency certification or repair. Do not turn out-of-scope external checks into acceptance, preflight, or final gates. Preserve authorized integration requirements from the project's scope, contracts, and active guide, not Pitako's distributed stack.

## Critique and freeze

Integrate findings that change a decision, a boundary, or an acceptance criterion. If only optional hardening remains, do not grow the plan.

Once required results are interpreted and the pending decision is resolved, preserve relevant conclusions in the plan and remove `## Planning workers` before freezing. Its removal does not invalidate critique because that operational section was excluded from the consulted object. Integrating corrections requested by critique does not itself require another consultation; another pass needs a material blocker or a change outside the reviewed object.

Set `status: frozen`. Then return `PLAN_FROZEN` with the id, revision, path, work-unit count, important decisions, whether critique ran and why, and an explicit statement that implementation has not begun. A completion wake does not relax this boundary: `$plan` remains planning-only and must not implement the frozen plan.

After freezing, apply the planning-only lifecycle rule above before returning `PLAN_FROZEN`. For a bound plan with `execution: none`, call `initLedger(ledgerFile(id, cwd), meta)` after freezing and before resolving; the initialized empty Team hold gate is required. Do not resolve a topic when knowledge is not absorbed or a coordination question remains. A bound topic with expected execution stays open; no session start, reload, or worker completion changes its status.

Then stop.
