# Contribute to Pitako

This guide applies to this checkout. Pitako is a TypeScript ESM package that composes Pi. It does not replace Pi's model, provider, or runtime.

## Find the relevant sources

Start with [README.md](README.md) for project orientation and [Engineering layer](docs/engineering.md) for design decisions. The main directories are:

- [extensions/](extensions/) contains profiles, Board, and composition adapters.
- [agents/](agents/) contains the nine role-specific pi-subagents profiles.
- [skills/](skills/) contains the coding baseline, workflows, and contextual skills.
- [config/](config/) contains structured defaults and configuration examples.
- [scripts/](scripts/) contains checkout preparation, loaders, verification, and vendoring tools.
- [tests/](tests/) contains tests and their fixtures.

Use [package.json](package.json) for current runtime versions, dependencies, and package resources. Follow [scripts/setup.sh](scripts/setup.sh) for checkout preparation and [GATES.md](GATES.md) for verification prerequisites and procedures.

## Tool providers and instruction ownership

Pi owns the runtime, models/providers, built-in tools and codemode. Pitako composes
them; no T3 client, MCP wrapper or client thread ID is a prerequisite. An optional
host's guidance may apply when that host is actually present. Unknown native trust
is neither approval nor denial: use the public operations under their actual policy,
honor real native rejections and user Stop, and never fabricate a trust certificate.

[package.json](package.json) declares loaded resources;
[config/stack.json](config/stack.json) records required entries and tools.
Registration and instruction sources:

| Provider | Entry / responsibility |
| --- | --- |
| `billion-context-pi` | [extensions/acp.ts](extensions/acp.ts) adapts mandatory ACP. Missing, disabled, unloadable or refused ACP is an unmet prerequisite; preserve upstream refusal guidance and native-compaction stand-down. Never override user settings to force admission. |
| `pi-subagents` | `node_modules/pi-subagents/bundle/index.js` owns delegation, workflows and missions. [extensions/plan-execute.ts](extensions/plan-execute.ts) registers the owned execution resource; [skills/plan](skills/plan), [skills/execute](skills/execute), [skills/architecture](skills/architecture) and [skills/review](skills/review) supply workflow instructions/scripts. |
| Pi codemode | Native tool composition/discovery, not a separate Pitako runtime or MCP bridge. [extensions/profile-policy.ts](extensions/profile-policy.ts) preserves analysis mutation policy for nested calls. |
| Pitako dev-tools | [extensions/dev-tools/index.ts](extensions/dev-tools/index.ts) registers Git, SSH, Python, Cargo and `resource_snapshot`. [extensions/resource-sampler/index.ts](extensions/resource-sampler/index.ts) is the owned sampler library consumed by resource tooling, **not a second extension**. |
| Pitako hashes | [extensions/file-sha256.ts](extensions/file-sha256.ts) registers read-only `file_sha256` and writer-only `file_sha256_save`; inspect structured `ok` and publication, not display text alone. |
| External `pi-lsp-client` | `node_modules/pi-lsp-client/src/index.ts` registers six LSP tools; Pitako does not own the client or install servers. See [configuration](docs/configuration.md). |
| Other composition | [extensions/index.ts](extensions/index.ts) and [extensions/profile.ts](extensions/profile.ts) assemble profile instructions; [extensions/catalog.ts](extensions/catalog.ts) advertises skills. [extensions/todo.ts](extensions/todo.ts) adapts rpiv-todo; [extensions/board/index.ts](extensions/board/index.ts) owns Board. CodeGraph, Codex patch tools, memory and web entries are linked in the stack manifest. |

Availability is role-specific, not inherited from the foreground tool inventory.
All nine [profiles](agents/) explicitly load ACP. Eight load dev-tools and hashes;
the interview relay has only ACP and native supervisor contact. Four roles
(architect, reviewer, scout, worker) load LSP/CodeGraph. The execute root workflow owns
dispatch; its director only publishes a read-only plan and ends. No packaged
child delegates; the worker is the single writer. The inspector is exceptional
read-only observation/recovery, not preparation or final validation. Preserve these ceilings and the
coding/analysis mutation policy: shell is not a sandbox, query Git can write
metadata, and Python/Cargo/SSH are not read-only merely because of annotations.
`git_commit` pushes by default; workers must set `push:false` without publication
authority.

## Keep changes scoped

Tests verify implementation and decisions owned by Pitako, not installation or operation of Pi, ACP, third-party extensions, providers, CodeGraph or LSP. Keep owned guarantees using controlled external boundaries; dependency certification is not an acceptance obligation. The complete procedure is `bun run typecheck` followed by `bun run test`, with normal discovery.

Reuse existing code and fixtures before adding another helper or abstraction. Verify the affected Pitako behavior and integrations, not the dependencies themselves. Choose behavior-based checks that preserve the contract rather than tests tied to implementation details.

## Write independent tests

The default test script is `bun test --parallel`. Each file must work alone and alongside other files, without execution-order assumptions, another file's setup, or residue from a previous run.

File parallelism does not establish case-level concurrency safety. Do not add global `--concurrent`. Preserve deliberate concurrency that tests a real contract.

### Own mutable resources

Give each file ownership of its mutable resources. Use unique temporary roots and private configuration, agent and history storage, databases, and ports or sockets when needed. Prefer explicit operation or child-process `cwd` and `env` over changes to shared state.

Isolated mocks, environment changes, and globals are permitted. Restore them only after the work that uses them has settled.

### Settle work before cleanup

Await owned asynchronous starts, callbacks, background attempts, sessions, and process disposal before restoring state or deleting directories. A status change, abort request, or runner teardown hook alone does not establish settlement. If release remains uncertain, report and retain the affected roots rather than delete resources still in use.

Use local cleanup such as `try/finally` for simple resources. Reuse the workspace crash fixture only when its child-process ownership matches the test. Cover normal completion and controllable failure or cancellation. Do not promise cleanup after `SIGKILL`.

Remove disposable resources. Retain diagnostic evidence only intentionally, and identify where it remains. Never delete unrelated paths with broad cleanup such as `/tmp/pitako*`.

### Check isolation without weakening tests

Resolve interference through ownership and isolation, not suite serialization, arbitrary worker caps, retries, sleeps, weakened assertions, or inflated timeouts.

Choose focused affected checks. When isolation is materially affected, include small parallel groups. Use [GATES.md](GATES.md) for applicable final obligations. Do not require repeated full serial and parallel comparisons for every test edit.
