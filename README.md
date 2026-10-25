# Pitako

Pitako is a TypeScript ESM Pi package for coding sessions. It composes navigation,
editing, context management, memory, TODOs, Board, and pi-subagents. Pi owns models,
providers, and the session runtime.

## Prepare this checkout

Use Node >=22.19.0 and Bun >1.4.2.

```sh
bash scripts/setup.sh
bun run pi
```

The setup script installs checkout dependencies and attempts CodeGraph index
initialization. CodeGraph tools use an existing index and do not initialize or
refresh it themselves. If CodeGraph or an LSP server is unavailable, use the
ordinary read and search tools. See [verification](GATES.md) for the test procedure.

For another project, install the package through Pi's package mechanism. The
package manifest declares its extensions, skills, prompts, and agent profiles.
Do not install those entries a second time as separate Pitako resources.

## Use the coding baseline

`coding` is the default profile. `/pitako profile analysis` disables `edit`,
`write`, `apply_patch`, and `lsp_rename`. Shell remains available, so analysis is
not a sandbox. `--pitako-profile` takes precedence over `PITAKO_PROFILE`.

Pitako selects upstream `apply_patch` on grammar-capable OpenAI models and uses
`edit` and `write` otherwise. The latter tools reject protected `.git`,
`node_modules`, and environment-file paths. This guard does not constrain
upstream `apply_patch` or shell.

Use `/pitako` for profile and skill status, `/todos` for the session task list,
and `/board` for shared topics. Board tools are pull-only. They do not inject
posts into every turn.

Load specialized skills only when they apply. The default collection includes
Ponytail, Caveman, investigation, architecture, review, verification, and
technical-writing guidance. See [the coding router](skills/pitako-coding/SKILL.md).

## Delegate through pi-subagents

Use pi-subagents for authorized delegation. The `architecture` and `review`
skills initiate their scripted workflows. Those scripts dispatch the packaged
`pitako.architect` and `pitako.reviewer` profiles, which perform read-only
reasoning without delegation.

```text
/skill:architecture <decision>
/skill:review <target and requirements>
/skill:pre-pr base=<local-ref>
```

An architecture memo is design advice. A completed review supplies findings,
uncertainties, and coverage, not permission to edit, merge approval, or passing
test evidence. The caller retains scope, authorization, and interpretation.
`pre-pr` reuses the review skill for independent whole-diff review and assesses
local publication readiness without committing or publishing.

See [architecture](docs/architecture.md) and [review](docs/review.md).

## Plan and execute

`/plan <assignment>` uses the packaged Matt Pocock `grilling` procedure, read-only
context providers and architecture with a doubts phase. The foreground obtains
actual human shared-understanding confirmation before writing complete specs at
`.pitako/plans/<id>.md`; it never edits product code or starts execution.

`/execute <id>` selects complete specs local-first across registered worktrees,
binds a native mission explicitly, and permits up to three complete cycles per
explicit invocation. Each fresh read-only director owns its detailed TODO and
delegates every edit/commit to sequential fresh `pitako.worker` increments.
The worker retains normal implementation tools and adds CodeGraph, LSP and the
official model-compatible apply_patch adapter, with edit/write fallback. Only the
director delegates. Each cycle ends with independent whole-spec review; gaps go
to the next fresh director, not an unlimited repair loop.

See the [plan skill](skills/plan/SKILL.md), [execute skill](skills/execute/SKILL.md)
and [migration spec](docs/plan-execute-spec.md) for source selection, native
replay, immutable input snapshots, native activity barriers and targeted human
`/execute <id> --unblock` historical exclusion withdrawal (not verified closure).
Installing 0.82.0 does not prove a running host reloaded it. No provider/model is
pinned and no Pitako usage budget, scheduler or private execution store is added.

## Retired orchestration

Pitako no longer provides AgentInstance, Team, Developer Head, managed
Architect/Reviewer tables, `/task`, or the shared planning/execution engine.
Its worker bridge and historical reader are removed. There are no compatibility
tools or replacement scheduler.

Old configuration, plans, ledgers, histories, and Board bindings
are not resumed, completed, pruned, or migrated by the retired runtime. Loading
the package does not require its former `config.toml` or model policies.

The replacement uses new-contract specs and native missions, not legacy frozen
status or old receipts.

The retirement does not delete user files. Former reservation, fencing,
fallback, delivery, checkpoint, and managed-acceptance guarantees are not
promises of pi-subagents.

## Reference

- [Configuration](docs/configuration.md)
- [Engineering layer](docs/engineering.md)
- [Contributing](AGENTS.md)
- [Verification](GATES.md)
- [Third-party provenance and licenses](THIRD_PARTY.md)

The packaged `pitako.worker` explicitly loads the existing Ponytail skill in
LITE mode: reuse code, avoid speculative abstractions and keep diffs small. This
never reduces assigned specs/scope, weakens required tests or replaces acceptance
criteria. Project instructions and output schemas/reporting take precedence over
generic Ponytail prose/test-minimization preferences; upstream bytes are unchanged.
