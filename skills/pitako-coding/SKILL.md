---
name: pitako-coding
description: Use Pitako's coding baseline. Router plus philosophy for a curated Pi coding session. Keep raw LSP and CodeGraph visible, keep diffs small, and load specialized skills only when they apply. Use when navigating or changing code in a Pitako session.
---

# Pitako coding

Pitako is a Pi package. It does not replace Pi's model, provider, or built-in read, bash, edit, and write tools.

This skill is the router. Do not paste the full bodies of Ponytail, Caveman, practical skills, or principle-* skills into the session. Load one specialized skill when its trigger matches.

## Profiles

- `coding` (default): read, bash, grep, find, ls, LSP, CodeGraph, and ACP context tools. All coding roles use `apply_patch` on supported models, otherwise `edit` and `write`.
- `analysis`: the same read and search tools, without `edit`, `write`, `apply_patch`, or `lsp_rename`. Shell and ACP temporary output are still available. This is not a sandbox.

Official `pi-codex-tools` registers `apply_patch` and owns its grammar capability. Pitako selects it through the public `supportsOpenAIGrammarTools` helper for `openai-responses` or `openai-codex-responses` models with `compat.supportsOpenAIGrammarTools === true`. On these models, `edit` and `write` are inactive. Pitako reapplies the policy after startup, model changes, and profile changes, including same-model child activation. Children start in `coding` independently of the parent profile.

Switch with `/pitako profile analysis` or start Pi with `--pitako-profile analysis`. `PITAKO_PROFILE` is the fallback when the flag is omitted.

## Defaults

1. Inspect the actual repository before editing.
2. Keep read, grep, LSP, and CodeGraph available. Choose a supported LSP or CodeGraph tool for bounded structural questions; use read, grep, or bash for literal, exhaustive, or exact results. Follow up with those tools when a backend is partial or unavailable.
3. Reuse what already exists. Question whether new code is needed.
4. Keep the diff proportionate to the task. No speculative abstractions.
5. Verify real behavior (diff, tests, command output) before claiming done. Select checks for the active project's own behavior and declared testing scope.
6. Default to conversation or analysis. A problem description, proposal or question does not authorize a new plan or implementation. A clear natural-language instruction authorizes the requested activity without magic words or turn-by-turn reconfirmation. Planning does not authorize implementation; a plan or available tools alone grants no authority. Conversation does not revoke already authorized work. Assigned children continue their authorized task within scope, not standby.
7. For meaningful multi-step work, list existing TODOs, then create all known stages as `pending` before starting the first. Mark only the current step `in_progress` and complete it only after the work is actually done. Update existing tasks as you advance or resume; preserve unrelated tasks and never `clear` the list to rebuild it. Add genuinely new stages when discovered. Each session tracks its own assignment, not other workers' tasks. Skip TODOs for trivial tasks and purely conversational requests.

## Tools

Keep read/grep, LSP, and CodeGraph visible, with `bash` and the model-compatible editing tools in the coding profile. Choose supported LSP or CodeGraph tools for bounded structural questions. Use read, grep, or bash for literal searches, exhaustive or exact results, unsupported backends, and follow-up.

The `codegraph_*` runtime tools use the CodeGraph CLI and need an existing index; they do not initialize or refresh it. This checkout's `scripts/setup.sh` attempts missing-index initialization best-effort after dependencies are ready. Other projects own their optional preparation; use it or run `codegraph init` explicitly when you want CodeGraph navigation. If initialization is unavailable or fails, continue with LSP/read/grep.

- `lsp_diagnostics` for server diagnostics
- `lsp_goto_definition` and `lsp_find_references` for navigation
- `lsp_symbols` for a document outline or workspace symbol search
- `lsp_prepare_rename`, then `lsp_rename`, when a rename should be applied

LSP needs an installed server for the file type. It can resolve a command on `PATH`, in the project's `node_modules/.bin`, or at an explicit path. TypeScript defaults to `typescript-language-server`. Servers are not installed automatically; `/lsp install <id>` installs supported recipes. A registered tool does not guarantee that a server or its requested operation is available.

`edit` and `write` are blocked for `.git/`, `node_modules/`, `.env`, and `.env.*` files. Do not bypass that with shell unless the user explicitly asks. Those guards do not protect upstream `apply_patch`, which accepts absolute paths, symlinks, moves, and fuzzy matching. The old strict-path, exact-match engine and structured failures are gone. No sandbox is added; future bwrap or OpenShell work does not protect this version.

ACP is the only compressor; `pi-codex-compaction` is not loaded. Use `compress`, `search_context`, `decompress`, and `/acp` for blocks. Original entries remain available. Persistent sessions reload `<sessionFile>.acp.json`; in-memory children retain state only for their session's lifetime. With ACP active, native `/compact` reports `Compaction cancelled` and automatic compaction creates no native summary. Disabled ACP or a refused `bili` proxy leaves native compaction available.

Pitako's ACP factory defaults to `{ delegate: false, autoUpdate: false, toolBashDefaultTimeout: 0 }`. ACP does not add a default timeout to bash calls; explicit call timeouts still apply. Explicit `~/.pi/acp.json` and project `.pi/acp.json` override these defaults, with project settings winning. They can enable delegates or updates, or set `enabled:false`. Preserve user files. The factory reads the master switch from `process.cwd()`; runtime options use `ctx.cwd`. A different child cwd does not change the factory's master-switch location. Children cannot use Pitako orchestration, but explicit ACP configuration can enable ACP delegates.

The manifest starts with early lifecycle, the independent official Codex entry, then late profile policy; ACP remains before Hermes. An excluded or absent Codex entry leaves coding `edit`/`write` available. Children load only the Pitako package root; parent filters are not automatically inherited and loader deduplication is not assumed. Managed Head requires exactly one canonical public-entry patch registration. The Codex entry invokes upstream install telemetry. Disable it with `PI_OFFLINE=1` or Pi's `enableInstallTelemetry:false` setting.

## Load when it applies

| Situation | Skill |
| --- | --- |
| Writing or shrinking implementation | `ponytail` |
| Tight tool use, less filler | `caveman` (lite) |
| Ambiguous failure, do not fix yet | `investigate-first` |
| How does this currently work? | `how` |
| Why is it shaped this way? | `why` |
| Shared API, type, or module change | `blast-radius` |
| Cross-module design before code | `architecture-design` |
| Explicit multi-perspective design discussion through pi-subagents | `architecture` |
| Explicit advisory adversarial review through pi-subagents | `review` |
| Review unnecessary complexity without applying fixes | `ponytail-review` |
| Novel architecture with no precedent | `principle-exhaust-the-design-space` |
| Verify behavior, review test quality in a diff, or simplify tests within authorized scope | `verify-behavior` |
| Debugging | `principle-fix-root-causes` |
| Stateful or domain-heavy feature | `principle-foundational-thinking`, `principle-model-the-domain` |
| Config, API, or validation work | `principle-boundary-discipline` |
| Large exploration | `principle-guard-the-context-window` |
| Same correction keeps appearing | `principle-encode-lessons-in-structure` |
| Explicit request to create or bounded-update root `GATES.md` | `/skill:gates` only |
| Explicitly authorized task to create an app-driving verification skill and feature map | `create-verification-skill` |
| Explicitly authorized task to maintain or audit an app-driving verification skill and feature map | `maintain-verification-skill` |
| Docs, README, PR prose | `technical-writing`, then `unslop` |
| Hard finished work, what to keep | `reflect` |
| Decision-complete plan, then stop | `plan` |
| Implement one frozen plan | `execute` |
| Prepare a local diff for publication without `$execute` | `pre-pr` |

Do not load every skill. Do not load `caveman` at full or ultra unless the user asks. Do not load Ponytail and Caveman full bodies together.

Ordinary verification uses `verify-behavior`; it does not invoke `gates` maintenance. `/skill:gates` writes only the selected project's root guide within the user's requested scope. The app-driving skills are not alternative project-wide gate recipes.

Use the active project's `GATES.md`, not the installed Pitako checkout as a universal guide. Reading a dependency to understand a call does not authorize certification or repair. Pitako checks its own rules through controlled external boundaries, not the operation of its distributed dependencies. Other projects retain authorized integration requirements from their scope, contracts, and active guide, not Pitako's distributed stack.

Ponytail governs simplicity of implementation and verification. `verify-behavior` governs evidence validity and sufficiency, including optional TDD. Its Pitako clarification permits existing frameworks and fixtures instead of Ponytail's prescribed self-check artifact. Neither skill waives validation, security, accessibility, or required error handling. Caveman lite governs noise, not architecture.

## Board

Use the Board when information should stay visible as explicit shared context.

Use FINDING for a fact or constraint; DECISION for a chosen boundary before its authoritative artifact; QUESTION/ANSWER for cross-context coordination; BLOCKER only when another context cannot correctly continue; HANDOFF only for essential next-context knowledge; INFO sparingly for mission context. Do not post progress, status, test counts, heartbeats, or ordinary worker events (for example, `HANDOFF: T3 done, 44 tests pass`): ledger and evidence own progress. Once absorbed, the plan, code, tests, or docs are authoritative. Keep posts concise and query with `board_query` or `board_topic_read` before posting a duplicate; do not load the whole Board when a focused query is enough.

Do not use the Board as a transcript, scratchpad, TODO list, or progress log. `todo` is the session plan. The Board is pull-based and is not injected into every turn. Bind an existing open topic to a draft plan with `board_workflow_claim`. Only a foreground session can finalize the plan-owned topic with `board_workflow_lifecycle`.

## Roles

An explicitly requested `architecture` skill discussion uses only `pi-subagents`
with dynamic perspectives on the same complete problem. It is advisory and
separate from the managed Architect route below. It does not replace required
managed passes or bypass their admission.

For authorized ordinary foreground delegation, prefer bundled `pi-subagents`:
activate with `subagents_enable({})` if needed, inspect agents with
`subagent({ action: "list" })`, then use `subagent({ agent: "scout", task, async: false })`
for reconnaissance or `worker` for authorized implementation. Pass scope,
permitted effects and checks explicitly; analysis assignments stay read-only.
Use `subagent({ action: "status", id: "<run-id>" })` and `bg_wait` for retained runs.
This runtime does not inherit Pitako `ModelPolicy`, routing, reservations, history
or the T3 agent bridge. Keep `$plan`, `$execute`, `/task`, Developer Head and
Architect/Reviewer tables on their existing Pitako routes. Never substitute
`subagent` for missing policy, failed admission or child/managed restrictions.
Pitako children do not receive these upstream orchestration tools.

`/pitako roles` and `/pitako role <id>` show role definitions. A role is a responsibility template; its `ModelPolicy` selects the instance's primary model and fallbacks. `agent_run` executes an allowed individual instance synchronously. The foreground session uses `team_assign`, `team_status`, `team_result`, and `team_cancel` for individual Team work; `/pitako team` inspects its roster. Architect and Reviewer use only `architecture_start` and `review_start`, including ad hoc questions. If the required start is absent, the pass is blocked, not individual, inline or waived. Background results are supplied automatically in the owning context, with or without plan/unit correlation. Tables supply either a complete inline report or an incomplete reference: read pertinent `team_result` sections before a dependent decision. Start with optional `section` and `maxBytes` (4096..16384 bytes, default 16384); continue with cursor only. Do not automatically load every page. Ordinary assignments retain complete results and optional diagnostic re-reads. Do not poll or acknowledge collection. Automatic handoff, transport end and report completion are not work acceptance or unit completion. Child instances do not receive orchestration tools. If delegation fails, report the error; do not take over that specialist work.

Ordinary Team role work admits distinct members, including repeated roles; Team, role and member/assignment are different identities. Both starts use a substantive director with its own role primary and zero to five optional specialists selected for utility with reasons, including zero. Selective recomposition retains useful conversations. Missing table configuration, omitted candidates and empty candidates mean an empty pool; `architecture_start` has no `mode`. Tables replace existing Architect/Reviewer passes, not add passes. Record and watch only the exterior root. Interpret its complete terminal current-object judgment and keep independent Reviewer critique separate from designers. This does not relax `$execute`'s one exterior Developer, asynchronous Head/writes, integration barriers, checkpoint authority, holds or acceptance policy.

## Web access

Use `web_search` for current external sources, `fetch_content` to read a URL, and `source_check` to collect cited evidence. Bundled `pi-web-access` needs network access and an available provider. `fetch_content` can clone GitHub repositories and save PDF text in a temporary directory.

## Not in this package

Poteto-mode is not bundled. `$plan` and `$execute` are skills, not a scheduler.
