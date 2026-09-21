---
name: architect
description: "Sketch types, signatures, and module structure before code. Use for changes that cross module or function boundaries, or when jumping to code would lock in the wrong shape. Does not implement unless the user asked."
---

# Architect

Design before implementing. Sketch types, function signatures, and module boundaries with `not implemented` bodies or short pseudocode.

This is a single-agent skill. Do not run arena, interrogate, swarm, or multi-model prototypes. Routine edits do not need this skill.

Research or design does not authorize implementation. Stop after the sketch unless the user asked to build it.

## Ground

Build a mental model of the systems the new code touches. Run `how` over the relevant subsystems, using CodeGraph and LSP. If the design redefines ownership or layering, also run `why` on the existing shape so the rationale is a constraint.

Skip grounding only when the work is genuinely greenfield.

## Sketch

Name the types, signatures, and module map. Screen the shape against these red flags:

- **Shallow module.** Large interface, little hidden complexity. Callers coordinate several methods to finish one operation.
- **Information leakage.** Transport, storage, or wire types leak through the public surface.
- **Temporal decomposition.** Modules named load / validate / transform / save that repeat one domain.
- **Pass-through method.** Forwards the same arguments without adding policy.

Prefer the design that hides more complexity behind a smaller public surface.

Compare meaningful alternatives only when the change is novel and the first shape is not forced by the repository. Two whole-shape options is enough. Point fixes inside one shape do not count. For that trigger, see `principle-exhaust-the-design-space`. Do not force competing prototypes on routine work.

## When implementation is authorized

Replace `not implemented` bodies against the sketch. A deviation is a signal: the sketch was wrong, a requirement was missed, or the implementation is overreaching.

If implementation keeps producing the same workaround shape, throw the sketch out. Redesign from the new constraints. Subtract before adding.

## Output

Usage first, then the type sketch. One file of new types and signatures for small work. A module map plus types for larger work. Include the rejected alternative in one paragraph when you compared more than one shape.
