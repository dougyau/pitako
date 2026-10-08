# Durable missions

Missions are opt-in. They do not replace session TODOs, Board, the frozen plan,
execution ledger, evidence, or the source repository. Legacy `agent_run`,
`agent_spawn`, and `team_assign` remain ad-hoc SDK paths.

Ordinary coordinator execution uses the frozen plan and scoped WorkBrief
handoffs. It does not require a managed mission or compile a plan into one.
Managed missions use the explicit prepared definition authored and validated
through the native flow below. User-authored `.mission.json` is only a legacy
compatibility path, not a prerequisite for ordinary preparation.

## Worker brief context

Ordinary managed worker briefs include the mission context, unit inputs and
outputs, complete declared acceptance predicates, and current engine obligations.
Predicate commands describe acceptance; they do not instruct workers to repeat
effects. The engine reserves and delivers the same brief string. Its hash covers
the JSON-encoded string, not additional SDK prompt context.

Previous attempt observations are advisory, including passes. Each observation
retains its originating revision. Dependencies show their current projected
status and available passing evidence referenced by an accepted dependency.
Missing or invalidated observations do not become evidence. The host still
assesses every current predicate; brief text and worker claims grant no authority.

Singleton continuations keep their advice-only JSON appendix after the ordinary
context. Team and finalization briefs keep their separate protocols without
ordinary sections. Recovery verification retains the instruction not to repeat
the original effect or modify candidate files. Context does not change recovery
mode selection, effect authorization, or independent completion checks.

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

An operator supplies frozen `.pitako/plans/<plan-id>.md`; it may live in the
registered main/sibling checkout rather than the execution root. Role policies are explicit provider/model/reasoning
bindings with bounded tools, targets, budgets, deadlines and correction limits.
No model/provider defaults are inferred. One owner controls a mission; attempt,
revision, input and effect identities fence stale or duplicate progress.
SQLite journaling, content-addressed artifacts, sealed output manifests and
managed candidate workspaces are different authorities, not substitutes.

```text
/mission prepare <plan-id>
/mission start <plan-id>
/mission status
/mission inspect
/mission pause <plan-id>
/mission resume <plan-id>
/mission cancel <plan-id>
/mission revise <plan-id> Change predicate <predicate-id> <field> to <JSON value>
/mission revise <plan-id> Change unit <unit-id> <field> to <JSON value>
/mission revise <plan-id>
/mission revise <plan-id> answer <question-id>
/mission revise <plan-id> answer <question-id> Change predicate <predicate-id> <field> to <JSON value>
/mission revise <plan-id> withdraw <question-id>
/mission help
/mission console
/mission metrics <mission-id> --export <new-report.json>
/mission export <artifact-directory>
```

Native mutations require confirmation of the exact action, physical root,
source, admitted revision/definition, ownership and typed payload in the
principal TUI session. Revise presents exact before/after values; omitting its
payload opens an input prompt for a typed choice rather than requiring engine
edits JSON. Prepare queues a single non-authoritative request to the current
coordinator through Pi foreground `followUp` messaging. Busy work is not cancelled
and the command does not wait for it or launch another coordinator. The host reads
the source pin, execution root, configuration and root GATES independently.
The coordinator uses `mission_prepare` with that request ID to author a mapped
schema-2 proposal and supported technical choices, not an admission receipt.

The native questions view groups missing permissions, **all five engine budgets**,
resume policy, any separate setup-effect allocation and genuine source ambiguities
with the original excerpts. Proposed estimates and configured role policies do not
approve any effects or budgets. Unsupported evidence/prerequisites and ambiguous
mappings remain specific unresolved issues, never manual passes or omitted gates.
The subsequent exact preview includes roots, physical source revision/pin, admitted
and prepared hashes, complete primary/fallback/reasoning/fast role policies,
original objective/WorkBrief/criteria, mappings, scope and verification obligations.
Only native confirmation admits that exact validated object. Tool results remain
proposal diagnostics, not transferable confirmation receipts.

Preparation persists only after confirmation and starts no worker.
Explicit `/mission start` separately confirms worker activation. Copied setup
can run during preparation under its own exact native consent, as described below.
Legacy setup runs only after separate start consent. Unadmitted drafts
are request data: wrong request/session/root, source/configuration drift, replacement,
dismissal, shutdown, reload or session switching require reauthoring. Admitted
preparation survives reload through immutable mission storage. For deliberate
existing-file compatibility use `/mission prepare-file <plan-id>`.
Help and status require
neither execution ownership nor a console, and do not recover work or acknowledge
notification delivery.

### Preparation status and setup

`mission_prepare` reports `decision-required` for genuine user decisions,
`technical-unresolved` for author corrections or unavailable inputs, and `ready`
when the current preparation is usable. Each result includes a next action.
Malformed mappings, unsupported evidence, and insufficient current command capacity
are technical problems. They do not become permission questions or manual passes.
`/mission status` reports unresolved setup separately from a ready prepared mission.
A prepared mission still needs explicit `/mission start`.

The optional `execution-root-local-copy-v1` contract copies bounded local inputs
to an exclusive temporary destination before running the admitted setup hook.
The preview names the destination, hook, writable directories, input seeds or cache,
and finite time and artifact limits. The hook runs in the managed capsule without
network access or global installation. Source and cache inputs stay unchanged.
The host publishes only the current owned output after complete observation.
Candidate consumers mount that dependency output read-only.

Start reuses this observed output and its existing protected reservations.
It does not run a second bootstrap. Copied setup cannot replay after restart,
and an unknown owner or incomplete observation leaves setup unresolved.
A changed destination or source needs fresh consent. The older
`execution-root-local-v1` contract retains its separate start-scoped behavior.

### Optional offline verification profile

`sealed-nested-verification-v1` is an explicit schema-2 verification profile,
not a shell flag or an ordinary worker capability. Native confirmation binds the
profile and copied runtime inputs. The host issues the checker capability for each
current predicate, subject, input binding, owner, and finite allocation.
Ordinary acceptance and finalization use the same profile.

The checker reads sealed subject code and the copied runtime without write access.
It can create scratch candidates and bounded evidence inside its disposable capsule.
Nested tools remain offline, and host services remain unavailable.
Ordinary workers keep their namespace, socket, and tool restrictions.
Unavailable inputs or sandbox capabilities reject the checker instead of using
host execution.

A checker exit code or child success message is not completion proof.
The host requires complete bounded output import, unchanged input identities,
retirement of the registered outer init, an empty namespace, and quiescent descendants.
Unknown or live ownership retains and fences the capsule. It does not authorize
cleanup, replay, or publication.

### Native decisions and recovery

For a named pending question, native `answer <question-id>` prompts for each
bounded field's new JSON value and derives exact preimages from the current
snapshot. Users need not author engine edits JSON. The confirmation presents the
complete typed before/after payload; existing exact-selection and overlapping
question rules still apply. Questions without bounded editable fields can be
withdrawn; no hidden edits are inferred.

The operator explicitly trusts Pi and its installed extension/input chain to
receive native confirmation. This is not cryptographic proof of human origin or
the protected console's provenance guarantee. Native receipts are host-issued,
one-use objects labeled `native-confirmation`; optional authenticated-console
receipts retain `console`. Model text, tools and child sessions cannot supply a
receipt or activate/control a mission. Missing UI and RPC/headless operation do
not auto-approve. Decline, dismissal, replaced prompts, session shutdown/switch,
source/revision changes and ownership transfer invalidate pending approval.
Unrelated telemetry alone does not require another confirmation.

No socket opens or is advertised on ordinary startup. `/mission console`
explicitly activates the optional compatibility console, including its existing
typed JSON and ambiguous-choice protocols. Its authenticated commands retain
operator authority. Saved `resumeAfterClose` authority still permits the existing
startup/reload recovery path; reading status does not grant it.

Worker text cannot activate, approve source writes, import assessments, change
budgets or publish results. During an
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

Durable worker and diagnosis transcripts remain in canonical private native
directories. Foreground `agent_history` and `/pitako history` consult those records
after restart. Registered shallow aliases make them discoverable by ordinary
Hermes backfill without moving transcripts. See [Worker history](worker-history.md)
for consultation, protected groups, retention, capture gaps, and search limits.

### Compare assignments with activity

`/mission inspect [mission-id|plan-id] --unit <id> --attempt <attempt-id>`
and the principal's model-only `mission_observe` tool use the same read-only projection.
Workers do not receive this tool; registered AgentInstance calls are rejected,
preserving the principal-only worker-history disclosure boundary.
Omit the attempt selector to include earlier and current attempts. The command
defaults to the mission bound to this repository; the tool requires its mission ID.
Neither admits a worker, attaches an engine, acquires execution ownership,
acknowledges notifications, nor returns a candidate control handle.

Follow the page `cursor` with `--cursor <token>` or the tool's `cursor` parameter,
keeping mission/unit/attempt selectors unchanged. Revision, original assignment,
attempt lineage, and host-event records precede retained native-history members.
Follow a record's `readCursor` to read its full brief, evidence, or native history.
Byte fragments are base64 with offsets; concatenate decoded fragments in order.
Cursors remain bound to the physical repository root, mission and selected attempt.
Missing, pruned, not-created and incomplete evidence are diagnostics, not empty
activity. Original prose unavailable in a legacy definition is not reconstructed
from later commentary. Large authority/artifact inputs retain the history
consultation limits and return explicit limit diagnostics.

Compare the original objective and full WorkBrief with tool calls, command
results and host receipts. For setup/GATES work that turns into dependency
investigation, separate the observed runner failure from its explanation:
a stacktrace naming Hermes does not establish Hermes as the cause. Compare
normal and parallel runner evidence under identical inputs, then select a
discriminating integration check. If investigation requires a scope change,
recommend an exact native pause/revise decision instead of treating commentary
as authorization. The display does not classify, steer, repair, pause or amend.

Native history remains private and is disclosed under the existing history
policy, without generic redaction. Read-only SQLite consultation preserves
mission authority but can update SHM reader bookkeeping or create cold WAL/SHM
sidecars; it is not a promise of zero filesystem changes.

## Engine verification versus effectiveness

Use [GATES.md](../GATES.md) for routine verification and stage-specific wrapper
selection. [scripts/verify-mission.ts](../scripts/verify-mission.ts) owns the
reachable commands and coverage for each required stage. T7 is the deterministic
integration stage, not proof of every T1–T6 obligation. Preserve any required
stage-specific evidence in distinct directories. The fixture uses real Node Pi SDK sessions and managed
tools but a local deterministic model transport: it exercises engine wiring,
not model quality, paid-provider behavior or a live autonomous success rate.

The credential-free composed fixture uses the native preparation and confirmation
handlers, a fixture-owned local setup hook, separate native start, and an actual
contained checker observation. Its finalization checks the product with the same
profile and copied dependency. The deterministic provider proves SDK wiring,
not classifier intelligence, real-provider performance, or P6 completion.
It does not replace the required final candidate gates or independent review.

The workflow and brief-context change uses focused dispatch, local SDK,
continuation, recovery, checker, and finalization regressions. Its routine final
procedure is in [GATES.md](../GATES.md), followed by independent review, not a
required T1–T7 stage-verifier sweep. Local-provider observations prove delivered
context and the exercised authority boundaries, not better model decisions.
An observed denied recovery write and unchanged candidate prove that path, not
universal filesystem immutability. Skipped or unavailable checks leave their
behavior unproven.

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
