import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const strict = { additionalProperties: false } as const;
// Preserve complete strings when a provider matches patterns against the full value.
const text = Type.String({ minLength: 1, pattern: "[\\s\\S]*\\S[\\s\\S]*" });
export const specialistChoiceSchema = Type.Union([
  Type.Object({ kind: Type.Literal("retain"), memberId: text, mandate: text, reason: text }, strict),
  Type.Object({ kind: Type.Literal("add"), candidateRef: text, mandate: text, reason: text }, strict),
]);
export const compositionSchema = Type.Object({
  kind: Type.Literal("composition"), snapshotId: text, reason: text,
  specialists: Type.Array(specialistChoiceSchema, { maxItems: 5 }),
}, strict);
export type SpecialistChoice = Static<typeof specialistChoiceSchema>;
export type Composition = Static<typeof compositionSchema>;
export interface CompositionBasis {
  snapshotId: string;
  candidateRefs: readonly string[];
  retainableMemberIds: readonly string[];
}
export interface CompositionPlan {
  retained: readonly { memberId: string; choiceIndex: number }[];
  added: readonly { candidateRef: string; choiceIndex: number }[];
  retiringMemberIds: readonly string[];
}
export type CompositionChoiceRef = { compositionMessageId: string; choiceIndex: number };
export class CompositionError extends Error {
  constructor(readonly code: "structure" | "snapshot" | "reference", readonly field: string,
    readonly badIds: string[] = [], readonly missingIds: string[] = []) { super(`Invalid composition: ${field}`); }
}

/** Pure total-set validation; callers use the same frozen basis before and after settlement. */
export function planComposition(body: Composition, basis: CompositionBasis): CompositionPlan {
  if (!Value.Check(compositionSchema, body)) throw new CompositionError("structure", "body");
  if (body.snapshotId !== basis.snapshotId)
    throw new CompositionError("snapshot", "body.snapshotId", [body.snapshotId], [basis.snapshotId]);
  const retained: { memberId: string; choiceIndex: number }[] = [], added: { candidateRef: string; choiceIndex: number }[] = [];
  const seen = new Set<string>();
  body.specialists.forEach((choice, choiceIndex) => {
    if (choice.kind === "retain") {
      if (seen.has(choice.memberId) || !basis.retainableMemberIds.includes(choice.memberId))
        throw new CompositionError("reference", "body.specialists.memberId", [choice.memberId]);
      seen.add(choice.memberId); retained.push({ memberId: choice.memberId, choiceIndex });
    } else {
      if (!basis.candidateRefs.includes(choice.candidateRef))
        throw new CompositionError("reference", "body.specialists.candidateRef", [choice.candidateRef]);
      added.push({ candidateRef: choice.candidateRef, choiceIndex });
    }
  });
  return { retained, added, retiringMemberIds: basis.retainableMemberIds.filter(id => !seen.has(id)) };
}
