import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { nativeCaller, type NativeCaller } from "../agent/consultation.ts";
import { immutable, SubmissionError } from "../architecture/protocol.ts";

export interface NativeTurn { instanceId: string; turnId: string; attemptId: string; historyId?: string; sessionId: string }
export interface Envelope<B> {
  stage: B extends { kind: infer K } ? K : never;
  body: B; turnId: string; attemptId: string;
  native: { historyId?: string; sessionId: string; toolCallId: string; persistence: "unconfirmed" };
  doubts: { id: string; question: string; purpose: string }[];
}
export interface LocalParticipant {
  readonly protocol: "architecture" | "review";
  readonly schema: TSchema;
  readonly analysis: true;
  readonly failure: string | undefined;
  readonly attempted: boolean;
  attemptSubmit(identity: NativeTurn): void;
  begin(identity: NativeTurn): void;
  bind(pi: ExtensionAPI, ctx: ExtensionContext): void;
  prompt(identity: NativeTurn): void;
  submit(toolCallId: string, value: unknown, ctx: ExtensionContext, identity: NativeTurn): unknown;
}

/** One originating prompt owns one provisional submission, published only after settlement. */
export function createParticipant<B extends { kind: string; doubts?: { question: string; purpose: string }[] },
  G extends { rules: { kind: string } }, M>(input: {
  protocol: "architecture" | "review"; schema: TSchema;
  validate(grant: G, value: unknown): { submissionId: string; body: B };
  current(): boolean; publish(message: Envelope<B>): M;
}) {
  const name = input.protocol;
  let grant: G | undefined, turn: NativeTurn | undefined, caller: NativeCaller | undefined;
  let provisional: { submissionId: string; body: B; receipt: { id: string; state: "provisional" }; toolCallId: string } | undefined;
  let invalid: string | undefined, submitted = false;
  const attempts: { submissionId: unknown; value: unknown; error?: SubmissionError }[] = [];
  const check = () => { if (!input.current() || !grant || !turn) throw new Error(`${name} grant retired`); };
  const attemptSubmit = (identity: NativeTurn) => {
    check();
    if (JSON.stringify(turn) !== JSON.stringify(identity)) throw new Error(`stale ${name} turn grant`);
    submitted = true;
  };
  return {
    protocol: name, schema: input.schema, analysis: true as const, attemptSubmit,
    get failure() { return invalid; },
    get attempted() { return submitted; },
    get caller() { if (!caller) throw new Error(`${name} native caller unavailable`); caller.check(); return caller; },
    open(authorization: G) {
      if (grant) throw new Error(`${name} turn busy`);
      grant = immutable(structuredClone(authorization)); turn = undefined; provisional = undefined;
      invalid = undefined; submitted = false; attempts.length = 0;
    },
    begin(identity: NativeTurn) {
      if (!input.current() || !grant) throw new Error(`${name} grant retired`);
      if (submitted) throw new Error(`${name} submission already attempted`);
      turn = structuredClone(identity);
    },
    bind(pi: ExtensionAPI, ctx: ExtensionContext) { caller = nativeCaller(pi, ctx, input.current); },
    prompt(identity: NativeTurn) {
      check();
      if (JSON.stringify(turn) !== JSON.stringify(identity)) throw new Error(`${name} attempt mismatch`);
      caller?.check();
    },
    submit(toolCallId: string, value: unknown, ctx: ExtensionContext, identity: NativeTurn) {
      attemptSubmit(identity);
      if (!caller || ctx.sessionManager !== caller.manager || ctx.sessionManager.getSessionId() !== turn!.sessionId) {
        invalid = `${name} native caller mismatch`; throw new Error(invalid);
      }
      caller.check();
      if (invalid) throw new Error(invalid);
      const submissionId = value && typeof value === "object" && "submissionId" in value ? value.submissionId : undefined;
      const previous = attempts.find(attempt => attempt.submissionId === submissionId);
      const fatal = (reason: string): never => { invalid = reason; throw new Error(reason); };
      if (previous) {
        if (!isDeepStrictEqual(previous.value, value)) fatal(`conflicting ${name} submission`);
        if (previous.error) throw previous.error;
        return provisional!.receipt;
      }
      if (provisional) fatal(`conflicting ${name} submission`);
      if (attempts.length >= 2) fatal(`${name} correction budget exhausted`);
      const attempt: typeof attempts[number] = { submissionId, value: structuredClone(value) };
      attempts.push(attempt);
      try {
        const validated = input.validate(grant!, value);
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
    settle(success: boolean): M {
      try {
        check(); caller?.check();
        if (!success || invalid || !provisional) throw new Error(invalid ?? `${name} protocol failed: no valid settled submit`);
        return input.publish({ stage: provisional.body.kind as Envelope<B>["stage"], body: structuredClone(provisional.body),
          turnId: turn!.turnId, attemptId: turn!.attemptId,
          native: { historyId: turn!.historyId, sessionId: turn!.sessionId, toolCallId: provisional.toolCallId, persistence: "unconfirmed" },
          doubts: provisional.body.doubts?.map(doubt => ({ id: randomUUID(), ...doubt })) ?? [] });
      } finally { grant = undefined; turn = undefined; provisional = undefined; }
    },
    revoke() { grant = undefined; turn = undefined; provisional = undefined; },
  };
}
