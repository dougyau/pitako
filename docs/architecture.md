# Architecture discussions

The [architecture skill](../skills/architecture/SKILL.md) initiates one background
pi-subagents workflow. `skills/architecture/workflow.js` owns dispatch and uses
the packaged `pitako.architect` profile for the director and perspective members.
Agents reason about the same complete decision rather than specialist subtasks.

The workflow supports up to ten rounds. Native continuation references preserve
the discussion and consumed round budget. The final result distinguishes
`completed`, `blocked`, and `failed`, with a memo, limits, and native references.

Only the script coordinates the discussion. The agents do not launch workflows
or delegate. A design memo is not implementation authority or review acceptance.
The former `architecture_start/read/control` tools and managed tables are retired.

Callers supply concrete `workDescription` text, not a name extracted from a brief.
New and resumed child requests expose readable labels, explicit phases and a
concrete first task line without changing keys or retained native session names.
Originals use native file-only publication with actual saved-output witnesses;
references alone do not establish access or sufficiency. Exact essential originals
remain recoverable with producing provenance; missing access blocks conclusions.
The final synthesis remains self-contained. See the skill for failed-original
retention limits and distinctions from optional observability.

The skill is the authoritative usage procedure.

All consultations require an explicit mission, stable consultation identity and
complete versioned `currentDecision`. Reentry requires the exact version-2
continuation. A changed decision requires a full associated `replacement` with
the expected revision. It accounts for preserved and replaced obligations and
retains active human content and provenance. Resuming an unchanged decision or
adding facts changes neither the revision nor the original round maximum.
Ambiguous dispatch stops reentry. Only an explicitly authorized selective
terminal factual retry can reconcile planning doubts without another comparison.

Planning uses the same script with native mission-backed consultation counts and
a distinct doubts phase between rounds. Context providers are read-only and
script-dispatched; human preferences return to foreground grilling.
