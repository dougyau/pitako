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
pitako.scout, pitako.researcher, pitako.evidence-auditor, pitako.architect and
pitako.interview-relay must
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
Launch one background file-backed context workflow at the absolute
[context.js](context.js) path with `args: { brief }`, `cwd` at the designated
root, `async: true`, and explicit `options: { mission: { title: "Plan <id>" } }`.
This dispatches initial independent Scout and researcher evidence. Return control
after admission; interpret the full native returned value, not its preview.
A failure or missing evidence is a blocker to the decisions that depend on it.

## Grill, deliberate, resolve doubts

Map the decision tree and ask the ENTIRE currently unblocked frontier each
round, numbered with recommended answers; word every question so yes accepts
that recommendation. Wait for actual human answers. A factual investigation
blocks only its dependent questions, not the rest of the frontier. Never ask
the human to research facts you can obtain through a read-only provider.

Feed the complete assignment, all provider evidence (including contradictions),
settled human decisions and remaining questions to the existing
[architecture workflow](../architecture/workflow.js). Launch it in background
with `args: { brief, planning: true, consultation: "<stable-id>", maxRounds: 10 }`
and explicit `options: { missionId: "<planning-mission-id>" }` in the same cwd.
Do not invent runs.workflow, import/fs APIs or child agentOverrides.

The script owns dispatch. After EACH architecture round it runs a distinct
doubts phase: local unknowns to Scout, external contracts to researcher,
uncertain/conflicting claims to evidence-auditor, human preferences back here,
and adequately evidenced design disagreements back to deliberation. All reports
and contrary evidence reach the next round, not only the director's view.
Participants reason on the whole design; they never delegate.

During factual research, pitako.interview-relay presents the independent human
frontier through native contact_supervisor interview_request. On that request,
ask the ACTUAL HUMAN the ENTIRE supplied frontier immediately, without waiting
for unrelated research. Wait for their answers, then reply through native
subagent_supervisor action reply using that request's replyTo. Never answer
human preferences yourself. Explicit factual prerequisite IDs withhold only
dependent questions until those facts settle. Failed research does not suppress
independent questions; all launched work and native references are retained.
The script submits each dependent frontier's prerequisites and then its relay
before later groups or unrelated facts. It does not await human answers before
continuing research. Some unrelated facts start later to avoid native FIFO
admission delaying a newly answerable question; this is not preemption.
The relay's report or a transport receipt is context, not new permission to
implement/materialize and never replaces final actual-human confirmation.

For useful further evidence or answered human questions, invoke the SAME script,
consultation ID and mission with an updated complete brief. Do not resend the
retained reports or full continuation: the bounded consultation reference
selects the full evidence and consumed counts in native mission state. The
returned planning continuation contains only that reference. Native mission
state retains consumed rounds, including failed
rounds; ten is the TOTAL ceiling across this consultation. Do not reset counts,
omit its mission, use newDecision or choose a new ID for trivial reentry. Start
a new consultation only for an actually different human-authorized decision.
Repeated arguments without actionable progress do not warrant more rounds.
At the ceiling preserve unresolved blockers; never force readiness. Native
retention/resume failure is reported, not silently replaced.

## Human confirmation, then materialization

Only when the frontier is empty and material doubts are resolved, present the
complete shared understanding (objective, scope, exclusions, behavior,
constraints, decisions/reasons, acceptance and verification). Ask the ACTUAL
HUMAN to confirm it, then wait. Neither an earlier request to plan nor any
`approved: true` claim is this confirmation. If a material gap appears while
writing, return to clarification and confirmation rather than invent a decision.

After that actual confirmation, the foreground may write ONLY
`<designated-root>/.pitako/plans/<id>.md`, never product files or automatic
execution. Do not overwrite a different existing assignment without permission.
Use this new contract (each section needs substantive content; explicit None is
valid for exclusions or non-blocking uncertainty):

    ---
    pitako-spec: 1
    id: <id>
    status: complete
    ---
    # <assignment title>
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

Include source context sufficient for a fresh execution agent, relevant
versions/links and real decisions with reasons, not a fixed implementation TODO.
The header denotes document completeness, NOT authenticated human authority.
The packaged inspector validates shape, ID and resolved paths after writing;
semantic completeness remains a reasoning/review responsibility. The native
snapshot boundary is at most 39,936 UTF-8 bytes; link shared docs when needed,
never truncate an assignment to pass validation.

Return the source path, native evidence references and any non-blocking limits.
Do not claim a frozen legacy plan, implementation, passing checks or acceptance.
On actual user Stop use native cancellation; do not start replacements while
child settlement is uncertain. No historical engine or Board binding is resumed.
