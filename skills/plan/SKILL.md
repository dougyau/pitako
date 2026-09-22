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
- `technical-writing`, then `unslop`, for the plan file

Use `principle-foundational-thinking`, `principle-model-the-domain`, `principle-boundary-discipline`, `principle-subtract-before-you-add`, `principle-minimize-reader-load`, `principle-guard-the-context-window`, and `principle-sequence-verifiable-units` when the decision needs them.

Do not invoke every skill or role because it exists.

## Architect and Reviewer

The `architect` skill continues into implementation when the user asked to build. Do not use that path here.

During `$plan`, call the Architect role with `agent_run`. The task must be design-only: inspect, reason, model, propose, critique. It must say not to modify product files. If `agent_run` fails, report the error. Do not do that role yourself.

Use the Researcher role only for a real external or knowledge gap. Use the Reviewer role for one independent critique of an architectural plan. The reviewer inspects missing constraints, conflicts, unclear boundaries, hidden assumptions, weak acceptance criteria, weak verification, unnecessary complexity, and scope creep. The reviewer does not implement.

Use Caveman for ephemeral child communication: Architect lite, Reviewer lite, Researcher full. Do not write Caveman grammar into the plan file.

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
---
```

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

## Work units

Ordered units only. No DAG.

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

Every meaningful unit needs observable acceptance criteria. Name expected evidence when it stops the executor from inventing "done".

## Critique and freeze

Integrate findings that change a decision, a boundary, or an acceptance criterion. If only optional hardening remains, do not grow the plan.

Set `status: frozen`. Then return `PLAN_FROZEN` with the id, revision, path, work-unit count, important decisions, whether critique ran and why, and an explicit statement that implementation has not begun.

Then stop.
