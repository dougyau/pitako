# Independent review

Use `/skill:review <target and requirements>` with the complete material to
review and its requirements.

The [review skill](../skills/review/SKILL.md) creates a native mission and
launches the named resource `pitako.review` (raw script paths fail). The resource
runs `skills/review/workflow.js`. `pitako.review-director` selects the angles
and resumes its session for synthesis after both model slots independently
review both angles (four `pitako.review-angle` children). The fixed angle
is `evidence-contract` for `diff`, `solution`, `codebase`, and `issue`, or
`decision-fidelity` for `plan`; the director selects one distinct risk angle.
Models use the [`pitako.review.*` settings](configuration.md#package-and-session-settings).
Only a matching nonterminal `pitako-review` cursor freezes those settings. A
different input replaces the one bounded cursor; an identical terminal pass is
not restarted implicitly.
Before synthesis, the model-free `pitako.originals-verifier`
compares the canonical JSON digest of each published original with the digest
admitted by the review and writes a no-clobber receipt in `access:review-<scopeId>`.
Reviewers read the verified originals by path; a contradictory or unavailable
original blocks that phase with an explanation. Check receipts read-only with
`access_receipt_verify` or `extensions/access-receipts.mjs check`, from the
designated worktree using the mission path, namespace and gate.

The cursor holds at most six reviewer settlement references and one verifier
reference. The model-free `pitako.review-store` saves the final outcome once to the
cwd-local SQLite store. It rechecks native journals and exact file digests and
does not relaunch models or rerun the verifier. If the final cursor save was
lost, the same operation key returns the committed result. Missing or altered
native originals fail closed. After proven store loss or replacement, the
final writer matches reconstructed path-only receipt bytes against the native
verifier result; it saves no receipt copy. If a receipt is missing or corrupt
in the same store, the authorized final writer rechecks it under a write lock
and quarantines the store before using that same proof. A cut before the cursor
save can leave settlements in the native journal. One read-only observation
verifies and returns those bodies
when they fit. To stay within 61440 bytes, it replaces only as many successful
bodies as needed with key, run ID and digest, and only if the current root's
native reuse source contains the exact settlement. The workflow checks the
reused body against that digest before consuming it. If the receipt still does
not fit (for example, after a save denial with several large reports and no
native reuse), `review-recovery-overflow` reports the measured size and slot
count and halts before any producer dispatch or SQLite write. The workflow
saves the diagnostic once in the terminal `pitako-review` cursor. Later
relaunches of the same review return it without dispatching any children or
saving again. An isolated save-denial fixture with four 20,000-byte coverage
strings measured 82,713 bytes for five settled slots. Failed settlements keep
their exact bodies; a retained Stop holds without another child or write.
The SQLite fence detects a foreign terminal cursor on relaunch; native cursor
saves are not atomic with COMMIT. Different input can start a review after
same-cwd store loss without overwriting a surviving fence.

Every reviewer sees the complete target. The caller supplies a target kind,
reference, and material, plus requirements and evidence. A label or branch name
alone is not review material. Source files and captured artifacts remain stable
during review.

The returned status distinguishes a completed report from blocked or failed
work. A child blocks only when missing material context prevents its phase;
findings, however severe, are reported in a completed review. Completion
supplies a memo and dispositions, not a clean verdict or merge
approval. The caller assesses findings, uncertainties, coverage, currentness,
and required checks before taking an authorized action. Findings and final
dispositions distinguish scoped defects, related improvements, out-of-scope
observations, and uncertainty. Scoped defects cite a requirement or existing
guarantee and its source. Substantiation does not authorize a repair or establish
blocking priority.

[Pre-pr](../skills/pre-pr/SKILL.md) reuses this skill for whole-diff review. It
retains its local gates and readiness assessment without creating a second
workflow, committing, or publishing. After corrections, it uses the same
workflow for a closure review of the delta, admitted findings, and affected
guarantees. Reviewers retain access to the complete candidate. Prior unaffected
coverage and closure coverage can together cover the final diff. Missing prior
coverage or unbounded interactions require broader review, not assumed closure.

Callers supply concrete `workDescription` text, not a name extracted from
a brief.
New and resumed child requests expose readable labels, explicit phases and a
concrete first task line, with phase and angle before the work description so
sibling jobs stay distinguishable even for long descriptions.
This changes neither keys nor retained native session names.
Originals use native file-only publication with actual saved-output witnesses;
references alone do not establish access or sufficiency.
Exact essential originals remain recoverable with producing provenance;
missing access blocks conclusions.
The final synthesis remains self-contained. See the skill for failed-original
retention limits and distinctions from optional observability.

The former `review_start/read/control` tools, Team report reader, and managed
judgments are retired. There is no compatibility route.
