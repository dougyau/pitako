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

## Optional Herdr pane

The optional target is Linux, Herdr **0.9.3**, Bun **1.4.2**, and the compatible
declared Pi peers (tested with **1.0.4**). Install Pitako and its declared peers in
a conventional `node_modules` tree, not via a checkout/Pi alias fallback. For
example, with an existing installation rooted at `/absolute/installation`:

```sh
herdr plugin link /absolute/installation/node_modules/pitako/extensions/herdr/agents-ui
```

That is the **installed package's plugin directory**, not the project cwd or
the package root. Its entrypoint runs Bun from this directory and resolves
`@earendil-works/pi-tui` and other declared peers through the conventional tree.
Herdr and Bun must already be on PATH (or the existing Herdr presence must supply
its executable). Run foreground Pi inside the existing Herdr session. Missing
Herdr, plugin, executable or peer prerequisites produce errors; Pitako does not
install them or start a Herdr server.

```text
/pitako agents pane
/pitako agents pane --control
/pitako agents pane --control --raw-history
/pitako agents pane close
```

Default access is read-only. `--control` grants context query, in-scope steering
and cancellation requests; it is not completion or authorization from a human.
`--raw-history` grants sensitive native history and raw route reads, still requiring
acknowledgment in each view. Either flag may be used independently. Ordinary local
Pi screen authority is unchanged. Repeat with identical flags focuses only the
exact owned returned panel. Changing flags requires explicit close/reopen; client
requests cannot upgrade server-owned grants. Close only targets that owned panel,
including an already gracefully exited panel, and never cancels workers.

Only this explicit interactive foreground command starts the private Unix broker.
Imports, status, child, RPC and Pi-only paths do not start sockets or terminals.
The coordinator captures its Herdr caller/socket, never the currently focused pane.
Launch targets that caller with a right split and no focus. The pane receives only
an absolute descriptor path, not prompts, history or a capability in argv/env/title.
The random runtime directory is mode 0700; descriptor and socket are mode 0600.
The bounded owned descriptor carries a 256-bit capability and owner epoch. This
protects against cross-binding/other users, not hostile same-UID processes or root.
Files and displayed/raw content remain sensitive; permissions do not redact them.

Disconnect retains labeled stale data (owner, last reply time) and disables controls.
An admitted mutation whose acknowledgment is lost has an **unknown outcome**:
neither rejection nor delivery/answer confirmation. Nothing reconnects, retries or
replays automatically. `R` explicitly reconnects to the unchanged descriptor and
reobserves current identities; markers may clarify an outcome, but their absence
is not non-delivery. Retired owners, changed descriptors and restarted epochs require
a new launch, not reuse of stale native selections. There is no exactly-once log.

Frames are bounded to 64KiB, list pages to 50 rows/32KiB, input to 16KiB, and native
history, original brief, route and SDK provenance use bounded on-demand pages.
There is one outstanding request per connection and no outbound transcript stream.
Pane closure settles its screen/read work and restores its own terminal, not Pi's.
Foreground restart/shutdown revokes authority before its first await; accepted
controller, broker and launcher work joins before private files are removed. Failed
launcher settlement retains diagnostics. A disconnected pane can remain visible but
has no authority. Worker settlement and history persistence remain separate facts.

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
