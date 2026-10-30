# Engineering layer

Before closing authorized work, foreground guidance and the coding router require
loading and applying `verify-behavior`, as do worker/reviewer profiles and workflow
compliance. Reconstruct material outcomes from the request, accepted decisions and
complete specs before examining the solution, independently of tasks, diff and
tests. Check both correctness and sufficiency: link each outcome to implementation,
current evidence and limits. Investigate material counterexamples; unresolved
material gaps prevent closure. Explain why minor uncertainty cannot compromise the
outcome. Existing reports justify fulfillment and evidence limits, not test counts.
Native discovery/assembly tests demonstrate delivery and readable skill paths,
not a model's semantic judgment or obedience. No new gate or phase is introduced.

Pitako composes Pi rather than replacing its runtime. The package has one
delegation route, pi-subagents, and no execution owner or scheduler of its own.

## Package composition

`package.json` declares resources. `config/stack.json` records required extension
entries for `extensions/stack.ts` to validate at load time.

The order starts with `extensions/index.ts`, the independent official Codex entry,
and `extensions/profile-policy.ts`. The early extension captures the session
profile. The late policy reapplies model-compatible tools after Codex startup
and model changes without taking over upstream hooks.

Navigation uses pi-lsp-client and pi-codegraph. The direct `@nicknisi/pi-ast-grep`
entry adds syntax search and single-file rewrites through an external ast-grep CLI.
Analysis blocks `ast_rewrite` at the call boundary, including previews and
codemode calls, while retaining `ast_search`. Architect, reviewer, and scout
allow only `ast_search`; the worker also allows `ast_rewrite`. These four roles
explicitly load the extension alongside LSP/CodeGraph.
`extensions/todo.ts` adapts rpiv-todo registration to make only `todo` model-only,
available directly to the model but not through codemode.
Upstream persists mutations as session entries for replay.
Board is repository-scoped storage shared by its worktrees.
Web access and pi-subagents are direct upstream entries.
No managed workflow guards wrap TODO or Board.

The owned `extensions/dev-tools/index.ts` factory supplies Git, SSH, Python,
Cargo and resource tools and hooks. Its sampler is the library under
`extensions/resource-sampler/`, not a second extension or external dependency. Prefer covered
deterministic operations, composed through native codemode; keep bash/Python
fallback for uncovered cases. Git queries are not sandboxed: metadata or spilled
output may be written. `git_status` is working changes, not tracked inventory;
structured `git_diff` includes `stat` and the bounded `diff`, with
`fullOutputPath` when truncated. Stat-only requests return an empty `diff`.
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
uses the existing 26 chunk grants and a combined initial inspection/settings
admission, leaving five closing inspections (32 host grants/calls maximum). No arbitrary check
commands or artifact loader are added to host authority. The finite native host
read deadline is not an execution budget. Child spawn capacity is separate;
exhaustion returns incomplete with phase/work/refs, not overrides or renewed slots.


The admitted `pitako.execute.maxCycles` is a positive safe integer (default 3).
Pi global agent-dir `settings.json` is overridden by the designated worktree's
`.pi/settings.json`, never the source/sibling cwd. Invalid settings stop before
a director; no settings are written. The immutable native association freezes
the limit across recovery/settings edits; legacy version-2 records stay fixed
at three without migration. Initial inspection reads neither settings file for
an admitted invocation; incompatible or partial associations are not fresh admission.
Reentry reevaluates a historical own-registration capacity halt only against the
current closing allocation, retaining history and cumulative consumption, not
overriding a native rejection. Reports use `Loop n de max` and consumed/max.
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

New tasks describe one observable `expectedResult`, keeping coordinated code/tests
together while separating independent outcomes. Mandatory
`dependsOn: [{taskId, reason}]` declares necessary justified earlier prerequisites;
`[]` means none, not concurrent-write safety. Admission validates complete shapes,
known unique IDs, nonblank reasons and strict precedence (hence no cycles).
Independent permutations are valid before admission; full admitted definitions
and order are never sorted, split, repaired or backfilled during recovery.
Final verification stays last even with `[]`. Sequential workers receive exact
durably completed direct prerequisite result references from existing results.
Failed/intermediate attempts are excluded. Historical results are not current
checks: workers check relevant assumptions, not automatically every prior gate.
Review/compliance receive plan references and independently cover full specs;
schema cannot prove semantic simplicity or dependency completeness. Correct
completed implementation is not repeated to improve retrospective decomposition.

Future task worktrees start at the candidate HEAD current at their creation,
not a frozen initial HEAD or copied WIP; existing worktrees are not automatically
updated/rebased. Completion or a result reference does not prove integration
into HEAD. Specs, full definitions and order stay immutable while the candidate
evolves; current verification still binds the actual candidate including WIP.
This is design direction only: no worktrees, concurrency, integration engine or
commit policy are implemented here.

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
Reconcile available complete results and Git/WIP before cursor advancement;
otherwise use checkpoint-first restoration, never blind writer redispatch. Positive actual activity/Stop/permission/recovery
barriers matter, not missing historical inventory or universal certificates.

An available complete native original is consumed before optional inspector
fallback. The active root durably records a compact recovery subject/stage,
immutable association, source/query refs, intention and disposition before
querying or advancing. Replay reconciles that exact observation, never launches
a replacement pending query or renews the route by changing keys/paths. Result
admission precedes cursor advancement and the next existing phase actually runs.
Essential persistence failure stops dispatch. This is not a generic resume API
for terminal roots, nor exactly-once external execution.

An unresolved plan observation is not full plan loss. New-plan recovery,
admitted-definition recovery and replay retain its concrete actor, impediment,
required scope/effects expansion and exact references without opening another
director, writer, replacement query or loop slot. Replay observes the retained
query; only genuine loss without a current barrier permits ordinary replanning.

A never-admitted plan is published before structural admission. Only after
settled producer/association and consistent complete links are established can
a useful structural diagnosis reject it. Rejection and the accounted gap share
one essential write; the next budgeted director receives the original reference
and corrective diagnosis. Replay cannot readmit a rejected plan or consume its
slot again; repetition without new corrective input blocks. Optional-cache or
original loss cannot renew that diagnosed route: its halt is essential state.
Native schema failure
needs a usable exact original (possibly recovered), not reconstruction. Existing
capacity, Stop, permission, settlement, identity and persistence barriers remain;
admitted incompatible contracts are not migrated or repaired.

Recovery remains inside the authorized task/stage objective, resources, effects,
permissions and budget. No artifact repair, functional work, extra host grants,
settings changes, replacement root or foreground polling is implied. If an
out-of-scope action is needed, retain evidence and name the actor, impediment
and concrete scope/effects expansion without performing it. Derived report
actions are pending obligations, not necessarily missing human consent or
claims that continuation already started.

Foreground displays existing structured progress and per-loop/final reports:
invocation, loop, phase, task/attempt, work/check-review-compliance including unrun,
pending and next authorized action, original elapsed time including pauses and
attributable deduplicated tokens with partial/unavailable coverage. No polling,
extra models, foreground/private TODO supervision or final validator. Complete
answers fulfillment and no human action/no more loops; partial distinguishes
technical continuation from new authorization. Child timeout is not invocation
cancellation. Publication is separate. Old supervisor replay receives clear rejection;
historical invoke-*, pitako-execution and Git remain untouched. Current human input
uses `unblock:true, resolution:{loop,text}` on the same immutable invocation, not a
bare bypass flag. The root retains the original impediment and current input before
reconstruction; loop 0 denotes request-only state without an invented snapshot.
Ambiguous historical host failure permits fresh bounded read-only reconstruction
under current policy, not a claim to have recovered or settled its failed receipt.
Positive current pertinent activity prevents replacement. Checkpoint restoration
does not require conclusive historical writer settlement.
Analysis/inspector result admission still reconciles exact retained originals;
do not blindly replace their queries. A failed status transport may use the
existing finite inspector route to observe the original complete operation receipt,
not reconstruct it from an agent output or infer closure from missing inventory.
Settled historical interruption or a completed needs-decision outcome can then consume
the next ordinary slot with current human corrective input. Never repeat completed
work, reuse an interrupted producer key, double-apply input, or let it authorize
later interruptions. Current native barriers, scope and essential persistence remain
authoritative. This does not supply generic native root restart support.

## Verification boundary

Tests cover Pitako-owned composition, profile policy, instruction resources,
workflow scripts, Board, and checkout preparation through controlled boundaries.
They do not certify external models, Pi, pi-subagents, T3, CodeGraph, or LSP.
Tests solely for the removed runtime no longer represent product obligations.

See [GATES.md](../GATES.md) for the complete procedure.

Read-only review/compliance protocol rejections can be re-evaluated in the same
invocation after a reader correction, without relaunching their completed producers
or consuming an implementation loop. Findings associate screening assessments by
`findingId`, not literal requirement wording; sources, consequences and verdict
consistency remain required. Originals are never rewritten.

The registered Node inspector reads only exact native producer references already
retained by that invocation's current read-only phase. It delivers complete JSON
from native state or an associated `structuredOutputPath`, rejects conflicting
bodies and producer escapes, and preserves references after a failed observation.
Current Stop, permission and positive pertinent activity barriers still apply.
Unknown historical writer settlement is not a checkpoint-restoration veto. Delivery
shares the existing 26 input grants with the unchanged 39,936-byte spec limit;
every complete escaped JSON envelope must fit 4,096 bytes. Excess transport or
essential persistence stops dispatch rather than truncating evidence or enlarging
native limits. Complete originals stay outside essential mission state.

### Scoped checkpoint artifacts

`extensions/execute-checkpoint.ts` and the separate Node writer entry
`skills/execute/checkpoint.mjs` implement exact-path preimages and immutable
write-ahead effects. They use normal worker authority, not read-only inspector
grants. The registered root saves an associated intention before dispatch;
the bound worker calls registered `checkpoint_create` with `kind:"pre"` and exact
paths before editing, and `kind:"unit"` or permitted pending `kind:"pause"` after
writes settle. The tool resolves real durable context, reuses the same owned
capture/seal operations and returns actual structured artifacts/receipts; it
never confirms results or advances the root cursor. Missing/stale context fails,
identical repeats preserve publications, and analysis/inspector calls remain
nonwriting directly and through codemode. The helper remains the journaled
apply/restore entry. File edits do not reload existing sessions. Artifacts under the
existing transient `.pi/subagents/` area do not alter checkoutEvidence identity.
Restoration retains partial bytes and refuses unrecorded changes, protected
metadata, symlinks, changed HEAD/index and missing/corrupt backups. Its position
projection cannot rewind budget/history or establish current check evidence.
Observations passed by the active caller are not native permission certificates.

### Confirmed checkpoint-first continuation

Capture real affected-file bytes, including previous WIP, before modifying and
bind coherent unit/task/cursor/admitted-progress references. Seal settled unit
writes; durable root result admission confirms the new point. A cooperative
pause may save pending WIP only while native control permits capture, without
extra task edits. Stop/refusal or abrupt loss uses the last confirmed point,
never an invented post-cut capture. Preserve partial bytes before selective
restoration, unrelated changes and confirmed work. Missing/corrupt bytes or real
file conflicts remain gaps; no reset/clean or fabricated backups.

Recovery is checkpoint-first after best-effort pertinent-writer status/stop through
available authorized public operations. Native resume and perfect historical
settlement are not prerequisites; missing receipts, unavailable observers,
inconclusive status and historical IDs alone are not activity. Positive current
pertinent activity is a conflict. Actual native Stop/refusal/permission/capacity
and essential-save barriers remain binding. A recorded Stop requires a real later
human continuation request before effects, never reuse of an old answer.
Restoration never rewinds consumed loops, attempts, admitted results or immutable
originals. Renew evidence invalidated by the restored candidate, then reach pending
work, final checks, review and compliance.

Separately delivered current human amendments remain separate from the admitted
base snapshot/sourceRefs/association. Carry their complete path, SHA-256 and
human-delivery provenance in existing admitted plan shared context and exact
plan/result references. Workers, review and compliance must read/hash the FULL
amendment before affected work or whole-spec assessment and retain that provenance
in results/reasons. Missing/changed bytes are a prerequisite gap, not permission
to replace frozen sources, infer authority from agent text, or renew the budget.
Preserve known unmet historical evidence obligations; new checkpoint observations
do not establish an unavailable historical before-state contrast.
