---
id: background-agent-delegation
revision: 1
status: frozen
created_at: 2026-09-22T11:03:34Z
updated_at: 2026-09-22T11:20:00Z
---

# Background agent delegation

## Problem

A long Developer, Architect, or Reviewer call occupies the Coordinator until the specialist returns. The user cannot ask what that specialist is doing, what remains of the plan, or an unrelated question until the tool call ends.

That blocks the future Team shape. A specialist must be able to work without owning the Coordinator conversation.

## Goal

Add background delegation for in-process AgentInstance work. `agent_spawn` accepts a worker and returns while that worker is still running. The Coordinator can handle another user turn before the worker finishes. Completion is one compact signal. The result stays out of Coordinator context until `agent_result`.

`$execute` uses that path for long specialist work and keeps `agent_run` when the next action needs the answer first.

## Non-goals

- Teams, a roster, mailboxes, or a DAG.
- An AgentRuntime interface. Two placements are not a reason to add one. `[agent_runtime]` stays the watchdog table.
- Changing `agent_run` into a background call, or routing it through Herdr.
- Changing `agent_supervise` into an `AgentRunResult`, removing its `--wait`, or narrowing its in-flight lock.
- A non-blocking Herdr supervise path. Visibility and a free Coordinator are not available together in this milestone.
- Persistence of workers across Pi restart, reload, `/new`, fork, or resume.
- Steering a running AgentInstance. New user information is recorded and applied after `agent_result`, or the worker is cancelled.
- Auto-parallel source writers. The code allows multiple workers. `$execute` still launches one writer at a time unless the frozen plan already assigns non-overlapping work.
- Rewriting `.pitako/plans/herdr-integration.md`.

## Constraints

- Pi 0.87, the installed package, has no durable background-task or subagent API. `examples/extensions/subagent` still occupies the tool call and dies on Ctrl+C. Do not adopt it.
- `pi.sendMessage` `deliverAs: "steer"` injects before the next LLM call. Do not use it for completion.
- `deliverAs: "followUp"` waits until the agent has no more tool calls. `triggerTurn: true` starts a turn only when idle. `deliverAs: "nextTurn"` does not wake an idle Coordinator.
- `pi.sendUserMessage` always starts a turn. Do not use it for a compact completion.
- `ctx.ui.notify` does not enter model context. `pi.appendEntry` does not either. This milestone uses notify for the no-watch case and does not add an entry renderer.
- `ctx.isIdle()` is false during an agent run, retry, auto-compaction retry, and queued continuation.
- `session_shutdown` reasons include `quit`, `reload`, `new`, `resume`, and `fork`. Reload tears down the extension instance. In-memory state does not survive unless it lives on `globalThis`.
- `runAgentInstance` links `input.signal` to the child controller. A background call must pass an owned controller, not the foreground tool signal.
- `finishRun` in `pi-agent-core` does not abort that controller when a run ends. Only an explicit abort does.
- Herdr `agent prompt` without `--wait` returns after submit. `agent wait` blocks. `agent get` and `agent list` exist. There is no agent cancel command. `pane close` exists. Do not install the Pi integration. Do not stop the Herdr server. Do not split a pane for this milestone.
- `agent_supervise` holds one process-local lock for the whole call, including `--wait`, so two splits cannot race. Leave that lock in place.
- Child sessions load the same extensions. Exclusion has to cover `childActiveTools`, `session_start`, `createAgentSession` `excludeTools`, and the Herdr `--exclude-tools` argv.

## Invariants

- `agent_run` remains a synchronous AgentInstance RPC. It still passes the tool `AbortSignal`. It does not pass `onAccepted`. Fallback, side-effect continuation, watchdog, usage, Board author, and private TODO stay inside the existing run.
- A failed or cancelled worker is not permission for the Coordinator to do that role's work.
- After accept, ending the spawn tool call, aborting a later Coordinator turn, or receiving another user message does not cancel the worker.
- Before accept, an already aborted foreground signal starts no worker and inserts no row.
- No running worker exists without a registry row. No handle is returned unless that row exists.
- Completion fires once. It does not include the transcript or the result body.
- Status and result reads never wait for the run.
- Workers do not call `agent_run`, `agent_supervise`, `agent_spawn`, `agent_status`, `agent_result`, or `agent_cancel`.
- Board stays coordination knowledge. Do not post running, elapsed, or completed as Board traffic.
- The ledger records the running owner and the later terminal status. It does not record watchdog ticks or tool calls.
- Do not poll. Do not `agent_spawn` and then immediately `agent_result`.

## Architecture

Scheduling is separate from placement.

| Call | Scheduling | Placement |
| --- | --- | --- |
| `agent_run` | synchronous | in-process AgentInstance |
| `agent_spawn` | returns at accept | in-process AgentInstance |
| `agent_supervise` | synchronous `--wait` | Herdr pane |

Herdr composition is deferred. Team v0 still lacks a visible pane whose prompt does not block the Coordinator, pane-owned cancel, and a placement field on the worker record. When that exists, keep the `agent_supervise` contract. Narrow the lock to split, start, and prompt submit, then detach `herdr agent wait`. Cancel would be `agent send-keys` plus `pane close`, not a new runtime type.

`runAgentInstance` gains one optional synchronous callback, `onAccepted(instance)`, called after the `AgentInstance` object exists and before `startWatchdogTimer`, `watchAbort`, `executeTargets`, and the first await. If the callback throws, the function rejects before the watchdog and before `executor.start`. `agent_run` does not pass the callback.

`extensions/agent/background.ts` owns a process-local `Symbol.for("pitako.backgroundWorkers")` map. It is not SQLite and not `ExecutionIdentity`. Board author stays `registerExecution` inside `openSession`.

A row holds `instanceId`, `roleId`, `acceptedAt`, optional interest `{ planId, unitId }`, the owned `AbortController`, optional `AgentRunResult`, and signal state `pending | held | sent | dropped`. Status is derived. `outcome.status` if settled, otherwise `cancelled` if the owned signal is aborted, otherwise `running`. Do not store a transcript.

`spawnBackground` checks the foreground signal, then calls `runAgentInstance` with only the owned signal and `onAccepted`. The callback checks the foreground signal again and inserts the row. After insert, detach the promise. Attach both fulfillment and rejection handlers so a later failure is stored and is not an unhandled rejection. If `onAccepted` never inserted, await the rejection and return the error. Do not pass `onPresent`.

`agent_cancel` aborts the owned controller and returns without awaiting the promise. Terminal status is visible from the aborted signal before the promise settles. `agent_result` still errors until the outcome exists.

Only the foreground owner cancels workers and flushes wakes. `createAgentSession` does not call `bindExtensions`, so an in-process child does not emit `session_start`. It does emit `agent_settled` on its own runner. That runner's idle getter stays true, because only `bindExtensions` installs the real one. Each extension load uses `moduleCache: false`, so the child is a second evaluation that can still see `Symbol.for("pitako.backgroundWorkers")`.

Bind the owner on the parent `session_start` only when `currentInstanceId()` is unset and `PITAKO_INSTANCE_ID` is unset. Store the foreground `pi` and the foreground `isIdle` getter on that owner. `ExtensionAPI` has no `isIdle`. Do not read idle state from the event context of a later handler.

A handler that is not that owner returns immediately. It does not send, does not read or clear held text, and does not cancel workers. That includes a second evaluation's `agent_settled`.

On the owner's `session_shutdown`, for every reason, abort every owned controller, mark signal state `dropped`, clear the map, and do not notify or wake. Do not await the run. Do not move workers into the replacement session. A late settle after clear does not signal. `AgentSession.dispose` does not emit `session_shutdown`.

### Tools

Register these on the agent extension. Descriptions say a failure is not permission to do that role in the parent.

- `agent_spawn({ role, task, plan?, unit? })`. `plan` and `unit` are both present or both absent. Returns `instance_id`, `role`, `status: running`, and `watch: yes|no`. Does not wait for the run.
- `agent_status({ id? })`. No id lists every row. Fields are `instance_id`, `role`, `status`, `watch`, and `elapsed_ms`. No task, result, usage, or transcript. Unknown id is an error. Never waits.
- `agent_result({ id })`. Returns `formatAgentResult` text. Errors if the id is unknown or the outcome is absent, including while running. Repeat fetch is allowed and does not signal again.
- `agent_cancel({ id })`. Returns the id and `cancelled`, or the current terminal status. Does not await the run. Unknown id is an error. Cancelling an already terminal worker does not signal again.

No `agent_list` tool. `/pitako agents` prints the same compact view through the existing notify path. An optional id filters one row. Empty text is `no workers`.

### Completion

Settle is the only signaler. Cancel does not signal by itself. The run settlement does. Signal state moves to `sent` or `dropped` once.

No-watch text, UI notify only, and only when `hasUI`:

```text
Pitako worker <instanceId> <status> role <roleId>.
```

If there is no UI, that signal is silent. `agent_status` still works. Do not spend a model turn to compensate.

Watch text:

```text
Pitako worker <instanceId> <status> role <roleId> plan <planId> unit <unitId>. Use agent_result. Do not do this role's work.
```

`status` is `completed`, `failed`, or `cancelled`.

If watch is set and the captured foreground `isIdle` getter returns true, one `pi.sendMessage` with `customType: "pitako.worker"`, `display: true`, `deliverAs: "followUp"`, and `triggerTurn: true`. Follow-up is the race shield if the session starts streaming between the idle check and the call. Do not pass `steer`. Do not use `nextTurn`.

If watch is set and that getter returns false, hold the text. Do not call `sendMessage`. Flush held lines only from the foreground owner, and only when that captured getter returns true, on the owner's `agent_settled`, `session_compact`, `session_compact_failed`, or `session_tree`. One message, one line per worker. `pi.sendMessage` returns void. The session wrapper catches a delivery failure and emits an error. The caller cannot observe that failure or restore the hold. Delivery is best-effort. A missed wake is recovered by a later `agent_status` read, not by try/catch and not by a timer.

The completion event is the `runAgentInstance` promise. Pi already emits the idle boundary. Do not add a status loop or a second scheduler.

### `$execute`

Interest is the optional `plan` and `unit` pair. There is no event bus and no `agent_watch` tool. The tool does not write the ledger.

In `skills/execute/SKILL.md`:

- A sync dependency uses `agent_run`. The wait is the dependency.
- Long specialist work uses `agent_spawn` with `plan` and `unit`. Do not use `agent_run` for that work. Do not call `agent_result` in the same turn. Do not poll `agent_status`.
- After spawn, write one ledger line and end the turn if nothing else in the current unit can proceed without that result. Do not ask the user whether to wait.
- On the `pitako.worker` wake, call `agent_result` once, update the ledger status, and continue that unit.
- A failed, cancelled, or lost worker is not foreground implementation. Report it and stop that unit. The existing correction order still applies when the result exists and verification fails. A missing worker is not that case.
- On resume, look only at the `## Workers` section. Do not treat frontmatter `status: running` or the `## Status` body as a worker. If a worker line says `status running`, call `agent_status` once for that id. If it is running, end the turn. If the id is unknown, record a blocker. Do not poll.
- One developer at a time unless the frozen plan already assigns non-overlapping work.
- New user information during a run is recorded and applied after `agent_result`, or the worker is cancelled.

Replace the worker rule that says to coordinate whenever `agent_run` is available. Coordination stays. The call depends on the dependency rule above. Architect consultation for a Level 2 question stays `agent_run`, because that answer is required before the next action. Do not leave a sentence that sends every specialist through `agent_run`.

`agent_run` unavailable still means implement inline. `agent_spawn` failure does not authorize inline implementation of that role.

Ledger shape, under a `## Workers` heading the executor creates when the first spawn is accepted. Replace that line on terminal status. Do not add a workflow schema for it.

```text
## Workers

- developer-ab12cd role developer unit T3 status running
```

### Exclusion

`ORCHESTRATION_TOOLS` is `agent_run`, `agent_supervise`, `agent_spawn`, `agent_status`, `agent_result`, `agent_cancel`. `childActiveTools` drops that list. `createAgentSession` `excludeTools` uses it. `session_start` drops it when `currentInstanceId()` or `PITAKO_INSTANCE_ID` is set. Herdr `--exclude-tools` uses the same list. Child instructions name those tools. That is the only Herdr contract change.

## Scope

- `onAccepted` in `extensions/agent/run.ts`.
- `extensions/agent/background.ts` and the four tools.
- Foreground bind, idle flush, shutdown cancel, and `/pitako agents` in `extensions/index.ts`.
- Exclusion updates in `extensions/profile.ts`, `extensions/agent/pi.ts`, `extensions/agent/run.ts`, and `extensions/herdr/supervise.ts`.
- `skills/execute/SKILL.md`, `README.md`, and `docs/engineering.md`.
- Focused tests and in-process dogfood evidence under `.pitako/runs/background-agent-delegation/evidence/`.

## Out of scope

- Herdr background prompt, pane lifecycle changes, and live Herdr dogfood.
- Result eviction before shutdown.
- A code cap on parallel developers.
- Nested background spawn.
- Any edit to `.pitako/plans/herdr-integration.md`.

## Work units

## T1 — Accept hook

Objective: `runAgentInstance` can publish its id before any model call, without changing `agent_run`.

Scope: `extensions/agent/run.ts` and the existing agent tests. No registry yet.

Relevant constraints/invariants: `onAccepted` runs synchronously after the instance object exists, before the watchdog timer, `watchAbort`, `executeTargets`, and the first await. A throw rejects before `executor.start`. `agent_run` still passes the tool signal and does not pass `onAccepted`.

Acceptance criteria:

- A test executor that has not been entered can still observe the instance id from `onAccepted`.
- A throwing `onAccepted` does not call `executor.start` and does not leave a watchdog timer running.
- Existing `agent_run` tests pass, including fallback, watchdog, side effects, and usage.

Expected evidence:

- `bun test tests/agent.test.ts`
- `bunx tsc --noEmit` clean for the touched files, or the repo typecheck if cheaper to run whole.

Likely relevant files/systems: `extensions/agent/run.ts`, `extensions/agent/index.ts`, `tests/agent.test.ts`.

## T2 — Background registry

Objective: Accept, status, result, cancel, and shutdown behavior exist without Pi tools.

Scope: `extensions/agent/background.ts` and `tests/agent-background.test.ts`. Inject the existing `AttemptExecutor` and a test clock. No Pi import in `background.ts`.

Relevant constraints/invariants: Owned `AbortController` only. Pre-abort inserts nothing. Post-accept foreground abort does not cancel. Two workers coexist. Cancel of one does not cancel the other. Status and result never wait. Late settle after `cancelAllWorkers` does not signal. Signal text has no result body. Delivery choice is a pure function of watch and idle.

Acceptance criteria:

- `spawnBackground` resolves while the injected executor is still pending, and the returned id is in the map with status `running`.
- An already aborted foreground signal does not call the executor.
- Aborting the foreground signal after accept does not abort the owned controller.
- `workerStatus` returns immediately with `running` and does not include result text.
- `workerResult` errors until settle, then returns the `AgentRunResult`. A second read does not signal again.
- Two pending workers, cancel A, B still running, results stay attributed.
- Terminal completion invokes the test notifier once. Text matches the compact lines above and does not contain the result body.
- `deliveryFor(false, *)` is notify. `deliveryFor(true, false)` is hold. `deliveryFor(true, true)` is wake. Wake text is the plan line.
- `cancelAllWorkers` aborts every owned controller, clears the map, and a late settle does not notify.

Expected evidence:

- `bun test tests/agent-background.test.ts`

Likely relevant files/systems: `extensions/agent/background.ts`, `extensions/agent/run.ts`, `tests/agent-background.test.ts`.

## T3 — Tools, exclusion, and notifier

Objective: The Coordinator can spawn, inspect, fetch, and cancel without blocking, and a child cannot call those tools.

Scope: Register the four tools. Bind foreground `pi` on `session_start`. Flush held wakes on the idle events. Cancel all workers on `session_shutdown`. Add `/pitako agents`. Update exclusion lists and Herdr argv. Do not change `--wait`, the in-flight lock, or `SuperviseResult`.

Relevant constraints/invariants: Tool execute for spawn returns before the run promise settles. No `onPresent`. No `deliverAs: "steer"`. A non-idle watched completion does not call `sendMessage` until the idle flush. `currentInstanceId()` makes spawn return an error. Herdr tests still see `--wait` and a second in-flight rejection.

Acceptance criteria:

- A deferred executor is still pending after the `agent_spawn` tool result contains `status: running`.
- `agent_status` and `agent_result` tool calls resolve while that executor is pending. Result is an error, not a hang.
- The `sendMessage` spy never receives `steer`. A non-idle completion does not call `sendMessage`. The foreground idle flush sends one follow-up with `triggerTurn: true`.
- A second evaluation's `agent_settled` does not send, does not consume held text, and does not cancel workers. Shutdown cancel runs only for the foreground owner.
- `childActiveTools` and `excludeTools` omit all six orchestration names.
- A supervised start argv excludes those six names and still contains `--wait` and `--no-approve`.
- Existing `tests/agent.test.ts`, `tests/agent-pi.test.ts`, and `tests/herdr.test.ts` pass.
- Shutdown handler aborts owned controllers and does not await the run promise.

Expected evidence:

- `bun test tests/agent-background.test.ts tests/agent.test.ts tests/agent-pi.test.ts tests/herdr.test.ts`
- Repo `bun test` and `bunx tsc --noEmit` before the milestone is called done.

Likely relevant files/systems: `extensions/agent/index.ts`, `extensions/index.ts`, `extensions/profile.ts`, `extensions/agent/pi.ts`, `extensions/herdr/supervise.ts`, `tests/herdr.test.ts`, `tests/agent-pi.test.ts`.

## T4 — Execute skill and docs

Objective: `$execute` distinguishes a sync dependency from long specialist work, and the docs match the tools that exist.

Scope: `skills/execute/SKILL.md`, `README.md`, `docs/engineering.md`. No historical plan edits.

Relevant constraints/invariants: No status loop. No spawn-then-immediate-result. Failed delegation is not inline implementation. README must not say there is no background mode.

Acceptance criteria:

- The skill names `agent_spawn` for long work and `agent_run` for a sync dependency.
- The skill forbids polling and forbids calling `agent_result` in the spawn turn.
- The skill says a lost or failed worker is not foreground implementation.
- The skill tells resume to match only a `## Workers` line, not the execute run status.
- The skill no longer says that every specialist call is `agent_run`, and it still uses `agent_run` for a Level 2 Architect question.
- README and engineering docs state the three-call table and that Herdr background is not in this milestone.
- `.pitako/plans/herdr-integration.md` is unchanged.

Expected evidence:

- A text assertion in tests, or a recorded `rg` of the skill and docs, plus `git diff -- .pitako/plans/herdr-integration.md` empty.

Likely relevant files/systems: `skills/execute/SKILL.md`, `README.md`, `docs/engineering.md`.

## T5 — Responsiveness dogfood

Objective: Prove a real Coordinator turn can proceed while a real background worker is still running, then show `$execute` can continue from the wake without polling.

Scope: In-process only. Do not install the Herdr Pi integration. Do not split a pane. Do not stop the Herdr server. Use a disposable plan if a live `$execute` needs one. Do not use `.pitako/plans/herdr-integration.md` as that plan.

Relevant constraints/invariants: The worker must still be running during the foreground interaction. Do not wait for it first. Fetch the result only after completion. Record evidence under `evidenceFile`.

Acceptance criteria:

- An automated responsiveness test accepts a second parent turn while a child `session.prompt` is still pending. A deferred `AttemptExecutor` that never enters `session.prompt` does not satisfy this criterion. A hanging fake model is enough. There is no blocker fallback that treats that deferred executor as the proof.
- Dogfood 1 records spawn return, a running status, a foreground action taken before completion, one completion signal, and a later lazy result with instance id and model provenance. If the live Pi session cannot host that sequence, the child-prompt test above is the required proof, and the evidence file says the live session was not available. Do not treat a pending executor as that proof.
- Dogfood 2 records `$execute` spawning a background developer, a foreground interaction while that developer is running, then continuation after the wake. It does not show a status poll loop. If a second live execute session cannot be started, record that limit and point at the skill text plus the child-prompt test. Do not invent a transcript.

Expected evidence:

- Files under `.pitako/runs/background-agent-delegation/evidence/`.

Likely relevant files/systems: a fresh Pi session, `agent_spawn`, `skills/execute/SKILL.md`.

## Verification strategy

Focused tests per unit, then `bun test` and `bunx tsc --noEmit`. Herdr tests stay green. The responsiveness proof is a parent turn accepted while a child `session.prompt` is pending, plus Dogfood 1 when a live session can host it. A deferred executor test may still guard the registry. It is not that proof. Live Herdr dogfood is out of scope and must be reported as skipped, not installed around.

## Success criteria

- Spawn returns while the worker is running.
- A later foreground abort does not cancel that worker.
- Explicit cancel cancels only the target.
- Two in-process workers can coexist.
- Status and result never block.
- One compact completion signal, with no transcript and no result body.
- An active Coordinator turn is not steered.
- A watched worker can wake an idle Coordinator through follow-up, or flush at the next idle boundary.
- A standalone completion does not start a model turn.
- `agent_run` and `agent_supervise` contracts remain, except the Herdr exclude list.
- `$execute` text matches the scheduling split.
- No AgentRuntime, no Team, no DAG, and the historical Herdr plan is untouched.
