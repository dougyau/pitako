import { Type, type Static } from "typebox";
import { createParticipant } from "../table/participant.ts";
import { validateSubmission } from "./protocol.ts";
import { compositionSchema } from "../table/composition.ts";
export type { NativeTurn } from "../table/participant.ts";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const texts = Type.Array(text);
const doubts = Type.Array(Type.Object({ question: text, purpose: text }, strict));
export const bodySchema = Type.Union([
  compositionSchema,
  Type.Object({ kind: Type.Literal("preparation"), analysis: text, doubts }, strict),
  Type.Object({ kind: Type.Literal("contribution"), proposal: text, arguments: texts,
    objections: Type.Array(Type.Object({ memberId: text, messageId: text, argument: text }, strict)), doubts }, strict),
  Type.Object({ kind: Type.Literal("decision"), action: Type.Union([
    Type.Literal("continue"), Type.Literal("consult"), Type.Literal("synthesize"), Type.Literal("recompose")]), reason: text }, strict),
  Type.Object({ kind: Type.Literal("consultation-plan"), resolutions: Type.Array(Type.Object({ doubtId: text,
    status: Type.Union([Type.Literal("answered"), Type.Literal("rejected")]), answer: text }, strict)),
    support: Type.Array(Type.Object({ role: Type.Union([Type.Literal("scout"), Type.Literal("researcher"), Type.Literal("oracle")]),
      brief: text, doubtIds: texts, prerequisites: Type.Array(Type.Integer({ minimum: 0 })) }, strict)) }, strict),
  Type.Object({ kind: Type.Literal("consultation-response"), doubtIds: texts, answer: text, evidence: texts, limits: texts, doubts }, strict),
  Type.Object({ kind: Type.Literal("knowledge"), resolutions: Type.Array(Type.Object({ doubtId: text,
    status: Type.Union([Type.Literal("answered"), Type.Literal("partial"), Type.Literal("rejected"), Type.Literal("failed")]),
    answer: text, supportIds: texts }, strict)) }, strict),
  Type.Object({ kind: Type.Literal("synthesis"), status: Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("failed")]),
    recommendation: text, alternatives: texts, evidence: texts, assumptions: texts, disagreements: texts, pending: texts }, strict),
]);
export type Body = Static<typeof bodySchema>;
export type Stage = Body["kind"];
export const submitSchema = Type.Object({ submissionId: text, body: bodySchema }, strict);
export interface Message { id: string; ordinal: number; roomId: string; assignmentId: string; memberId: string;
  author: string; stage: Stage; snapshotId: string; round?: number; turnId: string; attemptId: string; body: Body;
  native: { historyId?: string; sessionId: string; toolCallId: string; persistence: "unconfirmed" }; doubts: { id: string; question: string; purpose: string }[] }

/** Per-member local capability. Receipt is provisional, not permission to drive another prompt. */
export function participant(input: { current: () => boolean; publish: (message: Omit<Message, "id" | "ordinal" | "roomId" | "assignmentId" | "memberId" | "author" | "snapshotId">) => Message }) {
  return createParticipant({ ...input, protocol: "architecture", schema: submitSchema, validate: validateSubmission });
}
export type Participant = ReturnType<typeof participant>;
