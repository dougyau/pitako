import "./loader.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appendLedger, isLedgerIntegrityError, ledgerPath, loopSummaries, readRequest, verifyLedger } from "./ledger.mjs";
import { publish, safePath } from "../../extensions/hash-ledger.mjs";
import { canonicalDigest, canonicalJSON, sha256 } from "../../extensions/canonical.mjs";
import { observeRequests } from "./observe.mjs";
const { viewBudget } = await import("../../extensions/board/store.ts");
const { captureBaseline, checkpointTaskDelta, sealCheckpointRequest } = await import("../../extensions/execute-checkpoint.ts");
const { checkoutEvidence } = await import("../../extensions/spec-plans.ts");
const { prepare, apply, gate, currentHumanPostIds, readBacklog, reviewOriginals } = await import("./loop.ts");

function stepKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes(".."))
    throw new Error("Invalid loop-io step key");
  return value;
}

function readMarker(file) {
  let bytes;
  try { bytes = readFileSync(safePath(file), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const marker = JSON.parse(bytes);
  if (canonicalJSON(marker) !== bytes || marker.seq !== 0 || canonicalDigest(marker.result) !== marker.resultDigest)
    throw new Error("loop-io marker integrity mismatch");
  return marker;
}

function publishResult(directory, value) {
  safePath(directory, true);
  const marker = { seq: 0, ...value };
  const { head } = publish(directory, marker);
  return { path: path.join(directory, "000000.json"), digest: head };
}

function readReceipt(reference) {
  const bytes = readFileSync(safePath(reference.path), "utf8");
  if (sha256(bytes) !== reference.digest) throw new Error("loop-io receipt digest mismatch");
  const marker = readMarker(reference.path);
  if (!marker) throw new Error("Missing loop-io receipt");
  return marker.result;
}

// HUMAN #2391 (topic #197): the sandbox has no file API. Only validated,
// bounded admission projections cross stdout; complete evidence remains on disk.
export function receiptTransport(reference) {
  const projection = readReceipt(reference);
  const compact = JSON.parse(JSON.stringify(projection));
  for (const step of compact.steps) {
    if (step.operation === "drain") step.result = receiptTransport(step.result);
    if (step.operation === "apply" && (compact.operation !== "selection" || step.result.selected !== null))
      delete step.result.completedTasks;
    if (step.operation === "gate") {
      for (const gate of step.result.receipt.gates) gate.tail = "";
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
  const output = { ...reference, projection: compact };
  if (Buffer.byteLength(JSON.stringify(output)) > 61440) throw new Error("loop-io admission projection exceeds 61440 bytes");
  return output;
}

async function applyIntention(input) {
  const { backlog, replay, ...receipt } = apply({ ...input, currentHumanIds: await currentHumanPostIds(input) });
  return { ...receipt, acceptance: backlog.acceptance, acceptanceHistory: backlog.acceptanceHistory };
}

// Keys belong to intentions, not launches: a .rN retry must see the same markers.
// Ledger chain failures keep their human-only classification across the grouped transport.
function ledgerStep(run) {
  try { return run(); } catch (error) {
    if (isLedgerIntegrityError(error)) error.ledgerIntegrity = true;
    throw error;
  }
}
export async function drain(input, { afterEffect = () => {}, afterStep = () => {} } = {}) {
  const { root, invocation, intentions, key } = input;
  if (root !== process.cwd()) throw new Error("loop-io root must be its actual cwd");
  for (const reference of input.receipts ?? []) readReceipt(reference);
  stepKey(key);
  const directory = path.join(ledgerPath(root, invocation), "loop-io");
  if (!Array.isArray(intentions)) throw new Error("Expected pending loop-io intentions");
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
      publishResult(path.dirname(markerPath), { key: intention.key, requestDigest, resultDigest: canonicalDigest(result), result });
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
  const overflow = netChanged.slice(200);
  const reference = overflow.length ? publishResult(
    path.join(ledgerPath(root, invocation), "task-deltas", canonicalDigest(overflow)),
    { result: overflow, resultDigest: canonicalDigest(overflow) }) : null;
  return { touched, netChanged: netChanged.slice(0, 200), overflow: reference };
}

async function runOperation(operation, input) {
  const operations = { prepare, apply, gate, reviewOriginals, baseline: captureBaseline, taskDelta };
  if (!Object.hasOwn(operations, operation)) throw new Error("Expected loop-io prepare, apply, gate, reviewOriginals, baseline, taskDelta or drain");
  if (operation === "apply") input.currentHumanIds = await currentHumanPostIds(input);
  const value = await operations[operation](input);
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
  if (operation === "gate" && Buffer.byteLength(JSON.stringify(receipt)) > viewBudget(0)) throw Object.assign(new Error("Gate receipt exceeds 8 KiB"), { viewOverflow: true });
  return receipt;
}

// Evidence selection only; the workflow independently validates and admits the seal.
export function closeSealKind(workerStatus, definitions, receipt) {
  return workerStatus === "complete" && !receipt.mutated &&
    receipt.gates.length === definitions.length &&
    definitions.every(command => receipt.gates.some(result => result.id === command.id && result.status === "pass"))
    ? "unit" : "pause";
}

export async function grouped(operation, input, hooks = {}) {
  if (!["advance", "selection", "close"].includes(operation)) throw new Error("Expected advance, selection or close");
  const { root, invocation } = input;
  if (root !== process.cwd()) throw new Error("loop-io root must be its actual cwd");
  for (const reference of input.receipts ?? []) readReceipt(reference);
  const key = stepKey(input.key).replace(/\.r\d+$/, "");
  if (operation === "close" && input.gate?.writerSettled !== true)
    throw new Error("Close requires a settled worker and no active writer");
  const directory = path.join(ledgerPath(root, invocation), "loop-io");
  const requestDigest = canonicalDigest({ operation, ...input, key });
  const receiptDirectory = path.join(directory, "receipts", sha256(key));
  const prior = readMarker(path.join(receiptDirectory, "000000.json"));
  if (prior && (prior.key !== key || prior.requestDigest !== requestDigest))
    throw new Error("loop-io grouped replay differs");
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
      publishResult(path.dirname(markerPath), { key: subkey, requestDigest: digest, resultDigest: canonicalDigest(result), result });
      marker = readMarker(markerPath);
    }
    steps.push({ key: subkey, operation: name, result: marker.result });
    await hooks.afterStep?.(subkey);
    return marker.result;
  }
  const drainInput = { root, invocation, key: `${key}.drain`, intentions: input.intentions };
  // drain verifies its anchored publications on every replay, including a marker hit.
  await step("drain", drainInput, () => drain(drainInput, hooks), async reference => {
    if (canonicalDigest(await drain(drainInput)) !== canonicalDigest(reference))
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
    });
  }
  let selected;
  if (operation === "selection") {
    const request = bound(input.apply);
    selected = await step("apply", request, () => runOperation("apply", request),
      receipt => {
        if (readBacklog(root, request.specId).digest !== receipt.digest)
          throw new Error("backlog-conflict: completed selection changed");
      });
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
      const { contextPeak, ...receipt } = await runOperation("gate", request);
      return { receipt, contextPeak: contextPeak ?? null };
    }, saved => {
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
    const selection = { kind, workerStatus: request.workerStatus, mutated: gateReceipt.receipt.mutated,
      after: gateReceipt.receipt.after, gate: { path: gatePath, digest: sha256(readFileSync(safePath(gatePath))) } };
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
  return publishResult(receiptDirectory, { key, requestDigest, resultDigest: canonicalDigest(result), result });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { operation, ...input } = readRequest(readFileSync(0, "utf8"));
    if (input.root !== undefined && input.root !== process.cwd()) throw new Error("loop-io root must be its actual cwd");
    input.root = process.cwd();
    const receipt = operation === "drain" ? await drain(input) :
      ["advance", "selection", "close"].includes(operation) ? await grouped(operation, input) : await runOperation(operation, input);
    process.stdout.write(JSON.stringify(["drain", "advance", "selection", "close"].includes(operation) ? receiptTransport(receipt) : receipt) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: "loop-io", reason: error instanceof Error ? error.message : String(error), selectionRejected: error?.selectionRejected === true, replayRejected: error?.replayRejected === true, viewOverflow: error?.viewOverflow === true, ledgerIntegrity: error?.ledgerIntegrity === true }) + "\n");
    process.exitCode = 1;
  }
}
