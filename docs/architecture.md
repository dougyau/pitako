# Architecture consultations

Architecture is an in-memory directed table over Team: one substantive Architect director and zero to five optional specialists derived independently from the Architect role. It supplies the existing architectural `$plan` pass when needed; it does not add a pass, grant execution or freeze authority, or change `$execute` policy. Trivial work needs no Architect.

[Reviewer tables](review.md) are the separate route for independent critique, replacing the existing Reviewer pass, not the Architect pass. Public individual Architect and Reviewer calls through `agent_run`, `agent_spawn`, `team_assign` or `agent_supervise` (including `superviseAgent`) reject with the corresponding start tool. Internal roles and ModelPolicies remain available to tables.

## Configuration

[Startup configuration completion](configuration.md) adds commented candidate examples without selecting models. Existing candidate and topic arrays remain unchanged.

Add optional configuration to your existing Pitako user configuration:

```toml
[architecture]
candidates = [{ model = "provider/general", reasoning = "high" }]

[[architecture.topics]]
topic = "security and isolation"
candidates = [{ model = "provider/specialist" }]
```

Absent `[architecture]`, omitted `candidates`, and `candidates = []` all mean an empty specialist pool. Topic lists may also be empty. The director still requires its own `model_policies.architect` primary, validated before any reservation or room registration; candidates cannot supply that primary. Each candidate accepts only `model` and optional `reasoning`. Topics are nonempty descriptions, unique after whitespace and case normalization. Complete duplicate candidates within a list are rejected. Different reasoning choices for the same model may be initial choices, but that model is attempted only once per logical turn. Examples do not require these providers or models to exist.

Start captures a configuration snapshot with local candidate references. Architect selects a reference, mandate and reason, not an arbitrary model. A topic choice tries that candidate, other models in the topic's declared order, then untried general models. A general choice uses only generals. Each exchange returns to the original selection. Only existing provider-failure classification permits fallback; cancellation, authority loss, unknown closure, invalid submissions and incompatible reasoning do not.

Omitted reasoning uses the destination's settings/SDK default, never the preceding model's level. Explicit reasoning is validated before prompt, including after provider bind. The director and supports retain their existing role ModelPolicies. No separate classifier is introduced.

## Foreground tools

- `architecture_start`: `{ goal, topic?, plan?, unit?, boardTopicId? }`, without `mode`. Returns room/team, root assignment, member, instance and dispatch identities. The root is a real Architect Team assignment: use its exact assignment with `team_result` or `team_cancel` for terminal diagnostics/cancellation. Watched admission follows existing Team rules.
- `architecture_read`: `{ roomId, cursor? }`. Returns state, stage, captured snapshot, immutable message fragments, member identities and closure. Cursor pages retain an append cut. Reassemble fragments by message ID and offset; no content is silently truncated. Reads neither acknowledge a response nor advance a turn.
- `architecture_control`: `{ roomId, action, text? }`. `context` or `priorities` queues nonempty text for the next exchange or table frontier, never individual in-flight steering. `finish` completes the current exchange/stage, synthesizes and disbands. `stop` revokes immediately, requests cancellation and reports stopping, not proof of disposal.

The former direct consultation mode and intermediate-answer route are retired. New callers omit `mode`; no individual fallback exists. A foreground turn ending does not cancel the table lifetime. Session/workspace retirement, reload or exit revokes it and joins owned closure.

## Writing the work brief

Write `goal` as a self-contained Markdown work brief in the brief's original language. Include a short title, an objective and an expected result. Add context, questions, restrictions and references when useful. Prefer short paragraphs and lists; HTML, wide tables, frontmatter and empty sections are not required.

This is authorship guidance, not validation. `goal` remains a plain string, and plain text remains valid. No Markdown file, extra field, conversion or normalization is introduced. JSON escaping preserves the submitted value, including whitespace, line breaks, Unicode, quotes, backslashes and code fences, after deserialization.

The original general work brief is `architecture_start.goal`. Inspect it through the root identified by the start result: while its live handle is linked, existing `agent_observe` exposes `workbrief.source: "original WorkBrief"` and pages the text using `briefOffset` and the returned `workbrief.nextOffset`. Reconstruct all pages to read the complete original. Later room controls do not rewrite it.

Individual mandates are separate assignments, not the general work brief. An internal participant may inherit the root's original WorkBrief as its history origin; that inherited text is not its individual mandate. Full technical stage prompts also contain instructions, context and structured protocol around `goal`; they are not solely the work brief. Neither debate fragments from `architecture_read` nor a Team wrapper establish the original source.

UI reading/source views, page reconstruction in the UI, rendering and safe handling of links or HTML belong to the consumer's interface work, outside this change.

## Planning use

Use `architecture_start` for Architect work, including bounded questions. No table is mandatory for trivial work. Team identifies the collaboration, role the reusable responsibility, and member/assignment one participant; repeated roles do not occupy a global singleton slot.

A table supplies the required Architect judgment through its substantive director/root and zero to five optional specialists chosen for utility, with a reason even for zero. Ask for the current-object judgment, including unit partition/order when applicable. Do not commission a duplicate independent Architect pass by default. The synthesis is design input, not a frozen plan or its independent critique; Reviewer remains separate from the designers.

For example, with an unbound draft at `planFile("storage-design")`, validated prospective correlation is permitted:

```json
{ "plan": "storage-design", "unit": "architect-pass", "goal": "# Storage design review\n\n## Objective\nDesign-only judgment on the current storage-design draft.\n\n## Context and restrictions\nInspect the repository and draft, ignore ## Planning workers, and do not modify product files.\n\n## Expected result\nResolve boundaries and check unit partition/order for coupled contracts, prerequisites and consequential uncertainty." }
```

A Board-bound draft without a ledger instead omits `plan`, `unit` and explicit `boardTopicId`:

```json
{ "goal": "# Bound storage design review\n\n## Objective\nDesign-only judgment on the current bound storage-design draft.\n\n## Restrictions\nIgnore ## Planning workers; do not modify product files.\n\n## Expected result\nCheck boundaries and unit partition/order, reporting evidence and unresolved decisions." }
```

Neither draft route creates an execution ledger or Board binding. A compatible existing ledger may be correlated; incompatible ledgers and real Team holds remain blockers, not reasons to omit correlation or add an explicit-topic bypass. Preserve `$execute`'s one exterior Developer, asynchronous Head and authorized writes, exclusive integration barrier, Head-only checkpoints, root binding, holds and acceptance restrictions. The one-Developer rule is workflow policy, not an engine singleton reservation.

Record only the returned exterior `assignmentId` in `## Planning workers`, with role, purpose, pending decision and consulted object. Only that root supplies watcher completion and exact Team diagnostics/cancellation. Internal members cannot close its hold or accept its judgment. Interpret the complete terminal current-object result supplied automatically after closure; no polling, fetch or acknowledgement is required. Valid successful reconciliation is bookkeeping, not acceptance; partial, failed and cancelled outcomes retain applicable holds. Required independent Reviewer critique and final gates remain unchanged.

## Autonomous tables

The table runs without a coordinator response between stages. Architect chooses zero to five optional specialists from the captured candidates with a global reason and a mandate and utility reason for each choice. The director prepares once and contributes its own analysis, proposal, arguments and objections even with no specialists or after all specialists fail. New specialists prepare independently with initial context and their mandate, without peer proposals. The host collects every settled preparation or explicit failure before Architect resolves doubts or authorizes one finite support batch. Equivalent questions may share a request while retaining every original doubt reference. Even an empty batch has an explicit common knowledge boundary.

Independent supports may run together, at most two including startup and disposal. Dependent work starts only after its prerequisites succeed and close. The complete batch reaches Architect in request order, not arrival order; no specialist receives an early support result. New support doubts remain pending for a later stage or synthesis, not recursive dispatch.

Participants explore the repository themselves through existing read, search, shell, CodeGraph and LSP analysis tools. Stage prompts include the original work brief, effective root and relevant references. A compatible execution binding can select a root different from the foreground working directory. Local files are not an immutable exploration view. Analysis grants no product edits, installs, fetches or provider demonstrations.

Stage prompts contain inputs for the task, not the full journal. Preparation has the original brief and individual mandate without peer deliberation. Each deliberation round gives every participant the same immutable cut of confirmed preparations, contributions, integrated knowledge, failures and frontier controls. Supports receive assigned doubts and closed prerequisite results. Knowledge integration receives the current plan and support outcomes. Synthesis receives confirmed substantive results and linked knowledge, not orchestration history or native message envelopes. Scoped inputs do not promise constant or unlimited context.

Objections identify another specialist's message and explain disagreement; they are not knowledge doubts. Contributions become shared only after all expected outer turns and callbacks settle. Failed/cancelled/invalid turns remain explicit failures, never empty contributions.

Between stages Architect can continue, consult, synthesize early or selectively recompose. Composition describes the total desired set: `retain` keeps an eligible member's identity, conversation and frozen policy while updating its mandate; `add` admits a new candidate. Omission retires an active specialist. Validate all choices before revocation, close only outgoing owners, then admit additions in choice order; pending or unknown closure never frees a seat. There is no mandatory recomposition or fixed preference for zero. Context and priorities enter the next frontier for participants and director. No in-flight snapshot changes. After at most five rounds, only final clarification and synthesis remain. Requests for another round or redesign produce partial synthesis; round six is never dispatched. Preparation and consultation stages do not count as rounds.

Table internals have no automatic coordinator responses. The single exterior result follows synthesis and disband; `architecture_read` remains observational. Finish does not abort current work; stop revokes and aborts the entire owner immediately, then joins the same cached disband. Native participant input/steering is rejected in favor of room controls, without changing ordinary worker steering.

## Participant protocol and authority

Participants have host analysis policy, no product editing tools and no public orchestration/coordinator capabilities. Bash remains a trusted shell boundary, not an OS sandbox. Executable tool definitions are protected as well as the visible tool list, including codemode access, after bind and model activation.

Only the authorized member/turn/attempt receives local `architecture_submit`. It accepts a submission ID and a stage-discriminated body: composition, preparation, contribution, decision, consultation plan/response, knowledge or synthesis. The host validates structure and contextual references, coverage, actions and prerequisites before issuing a provisional receipt. A grant allows at most two distinct candidates in the same native prompt. A recoverable rejection reports code, stage, field, bad/missing IDs and corrections left; correct it with a new submission ID. Repeating the same ID/body returns the same receipt or diagnostic without consuming another candidate. Reusing an ID with different content, replacing an accepted provisional, or exhausting the budget fails the protocol. Identity, authority, stale/retired stage and cancellation failures are fatal, not correctable candidates. Beginning again cannot reset a consumed grant. Any submit attempt prevents provider fallback; pre-submit provider fallback remains available. A receipt commits only after successful outer prompt settlement with current authority. Final prose without a valid submit is failure. A stale capability cannot submit to or poison another turn.

The host assigns author, member/assignment, message ID, ordinal, snapshot, stage, turn and attempt. Native references come from the actual bound session and tool call; message persistence is explicitly unconfirmed. Only the host motor starts the next turn, after the previous outer prompt and callbacks have joined. The submit callback never drives another prompt.

Architect resolves doubts or authorizes leaf `oracle`, `researcher` or `scout` support. At most two supports run together. Prerequisites form a finite acyclic batch; failed prerequisites skip dependent work. Failures remain knowledge outcomes rather than invented answers. The motor records dispatch using the actual Architect native caller and parent assignment after authorized settlement, not a fabricated foreground context. Supports cannot delegate. Specialists retain private conversation context until replacement or disband; support work closes after its authorized response.

Each consultation cycle freezes the original doubt set `D`. The plan partitions it exactly between direct resolutions `R` and delegated doubts `Q`; support-generated doubts are deferred, never added to that cycle or dispatched recursively. Knowledge submissions cover only `Q`, not direct resolutions. A support response must cover its exact assigned doubt IDs. Knowledge may cite only its own support and transitive prerequisites, without duplicate IDs; an answered resolution cites its own successful support and requires every prerequisite to have succeeded. Failed dependencies cannot become answered.

After successful settlement, the host publishes one separate `knowledge-boundary`, ordered by `D`, with all direct and delegated resolutions. Direct entries have empty support IDs and plan provenance; delegated entries retain knowledge, stable consultation, assignment and native response message references. Authored messages and native provenance are never rewritten. If `Q` is empty, no knowledge submission is requested, but the complete boundary still publishes, including for empty `D`. The original pending queue is replaced only when this merge commits. Deferred doubts, partial knowledge, limits and known failures require an authored partial synthesis; the host does not downgrade an accepted complete body afterward.

Confirmed boundaries feed every shared frontier and final synthesis. Internal `consultation-plan`, `consultation-response` and `knowledge` stages remain knowledge acquisition within the table, not the retired direct route. Both local `architecture_read` immutable cursor/fragment streams and the passive bridge `ArchitectureRecord` stream include the separate `knowledge-boundary` records. They are host integrations, not authored `Message` publications; reconstruct them without altering their bodies or provenance.

## Delivery, holds and closure

Internal members never produce foreground envelopes, including during retirement. The former direct intermediate response is not emitted by new tables.

The automatic Architect result remains the authored synthesis body, not an internal journal. The separate Reviewer result is a compact judgment with an effective-root object descriptor and referenced grounds, as described in [Reviewer tables](review.md#exterior-report-and-judgment). Neither result requires a read to discover its judgment. Explicit `architecture_read` and `review_read` retain their full canonical journals for diagnostics. Saved worker results and `team_result` use the same respective result bodies as automatic delivery.

Only a final result after disband reaches terminal handoff and hold reconciliation. A partial synthesis is `failed`, not success. Stop is `cancelled`; failed, partial and cancelled results retain applicable holds. Unbound drafts create no ledger or Board binding; a bound draft without a ledger does not authorize creating one.

Disband closes admissions/grants and joins owned starts, prompts, aborts and disposal before releasing resources. Unknown closure retains reservations and actionable diagnostics and prevents terminal driver handoff, fictitious success or fallback. The root still joins its own disposal when a child fails to close. There is no protocol persistence, restart recovery, new runner or daemon. Histories and public observation metadata continue to use existing Team identities and capture rules; older direct-mode captures remain readable without rewriting historical files. New emission uses the directed-table composition contract; old external clients must update.

## Passive public observation

An updated Node ESM bridge client can discover accepted tables with
`listArchitectures()` and read frozen structured facts with `readArchitecture()`,
without coordinator tools or execution effects. Detect the complete optional
`architecture.public-v1` capability group under bridge envelope v2.
See [Passive Architecture tables](agent-bridge.md#passive-architecture-tables) for
public types, compatibility, byte reconstruction, limits and closure semantics.
The original root WorkBrief remains the document source; mandates, controls,
settled publications, definitive outcome and physical closure are separate facts.
