import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { nativeCaller, type NativeCaller } from "../agent/consultation.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
  let expected: Stage | undefined, turn: NativeTurn | undefined, caller: NativeCaller | undefined;
  let provisional: { submissionId: string; body: Body; receipt: { id: string; state: "provisional" }; toolCallId: string } | undefined;
  let invalid: string | undefined;
  const check = () => { if (!input.current() || !expected || !turn) throw new Error("architecture grant retired"); };
  return {
    analysis: true as const,
    get failure() { return invalid; },
    get caller() { if (!caller) throw new Error("Architect native caller unavailable"); caller.check(); return caller; },
    open(stage: Stage) { if (expected) throw new Error("architecture turn busy"); expected = stage; turn = undefined; provisional = undefined; invalid = undefined; },
    begin(identity: NativeTurn) { if (!input.current() || !expected) throw new Error("architecture grant retired"); turn = identity; provisional = undefined; invalid = undefined; },
    bind(pi: ExtensionAPI, ctx: ExtensionContext) { caller = nativeCaller(pi, ctx, input.current); },
    prompt(identity: NativeTurn) { check(); if (JSON.stringify(turn) !== JSON.stringify(identity)) throw new Error("architecture attempt mismatch"); caller?.check(); },
    submit(toolCallId: string, value: unknown, ctx: ExtensionContext, identity: NativeTurn) {
      // An old callback cannot poison the current attempt's provisional submission.
      check();
      if (JSON.stringify(turn) !== JSON.stringify(identity)) throw new Error("stale architecture turn grant");
      if (!caller || ctx.sessionManager !== caller.manager || ctx.sessionManager.getSessionId() !== turn!.sessionId) throw new Error("architecture native caller mismatch");
      caller.check();
      try {
        if (!Value.Check(submitSchema, value) || value.body.kind !== expected) throw new Error("invalid architecture submit for stage");
        if (provisional) {
          if (provisional.submissionId !== value.submissionId || !isDeepStrictEqual(provisional.body, value.body)) throw new Error("conflicting architecture submission");
          return provisional.receipt;
        }
        provisional = { ...structuredClone(value), toolCallId, receipt: { id: randomUUID(), state: "provisional" } };
        return provisional.receipt;
      } catch (error) { invalid = String(error); throw error; }
    },
    settle(success: boolean): Message {
      try {
        check();
        if (!success || invalid || !provisional) throw new Error(invalid ?? "architecture protocol failed: no valid settled submit");
        return input.publish({ stage: expected!, body: structuredClone(provisional.body), turnId: turn!.turnId, attemptId: turn!.attemptId,
          native: { historyId: turn!.historyId, sessionId: turn!.sessionId, toolCallId: provisional.toolCallId, persistence: "unconfirmed" },
          doubts: "doubts" in provisional.body ? provisional.body.doubts.map(doubt => ({ id: randomUUID(), ...doubt })) : [] });
      } finally { expected = undefined; turn = undefined; provisional = undefined; }
    },
    revoke() { expected = undefined; turn = undefined; provisional = undefined; },
  };
}
export type Participant = ReturnType<typeof participant>;
