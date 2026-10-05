# Verify the Pitako checkout

Run commands from this checkout's root. Select focused checks while implementing. Run the complete routine procedure after final edits and cleanup, then obtain the required independent review.

## Check prerequisites

Use the versions declared in [package.json](package.json): Bun 1.3.14 and Node >=22.19.0. Preparation through [scripts/setup.sh](scripts/setup.sh) installs frozen-lock dependencies and observes both Node SQLite paths. Reuse compatible setup evidence. Setup success does not prove every gate prerequisite.

- The smoke test needs the CodeGraph CLI on PATH and an installed TypeScript language server with its `typescript` runtime. The LSP resolver can use PATH or project binaries. See [scripts/smoke.ts](scripts/smoke.ts) and [tests/smoke.test.ts](tests/smoke.test.ts).
- Node checks need checkout dependencies visible to the actual Node executable, including CodeGraph's native SQLite path and production `node:sqlite`. See [scripts/code-intelligence-node.mjs](scripts/code-intelligence-node.mjs) and [scripts/mission-durability-node.mjs](scripts/mission-durability-node.mjs).
- Containment checks need supported Linux x64 or arm64, `/usr/bin/bwrap`, and working namespaces, mounts, and process containment. Inspect [extensions/mission/workspace.ts](extensions/mission/workspace.ts) and [tests/mission-workspace.test.ts](tests/mission-workspace.test.ts). Some tests return early on unsupported hosts. A green runner summary alone does not prove those cases ran.

If a prerequisite fails, record the dependent checks as unproven. Continue useful independent checks where possible. Do not install global tools or change settings merely to claim readiness.

## Select focused checks

Choose existing tests for the changed contract and its callers. Examples from the root:

```sh
bun test ./tests/workflow.test.ts ./tests/execution-binding.test.ts
bun test ./tests/setup.test.ts
bun test ./tests/composition.test.ts ./tests/load.test.ts
```

Use workflow and binding checks for instruction routing, setup checks for shell orchestration, and composition/load checks for shipped resources. These observe different contracts. Static instruction assertions do not prove model compliance.

For code-intelligence or mission changes, select the relevant existing tests under [tests](tests) and retain affected Node obligations. Use `bun run smoke` as a focused loader/LSP diagnostic when needed. Integrated checks remain necessary when a focused check does not exercise the affected runtime, SDK, containment, or package-loading path. Focused success does not waive required final gates.

## Run the complete routine procedure

Run these commands in order from the root:

```sh
bun run typecheck
bun test
bun run test:code-intelligence-node
bun run test:mission-node
```

The script definitions are in [package.json](package.json). Plain `bun test` runs the full discovered suite with the default serial runner, including `tests/todo.test.ts`, with no omitted files or duplicate runs. Keep intended concurrency within test cases and do not weaken assertions.

Full Bun coverage includes `tests/smoke.test.ts`. Do not add `bun run smoke` again by default. The Node `.mjs` suites are separate observations, not part of Bun discovery. Run the mission Node suite without `MISSION_DURABILITY_PHASE` filtering for the complete obligation.

Inspect actual output and exits for each command. Record failures, early-return or skipped cases, interrupted runs, and unrun checks separately from passes. Preserve relevant prerequisite and environment details. A successful typecheck does not prove runtime behavior.

## Use stage-specific mission integration only when required

For an affected stage obligation, use a distinct evidence directory:

```sh
bun run verify:mission -- <stage> --evidence-dir <distinct-directory>
```

[scripts/verify-mission.ts](scripts/verify-mission.ts) owns the stage's reachable commands and current coverage. Trace that wrapper before executing it or reusing its evidence. Do not run a T1–T7 sweep for routine skill/setup changes.

T3 includes T1 and T2 regressions. T7 runs the full discovered Bun suite once with the default serial runner. It starts broad commands only after SDK integration and owner-denial checks. An omitted-command manifest is not success. T7 does not establish every T1–T6 stage-specific obligation. T1's filtered Node phases do not replace the unfiltered durability suite.

Reuse equivalent complete wrapper evidence only when actual commands, inputs, environment, completeness, and required phase or binding remain compatible under [verify-behavior](skills/practical/verify-behavior/SKILL.md). Frozen plan and user requirements control conflicts. This guide grants no new authority and does not replace independent review or [pre-pr publication checks](skills/pre-pr/SKILL.md).
