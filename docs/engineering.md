# Engineering layer

Pitako 0.1 remains a Pi package. This note records the second milestone: a stronger single-agent coding distribution. Teams, boards, coordinators, and model fallbacks are still out of scope.

## Decisions

### rpiv-todo: npm dependency, full extension

`@juicesharp/rpiv-todo` 2.11.0 is a real Pi package (MIT). Pitako depends on it and loads `node_modules/@juicesharp/rpiv-todo/index.ts`. That is the session-local TODO layer: `todo`, `/todos`, overlay, `blockedBy`, `owner`, `metadata`, and branch replay.

It is not Pitako Tasks, Board, or Memory. Do not overload it with those semantics. Upstream keeps exactly one task `in_progress`. That is fine for single-agent Pitako. A later multi-agent policy may become one active task per owner; do not change it now.

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

## Dogfood

rpiv-todo dogfood: `/pitako` now names the session TODO layer in one line, and `tests/todo.test.ts` drives the real `todo` tool (create → in_progress → complete, `blockedBy`, cycle rejection, branch isolation, replay). No Pitako Task system was added.

Influenced by `ponytail` (compose the package, do not reimplement), `principle-experience-first` (install Pitako and TODOs are there), and `principle-prove-it-works` (the tool execute results are the proof).
