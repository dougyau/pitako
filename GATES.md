# Verify Pitako

Run checks from this checkout's root with Node >=22.19.0 and Bun >1.4.2.
Follow `scripts/setup.sh` when checkout preparation is needed. Verification does
not authorize installing dependencies or changing user settings.

## Scope

Verify Pitako-owned composition, profiles, resources, workflow scripts, Board,
and checkout preparation. Use controlled external boundaries. Certification of
Pi, SDK, pi-subagents, providers, CodeGraph, LSP, and T3 is not an acceptance
obligation. Missing external facilities must not become fabricated passes.

The AgentInstance, Team, Head, managed-table, bridge, and `/task` engine tests
are retired with their contracts. Architecture and review workflow checks remain.

## Complete procedure

Run in this order with normal test discovery:

```sh
bun run typecheck
bun run test
```

`bun run test` uses `bun test --parallel`. Each file owns its mutable resources.
Do not serialize the suite, cap workers, retry failures, inflate timeouts, or
weaken assertions to hide interference. Do not add global `--concurrent`.

Stop the ordered procedure at the first failure or interruption and report
remaining commands as unrun. A focused check does not replace the full procedure.
Use `git diff --check` for publication readiness.

## Focused checks

Choose explicit affected test files before the complete procedure. Profile,
load, composition, Board, session naming, and the scripted workflows are the
main retirement regressions. Use small parallel groups when ownership changes.
No configured-model or provider request is required.

## Capture through ordinary codemode

`scripts/verification-recipe-v1.js` is an optional existing recipe for raw logs
and observed exits. It supports `{kind:"full"}`, `{kind:"gate",gate:"typecheck"}`
or gate `"bun"`, and `{kind:"focused",files:["tests/profile.test.ts"]}`.

Resolve the current canonical project root, not the installed skill directory.
Choose a unique absolute owned `evidenceDir`, outside source files. In ordinary
built-in codemode, read the entire source without offset or limit before
evaluation:

```js
const source = await tools.read({path: root + "/scripts/verification-recipe-v1.js"});
if (typeof source !== "string" ||
    /\[(?:Showing |.*more lines in file|Line .*exceeds)/.test(source))
  throw new Error("Incomplete recipe source read");
const recipe = eval(source);
if (recipe.version !== 1 || typeof recipe.run !== "function")
  throw new Error("Unsupported verification recipe");
return await recipe.run({root, evidenceDir, selection: {kind: "full"}});
```

Await nested calls. Leave routine bash timeout and codemode `timeout_ms` unset.
Record candidate identity, command, cwd, logs, actual exits, and unrun commands.
Successful enclosing codemode completion alone is not a gate pass. Preserve
partial evidence on tool errors or interrupted capture. Settle an owned previous
invocation before starting a replacement; do not add detached runners or watchers.
