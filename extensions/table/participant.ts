import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { nativeCaller, type NativeCaller } from "../agent/consultation.ts";
import type { CompositionBasis } from "./composition.ts";
import { immutable, SubmissionError, type StageRules } from "../architecture/protocol.ts";

export interface NativeTurn { instanceId: string; turnId: string; attemptId: string; historyId?: string; sessionId: string }
declare const submitBinding: unique symbol;
/** Host object identity; serialized metadata cannot recreate this capability. */
export interface SubmitBinding { readonly [submitBinding]: true }
export type SubmitInput<B> = { body: B };
export interface SubmissionMetadata { version: 2; provenance: "host-bound"; compositionBasis?: CompositionBasis }
export interface Envelope<B> {
  submission: SubmissionMetadata;
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
  begin(identity: NativeTurn): SubmitBinding;
  bind(pi: ExtensionAPI, ctx: ExtensionContext): void;
  prompt(identity: NativeTurn): void;
  endPrompt(identity: NativeTurn): void;
  submit(binding: SubmitBinding, toolCallId: string, value: unknown, ctx: ExtensionContext, identity: NativeTurn, signal?: AbortSignal): unknown;
}

/** One originating prompt owns one provisional submission, published only after settlement. */
export function createParticipant<B extends { kind: string; doubts?: { question: string; purpose: string }[] },
  G extends { rules: StageRules }, M>(input: {
  protocol: "architecture" | "review"; schema: TSchema;
  validate(grant: G, value: unknown): SubmitInput<B>;
  current(): boolean; publish(message: Envelope<B>): M;
}) {
  const name = input.protocol;
  let grant: G | undefined, turn: NativeTurn | undefined, caller: NativeCaller | undefined;
  let provisional: { body: B; receipt: { id: string; state: "provisional" }; toolCallId: string } | undefined;
  let invalid: string | undefined, submitted = false;
  let binding: { token: SubmitBinding; grant: G; turn: NativeTurn; caller: NativeCaller; active: boolean } | undefined;
  const attempts: { value: unknown; error?: SubmissionError }[] = [];
  const calls = new Map<string, unknown>();
  const check = () => { if (!input.current() || !grant || !turn) throw new Error(`${name} grant retired`); };
  return {
    protocol: name, schema: input.schema, analysis: true as const,
    get failure() { return invalid; },
    get attempted() { return submitted; },
    get caller() { if (!caller) throw new Error(`${name} native caller unavailable`); caller.check(); return caller; },
    open(authorization: G) {
      if (grant) throw new Error(`${name} turn busy`);
      grant = immutable(structuredClone(authorization)); turn = undefined; provisional = undefined;
      invalid = undefined; submitted = false; attempts.length = 0; calls.clear(); binding = undefined;
    },
    begin(identity: NativeTurn) {
      if (!input.current() || !grant) throw new Error(`${name} grant retired`);
      if (submitted) throw new Error(`${name} submission already attempted`);
      turn = immutable(structuredClone(identity));
      if (!caller || caller.sessionId !== identity.sessionId) throw new Error(`${name} native caller mismatch`);
      caller.check();
      binding = { token: Object.freeze({}) as SubmitBinding, grant, turn, caller, active: false };
      return binding.token;
    },
    bind(pi: ExtensionAPI, ctx: ExtensionContext) {
      if (binding) binding.active = false;
      caller = nativeCaller(pi, ctx, input.current);
    },
    prompt(identity: NativeTurn) {
      check();
      if (!binding || !isDeepStrictEqual(binding.turn, identity)) throw new Error(`${name} attempt mismatch`);
      if (binding.caller !== caller) throw new Error(`${name} native caller mismatch`);
      binding.caller.check();
      if (submitted) throw new Error(`${name} submission already attempted`);
      binding.active = true;
    },
    endPrompt(identity: NativeTurn) {
      if (binding && isDeepStrictEqual(binding.turn, identity)) binding.active = false;
    },
    submit(definition: SubmitBinding, toolCallId: string, value: unknown, ctx: ExtensionContext, identity: NativeTurn, signal?: AbortSignal) {
      check();
      if (!binding?.active || definition !== binding.token) throw new Error(`stale ${name} definition generation`);
      if (!isDeepStrictEqual(binding.turn, identity)) throw new Error(`stale ${name} turn grant`);
      if (ctx.sessionManager !== binding.caller.manager || ctx.sessionManager.getSessionId() !== binding.turn.sessionId) {
        throw new Error(`${name} native caller mismatch`);
      }
      binding.caller.check();
      submitted = true;
      if (signal?.aborted) throw new Error(`${name} submit callback aborted`);
      const fatal = (reason: string): never => { invalid = reason; throw new Error(reason); };
      if (!toolCallId || calls.has(toolCallId) && !isDeepStrictEqual(calls.get(toolCallId), value))
        fatal(`conflicting ${name} toolCallId`);
      calls.set(toolCallId, structuredClone(value));
      const previous = attempts.find(attempt => isDeepStrictEqual(attempt.value, value));
      if (previous) {
        if (previous.error) throw previous.error;
        return provisional!.receipt;
      }
      if (invalid) throw new Error(invalid);
      if (provisional) fatal(`conflicting ${name} submission`);
      if (attempts.length >= 2) fatal(`${name} correction budget exhausted`);
      const attempt: typeof attempts[number] = { value: structuredClone(value) };
      attempts.push(attempt);
      try {
        const validated = input.validate(binding.grant, value);
        provisional = { ...structuredClone(validated), toolCallId, receipt: { id: randomUUID(), state: "provisional" } };
        return provisional.receipt;
      } catch (error) {
        if (error instanceof SubmissionError) {
          attempt.error = new SubmissionError({ ...error.diagnostic, correctionsLeft: 2 - attempts.length });
          if (attempts.length === 2) invalid = `${name} correction budget exhausted`;
          throw attempt.error;
        }
        return fatal(String(error));
      }
    },
    settle(success: boolean): M {
      try {
        check();
        if (!binding || binding.caller !== caller) throw new Error(`${name} native caller mismatch`);
        binding.caller.check();
        if (!success || invalid || !provisional) throw new Error(invalid ?? `${name} protocol failed: no valid settled submit`);
        return input.publish({ submission: { version: 2, provenance: "host-bound", ...(grant!.rules.kind === "composition" ? {
          compositionBasis: { snapshotId: grant!.rules.snapshotId, candidateRefs: [...grant!.rules.candidateRefs],
            retainableMemberIds: [...grant!.rules.retainableMemberIds] } } : {}) }, stage: provisional.body.kind as Envelope<B>["stage"], body: structuredClone(provisional.body),
          turnId: turn!.turnId, attemptId: turn!.attemptId,
          native: { historyId: turn!.historyId, sessionId: turn!.sessionId, toolCallId: provisional.toolCallId, persistence: "unconfirmed" },
          doubts: provisional.body.doubts?.map(doubt => ({ id: randomUUID(), ...doubt })) ?? [] });
      } finally { binding = undefined; grant = undefined; turn = undefined; provisional = undefined; }
    },
    revoke() { binding = undefined; grant = undefined; turn = undefined; provisional = undefined; },
  };
}
