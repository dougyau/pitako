# Worker history

Worker history records admitted SDK AgentInstances, including background and Team
workers. Historical managed attempts and diagnosis sessions remain readable as
protected, catalog-only archives. The native Pi JSONL is
the transcript authority. The host catalog records identities, lifecycle evidence,
known capture gaps, and exact cleanup ownership. Neither Hermes search results nor
worker text establish execution closure.

Local foreground RPC hosts can use the [Agent bridge host reference](agent-bridge.md)
for non-consuming worker reads and scoped history. The bridge requires fresh
acknowledgement for raw history and routing, and explicit activation for controls.
Its history scope is narrower than the foreground tools described below.

Team catalog members retain optional `teamId`, `memberId`, and initial `turnId`
from host admission. Later logical turns append their own turn/attempt identity
in the same native history; native request observations carry current turn and
attempt IDs. Repeated roles are distinct members, never a latest-role projection.
Older catalogs and captures without these optional fields remain readable.
A maintained member keeps its invocation unclosed between turns; assignment
close joins SDK disposal before sealing history. Unknown closure stays protected.

## Automatic settled results

Background and Team workers supply their complete captured result automatically
to the live owning conversation after physical settlement, including failed and
cancelled outcomes. Plan/unit and watch metadata are correlation, not delivery
permission. The Coordinator interprets the supplied result; `agent_result` and
`team_result` are optional complete, idempotent diagnostic re-reads. Passive
screen and bridge reads retain their existing bounded pagination and never
acknowledge handoff.

The live motor tracks collection, bookkeeping, delivery, and continuation
separately. An exact committed custom result in the owning active branch proves
incorporation; a subsequent owning turn with it in the branch proves a turn
opportunity, not model processing. Only these observations plus reconciled or
inapplicable bookkeeping set handoff acknowledgement. No read, draft, or void
send supplies that authority. Ledger failure does not hide the full result.
Outstanding failed/cancelled handoffs remain visible beyond ordinary terminal
linger, as pending or blocked rather than waiting for a model fetch.

Recovery is event-driven and bounded to one later attempt per failed operation.
Incorporated content is not resent to recover continuation, and parent abort/error
does not force a new turn. Session retirement fences late effects without
redirecting results. Full text may pressure context or later be compacted;
handoff is not restart recovery, work acceptance, unit completion, or Board
resolution. Historical native worker reads remain independent of this live state.

## List and read

### Head Developer history

Head and local leaf history use the existing catalog and native JSONL authority.
Member `head` metadata links the exterior assignment and Head instance to node,
run, admitted revision and effective revision where known. Confirmed active
scope changes update the bound leaf member and append native provenance.
Head-native `pitako.head` entries record graph, proposal, barrier and finish
observations. These records are diagnostics, not durable DAG replay authority;
private ownership tokens are not model parameters.
Local leaf members name their native Head session as coordinator. Select the
exterior `assignmentId` to list the Head and its leaves together; the ordinary
default foreground-session selector remains unchanged.

The complete exterior result carries an integrated summary or diagnostic failure,
current barrier/evidence references, bounded leaf identities and closure state.
It preserves the Head's own usage separately from aggregate observed usage,
classifier usage, elapsed time and peak active leaf parallelism. Missing values
remain unknown; retries and continuation are not counted as new absolute usage.
It does not copy leaf transcripts or promise model quality or savings.

Head-local `head_wait` returns new events and closed outcomes without polling.
Native `pitako.head.result` offers reconcile against the owning active branch.
An unobserved offer may replay the same envelope ID with a delivery gap, never
silently become a receipt. Ordinary catalog selectors, pagination and native
read contracts below are unchanged.

### Local source checkpoints

Every asynchronous `agent_spawn` and `team_assign` with `role: "developer"`,
`mode: "head"`, and explicit `writes` has checkpoint capability from admission.
No activation field is required. Other roles, modes, synchronous entrypoints,
and leaves do not gain Head checkpoint authority. This does not change any ModelPolicy.
Only the host-bound Head requests staging through `head_checkpoint`; leaves
do not stage or commit independently.

The Head chooses useful quiescent progress points for fast recovery, not a save
per tool. Availability does not automatically create, restart, reset, check out,
or adopt anything. Unsupported repositories refuse creation truthfully.

`head_checkpoint` supports these requests for its own assignment:

```json
{ "action": "create", "expectedRevision": 0, "paths": ["src/example.ts"], "summary": "Save partial implementation", "remaining": ["Review and remaining work"], "limits": ["Checks have not run"], "evidence": [] }
{ "action": "list" }
{ "action": "read", "checkpointId": "CHECKPOINT_ID", "commit": "COMMIT_ID" }
```

Creation accepts 1 to 256 literal relative file paths, not directories or globs.
`summary` is required. `remaining`, `limits`, and `evidence` are required arrays
with at most 32 entries each. All owned writers and operations must be physically
released. Pending nodes are allowed, but product edits still require integration.
An active checkpoint lease blocks writes, admission, graph changes, integration
transitions, and successful finish. Cancellation or unknown closure is not release.

Creation returns one of these statuses:

- `committed` includes `origin`, `ref`, and the versioned `manifest`.
- `refused` includes `checkpointId`, requested `selected` paths, `omitted` paths,
  `rejected` paths with reasons, and overall `reasons`. Any rejected path refuses
  the whole write. A deliberate valid subset needs a new request.
- `uncertain` includes exact `origin`, `ref`, and a `diagnostic`. The ref may
  survive receipt failure. Inspect that identity rather than blindly retrying.

Lease, stale-binding, and revision failures can instead raise tool errors before
creation. List returns records with `assignmentId`, `checkpointId`, `commit`,
and `ref`. The first commit parents admission HEAD or an explicitly adopted
origin. Later commits parent the preceding checkpoint. Only selected eligible
paths change in the saved tree; omitted paths keep their parent version.
Renames require explicit eligible delete/add paths.

The foreground read-only `agent_checkpoints` tool works without a live Head:

```json
{ "action": "list" }
{ "action": "list", "assignmentId": "ASSIGNMENT_ID" }
{ "action": "read", "assignmentId": "ASSIGNMENT_ID", "checkpointId": "CHECKPOINT_ID", "commit": "COMMIT_ID" }
```

It uses the current repository, not a caller-supplied filesystem path. Reusable
source-module exports in `extensions/agent/checkpoints.ts` are
`listCheckpoints(root, assignmentId?)` and
`readCheckpoint(root, origin, agentDir?)`. These are not a package export.
The reader validates actual ref, commit, tree, and manifest relationships.
Read returns `manifest`, cumulative saved-path `current` comparisons with raw
content/mode `matches`, `checkoutDirt`, `checkoutObservationGaps`, and
`historicalEvidence`, separately from `origin`, `ref`, and `commit`.
`manifest.selected`, `omitted`, and cumulative `saved` describe the saved point,
not all current dirt. `historicalEvidence` includes bounded native results,
evidence references, linked members, and `closureGaps`. Its tested source is
`not_recorded`; a historical successful edit or check is not current verification.
Missing history permits inspection with gaps, not adoption.

Explicit new Head continuation adds
`checkpoint_origin: { assignmentId, checkpointId, commit }` to the asynchronous
Developer Head request, without a second activation field.
Before a writable baseline or prompt, the host requires the same repository and
worktree, compatible admission HEAD and real index, exact saved raw content and
mode, compatible configuration, and a new envelope covering all cumulative saved
paths. It also requires positive terminal/disposed closure of the exact
predecessor Head and contributors, with live owners and execution holds reconciled.
Contributing leaves may occupy sealed invocation groups while the execution
group remains open. Missing, mismatched, live, or unknown records refuse adoption.
A ref, terminal status alone, or tool receipt proves neither closure nor acceptance.

The replacement starts a new DAG under new authority. It does not resume sessions,
restore judgments or the ledger, apply a commit, discard dirt, or dispatch
recovery automatically. Initial foreign and ignored paths remain excluded.
Omitted and subsequent dirt stays visible and ineligible under this origin.
Separately justified ordinary work may reconcile it later. Failed or cancelled
but settled contributions can be useful saved work without being accepted.

The supported boundary uses managed public SDK file tools, the known loaded
patch implementation/parser and provenance, and owned finite foreground Bash.
Shell scope is cooperative, not confinement. Daemons, detached or remote writers,
and escaped descendants are unsupported. Arbitrary external writers are not
coordinated. Unsupported writing definitions and unowned composition routes
refuse. Checkpoint Git support also refuses effective executable hooks, signing
requirements, external filters/fsmonitor, lazy-fetch/promisor repositories, and
uncertain configuration or attributes. Bare, unborn, or non-Git repositories
are unavailable. No hooks, signing, or private configuration are bypassed to save.

Commits use a private index and create-only
`refs/pitako/checkpoints/<root-digest>/<assignmentId>/<checkpointId>` refs.
The writer preserves working bytes, HEAD, branch, and real-index bytes/flags.
Private refs are a namespace, not access control. Bounded briefs and native result
excerpts can contain sensitive local material. Local storage grants no remote
publication, acceptance, node satisfaction, or final-verification authority.
No power-loss guarantee or protection against deleted refs is promised.

### Native history requests

The foreground `agent_history` tool supports these requests:

```json
{ "action": "list", "scope": "all", "limit": 20 }
{ "action": "list", "missionId": "MISSION_ID", "limit": 20 }
{ "action": "read", "historyId": "HISTORY_ID", "limit": 20 }
```

The operator command has the same list and read behavior:

```text
/pitako history list --scope all --limit 20
/pitako history list --role-id developer --limit 20
/pitako history list --mission-id MISSION_ID --limit 20
/pitako history read HISTORY_ID --limit 20
```

Without a selector, list uses the current coordinator session. `scope: "all"`
includes records from previous coordinator sessions after restart. Other list
selectors are `coordinatorSessionId`, `assignmentId`, and `instanceId`. Command
flags use hyphenated names, such as `--coordinator-session-id`.

Each page returns `items`, `diagnostics`, and `cursor`. A non-null cursor continues
the same request, with the same selectors and `cursor` or `--cursor TOKEN`.
The default limit is 50 and the maximum is 200. Output also has a byte limit, so
a page can contain fewer items than the requested limit.

List includes member identities, terminal outcomes, capture gaps, and group
closure or protection reasons. Read returns bounded native entry fragments with
base64 `data`. Concatenating the decoded fragments across pages reconstructs the
native bytes. Read does not follow an alias or consult ACP sidecars.
Changed files can invalidate a cursor. Diagnostics distinguish pruned history,
unreadable records, missing files, and incomplete deletion.

History consultation and maintenance are foreground-only. Child role tools do
not grant `agent_history`, and `/pitako history` rejects child callers.
The history commands do not grant source-write or retired mission-control authority.

`read` accepts `source: "worker"` by default, or `source: "coordinator"`.
The coordinator source uses the session identity and file captured in the worker
catalog. It accepts no arbitrary path. It exposes recorded coordinator decisions
and tool calls alongside worker evidence, including older keyed advice records.
Worker pruning does not own coordinator bytes or delete that locator.

## Live observation and input

Foreground `agent_observe` selects one exact active target:

```json
{ "target": { "kind": "background", "instanceId": "INSTANCE_ID" } }
{ "target": { "kind": "team", "assignmentId": "ASSIGNMENT_ID" } }
```

The result includes the original WorkBrief, native `historyId` and `sessionId`,
ordered coalesced activity, interaction receipts, and capture gaps. `after` uses
the returned event cursor. `briefOffset` pages the original WorkBrief. The default
limit is 50 events, the maximum is 200, and each page is at most 32 KiB.
Activity is event evidence, not proof that every event persisted.

`agent_input` accepts that target and observed native identity:

```json
{
  "target": { "kind": "background", "instanceId": "INSTANCE_ID" },
  "historyId": "HISTORY_ID",
  "sessionId": "SESSION_ID",
  "intent": "query",
  "text": "What missing context explains the dependency-debugging detour?"
}
```

`query` requests context. `steer` requests an in-scope correction relative to the
original WorkBrief. Input is a note, never a command or a replacement prompt.
It enters only at a later native steering boundary, after current tools finish.
It does not interrupt a running command. Native replacement requires a fresh
observation. Synchronous `agent_run` is not a live target.

The receipt is not an answer. `queued` means admitted, `handled` means an input
hook consumed the note, and `rejected` means submission was not accepted.
`unconfirmed` reports closure without delivery or answer proof. A candidate
answer mentions the interaction ID, but the host does not judge its adequacy.
Subsequent activity must establish correction. Optional `decisionId` links a
coordinator decision without turning it into authorization or result acceptance.

## Native agent screen

In Pi's interactive terminal, `/pitako agents` opens the scoped worker list.
`/pitako agents INSTANCE_ID` opens that exact worker; unknown IDs remain errors.
Enter opens detail, and Esc backs out of a form or detail before closing the screen.
Closing does not cancel workers. Pi retains its own terminal, footer and status.
RPC/print callers receive bounded text; child callers cannot inspect the parent.

Detail keys `1`–`5` select Brief, Activity, Identity & route, Receipts and Native history.
Arrow keys and Page Up/Down scroll; `n` fetches the next page, `p` restarts the current
section's pages, and `r` refreshes. Live detail refreshes at most once a second.
The original WorkBrief is separate from a Team wrapper. Selected/requested,
activated and observed SDK request facts remain separate; unknown is not inferred.
Route probabilities are displayed as captured, without rerouting or rounding.

`q` opens a context query and `s` opens in-scope steering. Both accept text, not
commands. Input receipts retain their qualified meanings above. `c` requires
typing `yes` and reports a cancellation request, not settled completion.
Unavailable controls report the native/owner reason.

Native history first lists worker metadata. Use `j`/`k` to select a history and Enter
to acknowledge sensitive raw content with `yes`. In Identity & route, `a` requests
the analogous raw-route acknowledgment. Consent belongs to this view, not future
views. Only the current bounded page is retained; there is no background history
stream or transcript cache. Native reads retain physical ordering, branches,
partial-entry and external-artifact limitations. Activity is coalesced event
evidence, not a persistence claim. Without a live binding, Activity explicitly
reports the gap; acknowledged native history remains the transcript authority.

## Persistence and gaps

Catalogs live in `<agentDir>/pitako/worker-history`. Ad-hoc native sessions live
in shallow directories under `<agentDir>/sessions`. Archived native sessions keep
their recorded private canonical directories. Their catalog stores the canonical path.
History list and read recover those records without Hermes, including after
restart or when Hermes excludes a session from indexing.

Pi 1.0.4 writes a native file once a user or assistant message exists. Pitako
uses the public SDK without forcing persistence. An admitted worker can have
catalog evidence but no persisted transcript, or a cancelled pre-assistant
session can retain a user message. File existence is not lifecycle completion.
A confirmed pre-assistant failure is different from an unexplained missing file.

Custom native entries record host provenance and observed selection, result, and
disposal conditions. They do not make the transcript complete. Cancellation,
crashes, provider errors, older admissions, and capture failures can leave gaps.
An allocated path or a missing file does not prove that no work occurred.
Interrupted disposal remains uncertain until authority can establish its state.

## Retention

The user configuration in `<agentDir>/pitako/config.toml` contains this default:

```toml
[worker_history]
ttl_days = 180
```

`ttl_days = false` disables deletion. Foreground session startup performs
cooperative maintenance. The operator commands are:

```text
/pitako history prune --dry-run
/pitako history prune
```

TTL starts at authoritative group closure, not at the last transcript write.
Maintenance protects active, paused, interrupted, unknown, and uncertain groups.
Standalone invocations close only after host settlement and observed disposal.
Execution-bound groups remain protected: there is currently no durable execution
closure proof used by retention. Archived managed groups are always protected, even if recorded as closed or with
interrupted cleanup. Recorded coverage and closure are historical evidence only;
current closure is unknown. No cleanup is resumed and no aliases are removed.

Deletion covers only validated owned native JSONL files, their known ACP
sidecars, and registered exact-target discovery aliases. It does not delete
mission databases, execution ledgers, artifacts, outputs, settings, or arbitrary
files found beneath a directory. A collision or retargeted alias does not grant
permission to overwrite it or delete through it.

Catalogs and private directories use restrictive permissions. Cleanup records
its exact intent before unlinking owned files and retains a compact pruned record.
A crash can leave an incomplete cleanup or an uncertain exclusion lock.
Maintenance reports and protects uncertainty rather than claiming that deletion
finished. Consultation remains available with diagnostics. This is cooperative
retention, not protection against a hostile process with the same user identity.

## Hermes secondary discovery

Pitako bundles unmodified `pi-hermes-memory` 0.9.9. Ordinary producers use standard
native directories. Historical exact-target directory aliases remain untouched;
no new managed aliases are created. Native reads use recorded canonical paths,
not these links.

Ordinary Hermes startup backfill discovers the standard `<agentDir>/sessions`
directories. Its public `session_search` tool searches the independent secondary
index. The installed extension excludes tool results, limits text and search
snippets, and has its own retention. A search hit can outlive native retention,
and native history can exist without a search hit. Search is not a replacement
for native list and read.

The manual `/memory-index-sessions` command has different root selection.
When `PI_CODING_AGENT_SESSION_DIR` is set, the command scans that configured root.
Ordinary backfill still scans `<agentDir>/sessions`. If the roots diverge, manual
indexing can miss worker records that ordinary backfill discovers. Pitako does
not relocate or duplicate aliases into the configured root to hide this
difference. With matching roots, the manual command discovers the same shallow
worker directories.

Hermes does not follow worker provenance anchors to other transcripts.
Anchor traversal and complete transcript reconstruction through search are not
promised. Background Hermes learning can make model calls according to its
configuration. The local compatibility fixture proves discovery and search
without paid calls, not model quality or autonomous worker effectiveness.

## Sensitive records

Raw native history can contain workbriefs, instructions, prompts, tool arguments,
tool results, model output, and paths. Restrictive permissions and retention do
not redact that content. Existing telemetry redaction does not promise transcript
redaction. Hermes's omission of tool results does not make its index free of
sensitive text, and native pruning does not purge Hermes's independent index.

Archived groups expose only recorded catalog members. Mission SQLite is never
opened or inspected: missing or unavailable databases do not block physical reads.
DB-only projected members are no longer discoverable; preserved bytes do not imply
complete catalog coverage. New archive mutation is rejected. Legacy projection-bearing
list cursors are rejected; identity-valid bounded physical read cursors still continue.
Old databases, sidecars, objects, outputs, ACP, aliases, and generated ledgers are
not migrated, recovered, or normalized.

This feature adds no privacy system or cross-store deletion guarantee.


## Consultation evidence and consumption

`/pitako stats consultations [dispatchId]` is a foreground bounded projection over
current coordinator catalog locators and their registered Head descendants. The ID
filters that scope; it never grants access to an arbitrary session path.
`agent_history` read accepts `{action:"read",dispatchId,source:"caller",groupId?,cursor?,limit?}`
for original caller entries, even when preparation produced no worker historyId.
The locator captures the actual caller SessionManager; Head caller and exterior
coordinator are distinct. A locator grants reading, never deletion of caller files.

Version 1 `pitako.consultation` entries distinguish decision, preparation, outcome,
closure, delivery and feedback. Classified decisions retain the complete bounded
request/response, identity, timing and reported usage or explicit absence. A valid
append can remain in memory before the first assistant; only native bytes are a
persistence receipt. The catalog stores a versioned decision reference and real
worker association, not a fictitious member for no-worker preparation.

`pitako.worker-history` result payload version 2 records a result ID, history ID,
target, configured/selected/requested/activated/observed effort, timestamp, bounded
request observations and attempt usage or null. Older payloads remain readable;
missing attribution is unknown. Native assistant usage remains authoritative.
Classifier overhead, worker attempts and authorized linked followups are separate
observations, deduplicated by result IDs. Inclusive Head/descendant overlap makes
a combined total unavailable. Zero catalog pricing does not prove free service.

The existing 32768-byte page/projection budget, 8192-byte fragments and 1..200-entry
pages remain. Stats additionally caps each native prefix scan at 1 MiB, its total
native scan at 4 MiB/32 sources, and descendant listings at 16 Head callers. Omitted
rows, incomplete prefixes and diagnostics are explicit; latest feedback means
latest observed, not necessarily latest persisted when coverage is truncated.
Use paged `agent_history` for records outside this projection, not a supplied path.

`consultation_feedback` is foreground or granted Head only. It requires the exact
incorporated result on the active owner branch and records host-attributed author,
time, usefulness, optional note (4096 UTF-8 bytes), and up to 32 own catalog followup
instances. Offered/draft/getter results do not authorize it. Corrections retain
history; absent feedback is valid. Links establish association, not causal savings,
acceptance, node review or finish verification. Unlinked/external work remains
unattributed. Retention prunes only owned worker files, never referenced caller or
followup sessions through these links.
