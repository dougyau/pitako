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
refresh it themselves. Pitako installs the TypeScript/JavaScript, Python, and PHP
language servers. Install `rust-analyzer` with your Rust toolchain. See
[language servers](docs/configuration.md#language-servers) for details.
If CodeGraph or an LSP server is unavailable, use the
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

## Update dependencies

The [Update dependencies workflow](.github/workflows/update-dependencies.yml)
runs every Monday at 05:17 UTC and supports manual runs from GitHub Actions.
It updates npm runtime dependencies to exact versions, regenerates `bun.lock`,
and synchronizes stack versions, existing dependency version notices, and
`docs/dependency-releases.json` with exact-version npm release provenance.
Pi host packages, development dependencies, the Git-pinned LSP client,
classic TypeScript and its language-server pins, and vendored skills stay unchanged.

The workflow prepares the checkout and runs `bun run typecheck`, `bun run test`,
and `git diff --check` before creating or updating one dependency PR.
Dependency code runs in a read-only job. Only the separate PR job has write access.
If the PR matches the verified candidate, the workflow requests squash auto-merge.
Failed checks prevent publication and auto-merge. No changes means no new PR.

Enable **Allow GitHub Actions to create and approve pull requests** under
**Settings > Actions > General > Workflow permissions**.
Also enable **Allow auto-merge** and **Allow squash merging** under
**Settings > General > Pull Requests**.
Branch protection requirements still apply; the workflow does not bypass them.
PRs created with `GITHUB_TOKEN` do not trigger other GitHub Actions workflows.
If branch rules require separate PR checks, configure their trigger or an
appropriate bot token before expecting automatic merges.
Passing Pitako's checks does not certify upstream compatibility or licenses.
The workflow does not publish npm releases.

After merging, `pi update --extensions` receives these versions when Pitako is
installed from the updated Git branch. Pinned tags, pinned commits, npm installs,
and local-path installs require their own release or checkout update.

## Use the coding baseline

`coding` is the default profile. `/pitako profile analysis` disables `edit`,
`write`, `apply_patch`, `lsp_rename`, `ast_rewrite`, hash saving, preview export,
and introduced Git/SSH/Python/Cargo
mutators, including nested codemode calls. Shell remains available, so analysis
is not a sandbox. `--pitako-profile` takes precedence over `PITAKO_PROFILE`.

Pitako selects upstream `apply_patch` on grammar-capable OpenAI models and uses
`edit` and `write` otherwise. The latter tools reject protected `.git`,
`node_modules`, and environment-file paths. This guard does not constrain
upstream `apply_patch` or shell.

`@nicknisi/pi-ast-grep` adds `ast_search` for syntax matching and `ast_rewrite`
for single-file replacements. Pitako includes the [ast-grep CLI](https://ast-grep.github.io/)
through `@ast-grep/cli` and adds its bundled binary to Pi's `PATH` when needed.
Rewrites preview by default;
only `dryRun:false` applies changes. Inspect the preview and the resulting diff.
Analysis keeps `ast_search` but blocks all `ast_rewrite` calls, including previews.

Navigation guidance selects LSP for symbol identity, definitions, and references,
CodeGraph for architecture, call chains, and impact, and ast-grep for syntax
patterns. Grep remains the tool for literal text, logs, and configuration. Read
the relevant source after navigation. Unavailable or incomplete backends permit
targeted read/grep fallback; empty results alone do not prove absence.

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

For Rust work, Pitako bundles [BeautifulRust](https://github.com/morganlinton/BeautifulRust)
as three on-demand skills: `rust-best-practices`, `rust-review`, and `rust-port`,
with the best-practices references. Invoke `/skill:rust-best-practices`,
`/skill:rust-review`, or `/skill:rust-port` explicitly when needed.
The worker can discover all three; the read-only reviewer can discover the
best-practices and review skills without gaining Cargo or editing tools.
Existing `cargo_*` tools handle checks, tests, formatting, builds, and dependencies.
The host supplies Rust and `rust-analyzer`. No toolchain or lint configuration
is installed automatically. The active project's verification guide and role
permissions take precedence over upstream command examples.

Prefer bundled deterministic Git/hash tools for covered operations; compose them
through native codemode and retain bash/Python fallback for uncovered operations.
`git_status` reports working changes, not a tracked inventory; structured
`git_diff` returns `stat` and the bounded `diff`, with `fullOutputPath` when
truncated. `stat:true` returns an empty `diff`. `file_sha256` reads;
authorized writers use `file_sha256_save` to hash and atomically publish reusable
items JSON in one call. Inspect structured `ok` and `publication`, not just text
or absence of an exception.

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

Callers supply concrete `workDescription` text for launch titles that identify
the work and phase. Architecture requires a mission, stable consultation ID and
complete `currentDecision`, with explicit continuations and replacements.
Full reasoning originals use native file-only artifacts, with publication
witnesses and access checks, instead of repeated foreground reports.
Final memos are self-contained. Pitako does not uniformly control native notices
or retained session names.

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
See the execute skill for settings examples, sourceRefs and native capacity limits.

New admissions use A1 hybrid capture: synchronous, bounded local-first discovery
in resource resolution embeds the complete spec as JSON data. This preliminary
read is not host-cancellable and is not native admission. One compact native host
receipt independently validates selection/content/physical identity, full source
hashes, designated settings and checkout. Matching bindings precede snapshot and
frozen-budget persistence, then the first director; no cross-file atomicity is
claimed. The 39,936-byte UTF-8 spec limit remains, without packet transport.

Ordinary closing uses a fixed package-owned external CLI observer, not a model:
it ignores stdin and observes actual cwd without rereading the plan. Each close
uses one awaited native child and retains its distinct run/directory/stdout/stderr
references. It consumes no host call; gaps without a proposed close consume no
observation. There is no five-close or inspection-pool model. Native child, tree,
session, concurrency, output, global mission-state (256 KiB) and policy limits
still apply. A limit of ten is accepted unchanged, not a guarantee of ten loops.
Capacity/doctor information is contextual, never reserved capacity; unknown stays
unknown. Essential save failures block protected dispatch/advance, with no promise
of post-Stop persistence, fsync or permanent artifact retention. New admission
support does not migrate retained legacy executions or revive terminal roots.
Blocking diagnostics name the cause/source, available expected/observed identity
and exact evidence, then recommend state-valid reconciliation: intended-source
admission before binding, reliable original restoration plus a human addendum
after binding, or supported native inspection for native barriers. No generic
`--unblock`, forced hash replacement or terminal-root resume is offered.

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
exceptional original-full-plan recovery.

`/execute <spec-id> --unblock` delivers a current human resolution to the same
mission and invocation. Supply the actual answer to the retained question, not
an agent suggestion or a bare flag. Preserve the original question and resolution,
sources, snapshot, WIP and consumed slots; a resolved director decision reaches
the next ordinary budgeted loop, not a relaunch of the completed director.
This is not a bypass, fresh admission or generic root restart.
Technical recovery does not require `--unblock`; supported native root continuation
is limited to eligible interruptions, not a restoration prerequisite. Stop, permissions, activity, capacity and persistence
remain barriers. Obsolete supervisor replay is rejected without changing
historical records or Git. Installed
pi-subagents 0.83.0 does not prove a running host reloaded it. No models, settings,
capacity overrides, private execution store or replacement scheduler are added.

Bound execute writers use registered `checkpoint_create` for pre-write capture,
completed-unit seals and permitted pending-pause seals. It publishes actual WIP
and progress through the existing journal; only durable root result admission
confirms the point. Missing context blocks capture, and file edits do not reload
active sessions. Analysis and inspection remain read-only.

Recovery is checkpoint-first from the last confirmed reconstructible file/progress
point, with best-effort pertinent-writer status/stop. Missing historical receipts
or inconclusive status are not activity; positive current pertinent activity is a
conflict. A recorded Stop requires a real later human continuation request before
effects, never an old answer. Capture affected bytes (including earlier WIP) before
edits and confirm progress on unit admission. Normal pause capture requires native
control; abrupt loss/Stop uses the last confirmed point, not a post-cut backup.
Preserve partial bytes before selective restoration, unrelated changes, confirmed
work and consumed accounting. Renew invalidated checks and reach review/compliance.

New `pitako.execute` admissions can pass multiple worktree-local Markdown
`amendments: [{path, sha256, provenance}]` (default `[]`). Native admission verifies
complete bytes before planning and freezes these references separately from the
base, without renewing budget. Reentry preserves references and rechecks hashes;
all phases receive them through the existing shared context. Human message
ID/timestamp provenance is descriptive, not authentication. See the execute skill
for foreground syntax; the existing resolution route stays unchanged.

Separately delivered current human amendments remain separate from the admitted
base snapshot/sourceRefs/association. They remain effective without replacing base
hashes, renewing the budget or causing a false base-source discrepancy; editing
a frozen source still blocks. Carry their complete path, SHA-256 and
human-delivery provenance in existing admitted plan shared context and exact
plan/result references. Workers, review and compliance must read/hash the FULL
amendment before affected work or whole-spec assessment and retain that provenance
in results/reasons. Missing/changed bytes are a prerequisite gap, not permission
to replace frozen sources, infer authority from agent text, or renew the budget.
Preserve known unmet historical evidence obligations; new checkpoint observations
do not establish an unavailable historical before-state contrast.

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

The packaged architect, execution director and worker load Ponytail in FULL mode:
reuse code, avoid speculative abstractions and choose the simplest complete solution.
Reviewers always apply ponytail-review to correctness, safety, tests and simplicity. This
never reduces assigned specs/scope, weakens required tests or replaces acceptance
criteria. Project instructions and output schemas/reporting take precedence over
generic Ponytail prose/test-minimization preferences; upstream bytes are unchanged.
