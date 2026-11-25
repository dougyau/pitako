import "./loader.mjs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { canonicalDigest, canonicalJSON, sha256 as digest } from "../../extensions/canonical.mjs";
const { PitakoStore, StoreError } = await import("../../extensions/pitako-store.ts");

import { safePath, validateExpected, readRequest } from "../../extensions/hash-ledger.mjs";

export { canonicalJSON, readRequest };
const invocationStore = new AsyncLocalStorage();
export async function withExecuteStore(root, invocation, fn, epoch = invocationStore.getStore()?.epoch ?? 0, cursor) {
  const scope = executeScope(invocation, epoch ?? 0);
  if (epoch === null && (!Number.isSafeInteger(cursor?.expectedHead?.seq) ||
      cursor.expectedHead.seq < 1 || !isHash(cursor.expectedHead.hash)))
    throw new Error("Closing publication integrity: invalid input head");
  const existing = invocationStore.getStore();
  if (existing) {
    if (existing.root !== root || existing.invocation !== invocation || existing.epoch !== epoch)
      throw new Error("Execute store session identity mismatch.");
    return fn();
  }
  const store = new PitakoStore(root, executeProjection, cursor && { root, storeId: cursor.storeId });
  try {
    return await store.withSession(() => {
      // Check identity before the head: a replaced DB is not a damaged old epoch.
      if (epoch === null) {
        const prefix = scope.slice(0, -1);
        const { scope: bound } = verifyExecuteStoreForWrite(root, store, { scope, head: cursor.expectedHead,
          matchesScope: name => name.startsWith(prefix) && /^(0|[1-9]\d*)$/.test(name.slice(prefix.length)) });
        epoch = Number(bound.slice(prefix.length));
        executeScope(invocation, epoch);
      } else if (cursor) {
        verifyExecuteStoreForWrite(root, store, { scope, head: cursor.expectedHead });
      }
      return invocationStore.run({ root, invocation, epoch, store, ledgerDigests: new WeakMap() }, fn);
    });
  } catch (error) {
    if (error?.code === "store-replaced" && !error.recovery)
      error.recovery = verifyExecuteStoreForWrite(root);
    if (!error?.recovery && error?.code !== "ENOENT" && isLedgerIntegrityError(error))
      verifyExecuteStoreForWrite(root);
    throw error;
  }
}
const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === names;

export function ledgerPath(root, invocation) {
  if (!path.isAbsolute(root) || typeof invocation !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(invocation) || invocation.includes(".."))
    throw new Error("Invalid ledger root or invocation.");
  return safePath(path.join(root, ".pi/subagents/execute", invocation));
}

export function executeScope(invocation, epoch = invocationStore.getStore()?.epoch ?? 0) {
  ledgerPath(process.cwd(), invocation);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Invalid execute epoch.");
  return `exec:${invocation}.e${epoch}`;
}

/** Native child keys carry the epoch even when the operation has no store refs yet. */
export function executeEpoch(invocation, key) {
  ledgerPath(process.cwd(), invocation);
  const prefix = `invoke-${invocation}`;
  if (typeof key !== "string" || !key) throw new Error("Invalid execute child key.");
  if (!key.startsWith("invoke-")) return 0;
  if (!key.startsWith(prefix + "."))
    throw new Error("Execute child key differs from its invocation.");
  const suffix = key.slice(prefix.length);
  const match = /^\.e([1-9]\d*)\./.exec(suffix);
  if (suffix.startsWith(".e") && !match) throw new Error("Invalid execute epoch key.");
  const epoch = match ? Number(match[1]) : 0;
  executeScope(invocation, epoch);
  return epoch;
}

function ledgerRecords(rows) {
  return rows.filter(row => row.kind === "ledger").flatMap(row => row.body.entries);
}

function ledgerDigest(entry) {
  // Store entries are deeply frozen; reuse their canonical hash only within this invocation.
  const cache = invocationStore.getStore()?.ledgerDigests;
  if (!cache || !Object.isFrozen(entry)) return canonicalDigest(entry);
  if (!cache.has(entry)) cache.set(entry, canonicalDigest(entry));
  return cache.get(entry);
}

function projectionText(value, bytes = 128) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (Buffer.byteLength(JSON.stringify(text)) <= bytes) return text;
  const suffix = " [truncated]";
  let end = Math.min(text.length, bytes);
  while (Buffer.byteLength(JSON.stringify(text.slice(0, end) + suffix)) > bytes) end--;
  return text.slice(0, end) + suffix;
}

// Values drive decisions; the verified reference supplies omitted originals.
function projectionPage(values, bytes, ref) {
  const items = [];
  for (const value of values) {
    if (Buffer.byteLength(JSON.stringify([...items, value])) > bytes) break;
    items.push(value);
  }
  return { items, total: values.length, omitted: values.length - items.length, ref };
}

function projectionRows(rows) {
  // Receipt addresses are derived from operation keys, not from their large bodies.
  const receipts = new Map(), markers = new Map();
  const operationName = row => {
    const key = row.opKey.slice("operation:".length);
    if (/\.a[1-9]\d*\.(close|baseline|gate)$/.test(key)) return key.split(".").at(-1);
    if (/\.selectionIO(?:\.d1)*$/.test(key)) return "selection";
    if (/\.(?:advance|nextAdvance)(?:\.v[1-9]\d*)?$/.test(key)) return "advance";
    return row.body.operation;
  };
  const plan = rows.findLast(row => row.kind === "operation" && row.body.request.plan);
  const closed = rows.findLast(row => row.kind === "ledger" && row.body.entries.some(entry => entry.kind === "loop"));
  const baseline = rows.findLast(row => row.kind === "operation" && operationName(row) === "baseline");
  const intent = rows.findLast(row => row.kind === "intent");
  // Before the new intent commits, the full fold still exposes the prior selection.
  const selected = intent && plan && intent.seq > plan.seq;
  const latestOperation = rows.findLast(row => row.kind === "operation");
  const obsoleteClose = row => row.kind === "operation" &&
    /^operation:.*\.a[1-9]\d*\.close$/.test(row.opKey) && row.seq < (plan?.seq ?? 0) && row.seq < (closed?.seq ?? 0);
  for (const row of rows) {
    if (row.kind !== "operation") continue;
    const key = row.opKey.slice("operation:".length);
    const name = operationName(row);
    receipts.set(`loop-io:loop-io/receipts/${digest(key)}/000000.json`, name);
    if (!["advance", "selection", "close"].includes(name)) continue;
    receipts.set(`loop-io:loop-io/receipts/${digest(`${key}.drain`)}/000000.json`, "drain");
    const steps = name === "advance" ? ["drain", "requests", "prepare"] :
      name === "selection" ? ["drain", "requests", "apply", "baseline"] :
        ["drain", "requests", "nextRequests", "nextBaseline"];
    for (const step of steps)
      markers.set(`loop-io:loop-io/steps/${digest(`${key}.${step}`)}/000000.json`, step);
  }
  let close = false, selection = false, requests = false, context = false;
  return rows.toReversed().filter(row => {
    // These originals are resolved from sources, not folded into decision fields.
    if (row.kind === "review-originals" || row.kind === "admission" ||
        row.kind === "seal" && row.opKey.startsWith("seal:")) return false;
    // A later plan clears taskFrame.
    // Neither selection nor baseline continuation can be written by a close.
    if (obsoleteClose(row)) return false;
    if (selected && row.seq < plan.seq &&
        (row.kind === "intent" && row !== intent || row.kind === "task-review-recovery")) return false;
    if (row.kind === "operation") {
      const name = operationName(row);
      if (selected && ["selection", "baseline"].includes(name) && row.seq < plan.seq) return false;
      if (name === "baseline" && row.seq < (baseline?.seq ?? 0) && row.seq < (closed?.seq ?? 0))
        return false;
      if (["advance", "gate"].includes(name) && row.seq < latestOperation.seq) return false;
    }
    const step = row.kind === "marker" ? markers.get(row.opKey) : null;
    if (["drain", "baseline", "nextBaseline"].includes(step)) return false;
    if (step === "requests" || step === "nextRequests") {
      if (requests) return false;
      requests = true;
    }
    if (step === "prepare" || step === "apply") {
      if (context) return false;
      context = Boolean(row.body.context && (row.body.result?.view ?? row.body.result?.receipt?.view));
    }
    if (row.kind !== "receipt") return true;
    const operation = receipts.get(row.opKey);
    if (["advance", "drain", "gate", "baseline"].includes(operation)) return false;
    if (operation === "close") {
      if (close) return false;
      close = Boolean(row.body.continuation);
    }
    if (operation === "selection") {
      if (selection) return false;
      selection = Boolean(row.body.result?.steps?.find(step => step.operation === "apply")?.result.path);
    }
    return true;
  }).toReversed();
}

/** The projection is calculated only from the verified prefix supplied by PitakoStore. */
export function executeProjection(rows) {
  return foldExecuteProjection(projectionRows(rows), rows);
}

/** The same read-only gate replay is used by loop-io and timeout inspection. */
export function storedGateEvidence(records, request) {
  const gate = records.find(candidate => candidate.opKey === `worker-gate:${request.key}`);
  if (!gate || gate.kind !== "marker")
    throw new StoreError("store-corrupt", "Committed gate marker unavailable");
  const head = { seq: gate.seq, hash: gate.digest }, prefix = records.slice(0, gate.seq);
  const previousReceipt = prefix.findLast(candidate => candidate.kind === "receipt" &&
    ["selection", "close", "drain"].includes(candidate.body.result?.operation));
  const receiptReference = previousReceipt ? { path: path.join(ledgerPath(request.root, request.invocation), "loop-io", "receipts",
    digest(previousReceipt.body.key), "000000.json"), digest: digest(canonicalJSON(previousReceipt.body)) } : null;
  const predecessor = prefix.findLast(candidate => candidate.kind === "operation" &&
    (candidate.body.operation === "selection" ? candidate.body.request.baseline?.key === request.checkpoint.key :
      candidate.body.operation === "baseline" ? candidate.body.request.intent?.key === request.checkpoint.key :
      candidate.body.operation === "close" && Object.values(candidate.body.request.nextBaseline ?? {})
        .some(intent => intent.key === request.checkpoint.key)));
  const predecessorReceipt = prefix.find(candidate => candidate.kind === "receipt" &&
    candidate.body.key === predecessor?.body.request.key);
  const steps = predecessorReceipt?.body.result.steps;
  const view = predecessor?.body.operation === "baseline" ? predecessor.body.request.continuation?.view :
    predecessor?.body.operation === "selection" ? steps?.find(step => step.operation === "apply")?.result.view :
      steps?.find(step => step.operation === "gate")?.result.receipt.view;
  if (!predecessor || canonicalDigest({ operation: predecessor.body.operation, ...predecessor.body.request }) !==
      predecessor.requestDigest || !Array.isArray(view?.posts))
    throw new StoreError("store-corrupt", "Committed gate lacks its worker launch view");
  return { ...gate.body.result, head,
    receiptReference, gateTask: request.task, boardPostIds: view.posts.map(post => post.id) };
}

export function storedGateProjection(store, scope, prefix, request) {
  const gate = storedGateEvidence(prefix.records, request);
  const saved = store.read(scope, gate.head);
  return { ...gate, P: saved.P, storeId: saved.identity.storeId };
}
/** Full-fold oracle: keep independent selection evidence without a second reducer. */
export function fullExecuteProjection(rows) {
  return foldExecuteProjection(rows, rows);
}

function foldExecuteProjection(rows, sources) {
  const recovery = sources.findLast(row => row.kind === "task-review-recovery");
  const operation = sources.findLast(row => row.kind === "operation");
  if (recovery && recovery.seq > (operation?.seq ?? 0)) {
    const request = sources.find(source => source.seq === recovery.body.gate.seq &&
      source.digest === recovery.body.gate.digest)?.body.request;
    const gate = sources.find(row => row.opKey === `worker-gate:${request?.key}`) ??
      sources.findLast(row => row.kind === "marker" &&
        row.body.operation === "gate" && row.body.request?.key === request?.key);
    if (!gate) throw new StoreError("store-corrupt", "Missing task review recovery gate");
    const prefix = sources.filter(row => row.seq <= gate.seq);
    const P = foldExecuteProjection(rows === sources ? prefix : projectionRows(prefix), prefix);
    const baseline = sources.find(row => row.seq === recovery.body.baseline);
    P.prompt.execution.taskReviewRecovery = { ...recovery.body,
      baseline: baseline ? { checkpoint: baseline.body, intent: { seq: baseline.seq, digest: baseline.digest } } : null,
      drains: (recovery.body.drains ?? []).map(seq => {
        const row = sources.find(row => row.seq === seq && row.kind === "receipt");
        if (!row) throw new StoreError("store-corrupt", "Missing recovered cancellation receipt");
        return { key: row.body.key,
          path: path.join(ledgerPath(request.checkpoint.association.root, request.checkpoint.association.invocation),
          "loop-io", "receipts", digest(row.body.key), "000000.json"),
          digest: digest(canonicalJSON(row.body)), projection: row.body.result };
      }) };
    return P;
  }
  const ledger = ledgerRecords(rows);
  const control = { lastAttempt: null, selectedTask: null, intent: null,
    admission: null, operation: null, plan: null, taskFrame: null, finishDrain: null };
  const prompt = { selectedTask: null, admission: null };
  // Earlier advances are omitted from `rows` once a selection commits, but
  // the loop-open clock is still authoritatively bound to the verified prefix.
  const opensLoop = row => row.kind === "operation" &&
    ["advance", "selection"].includes(row.body.operation);
  const latest = sources.findLast(opensLoop);
  if (latest) {
    const loopNumber = row => row.body.request.prepare?.loop ?? row.body.request.apply?.loop;
    const number = loopNumber(latest);
    const advance = sources.find(row => opensLoop(row) &&
      row.body.operation === "advance" && loopNumber(row) === number);
    const startedAt = (advance ?? latest).body.request.loopStartedAt;
    const differs = sources.some(row => opensLoop(row) && loopNumber(row) === number &&
      row.body.request.loopStartedAt !== undefined && row.body.request.loopStartedAt !== startedAt);
    if (differs || startedAt !== undefined && (!Number.isSafeInteger(startedAt) || startedAt < 0))
      throw new StoreError("store-corrupt", "Conflicting committed loop-open time");
    if (startedAt !== undefined) prompt.loopOpen = { number, startedAt };
  }
  let admission = null, selection = null, selectionIntent = null, workerOriginal = null, workerCheckpoint = null;
  let continuation = null, foldedContinuation = null, backlogPath = null, taskReviewRecovery = null;
  let demand = null;
  let tasks = [];
  function selectTask(id, reference) {
    const selected = tasks.find(task => task.id === id) ?? null;
    prompt.selectedTask = selected;
    control.selectedTask = selected ? {
      id: selected.id, status: selected.status, dependsOn: selected.dependsOn,
      gates: selected.gates, metric: selected.metric, ref: reference,
    } : null;
  }
  const summaries = summarizeLoops(ledger);
  const P = { lastAttempt: null, loopSummaries: summaries.map(summary => ({
    ...summary, gaps: projectionText(summary.gaps), review: projectionText(summary.review),
    compliance: projectionText(summary.compliance), rejection: projectionText(summary.rejection),
  })), closeReferences: [], planRejections: [], admittedTasks: projectionPage([], 768, null),
    manifest: { digest: null, length: 0, current: null },
    view: null, criterionStatuses: projectionPage([], 768, null), usage: { tokens: 0, known: 0, unknown: 0 },
    pendingDemand: { requests: projectionPage([], 768, null), sources: [] } };
  const criterionStatuses = [];
  let criterionRef = null;
  for (const row of rows) {
    const reference = { scope: row.scope, seq: row.seq, digest: row.digest };
    const inputReference = { seq: row.seq, digest: row.digest };
    if (row.kind === "root-admission") {
      control.admission = inputReference;
      admission = row.body;
    }
    if (row.kind === "operation") {
      control.operation = { operation: row.body.operation, key: row.body.request.key, input: inputReference };
      const observation = row.body.request.requestObservation;
      if (observation !== undefined) {
        if (!Number.isSafeInteger(observation) || observation < 0 ||
            observation >= Number.MAX_SAFE_INTEGER)
          throw new StoreError("store-corrupt", "Invalid stored request observation counter");
        control.requestObservation = observation +
          (["advance", "selection", "close"].includes(row.body.operation) ? 1 : 0);
      }
      if (row.body.operation === "selection") {
        selection = row.body.request;
        selectionIntent = workerOriginal = workerCheckpoint = null;
      }
      if (row.body.operation === "baseline") continuation = row.body.request.continuation;
      if (row.body.operation === "advance")
        control.operation.loop = row.body.request.prepare.loop;
      demand = row.body.request.demand ?? null;
      if (row.body.request.plan) {
        control.plan = inputReference;
        control.taskFrame = null;
      }
      if (Object.hasOwn(row.body.request, "taskFrame"))
        control.taskFrame = row.body.request.taskFrame ? inputReference : null;
    }
    if (row.kind === "task-review-recovery") taskReviewRecovery = row.body;
    if (row.kind === "intent") {
      control.intent = { ...reference };
      workerCheckpoint = null;
      if (row.body.taskId === selection?.baseline?.taskId &&
          row.body.loop === selection.baseline.loop) {
        selectionIntent = row.body;
        workerOriginal = null;
      }
    }
    if (row.kind === "ledger") {
      for (const entry of row.body.entries) {
        const body = entry.body;
        if (entry.kind === "unit" && !P.lastAttempt)
          // Revival needs the decision fields, not a second copy of report prose.
          P.lastAttempt = { taskId: body.taskId, number: body.attempt,
            result: body.result ? Object.fromEntries(["status", "revival"]
              .filter(field => Object.hasOwn(body.result, field)).map(field => [field, body.result[field]])) : null };
        if (entry.kind !== "loop") continue;
        const reference = { loop: entry.loop, scope: row.scope, seq: row.seq, digest: row.digest };
        P.closeReferences = [...P.closeReferences, reference].slice(-3);
        const summary = summarizeLoops([entry])[0];
        P.planRejections = [...P.planRejections,
          { loop: entry.loop, diagnostic: projectionText(summary.rejection) }].slice(-3);
        P.pendingDemand.sources = summary.status === "complete" ? [] :
          [{ ...reference, gaps: projectionText(summary.gaps), review: projectionText(summary.review),
            compliance: projectionText(summary.compliance) }];
        for (const value of body.usage ?? []) {
          if (value.tokens === null) P.usage.unknown++;
          else { P.usage.known++; P.usage.tokens += value.tokens; }
        }
      }
    }
    const result = row.body.result;
    // Direct drains use the slot key; grouped closing recovery adds ".drain".
    if (row.kind === "receipt" && /\.finishDrain(?:\.v[1-9]\d*)?(?:\.drain)?$/.test(row.body.key ?? "")) {
      const key = row.body.key.replace(/\.drain$/, "");
      control.finishDrain = { key, generation: Number(key.match(/\.v(\d+)$/)?.[1] ?? 0) };
    }
    if (row.kind === "receipt" && row.body.continuation) {
      const packet = row.body.continuation;
      if (!Array.isArray(packet.ledgerRefs))
        throw new StoreError("store-corrupt", "Missing close continuation ledger references");
      const resolve = (ref, kind) => {
        const source = sources.find(source => source.seq < row.seq && source.seq === ref?.seq &&
          source.digest === ref.digest && source.kind === kind);
        if (!source) throw new StoreError("store-corrupt", "Close continuation reference integrity mismatch");
        return source.body;
      };
      const request = resolve(packet.input, "operation").request;
      const gate = resolve(packet.gate, "marker");
      const seal = resolve(packet.seal, "seal");
      const intent = resolve(packet.attempt, "intent");
      // A gate receipt may have been carried by a prior standalone admission.
      // Fold its evidence, never the prior admission envelope and its projection.
      const { P: priorProjection, head: priorHead, storeId: priorStore, ...receipt } = gate.result.receipt;
      const resultReference = result => {
        if (!result) throw new StoreError("store-corrupt", "Missing close continuation ledger result");
        return Object.fromEntries(["taskId", "attempt", "sealed", "checkpoint", "ref"]
          .filter(key => result[key] !== undefined).map(key => [key, result[key]]));
      };
      const drained = packet.ledgerRefs.flatMap(ref => resolve(ref, "ledger").entries)
        .filter(entry => entry.kind === "unit").map(entry => ({
          frame: Object.fromEntries(["reviewProjections", "workerKnowledge"]
            .filter(key => entry.body.frame?.[key]).map(key => [key, entry.body.frame[key]])),
          result: resultReference(entry.body.result), results: entry.body.results.map(resultReference),
        }));
      if (!request.continuation || request.gate.checkpoint.key !== request.continuation.attempt.key ||
          intent.key !== (packet.next ? request.nextBaseline[seal.result.receipt.outcome]?.key :
            request.gate.checkpoint.key) ||
          gate.workerOriginal?.reference.key !== request.continuation.attempt.key)
        throw new StoreError("store-corrupt", "Close continuation source integrity mismatch");
      foldedContinuation = { ref: inputReference, intent: packet.attempt, checkpoint: intent,
        ...request.continuation, requests: result.steps.find(step => step.operation === "nextRequests").result,
        view: receipt.view, gate: { receipt, contextPeak: gate.result.contextPeak }, seal: seal.result.receipt,
        worker: gate.workerOriginal, drained };
    }
    if (row.kind === "receipt" && result?.operation === "selection")
      backlogPath = result.steps.find(step => step.operation === "apply")?.result.path ?? backlogPath;
    if (!result || row.kind === "receipt") continue;
    if (row.body.context) {
      const { digest, current } = row.body.context;
      tasks = row.body.context.tasks;
      selectTask(current?.id, reference);
      P.admittedTasks = projectionPage(tasks.map(task => ({
        id: task.id, status: task.status, title: projectionText(task.title),
        goal: projectionText(task.goal), remaining: projectionText(task.remaining),
        dependsOn: task.dependsOn.slice(0, 2),
        dependenciesOmitted: Math.max(0, task.dependsOn.length - 2),
      })), 768, reference);
      P.manifest = { digest, length: tasks.length, current: current?.id ?? null };
    }
    const view = result.view ?? result.receipt?.view;
    if (view) {
      const posts = projectionPage(view.posts.map(post => ({
        id: post.id, type: post.type, content: projectionText(post.content, 256),
      })), 768, reference);
      P.view = { topicId: view.topicId, authority: view.authority, ...posts,
        omitted: (view.omitted ?? 0) + posts.omitted };
    }
    if (row.body.attempt) P.lastAttempt = row.body.attempt;
    if (row.body.workerOriginal) workerOriginal = row.body.workerOriginal;
    if (row.body.workerCheckpoint) workerCheckpoint = row.body.workerCheckpoint;
    if (row.body.operation === "gate") selectTask(row.body.request.task.id, reference);
    // Request identities are replay keys, not truncatable text previews.
    if (row.body.operation === "requests" || row.body.operation === "nextRequests")
      P.pendingDemand.requests = { ...projectionPage(result.requests.map(request => ({
        ...request,
        at: typeof request.at === "string" ? projectionText(request.at, 64) : request.at,
      })), 2048, reference), next: result.next };
    if (row.body.operation === "seal" && result.receipt?.restored && P.lastAttempt)
      P.lastAttempt = { ...P.lastAttempt, restore: reference };
    if (row.body.operation === "gate" && !result.receipt.mutated) {
      for (const definition of row.body.request.task.gates) {
        const gate = result.receipt.gates.find(value => value.id === definition.id);
        for (const criterion of definition.verifies ?? []) {
          const prior = criterionStatuses.findIndex(value => value.criterion === criterion);
          if (prior !== -1) criterionStatuses.splice(prior, 1);
          // The preview needs statuses; full gate evidence retains candidate identities.
          criterionStatuses.push({ criterion, status: !gate ? "not-run" : gate.status === "pass" ? "passed" : "failed",
            loop: row.body.request.loop });
          criterionRef = reference;
        }
      }
    }
  }
  control.lastAttempt = P.lastAttempt;
  if (["advance", "selection"].includes(control.operation?.operation) ||
      ["selection", "close", "gate", "baseline"].includes(control.operation?.operation) && selection?.plan && selectionIntent) {
    prompt.admission = admission;
    if (control.operation.operation === "advance") {
      prompt.demand = demand;
      prompt.loopSummaries = summaries;
      prompt.transition = rows.findLast(row => row.kind === "operation" &&
        row.body.operation === "advance")?.body.request.transition ?? null;
    }
    if (control.operation.operation === "selection") prompt.loopSummaries = summaries;
    control.ledger = { count: ledger.length, head: ledger.length ? ledgerDigest(ledger.at(-1)) : null };
    control.lastConfirmed = ledger.findLast(entry => entry.kind === "unit")?.body.checkpoint ?? null;
    if (["selection", "close", "gate", "baseline"].includes(control.operation.operation) && selection?.plan && selectionIntent)
      prompt.execution = { plan: selection.plan, backlogPath, checkpoint: workerCheckpoint ?? selectionIntent, worker: workerOriginal,
        ...(control.operation.operation === "selection" && selection.recoveries ? { recoveries: selection.recoveries } : {}),
        ...(taskReviewRecovery?.gate.seq === control.operation.input.seq ? { taskReviewRecovery } : {}),
        ...(control.operation.operation === "close" &&
            foldedContinuation?.attempt.key === (workerCheckpoint ?? selectionIntent).key
          ? { continuationRef: foldedContinuation.ref, foldedContinuation }
          : continuation?.attempt.key === selectionIntent.key ? { continuation } :
            foldedContinuation?.checkpoint.key === (workerCheckpoint ?? selectionIntent).key
              ? { continuationRef: foldedContinuation.ref, foldedContinuation } : {}) };
    if (prompt.execution) {
      const checkpoint = prompt.execution.checkpoint;
      const prior = continuation?.attempt.key === checkpoint.key ? continuation :
        foldedContinuation?.checkpoint.key === checkpoint.key ? foldedContinuation : null;
      const usage = [...(prior?.usage ?? selection.usage ?? [])];
      if (workerOriginal) {
        const id = `${workerOriginal.reference.runId}:0`, reported = workerOriginal.usage;
        if (!usage.some(value => value.id === id)) usage.push({ id,
          tokens: reported && ["input", "output", "cacheRead", "cacheWrite"].every(field =>
            Number.isFinite(reported[field]) && reported[field] >= 0)
            ? ["input", "output", "cacheRead", "cacheWrite"].reduce((total, field) => total + reported[field], 0) : null });
      }
      prompt.execution.usage = usage;
    }
    if (control.operation.operation === "selection" && !prompt.execution && selection?.plan)
      prompt.execution = { plan: selection.plan, backlogPath, usage: selection.usage ?? [],
        ...(selection.recoveries ? { recoveries: selection.recoveries } : {}) };
  }
  delete P.lastAttempt;
  P.criterionStatuses = projectionPage(criterionStatuses, 768, criterionRef);
  // Only previews may shrink; exact decision and prompt fields share the transport budget.
  const exactBytes = Buffer.byteLength(JSON.stringify({ control, prompt }));
  const pageBudget = Math.max(6144, exactBytes + 2048);
  const size = () => exactBytes + Buffer.byteLength(',"preview":') + Buffer.byteLength(JSON.stringify(P));
  const pages = [P.pendingDemand.requests, P.admittedTasks, P.criterionStatuses, P.view].filter(Boolean);
  while (size() > pageBudget) {
    const page = pages.filter(page => page.items.length > (page === P.admittedTasks ? 2 : 1))
      .sort((a, b) => Buffer.byteLength(JSON.stringify(b.items)) - Buffer.byteLength(JSON.stringify(a.items)))[0];
    if (!page) break;
    page.items.pop();
    page.omitted++;
  }
  // Keep usable page values (up to two admitted tasks) and exact replay identities;
  // shorten only previews when needed. Refs retain the originals.
  for (const bytes of [96, 64, 32]) {
    if (size() <= pageBudget) break;
    for (const summary of [...P.loopSummaries, ...P.pendingDemand.sources])
      for (const key of ["gaps", "review", "compliance", "rejection"])
        if (typeof summary[key] === "string") summary[key] = projectionText(summary[key], bytes);
    for (const rejection of P.planRejections) rejection.diagnostic = projectionText(rejection.diagnostic, bytes);
    for (const task of P.admittedTasks.items)
      for (const key of ["title", "goal", "remaining"]) task[key] = projectionText(task[key], bytes);
    for (const post of P.view?.items ?? []) post.content = projectionText(post.content, bytes);
  }
  if (Buffer.byteLength(JSON.stringify(P)) > 8192) throw new Error("Execute preview exceeds 8192 bytes");
  if (Buffer.byteLength(JSON.stringify(control)) > 8192)
    throw new Error("Execute control projection exceeds 8192 bytes");
  const projection = { control, preview: P, prompt };
  if (Buffer.byteLength(JSON.stringify(projection)) > 61440)
    throw new Error("Execute decision projection exceeds its transport budget");
  return projection;
}

export function executeStore(root, invocation, writer = false, epoch = invocationStore.getStore()?.epoch ?? 0) {
  ledgerPath(root, invocation);
  const context = invocationStore.getStore();
  if (context && (context.root !== root || context.invocation !== invocation || context.epoch !== epoch))
    throw new Error("Execute store session identity mismatch.");
  const store = context?.store ?? new PitakoStore(root, executeProjection), scope = executeScope(invocation, epoch);
  let head;
  if (writer) {
    head = existsSync(store.file) ? store.readRecords(scope).head : null;
    // v9 has no explicit admission call. Its first deterministic writer admits the scope.
    if (head === null) {
      store.activate(scope);
      const admitted = store.commit(scope, null, "admission", canonicalDigest({ invocation }),
        () => ({ kind: "admission", body: { invocation } }));
      if (!["appended", "replay"].includes(admitted.outcome)) throw new Error(`Execute store ${admitted.outcome}`);
      head = admitted.head;
    }
  }
  return { store, scope, ...(writer ? { head } : {}) };
}

export function commitExecute(root, invocation, opKey, requestDigest, kind, body) {
  const { store, scope, head } = executeStore(root, invocation, true);
  const saved = store.commit(scope, head, opKey, requestDigest, () => ({ kind, body }));
  if (saved.outcome === "superseded") throw new StoreError("superseded", "Execute scope was superseded.");
  if (!["appended", "replay"].includes(saved.outcome)) throw new Error(`Execute store ${saved.outcome}: ${opKey}`);
  return saved;
}

/** A cursor lost after COMMIT must not renew settings on the next initial advance. */
export function admitExecuteRoot(root, invocation, admission) {
  if (admission?.association?.root !== root || admission.association.invocation !== invocation)
    throw new Error("loop-io admission identity mismatch");
  const { store, scope } = executeStore(root, invocation, true);
  const prior = store.readRecords(scope).records.find(row => row.opKey === "root-admission");
  if (prior) {
    const identity = value => {
      const { maxCycles, ...association } = value.association;
      return { association, admissionBinding: value.admissionBinding, amendments: value.amendments };
    };
    if (prior.kind !== "root-admission" ||
        canonicalDigest(identity(prior.body)) !== canonicalDigest(identity(admission)))
      throw new Error("loop-io admission identity mismatch");
    admission = prior.body;
  }
  return commitExecute(root, invocation, "root-admission", canonicalDigest(admission),
    "root-admission", admission);
}

export function committedIntent(intent, candidate) {
  const bound = { ...intent, baseline: candidate };
  const saved = commitExecute(intent.association.root, intent.association.invocation, `intent:${intent.key}`,
    canonicalDigest(bound), "intent", bound);
  return { seq: saved.head.seq, digest: saved.head.hash };
}

export function committedSeal(request, receipt) {
  return commitExecute(request.intent.association.root, request.intent.association.invocation,
    `seal:${request.intent.key}:${request.kind}:${canonicalDigest(receipt)}`,
    canonicalDigest(request), "seal", { request, result: receipt });
}
function validateRecord(record, seq, prev) {
  if (!keys(record, "body,kind,loop,prev,seq") || record.seq !== seq || record.prev !== prev ||
      !Number.isSafeInteger(record.loop) || (seq === 0 ? record.loop !== 0 || record.kind !== "spec" : record.loop < 1 || !["unit", "loop"].includes(record.kind)))
    throw new Error("Invalid ledger record or chain link.");
  if (seq === 0 && (!keys(record.body, "content,digest") || typeof record.body.content !== "string" ||
      !isHash(record.body.digest) || digest(record.body.content) !== record.body.digest)) throw new Error("Ledger spec digest mismatch.");
}

/** Read-only verification against the native state's anchor; suffixes may be unpublished-to-state retries. */
export function verifyLedger(root, invocation, expected, epoch = invocationStore.getStore()?.epoch ?? 0) {
  validateExpected(expected);
  if (expected.count === 0) return [];
  const { store, scope } = executeStore(root, invocation, false, epoch);
  const records = ledgerRecords(store.readRecords(scope).records).slice(0, expected.count);
  for (let seq = 0; seq < records.length; seq++)
    validateRecord(records[seq], seq, seq === 0 ? null : ledgerDigest(records[seq - 1]));
  if (records.length !== expected.count || ledgerDigest(records.at(-1)) !== expected.head)
    throw new Error("Ledger head mismatch.");
  return records;
}

/** Verified, bounded planning context; never a replacement for exact task originals. */
export function loopSummaries(root, invocation, expected) {
  return summarizeLoops(verifyLedger(root, invocation, expected));
}

/** Resolve the store prefix containing this exact published ledger anchor, not the tip. */
export function ledgerProjection(root, invocation, expected) {
  validateExpected(expected);
  const { store, scope } = executeStore(root, invocation);
  const row = store.readRecords(scope).records.find(row => row.kind === "ledger" &&
    row.body.entries.some(entry => entry.seq + 1 === expected.count &&
      ledgerDigest(entry) === expected.head));
  if (!row) throw new Error("Ledger head mismatch.");
  const { identity, head, P } = store.read(scope, { seq: row.seq, hash: row.digest });
  return { storeId: identity.storeId, head, P };
}

/** Publisher projection shared with controlled external-boundary fixtures. */
export function summarizeLoops(records) {
  const bounded = value => {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    // Bound encoded bytes too: escaped controls and multibyte text must fit stdout.
    if (Buffer.byteLength(JSON.stringify(text)) <= 512) return text;
    const marker = " [truncated; see verified ledger]";
    let limit = Math.min(text.length, 512);
    while (Buffer.byteLength(JSON.stringify(text.slice(0, limit) + marker)) > 512) limit--;
    return text.slice(0, limit) + marker;
  };
  return records.filter(record => record.kind === "loop").slice(-3).map(record => {
    const body = record.body;
    const gate = body.finalAttempt?.gate;
    const receipt = gate?.receipt;
    const currentChecks = body.kind === "final" && gate?.record
      ? gate.stage === "receipt" && receipt && !receipt.mutated &&
        receipt.after.head === body.candidate?.head && receipt.after.fingerprint === body.candidate?.fingerprint &&
        body.acceptance.length === receipt.gates.length && body.acceptance.every(command => {
          const result = receipt.gates.find(result => result.id === command.id);
          return result && (result.status === "pass" && result.exit === 0 ||
            command.exception && receipt.view.posts.some(post =>
              post.type === "HUMAN" && post.id === command.exception.humanRef));
        })
      : body.results?.at(-1)?.checks?.current;
    const fulfilled = body.observation && body.review?.verdict === "clear" && body.compliance?.status === "fulfilled" &&
      body.candidate?.head === body.observation.checkout?.head && body.candidate?.fingerprint === body.observation.checkout?.fingerprint &&
      body.compliance.candidate?.head === body.candidate?.head && body.compliance.candidate?.fingerprint === body.candidate?.fingerprint &&
      currentChecks;
    return { loop: record.loop, status: fulfilled ? "complete" : "gaps",
      gaps: bounded({ work: (body.results ?? []).map(result => ({ taskId: result.taskId,
        remaining: result.remaining, diagnosis: result.diagnosis })), obligations: body.compliance?.unresolved }),
      review: bounded({ verdict: body.review?.verdict, reason: body.review?.reason, unresolved: body.review?.unresolved }),
      compliance: bounded({ status: body.compliance?.status, reason: body.compliance?.reason }),
      rejection: bounded(body.plan?.rejection?.diagnostic ?? "") };
  });
}

/** Deterministic writers recheck semantic ledger integrity before quarantine. */
export function verifyExecuteStoreForWrite(root, store = new PitakoStore(root), cursor) {
  return store.verifyForWrite((scope, rows) => {
    if (!scope.startsWith("exec:")) return;
    try {
      const entries = ledgerRecords(rows);
      for (let seq = 0; seq < entries.length; seq++)
        validateRecord(entries[seq], seq, seq === 0 ? null : canonicalDigest(entries[seq - 1]));
    } catch (error) {
      throw new StoreError("store-corrupt", error.message);
    }
  }, cursor);
}

/** Readers report ledger failures; only deterministic writers may quarantine. */
export function isLedgerIntegrityError(error) {
  return error?.code === "ENOENT" || error?.code === "store-corrupt" || /Ledger (?:publication conflict|head mismatch|spec (?:digest|origin) mismatch|has a gap|path traverses)|Invalid ledger record or chain link|Noncanonical ledger record/.test(error?.message ?? "");
}

/** Bodies are explicit persisted projections owned by the workflow, never live runtime objects. */
export function appendLedger(root, invocation, request) {
  if (!(keys(request, "expected,record,spec") || keys(request, "expected,record")) || !keys(request.record, "body,kind,loop") ||
      !["unit", "loop"].includes(request.record.kind) || !Number.isSafeInteger(request.record.loop) || request.record.loop < 1)
    throw new Error("Invalid ledger append request.");
  const { expected, record } = request;
  validateExpected(expected);
  const records = verifyLedger(root, invocation, expected);
  const spec = request.spec ?? records[0]?.body;
  if (!keys(spec, "content,digest") || typeof spec.content !== "string" || !isHash(spec.digest) || digest(spec.content) !== spec.digest)
    throw new Error("Ledger spec digest mismatch.");
  canonicalJSON(record.body);
  if (records.length && canonicalJSON(records[0].body) !== canonicalJSON(spec)) throw new Error("Ledger spec origin mismatch.");
  let anchor = expected;
  const entries = [];
  if (expected.count === 0) {
    const first = { prev: null, seq: 0, kind: "spec", loop: 0, body: spec };
    entries.push(first);
    anchor = { count: 1, head: digest(canonicalJSON(first)) };
  }
  const entry = { prev: anchor.head, seq: anchor.count, kind: record.kind, loop: record.loop, body: record.body };
  validateRecord(entry, anchor.count, anchor.head);
  entries.push(entry);
  const { store, scope, head } = executeStore(root, invocation, true);
  const requestDigest = canonicalDigest(request);
  const saved = store.commit(scope, head, `ledger:${expected.count}`, requestDigest, rows => {
    const current = ledgerRecords(rows);
    if (current.length !== expected.count) throw new Error("Ledger publication conflict.");
    return { kind: "ledger", body: { entries } };
  });
  if (saved.outcome === "superseded") throw new StoreError("superseded", "Execute scope was superseded.");
  if (!["appended", "replay"].includes(saved.outcome)) throw new Error(`Ledger publication conflict: ${saved.outcome}`);
  return { count: entry.seq + 1, head: digest(canonicalJSON(entry)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const request = readRequest(readFileSync(0, "utf8"));
    if (!(keys(request, "expected,invocation,record,spec") || keys(request, "expected,invocation,record"))) throw new Error("Invalid ledger CLI request.");
    const { invocation, ...append } = request;
    const anchor = appendLedger(process.cwd(), invocation, append);
    process.stdout.write(JSON.stringify({ ...anchor, ...(append.record.kind === "loop"
      ? { summaries: loopSummaries(process.cwd(), invocation, anchor) } : {}) }) + "\n");
  } catch (error) {
    if (isLedgerIntegrityError(error))
      process.stdout.write(JSON.stringify({ error: "ledger-integrity", reason: error.message }) + "\n");
    process.stderr.write("Execution ledger publication failed; inspect the retained request and ledger before retrying.\n");
    process.exitCode = 1;
  }
}
