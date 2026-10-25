---
name: verify-behavior
description: "Select checks by observable behavior, review test quality in an agreed diff, or simplify existing tests within explicitly authorized scope. Use for verification, review-diff, or simplify-tests."
---

# Verify behavior

Choose evidence by behavior, not by function or test count. This skill does not
expand the task, edit permissions, or authority.

## Choose the mode and scope

- `verify`: check the authorized task with proportional evidence.
- `review-diff`: read only. Inspect the complete agreed diff, including product
  code, tests, fixtures, scripts, dependencies, configuration, meaningful docs,
  and relevant untracked files. Use the agreed base and scope. Do not assume
  `main`, fetch, or invent a base. Inspect removed guarantees as well as additions.
- `simplify-tests`: analyze tests in the agreed paths. Recommend by default.
  Edit only with explicit authorization. Work by behavior in verifiable units.
  Report out-of-scope issues without cleaning them.

## Read the project's verification guide

Start from behavior owned by the active project and its declared testing scope.
Read one root `GATES.md`. Resolve the current Git worktree root, or canonical cwd
outside Git. For an explicitly selected project, use that project instead.
Never substitute the installed Pitako package or an unrelated ancestor.

Treat the guide as ordinary Markdown, without a required schema or headings.
Use its prerequisites, focused and complete procedures, exact commands and cwd,
order, concurrency, wrapper coverage, and failure or skip interpretation.
Cross-check consequential claims against manifests, CI, wrappers, or tests.
Discover uncovered obligations when guidance is missing or stale. Ordinary
verification does not authorize maintaining the guide.

In Pitako, verify owned composition, rules, resources, adapters, and instruction
assembly through controlled external boundaries. This does not certify Pi, SDK,
ACP, pi-subagents, providers, classifiers, CodeGraph, or LSP. Reading an external
boundary grants no certification or repair task. Other projects retain authorized
integration requirements from their scope, contracts, and active guide.

A guide cannot waive a required gate, authorize changes, replace independent
review, or turn skipped or unrun checks into passes. Honor explicit user
requirements and raise genuine conflicts rather than silently replacing them.

### Repository codemode procedure

If the active guide provides `scripts/verification-recipe-v1.js`, load it from
the active project root. Follow that guide's complete source-loading example.
Use actual `tools.read` without offset or limit, reject failed, non-string, or
truncated reads before evaluation, and require `version === 1` and callable `run`.
Pass the resolved root and a unique absolute owned evidence directory to ordinary
built-in codemode. No plan binding, managed tool, or classifier is required.
Projects without the asset retain ordinary discovery.

Await nested calls. Leave routine bash timeout and codemode `timeout_ms` unset
for the recipe. Inspect logs and observed exits, errors, interruptions, and
capture failures. Enclosing script success alone is not check success. Stop the
ordered procedure at the first failed or interrupted command and name unrun
obligations. Preserve partial evidence and settle owned work before replacing it.
Do not add a detached runner, heartbeat, settings change, or second factory.

## Select and observe evidence

1. Name the authorized input or action, observable result, and guarantees that
   must remain true. Derive expectations from the contract, not copied logic.
2. Reuse existing checks. Choose the smallest observer of the relevant behavior.
   For costly, privileged, or integration-dependent evidence, trace a permitted
   positive route through its actual entry point, configuration, authorization,
   resource owner, and cleanup. A save call does not prove retrieved persistence.
3. Before adding a test, identify the plausible wrong implementation it rejects
   and the distinct guarantee it adds. Reject copied algorithms, stipulated mock
   results, and internal details without a contract. An interaction is observable
   when the interaction is the contract.
4. Trace checks that launch other checks. Do not re-enter the same verification
   stage recursively. Keep verifier integration tests outside suites they launch.
5. Inspect the actual result. A double isolates a dependency but does not prove
   that dependency's behavior. This limit adds no external certification duty.
   Preserve real-provider demonstrations only when separately required by the
   authorized project scope. Advisory results cannot satisfy deterministic gates.

Own mutable resources and settle asynchronous work before restoring globals or
deleting roots. A worktree does not isolate global settings. A cancellation
request, status change, or runner teardown is not settlement. Use appropriate
timeouts for child-process checks. Inspect a stalled invocation before replacing
it. Report hangs and timeouts as failed or incomplete, never passing.

TDD is optional when requested or when a cheap reproduction helps. Preserve a
useful regression test, not a ceremonial artifact. Report unreproduced failures.

## Distinguish diagnosis from final gates

Diagnose concrete failures with focused reproductions. Correct only within the
authorized assignment, then run affected regressions before repeating broad
gates. Diagnostic success does not waive final gates or independent review.
An unavailable prerequisite leaves dependent checks unproven; useful independent
checks may still run within authority. Do not impose arbitrary run caps.

Known diagnosis stays within the assignment. For an authorized consultation or
escalation, use `oracle` through pi-subagents with the scope, evidence, uncertainty,
and specific question. Check that the profile is available before dispatch.
If it is unavailable, report the blocker rather than substituting architect.
The architecture and review skills are explicit workflows, not the default
escalation route. A worker result is not coordinator acceptance.

### Triage a failing check before choosing an edit

Read the actual error and test, then choose the causal task, not blanket
red-test-to-repair:

1. Repair a confirmed regression owned by the assignment.
2. For a plausible effect, trace the exact causal mechanism before editing or
   attributing blame. Coincidence with a change is not causation.
3. Audit the test's real useful guarantee. Recommend retiring a useless check;
   edit/retire only within authorized scope, never delete a required spec guarantee.
4. Check reproducibility and determinism. Diagnose a useful flake and fix its
   cause, not a retry-until-green policy.
5. For timeouts, inspect excessive work, waits, contention and deadlocks. Remove
   avoidable causes rather than inflate deadlines.
6. Simplify fixtures/processes when they obscure the behavior, preserving coverage.

In an implementation assignment, bounded necessary verification-fixture and
stability fixes can belong to that assignment; they are not automatic authority
for unrelated product changes or global cleanup. Standalone `review-diff` remains
read-only and `simplify-tests` still recommends unless edits are authorized.

## Reuse evidence only for the obligation it covers

A wrapper may cover a required check when its observed commands, arguments,
inputs, environment, completeness, and phase cover that obligation. Record that
coverage instead of repeating it by default.

Partial logs, skipped checks, interrupted output, stale artifacts, and identical
command strings alone are insufficient. Inspect artifacts, not just a delegate's
summary. Reuse completed evidence while relevant inputs, environment, contract,
scope, and required phase remain compatible. A role change, handoff, age, or no-op
cleanup alone does not invalidate it. Relevant edits invalidate affected
conclusions, not every independent observation. Required gates and independent
review remain required.

## Simplify without losing guarantees

Before deleting a test, identify its guarantee and where it remains demonstrated,
or why the contract no longer applies. Preserve uncertain cases, distinct
guarantees, and current regressions. Age, slowness, size, and mocks do not prove
a test useless. Green after deletion is not proof that deletion was safe.

Simplify setup, remove unnecessary mocks, merge equivalent cases, or remove unused
helpers only within scope. Never weaken assertions, hide failures, remove the
only protection of a current guarantee, or replace recurring protection with a
one-time manual observation merely to reduce tests.

## Keep the proof proportional

Reuse existing frameworks and fixtures. Ponytail's runnable-check examples are
not an artifact mandate or a ban on the repository's testing tools. Do not add a
parallel self-check, framework, or abstraction for small duplication. Distinct
contracts may need distinct checks. Optimize understanding and maintenance,
not line or test counts.

Stop when the assigned outcome and evidence obligations are met. Verification
does not authorize repair, setup, paid requests, external effects, or extra
review duties. Expand only for concrete evidence or change-related risks.
Report the behavior, command, result, limits, unavailable checks, and whether
out-of-scope failures block required gates. Do not claim an unobserved behavior
because unrelated checks passed.
