---
name: review
description: Review a supplied diff, plan, solution, codebase scope, or issue through independent adversarial angles, cross-critique with one defense, and evidence-based synthesis. Uses one background pi-subagents scripted workflow.
---

# Review

Use only `pi-subagents` for this advisory review. This skill initiates the
workflow; its director and reviewers reason about the supplied target.
The caller interprets the report and retains authority over any further action.

## Prepare

1. Enable `subagent` with `subagents_enable({})` if needed. Read its
   `workflows/scripted-workflows` and `tool-reference/retained-children` guides.
2. Inspect profiles with `subagent({ action: "list" })`. Confirm that
   `pitako.reviewer` is available and suitable for read-only review without
   delegation. It supplies CodeGraph, read-only LSP, verify-behavior, and ponytail-review.
   If absent, reload the installed package before dispatch; do not substitute a
   profile, create agent files, or change settings to make the pass work.
3. Capture the target and requirements. Supply a target with `kind` (`diff`,
   `plan`, `solution`, `codebase`, or `issue`), `reference` (the exact revision,
   artifact, or named scope), and `material` (the reviewable text or exact
   read-only artifact paths). A commit label alone is not a diff.
   Include requirements with their sources, non-goals, and relevant evidence in
   `brief`. Distinguish agreed requirements from internal implementation choices.
   Resolve material ambiguity before dispatch. Arguments persist; omit secrets.

Keep source artifacts stable for the duration of the pass. Every child receives
the same target, but the workflow does not snapshot the checkout or certify that
referenced files stayed unchanged. If they change, the report is not current:
capture the new target and start a new pass. After corrections, use a closure
review rather than restarting the audit by default. In `brief`, name the prior
review and exact reviewed candidate, admitted findings, correction delta,
affected guarantees, and still-valid evidence. Keep the complete current
candidate in `target.material` alongside that delta. All reviewers share this
boundary and can inspect relevant interactions in the complete candidate.
If prior coverage or the correction boundary is unavailable, obtain the missing
coverage instead of claiming closure.

## Launch

Resolve [workflow.js](workflow.js) beside this installed skill, not against the
project being reviewed. Use an explicit native mission for the original manifest,
creating one as below (or supply its actual existing `options.missionId`). Each
new review pass needs its own mission/state namespace; a retained standalone pass
is not implicitly restarted or migrated. Make one background call with that absolute path:

```js
subagent({
  workflow: "<absolute skill directory>/workflow.js",
  cwd: "<project being reviewed>",
  async: true,
  options: { mission: { title: "Review stream parser memory safety" } },
  args: {
    workDescription: "Stream parser memory safety",
    brief: "<complete requirements, human decisions/provenance, context, exclusions, and evidence>",
    target: {
      kind: "diff",
      reference: "<exact candidate identity>",
      material: "<exact patch or absolute path to captured patch>"
    }
  }
})
```

Return control after admission. Native completion delivers the final result;
do not poll, add a watcher, or launch another director.

The script fixes three phases; the director selects two to four angles on the
same complete target, not files or subtasks:

1. **Independent review.** Fresh reviewers see no peer conclusions. Each may
   return zero findings. verify-behavior and ponytail-review are common; additional skills are chosen
   from the script's bounded list by risk. Apply ponytail-review to correctness, safety, useful tests and simplicity; require reachable cases and evidence, not speculative guards.
2. **Cross-critique and defense.** A different reviewer examines every finding.
   Each author then gets one response: maintain, narrow, or withdraw.
   Native resumes preserve each child's profile and context. Reviewers without
   assigned findings skip critique; authors without findings skip defense.
   When there are no findings, both phases need no child calls. No extra rounds.
3. **Synthesis.** The director deduplicates and records a reasoned disposition
   for every finding: include, discard, or uncertain. Evidence decides, not votes.
   Each finding and final disposition also has a `classification`:
   `scoped-defect`, `related-improvement`, `out-of-scope`, or `uncertain`.
   `requirement` cites the agreed requirement or existing guarantee and its
   source for a scoped defect; it is `null` when none is established.
   Cross-critique challenges both factual support and belonging to the scope.
   Unresolved claims stay uncertain rather than becoming defects automatically.

The workflow makes no model overrides. Pi-subagents owns native child model
selection.

## Evidence handoff

Every fresh/resumed request carries the complete current brief and target,
caller-supplied single-line `workDescription`, readable `label`, explicit `phase`
and concrete first task line. This includes angle selection, independent review,
cross-critique, defense and synthesis. Keys and native resume identity remain
unchanged; titles do not promise historical session renaming or uniform native views.

Full originals request native persistence and `outputMode: "file-only"`. Finding
indexes identify each authoritative original/ordinal/ID rather than copying
finding bodies into a second table. Reasons, coverage, uncertainty and contrary
narrative outside findings remain recoverable; every finding gets a disposition.
Essential-original references explain why the exact original is needed. Existing
child readers validate content/schema/association and report missing access;
resumed children reread essentials no longer in accessible context, not all history
universally. Earlier delivery or a child access receipt cannot certify reasoning.

Retain actual `results[].savedOutputPath`, returned reference objects and text
`outputReference` paths with producing query/revision/phase/producer/key/attempt/run.
Never derive native filenames or replace historical provenance with latest resume
IDs. Generic artifact paths and `structuredOutputPath` alone are not mandatory
publication proof; `runs.status` is observation/previews, not an original archive.
Missing, inaccessible or contradictory essentials block dependent conclusions.

Mandatory publication failure is not repaired by inline JSON. Optional
observability failure alone does not invalidate required publication/access.
Only a complete identifiable failed/partial original genuinely delivered can be
retained exactly once in existing native state, failed/unpublished/insufficient;
partial analysis need not be ready to preserve it. A field's presence, reference,
preview, rejection without an object or text without a truncation marker is not
completeness evidence. Distinguish non-delivery from unproved completeness; never
reconstruct, republish, duplicate successful originals, truncate evidence, delete
history or add alternate storage to evade the whole-file 256 KiB bound. Essential
save failure stops new dispatch, preserves diagnostics and settles owned work
when native controls allow; unknown inherited settlement remains unknown.

The final memo stays self-contained, not a bundle of intermediate reports or
only paths. Pitako limits its own prompts/emissions, not all native notices;
no fixed token savings, universal retention/recovery, exactly-once execution or
dependency certification is promised. This does not add a review continuation engine.

## Interpret

Read the returned `status`, not just workflow process success:

- `completed`: all phases completed, with a final `memo` and dispositions.
- `blocked`: missing material context prevented a review phase; read the question
  or evidence gap. Findings, however severe, never produce `blocked`.
- `failed`: a child or protocol failed; no complete review is claimed.

Completion is not a clean verdict, merge approval, or acceptance. The memo must
separate scoped defects, non-blocking improvements and out-of-scope observations,
uncertainties, checked coverage, and limits. `include` means substantiated, not
blocking or authorized for repair. The caller decides which corrections to
admit by recording the requirement, material consequence, smallest correction,
and whether existing evidence suffices or a distinct regression is needed.
Ask the user before adding a product guarantee.
For closure, new correction regressions, missed material scope defects, and
grave risks can block. Other new observations remain recommendations.
No findings does not mean unrun tests passed. Only the final report and native
run references return to the caller; intermediate reports stay in native
artifacts. If the completion preview truncates, read only the workflow's returned
value from its cited result artifact.

The script adds no replacements, retries, new rounds, or fresh-context fallbacks.
Installed pi-subagents may automatically recover a child whose setup fails
before model output, using a native `resume`. This is not another review round.
If that recovery fails, the workflow reports failure with the available child
diagnostic and run references. Config-form `runs.all` collects terminal failures,
including the director's, with their native run IDs. A dispatch rejection before
a child result exists may have no run ID; the script does not invent one.
Those references are diagnostic, not a workflow
continuation. After correction, capture the current target and request a closure
review explicitly.
On Stop, cancel the owning workflow; cancellation admission is not closure.

Read-only profiles are tool boundaries, not sandbox confinement or confidentiality.
