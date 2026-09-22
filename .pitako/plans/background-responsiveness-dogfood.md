---
id: background-responsiveness-dogfood
revision: 1
status: frozen
created_at: 2026-09-22T17:31:26Z
updated_at: 2026-09-22T17:31:26Z
---

# Background responsiveness dogfood

## Problem

Operator coverage for background workers stops at the registry helpers. `/pitako agents` has no test for an empty list, a running row, an id filter, or an unknown id. Cancel-before-settle is not asserted as `cancelled` with result still unavailable. `skills/execute/SKILL.md` still says an unavailable `agent_run` means implement inline, which was used to treat a stalled Developer as permission for the Coordinator to write the specialist's changes.

## Goal

Add the missing operator checks and make the execute skill say that a failed, stalled, cancelled, or lost delegation is not inline implementation.

## Non-goals

- Teams, a DAG, or a new orchestration framework.
- Changing `agent_run`, `agent_spawn`, or `agent_supervise` scheduling.
- Herdr behavior, pane lifecycle, or `.pitako/plans/herdr-integration.md`.
- Artificial delays.

## Constraints

- Bounded. No Architect pass and no Reviewer pass. The change is tests, one command assertion, and skill text.
- `/pitako agents` already calls `formatWorkerViews(workerStatus(id))`. Empty text is `no workers`. Unknown id throws `unknown worker`.
- `agent_cancel` returns `cancelled` when the owned signal is aborted, before the run promise settles. `agent_result` then throws `result is not available` until the outcome exists.
- Do not poll. Do not add a wait tool.

## Invariants

- `agent_spawn` stays background and in-process. `agent_run` stays synchronous. `agent_supervise` stays a synchronous Herdr wait.
- A delegation failure is not permission for the Coordinator to write that role's source changes.
- Inline implementation remains only when neither `agent_run` nor `agent_spawn` is registered in the session.
- The Coordinator may still verify a completed result. That is not the specialist implementation.

## Scope

- Tests for `/pitako agents` and for cancel-before-settle result availability.
- `skills/execute/SKILL.md` wording, plus a text assertion in `tests/workflow.test.ts`.
- A short README or engineering sentence only if the command's empty and unknown-id behavior is still unstated.

## Out of scope

- New tools, a dashboard, or worker persistence.
- Product changes that are not required for those checks or for the skill sentence.

## Work units

## T1 — Operator coverage and no inline fallback

Objective: A Developer can see worker status from `/pitako agents`, can see cancellation before a result exists, and cannot read the execute skill as permission to implement a failed delegation.

Scope: `tests/agent-background.test.ts` or the closest existing command test, `skills/execute/SKILL.md`, `tests/workflow.test.ts`, and at most a few sentences in `README.md` or `docs/engineering.md`. No Herdr edits.

Relevant constraints/invariants: Keep the three-call matrix. Do not add sleeps. Do not rewrite the frozen background-agent-delegation plan.

Acceptance criteria:

- `/pitako agents` with no workers notifies `no workers`.
- With one running worker, the notify text contains `instance_id`, `role`, `status: running`, `watch`, and `elapsed_ms`, and does not contain the task text or the result body.
- `/pitako agents <id>` returns that row. An unknown id notifies an error and does not throw out of the command handler.
- After `agent_cancel` and before the executor settles, status is `cancelled` and `agent_result` errors with `result is not available`.
- The execute skill no longer says that an unavailable `agent_run` means implement inline. It says inline implementation is allowed only when neither `agent_run` nor `agent_spawn` is registered. A failure, stall, cancellation, or lost worker is not foreground implementation.
- `tests/workflow.test.ts` asserts that distinction.
- `bun test tests/agent-background.test.ts tests/workflow.test.ts` passes.

Expected evidence:

- The focused test command above, green.

Likely relevant files/systems: `extensions/index.ts`, `extensions/agent/background.ts`, `extensions/agent/index.ts`, `skills/execute/SKILL.md`, `tests/agent-background.test.ts`, `tests/workflow.test.ts`.

## Verification strategy

Focused tests for T1, then the execute loop runs `bun test` and `bunx tsc --noEmit` after the worker result is retrieved. Do not treat a worker saying done as proof.

## Success criteria

- The operator checks above exist and pass.
- The execute skill forbids inline implementation after a present delegation tool fails or stalls.
- No Herdr, Team, or DAG change.
