# Engineering layer

Pitako composes Pi rather than replacing its runtime. The package has one
delegation route, pi-subagents, and no execution owner or scheduler of its own.

## Package composition

`package.json` declares resources. `config/stack.json` records required extension
entries for `extensions/stack.ts` to validate at load time.

The order starts with `extensions/index.ts`, the independent official Codex entry,
and `extensions/profile-policy.ts`. The early extension captures the session
profile. The late policy reapplies model-compatible tools after Codex startup
and model changes without taking over upstream hooks.

Navigation uses pi-lsp-client and pi-codegraph. TODO wraps rpiv-todo and keeps
`todo` model-only so nested codemode calls cannot lose the snapshots used by
replay and readers. Board is repository-scoped storage shared by its worktrees.
ACP loads before Hermes. Web access and pi-subagents are direct upstream entries.

ACP keeps Pitako defaults `delegate:false`, `autoUpdate:false`, and
`toolBashDefaultTimeout:0`. Explicit global and project ACP files retain upstream
precedence. No managed workflow guards wrap ACP, TODO, or Board.
All nine packaged profiles explicitly load this `billion-context-pi` adapter and
require its five context tools. Native child required-tool diagnostics report
missing registration. Registration alone does not establish operational
compression after a refusal; disabled, unloadable or refused ACP is an unmet
prerequisite. Preserve upstream refusal and native-compaction stand-down rather
than overriding settings.

The owned `extensions/dev-tools/index.ts` factory supplies Git, SSH, Python,
Cargo and resource tools and hooks. Its sampler is the library under
`extensions/resource-sampler/`, not a second extension or external dependency. Prefer covered
deterministic operations, composed through native codemode; keep bash/Python
fallback for uncovered cases. Git queries are not sandboxed: metadata or spilled
output may be written. `git_status` is working changes, not tracked inventory;
structured `git_diff` is statistics, not a patch/path array.
`file_sha256` is read-only; writer-only `file_sha256_save` hashes and atomically
publishes reusable items JSON in one call. Both share a validation/hash core,
independent of spec-plan inspection. Check structured `ok` and `publication`;
codemode can return structured failures without throwing.

## Profiles and authority

`extensions/profile.ts` owns ordinary session profile selection, not worker
identity. It selects upstream patch tools by model capability and leaves raw
navigation available. Analysis removes known editing tools and introduced
mutators (including locally writing `ssh_pull`, Python/Cargo execution effects
and hash saving) and blocks them at the tool-call boundary, including codemode.
It retains shell, so this is not a sandbox. Child strict allowlists retain
hash queries for read-only roles, saving/full tools for workers, director-only
delegation and the narrow interview relay.

`extensions/index.ts` registers only `/pitako`, profile guidance, automatic
ordinary session naming, profile mutation and edit/write protected-path guards. Startup does not
load role policies, complete legacy configuration, create leases, start a
bridge, reconcile executions, or prune histories.

Board authors are session IDs with `pi` as the default. Attribution is not
an authenticated role or execution grant. Ordinary CRUD, pagination, validation,
resource closure, and repository namespace remain active. Existing plan-binding
columns remain in the database schema; their former lifecycle tools are absent.
Their future treatment belongs to the migration of plan and execute.

## Workflow ownership

The architecture and review skills initiate their existing file-backed
pi-subagents workflows. Scripts own dispatch. Directors and participants only
reason about the same supplied problem or target.

The workflows return advice with native references. They do not grant authority,
freeze plans, accept implementation, or reproduce the removed runtime's
reservation, fencing, disposal, fallback, or delivery guarantees.

Ordinary authorized consultation and escalation use `oracle` through
pi-subagents. The `pitako.architect` profile is internal to the architecture
workflow, not a general escalation role.

`pre-pr` reuses the review skill, interprets its complete current-target report,
and retains local checks and publication-readiness rules. It adds no workflow.
Plan and execute compose the same architecture/review contracts. Foreground
planning owns grilling and actual human confirmation. Execution uses a narrowly
registered named resource for read-only spec/Git host inspections, native mission
state for immutable invocation inputs and cycle attempts, fresh cycle directors,
and sequential fresh packaged workers. Only the director opts into delegation,
TODO and both supervisor channels. The ordinary worker retains the native worker
contract plus explicit CodeGraph/LSP/Codex providers, without delegation.

Registration is session-scoped and disposed on shutdown/re-registration. Helpers
and scripts ship under extensions/skills. The raw sandbox cannot fs/import or
call arbitrary tools. Native replay is not stack restoration or exactly-once;
unrecorded attempts block for native mission/Git/descendant reconciliation.
Reused results alone never prove current checks. The read-only host API requires
a finite per-operation timeout; its native maximum is not a Pitako cycle budget.
The old bridge has no historical replacement.

The packaged execution-director alone uses native `timeoutMs: 7200000` (two
hours). A confirmed timeout consumes one of three cycles in that explicit
invocation; native awaited completion and fresh read-only Git/known-ref
observations precede the next slot. Positive native active/pending, detached,
recovery, Stop and permission signals block replacement. Failed tests/model
verdicts are diagnosis, not activity proof or writer permission. Shared
verify-behavior is explicitly selected in director/worker profiles.

An unsettled historical marker permits pertinent read-only admission diagnosis.
Missing retained awaited completion produces exact pending diagnosis and explicit
`/execute <spec-id> --unblock` guidance. That actual human request maps to strict
boolean data on the same named resource and can withdraw only that historical
Pitako exclusion, recording the request/old refs in native mission state. It is
not authentication, verified closure or a native barrier override. Old outcomes,
counts, snapshots and Git/WIP remain. Same-ID replay cannot renew three slots or
clear a newer hold. Status projection/inventory is incomplete: positive exact-ref
native management warnings are advisory blockers; absent fields, status.ok and
normal prose never certify CLOSED. No global process lock is claimed. Completion
still needs current-checkout verification and whole-spec review.

## Verification boundary

Tests cover Pitako-owned composition, profile policy, instruction resources,
workflow scripts, Board, and checkout preparation through controlled boundaries.
They do not certify external models, Pi, ACP, pi-subagents, T3, CodeGraph, or LSP.
Tests solely for the removed runtime no longer represent product obligations.

See [GATES.md](../GATES.md) for the complete procedure.
