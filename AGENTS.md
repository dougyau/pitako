# Contribute to Pitako

This guide applies to this checkout. Pitako is a TypeScript ESM package that composes Pi. It does not replace Pi's model, provider, or runtime.

## Find the relevant sources

Start with [README.md](README.md) for project orientation and [Engineering layer](docs/engineering.md) for design decisions. The main directories are:

- [extensions/](extensions/) contains profiles, Board, and composition adapters.
- [agents/](agents/) contains the pi-subagents architect and reviewer profiles.
- [skills/](skills/) contains the coding baseline, workflows, and contextual skills.
- [config/](config/) contains structured defaults and configuration examples.
- [scripts/](scripts/) contains checkout preparation, loaders, verification, and vendoring tools.
- [tests/](tests/) contains tests and their fixtures.

Use [package.json](package.json) for current runtime versions, dependencies, and package resources. Follow [scripts/setup.sh](scripts/setup.sh) for checkout preparation and [GATES.md](GATES.md) for verification prerequisites and procedures.

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
