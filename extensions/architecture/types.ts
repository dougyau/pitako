import { Type, type Static } from "typebox";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { nativeCaller, type NativeCaller } from "../agent/consultation.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { immutable, validateSubmission, SubmissionError, type StageGrant } from "./protocol.ts";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const texts = Type.Array(text);
const doubts = Type.Array(Type.Object({ question: text, purpose: text }, strict));
const specialist = Type.Object({ candidateRef: text, mandate: text, reason: text }, strict);
export const bodySchema = Type.Union([
  Type.Object({ kind: Type.Literal("composition"), snapshotId: text, specialists: Type.Array(specialist, { minItems: 1, maxItems: 5 }) }, strict),
  Type.Object({ kind: Type.Literal("preparation"), analysis: text, doubts }, strict),
  Type.Object({ kind: Type.Literal("contribution"), proposal: text, arguments: texts,
    objections: Type.Array(Type.Object({ memberId: text, messageId: text, argument: text }, strict)), doubts }, strict),
  Type.Object({ kind: Type.Literal("decision"), action: Type.Union([
    Type.Literal("continue"), Type.Literal("consult"), Type.Literal("synthesize"), Type.Literal("recompose")]), reason: text }, strict),
  Type.Object({ kind: Type.Literal("answer"), answer: text, evidence: texts, limits: texts, doubts }, strict),
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
export interface NativeTurn { instanceId: string; turnId: string; attemptId: string; historyId?: string; sessionId: string }
export interface Message { id: string; ordinal: number; roomId: string; assignmentId: string; memberId: string;
  author: string; stage: Stage; snapshotId: string; round?: number; turnId: string; attemptId: string; body: Body;
  native: { historyId?: string; sessionId: string; toolCallId: string; persistence: "unconfirmed" }; doubts: { id: string; question: string; purpose: string }[] }

/** Per-member local capability. Receipt is provisional, not permission to drive another prompt. */
export function participant(input: { current: () => boolean; publish: (message: Omit<Message, "id" | "ordinal" | "roomId" | "assignmentId" | "memberId" | "author" | "snapshotId">) => Message }) {
  let grant: StageGrant | undefined, turn: NativeTurn | undefined, caller: NativeCaller | undefined;
  let provisional: { submissionId: string; body: Body; receipt: { id: string; state: "provisional" }; toolCallId: string } | undefined;
  let invalid: string | undefined, submitted = false;
  const attempts: { submissionId: unknown; value: unknown; error?: SubmissionError }[] = [];
  const check = () => { if (!input.current() || !grant || !turn) throw new Error("architecture grant retired"); };
  const attemptSubmit = (identity: NativeTurn) => {
    // A stale callback must not consume or poison a later turn's grant.
    check();
    if (JSON.stringify(turn) !== JSON.stringify(identity)) throw new Error("stale architecture turn grant");
    submitted = true;
  };
  return {
    analysis: true as const,
    attemptSubmit,
    get failure() { return invalid; },
    get attempted() { return submitted; },
    get caller() { if (!caller) throw new Error("Architect native caller unavailable"); caller.check(); return caller; },
    open(authorization: StageGrant) {
      if (grant) throw new Error("architecture turn busy");
      grant = immutable(structuredClone(authorization)); turn = undefined; provisional = undefined; invalid = undefined; submitted = false; attempts.length = 0;
    },
    begin(identity: NativeTurn) {
      if (!input.current() || !grant) throw new Error("architecture grant retired");
      if (submitted) throw new Error("architecture submission already attempted");
      turn = structuredClone(identity);
    },
    bind(pi: ExtensionAPI, ctx: ExtensionContext) { caller = nativeCaller(pi, ctx, input.current); },
    prompt(identity: NativeTurn) { check(); if (JSON.stringify(turn) !== JSON.stringify(identity)) throw new Error("architecture attempt mismatch"); caller?.check(); },
    submit(toolCallId: string, value: unknown, ctx: ExtensionContext, identity: NativeTurn) {
      attemptSubmit(identity);
      if (!caller || ctx.sessionManager !== caller.manager || ctx.sessionManager.getSessionId() !== turn!.sessionId) {
        invalid = "architecture native caller mismatch";
        throw new Error(invalid);
      }
      caller.check();
      if (invalid) throw new Error(invalid);
      const submissionId = value && typeof value === "object" && "submissionId" in value ? value.submissionId : undefined;
      const previous = attempts.find(attempt => attempt.submissionId === submissionId);
      const fatal = (reason: string): never => { invalid = reason; throw new Error(reason); };
      if (previous) {
        if (!isDeepStrictEqual(previous.value, value)) fatal("conflicting architecture submission");
        if (previous.error) throw previous.error;
        return provisional!.receipt;
      }
      if (provisional) fatal("conflicting architecture submission");
      if (attempts.length >= 2) fatal("architecture correction budget exhausted");
      const attempt: typeof attempts[number] = { submissionId, value: structuredClone(value) };
      attempts.push(attempt);
      try {
        const validated = validateSubmission(grant!, value);
        provisional = { ...structuredClone(validated), toolCallId, receipt: { id: randomUUID(), state: "provisional" } };
        return provisional.receipt;
      } catch (error) {
        if (error instanceof SubmissionError) {
          attempt.error = new SubmissionError({ ...error.diagnostic, correctionsLeft: 2 - attempts.length });
          throw attempt.error;
        }
        return fatal(String(error));
      }
    },
    settle(success: boolean): Message {
      try {
        check();
        caller?.check();
        if (!success || invalid || !provisional) throw new Error(invalid ?? "architecture protocol failed: no valid settled submit");
        return input.publish({ stage: grant!.rules.kind, body: structuredClone(provisional.body), turnId: turn!.turnId, attemptId: turn!.attemptId,
          native: { historyId: turn!.historyId, sessionId: turn!.sessionId, toolCallId: provisional.toolCallId, persistence: "unconfirmed" },
          doubts: "doubts" in provisional.body ? provisional.body.doubts.map(doubt => ({ id: randomUUID(), ...doubt })) : [] });
      } finally { grant = undefined; turn = undefined; provisional = undefined; }
    },
    revoke() { grant = undefined; turn = undefined; provisional = undefined; },
  };
}
export type Participant = ReturnType<typeof participant>;
