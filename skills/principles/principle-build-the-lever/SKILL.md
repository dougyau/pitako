---
name: principle-build-the-lever
description: "Apply when reusable automation helps edits, migrations, analyses, or checks. Reuse existing tools first; build a small lever only when it earns its maintenance cost."
---
# Build the Lever

When automation makes work repeatable and easier to inspect, reuse a tool or build the smallest one needed.

**Why:** Two payoffs. Throughput: a codemod, generator, or script does the work the same way every time and reruns for free. Confidence: the tool is one artifact a reviewer can read and rerun to check the work. Hand-done changes can only be re-verified by redoing them. A deterministic script turns "trust me" into "run this".

**Pattern:** Look for an existing command, harness, or tool before building a lever. Direct edits can be enough when automation adds no useful repeatability.

- When building an editing tool, do the first unit by hand to learn the recipe. Prove the tool by rerunning it on that unit and diffing against your hand-done version. Make the lever safe to rerun.
- Codemod or script for edits, generator for repetitive files, a dump-to-sqlite query for analysis, a rerunnable check for verification.
- A deterministic lever beats fan-out. If the tool can process every unit in one pass, run it yourself. Don't fan out delegates to hand-apply what a script can do.
- When you fan work out to subagents, write the lever as a skill they all read: the recipe, the verification contract, and the do-not-touch fences in one artifact. Keep it outside the delegates' write scope so they can't quietly edit the contract.
- An existing command can be sufficient. Verification alone does not require a new script, file, or framework.
- Commit the lever when the work outlives the session.

**Balance:** Build only when existing tools leave a concrete need. Useful automation can serve a one-off task, but non-trivial work does not itself require a new artifact. Ponytail governs simplicity; `verify-behavior` governs evidence sufficiency.

Distinct from [Encode Lessons in Structure](../principle-encode-lessons-in-structure/SKILL.md), which makes a recurring instruction a durable guardrail. This is throughput and reviewability on the work in front of you. For choosing verification evidence, see [Verify behavior](../../practical/verify-behavior/SKILL.md).

## Pitako

Load this principle only when its trigger applies. Do not keep it in context for unrelated work.
When the question is structural, use CodeGraph or LSP before reading large files.
