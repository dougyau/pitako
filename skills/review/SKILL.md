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
   delegation. It supplies CodeGraph, read-only LSP, and verify-behavior.
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
project being reviewed. Make one background call with that absolute path:

```js
subagent({
  workflow: "<absolute skill directory>/workflow.js",
  cwd: "<project being reviewed>",
  async: true,
  args: {
    brief: "<requirements, context, exclusions, and evidence>",
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
   return zero findings. verify-behavior is common; additional skills are chosen
   from the script's bounded list by risk. Use ponytail-review for complexity.
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

## Interpret

Read the returned `status`, not just workflow process success:

- `completed`: all phases completed, with a final `memo` and dispositions.
- `blocked`: usable review could not proceed; read the question or evidence gap.
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
