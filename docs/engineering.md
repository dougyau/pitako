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
codemode calls, while retaining `ast_search`. Architect, reviewer (including
its variants), and scout allow only `ast_search`; the worker also allows
`ast_rewrite`. These profiles load the extension alongside LSP/CodeGraph.
`extensions/todo.ts` is the single Pi entry for the vendored, commit-pinned
rpiv-todo fork in `vendor/rpiv-todo/`. Pi's default tool exposure makes `todo`
available to both the model and codemode. The single
`commit(sessionId, actor, ops)` seam checks ownership and invariants, reduces,
prunes and enforces limits, commits the store, refreshes the foreground overlay,
and appends one `pitako-todo-state` entry `{version: 1, tasks, nextId}` per real
mutation. Reads and no-ops append nothing. Replay also accepts `rpiv-todo-state`
and legacy `todo` toolResults. The entry builds the commit handle and provides
an optional projection registration callback with that handle, keeping consumers
in the same module graph and store instance.
Board is repository-scoped storage shared by its worktrees.
Web access and pi-subagents are direct upstream entries.
`pi-blackhole` is a direct upstream entry for automatic deterministic compaction,
session observational memory, and read-only `recall`. Pitako adds no adapter or
configuration overrides. Background memory workers use configured models;
upstream defaults disable fallback to the session model.
Child profiles retain an empty `extensions:` override to disable ambient
extensions, with their required providers in `subagentOnlyExtensions`.
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
hash queries for read-only roles, saving/full tools for workers, and no packaged child delegation.

`extensions/index.ts` registers only `/pitako`, profile guidance, automatic
ordinary session naming, profile mutation and edit/write protected-path guards. Startup does not
load role policies, complete legacy configuration, create leases, start a
bridge, reconcile executions, or prune histories.

Board authors are session IDs with `pi` as the default. Attribution is not
an authenticated role or execution grant. Ordinary CRUD, pagination, validation,
resource closure, and repository namespace remain active. Existing plan-binding
columns remain in the database schema; their former lifecycle tools are absent.
Their future treatment belongs to the migration of plan and execute.

## Cwd-local workflow store

The foreground and all packaged child profiles load `extensions/pitako-store-tool.ts`.
`pitako_store` is read-only, including analysis and nested codemode calls: it
never creates, repairs or quarantines a store. `head`, `records`, `record`
(by `seq`), `ledger` (record kind `ledger`), `receipts` (kind `receipt`),
`blob` (by SHA-256 `digest`) and `verify` report verified history or
`unavailable` with a store error code. Record reads verify the chain and body
digests; blob reads verify the bytes. `verify` checks SQLite and all record chains.

Supply `scope` for record operations and the cursor's `head` and `storeId`
when inspecting workflow evidence. Omitting `head` explicitly observes the tip.
Each response has at most 50 items and 50 KiB. Items contain base64 byte
fragments: group by `index`, concatenate decoded bytes in `offset` order,
then parse complete JSON records (blobs remain raw bytes). Repeat the original
request merged with `next` until `next` is null. `next` pins the observed
head and store identity, preventing later appends from shifting record pages.
Blob metadata preserves original size and truncation; paging itself discards
no bytes. Missing or corrupt evidence is unavailable, never silently shortened.
For example, call `{op:"records",scope:"exec:example.e0",limit:50}`, then
repeat with its `next` fields. Store access attests byte identity, not reasoning.

`extensions/pitako-store.ts` supplies operation-local SQLite transactions on
`<realpath(cwd)>/.pi/pitako/pitako.db`, using the shared Node/Bun SQLite adapter.
Each worktree owns its database; Board remains global and the backlog remains a
human-editable file. Phase 1 uses the store for `/execute` and integrated review.
Architecture uses it for its ledger and standalone review for its final result.
Gate logs are digest-addressed blobs; `logRef` is the digest for `pitako_store`
`op:"blob"`. Logs above 1 MiB keep exactly 512 KiB from each end, with
`originalSize` and `truncated` recorded. A truncated digest binds both ends
and the original size. Task deltas are `task-delta` records in the execute
epoch; read `body.patch` and any changed-path overflow from the pinned record.
Foreground todo requests and display receipts use `todo:<invocation>` and
cannot advance an execute head. Access-verifier receipts use `access:<namespace>`.
Only the completed architecture memo receipt stays a no-clobber file, as
required by HUMAN #4224 for correspondence after database loss. It is not
copied or indexed in SQLite.

Access receipt items can name a JSON file by `path` or a store record by
`store: {storeId, scope, seq}`. File items keep the same receipt bytes and
canonical JSON digest. For a store item, `digest` is the record-chain digest,
not `bodyDigest`. The verifier matches the cwd-local store identity, finds the
row, verifies the chain and body, then compares `digest`. `access_receipt_verify`
and `access-receipts.mjs check` are read-only. For store items, run them from the
designated worktree; the receipt's location does not select the database.
A missing row reports `unavailable` / `missing-record`; a mismatch reports
`unavailable` / `store-corrupt`. Readers never create or quarantine the store;
execute's deterministic loop-io writer rechecks the failure under its write
lock before quarantine. For ordinary receipts, pass the native mission path,
namespace and gate from the designated worktree. `receiptPath` is for the
architecture memo exception. Canonical receipt bytes still determine the
receipt digest; storage does not change what a successful path item attests.

Execute gate and grouped-close requests identify their settled worker by
`{key, runId}`, not inline knowledge. The deterministic gate reads that exact
producer's native mission artifact references, checks its terminal status and
compares the saved JSON with the native structured-output digest before effects.
Gate receipts retain the original path and SHA-256; grouped replay revalidates
that reference before reusing a marker. Final acceptance has no worker original.

The store uses WAL, `synchronous=FULL`, a 5000 ms busy timeout and
`user_version=1`. Creation appends `/.pi/pitako/` once to the Git-provided
`info/exclude`, using a synced temporary file and atomic replacement. Interrupted
creation can leave an unused temp file, never a persistent exclusion lock. Store
metadata is excluded from checkout fingerprints and checkpoint restoration.
Initialization is decided under `BEGIN IMMEDIATE`, not from file existence:
writers can finish an empty database opened by another creator without quarantine.
Only `meta`, `records`, `blobs` (reserved for gate logs), and `active` exist.
Checkpoint images remain files under `.pi/subagents/checkpoints/`.

Deterministic writers explicitly `activate(scope)` at admission, then use
`commit(scope, expectedHead, opKey, requestDigest, fn)`. The callback and
projection reducer are pure synchronous calculations; all external effects
must finish **before** commit, retaining their own idempotence checks.
Records contain canonical JSON bodies and a verified hash chain. Replay returns
the original result and projection at that record, not the current tip.
`todo:` and `access:` scopes append by key without a head or supersession fence.
Other scopes use their workflow-kind fence and compare-and-swap head.

Readers use `read(scope, cursor.head)` (including `null` for genesis); omitting
the head explicitly observes the tip. `verify()` checks SQLite integrity and
all scope chains. Readers never initialize or quarantine a database. SQLite
may maintain WAL/SHM sidecars even on a read-only connection.
Only deterministic host writers may create, activate, append or recover stores;
model children inspect history through `pitako_store`. The store holds execute,
its integrated review, architecture, and standalone review. `/plan` context
does not write store rows. Checkpoint images remain files.

Busy writers make three attempts, then report transient `store-busy`.
Corruption, incompatible versions, missing identity and cursor-ahead failures
quarantine WAL, SHM, then DB with inode checks, initialize a fresh store and
throw `StoreError` with its new `recovery` identity and quarantine path.
`store-replaced` supplies the observed identity without quarantine; `wrong-cwd`
is explicit and never repaired by moving data. Epoch/budget handling belongs to
the enclosing workflow, not this storage module. No native mission files change.

Inspect without Pi, from the designated worktree (read-only):

```sh
sqlite3 -readonly .pi/pitako/pitako.db \
  'PRAGMA user_version; SELECT * FROM meta; SELECT * FROM active;'
sqlite3 -readonly .pi/pitako/pitako.db \
  "SELECT scope,seq,kind,opKey,digest FROM records ORDER BY scope,seq LIMIT 50;"
sqlite3 -readonly .pi/pitako/pitako.db \
  "SELECT scope,seq,kind FROM records
   WHERE kind='task-delta' OR scope LIKE 'todo:%' OR scope LIKE 'access:%' LIMIT 50;
   SELECT digest,size,originalSize,truncated FROM blobs LIMIT 50;"
```

SQL inspection does not verify the hash chain; use the store reader's `verify()`
for integrity checks or `access_receipt_verify` to recheck an individual receipt.
To inspect a retained execute cursor, use the invocation,
epoch and `head.seq` from `pitako-execute` in native mission state. For example,
for invocation `demo`, epoch 0 and head 42:

```sh
sqlite3 -readonly .pi/pitako/pitako.db \
  "SELECT seq,kind,opKey,digest FROM records
   WHERE scope='exec:demo.e0' AND seq<=42 ORDER BY seq DESC LIMIT 50;"
```

Rows after that point may have committed without a corresponding cursor save.
Neither interface prunes history or migrates old formats.

## Workflow ownership

Architecture and standalone review initiate their existing file-backed
pi-subagents workflows. Scripts own dispatch. Directors and participants only
reason about the same supplied problem or target.

The [architecture](../skills/architecture/SKILL.md) and
[review](../skills/review/SKILL.md) skills own the request, continuation and
evidence contracts. Callers provide a concrete single-line `workDescription`.
New and resumed producers receive readable labels, explicit phases and a concrete
first task line. This includes context providers, initial directors, doubts,
and execute's integrated review. Review angles and initial provider
identities precede the work description. Integrated review uses available
admitted task goals or completed-work descriptions, not just the spec ID.
Its bounded sub-cursor is nested in `pitako-execute`. The shared library receives
the enclosing in-memory loop; `reviewOriginals` uses the existing loop-io call,
not a separate review state key or store-IO child.
Clear/material-gaps review reference conversion and its synthesis pointer share an
enclosing save; replay does not repeat the verifier admission. The closed-loop
archive retains that snapshot before a subsequent loop replaces it.
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
Planning awaits all factual providers in one wave, then pauses in native mission
state with `needs-human` and a by-reference frontier for the foreground human.
Published schema-valid factual `blocked` outputs from successful native runs are
unresolved facts, not round failures; prerequisiteFacts carry their status and
verified factual originals; director-after reads humanContext there as unresolved.
Native failures and publication/access barriers still abort. Execution needs are
`experiment` doubts, never read-only provider tasks. Recommendations identify the
probe and expected observation; the foreground runs only authorized probes outside
the repository and returns results through humanAnswers with provenance.
No factualRetry is accepted while paused; unresolved facts reach evaluation and
may become narrower factual questions or experiments in the next round.
No child waits for human answers. Re-entry uses the exact `continuation` plus
`humanAnswers` with per-ID provenance; continuation alone replays the pause
without model dispatch or mission-state writes, with no expiry. Keep one in-flight run per consultation;
native state is not an atomic lock. Answers are decision context only. Final memos retain material reasons,
disagreement and limits. This adds no summarizer, filesystem capability, profile
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
`inspect.mjs` argument vector. `inspect-initial` uses `process.execPath`,
so the inspecting runtime supports the same SQLite adapter as Pi.

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
Each implementation attempt spends one extra slot on the root checkpoint sealer
(5 per implementation attempt, 4 per verification attempt), and each execute review
spends one `pitako.originals-verifier` slot before synthesis over the four independent
originals (two angles mirrored across two model slots). Measured locally on a real
four-angle review, one verifier process took about 40-50 ms (Node startup about
26 ms) with 33-125 KB of stdin, well under its explicit 1 MiB ceiling; native
dispatch overhead was not measured.

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
continuation authority: recorded Stop/refusal and other human-needed
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
the limit across recovery/settings edits. Initial inspection reads neither settings file for
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
`pitako.compliance` full-spec analyst only on clear screening. Both
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

The same registration owns model-free runtime agents, including
`pitako.execution-ledger`, `pitako.architecture-ledger`, `pitako.review-store`,
`pitako.originals-verifier` and the per-operation `pitako.loop-*` agents.
The latter share `skills/execute/loop-io.mjs`. Retained reviewer and loop-io
producer checks accept legacy names in the same family; receipt digests still
verify the original bytes.
Standalone review normally calls `pitako.review-store` once, at final save. Its sole state key
is `pitako-review`, capped at 16,384 pretty-printed UTF-8 bytes. The writer
reconstructs the outcome from exact native settlements, verifies published
originals and access receipts, and commits one record at `review:<scopeId>`.
The stable operation key replays that record if the terminal cursor save was
lost. A relaunch missing settlements makes one read-only recovery observation
of the exact native journal before dispatch. Recovered results are reused;
a retained Stop holds without further children or a final write. Execute's
integrated review uses `pitako.loop-review-originals` and never invokes
`pitako.review-store`. `/plan` writes no key.

The writer checks on-disk review ownership before committing; the SQLite fence
does not make native `state.set` conditional. If another scope's terminal
cursor is written after COMMIT and no later owner save repairs it, resolve
refuses with a read-only integrity error rather than dispatching or trusting
the clobbered cursor. A different review input can proceed when the unrelated
terminal receipt's store is missing or replaced, without weakening a surviving fence.

Architecture
stores admission, decision replacement, caller context (answers, evidence and
retry authorization), and closed-round records in the cwd-local store's
`arch:<consultation>` scope. Only a committed genesis changes the active
architecture scope. The writer verifies the hash chain even on observation or
replay, and an identical replay returns its original head. It does not stat or
publish a native mission file ledger.
Architecture contract v4 keeps model-authored prose in published originals and
closed-round store records, not mission state. Open-round consumers verify native
paths; archived consumers use `{id, store, digest}` and read that ID within
`body.originals`. The closed `pitako-architecture` cursor is bounded
to 16384 UTF-8 bytes including the pretty-printed state wrapper. It keeps only
the active consultation, decision digest, head, round counts, current phase,
slot refs and stage markers. The observer rehydrates the open phase from native
settlements and published digests at the existing observation boundary, without
relaunching acknowledged model slots. It reads the current decision at the saved
head. The round row also supplies the previous
roster, archived original references, next director packet or memo, and steering
outcomes after the dispatch slots are cleared. Caller answers/evidence/authorization are
ledger context records. Observation recovers their refs at the saved head,
and each context row links its earlier active refs. After store loss, only the
architecture ledger writer can restore these records. It verifies the native
ledger requests and settlements against the saved hash chain, including earlier
recovery receipts and the complete active-context links. Missing originals are a
terminal integrity failure. On rolling-round reentry, the existing observe call
checks the pinned challenge and target settlement without registering a sibling
just to steer. It writes no steering row; the round publication retains the
reconciled outcome. Use `pitako_store` for archived refs; live native originals
still use path receipts. An unavailable store item at the gate halts the root
without launching its consumer or publishing an access receipt. Relaunch uses
the same observer and normal gate key rather than extra deterministic children.
The script computes canonical SHA-256 at confirmation; the next
consuming gate verifies published files. No per-batch pinning children run.
Model prose is uncapped, without projection compaction. Eight factual doubts,
eight deliberation doubts and 64 human/experiment IDs are checked before
confirmation. Essential-save failures leave a diagnosed boundary. A committed
answer row's bounded slot/phase basis permits adoption at relaunch without
redispatch or renewed round counts; other unanchored caller inputs still use
identical-input reconciliation. Basis mismatches and native steering outcomes
without a saved sending stage are terminal integrity failures. Foreground reads verified
frontier originals and memo `{path, digest}` rather than inline prose; continuation
alone returns identical values. Older incompatible formats are not migrated.

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
Final review and compliance both get the committed gate reference and digest,
the bounded per-gate summary (`id`, `status`, `exit`, `ms`, `logRef`),
`after`, `mutated`, and the current-acceptance result, even with no task results.
The block is `null` without a receipt and omits gate tails. Excepted results
remain separate. Replay reconstructs this block from verified committed data.
Complete requires reasoned fulfillment/current mandatory checks/no material gaps;
the admitted loops without it return partial. Standalone /review remains advisory.

Execute v11 saves only `pitako-execute`: one validated cursor of at most
16384 UTF-8 bytes, measured as a pretty-printed single-key JSON object.
It records the committed head, current action, loop position and bounded child
references, with an embedded integrated-review cursor. A new invocation
replaces it; there is no legacy-state migration, pointer or second plan cache.
Plans, task and attempt bodies, checkpoint intents and closed-loop ledger
records live in SQLite. Deterministic operations return an in-memory decision
projection for the current head, with receipt lines bounded to 61440 bytes.
The store commits before the cursor save. Retained readers, `inspect-initial`
and `checkpoint_create` verify the saved head, not the tip; a worker's
checkpoint intent must already be committed at that head.
Three-loop rings retain plan-rejection diagnostics, native closing references
and bounded summaries. Reports, review/compliance and directors receive these
summaries with `{ledgerPath, head}`. Publishers verify the chain via `ledger.mjs`
and return the last three loop summaries, replacing direct director reads
(the director has no shell). Further reads verify against that head; missing or
altered records block. The inspector still reads only supplied exact references.
Plan defects beyond
three loops are not automatically detected; duplicate completions fail at
admission. Loop-owned keys contain `.l<n>.`. Seals add one spawn; fused closing
adds none, retries unpublished output with `.checkout.r<n>`, and never lets
stdin choose the workspace. Older retained states fail explicitly and are not
migrated. Each attempt adds one checkpoint-sealer spawn.
Exceptional inspector recovery reads original full values via retained
refs only when unavailable directly. Compare full JSON where binding/original
survive. Missing binding uses original in place; conflict forbids edits; optional
artifact loss does not block admitted payload/cache; full loss needs remaining
director or partial. Native replay is not exactly-once/read-only reattachment.
Reconcile available complete results and Git/WIP before cursor advancement;
otherwise use checkpoint-first restoration, never blind writer redispatch. Positive actual activity/Stop/permission/recovery
barriers matter, not missing historical inventory or universal certificates.

Relaunch resumes the recorded action. A lost cursor save replays the operation
by key at its committed record or observes the existing native producer by
run ID; it does not repeat settled effects or change a dispatched key's params.
If the first advance committed before any cursor was saved, `inspect-initial`
returns its verified operation reference. Loop-io replays that input under
the deterministic retry key before the first director; settings and timestamps
come from the retained admission, not from a fresh launch.
Every invocation verifies the full hash chain over the retained bytes. A new
store epoch preserves the consumed and maximum loop counts and uses the
`invoke-<invocation>.e<epoch>` child prefix.

Execute-owned analysisDispatch freezes a four-hour reviewer default
(`REVIEWER_TIMEOUT_MS = 14400000`), including resumed final synthesis; workers
default to four hours. Coordinator `args.timeouts` is validated operational config
only, never immutable context/binding/association/hostRequest. Sticky overrides,
empty-object reset and effective values/since reporting precede dispatch by
essential save; existing intentions keep frozen values. Task/final gates use
`max(command.timeoutMs ?? 1800000, gateFloorMs ?? 0)` without backlog mutation.
Gate/close totals are always derived from the frozen task:
`min(2147483647, max(14400000, sum(effective command timeouts) +
(metric ? 1800000 : 0) + 3600000))`.

A native barrier-free timeout yields partial `timeout` with class/key/launchedMs.
Only a strictly greater relevant override and exact terminal producer evidence
allow generation renewal. The verified timeout remains the replay point until
the replacement launch intention is saved.
The cap is three generations per step; final review renews the whole read-only
phase, gates use `.gN`, close retries use `.rN`, and workers use new attempts.
Restoring workers require the exact timed-out writer; other no-evidence cases
still require human renewal. Final acceptance errors remain environment halts,
not timeout retries. Operational input cannot clear Stop, denial, needs-decision,
spawn-budget barriers, or supply HUMAN
text. Native terminal status does not prove subprocess quiescence; timeout/Stop
races and tool deadlines remain limits. One-hour overhead is unmeasured and a
floor increase need not fix overhead timeouts. No installed-copy hotfix changes,
v8 migration, standalone review/pre-pr or director/inspector/non-close timeout
changes are implied. See the [coordinator contract](../skills/execute/SKILL.md#coordinator-timeouts)
for executable input, validation and halt-specific actions.

An integrated review cut before the first replacement launch-intention save
can resume from the retained timeout. After a renewed (`.g2`/`.g3`) prepare
has settled, a cut before the next independent launch-intention save, or
after the renewed independent reviews have settled but before the synthesis
launch-intention save, reports `early-review-replay-gap`. Neither cut admits
a child, relaunches a model, or writes state on reentry. The initial acceptance
replay may not attach originals from a renewed generation (DECISION #4283).

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
cancellation. Publication is separate. Human-needed halts are terminal. After the first COMMIT, a relaunch verifies
and reconstructs the original halt without admitting children or advancing.
Missing or mismatched originals fail integrity. A Stop before the first COMMIT
leaves no Pitako cursor; relaunch starts fresh admission under native permissions.
After a fix or ruling, post it as Board HUMAN and start a new invocation on the
same worktree and backlog. There is no `--unblock` route; launch arguments
`unblock` and `resolution` are rejected by name.
After COMMIT, a host throw without a native original holds on the verified
bounded diagnostic and halted action. Relaunch does not repeat the inspection.
Positive current pertinent activity prevents replacement. Checkpoint restoration
does not require conclusive historical writer settlement.
Analysis/inspector result admission still reconciles exact retained originals;
do not blindly replace their queries. A failed status transport may use the
existing finite inspector route to observe the original complete operation receipt,
not reconstruct it from an agent output or infer closure from missing inventory.
A stopped invocation never consumes another slot on relaunch. Current native
barriers, scope and essential persistence remain authoritative.

## Verification boundary

Tests cover Pitako-owned composition, profile policy, instruction resources,
workflow scripts, Board, and checkout preparation through controlled boundaries.
They do not certify external models, Pi, pi-subagents, T3, CodeGraph, or LSP.
Tests solely for the removed runtime no longer represent product obligations.

See [GATES.md](../GATES.md) for the complete procedure.

After a terminal review/compliance protocol rejection, reader corrections apply
to a new invocation, not to the retained halt. Findings associate screening assessments by
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
advice. No `--force`, silent hash replacement, extra
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
the bound worker writes with `edit`, `write` or `apply_patch`, and the checkpoint
extension's `tool_call` hook durably captures each first-touch preimage and
journals each call before allowing it. After a cooperative worker terminal, the root dispatches the
model-free `pitako.checkpoint-sealer` runtime agent: it verifies the journal,
observes the candidate and writes `unit` or `pause` seal metadata by a fixed table
on the report status. No model chooses the kind or transcribes receipts. The tool
and sealer never confirm results or advance the root cursor. The worker is the
only writer of checkout content; root-dispatched deterministic agents write only
Pitako metadata (seals, ledger records, access receipts). Missing/stale context fails,
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

See [Architecture](architecture.md) for the derived per-consultation state bound,
reference limits and pending replacement recovery.
