# Engineering layer

Pitako composes Pi rather than replacing its runtime. The package has one
delegation route, pi-subagents, and no execution owner or scheduler of its own.

## Package composition

`package.json` declares resources. `config/stack.json` records required extension
entries for `extensions/stack.ts` to validate at load time.

The order starts with `extensions/index.ts`, the independent official Codex entry,
and `extensions/profile-policy.ts`. The early extension captures the session
profile. The late policy reapplies model-compatible tools after Codex startup
and model changes without taking over upstream hooks.

Navigation uses pi-lsp-client and pi-codegraph. `extensions/todo.ts` re-exports
rpiv-todo without changing tool exposure. `todo` is available directly and through
codemode. Upstream persists mutations as session entries for replay.
Board is repository-scoped storage shared by its worktrees.
ACP loads before Hermes. Web access and pi-subagents are direct upstream entries.

ACP keeps Pitako defaults `delegate:false`, `autoUpdate:false`, and
`toolBashDefaultTimeout:0`. Explicit global and project ACP files retain upstream
precedence. No managed workflow guards wrap ACP, TODO, or Board.
All nine packaged profiles explicitly load this `billion-context-pi` adapter and
require its five context tools. Native child required-tool diagnostics report
missing registration. Registration alone does not establish operational
compression after a refusal; disabled, unloadable or refused ACP is an unmet
prerequisite. Preserve upstream refusal and native-compaction stand-down rather
than overriding settings.

The owned `extensions/dev-tools/index.ts` factory supplies Git, SSH, Python,
Cargo and resource tools and hooks. Its sampler is the library under
`extensions/resource-sampler/`, not a second extension or external dependency. Prefer covered
deterministic operations, composed through native codemode; keep bash/Python
fallback for uncovered cases. Git queries are not sandboxed: metadata or spilled
output may be written. `git_status` is working changes, not tracked inventory;
structured `git_diff` is statistics, not a patch/path array.
`file_sha256` is read-only; writer-only `file_sha256_save` hashes and atomically
publishes reusable items JSON in one call. Both share a validation/hash core,
independent of spec-plan inspection. Check structured `ok` and `publication`;
codemode can return structured failures without throwing.

## Profiles and authority

`extensions/profile.ts` owns ordinary session profile selection, not worker
identity. It selects upstream patch tools by model capability and leaves raw
navigation available. Analysis removes known editing tools and introduced
mutators (including locally writing `ssh_pull`, Python/Cargo execution effects
and hash saving) and blocks them at the tool-call boundary, including codemode.
It retains shell, so this is not a sandbox. Child strict allowlists retain
hash queries for read-only roles, saving/full tools for workers, no packaged child delegation and the narrow
interview relay.

`extensions/index.ts` registers only `/pitako`, profile guidance, automatic
ordinary session naming, profile mutation and edit/write protected-path guards. Startup does not
load role policies, complete legacy configuration, create leases, start a
bridge, reconcile executions, or prune histories.

Board authors are session IDs with `pi` as the default. Attribution is not
an authenticated role or execution grant. Ordinary CRUD, pagination, validation,
resource closure, and repository namespace remain active. Existing plan-binding
columns remain in the database schema; their former lifecycle tools are absent.
Their future treatment belongs to the migration of plan and execute.

## Workflow ownership

The architecture and review skills initiate their existing file-backed
pi-subagents workflows. Scripts own dispatch. Directors and participants only
reason about the same supplied problem or target.

The workflows return advice with native references. They do not grant authority,
freeze plans, accept implementation, or reproduce the removed runtime's
reservation, fencing, disposal, fallback, or delivery guarantees.

Ordinary authorized consultation and escalation use `oracle` through
pi-subagents. The `pitako.architect` profile is internal to the architecture
workflow, not a general escalation role.

`pre-pr` reuses the review skill, interprets its complete current-target report,
and retains local checks and publication-readiness rules. It adds no workflow.
Plan and execute compose the same architecture/review contracts. Foreground
planning owns grilling and actual human confirmation. Execute registers one
session-scoped named root resource, replaced/disposed on lifecycle events.
Registration preloads COMPLETE trusted sources: lexical review library marker,
complete shared review source, then execute controller. No slicing, protocol
copy, sandbox imports, nested async helpers or nested workflows are introduced.
The bounded resolver has no discovery I/O; physical registered-root/Git checks
remain launch hooks and host inspection. POSIX quoting and Windows encoded
argument transport retain exact arguments through the Node-hook inspect.mjs loader.

Native mission state binds actual returned missionPath/missionId, invocation,
full immutable specs and designated Git common root. The 39,936-byte snapshot
uses the existing 26 chunk grants, initial inspection, one settings admission and four closing
inspections (32 host grants/calls maximum). No arbitrary check
commands or artifact loader are added to host authority. The finite native host
read deadline is not an execution budget. Child spawn capacity is separate;
exhaustion returns incomplete with phase/work/refs, not overrides or renewed slots.


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

The root consumes one of the admitted loops before each fresh read-only director. That
director publishes the sole schema-bound full loop_plan and ends before workers.
It has no delegation/TODO/supervisor orchestration tools. Sequential ordinary
fresh workers implement only selected tasks and report actual checks/current
candidate including WIP, work done, concrete pending work and causal diagnosis.
Execute sets reads:false/progress:false, supported acceptance suppression with
an explicit duplicate-gate reason, and 14400000 ms per implementation attempt.
Ordinary worker defaults/tools remain unchanged. Useful diagnosed same-task
continuations get new attempt keys; no blind retries or arbitrary attempt quota.

The root invokes the real shared adversarial phases, then exactly one fresh
reviewer-profile full-spec compliance analyst only on clear screening. Both
receive complete specs and the same candidate with no own writer active.
Material gaps end the loop and go to another director; no global repair phase
follows review. Native closing compares the candidate with check/analysis evidence.
Complete requires reasoned fulfillment/current mandatory checks/no material gaps;
the admitted loops without it return partial. Standalone /review remains advisory.

Compact explicit native-state result projections retain exact producer/run,
outputReference/outputArtifactPath/outputPathMapping/artifactPaths and optional
structuredOutputPath. No whole prompts/reports/child objects are duplicated.
The identical active-plan cache is optional within the entire 256 KiB state file;
essential snapshot/frozen descriptor/progress failure stops dispatch, never prunes
history. Exceptional inspector recovery reads original full values via retained
refs only when unavailable directly. Compare full JSON where binding/original
survive. Missing binding uses original in place; conflict forbids edits; optional
artifact loss does not block admitted payload/cache; full loss needs remaining
director or partial. Native replay is not exactly-once/read-only reattachment.
Reconcile settled results and Git/WIP before cursor advancement; never blindly
redispatch unresolved writers. Positive actual activity/Stop/permission/recovery
barriers matter, not missing historical inventory or universal certificates.

Foreground displays existing structured progress and per-loop/final reports:
invocation, loop, phase, task/attempt, work/check-review-compliance including unrun,
pending and next authorized action, original elapsed time including pauses and
attributable deduplicated tokens with partial/unavailable coverage. No polling,
extra models, foreground/private TODO supervision or final validator. Complete
answers fulfillment and no human action/no more loops; partial distinguishes
technical continuation from new authorization. Child timeout is not invocation
cancellation. Publication is separate. Old supervisor replay and --unblock receive
clear rejection; historical invoke-*, pitako-execution and Git remain untouched.

## Verification boundary

Tests cover Pitako-owned composition, profile policy, instruction resources,
workflow scripts, Board, and checkout preparation through controlled boundaries.
They do not certify external models, Pi, ACP, pi-subagents, T3, CodeGraph, or LSP.
Tests solely for the removed runtime no longer represent product obligations.

See [GATES.md](../GATES.md) for the complete procedure.
