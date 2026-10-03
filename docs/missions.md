# Durable missions

Missions are opt-in. They do not replace session TODOs, Board, the frozen plan,
execution ledger, evidence, or the source repository. Legacy `agent_run`,
`agent_spawn`, and `team_assign` remain ad-hoc SDK paths.

## Compatibility and safety

The Pi package loads `extensions/index.ts`, which registers `/mission` and the
mission extension. Pi 0.87.0 and Node >=22.19 are the supported runtime; Node's
built-in SQLite stores the journal. Bun SQLite is for tests, not the production
SDK. Managed execution additionally requires Linux, `git`, and working
`bubblewrap` user/mount namespaces. Unsupported or unavailable sandboxing rejects
execution instead of silently using ordinary tools. No new service is required.

Managed `apply_patch` uses the public `pi-codex-tools` parser and writer, including
Move destinations, fuzzy matching and thrown failures. Node loads that published
TypeScript API through Pi's existing Jiti dependency; the contained patch process
requires Bun. Patch and shell writers use the existing directory-subtree
`allowedPaths` writable mounts, not a private strict patch backend. Workspace-relative
target admission, read-only source/store/Git views, process fencing and sealed
private results remain mission guarantees. Scratch after-images are deterministic
only when targets can be copied without live symlink aliases; otherwise recovery
must reconcile observed evidence rather than assume a planned result.

An operator prepares a frozen `.pitako/plans/<plan-id>.md` and its validated
`.mission.json` definition. Role policies are explicit provider/model/reasoning
bindings with bounded tools, targets, budgets, deadlines and correction limits.
No model/provider defaults are inferred. One owner controls a mission; attempt,
revision, input and effect identities fence stale or duplicate progress.
SQLite journaling, content-addressed artifacts, sealed output manifests and
managed candidate workspaces are different authorities, not substitutes.

```text
/mission prepare <plan-id>
/mission start <mission-id>
/mission status <mission-id>
/mission inspect <mission-id>
/mission pause <mission-id>
/mission resume <mission-id>
/mission cancel <mission-id>
/mission revise <mission-id> <instruction> -- <structured delta>
/mission metrics <mission-id> --export <new-report.json>
/mission export <artifact-directory>
```

Console commands are operator authority. Worker text cannot activate, approve
source writes, import assessments, change budgets or publish results. During an
active mission the coordinator classifies inputs; ambiguous choices require an
operator response, not a guessed authorization. Revision impact invalidates
affected acceptances and preserves unaffected work. Recovery reconciles actual
filesystem/effect evidence before dispatch: uncertain effects are quarantined or
blocked, not retried as if nothing happened. Explicit pause drains admitted work;
quit/navigation retire the owner. Unproven shutdowns can require reconciliation,
not automatic successful continuation.

Results stay in managed product/candidate roots and content-addressed artifacts.
Inspect the integrated report and completion manifest before deliberately
applying anything yourself. There is no automatic source apply, commit, push,
publication or privileged same-UID hardening guarantee.

## Engine verification versus effectiveness

`bun run verify:mission -- T7 --evidence-dir <directory>` is the deterministic
integration stage. Run T1–T7 individually into distinct evidence directories for
the complete stage set. `bun run test:mission-node` runs the production-Node
durability suite (not the stage verifier). The fixture uses real Node Pi SDK sessions and managed
tools but a local deterministic model transport: it exercises engine wiring,
not model quality, paid-provider behavior or a live autonomous success rate.

`mission-metrics-v1` is a pure, versioned projection of an explicit cohort captured
at event sequence/time cutoffs. Revisions are not extra missions. The report
retains repository/mission/plan/definition/authority/criteria/budget/policy and
engine/runtime identities. Captures omit prompt, source, command, operator and
error text; identity/provenance fields can still be sensitive and should be
reviewed before sharing. Journal/artifact exports are fuller sensitive evidence,
not redacted metric captures.

Construct a `mission-metric-cohort-v1` JSON using `captureMetricMission(store,
inspection, engineCommit, cutoff)` from `extensions/mission/metrics.ts`:
`metricVersion: "mission-metrics-v1"`, a label, a population
(`deterministic-fixture`, `live-evaluation`, or `normal-use`), and the captured
missions. Keep this input immutable. Recalculate with
`calculateMissionMetrics(cohort)` or:

```text
/mission metrics --cohort <capture.json> --export <new-report.json>
```

The report binds the capture hash; `--export` never overwrites an existing file.
Include every activated mission in the chosen population, including cancellations,
failures and unfinished runs. Do not combine deterministic fixtures and live
evaluation into a favorable denominator.

### Independent observation import

The existing `EvaluationObservation` schema supports outcome, operator
intervention, confirmed defect and unknown assessment; corrections name
`supersedesId`. Store each external assessment and its provenance as
content-addressed artifacts using the store's existing artifact API. The
provenance is `mission-evaluator-v1`: independent evaluator identity, method,
mission/revision/result manifest, criterion version and evidence references.
Intervention classification is `none`, `goal_authority`, `rescue`, or `unknown`;
safeguard defects can classify lost edits, unauthorized/duplicate effects or stale
acceptance. Then import an array of observations through the console:

```text
/mission metrics --import-observations <observations.json>
```

Import validates result/revision identities, evidence hashes, timestamps,
correction targets and an operator-attested independent provenance record. Worker
or engine identities cannot self-assess. Attestation is not cryptographic proof
of a person's independence: the operator is accountable for that assertion.
Assessments do not change scheduling, unit acceptance or engine completion.
Missing, legacy/unattested, superseded or obsolete assessments are not success.

### Interpretation and matched baseline

Correctness and rescue-free success use **all admitted missions** as denominators;
coverage exposes pass/fail/inconclusive versus unassessed. Cost covers dispatched
requests across failed, repeated, verification, recovery and Team work. SDK USD
estimates are not invoices; reservations are not spend. Unknown usage/exposure
stays unknown, and cost per independent success is undefined when none passed.
Timing separates delivery, active/model/tool/dispatch/visible-response and
assessment-delay samples. Unpaired pause/human-wait or cross-runtime crash
intervals are unknown, not zero or invented human minutes.

Recovery reports interruption episodes, accepted checkpoints and reused/repeated
work; missing delay proof remains unknown. Rework reports corrective attempts,
reopened units and independently linked defects/follow-up windows. Team rounds
are descriptive attribution, not proof of useful collaboration. Confirmed lost
user edits, unauthorized/duplicate effects and stale acceptance are defects;
prevented attempts and uncertain effects are separate from confirmed violations.

For a live comparison, predeclare at least 20 representative cases per cohort
when practical, stratified by difficulty, repository change, interruption and
goal revision. Match source state, initial task, model/reasoning, authority,
budget, runtime, evaluator criteria and follow-up window against ordinary
AgentInstance/Team use. Log differences; randomize/counterbalance order and assess
blind where possible. Publish full cohort membership/cutoffs, provenance,
numerators, denominators, uncertainty and raw captures before making claims.
Smaller pilots are descriptive insufficient evidence, not effectiveness proof.

No paid dogfood allowance is implied by these commands. Live effectiveness is
currently **unmeasured**; deterministic test outcomes must not be relabeled as
live observations or comparative benefit.
