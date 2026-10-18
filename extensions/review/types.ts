import { Type, type Static } from "typebox";
import { bodySchema as architectureSchema } from "../architecture/types.ts";
import type { Body as ArchitectureBody, Message as ArchitectureMessage } from "../architecture/types.ts";
const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 }), texts = Type.Array(text, { minItems: 1 });
const doubts = Type.Array(Type.Object({ question: text, purpose: text }, strict));
export const findingSchema = Type.Object({
  key: text, materiality: Type.Union([Type.Literal("blocking"), Type.Literal("nonblocking")]),
  contract: text, reference: text, consequence: text,
  basis: Type.Union([
    Type.Object({ kind: Type.Literal("failure"), path: text, evidence: texts }, strict),
    Type.Object({ kind: Type.Literal("missing-observation"), observation: text, effect: text, nextCapture: text, evidence: texts }, strict),
  ]),
}, strict);
const findings = Type.Array(findingSchema);
const response = Type.Object({ findingId: text, action: Type.Union([
  Type.Literal("corroborate"), Type.Literal("object"), Type.Literal("modify"), Type.Literal("withdraw")]),
  reason: text, evidence: texts, replacement: Type.Optional(findingSchema) }, strict);
const disposition = Type.Object({ findingId: text, status: Type.Union([
  Type.Literal("upheld"), Type.Literal("rejected"), Type.Literal("withdrawn"), Type.Literal("duplicate"), Type.Literal("unresolved")]),
  reason: text, references: Type.Array(text), duplicateOf: Type.Optional(text) }, strict);
export const synthesisSchema = Type.Object({
  kind: Type.Literal("synthesis"), completion: Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("failed")]),
  verdict: Type.Union([Type.Literal("no-blockers"), Type.Literal("changes-required"), Type.Literal("inconclusive")]),
  summary: text, dispositions: Type.Array(disposition),
  newFindings: Type.Array(Type.Object({ finding: findingSchema, status: Type.Union([Type.Literal("upheld"), Type.Literal("unresolved")]),
    reason: text, references: Type.Array(text) }, strict)),
  evidence: Type.Array(text), limits: Type.Array(text), pending: Type.Array(text),
}, strict);
// Composition, support and round decisions share grammar, not architectural judgments.
export const bodySchema = Type.Union([
  ...architectureSchema.anyOf.filter(schema => !["preparation", "contribution", "synthesis", "answer"].includes(schema.properties.kind.const)),
  Type.Object({ kind: Type.Literal("preparation"), analysis: text, findings, doubts }, strict),
  Type.Object({ kind: Type.Literal("contribution"), analysis: text, findings, responses: Type.Array(response), doubts }, strict),
  synthesisSchema,
]);
export const submitSchema = Type.Object({ submissionId: text, body: bodySchema }, strict);
export type Finding = Static<typeof findingSchema>;
export type Response = Static<typeof response>;
export type Synthesis = Static<typeof synthesisSchema>;
export type ReviewBody = Exclude<ArchitectureBody, { kind: "preparation" | "contribution" | "synthesis" | "answer" }>
  | { kind: "preparation"; analysis: string; findings: Finding[]; doubts: { question: string; purpose: string }[] }
  | { kind: "contribution"; analysis: string; findings: Finding[]; responses: Response[]; doubts: { question: string; purpose: string }[] }
  | Synthesis;
export type TableBody = ArchitectureBody | ReviewBody;
export type TableMessage = Omit<ArchitectureMessage, "body"> & { body: TableBody };
export interface PublishedFinding extends Finding {
  id: string; objectIdentity: string; author: string; memberId: string; messageId: string;
}
