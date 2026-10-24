---
name: architecture-design
description: "Design module interfaces, caller obligations, types, and ownership before code. Use for cross-module changes or when the interface would lock in the wrong shape. Does not implement unless the user asked."
---

# Architecture design

Design before implementing. Sketch types, function signatures, and module boundaries with `not implemented` bodies or short pseudocode.

This is a single-agent skill. Do not run arena, interrogate, swarm, or multi-model prototypes. Routine edits do not need this skill.

Research or design does not authorize implementation. Stop after the sketch unless the user asked to build it.

## Ground

Build a mental model of the systems the new code touches. Run `how` over the relevant subsystems, using CodeGraph and LSP. If the design redefines ownership or layering, also run `why` on the existing shape so the rationale is a constraint.

Skip grounding only when the work is genuinely greenfield.

## Sketch

Start with a caller's usage example, then name the types, signatures, and module
map. Describe obligations beyond the signature where relevant: configuration,
ordering, resource ownership, cancellation, errors, and performance constraints.
Make clear which responsibilities remain with the caller and which the module
owns.

Screen the shape against these red flags:

- **Shallow module.** Large interface, little hidden complexity. Callers coordinate several methods to finish one operation.
- **Information leakage.** Transport, storage, or wire types leak through the public surface.
- **Temporal decomposition.** Modules named load / validate / transform / save that repeat one domain.
- **Pass-through method.** Forwards the same arguments without adding policy or
  hiding knowledge the caller would otherwise need.

Prefer the design that hides more complexity behind a smaller public surface.

## Check the interface

Follow an important caller from request to result. A small method count is not
enough if the caller still coordinates the lifecycle or knows the implementation.
Judge the interface by useful behavior and knowledge it removes from callers,
not by implementation size.

For a proposed abstraction, explain what callers would have to repeat if it
disappeared. If removing it only makes the path easier to follow, reconsider it.
When extracting or combining modules, show where a likely change would land.
Prefer keeping related knowledge and edits together over spreading them across
wrappers.

Justify each point of variation with a current dependency, ownership constraint,
or verification need. Do not add pluggable layers for hypothetical implementations.
A necessary trust boundary does not need a second adapter to justify it.

Identify observable checks through the interface callers use. Internal checks
can cover a concrete uncertainty; do not expose internals merely to make them
mockable. Explain how the proposed shape supports verification without running
checks outside the assignment.

Compare meaningful alternatives only when the change is novel and the first shape is not forced by the repository. Two whole-shape options is enough. Point fixes inside one shape do not count. For that trigger, see `principle-exhaust-the-design-space`. Do not force competing prototypes on routine work.

## When implementation is authorized

Replace `not implemented` bodies against the sketch. A deviation is a signal: the sketch was wrong, a requirement was missed, or the implementation is overreaching.

If implementation keeps producing the same workaround shape, throw the sketch out. Redesign from the new constraints. Subtract before adding.

## Output

Follow the assigned output contract. Otherwise, show usage first, then the type
sketch and caller obligations. Include a module map for larger work, the checks
that would establish the design's guarantees, and a short reason for rejecting
an alternative when you compared more than one shape.
