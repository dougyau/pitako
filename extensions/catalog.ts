/** Discoverable skills Pitako ships by default. Descriptions stay in context; bodies load on demand. */
export const DEFAULT_SKILL_NAMES = [
  "pitako-coding",
  "ponytail",
  "caveman",
  "investigate-first",
  "architect",
  "how",
  "why",
  "blast-radius",
  "tdd",
  "show-me-your-work",
  "create-verification-skill",
  "maintain-verification-skill",
  "reflect",
  "technical-writing",
  "unslop",
  "principle-foundational-thinking",
  "principle-model-the-domain",
  "principle-boundary-discipline",
  "principle-prove-it-works",
  "principle-fix-root-causes",
  "principle-guard-the-context-window",
  "principle-subtract-before-you-add",
  "principle-minimize-reader-load",
  "principle-type-system-discipline",
  "principle-sequence-verifiable-units",
  "principle-encode-lessons-in-structure",
  "principle-make-operations-idempotent",
  "principle-exhaust-the-design-space",
  "principle-outcome-oriented-execution",
  "principle-redesign-from-first-principles",
  "principle-build-the-lever",
  "principle-migrate-callers-then-delete-legacy-apis",
  "principle-separate-before-serializing-shared-state",
  "principle-experience-first",
] as const;

export type DefaultSkillName = (typeof DEFAULT_SKILL_NAMES)[number];

/** Upstream skills inspected and intentionally left out of this milestone. */
export const EXCLUDED_SKILL_NAMES = [
  "poteto-mode",
  "setup-pstack",
  "arena",
  "interrogate",
  "swarm",
  "principle-never-block-on-the-human",
  "principle-laziness-protocol",
] as const;

/** Language-specific. Not in the default `pi.skills` list. */
export const OPTIONAL_LANGUAGE_SKILLS = ["typescript-best-practices"] as const;

export const THIRD_PARTY_ALWAYS_ON_MARKERS = [
  "ACTIVE EVERY RESPONSE",
  "Respond terse like smart caveman",
  "Must always apply.",
  "subagent_type",
  "Use `subagent_type:",
] as const;

export function skillStatusLines(): string[] {
  return [
    "Skills load on demand. Only names and descriptions stay in the system prompt.",
    `Default skills (${DEFAULT_SKILL_NAMES.length}): ${DEFAULT_SKILL_NAMES.join(", ")}`,
    "Disable individual skills with `pi config` or package skill filters.",
    "Optional, not loaded: typescript-best-practices (add +skills/language/typescript-best-practices).",
    "Not included: poteto-mode, setup-pstack, arena, interrogate, swarm, principle-never-block-on-the-human.",
  ];
}
