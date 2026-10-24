# Verify the Pitako checkout

Run commands from this checkout's root. Select focused checks while implementing. Run the complete routine procedure after final edits and cleanup, then obtain the required independent review.

## Check prerequisites

Use stable Bun >1.4.2 and Node >=22.19.0, as declared in [package.json](package.json). Use the installed runtimes on PATH; neither an exact Bun version nor the latest release is required. Bun 1.4.2 and earlier are unsupported because synchronous subprocess calls can hang. Do not install an older local runtime to satisfy historical version references. Preparation through [scripts/setup.sh](scripts/setup.sh) checks the installed runtimes, installs frozen-lock dependencies and observes both Node SQLite paths. It does not install or downgrade runtimes. Reuse compatible setup evidence. Setup success does not prove every gate prerequisite.

Acceptance checks exercise Pitako-owned behavior. They do not require CodeGraph, LSP, Pi SDK, external package loading, providers or classifiers to certify dependencies. Preparation is not integration acceptance. Controlled adapter responses and local history inputs preserve Pitako policy and lifecycle checks without demonstrating external runtime compatibility.

If a prerequisite fails, record the dependent checks as unproven. Continue useful independent checks where possible. Do not install global tools or change settings merely to claim readiness.

## Select focused checks

Choose existing tests for the changed contract and its callers. Examples from the root:

```sh
bun test ./tests/workflow.test.ts ./tests/execution-binding.test.ts
bun test ./tests/setup.test.ts
bun test ./tests/composition.test.ts ./tests/load.test.ts
```

Use workflow and binding checks for instruction routing, setup checks for shell orchestration, and composition/load checks for shipped resources. These observe different contracts. Static instruction assertions do not prove model compliance.

For worker-history changes, select existing owned mapping, cancellation, catalog and retention tests. Use controlled external boundaries rather than real SDK sessions, indexes or language servers. Focused success does not waive the complete owned procedure.

## Run the complete routine procedure

Run these commands in order from the root:

```sh
bun run typecheck
bun run test
```

The canonical `test` script in [package.json](package.json) is `bun test --parallel`. It runs the full discovered suite, with CPU-derived file parallelism and no omitted files, arbitrary worker cap or exclusion list. Keep intended concurrency within test cases and do not weaken assertions.

The suite discovers retained tests normally. Do not add exclusions, skips, retries, caps or serialization to hide interference. External certification checks are retired, not moved to optional or affected-only gates.

### Explicitly granted Head verification

An asynchronous Developer `mode: "head"` may receive an exterior `verification` grant with positive finite `durationMs`, `captureBytes`, `invocations`, and explicit relative `artifactRoots` and `scratchRoots` (empty arrays are valid). This grants local checks and those artifacts, not setup, installs, product/configuration edits, provider spend, or acceptance. Omission preserves the ordinary principal recipe below; single, leaf, consultation, and other-role routes have no such capability.

Head reads this root guide and selects ordered `head_gates request` commands at its integration epoch/revision. For the complete Pitako procedure select exactly `bun run typecheck`, then `bun run test`, at cwd `.` with each child delta `{BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0"}` and explicit finite command timeouts within the grant. Focused selections must name explicit affected test files. The engine does not evaluate the recipe or interpret Markdown. Do not run a harmless command to fabricate evidence. Record unmet prerequisites, manual checks, and unrun obligations.

The handle precedes execution. The host serially owns processes, bounded capture, cancellation and closure; a typed wait uses the engine deadline without extending owner max-runtime. Head stays in the same one-shot session for steering, exact native `pitako.head.gates` receipts, and authorized corrections after released closure. During active or unknown leases no overlapping product writer, reopen, checkpoint or successful finish is permitted. `status`/`read`, copied receipts and partial/stale outcomes are not verification. Unknown retains the barrier and diagnostics; do not replace or clean it. A successful current receipt proves only the selected checks; the coordinator still independently reviews and accepts.

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

Use `{kind: "focused", files: [...]}` for explicit `tests/**/*.test.ts` paths, or `{kind: "gate", gate: "typecheck" | "bun"}` for a fixed gate. The final `{kind: "full"}` selection runs exactly the two commands above in order. Without an explicit exterior verification grant, the principal coordinator owns that final complete invocation directly; never delegate it to an ordinary AgentInstance or Team tool subject to the 45-minute tool-stall watchdog. Workers may run focused checks with bounds appropriate to their fixtures. The granted Head route above is the only exception.

Leave routine bash timeout and codemode `timeout_ms` unset and await nested calls. This removes those deadlines, not every caller constraint. Use no detached runner, heartbeat or settings change. The thin shell capture retains raw logs, start metadata, child environment choices and observed exits below `evidenceDir`; bounded results name those paths. `BUN_OPTIONS=''` removes inherited runner flags only for the child; `NO_COLOR=1 FORCE_COLOR=0` makes its logs readable. The principal environment is unchanged.

Stop the full procedure at the first failed, interrupted or unavailable command and name remaining obligations as unrun. Tool errors, malformed results, capture failure or missing terminal observation are incomplete, never passes. Preserve partial and failed logs. Establish prior owned invocation settlement before launching a replacement; no automatic retry or hidden resume.

Inspect actual output and exits for each command. Record failures, early-return or skipped cases, interrupted runs, and unrun checks separately from passes. Preserve relevant prerequisite and environment details. A successful typecheck does not prove runtime behavior.

Reuse equivalent complete check evidence only when actual commands, inputs, environment, completeness, and required phase or binding remain compatible under [verify-behavior](skills/practical/verify-behavior/SKILL.md). Frozen plan and user requirements control conflicts. This guide grants no new authority and does not replace independent review or [pre-pr publication checks](skills/pre-pr/SKILL.md).
