# Pitako

Pitako is a small, installable [Pi](https://github.com/earendil-works/pi) package. It gives you a curated coding session on top of the Pi you already run: normal coding tools, LSP, and CodeGraph, plus a read-only analysis profile.

It is an opinionated composition of Pi. It is not a fork, and it does not replace Pi's model or provider.

## Engineering philosophy

Pitako is a curated engineering distribution of Pi, not a concatenation of other frameworks.

It currently combines:

- [Ponytail](https://github.com/DietrichGebert/ponytail) (Dietrich Gebert) for the smallest complete implementation
- selected [Caveman](https://github.com/JuliusBrussee/caveman) (Julius Brussee) coding-skill behavior, lite by default
- selected [pstack](https://github.com/cursor/plugins/tree/main/pstack) practical skills and `principle-*` skills (Lauren Tan)
- LSP (`pi-lsp-client`) and CodeGraph (`@vndv/pi-codegraph`)
- [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) for session-local TODOs

Not every skill or principle is active all the time. Pi keeps names and descriptions in context and loads a skill body when the task matches. Principles are contextual. Roles can use different subsets. Team assignments and the workspace Board are available to the foreground session.

`pitako-coding` is the router: inspect the repo, keep raw read, grep, LSP, and CodeGraph available, use bounded Code Intelligence queries when they fit, keep diffs small, verify real behavior, and load a specialized skill only when it applies. It does not embed the full Ponytail, Caveman, or pstack bodies.

Disable Ponytail, Caveman, or any individual skill with `pi config` or package skill filters. See [Disable or override](#disable-or-override-an-extension). Attribution and pins are in [THIRD_PARTY.md](THIRD_PARTY.md). Decisions are in [docs/engineering.md](docs/engineering.md).

## What this milestone is

- A Pi package (`keywords: pi-package`) with the Pitako extension, the Board extension, curated skills, and one prompt.
- The **coding** profile: Pi's read, bash, edit, and write tools, plus grep, find, and ls, plus LSP and CodeGraph.
- The **analysis** profile: the same read and search tools, without `edit`, `write`, `apply_patch`, or `lsp_rename`.
- Six bounded, read-only Code Intelligence queries: `project_report`, `read_symbol`, `read_enclosing`, `module_report`, `inspect_symbol`, and `review_surface`. Graph-backed queries create or refresh their index when needed under Node; raw tools remain visible.
- Startup checks that fail with a clear configuration error when a required extension file or the `codegraph` CLI is missing.
- On-demand Ponytail, selected Caveman skills, and selected pstack practical skills and principles.
- Session-local TODOs via `@juicesharp/rpiv-todo` (`todo`, `/todos`, overlay).
- A workspace-scoped Board (`board_*` tools, `/board`) stored in SQLite. Plans can bind and finalize their own topics.
- Role definitions and model policies (`/pitako roles`). These are templates, not running agents.
- `agent_run` for one synchronous in-process AgentInstance. It does not start a team.
- `agent_spawn` for one background in-process AgentInstance. The Coordinator stays available. `agent_status`, `agent_result`, and `agent_cancel` inspect that worker. `/pitako agents` prints the same compact view.
- `agent_supervise` for one synchronous visible sibling pane. It does not run in the background or join the Team roster.
- `team_assign`, `team_status`, `team_result`, and `team_cancel` for independent foreground Team assignments, with one active assignment per role.
- `$plan` and `$execute`. Planning stops at `PLAN_FROZEN`. Execution is a separate invocation. Neither calls Herdr.

## Session TODOs

Pitako uses [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) (juicesharp, MIT) as the tactical plan for the current Pi session.

- `todo` — create, update, list, get, delete, clear
- `/todos` — print the list grouped by status
- live overlay above the editor (`ctrl+shift+t` collapses it)
- session/branch replay, so the list survives `/reload` and compaction
- `blockedBy` dependencies (cycles are rejected)
- `owner` and `metadata` fields, unused by Pitako today and left for later Task/Board wiring

This is not Pitako's Task system or Memory. The Board is a separate forum. See [Board](#board). Skip TODOs for trivial tasks and purely conversational requests. Configure overlay size, collapse key, and model guidance in rpiv-todo's own `~/.config/rpiv-todo/config.json`. Disable the extension with a package filter: `!node_modules/@juicesharp/rpiv-todo/index.ts`.

## Board

Pitako Board is a forum for the current workspace. A topic is one shared subject. Posts record what the work established. The Board is not chat history, a TODO list, a task scheduler, or durable memory.

```
Board
└── Topic
    └── Posts
```

Post types are `INFO`, `FINDING`, `QUESTION`, `ANSWER`, `DECISION`, `BLOCKER`, and `HANDOFF`.

| Tool | Behavior |
| --- | --- |
| `board_topic_create` | Create a topic. Scope is `global` and status starts `open`. The foreground author is `pi`; child authors use their AgentInstance id. |
| `board_topic_list` | List topics in this workspace. Defaults to open, newest activity first. Default 20, max 50. |
| `board_topic_read` | Read one topic and a page of posts, oldest to newest within the page. Default 40, max 100. Page with `beforePostId` or `afterPostId`. |
| `board_topic_update` | Change title, description, or status (`open`, `resolved`, `closed`). Plan-owned topic status uses `board_workflow_lifecycle`. |
| `board_workflow_claim` | Bind an existing open topic to a draft plan. |
| `board_workflow_lifecycle` | Resolve or close the bound plan topic from the foreground session after plan checks. |
| `board_post` | Add a post. `replyTo` must be a post in the same topic. |
| `board_query` | Filter current-workspace posts by topic, type, author, or text. Default 20, max 50. |

`/board` lists open topics. `/board 3` reads topic 3.

`todo` is the session plan. The Board is shared knowledge. Do not copy TODOs onto the Board, and do not create TODOs from posts.

The database is `$PI_CODING_AGENT_DIR/pitako/board.db`. If `PI_CODING_AGENT_DIR` is unset, that path is `~/.pi/agent/pitako/board.db`. A relative `PI_CODING_AGENT_DIR` resolves to an absolute path. The file is shared by the Pi installation. Each topic stores a workspace. The workspace is the git repository root, or the current directory when you are not in a git repository. Topics from another repository do not appear.

Agents pull the Board by calling the tools. Pitako does not inject topics or posts into every turn.

Storage is SQLite schema version 2, with foreign keys and WAL. It migrates v1 data without deleting posts and rejects incomplete schemas. Node uses built-in `node:sqlite`; Bun tests use `bun:sqlite`. Scope is `global` only. Decisions are immutable posts. A later post can point at an earlier one with `replyTo` or metadata such as `{"supersedes": 17}`. There is no decision graph. A `DECISION` post does not resolve the topic. Set the status when the discussion is done or no longer relevant.

Private boards, memory, embeddings, and automatic summaries are not in this version. A later Pitako Thread may namespace topics.

Disable the extension with a package filter: `!extensions/board/index.ts`.

## Roles and model policies

A role is a reusable responsibility template, not a running agent. AgentInstances use roles for synchronous runs, background workers, and Team assignments.

```
RoleDefinition
  -> ModelPolicy
    -> ModelTarget
```

The role carries instructions, skills, and principles. The model policy carries an ordered list of model targets. A target is a Pi model id (`provider/model`) plus an optional reasoning level. The role is not a model.

Built-in roles are `coordinator`, `architect`, `developer`, `reviewer`, and `researcher`. Instructions live in `roles/*.md`. Structured defaults live in `config/defaults.toml`. Concrete models are not shipped, because installations do not share subscriptions.

User overrides go in `$PI_CODING_AGENT_DIR/pitako/config.toml`. If `PI_CODING_AGENT_DIR` is unset, that path is `~/.pi/agent/pitako/config.toml`. Do not edit the package to change models.

Precedence is built-in defaults, then the user file. A scalar replaces that field when set. A `skills` or `principles` array replaces the built-in list when set, and is left alone when omitted. `primary` and `fallbacks` work the same way. There is no append merge.

Reasoning uses Pi's levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `default`, or omitting the field, leaves the later runner on Pi's session default. Pitako does not clamp a level the model cannot do. When a model catalog is supplied, an unsupported level fails. Without a catalog, only the syntax of `provider/model` is checked, so a target can be named before that provider is authenticated.

### Fast requests

A target can set `fast = true` to request provider-specific priority service. Pitako sends `service_tier = "priority"` for both `openai-codex/gpt-6-luna` and `xai/grok-4.7`. Omitting `fast` or setting it to `false` keeps normal service behavior. Pitako's `fast` flag is separate from Codex CLI's `fast_mode` option. See the [Codex Fast mode documentation](https://developers.openai.com/codex/agent-configuration/speed/) and the [Codex configuration reference](https://developers.openai.com/codex/config-file/config-reference/).

```toml
[model_policies.developer.primary]
model = "openai-codex/gpt-6-luna"
reasoning = "max"
fast = true
```

```toml
[model_policies.reviewer.primary]
model = "xai/grok-4.7"
reasoning = "xhigh"
fast = true
```

These settings express request intent, not a granted tier. A provider endpoint can accept a request and still serve it at the standard tier. xAI `priority` means priority processing, not the separate Grok 4.7 Fast model variant.

`agent_run` and `agent_result` include per-request summaries: `fast_requested`, `requested_service_tier`, `returned_service_tier`, and `time_to_first_model_output_ms`. `requested_service_tier` records the request, not the tier served. Current Pi does not expose the response service tier, so `returned_service_tier` is `unavailable`. Time to first model output is elapsed time from the Pi model-stream request start to the first non-empty text or thinking delta, or first tool-call start. Pi-reported cost is an estimate, not the provider's bill. The requested tier, response time, and estimated cost do not establish that ChatGPT Fast was active.

Herdr has no fast-mode parity. `agent_supervise` rejects a `fast = true` primary before splitting a pane. A fast fallback is not selected by Herdr.

Fallback means the preferred target could not be used because of provider or model availability: rate limit, quota, outage, or auth. It does not mean the code failed tests, the answer was weak, or the task got hard. `agent_run` may switch to the next target for those availability failures only. Pi does not export a stable error taxonomy, so `fallback_on` is not configurable.

A fresh install still resolves a role. The model policy diagnostic says no primary target is configured. It does not crash the coding session.

```toml
[model_policies.architect.primary]
model = "openai-codex/gpt-5.6-sol"
reasoning = "high"

[[model_policies.architect.fallbacks]]
model = "example/other-model"
reasoning = "medium"
```

Inspect the effective config with `/pitako roles`, `/pitako role architect`, `/pitako policies`, and `/pitako policy architect`. These commands do not show API keys and do not write config.

## AgentInstance

A RoleDefinition is a template. An AgentInstance is one isolated run of that role.

```
agent_run({ role: "architect", task: "..." })
```

The child gets the role instructions, that role's skills and principles, the Pitako coding baseline, the current cwd, and the shared Board. It does not get the parent transcript or the parent TODO list. Board posts from the child use the instance id as author. That id is looked up from the child Pi session, not from a module-local async store and not from a tool argument.

The run is synchronous. It returns the final result, the instance id, the selected model, the reasoning level, and whether a fallback happened. It does not return the child transcript.

The model comes from the role's ModelPolicy. An explicit reasoning level is applied. `default`, or an omitted level, is not rewritten to `medium`. Pi keeps its own default. Activating a target includes resolving the model and `setModel`. A quota, rate-limit, auth, or unavailable failure at that step tries the next target. An unknown error does not.

Before a mutating or unknown tool runs, the next target may start a fresh session. After one runs, the same session switches model and continues. The original task is not sent again. Unknown tools count as potential side effects. Pi does not mark tools as mutating, so this list is fail-safe rather than a registry. A failed test does not switch models. If every target fails, `agent_run` returns the error. The parent must not do that role's work itself.

The result can include turns, input, output, cache tokens, cost, and tool-call counts when Pi reports them. Input tokens are cumulative across turns, not the size of one prompt.

The child cannot call `agent_run`, `agent_supervise`, `agent_spawn`, `agent_status`, `agent_result`, `agent_cancel`, or the `team_*` orchestration tools. It cannot delegate. Same-session fallback can continue a child run; it does not expose a separate resume command.

`agent_spawn` returns while the worker is still running. The worker has its own cancellation. A later Coordinator turn does not cancel it. Completion is one short signal. The result stays out of the Coordinator conversation until `agent_result`. A spawn with `plan` and `unit` can wake an idle `$execute` turn. A spawn without that pair only notifies the UI. Herdr background supervision is not in this milestone.

There is no fixed wall-clock deadline. A run ends for inactivity, not because it is old. The default idle window is 10 minutes with no tool running, and 45 minutes while a tool is running. `max_run_time = "0"` means unlimited. Parent cancellation is immediate and is not a stall. An open cursor AgentSession run uses the tool window because native exec emits no Pi tool event, and a stall still does not switch models. Prompt-cache warming does not count as progress. Pi's HTTP idle timeout is a separate transport limit and is left unchanged.

```toml
[agent_runtime]
idle_timeout = "10m"
tool_stall_timeout = "45m"
max_run_time = "0"
```

`[agent_runtime]` is the in-process watchdog. It does not apply to a supervised pane.

## Visible pane

`agent_supervise` is a separate tool. It requires Herdr presence and a current official Pi integration. The operator installs that integration with `herdr integration install pi`. Pitako does not install it. The result is an instance id, a pane id, and a Herdr status. It is not an `AgentRunResult`.

## Plans

`$plan` investigates, writes a decision-complete plan, and stops at `PLAN_FROZEN`. It does not implement, and it does not invoke `$execute`.

`$execute <plan-id>` is the implementation authority for that frozen plan. Until that invocation, planning completion is not permission to change the product.

`/skill:pre-pr [base=<local-ref>]` prepares the current worktree diff for first or later publication without `$plan`, a frozen plan, or `$execute`. It never commits or performs remote actions.

Artifacts live in the workspace (git root, or the current directory outside a repository):

```
.pitako/plans/<id>.md
.pitako/runs/<id>/ledger.md
.pitako/runs/<id>/evidence/
```

Six records stay separate. `todo` is the current session checklist. The Board holds shared findings, decisions, and handoffs. The plan is the frozen decision. The ledger is the resume checkpoint: plan id, revision, content hash, status, and rulings. Evidence is proof for one unit. The repository is the product change. Do not use one as a substitute for another.

`$plan` and `$execute` are not Herdr callers. Team assignments can run independent work, but there is no DAG scheduler.

## What this is not yet

Pitako does not implement subteams or a DAG scheduler. Team assignments let independent roles run concurrently, with one assignment per role. Session TODOs are local execution plans. The Board is not a team roster or a memory store.

Web search is not bundled. See [Web research](#web-research).

## Requirements

- Node.js 22.19 or newer (same floor as current Pi).
- [Pi coding agent](https://github.com/earendil-works/pi) `@earendil-works/pi-coding-agent` 0.87 or newer.
- Bun 1.3 if you are developing this repository. People who only install a published package do not need Bun.
- An installed language server for LSP. It can be resolved from `PATH`, a project-local `node_modules/.bin`, or an explicit command path. TypeScript defaults to `typescript-language-server`; `/lsp install <id>` offers explicit installation for supported servers.
- CodeGraph CLI. This package depends on `@colbymchenry/codegraph` and will use `node_modules/.bin/codegraph` when `codegraph` is not already on `PATH`.

Pitako does not set a provider or model. Use whatever you configured in Pi.

## Install into Pi

From a checkout, install dependencies first. A local path install does not run `npm install` for you.

```bash
bun install
pi install .
```

`pi install .` writes the package into Pi settings. Add `-l` to install it for the current project instead of your user settings.

Try it once without saving settings:

```bash
bun install
pi --no-extensions --approve -e .
```

`--no-extensions` skips other discovered extensions so you can see Pitako on its own. `-e .` still loads this package. Drop `--no-extensions` when you want Pitako together with your other packages.

Development shortcut, using the Pi binary from this repo's dev dependency rather than whatever `pi` is on your `PATH`:

```bash
bun run pi
```

Open a project with source files and a language server for LSP. Dense graph queries build or refresh the CodeGraph index as needed under Node; raw `codegraph_*` queries need an existing index. Run `codegraph init` if you plan to use raw CodeGraph before any dense graph query.

## Development

```bash
bun install
bun test
bun run smoke
bun run typecheck
```

`bun test` includes the smoke test. `bun run smoke` is the same check, printed on the console.

## Profiles

| Profile | Tools |
| --- | --- |
| `coding` (default) | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, LSP, CodeGraph, and read-only Code Intelligence queries. Developer AgentInstances also get `apply_patch`. On Windows, `powershell` is included when Pi registered it. |
| `analysis` | `read`, `bash`, `grep`, `find`, `ls`, LSP, CodeGraph, and read-only Code Intelligence queries. No `edit`, `write`, `apply_patch`, or `lsp_rename`. |

Shell is still available in `analysis`. Restricting bash safely would be a separate sandbox, and this milestone does not add one.

```bash
pi --no-extensions --approve -e . --pitako-profile analysis
```

Or, inside a session: `/pitako profile analysis`. `/pitako` prints the current profile.

`PITAKO_PROFILE` is used when `--pitako-profile` is omitted. An unknown name fails startup with `PitakoConfigError`.

`edit` and `write` are blocked for `.git/`, `node_modules/`, `.env`, and `.env.*` files. `analysis` does not enable either tool.

An unnamed session takes its display name from the first user line, capped at 60 characters. `--name` and `/name` win. A `$plan` or `$execute` session is renamed from the plan heading when that file exists, as `plan: <heading>` or `execute: <heading>`. On resume, Pitako replaces the old `pitako:coding` or `pitako:analysis` placeholder. The footer cwd line and `pitako` status slot both show the display name; the profile is not written into the status slot. `/pitako` still prints the profile.

## Included extensions

| Piece | Package | Why |
| --- | --- | --- |
| LSP | [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client) at `1c981dfcacc456fe4ce9f4120a2f0250b54d6844` | Pi-native tools for diagnostics, go to definition, references, symbols, prepare-rename, and rename. Not published on npm, so it is pinned as a git dependency. MIT. |
| CodeGraph | [`@vndv/pi-codegraph`](https://github.com/vndv/pi-codegraph) `0.1.10` | Pi-native tools over the `codegraph` CLI: search, callers, callees, impact, explore, node, files, status. MIT. |
| CodeGraph CLI | `@colbymchenry/codegraph` `1.6.0` | The index and `codegraph serve` process the raw extension talks to. MIT. |
| Code Intelligence | `extensions/code-intelligence/` | Six bounded queries using AST, LSP, Git, and the direct CodeGraph SDK. Graph-backed queries require Node. |
| Profiles, protected paths, status | `extensions/index.ts` | Pitako-owned. |

`@vndv/pi-codegraph` registers Pi tools. It spawns `codegraph serve --mcp` internally. You do not add an MCP server to Pi.

Hover is not part of `pi-lsp-client`. This package does not add a second LSP client to fill that gap.

Selection notes and rejected packages are in [docs/foundation.md](docs/foundation.md).

### Verify LSP

In a TypeScript project, with `typescript-language-server` on `PATH`:

```text
Use lsp_diagnostics on src/main.ts.
Use lsp_goto_definition on the greet call in src/main.ts.
```

Or run `bun run smoke`, which loads Pitako through Pi's resource loader and calls `lsp_goto_definition` and `lsp_find_references` on `fixtures/tiny-ts`.

### Verify CodeGraph

```bash
codegraph init
```

Then ask Pi to use the raw `codegraph_search` and `codegraph_callers` tools. The smoke test initializes the tiny fixture for these raw queries. Under Node, a graph-backed dense query can build the index instead; `project_report` only observes it. Under Bun, graph-backed dense queries report unavailable.

## Disable or override an extension

Pi can filter a package without editing Pitako. In `settings.json`:

```json
{
  "packages": [
    {
      "source": "/absolute/or/relative/path/to/pitako",
      "extensions": [
        "!extensions/code-intelligence/codegraph-raw.ts"
      ]
    }
  ]
}
```

`pi config` toggles individual resources from installed packages, including skills. Paths are relative to the package root. Filtering the raw CodeGraph extension out of the loader does not remove the dependency or the dense queries; it only stops Pi from registering the raw `codegraph_*` tools.

To drop Ponytail, Caveman, or one principle without editing Pitako:

```json
{
  "packages": [
    {
      "source": "/absolute/or/relative/path/to/pitako",
      "skills": [
        "!node_modules/@dietrichgebert/ponytail/skills/ponytail",
        "!skills/caveman",
        "!skills/principles/principle-experience-first"
      ]
    }
  ]
}
```

To load the optional TypeScript skill: `+skills/language/typescript-best-practices`.

To drop Pitako entirely: `pi remove` with the same source you installed.

## Web research

Not bundled. [`pi-web-access`](https://github.com/nicobailon/pi-web-access) (MIT, actively maintained) can search and fetch pages, but it also ships PDF extraction, YouTube, repository cloning, and several API-key providers. That should stay optional so a missing search key cannot block the coding baseline.

To add it later, depend on a pinned version and append its `pi.extensions` entry (currently `./dist`) in this package's `pi.extensions` and `config/stack.json`. The `web-research` slot in `config/stack.json` records that choice.

## Configuration examples

`config/presets.example.json` shows thinking-level examples with no provider and no model. Pitako does not load it. Copy it to `~/.pi/agent/presets.json` only if you already use Pi's preset example.

Do not commit API keys, `auth.json`, or `~/.pi/agent/settings.json`.

## Layout

```
pitako/
├── package.json          # pi manifest and pinned dependencies
├── extensions/           # profiles, Board, roles, Team, and Code Intelligence
├── roles/                # role instruction markdown
├── skills/pitako-coding/ # router + baseline
├── skills/plan/          # $plan, stops at PLAN_FROZEN
├── skills/execute/       # explicit implementation authority
├── skills/remove-ai-slops/
├── skills/caveman/       # vendored MIT Caveman skill
├── skills/practical/     # selected pstack workflows
├── skills/principles/    # selected pstack principles
├── skills/language/      # optional; not loaded by default
├── prompts/explain.md
├── config/stack.json
├── fixtures/tiny-ts/     # smoke fixture
├── scripts/              # loader and smoke runner
└── tests/
```

Team assignment and model policy code already live under `extensions/agent/`, `extensions/team.ts`, and `extensions/roles/`. No separate package is required.

## Smoke test

```bash
bun install
bun run smoke
```

The script copies `fixtures/tiny-ts` to a temp directory, runs `codegraph init`, loads this package the way Pi loads a project package path, and checks:

- `codegraph_search` finds `greet`
- `codegraph_callers` finds `run`
- `lsp_goto_definition` resolves into `greet.ts`
- `lsp_find_references` mentions `greet`
- Board tools are registered. The smoke test does not call them.

## Current limitations

- No hover tool. `pi-lsp-client` does not provide one.
- `codegraph_context` is not wrapped. `codegraph_explore` and `codegraph_node` cover relevant source and call edges.
- Analysis mode does not sandbox `bash` or `powershell`.
- Language servers are not installed automatically.
- `pi-lsp-client` is consumed from git because it is not on npm. The commit is pinned.
- Web research is not bundled. Board scope is global only. Agent fallback does not rerun a task after side effects.
- Local `pi install .` requires `bun install` (or `npm install`) in this directory first, so `node_modules` exists.

## Roadmap

Not built yet:

- Subteams and nested agent delegation
- Background workers that survive process exit
- Private or team Board scopes
- Hover and `codegraph_context` tools

## License

MIT. Third-party notices are in [NOTICE](NOTICE).
