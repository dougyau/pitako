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
work. Completion supplies a memo and dispositions, not a clean verdict or merge
approval. The caller assesses findings, uncertainties, coverage, currentness,
and required checks before taking an authorized action.

[Pre-pr](../skills/pre-pr/SKILL.md) reuses this skill for whole-diff review. It
retains its local gates and readiness assessment without creating a second
workflow, committing, or publishing.

The former `review_start/read/control` tools, Team report reader, and managed
judgments are retired. There is no compatibility route.
