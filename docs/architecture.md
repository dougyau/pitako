# Architecture discussions

The [architecture skill](../skills/architecture/SKILL.md) initiates one background
pi-subagents workflow. `skills/architecture/workflow.js` owns dispatch and uses
the packaged `pitako.architect` profile for the director and perspective members.
Agents reason about the same complete decision rather than specialist subtasks.

The workflow supports up to five rounds. Native continuation references preserve
the discussion and consumed round budget. The final result distinguishes
`completed`, `blocked`, and `failed`, with a memo, limits, and native references.

Only the script coordinates the discussion. The agents do not launch workflows
or delegate. A design memo is not implementation authority or review acceptance.
The former `architecture_start/read/control` tools and managed tables are retired.

The skill is the authoritative usage procedure.
