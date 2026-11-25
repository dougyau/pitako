import "./loader.mjs";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { structuredPatch } from "diff";
import { admitExecuteRoot, appendLedger, committedIntent, commitExecute, executeEpoch, executeScope, executeStore, withExecuteStore, isLedgerIntegrityError, verifyExecuteStoreForWrite, ledgerPath, loopSummaries, summarizeLoops, readRequest, storedGateProjection, verifyLedger } from "./ledger.mjs";
import { safePath } from "../../extensions/hash-ledger.mjs";
import { nativeReference, settledBarrier } from "./halt-evidence.mjs";
import { canonicalDigest, canonicalJSON, sha256 } from "../../extensions/canonical.mjs";
import { accessReceiptKey, checkReceipt } from "../../extensions/access-receipts.mjs";
import { observeRequests } from "./observe.mjs";
import { reviewAnalysisConforms, reviewSynthesisContract } from "../review/synthesis.mjs";
const { viewBudget } = await import("../../extensions/board/store.ts");
const { PitakoStore, StoreError } = await import("../../extensions/pitako-store.ts");
const { captureBaseline, checkpointTaskDelta, readCheckpointTaskBytes, sealCheckpointRequest, observeTaskReviewSeal } = await import("../../extensions/execute-checkpoint.ts");
const { checkoutEvidence } = await import("../../extensions/spec-plans.ts");
const { prepare, apply, gate, taskGateWire, currentHumanPostIds, readBacklog, reviewOriginals, readReviewOriginal, readWorkerOriginal, readNativeOriginal } = await import("./loop.ts");
const { boundRetainedAnalyses, readNativeSettlement } = await import("../../extensions/execute-retained.ts");
const { boundExecuteTimeoutProjection, verifyExecuteTimeoutProjection } = await import("../../extensions/execute-progress.ts");
function stepKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes(".."))
    throw new Error("Invalid loop-io step key");
  return value;
}

function markerLocation(file) {
  const parts = file.split(`${path.sep}.pi${path.sep}subagents${path.sep}execute${path.sep}`);
  if (parts.length !== 2) throw new Error("Invalid loop-io marker location");
  const [invocation, ...relative] = parts[1].split(path.sep);
  return { root: parts[0], invocation, opKey: `loop-io:${relative.join("/")}` };
}

function readMarker(file) {
  const { root, invocation, opKey } = markerLocation(file);
  const { store, scope } = executeStore(root, invocation, true);
  const row = store.readRecords(scope).records.find(row => row.opKey === opKey);
  if (!row) return null;
  const marker = row.body;
  if (marker.seq !== 0 || canonicalDigest(marker.result) !== marker.resultDigest)
    throw new Error("loop-io marker integrity mismatch");
  return marker;
}

/** Runtime projections travel on stdout, never inside persisted receipt results. */
export function receiptData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { P, ...data } = value;
  if (Array.isArray(data.steps))
    data.steps = data.steps.map(step => ({ ...step, result: receiptData(step.result) }));
  if (data.receipt) data.receipt = receiptData(data.receipt);
  return data;
}

function publishResult(directory, value) {
  const result = receiptData(value.result);
  const marker = { seq: 0, ...value, result, resultDigest: canonicalDigest(result) };
  const file = path.join(directory, "000000.json");
  const { root, invocation, opKey } = markerLocation(file);
  const kind = directory.includes(`${path.sep}receipts${path.sep}`) ? "receipt" :
    value.operation === "seal" ? "seal" : "marker";
  const saved = commitExecute(root, invocation, opKey, value.requestDigest ?? canonicalDigest(value.result), kind, marker);
  // Keep the logical marker address stable for already-bound replay inputs.
  return { path: file, digest: sha256(canonicalJSON(saved.result)), storeId: saved.identity.storeId, head: saved.head, P: saved.P };
}

function readReceipt(reference) {
  const marker = readMarker(reference.path);
  if (!marker) throw new Error("Missing loop-io receipt");
  if (sha256(canonicalJSON(marker)) !== reference.digest) throw new Error("loop-io receipt digest mismatch");
  return marker.result;
}

// HUMAN #2391 (topic #197): the sandbox has no file API. Only validated,
// bounded admission projections cross stdout; complete evidence remains on disk.
export function receiptTransport(reference, outer = true, readProjection = readReceipt) {
  if (reference.replayOperation === "baseline" || reference.replayedDrain || reference.P?.prompt.closing) return reference;
  const projection = readProjection(reference);
  const compact = JSON.parse(JSON.stringify(projection));
  for (const step of compact.steps) {
    if (step.operation === "drain") step.result = receiptTransport(step.result, false, readProjection);
    else if (step.result?.path && step.result?.digest) delete step.result.P;
    if (step.operation === "prepare" || step.operation === "apply" && compact.operation !== "selection") {
      delete step.result.acceptance;
      delete step.result.acceptanceHistory;
    }
    if (step.operation === "apply" && compact.operation !== "selection") delete step.result.view;
    if (step.operation === "apply" && (compact.operation !== "selection" || step.result.selected !== null))
      delete step.result.completedTasks;
    if (step.operation === "gate") {
      for (const gate of step.result.receipt.gates) gate.tail = "";
      // Transfer the fresh Board observation once, outside the retained gate.
      compact.view = step.result.receipt.view;
      const wire = taskGateWire(step.result.receipt);
      if (wire !== step.result.receipt) step.result.workerOriginal = step.result.receipt.workerOriginal;
      step.result.receipt = wire;
      // Final acceptance uses the standalone gate operation, not a task close.
      delete step.result.receipt.view;
    }
    if (compact.operation === "close" && step.operation === "requests" &&
        compact.steps.some(step => step.operation === "nextRequests")) {
      const { requests, ...page } = step.result;
      step.result = { ...page, count: requests.length };
    }
    if (step.operation === "seal" && step.result.receipt.restored) {
      const restored = step.result.receipt.restored;
      step.result.receipt.restored = Object.fromEntries(
        ["checkpointRef", "partialRef", "restoredRef", "digest", "position", "candidate", "confirmedPause", "confirmedUnit"]
          .filter(key => restored[key] !== undefined).map(key => [key, restored[key]]));
    }
  }
  const { P: storedProjection, reconstruct, ...location } = reference;
  let P = storedProjection;
  if (!reconstruct && P?.prompt.execution?.foldedContinuation) {
    const { foldedContinuation, ...execution } = P.prompt.execution;
    P = { ...P, prompt: { ...P.prompt, execution } };
  }
  const output = { ...location, ...(outer ? { P } : {}), projection: compact };
  const wireBytes = () => Buffer.byteLength(JSON.stringify(output));
  if (wireBytes() > 61440) {
    const pages = compact.steps.filter(step => ["requests", "nextRequests"].includes(step.operation) &&
      Array.isArray(step.result.requests)).map(step => step.result);
    if (pages.length) {
      const { root, invocation } = markerLocation(reference.path);
      const { store, scope } = executeStore(root, invocation);
      const retained = store.read(scope, reference.head);
      const request = retained.records.find(row => row.seq === P.control.operation.input.seq &&
        row.digest === P.control.operation.input.digest)?.body.request;
      const cursor = request?.requests?.cursor ?? 0;
      // Only the wire page shrinks. The immutable receipt and its replay identity
      // retain every request; the existing observer resumes at the first omitted one.
      while (wireBytes() > 61440) {
        const page = pages.filter(page => page.requests.length > 1)
          .sort((a, b) => Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a)))[0];
        if (!page) break;
        const original = canonicalJSON(page);
        if (P.prompt.selectedTask) page.observed ??= { count: page.requests.length, next: page.next,
          taskId: P.prompt.selectedTask.id,
          requested: page.requests.some(request => request.taskId === P.prompt.selectedTask.id) };
        page.requests.pop();
        page.next = cursor + page.requests.length;
        for (const field of ["continuation", "foldedContinuation"]) {
          const packet = output.P?.prompt.execution?.[field];
          if (packet?.requests && canonicalJSON(packet.requests) === original) {
            output.P = { ...output.P, prompt: { ...output.P.prompt, execution: {
              ...output.P.prompt.execution, [field]: { ...packet, requests: page },
            } } };
          }
        }
      }
    }
  }
  if (wireBytes() > 61440) throw new Error("loop-io admission projection exceeds 61440 bytes");
  return output;
}

async function applyIntention(input) {
  const { store, scope } = executeStore(input.root, input.invocation);
  const { backlog, replay, ...receipt } = apply({ ...input, currentHumanIds: await currentHumanPostIds(input) },
    digest => store.verifyGateLogForWrite(digest, scope));
  return { ...receipt, acceptance: backlog.acceptance, acceptanceHistory: backlog.acceptanceHistory };
}

// Keys belong to intentions, not launches: a .rN retry must see the same markers.
// Keep ledger integrity evidence across the grouped transport.
function ledgerStep(run) {
  try { return run(); } catch (error) {
    if (isLedgerIntegrityError(error)) error.ledgerIntegrity = true;
    throw error;
  }
}
const finalDrainKey = /\.l(\d+)\.finishDrain(?:\.v[1-9]\d*)?$/;
function pauseDrain(request) {
  return request.finalDrain === undefined && request.intentions?.some(entry =>
    entry.operation === "ledger" && entry.input?.record?.kind === "unit" &&
    entry.input.record.body.result?.status === "blocked");
}
export function recordFinalDrainInput(input) {
  if (!finalDrainKey.test(input.key) || input.finalDrain !== true && !pauseDrain(input)) return;
  const { operation, ...request } = input;
  return commitExecute(input.root, input.invocation, `final-drain:${input.key}`, canonicalDigest(request),
    "marker", { key: input.key, request });
}
export function retainSelectionRejection(input, error) {
  const seed = input.rejectionArchive;
  if (!seed || !error.selectionRejected || error.message.startsWith("backlog-conflict:") ||
      !seed.previous && !error.replayRejected) return;
  const { root, invocation, key } = input;
  const { store, scope } = executeStore(root, invocation);
  const prefix = store.readRecords(scope);
  const selection = prefix.records.find(row => row.opKey === `operation:${key}`);
  const loop = input.apply.loop;
  if (selection?.kind !== "operation" || seed.record.loop !== loop ||
      seed.key.replace(/\.finishDrain(?:\.v[1-9]\d*)?$/, ".selectionIO") !== key.replace(/\.d1$/, ""))
    throw new Error("Selection rejection archive integrity mismatch.");
  const record = { ...seed.record, body: { ...seed.record.body, plan: {
    ...seed.record.body.plan, stage: "rejected",
    rejection: { diagnostic: error.message, ref: seed.record.body.plan.ref,
      ...(seed.previous ? { previous: seed.previous } : {}) },
  } } };
  const intentions = input.intentions.slice();
  const previous = intentions.findLast(entry => entry.operation === "ledger");
  intentions.push({ key: seed.key.replace(/\.finishDrain(?:\.v\d+)?$/, ".gaps"), operation: "ledger",
    input: { record, ...(previous ? { expectedFrom: previous.key } : { expected: seed.expected }),
      ...(!previous && seed.spec ? { spec: seed.spec } : {}) } });
  const saved = recordFinalDrainInput({ root, invocation, key: seed.key, finalDrain: true, intentions,
    receipts: input.receipts, storeId: prefix.identity.storeId,
    expectedHead: { seq: selection.seq, hash: selection.digest } });
  return { key: seed.key, head: saved.head, storeId: saved.identity.storeId };
}
function nativeFinalDrain(admission, input) {
  const { digest, producer } = input.refs.drain ?? {};
  const association = admission?.association;
  if (!association || !producer || !/^[a-f0-9]{64}$/.test(digest) ||
      stepKey(producer.key).replace(/\.r\d+$/, "") !== input.key ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(producer.runId))
    throw new Error("Final drain lacks its exact native intention.");
  const mission = JSON.parse(readFileSync(safePath(association.missionPath), "utf8"));
  const children = mission.workflowChildren?.filter(child => child.key === producer.key && child.runId === producer.runId) ?? [];
  const child = children[0];
  const dirs = child?.artifactPaths?.filter(file => typeof file === "string" && path.isAbsolute(file) &&
    path.basename(file) === producer.runId) ?? [];
  if (mission.id !== association.missionId || children.length !== 1 || child.agent !== "pitako.loop-io" || dirs.length !== 1 ||
      !/^[0-9a-f-]{36}$/.test(child.workflowRunId))
    throw new Error("Final drain native producer identity mismatch.");
  const status = JSON.parse(readFileSync(safePath(path.join(dirs[0], "status.json")), "utf8"));
  if (status.runId !== producer.runId || status.workflowKey !== producer.key || status.cwd !== input.root ||
      status.parentWorkflowRunId !== child.workflowRunId || status.steps?.[0]?.agent !== child.agent)
    throw new Error("Final drain native status identity mismatch.");
  const settled = readNativeSettlement(path.join(path.dirname(dirs[0]), child.workflowRunId, "workflow-children.jsonl"),
    producer.key, producer.runId, child.agent);
  const task = settled.results?.length === 1 && settled.results[0].task;
  const { operation, ...request } = JSON.parse(typeof task === "string" ? task : "null") ?? {};
  if (operation !== "drain" || canonicalDigest({ operation, ...request }) !== digest ||
      request.finalDrain !== true && !pauseDrain(request))
    throw new Error("Final drain native intention digest mismatch.");
  return request;
}

function committedSelectionReceipt(input, prefix, row, receipt) {
  if (row?.kind !== "operation" || row.body.operation !== "selection" || row.body.request.key !== input.key ||
      canonicalDigest({ operation: "selection", ...row.body.request }) !== row.requestDigest ||
      receipt?.kind !== "receipt" || receipt.body.key !== input.key ||
      receipt.body.requestDigest !== row.requestDigest || receipt.seq <= row.seq)
    throw new Error("Committed selection replay differs from its exact receipt.");
  return { replay: { path: path.join(ledgerPath(input.root, input.invocation), "loop-io", "receipts",
    sha256(input.key), "000000.json"), digest: sha256(canonicalJSON(receipt.body)),
    storeId: prefix.identity.storeId, head: prefix.head, P: prefix.P } };
}

export function replaySelectionRejection(input, request, error) {
  if (!input.refs?.director || !error.selectionRejected || error.rejectedDrain ||
      error.message.startsWith("backlog-conflict:")) return;
  const { store, scope } = executeStore(input.root, input.invocation);
  let prefix = store.read(scope, input.expectedHead);
  const advanceKey = prefix.P.control.operation?.key;
  const receipt = prefix.records.find(row => row.kind === "receipt" && row.body.key === advanceKey);
  if (prefix.P.control.operation?.operation !== "advance" || !receipt)
    throw new Error("Director selection integrity failure: rejection lacks its exact advance receipt.");
  if (receipt.seq !== prefix.head.seq) prefix = store.read(scope, { seq: receipt.seq, hash: receipt.digest });
  return { path: path.join(ledgerPath(input.root, input.invocation), "loop-io", "receipts",
    sha256(advanceKey), "000000.json"), digest: sha256(canonicalJSON(receipt.body)),
    storeId: prefix.identity.storeId, head: prefix.head, P: prefix.P,
    selectionFailure: { reason: error.message, replayRejected: error.replayRejected === true, plan: request.plan,
      usage: request.usage, requestObservation: request.requestObservation,
      ...(request.recoveries ? { recoveries: request.recoveries } : {}),
      ...(request.rejectionArchive?.record.body.analysisCalls ? {
        analysisCalls: request.rejectionArchive.record.body.analysisCalls } : {}),
      ...(request.rejectionArchive?.previous ? { previous: request.rejectionArchive.previous } : {}) } };
}

function boundNativeProducer(association, fail) {
  const mission = JSON.parse(readFileSync(safePath(association.missionPath), "utf8"));
  if (mission.id !== association.missionId || !Array.isArray(mission.workflowChildren))
    throw fail("native mission identity mismatch");
  const native = (subject, agent, runId) => {
    const children = mission.workflowChildren.filter(child => child.key === subject && (!runId || child.runId === runId));
    const child = children[0];
    const dirs = child?.artifactPaths?.filter(file => typeof file === "string" && path.isAbsolute(file) &&
      path.basename(file) === child.runId) ?? [];
    if (children.length !== 1 || child.agent !== agent || dirs.length !== 1 ||
        !/^[0-9a-f-]{36}$/.test(child.workflowRunId))
      throw fail(`missing or ambiguous native producer ${subject}`);
    const status = JSON.parse(readFileSync(safePath(path.join(dirs[0], "status.json")), "utf8"));
    const journal = path.join(path.dirname(dirs[0]), child.workflowRunId, "workflow-children.jsonl");
    const result = readNativeSettlement(journal, subject, child.runId, agent);
    if (status.runId !== child.runId || status.cwd !== association.root || status.workflowKey !== subject ||
        status.parentWorkflowRunId !== child.workflowRunId || status.steps?.length !== 1 ||
        status.steps[0].agent !== agent || result.results?.length !== 1)
      throw fail(`native identity mismatch for ${subject}`);
    return { child, status, result, journal };
  };
  return { native, children: mission.workflowChildren };
}

function priorSelectionRejection(base, records, { native, children }, fail) {
  const key = `${base}.selectionIO`;
  const row = records.find(record => record.opKey === `operation:${key}`);
  const previous = row?.body.request;
  const failed = children.filter(child => child.key?.replace(/\.r\d+$/, "") === key).at(-1);
  if (row?.kind !== "operation" || row.body.operation !== "selection" || previous?.key !== key ||
      canonicalDigest({ operation: "selection", ...previous }) !== row.requestDigest || !failed)
    throw fail("prior selection rejection is unavailable");
  const { result } = native(failed.key, "pitako.loop-io", failed.runId);
  const wire = JSON.parse(result.output?.trim().split("\n").at(-1) ?? "null");
  const error = wire?.selectionFailure ?? (!result.ok && wire?.selectionRejected ? wire : null);
  if (!error || error.replayRejected || typeof error.reason !== "string" ||
      wire.selectionFailure && canonicalDigest(error.plan) !== canonicalDigest(previous.plan))
    throw fail("prior selection rejection differs");
  return { previous, rejection: { diagnostic: error.reason.slice(0, 2000), rejectedRef: previous.plan.ref } };
}

const selectionNativeRef = (subject, result) => ({ key: subject, ...Object.fromEntries(
  ["agent", "runId", "asyncDir", "outputReference", "outputArtifactPath", "outputPathMapping", "artifactPaths", "externalAdapter"]
    .filter(field => result[field] !== undefined).map(field => [field, result[field]])),
  ...(result.results.some(entry => entry.structuredOutputPath || entry.savedOutputPath) ? {
    results: result.results.filter(entry => entry.structuredOutputPath || entry.savedOutputPath)
      .map(entry => Object.fromEntries(["structuredOutputPath", "savedOutputPath"]
        .filter(field => entry[field] !== undefined).map(field => [field, entry[field]]))),
  } : {}) });
const selectionNativeUsage = result => {
  const usage = result.results[0].usage, fields = ["input", "output", "cacheRead", "cacheWrite"];
  return { id: `${result.runId}:0`, tokens: usage && fields.every(field => Number.isFinite(usage[field]) && usage[field] >= 0)
    ? fields.reduce((total, field) => total + usage[field], 0) : null };
};
function retryDirectorContext(input, prefix, store, scope, request, receipt, cursorPrefix) {
  const director = input.refs.retryDirector;
  const association = prefix.P.prompt.admission?.association;
  const base = director?.key?.replace(/\.director\.d1$/, "");
  const fail = reason => new Error(`Director selection integrity failure: ${reason}.`);
  if (!association || !base || director.key !== `${base}.director.d1` ||
      base !== `${request.key.replace(/\.l\d+\.(?:advance|nextAdvance)$/, "")}.l${request.prepare.loop}` ||
      director.runId !== null && !/^[a-f0-9-]{36}$/.test(director.runId))
    throw fail("unbound retry director");
  const producers = boundNativeProducer(association, fail);
  let settled;
  if (director.runId === null) {
    if (producers.children.some(child => child.key === director.key))
      throw fail("retry director already has a native producer");
  } else {
    const { result, status } = producers.native(director.key, "pitako.execution-director", director.runId);
    if (status.state !== "complete" || !result.ok)
      throw fail("retry director is not the settled inspector source");
    settled = result;
  }
  // The rejected operation is newer than the cursor; only the exact failed
  // selection and its native settlement supply the retry context, not tip P.
  const { records } = store.readRecords(scope);
  const { previous, rejection } = priorSelectionRejection(base, records, producers, fail);
  if (!receipt || previous.plan.ref.key !== `${base}.director` || previous.apply.loop !== request.prepare.loop ||
      previous.apply.expectedDigest !== receipt.body.result.steps.find(step => step.operation === "prepare")?.result.digest)
    throw fail("retry director lacks its exact advance");
  const demandSources = prefix.P.prompt.demand?.sources.find(item => item.loop === request.prepare.loop - 1)?.sources ?? [];
  const demandOriginals = demandSources.filter(source => source.kind === "review")
    .map(({ ref }) => ({ id: ref.key, ...ref }));
  let demandOriginalsVerified = false;
  if (prefix.head.seq !== cursorPrefix.head.seq || prefix.head.hash !== cursorPrefix.head.hash) {
    // The saved cursor may be at the review-demand verification, not at the advance receipt.
    const row = cursorPrefix.records.at(-1);
    if (!cursorPrefix.records.some(anchor => anchor.seq === prefix.head.seq && anchor.digest === prefix.head.hash) ||
        row.seq <= prefix.head.seq || row.kind !== "review-originals" ||
        row.opKey !== `review-originals:${base}.demandOriginals` || !demandOriginals.length ||
        canonicalDigest(cursorPrefix.P.control.operation) !== canonicalDigest(prefix.P.control.operation) ||
        canonicalDigest(row.body.originals?.map(({ body, ...ref }) => ref) ?? null) !== canonicalDigest(demandOriginals))
      throw fail("retry director cursor is not at its advance or verified demand originals");
    demandOriginalsVerified = true;
  }
  const archive = previous.rejectionArchive?.record.body;
  let analysisCalls = archive?.analysisCalls;
  if (demandSources.length) {
    // The first director saw this observation before the rejection; it is newer than the advance's demand ring.
    const demand = [".g3", ".g2", ""].map(generation => `${base}${generation}.demand-observation`)
      .map(key => producers.children.find(child => child.key === key &&
        previous.usage.some(entry => entry.id === `${child.runId}:0`))).find(Boolean);
    if (!demand) throw fail("retry director lacks its demand observation");
    const { status } = producers.native(demand.key, "pitako.reviewer", demand.runId);
    const { settlement } = readNativeOriginal(input.root, { association },
      { key: demand.key, runId: demand.runId }, "pitako.reviewer", "settlement");
    const ref = selectionNativeRef(demand.key, settlement);
    if (analysisCalls && canonicalDigest(analysisCalls.find(call => call.key === demand.key)?.ref ?? null) !== canonicalDigest(ref))
      throw fail("retry director demand observation differs from its archive");
    analysisCalls ??= [{ key: demand.key, ref, stage: "receipt", timeoutMs: status.timeoutMs, barrier: null }];
  }
  return {
    rejection, requestObservation: previous.requestObservation, recoveries: previous.recoveries ?? [],
    ...(demandOriginalsVerified ? { demandOriginalsVerified } : {}),
    usage: settled ? [...previous.usage, selectionNativeUsage(settled)] : previous.usage,
    ...(settled ? { plan: { ref: selectionNativeRef(director.key, settled), ok: true, status: "unavailable", barrier: null,
      reused: settled.reused === true, terminal: null, stage: "published" } } : {}),
    ...(analysisCalls ? { analysisCalls } : {}),
    ...Object.fromEntries(["retired", "analysisGenerations"]
      .filter(field => archive?.[field] !== undefined).map(field => [field, archive[field]])),
  };
}

function directorSelectionInput(input, prefix, store, scope) {
  const { root, invocation, key, refs } = input;
  const { director, inspector, input: anchor, loop, consumedLoops, backlogDigest } = refs;
  const { association, amendments } = prefix.P.prompt.admission ?? {};
  const advance = prefix.records.find(row => row.seq === anchor.seq && row.digest === anchor.digest);
  const base = key.replace(/\.selectionIO(?:\.d1)?$/, "");
  const originalKey = key.replace(/\.selectionIO(?=\.d1$|$)/, ".director");
  const fail = reason => new Error(`Director selection integrity failure: ${reason}.`);
  if (!association || root !== association.root || invocation !== association.invocation ||
      !/^invoke-.+\.l\d+$/.test(base) || !base.endsWith(`.l${loop}`) ||
      director?.key !== originalKey || !/^[a-f0-9-]{36}$/.test(director.runId) ||
      loop !== consumedLoops || consumedLoops > association.maxCycles ||
      advance?.body.operation !== "advance" || advance.kind !== "operation" ||
      advance.body.request.prepare.loop !== loop)
    throw fail("unbound director or advance");
  const tip = store.readRecords(scope);
  const stored = tip.records.find(row => row.opKey === `operation:${key}`);
  if (stored) {
    const request = stored.body.request;
    const ref = request?.plan?.ref;
    if (stored.kind !== "operation" || stored.body.operation !== "selection" ||
        stored.seq <= prefix.head.seq || ref?.key !== director.key || ref.runId !== director.runId ||
        stored.requestDigest !== canonicalDigest({ operation: "selection", ...request }))
      throw fail("stored selection differs from its director");
    const receipt = tip.records.find(row => row.kind === "receipt" && row.body.key === key);
    // The same .rN params work both before and after COMMIT, including after
    // a second lost cursor save. Committed replay needs no native body.
    if (receipt && !inspector) return committedSelectionReceipt(input,
      store.read(scope, { seq: receipt.seq, hash: receipt.digest }), stored, receipt);
  }
  const producers = boundNativeProducer(association, fail);
  const { native, children } = producers;
  const source = native(director.key, "pitako.execution-director", director.runId);
  const ref = selectionNativeRef, usageEntry = selectionNativeUsage;
  const plan = { ref: ref(director.key, source.result), ok: source.result.ok === true, status: "unavailable", barrier: null,
    reused: source.result.reused === true, terminal: null, stage: "published" };
  function publishedOriginal(producer, key, who) {
    const entry = producer.result.results[0], file = entry.savedOutputPath;
    if (producer.status.state !== "complete" || producer.status.steps[0].exitCode !== 0 ||
        !producer.result.ok || entry.exitCode !== 0 || !path.isAbsolute(file ?? "") ||
        path.basename(file) !== `${key}.json` || !producer.child.artifactPaths.includes(file) ||
        [producer.result, entry, producer.status.steps[0]].some(item => item.stopped || item.interrupted ||
          item.detached || item.timedOut || item.outputSaveError || item.outputPartial || item.truncation))
      throw fail(`${who} lacks an exact successful original`);
    const nativeValue = producer.status.steps[0].structuredOutput;
    let value;
    try { value = JSON.parse(readFileSync(safePath(file), "utf8")); }
    catch (error) {
      // An inspector original can survive in either native location. The
      // settlement journal and admitted inspector digest still bind the value.
      if (who !== "inspector" || error.code !== "ENOENT" || nativeValue === undefined) throw error;
      value = nativeValue;
    }
    if ([producer.result.structuredOutput,
      ...(nativeValue !== undefined || who !== "inspector" ? [nativeValue] : []),
      ...(typeof producer.result.output === "string" && /^\s*\{/.test(producer.result.output)
        ? [JSON.parse(producer.result.output)] : [])].some(body => canonicalDigest(body ?? null) !== canonicalDigest(value)))
      throw fail(`${who} original digest mismatch`);
    return value;
  }
  let value, recovery, recoveryUsage;
  if (inspector) {
    if (!inspector.key?.startsWith(`${base}.recover`) || !/\.recover[1-9]\d*$/.test(inspector.key) ||
        !/^[0-9a-f-]{36}$/.test(inspector.runId ?? "") || !/^[a-f0-9]{64}$/.test(inspector.digest ?? ""))
      throw fail("unbound inspector");
    const producer = native(inspector.key, "pitako.execution-inspector", inspector.runId);
    const recovered = publishedOriginal(producer, inspector.key, "inspector");
    const line = producer.result.results[0].task?.split("\n").find(line => line.startsWith("Selection source (data): "));
    const binding = line && JSON.parse(line.slice("Selection source (data): ".length));
    if (producer.child.workflowRunId !== source.child.workflowRunId ||
        canonicalDigest(binding ?? null) !== canonicalDigest({
          advance: anchor, director: { ...director, digest: canonicalDigest(plan.ref) },
        }) || canonicalDigest(recovered) !== inspector.digest)
      throw fail("inspector source binding or digest mismatch");
    if (recovered.status !== "recovered" || recovered.originalAvailable !== true ||
        recovered.binding === "changed" || recovered.comparison === "different-full-json" ||
        !Array.isArray(recovered.provenance) || !recovered.provenance.length ||
        !recovered.provenance.every(item => typeof item === "string" && item.trim()) ||
        typeof recovered.reason !== "string" || !recovered.reason.trim())
      throw fail("inspector lacks an authoritative recovered original");
    value = recovered.original;
    // Missing optional director bytes are why this route exists. Contradictory
    // bytes are not missing and cannot authorize the inspector's selection.
    const directorResult = source.result.results[0];
    const directorBodies = [source.result.structuredOutput, source.status.steps[0].structuredOutput];
    if (typeof source.result.output === "string" && /^\s*\{/.test(source.result.output))
      directorBodies.push(JSON.parse(source.result.output));
    if (directorResult.savedOutputPath && source.child.artifactPaths.includes(directorResult.savedOutputPath)) {
      try { directorBodies.push(JSON.parse(readFileSync(safePath(directorResult.savedOutputPath), "utf8"))); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (!value || directorBodies.some(body => body !== undefined && canonicalDigest(body) !== canonicalDigest(value)))
      throw fail("inspector original conflicts with the director");
    const recoveryRef = ref(inspector.key, producer.result);
    plan.recoverySource = { ref: recoveryRef, binding: recovered.binding, comparison: recovered.comparison };
    let reason = "", remaining = 1080;
    for (const point of recovered.reason.toWellFormed()) {
      const size = Buffer.byteLength(JSON.stringify(point)) - 2;
      if (size > remaining || reason.length + point.length > 360) break;
      reason += point; remaining -= size;
    }
    recovery = { subject: key.endsWith(".d1") ? "loop-plan:d1" : "loop-plan", phase: "loop-plan",
      association: { ...association, loop }, source: plan.ref, ref: recoveryRef, stage: "observed",
      disposition: "recovered", ok: true, status: "recovered", barrier: null, reused: producer.result.reused === true,
      terminal: null, reason, provenance: recovered.provenance };
    recoveryUsage = usageEntry(producer.result);
    if (stored) {
      const receipt = tip.records.find(row => row.kind === "receipt" && row.body.key === key);
      if (canonicalDigest(stored.body.request.plan) !== canonicalDigest(plan) ||
          canonicalDigest(stored.body.request.apply.director) !== canonicalDigest(value))
        throw fail("stored selection differs from its inspector");
      if (receipt) return committedSelectionReceipt(input,
        store.read(scope, { seq: receipt.seq, hash: receipt.digest }), stored, receipt);
    }
  } else value = publishedOriginal(source, director.key, "director");
  if (!(value?.select === null || typeof value?.select === "string" && value.select.trim()) ||
      !Array.isArray(value.changes) || typeof value.reason !== "string" || !value.reason.trim())
    throw fail("director original digest mismatch");
  if (stored) {
    const request = stored.body.request;
    if (canonicalDigest(request.apply.director) !== canonicalDigest(value)) throw fail("stored selection differs from its director");
    return request;
  }
  const earlier = prefix.records.findLast(row => row.kind === "receipt" && row.body.key === advance.body.request.key);
  const prepared = earlier?.body.result.steps.find(step => step.operation === "prepare")?.result;
  if (!prepared || prepared.digest !== backlogDigest ||
      value.select !== null && !advance.body.request.candidate)
    throw fail("advance receipt does not bind the selected backlog");
  const { previous, rejection } = key.endsWith(".d1") ? priorSelectionRejection(base, tip.records, producers, fail) : {};
  let { analysisCalls, retired, analysisGenerations } = previous?.rejectionArchive?.record.body ?? {};
  let usage = previous?.usage ?? [];
  if (!previous) {
    const demandKey = [".g3", ".g2", ""].map(suffix => `${base}${suffix}.demand-observation`)
      .find(subject => children.some(child => child.key === subject));
    const demandRequired = advance.body.request.demand?.sources
      .some(entry => entry.loop === loop - 1 && entry.sources.length);
    if (!demandKey && demandRequired) throw fail("missing demand observation producer");
    if (demandKey) {
      const { result, status } = native(demandKey, "pitako.reviewer");
      if (!result.ok || status.state !== "complete" || status.steps[0].exitCode !== 0 ||
          result.results[0].exitCode !== 0)
        throw fail("demand observation did not settle successfully");
      analysisCalls = [{ key: demandKey, stage: "receipt", ref: ref(demandKey, result),
        timeoutMs: status.timeoutMs ?? refs.reviewerMs, barrier: null }];
      usage = [usageEntry(result)];
      const generation = Number(demandKey.match(/\.g([23])\.demand-observation$/)?.[1] ?? 1);
      if (generation > 1) {
        const retiredKey = `${base}${generation === 2 ? "" : ".g2"}.demand-observation`;
        const { result: prior } = native(retiredKey, "pitako.reviewer");
        if (!prior.results[0].timedOut && ![prior, ...prior.results].some(entry => entry.terminalOutcome?.reason === "timeout"))
          throw fail("previous demand observation did not time out");
        retired = [nativeReference(retiredKey, prior, true)];
        analysisGenerations = { "demand-observation": generation };
      }
    }
  }
  usage = [...usage, usageEntry(source.result), ...(recoveryUsage ? [recoveryUsage] : [])];
  const recoveries = [...(previous?.recoveries ?? []), ...(recovery ? [recovery] : [])];
  // Paginated request observations after advance use the same monotonic counter.
  const requestObservation = previous?.requestObservation ?? readFileSync(safePath(source.journal), "utf8")
    .split("\n").reduce((count, line) => {
      let entry;
      try { entry = JSON.parse(line); } catch { return count; }
      const match = typeof entry.key === "string" && /^(.+)\.requests-(\d+)(?:\.r\d+)?$/.exec(entry.key);
      return match && match[1].startsWith(base.slice(0, base.lastIndexOf(".l")) + ".l")
        ? Math.max(count, Number(match[2])) : count;
    }, prefix.P.control.requestObservation);
  const specId = advance.body.request.prepare.specId;
  const lastConfirmed = prefix.P.control.lastConfirmed;
  const priorUnit = lastConfirmed?.kind === "unit" ? Object.fromEntries(
    ["taskId", "attempt", "resultRef", "checkpointRef", "digest"].map(field => [field, lastConfirmed[field]])) : null;
  const baseline = value.select === null ? null : {
    version: 2, association, key: `${base}.t1.a1`, baseline: advance.body.request.candidate,
    taskId: value.select, attempt: 1, loop, cursor: 0, phase: "implementation", planRef: plan.ref,
    progress: { consumedLoops, admitted: {}, previous: priorUnit },
  };
  let rejectionArchive;
  if (consumedLoops === association.maxCycles) {
    const { ledger: expected, finishDrain } = prefix.P.control;
    const generation = finishDrain?.key.startsWith(`${base}.finishDrain`) ? finishDrain.generation + 1 : 0;
    const body = { number: loop, cursor: 0, manifest: null, plan, attempt: null, results: [], recoveries, usage,
      ...(analysisCalls ? { analysisCalls } : {}),
      ...(retired ? { retired } : {}),
      ...(analysisGenerations ? { analysisGenerations } : {}),
      ...(prepared.cancelledScope?.length ? { cancelledScope: prepared.cancelledScope } : {}) };
    const spec = refs.spec;
    if (expected.count === 0 && (typeof spec !== "string" || sha256(spec) !== association.digest))
      throw fail("missing exact spec for rejection archive");
    rejectionArchive = { expected, record: { kind: "loop", loop, body },
      key: `${base}.finishDrain${generation ? `.v${generation}` : ""}`,
      ...(expected.count === 0 ? { spec: { content: spec, digest: association.digest } } : {}),
      ...(rejection ? { previous: rejection } : {}) };
  }
  return { root, invocation, key, plan, usage, ...(recoveries.length ? { recoveries } : {}),
    ...(rejectionArchive ? { rejectionArchive } : {}),
    apply: { root, specId, expectedDigest: backlogDigest, key: key.replace(/\.selectionIO/, ".selection"), invocation, loop,
      authority: { specDigest: association.digest, amendmentDigests: (amendments ?? []).map(item => item.sha256) },
      director: value }, ...(baseline ? { baseline } : {}),
    requestObservation,
    receipts: [{ path: path.join(ledgerPath(root, invocation), "loop-io", "receipts",
      sha256(earlier.body.key), "000000.json"), digest: sha256(canonicalJSON(earlier.body)) }],
    requests: { cursor: 0 }, intentions: [] };
}
export async function drain(input, { afterEffect = () => {}, afterStep = () => {} } = {}) {
  if (input.refs) {
    const resolved = resolveStoredGroupedInput("drain", input);
    if (resolved.replay) return resolved.replay;
    await drain(resolved, { afterEffect, afterStep });
    return resolveStoredGroupedInput("drain", input).replay;
  }
  const { root, invocation, intentions, key } = input;
  if (root !== process.cwd()) throw new Error("loop-io root must be its actual cwd");
  for (const reference of input.receipts ?? []) readReceipt(reference);
  stepKey(key);
  const directory = path.join(ledgerPath(root, invocation), "loop-io");
  if (!Array.isArray(intentions)) throw new Error("Expected pending loop-io intentions");
  // Validate the decision projection before any backlog effect; the session reuses this fold.
  const { store, scope } = executeStore(root, invocation, true);
  store.read(scope);
  const receiptKey = key.replace(/\.r\d+$/, "");
  const receiptDirectory = path.join(directory, "receipts", sha256(receiptKey));
  const previousReceipt = readMarker(path.join(receiptDirectory, "000000.json"));
  if (previousReceipt && (previousReceipt.key !== receiptKey || previousReceipt.requestDigest !== canonicalDigest(intentions)))
    throw new Error("loop-io drain replay differs");
  const seen = new Set();
  const resolved = new Map();
  const steps = intentions.map(intention => {
    stepKey(intention.key);
    if (seen.has(intention.key)) throw new Error("Duplicate loop-io intention key");
    seen.add(intention.key);
    const request = intention.input;
    if (!request || typeof request !== "object" || Array.isArray(request) ||
        request.root !== undefined && request.root !== root ||
        request.invocation !== undefined && request.invocation !== invocation ||
        !["ledger", "apply"].includes(intention.operation))
      throw new Error("Invalid loop-io intention");
    if (intention.operation === "apply" && (request.key !== intention.key ||
        !(request.settle || request.cancellations || request.recordGaps)))
      throw new Error("Drain apply requires an existing cancellation, settlement or gaps intention");
    const markerPath = path.join(directory, "steps", sha256(intention.key), "000000.json");
    const requestDigest = canonicalDigest(intention);
    const marker = readMarker(markerPath);
    if (marker && (marker.key !== intention.key || marker.requestDigest !== requestDigest))
      throw new Error("loop-io intention replay differs");
    if (marker) resolved.set(intention.key, marker.result);
    return { intention, markerPath, requestDigest, marker };
  });
  recordFinalDrainInput(input);
  function requestFor(intention) {
    const { expectedFrom, expectedDigestFrom, ...request } = intention.input;
    if (expectedFrom) {
      const anchor = resolved.get(expectedFrom);
      if (!anchor) throw new Error("Missing preceding ledger intention");
      request.expected = { count: anchor.count, head: anchor.head };
    }
    if (expectedDigestFrom) {
      const applied = resolved.get(expectedDigestFrom);
      if (!applied) throw new Error("Missing preceding apply intention");
      request.expectedDigest = applied.digest;
    }
    return request;
  }

  // Verify anchored records even on a marker hit; never trust a cached publication alone.
  for (const { intention, marker } of steps) {
    if (!marker || intention.operation !== "ledger") continue;
    const records = ledgerStep(() => verifyLedger(root, invocation, { count: marker.result.count, head: marker.result.head }));
    const input = requestFor(intention), record = records.at(-1), requested = input.record;
    ledgerStep(() => verifyLedger(root, invocation, input.expected));
    if (marker.result.count !== Math.max(1, input.expected.count) + 1 ||
        input.spec && canonicalJSON(records[0].body) !== canonicalJSON(input.spec) ||
        canonicalJSON({ kind: record.kind, loop: record.loop, body: record.body }) !== canonicalJSON(requested) ||
        record.prev !== (input.expected.count === 0 ? sha256(canonicalJSON(records[0])) : input.expected.head))
      throw Object.assign(new Error("loop-io ledger marker differs"), { ledgerIntegrity: true });
  }
  // A later apply may have published before its marker. Verify that same-key replay
  // rather than comparing the current backlog with an earlier, superseded apply.
  const applies = steps.filter(step => step.intention.operation === "apply");
  if (applies.some(step => step.marker)) {
    const latest = applies.at(-1), request = latest.intention.input;
    const current = readBacklog(root, request.specId);
    const applied = applies.findLast(step => step.intention.key === current.backlog?.lastApplied?.key);
    if (!applied || applies.indexOf(applied) < applies.findLastIndex(step => step.marker))
      throw new Error("backlog-conflict: completed drain apply changed");
    const value = await applyIntention({ ...requestFor(applied.intention), root, invocation });
    if (applied.marker && value.digest !== applied.marker.result.digest)
      throw new Error("backlog-conflict: drain marker content changed");
  }

  const results = [];
  for (const step of steps) {
    const { intention, markerPath, requestDigest } = step;
    let marker = step.marker;
    if (!marker) {
      const input = requestFor(intention), request = { ...input, root, invocation };
      const result = intention.operation === "ledger"
        ? ledgerStep(() => appendLedger(root, invocation, input))
        : await applyIntention(request);
      if (intention.operation === "ledger" && intention.input.record.kind === "loop")
        result.summaries = ledgerStep(() => loopSummaries(root, invocation, result));
      await afterEffect(intention.key);
      const context = intention.operation === "apply" ? taskContext(root, input.specId, result.selected) : null;
      publishResult(path.dirname(markerPath), { key: intention.key, operation: intention.operation, context,
        requestDigest, resultDigest: canonicalDigest(result), result });
      marker = readMarker(markerPath);
    }
    results.push({ key: intention.key, operation: intention.operation, result: marker.result });
    resolved.set(intention.key, marker.result);
    await afterStep(intention.key);
  }
  const result = { invocation, steps: results };
  return publishResult(receiptDirectory, {
    key: receiptKey, requestDigest: canonicalDigest(intentions), resultDigest: canonicalDigest(result), result,
  });
}

function taskContext(root, specId, selected) {
  const { backlog, digest } = readBacklog(root, specId);
  return { tasks: backlog?.tasks ?? [], digest, current: selected ?? null };
}

const slotDiffLegend = [
  "pitako-slot-diff v1",
  "a/ = slot baseline before attempt 1; b/ = current candidate.",
  "Index: status<TAB>section start line or -<TAB>pre mode -> post mode<TAB>pre sha256<TAB>post sha256<TAB>JSON path.",
  "Symlink and gitlink values are checkout digests. Non-rendered statuses declare unavailable content.",
  "Sections: ---/+++ paths, @@ logical-line ranges @@, then space/-/+ content; | continues the preceding logical line.",
  "\\ CRLF restores CR before LF; \\ No newline at end of file removes final LF. Chunks preserve bytes.",
  "Reading evidence only: this artifact cannot be applied with git apply.",
];

function slotDiffLine(line) {
  if (line === "\\ No newline at end of file") return [line];
  const prefix = line[0], crlf = line.endsWith("\r");
  const bytes = Buffer.from(line.slice(1, crlf ? -1 : undefined));
  const lines = [];
  let start = 0;
  do {
    let end = Math.min(start + 4096, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    lines.push((start ? "|" : prefix) + bytes.subarray(start, end).toString("utf8"));
    start = end;
  } while (start < bytes.length);
  if (crlf) lines.push("\\ CRLF");
  return lines;
}

const slotDiffPath = (side, record, digest) => {
  if (digest === null) return "/dev/null";
  const name = `${side}/${record.path}`;
  return /[\s"\\\x00-\x1f\x7f]/u.test(name) ? JSON.stringify(name) : name;
};

/** Pure rendering keeps all content limits visible in the complete index. */
export function renderSlotDiff(records, current) {
  let sectionBytes = 0, omitted = 0;
  const entries = records.map(record => {
    let status = record.status, section = [], hunks = 0;
    if (["verified", "unchanged"].includes(status)) {
      const before = record.before, after = current.get(record.path);
      const binary = bytes => /[\x00-\x08\x0b\x0c\x0e-\x1f]|\r(?!\n)/.test(bytes.toString("latin1"));
      if (binary(before) || binary(after)) status = "binary";
      else {
        let oldText, newText;
        try {
          const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
          oldText = decoder.decode(before); newText = decoder.decode(after);
        } catch { status = "invalid-utf8"; }
        if (status !== "invalid-utf8") {
          const patch = structuredPatch("", "", oldText, newText, "", "", { context: 3, maxEditLength: 2000 });
          if (patch === undefined) status = "too-large";
          else if (status !== "unchanged") {
            section = [`--- ${slotDiffPath("a", record, record.pre)}`, `+++ ${slotDiffPath("b", record, record.post)}`];
            hunks = patch.hunks.length;
            for (const hunk of patch.hunks) {
              section.push(`@@ -${hunk.oldLines ? hunk.oldStart : hunk.oldStart - 1},${hunk.oldLines} +${hunk.newLines ? hunk.newStart : hunk.newStart - 1},${hunk.newLines} @@`);
              for (const line of hunk.lines) section.push(...slotDiffLine(line));
            }
            const size = Buffer.byteLength(section.join("\n") + "\n");
            if (sectionBytes + size > 512 * 1024) { status = "omitted-cap"; section = []; }
            else { status = "rendered"; sectionBytes += size; }
          }
        }
      }
    }
    if (canonicalJSON(record.pre) !== canonicalJSON(record.post) && (status !== "rendered" || !hunks)) omitted++;
    return { record, status, section };
  });
  let nextLine = slotDiffLegend.length + 2 + entries.length;
  const mode = value => value === null ? "-" : value.mode.toString(8).padStart(6, "0");
  const index = entries.map(({ record, status, section }) => {
    const start = section.length ? nextLine : "-";
    nextLine += section.length;
    return [status, start, `${mode(record.pre)} -> ${mode(record.post)}`,
      record.pre?.hash ?? "-", record.post?.hash ?? "-", JSON.stringify(record.path)].join("\t");
  });
  const lines = [...slotDiffLegend, `index ${entries.length}`, ...index, ...entries.flatMap(entry => entry.section)];
  return { bytes: Buffer.from(lines.join("\n") + "\n"), lines: lines.length, omitted };
}

export function taskDelta({ root, invocation, intents }) {
  if (root !== process.cwd() || !Array.isArray(intents) ||
      intents.some(intent => intent.association.root !== root || intent.association.invocation !== invocation))
    throw new Error("Task delta loop-io association mismatch");
  let delta;
  try { delta = checkpointTaskDelta(intents); }
  catch (error) {
    // The sealer owns never-closed-effect recovery; do not review uncertain bytes.
    if (error.message === "Task delta requires settled checkpoint effects.") return { unsettled: true };
    throw error;
  }
  const { touched, netChanged } = delta;
  const current = readCheckpointTaskBytes(root, delta.records);
  let diff = null, reference = null;
  const overflow = netChanged.slice(200);
  if (touched.length) {
    const rendered = renderSlotDiff(delta.records, current);
    const body = { patch: rendered.bytes.toString("utf8"), overflow };
    const requestDigest = canonicalDigest(body);
    const saved = commitExecute(root, invocation, `task-delta:${requestDigest}`, requestDigest, "task-delta", body);
    const ref = { store: { storeId: saved.identity.storeId, scope: executeScope(invocation), seq: saved.head.seq },
      digest: saved.head.hash };
    diff = { ...ref, sha256: sha256(rendered.bytes), bytes: rendered.bytes.length, lines: rendered.lines, omitted: rendered.omitted };
    if (overflow.length) reference = ref;
  }
  return { touched, netChanged: netChanged.slice(0, 200), overflow: reference, diff };
}

export function commitTaskReviewContext(input, delta) {
  if (!Number.isSafeInteger(input.requestObservation) || input.requestObservation < 0)
    throw new Error("Invalid task review request observation");
  const key = input.intents.at(-1).key;
  // Anchor pending observation keys and the review brief before either model launches.
  const saved = commitExecute(input.root, input.invocation, `task-review-context:${key}`,
    canonicalDigest(input), "task-review-context",
    { key, delta, requestObservation: input.requestObservation });
  return { ...delta, head: saved.head, P: saved.P, storeId: saved.identity.storeId };
}

export async function runOperation(operation, input, grouped = false) {
  // withExecuteStore has already verified the cursor identity, fence and chain.
  if (operation === "verifySelection") return { ok: true };
  if (operation === "reviewOriginals" && input.refs) return publishFinalReview(input);
  if (operation === "verifyTimeout") {
    const { root, invocation, cursor, storeId, expectedHead, key, capture } = input;
    if (storeId !== cursor?.storeId || canonicalDigest(expectedHead) !== canonicalDigest(cursor.head) ||
        key !== `${cursor.action.key}.store-check`)
      throw new Error("Timeout verification request mismatch.");
    const { store, scope } = executeStore(root, invocation);
    const { association, admissionBinding } = verifyExecuteTimeoutProjection(root, cursor, store, scope);
    if (!capture) return { ok: true };
    return { ok: true,
      recovery: boundRetainedAnalyses(root, association.commonDir, association.source, association.digest, admissionBinding, association),
      timeoutRecovery: boundExecuteTimeoutProjection(root, association) };
  }
  const storedInput = ["gate", "baseline"].includes(operation) && input.refs;
  if (storedInput) input = resolveStoredGroupedInput(operation, input);
  if (input.replay) return input.replay;
  if (input.finalAcceptanceReplay) {
    const { request, envelope } = input.finalAcceptanceReplay;
    const receipt = await gate(request, { digest: canonicalDigest(request), producer: envelope.key });
    commitFinalGate(request, receipt, envelope.key);
    return resolveStoredGroupedInput("gate", envelope).replay;
  }
  if (operation === "baseline") recordBaselineInput(input);
  const operations = { prepare, apply, gate, reviewOriginals, baseline: captureBaseline, taskDelta };
  if (!Object.hasOwn(operations, operation)) throw new Error("Expected loop-io prepare, apply, gate, reviewOriginals, baseline, taskDelta or drain");
  if (operation === "apply") input.currentHumanIds = await currentHumanPostIds(input);
  const finalGate = operation === "gate" && input.task.id === "final-acceptance" && !input.worker && !grouped;
  const value = finalGate ? await gate(input, { digest: canonicalDigest(input), producer: input.key }) :
    await operations[operation](input);
  if (operation === "taskDelta" && input.requestObservation !== undefined && !value.unsettled)
    return commitTaskReviewContext(input, value);
  if (operation === "reviewOriginals" && input.invocation !== undefined) {
    if (input.root !== process.cwd()) throw new Error("loop-io root must be its actual cwd");
    const originals = value.originals.map(original => ({
      ...original, body: readReviewOriginal(original),
    }));
    const saved = commitExecute(input.root, input.invocation, `review-originals:${stepKey(input.key)}`,
      canonicalDigest(input), "review-originals", { originals });
    Object.assign(value, { head: saved.head, P: saved.P, storeId: saved.identity.storeId });
  }
  if (operation === "baseline") {
    value.intent = committedIntent(input.intent, value.candidate);
    const { store, scope } = executeStore(input.intent.association.root, input.intent.association.invocation);
    const { head, P, identity } = store.read(scope, { seq: value.intent.seq, hash: value.intent.digest });
    Object.assign(value, { head, P, storeId: identity.storeId });
  }
  if (operation === "apply") {
    const prepared = await prepare({ root: input.root, specId: input.specId, previousConfirmedUnit: null,
      taskId: value.selected?.id, invocation: input.invocation, loop: input.loop, dbPath: input.dbPath });
    if (prepared.digest !== value.digest) throw new Error(`backlog-conflict: ${prepared.path}`);
    value.view = prepared.view;
  }
  if (operation === "prepare" || operation === "apply") {
    const canonicalView = canonicalJSON(value.view);
    value.viewDigest = sha256(canonicalView);
    value.viewBytes = Buffer.byteLength(canonicalView);
  }
  const { backlog, ...receipt } = value;
  if (backlog) {
    receipt.acceptance = backlog.acceptance;
    receipt.acceptanceHistory = backlog.acceptanceHistory;
  }
  if (finalGate) return commitFinalGate(input, receipt);
  return operation === "gate" && input.worker && !grouped ? commitStoredGate(input, receipt) : receipt;
}

export function commitFinalGate(input, receipt, producer = input.key) {
  const key = input.key.replace(/\.r\d+$/, "");
  const execDigest = canonicalDigest(input.task.gates.map(({ id, command, cwd, timeoutMs }) => ({ id, command, cwd, timeoutMs })));
  const saved = commitExecute(input.root, input.invocation, `final-gate:${key}`, canonicalDigest(input), "final-gate",
    { producer, execDigest, receipt, receiptDigest: canonicalDigest(receipt) });
  const { store, scope } = executeStore(input.root, input.invocation);
  const { prev, requestDigest } = store.readRecords(scope, saved.head).records.at(-1);
  return { ...saved.result.receipt, receiptDigest: saved.result.receiptDigest,
    finalGate: { seq: saved.head.seq, digest: saved.head.hash, prev, requestDigest, producer, execDigest }, storeId: saved.identity.storeId };
}

function finalGateSelection(input, prefix, gateKey, before = Infinity) {
  const ref = input.refs.input;
  const row = prefix.records[ref.seq - 1];
  const selection = row?.body.request;
  const selected = selection && prefix.records.find(candidate => candidate.kind === "receipt" &&
    candidate.body.key === selection.key && candidate.seq > row.seq && candidate.seq < before);
  const applied = selected?.body.result?.steps.find(step => step.operation === "apply")?.result;
  if (row?.digest !== ref.digest || !applied || applied.selected !== null || selection.baseline ||
      gateKey.replace(/\.acceptance\.g[23]\.gate$/, ".acceptance.gate") !==
        selection.apply.key.replace(/\.selection(?:\.d1)?$/, ".acceptance.gate"))
    throw new StoreError("store-corrupt", "Final acceptance gate/selection integrity mismatch");
  const { path, digest } = committedSelectionReceipt({ key: selection.key, root: input.root, invocation: input.invocation },
    prefix, row, selected).replay;
  const requests = selected.body.result.steps.find(step => step.operation === "requests")?.result;
  return { applied, selection: row.body.request, selectionInput: ref, selectionReference: { path, digest }, requests,
    selectionHead: { seq: selected.seq, hash: selected.digest } };
}

function finalGateSource(input, prefix, gateKey, gateRef = { seq: prefix.head.seq, digest: prefix.head.hash }) {
  const gate = prefix.records[gateRef.seq - 1];
  if (gate?.digest !== gateRef.digest || gate.kind !== "final-gate" ||
      gate.opKey !== `final-gate:${gateKey}` || !gate.body.receipt ||
      canonicalDigest(gate.body.receipt) !== gate.body.receiptDigest)
    throw new StoreError("store-corrupt", "Final acceptance gate record integrity mismatch");
  return { ...finalGateSelection(input, prefix, gateKey, gate.seq), receipt: gate.body.receipt };
}

function reviewLaunchPrefix(rootKey, loop, generation) {
  const suffix = `.l${loop}${generation === 1 ? "" : `.g${generation}`}.review.`;
  return generation === 1 || rootKey.length + suffix.length <= 83 ? rootKey + suffix
    : `${rootKey.slice(0, 83 - suffix.length - 13)}-${canonicalDigest(rootKey).slice(0, 12)}${suffix}`;
}

function replayRenewedDemand(association, base, ref, generation, originals) {
  const fail = reason => new Error(`Renewed demand replay integrity failure: ${reason}.`);
  const { native, children } = boundNativeProducer(association, fail);
  const timedOut = (result, status) => !settledBarrier(result) && ["complete", "failed"].includes(status.state) &&
    [result, ...result.results].some(entry => entry.timedOut || entry.terminalOutcome?.reason === "timeout");
  const retiredKey = `${base}${generation === 2 ? "" : ".g2"}.demand-observation`;
  const { result: prior, status: priorStatus } = native(retiredKey, "pitako.reviewer");
  if (!timedOut(prior, priorStatus))
    throw fail("preceding demand observation did not time out");
  const renewal = { generation, retired: nativeReference(retiredKey, prior, true) };
  if (ref.runId === null && !children.some(child => child.key === ref.key))
    return { analyses: [], demandRenewal: renewal };
  const { result, status } = native(ref.key, "pitako.reviewer", ref.runId);
  if (!Number.isSafeInteger(status.timeoutMs) || status.timeoutMs <= priorStatus.timeoutMs ||
      status.timeoutMs < 1 || status.timeoutMs > 86400000)
    throw fail("native deadline unavailable");
  renewal.launchedMs = status.timeoutMs;
  if (timedOut(result, status)) {
    if (ref.digest !== null) throw fail("producer timed out instead of publishing its original");
    return { analyses: [], demandRenewal: { ...renewal, timeout: nativeReference(ref.key, result, true) } };
  }
  return { analyses: originals(), demandRenewal: renewal };
}

function replayAnalysisOriginals(input, saved, loop, role) {
  const refs = input.refs.analyses, association = saved.P.prompt.admission?.association;
  const epoch = executeEpoch(input.invocation, input.key);
  const rootKey = `invoke-${input.invocation}${epoch ? `.e${epoch}` : ""}`;
  const base = `${rootKey}.l${loop}`;
  const generation = Number(String(refs?.[0]?.key ?? "").match(role === "demand"
    ? /\.g([23])\.demand-observation$/ : /\.g([23])\.review\./)?.[1] ?? 1);
  const prefix = reviewLaunchPrefix(rootKey, loop, generation);
  const isKey = key => role === "demand" ? key === `${base}${generation === 1 ? "" : `.g${generation}`}.demand-observation` :
    key.startsWith(prefix) && /^(?:director-prepare|independent-[A-Za-z0-9_.-]+-r[12])$/.test(key.slice(prefix.length));
  if (!association || association.root !== input.root || !Array.isArray(refs) ||
      refs.length > (role === "demand" ? 1 : 5) || new Set(refs.map(ref => ref?.key)).size !== refs.length)
    throw new Error("Invalid early analysis replay references.");
  if (role === "demand") {
    for (const item of saved.P.prompt.demand?.sources ?? []) if (item.loop === loop - 1)
      for (const source of item.sources) if (source.kind === "review") readReviewOriginal(source.ref);
  }
  const mission = JSON.parse(readFileSync(safePath(association.missionPath), "utf8"));
  if (mission.id !== association.missionId || !Array.isArray(mission.workflowChildren))
    throw new Error("Early analysis replay mission identity mismatch.");
  const producers = mission.workflowChildren.filter(child =>
    typeof child.key === "string" && isKey(child.key) && child.agent === "pitako.reviewer");
  if (new Set(producers.map(item => item.key)).size !== producers.length ||
      producers.length > (role === "demand" ? 1 : 5) ||
      refs.some(ref => !ref || Object.keys(ref).sort().join(",") !== "digest,key,runId" ||
        !(generation > 1 && ref.runId === null && ref.digest === null &&
          (role === "review" ? ref.key === `${prefix}director-prepare` : isKey(ref.key) && !producers.length) ||
          producers.some(child => child.key === ref.key && (ref.runId === null || child.runId === ref.runId))) ||
        ref.digest !== null && !/^[a-f0-9]{64}$/.test(ref.digest)))
    throw new Error("Invalid early analysis original identity.");
  const originals = () => producers.map(({ key, runId }) => {
    const expected = refs.find(ref => ref.key === key);
    const { value, reference, settlement } = readNativeOriginal(input.root, { association },
      { key, runId }, "pitako.reviewer", "settlement");
    const digest = canonicalDigest(value);
    if (expected?.digest && expected.digest !== digest)
      throw new Error("Early analysis original digest changed.");
    // Tasks and output previews are not evidence. Keep the witnesses consumed
    // by nativeReference and the review reducer, plus the checked JSON value.
    const { output, task, ...result } = settlement;
    const results = result.results.map(({ task, output, acceptance, ...entry }) => ({
      ...entry, ...(acceptance?.recovery ? { acceptance: { recovery: acceptance.recovery } } : {}),
    }));
    return { reference, digest, result: { ...result, results, structuredOutput: value } };
  });
  return role === "demand" && generation > 1
    ? replayRenewedDemand(association, base, refs[0], generation, originals) : { analyses: originals() };
}

function replayRenewedReviewAccess(input, prefix, analyses) {
  const reviewPrefix = analyses.find(item => item.reference.key.endsWith(".director-prepare"))
    ?.reference.key.replace(/director-prepare$/, "");
  if (!reviewPrefix || !/\.g[23]\.review\.$/.test(reviewPrefix)) return;
  const { association } = prefix.P.prompt.admission;
  const base = `${reviewPrefix}verify-synthesis`;
  const fail = reason => new Error(`Renewed review verifier replay integrity failure: ${reason}`);
  const { children, native } = boundNativeProducer(association, fail);
  let verifier;
  for (let retry = 0; ; retry++) {
    const key = base + (retry ? `.store.r${retry}` : "");
    if (!children.some(child => child.key === key)) break;
    const { result, status } = native(key, "pitako.access-verifier");
    if (!result.ok || settledBarrier(result) || status.state !== "complete" || status.steps[0].exitCode !== 0 ||
        [result, ...result.results].some(entry => entry.error || entry.timedOut || entry.terminalOutcome ||
          entry.exitCode !== undefined && entry.exitCode !== 0))
      throw fail("receipt differs from its verified originals");
    const output = JSON.parse(result.output ?? "null");
    const busy = output?.v === 1 && output.code === "store-busy" && Object.keys(output).length === 2;
    verifier = { ref: { key, runId: result.runId, agent: result.agent, ok: true, output: result.output }, output, busy };
    if (!busy) break;
    if ([result, ...result.results].some(entry => entry.truncation || entry.outputSaveError))
      throw fail("receipt differs from its verified originals");
  }
  if (!verifier || verifier.busy) return;
  const gate = `${reviewPrefix}synthesis`, namespace = `execute-${input.invocation}`;
  const access = checkReceipt({ missionPath: association.missionPath, namespace, gate }, input.root);
  const reports = analyses.filter(item => item.reference.key.startsWith(`${reviewPrefix}independent-`));
  if (access.status !== "verified" || access.receipt.store.storeId !== input.storeId ||
      canonicalDigest(verifier.output?.receipt ?? null) !== canonicalDigest({ store: access.receipt.store, digest: access.receipt.digest }) ||
      reports.length !== 4 || access.items.length !== reports.length ||
      access.items.some(({ id, path }) => !reports.some(item =>
        `${item.reference.key}.v1.a1` === id && item.reference.path === path)))
    throw fail("receipt differs from its verified originals");
  return verifier.ref;
}

function replayFinalGate(input, store, scope, anchor) {
  const fail = reason => new StoreError("store-corrupt", `Final acceptance gate replay integrity mismatch: ${reason}`);
  const tip = store.readRecords(scope), rows = tip.records;
  const opKey = input.key.replace(/\.r\d+$/, "");
  const loop = Number(opKey.match(/\.l([1-9]\d*)\.acceptance\.gate$/)?.[1]);
  const row = rows.findLast(row => row.kind === "operation" && row.body.operation === "selection" &&
    row.body.request.apply.key.replace(/\.selection(?:\.d1)?$/, ".acceptance.gate") === opKey);
  if (!row || !loop || canonicalDigest(anchor.head) !== canonicalDigest({ seq: input.refs.input.seq, hash: input.refs.input.digest }))
    throw fail("missing selection or invalid anchor");
  const selectionInput = { seq: row.seq, digest: row.digest };
  const source = { ...input, refs: { input: selectionInput } };
  const existing = rows.find(row => row.opKey === `final-gate:${opKey}`);
  const { applied, selection, selectionHead, selectionReference, requests } = finalGateSelection(source, tip, opKey, existing?.seq);
  const { selected, digest, path: backlogPath, completedTasks, acceptance, acceptanceHistory, cancelledScope } = applied;
  const gates = acceptance.map(command => ({ ...command, timeoutMs: Math.max(command.timeoutMs ?? 1800000, input.refs.gateFloorMs) }));
  const exec = gates.map(({ id, command, cwd, timeoutMs }) => ({ id, command, cwd, timeoutMs }));
  let reuse;
  if (anchor.head.hash !== row.digest || input.refs.analyses && existing?.body.receipt.reused) {
    const prior = anchor.head.hash !== row.digest ? anchor.records.at(-1) :
      rows.find(record => record.kind === "final-gate" && record.body.producer === existing.body.receipt.reused.gateKey);
    const { producer, execDigest, receipt, receiptDigest } = prior?.body ?? {};
    const previousLoop = Number(producer?.match(/\.l([1-9]\d*)\.acceptance(?:\.g[23])?\.gate(?:\.r\d+)?$/)?.[1]);
    if (prior?.kind !== "final-gate" || prior.seq >= row.seq || !(previousLoop < loop) ||
        `final-gate:${producer.replace(/\.r\d+$/, "")}` !== prior.opKey ||
        !receipt || canonicalDigest(receipt) !== receiptDigest ||
        execDigest !== canonicalDigest(exec) || receipt.mutated || receipt.reused)
      throw fail("invalid prior acceptance reuse binding");
    reuse = { loop: previousLoop, gateKey: producer, candidate: receipt.after, exec, results: receipt.gates };
  }
  const intervening = rows.slice(selectionHead.seq, existing ? existing.seq - 1 : rows.length);
  const committedReceipt = reference => {
    const { opKey } = markerLocation(reference.path);
    const marker = rows.find(row => row.seq <= selectionHead.seq && row.opKey === opKey)?.body;
    if (marker?.seq !== 0 || canonicalDigest(marker.result) !== marker.resultDigest ||
        sha256(canonicalJSON(marker)) !== reference.digest)
      throw fail("unbound selection transport receipt");
    return marker.result;
  };
  // The first wire page can be shorter than the selection's stored page.
  let page = requests?.requests?.length ? receiptTransport({ ...selectionReference, head: selectionHead,
    storeId: tip.identity.storeId, P: store.read(scope, selectionHead).P }, true, committedReceipt).projection.steps
    .find(step => step.operation === "requests")?.result : requests;
  let cursor = selection.requests?.cursor, offset = 0, requestObservation = selection.requestObservation ?? 0;
  while (true) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(requestObservation) ||
        requestObservation < 0 || requestObservation >= Number.MAX_SAFE_INTEGER ||
        page?.version !== 1 || page.ok !== true || page.invocation !== input.invocation ||
        !Array.isArray(page.requests) || page.next !== null &&
        (!Number.isSafeInteger(page.next) || page.next <= cursor || page.next !== cursor + page.requests.length))
      throw fail("invalid request observation page");
    requestObservation++;
    if (page.next === null) break;
    cursor = page.next;
    const matches = row => row?.kind === "observation" && row.body.operation === "requests" &&
      row.opKey.startsWith(`requests:${cursor}:`);
    // Unchanged pages are deduplicated by the observer and can predate selection.
    const observed = matches(intervening[offset]) ? intervening[offset++] :
      rows.findLast(row => row.seq <= selectionHead.seq && matches(row));
    page = observed?.body.result;
    if (!page || observed.requestDigest !== canonicalDigest(page) ||
        observed.opKey !== `requests:${cursor}:${observed.requestDigest}`)
      throw fail("unbound request observation page");
  }
  const request = { root: input.root, specId: selection.apply.specId, invocation: input.invocation,
    loop, attempt: 1, key: opKey, task: { id: "final-acceptance", gates, metric: null, progress: { nonImproving: 0, last5: [] } },
    workerStatus: "complete", writerSettled: true, requestObservation,
    ...(reuse ? { reuse } : {}) };
  const requestDigest = canonicalDigest(request);
  const saved = intervening[offset];
  if (saved) {
    const diagnosticKey = `gate:${opKey}`;
    const { receiptDigest, ...body } = saved.body;
    if (offset !== intervening.length - 1 || saved.kind !== "gate" ||
        saved.opKey.replace(/\.r[1-9]\d*$/, "") !== diagnosticKey ||
        body.finalRequest?.digest !== requestDigest ||
        typeof body.finalRequest.producer !== "string" ||
        body.finalRequest.producer.replace(/\.r[123]$/, "") !== opKey || !body.wireReceipt)
      throw fail("unbound diagnostic receipt");
    if (!body.identity || canonicalDigest(body) !== receiptDigest || canonicalDigest(body.identity) !== saved.requestDigest ||
        existing && (existing.body.producer !== body.finalRequest.producer ||
          existing.body.receiptDigest !== canonicalDigest(body.wireReceipt)))
      throw fail("invalid diagnostic digest");
    if (Buffer.byteLength(JSON.stringify(body.wireReceipt)) > viewBudget(0))
      throw Object.assign(new Error("Gate receipt exceeds 8 KiB"), { viewOverflow: true });
    if (!existing) {
      commitFinalGate(request, body.wireReceipt, body.finalRequest.producer);
      return replayFinalGate(input, store, scope, anchor);
    }
  }
  if (!existing) {
    if (input.refs.analyses) throw fail("early review lacks a committed gate");
    return { finalAcceptanceReplay: { request, envelope: input } };
  }
  const prefix = store.read(scope, { seq: existing.seq, hash: existing.digest });
  const { receipt } = finalGateSource(source, prefix, opKey);
  const { producer, receiptDigest, execDigest } = existing.body;
  if (typeof producer !== "string" || producer.replace(/\.r[123]$/, "") !== opKey ||
      requestDigest !== existing.requestDigest || execDigest !== canonicalDigest(exec))
    throw fail("committed gate request differs");
  const predecessor = { seq: existing.seq - 1, hash: existing.prev };
  const analyses = input.refs.analyses && replayAnalysisOriginals(input, prefix, loop, "review").analyses;
  const reviewAccess = analyses && replayRenewedReviewAccess(input, prefix, analyses);
  return { replay: { head: prefix.head, P: prefix.P, storeId: prefix.identity.storeId,
    finalGate: { seq: existing.seq, digest: existing.digest, prev: existing.prev, requestDigest: existing.requestDigest, producer, execDigest },
    predecessor, selectionHead, selectionInput, receipt, receiptDigest, requestObservation,
    selection: { selected, digest, path: backlogPath, completedTasks, acceptance, acceptanceHistory, cancelledScope },
    selectionReference, ...(analyses ? { analyses } : {}), ...(reviewAccess ? { reviewAccess } : {}) } };
}

export function publishFinalReview(input, observe = checkoutEvidence) {
  const fail = reason => new Error(`Final review publication integrity failure: ${reason}`);
  const { root, invocation, key, storeId, scope, expectedHead, refs } = input;
  const base = key.replace(/\.reviewOriginals$/, "");
  const loop = Number(base.match(/\.l([1-9]\d*)$/)?.[1]);
  const epoch = executeEpoch(invocation, key);
  const { store, scope: ownedScope } = executeStore(root, invocation, false, epoch);
  if (scope !== ownedScope || base !== `invoke-${invocation}${epoch ? `.e${epoch}` : ""}.l${loop}` ||
      key !== `${base}.reviewOriginals` || !Array.isArray(refs?.originals) || refs.originals.length !== 6 ||
      new Set(refs.originals.map(ref => ref.key)).size !== 6)
    throw fail("unbound request");
  const tip = store.readRecords(scope);
  if (tip.identity.storeId !== storeId) throw fail("store identity changed");
  if (expectedHead?.seq !== refs.input?.seq || expectedHead?.hash !== refs.input?.digest)
    throw fail("selection head differs");
  const requestDigest = canonicalDigest(input);
  const opKey = `review-originals:${key}`;
  const prior = tip.records.find(row => row.opKey === opKey);
  if (prior && (prior.kind !== "review-originals" || prior.requestDigest !== requestDigest))
    throw fail("committed request differs");
  const gate = tip.records.findLast(row => row.kind === "final-gate" &&
    ["", ".g2", ".g3"].some(generation => row.opKey === `final-gate:${base}.acceptance${generation}.gate`) &&
    (!prior || row.seq < prior.seq));
  if (!gate || !prior && tip.head.hash !== gate.digest) throw fail("invalid acceptance head");
  const prefix = store.read(scope, { seq: gate.seq, hash: gate.digest });
  const gateRef = { seq: gate.seq, digest: gate.digest };
  const gateKey = gate.opKey.slice("final-gate:".length);
  const { applied, receipt, selectionReference } = finalGateSource(input, prefix, gateKey, gateRef);
  const actual = observe(root);
  const { head, fingerprint } = receipt.after;
  if (receipt.mutated) throw fail("mutated final acceptance");
  const admission = prefix.P.prompt.admission;
  const execution = prefix.P.prompt.execution;
  const startedAt = prefix.P.prompt.loopOpen?.startedAt;
  if (!admission || !execution?.plan?.ref || prefix.P.prompt.loopOpen?.number !== loop || startedAt === undefined)
    throw fail("missing selection context");
  const { association } = admission;
  const { native } = boundNativeProducer(association, fail);
  const originals = [], references = [], calls = [], reviewUsage = [], digests = {};
  const synthesisRef = refs.originals.at(-1);
  const reviewPrefix = synthesisRef.key.replace(/director-synthesis$/, "");
  const generation = Number(reviewPrefix.match(/\.g([23])\.review\.$/)?.[1] ?? 1);
  const namespace = `execute-${invocation}`;
  for (const ref of refs.originals) {
    if (!ref.key.startsWith(reviewPrefix) || !ref.runId) throw fail("unbound reviewer");
    const { result, status } = native(ref.key, "pitako.reviewer", ref.runId);
    const original = readNativeOriginal(root, { association }, ref, "pitako.reviewer", false);
    const digest = canonicalDigest(original.value);
    if (!result.ok || result.terminalOutcome || result.results[0].exitCode !== 0 ||
        status.state !== "complete" || original.value.status !== "ready" ||
        result.results[0].savedOutputPath !== original.reference.path ||
        canonicalDigest(result.structuredOutput) !== digest || (ref.digest && ref.digest !== digest))
      throw fail(`native original mismatch for ${ref.key}`);
    const { key, runId, path, sha256 } = original.reference;
    digests[key] = digest;
    originals.push({ id: `${key}.v1.a1`, key, runId, path, sha256, body: original.value });
    // The returned publication reference and the verified saved file are
    // distinct native witnesses. Do not substitute one for the other.
    const fields = (source, names) => Object.fromEntries(names.filter(name => source[name] !== undefined)
      .map(name => [name, source[name]]));
    const reference = { key, runId, agent: "pitako.reviewer",
      ...fields(result, ["model", "outputReference", "metadataSaveError"]),
      results: [{ savedOutputPath: path,
        ...fields(result.results[0], ["outputReference", "structuredOutputPath", "metadataSaveError"]) }] };
    references.push({ ...reference, barrier: null, reused: result.reused === true });
    calls.push({ key, stage: "receipt", ref: { key, runId }, timeoutMs: status.timeoutMs ?? refs.reviewerMs, barrier: null });
    const usage = result.results[0].usage;
    const usageFields = ["input", "output", "cacheRead", "cacheWrite"];
    reviewUsage.push({ id: `${runId}:0`, tokens: usage && usageFields.every(field =>
      Number.isFinite(usage[field]) && usage[field] >= 0) ? usageFields.reduce((sum, field) => sum + usage[field], 0) : null });
  }
  const [prepare, ...reports] = originals;
  const synthesis = reports.pop();
  const risk = prepare.body.angles?.[0]?.id;
  const screening = synthesis.body.screening;
  const childPrefix = base.slice(0, -`.l${loop}`.length);
  const expectedPrefix = reviewLaunchPrefix(childPrefix, loop, generation);
  if (reviewPrefix !== expectedPrefix ||
      prepare.key !== `${reviewPrefix}director-prepare` || synthesis.key !== `${reviewPrefix}director-synthesis` ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,28}$/.test(risk ?? "") || risk === "evidence-contract" ||
      !["clear", "material-gaps"].includes(screening?.verdict) ||
      ["evidence-contract", risk].flatMap(angle => ["r1", "r2"].map(slot => `${reviewPrefix}independent-${angle}-${slot}`))
        .some((key, index) => reports[index].key !== key))
    throw fail("invalid completed review");
  const findingIds = reports.flatMap(report => report.body.findings.map((_, index) =>
    `${report.key.slice(`${reviewPrefix}independent-`.length)}-${index + 1}`));
  const { schema, validate } = reviewSynthesisContract("execute");
  if (!reviewAnalysisConforms(synthesis.body, schema)) throw fail("invalid synthesis shape");
  try { validate(synthesis.body, findingIds); } catch (error) { throw fail(error.message); }
  const accessGate = `${reviewPrefix}synthesis`;
  const accessRequest = { missionPath: association.missionPath, namespace, gate: accessGate };
  let access = checkReceipt(accessRequest, root);
  if (access.status === "missing") {
    // This gate must already have published its receipt; confirm the missing
    // key even if the entire access scope is empty. The writer owns quarantine.
    const writer = new PitakoStore(root, undefined, { root: store.root, storeId });
    verifyExecuteStoreForWrite(root, writer, { scope, head: prefix.head, requiredRecord: {
      scope: `access:${namespace}`, opKey: accessReceiptKey(association.missionPath, accessGate),
    } });
    access = checkReceipt(accessRequest, root);
    if (access.status === "missing")
      throw new StoreError("store-busy", "Review access receipt changed during the writer recheck.");
  }
  if (access.code === "store-corrupt" || access.code === "missing-record") {
    const item = access.items?.find(item => item.code === access.code);
    // Reconfirm under the writer lock, fenced to this cursor's store and scope.
    const writer = new PitakoStore(root, undefined, { root: store.root, storeId });
    if (item) writer.verifyRecordForWrite(item.store, item.expectedDigest.toLowerCase(), scope);
    else verifyExecuteStoreForWrite(root, writer, { scope, head: prefix.head });
    throw new StoreError(access.code, "Review access receipt store is unavailable.");
  } else if (access.code) {
    throw new StoreError(access.code, "Review access receipt store is unavailable.");
  }
  if (access.status !== "verified" || access.items.length !== reports.length ||
      reports.some((report, index) => access.items[index].id !== report.id ||
        access.items[index].path !== report.path))
    throw fail("review access receipt differs from its originals");
  const compact = originals.map(({ body, ...ref }) => ref);
  const candidate = { head, fingerprint };
  const expected = prefix.P.control.ledger;
  let reason = "";
  for (const point of screening.reason.toWellFormed()) {
    const next = reason + point;
    if (next.length > 360 || Buffer.byteLength(JSON.stringify(next)) > 1082) break;
    reason = next;
  }
  // Canonical on both paths: the root consumes the committed seed, never a
  // separate root-built body whose field ordering or observations can drift.
  const archiveSeed = {
    input: refs.input, expected, digests,
    complianceKey: `${base}.compliance`, complianceTimeoutMs: refs.reviewerMs,
    ...(expected.count === 0 ? { spec: { path: association.source, sha256: association.digest } } : {}),
    body: { number: loop, cursor: 0, manifest: [], plan: {
      ...execution.plan, stage: "admitted", association: { ...association, loop },
    }, attempt: null, results: [], kind: "final", startedAt,
    acceptance: applied.acceptance, acceptanceHistory: applied.acceptanceHistory,
    finalAttempt: { key: `${base}.acceptance`, number: 1, gate: {
      key: gateKey, stage: "receipt", receipt, record: gateRef,
    } },
    recoveries: execution.recoveries ?? [], analysisCalls: calls,
    review: { status: "completed", phase: "synthesis", verdict: screening.verdict,
      reason,
      unresolved: screening.assessments.filter(item => item.material), nativeFailure: null, references },
    integratedReview: { version: 3, namespace: reviewPrefix, query: JSON.stringify(candidate), revision: 1,
      decision: { reference: { stateKey: base.slice(0, -`.l${loop}`.length), loop } },
      models: Object.fromEntries(["r1", "r2", "synthesis"].map(slot => [slot, admission.models[slot]])), phase: "synthesis",
      receipts: [{ gate: accessGate, digest: access.receipt.digest, accessible: true }], originals: compact },
    candidate, usage: [...execution.usage, ...reviewUsage],
    ...(generation > 1 ? { analysisGenerations: { "final-review": generation } } : {}),
    ...(applied.cancelledScope?.length ? { cancelledScope: applied.cancelledScope } : {}) },
  };
  const response = (saved, seed) => ({ head: saved.head, storeId, selectionReference,
    checkout: { head: actual.head, fingerprint: actual.fingerprint },
    P: { ...saved.P, prompt: { ...saved.P.prompt, closingSeed: seed } } });
  if (prior) {
    if (canonicalDigest(prior.body.archiveSeed) !== canonicalDigest(archiveSeed))
      throw fail("committed archive differs from its sources");
    return response(store.read(scope, { seq: prior.seq, hash: prior.digest }), prior.body.archiveSeed);
  }
  if (Buffer.byteLength(JSON.stringify(response(prefix, archiveSeed))) > 61440)
    throw fail("archive projection exceeds 61440 bytes");
  const saved = commitExecute(root, invocation, opKey, requestDigest, "review-originals", { archiveSeed, originals });
  return response(saved, saved.result.archiveSeed);
}

export function recordBaselineInput(input) {
  if (!input.continuation) return;
  const { root, invocation } = input.intent.association;
  const request = { ...input, root, invocation, key: `${input.intent.key}.baseline` };
  commitExecute(root, invocation, `operation:${request.key}`, canonicalDigest({ operation: "baseline", ...request }),
    "operation", { operation: "baseline", request });
}

export function commitStoredGate(input, receipt) {
  const { root, invocation, key } = input;
  const requestDigest = canonicalDigest({ operation: "gate", ...input });
  commitExecute(root, invocation, `operation:${key}`, requestDigest, "operation",
    { operation: "gate", request: input });
  const original = readWorkerOriginal(input);
  const saved = commitExecute(root, invocation, `worker-gate:${key}`, requestDigest, "marker",
    { result: receipt, workerOriginal: original });
  return { ...receipt, head: saved.head, P: saved.P, storeId: saved.identity.storeId };
}

// Evidence selection only; the workflow independently validates and admits the seal.
export function closeSealKind(workerStatus, definitions, receipt) {
  return workerStatus === "complete" && !receipt.mutated &&
    receipt.gates.length === definitions.length &&
    definitions.every(command => receipt.gates.some(result => result.id === command.id && result.status === "pass"))
    ? "unit" : "pause";
}

export function resolveStoredGroupedInput(operation, input) {
  if (input.refs !== undefined) {
    const allowed = ["root", "invocation", "key", "storeId", "scope", "expectedHead", "refs"];
    if (Object.keys(input).some(key => !allowed.includes(key)) ||
        !input.refs || !["input", "closing,input", "input,reviewRecovery", "committed,input", "committed,gateFloorMs,input", "input,intent,worker",
          ...(operation === "advance" ? ["analyses,input", "cancellationDrain,input", "input,retryDirector"] : []),
          ...(operation === "gate" ? ["analyses,committed,gateFloorMs,input"] : []),
          ...(operation === "drain" ? ["drain,input"] : []),
          ...(operation === "selection" ? ["input,uncertainWorker", "input,uncertainWorker,worker", "cancellationDrain,committed,input", "backlogDigest,consumedLoops,director,input,loop,reviewerMs",
            "backlogDigest,consumedLoops,director,input,loop,reviewerMs,spec",
            "backlogDigest,consumedLoops,director,input,inspector,loop,reviewerMs",
            "backlogDigest,consumedLoops,director,input,inspector,loop,reviewerMs,spec"] : []),
          "gateFloorMs,input,intent,request,worker", "gateFloorMs,input,intent,request,timeoutOriginal,worker",
          "committed,gateFloorMs,input,intent,request,worker"]
          .includes(Object.keys(input.refs).sort().join(",")) ||
        Object.keys(input.refs).length > 3 && !["close", "gate", "selection"].includes(operation) ||
        !input.expectedHead || !input.refs.input ||
        Object.keys(input.refs.input).sort().join(",") !== "digest,seq")
      throw new Error("Invalid loop-io stored operation request");
    const { store, scope } = executeStore(input.root, input.invocation);
    if (input.scope !== scope) throw new Error("loop-io stored operation scope mismatch");
    const cursorPrefix = store.read(scope, input.expectedHead);
    let prefix = cursorPrefix;
    if (prefix.identity.storeId !== input.storeId) throw new Error("loop-io stored operation store mismatch");
    const ref = input.refs.input;
    let row = prefix.records.find(row => row.seq === ref.seq && row.digest === ref.digest);
    function committedRestoration(source, worker) {
      const nextKey = source.key.replace(/\.a\d+$/, `.a${source.attempt + 1}`);
      if (nextKey === source.key) return;
      const records = store.readRecords(scope).records;
      const operation = records.find(candidate => candidate.seq > row.seq && candidate.opKey === `operation:${nextKey}.baseline`);
      const request = operation?.body.request;
      const restore = request?.continuation?.attempt?.restore;
      if (!restore) return;
      const intent = records.find(candidate => candidate.seq > operation.seq &&
        candidate.kind === "intent" && candidate.body.key === nextKey);
      if (!intent) return;
      if (operation.kind !== "operation" || operation.body.operation !== "baseline" ||
          request.root !== input.root || request.invocation !== input.invocation ||
          request.key !== `${nextKey}.baseline` ||
          canonicalDigest({ operation: "baseline", ...request }) !== operation.requestDigest ||
          canonicalDigest({ ...request.intent, baseline: intent.body.baseline }) !== canonicalDigest(intent.body) ||
          intent.body.taskId !== source.taskId || intent.body.loop !== source.loop ||
          intent.body.cursor !== source.cursor || intent.body.attempt !== source.attempt + 1 ||
          canonicalDigest(intent.body.association) !== canonicalDigest(source.association) ||
          restore.producer?.key !== source.key || (restore.producer.runId ?? null) !== (worker.runId ?? null) ||
          canonicalDigest(request.continuation.taskFrame?.intents?.[source.key]) !== canonicalDigest(source))
        throw new Error("Committed restoration baseline differs from its source attempt.");
      const saved = store.read(scope, { seq: intent.seq, hash: intent.digest });
      return { replay: { candidate: intent.body.baseline, intent: { seq: intent.seq, digest: intent.digest },
        head: saved.head, P: saved.P, storeId: saved.identity.storeId, replayOperation: "baseline" } };
    }
    if (operation === "gate" && input.refs.committed === true &&
        /\.acceptance\.gate(?:\.r[123])?$/.test(input.key) &&
        Number.isSafeInteger(input.refs.gateFloorMs) && input.refs.gateFloorMs >= 0)
      return replayFinalGate(input, store, scope, prefix);
    if (input.refs.analyses && operation !== "advance")
      throw new Error("Early analysis replay requires the committed final gate or advance.");
    if (operation === "selection" && input.refs.director) {
      try { return directorSelectionInput(input, prefix, store, scope); }
      catch (error) {
        if (error instanceof StoreError || error.message.startsWith("Director selection integrity failure:")) throw error;
        throw new Error(`Director selection integrity failure: ${error.code === "ENOENT" ? "native original missing" : error.message}.`);
      }
    }
    if (operation === "selection" && input.refs.committed === true) {
      if (input.refs.cancellationDrain && row?.body?.request?.key === `${input.key}.d1`)
        input = { ...input, key: row.body.request.key };
      const selection = prefix.records.find(candidate => candidate.kind === "receipt" && candidate.body.key === input.key);
      const base = committedSelectionReceipt(input, prefix, row, selection);
      if (!row.body.request.baseline) return base;
      const taskId = row.body.request.baseline.taskId;
      const loopKey = input.key.replace(/\.selectionIO(?:\.d1)?$/, "");
      const drainNumber = key => key?.startsWith(`${loopKey}.cancellationDrain`) &&
        /^[1-9]\d*$/.test(key.slice(`${loopKey}.cancellationDrain`.length))
        ? Number(key.slice(`${loopKey}.cancellationDrain`.length)) : null;
      const pending = input.refs.cancellationDrain;
      if (pending !== undefined && !drainNumber(pending)) throw new Error("Invalid selection cancellation reference.");
      const records = pending ? store.readRecords(scope).records : prefix.records;
      const drain = records.findLast(candidate => candidate.seq > selection.seq &&
        candidate.kind === "receipt" && (pending ? candidate.body.key === pending : drainNumber(candidate.body.key)));
      if (!drain) return base;
      const [step, ...extra] = drain.body.result.steps;
      const number = drainNumber(drain.body.key);
      const apply = step?.result;
      const cancel = apply?.cancelledScope?.find(task => task.id === taskId && !task.completed)?.cancel;
      if (!cancel || extra.length || step.operation !== "apply" || step.key !== `${loopKey}.cancel-${number}`)
        throw new Error("Selection cancellation differs from its committed application.");
      const saved = store.read(scope, { seq: drain.seq, hash: drain.digest });
      return { replay: { ...base.replay, head: saved.head, P: saved.P, selectionCancellation: {
        number, cancelledScope: apply.cancelledScope, backlogDigest: apply.digest,
        receipt: { path: path.join(ledgerPath(input.root, input.invocation), "loop-io", "receipts",
          sha256(drain.body.key), "000000.json"), digest: sha256(canonicalJSON(drain.body)) },
      } } };
    }
    if (operation === "selection" && input.refs.uncertainWorker) {
      // A manifest is a reason not to redispatch, not a certificate of
      // settlement or restore authority. The worker validates it before effects.
      const ref = input.refs.uncertainWorker;
      if (Object.keys(ref).sort().join(",") !== "digest,seq")
        throw new Error("Invalid uncertain worker intent reference.");
      const intent = prefix.records.find(candidate => candidate.kind === "intent" &&
        candidate.seq === ref.seq && candidate.digest === ref.digest)?.body;
      const baseline = row?.body.request?.baseline;
      if (!intent || canonicalDigest({ ...baseline, baseline: intent.baseline }) !== canonicalDigest(intent))
        throw new Error("Uncertain worker replay differs from its committed selection intent.");
      const restoration = committedRestoration(intent, input.refs.worker ?? {});
      if (restoration) return restoration;
      const key = row.body.request.key;
      const receipt = prefix.records.find(candidate => candidate.kind === "receipt" && candidate.body.key === key);
      const result = committedSelectionReceipt({ ...input, key }, prefix, row, receipt);
      const file = path.join(input.root, ".pi/subagents/checkpoints", intent.key, "manifest.json");
      let checkpointCaptured = false;
      try {
        if (!lstatSync(safePath(file)).isFile()) throw new Error("Invalid retained worker checkpoint manifest.");
        checkpointCaptured = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return { replay: { ...result.replay, checkpointCaptured } };
    }
    if (operation === "drain") {
      const key = stepKey(input.key);
      const recorded = row?.kind === "marker" && row.opKey === `final-drain:${key}`;
      if ((!recorded && row?.kind !== "operation") || !finalDrainKey.test(key) || !key.startsWith(`invoke-${input.invocation}.`))
        throw new Error("Final drain replay input mismatch");
      const tip = store.read(scope);
      const admission = prefix.records.find(row => row.kind === "root-admission")?.body;
      if (!admission) throw new Error("Final drain lacks its root admission.");
      const receipt = tip.records.find(candidate => candidate.seq > row.seq &&
        candidate.kind === "receipt" && candidate.body.key === key);
      let drain = recorded ? row : tip.records.find(candidate => candidate.seq > row.seq &&
        candidate.opKey === `final-drain:${key}`);
      const request = drain?.body.request ?? nativeFinalDrain(admission, input);
      if (!request || request.finalDrain !== true && !pauseDrain(request) || request.key !== key ||
          request.root !== input.root || request.invocation !== input.invocation ||
          request.storeId !== input.storeId ||
          !tip.records.some(candidate => candidate.seq === request.expectedHead?.seq &&
            candidate.digest === request.expectedHead.hash && (recorded || candidate.seq >= row.seq) &&
            (drain ? candidate.seq < drain.seq : candidate.seq <= input.expectedHead.seq)) ||
          drain && canonicalDigest(request) !== drain.requestDigest ||
          input.refs.drain && canonicalDigest({ operation, ...request }) !== input.refs.drain.digest)
        throw new Error("Final drain lacks its exact stored intention.");
      const loop = Number(key.match(finalDrainKey)?.[1]);
      const pause = pauseDrain(request);
      if (pause && (row?.kind !== "operation" || row.body.operation !== "close" ||
          canonicalDigest({ operation: "close", ...row.body.request }) !== row.requestDigest ||
          row.body.request.gate.loop !== loop || row.body.request.gate.workerStatus !== "blocked" ||
          !prefix.records.some(candidate => candidate.kind === "receipt" && candidate.seq > row.seq &&
            candidate.body.key === row.body.request.key && candidate.body.requestDigest === row.requestDigest) ||
          !request.intentions.some(entry => entry.operation === "ledger" && entry.input.record.kind === "unit" &&
            entry.input.record.body.result?.status === "blocked" && entry.input.record.loop === loop &&
            entry.input.record.body.attempt === row.body.request.gate.attempt &&
            entry.input.record.body.taskId === row.body.request.gate.task.id)))
        throw new Error("Pause drain differs from its committed close.");
      if (!drain) {
        if (receipt) throw new Error("Final drain receipt has no intention marker.");
        recordFinalDrainInput(request);
        drain = store.read(scope).records.at(-1);
        if (drain?.opKey !== `final-drain:${key}`) throw new Error("Final drain intention was not committed.");
      }
      if (!receipt) return request;
      if (receipt.body.requestDigest !== canonicalDigest(request.intentions))
        throw new Error("Final drain receipt differs from its stored intention.");
      if (pause) {
        prefix = store.read(scope, { seq: receipt.seq, hash: receipt.digest });
        return committedReplay(row);
      }
      const archivesLoop = request.intentions.some(entry =>
        entry.operation === "ledger" && entry.input.record.kind === "loop" && entry.input.record.loop === loop);
      const archived = tip.records.findLast(candidate => candidate.kind === "ledger" &&
        candidate.seq < receipt.seq && (archivesLoop ? candidate.seq > drain.seq : candidate.seq < drain.seq) &&
        candidate.body.entries.some(entry => entry.kind === "loop" && entry.loop === loop));
      if (!archived)
        throw new Error("Final drain has no committed loop receipt.");
      const entry = archived.body.entries.find(entry => entry.kind === "loop" && entry.loop === loop);
      const head = { seq: receipt.seq, hash: receipt.digest }, saved = store.read(scope, head);
      const summaries = summarizeLoops(saved.records.filter(row => row.kind === "ledger").flatMap(row => row.body.entries));
      return { replay: { replayedDrain: { key, loop, outcome: summaries.at(-1)?.status,
        summaries,
        work: (entry.body.results ?? []).slice(-8).map(({ taskId, attempt, status }) => ({ taskId, attempt, status })),
        backlogDigest: receipt.body.result.steps.findLast(step => step.operation === "apply")?.result.digest,
        associationDigest: canonicalDigest(admission.association),
        admissionBinding: admission.admissionBinding },
      head, storeId: saved.identity.storeId } };
    }
    if (input.refs.closing) {
      const closing = input.refs.closing;
      const tip = store.readRecords(scope);
      const published = tip.records.find(candidate => candidate.kind === "ledger" &&
        candidate.body.entries.some(entry => entry.kind === "loop" && entry.loop === closing.loop));
      const body = published?.body.entries.find(entry => entry.kind === "loop" && entry.loop === closing.loop)?.body;
      const original = body?.compliance?.original;
      const synthesis = !body?.compliance && body?.review?.verdict === "material-gaps" &&
        closing.key?.endsWith(".director-synthesis") &&
        body.review.references.some(ref => ref.key === closing.key && ref.runId === closing.runId);
      if (operation !== "advance" || !row || !body?.observation || body.kind !== "final" ||
          body.number !== closing.loop || (synthesis
            ? !body.integratedReview?.originals.some(ref => ref.key === closing.key && ref.runId === closing.runId)
            : original?.key !== closing.key || original.runId !== closing.runId ||
              body.compliance.ref.key !== closing.key || body.compliance.ref.runId !== closing.runId))
        throw new StoreError("store-corrupt", "Closing publication integrity mismatch");
      try {
        const admission = tip.records.find(candidate => candidate.kind === "root-admission")?.body;
        if (!admission) throw new Error("missing admission");
        // Synthesis is already bound to its exact key, run, path and bytes by the review archive seed.
        if (!synthesis) {
          const verified = readNativeOriginal(input.root, { association: admission.association }, original, "pitako.reviewer");
          if (verified.reference.path !== original.path || canonicalDigest(verified.value) !== original.digest)
            throw new Error("compliance producer/path/digest mismatch");
        }
        for (const review of body.integratedReview?.originals ?? []) {
          const retained = tip.records.some(candidate => candidate.kind === "review-originals" &&
            (!synthesis || canonicalDigest(candidate.body.archiveSeed?.input ?? null) === canonicalDigest(input.refs.input)) &&
            candidate.body.originals.some(original => original.key === review.key &&
              original.runId === review.runId && original.path === review.path && original.sha256 === review.sha256));
          if (!retained) throw new Error(`review producer/path/digest mismatch: ${review.key}`);
          readReviewOriginal(review);
        }
      } catch (error) {
        throw new StoreError("store-corrupt", `Closing original integrity mismatch: ${error.message}`);
      }
      // Closing has no remaining effects; finish's empty drain is the normal final commit.
      const epoch = synthesis ? executeEpoch(input.invocation, input.key) : 0;
      const finishKey = `${synthesis ? `invoke-${input.invocation}${epoch ? `.e${epoch}` : ""}.l${closing.loop}`
        : closing.key.replace(/\.compliance$/, "")}.finishDrain.drain`;
      const result = { invocation: input.invocation, steps: [] };
      const finished = publishResult(path.join(ledgerPath(input.root, input.invocation), "loop-io", "receipts",
        sha256(finishKey)), { key: finishKey, requestDigest: canonicalDigest([]),
        resultDigest: canonicalDigest(result), result });
      const head = finished.head, saved = store.read(scope, head);
      const entries = saved.records.filter(row => row.kind === "ledger").flatMap(row => row.body.entries);
      const ledger = { count: entries.length, head: sha256(canonicalJSON(entries.at(-1))) };
      return { replay: { head, storeId: saved.identity.storeId,
        P: { ...saved.P, control: { ...saved.P.control, ledger },
          prompt: { ...saved.P.prompt,
          admission: saved.records.find(row => row.kind === "root-admission")?.body,
          closing: { body, summaries: loopSummaries(input.root, input.invocation, ledger) } } } } };
    }
    if (input.refs.reviewRecovery) {
      const request = row?.body.request;
      const reviews = input.refs.reviewRecovery;
      if (operation !== "gate" || row?.kind !== "operation" || row.body.operation !== "gate" ||
          request.root !== input.root || request.invocation !== input.invocation ||
          canonicalDigest({ operation: "gate", ...request }) !== row.requestDigest ||
          !Array.isArray(reviews) || reviews.length > 2 ||
          input.key !== `${request.checkpoint.key}.${reviews.length === 0 ? "review-context-recovery" :
            reviews.length === 1 ? "task-reviewer.review-recovery" : "task-synthesis.review-recovery"}` ||
          reviews.some((review, index) => Object.keys(review).sort().join(",") !== "key,runId" ||
            review.key !== `${request.checkpoint.key}.task-${index ? "synthesis" : "reviewer"}`))
        throw new StoreError("store-corrupt", "Task review recovery input integrity mismatch");
      const gate = prefix.records.find(candidate => candidate.opKey === `worker-gate:${request.key}`) ??
        prefix.records.findLast(candidate => candidate.kind === "marker" &&
          candidate.body.operation === "gate" && candidate.body.request?.key === request.key);
      const original = readWorkerOriginal(request);
      if (!gate || canonicalDigest(gate.body.workerOriginal) !== canonicalDigest(original))
        throw new StoreError("store-corrupt", "Task review recovery gate/worker integrity mismatch");
      const originals = reviews.map(review => {
        const original = readNativeOriginal(input.root, request.checkpoint, review, "pitako.reviewer");
        return { reference: { ...review, path: original.reference.path, digest: canonicalDigest(original.value) },
          body: original.value };
      });
      const execution = prefix.P.prompt.execution;
      const continuation = [execution?.continuation, execution?.foldedContinuation]
        .find(packet => packet?.attempt.key === request.checkpoint.key);
      const seal = originals.length === 2 ? observeTaskReviewSeal(request.checkpoint, true,
        continuation?.attempt.restore?.sourceKeys.map(key => {
          const source = prefix.records.findLast(row => row.kind === "intent" && row.body.key === key);
          if (!source) throw new StoreError("store-corrupt", "Task review recovery restoration source is absent");
          return source.body;
        })) : null;
      const records = store.readRecords(scope).records;
      const advance = records.find(candidate => candidate.kind === "operation" &&
        candidate.seq > row.seq && candidate.body.operation === "advance" &&
        candidate.body.request.key === request.checkpoint.key.replace(/\.t[1-9]\d*\.a[1-9]\d*$/, ".nextAdvance"));
      if (advance) {
        const receipt = records.find(candidate => candidate.kind === "receipt" &&
          candidate.body.key === advance.body.request.key);
        const unit = advance.body.request.intentions?.find(entry => entry.operation === "ledger" &&
          entry.input.record.kind === "unit" &&
          entry.input.record.body.checkpoint?.resultRef?.key === request.checkpoint.key)?.input.record.body;
        const admission = advance.body.admission && records.find(candidate =>
          candidate.seq === advance.body.admission.seq && candidate.digest === advance.body.admission.digest &&
          candidate.kind === "root-admission")?.body;
        if (!receipt || receipt.body.requestDigest !== advance.requestDigest ||
            canonicalDigest({ operation: "advance", ...advance.body.request,
              ...(admission ? { admission } : {}) }) !== advance.requestDigest ||
            advance.body.request.transition?.taskId !== request.checkpoint.taskId ||
            canonicalDigest(unit?.result.ref ?? null) !== canonicalDigest({
              key: original.reference.key, runId: original.reference.runId,
              path: original.reference.path, digest: original.reference.sha256,
            }) ||
            originals.some(({ reference }) => !Object.values(unit?.result.taskReview ?? {}).some(review =>
              review.key === reference.key && review.runId === reference.runId &&
              review.path === reference.path && review.digest === reference.digest)) ||
            seal && (unit.checkpoint.digest !== seal.digest || unit.checkpoint.checkpointRef !== seal.checkpointRef))
          throw new StoreError("store-corrupt", "Task review committed advance integrity mismatch");
        const head = { seq: receipt.seq, hash: receipt.digest }, saved = store.read(scope, head);
        return { replay: { committedAdvance: receiptTransport({
          path: path.join(ledgerPath(input.root, input.invocation), "loop-io", "receipts",
            sha256(advance.body.request.key), "000000.json"),
          digest: sha256(canonicalJSON(receipt.body)), head, P: saved.P,
          storeId: saved.identity.storeId, reconstruct: true,
        }) } };
      }
      const requestPages = store.readRecords(scope).records.filter(candidate => candidate.kind === "observation" &&
        candidate.body.observation?.input.seq === ref.seq && candidate.body.observation.input.digest === ref.digest);
      const requests = requestPages.at(-1);
      const requestPage = requests ? { ...requests.body.result,
        requests: requestPages.flatMap(page => page.body.result.requests) } : null;
      const context = prefix.records.findLast(candidate => candidate.kind === "task-review-context" &&
        candidate.body.key === request.checkpoint.key)?.body;
      if (!context) throw new StoreError("store-corrupt", "Missing task review context");
      const previousReceipt = prefix.records.findLast(candidate => candidate.kind === "receipt" &&
        ["selection", "close", "drain"].includes(candidate.body.result?.operation));
      const receiptReference = prefix.P.prompt.execution?.continuation?.receiptReference ??
        (previousReceipt ? { path: path.join(ledgerPath(input.root, input.invocation), "loop-io", "receipts",
          sha256(previousReceipt.body.key), "000000.json"), digest: sha256(canonicalJSON(previousReceipt.body)) } : null);
      const saved = commitExecute(input.root, input.invocation, `task-review-recovery:${input.key}`,
        canonicalDigest({ gate: ref, reviews }), "task-review-recovery",
        { gate: ref, originals, seal,
          baseline: records.find(candidate => candidate.kind === "intent" && candidate.seq > gate.seq &&
            candidate.body.key === request.checkpoint.key.replace(/\.a\d+$/, `.a${request.checkpoint.attempt + 1}`))
            ?.seq ?? null,
          drains: records.filter(candidate => candidate.kind === "receipt" && candidate.seq > gate.seq &&
            new RegExp(`^${request.checkpoint.key.split(".t")[0].replaceAll(".", "\\.")}\\.cancellationDrain\\d+$`).test(candidate.body.key))
            .map(candidate => candidate.seq),
          delta: context.delta, requestObservation: context.requestObservation,
          requests: requestPage, observation: requests?.body.observation ?? null, receiptReference });
      return { replay: { ...(gate.body.result.receipt ?? gate.body.result),
        head: saved.head, P: saved.P, storeId: saved.identity.storeId } };
    }
    function committedReplay(source) {
      if (operation !== "drain" && input.refs.committed !== true)
        throw new StoreError("store-corrupt", "Invalid committed close replay");
      const before = store.read(scope);
      const receipt = before.records.find(candidate => candidate.kind === "receipt" && candidate.body.key === source.body.request.key);
      if (!receipt || receipt.body.requestDigest !== source.requestDigest)
        throw new StoreError("store-corrupt", "Missing committed close receipt");
      const head = { seq: receipt.seq, hash: receipt.digest }, saved = store.read(scope, head);
      return { replay: { path: path.join(ledgerPath(input.root, input.invocation), "loop-io", "receipts",
        sha256(source.body.request.key), "000000.json"), digest: sha256(canonicalJSON(receipt.body)),
        storeId: saved.identity.storeId, head: operation === "drain" ? prefix.head : head,
        P: operation === "drain" ? prefix.P : saved.P, reconstruct: true } };
    }
    if (Object.keys(input.refs).join(",") === "input,intent,worker") {
      const intent = prefix.records.find(candidate => candidate.kind === "intent" &&
        candidate.seq === input.refs.intent?.seq && candidate.digest === input.refs.intent.digest);
      const request = row?.body.request;
      const checkpoint = intent?.body;
      const predecessorOperation = row?.body.operation;
      if (!request || row.kind !== "operation" || operation !== "close" ||
          !["close", "baseline"].includes(predecessorOperation) ||
          request.root !== input.root || request.invocation !== input.invocation ||
          canonicalDigest({ operation: predecessorOperation, ...request }) !== row.requestDigest ||
          checkpoint?.key !== input.refs.worker?.key ||
          (predecessorOperation === "baseline" ? request.intent?.key !== checkpoint.key :
            !Object.values(request.nextBaseline ?? {}).some(value => value.key === checkpoint.key)))
        throw new StoreError("store-corrupt", "Pending close predecessor integrity mismatch");
      const recoveredWorker = readWorkerOriginal({ root: input.root, checkpoint, worker: input.refs.worker });
      if (predecessorOperation === "baseline") return { replay: { candidate: checkpoint.baseline,
        intent: input.refs.intent, head: prefix.head, P: prefix.P, storeId: prefix.identity.storeId,
        replayOperation: "baseline", recoveredWorker } };
      const receipt = prefix.records.find(candidate => candidate.kind === "receipt" &&
        candidate.body.key === request.key);
      if (!receipt) throw new StoreError("store-corrupt", "Missing pending close predecessor receipt");
      const head = { seq: receipt.seq, hash: receipt.digest };
      const saved = store.read(scope, head);
      return { replay: { path: path.join(ledgerPath(input.root, input.invocation), "loop-io", "receipts",
        sha256(request.key), "000000.json"), digest: sha256(canonicalJSON(receipt.body)),
        storeId: saved.identity.storeId, head, P: saved.P, recoveredWorker, reconstruct: true } };
    }
    if (operation === "close" && input.refs.worker && row?.kind === "operation" &&
        ["selection", "close", "baseline", "gate"].includes(row.body.operation)) {
      const committed = store.readRecords(scope).records.find(candidate => candidate.kind === "operation" &&
        candidate.body.operation === "close" && candidate.body.request.key === input.key);
      if (committed) {
        const request = committed.body.request;
        const intent = prefix.records.find(candidate => candidate.seq === input.refs.intent?.seq &&
          candidate.digest === input.refs.intent.digest && candidate.kind === "intent");
        const admission = prefix.records.find(candidate => candidate.kind === "root-admission")?.body;
        const association = request.gate.checkpoint.association;
        if (!intent || canonicalDigest(request.gate.worker) !== canonicalDigest(input.refs.worker) ||
            request.root !== input.root || request.invocation !== input.invocation || !admission ||
            canonicalDigest(input.refs.request) !== canonicalDigest({
              associationDigest: canonicalDigest(association), admissionBinding: admission.admissionBinding,
              missionId: association.missionId, missionPath: association.missionPath,
              sourceRefs: association.sourceRefs ?? [], amendments: admission.amendments, specId: request.gate.specId,
            }) ||
            canonicalDigest(request.gate.checkpoint) !== canonicalDigest(intent.body) ||
            canonicalDigest({ operation, ...request }) !== committed.requestDigest)
          throw new Error("loop-io committed close replay integrity mismatch");
        return input.refs.committed ? committedReplay(committed) : request;
      }
      if (input.refs.committed) throw new StoreError("store-corrupt", "Missing committed close input");
    }
    if (operation === "close" && row?.kind === "operation") {
      const source = row.body.operation === "close" && row.body.request.key === input.key ? row
        : input.refs.committed && row.body.operation === "gate" &&
          row.body.request.checkpoint?.key + ".close" === input.key
          ? store.readRecords(scope).records.find(candidate => candidate.seq > row.seq &&
            candidate.kind === "operation" && candidate.body.operation === "close" &&
            candidate.body.request.key === input.key) : null;
      if (source && (source.body.request.root !== input.root || source.body.request.invocation !== input.invocation ||
          canonicalDigest({ operation, ...source.body.request }) !== source.requestDigest))
        throw new Error("loop-io stored close digest mismatch");
      if (source) return input.refs.committed ? committedReplay(source) : source.body.request;
    }
    if (input.refs.committed && operation === "close")
      throw new StoreError("store-corrupt", "Missing committed close input");
    const replayGate = (snapshot, request, withReviewContext = false) => {
      const gate = snapshot.records.find(candidate => candidate.opKey === `worker-gate:${request.key}`);
      const original = readWorkerOriginal(request);
      if (!gate || gate.kind !== "marker" ||
          gate.requestDigest !== canonicalDigest({ operation: "gate", ...request }) ||
          canonicalDigest(gate.body.workerOriginal) !== canonicalDigest(original))
        throw new StoreError("store-corrupt", "Committed gate original integrity mismatch");
      const context = withReviewContext && snapshot.records.find(candidate => candidate.seq > gate.seq &&
        candidate.kind === "task-review-context" && candidate.body.key === request.checkpoint.key);
      const receipt = storedGateProjection(store, scope, snapshot, request);
      if (context) {
        const saved = store.read(scope, { seq: context.seq, hash: context.digest });
        Object.assign(receipt, { head: saved.head, P: saved.P,
          reviewContext: { delta: context.body.delta, requestObservation: context.body.requestObservation } });
      }
      return { replay: receipt };
    };
    if (["close", "gate"].includes(operation) && input.refs.worker) {
      const { intent: intentRef, worker, gateFloorMs, request } = input.refs;
      const intentRow = prefix.records.find(row => row.seq === intentRef?.seq && row.digest === intentRef.digest);
      const checkpoint = intentRow?.kind === "intent" ? intentRow.body : null;
      const selected = prefix.P.prompt.selectedTask;
      const selectionRow = prefix.records.findLast(candidate => candidate.seq <= intentRow?.seq &&
        candidate.kind === "operation" && candidate.body.operation === "selection" &&
        candidate.body.request.baseline?.taskId === checkpoint?.taskId &&
        candidate.body.request.baseline?.loop === checkpoint?.loop);
      const selection = selectionRow?.body.request;
      const admission = prefix.records.find(row => row.kind === "root-admission")?.body;
      const recovery = operation === "close" && input.key === `${worker.key}.recover`;
      const gate = operation === "gate";
      const timeout = input.refs.timeoutOriginal;
      let gateKey = `${worker.key}.gate`;
      if (timeout) {
        if (!gate || Object.keys(timeout).sort().join(",") !== "digest,key,path,runId" ||
            !/^[a-f0-9]{64}$/.test(timeout.digest))
          throw new StoreError("store-corrupt", "Invalid gate timeout original reference");
        let original;
        try { original = readNativeSettlement(timeout.path, timeout.key, timeout.runId, "pitako.loop-io"); }
        catch (error) { throw new StoreError("store-corrupt", `Gate timeout original unavailable: ${error.message}`); }
        const generation = Number(timeout.key.match(/\.g([23])\.gate(?:\.r\d+)?$/)?.[1] ?? 1);
        const originalKey = `${worker.key}${generation > 1 ? `.g${generation}` : ""}.gate`;
        if (canonicalDigest(original) !== timeout.digest ||
            ![originalKey, `${originalKey}.r1`, `${originalKey}.r2`].includes(timeout.key) ||
            generation >= 3 || original.key !== timeout.key || original.runId !== timeout.runId ||
            ![original, ...(original.results ?? [])].some(entry =>
              entry.timedOut === true || entry.terminalOutcome?.reason === "timeout"))
          throw new StoreError("store-corrupt", "Gate timeout original integrity mismatch");
        gateKey = `${worker.key}.g${generation + 1}.gate`;
      }
      const precedingIntent = prefix.records.findLast(candidate => candidate.kind === "intent");
      const predecessor = row?.kind === "operation" && row.body.request;
      if (Object.keys(intentRef ?? {}).sort().join(",") !== "digest,seq" ||
          Object.keys(worker).sort().join(",") !== "key,runId" ||
          Object.keys(request ?? {}).sort().join(",") !== "admissionBinding,amendments,associationDigest,missionId,missionPath,sourceRefs,specId" ||
          !admission || canonicalDigest(admission.association) !== request.associationDigest ||
          admission.admissionBinding !== request.admissionBinding ||
          admission.association.missionId !== request.missionId || admission.association.missionPath !== request.missionPath ||
          canonicalDigest(admission.association.sourceRefs ?? []) !== canonicalDigest(request.sourceRefs) ||
          canonicalDigest(admission.amendments) !== canonicalDigest(request.amendments) ||
          canonicalDigest(checkpoint?.association) !== request.associationDigest ||
          !selection?.baseline || selection.root !== input.root || selection.invocation !== input.invocation ||
          selection.apply.specId !== request.specId ||
          canonicalDigest({ operation: "selection", ...selection }) !== selectionRow.requestDigest ||
          (recovery || gate ? precedingIntent?.digest !== intentRow.digest ||
            !predecessor || predecessor.root !== input.root || predecessor.invocation !== input.invocation ||
            !["selection", "close", "baseline", ...(gate && input.refs.timeoutOriginal ? ["gate"] : [])].includes(row.body.operation) ||
            canonicalDigest({ operation: row.body.operation, ...predecessor }) !== row.requestDigest ||
            (row.body.operation === "selection" ? predecessor.baseline?.key !== checkpoint.key :
              row.body.operation === "baseline" ? predecessor.intent?.key !== checkpoint.key :
                row.body.operation === "gate" ? canonicalDigest(predecessor.checkpoint) !== canonicalDigest(checkpoint) ||
                  canonicalDigest(predecessor.worker) !== canonicalDigest(worker) :
                !Object.values(predecessor.nextBaseline ?? {}).some(intent => intent.key === checkpoint.key))
            : row?.digest !== selectionRow.digest ||
              selection.baseline.key !== checkpoint?.key || checkpoint.attempt !== 1) ||
          checkpoint.taskId !== selected?.id || checkpoint.key !== worker.key ||
          typeof worker.runId !== "string" || !worker.runId ||
          !(gate ? input.key === gateKey : [`${worker.key}.close`, `${worker.key}.recover`].includes(input.key)) ||
          !Number.isSafeInteger(gateFloorMs) || gateFloorMs < 0 || gateFloorMs > 86400000)
        throw new Error("loop-io worker close lacks its committed selection and intent");
      if (recovery) {
        const restoration = committedRestoration(checkpoint, worker);
        if (restoration) return restoration;
        if (row.body.operation === "baseline") {
          const continuation = predecessor.continuation;
          if (continuation?.attempt.key !== checkpoint.key || !continuation.view || !continuation.requests)
            throw new Error("loop-io baseline recovery lacks its task continuation");
          return { root: input.root, invocation: input.invocation, key: input.key,
            recovery: { checkpoint, worker, predecessor: { steps: [
              { operation: "apply", result: { view: continuation.view } },
              { operation: "requests", result: continuation.requests },
            ] } } };
        }
        const predecessorReceipt = prefix.records.find(candidate => candidate.kind === "receipt" &&
          candidate.body.key === predecessor.key);
        if (!predecessorReceipt) throw new Error("loop-io worker recovery lacks its predecessor receipt");
        return { root: input.root, invocation: input.invocation, key: input.key,
          recovery: { checkpoint, worker, predecessor: predecessorReceipt.body.result } };
      }
      const { value, usage } = readWorkerOriginal({ root: input.root, worker, checkpoint });
      if (operation === "gate") {
        if (input.key !== gateKey || value.status !== "complete")
          throw new Error("loop-io worker gate requires a completed attempt");
        if (input.refs.committed) {
          const snapshot = store.read(scope);
          const committed = snapshot.records.find(candidate => candidate.seq > row.seq &&
            candidate.kind === "operation" && candidate.body.operation === "gate" &&
            candidate.body.request.key === gateKey);
          const request = committed?.body.request;
          if (!request || canonicalDigest(request.checkpoint) !== canonicalDigest(checkpoint) ||
              canonicalDigest(request.worker) !== canonicalDigest(worker) ||
              canonicalDigest({ operation: "gate", ...request }) !== committed.requestDigest)
            throw new Error("Committed gate input integrity mismatch");
          return replayGate(snapshot, request, true);
        }
        const progress = prefix.P.prompt.execution?.continuation?.metricSeries ??
          prefix.records.findLast(candidate => candidate.body.operation === "gate" &&
            candidate.body.request?.task.id === selected.id &&
            candidate.body.request.checkpoint?.loop === checkpoint.loop &&
            candidate.body.result?.receipt)?.body.result.receipt.progress ??
          selected.progress ?? { nonImproving: 0, last5: [] };
        return { root: input.root, specId: selection.apply.specId, invocation: input.invocation,
          loop: checkpoint.loop, attempt: checkpoint.attempt, key: input.key,
          requestObservation: prefix.P.control.requestObservation ?? 0,
          task: { id: selected.id,
            gates: selected.gates.map(gate => ({ ...gate, timeoutMs: Math.max(gate.timeoutMs ?? 1800000, gateFloorMs) })),
            metric: selected.metric ?? null, progress },
          workerStatus: value.status, writerSettled: true, checkpoint, worker };
      }
      const receiptRow = prefix.records.find(row => row.kind === "receipt" && row.body.key === selection.key);
      if (!receiptRow) throw new Error("loop-io worker close lacks its selection receipt");
      if (!["blocked", "continue"].includes(value.status))
        throw new Error("loop-io worker close requires an incomplete first attempt");
      const selectionPath = path.join(ledgerPath(input.root, input.invocation), "loop-io", "receipts",
        sha256(selection.key), "000000.json");
      const next = { ...checkpoint, key: checkpoint.key.replace(/\.a1$/, ".a2"), attempt: 2,
        progress: { ...checkpoint.progress, admitted: { ...checkpoint.progress.admitted,
          [selected.id]: [...new Set([...(checkpoint.progress.admitted[selected.id] ?? []), "continue"])] } } };
      const sealed = { ...next, progress: { ...next.progress, previous: null } };
      const seal = { v: 1, intent: checkpoint };
      return { root: input.root, invocation: input.invocation, key: input.key,
        requestObservation: prefix.P.control.requestObservation ?? 0,
        receipts: [{ path: selectionPath, digest: sha256(canonicalJSON(receiptRow.body)) }],
        requests: { cursor: 0 }, intentions: [],
        taskFrame: { taskId: selected.id, identities: [], evidence: [], operations: [], restorationKeys: [] },
        gate: { root: input.root, specId: selection.apply.specId, invocation: input.invocation,
          loop: checkpoint.loop, attempt: 1, key: `${worker.key}.gate`,
          task: { id: selected.id,
            gates: selected.gates.map(gate => ({ ...gate, timeoutMs: Math.max(gate.timeoutMs ?? 1800000, gateFloorMs) })),
            metric: selected.metric ?? null, progress: selected.progress ?? { nonImproving: 0, last5: [] } },
          workerStatus: value.status, writerSettled: true, checkpoint, worker },
        seal: { unit: seal, pause: seal }, nextBaseline: { sealed, observed: next },
        continuation: { attempt: { taskId: checkpoint.taskId, index: checkpoint.cursor, number: 1,
          key: checkpoint.key, checkpoint, intent: intentRef,
          baseline: checkpoint.baseline, launch: worker, bindingKey: worker.key,
          boardPostIds: receiptRow.body.result.steps.find(step => step.operation === "apply").result.view.posts.map(post => post.id) },
          taskState: { admitted: checkpoint.progress.admitted[selected.id] ?? [], completed: null, last: null },
          taskFrame: { taskId: selected.id, identities: [], evidence: [], operations: [], restorationKeys: [] },
          results: [], recoveries: [],
          usage: [...(selection.usage ?? []), { id: `${worker.runId}:0`,
            tokens: usage && ["input", "output", "cacheRead", "cacheWrite"].every(field =>
              Number.isFinite(usage[field]) && usage[field] >= 0)
              ? ["input", "output", "cacheRead", "cacheWrite"].reduce((total, field) => total + usage[field], 0) : null }],
          metricSeries: selected.progress ?? { nonImproving: 0, last5: [] },
          lastConfirmed: prefix.P.control.lastConfirmed ?? null } };
    }
    // A lost advance-head save leaves the preceding close ref in the cursor.
    // Resolve only the exact committed successor key, never a projection at the tip.
    if (operation === "advance" && row?.kind === "operation" && row.body.operation === "close" &&
        row.body.request.root === input.root && row.body.request.invocation === input.invocation) {
      const predecessor = /^(.*\.l([1-9]\d*))\.t[1-9]\d*\.a[1-9]\d*\.close$/.exec(row.body.request.key);
      if (!predecessor || input.key !== `${predecessor[1]}.nextAdvance`)
        throw new Error("loop-io stored transition predecessor mismatch");
      const committed = store.read(scope);
      const successor = committed.records.find(candidate => candidate.seq > input.expectedHead.seq &&
        candidate.kind === "operation" && candidate.opKey === `operation:${input.key}`);
      if (successor?.body.operation !== "advance" ||
          successor.body.request.prepare?.loop !== Number(predecessor[2]) + 1)
        throw new Error("loop-io stored transition has no committed advance");
      row = successor;
      prefix = committed;
    }
    // A launched cursor keeps the input reference, not a second operation key.
    if (row?.kind !== "operation" || row.body.operation !== operation ||
        row.body.request.root !== input.root || row.body.request.invocation !== input.invocation ||
        (input.key !== undefined && row.body.request.key !== stepKey(input.key).replace(/\.r\d+$/, "")))
      throw new Error("loop-io stored operation input integrity mismatch");
    const request = { ...row.body.request };
    if (row.body.admission) {
      const ref = row.body.admission;
      const admission = prefix.records.find(row => row.seq === ref.seq && row.digest === ref.digest);
      if (admission?.kind !== "root-admission") throw new Error("loop-io stored admission mismatch");
      request.admission = admission.body;
    }
    if (canonicalDigest({ operation, ...request }) !== row.requestDigest)
      throw new Error("loop-io stored operation digest mismatch");
    if (operation === "baseline") {
      const intent = prefix.records.findLast(candidate => candidate.kind === "intent" &&
        candidate.body.key === request.intent.key);
      if (!intent || canonicalDigest(intent.body) !==
          canonicalDigest({ ...request.intent, baseline: intent.body.baseline }))
        throw new StoreError("store-corrupt", "Committed baseline intent integrity mismatch");
      return { replay: { candidate: intent.body.baseline,
        intent: { seq: intent.seq, digest: intent.digest }, head: prefix.head,
        P: prefix.P, storeId: prefix.identity.storeId, replayOperation: "baseline" } };
    }
    if (operation === "gate") {
      return input.refs.committed ? replayGate(store.read(scope), request, true) : replayGate(prefix, request);
    }
    if (operation === "advance" && (request.transition || /\.g[23]\.demand-observation$/.test(input.refs.analyses?.[0]?.key))) {
      const cancellationKey = request.transition &&
        `${request.key.replace(/\.nextAdvance$/, ".cancellationDrain")}${request.transition.requestObservation + 1}`;
      if (input.refs.cancellationDrain !== undefined && input.refs.cancellationDrain !== cancellationKey)
        throw new Error("Cancellation drain differs from its committed advance");
      const committed = store.read(scope);
      const receipt = committed.records.find(candidate => candidate.kind === "receipt" &&
        candidate.body.key === request.key);
      if (receipt) {
        const drained = cancellationKey && committed.records.find(candidate => candidate.seq > receipt.seq &&
          candidate.kind === "receipt" && candidate.body.key === cancellationKey &&
          candidate.body.result.steps.some(step => step.operation === "apply"));
        const head = { seq: (drained ?? receipt).seq, hash: (drained ?? receipt).digest };
        const saved = store.read(scope, head);
        const retryDirector = input.refs.retryDirector &&
          retryDirectorContext(input, saved, store, scope, request, receipt, cursorPrefix);
        const demand = input.refs.analyses && replayAnalysisOriginals(input, saved, request.prepare.loop, "demand");
        const renewal = demand?.demandRenewal;
        if (renewal && (cursorPrefix.head.seq < head.seq ||
            canonicalDigest(cursorPrefix.P.control.operation) !== canonicalDigest(saved.P.control.operation)))
          throw new Error("Renewed demand replay differs from its committed advance.");
        const P = retryDirector || renewal ? cursorPrefix.P : saved.P;
        return { replay: {
          ...demand,
          ...(retryDirector ? { retryDirector } : {}),
          path: path.join(ledgerPath(input.root, input.invocation), "loop-io", "receipts", sha256(request.key), "000000.json"),
          digest: sha256(canonicalJSON(receipt.body)), head: retryDirector || renewal ? cursorPrefix.head : head, storeId: saved.identity.storeId,
          P: request.transition ? { ...P, prompt: { ...P.prompt, transition: { ...request.transition,
            drained: drained?.body.result.steps.find(step => step.operation === "apply").result ?? null,
            drainedReference: drained ? {
              path: path.join(ledgerPath(input.root, input.invocation), "loop-io", "receipts", sha256(drained.body.key), "000000.json"),
              digest: sha256(canonicalJSON(drained.body)),
            } : null } } } : P,
        } };
      }
    }
    if (input.refs.analyses) throw new Error("Early analysis lacks its committed advance.");
    if (input.refs.retryDirector) {
      const receipt = prefix.records.find(row => row.kind === "receipt" && row.body.key === request.key);
      if (!receipt) throw new Error("Director selection integrity failure: retry director lacks its exact advance.");
      const saved = store.read(scope, { seq: receipt.seq, hash: receipt.digest });
      const retryDirector = retryDirectorContext(input, saved, store, scope, request, receipt, cursorPrefix);
      return { replay: {
        path: path.join(ledgerPath(input.root, input.invocation), "loop-io", "receipts", sha256(request.key), "000000.json"),
        digest: sha256(canonicalJSON(receipt.body)), head: cursorPrefix.head, storeId: cursorPrefix.identity.storeId, P: cursorPrefix.P,
        retryDirector,
      } };
    }
    input = request;
  }
  return input;
}

// HUMAN #3209: recover the terminal native original, without running gates or seals.
export function recoverStoredWorker(input) {
  const { root, invocation, key, recovery } = input;
  const requestDigest = canonicalDigest(input);
  const { store, scope } = executeStore(root, invocation);
  const committed = store.readRecords(scope).records.find(row => row.opKey === `worker-original:${key}`);
  if (committed && committed.requestDigest !== requestDigest)
    throw new Error("loop-io worker recovery replay differs");
  // A lost cursor save must replay the committed original, not depend on native
  // artifacts still being available after the recovery read settled.
  const original = committed?.body.workerOriginal ?? readWorkerOriginal({ root, ...recovery });
  commitExecute(root, invocation, `worker-original:${key}`, requestDigest, "marker",
    { result: {}, workerOriginal: original, workerCheckpoint: recovery.checkpoint });
  const predecessor = recovery.predecessor;
  const view = predecessor.steps.find(step => step.operation === "gate")?.result.receipt.view ??
    predecessor.steps.find(step => step.operation === "apply")?.result.view;
  const requests = predecessor.steps.find(step => step.operation === "nextRequests")?.result ??
    predecessor.steps.find(step => step.operation === "requests")?.result;
  if (!view || !requests) throw new Error("Worker recovery lacks its committed predecessor receipt");
  const result = { invocation, operation: "close", view,
    steps: [{ key: `${key}.nextRequests`, operation: "nextRequests", result: requests }] };
  return { ...publishResult(path.join(ledgerPath(root, invocation), "loop-io", "receipts", sha256(key)),
    { key, requestDigest, resultDigest: canonicalDigest(result), result }), reconstruct: true };
}

// The receipt COMMIT owns the continuation; evidence stays in already committed rows.
export function closeContinuation(input, steps) {
  const baseline = steps.find(step => step.operation === "nextBaseline")?.result;
  if (!input.continuation) return null;
  const { store, scope } = executeStore(input.root, input.invocation);
  const rows = store.readRecords(scope).records;
  const operation = rows.find(row => row.kind === "operation" && row.body.request.key === input.key);
  const reference = name => {
    const step = steps.find(step => step.operation === name);
    const row = rows.find(row => row.body.key === step?.key && row.kind !== "receipt");
    if (!row) throw new StoreError("store-corrupt", `Missing close continuation ${name}`);
    return { seq: row.seq, digest: row.digest };
  };
  if (!operation) throw new StoreError("store-corrupt", "Missing close continuation input");
  const intent = baseline?.captured ? baseline.intent : input.continuation.attempt.intent;
  if (!intent) throw new StoreError("store-corrupt", "Missing close continuation intent");
  const ledgerRefs = (input.intentions ?? []).filter(intention =>
    intention.operation === "ledger" && intention.input.record.kind === "unit").map(intention => {
    const row = rows.find(row => row.kind === "ledger" && row.body.entries.some(entry =>
      entry.kind === "unit" && canonicalDigest(entry.body) === canonicalDigest(intention.input.record.body)));
    if (!row) throw new StoreError("store-corrupt", "Missing close continuation ledger admission");
    return { seq: row.seq, digest: row.digest };
  });
  return { attempt: intent, next: baseline?.captured === true,
    input: { seq: operation.seq, digest: operation.digest },
    gate: reference("gate"), seal: reference("seal"), ledgerRefs };
}

export async function grouped(operation, input, hooks = {}) {
  if (!["advance", "selection", "close"].includes(operation)) throw new Error("Expected advance, selection or close");
  if (input.root !== process.cwd()) throw new Error("loop-io root must be its actual cwd");
  const referenced = !!input.refs;
  const replayRequest = input.refs?.director ? input : null;
  input = resolveStoredGroupedInput(operation, input);
  if (input.replay) return input.replay;
  if (input.recovery) return recoverStoredWorker(input);
  const { root, invocation } = input;
  for (const reference of input.receipts ?? []) readReceipt(reference);
  const key = stepKey(input.key).replace(/\.r\d+$/, "");
  if (operation === "close" && input.gate?.writerSettled !== true)
    throw new Error("Close requires a settled worker and no active writer");
  let admissionReference;
  if (input.admission) {
    const saved = admitExecuteRoot(root, invocation, input.admission);
    input = { ...input, admission: saved.result };
    admissionReference = { seq: saved.head.seq, digest: saved.head.hash };
  }
  const directory = path.join(ledgerPath(root, invocation), "loop-io");
  const requestDigest = canonicalDigest({ operation, ...input, key });
  const receiptDirectory = path.join(directory, "receipts", sha256(key));
  const prior = readMarker(path.join(receiptDirectory, "000000.json"));
  if (prior && (prior.key !== key || prior.requestDigest !== requestDigest))
    throw new Error("loop-io grouped replay differs");
  // Keep the exact request before effects; a cursor's input ref must not depend on
  // a native stdout preview or an in-memory copy of the invocation.
  const { admission, ...request } = input;
  const operationSaved = commitExecute(root, invocation, `operation:${key}`, requestDigest, "operation",
    { operation, request: { ...request, key }, ...(admissionReference ? { admission: admissionReference } : {}) });
  const steps = [];
  async function step(name, request, execute, verify = () => {}) {
    const subkey = stepKey(`${key}.${name}`);
    const markerPath = path.join(directory, "steps", sha256(subkey), "000000.json");
    const digest = canonicalDigest(request);
    let marker = readMarker(markerPath);
    if (marker && (marker.key !== subkey || marker.requestDigest !== digest))
      throw new Error("loop-io grouped step replay differs");
    if (marker) await verify(marker.result);
    else {
      const result = await execute();
      await hooks.afterEffect?.(subkey);
      if (result.captured && request.intent) result.intent = committedIntent(request.intent, result.candidate);
      const context = ["prepare", "apply"].includes(name) ? taskContext(root, request.specId, result.selected) : null;
      const original = name === "gate" && request.worker ? readWorkerOriginal(request) : null;
      const attempt = original ? { taskId: request.task.id, number: request.attempt,
        checkpoint: { key: request.checkpoint.key, loop: request.checkpoint.loop, baseline: request.checkpoint.baseline ?? null },
        launch: request.worker, result: { status: request.workerStatus, revival: { opinion: original.value.continuation?.mode ?? "fresh" } },
        revival: request.revival ? { decision: request.revival.decision } : null,
        gate: { receipt: { after: result.receipt.after, progress: { nonImproving: result.receipt.progress?.nonImproving },
          stalled: result.receipt.stalled, contextPeak: result.contextPeak } },
        halt: null, restore: null } : null;
      publishResult(path.dirname(markerPath), { key: subkey, operation: name, request, context, attempt,
        ...(original ? { workerOriginal: original } : {}),
        requestDigest: digest, resultDigest: canonicalDigest(result), result });
      marker = readMarker(markerPath);
    }
    steps.push({ key: subkey, operation: name, result: marker.result });
    await hooks.afterStep?.(subkey);
    return marker.result;
  }
  const drainInput = { root, invocation, key: `${key}.drain`, intentions: input.intentions };
  const drainReference = async hooks => {
    const { P, ...reference } = await drain(drainInput, hooks);
    return reference;
  };
  // drain verifies its anchored publications on every replay, including a marker hit.
  await step("drain", drainInput, () => drainReference(hooks), async reference => {
    if (canonicalDigest(await drainReference()) !== canonicalDigest(reference))
      throw new Error("loop-io drain reference changed");
  });
  const bound = request => {
    if (!request || request.root !== undefined && request.root !== root ||
        request.invocation !== undefined && request.invocation !== invocation)
      throw new Error("loop-io grouped request identity mismatch");
    return { ...request, root, invocation };
  };
  if (operation === "advance") {
    const request = bound(input.prepare);
    await step("prepare", request, () => runOperation("prepare", request), receipt => {
      if (readBacklog(root, request.specId).digest !== receipt.digest)
        throw new Error("backlog-conflict: completed prepare changed");
    }).catch(error => {
      if (admissionReference && error.viewOverflow === true)
        error.overflowAdmission = { head: operationSaved.head, storeId: operationSaved.identity.storeId,
          associationDigest: canonicalDigest(admission.association), topicId: error.topicId, key };
      throw error;
    });
  }
  let selected;
  if (operation === "selection") {
    const request = bound(input.apply);
    try {
      selected = await step("apply", request, () => runOperation("apply", request),
        receipt => {
          if (readBacklog(root, request.specId).digest !== receipt.digest)
            throw new Error("backlog-conflict: completed selection changed");
        });
    } catch (error) {
      error.rejectedDrain = retainSelectionRejection(input, error);
      const rejected = replayRequest && replaySelectionRejection(replayRequest, input, error);
      if (rejected) return rejected;
      throw error;
    }
  }
  const requests = { invocation, cursor: input.requests?.cursor };
  let page = await step("requests", requests, () => observeRequests(requests));
  async function baseline(name, intent, eligible, reason, details = {}) {
    const cancelled = page.requests.some(request => request.taskId === intent?.taskId);
    const capture = eligible && !cancelled && page.next === null;
    await step(name, { intent, capture, reason, details }, () => capture
      ? { captured: true, ...captureBaseline({ intent }), ...details }
      : { captured: false, ...details, ...(details.variant !== undefined ? { variant: null } : {}),
        reason: cancelled ? "cancelled" : page.next !== null ? "requests-pending" : reason },
    saved => {
      if (saved.captured && canonicalDigest(captureBaseline({ intent })) !== canonicalDigest({ candidate: saved.candidate }))
        throw new Error("loop-io completed baseline changed");
    });
  }
  if (operation === "selection" && input.baseline)
    await baseline("baseline", input.baseline, selected.selected?.id === input.baseline.taskId, "not-selected");
  let contextPeak;
  if (operation === "close") {
    const request = bound(input.gate);
    const gateReceipt = await step("gate", request, async () => {
      const { contextPeak, ...receipt } = await runOperation("gate", request, true);
      return { receipt, contextPeak: contextPeak ?? null };
    }, saved => {
      if (canonicalDigest(readWorkerOriginal(request, false).reference) !== canonicalDigest(saved.receipt.workerOriginal))
        throw new Error("loop-io completed worker original changed");
      const current = checkoutEvidence(root);
      if (current.head !== saved.receipt.after.head || current.fingerprint !== saved.receipt.after.fingerprint)
        throw new Error("loop-io completed gate candidate changed");
    });
    contextPeak = gateReceipt.contextPeak;
    const gateStep = steps.at(-1);
    const kind = closeSealKind(request.workerStatus, request.task.gates, gateReceipt.receipt);
    const seal = input.seal?.[kind];
    if (!seal || seal.intent?.association?.root !== root || seal.intent.association.invocation !== invocation ||
        canonicalDigest(seal.intent) !== canonicalDigest(request.checkpoint))
      throw new Error("loop-io seal attempt mismatch");
    const sealRequest = { ...seal, kind };
    const gatePath = path.join(directory, "steps", sha256(gateStep.key), "000000.json");
    // Bind the seal to the committed gate marker, not a second published copy.
    const selection = { kind, workerStatus: request.workerStatus, mutated: gateReceipt.receipt.mutated,
      after: gateReceipt.receipt.after, gate: { path: gatePath, digest: sha256(canonicalJSON(readMarker(gatePath))) } };
    const sealed = await step("seal", { sealRequest, selection }, () => ({ ...selection, receipt: sealCheckpointRequest(sealRequest) }),
      saved => {
        if (canonicalDigest(sealCheckpointRequest(sealRequest)) !== canonicalDigest(saved.receipt))
          throw new Error("loop-io completed seal changed");
      });
    if (input.nextBaseline) {
      // Re-observe after long gates, at the old pre-continuation cancellation point.
      const earlier = page;
      page = await step("nextRequests", requests, () => observeRequests(requests));
      if (page.requests.length < earlier.requests.length ||
          canonicalDigest(page.requests.slice(0, earlier.requests.length)) !== canonicalDigest(earlier.requests))
        throw new Error(`loop-io request snapshot integrity conflict: earlier count ${earlier.requests.length}, later count ${page.requests.length}`);
      for (const intent of [input.nextBaseline.sealed, input.nextBaseline.observed]) {
        if (!intent || intent.taskId !== request.checkpoint.taskId || intent.attempt !== request.checkpoint.attempt + 1)
          throw new Error("loop-io next baseline attempt mismatch");
      }
      const outcome = sealed.receipt.outcome;
      const variant = kind === "pause" && request.workerStatus !== "blocked" && ["sealed", "observed"].includes(outcome) ? outcome : null;
      await baseline("nextBaseline", input.nextBaseline[variant ?? "sealed"], variant !== null,
        request.workerStatus === "blocked" ? "blocked" : kind === "unit" ? "unit" : outcome,
        { variant, sealOutcome: outcome });
    }
  }
  const result = { invocation, operation, steps, ...(operation === "close" ? { contextPeak } : {}) };
  return { ...publishResult(receiptDirectory, { key, requestDigest, resultDigest: canonicalDigest(result), result,
    ...(operation === "close" ? { continuation: closeContinuation({ ...input, key }, steps) } : {}) }),
    reconstruct: referenced };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { operation, ...input } = readRequest(readFileSync(0, "utf8"));
    if (input.root !== undefined && input.root !== process.cwd())
      throw new StoreError("wrong-cwd", "Execute cursor belongs to the wrong cwd.");
    input.root = process.cwd();
    const epoch = executeEpoch(input.invocation, input.key ?? input.intent?.key);
    if (input.scope !== undefined && input.scope !== executeScope(input.invocation, epoch))
      throw new Error("loop-io stored operation scope mismatch");
    const receipt = await withExecuteStore(input.root, input.invocation, () => operation === "drain" ? drain(input) :
      ["advance", "selection", "close"].includes(operation) ? grouped(operation, input) : runOperation(operation, input), epoch,
      input.storeId ? { storeId: input.storeId, expectedHead: input.expectedHead } : undefined);
    const output = JSON.stringify(["drain", "advance", "selection", "close"].includes(operation) ? receiptTransport(receipt) :
      operation === "gate" && Array.isArray(receipt.gates) && !receipt.finalGate ? taskGateWire(receipt) : receipt);
    if (Buffer.byteLength(output) > 61440) throw new Error("loop-io admission projection exceeds 61440 bytes");
    process.stdout.write(output + "\n");
  } catch (error) {
    const ledgerIntegrity = error?.ledgerIntegrity === true || isLedgerIntegrityError(error);
    // Read-side preflights never quarantine. This deterministic writer owns recovery
    // after its operation-local connection has settled.
    if (!error?.recovery && error?.code !== "ENOENT" && ledgerIntegrity) {
      try {
        verifyExecuteStoreForWrite(process.cwd());
      } catch (recovered) { error = recovered; }
    }
    process.stdout.write(JSON.stringify({ error: "loop-io", reason: error instanceof Error ? error.message : String(error),
      ...(error instanceof StoreError ? { code: error.code, ...(error.recovery ? { recovery: error.recovery } : {}) } : {}),
      selectionRejected: error?.selectionRejected === true, replayRejected: error?.replayRejected === true,
      ...(error?.rejectedDrain ? { rejectedDrain: error.rejectedDrain } : {}),
      viewOverflow: error?.viewOverflow === true,
      ...(error?.overflowAdmission ? { overflowAdmission: error.overflowAdmission } : {}), ledgerIntegrity }) + "\n");
    process.exitCode = 1;
  }
}
