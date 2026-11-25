# Architecture discussions

The [architecture skill](../skills/architecture/SKILL.md) creates or shows a native
mission and launches the named resource `pitako.architecture` (raw script paths
fail). `skills/architecture/workflow.js` owns dispatch and uses the packaged
`pitako.architect` profile for the director and perspective members. Each
consuming gate first runs the model-free `pitako.originals-verifier`; consumers then
receive verified references `{ id, path, digest }` for native originals or
`{ id, store, digest }` for caller context. They read store records using
`pitako_store`. A
contradictory or unavailable original blocks the gate with an explanation.
Agents reason about the same complete decision rather than specialist subtasks.

The workflow supports up to ten rounds. Native continuation references preserve
the discussion and consumed round budget. The final result distinguishes
`completed`, `blocked`, `needs-human`, and `failed`, with a memo or frontier,
limits, and native references.

Only the script coordinates the discussion. The agents do not launch workflows
or delegate. A design memo is not implementation authority or review acceptance.
The former `architecture_start/read/control` tools and managed tables are retired.

Callers supply concrete `workDescription` text, not a name extracted from a brief.
New and resumed child requests expose readable labels, explicit phases and a
concrete first task line without changing keys or retained native session names.
Originals use native file-only publication with actual saved-output witnesses;
references alone do not establish access or sufficiency. Exact essential originals
remain recoverable with producing provenance; missing access blocks conclusions.
The final synthesis remains self-contained. See the skill for failed-original
retention limits and distinctions from optional observability.

The skill is the authoritative usage procedure.

All consultations require an explicit mission, stable consultation identity and
complete versioned `currentDecision`. Reentry requires the exact version-4
continuation. Older incompatible formats are not migrated.
A changed decision requires a full associated `replacement` with
the expected revision. It accounts for preserved and replaced obligations and
retains active human content and provenance. Resuming an unchanged decision or
adding facts changes neither the revision nor the original round maximum.
Ambiguous dispatch stops reentry. Only an explicitly authorized selective
terminal factual retry can reconcile planning doubts without another comparison.

Planning uses the same script with native mission-backed consultation counts and
a distinct doubts phase between rounds. Context providers are read-only and
script-dispatched; human preferences return to foreground grilling. Execution
needs use `experiment` doubts with a proposed probe and expected observation;
the foreground runs only authorized probes outside the repository and returns
results as humanAnswers with command/environment/observation provenance.
Successfully published, schema-valid factual status `blocked` remains unresolved,
with status and verified original references in dependent questions' prerequisiteFacts and the
director's evaluation. Native failures still abort. No factualRetry is accepted
while paused; a later round may narrow the fact or raise an experiment.

Contract v4 retains model-authored prose in native originals and closed-round
store records, never mission state. Archived model access items use SQLite row
refs and the item ID within `body.originals`; live path receipts keep their
existing format. Access receipts are no-clobber records in
`access:architecture-<consultation>`, except the completed memo receipt. HUMAN
#4224 keeps that original file, byte for byte, outside the database so it can
witness a restored chain; it is neither indexed nor copied into SQLite.
The verified hash-chain ledger in the cwd-local `.pi/pitako/pitako.db` scope
`arch:<consultation>`
retains admissions, replacements, caller answers/evidence with provenance and
closed rounds. The single `pitako-architecture` mission key holds a closed
16384-byte cursor (including the pretty-printed wrapper): identity, revision
and decision digest, head, round counts, phase, current slots, frontier/context
refs, steering stages and any pending replacement digest. A committed
consultation uses this same key and fences the old writer. Decision bodies,
rosters, native paths and diagnostics are not in the cursor.
Fresh perspectives read their focus and packet in the director original; factual
providers read their doubt by id in the doubts original. Latest caller-context
ledger references remain active in subsequent rounds; each context record chains
earlier active answers/evidence through `priorActive` entries with exact
`{store, digest}`, and those chained records are active too. The ledger
observer reconstructs the current context references at the saved store head.
If the store is lost, the writer verifies native ledger requests and
settlements against that head, restores the chain, and rebinds the context
references. Missing or contradictory native originals cause a terminal
integrity failure without renewing the original round count.
For a completed consultation, the same memo gate can pass under the restored
store. The verifier checks the full restored chain and uses native history to
prove the old receipt's scope, sequences, digests and item identities. Failed
correspondence is a terminal integrity failure. The receipt bytes stay intact,
and `checkReceipt` still rejects the old store ID.
If a store-backed access item is unavailable after the ledger observation, the
current root halts without launching the consumer or publishing a gate receipt.
The existing observer on same-consultation relaunch rechecks the store; the
consumer uses its normal gate after successful rehydration.
For an open rolling round, the same observer checks the challenge original and
native child journal. Reentry before `sending` records a verified unavailable
route as missed without registering the old sibling. A sibling that settles
after the cursor save can be adopted from its matching native settlement and
published original; an unsettled sibling is not redispatched. `sending` without
a verified outcome is unconfirmed and is never resent. A verified outcome
without its sending boundary, a contradiction, or a rejected live transport is
an integrity failure. Steering is persisted in SQLite only at round close.
Foreground reads the
verified doubts/factual originals to ask the human, and the verified memo reference
to read a conclusion (the returned excerpt is only a preview).
Prose has no D4 caps or projection compaction. Eight factual doubts, eight deliberation doubts and
64 human/experiment IDs are checked before confirmation.

Round close empties the dispatch slots; the pinned round record supplies the
previous roster, original references, next director packet or memo, and
steering outcomes. On reentry the existing ledger observer restores this
projection at the saved head and checks each live slot against its matching
native settlement and published digest. It reconstructs the verified path,
phase controls and diagnostics rather than reading them from mission state.
An identical append replay returns the original result; a stale writer adopts
the committed head without applying or acknowledging the rejected operation.
When the tip contains committed human answers after a lost cursor save, relaunch
verifies the answer record's slot and phase basis, restores the open round and
continues evaluation. If a native steering outcome exists but no saved sending
stage proves it, the continuation halts without dispatch.
The observer's receipt is limited to 61440 bytes.

A pending replacement stores only kind, expectedRevision and canonical SHA-256.
Reentry MUST resubmit the identical complete replacement: matching digest finishes
the idempotent append, saves the decision digest and anchor, and clears the marker; missing or
different input blocks before any child. A confirmed failed comparison is archived
as a failed ledger round before a caller-requested new prepare, without changing
consumed/valid counts or making failed originals later essentials. Identical replay
reconciles an append/save cut. Native barriers never disappear through archiving.
