import { Value } from "typebox/value";
import { submitSchema, type Body, type Message, type Stage } from "./types.ts";
import { CompositionError, planComposition, type CompositionBasis } from "../table/composition.ts";

export type Doubt = Message["doubts"][number];
export type Plan = Extract<Body, { kind: "consultation-plan" }>;
export type Knowledge = Extract<Body, { kind: "knowledge" }>;
export interface ConsultationResponse {
  id: string;
  assignmentId?: string;
  status: "completed" | "failed";
  message?: Message;
  error?: string;
}
export type StageRules =
  | ({ kind: "composition" } & CompositionBasis)
  | { kind: "preparation" }
  | { kind: "contribution"; objections: { memberId: string; messageId: string }[] }
  | { kind: "decision"; allowed: Extract<Body, { kind: "decision" }>["action"][] }
  | { kind: "consultation-plan"; doubts: Doubt[] }
  | { kind: "consultation-response"; doubtIds: string[] }
  | { kind: "knowledge"; plan: Plan; responses: ConsultationResponse[] }
  | { kind: "synthesis"; pendingDoubts: Doubt[]; partialReasons: string[] };
export interface StageGrant {
  roomId: string;
  memberId: string;
  assignmentId: string;
  snapshotId: string;
  round: number;
  rules: StageRules;
}
export interface SubmissionDiagnostic {
  code: "structure" | "reference" | "coverage" | "prerequisite" | "action" | "snapshot";
  stage: Stage;
  field: string;
  badIds: (string | number)[];
  missingIds: (string | number)[];
  correctionsLeft: number;
}
export class SubmissionError extends Error {
  constructor(readonly diagnostic: SubmissionDiagnostic) { super(JSON.stringify(diagnostic)); }
}
export function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) immutable(item);
  }
  return value;
}
/** The sole contextual validation boundary, called before a provisional receipt. */
export function validateSubmission(grant: StageGrant, value: unknown): { submissionId: string; body: Body } {
  const rules = grant.rules;
  const reject = (code: SubmissionDiagnostic["code"], field: string, badIds: (string | number)[] = [], missingIds: (string | number)[] = []): never => {
    throw new SubmissionError({ code, stage: rules.kind, field, badIds, missingIds, correctionsLeft: 0 });
  };
  if (!Value.Check(submitSchema, value)) {
    const first = [...Value.Errors(submitSchema, value)][0];
    return reject("structure", first?.instancePath || "body");
  }
  if (value.body.kind !== rules.kind) throw new Error("invalid architecture submit for stage");
  const body = value.body;
  const exact = (actual: string[], allowed: string[], field: string, cover = true) => {
    const seen = new Set<string>();
    const bad = actual.filter(id => { const duplicate = seen.has(id); seen.add(id); return duplicate || !allowed.includes(id); });
    const missing = cover ? allowed.filter(id => !seen.has(id)) : [];
    if (bad.length || missing.length) reject(bad.length ? "reference" : "coverage", field, bad, missing);
  };
  if (body.kind === "composition" && rules.kind === body.kind) {
    try { planComposition(body, rules); }
    catch (error) {
      if (error instanceof CompositionError) reject(error.code, error.field, error.badIds, error.missingIds);
      throw error;
    }
  } else if (body.kind === "decision" && rules.kind === body.kind) {
    if (!rules.allowed.includes(body.action)) reject("action", "body.action", [body.action], rules.allowed);
  } else if (body.kind === "contribution" && rules.kind === body.kind) {
    for (const objection of body.objections) if (!objection.argument.trim() || !rules.objections.some(item => item.memberId === objection.memberId && item.messageId === objection.messageId))
      reject("reference", "body.objections", [objection.memberId, objection.messageId]);
  } else if (body.kind === "consultation-plan" && rules.kind === body.kind) {
    exact([...body.resolutions.map(item => item.doubtId), ...body.support.flatMap(item => item.doubtIds)], rules.doubts.map(item => item.id), "body.resolutions/support.doubtIds");
    body.support.forEach((request, index) => {
      const bad = request.prerequisites.filter((id, pos) => id >= body.support.length || id === index || request.prerequisites.indexOf(id) !== pos);
      if (bad.length || !request.brief.trim() || !request.doubtIds.length) reject("prerequisite", `body.support.${index}`, bad);
    });
    const visited = new Set<number>(), visiting = new Set<number>();
    const visit = (index: number) => {
      if (visiting.has(index)) reject("prerequisite", "body.support.prerequisites", [index]);
      if (visited.has(index)) return;
      visiting.add(index); body.support[index]!.prerequisites.forEach(visit);
      visiting.delete(index); visited.add(index);
    };
    body.support.forEach((_, index) => { visit(index); });
  } else if (body.kind === "consultation-response" && rules.kind === body.kind) {
    exact(body.doubtIds, rules.doubtIds, "body.doubtIds");
  } else if (body.kind === "knowledge" && rules.kind === body.kind) {
    exact(body.resolutions.map(item => item.doubtId), rules.plan.support.flatMap(item => item.doubtIds), "body.resolutions.doubtId");
    for (const resolution of body.resolutions) {
      const own = rules.plan.support.findIndex(item => item.doubtIds.includes(resolution.doubtId));
      const required = new Set<number>();
      const add = (index: number) => { if (required.has(index)) return; required.add(index); rules.plan.support[index]!.prerequisites.forEach(add); };
      add(own);
      exact(resolution.supportIds, [...required].map(index => rules.responses[index]!.id), "body.resolutions.supportIds", false);
      if (resolution.status === "answered") {
        const missing = [...required].filter(index => rules.responses[index]!.status !== "completed").map(index => rules.responses[index]!.id);
        if (!resolution.supportIds.includes(rules.responses[own]!.id)) missing.push(rules.responses[own]!.id);
        if (missing.length) reject("prerequisite", "body.resolutions.supportIds", [], missing);
      }
    }
  } else if (body.kind === "synthesis" && rules.kind === body.kind && body.status === "complete") {
    if (rules.pendingDoubts.length || rules.partialReasons.length)
      reject("coverage", "body.status", ["complete"], [...rules.pendingDoubts.map(item => item.id), ...rules.partialReasons]);
  }
  return value;
}

export interface KnowledgeBoundary {
  kind: "knowledge-boundary";
  id: string;
  ordinal: number;
  roomId: string;
  cycleId: string;
  planMessageId: string;
  knowledgeMessageId: string | null;
  resolutions: (Knowledge["resolutions"][number] & {
    provenance: { kind: "direct"; planMessageId: string } |
      { kind: "delegated"; knowledgeMessageId: string; consultationId: string; responses: { consultationId: string; assignmentId?: string; messageId?: string; status: "completed" | "failed" }[] };
  })[];
}
/** Merge only confirmed authored messages. Never rewrite their native bodies. */
export function mergeKnowledge(input: { id: string; ordinal: number; roomId: string; cycleId: string; doubts: Doubt[]; plan: Message & { body: Plan };
  knowledge?: Message & { body: Knowledge }; responses: ConsultationResponse[] }): KnowledgeBoundary {
  const { plan, knowledge, responses } = input;
  return {
    kind: "knowledge-boundary", id: input.id, ordinal: input.ordinal, roomId: input.roomId, cycleId: input.cycleId,
    planMessageId: plan.id, knowledgeMessageId: knowledge?.id ?? null,
    resolutions: input.doubts.map(doubt => {
      const direct = plan.body.resolutions.find(item => item.doubtId === doubt.id);
      if (direct) return { ...direct, supportIds: [], provenance: { kind: "direct" as const, planMessageId: plan.id } };
      const resolution = knowledge!.body.resolutions.find(item => item.doubtId === doubt.id)!;
      const own = plan.body.support.findIndex(item => item.doubtIds.includes(doubt.id));
      return { ...structuredClone(resolution), provenance: { kind: "delegated" as const, knowledgeMessageId: knowledge!.id, consultationId: responses[own]!.id,
        responses: responses.filter(item => resolution.supportIds.includes(item.id) || item.id === responses[own]!.id).map(item => ({
          consultationId: item.id, assignmentId: item.assignmentId, messageId: item.message?.id, status: item.status,
        })) } };
    }),
  };
}
