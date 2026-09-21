# Foundation notes

The curated engineering layer (Ponytail, Caveman, selected pstack skills, rpiv-todo) is documented in [engineering.md](engineering.md).

Pitako 0.1 composes current Pi (`@earendil-works/pi-coding-agent` 0.87.0). Packages declare resources under `package.json` `pi` (`extensions`, `skills`, `prompts`). Pi installs npm and git packages with `pi install` and runs `npm install` in that package. A local path is not copied and does not install dependencies, so a checkout needs `bun install` first.

Third-party Pi packages are dependencies. Their entry files are listed in `pi.extensions` and `config/stack.json`. Pi's own docs require those nested packages to be in `dependencies` and `bundledDependencies` so the published tarball contains them. Pitako does not vendor their source.

## Selected

### pi-lsp-client

Commit `1c981dfcacc456fe4ce9f4120a2f0250b54d6844` (2026-07-25). MIT. Entry `src/index.ts`. Imports `@earendil-works/pi-coding-agent`.

Tools: `lsp_diagnostics`, `lsp_goto_definition`, `lsp_find_references`, `lsp_symbols`, `lsp_prepare_rename`, `lsp_rename`. Shared server pool, idle reaping, and a `/lsp` inspector. Servers come from the project or user config, otherwise a built-in catalog. It does not hardcode a developer home path.

It is not on npm. The git pin is the supported package source. Hover is absent; this milestone does not add a second client.

### @vndv/pi-codegraph 0.1.10

MIT. Last commit reviewed: 2026-08-11. Entry `extensions/codegraph.ts`. Peer dependency on Pi and `typebox` (Pi aliases `typebox` when it loads extensions).

Native Pi tools: `codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_explore`, `codegraph_node`, `codegraph_files`, `codegraph_status`. Each call spawns `codegraph serve --mcp` for the project path. That is the CLI's interface, not a Pi MCP adapter the user has to configure.

`codegraph_explore` is the relevant-context tool. The CLI's separate `codegraph_context` tool is not wrapped.

Requires Node >= 22.19, matching Pi. Tested here against CodeGraph CLI 1.6.0, which this package depends on. If `codegraph` is already on `PATH`, that binary wins. Otherwise Pitako prepends its own `node_modules/.bin` for the process.

### Profiles

Pi's default active built-ins are `read`, `bash`, `edit`, and `write`. `grep`, `find`, and `ls` are registered but inactive until something enables them. The coding profile turns those three on. The analysis profile calls `pi.setActiveTools` with the coding set minus `edit`, `write`, and `lsp_rename`.

No provider or model is set. `config/presets.example.json` is documentation only.

## Rejected

| Candidate | Why not |
| --- | --- |
| `@narumitw/pi-lsp` 0.49.8 | Maintained (2026-09-20) and MIT, but only `lsp_diagnostics` and `lsp_fix`. No definition, references, symbols, or rename. |
| `pi-lsp-extension` 1.3.0 (samfoy) | MIT, last published 2026-06-02. Extra tree-sitter daemon stack, and it is not the LSP port this milestone asked to evaluate first. |
| `pi-lens` 4.2.1 | MIT and active, but it bundles linters, formatters, ast-grep, and structural analysis. Too wide for a baseline LSP dependency. |
| `@lunarnexus/pi-codegraph` 0.2.1 | MIT and newer (2026-09-11), but it imports CodeGraph's private `lib/dist/mcp/tools.js` and injects a system prompt that tells the agent to avoid read/grep. The public `codegraph serve` contract is more stable. |
| `@zzz210s/pi-codegraph` | MIT and self-contained, but it needs native tree-sitter and better-sqlite3, supports a shorter language list, and stores its index in `.codegraph/`, which collides with colbymchenry/codegraph. |
| `picassio/pi-code-graph` | MIT, but it needs Docker Memgraph, embeddings, and a model provider. That is a new service, not a Pi coding baseline. |
| `pi-codegraph-extension` (gripebomb) | MIT MCP wrapper, last published 2026-06-05, and it is the pattern this milestone said not to prefer. |
| `pi-web-access` 0.30.0 | MIT and maintained (2026-09-19). Search and fetch are real, but so are PDF, YouTube, repo clone, and many API keys. Left as an optional slot in `config/stack.json`. |
| `@vanillagreen/pi-web-tools` 3.0.1 | Ties search to specific providers, including OpenAI-native web search. That assumes an account Pitako must not assume. |
| Official `preset.ts` | Hardcodes example providers and models. Pitako ships an example JSON without those fields instead of loading the extension. |
| Official `dirty-repo-guard.ts` | Cancels session switch and fork when the repo is dirty, including non-interactive runs. Too disruptive for a baseline. |
| Official `plan-mode` | Useful later. Its bash allowlist is a policy subsystem. Analysis mode only proves tool gating. |
| Official `handoff.ts` | Cross-provider model switch. Belongs with model policy, not this milestone. |
| Official `subagent/` | Not loaded. Patterns worth reusing later are below. |

## Upstream patterns kept small

From the current Pi examples (package 0.87.0):

- **Tool gating:** `pi.getActiveTools` / `pi.setActiveTools`. Used by the profiles.
- **Protected paths:** `tool_call` can return `{ block: true, reason }`. Pitako blocks `.git/`, `node_modules/`, and `.env` files for `edit` and `write`.
- **Session name and status:** `pi.setSessionName` and `ctx.ui.setStatus`.
- **Flags:** `--pitako-profile` via `pi.registerFlag`.
- **Subagents, for later teams:** the official example spawns a separate `pi` process in JSON mode, discovers agent markdown from `~/.pi/agent/agents` (project agents only when explicitly trusted), and passes a tool list in frontmatter. Parallel and chain modes are capped. Pitako does not copy that runtime. A future team package can reuse isolated processes, markdown agent files, and per-agent tool lists without a roster or board type in this repo.

## Startup errors

`prepareRuntime` runs when the Pitako extension loads.

- Missing `node_modules/pi-lsp-client` or `@vndv/pi-codegraph` entry: `PitakoConfigError` names the extension id, the relative path, and `bun install`.
- Missing `codegraph` on `PATH` and missing bundled binary: the same kind of error names the program and both install options.

Pi reports an extension that throws while loading as a startup error. A language server that is not installed is not a package failure. `pi-lsp-client` reports that when a tool runs.

## Deferred

- Coordinator, architect, researcher, and development roles
- Teams, subteams, roster, message board
- Work intents and execution authority
- Model class, model policy, and fallbacks
- Repository hints, worktrees, remote agents
- Web research until a small extension is worth requiring
- Bash sandbox and plan-mode command allowlists
- Hover, and `codegraph_context` if a maintained Pi wrapper exposes it without private imports
