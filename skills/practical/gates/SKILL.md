---
name: gates
description: Create or update a project's root GATES.md only on explicit user request through /skill:gates. Natural-language arguments select the target and bounded maintenance scope.
disable-model-invocation: true
---

# Create or update GATES

Use only when the user explicitly requests creation or maintenance of root `GATES.md`. Ordinary verification, missing guidance, or a stale command does not authorize maintenance.

## Select the target and scope

Read the user's natural-language request. Identify the selected project/worktree root and whether the task is creation or a bounded update. Use the root-selection rules in `../verify-behavior/SKILL.md` and existing `workflowWorkspace` resolution. Do not substitute the installed package, pinned plan source, or an unrelated ancestor. If the target or requested scope is ambiguous, clarify before writing.

Write only `<selected-project-root>/GATES.md`. Inspect an existing file before editing; an external symlink is not permission to write another root. Preserve accurate content outside the requested scope. Report an unrelated stale section rather than silently expanding maintenance.

Authoring permission does not authorize setup, dependency or toolchain installs, broad test runs, product fixes, new test infrastructure, settings changes, or feature maps. Keep `create-verification-skill` and `maintain-verification-skill` for their app-driving verification skills and feature maps, not project-wide gate recipes.

## Inspect the executable sources

Inspect relevant manifests and lockfiles, CI, project documentation, wrappers, tests, and runner capabilities. Trace wrapper commands to learn what they cover, omit, or serialize. Do not assume a language, `package.json`, Bun, or a particular runner.

Cross-check consequential claims against those sources. A targeted read-only help or version probe is allowed for a material uncertainty. Do not run setup or a complete suite merely to document its command. If sources disagree or a prerequisite is unknown, label the unresolved procedure and what must be confirmed instead of inventing a command or claiming readiness.

## Write the guide

Use ordinary Markdown suited to the project. No fixed headings, frontmatter, schema, timestamps, or generated stamp are required. Explain the relevant:

- Prerequisites, including unknown or unobserved external facilities.
- Focused checks and complete procedures, with exact native commands and working directories for each component.
- Order, supported concurrency, isolated groups, and wrapper coverage.
- Expected observations and interpretation of failures, skips, omissions, and interrupted runs.

Distinguish source-confirmed commands from observed executions. For an observed result, retain its command, cwd, relevant inputs/environment, result, and limits. An unrun or skipped check is not a pass. Setup success does not prove every gate prerequisite. A focused check does not replace uncovered complete-procedure obligations.

Link executable sources where useful rather than copying changing wrapper populations. GATES cannot waive frozen requirements, authorize product changes, or replace independent review. Do not duplicate the guide in the router or app-driving skills.

Review the diff against the requested scope and source evidence. Confirm that accurate unrelated sections remain intact and that only the selected root `GATES.md` changed. Report the edits, unresolved commands or prerequisites, and which claims were source-confirmed versus observed.
