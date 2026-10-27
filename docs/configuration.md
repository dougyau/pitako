# Configuration

Pitako's current configuration consists of its package resource declarations,
ordinary profiles, and the upstream extensions' settings.

## Language servers

Pitako bundles the external `pi-lsp-client` v0.2.0 client at commit
`9d029fb32b721c038b58fb418b98bbfcf720cf0a`, not language servers. Its six
tools include document/workspace symbols and prepare/rename; existing role
permissions still restrict `lsp_rename`. Other supported languages remain
available through the client's normal server selection.

Provision servers explicitly in an environment you own. For a classic
TypeScript server, for example, install `typescript-language-server` and a
classic TypeScript release supplying `tsserver.js` in a private tool directory, after checking
their chosen releases' Node requirements. Put that directory's `node_modules/.bin`
on PATH, or configure an absolute command in project `.pi/lsp-client.json`:

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

The server must resolve its classic `typescript/lib/tsserver.js`; TypeScript
7.0.2 used by Pitako's sole `tsc --noEmit` gate does not provide that classic
server. Compiler and server language-version equivalence is not promised.
A selected server can require a newer Node runtime than Pitako's
`>=22.19.0` host floor; provision its runtime separately. CodeGraph and ambient
PATH are not evidence that a suitable server is installed.

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

## Package and session settings

- `package.json` declares extensions, advertised skills, prompts, and pi-subagents
  profiles under `agents/`.
- `config/stack.json` lists required extension entries checked by startup.
- `--pitako-profile coding|analysis` selects the session profile.
  `PITAKO_PROFILE` is the fallback when the flag is omitted.
- `/pitako profile coding|analysis` changes the current session's profile.
- `PI_CODING_AGENT_DIR` selects Pi storage. Board uses its `pitako/board.db`.

ACP defaults to `delegate:false`, `autoUpdate:false`, and
`toolBashDefaultTimeout:0`. Explicit `~/.pi/acp.json` and project `.pi/acp.json`
override these defaults, with project settings winning. `enabled:false` keeps
upstream native compaction available. Pitako does not rewrite those files.

Pi and pi-subagents own model and child configuration. Pitako's former
`config.toml`, role policies, developer routing, Head, and worker-history settings
are not read, validated, or completed. Existing files are left untouched.

`plan` and `execute` are advertised skills, with `/plan` and `/execute` prompt
templates. Planning gathers evidence and confirms specs without implementation;
execution uses native pi-subagents missions and the `pitako.execute` resource
registered by `extensions/plan-execute.ts`. See the [plan/execute
specification](plan-execute-spec.md) for their authority and preflight boundaries.
