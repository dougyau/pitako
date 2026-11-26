import { canonicalDigest, sha256 } from "./canonical.mjs";
import path from "node:path";
import { EXECUTE_CURSOR_KEY, validateExecuteCursor, type ExecuteCursor } from "./execute-cursor.ts";
import type { CheckpointIntent } from "./execute-checkpoint.ts";
import { PitakoStore, StoreError, type VerifiedStoreRecord } from "./pitako-store.ts";
import { executeProjection, ledgerPath, storedGateEvidence } from "../skills/execute/ledger.mjs";
import { existsSync, readFileSync } from "node:fs";
import { EXECUTE_CONTINUATION_INCOMPATIBLE, EXECUTE_STATE_VERSION, executionStatePath, readContinuation } from "./execute-state.ts";

function savedExecuteCursor(context: { missionPath: string; missionId: string; invocation: string }) {
  let value;
  try { value = JSON.parse(readFileSync(executionStatePath(context), "utf8"))[EXECUTE_CURSOR_KEY]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (value?.invocation !== context.invocation) return undefined;
  // Preliminary capture must let the root report the retained cursor without dispatching.
  if (value.version !== EXECUTE_STATE_VERSION)
    throw new StoreError(EXECUTE_CONTINUATION_INCOMPATIBLE,
      `${EXECUTE_CONTINUATION_INCOMPATIBLE}: Retained execute cursor v${value.version} is incompatible.`);
  return value;
}

export function boundExecuteHostHalt(cwd: string, context: Parameters<typeof savedExecuteCursor>[0] & {
  amendments: unknown[];
}) {
  const value = savedExecuteCursor(context);
  if (!value?.hostHalt) return undefined;
  const { cursor, admission } = readExecuteAdmission(cwd, value);
  if (canonicalDigest(admission.amendments ?? []) !== canonicalDigest(context.amendments))
    throw new Error("Retained host halt admission amendments changed.");
  return canonicalDigest(cursor);
}

export function boundExecuteTimeoutProjection(cwd: string, context: Parameters<typeof savedExecuteCursor>[0]) {
  const value = savedExecuteCursor(context);
  if (!value) return undefined;
  const packet = readExecuteTimeoutProjection(cwd, value);
  return packet ? { packet, digest: canonicalDigest(packet) } : undefined;
}

/** The first advance can commit before there is a cursor for its epoch. */
export function readInitialAdvanceReplay(cwd: string, context: Parameters<typeof savedExecuteCursor>[0] & {
  sourceRefs?: unknown[]; amendments?: unknown[];
}, selected: { commonDir: string; source: string; digest: string; binding: string }, previous?: ExecuteCursor) {
  const store = new PitakoStore(cwd);
  if (!existsSync(store.file)) return undefined;
  const epoch = previous ? previous.epoch + 1 : 0;
  const loop = (previous?.budget.consumedLoops ?? 0) + 1;
  const scope = `exec:${context.invocation}.e${epoch}`;
  const key = `invoke-${context.invocation}${epoch ? `.e${epoch}` : ""}.l${loop}.advance`;
  let records, storeId;
  try {
    if (previous && store.readIdentity()?.storeId === previous.storeId) return undefined;
    const { identity, records: observed } = store.readRecords(scope);
    if (identity.storeId === previous?.storeId) return undefined;
    storeId = identity.storeId;
    records = observed;
  } catch (error) {
    // Leave unreadable-store recovery to the existing writer.
    if (error instanceof StoreError && ["store-corrupt", "store-busy"].includes(error.code)) return undefined;
    throw error;
  }
  const admission = records.find(row => row.kind === "root-admission")?.body as {
    association?: CheckpointIntent["association"];
    admissionBinding?: string; amendments?: unknown[];
  } | undefined;
  if (!admission?.association) return undefined;
  const { association } = admission;
  if (association.missionId !== context.missionId || association.missionPath !== context.missionPath ||
      association.invocation !== context.invocation || association.root !== cwd ||
      association.commonDir !== selected.commonDir || association.source !== selected.source ||
      association.digest !== selected.digest || admission.admissionBinding !== selected.binding ||
      canonicalDigest(association.sourceRefs ?? []) !== canonicalDigest(context.sourceRefs ?? []) ||
      canonicalDigest(admission.amendments ?? []) !== canonicalDigest(context.amendments ?? []) ||
      previous && (canonicalDigest(association) !== previous.associationDigest ||
        admission.admissionBinding !== previous.admissionBinding || loop > previous.budget.maxCycles))
    throw new Error("Initial advance replay immutable admission mismatch.");
  const { records: activeRecords } = new PitakoStore(cwd, undefined, { root: cwd, storeId }).readRecords(scope, undefined, true);
  const operation = activeRecords.find(row => row.kind === "operation" && row.opKey === `operation:${key}`);
  if (!operation) return undefined;
  if (activeRecords.some(row => row.seq > operation.seq && row.kind === "operation"))
    throw new Error("Initial advance cannot replay later execution without its saved cursor.");
  return { storeId, input: { seq: operation.seq, digest: operation.digest } };
}

export function boundEpochAdvanceReplay(cwd: string, context: Parameters<typeof readInitialAdvanceReplay>[1],
  selected: Parameters<typeof readInitialAdvanceReplay>[2], value: unknown = savedExecuteCursor(context)) {
  if (value === undefined) return undefined;
  validateExecuteCursor(EXECUTE_CURSOR_KEY, value);
  if (value.invocation !== context.invocation || value.root !== cwd || value.action.kind === "terminal" ||
      value.hostHalt || value.halt && !["recovery", "timeout", "worker-activity"].includes(value.halt.stage))
    return undefined;
  return readInitialAdvanceReplay(cwd, context, selected, value);
}

/** Observe only the committed result of the selection named by the saved director. */
export function readExecuteSelectionReplay(cwd: string, cursor: ExecuteCursor) {
  const { action, loop } = cursor;
  if (loop?.phase !== "director" || action.kind !== "launched" || action.role !== "execution-director" ||
      !action.runId || cursor.hostHalt || cursor.halt && cursor.halt.stage !== "recovery") return undefined;
  const base = `invoke-${cursor.invocation}${cursor.epoch ? `.e${cursor.epoch}` : ""}.l${loop.number}`;
  if (action.key !== `${base}.director` && action.key !== `${base}.director.d1`) return undefined;
  const key = action.key.replace(/\.director(?=\.d1$|$)/, ".selectionIO");
  const store = new PitakoStore(cwd, undefined, { root: cursor.root, storeId: cursor.storeId });
  const { records } = store.readRecords(`exec:${cursor.invocation}.e${cursor.epoch}`, undefined, true);
  if (records[cursor.head.seq - 1]?.digest !== cursor.head.hash)
    throw new StoreError("cursor-ahead", "Director cursor head is absent from the store.");
  const row = records.find(record => record.seq > cursor.head.seq && record.opKey === `operation:${key}`);
  if (!row) return undefined;
  const body = row.body as { operation: string; request: { key: string; root: string; invocation: string;
    plan: { ref: { key: string; runId: string } }; rejectionArchive?: { key: string } } };
  const request = { operation: body.operation, ...body.request };
  if (row.kind !== "operation" || request.operation !== "selection" || request.key !== key ||
      request.root !== cursor.root || request.invocation !== cursor.invocation ||
      request.plan?.ref?.key !== action.key || request.plan.ref.runId !== action.runId ||
      canonicalDigest(request) !== row.requestDigest)
    throw new StoreError("store-corrupt", "Committed selection differs from its retained director.");
  const drainKey = request.rejectionArchive?.key;
  const receipt = records.find(candidate => candidate.seq > row.seq &&
    (candidate.kind === "receipt" && (candidate.body as { key?: string }).key === key ||
      drainKey && candidate.opKey === `final-drain:${drainKey}`));
  if (!receipt) return undefined;
  if (receipt.kind === "receipt") {
    const saved = receipt.body as { requestDigest: string; result: unknown; resultDigest: string };
    if (saved.requestDigest !== row.requestDigest || canonicalDigest(saved.result) !== saved.resultDigest)
      throw new StoreError("store-corrupt", "Committed selection receipt differs from its operation.");
  } else {
    const saved = receipt.body as { key: string; request: { expectedHead?: { seq: number; hash: string } } };
    if (receipt.kind !== "marker" || saved.key !== drainKey || saved.request.expectedHead?.seq !== row.seq ||
        saved.request.expectedHead.hash !== row.digest || canonicalDigest(saved.request) !== receipt.requestDigest)
      throw new StoreError("store-corrupt", "Committed rejected selection drain differs from its operation.");
  }
  const packet = { key, head: { seq: receipt.seq, hash: receipt.digest },
    input: receipt.kind === "receipt" ? { seq: row.seq, digest: row.digest } : { seq: receipt.seq, digest: receipt.digest },
    ...(receipt.kind === "marker" ? { drainKey } : {}) };
  return { packet, digest: canonicalDigest({ packet, cursorHead: cursor.head, director: action.runId }) };
}

/** Host observations are pinned to the saved cursor, including after a lost cursor save. */
export function readExecuteProgress(cwd: string, value: unknown) {
  validateExecuteCursor(EXECUTE_CURSOR_KEY, value);
  const cursor = value;
  const store = new PitakoStore(cwd, undefined, { root: cursor.root, storeId: cursor.storeId });
  const { records } = store.read(`exec:${cursor.invocation}.e${cursor.epoch}`, cursor.head);
  return { cursor, records };
}

export function readExecuteAdmission(cwd: string, value: unknown) {
  const progress = readExecuteProgress(cwd, value);
  return { ...progress, admission: admissionEvidence(progress.cursor, progress.records) };
}

function admissionEvidence(cursor: ExecuteCursor, records: readonly VerifiedStoreRecord[]) {
  const admission = records.find(row => row.kind === "root-admission")?.body as {
    association: CheckpointIntent["association"]; admissionBinding: string; amendments?: unknown[];
  } | undefined;
  if (!admission?.association || admission.association.invocation !== cursor.invocation ||
      admission.admissionBinding !== cursor.admissionBinding ||
      canonicalDigest(admission.association) !== cursor.associationDigest)
    throw new StoreError("store-corrupt", "Execute admission differs from the saved cursor.");
  return admission;
}

function timeoutAction(cursor: ExecuteCursor) {
  if (cursor.action.kind === "pending")
    return /^(?:timeout|gate-renewal-(?:stop|interrupt|permission))$/.test(cursor.halt?.stage ?? "") &&
      cursor.action.op === "gate" && /\.acceptance(?:\.g[23])?\.gate$/.test(cursor.action.opKey)
      ? cursor.action : undefined;
  if (!["timeout", "reviewer-renewal-barrier"].includes(cursor.halt?.stage ?? "")) return undefined;
  if (cursor.action.kind !== "launched" ||
      !(cursor.action.role === "worker" && cursor.action.op === "baseline" ||
        cursor.action.role === "reviewer" &&
        /(?:\.review\.[^.]+|\.(?:task-(?:reviewer|synthesis)|demand-observation|compliance))$/.test(cursor.action.key)))
    return undefined;
  return cursor.action;
}
function timeoutEvidence(cursor: ExecuteCursor, action: NonNullable<ReturnType<typeof timeoutAction>>,
  records: readonly VerifiedStoreRecord[]) {
  const row = records.find(row => row.seq === action.input.seq &&
    row.digest === action.input.digest);
  const body = row?.body as { operation?: string; request?: any; admission?: { seq: number; digest: string } } | undefined;
  if (action.kind === "pending" || action.key.includes(".review.") || action.key.endsWith(".compliance")) {
    const base = `invoke-${cursor.invocation}${cursor.epoch ? `.e${cursor.epoch}` : ""}.l${cursor.loop?.number}`;
    const publication = action.kind === "launched" && action.key.endsWith(".compliance") ? records.at(-1) : undefined;
    const archiveSeed = publication?.kind === "review-originals" &&
      publication.opKey === `review-originals:${base}.reviewOriginals`
      ? (publication.body as { archiveSeed: { input: unknown; body: { finalAttempt: { gate: { record: { seq: number; digest: string } } } } } }).archiveSeed : undefined;
    if (publication && (!archiveSeed || canonicalDigest(archiveSeed.input) !== canonicalDigest(action.input)))
      throw new StoreError("store-corrupt", "Compliance timeout lacks its committed review publication.");
    const selection = row;
    const request = (selection?.body as typeof body)?.request;
    const receipt = records.find(record => record.kind === "receipt" &&
      (record.body as { key: string }).key === request?.key);
    const applied = (receipt?.body as { result: { steps: { operation: string; result: any }[] };
      resultDigest: string; requestDigest: string } | undefined);
    const selected = applied?.result.steps.find(step => step.operation === "apply")?.result;
    const gateRef = archiveSeed?.body.finalAttempt.gate.record;
    const gate = gateRef ? records[gateRef.seq - 1] : records.at(-1);
    const final = gate?.body as { receipt: any; receiptDigest: string; producer: string; execDigest: string } | undefined;
    const opKey = action.kind === "pending" ? action.opKey : gate?.opKey?.slice("final-gate:".length);
    if (!selection || body?.operation !== "selection" || !request ||
        ![`${base}.selection`, `${base}.selection.d1`].includes(request.apply?.key) ||
        canonicalDigest({ operation: "selection", ...request }) !== selection.requestDigest ||
        !receipt || !applied || applied.requestDigest !== selection.requestDigest ||
        canonicalDigest(applied.result) !== applied.resultDigest || selected?.selected !== null ||
        !gate || gate.kind !== "final-gate" || gate.opKey !== `final-gate:${opKey}` ||
        gateRef && gate.digest !== gateRef.digest ||
        !["", ".g2", ".g3"].some(generation => opKey === `${base}.acceptance${generation}.gate`) ||
        !final || canonicalDigest(final.receipt) !== final.receiptDigest)
      throw new StoreError("store-corrupt", "Final acceptance timeout lacks its committed gate and selection.");
    const { seq, digest, prev, requestDigest } = gate;
    const { producer, execDigest, receiptDigest } = final;
    return { finalGateTimeout: { finalGate: { seq, digest, prev, requestDigest, producer, execDigest },
      receipt: final.receipt, receiptDigest, selection: selected, selectionInput: { seq: selection.seq, digest: selection.digest },
      selectionReference: { path: path.join(ledgerPath(cursor.root, cursor.invocation),
        "loop-io", "receipts", sha256(request.key), "000000.json"), digest: canonicalDigest(applied) },
      selectionHead: { seq: receipt.seq, hash: receipt.digest },
      requestObservation: final.receipt.requestObservation ?? request.requestObservation + 1 },
      ...(archiveSeed ? { archiveSeed } : {}) };
  }
  if (action.role === "worker") {
    const ref = cursor.loop?.attempt?.intent;
    const intent = ref && records[ref.seq - 1];
    if (row?.kind !== "operation" || body?.operation !== "baseline" ||
        canonicalDigest({ operation: "baseline", ...body.request }) !== row.requestDigest ||
        intent?.kind !== "intent" || intent.digest !== ref?.digest ||
        canonicalDigest(intent.body) !== canonicalDigest({ ...body.request.intent,
          baseline: (intent.body as CheckpointIntent).baseline }) ||
        body.request.intent.key !== action.key || !readContinuation(body.request.continuation)?.attempt?.restore)
      throw new StoreError("store-corrupt", "Restoring worker timeout differs from its committed baseline.");
    return { baseline: { intent: ref, replayOperation: "baseline" } };
  }
  if (action.key.endsWith(".demand-observation")) {
    const loop = cursor.loop;
    const base = `invoke-${cursor.invocation}${cursor.epoch ? `.e${cursor.epoch}` : ""}.l${loop?.number}`;
    const anchor = body?.admission;
    const admission = records.find(record => record.kind === "root-admission" &&
      record.seq === anchor?.seq && record.digest === anchor.digest);
    if (loop?.phase !== "director" || !["", ".g2", ".g3"].some(g => `${base}${g}.demand-observation` === action.key) ||
        row?.kind !== "operation" || body?.operation !== "advance" ||
        body.request?.prepare?.loop !== loop.number || !admission ||
        canonicalDigest({ operation: "advance", ...body.request, admission: admission.body }) !== row.requestDigest)
      throw new StoreError("store-corrupt", "Demand timeout advance input differs from the cursor.");
    const key = body.request.key;
    const receipt = records.find(candidate => candidate.kind === "receipt" && candidate.seq > row.seq &&
      (candidate.body as { key?: string }).key === key);
    const saved = receipt?.body as { requestDigest?: string; resultDigest?: string;
      result: { steps?: { operation: string; result: Record<string, unknown> }[] } } | undefined;
    if (!receipt || !saved || saved.requestDigest !== row.requestDigest || canonicalDigest(saved.result) !== saved.resultDigest)
      throw new StoreError("store-corrupt", "Demand timeout advance receipt is unavailable or differs.");
    const prepare = saved.result.steps?.filter(step => step.operation === "prepare");
    const requests = saved.result.steps?.filter(step => step.operation === "requests");
    if (prepare?.length !== 1 || requests?.length !== 1)
      throw new StoreError("store-corrupt", "Demand timeout advance lacks prepare or request evidence.");
    const { acceptance: _acceptance, acceptanceHistory: _history, ...prepared } = prepare[0]!.result;
    const verifiedOriginals = records.some(candidate => candidate.kind === "review-originals" &&
      candidate.opKey === `review-originals:${base}.demandOriginals` && candidate.seq > receipt.seq);
    return { advance: {
      path: path.join(ledgerPath(cursor.root, cursor.invocation), "loop-io", "receipts", sha256(key), "000000.json"),
      digest: canonicalDigest(saved),
      projection: { steps: [{ ...prepare[0]!, result: prepared }, requests[0]!] },
    }, verifiedOriginals };
  }
  if (row?.kind !== "operation" || body?.operation !== "gate" ||
      canonicalDigest({ operation: "gate", ...body.request }) !== row.requestDigest)
    throw new StoreError("store-corrupt", "Timeout gate input differs from the cursor.");
  const { head: _head, ...gate } = storedGateEvidence(records, body.request);
  const base = action.key.replace(/(?:\.g[23])?\.task-(reviewer|synthesis)$/, "");
  const context = [...records].reverse().find(row => row.kind === "task-review-context" &&
    (row.body as { key?: string }).key === base)?.body;
  if (!context) throw new StoreError("store-corrupt", "Timeout review context unavailable.");
  return { gate, context };
}

/** Only timeout renewal may reconstruct P through the existing read-only host call. */
export function readExecuteTimeoutProjection(cwd: string, value: unknown) {
  validateExecuteCursor(EXECUTE_CURSOR_KEY, value);
  const cursor = value;
  const action = timeoutAction(cursor);
  if (!action) return undefined;
  const store = new PitakoStore(cwd, executeProjection, { root: cursor.root, storeId: cursor.storeId });
  const scope = `exec:${cursor.invocation}.e${cursor.epoch}`;
  const prefix = store.read(scope, cursor.head);
  const evidence = timeoutEvidence(cursor, action, prefix.records);
  const result = { head: prefix.head, storeId: prefix.identity.storeId, P: prefix.P,
    ...("advance" in evidence || "baseline" in evidence || "finalGateTimeout" in evidence ? evidence : {
      gate: { ...evidence.gate, storeId: prefix.identity.storeId }, context: evidence.context,
    }) };
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > 61440) throw new Error(`Timeout projection exceeds 61440 bytes: ${bytes}.`);
  return result;
}

/** Recheck the exact prefix at the writer before treating missing evidence as corruption. */
export function verifyExecuteTimeoutProjection(root: string, value: unknown, store: PitakoStore, scope: string) {
  validateExecuteCursor(EXECUTE_CURSOR_KEY, value);
  const action = timeoutAction(value);
  if (!action || value.root !== root || scope !== `exec:${value.invocation}.e${value.epoch}`)
    throw new Error("Invalid timeout verification position.");
  let admission: ReturnType<typeof admissionEvidence> | undefined;
  store.verifyForWrite((name, records) => {
    if (name !== scope) return;
    if (records[value.head.seq - 1]?.digest !== value.head.hash)
      throw new StoreError("cursor-ahead", "Timeout cursor head is missing.");
    const prefix = records.slice(0, value.head.seq);
    admission = admissionEvidence(value, prefix);
    executeProjection(prefix);
    timeoutEvidence(value, action, prefix);
  }, { scope, head: value.head });
  if (!admission) throw new StoreError("store-corrupt", "Timeout admission unavailable.");
  return admission;
}
