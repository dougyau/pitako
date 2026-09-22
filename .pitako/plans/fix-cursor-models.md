---
id: fix-cursor-models
revision: 1
status: frozen
created_at: 2026-09-22T10:28:50Z
updated_at: 2026-09-22T10:28:50Z
---

# Fix extension-provider models in agent_run

## Problem

`agent_run` cannot select `cursor/composer-2.5`, or any other model that exists only after a Pi extension registers its provider.

`createPiExecutor` builds a fresh `ModelRuntime`. `findModel` runs before `createAgentSession`. That runtime has builtin providers only. `pi-cursor` registers `cursor` on the runtime while `AgentSession` binds extensions. The lookup has already returned `model unavailable: cursor/composer-2.5`. Pitako classifies that as `unavailable` and falls back.

A runtime that has already bound extensions resolves `cursor/composer-2.5` with `reasoning: false`. With `thinkingLevel: "off"`, that model answered `pong`. The model id and `reasoning = "off"` are not the defect.

Earlier developer runs reported `fallback: quota from cursor/composer-2.5`. Those child sessions were in-memory, so the provider text is gone. This plan does not chase that classification.

## Goal

A policy target that appears only after extension bind is selected and prompted. A target that is still missing after bind stays `model unavailable: provider/model`.

## Non-goals

- Sharing the parent session's `ModelRuntime`.
- A second extension loader, a Cursor-specific catalog, or a composer special case.
- Changing fallback reasons, quota matching, or reasoning levels.
- Changing `agent_supervise`.
- Making `allowModelNetwork: true`.

## Constraints

- Pi registers extension providers in `AgentSession` bind, on the runtime passed into `createAgentSession`. `DefaultResourceLoader.reload` does not do that.
- `createAgentSession` may pick a bootstrap model from settings when the policy model is not visible yet. That model must not receive the task.
- `setModel` stays `{ persist: false }`.
- A fresh runtime remains the child boundary. Do not reuse the foreground runtime.
- Same-session fallback already has a bound runtime. Do not bind extensions a second time for that continue.

## Invariants

- No prompt is sent until the policy model is the session model, or the target has failed closed.
- Session construction, extension bind, and `setModel` before a prompt are not side effects. Fallback may still start a fresh session.
- After bind, a missing id is still unavailable. Do not treat a late miss as success.
- Builtin models that exist before bind keep the current path. Do not require a bootstrap prompt for them.
- `reasoning = "off"` remains valid. Do not rewrite it to `medium`.

## Scope

`extensions/agent/pi.ts` and the tests that cover target activation. One sentence in `docs/engineering.md` under AgentInstance v0, next to the existing activation paragraph.

## Out of scope

`extensions/agent/fallback.ts`, role config, `~/.pi/agent/pitako/config.toml`, Herdr, and live quota diagnosis.

## Architecture / boundaries

The child runtime is still created inside `createPiExecutor`. Extension providers become visible only by constructing the child session on that runtime, which is the registration path Pi already has.

Resolve the policy model after that bind, then `setModel` and the existing thinking-level apply, then prompt. If the model was already on the runtime, skip the extra bind and keep today's order.

If bind throws before the policy model is selected, that error is the attempt failure. Do not send the task to the bootstrap model to "see what happens".

## T1 — Select extension models after bind

Objective:

`agent_run` selects a model that a Pi extension registers during session bind, and does not prompt any other model first.

Scope:

The child runtime and the first `runTarget` lookup. Same-session `continueWith` stays on the already bound runtime.

Relevant constraints/invariants:

No parent runtime. No second loader. No prompt before the policy model is active. Late miss stays `model unavailable`. Bootstrap construction is not a side effect.

Acceptance criteria:

- A model absent from a fresh `ModelRuntime`, and present only after a session binds on that runtime, is the model that receives the task.
- The bootstrap model, if `createAgentSession` selected one, receives no prompt.
- A model still absent after bind fails with `model unavailable: provider/model` and does not prompt.
- A builtin model that exists before bind is unchanged.
- Same-session fallback does not open a second bootstrap session.
- `docs/engineering.md` states that extension providers are bound before a missing policy model is final.

Expected evidence:

- A test that fails on today's lookup order and passes when the policy model is selected only after bind. It must not call Cursor.
- `bun test` for the agent adapter tests, and `bunx tsc --noEmit`.

Likely relevant files/systems:

- `extensions/agent/pi.ts`
- `tests/agent-pi.test.ts`
- `docs/engineering.md`
- Pi `createAgentSession` / `AgentSession` provider registration

## Verification strategy

Prove the ordering with a local double, not with a live Cursor account. The double registers its provider only when a session is constructed on the child runtime.

Do not require `cursor/composer-2.5` in CI. A manual `pong` against that model is optional and is not the acceptance gate.

## Success criteria

Developer `agent_run` whose primary target is an extension model uses that model when the extension binds on the child runtime. A genuinely unknown id still falls back only through the existing unavailable classification. No product change outside this boundary.
