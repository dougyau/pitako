# Worker history

Worker history records admitted SDK AgentInstances, including background and Team
workers. Historical managed attempts and diagnosis sessions remain readable as
protected, catalog-only archives. The native Pi JSONL is
the transcript authority. The host catalog records identities, lifecycle evidence,
known capture gaps, and exact cleanup ownership. Neither Hermes search results nor
worker text establish execution closure.

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
