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

Not every skill or principle is active all the time. Pi keeps names and descriptions in context and loads a skill body when the task matches. Principles are contextual. Later roles can use different subsets. This milestone does not implement teams or a board.

`pitako-coding` is the router: inspect the repo, prefer CodeGraph and LSP, keep diffs small, verify real behavior, and load a specialized skill only when it applies. It does not embed the full Ponytail, Caveman, or pstack bodies.

Disable Ponytail, Caveman, or any individual skill with `pi config` or package skill filters. See [Disable or override](#disable-or-override-an-extension). Attribution and pins are in [THIRD_PARTY.md](THIRD_PARTY.md). Decisions are in [docs/engineering.md](docs/engineering.md).

## What this milestone is

- A Pi package (`keywords: pi-package`) with one Pitako extension, curated skills, and one prompt.
- The **coding** profile: Pi's read, bash, edit, and write tools, plus grep, find, and ls, plus LSP and CodeGraph.
- The **analysis** profile: the same read and search tools, without `edit`, `write`, or `lsp_rename`.
- Startup checks that fail with a clear configuration error when a required extension file or the `codegraph` CLI is missing.
- On-demand Ponytail, selected Caveman skills, and selected pstack practical skills and principles.
- Session-local TODOs via `@juicesharp/rpiv-todo` (`todo`, `/todos`, overlay).

## Session TODOs

Pitako uses [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) (juicesharp, MIT) as the tactical plan for the current Pi session.

- `todo` — create, update, list, get, delete, clear
- `/todos` — print the list grouped by status
- live overlay above the editor (`ctrl+shift+t` collapses it)
- session/branch replay, so the list survives `/reload` and compaction
- `blockedBy` dependencies (cycles are rejected)
- `owner` and `metadata` fields, unused by Pitako today and left for later Task/Board wiring

This is **not** Pitako's future durable/shared Task system, Board, or Memory. Skip TODOs for questions and one-line edits. Configure overlay size, collapse key, and model guidance in rpiv-todo's own `~/.config/rpiv-todo/config.json`. Disable the extension with a package filter: `!node_modules/@juicesharp/rpiv-todo/index.ts`.

## What this is not yet

Pitako does not implement agents, roles, teams, subteams, a message board, model policies, or fallbacks. Those are later packages (`extensions/` can grow; nothing empty is reserved for them today). Session TODOs are local execution plans, not that shared work.

Web search is not bundled. See [Web research](#web-research).

## Requirements

- Node.js 22.19 or newer (same floor as current Pi).
- [Pi coding agent](https://github.com/earendil-works/pi) `@earendil-works/pi-coding-agent` 0.87 or newer.
- Bun 1.3 if you are developing this repository. People who only install a published package do not need Bun.
- A language server on `PATH` for the languages you want LSP to answer. TypeScript: `typescript-language-server` (and `typescript`). Pitako does not download language servers.
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

Open a project that has a CodeGraph index (`codegraph init` in that project) and a language server available for its files.

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
| `coding` (default) | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, LSP, CodeGraph. On Windows, `powershell` is included when Pi registered it. |
| `analysis` | `read`, `bash`, `grep`, `find`, `ls`, LSP, CodeGraph. No `edit`, `write`, or `lsp_rename`. |

Shell is still available in `analysis`. Restricting bash safely would be a separate sandbox, and this milestone does not add one.

```bash
pi --no-extensions --approve -e . --pitako-profile analysis
```

Or, inside a session: `/pitako profile analysis`. `/pitako` prints the current profile.

`PITAKO_PROFILE` is used when `--pitako-profile` is omitted. An unknown name fails startup with `PitakoConfigError`.

`edit` and `write` are blocked for `.git/`, `node_modules/`, and `.env` files in either profile.

Pitako names an unnamed session `pitako:coding` or `pitako:analysis` and sets a `pitako:` status when the UI is available. It does not override a name you passed with `--name`.

## Included extensions

| Piece | Package | Why |
| --- | --- | --- |
| LSP | [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client) at `1c981dfcacc456fe4ce9f4120a2f0250b54d6844` | Pi-native tools for diagnostics, go to definition, references, symbols, prepare-rename, and rename. Not published on npm, so it is pinned as a git dependency. MIT. |
| CodeGraph | [`@vndv/pi-codegraph`](https://github.com/vndv/pi-codegraph) `0.1.10` | Pi-native tools over the `codegraph` CLI: search, callers, callees, impact, explore, node, files, status. MIT. |
| CodeGraph CLI | `@colbymchenry/codegraph` `1.6.0` | The index and `codegraph serve` process the extension talks to. MIT. |
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

Then ask Pi to use `codegraph_search` for a symbol and `codegraph_callers` for its callers. The smoke test does this on the tiny fixture.

## Disable or override an extension

Pi can filter a package without editing Pitako. In `settings.json`:

```json
{
  "packages": [
    {
      "source": "/absolute/or/relative/path/to/pitako",
      "extensions": [
        "!node_modules/@vndv/pi-codegraph/extensions/codegraph.ts"
      ]
    }
  ]
}
```

`pi config` toggles individual resources from installed packages, including skills. Paths are relative to the package root. Filtering CodeGraph out of the loader does not remove the dependency; it only stops Pi from registering those tools.

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
├── extensions/           # Pitako extension (future first-party extensions go here)
├── skills/pitako-coding/ # router + baseline
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

A later `pitako-team` or `pitako-model-policy` extension is a new file under `extensions/` plus a `pi.extensions` entry. No empty packages are created for them now.

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

## Current limitations

- No hover tool. `pi-lsp-client` does not provide one.
- `codegraph_context` is not wrapped. `codegraph_explore` and `codegraph_node` cover relevant source and call edges.
- Analysis mode does not sandbox `bash` or `powershell`.
- Language servers are not installed automatically.
- `pi-lsp-client` is consumed from git because it is not on npm. The commit is pinned.
- Web research, roles, teams, boards, and model fallbacks are not implemented.
- Local `pi install .` requires `bun install` (or `npm install`) in this directory first, so `node_modules` exists.

## Roadmap

Not built yet:

- agent roles (researcher, architect, development, reviewer)
- teams and subteams
- a shared message board
- model policies and fallbacks

## License

MIT. Third-party notices are in [NOTICE](NOTICE).
