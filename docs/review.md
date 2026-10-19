# Reviewer tables

Reviewer tables are the sole public Reviewer route over Team. Use `review_start` for the existing independent Reviewer pass in `$plan`, `$execute` or `pre-pr`; it adds no pass. Individual Reviewer calls reject before dispatch and direct callers to `review_start`.

Each table has a new independent substantive Reviewer director/root and zero to five optional specialists selected for utility with reasons, including zero. They are separate from designers, implementers and the accepting coordinator. Every judge receives the complete object and criteria. A mandate focuses investigation without forbidding other material findings. Optional Scout, Researcher and Oracle supports supply knowledge, not judge findings.

The table does not implement corrections, accept units, freeze plans, declare READY, change requirements or waive gates. Corrections remain outside the table. Judgment does not require unanimity and is not a majority vote. [Architecture tables](architecture.md) are the separate Architect route, without a `mode` parameter or individual fallback.

## Configuration

[Startup configuration completion](configuration.md) exposes candidate settings as comments without selecting models.

The optional `[review]` section uses the same strict candidate and topic grammar as `[architecture]`:

```toml
[review]
candidates = [{ model = "provider/general", reasoning = "high" }]

[[review.topics]]
topic = "security"
candidates = [{ model = "provider/specialist" }]
```

These are placeholder models, not availability or authentication claims. Absent `[review]`, omitted `candidates` and `candidates = []` all mean an empty specialist pool. The director still requires its own `model_policies.reviewer` primary, checked before reservations or room registration. Candidates cannot supply it and there is no implicit architecture fallback.

General and topic candidate lists may be empty. Candidates accept only `model` and optional `reasoning`, not `fast`. Unknown keys and complete duplicate candidates within a list are rejected. Topics are nonempty and unique after whitespace and case normalization.

Start captures immutable candidate references. The director chooses a reference, mandate and reason, not an arbitrary model. A topic selection tries the chosen candidate, remaining topic models in declared order, then unattempted general models. A general selection uses only general models. Each logical turn starts again at the original selection, with at most one attempt per model.

Only eligible provider failures permit fallback. Disagreement, failed tests, cancellation, invalid submission, incompatible explicit reasoning and unknown closure do not. Explicit reasoning is strict and validated before prompt, including after bind. Omitted reasoning uses the destination's defaults, never inherited `fast` or director reasoning. The director retains `model_policies.reviewer`; supports retain their own ModelPolicies.

## Foreground API

- `review_start({goal, object, criteria, topic?, plan?, unit?, boardTopicId?})` starts the table. `goal` is a nonempty work brief; `criteria` is a nonempty array of nonempty strings. The response contains the real exterior Team `assignmentId`, `roomId`, member, instance and dispatch identities, not an approval.
- `review_read({roomId, cursor?})` returns bounded diagnostic fragments, state and identities. It is optional. Reads do not transport or acknowledge the exterior result.
- `review_control({roomId, action, text?})` accepts `context`, `priorities`, `finish` or `stop`. Context and priorities queue nonempty text for the next frontier without replacing the object or criteria. Finish drains current work and requests synthesis; it cannot invent missing review. Stop revokes and joins owned work. A stopping receipt is not closure.

There is no individual Reviewer fallback or direct review-table mode. Use a `brief` object for a bounded question. Native steering of table participants is rejected in favor of table controls.

## Objects and current identity

The `object` selector has three forms:

- `{kind: "plan", planId: "storage-design"}` captures the complete plan text, ID, revision and path. Only the actual `## Planning workers` section is excluded; substantive sections after it remain included. This selector is for whole-plan critique.
- `{kind: "diff", base: "<agreed-local-ref>"}` captures the complete final diff against an explicit local base. It includes committed scope, staged and unstaged edits, and applicable non-ignored untracked files. It records the resolved base commit, merge-base, HEAD, content, modes and deletions. It imposes no new clean-tree or commits-only prerequisite for review.
- `{kind: "brief", text: "Bounded question and context"}` captures a bounded consultation. It cannot substitute for whole-plan critique or final whole-diff review.

Requests include purpose, scope, criteria, evidence references and current identities. The coordinator supplies the agreed local base and quiescence. Git capture is local and read-only, without network, external diff, textconv or filters. Unsupported or incomplete capture rejects with a diagnostic rather than silently omitting material.

The host reobserves the object after synthesis. Observed drift or failed reobservation prevents a favorable report and retains earlier findings. Fingerprints identify observed endpoints, not transactional snapshots, ABA-proof history or freshness during disposal or after delivery. The coordinator compares the reviewed object with the decision object before using the judgment. Material edits invalidate affected judgment under the workflow's review policy.

## Workflow correlation and root records

`object.planId` selects plan text; the separate `plan` and `unit` fields correlate work. An unbound draft permits validated prospective correlation without creating a ledger or Board binding:

```json
{ "goal": "Independent whole-plan critique; ignore ## Planning workers. Check acceptance realizability and unit order. Do not implement.", "object": { "kind": "plan", "planId": "storage-design" }, "criteria": ["Acceptance is realizable", "Interacting contracts and unit order are coherent"], "plan": "storage-design", "unit": "reviewer-critique" }
```

A Board-bound draft without a ledger omits `plan`, `unit` and explicit `boardTopicId`, while still selecting the plan object:

```json
{ "goal": "Independent whole-plan critique; ignore ## Planning workers. Do not implement.", "object": { "kind": "plan", "planId": "storage-design" }, "criteria": ["Acceptance is realizable", "No material contract gap"] }
```

A compatible execution ledger uses the existing binding, relevant unit, watches and Board rules. Incompatible binding or a real Team hold blocks; switching routes or omitting correlation cannot bypass admission rejection. Standalone `pre-pr` creates no plan, ledger or topic.

Only the actual returned exterior root assignment belongs in `## Planning workers` or `## Workers`, with role, purpose, pending decision and consulted object. That root supplies watched completion and exact Team diagnostics or cancellation. Internal participants, supports and room messages never deliver foreground judgments or close the root's hold.

## Deliberation and findings

The director prepares once and independently reviews the whole object against all criteria, with findings and responses of its own, even without specialists or after all specialists fail. New specialists prepare independently without peer findings. Each round gives participants the same immutable snapshot. Contributions publish together after settlement in stable order, not arrival order. The director can continue, consult, synthesize early or selectively recompose within five rounds. Final clarification does not authorize a sixth round.

Optional supports run in finite batches, with at most two owners including preparation and disposal. Dependent work waits for successful prerequisite completion and closure. Composition is the total desired set: retain eligible specialists with their identities, conversations and frozen policies, add new candidates, and retire omitted members. A reason is required even for zero specialists. Recomposition validates before revocation and waits for outgoing closure before seat reuse; it is selective, not mandatory, with no fixed preference for zero.

Findings retain materiality, affected contract or risk, location, consequence and evidence. A finding can identify a reachable failure or an indispensable missing observation with its decision impact and next feasible authorized capture. Responses corroborate, object, modify or withdraw with reasons and evidence. Only an author modifies or withdraws their finding; the director judges it.

Synthesis disposes each published finding exactly once as `upheld`, `rejected`, `withdrawn`, `duplicate` or `unresolved`, with reasons and valid references. New director findings and their dispositions publish together. Withdrawal, recomposition and rejection retain original evidence, responses and material dissent. Supports do not issue judge findings.

## Exterior report and judgment

After owned physical closure, the existing automatic exterior result carries the complete JSON `ReviewReport` in `AgentRunResult.result`. It includes the object and criteria, canonical findings, responses, provenance, synthesis and dispositions or their explicit absence, failures, observed identities and limits. No read or result fetch is needed to discover objections. Internal participant results are not foreground delivery.

The actual exterior status and report's top-level fields govern interpretation:

- `completion: "complete" | "partial" | "failed"` describes review work.
- `verdict: "no-blockers" | "changes-required" | "inconclusive"` describes judgment.

Complete work projects exterior `completed` even when it requires changes or is inconclusive. Partial and failed work project `failed`; stop or cancellation projects `cancelled`. Failed, cancelled, partial or drifted work, and missing indispensable evidence, cannot approve. Material upheld or unresolved blockers prevent `no-blockers`. A final inconclusive judgment blocks approval. Even `no-blockers` is not coordinator acceptance, freeze, READY or a gate waiver.

Cancellation retains published findings and historical synthesis or dispositions, but top-level completion becomes `failed` and verdict becomes `inconclusive`. Nested complete or favorable synthesis is historical evidence, not final authority. Optional `review_read` may show the driver finished while exterior cancellation is still settling. Room state, reads and status alone establish neither approval nor closure.

Successful terminal reconciliation removes only that assignment's work hold, never accepts the product. Failed or cancelled holds retain their existing recovery requirements. Starts, prompts, callbacks, aborts and disposal must settle before exterior delivery or resource release. Unknown closure retains reservations and diagnostics without a fictitious result.

## Limits

Analysis policy removes product editing tools and public orchestration capabilities from participants. Bash remains trusted, not sandboxed. Structural validation proves protocol accounting, not reasoning truth, exhaustive review or future model compliance. The protocol has no persistence or restart recovery, new runner or scheduler. Configuration does not prove model availability or authentication.
