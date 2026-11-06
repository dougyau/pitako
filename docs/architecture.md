# Architecture discussions

The [architecture skill](../skills/architecture/SKILL.md) creates or shows a native
mission and launches the named resource `pitako.architecture` (raw script paths
fail). `skills/architecture/workflow.js` owns dispatch and uses the packaged
`pitako.architect` profile for the director and perspective members. Each
consuming gate first runs the model-free `pitako.access-verifier`; consumers then
receive verified references `{ id, path, digest }` and read them, and a
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
continuation. v3 state is not migrated: start a new consultation/mission.
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

Contract v4 stores all model-authored prose only in published native originals.
The verified hash-chain ledger at
`<missionDirectory>/ledger/architecture-<consultation>/`, outside the checkout,
retains admissions, replacements, caller answers/evidence with provenance and
closed rounds. State holds only control skeletons and digest-pinned references,
plus the args-bounded current decision and transient digest-only replacement intention.
Fresh perspectives read their focus and packet in the director original; factual
providers read their doubt by id in the doubts original. Latest caller-context
ledger references remain active in subsequent rounds; each context record chains
earlier active answers/evidence through `priorActive` entries with exact
`{path, digest}`, and those chained records are active too. Foreground reads the
verified doubts/factual originals to ask the human, and the verified memo reference
to read a conclusion (the returned excerpt is only a preview).
D8 uses unrelated state = current stateBytes minus this consultation's retained
entry (conservative measurement); unrelated + derived worst case 108306 <= 262144.
Capacity failure returns blocked with numbers and the action to use a new mission.
The bound includes maximal reference counts, args-bounded decision and digest-only ledgerPending,
control skeletons and measured pretty overhead; it is independent of prose/round
history. Prose has no D4 caps or projection compaction. Eight factual doubts, eight deliberation doubts and
64 human/experiment IDs are checked before confirmation.

Architecture's derived per-consultation bound is 108306 pretty-printed bytes
(<=112 KiB), leaving over 150 KiB for other mission state, including /plan's
initial-context. Artifact root (384 JSON bytes) is stored per original; original relative
paths (160 JSON bytes) must reconstruct exactly the native savedOutputPath. Each
root is derived from that original's native saved path; digest pins, path
normalization and traversal checks protect retained references. Previous-round originals retain only
id/root/path/digest. Run IDs are bounded to 96 JSON bytes, doubt IDs to 32 ASCII
characters, and diagnostics (only for insufficient/failed originals) to 512 JSON
bytes. Associations/native witnesses are stored once per dispatch; compact control
tuples preserve validated logical controls. See the architecture skill for the
bound and retained-state representation.

A pending replacement stores only kind, expectedRevision and canonical SHA-256.
Reentry MUST resubmit the identical complete replacement: matching digest finishes
the idempotent append, saves snapshot/anchor and clears the marker; missing or
different input blocks before any child. A confirmed failed comparison is archived
as a failed ledger round before a caller-requested new prepare, without changing
consumed/valid counts or making failed originals later essentials. Identical replay
reconciles an append/save cut. Native barriers never disappear through archiving.
