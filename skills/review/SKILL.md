---
name: review
description: Review a supplied diff, plan, solution, codebase scope, or issue through two independent angles mirrored across two model slots, followed by evidence-based synthesis. Uses one background pi-subagents scripted workflow.
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
    Execute's integrated review preserves the reviewer's declared profile skills
    (including Ponytail) alongside its workflow-specific scope-discipline addition.
    Its protocol snapshot belongs to the enclosing execute loop, not a separate
    `review-*` mission key. Execute supplies that in-memory loop and owns saves,
    original-reference conversion and replay; standalone persistence is unchanged.
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

When `/execute` embeds this review library, the bounded review cursor lives in
`pitako-execute`, not in a separate review key. Execute passes its in-memory loop
and records original references through the existing `reviewOriginals` loop-io
call. Final review and compliance receive the same committed blocking acceptance
reference and digest, bounded check summaries (not output bodies), and candidate
and mutation status, even if no task ran. An absent receipt is explicit, and
relaunch does not substitute evidence from a different candidate.
Integrated review does not use the standalone final store writer below.

## Launch

Launch the registered named resource `pitako.review`, never a script path: raw
paths fail with "launch by name after mission.create". The one `pitako-review`
cursor freezes the three model slots only for a matching nonterminal input.
Different input replaces the cursor; an identical terminal pass is not
restarted. Use native replay after `runtime-replaced` or `owner-exited` so
successful child admissions can be reused. Native Stop and permission refusals
still apply.

On the normal path, `pitako.store-io` runs once at the end, using the
bounded save intention and verifying original native settlements by key,
run ID and digest. It does not rerun a producer or gate. A lost cursor save
replays the store operation at the same key; a missing or contradictory
settlement fails closed. If a cut leaves settlements only in the native journal,
one read-only recovery observation returns the verified bodies if they fit. At the
61440-byte cap it can compact successful bodies only with matching native reuse
evidence for this relaunch. Otherwise an oversized receipt halts with
`review-recovery-overflow` before any producer dispatch or SQLite write. The
workflow saves the diagnostic once in the terminal `pitako-review` cursor.
Later relaunches of the same review return it without dispatching any children
or saving again. A retained Stop holds on further relaunches without another
child or a final write. The native cursor save is not atomic with COMMIT. Relaunch
refuses before dispatch
if the terminal cursor conflicts with a surviving committed owner. Different
review input can proceed after same-cwd store loss or replacement.
First create the mission in the project being reviewed:

```js
subagent({ action: "mission.create", cwd: "<project being reviewed>",
  options: { mission: { title: "Review stream parser memory safety" } } })
```

Copy the actual returned missionId and the exact `Mission record path
(args.missionPath): <path>` line (not the `State:` path). Then make one
background call with the same missionId in args and options:

```js
subagent({
  workflow: "pitako.review",
  cwd: "<project being reviewed>",
  async: true,
  options: { missionId: "<actual missionId>" },
  args: {
    missionId: "<actual missionId>",
    missionPath: "<actual mission record path>",
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

The script uses exactly two angles on the same complete target, not files or
subtasks. The fixed angle is `evidence-contract` for `diff`, `solution`,
`codebase`, and `issue`, or `decision-fidelity` for `plan` (including specs).
The director selects exactly one additional risk angle whose id must differ
from the fixed angle.

1. **Independent mirrored review.** Each angle is reviewed by both model slots,
   `r1` and `r2`, giving four fresh read-only `pitako.reviewer` children.
   Fresh reviewers see no peer conclusions. Each may
   return zero findings. verify-behavior and ponytail-review are common; additional skills are chosen
   from the script's bounded list by risk. Apply ponytail-review to correctness, safety, useful tests and simplicity; require reachable cases and evidence, not speculative guards.
2. **Synthesis.** Directly after the four reviews, the director deduplicates and records a reasoned disposition
   for every finding: include, discard, or uncertain. Evidence decides, not votes.
   Each finding and final disposition also has a `classification`:
   `scoped-defect`, `related-improvement`, `out-of-scope`, or `uncertain`.
   `requirement` cites the agreed requirement or existing guarantee and its
   source for a scoped defect; it is `null` when none is established.
   Unresolved claims stay uncertain rather than becoming defects automatically.
   A disposition classified `uncertain` uses decision `uncertain`, never `include`.

No critique or defense phases run in standalone `/review` or `/execute` final
review. No extra rounds. Synthesis rules, schema, and `.director-synthesis` key
are unchanged. Independent keys are `independent-<angle>-r1` and
`independent-<angle>-r2`; model ids never enter keys. References record the model,
and finding ids are `<angle>-<slot>-<n>`.

Pi settings `pitako.review.r1` and `pitako.review.r2` default to
`anthropic/claude-opus-5-5:high` and `openai-codex/gpt-6.1-sol:xhigh`;
`pitako.review.synthesis` defaults to `anthropic/claude-opus-5-5:high` and selects
both the prepare director and synthesis. Each value is one exact
`provider/id[:thinking]` string sent unchanged as the child `model`.
Standalone `/review` reads settings through its named analysis resource;
`/execute` freezes them at admission. Both reuse frozen values on replay.
Invalid values are rejected; an unknown or failing model stops review with its
settings key, model, and native error, never a fallback model.
See [configuration](../../docs/configuration.md#package-and-session-settings)
for settings precedence and examples.

## Evidence handoff

Every fresh/resumed request carries the complete current brief and target,
caller-supplied single-line `workDescription`, readable `label`, explicit `phase`
and concrete first task line. This includes angle selection, independent review,
and synthesis. Keys and native resume identity remain
unchanged; titles do not promise historical session renaming or uniform native views.

Full originals request native persistence and `outputMode: "file-only"`. Finding
indexes identify each authoritative original/ordinal/ID rather than copying
finding bodies into a second table. Reasons, coverage, uncertainty and contrary
narrative outside findings remain recoverable; every finding gets a disposition.
Essential-original references explain why the exact original is needed. Before
the synthesis phase the workflow dispatches the
model-free `pitako.access-verifier` once over the phase's required originals. It
compares the canonical JSON digest of each published file with the admitted
digest and writes a no-clobber receipt in the cwd store
(`access:review-<scopeId>` for standalone review).
A contradictory or unavailable original blocks the whole phase before dispatch
with an explanation naming the original, key, path, expected and observed
digests and the action to take; a verifier failure is reported as
"verification did not run". No model creates, chooses or copies receipts, IDs,
paths or digests; reviewers read each verified original in full by its
`savedOutputPath`. The standalone cursor never keeps report bodies. Check the receipts later
from the designated worktree with `access_receipt_verify` using the mission
path, namespace and gate.

Retain actual `results[].savedOutputPath`, returned reference objects and text
`outputReference` paths with producing query/revision/phase/producer/key/attempt/run.
Never derive native filenames or replace historical provenance with latest resume
IDs. Generic artifact paths and `structuredOutputPath` alone are not mandatory
publication proof; `runs.status` is observation/previews, not an original archive.
Missing, inaccessible or contradictory essentials block dependent conclusions.

Mandatory publication failure is not repaired by inline JSON. Optional
observability failure alone does not invalidate required publication/access.
Only a complete identifiable failed/partial original genuinely delivered can be
retained once in the final store record, failed/unpublished/insufficient;
partial analysis need not be ready to preserve it. A field's presence, reference,
preview, rejection without an object or text without a truncation marker is not
completeness evidence. Distinguish non-delivery from unproved completeness; never
republish or duplicate successful originals, truncate evidence, or delete history
to evade the whole-file 256 KiB bound. Essential
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
