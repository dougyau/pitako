# Verify the Pitako checkout

Run commands from this checkout's root. Select focused checks while implementing. Run the complete routine procedure after final edits and cleanup, then obtain the required independent review.

## Check prerequisites

Use the versions declared in [package.json](package.json): Bun 1.4.2 and Node >=22.19.0. Preparation through [scripts/setup.sh](scripts/setup.sh) installs frozen-lock dependencies and observes both Node SQLite paths. Reuse compatible setup evidence. Setup success does not prove every gate prerequisite.

- The smoke test needs the CodeGraph CLI on PATH and an installed TypeScript language server with its `typescript` runtime. The LSP resolver can use PATH or project binaries. See [scripts/smoke.ts](scripts/smoke.ts) and [tests/smoke.test.ts](tests/smoke.test.ts).
- Node checks need checkout dependencies visible to the actual Node executable, including CodeGraph's native SQLite path and production `node:sqlite`. See [scripts/code-intelligence-node.mjs](scripts/code-intelligence-node.mjs).

If a prerequisite fails, record the dependent checks as unproven. Continue useful independent checks where possible. Do not install global tools or change settings merely to claim readiness.

## Select focused checks

Choose existing tests for the changed contract and its callers. Examples from the root:

```sh
bun test ./tests/workflow.test.ts ./tests/execution-binding.test.ts
bun test ./tests/setup.test.ts
bun test ./tests/composition.test.ts ./tests/load.test.ts
```

Use workflow and binding checks for instruction routing, setup checks for shell orchestration, and composition/load checks for shipped resources. These observe different contracts. Static instruction assertions do not prove model compliance.

For code-intelligence or worker-history changes, select the relevant existing tests under [tests](tests) and retain affected Node obligations. Use `bun run smoke` as a focused loader/LSP diagnostic when needed. Integrated checks remain necessary when a focused check does not exercise the affected runtime, SDK, history, or package-loading path. Focused success does not waive required final gates.

## Run the complete routine procedure

Run these commands in order from the root:

```sh
bun run typecheck
bun run test
bun run test:code-intelligence-node
```

The canonical `test` script in [package.json](package.json) is `bun test --parallel`. It runs the full discovered suite, including `tests/todo.test.ts`, with CPU-derived file parallelism and no omitted files, arbitrary worker cap or exclusion list. Keep intended concurrency within test cases and do not weaken assertions.

Full Bun coverage includes `tests/smoke.test.ts`. Do not add `bun run smoke` again by default. Ordinary SDK, retention and JEV Node fixtures are already reached by Bun callers; do not repeat them by default. The separate CodeGraph Node suite remains required. Standalone ad-hoc, query and Hermes history observers remain affected-only checks when their contracts change; do not sweep every `.mjs` file.

### Use the repository recipe through ordinary codemode

Use [scripts/verification-recipe-v1.js](scripts/verification-recipe-v1.js), not a new SDK driver or codemode factory. Pi's built-in codemode must already be active through normal tool selection. Under `$execute`, reopen with `openExecutionPlan` and reconcile the ledger and Team holds first. In the ordinary Node/Bun workflow context, obtain a fresh absolute invocation directory with `evidenceFile(planId, uniqueRelative, binding.executionRoot)` from `extensions/workflow.ts`. Choose a unique relative name for each invocation. Pass that returned directory and the captured `binding.executionRoot` into QuickJS; do not import the Node helper there or concatenate `.pitako/runs` paths.

In actual codemode, with those resolved `executionRoot` and `evidenceDir` values:

```js
const source = await tools.read({
  path: executionRoot + "/scripts/verification-recipe-v1.js",
});
if (typeof source !== "string" ||
    /\[(?:Showing |.*more lines in file|Line .*exceeds)/.test(source))
  throw new Error("Incomplete verification recipe source read");
const recipe = eval(source);
if (recipe.version !== 1 || typeof recipe.run !== "function")
  throw new Error("Unsupported verification recipe");
text(await recipe.run({
  root: executionRoot,
  evidenceDir,
  selection: {kind: "focused", files: ["tests/workflow.test.ts"]},
}));
```

Read the complete source before evaluation: no offset/limit, failed read, non-string result or truncation/continuation notice. Record current source identity with the execution binding; version 1 alone does not identify the bytes. The optional JEV helper is separate: resolve `jev-advice.js` beside verify-behavior's advertised installed `SKILL.md` path, not beside this repository recipe. Finish any short advisory call before checks. No classifier or provider is required.

Use `{kind: "focused", files: [...]}` for explicit `tests/**/*.test.ts` paths, or `{kind: "gate", gate: "typecheck" | "bun" | "code-intelligence-node"}` for a fixed gate. The final `{kind: "full"}` selection runs exactly the three commands above in order. The principal coordinator owns that final complete invocation directly. Never delegate it to an AgentInstance or Team subject to the 45-minute tool-stall watchdog. Workers may run focused checks with bounds appropriate to their fixtures.

Leave routine bash timeout and codemode `timeout_ms` unset and await nested calls. This removes those deadlines, not every caller constraint. Use no detached runner, heartbeat or settings change. The thin shell capture retains raw logs, start metadata, child environment choices and observed exits below `evidenceDir`; bounded results name those paths. `BUN_OPTIONS=''` removes inherited runner flags only for the child; `NO_COLOR=1 FORCE_COLOR=0` makes its logs readable. The principal environment is unchanged.

Stop the full procedure at the first failed, interrupted or unavailable command and name remaining obligations as unrun. Tool errors, malformed results, capture failure or missing terminal observation are incomplete, never passes. Preserve partial and failed logs. Establish prior owned invocation settlement before launching a replacement; no automatic retry or hidden resume.

Inspect actual output and exits for each command. Record failures, early-return or skipped cases, interrupted runs, and unrun checks separately from passes. Preserve relevant prerequisite and environment details. A successful typecheck does not prove runtime behavior.

Reuse equivalent complete check evidence only when actual commands, inputs, environment, completeness, and required phase or binding remain compatible under [verify-behavior](skills/practical/verify-behavior/SKILL.md). Frozen plan and user requirements control conflicts. This guide grants no new authority and does not replace independent review or [pre-pr publication checks](skills/pre-pr/SKILL.md).
