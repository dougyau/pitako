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
   principles, plus `architecture-design`, `how`, `why`, and `blast-radius`.
   Each architect loads and applies Ponytail FULL while preserving required boundaries and read-only scope.
   The workflow assigns each child's responsibility and perspective.
   Confirm its effective contract is suitable for read-only analysis without
   delegation. User or project overrides can change the profile. If it is absent,
   reload the installed package before dispatch. Do not substitute another profile,
   change settings, or create agent files to make a discussion work.
4. Supply a complete `currentDecision` snapshot with the decision, desired
   outcome, constraints, non-goals, evidence and open questions. Include active
   human decisions and their exact provenance, plus identified obligations.
   Resolve material ambiguity before dispatch. Arguments persist; omit secrets.
   Choose a stable consultation ID and an explicit native mission for both
   ordinary and planning consultations. Allow only one active entry per
   consultation; mission state is not an atomic caller lock.

## Launch one background workflow

Resolve [workflow.js](workflow.js) beside this installed skill, not against the
project's working directory. Pass its absolute path as `workflow`. Keep `cwd`
at the project being discussed.

```js
subagent({
	workflow: "<absolute skill directory>/workflow.js",
	cwd: "<project root>",
	async: true,
	options: { mission: { title: "Design stream parser limits" } },
	args: {
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

Only the final memo, status, round counts, steering receipts, and native
continuation references return to the foreground conversation. Reports and
challenge packets stay in child sessions and the workflow's native artifacts.
Do not import them unless diagnosis requires it.

Native completion can truncate its preview. Recover only the workflow's returned
value from the cited native result artifact to read the full memo and continuation.
Do not load the child reports to recover that value.

Check the returned `status`, not just process success:

- `completed` includes the director's design memo.
- `blocked` includes a question or limit requiring a user decision.
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

Each handoff names essential originals and why they matter. Children use their
existing readers to recover exact content and validate schema/association.
Fresh sessions need all necessary evidence; resumed sessions reread essentials
lost from accessible context, including after compaction. Previous delivery is
not current access, and an access receipt is not proof of reasoning. Missing,
inaccessible or contradictory essentials block dependent conclusions. Do not
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
can be retained exactly once in existing native state, failed, unpublished and
insufficient, without requiring ready analysis. Mere `structuredOutput`, preview,
error, reference, rejected call without an object, or text lacking a truncation
flag does not prove complete delivery. Do not reconstruct, republish, duplicate,
truncate, erase history or open another store to fit the whole-file 256 KiB
limit. Distinguish non-delivery from unproved completeness.

The caller's concrete single-line `workDescription` supplies readable labels,
explicit phases and first-line task titles for all fresh/resumed producers,
including initial director, doubts, factual providers and relay. Keys remain
stable. Pitako does not rename retained sessions, control every native notice
or view, guarantee artifact retention/recovery, or certify dependencies. The
final memo remains self-contained: decisions, reasons, disagreements, limits
and references, not just paths.

## Continue a consultation

Retain the exact returned version-2 `continuation` (`{version: 2, consultation}`)
and actual mission ID. Both ordinary and planning consultations return this
compact reference, not the retained control state.
Use the same mission, consultation ID and planning mode on reentry. The native
state keeps the phase cursor, producer intentions, terminal evidence, current
revision, original maximum, consumed rounds and valid rounds. Missing,
incompatible or wrong-identity continuations fail before dispatch; duplicate
initial admission is not a restart. Do not migrate old continuations.

For unchanged decisions, omit `currentDecision` and `replacement`; optional
`evidence` is factual data, not a revision or human decision:

```js
subagent({
	workflow: "<absolute skill directory>/workflow.js",
	cwd: "<project root>",
	async: true,
	options: { missionId: "<actual existing mission ID>" },
	args: {
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
stop before another child launch, including the initial director or human relay.
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

Planning launches pitako.interview-relay through the native
supervisor channel concurrently with independent research. Each doubt names
explicit factual prerequisite IDs; only dependent human questions wait for those
facts. The read-only relay does not decide: when its interview_request arrives,
present the ENTIRE supplied frontier to the ACTUAL HUMAN immediately, wait for
their answers, then use subagent_supervisor action reply with that request's
replyTo. Do not answer preferences yourself or wait for unrelated research.
Relay reports/receipts are decision context, not implementation permission or
final confirmation. All launched work is awaited and native references retained.
Prerequisites for each dependent frontier run before later groups or unrelated
facts; its relay is submitted without waiting for the human answer. This delays
some unrelated research to avoid FIFO admission delaying answerable questions,
without a custom priority scheduler or preemption.
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
