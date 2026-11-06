---
name: architecture
description: Discuss an architectural decision through dynamic perspectives on the same complete problem, using one background pi-subagents scripted workflow and at most ten rounds. Use for architecture, a design council, or contrasting viewpoints without splitting the work.
---

# Architecture

Use only `pi-subagents` for this advisory discussion. Each member considers the
same complete problem through a different, dynamically chosen perspective.
Do not split the work into specialist subtasks. Design advice does not authorize
implementation.

The skill initiates the workflow. Its director and perspective agents only
reason about the supplied problem. `plan` uses this discussion with factual providers and a distinct doubts phase.
An ordinary architecture discussion does not start execution.

## Prepare

1. Enable `subagent` with `subagents_enable({})` if needed.
2. Read the extension guides with `subagent({ action: "guide", options: { topic } })`:
   - `council` for report and execution contracts.
   - `workflows/scripted-workflows` for file-backed background execution.
   - `workflows/advanced-rolling-child-runs` for rolling councils.
   - `workflows/steering-a-workflow-child` for steering receipts.
3. Inspect available profiles with `subagent({ action: "list" })`. The workflow
   uses the packaged `pitako.architect` for its reasoning director and perspective
   members. It supplies CodeGraph, read-only LSP tools, and selected design
   principles, plus `architecture-design`, `how`, `why`, `blast-radius`, and
   `scope-discipline`.
   Each architect loads and applies Ponytail FULL while preserving required boundaries and read-only scope.
   The workflow assigns each child's responsibility and perspective.
   Confirm its effective contract is suitable for read-only analysis without
   delegation. User or project overrides can change the profile. If it is absent,
   reload the installed package before dispatch. Do not substitute another profile,
   change settings, or create agent files to make a discussion work.
4. Supply a complete `currentDecision` snapshot with the decision, desired
   outcome, constraints, non-goals, evidence and open questions. When a reported
   problem motivates it, start the brief with that problem and its minimal fix. Include active
   human decisions and their exact provenance, plus identified obligations.
   Resolve material ambiguity before dispatch. Arguments persist; omit secrets.
   Choose a stable consultation ID and an explicit native mission for both
   ordinary and planning consultations. Allow only one active entry per
   consultation; mission state is not an atomic caller lock.

## Launch one background workflow

Launch the registered named resource `pitako.architecture`, never a script path:
raw paths fail with "launch by name after mission.create". Keep `cwd` at the
project being discussed. First create the mission (or `mission.show` an existing
one) and copy the actual missionId and the exact `Mission record path
(args.missionPath): <path>` line, not the `State:` path:

```js
subagent({ action: "mission.create", cwd: "<project root>",
	options: { mission: { title: "Design stream parser limits" } } })
```

Then launch with the same missionId in args and options:

```js
subagent({
	workflow: "pitako.architecture",
	cwd: "<project root>",
	async: true,
	options: { missionId: "<actual missionId>" },
	args: {
		missionId: "<actual missionId>",
		missionPath: "<actual mission record path>",
		consultation: "stream-parser",
		workDescription: "Stream parser memory limits",
		currentDecision: {
			version: 1,
			brief: "<complete current problem, alternatives, non-goals, evidence and questions>",
			constraints: ["Read-only design advice"],
			obligations: [{ id: "bounded-memory", content: "Bound parser memory", provenance: "<request source>" }],
			humanDecisions: [{ id: "streaming", content: "Keep streaming input", provenance: "<actual human message>" }],
			provenance: "<caller request and source references>"
		},
		maxRounds: 10
	}
})
```

This is the only top-level launch. Return control after admission and let native
completion deliver the result. Do not poll, add a watcher, launch a nested
director, or switch to synchronous execution.

The script owns sequencing and awaits every child. The director only reasons:
it chooses two to four dynamic perspectives, prepares objections, evaluates
reports, and synthesizes. Neither the director nor members delegate. Initial
children use fresh context. Continuations use `resume: lastRunId` without
`agent`, preserving the native child contract.

Resuming an older consultation also preserves its old profile. To use the new
profile instead, start a fresh consultation explicitly. Do not silently replace
a retained child.

The first round uses configuration-object `runs.all` for independent recommendations.
Later rounds use singleton configuration-object `runs.all` with rolling
`Promise.race` coordination. An early report can challenge
still-running peers through awaited `runs.steer`, then the script collects the
remaining results. No child uses `async: true`, which would return an admission
receipt instead of its report.

Never exceed ten rounds, including the initial round. Honor a lower positive
`maxRounds`. Stop earlier when further evidence is unlikely to change the
recommendation. At the cap, preserve unresolved disagreements instead of forcing
agreement. The script rejects an extra round.

## Interpret the result

Final/blocked results carry either a memo or an error. A memo returns as `memo: {path, digest}` plus a short `excerpt`,
status, counts, steering receipts and continuation. The foreground reads the
verified memo file in full; the excerpt is not a substitute. Perspective reports
and packets remain in published originals, not the returned result.

Native completion can truncate its preview. Recover only the workflow's returned
value from the cited native result artifact, then read its verified memo reference.
Do not load the child reports to recover that value.

Check the returned `status`, not just process success:

- `completed` includes the director's design memo.
- `blocked` includes a question or limit requiring a user decision.
- `needs-human` pauses a planning round for foreground human answers (see below).
- `failed` includes a failure and any captured continuation references.

The director compares complete alternatives and records accepted and rejected
arguments with reasons, evidence, uncertainty, and user decisions. Do not use
majority vote as proof. A memo is not independent review, plan freeze, execution
acceptance, or permission to implement.

Steering states `queued`, `delivered`, `missed`, and `failed` describe transport.
They do not prove the model incorporated the challenge. A missed late challenge
does not trigger a retry. Judge the resulting report instead.

## Evidence and presentation

Full reasoning reports request explicit native persistence and `outputMode: "file-only"`. The ordered manifest retains stable original IDs, producing
consultation/revision/phase/producer/key/attempt/run and actual returned
references. Operational resume IDs do not replace original provenance.
Preserve `results[].savedOutputPath`, returned reference objects and textual
`outputReference` paths. Generic artifact references or `structuredOutputPath`
alone do not prove mandatory publication; `runs.status` previews are not originals.

Each consuming gate first dispatches the model-free `pitako.access-verifier` once
over the union of its required originals. The workflow computes canonical
SHA-256 of each complete structured value at confirmation (pure JS UTF-8, sorted
JSON keys), without a pinning child. The next consuming gate verifies that digest and writes a no-clobber receipt under
`<mission>/receipts/architecture-<consultation>/<gate>.json`. Consumers then
receive verified references `{ id, path, digest }` with an instruction to read
each path in full. No model creates, chooses or copies receipts, IDs, paths or
digests. A contradictory or unavailable original blocks the gate before dispatch
with the original, key, path, differing JSON pointers and the action to take;
the workflow never chooses a version. A verifier failure reports that
verification did not run. Fresh sessions need all necessary evidence; resumed
sessions reread essentials lost from accessible context, including after
compaction. A receipt attests content identity, not reasoning. Do not
require universal history rereads or hide contrary non-finding narrative.

Native Stop, interruption, detachment, partial terminal outcomes, child timeout or
nonzero exit override a schema-valid value and prevent dependent dispatch/reentry.
Returned native producer witnesses must agree with the request and producing run.
Retain these outcomes and all returned publication witnesses without rewriting
the original association. Top-level outputSaveError overrides child saved paths;
combined control, publication and essential-save diagnostics remain visible.
Mandatory publication failure remains failure despite inline JSON. Optional
observability failure alone is different when required witnesses and access
survive. A complete identifiable failed/partial original genuinely delivered
can be retained by reference, failed, unpublished and
insufficient, without requiring ready analysis. Mere `structuredOutput`, preview,
error, reference, rejected call without an object, or text lacking a truncation
flag does not prove complete delivery. Do not reconstruct, republish, duplicate,
truncate or erase history to fit capacity. Distinguish non-delivery from unproved
completeness.

Contract v4 keeps all model-authored prose in published originals, never mission
state: packets, perspective focus, memos, doubt questions/decisions/recommendations
and humanContext are read by id from the verified director/doubts/factual files.
The verified hash-chain ledger at
`<missionDirectory>/ledger/architecture-<consultation>/` holds admission, replacements,
caller context (human answers, caller evidence and retry authorization, with original
provenance), and closed rounds. Latest caller-context `{path, digest}` references
chain through each record's `priorActive` references: ALL earlier answers/evidence
remain ACTIVE decision context with their provenance in later prompts, not mere
history or director paraphrases.
State contains bounded control skeletons, per-original artifact roots and
relative paths/digests. The reconstructed absolute path must exactly equal the
native published savedOutputPath. Each root is derived from that original's native
saved path; digest pins, path normalization and traversal checks protect retained
references. Previous/closed-round live originals retain only `{id, artifactRoot, relativePath,
digest}`. Each current association/native witness is stored once in its dispatch;
control tuples/bitmasks expand back to the validated logical controls on reentry.
Only insufficient/failed originals retain diagnostics. The active current decision
is an inline JSON string (at most twice the 16 KiB native args bytes). Dependency
masks expand to factual IDs for prompts/frontiers. Perspectives read their focus
and packet from the director original, never state projections of model prose.

`ledgerPending` is only `{kind: "decision", expectedRevision, digest}`; the digest
is script-computed canonical SHA-256 of the complete replacement. After an
append/save interruption, **resubmit the identical replacement** with the same
continuation. Matching digest completes the append idempotently, saves the new
snapshot/anchor and clears the marker. Omitted or different replacements return
`blocked` with an error before any child, with this resubmission instruction; the marker never
contains replacement prose.

Only one active consultation per mission at a time; D8 does not reserve concurrent consultations.

D8 admission is: unrelated = current `stateBytes` minus this consultation's retained
entry (measured conservatively); unrelated + **108306 bytes (<= 112 KiB)** must be
<= 262144. Otherwise return `blocked` with numbers and use a new mission. This
leaves over 150 KiB for /plan's initial-context and other mission keys. The maximal
pretty-printed skeleton is filled at every tested save point, accounting for JSON
escaping and indentation.
Only discuss controls retain perspectives; their packet roster is cleared before
evaluation, so only one director roster can be populated at once. Nine diagnostic
slots cover eight blocked/failed factual providers plus a failed evaluation.
Pending frontier IDs are stored as a JSON-encoded list, preserving logical IDs
without per-item pretty indentation. A native barrier stops later dispatch.

Structural limits (JSON UTF-8 bytes, including quotes/escaping): artifact root
384, relative original path 160, ledger path 1024, runId 96, diagnostic 512 and
perspective label 128 (also at most 64 characters). Doubt IDs are at most 32 ASCII
characters; generated keys/IDs are bounded to 36/137 characters. Each round permits
8 factual doubts, 64 combined human/experiment IDs and 8 deliberation doubts.
Invalid output fails before confirmation/provider dispatch, with a new-consultation
recovery action. Prose has no D4 character/projection budget or compaction-resume
mechanism. Essential save failures poison the queue and identify the failed
boundary; unconfirmed dispatch must be reconciled, never blindly replayed.
Missing digests have an integrity diagnosis distinct from publication failure.

Before a caller-requested new prepare after a confirmed failed comparison, the
script archives that comparison as a ledger round with `comparison: "failed"`.
Counts are unchanged (no valid round or refunded round); originals/diagnostics
remain reachable in history, not required essentials for later work. An
append/anchor cut reconciles identical bytes before any model child. Stop,
permission and unconfirmed-dispatch barriers are never archived away. Selective
retries replace only their targeted live references/dispatches and retain one
retry authorization skeleton; repeated ceiling synthesis/replacements prune live
controls while retaining their ledger history.

The caller's concrete single-line `workDescription` supplies readable labels,
explicit phases and first-line task titles for all fresh/resumed producers,
including initial director, doubts and factual providers. Keys remain
stable. Pitako does not rename retained sessions, control every native notice
or view, guarantee artifact retention/recovery, or certify dependencies. The
final memo remains self-contained: decisions, reasons, disagreements, limits
and references, not just paths.

## Continue a consultation

Retain the exact returned version-4 `continuation` (`{version: 4, consultation}`)
and actual mission ID. Both ordinary and planning consultations return this
compact reference, not the retained control state.
Use the same mission, consultation ID and planning mode on reentry. The native
state keeps the phase cursor, producer intentions, terminal evidence, current
revision, original maximum, consumed rounds and valid rounds. Missing,
incompatible or wrong-identity continuations fail before dispatch; v3 requires a
new consultation/mission, with no migration. Duplicate
initial admission is not a restart.

For unchanged decisions, omit `currentDecision` and `replacement`; optional
`evidence` is factual data, not a revision or human decision:

```js
subagent({
	workflow: "pitako.architecture",
	cwd: "<project root>",
	async: true,
	options: { missionId: "<actual existing mission ID>" },
	args: {
		missionId: "<actual existing mission ID>",
		missionPath: "<actual mission record path>",
		consultation: "stream-parser",
		workDescription: "Stream parser memory limits",
		continuation: previousResult.continuation,
		evidence: "<new factual evidence and sources, not revised instructions>"
	}
})
```

For a changed decision use that same call with `replacement` instead of
`evidence`. `completeSnapshot` has the full initial `currentDecision` shape;
it is not a patch or a concatenation of past briefs:

```js
const replacement = {
	consultation: "stream-parser",
	expectedRevision: confirmedRevision,
	snapshot: completeSnapshot,
	preservedObligations: ["bounded-memory"],
	replacedObligations: []
};
```

`confirmedRevision` is the current confirmed decision revision (initially 1;
advance it only on confirmed replacement). Do not try to read the revision
from the compact continuation reference; the native state remains authoritative. Every prior obligation must appear exactly once in either
`preservedObligations` (unchanged content/provenance in the snapshot) or
`replacedObligations: [{id, reason, provenance}]`. Preserve every active human
decision's content and provenance. The controller persists the replacement
before dependent work. Structural identity/revision checks do not prove semantic
equivalence or human authority; a director's proposal is not human approval.
Unchanged resume and factual evidence do not increment the revision. History
and contrary originals remain separate from current instructions.

Do not change `maxRounds` on continuation. Failed admitted rounds consume it;
`validRounds` counts rounds with sufficient terminal evidence, admitted once.
No reentry grants an eleventh round. Planning's distinct doubts phase remains
after each round. At the ceiling, reconciliation and synthesis remain possible.
A genuinely different human-authorized ordinary decision may use `newDecision: true`, a new consultation ID and complete `currentDecision`, reusing the prior
director through its continuation but starting fresh members/counts. This flag
is not authority and cannot reset the same consultation; planning requires a
separately authorized new consultation.

If dispatch may have occurred without durable terminal/evidence confirmation,
stop before another child launch, including the initial director.
Correlation IDs and later `reused: true` do not establish safe dispatch or
exactly-once execution. Essential save/capacity failure stops new dispatch and
is not recursively retried. Settle owned work when native controls permit;
report inherited settlement uncertainty and any simultaneous Stop/permission
barrier, rather than advising continuation over it.

Only after prior factual work is known terminal may an explicitly human-authorized
selective retry use the same continuation with:

```js
const factualRetry = {
	consultation: "stream-parser",
	revision: confirmedRevision,
	originalIds: ["<latest insufficient terminal factual original ID>"],
	authorization: { content: "<actual human retry instruction>", provenance: "<human message reference>" }
};
```

Use `planning: true` on this call. Do not combine it with a replacement. It
retries only missing/insufficient factual providers at the retained frontier,
including known terminal non-delivery, keeps sufficient providers, attempts and
counters, and starts no new comparison round. Ambiguous dispatch blocks again;
a further failed attempt needs new authorization targeting that latest attempt.
Do not resend retained full reports in arguments.

### Planning pause and human re-entry

With `planning: true`, all factual providers launch in one awaited wave. Only
once every provider is settled, published and schema-valid, with verified access
and no native barrier, does a human/experiment frontier pause the round.
Status `blocked` from a successfully completed native factual run is an unresolved
fact, not an abort or adequate evidence. Its status and verified original reference accompany
dependent questions; director-after reads humanContext there as unresolved.
Failed prerequisites retain stage `frontier`; only an authorized `factualRetry`
can reconcile them before pausing. There are no partial or withheld frontiers.
Human, experiment and deliberation doubts may depend only on factual doubt IDs. Deliberation
doubts are never dispatched: `director-after-rN` resolves them after the factual
wave and any human answers, matching factual evidence by `doubtId`.

The controller saves stage `awaiting-human` and `pending: { round, revision, ids }`,
then returns `{ status: "needs-human", frontier, rounds, validRounds, continuation }`.
`frontier` contains `consultation`, `revision`, `round`, `original: {path, digest}`
for the doubts original, and question skeletons (`id`, `kind`, `dependsOn`,
`prerequisiteFacts`). Each prerequisite fact has `id`, `key`, `originalId`, `status`
and `original: {path, digest}` for its factual original. The foreground reads the
full `workflow.value` from native `status.json`, not the truncated wake preview,
then reads those verified files in full: recover questions, decisions, recommendations
and common humanContext from the doubts original by id, and humanContext, sources
and limits from factual originals. Ask the actual human the entire frontier in one
grilling round, preserving unresolved facts and provenance.
No child remains alive waiting for a person. The pause has no expiry, survives
restart, does not run `director-after-rN`, and adds no consumed or valid round.
Continuation-only re-entry returns the identical value without model dispatch or
mission-state writes; read-only ledger/access verification can run again.

Providers are read-only and cannot execute code, install tools or measure runtime
behavior. Such unknowns MUST be `experiment` doubts, never provider tasks.
An experiment recommendation states the proposed probe and expected observation.
The foreground runs only authorized experiments outside the repository and
returns the command, environment/version, observed result and source/log provenance
through that ID's humanAnswers entry. If not authorized or not observed, use
`defer` or `unknown`; never invent a result. No retry is accepted while paused:
unresolved blocked facts flow to the next evaluation. If still decision-critical,
the director can ask a narrower factual question or an experiment next round.

Re-enter the SAME named resource, mission and consultation with `planning: true`, the exact
returned `continuation`, and:

```js
const humanAnswers = {
	consultation: "stream-parser",
	revision: pausedResult.frontier.revision,
	round: pausedResult.frontier.round,
	answers: pausedResult.frontier.questions.map(({ id }) => ({
		id,
		disposition: "answer", // or "defer" / "unknown"
		content: "<actual human answer; required for answer>",
		provenance: "<actual human message reference for this ID>"
	}))
};
```

Use actual answers, never inferred preferences. Every pending ID must appear
exactly once, with no extras; all dispositions require nonempty caller provenance.
`defer` and `unknown` remain unresolved. Validation requires the same consultation,
revision and round, with `pending.round === control.round === rounds`, planning
mode and stage `awaiting-human`. It precedes every write. Accepted answers are
published as a ledger context record with per-answer provenance; state keeps only
its digest-pinned reference, clears pending and advances to `evaluate` before
`director-after-rN` runs exactly once. An append/save cut requires identical caller
input to reconcile an unanchored context record; it never silently discards answers. They are actual-human decision context, NOT implementation authority
or final confirmation.

Reject without state/counter changes or child calls: answers outside the paused
stage (including sequential duplicate submissions), wrong identity/revision/round,
missing/extra/duplicate IDs, answers combined with `replacement`, and `evidence`
or `factualRetry` while paused. Replacement alone resets to `prepare`, discards
pending and preserves consumed counters; retain prior human decisions with their
provenance in `snapshot.humanDecisions`.

Native args bounds are 16384 compact UTF-8 bytes, 64 array items, 16 fields per
object and depth 8. More than 64 pending IDs fails explicitly before pausing.
Admission and byte backstops protect the whole-file 256 KiB limit, including the
answer-bearing save; never truncate. Keep at most one in-flight run per consultation: native state has
no atomic caller lock, so concurrent re-entry can duplicate evaluation. Native
Stop, cancellation, permission rejection and ambiguous/unsettled dispatch remain
fatal, not human pauses.

At the ceiling, answer/evidence reconciliation and synthesis-only reentry remain
available; no eleventh perspective round is permitted.

Native retention and resume eligibility are finite. A failed resume stops the
workflow; no fresh-context replacement or model substitution occurs silently.
Report the failure before deciding whether to start a fresh discussion.
Continuation references are data, not a custom session store or authority proof.

On an explicit Stop, request native cancellation of the owning workflow.
Cancellation admission alone does not establish child settlement. Do not launch
a replacement while closure is uncertain.

Fresh context and read-only instructions are not sandbox confinement or
confidentiality. No new scheduler, registry, settings, or session store is added.
