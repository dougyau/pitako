# Pitako

Pitako is a TypeScript ESM Pi package for coding sessions. It composes navigation,
editing, context management, memory, TODOs, Board, and pi-subagents. Pi owns models,
providers, and the session runtime.

## Prepare this checkout

Use Node >=22.19.0 and Bun >1.4.2.

```sh
bash scripts/setup.sh
bun run pi
```

The setup script installs checkout dependencies and attempts CodeGraph index
initialization. CodeGraph tools use an existing index and do not initialize or
refresh it themselves. If CodeGraph or an LSP server is unavailable, use the
ordinary read and search tools. See [verification](GATES.md) for the test procedure.

For another project, install the package through Pi's package mechanism. The
package manifest declares its extensions, skills, prompts, and agent profiles.
Do not install those entries a second time as separate Pitako resources.

## Use the coding baseline

`coding` is the default profile. `/pitako profile analysis` disables `edit`,
`write`, `apply_patch`, and `lsp_rename`. Shell remains available, so analysis is
not a sandbox. `--pitako-profile` takes precedence over `PITAKO_PROFILE`.

Pitako selects upstream `apply_patch` on grammar-capable OpenAI models and uses
`edit` and `write` otherwise. The latter tools reject protected `.git`,
`node_modules`, and environment-file paths. This guard does not constrain
upstream `apply_patch` or shell.

Use `/pitako` for profile and skill status, `/todos` for the session task list,
and `/board` for shared topics. Board tools are pull-only. They do not inject
posts into every turn.

Load specialized skills only when they apply. The default collection includes
Ponytail, Caveman, investigation, architecture, review, verification, and
technical-writing guidance. See [the coding router](skills/pitako-coding/SKILL.md).

## Delegate through pi-subagents

Use pi-subagents for authorized delegation. The `architecture` and `review`
skills initiate their scripted workflows. Those scripts dispatch the packaged
`pitako.architect` and `pitako.reviewer` profiles, which perform read-only
reasoning without delegation.

```text
/skill:architecture <decision>
/skill:review <target and requirements>
/skill:pre-pr base=<local-ref>
```

An architecture memo is design advice. A completed review supplies findings,
uncertainties, and coverage, not permission to edit, merge approval, or passing
test evidence. The caller retains scope, authorization, and interpretation.
`pre-pr` reuses the review skill for independent whole-diff review and assesses
local publication readiness without committing or publishing.

See [architecture](docs/architecture.md) and [review](docs/review.md).

## Retired orchestration

Pitako no longer provides AgentInstance, Team, Developer Head, managed
Architect/Reviewer tables, `/task`, or the shared planning/execution engine.
Its worker bridge and historical reader are removed. There are no compatibility
tools or replacement scheduler.

`plan` and `execute` are suspended and excluded from advertised skills pending
their migration. Old configuration, plans, ledgers, histories, and Board bindings
are not resumed, completed, pruned, or migrated by the retired runtime. Loading
the package does not require its former `config.toml` or model policies.

The retirement does not delete user files. Former reservation, fencing,
fallback, delivery, checkpoint, and managed-acceptance guarantees are not
promises of pi-subagents.

## Reference

- [Configuration](docs/configuration.md)
- [Engineering layer](docs/engineering.md)
- [Contributing](AGENTS.md)
- [Verification](GATES.md)
- [Third-party provenance and licenses](THIRD_PARTY.md)
