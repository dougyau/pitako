# Independent review

Use `/skill:review <target and requirements>` with the complete material to
review and its requirements.

The [review skill](../skills/review/SKILL.md) initiates one background
pi-subagents workflow. `skills/review/workflow.js` dispatches the packaged
`pitako.reviewer` profile for independent angles, cross-critique, one author
response, and a final synthesis.

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
