---
name: pitako-coding
description: Use Pitako's coding baseline. Choose LSP for symbols, CodeGraph for architecture and impact, ast-grep for syntax, and grep for text. Keep diffs small and load specialized skills only when they apply. Use when navigating or changing code in a Pitako session.
---

# Pitako coding

Pitako is a Pi package. It does not replace Pi's model, provider, or built-in read, bash, edit, and write tools.

This skill is the router. Do not paste the full bodies of Ponytail, Caveman, practical skills, or principle-* skills into the session. Load one specialized skill when its trigger matches.

## Profiles

- `coding` (default): read, bash, grep, find, ls, LSP, CodeGraph, and ast-grep. Use `apply_patch` on supported models, otherwise `edit` and `write`.
- `analysis`: read/search and hash queries, without editing, hash saving or introduced Git/SSH/Python/Cargo mutators. The tool-call boundary blocks those directly and through codemode, including `ssh_pull`'s local writes and all `ast_rewrite` calls. Shell remains available. This is not a sandbox.

Official `pi-codex-tools` registers `apply_patch` and owns its grammar capability. Pitako selects it through the public `supportsOpenAIGrammarTools` helper for `openai-responses` or `openai-codex-responses` models with `compat.supportsOpenAIGrammarTools === true`. On these models, `edit` and `write` are inactive. Pitako reapplies the policy after startup, model changes, and profile changes. Pi-subagents owns its children's profiles and tool selection.

Switch with `/pitako profile analysis` or start Pi with `--pitako-profile analysis`. `PITAKO_PROFILE` is the fallback when the flag is omitted.

## Defaults

1. Inspect the actual repository before editing.
2. Start with supplied files and named seams. Choose navigation by question before broad grep, using the table below. Read the relevant source after navigation.
3. Reuse what already exists. Question whether new code is needed.
4. Keep the diff proportionate to the task. No speculative abstractions.
5. Before claiming the authorized assignment complete, load and apply `verify-behavior`. Before examining the solution, reconstruct material outcomes from the authorized request, accepted decisions and complete specs, not the diff, task plan or existing tests. Distinguish correctness from sufficiency: connect each outcome to implementation, current evidence and limits. Investigate material counterexamples; unresolved material gaps prevent completion. Explain why minor uncertainty cannot compromise the requested outcome. Justify fulfillment and limits in the existing report, not test counts. Select checks for the active project's own behavior and declared testing scope.
6. Default to conversation or analysis. A problem description, proposal or question does not authorize a new plan or implementation. A clear natural-language instruction authorizes the requested activity without magic words or turn-by-turn reconfirmation. Planning does not authorize implementation; a plan or available tools alone grants no authority. Conversation does not revoke already authorized work. Assigned children continue their authorized task within scope, not standby.
7. Outside root-owned /execute (no foreground or private child TODO supervision), for meaningful multi-step work, list existing TODOs, then create all known stages as `pending` before starting the first. Mark only the current step `in_progress` and complete it only after the work is actually done. Update existing tasks as you advance or resume; preserve unrelated tasks and never `clear` the list to rebuild it. Add genuinely new stages when discovered. Each session tracks its own assignment, not other workers' tasks. Skip TODOs for trivial tasks and purely conversational requests.

## Tools

Prefer deterministic Git/hash tools for covered operations and compose them
through native codemode. Keep bash/Python fallback for uncovered operations when
your role permits it. `git_status` reports working changes, not every tracked
file. Structured `git_diff` returns `stat` and the bounded `diff`, with
`fullOutputPath` when truncated. Stat-only requests return an empty `diff`. Git queries
may update metadata or spill output; they are not sandboxed.
`file_sha256` reads only. Authorized writers use `file_sha256_save` to hash and
atomically publish reusable items JSON in one call. Inspect structured `ok` and
`publication`: typed failures can return without throwing, and successful hashes
alone do not establish saving, a source snapshot, or passing tests.

### Choose navigation by question

| Question | First tool |
| --- | --- |
| Where is this symbol defined or referenced? | `lsp_goto_definition` or `lsp_find_references` at a known position. Use `lsp_symbols` to find a symbol or outline a file. |
| How does this subsystem work? | `codegraph_explore` for related source, or `codegraph_files` for the indexed structure. |
| Who calls this function, or what would a change affect? | `codegraph_callers`, `codegraph_callees`, or `codegraph_impact`. |
| Where is this code shape used? | `ast_search`, for example `console.log($$$ARGS)`. `$NAME` captures one syntax node and `$$$NAME` captures several. |
| Where is this exact string, log message, or config key? | `grep`. Use `find` or `ls` for file paths and `read` for known source. |
| What diagnostics does the language server report? | `lsp_diagnostics`. |

Do not approximate symbol references or syntax patterns with grep when the
matching navigation tool is available. ast-grep matches syntax, not types or
symbol identity. Use LSP when that distinction matters. With a symbol name but
no position, `codegraph_search` can locate it and `codegraph_node` can inspect it.
Do not query every backend for the same question.

Read the relevant source after navigation. If a backend is partial or unavailable,
report the limit and fall back to another supported tool or targeted read/grep.
Empty results do not prove absence. Check scope, language, or index coverage
before concluding that no callers or matches exist.

The `codegraph_*` tools need an existing index and do not initialize or refresh
it. Use `codegraph_status` when index availability or freshness is in question.
Do not install servers or initialize indexes without provisioning authority.
Pitako installs the TypeScript/JavaScript, Python, and PHP server dependencies;
Rust uses the host's `rust-analyzer`. A registered tool does not guarantee that
a server supports the requested operation. See [configuration](../../docs/configuration.md).

For an authorized rename, use `lsp_prepare_rename`, then `lsp_rename`.
For an authorized syntax replacement, preview `ast_rewrite` in an explicit file,
inspect the matches, then apply with `dryRun:false` and inspect the diff.
Read-only roles cannot rewrite or rename. Analysis blocks every `ast_rewrite`
call, including previews.

`edit` and `write` are blocked for `.git/`, `node_modules/`, `.env`, and `.env.*` files. Do not bypass that with shell unless the user explicitly asks. Those guards do not protect upstream `apply_patch`, which accepts absolute paths, symlinks, moves, and fuzzy matching. The old strict-path, exact-match engine and structured failures are gone. No sandbox is added; future bwrap or OpenShell work does not protect this version.

An excluded or absent Codex entry leaves coding `edit`/`write` available. The Codex entry invokes upstream install telemetry. Disable it with `PI_OFFLINE=1` or Pi's `enableInstallTelemetry:false` setting.

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
| Clarify an authorized assignment into confirmed complete specs | `plan` |
| Stress-test an idea with a decision-tree interview | `grilling` |
| Implement complete selected specs through native mission cycles | `execute` |
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
| Prepare a local diff for publication | `pre-pr` |

Do not load every skill. Do not load `caveman` at full or ultra unless the user asks. Do not load Ponytail and Caveman full bodies together.

Ordinary verification uses `verify-behavior`; it does not invoke `gates` maintenance. `/skill:gates` writes only the selected project's root guide within the user's requested scope. The app-driving skills are not alternative project-wide gate recipes.

Use the active project's `GATES.md`, not the installed Pitako checkout as a universal guide. Reading a dependency to understand a call does not authorize certification or repair. Pitako checks its own rules through controlled external boundaries, not the operation of its distributed dependencies. Other projects retain authorized integration requirements from their scope, contracts, and active guide, not Pitako's distributed stack.

Ponytail governs simplicity of implementation and verification. `verify-behavior` governs evidence validity and sufficiency, including optional TDD. Its Pitako clarification permits existing frameworks and fixtures instead of Ponytail's prescribed self-check artifact. Neither skill waives validation, security, accessibility, or required error handling. Caveman lite governs noise, not architecture.

## Board

Use the Board when information should stay visible as explicit shared context.

Use FINDING for a fact or constraint; DECISION for a chosen boundary before its authoritative artifact; QUESTION/ANSWER for cross-context coordination; BLOCKER only when another context cannot correctly continue; HANDOFF only for essential next-context knowledge; INFO sparingly for mission context. Do not post progress, status, test counts, heartbeats, or ordinary worker events (for example, `HANDOFF: T3 done, 44 tests pass`): TODOs and evidence own progress. Once absorbed, code, tests, or docs are authoritative. Keep posts concise and query with `board_query` or `board_topic_read` before posting a duplicate; do not load the whole Board when a focused query is enough.

Do not use the Board as a transcript, scratchpad, TODO list, or progress log. `todo` is the session plan. The Board is pull-based and is not injected into every turn. Use `board_topic_update` for ordinary topic lifecycle. Plan ownership and execution lifecycle tools are retired.

## Delegation

For authorized delegation, use bundled `pi-subagents`:
activate with `subagents_enable({})` if needed, inspect agents with
`subagent({ action: "list" })`, then use `subagent({ agent: "scout", task, async: false })`
for reconnaissance or `worker` for authorized implementation. Pass scope,
permitted effects and checks explicitly; analysis assignments stay read-only.
For native async work, return control after admission and interpret its automatic
completion. Do not poll or add watchers. Use retained-run status only when
diagnosis is needed. A launch failure is a blocker, not permission to switch
runtimes silently.

For authorized consultation or escalation, use `oracle`. Inspect the available
profiles first and pass the specific question, scope, and evidence. If oracle
is unavailable, report the blocker. Architect is not a general escalation role.

The `architecture` and `review` skills initiate their existing scripted
workflows. Scripts own dispatch; `pitako.architect` and `pitako.reviewer` perform
read-only reasoning without delegation. Advice and review completion are not
authorization, passing checks, or acceptance.

The former AgentInstance, Team, Head, table, routing, and bridge runtime is
retired. Its model policies and execution guarantees do not transfer to
pi-subagents. `/plan` uses grilling and actual foreground human confirmation.
`/execute` uses one explicit native mission-bound root workflow. Fresh read-only
directors publish loop_plan and end before sequential fresh `pitako.worker`
attempts with CodeGraph/LSP and the official model-compatible apply_patch adapter.
The root owns dispatch, checks, shared adversarial review and one individual
whole-spec compliance analyst. No foreground/private TODO supervision or final
validator; display existing structured progress and semantic closure. `/task`
is unavailable. No historical execution is resumed or maintained automatically.

## Web access

Use `web_search` for current external sources, `fetch_content` to read a URL, and `source_check` to collect cited evidence. Bundled `pi-web-access` needs network access and an available provider. `fetch_content` can clone GitHub repositories and save PDF text in a temporary directory.

## Not in this package

Poteto-mode is not bundled. Pitako adds no scheduler.
