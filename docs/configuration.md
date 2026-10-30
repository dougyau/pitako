# Configuration

Pitako's current configuration consists of its package resource declarations,
ordinary profiles, and the upstream extensions' settings.

## Language servers

Pitako bundles the external `pi-lsp-client` v0.2.0 client at commit
`9d029fb32b721c038b58fb418b98bbfcf720cf0a`. Its six
tools include document/workspace symbols and prepare/rename; existing role
permissions still restrict `lsp_rename`. Other supported languages remain
available through the client's normal server selection.

Pitako installs these npm dependencies:

| Language | Server | Executable |
| --- | --- | --- |
| TypeScript and JavaScript | `typescript-language-server` 5.3.0 with classic `typescript` 5.9.3 | `typescript-language-server` |
| Python | `pyright` 1.1.414 | `pyright-langserver` |
| PHP | `intelephense` 1.18.5 | `intelephense` |

Startup accepts these commands from PATH or adds Pitako's `node_modules/.bin`
when needed. This also applies to packaged child agents. No global npm install
or user configuration change is required. Intelephense is downloaded as a
dependency, not bundled in Pitako's tarball, under its
[proprietary license](https://github.com/bmewburn/intelephense-docs/blob/master/LICENSE.txt).
Navigation and diagnostics are free; rename requires an Intelephense licence.

Pitako's typecheck gate still uses TypeScript 7.0.2, installed separately as
the `typescript-compiler` development alias. The explicit gate command avoids
the two packages' competing `tsc` binaries. TypeScript 7 does not provide classic
`tsserver.js`. Compiler and server language-version equivalence is not promised.
The classic TypeScript and language-server pins are updated manually to preserve
`tsserver.js` and Pitako's Node >=22.19.0 floor.

For Rust, install the `rust-analyzer` component of the project's Rust toolchain:

```sh
rustup component add rust-analyzer
rust-analyzer --version
```

Keep its executable on PATH. Pitako does not install or require it at startup.
Provision other servers in an environment you own. To override a server, set its
command in project `.pi/lsp-client.json`, for example:

```json
{
  "lsp": {
    "typescript": {
      "command": ["/absolute/private-tools/node_modules/.bin/typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]
    }
  }
}
```

An overridden server may need a newer Node runtime or its own classic TypeScript
installation. Provision those with the server.

The external client's README is authoritative for its built-in languages and
configuration. Project `.pi/lsp-client.json` overrides `~/.pi/lsp-client.json`;
both override built-ins. Entries support `command`, `extensions`, `priority`,
`env`, `disabled`, `requestTimeoutMs` and `initTimeoutMs`. `/lsp` inspects the
pool, `/lsp status` reports availability, and `/lsp warmup <id>` explicitly
initializes an installed server. `/lsp install <id>` executes upstream install
recipes for whitelisted servers (others show manual hints); use it only with
explicit provisioning authority. Pitako does not run it or change user config
on load.

The selected client's post-edit diagnostics hook passes an `ExtensionContext`
to a tool expecting SDK 1.4.0's `ExtensionToolContext` (`tools` and `executeTool`
are absent). Its diagnostics implementation does not currently consume that
context, but directly typechecking that upstream source reports TS2769. Pitako
tests its installed registration boundary, not upstream source compilation or
post-edit/server compatibility. No dependency patch or compatibility cast is
applied.

## AST syntax tools

Pitako bundles `@nicknisi/pi-ast-grep` 0.3.4 and `@ast-grep/cli` 0.51.0.
On load, Pitako uses `ast-grep` from `PATH` or adds its `node_modules/.bin`
directory when needed. No separate CLI installation is required.
Keep optional dependencies enabled when installing; they provide the native binary.
The manifest trusts the CLI's `postinstall` script under Bun so the launcher does
not emit fallback warnings, which the extension treats as errors on empty searches.
The extension uses `ast-grep`, not `sg`, and adds no configuration files.

`ast_search` matches syntax, not types. `ast_rewrite` requires an explicit file
and previews changes unless `dryRun:false` is supplied. Analysis blocks
`ast_rewrite`, including previews and nested codemode calls, but keeps `ast_search`.
The architect, reviewer, and scout load the extension with only `ast_search`
allowed. The worker also allows `ast_rewrite`. Other child roles do not load it.

## Previews and questions

Pitako loads these upstream entries directly in ordinary sessions, not in the
packaged child profiles:

- `pi-markdown-preview` 0.25.0 provides `/preview`, `/preview-browser`,
  `/preview-pdf`, and `preview_export`. Export writes artifacts, so the analysis
  profile blocks the tool, including nested codemode calls.
- `@juicesharp/rpiv-ask-user-question` 2.15.0 provides `ask_user_question` for
  structured questions with options and custom answers. It remains available in
  both coding and analysis profiles.

Markdown preview requires Pandoc. Terminal previews and PNG export also require
a Chromium-based browser. Terminal image display requires a compatible terminal.
PDF export requires a LaTeX engine, and Mermaid diagrams in PDF require `mmdc`.
Some browser assets load from jsDelivr or unpkg and need network access.
Pitako does not install these programs.

Markdown preview renders Mermaid in its previews and exports, independently of
Pi's native inline renderer. No change to `markdown.mermaid` is required.
Pitako does not change user settings.

## Package and session settings

- `package.json` declares extensions, advertised skills, prompts, and pi-subagents
  profiles under `agents/`.
- `config/stack.json` lists required extension entries checked by startup.
- `--pitako-profile coding|analysis` selects the session profile.
  `PITAKO_PROFILE` is the fallback when the flag is omitted.
- `/pitako profile coding|analysis` changes the current session's profile.
- `PI_CODING_AGENT_DIR` selects Pi storage. Board uses its `pitako/board.db`.

Pi and pi-subagents own model and child configuration. Pitako's former
`config.toml`, role policies, developer routing, Head, and worker-history settings
are not read, validated, or completed. Existing files are left untouched.

`plan` and `execute` are advertised skills, with `/plan` and `/execute` prompt
templates. Planning gathers evidence and confirms specs without implementation;
execution uses native pi-subagents missions and the `pitako.execute` resource
registered by `extensions/plan-execute.ts`. See the [plan/execute
specification](plan-execute-spec.md) for their authority and preflight boundaries.
