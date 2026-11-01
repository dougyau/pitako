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

The [architecture](../skills/architecture/SKILL.md) and
[review](../skills/review/SKILL.md) skills own the request, continuation and
evidence contracts. Callers provide a concrete single-line `workDescription`.
New and resumed producers receive readable labels, explicit phases and a concrete
first task line. This includes context providers, initial directors, doubts,
the relay and execute's integrated review. Review angles and initial provider
identities precede the work description. Integrated review uses available
admitted task goals or completed-work descriptions, not just the spec ID.
These titles do not rename retained sessions or control all native views
or notices.
Architecture requires a complete versioned decision before dispatch. Its skill
defines replacement, reentry and selective factual retry. Execute recovery is
separate.

Reasoning originals use native file-only publication. Ordered manifests retain
publication witnesses, returned references and producing provenance rather than
duplicate reports. `structuredOutputPath` or generic artifact references alone
do not prove required publication. The skills define access checks, retention
of failed originals and the whole-file capacity limit. Missing or contradictory
essentials block dependent conclusions, including after resume. Publication,
delivery, sufficiency, access and optional observability are distinct.
Foreground receives concise supporting context, and the file-blind relay receives
a self-contained frontier. Final memos retain material reasons, disagreement
and limits. This adds no summarizer, phase, filesystem capability, profile
delegation, exactly-once guarantee or dependency certification.

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
The resolver now performs accepted synchronous preliminary discovery I/O, without
host cancellation during the read. Local-first/explicit selection stays in the
designated physical checkout and its registered repository worktrees, never the
installed package checkout or unrelated projects. Invalid oversized candidates
have bounded reads; the complete spec limit remains 39,936 UTF-8 bytes, with no
arbitrary worktree/path count limit. Full content and a small descriptor enter
the preloaded script via `JSON.stringify`, as data, not commands/instructions.
No settings, referenced-source validation or checkout evidence is read at this
preliminary boundary. POSIX quoting/Windows encoded arguments retain the exact
Node-hook `inspect.mjs` argument vector.

One compact native host admission independently rediscovers with the same selectors,
validates every complete source hash, reads designated settings and computes
checkout evidence once. A fixed-order versioned binding covers spec ID, physical
root, canonical common directory, selected source and complete content digest.
The root compares it before any director or snapshot persistence; disagreement
blocks, not automatic recapture. Matching admission persists one complete snapshot,
association, sourceRefs and frozen budget. The receipt stays within 4,096 bytes
without echoing the spec. This is explicit comparison plus required persistence,
not cross-file atomicity or authority from a digest.

New admissions use one initial host operation, no initial child, and one native
child per genuine closing observation. There is no packet transport, inspection
pool or loop-indexed closing-grant ceiling. Gaps without a proposed close consume
no observation. `maxCycles = 10` is accepted unchanged, not clamped or rejected
from a worst-case default child budget; it does not promise ten complete loops.
Native child, tree, session, concurrency, output, state and policy limits remain
real. Report the actual rejection with phase/work/references intact, never skip
required checks or analyses, renew slots or create another mission to evade it.
Available capacity/doctor information retains its provenance: it is context, not
a reservation or guaranteed effective limit. Unknown capacity stays unknown.

The exact native pre-launch fan-out rejection returns `budget-exhausted` after
saving current state, without closing/archiving the loop or spending another slot.
The foreground automatically relaunches the same invocation/mission as a new
top-level run; native resume retains the per-run `maxSubagentSpawnsPerRun` budget
(default 64). Ordinary frozen-source/digest/association reentry reconciles pending
seals, intentions and retries; admitted work is not repeated. Compact rejected-key
evidence licenses only launches the native receipt proves never started, and is
consumed durably before dispatch. An O(1) last-exhaustion marker tracks the latest
admitted seal, ledger count/head and closed loop. Repeated exhaustion without
progress halts for a human because one step needs more spawns than the configured
budget. Progress allows another automatic relaunch. Relaunch supplies no human
continuation or unblock authority: recorded Stop/refusal and other human-needed
barriers return unchanged with no dispatch. Per-seal archiving is unchanged.

Transient non-archive state-save failures (native lock timeout or I/O errno)
retry at most three times with the identical frozen projection and no intervening
effects. Saves are ordered; the native setter freshly reads the merged state
under lock, so a write that committed before throwing is safely rewritten.
Cached `get` cannot confirm disk state. Size-limit, invalid JSON and other
deterministic failures halt immediately; capped failures name the repeated cause.
Fixed pure host reconstruction also retries transient lock/I/O/transport failures
up to three attempts, in order through `inspect-initial`, `inspect-initial.r1`
and `inspect-initial.r2` with byte-identical commands. Unused aliases spend no
host or child capacity. Deterministic failures and observed Stop/refusal/pending
activity never retry; no retry clears a human-needed barrier. Failed reconstruction
retains its repeated cause and cannot silently renew its route.

The admitted `pitako.execute.maxCycles` is a positive safe integer (default 3).
Pi global agent-dir `settings.json` is overridden by the designated worktree's
`.pi/settings.json`, never the source/sibling cwd. Invalid settings stop before
a director; no settings are written. The immutable native association freezes
the limit across recovery/settings edits; legacy version-2 records stay fixed
at three without migration. Initial inspection reads neither settings file for
an admitted invocation; incompatible or partial associations are not fresh admission.
Reports use `Loop n de max` and consumed/max.

Early fulfillment stops; last-slot gaps need a new human invocation. Stop,
permissions, persistence and actual native host/child capacity outrank the limit.
Higher limits grant no extra native capacity. Hash-associated complete inherited
spec refs remain in all phase contexts without enlarging the selected snapshot.
See the execute skill for settings examples, sourceRefs and native capacity limits.

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
The session-scoped `pitako.checkout-observer` is registered outside resolution via
public `registerAgentViaEvents`, using an absolute executable and fixed owned
`observe.mjs` argument vector. Conflict/rejection is an error, not an overwrite or
fallback. It uses no model, delegation or conversational context, consumes
`{expected, body}` on stdin to verify and publish the close ledger record,
and calls `designatedWorkspace`/`checkoutEvidence` on actual cwd without reading
the spec. All stdout is bounded before emission below 65,536 bytes, emitting
complete failure JSON instead of a truncated success.

The root persists invocation/loop/unique-key intention, dispatches singleton
`runs.all` with `output:false`, inline output and effective implicit waiting,
then validates native completion, identity, one JSON output document and
publication. It saves closing evidence before outcome/advance, keeping operation
key, run ID, `asyncDir` and actual `externalAdapter.outputArtifacts` stdout/stderr
references. Missing/invalid/nonterminal output or `outputSaveError` cannot close;
failures retain only fields that exist. Different closes have distinct artifacts.
The predicate remains `sameCandidate && review clear && compliance fulfilled &&
checks current`; observation replaces neither checks/review/compliance nor worker
reports/checkpoint evidence.
Complete requires reasoned fulfillment/current mandatory checks/no material gaps;
the admitted loops without it return partial. Standalone /review remains advisory.

Compact explicit native-state result projections retain exact producer/run,
outputReference/outputArtifactPath/outputPathMapping/artifactPaths and optional
structuredOutputPath. No whole prompts/reports/child objects are duplicated.
The identical active-plan cache is optional within the entire 256 KiB state file;
essential snapshot/frozen descriptor/progress failure stops unsafe dispatch.
Closed-loop history goes to a verified ledger; superseded recovery data is
archived then discarded. New v4 state holds current control/progress and usage
totals, not an accumulating loop array. Full completed results are stored once
per task, with completed attempts referencing them; pending continuations retain
their last result. Closing rebuilds deterministic bytes from immutable source
fields, freezing only mutable usage/resolution inputs.
Three-loop rings retain plan-rejection diagnostics, native closing references
and bounded summaries. Reports, review/compliance and directors receive these
summaries with `{ledgerPath, head}`. Publishers verify the chain via `ledger.mjs`
and return the last three loop summaries, replacing direct director reads
(the director has no shell). Further reads verify against that head; missing or
altered records block. The inspector still reads only supplied exact references.
`--unblock` searches invocation resolutions, last closed disposition, then the
open loop; older closed entries cannot resume or conflict. Plan defects beyond
three loops are not automatically detected; duplicate completions fail at
admission. Loop-owned keys contain `.l<n>.`. Seals add one spawn; fused closing
adds none, retries unpublished output with `.checkout.r<n>`, and never lets
stdin choose the workspace. Retained v2/v3 states are not migrated.
Exceptional inspector recovery reads original full values via retained
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

For newly bound invocations, resource expansion carries exact retained read-only
originals as inert data, separately from the full spec. Native admission
independently recomputes their projection digest; a difference blocks before
consumption. Only already-associated current-loop producers qualify, including
pending recovery inspectors; conflicting bodies or producer escapes are rejected.
The compact admission receipt carries the comparison digest and applicable
checkpoint observation, not complete originals. Ordinary cwd-only closing does
not deliver recovery payloads. `inspectionSnapshot` and unrelated inspector
consumers remain available. This path does not migrate or revive legacy roots.
Complete originals stay outside essential mission state. Required originals that
remain unavailable are evidence gaps, not permission to reconstruct from previews;
optional witness loss alone does not block a surviving authoritative original.
Comparison or essential-save failure prevents admission, never truncates evidence
or silently recaptures it.

### Actionable blocking diagnostics

Keep the actual cause/input, expected and observed identity/version where
available, and exact evidence references; explicitly mark unavailable observations.
Before admission, reconcile ambiguous selection, missing/read/size errors or a
disputed version, then explicitly prepare admission with the intended source.
Do not label every failure a hash mismatch or automatically select newer bytes.
After admission, preserve the original snapshot and frozen source hashes: restore
exact bytes from a reliable original, and deliver desired changes as explicit
human addenda. Without reliable originals remain blocked/partial; a revised
assignment and new admission require actual human authorization.

Retain concurrent barriers. Native Stop, rejection, uncertain activity and
essential-save failure need their supported native inspection/reconciliation
route; correcting a source cannot override them. For terminal roots, inspect
retained evidence and report only operations valid for that state, never resume
advice or a generic `--unblock`. No `--force`, silent hash replacement, extra
arbitrary approvals or restart that erases consumed work is supported.

Self-resolvable failures retry automatically; halts require human-needed
conditions, including actual native barriers or integrity conflicts, not ordinary
technical reconstruction. The mission-state limit is global, currently 256 KiB. Essential saves precede
protected dispatch/advance; no post-Stop save, fsync or permanent artifact-retention
guarantee is added.

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
