# Engineering layer

Pitako 0.1 remains a Pi package. This note records the coding distribution, Board v0, and role definitions. Teams and agent execution are still out of scope.

## Decisions

### rpiv-todo: npm dependency, full extension

`@juicesharp/rpiv-todo` 2.11.0 is a real Pi package (MIT). Pitako depends on it and loads `node_modules/@juicesharp/rpiv-todo/index.ts`. That is the session-local TODO layer: `todo`, `/todos`, overlay, `blockedBy`, `owner`, `metadata`, and branch replay.

It is not Pitako Tasks or Memory. Do not overload it with Board semantics. Board v0 is a separate extension. Upstream keeps exactly one task `in_progress`. That is fine for single-agent Pitako. A later multi-agent policy may become one active task per owner; do not change it now.

`@juicesharp/rpiv-i18n` stays optional. Users configure overlay size, collapse key, and guidance through rpiv-todo's own `~/.config/rpiv-todo/config.json`. Disable the extension with Pi package filters.

### Ponytail: npm dependency, skill only

`@dietrichgebert/ponytail` 4.10.0 is a real Pi package (MIT). Its extension prepends the full skill body on every `before_agent_start`. That is always-on context. Pitako depends on the package and loads `node_modules/@dietrichgebert/ponytail/skills/ponytail` only.

Users who want always-on Ponytail can add `+node_modules/@dietrichgebert/ponytail/pi-extension/index.js` with Pi package filters. Pitako does not.

### Caveman: vendor MIT skills

Caveman is not a Pi package. `skills/` is MIT. Engine, proxy, browse, MCP, and the Go memory core are BSL-1.1. Pitako vendors `caveman` and `investigate-first` only. Default intensity is lite so architectural explanations stay in full sentences.

### pstack: vendor selected skills

`@zenspc/pi-pstack` 0.6.0 is the current Pi-native port. It still loads poteto-mode, setup-pstack, and `pi-subagents`. Depending on it would activate orchestration this milestone forbids.

Pitako vendors selected skills from the official pstack plugin (Lauren Tan, MIT, plugin revision `6ed0f7a9504f577d7529064103cecce9be7dfc5e`) and rewrites the orchestrated ones (`how`, `why`, `architect`, `blast-radius`, `show-me-your-work`, `reflect`, verification skills) for a single agent.

`typescript-best-practices` lives under `skills/language/` and is not in the default `pi.skills` list.

## Conflicts

| Tension | Resolution |
| --- | --- |
| Ponytail "code first, three lines" vs prove-it-works | Ponytail sizes the implementation. Evidence skills size the proof. Architectural explanations are in scope when the change crosses a boundary. |
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

## Board v0

The Board is a workspace forum: topics hold posts of type INFO, FINDING, QUESTION, ANSWER, DECISION, BLOCKER, and HANDOFF. It is not a TODO list, a transcript, or memory.

Storage is SQLite at `$PI_CODING_AGENT_DIR/pitako/board.db`, falling back to `~/.pi/agent/pitako/board.db`. Pi runs on Node, so the driver is built-in `node:sqlite` (`DatabaseSync`). That module is still experimental in Node 22 through 25, but it is present on Pi's Node 22.19 floor and needs no native addon. Bun 1.3.14 does not implement `node:sqlite`, so tests open `bun:sqlite` through `extensions/board/sqlite.ts`. The SQL is the same. Schema version is `PRAGMA user_version`. Version 1 is created once. Any other version fails without deleting data.

Workspace is `git rev-parse --show-toplevel`, or the canonical cwd outside a repository. Tools do not accept a workspace argument. Scope is always `global`. Author is the string `pi`. Integer ids are SQLite row ids. There is no agent identity, team scope, or Thread table. A later schema version can add those without reading an unversioned file.

The extension registers tools and `/board`. It does not subscribe to agent events, so Board rows never enter the prompt unless a tool is called. List, read, and query results are capped.

## Roles and model policies

A role is a template. It is not an AgentInstance. Built-in roles are coordinator, architect, developer, reviewer, and researcher. Instructions are markdown under `roles/`. `config/defaults.toml` holds names, skill lists, principle lists, and empty model policies. No concrete provider is shipped.

User config is `$PI_CODING_AGENT_DIR/pitako/config.toml`. `smol-toml` parses it. There was no TOML parser in the tree. Scalar overrides replace one field. Skill, principle, primary, and fallback arrays replace the whole list when present and stay when omitted.

Reasoning is Pi's `ThinkingLevel` plus `off`. The set is checked against the `ThinkingLevel` type so a new Pi level fails the build. Unsupported levels are rejected with `getSupportedThinkingLevels` only when the caller supplies models. Config load does not open Pi's model registry, so a named target can exist before auth does. Exact `provider/model` is required. Bare ids are rejected.

Fallback is availability only. v0 does not select a fallback and does not accept `fallback_on`. Pi's retry classifier is string matching, not a stable category enum, so inventing a config taxonomy would pretend the errors are more structured than they are. `FallbackReason` is reserved on the resolved policy for the runner.

`getRole("architect")` and `resolveRole("architect")` return instructions, skills, principles, the policy id, the primary target, reasoning, and ordered fallbacks. If no primary is configured, resolution succeeds with a diagnostic instead of crashing.

## AgentInstance v0

`agent_run` creates one in-process Pi `AgentSession` with `SessionManager.inMemory`. That gives a new conversation and a new rpiv-todo session id without a child process. Pi's `setModel` keeps the same session when a provider fails after a mutating tool. A fresh session is used only when no mutating tool has run. Unknown errors and cancellation do not fall back. The child prompt is the role instructions plus the task. Parent messages are not passed in.

Board author is resolved from a process-shared session registry, not AsyncLocalStorage. A child Pi session id maps to the instance id. The foreground session stays `pi`. The model cannot pass an author. Child tools are enabled with `setActiveToolsByName` at construction, including grep, find, and ls. `agent_run` stays excluded.

Target activation is part of fallback. `setModel` throwing `No API key` is an auth failure, and the next target is tried. Unknown throws are not. Pi tools have no mutating flag. Known read-only names do not mark side effects. Every other name does. After that flag is set, fallback continues the same session and does not send the original task again. `reasoning = default` is not rewritten to `medium`.

A child session does not receive the foreground sentence that the user selected the model. `SessionStats.tokens.input` is cumulative billed input across turns. It cannot be split into skills, tool output, or file reads. The earlier Architect figure of 472440 input tokens is that cumulative total, not one prompt.

## Dogfood

rpiv-todo dogfood: `/pitako` now names the session TODO layer in one line, and `tests/todo.test.ts` drives the real `todo` tool (create, in_progress, complete, `blockedBy`, cycle rejection, branch isolation, replay). No Pitako Task system was added.

Board v0 dogfood used topic `Board v0 dogfood` in `~/.pi/agent/pitako/board.db` for this repository. The follow-up was small: `scripts/smoke.ts` now requires the six Board tool names and still does not call them. `bun run smoke` passed. The open question, left unanswered, is whether smoke should set a temporary `PI_CODING_AGENT_DIR` before any future Board call.

The TODO list stayed the execution checklist. The Board held the finding, the decision, and the handoff. That split was natural. Friction: a session started before the extension existed does not see `board_*` until reload, so the posts were made by executing the registered tools in a bun process. `node:sqlite` still prints an experimental warning, and Bun 1.3.14 cannot import it.

Roles v0 dogfood wrote a local `~/.pi/agent/pitako/config.toml` for the authenticated providers on this machine. That file is not in the repository. `resolveRole("architect")` returned the markdown instructions, the skill and principle lists, the primary target, reasoning, and ordered fallbacks. Nothing was spawned.

Influenced by `ponytail` (compose the package, do not reimplement), `principle-experience-first` (install Pitako and TODOs are there), and `principle-prove-it-works` (the tool execute results are the proof).
