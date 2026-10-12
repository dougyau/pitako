# Engineering layer

Pitako 0.1 is a Pi package. This note records its dependency choices, Board, roles, AgentInstance, Team assignments, direct navigation tools, and `$plan` / `$execute`.

## Decisions

### rpiv-todo: npm dependency, full extension

`@juicesharp/rpiv-todo` 2.11.0 is a real Pi package (MIT). Pitako depends on it and loads `node_modules/@juicesharp/rpiv-todo/index.ts`. That is the session-local TODO layer: `todo`, `/todos`, overlay, `blockedBy`, `owner`, `metadata`, and branch replay.

It is not Pitako Tasks or Memory. Do not overload it with Board semantics. The Board is a separate extension. Upstream keeps exactly one task `in_progress` per session. Team workers have separate sessions and separate TODO lists; do not turn one session's list into a shared roster.

`@juicesharp/rpiv-i18n` stays optional. Users configure overlay size, collapse key, and guidance through rpiv-todo's own `~/.config/rpiv-todo/config.json`. Disable the extension with Pi package filters.

### Ponytail: npm dependency, skill only

`@dietrichgebert/ponytail` 4.10.0 is a real Pi package (MIT). Its extension prepends the full skill body on every `before_agent_start`. That is always-on context. Pitako depends on the package and loads `node_modules/@dietrichgebert/ponytail/skills/ponytail` only.

Users who want always-on Ponytail can add `+node_modules/@dietrichgebert/ponytail/pi-extension/index.js` with Pi package filters. Pitako does not.

### Caveman: vendor MIT skills

Caveman is not a Pi package. `skills/` is MIT. Engine, proxy, browse, MCP, and the Go memory core are BSL-1.1. Pitako vendors `caveman` and `investigate-first` only. Default intensity is lite so architectural explanations stay in full sentences.

### pstack: vendor selected skills

`@zenspc/pi-pstack` 0.6.0 is the Pi-native port evaluated for the initial distribution. It loads poteto-mode, setup-pstack, and `pi-subagents`. Depending on it would add orchestration outside Pitako's AgentInstance and Team tools.

Pitako vendors selected skills from the official pstack plugin (Lauren Tan, MIT, plugin revision `6ed0f7a9504f577d7529064103cecce9be7dfc5e`) and rewrites the orchestrated ones (`how`, `why`, `architect`, `blast-radius`, `reflect`, verification procedures) for a single agent.

Pitako's `verify-behavior` consolidates the useful responsibilities of the retired `tdd`, `show-me-your-work`, and `principle-prove-it-works`. It loads from the existing `skills/practical` package location. Its modes select checks, review the complete agreed diff read-only, or recommend test simplification. Edits require explicit authorization and an editing role. See [Verify behavior](../README.md#verify-behavior) for usage and manual override migration.

The catalog and role defaults select `verify-behavior` once for Developer, Reviewer, Coordinator, and Researcher. Architect, ModelPolicy, resource filtering, and whole-array override semantics are unchanged. Retired override names fail with the existing `unknown skill` error.

`scripts/vendor-engineering-layer.py` no longer selects the retired principle. Reapply the verification-policy adaptations after vendoring: `principle-build-the-lever`, `principle-sequence-verifiable-units`, `principle-outcome-oriented-execution`, `create-verification-skill`, and `maintain-verification-skill`. The exact changes and other retained local edits are in `docs/provenance.json`. The consolidated skill retains pstack attribution and its MIT license.

Roles and workflows route evidence selection and test quality to `verify-behavior` within their existing passes. Developer implementation includes complete relevant diff self-inspection, including test infrastructure and deleted guarantees. Verification-only work does not add semantic review, and diagnosis-only work does not authorize repair. Reviewer consultations answer the assigned question. Correction reviews examine the finding, intervening change, and affected contracts. Neither is final approval. Final review independently covers the complete agreed final diff, underlying evidence, and relevant effects. Review findings need an affected contract or concrete risk and a plausible reachable path; a missing new test alone is not a defect. Evidence reuse does not cancel mandatory gates, final approval, or independent review.

Creating or maintaining a project verification procedure requires an explicitly authorized task. Missing or stale guidance during routine verification does not authorize a new skill, feature map, or tree audit.

Check selection starts from behavior owned by the active project and its declared testing scope. The active project's root `GATES.md` controls its procedure, not the installed Pitako checkout. Reading an external boundary to understand a call does not authorize dependency certification or repair. A Reviewer cannot require the real replaced runtime solely because a controlled boundary double verifies an owned rule. Other projects retain authorized integration requirements from their scope, contracts, and active guide, not Pitako's distributed stack.

Pitako acceptance covers its own rules, adapters, resource declarations, and instruction assembly through controlled external boundaries. It does not certify installation or operation of Pi, SDK, ACP, third-party extensions, providers, classifiers, CodeGraph, LSP, or Herdr. The complete checkout procedure is `bun run typecheck`, then `bun run test`, with normal file-parallel discovery. External certification checks are retired, not deferred gates. Local text and assembly checks observe policy availability, not future model compliance. Isolation, asynchronous settlement before cleanup, evidence limits, and independent review remain required.

`typescript-best-practices` lives under `skills/language/` and is not in the default `pi.skills` list.

### Codex tools and ACP: upstream entries, Pitako policy

`pi-codex-tools@0.3.0` owns `apply_patch` registration and grammar capability. `extensions/profile.ts` uses the public `supportsOpenAIGrammarTools` helper to select patch editing for supported OpenAI Responses and Codex models, or `edit` and `write` for other models. This applies to every coding role. Pitako reconciles the full tool set after startup, model events, profile changes, and child `setModel`, even when the selected model is unchanged. `analysis` excludes `edit`, `write`, `apply_patch`, and `lsp_rename` throughout.

Pitako no longer has a strict-path, exact-match patch engine or structured patch failures. Upstream accepts absolute paths, symlinks, moves, and fuzzy matching. Foreground `edit` and `write` protected-path guards do not protect `apply_patch`. Shell and ACP temporary output also remain available in `analysis`. Foreground and ad hoc sessions are not sandboxed.

`billion-context-pi@0.1.83` is the only compressor. `extensions/acp.ts` calls `createAcpExtension({ delegate: false, autoUpdate: false, toolBashDefaultTimeout: 0 })`. ACP does not add a default timeout to bash calls; explicit call timeouts still apply. Explicit `~/.pi/acp.json` and project `.pi/acp.json` retain upstream precedence, with project settings winning. Users can enable delegation or updates, or set `enabled:false`; Pitako does not rewrite their files. The factory reads the master switch using `process.cwd()`, while runtime options use `ctx.cwd`. A different child cwd is not a separate factory master-switch location.

`compress`, `search_context`, `decompress`, and `/acp` manage and recover blocks while keeping original session entries. Persistent sessions reload `<sessionFile>.acp.json`; in-memory children have no persistent sidecar. Active ACP cancels native manual `/compact` with `Compaction cancelled` and prevents automatic native summaries. Disabled ACP or a refused `bili` proxy leaves native compaction available. Pitako does not add `pi-codex-compaction`, a custom compactor, or a second scheduler.

The foreground entry is first in Pitako's manifest. It composes the official Codex factory, captures only its startup hook, and synchronously revokes the old foreground epoch before invoking/awaiting upstream startup and settling retired work. Upstream model selection remains registered before Pitako's profile policy. The ACP entry loads before Hermes so a cancelled compaction does not trigger Hermes's flush. The main loader and SDK child loader each register the official patch tool once, including children of `pi -e .`. Codex remains a bundled physical runtime prerequisite and invokes upstream install telemetry; `PI_OFFLINE=1` or Pi's `enableInstallTelemetry:false` disables it.

Codex registration is now attributed to `extensions/index.ts`: filtering `!node_modules/pi-codex-tools/index.ts` no longer disables it inside foreground, and manually adding the standalone official entry alongside foreground causes duplicate registration rather than automatic deduplication. Official Codex alone and standalone agent tools remain independent entrypoints. Caller-owned extensions loaded earlier than Pitako have no public lifecycle priority guarantee; the revoke-before-first-await contract applies to the shipped Pitako composition.

## Conflicts

| Tension | Resolution |
| --- | --- |
| Ponytail artifact prescription vs repository checks | Ponytail governs simplicity of implementation and verification. `verify-behavior` governs evidence validity and sufficiency. Developer child instructions clarify that existing frameworks and fixtures are valid and distinct contracts may need distinct checks. No dependency edit or hook enforces this instruction. |
| Ponytail "never stall" vs research ≠ implement | Profile note and `pitako-coding`: design does not authorize implementation. |
| Caveman full dialect vs clear architecture | Default lite. Full/ultra/wenyan only if the user asks. |
| pstack architect implements by default | Pitako architect stops at the sketch. |
| pstack how/why spawn subagents | Single agent, CodeGraph and LSP. |
| principle-never-block-on-the-human | Excluded. Later authority boundaries need inspect / experiment / implement. |
| unslop "must always apply" | Limited to prose. |

## Always-on context

The Pitako extension injects `profileNote` only: profile, inspect-first, small diffs, real verification, and "load a specialized skill only when it applies." Skill bodies stay out of that note.

## Configurability

Use Pi's package filters or `pi config`. Examples live in the README. Pitako does not add a settings file.

## Board

The Board is a workspace forum: topics hold posts of type INFO, FINDING, QUESTION, ANSWER, DECISION, BLOCKER, and HANDOFF. It is not a TODO list, a transcript, or memory.

Storage is SQLite at `$PI_CODING_AGENT_DIR/pitako/board.db`, falling back to `~/.pi/agent/pitako/board.db`. Pi runs on Node, so the driver is built-in `node:sqlite` (`DatabaseSync`). That module is still experimental in Node 22 through 25, but it is present on Pi's Node 22.19 floor and needs no native addon. Bun 1.3.14 does not implement `node:sqlite`, so tests open `bun:sqlite` through `extensions/board/sqlite.ts`. The SQL is the same. Schema version is `PRAGMA user_version`. New databases use v2. Existing v1 rows migrate to v2 without losing posts; incomplete or unsupported schemas fail without deleting data.

Workspace is `git rev-parse --show-toplevel`, or the canonical cwd outside a repository. Tools do not accept a workspace argument. Scope is always `global`. Foreground posts use author `pi`; child posts use their AgentInstance id. Topics can be bound to a plan with `board_workflow_claim`; `board_workflow_lifecycle` changes the status of a bound topic after its plan checks. Integer ids are SQLite row ids. There is no team scope or Thread table.

The extension registers tools and `/board`. It does not subscribe to agent events, so Board rows never enter the prompt unless a tool is called. List, read, and query results are capped.

## Roles and model policies

A role is a template. It is not an AgentInstance. Built-in roles are coordinator, architect, developer, reviewer, and researcher. Instructions are markdown under `roles/`. `config/defaults.toml` holds names, skill lists, principle lists, and empty model policies. No concrete provider is shipped.

User config is `$PI_CODING_AGENT_DIR/pitako/config.toml`. `smol-toml` parses it. There was no TOML parser in the tree. Scalar overrides replace one field. Skill, principle, primary, and fallback arrays replace the whole list when present and stay when omitted.

Developer has one responsibility and three capacity policies: `developer_senior`,
`developer_mid`, and `developer_junior`. They share the same instructions, skills,
tools, permissions and review contract. Explicit profile fields override explicitly
configured fields in the legacy policy named by `roles.developer.model_policy`;
omitted fields inherit, including reasoning, fast mode and provider fallbacks.
Bundled profiles have no concrete model. See
[developer-profiles.example.toml](../config/developer-profiles.example.toml) for
optional starting targets, not installed settings or quality claims.
Use `/pitako policies`, `/pitako policy developer_mid` (or senior/junior), and
`/pitako role developer` to inspect the resolved target and configuration sources.

Ordinary `agent_run` Developer dispatch uses the public host classifier APIs to
ask available `opencode/jev-1.13-free` one fixed capacity question about the exact
submitted WorkBrief. Submit non-secret context. Missing, indeterminate, failed or
malformed advice selects mid; cancellation never selects a replacement. Native
recording unavailable skips classification explicitly. The runner consumes an
immutable configuration/policy snapshot and never reclassifies; direct runner
callers use mid. Provider fallbacks stay within the selected policy. Other roles
and the principal model are unchanged.

The native `pitako.developer-routing` entry retains dispatch/advice/tool-call
identity, exact submitted context, complete public response and policy provenance.
Worker origin metadata carries this record through ordinary HistoryOrigin.
`agent_run` returns `dispatchId` plus the existing instance/history IDs. Classifier
usage is in the advice response, separately from worker usage. Native append can
be pending before a first assistant, not a persistence receipt; the returned
`routingEvidence` names that gap. Non-retained coordinators skip advice, and a
failed recording falls back to mid without a second writer or a claim of retained
probabilities.

Reasoning is Pi's `ThinkingLevel` plus `off`. The set is checked against the `ThinkingLevel` type so a new Pi level fails the build. Unsupported levels are rejected with `getSupportedThinkingLevels` only when the caller supplies models. Config load does not open Pi's model registry, so a named target can exist before auth does. Exact `provider/model` is required. Bare ids are rejected.

Fallback is availability only. The runner tries the next configured target for recognized provider or model failures; it does not accept `fallback_on`. The classifier matches error text because Pi does not export a stable provider error taxonomy. Test failures and unknown errors do not trigger fallback.

`getRole("architect")` and `resolveRole("architect")` return instructions, skills, principles, the policy id, the primary target, reasoning, and ordered fallbacks. If no primary is configured, resolution succeeds with a diagnostic instead of crashing.

## AgentInstance v0

`agent_run` stays synchronous. It creates one in-process Pi `AgentSession` with `SessionManager.inMemory`. That gives a new conversation and a new rpiv-todo session id without a child process. Pi's `setModel` keeps the same session when a provider fails after a mutating tool. A fresh session is used only when no mutating tool has run. Unknown errors and cancellation do not fall back. The child prompt is the role instructions plus the task. Parent messages are not passed in.

Board author is resolved from a process-shared session registry, not AsyncLocalStorage. A child Pi session id maps to the instance id. The foreground session stays `pi`. The model cannot pass an author. Child identity is registered before `bindExtensions({})`, which starts already-loaded extensions. Tool policy is reconciled after binding and after `setModel`, including same-model activation. Children start in `coding` independently of the parent profile and keep an explicit profile change of their own. Foreground Pitako orchestration stays excluded; explicit ACP configuration can still enable ACP delegates. A completed bind receives one `session_shutdown` before disposal and identity release. Failures before bind dispose without a fictitious shutdown. Role ModelPolicy selection is unchanged.

A policy model that an extension registers during session bind is resolved after that bind. A missing id is final only then, and the task is not sent until that model is active. Target activation is part of fallback. `setModel` throwing `No API key` is an auth failure, and the next target is tried. Unknown throws are not. Pi tools have no mutating flag. Known read-only names do not mark side effects. Every other name does. After that flag is set, fallback continues the same session and does not send the original task again. `reasoning = default` is not rewritten to `medium`.

A child session does not receive the foreground sentence that the user selected the model. `SessionStats` counters are cumulative, so same-session fallback records a delta, not a second absolute snapshot. `contextTokens` is a gauge and keeps the latest value. HTTP 5xx text classifies only with status wording, not a bare number. A fallback line is printed only after a fallback target starts. An already-aborted signal disposes the child before `prompt`. Windows child sessions include `powershell` when Pi registered it.

AgentInstance has no 20-minute deadline. The stops at that mark came from the parent tool timeout around `pi --mode json`, not from this package. Pi's HTTP idle timeout defaults to 5 minutes and stays a transport concern. The Pitako watchdog aborts only after confirmed inactivity: 10 minutes idle, 45 minutes during a tool, unless `max_run_time` is set above 0. Cache-warming events do not refresh activity. A stall is a terminal failure and does not fall back. An open cursor AgentSession run uses the tool window because native exec emits no Pi tool event, and a stall still does not switch models.

`agent_spawn` is the background scheduling path for that same `runAgentInstance`. It passes an owned `AbortController`, not the foreground tool signal. The registry is process-local (`Symbol.for("pitako.backgroundWorkers")`). It is not `ExecutionIdentity` and not SQLite. Status and result reads do not wait. Physical settlement collects one immutable full-result envelope, independent of watch metadata or UI. Idle delivery appends `pitako.worker.result` messages with `triggerTurn:false`, observes exact committed active-branch entries, then requests one short wake for the incorporated batch. Busy delivery offers complete `custom_message` drafts through `agent_before_settle`; newly offered context with a completed parent requests continuation even when the incoming preview's `canContinue` is false. Drafts, sends, and previews are not receipts.

Bookkeeping and delivery recover independently, with one initial operation and at most one later event-driven recovery per failed operation. Outstanding offers suppress duplicate offers until a safe final boundary; late exact receipts still reconcile after recovery is exhausted. Incorporation is historical once observed, but final `resultTaken` also requires reconciled or inapplicable bookkeeping and a subsequent public owning `turn_start` with the full result in its active branch. Neither this turn opportunity nor bookkeeping accepts work or completes a unit. Incorporated text is not resent to repair continuation; a rejected busy continuation never falls back to an idle wake. Parent abort/error restrictions clear only on an externally initiated owning run.

The captured foreground session ID, revision, owner token, and Team token fence every effect. Worker live-handle generation is not the foreground lease. Terminal manual-compaction/tree boundaries can deliver despite stale `isIdle`; automatic compaction during busy work is not final agent settlement. Retirement prevents retargeting and preserves cancellation/resource settlement. `steer` is not used for result handoff. Workers and handoffs do not survive reload, `/new`, fork, resume, or process exit.

`agent_supervise` stays a synchronous Herdr wait. It is not an AgentInstance path and it is not the background path. It requires Herdr presence and a current official Pi integration. The operator installs that integration with `herdr integration install pi`. Pitako does not install it. A supervised result is an instance id, a pane id, and a Herdr status. It is not an `AgentRunResult`.

## Team assignments

`team_assign` starts background AgentInstances from the foreground session. A complete WorkBrief can run autonomously even when a coordinator decision depends on its result. One assignment per role can run at a time; physical settlement releases occupancy independently of handoff. An exact assignment-ID catalog retains every accepted assignment for its lease, with a separate latest-role index for default status. `team_status`, `team_result`, and `team_cancel` use assignment IDs, not worker instance IDs. Automatic collection and optional diagnostic re-reads share idempotent bookkeeping under the captured assignment, topic applicability, and execution binding. Successful results reconcile only their own result hold; failed/cancelled outcomes retain applicable blocking holds. Ledger failures never hide the result. All settled outcomes use automatic full delivery, even ad hoc assignments. Child sessions cannot dispatch Team work. Ad-hoc Team state is not a durable scheduler or a Board scope.

## Direct navigation tools

Pitako loads LSP and CodeGraph through their direct extension entries. CodeGraph retains its upstream navigation prompt hook and uses the CLI through `codegraph serve --mcp`. Runtime tools do not initialize or refresh the index. This checkout's `scripts/setup.sh` attempts missing-index initialization best-effort after dependency/native prerequisites, using a CLI on PATH or in the checkout's `node_modules/.bin` and respecting a valid `CODEGRAPH_DIR` override. Existing indexes are untouched; missing CLI or initialization errors warn and continue. The noninteractive init child suppresses Git-hook offers, platform downloads, and telemetry/update network calls; it adds no runtime or startup hook. Other projects own their preparation. Read, grep, find, ls, and bash remain available for inspection, literal searches, and follow-up when a backend is partial or unavailable. `/pitako stats` reports general model and AgentInstance usage, not query-specific metrics.

## Plan and execute

`$plan` writes `.pitako/plans/<id>.md` and stops at `PLAN_FROZEN`. It does not invoke `$execute`. `$execute` is a separate skill. It requires `status: frozen`. `$plan` and `$execute` are not Herdr callers.

Both workflows dispatch Architect/Reviewer dependencies in background, including Level 2 consultations and final independent review. Prefer Team; use `agent_spawn` only when Team is not registered. This supersedes generic tool prompts recommending `agent_run` for Architect or limiting Team to independent work, without changing those prompts or synchronous ad hoc `agent_run`. Missing background tools block the required judgment; they do not permit inline specialist work or waived review. The coordinator ends its turn when no authorized independent work remains and interprets the complete automatic result before a dependent decision. Occupied Team roles require settlement and role release, not a transport fallback.

Planning records exact handles and the pending decision in `## Planning workers`, excluded from the consulted object with an explicit instruction to ignore it. A Board-bound draft without a ledger omits both `plan` and `unit` on Team dispatch; an unbound draft or compatible existing ledger can correlate consultations. Planning does not create an execution ledger to dispatch. Removing the operational section at freeze does not invalidate critique. After reload or process loss, one handle-specific status check can establish loss and permit one replacement planning consultation, never recovery of a real Team Hold. Execution keeps its existing unknown-handle blocker and hold recovery. In either workflow, an object change outside the WorkBrief invalidates the old judgment for the pending decision: interpret it without accepting it, cancel the exact active target, wait for settlement and role release, then consult against the current object. Steering receipts do not prove correction or replace that consultation.

`extensions/workflow.ts` resolves paths from the git root, or from cwd outside a repository. `initLedger` creates `.pitako/runs/<id>/ledger.md` once and does not overwrite it. Resume reads the plan and the ledger before evidence. A revision or hash mismatch stops the run. Evidence stays under `.pitako/runs/<id>/evidence/`. The helper rejects `..`, absolute paths, and separators. It is not a workflow engine.

`todo` is the session checklist. Board posts are shared findings and handoffs. The plan is the frozen decision. The ledger is the checkpoint. Evidence is proof. The repository is the product change.

`remove-ai-slops` is on the developer skill list. Use it after verification is green, and only when the diff is large enough to hide waste. It is not mandatory, and not a pass after every edit.

## Dogfood

The original rpiv-todo dogfood exercised the real upstream tool. The original Board dogfood used topic `Board v0 dogfood` in `~/.pi/agent/pitako/board.db`, followed by external loader checks. Those dependency checks and their exclusive scripts are retired. Current tests observe Pitako's resource declarations and Board behavior without certifying the external runtime. No Pitako Task system was added.

The TODO list stayed the execution checklist. The Board held the finding, the decision, and the handoff. That split was natural. Friction: a session started before the extension existed does not see `board_*` until reload, so the posts were made by executing the registered tools in a bun process. `node:sqlite` still prints an experimental warning, and Bun 1.3.14 cannot import it.

Roles v0 dogfood wrote a local `~/.pi/agent/pitako/config.toml` for the authenticated providers on this machine. That file is not in the repository. `resolveRole("architect")` returned the markdown instructions, the skill and principle lists, the primary target, reasoning, and ordered fallbacks. Nothing was spawned.

The original dogfood used `ponytail` to compose rather than reimplement, `principle-experience-first` for install behavior, and the now-retired `principle-prove-it-works` for direct tool results. `verify-behavior` now owns the evidence policy.
