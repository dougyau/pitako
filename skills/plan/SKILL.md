---
name: plan
description: Turn an authorized planning conversation into complete spec-plans using packaged grilling, factual context providers, and architecture with doubts between rounds. Never implements product code.
---

# Plan

Planning permission is not implementation permission. Use only pi-subagents for
these delegates. Read the packaged [grilling procedure](../grilling/SKILL.md)
in full and follow it exactly. The FOREGROUND session asks and waits for actual
human answers; a child, mission, JSON field, copied envelope or wake cannot
confirm shared understanding. Do not send that confirmation question to a child.

## Establish context

Enable subagent if needed and inspect effective profiles with action list:
pitako.scout, pitako.researcher, pitako.evidence-auditor and pitako.architect must
remain read-only and non-delegating. Overrides can change them; missing or
unsuitable profiles block, not authorize configuration or installation changes.
Read native scripted-workflow and mission guides. Use configured Pi models.

Resolve installed skill paths, not paths relative to the implementation checkout.
Choose and validate an ID (`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`) and designated
absolute Git worktree root. Run the packaged [inspect.mjs](../execute/inspect.mjs)
entry with Node >=22.19.0 and argument vector
`[absoluteInspectorEntry, root, id, "", "root"]` (or a safely quoted equivalent),
never shell-interpolated paths. It validates canonical common directory/registered
roots. Its narrow loader runs the shared TypeScript inspector even under
node_modules; do not launch inspect.ts directly with native type stripping.
This root-only inspection needs no existing commit; execution's separate
checkout-evidence inspection still does.
No unrelated/global scan or installed-Pitako-root substitution is permitted.

List existing foreground TODOs; create pending context, clarification,
architecture and materialization stages. Preserve unrelated entries and keep
only one in_progress. Write a complete conversation/source brief without secrets.
Begin it with the scope anchor: the original problem as reported (symptom and
human message reference), its known or suspected cause, and the minimal fix that
would resolve it (areas or files). Carry this anchor unchanged into every later
brief, architecture snapshot, confirmation and spec.
Launch one background file-backed context workflow at the absolute
[context.js](context.js) path with `args: { brief, workDescription: "<concrete single-line work>", consultation: "<stable-id>" }`, `cwd` at the designated
root, `async: true`, and explicit `options: { mission: { title: "Plan <id>" } }`.
This dispatches initial independent Scout and researcher evidence. Return control
after admission; interpret the full native returned value, not its preview.
A failure or missing evidence is a blocker to the decisions that depend on it.

## Grill, deliberate, resolve doubts

Map the decision tree and ask the ENTIRE currently unblocked frontier each
round, numbered with recommended answers; word every question so yes accepts
that recommendation. Wait for actual human answers. During initial grilling a factual investigation
blocks only its dependent questions, not the rest of the frontier. Architecture
rounds use the full-provider pause boundary below. Never ask
the human to research facts you can obtain through a read-only provider.

Classify each question as a clarification of the original problem or an
expansion: any requirement, guarantee, surface, source or recovery beyond the
minimal fix. Mark an expansion `➕ Expansion`, state its estimated cost (areas,
surfaces and acceptance criteria it adds) and recommend the minimal option unless
the human already requested that expansion, so a yes never adds scope nobody
requested. A blanket answer ("yes to all") does not accept an expansion whose
recommendation is not the minimal option; ask for it by number. Re-ask an
unanswered or off-topic question unchanged; do not reverse its recommendation in
a later round. Do not present an expansion as a correction of facts. Repository
principles (for example AGENTS.md) constrain how the work is done; they do not
create requirements unless the human asks for them.

Use the concise provider facts, reasons, contradictions, limits, pending
questions and sources for grilling; full originals remain separately recoverable.
Missing access blocks dependent conclusions; the context handoff does not claim
foreground access was observed or require another acknowledgement phase.
Feed the complete assignment, material evidence (including contradictions),
settled human decisions/provenance and remaining questions to the registered
named resource `pitako.architecture` (see the [architecture skill](../architecture/SKILL.md));
raw script paths fail. Run `mission.show` for the planning mission and copy the
exact `Mission record path (args.missionPath): <path>` line. Launch it in background
with `workflow: "pitako.architecture"`, `args: { currentDecision, workDescription: "<concrete single-line work>", planning: true, consultation: "<stable-id>", maxRounds: 10, missionId: "<planning-mission-id>", missionPath: "<planning mission record path>" }`
and explicit `options: { missionId: "<planning-mission-id>" }` in the same cwd.
Plan semantics are unchanged; only the launch is by name.
Do not invent runs.workflow, import/fs APIs or child agentOverrides.

Build `currentDecision` using the complete version-1 snapshot shape in the
[architecture skill](../architecture/SKILL.md): brief, constraints, identified
obligations, active human decisions and provenance. Put the scope anchor first
in its brief and give each obligation's origin (human, agent-accepted, repo or
derived). Do not pass `brief` as an
architecture argument. Both initial providers and the first director receive
the caller description; it is not extracted from administrative prompt text.

The script owns dispatch. After EACH architecture round it runs a distinct
doubts phase: local unknowns to Scout, external contracts to researcher,
uncertain/conflicting claims to evidence-auditor, human preferences back here,
execution needs to experiment questions back here, and adequately evidenced design
disagreements back to deliberation. Providers are read-only: never ask them to run
code, install anything or measure execution. Experiments require a recommendation
with the proposed probe and expected observation. Previous-round reports
and contrary evidence reach fresh perspectives, not only the director's view;
older rounds remain in verified ledger history rather than accumulating in state.
Participants reason on the whole design; they never delegate.

On `needs-human`, the architecture round has paused in native mission state after
ALL factual providers settled in one awaited wave with published, schema-valid
answers and verified access. A native-success answer with status `blocked` is an
unresolved fact, not a failed delivery: its status and verified original reference remain in
dependent questions' prerequisiteFacts. Native failures still abort; terminal
failed prerequisite research requires human-authorized `factualRetry` before a
pause. No child waits for a person. Read the full returned value from
`status.json` at `workflow.value`; the completion wake preview is truncated.
Ask the ACTUAL HUMAN the ENTIRE frontier in one round using the grilling format:
number questions with recommendations and word them so yes accepts the recommendation.
Apply the expansion rules above to every architecture question.
Read `frontier.original: {path, digest}` (the verified doubts original) in full;
match each question skeleton by id to recover question, decision, recommendation
and common humanContext. Read each prerequisite fact's `original: {path, digest}`
in full for humanContext, facts, reasons, contradictions, limits and sources. Never answer preferences yourself.
Record actual per-ID human provenance, including explicit deferrals or unknowns.
A human yes to an agent recommendation is agent-accepted origin, not a human request.
Questions carry `kind: human | experiment`. For experiments the foreground runs
only authorized probes outside the repository; return the actual command,
environment/version, observation and source/log provenance as the experiment ID's
humanAnswers content/provenance. Otherwise defer or mark unknown. This is not
permission for a child to execute or for the foreground to modify product files.

Re-enter the SAME named resource, consultation, mission and `planning: true` with the exact
returned `continuation` plus `humanAnswers: { consultation, revision, round, answers }`.
Take revision and round from the returned frontier; each answer is
`{ id, disposition: "answer" | "defer" | "unknown", content, provenance }`.
Content is required for `answer`; provenance is required for every ID. Cover the
exact pending ID set once with no extras. See the architecture skill for the full
shape, native payload bounds and rejection rules. Do not combine answers with a
replacement or send `evidence`/`factualRetry` while paused. Continuation alone
returns the same frontier without model dispatch or state writes (read-only
verification may run); the pause has no expiry and
survives restart. Keep at most one in-flight run per consultation, including
re-entry: native mission state is not an atomic lock against concurrent submissions.
Answers and caller evidence are ledger records with digest-pinned references carried
to later-round prompts with their original provenance, not director paraphrases.
Final/blocked results carry either a memo or an error. For results carrying a memo, read `memo: {path, digest}` in full; `excerpt` is only a
short preview. Continuation alone returns the identical memo result.
Answers are decision context only, not permission to implement/materialize and
never final actual-human confirmation. Deferrals and unknowns remain unresolved.
Blocked facts also remain unresolved in director-after. Do not retry while paused;
the director can raise a narrower factual doubt or an experiment next round.
A pause adds no round; even at round ten answers lead only to finish or blocked.
Native Stop, cancellation, permission rejection and ambiguous/unsettled dispatch
remain fatal, not `needs-human`.

Outside the paused stage, for useful further factual evidence invoke the SAME named resource,
consultation ID, `planning: true` and mission with the exact returned version-4
`continuation`. For unchanged instructions use `evidence` for factual input;
for changed instructions use an explicit complete `replacement` with consultation,
expected current revision and preserved/replaced obligations, as documented in
architecture. Preserve active human decisions and provenance; never concatenate
briefs or silently patch instructions. Resume/evidence alone does not increment
revision. The bounded planning continuation selects phase/evidence/counters in
native state; it contains only version and consultation, not current revision.
Retain the confirmed decision revision separately. Do not resend retained reports.
Stop on ambiguous dispatch before another launch. Only explicit human-authorized
`factualRetry` of known terminal missing/insufficient providers may reconcile
that frontier without another comparison round; preserve sufficient providers,
attempts and counters. Missing/incompatible state is not a new consultation. Native mission
state retains consumed rounds, including failed
rounds; ten is the TOTAL ceiling across this consultation. Do not reset counts,
omit its mission, use newDecision or choose a new ID for trivial reentry. Start
a new consultation only for an actually different human-authorized decision.
Repeated arguments without actionable progress do not warrant more rounds.
At the ceiling preserve unresolved blockers; never force readiness. Native
retention/resume failure is reported, not silently replaced.

## Human confirmation, then materialization

Only when the frontier is empty and material doubts are resolved, present the
complete shared understanding (original problem and minimal fix, objective,
scope, exclusions, behavior, constraints, decisions/reasons, acceptance and
verification), not a delta of a previous version. Include a scope balance: the
minimal fix versus the proposed plan (areas, surfaces, acceptance criteria and
approximate size), and list separately every requirement of agent-accepted, repo
or derived origin. Offer the minimal fix only, the fix plus a chosen subset, or
the full plan. When confirmed guarantees go beyond the minimal fix, write the fix
as spec `<id>` and the additional guarantees as a separate spec `<id>-extra`, so
the fix can be executed and published first. Ask the ACTUAL
HUMAN to confirm it, then wait. Neither an earlier request to plan nor any
`approved: true` claim is this confirmation. If a material gap appears while
writing, return to clarification and confirmation rather than invent a decision.

After that actual confirmation, the foreground may write ONLY the confirmed
`<designated-root>/.pitako/plans/<id>.md` (and `<id>-extra.md`; both IDs must be
valid), never product files or automatic
execution. Do not overwrite a different existing assignment without permission.
Use this new contract (each section needs substantive content; explicit None is
valid for exclusions or non-blocking uncertainty):

    ---
    pitako-spec: 2
    id: <id>
    status: complete
    ---
    # <assignment title>
    ## Original problem
    ## Objective
    ## Scope
    ## Exclusions
    ## Expected behavior
    ## Constraints
    ## Decisions and reasons
    ## Acceptance criteria
    ## Verification
    ## Source context
    ## Non-blocking uncertainty

Original problem states the reported symptom with its human reference, the known
cause and the minimal fix, and ends with a `Verified by: #n[, #m]` line naming the
acceptance criteria that demonstrate the fix; an `<id>-extra` spec uses
`Verified by: spec <id>` instead. Acceptance criteria are a numbered list whose
items each carry `[origin: human <ref>]`, `[origin: agent-accepted <ref>]`,
`[origin: repo <rule>]` or `[origin: derived #k]`; tag Scope and Constraints
items the same way.

Include source context sufficient for a fresh execution agent, relevant
versions/links and real decisions with reasons, not a fixed implementation TODO.
The header denotes document completeness, NOT authenticated human authority.
The packaged inspector validates shape (including the v2 anchor and origin tags),
ID and resolved paths after writing;
semantic completeness remains a reasoning/review responsibility. The native
snapshot boundary is at most 39,936 UTF-8 bytes; link shared docs when needed,
never truncate an assignment to pass validation. Never shorten Original problem
to fit; near the limit, first offer the human a scope cut or the `-extra` spec.

Return the source path, native evidence references and any non-blocking limits.
Do not claim a frozen legacy plan, implementation, passing checks or acceptance.
On actual user Stop use native cancellation; do not start replacements while
child settlement is uncertain. No historical engine or Board binding is resumed.

### Architecture mission capacity and interrupted replacements

Only one active consultation per mission at a time; D8 does not reserve concurrent consultations.

Architecture reserves a derived **108306 pretty-printed bytes (<=112 KiB)** per
consultation, rather than nearly the whole 256 KiB mission. The real initial-context
reference envelope and consultation can coexist; genuinely oversized unrelated
mission state still blocks before model dispatch. Roots are derived per original
from the native saved path. Relative paths reconstruct that path exactly; digest
pins, path normalization and traversal checks protect retained references.
Limits are 8 factual, 64 human/experiment and 8 deliberation doubts per
round, with doubt IDs at most 32 ASCII characters. Read full originals by verified
absolute references as before.

A replacement append/save interruption leaves only a digest intention. Re-enter
with the exact continuation AND resubmit the same complete replacement (canonical
SHA-256 must match). Missing/different input blocks before any child. Identical
resubmission completes publication idempotently and clears the marker after saving
the new snapshot/anchor. Do not infer that continuation alone carries replacement
content. Failed confirmed comparisons are archived before a newly requested prepare;
they consume their original round, do not become valid and are not later essentials.
Native Stop/permission/unconfirmed-dispatch barriers remain binding.
