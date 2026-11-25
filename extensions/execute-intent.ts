import { isDeepStrictEqual } from "node:util";
import { canonicalDigest } from "./canonical.mjs";
import { previousUnitMatches, type CheckpointIntent, type ConfirmedUnit, type SealerRequest } from "./execute-checkpoint.ts";
import { StoreError } from "./pitako-store.ts";
import { readExecuteProgress } from "./execute-progress.ts";

export type CheckpointBinding = { association: CheckpointIntent["association"]; key: string };

/** The intent record body is the complete original committed by baseline operations. */
export type ExecuteIntentBody = CheckpointIntent;
type BaselineOperation = {
  operation?: string;
  request?: { intent?: CheckpointIntent; continuation?: { attempt?: { bindingKey?: string }; lastConfirmed?: ConfirmedUnit | { kind: "pause" } | null } };
};

/** Inspectors derive the association from the committed original; writer bindings also compare their supplied association. */
export function readExecuteIntentContext(cwd: string, value: unknown, association?: CheckpointIntent["association"]) {
  const { cursor, records } = readExecuteProgress(cwd, value);
  const loop = cursor.loop, attempt = loop?.attempt;
  if (association && (cursor.invocation !== association.invocation ||
      cursor.associationDigest !== canonicalDigest(association)))
    throw new Error("Checkpoint durable association mismatch.");
  if (!loop || loop.phase !== "implementation" || !attempt?.intent)
    throw new Error("Checkpoint execution has no current committed intention.");
  const row = records[attempt.intent.seq - 1];
  if (!row || row.digest !== attempt.intent.digest)
    throw new StoreError("store-corrupt", "Checkpoint intent reference differs from its committed record.");
  const intent = row.kind === "intent" ? row.body as ExecuteIntentBody : undefined;
  if (!intent || intent.version !== 2 ||
      association && !isDeepStrictEqual(intent.association, association) ||
      !intent.association || cursor.invocation !== intent.association.invocation ||
      cursor.associationDigest !== canonicalDigest(intent.association) ||
      intent.phase !== loop.phase || intent.loop !== loop.number || intent.cursor !== loop.cursor ||
      intent.taskId !== loop.taskId || intent.attempt !== attempt.number ||
      intent.progress?.consumedLoops !== cursor.budget.consumedLoops ||
      intent.association.maxCycles !== cursor.budget.maxCycles)
    throw new Error("Checkpoint intention/progress differs from durable execution context.");
  // Baselines carry the prior confirmation; a later admitted ledger unit replaces it.
  let confirmed: ConfirmedUnit | { kind: "pause" } | null | undefined;
  for (const record of records) {
    if (record.kind === "operation") {
      const continuation = (record.body as BaselineOperation).request?.continuation;
      if (continuation && Object.hasOwn(continuation, "lastConfirmed")) confirmed = continuation.lastConfirmed;
    }
    if (record.kind === "ledger") {
      for (const entry of (record.body as { entries: { kind: string; body: { checkpoint?: ConfirmedUnit | { kind: "pause" } } }[] }).entries)
        if (entry.kind === "unit" && entry.body.checkpoint) confirmed = entry.body.checkpoint;
    }
    if (record.kind === "receipt") {
      const packet = (record.body as { continuation?: {
        next: boolean; attempt: { seq: number; digest: string }; seal: { seq: number; digest: string };
      } }).continuation;
      if (packet?.next && packet.attempt.seq === row.seq && packet.attempt.digest === row.digest) {
        const seal = records[packet.seal.seq - 1];
        const result = seal?.body as { result?: { kind: string; receipt: { outcome: string } } };
        if (!seal || seal.kind !== "seal" || seal.digest !== packet.seal.digest ||
            result.result?.kind !== "pause" || !["sealed", "observed"].includes(result.result.receipt.outcome))
          throw new StoreError("store-corrupt", "Folded checkpoint pause provenance differs.");
        if (result.result.receipt.outcome === "sealed") confirmed = { kind: "pause" };
      }
    }
  }
  if (confirmed?.kind === "unit" && !previousUnitMatches(intent, confirmed))
    throw new Error("Confirmed unit lacks admitted pending-position provenance.");
  return { cursor, loop, attempt, intent, records, confirmed };
}

/** Read-only: a newer store tip cannot authorize a writer missing from cursor.head. */
export function readExecuteIntent(cwd: string, value: unknown, binding: CheckpointBinding, hook = false): CheckpointIntent {
  const { cursor, loop, attempt, intent, records } = readExecuteIntentContext(cwd, value, binding.association);
  if (loop.outcome || cursor.halt || cursor.hostHalt || cursor.action.kind === "terminal" ||
      !(hook ? attempt.stage === "launched" : ["intention", "launched"].includes(attempt.stage)))
    throw new Error("Checkpoint execution is stale, stopped or not a pending writer unit.");
  const baseline = [...records].reverse().find(row => {
    const body = row.body as BaselineOperation | null;
    return row.kind === "operation" && body?.operation === "baseline" &&
      body.request?.intent?.key === intent.key;
  })?.body as BaselineOperation | undefined;
  const bindingKey = baseline?.request?.continuation?.attempt?.bindingKey ?? intent.key;
  if ((hook ? bindingKey : intent.key) !== binding.key)
    throw new Error("Checkpoint intention/progress differs from durable execution context.");
  if (attempt.stage === "launched" &&
      !(cursor.action.kind === "launched" && cursor.action.key === intent.key && cursor.action.role === "worker" ||
        cursor.inFlight.some(child => child.key === intent.key && child.role === "worker")))
    throw new Error("Checkpoint launch is absent from the current cursor.");
  return intent;
}

/** Sealing observes settled work, not a live launch; all source intents still need a head-bound original. */
export function verifyExecuteSealerIntents(cwd: string, value: unknown, request: SealerRequest): void {
  const { intent, records } = readExecuteIntentContext(cwd, value, request.intent.association);
  // A folded close can leave the cursor on its successor before the preceding
  // seal is rechecked. Only an already committed identical seal permits this.
  const committedReplay = records.some(row => {
    if (row.kind !== "seal") return false;
    const body = row.body as { requestDigest?: string; result?: Record<string, unknown> };
    if (!body.result) return false;
    const { receipt, ...selection } = body.result;
    return body.requestDigest === canonicalDigest({ sealRequest: request, selection });
  }) && records.some(row => row.kind === "intent" && isDeepStrictEqual(row.body, request.intent));
  if (!isDeepStrictEqual(intent, request.intent) && !committedReplay)
    throw new Error("Checkpoint sealer intention differs from its committed original.");
  for (const source of request.restoreSources ?? []) {
    if (source.attempt > request.intent.attempt || !records.some(row =>
      row.kind === "intent" && isDeepStrictEqual(row.body, source)))
      throw new Error("Checkpoint restoration source lacks a cursor-head committed original.");
  }
}
