---
name: architecture
description: Discuss an architectural decision through dynamic perspectives on the same complete problem, using one background pi-subagents scripted workflow and at most ten rounds. Use for architecture, a design council, or contrasting viewpoints without splitting the work.
---

# Architecture

Use only `pi-subagents` for this advisory discussion. Each member considers the
same complete problem through a different, dynamically chosen perspective.
Do not split the work into specialist subtasks. Design advice does not authorize
implementation.

The skill initiates the workflow. Its director and perspective agents only
reason about the supplied problem. `plan` uses this discussion with factual providers and a distinct doubts phase.
An ordinary architecture discussion does not start execution.

## Prepare

1. Enable `subagent` with `subagents_enable({})` if needed.
2. Read the extension guides with `subagent({ action: "guide", options: { topic } })`:
   - `council` for report and execution contracts.
   - `workflows/scripted-workflows` for file-backed background execution.
   - `workflows/advanced-rolling-child-runs` for rolling councils.
   - `workflows/steering-a-workflow-child` for steering receipts.
3. Inspect available profiles with `subagent({ action: "list" })`. The workflow
   uses the packaged `pitako.architect` for its reasoning director and perspective
   members. It supplies CodeGraph, read-only LSP tools, and selected design
   principles, plus `architecture-design`, `how`, `why`, and `blast-radius`.
   Each architect loads and applies Ponytail FULL while preserving required boundaries and read-only scope.
   The workflow assigns each child's responsibility and perspective.
   Confirm its effective contract is suitable for read-only analysis without
   delegation. User or project overrides can change the profile. If it is absent,
   reload the installed package before dispatch. Do not substitute another profile,
   change settings, or create agent files to make a discussion work.
4. Write a complete brief with the decision, desired outcome, constraints,
   non-goals, shared evidence, and open questions. Resolve material ambiguity
   before dispatch. Arguments are persisted, so do not include secrets.

## Launch one background workflow

Resolve [workflow.js](workflow.js) beside this installed skill, not against the
project's working directory. Pass its absolute path as `workflow`. Keep `cwd`
at the project being discussed.

```js
subagent({
	workflow: "<absolute skill directory>/workflow.js",
	async: true,
	args: { brief: "<complete decision brief>", maxRounds: 10 }
})
```

This is the only top-level launch. Return control after admission and let native
completion deliver the result. Do not poll, add a watcher, launch a nested
director, or switch to synchronous execution.

The script owns sequencing and awaits every child. The director only reasons:
it chooses two to four dynamic perspectives, prepares objections, evaluates
reports, and synthesizes. Neither the director nor members delegate. Initial
children use fresh context. Continuations use `resume: lastRunId` without
`agent`, preserving the native child contract.

Resuming an older consultation also preserves its old profile. To use the new
profile instead, start a fresh consultation explicitly. Do not silently replace
a retained child.

The first round uses `runs.all` for independent recommendations. Later rounds
use rolling `runs.run` promises and `Promise.race`. An early report can challenge
still-running peers through awaited `runs.steer`, then the script collects the
remaining results. No child uses `async: true`, which would return an admission
receipt instead of its report.

Never exceed ten rounds, including the initial round. Honor a lower positive
`maxRounds`. Stop earlier when further evidence is unlikely to change the
recommendation. At the cap, preserve unresolved disagreements instead of forcing
agreement. The script rejects an extra round.

## Interpret the result

Only the final memo, status, round counts, steering receipts, and native
continuation references return to the foreground conversation. Reports and
challenge packets stay in child sessions and the workflow's native artifacts.
Do not import them unless diagnosis requires it.

Native completion can truncate its preview. Recover only the workflow's returned
value from the cited native result artifact to read the full memo and continuation.
Do not load the child reports to recover that value.

Check the returned `status`, not just process success:

- `completed` includes the director's design memo.
- `blocked` includes a question or limit requiring a user decision.
- `failed` includes a failure and any captured continuation references.

The director compares complete alternatives and records accepted and rejected
arguments with reasons, evidence, uncertainty, and user decisions. Do not use
majority vote as proof. A memo is not independent review, plan freeze, execution
acceptance, or permission to implement.

Steering states `queued`, `delivered`, `missed`, and `failed` describe transport.
They do not prove the model incorporated the challenge. A missed late challenge
does not trigger a retry. Judge the resulting report instead.

## Continue a consultation

Retain the exact returned `continuation`, especially the latest director and
member `runId` values. Invoke the same file in background with:

```js
subagent({
	workflow: "<absolute skill directory>/workflow.js",
	async: true,
	args: {
		brief: "<new question or evidence>",
		continuation: previousResult.continuation
	}
})
```

The original decision and consumed round count remain in effect. Do not reset
the count to extend the same discussion. Failed rounds consume that budget.
The separate `validRounds` count increases only after every member returns a
ready report. Completion requires at least one such round, including after a
failed consultation is resumed. For an ordinary explicitly NEW human-authorized decision, `newDecision: true`
with its complete new brief may reuse the director but starts fresh perspective
members and a new count. Unchanged briefs cannot reset the same decision. The
flag or slightly changed text is not proof of human authorization; the foreground
must obtain the actual instruction. Normal continuations retain their count.
Planning is stricter: it uses an explicit mission and stable consultation ID;
native state retains consumed rounds even on repeated entry. `newDecision` may
not reset that planning consultation. A genuinely new planning assignment needs
its own separately authorized consultation. Its doubts phase dispatches factual
providers between rounds. Reentry uses the same mission and consultation ID;
the returned planning continuation is a bounded reference, not the retained
reports. Do not resend full accumulated evidence in workflow arguments.
It launches pitako.interview-relay through the native
supervisor channel concurrently with independent research. Each doubt names
explicit factual prerequisite IDs; only dependent human questions wait for those
facts. The read-only relay does not decide: when its interview_request arrives,
present the ENTIRE supplied frontier to the ACTUAL HUMAN immediately, wait for
their answers, then use subagent_supervisor action reply with that request's
replyTo. Do not answer preferences yourself or wait for unrelated research.
Relay reports/receipts are decision context, not implementation permission or
final confirmation. All launched work is awaited and native references retained.
Prerequisites for each dependent frontier run before later groups or unrelated
facts; its relay is submitted without waiting for the human answer. This delays
some unrelated research to avoid FIFO admission delaying answerable questions,
without a custom priority scheduler or preemption.
At the ceiling, answer/evidence reconciliation and synthesis-only reentry remain
available; no eleventh perspective round is permitted.

Native retention and resume eligibility are finite. A failed resume stops the
workflow; no fresh-context replacement or model substitution occurs silently.
Report the failure before deciding whether to start a fresh discussion.
Continuation references are data, not a custom session store or authority proof.

On an explicit Stop, request native cancellation of the owning workflow.
Cancellation admission alone does not establish child settlement. Do not launch
a replacement while closure is uncertain.

Fresh context and read-only instructions are not sandbox confinement or
confidentiality. No new scheduler, registry, settings, or session store is added.
