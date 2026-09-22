---
id: herdr-integration
revision: 2
status: frozen
created_at: 2026-08-14T12:00:00Z
updated_at: 2026-08-14T20:00:00Z
---

# Herdr integration

## Problem

A long-running specialist started from Pitako is invisible. `agent_run` creates an in-process session. Herdr already shows the foreground Pi pane, and it can start, prompt, and wait on a sibling pane. Pitako does not use that path. The official Pi integration is not installed, so Herdr cannot reliably tell idle from a still-running turn.

## Goal

Add one explicit supervise path. A foreground Pitako session inside Herdr can open one visible sibling Pi pane, submit one task, and return the instance id, pane id, and Herdr status. The child posts to the Board as that instance id. `agent_run` stays the private in-process run.

## Non-goals

- Redesigning AgentInstance, or editing `extensions/agent/run.ts`, `extensions/agent/pi.ts`, `extensions/execution-identity.ts`, `extensions/board/workspace.ts`, `extensions/workflow.ts`, `skills/plan/SKILL.md`, or `skills/execute/SKILL.md`.
- Pointing `$plan` or `$execute` workers at Herdr. They keep calling `agent_run`.
- Teams, a roster, a DAG, a scheduler, a background queue, resume, private Board scopes, worktrees, extra workspaces, or SSH machines.
- An AgentRuntime interface, a second fallback engine, a second watchdog, skill-allowlist parity, or usage accounting for supervised runs.
- Vendoring `herdr-agent-state.ts`, talking to the Herdr socket, auto-installing the integration, or reporting `done`.
- Auto-answering blocked dialogs, closing a successful pane, or copying a pane transcript into the parent result.
- Emitting `herdr:blocked`, calling `report-agent`, duration-based placement, nested supervise, and `pane report-metadata`.

## Constraints

- This session observed `HERDR_ENV=1`, herdr 0.9.1, and `herdr integration status` with `pi: not installed` at `~/.pi/agent/extensions/herdr-agent-state.ts`.
- On herdr 0.9.1 a current integration prints `name: current (vN) (path)`. Other status fragments are `outdated ( < v` and `needs repair (`.
- `herdr pane report-agent` accepts `idle`, `working`, `blocked`, and `unknown`. The official Pi reporter owns those calls. Pitako does not.
- The installed control skill is `herdr --skill`. It matches the local Herdr skill backup. Do not control Herdr when `HERDR_ENV` is not `1`.
- `agent_run` is synchronous, in-memory, and transcript-free. Board author is not a tool argument. An unregistered foreground author is `pi`.
- `[agent_runtime]` in `config/defaults.toml` is the in-process watchdog table. It is not a pluggable runtime.
- CI must not split the live session. Live pane proof is manual dogfood.

## Invariants

- `agent_run` does not gain a Herdr path. A failed `agent_run` is still not a reason for the parent to do that role.
- Availability fallback, side-effect continuation, and the watchdog stay inside `runAgentInstance`. The Herdr path does not copy them.
- No fixed deadline on `agent_run` or on the supervised wait.
- Workspace and Board database path stay as they are.
- Do not close a pane this call did not create. Do not stop the Herdr server, and do not close a workspace or tab.
- Herdr wire fields do not enter `AgentInstance` or the Board schema.
- A supervised child cannot call `agent_run` or `agent_supervise`.

## Scope

One new tool, `agent_supervise`, and the small modules it needs. It resolves a role with the existing model policy, splits one sibling pane, starts Pi, prompts once, and returns ids plus Herdr status.

## Out of scope

Anything in Non-goals. Also the default Herdr split ratio. The session id for author registration comes from `ctx.sessionManager.getSessionId()` at `session_start`, not from the event payload.

## Architecture / boundaries

Do not fold Herdr into AgentInstance. An interface with one in-process implementation and one Herdr implementation would edit the frozen runner and hide two products behind one call. That abstraction is rejected.

`extensions/herdr/presence.ts` parses the environment and integration status. It does not exec `herdr`. `extensions/herdr/supervise.ts` is the only module that execs `herdr`. `extensions/index.ts` registers the tool and the session hook. `extensions/profile.ts` drops `agent_supervise` from `childActiveTools`, next to `agent_run`. No new package entry. No new config key. Tests inject a command runner. That runner is a CLI seam, not an AgentRuntime.

Presence is true only when `HERDR_ENV=1`, `HERDR_PANE_ID` is set, and `HERDR_SOCKET_PATH` is set. Record `HERDR_TAB_ID` and `HERDR_WORKSPACE_ID` when present. They are not required for `pane split --current`. Do not infer presence from the terminal title or from a `herdr` call when the env check fails. After the gate, a read-only `herdr status` may confirm the server is running and endpoint-compatible. If it is not, stop. Do not upgrade or restart it.

`agent_supervise` runs only when that gate passes and the `pi:` status token is `current`. A line such as `pi: current (vN) (path)` passes. `not installed`, `outdated`, and `needs repair` fail closed before any split. The error names `herdr integration install pi` and does not install or overwrite the extension. Do not fall back to `agent_run`.

Command sequence, after the gate:

1. `herdr pane layout --pane "$HERDR_PANE_ID"`. Width greater than or equal to height splits `right`, otherwise `down`.
2. `herdr pane split --current --direction <dir> --cwd <caller cwd> --no-focus --env PITAKO_INSTANCE_ID=... --env PITAKO_ROLE_ID=...`. Read the new pane id. Do not create a workspace, tab, or worktree.
3. `herdr agent start <instanceId> --kind pi --pane <paneId> -- --model <provider/id> [--thinking <level>] --no-approve --append-system-prompt <preamble + role instructions> --exclude-tools agent_run,agent_supervise`. Use Herdr's default startup timeout. Pass `--no-approve`. Do not pass `--approve`. This run ignores project-local settings and extensions. If start returns `agent_not_ready` or times out, do not prompt.
4. `herdr agent prompt <instanceId> <task> --wait`, only after start has a live agent. No Pitako timeout. Do not use `pane run` or `pane send-text` for the prompt. `agent prompt` writes the task and Enter. Without `--no-approve`, that Enter can accept Pi's project-trust selector and write `~/.pi/agent/trust.json` before `session_start`.
5. On `idle` or `done`, leave the pane. The tool returns the instance id, pane id, and `agent_status`. It does not return a transcript.
6. On `blocked` or `agent_blocked`, send no keys. Leave the pane. One diagnostic `herdr agent read <name> --source recent-unwrapped --lines 40`, then the parent surfaces that excerpt.
7. On `agent_prompt_stalled`, timeout, `unknown`, or `agent_not_ready`, do not resubmit and do not close the pane. A stall does not prove the prompt was never delivered.
8. Close the created pane only when start fails before a live agent exists, or on parent abort after `herdr agent send-keys <name> ctrl+c`. Do not close on idle, done, blocked, `agent_blocked`, `agent_prompt_stalled`, timeout, unknown, or `agent_not_ready`.

Do not call `pane report-agent`, `report-agent-session`, or `release-agent`. Do not launch `pi --mode json`. The official reporter ignores non-TUI modes.

The in-process author map stays process-local. `session_start` and `session_shutdown` do not carry a session id. On `session_start`, if both `PITAKO_INSTANCE_ID` and `PITAKO_ROLE_ID` are set and Herdr presence holds, call existing `registerExecution` with `ctx.sessionManager.getSessionId()` captured at that hook. If that getter returns nothing, skip. Do not invent an author. On `session_shutdown`, unregister the id captured at start. Re-register on the next `session_start` so a `/new` in the pane does not fall back to `pi`. If those env vars are present outside Herdr, do not register. A normal foreground session stays `pi`. The pane id is not part of the author string.

Placement is explicit. No duration heuristic. `agent_run` is the private ephemeral run. `agent_supervise` is one visible pane for a foreground coordinator. One supervise call is in flight per process. A second call fails. That is a lock, not a queue. An in-process child cannot call either tool. A supervised process cannot call either tool.

Herdr already shows working, idle, blocked, and unknown. It may display `done` when an unseen idle turn settles. Pitako must not report `done`. It must not map `unknown` to completion, or a stall to `blocked`. The approval gap is accepted. Pi's official reporter does not hook tool approval, and `pi.toml` has no blocked rule. The pane stays visible. The tool does not answer the dialog.

Stable handles for a later Team v0, without building it: instance id, role id, workspace from `currentWorkspace`, Herdr agent name equal to the instance id, pane id as a return value only. Board author remains that instance id on the global board. No team scope, roster, parent edge, or per-agent workspace. Do not add a team env var.

Omitted reasoning does not pass `--thinking`. No primary target is a `PitakoConfigError` before any split. The child preamble must not call the child an in-process AgentInstance. Do not reuse `childInstructions` for that sentence.

## Work units

### T1 — Presence and integration gate

Objective: Tell whether this process is inside Herdr and whether the official Pi integration is current, without mutating Herdr.

Scope: Environment parse and status-text parse only.

Relevant constraints/invariants: No `herdr` command runs from this unit. Missing presence is not an error by itself.

Acceptance criteria:

- Missing `HERDR_ENV`, or `HERDR_ENV=1` without pane id or socket, is absent.
- The full env used by a real inside-Herdr session is present.
- A fixture of `pi: not installed (~/.pi/agent/extensions/herdr-agent-state.ts)` does not pass.
- A fixture of `pi: current (vN) (path)` passes.
- `outdated` and `needs repair` fail closed. The check does not treat "not the words not installed" as success.

Expected evidence: Unit test. The not-installed fixture is the status line observed in this session.

Likely relevant files/systems: `extensions/herdr/presence.ts`, `tests/herdr.test.ts`.

### T2 — Board author across the process boundary

Objective: A supervised child posts as its instance id. Every existing in-process author mapping still works.

Scope: `session_start` and `session_shutdown` call existing `registerExecution` and `unregisterExecution`. Do not edit `extensions/execution-identity.ts`, `extensions/board/tools.ts`, or `extensions/agent/pi.ts`.

Relevant constraints/invariants: Author is not a tool argument. Unregistered foreground author stays `pi`. Env outside Herdr does not register.

Acceptance criteria:

- No env, or env outside Herdr, still resolves to `pi`.
- The hook reads `ctx.sessionManager.getSessionId()`. A fake `sessionManager` plus presence resolves through `resolveBoardAuthor` to the instance id.
- A missing session id does not throw and does not invent an author.
- Existing two-session registry tests still pass.
- A helper that only calls `registerExecution` directly is not enough evidence for this unit.

Expected evidence: Unit test of the helper, plus the author cases in `tests/agent.test.ts`.

Likely relevant files/systems: `extensions/herdr/presence.ts`, `extensions/index.ts`, `tests/herdr.test.ts`.

### T3 — One supervised pane

Objective: `agent_supervise` launches one named Pi, submits one task, and returns ids plus Herdr status. `agent_run` does not gain a Herdr path.

Scope: The command sequence in Architecture. Single-flight guard. Refuse when `currentInstanceId()` or `PITAKO_INSTANCE_ID` is set. Filter the tool out of `childActiveTools`. Fixture-tested command runner. No live split in CI.

Relevant constraints/invariants: Do not fall back to `agent_run`. Do not close a pane this call did not create. Success carries no transcript. Stall does not resubmit.

Acceptance criteria:

- Outside Herdr, or with the Pi integration missing, the result is an error and no split is issued. The missing-integration error names `herdr integration install pi`.
- Happy-path argv includes `--current`, `--no-focus`, the caller cwd, both env vars, `--kind pi`, the instance id as the name, `--model` from the role policy, `--no-approve`, and `--exclude-tools agent_run,agent_supervise`. It does not include `--approve`.
- If start returns `agent_not_ready` or times out, no prompt is issued and the pane stays open.
- Success returns the instance id, pane id, and `agent_status`. It does not return a transcript.
- Idle, done, blocked, `agent_blocked`, `agent_prompt_stalled`, timeout, unknown, and `agent_not_ready` do not close the pane and are not resubmitted. Blocked may carry the 40-line diagnostic read.
- The created pane is closed only when start fails before a live agent exists, or on parent abort after `ctrl+c`.
- `agent_run` tests show no `herdr` argv.
- A second overlapping call in the same process fails without a queue.

Expected evidence: Fixture tests. Manual dogfood, not CI: a sibling pane appears in `herdr agent list` under the instance id, and a Board post from that pane uses that author.

Likely relevant files/systems: `extensions/herdr/supervise.ts`, `extensions/index.ts`, `extensions/profile.ts`, `tests/herdr.test.ts`.

### T4 — Say the split where the old limitation is stated

Objective: README and engineering docs no longer say that every agent run is only in-process, and they do not describe a team.

Scope: Short prose. No new config. No behavior change.

Relevant constraints/invariants: `$plan` and `$execute` are not Herdr callers. Teams, a DAG, and a scheduler stay absent.

Acceptance criteria:

- Docs say `agent_run` is unchanged, `agent_supervise` requires Herdr presence and the official Pi integration, and a supervised result is not an `AgentRunResult`.

Expected evidence: Doc diff only.

Likely relevant files/systems: `README.md`, `docs/engineering.md`.

## Verification strategy

T1 and T2 are deterministic unit tests. T3 uses an injected command runner and argv assertions. Do not split a pane in CI. The live proof is one manual dogfood after the fixture tests are green: list the sibling agent, post to the Board from that pane, and read the author back. Existing AgentInstance, Board, role, and profile tests stay green. T4 is a doc read, not a behavior test.

## Success criteria

- `agent_run` behavior and tests are unchanged.
- A missing Herdr gate, or a Pi integration that is not `current`, fails before any split. `outdated` and `needs repair` fail closed. The error names the install command and does not install it.
- A fixture happy path passes `--no-approve`, does not pass `--approve`, and does not close the pane. Start timeout and `agent_not_ready` do not prompt.
- The hook test drives `ctx.sessionManager.getSessionId()` and `resolveBoardAuthor`. A direct `registerExecution` call is not the proof. A foreground session without that registration is still `pi`.
- Docs name the split and do not claim a team.
