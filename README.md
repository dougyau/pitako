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

### Herdr worktrees

[`.herdr/worktree.toml`](.herdr/worktree.toml) configures Herdr UI to run
`bash scripts/setup-worktree.sh` in new worktrees. Unlike basic setup, this
script requires a current CodeGraph index and reports preparation failures.
Herdr owns script execution and asks for human trust approval.

When `HERDR_ENV=1`, Pitako checks the current checkout at interactive session
startup. If `scripts/setup-worktree.sh` exists but the recommended Herdr setup
entry is missing or different, it suggests the configuration once per session.
Custom setup is not assumed incorrect. Pitako does not edit files, execute setup,
or approve trust. Non-UI sessions and pi-subagents children do not show the notice.
An existing entry does not prove that setup completed in this checkout, and this
hook does not guarantee setup for worktrees created through Git or the daemon CLI.

For another project, install the package through Pi's package mechanism. The
package manifest declares its extensions, skills, prompts, and agent profiles.
Do not install those entries a second time as separate Pitako resources.

## Use the coding baseline

`coding` is the default profile. `/pitako profile analysis` disables `edit`,
`write`, `apply_patch`, `lsp_rename`, hash saving, preview export, and introduced Git/SSH/Python/Cargo
mutators, including nested codemode calls. Shell remains available, so analysis
is not a sandbox. `--pitako-profile` takes precedence over `PITAKO_PROFILE`.

Pitako selects upstream `apply_patch` on grammar-capable OpenAI models and uses
`edit` and `write` otherwise. The latter tools reject protected `.git`,
`node_modules`, and environment-file paths. This guard does not constrain
upstream `apply_patch` or shell.

Use `/pitako` for profile and skill status, `/todos` for the session task list,
and `/board` for shared topics. Board tools are pull-only. They do not inject
posts into every turn.

Pitako also bundles Markdown previews through `/preview` and structured questions
through `ask_user_question`. See [preview settings](docs/configuration.md#previews-and-questions)
for external prerequisites. Mermaid renders in previews independently of Pi's
native inline renderer.

Load specialized skills only when they apply. The default collection includes
Ponytail, Caveman, investigation, architecture, review, verification, and
technical-writing guidance. See [the coding router](skills/pitako-coding/SKILL.md).

Prefer bundled deterministic Git/hash tools for covered operations; compose them
through native codemode and retain bash/Python fallback for uncovered operations.
`git_status` reports working changes, not a tracked inventory; structured
`git_diff` returns statistics, not patches or path arrays. `file_sha256` reads;
authorized writers use `file_sha256_save` to hash and atomically publish reusable
items JSON in one call. Inspect structured `ok` and `publication`, not just text
or absence of an exception.

ACP from `billion-context-pi` is mandatory, including in all nine packaged child
profiles. Missing, disabled, unloadable or refused ACP is an unmet prerequisite,
not a supported ACP-less mode. Preserve explicit user configuration and upstream
refusal/native-compaction guidance; never force-enable it.

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
retains the full immutable snapshot and an explicitly created/opened native
mission's actual missionId/missionPath, and launches one root workflow. Up to
the admitted loops each use a fresh read-only director that publishes one complete
`loop_plan` and ends before sequential fresh `pitako.worker` attempts. The root
owns task/attempt selection, mandatory checks, shared adversarial review and,
only after clear screening, one individual full-spec compliance analyst.


The admitted `pitako.execute.maxCycles` is a positive safe integer (default 3).
Pi global agent-dir `settings.json` is overridden by the designated worktree's
`.pi/settings.json`, never the source/sibling cwd. Invalid settings stop before
a director; no settings are written. The immutable native association freezes
the limit across recovery/settings edits; legacy version-2 records stay fixed
at three without migration. Reports use `Loop n de max` and consumed/max.
Early fulfillment stops; last-slot gaps need a new human invocation. Stop,
permissions, persistence and actual native host/child capacity outrank the limit.
Higher limits grant no extra native capacity. Hash-associated complete inherited
spec refs remain in all phase contexts without enlarging the selected snapshot.
See the execute skill for settings examples, sourceRefs and bounded host grants.

Workers retain normal tools and defaults; execute alone disables private
read/progress diaries and applies four hours per implementation attempt.
Material review/compliance gaps go to the next loop, not a hidden repair loop.
Completion requires full-spec fulfillment, current checks and no material gaps
on the same candidate including WIP. The admitted loops without fulfillment are partial.
Native Stop, permissions/activity and capacity remain barriers; recovery does
not renew slots or blindly redispatch an unresolved writer.

Foreground displays the root's structured progress, per-loop and final reports
without polling, TODO supervision or a final validator. Missing time/token
metrics remain unavailable/partial. Complete means no more loops or human action
needed for fulfillment; publication is separate and never automatic.

See the [plan skill](skills/plan/SKILL.md), [execute skill](skills/execute/SKILL.md)
and [migration spec](docs/plan-execute-spec.md) for immutable association and
exceptional original-full-plan recovery. Obsolete supervisor replay and
`--unblock` are rejected without changing historical records or Git. Installed
pi-subagents 0.83.0 does not prove a running host reloaded it. No models, settings,
capacity overrides, private execution store or replacement scheduler are added.

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
