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

## Profiles and authority

`extensions/profile.ts` owns ordinary session profile selection, not worker
identity. It selects upstream patch tools by model capability and leaves raw
navigation available. Analysis removes known editing tools but retains shell.

`extensions/index.ts` registers only `/pitako`, profile guidance, automatic
ordinary session naming, and edit/write protected-path guards. Startup does not
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
hours), not a global or worker budget. A confirmed native timeout consumes its
cycle. The fresh read-only execution-inspector must reconcile all descendants
and actual Git before a new fresh director can use the next of three slots in
the same invocation. Only non-reused verified settlement clears unsettled state;
uncertain descendants, permissions, ordinary failures and Stop remain blockers.
Compact timeout and settlement references survive replay; Git/WIP and immutable
inputs are retained. Three settled timeouts return partial, never a fourth cycle
or successful review. Later completion still requires current-checkout validation.

## Verification boundary

Tests cover Pitako-owned composition, profile policy, instruction resources,
workflow scripts, Board, and checkout preparation through controlled boundaries.
They do not certify external models, Pi, ACP, pi-subagents, T3, CodeGraph, or LSP.
Tests solely for the removed runtime no longer represent product obligations.

See [GATES.md](../GATES.md) for the complete procedure.
