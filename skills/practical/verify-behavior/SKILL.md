---
name: verify-behavior
description: "Select checks by observable behavior, review test quality in an agreed diff, or simplify existing tests within explicitly authorized scope. Use for verification, review-diff, or simplify-tests."
---

# Verify behavior

Choose evidence by behavior, not by function or test count. This skill does not expand the task, edit permissions, or role authority.

## Choose the mode and scope

Modes are natural-language requests, not a new tool or API. For example:

```text
/skill:verify-behavior verify the authorized change
/skill:verify-behavior review-diff base=<agreed-local-ref>
/skill:verify-behavior simplify-tests tests/<agreed-module>
```

- `verify`: check the authorized task using proportional evidence. Do not change code outside its authority.
- `review-diff`: read only. Inspect the complete agreed diff, including product code, tests, helpers, fixtures, scripts, dependencies, and relevant configuration. For a branch, include commits since the agreed base, staged and unstaged changes, and relevant new files. For a local diff, say so. Reuse the base and scope supplied by `pre-pr` or `execute`. Do not assume `main`, fetch, or invent an ambiguous base. Consult unchanged code as context, not as cleanup scope. Inspect removed guarantees as well as added complexity.
- `simplify-tests`: analyze existing tests in the agreed paths, even without a diff. Recommend by default. Edit only with explicit authorization and an editing role. Reviewer and Researcher remain read-only. For a large tree, work by behavior or module in verifiable units. Report out-of-scope issues without cleaning them.

## Read the project's verification guide

Read one root `GATES.md` for the active project. Use existing workspace resolution through `workflowWorkspace` in `extensions/workflow.ts`, which selects the Git worktree root or canonical cwd outside Git:

- `$execute` uses `binding.executionRoot` captured by `openExecutionPlan`, not the pinned plan source.
- `$plan` uses the project being planned. Read guidance only; do not run setup or checks.
- Standalone verification and `$pre-pr` use the current canonical project/worktree root.

Read `<active-project-root>/GATES.md`, never the installed Pitako package, plan-source checkout, or substitute ancestors. A mixed repository uses one root guide that may name component-specific command working directories.

Treat the guide as ordinary Markdown. Require no fixed headings, frontmatter, schema, parser, timestamp, generated stamp, or cache. Generic verification does not require `package.json` or any particular stack or runner. Use the guide's relevant prerequisites, focused and complete procedures, exact commands and cwd, order, supported concurrency, wrapper coverage, expected observations, and failure or skip interpretation.

Cross-check consequential claims against manifests, CI, wrappers, or test sources before relying on them. Missing, stale, or incomplete guidance falls back to existing discovery for the uncovered obligation. Do not automatically create or maintain the guide. A guide cannot waive a frozen gate, authorize product changes, replace independent review, or turn a skipped or unrun check into a pass.

The frozen plan and user authority control a genuine conflict. Apply existing execution decision rules rather than silently replacing the requirement. Fresh focused diagnostics remain allowed. Preserve phase- and binding-compatible evidence reuse below. Reference the root guide and relevant obligations in a WorkBrief rather than copying the whole guide into every brief.

## Select and observe evidence

1. Name the input or action, observable result, and affected guarantees that must remain true. Derive expectations from the contract or requirement, not from a copy of the implementation.
2. Reuse existing checks. Choose the smallest check that observes the relevant contract, whether a domain rule, public library API, command, service, or user interaction. For new, costly, privileged, or integration-dependent evidence, trace a compact permitted positive route from the actual entry point to the required observation. Resolve only material prerequisites: interaction driver, effective state and resource sharing, configuration, credentials, effect owner, authorization, and cleanup. A call to `save()` does not prove persistence. Retrieve the data through the relevant path. Intention logs, compilation, a diff, or a mock that supplies the expected answer do not replace that observation.
3. Before adding a test, ask what plausible wrong implementation it would reject and what it adds beyond existing evidence. This is a brief technical decision, not a written justification per test or a mutation-testing requirement. Reject copied algorithms, mock-stipulated results, internal details without a contract, and duplicate guarantees without a meaningful distinct case. An interaction can be observable when it is the contract. A different parameter can represent a distinct behavior class.
4. Before running checks that launch other checks, trace their reachable commands through suites, fixtures, and wrappers. Use the actual arguments and environment. Do not run a cycle that re-enters the same verification stage or suite. When enabling a stage, update unsupported-stage cases whose contract no longer applies. Keep valid verifier integration tests outside the suites they launch.
5. Run the check and inspect the actual result. A double can isolate a dependency, but proves neither that dependency's real behavior nor an integration it replaces. Deterministic host checks prove their host contract or local mechanism, not an external model's completion of the real workflow. Preserve a separately required real-provider demonstration. Advisory managed observations, including passes, do not satisfy current host acceptance predicates. Report only what the exercised path observes. Internal refactors that preserve the contract should not break tests through implementation details.

Inspect the actual path before choosing a restriction. A worktree does not prove global-state isolation. Private state is not inherently prohibited, and a credentials symlink does not prove immutable credentials.

An equivalent PTY or private-state route is permitted only if it preserves the required actual entry point, authorization, and resource constraints. Preserve an explicit prohibition on credential persistence; do not invent one when absent. Direct internal receipt creation cannot prove a native path it bypasses.

A fixture, equivalent test environment, successful diagnostic, or ordinary ledger ruling grants no spending, external-effect, reset, or budget authority. Managed workers retain findings-only authority and current host predicates. Standalone consumers retain their existing scope and authority; this skill requires no plan, setup, or new evidence artifact.

Use an appropriate timeout for checks that spawn processes. Use the existing runner's cleanup for owned child processes. If a run stalls, inspect its process tree and command chain before starting another run. Report a hang or timeout as failed or incomplete verification, never as passing evidence.

TDD is optional when requested or when it makes a cheap local regression easier. Reproduce the exact reported failure when feasible. Keep a new regression test when it adds useful, proportional protection, not merely because a correction occurred. Report when the prior failure could not be demonstrated.

## Distinguish diagnosis from final gates

Diagnose a concrete failure with a focused reproduction. Seek early reachable evidence for consequential interactions, such as persistence and fallback before the first assistant, before repeating an expensive demonstration. A focused local reproduction does not replace a separately required real-provider demonstration or establish that a dependency caused the defect. Diagnose a dependency only as needed to locate the failing boundary of the authorized objective. Report out-of-scope findings and whether they block required acceptance; do not turn diagnosis into dependency maintenance.

After the correction, run affected regression checks before repeating a broad final gate. Diagnosis explains the failure. Affected regression checks the corrected behavior and affected guarantees. Final gates establish the plan's required finished-state evidence. Diagnostic success does not waive final gates or independent review.

Check relevant environment prerequisites when evidence makes them material, such as runtime dependency visibility, platform support, or fixture isolation. A failed prerequisite leaves dependent checks unproven. Useful independent checks may still run only within existing authority. Under `$execute`, they stay inside the current unit and cannot bypass ownership, unresolved Team holds, or setup restrictions. Failed or interrupted setup permits only non-dependent read-only diagnosis, not implementation writes or dependent checks. Independent checks do not accept an incomplete unit, start a later unit, skip a required check, or waive final review. Do not impose universal fail-fast behavior, arbitrary run caps, or a preflight framework.

## Reuse evidence only for the obligation it covers

A wrapper can satisfy a required gate when its observed execution covers that obligation. Trace the actual checks it launches and compare arguments, inputs, environment, completeness, and required phase or binding. Record the coverage in existing workflow evidence rather than running a covered check again by default.

Partial logs, skipped checks, interrupted output, stale artifacts, or the same command string alone are insufficient. A host predicate and a worker diagnostic command can be different obligations even when their command strings match. Evidence from one binding does not satisfy a different required binding merely because the command is identical.

Reuse completed evidence while its inputs, environment, contract, and required phase or binding remain compatible. Do not discard valid evidence solely because it is old. Relevant edits after a pass invalidate affected conclusions, not every independent observation. Rerun checks whose conclusions are invalidated. Valid reuse satisfies an obligation only through demonstrated coverage. It never cancels a mandatory gate or independent review.

## Simplify without losing guarantees

Before recommending or deleting a test, identify its guarantee and where that guarantee remains demonstrated, or why the contract no longer applies. Preserve uncertain cases, distinct guarantees, and current regressions. Age, slowness, size, or mocks do not prove a test useless. Green after deletion is not proof that deletion was safe.

Simplification can reduce setup, remove unnecessary mocks, merge equivalent cases, or remove unused helpers. Deletion is not a goal. Never weaken an assertion to accept a failure, hide an adverse result, remove the only protection of a current guarantee, or replace recurring automated protection with a one-time manual observation just to reduce tests.

## Keep the proof proportional

Ponytail governs simplicity of implementation and all verification artifacts. `verify-behavior` governs evidence validity and sufficiency. Reuse first, extend for a concrete missing guarantee, and create only what is needed. Apply this to fixtures, mocks, helpers, scripts, dependencies, evidence files, and runs. Keep setup, action, and observation readable. Do not build a framework for one case or an abstraction for small duplication. Optimize understanding, execution, and maintenance, not line or test counts.

Pitako does not treat Ponytail's `ONE runnable check`, `demo()` or `test_*.py`, and no-frameworks/no-fixtures paragraph as an artifact mandate. Reuse the repository's existing frameworks and fixtures when they observe the contract. One existing check may suffice; distinct contracts may require distinct checks. Do not add an alternative self-check just to satisfy that paragraph.

Stop when acceptance criteria are demonstrated, concrete risks introduced by the change are checked, and mandatory gates pass. Expand verification only for new evidence or a specific risk connected to the change, not an invented list of nearby cases. Report an out-of-scope failure without silently taking it on. State whether it blocks a mandatory gate.

Do not rerun solely because the role changed. Repeat when changes, a relevant environment difference, or insufficient evidence invalidate the conclusion, or when a mandatory gate requires it. Independent review remains required where applicable.

Report the behavior, check, observed result, and limits. Inspect artifacts rather than trusting a delegate's summary. Name necessary checks that could not run and the behavior still unproven. Do not compensate with irrelevant tests, use a green suite or coverage percentage as proof of an unobserved behavior, or create another record when workflow evidence already suffices.
